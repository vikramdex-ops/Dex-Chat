// Tracked requests on the hub: what a bot's "track" does once someone has sent it. Each request
// is numbered and kept here; at each stage the person acting gets one card in their conversation
// with the bot (and a Desk task), the person who asked watches their own card move, queues with
// limited places hand the next place on, reminders are gathered into one list per person and come
// only during working hours, and the register is one card that replaces the one before. The
// rules themselves are in @dex/core/bottrack, shared with the bot maker's test run.
import type { DatabaseSync } from 'node:sqlite';
import { ulid } from '@dex/core';
import type { BotFlowCard, BotFlowDefinition, BotItem, BotRegisterView, BotTrackView, PublicUser } from '@dex/core';
import { BotFlowError, localDate, withinHours } from '@dex/core/botflows';
import { OFFICE_WEEK, nudgeDue, personAnswer, queueOf, registerView, seatKey, seatLimit, stageOf, trackAct, trackNoted, trackOpen, trackTakeOver, trackTick, trackView, trackWithdraw } from '@dex/core/bottrack';
import type { TrackPeople } from '@dex/core/bottrack';
import type { Desk } from './desk.ts';
import type { Messaging } from './messaging.ts';
import type { Store } from './store.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bot_items (
  id TEXT PRIMARY KEY,
  flow TEXT NOT NULL,
  flow_version INTEGER,
  num INTEGER NOT NULL,
  bot_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  actor_id TEXT,
  status TEXT NOT NULL,
  stage TEXT,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bot_items_flow ON bot_items(flow, status);
