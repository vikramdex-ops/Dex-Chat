// Bots talking to bots, on the hub (docs/BOT-NETWORK.md): a bot asks another's skill mid-flow and
// uses the answer; a bot hands a request to another with the answers it needs (from its last step,
// a stage that waits on the other bot, or a button), and the other bot hands it back with a
// result; a bot listens for another's events. Every hop is checked (who may ask whom, loops, depth,
// rate, idempotency), kept as a link (the relay cards, the network sheet and the audit log read
// them), and shown to the person as a relay card: the bots as instrument tags on a small loop.
// The rules are in @dex/core/botnet, shared with the bot maker.
import type { DatabaseSync } from 'node:sqlite';
import { ulid } from '@dex/core';
import type { BotAsk, BotFlowAnswer, BotFlowCard, BotFlowDefinition, BotFlowInfo, BotHandoff, BotHop, BotItem, BotLinkKind, BotLinkStatus, BotNetExchange, BotNetMap, BotRelayView, BotScope, BotSkill, BotStageBot, BotSubscription, BotTag, PublicUser } from '@dex/core';
import { checkAnswer, localDate, renderTemplate, saveKey, summaryLines } from '@dex/core/botflows';
import type { BotFlowVars } from '@dex/core/botflows';
import { NET_RATE, NET_TIMEOUT_MS, RateWindow, SYSTEM_BOTS, SYSTEM_SKILLS, answerWords, askRefusal, askWords, carryFor, declaredLinks, extendTrail, handoffRefusal, inputsFor, loopRefusal, skillBot, skillsOf, tagLetters, trailOf, withTimeout } from '@dex/core/botnet';
import type { NetParty } from '@dex/core/botnet';
import { addDays, isWorkingDay, holidayOn, officeParts } from '@dex/core/botjobs';
import type { OfficeCalendar } from '@dex/core/botjobs';
import { stageOf } from '@dex/core/bottrack';
import type { BotItems } from './botitems.ts';
import type { Messaging } from './messaging.ts';
import type { Store } from './store.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bot_links (
  id TEXT PRIMARY KEY,
  key TEXT UNIQUE,
  kind TEXT NOT NULL,
  from_bot TEXT NOT NULL,
  to_bot TEXT NOT NULL,
  user_id TEXT,
  owner_id TEXT,
  grp TEXT,
  ask TEXT NOT NULL,
  answer TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  at INTEGER NOT NULL,
  ms INTEGER,
  data TEXT NOT NULL DEFAULT '{}',
  back TEXT,
  origin_item TEXT,
  origin_session TEXT,
  target_item TEXT,
  target_session TEXT
);
CREATE INDEX IF NOT EXISTS idx_bot_links_pair ON bot_links(from_bot, to_bot, at);
CREATE INDEX IF NOT EXISTS idx_bot_links_grp ON bot_links(grp, at);
CREATE INDEX IF NOT EXISTS idx_bot_links_target ON bot_links(target_item);
CREATE INDEX IF NOT EXISTS idx_bot_links_tsession ON bot_links(target_session);
CREATE INDEX IF NOT EXISTS idx_bot_links_at ON bot_links(at);
CREATE TABLE IF NOT EXISTS bot_relay_cards (
  client_id TEXT PRIMARY KEY,
  grp TEXT NOT NULL,
  user_id TEXT,
  conv_id TEXT NOT NULL,
  superseded INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bot_relay_grp ON bot_relay_cards(grp, superseded);
`;

const DAY = 24 * 3600_000;
const SYSTEM_TITLES: Record<string, string> = { directory: 'Directory', nib: 'Nib', calendar: 'Office calendar' };
const SYSTEM_TAGS: Record<string, string> = { directory: 'DIR', nib: 'NIB', calendar: 'CAL' };

export class BotNetError extends Error {}

/** A live bot as the network sees it. */
export interface NetBot {
  def: BotFlowDefinition;
  bot: PublicUser;
  ownerId: string | null;
  source: BotFlowInfo['source'];
  scope: BotScope;
  status: string;
  version: number;
}

/** What the bot conversations give the network (BotFlows implements it). */
export interface NetHost {
  live(name: string): NetBot | null;
  all(): NetBot[];
  /** May this person (null: the office itself, for its own bots) start that bot? */
  mayUse(name: string, userId: string | null): boolean;
  /** Start a bot for someone with answers carried in; the steps those answer are passed over. */
  startCarried(person: PublicUser, name: string, carried: Record<string, string>, o: { trail: string; link: string; from: string }): Promise<{ sessionId: string; convId: string; itemId: string | null; done: boolean }>;
  postCard(bot: PublicUser, convId: string, body: string, kind: BotFlowCard['kind'], data: Record<string, unknown>): string;
  refreshCard(clientId: string): void;
  dm(bot: PublicUser, userId: string): string;
  say(bot: PublicUser, convId: string, text: string): void;
  /** Finished runs of a bot since a moment. */
  sent(name: string, since: number): number;
}

export interface BotNetDeps {
  db: DatabaseSync;
  store: Store;
  messaging: Messaging;
  items: BotItems;
  host: NetHost;
  log: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
  now: () => number;
  deliver: (userIds: string[], name: string, data: unknown) => void;
  calendar: () => OfficeCalendar;
}

/** Who asks, for whom, and where the relay card goes. */
export interface NetContext {
  /** The asking bot's flow name. */
  from: string;
  /** The person the flow (or job) runs for. */
  person: PublicUser;
  /** The bots this request has already been through. */
  trail: string[];
  /** The relay card's group: the session or the request it belongs to. */
  group: string;
  /** Post the relay card in the person's conversation with the asking bot. */
  card?: boolean;
  /** Once only: a second hop with the same key returns the first one. */
  key?: string;
  originItem?: string | null;
  originSession?: string | null;
  /** The bot maker's test run or a dry run: errands are described, not done. */
  dry?: boolean;
  /** A job asking as its maker: the maker is the person. */
  ownerOverride?: string | null;
  step?: string | null;
}

export interface AskResult {
  ok: boolean;
  status: BotLinkStatus;
  values: Record<string, BotFlowAnswer>;
  answer: BotFlowAnswer | null;
  words: string;
  reason: string | null;
  hopId: string | null;
}

interface LinkRow {
  id: string; key: string | null; kind: BotLinkKind; from_bot: string; to_bot: string; user_id: string | null; owner_id: string | null; grp: string | null;
  ask: string; answer: string | null; status: BotLinkStatus; reason: string | null; at: number; ms: number | null; data: string; back: string | null;
  origin_item: string | null; origin_session: string | null; target_item: string | null; target_session: string | null;
}

function parse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

export class BotNet {
  private readonly db: DatabaseSync;
  private readonly d: BotNetDeps;
  private readonly rate = new RateWindow();
  /** How long a skill may take (tests make it short). */
  timeoutMs = NET_TIMEOUT_MS;
  /** Skills the tests make slow or broken: id → resolver. */
  readonly overrides = new Map<string, (inputs: Record<string, string>, person: PublicUser) => Promise<Record<string, BotFlowAnswer>>>();
  /** Work started by events, so tests can wait for it. */
  private pending = new Set<Promise<unknown>>();
  /** Leave from Nib (set by the hub). */
  leave: ((userId: string, date: string) => { back: string | null; coverId: string | null } | null) | null = null;

  constructor(deps: BotNetDeps) {
    this.d = deps;
    this.db = deps.db;
    this.db.exec(SCHEMA);
  }

  /** Every piece of work events started has finished (tests). */
  async settle(): Promise<void> { while (this.pending.size) await Promise.allSettled([...this.pending]); }
  private track<T>(p: Promise<T>): void {
    const q = p.catch((err: Error) => this.d.log('warn', 'bot event failed', { error: err.message })).finally(() => this.pending.delete(q));
    this.pending.add(q);
  }

  // ------------------------------------------------------------ parties
  private party(b: NetBot): NetParty { return { flow: b.def.name, ownerId: b.ownerId, source: b.source, scope: b.scope, network: b.def.network ?? null }; }
  private isAdmin(id: string | null): boolean { const u = id ? this.d.store.userById(id) : null; return !!u && (u.role === 'owner' || u.role === 'admin'); }
  private active(id: string): PublicUser | null { const u = this.d.store.userById(id); return u && u.role !== 'bot' && this.d.store.activeUsers().some((a) => a.id === id) ? u : null; }
  private titleOf(key: string): string { return SYSTEM_TITLES[key] ?? this.d.host.live(key)?.def.title ?? key; }

  /** The skills a bot (or a maker, for the blocks in the bot maker) may ask. */
  skillsFor(ownerId: string | null, except?: string): BotSkill[] {
    const out = [...SYSTEM_SKILLS];
    for (const b of this.d.host.all()) {
      if (b.def.name === except || b.status !== 'live') continue;
      const p = this.party(b);
      const refusal = askRefusal({ caller: { flow: except ?? '', ownerId, source: 'member', scope: 'private' }, target: p, ownerMayUse: this.d.host.mayUse(b.def.name, ownerId), effect: 'read', forSelf: true, ownerIsAdmin: this.isAdmin(ownerId), targetTitle: b.def.title });
      if (refusal) continue;
      out.push(...skillsOf(b.def, { public: p.scope === 'office' }));
    }
    return out;
  }

  /** The skill an id names, and the bot that answers it. */
  private skill(id: string): { skill: BotSkill; bot: NetBot | null } | null {
    const sys = SYSTEM_SKILLS.find((s) => s.id === id);
    if (sys) return { skill: sys, bot: null };
    const b = this.d.host.live(skillBot(id));
    if (!b) return null;
    const s = skillsOf(b.def, { public: b.scope === 'office' }).find((x) => x.id === id);
    return s ? { skill: s, bot: b } : null;
  }

  // ------------------------------------------------------------ links
  private link(id: string): LinkRow | null { return (this.db.prepare('SELECT * FROM bot_links WHERE id = ?').get(id) as LinkRow | undefined) ?? null; }
  private byKey(key: string): LinkRow | null { return (this.db.prepare('SELECT * FROM bot_links WHERE key = ?').get(key) as LinkRow | undefined) ?? null; }

  private record(r: Omit<LinkRow, 'id' | 'data' | 'back' | 'target_item' | 'target_session'> & { data?: Record<string, unknown>; target_item?: string | null; target_session?: string | null }): LinkRow {
    const id = ulid();
    this.db.prepare(`INSERT INTO bot_links (id, key, kind, from_bot, to_bot, user_id, owner_id, grp, ask, answer, status, reason, at, ms, data, origin_item, origin_session, target_item, target_session)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, r.key, r.kind, r.from_bot, r.to_bot, r.user_id, r.owner_id, r.grp, r.ask.slice(0, 200), r.answer?.slice(0, 300) ?? null, r.status, r.reason?.slice(0, 400) ?? null, r.at, r.ms,
        JSON.stringify(r.data ?? {}), r.origin_item, r.origin_session, r.target_item ?? null, r.target_session ?? null);
    // links are kept a quarter: the network sheet weighs a week, the relay cards their own run
    if (Math.random() < 0.02) this.db.prepare('DELETE FROM bot_links WHERE at < ?').run(this.d.now() - 90 * DAY);
    const row = this.link(id)!;
    this.pulse(row);
    this.d.store.audit(r.user_id ?? r.owner_id, `botnet.${r.kind}`, r.to_bot, { from: r.from_bot, to: r.to_bot, status: r.status, ask: r.ask.slice(0, 120), ...(r.reason ? { reason: r.reason.slice(0, 200) } : {}) });
    return row;
  }

  private update(id: string, set: Partial<Pick<LinkRow, 'answer' | 'status' | 'reason' | 'ms' | 'back' | 'target_item' | 'target_session'>>): void {
    const keys = Object.keys(set) as Array<keyof typeof set>;
    if (!keys.length) return;
    this.db.prepare(`UPDATE bot_links SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => set[k] ?? null), id);
    const row = this.link(id);
    if (row) { this.pulse(row); if (row.grp) this.refreshGroup(row.grp); }
  }

  /** The network sheet pulses for administrators and the makers of both bots. */
  private pulse(r: LinkRow): void {
    const to = new Set<string>(this.d.store.activeUsers().filter((u) => u.role === 'owner' || u.role === 'admin').map((u) => u.id));
    for (const k of [r.from_bot, r.to_bot]) { const o = this.d.host.live(k)?.ownerId; if (o) to.add(o); }
    try { this.d.deliver([...to], 'botnet.pulse', { from: r.from_bot, to: r.to_bot, kind: r.kind, status: r.status, at: r.at }); } catch { /* nobody to tell */ }
  }

  // ------------------------------------------------------------ the relay card
  /** Post a fresh relay card for a group in the person's conversation with the bot, folding the one before. */
  private relayCard(group: string, bot: PublicUser, person: string, def: BotFlowDefinition | null): void {
    try {
      const convId = this.d.host.dm(bot, person);
      const older = this.db.prepare('SELECT client_id FROM bot_relay_cards WHERE grp = ? AND conv_id = ? AND superseded = 0').all(group, convId) as Array<{ client_id: string }>;
      const persona = def?.persona ? { mark: def.persona.mark, colour: def.persona.colour } : null;
      const hops = this.db.prepare('SELECT ask, answer, status FROM bot_links WHERE grp = ? ORDER BY at DESC LIMIT 1').get(group) as { ask: string; answer: string | null; status: string } | undefined;
      const body = hops ? `${hops.ask}${hops.answer ? ` → ${hops.answer}` : ''}` : 'Bots at work';
      const clientId = this.d.host.postCard(bot, convId, body, 'relay', { title: def?.title ?? bot.displayName, group, ownerId: person, ...(persona ? { persona } : {}) });
      this.db.prepare('INSERT INTO bot_relay_cards (client_id, grp, user_id, conv_id, created_at) VALUES (?, ?, ?, ?, ?)').run(clientId, group, person, convId, this.d.now());
      for (const o of older) { this.db.prepare('UPDATE bot_relay_cards SET superseded = 1 WHERE client_id = ?').run(o.client_id); this.d.host.refreshCard(o.client_id); }
    } catch (err) { this.d.log('warn', 'relay card not posted', { error: (err as Error).message }); }
  }

  private refreshGroup(group: string): void {
    for (const r of this.db.prepare('SELECT client_id FROM bot_relay_cards WHERE grp = ? AND superseded = 0').all(group) as Array<{ client_id: string }>) this.d.host.refreshCard(r.client_id);
  }

  private tagOf(key: string): BotTag {
    if (SYSTEM_BOTS.includes(key)) return { key, title: SYSTEM_TITLES[key], mark: null, colour: null, tag: SYSTEM_TAGS[key], system: true };
    const b = this.d.host.live(key);
    const p = b?.def.persona;
    return { key, title: b?.def.title ?? key, mark: p?.mark ?? null, colour: p?.colour ?? null, tag: tagLetters(b?.def.title ?? key, p?.mark.kind === 'monogram' ? p.mark.letters : null), system: false };
  }

  private hopOf(r: LinkRow): BotHop {
    const data = parse<{ ref?: string; step?: string }>(r.data, {});
    let canRetry = false;
    if (r.kind === 'query' && r.status !== 'ok' && r.origin_session && data.step) {
      const s = this.db.prepare("SELECT step FROM bot_sessions WHERE id = ? AND status = 'active'").get(r.origin_session) as { step: string | null } | undefined;
      canRetry = s?.step === data.step && !this.db.prepare("SELECT 1 FROM bot_links WHERE origin_session = ? AND at > ? AND kind = 'query' AND status = 'ok' AND json_extract(data, '$.step') = ?").get(r.origin_session, r.at, data.step);
    }
    return {
      id: r.id, kind: r.kind, from: r.from_bot, to: r.to_bot, ask: r.ask, answer: r.answer, status: r.status, reason: r.reason, at: r.at, ms: r.ms,
      back: parse<BotHop['back']>(r.back, null), ref: data.ref ?? null, canRetry,
    };
  }

  /** What a relay card shows now (drawn again each time its message is). */
  relayView(clientId: string, group: string, viewer: string | null): BotRelayView {
    const meta = this.db.prepare('SELECT superseded, user_id FROM bot_relay_cards WHERE client_id = ?').get(clientId) as { superseded: number; user_id: string | null } | undefined;
    const rows = (this.db.prepare('SELECT * FROM bot_links WHERE grp = ? ORDER BY at, rowid LIMIT 40').all(group) as unknown as LinkRow[])
      .filter((r) => !viewer || !r.user_id || r.user_id === viewer || r.owner_id === viewer || meta?.user_id === viewer);
    const keys: string[] = [];
    for (const r of rows) for (const k of [r.from_bot, r.to_bot]) if (!keys.includes(k)) keys.push(k);
    return { group, tags: keys.map((k) => this.tagOf(k)), hops: rows.map((r) => this.hopOf(r)), ...(meta?.superseded ? { moved: true } : {}) };
  }

  // ------------------------------------------------------------ asking a skill
  /** Answer a skill from the office's own records. Throws worded for people. */
  private async resolve(skill: BotSkill, bot: NetBot | null, raw: Record<string, string>, person: PublicUser, dry: boolean): Promise<Record<string, BotFlowAnswer>> {
    const over = this.overrides.get(skill.id);
    if (over) return over(raw, person);
    const cal = this.d.calendar();
    const today = officeParts(this.d.now(), cal.tzOffset).date;
    const dateOf = (v: string | undefined): string => {
      const t = (v ?? '').trim().toLowerCase();
      if (!t || t === 'today') return today;
      if (t === 'tomorrow') return addDays(today, 1);
      if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
      throw new BotNetError(`“${v}” is not a date.`);
    };
    const words = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    const personOf = (v: string | undefined, fallback: PublicUser | null): PublicUser => {
      const t = (v ?? '').trim().replace(/^<@([0-9A-Z]{26})>$/, '$1');
      if (!t) { if (fallback) return fallback; throw new BotNetError('Say which person.'); }
      const all = this.d.store.activeUsers().filter((u) => u.role !== 'bot');
      const hit = all.find((u) => u.id === t) ?? this.d.store.userForAccount(t) ?? (() => { const m = all.filter((u) => u.displayName.toLowerCase() === t.toLowerCase()); return m.length === 1 ? m[0] : null; })();
      if (!hit || hit.role === 'bot') throw new BotNetError(`No one in the office is “${t}”.`);
      return hit;
    };
    const ans = (value: string, label = value): BotFlowAnswer => ({ value, label });
    const num = (n: number) => ans(String(n));
    const yes = (b: boolean) => ans(b ? 'yes' : 'no', b ? 'Yes' : 'No');
    const kind = skill.id.slice(skill.id.indexOf('.') + 1);
    if (skill.id === 'directory.lead') {
      const p = personOf(raw.person, person);
      const lead = this.d.items.leadOf(p.id);
      const dept = p.profile.departmentId ? (this.db.prepare('SELECT name FROM departments WHERE id = ?').get(p.profile.departmentId) as { name: string } | undefined)?.name ?? '' : '';
      if (!lead) throw new BotNetError(`${p.displayName} has no lead in the Directory.`);
      return { lead: ans(lead.id, lead.displayName), department: ans(dept, dept || '—') };
    }
    if (skill.id === 'nib.away') {
      const p = personOf(raw.person, person);
      const date = dateOf(raw.date);
      const l = this.leave?.(p.id, date) ?? null;
      const oooUntil = p.ooo && p.ooo.until > Date.parse(`${date}T00:00:00`) ? p.ooo.until : null;
      const away = !!l || !!oooUntil;
      const back = l?.back ?? (oooUntil ? localDate(oooUntil) : null);
      const cover = l?.coverId ? this.d.store.userById(l.coverId) : p.ooo?.delegateId ? this.d.store.userById(p.ooo.delegateId) : null;
      return { away: yes(away), back: back ? ans(back, words(back)) : ans('', '—'), cover: cover ? ans(cover.id, cover.displayName) : ans('', '—') };
    }
    if (skill.id === 'nib.awayList') {
      const date = dateOf(raw.date);
      const who = this.d.store.activeUsers().filter((u) => u.role !== 'bot' && (this.leave?.(u.id, date) || (u.ooo && u.ooo.until > Date.parse(`${date}T00:00:00`))));
      return { count: num(who.length), people: ans(who.map((u) => u.id).join(','), who.map((u) => u.displayName).join(', ') || '—') };
    }
    if (skill.id === 'calendar.workday') {
      const date = dateOf(raw.date);
      const h = holidayOn(cal, date);
      const working = isWorkingDay(cal, date);
      return { working: yes(working), why: ans(working ? '' : h ? h.name : 'not a working day', working ? '—' : h ? h.name : 'Not a working day') };
    }
    if (!bot) throw new BotNetError('That bot is not available.');
    const def = bot.def;
    if (kind === 'sent') {
      const days = Math.max(1, Math.min(90, Number(raw.days) || 7));
      return { count: num(this.d.host.sent(def.name, this.d.now() - days * DAY)) };
    }
    const open = this.d.items.openItems(def.name);
    if (kind === 'open') {
      const now = this.d.now();
      const stage = raw.stage ? def.track?.stages.find((s) => s.id === raw.stage || s.label.toLowerCase() === raw.stage.toLowerCase()) : undefined;
      if (raw.stage && !stage) throw new BotNetError(`${def.title} has no stage “${raw.stage}”.`);
      const older = Number(raw.older) || 0;
      const by = raw.person ? personOf(raw.person, null) : null;
      const hits = open.filter((i) => (!stage || i.stage === stage.id) && (!older || now - i.createdAt > older * DAY) && (!by || i.requesterId === by.id));
      const oldest = hits.length ? Math.floor((now - Math.min(...hits.map((i) => i.createdAt))) / DAY) : 0;
      // the numbers are for anyone; which requests they are, only those the person may see
      const seen = hits.filter((i) => this.d.items.visibleTo(def.name, i, person.id)).sort((a, b) => a.createdAt - b.createdAt).slice(0, 12);
      const refs = seen.map((i) => `${i.ref} (${Math.floor((now - i.createdAt) / DAY)} d)`);
      return { count: num(hits.length), oldest: num(oldest), refs: ans(seen.map((i) => i.ref).join(','), refs.join(', ') || '—') };
    }
    if (kind === 'status') {
      const ref = (raw.ref ?? '').trim().toUpperCase();
      const all = this.d.items.byRef(def.name, ref);
      if (!all || !this.d.items.visibleTo(def.name, all, person.id)) throw new BotNetError(`${ref || 'That request'} was not found.`);
      const st = stageOf(def, all.stage);
      const who = all.actorId ? this.d.store.userById(all.actorId) : null;
      return { stage: ans(all.status === 'open' ? st?.id ?? '' : 'end', all.status === 'open' ? st?.label ?? '—' : all.stamp ?? 'Closed'), who: who ? ans(who.id, who.displayName) : ans('', '—'), stamp: ans(all.stamp ?? '', all.stamp ?? '—') };
    }
    const limited = def.track?.stages.find((s) => s.limit);
    if (kind === 'seats' && limited?.limit) {
      const key = (raw.key ?? '').trim();
      if (!key) throw new BotNetError('Say which one, like CAESAR II.');
      const name = Object.keys(limited.limit.seats).find((k) => k.toLowerCase() === key.toLowerCase()) ?? key;
      const of = limited.limit.seats[name] ?? limited.limit.otherwise;
      const here = open.filter((i) => i.stage === limited.id && (limited.limit!.by ? (i.vars[limited.limit!.by]?.label || i.vars[limited.limit!.by]?.value) === name : true));
      const used = here.filter((i) => !i.waiting).length;
      return { free: num(Math.max(0, of - used)), of: num(of), waiting: num(here.filter((i) => i.waiting).length) };
    }
    if (kind === 'release' && limited) {
      const p = personOf(raw.person, person);
      const mine = open.filter((i) => i.stage === limited.id && i.requesterId === p.id);
      const end = limited.actions.find((a) => a.to === 'end' && a.outcome !== 'stopped' && a.tone !== 'stop');
      if (!end) throw new BotNetError(`${def.title} has no button that releases a place.`);
      if (!dry) for (const i of mine) this.d.items.handle('botflow.act', p, { itemId: i.id, action: end.id });
      return { released: num(mine.length), refs: ans(mine.map((i) => i.ref).join(','), mine.map((i) => i.ref).join(', ') || '—') };
    }
    throw new BotNetError(`${def.title} cannot answer that.`);
  }

  /**
   * Ask a skill for a run. Every refusal and failure comes back worded for the person (the flow
   * decides whether to ask them instead, carry on or stop), and every attempt is a link.
   */
  async ask(ctx: NetContext, a: BotAsk, vars: BotFlowVars): Promise<AskResult> {
    const now = this.d.now();
    const from = this.d.host.live(ctx.from);
    const ownerId = ctx.ownerOverride !== undefined ? ctx.ownerOverride : from?.ownerId ?? null;
    if (ctx.key) {
      const had = this.byKey(ctx.key);
      if (had) {
        const v = parse<{ values?: Record<string, BotFlowAnswer>; main?: string }>(had.data, {});
        const values = v.values ?? {};
        return { ok: had.status === 'ok', status: had.status, values, answer: v.main ? values[v.main] ?? null : null, words: had.answer ?? '', reason: had.reason, hopId: had.id };
      }
    }
    const found = this.skill(a.skill);
    const toBot = skillBot(a.skill);
    const raw = inputsFor(a, vars);
    const base = { key: ctx.key ?? null, kind: 'query' as const, from_bot: ctx.from, to_bot: toBot, user_id: ctx.person.id, owner_id: ownerId, grp: ctx.group, at: now, origin_item: ctx.originItem ?? null, origin_session: ctx.originSession ?? null };
    const fail = (status: BotLinkStatus, reason: string, ask = a.skill): AskResult => {
      const row = this.record({ ...base, ask, answer: null, status, reason, ms: null, data: { step: ctx.step ?? null } });
      if (ctx.card && from) this.relayCard(ctx.group, from.bot, ctx.person.id, from.def);
      return { ok: false, status, values: {}, answer: null, words: '', reason, hopId: row.id };
    };
    if (!found) return fail('refused', `There is no bot called ${toBot} that ${from?.def.title ?? 'this bot'} can ask.`);
    const { skill, bot } = found;
    const inputs: Record<string, BotFlowAnswer> = {};
    for (const i of skill.inputs) {
      const v = raw[i.id];
      if (!v) { if (!i.optional && !(i.kind === 'person')) return fail('failed', `${skill.title} needs “${i.label}”.`, skill.short); continue; }
      const u = i.kind === 'person' ? this.d.store.userById(v.replace(/^<@([0-9A-Z]{26})>$/, '$1')) : null;
      inputs[i.id] = { value: v, label: u?.displayName ?? v };
    }
    const askText = askWords(skill, inputs);
    const forSelf = !raw.person || raw.person === ctx.person.id;
    const refusal = askRefusal({
      caller: from ? this.party(from) : { flow: ctx.from, ownerId, source: 'member', scope: 'private' }, target: bot ? this.party(bot) : 'system',
      ownerMayUse: bot ? this.d.host.mayUse(bot.def.name, ownerId) : true, effect: skill.effect, forSelf, ownerIsAdmin: this.isAdmin(ownerId), targetTitle: bot?.def.title ?? skill.botTitle,
    });
    if (refusal) return fail('refused', refusal, askText);
    if (bot) {
      const loop = loopRefusal(ctx.trail, ctx.from, bot.def.name, bot.def.title);
      if (loop) return fail('loop', loop, askText);
      if (bot.status !== 'live') return fail('failed', `${bot.def.title} is ${bot.status} by the person who made it.`, askText);
    }
    if (!this.rate.take(`ask:${ctx.from}`, NET_RATE.asks, now) || !this.rate.take(`ask:${ctx.from}:${ctx.person.id}`, NET_RATE.asks / 2, now)) {
      return fail('limited', `${from?.def.title ?? 'This bot'} asked too often in the last minute. Try again in a minute.`, askText);
    }
    const t0 = Date.now();
    const got = await withTimeout(this.resolve(skill, bot, raw, ctx.person, !!ctx.dry), this.timeoutMs);
    const ms = Date.now() - t0;
    if (!got.ok) {
      const reason = got.timeout ? `${bot?.def.title ?? skill.botTitle} did not answer in time.` : got.error;
      const row = this.record({ ...base, ask: askText, answer: null, status: got.timeout ? 'timeout' : 'failed', reason, ms, data: { step: ctx.step ?? null } });
      if (ctx.card && from) this.relayCard(ctx.group, from.bot, ctx.person.id, from.def);
      return { ok: false, status: row.status, values: {}, answer: null, words: '', reason, hopId: row.id };
    }
    const values = got.value;
    const words = (ctx.dry && skill.effect === 'act' ? 'would ' : '') + answerWords(skill, values);
    const row = this.record({ ...base, ask: askText, answer: words, status: 'ok', reason: null, ms, data: { values, main: skill.main, step: ctx.step ?? null } });
    if (ctx.card && from) this.relayCard(ctx.group, from.bot, ctx.person.id, from.def);
    // the answer reads as the words ("1 free"); its value is the main output itself (for branches)
    const main = values[skill.main];
    return { ok: true, status: 'ok', values, answer: main ? { value: main.value, label: skill.outputs.find((o) => o.id === skill.main)?.kind === 'person' ? main.label : words } : null, words, reason: null, hopId: row.id };
  }

  /** One hop, as a relay card shows it. */
  hop(id: string): BotHop | null { const r = this.link(id); return r ? this.hopOf(r) : null; }

  /** The person asks a failed hop again; the flow carries on when it answers. */
  retryOf(hopId: string, me: PublicUser): { session: string; step: string } {
    const r = this.link(hopId);
    if (!r || r.user_id !== me.id) throw new BotNetError('That was not found.');
    const h = this.hopOf(r);
    if (!h.canRetry) throw new BotNetError('There is nothing to ask again.');
    return { session: r.origin_session!, step: parse<{ step: string }>(r.data, { step: '' }).step };
  }

  // ------------------------------------------------------------ handing over
  /**
   * Hand a request to another bot for a person, with answers carried across. The other bot's
   * steps those answer are passed over (each answer is checked again there); with `start`, its
   * request opens at that stage. Returns the hop and a line for the person.
   */
  async handoff(ctx: NetContext, h: BotHandoff, vars: BotFlowVars, o: { ref?: string | null } = {}): Promise<{ ok: boolean; hop: BotHop | null; line: string; itemId: string | null; convId: string | null }> {
    const now = this.d.now();
    const from = this.d.host.live(ctx.from);
    const ownerId = from?.ownerId ?? null;
    if (ctx.key) {
      const had = this.byKey(ctx.key);
      if (had) return { ok: had.status === 'ok' || had.status === 'returned', hop: this.hopOf(had), line: had.answer ?? had.reason ?? '', itemId: had.target_item, convId: null };
    }
    const target = this.d.host.live(h.to);
    const base = { key: ctx.key ?? null, kind: 'handoff' as const, from_bot: ctx.from, to_bot: h.to, user_id: ctx.person.id, owner_id: ownerId, grp: ctx.group, at: now, origin_item: ctx.originItem ?? null, origin_session: ctx.originSession ?? null };
    const what = `HANDED · ${o.ref ?? from?.def.title ?? ctx.from}`;
    const fail = (status: BotLinkStatus, reason: string) => {
      const row = this.record({ ...base, ask: what, answer: null, status, reason, ms: null, data: { ref: null } });
      if (ctx.card !== false && from) this.relayCard(ctx.group, from.bot, ctx.person.id, from.def);
      return { ok: false, hop: this.hopOf(row), line: reason, itemId: null, convId: null };
    };
    if (!target) return fail('refused', `There is no bot called ${h.to} to hand it to.`);
    if (target.status !== 'live') return fail('failed', `${target.def.title} is ${target.status} by the person who made it.`);
    const refusal = handoffRefusal({ caller: from ? this.party(from) : null, target: this.party(target), targetDef: target.def, ownerMayUse: this.d.host.mayUse(h.to, ownerId), personMayUse: this.d.host.mayUse(h.to, ctx.person.id), targetTitle: target.def.title, start: h.start });
    if (refusal) return fail('refused', refusal);
    const loop = loopRefusal(ctx.trail, ctx.from, h.to, target.def.title);
    if (loop) return fail('loop', loop);
    if (!this.rate.take(`handoff:${ctx.from}`, NET_RATE.handoffs, now) || !this.rate.take(`handoff:${ctx.from}:${h.to}:${ctx.person.id}`, NET_RATE.perPerson, now)) {
      return fail('limited', `${from?.def.title ?? 'This bot'} handed over too often in the last minute. Try again in a minute.`);
    }
    const carried = carryFor(h, vars, target.def, { title: from?.def.title });
    const trail = extendTrail(ctx.trail, ctx.from);
    const row = this.record({ ...base, ask: what, answer: null, status: 'pending', reason: null, ms: null, data: { ref: null, carried: Object.keys(carried) } });
    if (ctx.card !== false && from) this.relayCard(ctx.group, from.bot, ctx.person.id, from.def);
    const t0 = Date.now();
    try {
      let itemId: string | null = null;
      let convId: string | null = null;
      let line: string;
      if (h.start && target.def.track) {
        // straight into a stage of the other bot's track: the earlier stages happened here
        const v: Record<string, BotFlowAnswer> = { user: { value: ctx.person.id, label: ctx.person.displayName } };
        for (const s of target.def.steps) {
          const k = saveKey(s);
          if (!(k in carried)) continue;
          try { v[k] = checkAnswer(s, carried[k], this.answerCtx(ctx.person)); } catch { v[k] = { value: carried[k], label: carried[k] }; }
        }
        v.__trail = { value: trail, label: trail };
        v.__link = { value: row.id, label: row.id };
        const lines = summaryLines(target.def, target.def.steps.map((s) => s.id).filter((id) => { const s = target.def.steps.find((x) => x.id === id)!; return saveKey(s) in v && s.input.kind !== 'confirm'; }), v);
        const item = this.d.items.createAt(target.def, target.version, target.bot, target.ownerId, ctx.person, v, lines, h.start);
        itemId = item.id;
        line = `${target.def.title} has it: ${item.ref}.`;
        this.update(row.id, { status: 'ok', answer: item.ref, ms: Date.now() - t0, target_item: item.id });
        this.setData(row.id, { ref: item.ref });
      } else {
        const r = await this.d.host.startCarried(ctx.person, h.to, carried, { trail, link: row.id, from: ctx.from });
        itemId = r.itemId;
        convId = r.convId;
        const ref = itemId ? this.d.items.refOf(itemId) : null;
        line = r.done ? (ref ? `${target.def.title} has it: ${ref}.` : `${target.def.title} has it.`) : `${target.def.title} carries on in its own conversation: a few more questions there.`;
        this.update(row.id, { status: 'ok', answer: ref ?? (r.done ? 'sent' : 'asking'), ms: Date.now() - t0, target_session: r.sessionId, ...(itemId ? { target_item: itemId } : {}) });
        if (ref) this.setData(row.id, { ref });
      }
      return { ok: true, hop: this.hopOf(this.link(row.id)!), line, itemId, convId };
    } catch (err) {
      const reason = `${target.def.title} could not take it: ${(err as Error).message}`;
      this.update(row.id, { status: 'failed', reason, ms: Date.now() - t0 });
      return { ok: false, hop: this.hopOf(this.link(row.id)!), line: reason, itemId: null, convId: null };
    }
  }

  private setData(id: string, extra: Record<string, unknown>): void {
    const r = this.link(id);
    if (!r) return;
    this.db.prepare('UPDATE bot_links SET data = ? WHERE id = ?').run(JSON.stringify({ ...parse<Record<string, unknown>>(r.data, {}), ...extra }), id);
    if (r.grp) this.refreshGroup(r.grp);
  }

  private answerCtx(me: PublicUser) {
    return {
      now: this.d.now(),
      person: (v: string) => { const u = this.d.store.userById(v) ?? this.d.store.userForAccount(v); return u && u.role !== 'bot' && u.id !== me.id ? { id: u.id, name: u.displayName } : null; },
      file: () => null,
    };
  }

  /** A run that came in by a handoff finished and opened a request: the hop follows that request now. */
  sessionTracked(linkId: string, itemId: string, ref: string): void {
    const r = this.link(linkId);
    if (!r || r.kind !== 'handoff') return;
    this.update(linkId, { target_item: itemId, answer: ref });
    this.setData(linkId, { ref });
  }

  /** A run that came in by a handoff finished without a request to follow (a plain bot): it is back at once. */
  sessionDone(linkId: string, words: string): void {
    const r = this.link(linkId);
    if (!r || r.kind !== 'handoff' || r.target_item) return;
    this.update(linkId, { status: 'returned', back: JSON.stringify({ at: this.d.now(), stamp: 'SENT', words: words.slice(0, 300) }) });
  }

  /** A request of any bot closed: hand it back to the bot that handed it over, and tell the bots listening. */
  itemClosed(def: BotFlowDefinition, item: BotItem): void {
    const r = this.db.prepare("SELECT * FROM bot_links WHERE target_item = ? AND kind = 'handoff' AND status = 'ok' LIMIT 1").get(item.id) as LinkRow | undefined;
    if (r) {
      const note = [...item.history].reverse().find((e) => e.note && e.action !== 'nudge' && e.action !== 'escalate')?.note ?? '';
      const words = `${item.ref} · ${item.stamp ?? 'CLOSED'}${note ? `: ${note}` : ''}`;
      this.update(r.id, { status: 'returned', back: JSON.stringify({ at: this.d.now(), stamp: item.stamp, words: words.slice(0, 300) }) });
      const outcome = item.status === 'done' ? 'done' : 'stopped';
      if (r.origin_item) {
        try { this.d.items.handBack(r.origin_item, def.name, outcome, words); } catch (err) { this.d.log('warn', 'hand back failed', { error: (err as Error).message }); }
      } else {
        const from = this.d.host.live(r.from_bot);
        if (from && r.user_id) this.d.host.say(from.bot, this.d.host.dm(from.bot, r.user_id), `${def.title} handed back ${words}`);
      }
    }
    this.emit(def, item, 'closed');
  }

  /** The cell of a stage that waits on another bot: the bot's mark and how its request stands. */
  stageBot(item: BotItem, stageId: string, flow: string): BotStageBot {
    const t = this.tagOf(flow);
    const r = this.db.prepare("SELECT * FROM bot_links WHERE origin_item = ? AND kind = 'handoff' AND to_bot = ? AND json_extract(data, '$.stage') = ? ORDER BY at DESC LIMIT 1").get(item.id, flow, stageId) as LinkRow | undefined;
    const base = { flow, title: t.title, mark: t.mark, colour: t.colour };
    if (!r) return { ...base, ref: null, label: 'Waiting', status: 'pending' };
    if (r.status === 'refused' || r.status === 'failed' || r.status === 'loop' || r.status === 'limited' || r.status === 'timeout') return { ...base, ref: null, label: 'Did not take it', status: 'failed' };
    const back = parse<BotHop['back']>(r.back, null);
    const ref = parse<{ ref?: string }>(r.data, {}).ref ?? null;
    if (back) return { ...base, ref, label: back.stamp ?? 'Back', status: back.stamp && /NOT|TURNED|STOP|WITHDRAWN/.test(back.stamp) ? 'stopped' : 'done' };
    const target = r.target_item ? this.d.items.peek(r.target_item) : null;
    if (target) {
      const tb = this.d.host.live(flow);
      const st = tb ? stageOf(tb.def, target.stage) : undefined;
      return { ...base, ref: target.ref, label: target.status === 'open' ? st?.label ?? 'Open' : target.stamp ?? 'Closed', status: target.status === 'open' ? 'open' : target.status === 'done' ? 'done' : 'stopped' };
    }
    return { ...base, ref, label: 'Asking', status: 'open' };
  }

  /** A request reached a stage that waits on another bot: hand it over (or, if that fails, to a person). */
  async botStage(def: BotFlowDefinition, item: BotItem, ownerId: string | null): Promise<void> {
    const stage = stageOf(def, item.stage);
    if (!stage?.handoff || !stage.who.startsWith('bot:')) return;
    const person = this.active(item.requesterId);
    if (!person) return;
    const round = item.rounds[stage.id] ?? 1;
    const vars: BotFlowVars = { ...item.vars, ref: { value: item.ref, label: item.ref }, title: { value: item.title, label: item.title } };
    const res = await this.handoff({ from: def.name, person, trail: trailOf(item.vars.__trail?.value), group: item.id, key: `stage:${item.id}:${stage.id}:${round}`, originItem: item.id, card: true }, stage.handoff, vars, { ref: item.ref });
    if (res.hop) this.setData(res.hop.id, { stage: stage.id });
    if (!res.ok) {
      // a person carries it on by hand: the bot's maker, else the person who asked
      const to = ownerId && this.active(ownerId) ? ownerId : item.requesterId;
      this.d.items.assignFallback(item.id, to, res.line);
    }
  }

  // ------------------------------------------------------------ events
  /** A request opened, moved to a stage or closed: bots listening for it act. */
  emit(def: BotFlowDefinition, item: BotItem, what: 'opened' | 'closed' | 'stage'): void {
    const name = what === 'stage' ? `${def.name}.stage.${item.stage}` : `${def.name}.${what}`;
    const vars: BotFlowVars = { ...item.vars, ref: { value: item.ref, label: item.ref }, title: { value: item.title, label: item.title }, stamp: { value: item.stamp ?? '', label: item.stamp ?? '' } };
    this.dispatch(name, def.name, item.requesterId, vars, { item, stamp: item.stamp, trail: trailOf(item.vars.__trail?.value), key: `${item.id}:${name}:${item.history.length}` });
  }

  /** Someone goes on leave (Nib's leave note): bots listening act for them. */
  emitAway(userId: string, from: string, to: string | null): void {
    const u = this.d.store.userById(userId);
    if (!u) return;
    const vars: BotFlowVars = { user: { value: u.id, label: u.displayName }, from: { value: from, label: from }, to: { value: to ?? '', label: to ?? '' } };
    this.dispatch('nib.away', 'nib', userId, vars, { item: null, stamp: null, trail: [], key: `away:${userId}:${from}` });
  }

  private dispatch(name: string, source: string, personId: string, vars: BotFlowVars, o: { item: BotItem | null; stamp: string | null; trail: string[]; key: string }): void {
    const subs: Array<{ b: NetBot; s: BotSubscription }> = [];
    for (const b of this.d.host.all()) {
      if (b.status !== 'live') continue;
      for (const s of b.def.network?.on ?? []) if (s.on === name && (!s.stamp || s.stamp === (o.stamp ?? '').toUpperCase())) subs.push({ b, s });
    }
    if (!subs.length) return;
    // later, so the request that moved is saved and its cards are drawn first
    this.track(new Promise<void>((resolve) => setImmediate(resolve)).then(async () => {
      for (const { b, s } of subs.slice(0, 20)) {
        try { await this.react(b, s, name, source, personId, vars, o); } catch (err) { this.d.log('warn', 'bot event reaction failed', { bot: b.def.name, error: (err as Error).message }); }
      }
    }));
  }

  private async react(b: NetBot, s: BotSubscription, name: string, source: string, personId: string, vars: BotFlowVars, o: { item: BotItem | null; trail: string[]; key: string }): Promise<void> {
    const now = this.d.now();
    const key = `evt:${o.key}:${b.def.name}:${s.id}`;
    if (this.byKey(key)) return;
    const person = this.active(personId);
    const label = o.item ? `${name.split('.').slice(1).join('.').toUpperCase()} · ${o.item.ref}` : `AWAY · ${person?.displayName ?? ''}`;
    const base = { key, kind: 'event' as const, from_bot: source, to_bot: b.def.name, user_id: personId, owner_id: b.ownerId, grp: o.item?.id ?? `away:${personId}`, at: now, origin_item: o.item?.id ?? null, origin_session: null, ms: null };
    const refuse = (status: BotLinkStatus, reason: string) => { this.record({ ...base, ask: label, answer: null, status, reason }); };
    // who may listen: the maker may use the bot it listens to (Nib's leave: anyone's bots)
    if (source !== 'nib') {
      const src = this.d.host.live(source);
      if (!src) return;
      if (!this.d.host.mayUse(source, b.ownerId) && src.scope !== 'office') { refuse('refused', `${src.def.title} is not shared with the maker of ${b.def.title}.`); return; }
      if ((src.def.network?.share ?? 'users') === 'owner' && src.ownerId !== b.ownerId) { refuse('refused', `${src.def.title} tells only its own maker’s bots.`); return; }
    }
    const loop = loopRefusal(o.trail, source, b.def.name, b.def.title);
    if (loop) { refuse('loop', loop); return; }
    if (!this.rate.take(`event:${b.def.name}`, NET_RATE.events, now)) { refuse('limited', `${b.def.title} heard too much in the last minute.`); return; }
    if (!person) { refuse('failed', 'The person it is about is not in the office any more.'); return; }
    const trail = extendTrail(o.trail, source);
    if (s.do === 'tell') {
      const owner = b.ownerId ? this.active(b.ownerId) : null;
      if (!owner) { refuse('failed', `${b.def.title} has no maker to tell.`); return; }
      // a maker hears only about requests they could open anyway
      if (o.item && !this.d.items.visibleTo(source, o.item, owner.id)) { refuse('refused', `${owner.displayName} may not see ${o.item.ref}.`); return; }
      const text = renderTemplate(s.text ?? '', { ...vars, user: { value: person.id, label: person.displayName } }).slice(0, 2000);
      this.d.host.say(b.bot, this.d.host.dm(b.bot, owner.id), text);
      this.record({ ...base, ask: label, answer: 'told', status: 'ok', reason: null });
      return;
    }
    if (s.do === 'ask' && s.ask) {
      const res = await this.ask({ from: b.def.name, person, trail: o.trail, group: base.grp, key: `${key}:ask`, card: false }, s.ask, vars);
      this.record({ ...base, ask: label, answer: res.ok ? res.words : null, status: res.ok ? 'ok' : res.status, reason: res.reason });
      if (res.ok && s.text) {
        const owner = b.ownerId ? this.active(b.ownerId) : null;
        const text = renderTemplate(s.text, { ...vars, result: res.answer ?? { value: '', label: '' }, ...Object.fromEntries(Object.entries(res.values).map(([k, v]) => [`result.${k}`, v])) });
        if (owner) this.d.host.say(b.bot, this.d.host.dm(b.bot, owner.id), text);
      }
      return;
    }
    // start: this bot's conversation for the person it is about, with answers carried in
    if (!this.d.host.mayUse(b.def.name, person.id)) { refuse('refused', `${person.displayName} cannot use ${b.def.title}.`); return; }
    const row = this.record({ ...base, ask: label, answer: null, status: 'pending', reason: null });
    try {
      const carried = carryFor({ carry: s.carry }, vars, b.def);
      const r = await this.d.host.startCarried(person, b.def.name, carried, { trail, link: row.id, from: source });
      this.update(row.id, { status: 'ok', answer: r.done ? 'sent' : 'started', target_session: r.sessionId, ...(r.itemId ? { target_item: r.itemId } : {}) });
    } catch (err) {
      this.update(row.id, { status: 'failed', reason: (err as Error).message });
    }
  }

  // ------------------------------------------------------------ the network sheet
  /** The bots as tags and their connections, weighted by the last week's traffic. */
  map(me: PublicUser, scope: 'mine' | 'office'): BotNetMap {
    const admin = me.role === 'owner' || me.role === 'admin';
    const office = scope === 'office' && admin;
    const all = this.d.host.all();
    const mine = new Set(all.filter((b) => b.ownerId === me.id).map((b) => b.def.name));
    const edges = new Map<string, BotNetMap['edges'][number]>();
    const edge = (from: string, to: string) => {
      const k = `${from}>${to}`;
      let e = edges.get(k);
      if (!e) { e = { from, to, kinds: [], declared: false, count: 0, failures: 0, lastAt: null }; edges.set(k, e); }
      return e;
    };
    for (const b of all) {
      if (!office && !mine.has(b.def.name)) continue;
      for (const l of declaredLinks(b.def)) {
        // an event goes from the bot it comes from to the one listening
        const e = l.kind === 'event' ? edge(l.to, b.def.name) : edge(b.def.name, l.to);
        e.declared = true;
        if (!e.kinds.includes(l.kind)) e.kinds.push(l.kind);
      }
    }
    const since = this.d.now() - 7 * DAY;
    const rows = this.db.prepare('SELECT from_bot, to_bot, kind, status, COUNT(*) AS n, MAX(at) AS last FROM bot_links WHERE at > ? GROUP BY from_bot, to_bot, kind, status').all(since) as Array<{ from_bot: string; to_bot: string; kind: BotLinkKind; status: BotLinkStatus; n: number; last: number }>;
    for (const r of rows) {
      if (!office && !mine.has(r.from_bot) && !mine.has(r.to_bot)) continue;
      const e = edge(r.from_bot, r.to_bot);
      if (!e.kinds.includes(r.kind)) e.kinds.push(r.kind);
      e.count += r.n;
      if (!['ok', 'returned', 'pending'].includes(r.status)) e.failures += r.n;
      e.lastAt = Math.max(e.lastAt ?? 0, r.last);
    }
    const keys = new Set<string>([...(office ? all.map((b) => b.def.name) : [...mine])]);
    for (const e of edges.values()) { keys.add(e.from); keys.add(e.to); }
    const nodes = [...keys].map((k) => {
      const b = all.find((x) => x.def.name === k);
      return { ...this.tagOf(k), ownerId: b?.ownerId ?? null, scopeOf: (SYSTEM_BOTS.includes(k) ? 'system' : b?.scope ?? 'private') as BotScope | 'system', mine: mine.has(k) };
    }).filter((n) => n.system || all.some((b) => b.def.name === n.key));
    return { scope: office ? 'office' : 'mine', nodes, edges: [...edges.values()].filter((e) => nodes.some((n) => n.key === e.from) && nodes.some((n) => n.key === e.to)), at: this.d.now() };
  }

  /** Recent exchanges along one line (both ways). Makers see their own bots' lines; names only for administrators. */
  edge(me: PublicUser, from: string, to: string): BotNetExchange[] {
    const admin = me.role === 'owner' || me.role === 'admin';
    if (!admin) {
      const own = [from, to].some((k) => this.d.host.live(k)?.ownerId === me.id);
      if (!own) throw new BotNetError('That line is not one of your bots’.');
    }
    const rows = this.db.prepare('SELECT * FROM bot_links WHERE (from_bot = ? AND to_bot = ?) OR (from_bot = ? AND to_bot = ?) ORDER BY at DESC LIMIT 40').all(from, to, to, from) as unknown as LinkRow[];
    return rows.map((r) => ({ id: r.id, kind: r.kind, at: r.at, ask: r.ask, answer: r.answer, status: r.status, reason: r.reason, ms: r.ms, userId: admin ? r.user_id : null }));
  }

  /** Checks a bot's network parts as its maker saves it: every skill, bot and event it names is one they may use. */
  checkSave(me: PublicUser, def: BotFlowDefinition): void {
    const asks: BotAsk[] = [...def.steps.filter((s) => s.ask).map((s) => s.ask!), ...(def.network?.on ?? []).filter((s) => s.ask).map((s) => s.ask!), ...(def.jobs ?? []).flatMap((j) => (j.do.do === 'check' || j.do.do === 'ask' ? [j.do.ask] : []))];
    const known = this.skillsFor(me.id, def.name);
    for (const a of asks) {
      if (skillBot(a.skill) === def.name) continue;
      if (!known.some((s) => s.id === a.skill)) throw new BotNetError(`“${a.skill}” is not a skill your bots can ask. Pick one from the list.`);
    }
    const handTo = [...def.finish.filter((a) => a.do === 'handoff').map((a) => (a as BotHandoff).to), ...(def.track?.stages ?? []).flatMap((s) => [...(s.who.startsWith('bot:') ? [s.who.slice(4)] : []), ...s.actions.filter((a) => a.handoff).map((a) => a.handoff!.to)])];
    for (const to of handTo) {
      if (to === def.name) throw new BotNetError(`${def.title} cannot hand a request to itself.`);
      const t = this.d.host.live(to);
      if (!t) throw new BotNetError(`There is no bot called ${to} to hand requests to.`);
      if (!this.d.host.mayUse(to, me.id) && t.ownerId !== me.id) throw new BotNetError(`${t.def.title} is not a bot you can use, so yours cannot hand to it.`);
    }
    for (const s of def.network?.on ?? []) {
      if (s.on === 'nib.away') continue;
      const src = this.d.host.live(s.on.split('.')[0]);
      if (!src) throw new BotNetError(`There is no bot called ${s.on.split('.')[0]} to listen to.`);
      if (!this.d.host.mayUse(src.def.name, me.id) && src.ownerId !== me.id) throw new BotNetError(`${src.def.title} is not a bot you can use, so yours cannot listen to it.`);
    }
  }
}