CREATE INDEX IF NOT EXISTS idx_bot_items_actor ON bot_items(actor_id, status);
CREATE TABLE IF NOT EXISTS bot_item_cards (
  client_id TEXT PRIMARY KEY,
  item_id TEXT,
  flow TEXT NOT NULL,
  user_id TEXT,
  conv_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  superseded INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bot_item_cards_item ON bot_item_cards(item_id);
CREATE INDEX IF NOT EXISTS idx_bot_item_cards_flow ON bot_item_cards(flow, purpose, superseded);
`;

const DAY = 24 * 3600_000;
/** Open requests read for a register (and for queues); the register shows the oldest first. */
const MAX_OPEN = 400;

interface ItemRow { id: string; flow: string; flow_version: number | null; num: number; bot_id: string; requester_id: string; data: string; status: string }
/** The request plus what only the hub keeps: the Desk task of the stage it is in. */
type Kept = BotItem & { taskId?: string | null };
type CardPurpose = 'requester' | 'actor' | 'register';

export interface BotItemsDeps {
  db: DatabaseSync;
  store: Store;
  messaging: Messaging;
  desk: Desk;
  log: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
  /** The clock (tests move it). */
  now: () => number;
  /** The definition a request runs on (the revision it was sent on), its bot and the bot's maker; null when switched off. */
  flowOf: (flow: string, version: number | null) => { def: BotFlowDefinition; bot: PublicUser; ownerId: string | null } | null;
  /** Post a card as the bot; returns its client id. */
  postCard: (bot: PublicUser, convId: string, body: string, kind: BotFlowCard['kind'], data: Record<string, unknown>) => string;
  refreshCard: (clientId: string) => void;
  dm: (bot: PublicUser, userId: string) => string;
  say: (bot: PublicUser, convId: string, text: string) => void;
}

export class BotItems {
  private readonly db: DatabaseSync;
  private readonly d: BotItemsDeps;

  constructor(deps: BotItemsDeps) {
    this.d = deps;
    this.db = deps.db;
    this.db.exec(SCHEMA);
  }

  // ------------------------------------------------------------ keeping
  private load(id: string): { item: Kept; row: ItemRow } | null {
    const row = this.db.prepare('SELECT * FROM bot_items WHERE id = ?').get(id) as ItemRow | undefined;
    if (!row) return null;
    try { return { item: JSON.parse(row.data) as Kept, row }; } catch { return null; }
  }

  private store(item: Kept, row: Pick<ItemRow, 'flow_version' | 'bot_id' | 'num'>): void {
    this.db.prepare(`INSERT INTO bot_items (id, flow, flow_version, num, bot_id, requester_id, actor_id, status, stage, data, created_at, updated_at, closed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET actor_id = excluded.actor_id, status = excluded.status, stage = excluded.stage, data = excluded.data, updated_at = excluded.updated_at, closed_at = excluded.closed_at`)
      .run(item.id, item.flow, row.flow_version, row.num, row.bot_id, item.requesterId, item.actorId, item.status, item.stage, JSON.stringify(item), item.createdAt, item.updatedAt, item.closedAt);
  }

  private openOf(flow: string): Kept[] {
    return (this.db.prepare("SELECT data FROM bot_items WHERE flow = ? AND status = 'open' ORDER BY created_at LIMIT ?").all(flow, MAX_OPEN) as Array<{ data: string }>)
      .map((r) => { try { return JSON.parse(r.data) as Kept; } catch { return null; } }).filter((x): x is Kept => !!x);
  }

  private closedOf(flow: string, since: number): Kept[] {
    return (this.db.prepare("SELECT data FROM bot_items WHERE flow = ? AND status != 'open' AND closed_at > ? ORDER BY closed_at DESC LIMIT 50").all(flow, since) as Array<{ data: string }>)
      .map((r) => { try { return JSON.parse(r.data) as Kept; } catch { return null; } }).filter((x): x is Kept => !!x);
  }

  // ------------------------------------------------------------ people
  /** A person's lead from the directory: their manager, else their department's head (never themselves). */
  leadOf(userId: string): PublicUser | null {
    const u = this.d.store.userById(userId);
    if (!u) return null;
    const ok = (id: string | null | undefined) => {
      if (!id || id === userId) return null;
      const p = this.d.store.userById(id);
      return p && p.role !== 'bot' && this.active(p.id) ? p : null;
    };
    const m = ok(u.profile.managerId);
    if (m) return m;
    if (!u.profile.departmentId) return null;
    const head = this.db.prepare('SELECT head_id FROM departments WHERE id = ?').get(u.profile.departmentId) as { head_id: string | null } | undefined;
    return ok(head?.head_id);
  }

  private active(id: string): boolean { return this.d.store.activeUsers().some((u) => u.id === id); }

  private people(def: BotFlowDefinition, ownerId: string | null): TrackPeople {
    return {
      resolve: (who, item) => {
        const now = this.d.now();
        let id: string | null = null;
        if (who === 'requester') id = item.requesterId;
        else {
          id = personAnswer(def, who, item);
          if (!id && who === 'lead') id = this.leadOf(item.requesterId)?.id ?? null;
          if (!id && who.startsWith('role:')) {
            const p = def.track?.roles?.[who.slice(5)]?.person;
            id = p && this.active(p) ? p : null;
          }
          if (!id) id = ownerId && this.active(ownerId) ? ownerId : item.requesterId;
        }
        // out of office with someone covering: it goes to them
        const u = this.d.store.userById(id);
        if (u?.ooo && u.ooo.until > now && u.ooo.delegateId && u.ooo.delegateId !== id && this.active(u.ooo.delegateId)) return { id: u.ooo.delegateId, note: `ooo:${u.id}` };
        return { id };
      },
    };
  }

  /** Who reminders are passed up to for a request: the lead of the person sitting on it, or a role. */
  private escalateTo(def: BotFlowDefinition, item: Kept, ownerId: string | null): string | null {
    const esc = def.track?.remind?.escalate ?? 'lead';
    if (esc === 'none' || !item.actorId) return null;
    let to: string | null = null;
    if (esc === 'lead') to = this.leadOf(item.actorId)?.id ?? (ownerId && ownerId !== item.actorId ? ownerId : null);
    else if (esc.startsWith('role:')) to = def.track?.roles?.[esc.slice(5)]?.person ?? ownerId;
    return to && to !== item.actorId && this.active(to) ? to : null;
  }

  /** The people who hold a bot's roles (its maker for roles no one holds). */
  private roleHolders(def: BotFlowDefinition, ownerId: string | null): Set<string> {
    const out = new Set<string>();
    for (const r of Object.values(def.track?.roles ?? {})) { const p = r.person ?? ownerId; if (p) out.add(p); }
    if (ownerId) out.add(ownerId);
    return out;
  }

  /** May this person see a request? Those in it, its leads, the bot's maker and role holders, administrators. */
  private canSee(def: BotFlowDefinition, ownerId: string | null, item: Kept, me: string): boolean {
    // anyone it has been with: they acted on it, or were reminded of it
    if (item.requesterId === me || item.actorId === me || item.history.some((e) => e.by === me || ((e.action === 'nudge' || e.action === 'escalate') && e.note === me))) return true;
    const u = this.d.store.userById(me);
    if (u && (u.role === 'owner' || u.role === 'admin')) return true;
    if (this.roleHolders(def, ownerId).has(me)) return true;
    return this.leadOf(item.requesterId)?.id === me || (!!item.actorId && this.leadOf(item.actorId)?.id === me);
  }

  /** May this person take over the stage? The lead of whoever is acting, the bot's maker, an administrator. */
  private canTakeOver(def: BotFlowDefinition, ownerId: string | null, item: Kept, me: string): boolean {
    if (item.status !== 'open' || item.waiting || item.actorId === me || item.requesterId === me) return false;
    if (ownerId === me) return true;
    const u = this.d.store.userById(me);
    if (u && (u.role === 'owner' || u.role === 'admin')) return true;
    return !!item.actorId && (this.leadOf(item.actorId)?.id === me || this.escalateTo(def, item, ownerId) === me);
  }

  // ------------------------------------------------------------ cards
  private cardFor(bot: PublicUser, def: BotFlowDefinition, item: Kept, userId: string, purpose: CardPurpose, body: string): void {
    const convId = this.d.dm(bot, userId);
    // the newest card for this request in this conversation is the one that acts; older ones fold
    const older = this.db.prepare("SELECT client_id FROM bot_item_cards WHERE item_id = ? AND user_id = ? AND purpose = 'actor' AND superseded = 0").all(item.id, userId) as Array<{ client_id: string }>;
    const persona = def.persona ? { mark: def.persona.mark, colour: def.persona.colour } : null;
    const clientId = this.d.postCard(bot, convId, body, 'track', { title: def.title, itemId: item.id, ownerId: userId, ...(persona ? { persona } : {}) });
    this.db.prepare('INSERT INTO bot_item_cards (client_id, item_id, flow, user_id, conv_id, purpose, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(clientId, item.id, item.flow, userId, convId, purpose, this.d.now());
    for (const o of older) { this.db.prepare('UPDATE bot_item_cards SET superseded = 1 WHERE client_id = ?').run(o.client_id); this.d.refreshCard(o.client_id); }
  }

  /** The person who asked keeps the card the bot finished on; it follows the request from now on. */
  attachRequesterCard(clientId: string, item: Pick<BotItem, 'id' | 'flow' | 'requesterId'>, convId: string): void {
    this.db.prepare('INSERT OR IGNORE INTO bot_item_cards (client_id, item_id, flow, user_id, conv_id, purpose, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(clientId, item.id, item.flow, item.requesterId, convId, 'requester', this.d.now());
  }

  private refreshItem(item: Pick<BotItem, 'id' | 'flow'>): void {
    for (const r of this.db.prepare('SELECT client_id FROM bot_item_cards WHERE item_id = ? AND superseded = 0').all(item.id) as Array<{ client_id: string }>) this.d.refreshCard(r.client_id);
    for (const r of this.db.prepare("SELECT client_id FROM bot_item_cards WHERE flow = ? AND purpose = 'register' AND superseded = 0").all(item.flow) as Array<{ client_id: string }>) this.d.refreshCard(r.client_id);
  }

  /** What a card shows now (called each time its message is drawn), or null when it is not ours. */
  cardView(clientId: string, data: { itemId?: string; flow?: string; mode?: BotRegisterView['mode']; ownerId?: string; itemIds?: string[]; space?: boolean }): Pick<BotFlowCard, 'track' | 'register'> | null {
    const meta = this.db.prepare('SELECT superseded FROM bot_item_cards WHERE client_id = ?').get(clientId) as { superseded: number } | undefined;
    const moved = !!meta?.superseded;
    if (data.itemId) {
      const got = this.load(data.itemId);
      if (!got) return { track: null };
      const f = this.d.flowOf(got.item.flow, got.row.flow_version);
      if (!f) return { track: null };
      const viewer = data.ownerId ?? got.item.requesterId;
      const now = this.d.now();
      const stage = stageOf(f.def, got.item.stage);
      const peers = stage && got.item.status === 'open' ? this.openOf(got.item.flow).filter((x) => x.stage === stage.id) : [];
      return { track: trackView(f.def, got.item, viewer, { now, moved, canTakeOver: this.canTakeOver(f.def, f.ownerId, got.item, viewer), queue: peers.length ? queueOf(f.def, got.item, peers) : null }) };
    }
    if (data.flow) return { register: this.register(data.flow, data.ownerId ?? null, data.mode ?? 'all', { moved, itemIds: data.itemIds, space: data.space }) };
    return null;
  }

  /** A bot's register as one person (or, for a card in a Space, its people) may see it. */
  register(flow: string, viewer: string | null, mode: BotRegisterView['mode'], o: { moved?: boolean; itemIds?: string[]; space?: boolean } = {}): BotRegisterView | null {
    const row = this.db.prepare('SELECT flow_version FROM bot_items WHERE flow = ? ORDER BY created_at DESC LIMIT 1').get(flow) as { flow_version: number | null } | undefined;
    const f = this.d.flowOf(flow, null) ?? (row ? this.d.flowOf(flow, row.flow_version) : null);
    if (!f) return null;
    const now = this.d.now();
    const see = (i: Kept) => o.space || (viewer !== null && this.canSee(f.def, f.ownerId, i, viewer));
    let open = this.openOf(flow);
    const queues = open;
    if (mode === 'mine') open = open.filter((i) => i.actorId === viewer && !i.waiting);
    else if (mode === 'team') open = open.filter((i) => o.itemIds?.includes(i.id));
    else open = open.filter(see);
    const closed = mode === 'all' ? this.closedOf(flow, now - 7 * DAY).filter(see) : [];
    const v = registerView(f.def, o.moved ? [] : open, o.moved ? [] : closed, { mode, viewerId: viewer ?? '', now, canTakeOver: (i) => viewer !== null && this.canTakeOver(f.def, f.ownerId, i, viewer as string) });
    // a queue's place counts everyone in it, not only the requests this person may open; and who
    // holds a seat now is for everyone who may use the bot
    if (!o.moved) {
      v.rows = v.rows.map((r) => { const it = queues.find((q) => q.id === r.itemId); return it ? { ...r, queue: queueOf(f.def, it, queues) } : r; });
      if (v.seats.length) v.seats = registerView(f.def, queues, [], { mode, viewerId: viewer ?? '', now, limit: 0 }).seats;
    }
    return o.moved ? { ...v, moved: true } : v;
  }

  /** Post the register as a card into a conversation, folding the one before it there. */
  postRegister(bot: PublicUser, def: BotFlowDefinition, convId: string, viewer: string | null, mode: BotRegisterView['mode'], body: string, extra: { itemIds?: string[]; space?: boolean } = {}): string {
    const older = this.db.prepare("SELECT client_id FROM bot_item_cards WHERE flow = ? AND conv_id = ? AND purpose = 'register' AND superseded = 0").all(def.name, convId) as Array<{ client_id: string }>;
    const persona = def.persona ? { mark: def.persona.mark, colour: def.persona.colour } : null;
    const clientId = this.d.postCard(bot, convId, body, 'register', { title: def.title, flow: def.name, mode, ...(viewer ? { ownerId: viewer } : {}), ...(extra.itemIds ? { itemIds: extra.itemIds } : {}), ...(extra.space ? { space: true } : {}), ...(persona ? { persona } : {}) });
    this.db.prepare('INSERT INTO bot_item_cards (client_id, item_id, flow, user_id, conv_id, purpose, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?)').run(clientId, def.name, viewer, convId, 'register', this.d.now());
    for (const o of older) { this.db.prepare('UPDATE bot_item_cards SET superseded = 1 WHERE client_id = ?').run(o.client_id); this.d.refreshCard(o.client_id); }
    return clientId;
  }

  // ------------------------------------------------------------ moving a request on
  private taskFor(item: Kept, def: BotFlowDefinition): void {
    const stage = stageOf(def, item.stage);
    if (!stage || !item.actorId || item.waiting) return;
    if (!(stage.task ?? item.actorId !== item.requesterId)) return;
    const asker = this.d.store.userById(item.requesterId);
    if (!asker) return;
    try {
      const due = item.due && item.due > this.d.now() ? item.due : this.d.now() + DAY;
      const r = this.d.desk.handle('remind.create', asker, { forUserId: item.actorId, text: `${item.ref} · ${stage.label}: ${item.title}`.slice(0, 500), dueAt: due }) as { id: string };
      item.taskId = r.id;
    } catch (err) { this.d.log('warn', 'tracked request task not created', { item: item.ref, error: (err as Error).message }); }
  }

  private closeTask(item: Kept): void {
    if (!item.taskId) return;
    const asker = this.d.store.userById(item.requesterId);
    try { if (asker) this.d.desk.handle('remind.update', asker, { id: item.taskId, done: true }); } catch { /* removed from the Desk already */ }
    item.taskId = null;
  }

  /** Places in a stage with a limit: wait when they are all taken. Returns true when it waits. */
  private seat(def: BotFlowDefinition, item: Kept): boolean {
    const stage = stageOf(def, item.stage);
    if (!stage?.limit) return false;
    const key = seatKey(stage, item);
    const held = this.openOf(item.flow).filter((x) => x.id !== item.id && x.stage === stage.id && !x.waiting && seatKey(stage, x) === key).length;
    if (held < seatLimit(stage, key, item)) return false;
    item.waiting = true;
    return true;
  }

  /** A place came free in `stageId`: the longest-waiting request with the same key moves up. */
  private promote(def: BotFlowDefinition, bot: PublicUser, flow: string, stageId: string, key: string): void {
    const stage = stageOf(def, stageId);
    if (!stage?.limit) return;
    const open = this.openOf(flow);
    const held = open.filter((x) => x.stage === stageId && !x.waiting && seatKey(stage, x) === key).length;
    if (held >= seatLimit(stage, key, open.find((x) => seatKey(stage, x) === key))) return;
    const next = open.filter((x) => x.stage === stageId && x.waiting && seatKey(stage, x) === key).sort((a, b) => a.since - b.since || a.createdAt - b.createdAt)[0];
    const got = next ? this.load(next.id) : null;
    if (!got) return;
    const now = this.d.now();
    const item: Kept = { ...got.item, waiting: false, since: now, updatedAt: now, history: [...got.item.history, { at: now, by: null, stage: stageId, action: 'seat', label: 'Your turn' }] };
    this.taskFor(item, def);
    this.store(item, got.row);
    if (item.actorId) this.cardFor(bot, def, item, item.actorId, 'actor', `${item.ref}: ${key} is free. It is yours now.`);
    this.refreshItem(item);
  }

  /** After any move: tasks, places in queues, the cards of the next person, and a word when it closes. */
  private moved(def: BotFlowDefinition, bot: PublicUser, before: Kept | null, after: Kept, row: Pick<ItemRow, 'flow_version' | 'bot_id' | 'num'>, opts: { fresh?: boolean; by?: string } = {}): Kept {
    const sameStage = !!before && before.stage === after.stage && before.status === 'open' && after.status === 'open';
    const reentered = sameStage && after.since !== before.since;
    if (before && (!sameStage || reentered || before.actorId !== after.actorId)) { after.taskId = before.taskId ?? null; this.closeTask(after); }
    let waits = false;
    if (after.status === 'open' && !sameStage) waits = this.seat(def, after);
    if (after.status === 'open' && !waits && (!sameStage || reentered || before?.actorId !== after.actorId)) this.taskFor(after, def);
    this.store(after, row);
    const stage = stageOf(def, after.stage);
    // the person acting next is told with a card of their own (the person who asked already has one when it starts with them)
    if (after.status === 'open' && !waits && after.actorId && !sameStage && !(opts.fresh && after.actorId === after.requesterId)) {
      this.cardFor(bot, def, after, after.actorId, 'actor', `${after.ref} · ${stage?.label ?? ''}: ${after.title}`);
    }
    if (waits && !opts.fresh) this.say(bot, after.requesterId, `${after.ref}: every place is taken. You are in line, and this card moves up when one is free.`);
    // someone is waiting: the person who has held a place longest is asked (once, politely) whether they are done
    if (waits && stage) this.askHolder(def, bot, after);
    // a place came free
    if (before && before.status === 'open' && !before.waiting && stageOf(def, before.stage)?.limit && (!sameStage ? true : after.status !== 'open')) {
      this.promote(def, bot, after.flow, before.stage!, seatKey(stageOf(def, before.stage)!, before));
    }
    if (after.status !== 'open' && before?.status === 'open' && opts.by !== after.requesterId) {
      this.say(bot, after.requesterId, `${after.ref} · ${after.stamp ?? ''}: ${after.title}`);
    }
    this.refreshItem(after);
    return after;
  }

  private say(bot: PublicUser, userId: string, text: string): void {
    try { this.d.say(bot, this.d.dm(bot, userId), text); } catch (err) { this.d.log('warn', 'tracked request word not posted', { error: (err as Error).message }); }
  }

  private askHolder(def: BotFlowDefinition, bot: PublicUser, waiter: Kept): void {
    const stage = stageOf(def, waiter.stage);
    if (!stage) return;
    const now = this.d.now();
    const key = seatKey(stage, waiter);
    const holder = this.openOf(waiter.flow).filter((x) => x.stage === stage.id && !x.waiting && seatKey(stage, x) === key && now - x.since > 3600_000 && x.nudges < (def.track?.remind?.times ?? 2))
      .sort((a, b) => a.since - b.since)[0];
    if (!holder || !holder.actorId) return;
    const got = this.load(holder.id);
    if (!got) return;
    const name = this.d.store.userById(waiter.requesterId)?.displayName ?? 'Someone';
    this.say(bot, holder.actorId, `${name} is waiting for ${key}. If you are done with ${holder.ref}, release it on its card.`);
    const noted = trackNoted(got.item, 'nudge', now, holder.actorId) as Kept;
    this.store(noted, got.row);
    this.refreshItem(noted);
  }

  /** A request is sent: numbered, at its first stage, the first person told. */
  create(def: BotFlowDefinition, version: number | null, bot: PublicUser, ownerId: string | null, requester: PublicUser, vars: BotItem['vars'], lines: BotItem['lines']): Kept {
    const num = ((this.db.prepare('SELECT MAX(num) AS n FROM bot_items WHERE flow = ?').get(def.name) as { n: number | null }).n ?? 0) + 1;
    const item = trackOpen(def, { id: ulid(), num, requesterId: requester.id, vars, lines, now: this.d.now(), people: this.people(def, ownerId) }) as Kept;
    return this.moved(def, bot, null, item, { flow_version: version, bot_id: bot.id, num }, { fresh: true, by: requester.id });
  }

  /** The words for the closing card of a tracked bot. */
  notesFor(def: BotFlowDefinition, item: Kept): string[] {
    const stage = stageOf(def, item.stage);
    const who = item.actorId ? this.d.store.userById(item.actorId)?.displayName ?? '' : '';
    if (item.waiting) return [`${item.ref}: in line for a place. This card shows where you are.`];
    return [`${item.ref}: ${stage?.label ?? ''}${who && item.actorId !== item.requesterId ? `, with ${who}` : ''}. This card follows it.`];
  }

  private flowFor(row: ItemRow): { def: BotFlowDefinition; bot: PublicUser; ownerId: string | null } {
    const f = this.d.flowOf(row.flow, row.flow_version);
    if (!f) throw new BotFlowError('This bot was switched off, so its requests are paused.');
    return f;
  }

  private mine(me: PublicUser, itemId: string): { item: Kept; row: ItemRow; f: { def: BotFlowDefinition; bot: PublicUser; ownerId: string | null } } {
    const got = this.load(itemId);
    if (!got) throw new BotFlowError('That request was not found.');
    const f = this.flowFor(got.row);
    if (!this.canSee(f.def, f.ownerId, got.item, me.id)) throw new BotFlowError('That request was not found.');
    return { ...got, f };
  }

  private viewFor(me: PublicUser, itemId: string): BotTrackView {
    const { item, f } = this.mine(me, itemId);
    const stage = stageOf(f.def, item.stage);
    const peers = stage && item.status === 'open' ? this.openOf(item.flow).filter((x) => x.stage === stage.id) : [];
    return trackView(f.def, item, me.id, { now: this.d.now(), canTakeOver: this.canTakeOver(f.def, f.ownerId, item, me.id), queue: peers.length ? queueOf(f.def, item, peers) : null });
  }

  // ------------------------------------------------------------ operations
  handle(op: string, me: PublicUser, d: Record<string, unknown>): unknown {
    const itemId = typeof d.itemId === 'string' ? d.itemId : '';
    switch (op) {
      case 'botflow.item':
        return { track: this.viewFor(me, itemId) };
      case 'botflow.act': {
        const { item, row, f } = this.mine(me, itemId);
        const after = trackAct(f.def, item, String(d.action ?? ''), me.id, this.d.now(), this.people(f.def, f.ownerId), typeof d.note === 'string' ? d.note : '') as Kept;
        after.taskId = item.taskId;
        this.moved(f.def, f.bot, item, after, row, { by: me.id });
        this.d.store.audit(me.id, 'botflow.item.acted', item.id, { flow: item.flow, ref: item.ref, action: String(d.action ?? ''), stage: item.stage });
        return { ok: true, track: this.viewFor(me, itemId) };
      }
      case 'botflow.tick': {
        const { item, row, f } = this.mine(me, itemId);
        const after = trackTick(f.def, item, Number(d.index), d.on === true, me.id) as Kept;
        this.store(after, row);
        this.refreshItem(after);
        return { ok: true, track: this.viewFor(me, itemId) };
      }
      case 'botflow.withdraw': {
        const { item, row, f } = this.mine(me, itemId);
        const after = trackWithdraw(item, me.id, this.d.now(), typeof d.note === 'string' ? d.note : '') as Kept;
        after.taskId = item.taskId;
        this.moved(f.def, f.bot, item, after, row, { by: me.id });
        return { ok: true, track: this.viewFor(me, itemId) };
      }
      case 'botflow.takeover': {
        const { item, row, f } = this.mine(me, itemId);
        if (!this.canTakeOver(f.def, f.ownerId, item, me.id)) throw new BotFlowError('Only the lead of the person it waits for, or the bot’s maker, can take it over.');
        const after = trackTakeOver(item, me.id, this.d.now()) as Kept;
        after.taskId = item.taskId;
        this.closeTask(after);
        this.taskFor(after, f.def);
        this.store(after, row);
        this.cardFor(f.bot, f.def, after, me.id, 'actor', `${after.ref} · ${stageOf(f.def, after.stage)?.label ?? ''}: ${after.title}`);
        if (item.actorId) this.say(f.bot, item.actorId, `${after.ref}: ${me.displayName} has taken this over from you.`);
        this.refreshItem(after);
        return { ok: true, track: this.viewFor(me, itemId) };
      }
    }
    return undefined;
  }

  // ------------------------------------------------------------ the timer: reminders and the register
  /** The day a scheduled register was last posted, per bot. */
  private lastPosted(flow: string): string {
    return (this.db.prepare('SELECT value FROM meta WHERE key = ?').get(`botreg_${flow}`) as { value: string } | undefined)?.value ?? '';
  }

  tick(now = this.d.now(), flows: string[] = (this.db.prepare("SELECT DISTINCT flow FROM bot_items WHERE status = 'open'").all() as Array<{ flow: string }>).map((r) => r.flow)): void {
    for (const flow of flows) {
      try { this.tickFlow(flow, now); } catch (err) { this.d.log('warn', 'tracked requests timer failed', { flow, error: (err as Error).message }); }
    }
  }

  /** Bots with a register to post at a time of day (called with every live tracked bot). */
  tickRegisters(now: number, defs: Array<{ def: BotFlowDefinition; bot: PublicUser; ownerId: string | null }>): void {
    for (const { def, bot, ownerId } of defs) {
      const reg = def.track?.register;
      if (!reg?.at) continue;
      const d = new Date(now);
      const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const today = localDate(now);
      if (!(reg.days ?? [1, 2, 3, 4, 5]).includes(d.getDay()) || hm < reg.at || this.lastPosted(def.name) === today) continue;
      this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`botreg_${def.name}`, today);
      const open = this.openOf(def.name).length;
      if (!open) continue;
      try {
        const to = reg.to ?? 'owner';
        const body = open === 1 ? `${def.title}: 1 open request.` : `${def.title}: ${open} open requests.`;
        if (to.startsWith('space:')) {
          const id = this.d.messaging.spaceByName(to.slice(6));
          if (!id) { this.d.log('warn', 'register Space not found', { flow: def.name, space: to.slice(6) }); continue; }
          this.d.messaging.ensureMember(id, bot.id);
          this.postRegister(bot, def, id, null, 'all', body, { space: true });
        } else {
          const who = to.startsWith('role:') ? def.track?.roles?.[to.slice(5)]?.person ?? ownerId : ownerId;
          if (who && this.active(who)) this.postRegister(bot, def, this.d.dm(bot, who), who, 'all', body);
        }
      } catch (err) { this.d.log('warn', 'register not posted', { flow: def.name, error: (err as Error).message }); }
    }
  }

  private tickFlow(flow: string, now: number): void {
    const f = this.d.flowOf(flow, null);
    if (!f) return;
    const hours = f.def.persona?.hours ?? OFFICE_WEEK;
    if (!withinHours(hours, now)) return;
    const open = this.openOf(flow);
    const nudge = new Map<string, Kept[]>();
    const escalate = new Map<string, Kept[]>();
    for (const it of open) {
      const row = this.db.prepare('SELECT flow_version FROM bot_items WHERE id = ?').get(it.id) as { flow_version: number | null } | undefined;
      const def = this.d.flowOf(flow, row?.flow_version ?? null)?.def ?? f.def;
      const due = nudgeDue(def, it, now);
      if (!due || !it.actorId) continue;
      if (due === 'nudge') {
        // someone away is not reminded (it is passed up in time instead)
        const u = this.d.store.userById(it.actorId);
        if (u?.ooo && u.ooo.until > now) continue;
        nudge.set(it.actorId, [...(nudge.get(it.actorId) ?? []), it]);
      } else {
        const to = this.escalateTo(def, it, f.ownerId);
        if (to) escalate.set(to, [...(escalate.get(to) ?? []), it]);
        else { const got = this.load(it.id); if (got) this.store({ ...got.item, escalated: true }, got.row); }
      }
    }
    // one list per person, replacing their last one: never a message per request
    for (const [userId, items] of nudge) {
      for (const it of items) { const got = this.load(it.id); if (got) this.store(trackNoted(got.item, 'nudge', now, userId) as Kept, got.row); }
      const body = items.length === 1 ? `Reminder: ${items[0].ref} waits for you.` : `Reminder: ${items.length} requests wait for you.`;
      this.postRegister(f.bot, f.def, this.d.dm(f.bot, userId), userId, 'mine', body);
      for (const it of items) this.refreshItem(it);
    }
    for (const [userId, items] of escalate) {
      for (const it of items) { const got = this.load(it.id); if (got) this.store(trackNoted(got.item, 'escalate', now, userId) as Kept, got.row); }
      const body = items.length === 1 ? `${items[0].ref} has waited a while. Have a look?` : `${items.length} requests have waited a while. Have a look?`;
      this.postRegister(f.bot, f.def, this.d.dm(f.bot, userId), userId, 'team', body, { itemIds: items.map((i) => i.id) });
      for (const it of items) this.refreshItem(it);
    }
  }
}
