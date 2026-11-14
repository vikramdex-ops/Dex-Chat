// Conversations with integrations that take several steps: a plot request, a leave request, a
// site-visit booking. The hub keeps where each person is (the current step, the answers so far,
// when it started and when it expires), so a conversation survives an app restart or a move to
// another PC: the integration offers "Pick up where you left off" when the person comes back.
//
// Two kinds of integration use it:
//  - flows run by the hub: steps defined in JSON (PUT /api/flows/<name>, or written by an
//    administrator in the Control room), with choices, checked text, a person, a file or a
//    confirmation, branching, variables and actions at the end (post a summary, call the
//    integration's webhook, put a task on someone's Desk);
//  - integrations with their own logic: they keep their state here (GET/PUT /api/sessions/<user>)
//    and receive what people write or answer at their webhook, with the session id and step.
// Each step shows as an interactive card in the person's Direct conversation with the integration.
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { ulid } from '@dex/core';
import type { BotSession, Conversation, BotFlowAnswer, BotFlowCard, BotFlowDefinition, BotFlowInfo, BotFlowInput, Message, Ops, PublicUser, SlashCommand } from '@dex/core';
import { BOTFLOW_DEFAULT_DAYS, BotFlowError, checkAnswer, checkInput, localDate, nextAfter, remainingPath, renderTemplate, saveKey, startVars, stepById, summaryLines, validateFlow } from '@dex/core/botflows';
import type { BotFlowVars } from '@dex/core/botflows';
import { isSealed } from '@dex/core/e2e';
import { BUILT_IN, post } from './commands.ts';
import type { Desk } from './desk.ts';
import type { FileStore } from './files.ts';
import { MsgError } from './messaging.ts';
import type { Messaging, MsgRow } from './messaging.ts';
import type { Store } from './store.ts';
import { BUILTIN_FLOWS, FRONT_OFFICE_ACCOUNT, FRONT_OFFICE_NAME } from './botflows-builtin.ts';

export class BotFlowsError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bot_flows (
  name TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  def TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);
CREATE TABLE IF NOT EXISTS bot_sessions (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  flow TEXT,
  conv_id TEXT NOT NULL,
  origin_conv_id TEXT,
  step TEXT,
  history TEXT NOT NULL DEFAULT '[]',
  answers TEXT NOT NULL DEFAULT '{}',
  vars TEXT NOT NULL DEFAULT '{}',
  prompts TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  offered_at INTEGER,
  card TEXT
);
CREATE INDEX IF NOT EXISTS idx_bot_sessions_user ON bot_sessions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_bot_sessions_expiry ON bot_sessions(status, expires_at);
CREATE TABLE IF NOT EXISTS bot_cards (
  client_id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  session_id TEXT,
  kind TEXT NOT NULL,
  step TEXT,
  data TEXT NOT NULL,
  message_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bot_cards_session ON bot_cards(session_id);
`;

const DAY = 24 * 3600_000;
const MAX_BODY = 256 * 1024;
const MAX_DATA = 64 * 1024;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** A prompt an integration with its own logic shows as a card. */
interface ExtPrompt { text: string; input: BotFlowInput; title?: string; of?: number }

interface SessionRow {
  id: string; bot_id: string; user_id: string; flow: string | null; conv_id: string; origin_conv_id: string | null;
  step: string | null; history: string; answers: string; vars: string; prompts: string; status: BotSession['status'];
  started_at: number; updated_at: number; expires_at: number; offered_at: number | null; card: string | null;
}
interface S {
  id: string; botId: string; userId: string; flow: string | null; convId: string; originConvId: string | null;
  step: string | null; history: string[]; answers: Record<string, BotFlowAnswer>; vars: Record<string, unknown>;
  prompts: Record<string, ExtPrompt>; status: BotSession['status']; startedAt: number; updatedAt: number; expiresAt: number;
  offeredAt: number | null; card: string | null;
}
interface FlowRow { name: string; bot_id: string; def: string; enabled: number; source: BotFlowInfo['source']; updated_at: number; updated_by: string | null }
interface CardRow { client_id: string; bot_id: string; session_id: string | null; kind: BotFlowCard['kind']; step: string | null; data: string; message_id: string | null; created_at: number }
type CardData = Partial<Pick<BotFlowCard, 'title' | 'stepNo' | 'stepCount' | 'prompt' | 'input' | 'answer' | 'previous' | 'canBack' | 'flows' | 'lines' | 'notes' | 'requesterId'>> & { ownerId?: string };

function parse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

const toS = (r: SessionRow): S => ({
  id: r.id, botId: r.bot_id, userId: r.user_id, flow: r.flow, convId: r.conv_id, originConvId: r.origin_conv_id, step: r.step,
  history: parse(r.history, []), answers: parse(r.answers, {}), vars: parse(r.vars, {}), prompts: parse(r.prompts, {}),
  status: r.status, startedAt: r.started_at, updatedAt: r.updated_at, expiresAt: r.expires_at, offeredAt: r.offered_at, card: r.card,
});

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface BotFlowsDeps {
  store: Store;
  messaging: Messaging;
  files: FileStore;
  desk: Desk;
  /** Tell every connected app (the list of flows changed). */
  broadcast: (name: string, data: unknown) => void;
  log: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
}

export class BotFlows {
  private readonly db: DatabaseSync;
  private readonly d: BotFlowsDeps;
  /** Offer "Pick up where you left off" when someone comes back after this long. */
  resumeAfterMs = 2 * 60_000;
  /** Answers to cards are given one at a time per session. */
  private readonly busy = new Set<string>();

  constructor(deps: BotFlowsDeps) {
    this.d = deps;
    this.db = deps.store.db;
    this.db.exec(SCHEMA);
    this.seed();
  }

  // ------------------------------------------------------------ built-in flows
  /** Front Office and its flows, once (an administrator may change, switch off or revoke them later). */
  private seed(): void {
    const store = this.d.store;
    let bot = store.userByAccount(FRONT_OFFICE_ACCOUNT);
    if (!bot) {
      bot = store.createUser(FRONT_OFFICE_ACCOUNT, FRONT_OFFICE_NAME, 'bot');
      // an integration is active while it has a token; this one is never shown to anyone
      store.createBotToken(bot.id, crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex'), bot.id);
    }
    for (const def of BUILTIN_FLOWS) {
      const key = `flow_seeded_${def.name}`;
      if (store.meta(key, () => '') === '1') continue;
      if (!this.flowRow(def.name)) {
        this.db.prepare('INSERT INTO bot_flows (name, bot_id, def, enabled, source, updated_at, updated_by) VALUES (?, ?, ?, 1, ?, ?, NULL)')
          .run(def.name, bot.id, JSON.stringify(validateFlow(def)), 'builtin', Date.now());
      }
      this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, '1');
    }
  }

  get frontOfficeId(): string | null { return this.d.store.userByAccount(FRONT_OFFICE_ACCOUNT)?.id ?? null; }

  // ------------------------------------------------------------ reading
  private flowRow(name: string): FlowRow | undefined {
    return this.db.prepare('SELECT * FROM bot_flows WHERE name = ?').get(name) as FlowRow | undefined;
  }

  private info(r: FlowRow): BotFlowInfo {
    const def = parse<BotFlowDefinition | null>(r.def, null);
    return {
      name: r.name, title: def?.title ?? r.name, description: def?.description ?? null, command: def?.command ?? null,
      botId: r.bot_id, botName: this.d.store.userById(r.bot_id)?.displayName ?? 'Integration', enabled: !!r.enabled,
      source: r.source, steps: def?.steps.length ?? 0, updatedAt: r.updated_at,
    };
  }

  /** A flow people can use now: switched on, and its integration not revoked. */
  private usable(name: string): { def: BotFlowDefinition; bot: PublicUser } | null {
    const r = this.flowRow(name);
    if (!r || !r.enabled || !this.d.store.botActive(r.bot_id)) return null;
    const bot = this.d.store.userById(r.bot_id);
    const def = parse<BotFlowDefinition | null>(r.def, null);
    return bot && def ? { def, bot } : null;
  }

  private usableFlows(botId?: string): FlowRow[] {
    const rows = (botId
      ? this.db.prepare('SELECT * FROM bot_flows WHERE bot_id = ? AND enabled = 1 ORDER BY name').all(botId)
      : this.db.prepare('SELECT * FROM bot_flows WHERE enabled = 1 ORDER BY name').all()) as unknown as FlowRow[];
    return rows.filter((r) => this.d.store.botActive(r.bot_id));
  }

  private row(id: string): S | null {
    const r = this.db.prepare('SELECT * FROM bot_sessions WHERE id = ?').get(id) as SessionRow | undefined;
    return r ? toS(r) : null;
  }

  private activeFor(botId: string, userId: string): S | null {
    const r = this.db.prepare("SELECT * FROM bot_sessions WHERE bot_id = ? AND user_id = ? AND status = 'active' ORDER BY started_at DESC LIMIT 1").get(botId, userId) as SessionRow | undefined;
    return r ? toS(r) : null;
  }

  private save(s: S): void {
    this.db.prepare(`INSERT INTO bot_sessions (id, bot_id, user_id, flow, conv_id, origin_conv_id, step, history, answers, vars, prompts, status, started_at, updated_at, expires_at, offered_at, card)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET step = excluded.step, history = excluded.history, answers = excluded.answers, vars = excluded.vars, prompts = excluded.prompts,
        status = excluded.status, updated_at = excluded.updated_at, expires_at = excluded.expires_at, offered_at = excluded.offered_at, card = excluded.card, origin_conv_id = excluded.origin_conv_id`)
      .run(s.id, s.botId, s.userId, s.flow, s.convId, s.originConvId, s.step, JSON.stringify(s.history), JSON.stringify(s.answers), JSON.stringify(s.vars),
        JSON.stringify(s.prompts), s.status, s.startedAt, s.updatedAt, s.expiresAt, s.offeredAt, s.card);
  }

  /** The session as integrations and apps see it. */
  sessionView(s: S): BotSession {
    return {
      id: s.id, botId: s.botId, userId: s.userId, flow: s.flow, convId: s.convId, originConvId: s.originConvId, step: s.step,
      history: s.history, answers: s.answers, data: s.vars, status: s.status, startedAt: s.startedAt, updatedAt: s.updatedAt, expiresAt: s.expiresAt,
    };
  }

  // ------------------------------------------------------------ cards
  /** The card a message carries (called for every message the hub shows; most are not cards). */
  view(r: MsgRow): Pick<Message, 'botflow'> {
    if (!r.client_id || !r.client_id.startsWith('card-')) return {};
    const c = this.db.prepare('SELECT * FROM bot_cards WHERE client_id = ? AND bot_id = ?').get(r.client_id, r.author_id) as CardRow | undefined;
    if (!c) return {};
    const data = parse<CardData>(c.data, {});
    const s = c.session_id ? this.row(c.session_id) : null;
    let state: BotFlowCard['state'] = 'done';
    if (c.kind === 'step' || c.kind === 'resume') {
      if (data.answer) state = 'answered';
      else if (!s) state = 'cancelled';
      else if (s.status === 'active') state = s.card === c.client_id ? 'active' : 'moved';
      else if (s.status === 'done') state = 'moved';
      else state = s.status;
    } else if (c.kind === 'menu' || c.kind === 'offer') state = 'active';
    const card: BotFlowCard = {
      kind: c.kind, botId: c.bot_id, sessionId: c.session_id, ownerId: s?.userId ?? data.ownerId ?? null, title: data.title ?? '', state,
      ...(c.step ? { stepId: c.step } : {}),
      ...(data.stepNo !== undefined ? { stepNo: data.stepNo } : {}),
      ...(data.stepCount !== undefined ? { stepCount: data.stepCount } : {}),
      ...(data.prompt !== undefined ? { prompt: data.prompt } : {}),
      ...(data.input ? { input: data.input } : {}),
      ...(data.answer !== undefined ? { answer: data.answer } : {}),
      ...(data.previous !== undefined ? { previous: data.previous } : {}),
      ...(state === 'active' && (c.kind === 'step' || c.kind === 'resume') ? { canBack: !!data.canBack } : {}),
      ...(data.flows ? { flows: data.flows } : {}),
      ...(data.lines ? { lines: data.lines } : {}),
      ...(data.notes ? { notes: data.notes } : {}),
      ...(data.requesterId ? { requesterId: data.requesterId } : {}),
      ...(s && c.kind === 'resume' ? { startedAt: s.startedAt, updatedAt: s.updatedAt, expiresAt: s.expiresAt } : {}),
    };
    return { botflow: card };
  }

  /**
   * Post a card into a conversation as the integration. Returns the message's client id. With
   * `current`, the card becomes that session's live one before it is sent (so everyone receives
   * it as the card to answer), and the card it replaces is shown again as moved on.
   */
  private postCard(bot: PublicUser, convId: string, body: string, kind: BotFlowCard['kind'], sessionId: string | null, step: string | null, data: CardData, files: string[] = [], current?: S): string {
    const clientId = `card-${ulid()}`;
    this.db.prepare('INSERT INTO bot_cards (client_id, bot_id, session_id, kind, step, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(clientId, bot.id, sessionId, kind, step, JSON.stringify(data), Date.now());
    const old = current ? current.card : null;
    if (current) { current.card = clientId; this.save(current); }
    const conv = this.d.messaging.memberConv(convId, bot.id);
    const text = body.trim().slice(0, 7900) || data.title || 'Card';
    const msg = this.d.messaging.sendAs(bot, conv, text, undefined, files, clientId, { skipFileCheck: true });
    this.db.prepare('UPDATE bot_cards SET message_id = ? WHERE client_id = ?').run(msg.id, clientId);
    if (old && old !== clientId) this.refreshCard(old);
    return clientId;
  }

  private refreshCard(clientId: string | null): void {
    if (!clientId) return;
    const r = this.db.prepare('SELECT message_id FROM bot_cards WHERE client_id = ?').get(clientId) as { message_id: string | null } | undefined;
    if (r?.message_id) this.d.messaging.refresh(r.message_id);
  }

  private setCardAnswer(clientId: string | null, answer: BotFlowAnswer): void {
    if (!clientId) return;
    const r = this.db.prepare('SELECT data FROM bot_cards WHERE client_id = ?').get(clientId) as { data: string } | undefined;
    if (!r) return;
    this.db.prepare('UPDATE bot_cards SET data = ? WHERE client_id = ?').run(JSON.stringify({ ...parse<CardData>(r.data, {}), answer }), clientId);
    this.refreshCard(clientId);
  }

  /** The Direct conversation between a person and an integration (created when needed). */
  private dm(bot: PublicUser, userId: string): string {
    return (this.d.messaging.handle('conv.create', bot, { kind: 'direct', members: [userId] }) as Conversation).id;
  }

  private say(bot: PublicUser, convId: string, text: string): void {
    try {
      this.d.messaging.sendAs(bot, this.d.messaging.memberConv(convId, bot.id), text.slice(0, 4000), undefined, [], `say-${ulid()}`, {});
    } catch (err) { this.d.log('warn', 'integration reply not posted', { error: (err as Error).message }); }
  }

  // ------------------------------------------------------------ running a flow
  /** Starting variables plus the answers on the route actually taken (Back leaves answers that no longer count). */
  private effective(s: S): BotFlowVars {
    const vars = { ...(s.vars as BotFlowVars) };
    const def = s.flow ? this.usable(s.flow)?.def : null;
    for (const id of s.history) {
      const step = def ? stepById(def, id) : undefined;
      const key = step ? saveKey(step) : id;
      if (s.answers[key]) vars[key] = s.answers[key];
    }
    return vars;
  }

  private position(s: S, def: BotFlowDefinition): { stepNo: number; stepCount: number } {
    const known = { ...(s.vars as BotFlowVars), ...s.answers };
    const all = remainingPath(def, def.steps[0].id, known);
    const at = s.step ? all.indexOf(s.step) : -1;
    if (at >= 0) return { stepNo: at + 1, stepCount: all.length };
    const ahead = s.step ? remainingPath(def, s.step, known).length : 0;
    const done = new Set(s.history).size;
    return { stepNo: done + 1, stepCount: done + Math.max(1, ahead) };
  }

  private summaryOf(def: BotFlowDefinition, s: S): { lines: Array<{ label: string; value: string }>; text: string } {
    const lines = summaryLines(def, s.history, this.effective(s));
    return { lines, text: lines.map((l) => `- **${l.label}:** ${l.value.replace(/\n+/g, '; ')}`).join('\n') };
  }

  private postStep(s: S, def: BotFlowDefinition, bot: PublicUser): void {
    const step = stepById(def, s.step);
    if (!step) throw new BotFlowsError('This flow changed while you were in it. Start it again.');
    const vars = { ...this.effective(s) };
    const { stepNo, stepCount } = this.position(s, def);
    const prompt = renderTemplate(step.prompt, vars, { summary: this.summaryOf(def, s).text, title: def.title });
    const previous = step.input.kind !== 'confirm' ? s.answers[saveKey(step)] ?? null : null;
    this.postCard(bot, s.convId, prompt, 'step', s.id, step.id, { title: def.title, stepNo, stepCount, prompt, input: step.input, previous, canBack: s.history.length > 0 }, [], s);
  }

  private postExtStep(s: S, bot: PublicUser): void {
    const p = s.step ? s.prompts[s.step] : undefined;
    if (!p) throw new BotFlowsError(`${bot.displayName} has nothing to ask right now.`);
    const prev = s.history[s.history.length - 1];
    this.postCard(bot, s.convId, p.text, 'step', s.id, s.step, {
      title: p.title ?? bot.displayName, stepNo: s.history.length + 1, ...(p.of ? { stepCount: p.of } : {}), prompt: p.text, input: p.input,
      previous: s.step ? s.answers[s.step] ?? null : null, canBack: !!prev && !!s.prompts[prev],
    }, [], s);
  }

  private touch(s: S, days: number): void {
    s.updatedAt = Date.now();
    s.expiresAt = s.updatedAt + days * DAY;
  }

  private days(s: S): number {
    const def = s.flow ? this.usable(s.flow)?.def : null;
    return def?.expiresInDays ?? (typeof (s.vars as { __days?: unknown }).__days === 'number' ? (s.vars as { __days: number }).__days : BOTFLOW_DEFAULT_DAYS);
  }

  /** Start a flow for someone: the first step appears in their conversation with the integration. */
  async start(me: PublicUser, name: string, originConvId: string | null): Promise<{ sessionId: string; convId: string; resumed: boolean }> {
    if (me.role === 'bot') throw new BotFlowsError('Integrations cannot start flows.');
    const u = this.usable(name);
    if (!u) throw new BotFlowsError('That flow is not available.', 404);
    const { def, bot } = u;
    const existing = this.activeFor(bot.id, me.id);
    if (existing?.flow === name) {
      // the same flow again: carry on where they are
      this.postStep(existing, def, bot);
      return { sessionId: existing.id, convId: existing.convId, resumed: true };
    }
    if (existing) this.end(existing, 'cancelled');
    const dm = this.dm(bot, me.id);
    let origin: string | null = null;
    if (originConvId && originConvId !== dm) origin = this.d.messaging.memberConv(originConvId, me.id).id;
    const now = Date.now();
    const s: S = {
      id: ulid(), botId: bot.id, userId: me.id, flow: name, convId: dm, originConvId: origin, step: def.steps[0].id, history: [], answers: {},
      vars: startVars(def, { id: me.id, name: me.displayName, account: me.account }), prompts: {}, status: 'active',
      startedAt: now, updatedAt: now, expiresAt: now + (def.expiresInDays ?? BOTFLOW_DEFAULT_DAYS) * DAY, offeredAt: null, card: null,
    };
    this.save(s);
    this.postStep(s, def, bot);
    return { sessionId: s.id, convId: dm, resumed: false };
  }

  private end(s: S, status: 'cancelled' | 'expired' | 'done'): void {
    s.status = status;
    if (status !== 'done') s.updatedAt = Date.now();
    this.save(s);
    this.refreshCard(s.card);
  }

  private answerContext(me: PublicUser) {
    const people = () => this.d.store.activeUsers().filter((u) => u.role !== 'bot' && u.id !== me.id);
    return {
      now: Date.now(),
      person: (v: string) => {
        const id = v.replace(/^<@([0-9A-Z]{26})>$/, '$1').replace(/^@/, '').trim();
        const all = people();
        const hit = all.find((u) => u.id === id) ?? (() => {
          const acct = this.d.store.userForAccount(id);
          if (acct && all.some((u) => u.id === acct.id)) return acct;
          const byName = all.filter((u) => u.displayName.toLowerCase() === id.toLowerCase());
          return byName.length === 1 ? byName[0] : undefined;
        })();
        return hit ? { id: hit.id, name: hit.displayName } : null;
      },
      file: (id: string) => {
        const f = this.d.files.info(id);
        return f && f.uploaderId === me.id ? { id: f.id, name: f.name } : null;
      },
    };
  }

  /** One answer to the current step (from the card, or written in the conversation). */
  async answer(me: PublicUser, sessionId: string, stepId: string, raw: string): Promise<{ done: boolean }> {
    if (this.busy.has(sessionId)) throw new BotFlowsError('Still saving your last answer.');
    this.busy.add(sessionId);
    try {
      const s = this.mine(me, sessionId);
      if (s.step !== stepId) throw new BotFlowsError('That step was already answered. Answer the newest card.');
      const bot = this.botOf(s);
      if (!s.flow) return await this.answerExternal(me, s, bot, raw);
      const u = this.usable(s.flow);
      if (!u) { this.end(s, 'cancelled'); throw new BotFlowsError('This flow was switched off by an administrator.'); }
      const step = stepById(u.def, s.step);
      if (!step) { this.end(s, 'cancelled'); throw new BotFlowsError('This flow changed while you were in it. Start it again.'); }
      const answer = checkAnswer(step, raw, this.answerContext(me));
      this.setCardAnswer(s.card, answer);
      s.answers[saveKey(step)] = answer;
      s.history.push(step.id);
      const next = nextAfter(u.def, step, this.effective(s));
      for (const [k, v] of Object.entries(next.set)) (s.vars as BotFlowVars)[k] = { value: v, label: v };
      this.touch(s, this.days(s));
      if (next.goto === 'end') {
        await this.finish(me, s, u.def, u.bot);
        return { done: true };
      }
      s.step = next.goto;
      this.postStep(s, u.def, u.bot);
      return { done: false };
    } finally {
      this.busy.delete(sessionId);
    }
  }

  private mine(me: PublicUser, sessionId: string): S {
    const s = this.row(sessionId);
    if (!s || s.userId !== me.id) throw new BotFlowsError('That conversation was not found.', 404);
    if (s.status === 'done') throw new BotFlowsError('This is already finished.');
    if (s.status === 'cancelled') throw new BotFlowsError('This was cancelled. Start it again to carry on.');
    if (s.status === 'expired') throw new BotFlowsError('This expired. Start it again.');
    return s;
  }

  private botOf(s: S): PublicUser {
    const bot = this.d.store.userById(s.botId);
    if (!bot || !this.d.store.botActive(bot.id)) { this.end(s, 'cancelled'); throw new BotFlowsError('That integration was revoked by an administrator.'); }
    return bot;
  }

  async back(me: PublicUser, sessionId: string): Promise<void> {
    const s = this.mine(me, sessionId);
    const bot = this.botOf(s);
    const prev = s.history[s.history.length - 1];
    if (!prev) throw new BotFlowsError('This is the first step.');
    if (!s.flow) {
      if (!s.prompts[prev]) throw new BotFlowsError(`${bot.displayName} cannot go back from here.`);
      s.history.pop();
      s.step = prev;
      this.touch(s, this.days(s));
      this.postExtStep(s, bot);
      void this.notify(bot, s, me, { type: 'back' });
      return;
    }
    const u = this.usable(s.flow);
    if (!u) { this.end(s, 'cancelled'); throw new BotFlowsError('This flow was switched off by an administrator.'); }
    s.history.pop();
    s.step = prev;
    this.touch(s, this.days(s));
    this.postStep(s, u.def, u.bot);
  }

  async cancel(me: PublicUser, sessionId: string): Promise<void> {
    const s = this.mine(me, sessionId);
    this.end(s, 'cancelled');
    const bot = this.d.store.userById(s.botId);
    if (bot && !s.flow && this.d.store.botActive(bot.id)) void this.notify(bot, s, me, { type: 'cancel' });
  }

  async resume(me: PublicUser, sessionId: string, over: boolean): Promise<void> {
    const s = this.mine(me, sessionId);
    const bot = this.botOf(s);
    if (!s.flow) {
      if (over) {
        this.end(s, 'cancelled');
        void this.notify(bot, s, me, { type: 'restart' });
        return;
      }
      this.touch(s, this.days(s));
      this.postExtStep(s, bot);
      return;
    }
    const u = this.usable(s.flow);
    if (!u) { this.end(s, 'cancelled'); throw new BotFlowsError('This flow was switched off by an administrator.'); }
    if (over) {
      s.history = [];
      s.answers = {};
      s.vars = startVars(u.def, { id: me.id, name: me.displayName, account: me.account });
      s.step = u.def.steps[0].id;
    }
    this.touch(s, this.days(s));
    this.postStep(s, u.def, u.bot);
  }

  /** Due date for a task: 09:00 on the chosen day (or an hour from now if that has passed). */
  private dueAt(vars: BotFlowVars, a: { due?: string; dueInDays?: number }): number {
    const now = Date.now();
    let day: Date | null = null;
    const v = a.due ? vars[a.due]?.value : undefined;
    const m = v ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v) : null;
    if (m) day = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 9, 0, 0, 0);
    else {
      day = new Date(now);
      day.setDate(day.getDate() + (a.dueInDays ?? 1));
      day.setHours(9, 0, 0, 0);
    }
    return day.getTime() > now ? day.getTime() : now + 3600_000;
  }

  private async finish(me: PublicUser, s: S, def: BotFlowDefinition, bot: PublicUser): Promise<void> {
    const vars = this.effective(s);
    const { lines, text: summary } = this.summaryOf(def, s);
    const fileIds = def.steps.filter((st) => st.input.kind === 'file' && s.history.includes(st.id)).map((st) => vars[saveKey(st)]?.value).filter((v): v is string => !!v);
    const fill = (t: string) => renderTemplate(t, vars, { summary, title: def.title });
    const notes: string[] = [];
    for (const a of def.finish) {
      try {
        if (a.do === 'task') {
          const who = vars[a.assignee]?.value ? this.d.store.userById(vars[a.assignee].value) : null;
          if (!who || who.role === 'bot') { notes.push('No task was created: no one was chosen to do it.'); continue; }
          const dueAt = this.dueAt(vars, a);
          const text = fill(a.text).slice(0, 500);
          this.d.desk.handle('remind.create', me, { forUserId: who.id, text, dueAt });
          // the details (and any attached file) for the person doing it
          const dm = this.dm(bot, who.id);
          this.postCard(bot, dm, `${me.displayName}: ${text}`, 'summary', s.id, null, { title: def.title, lines, requesterId: me.id, ownerId: who.id, prompt: text }, fileIds);
          notes.push(`A task is on ${who.displayName}'s Desk for ${localDate(dueAt) === localDate(Date.now()) ? 'today' : new Date(dueAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}.`);
        } else if (a.do === 'post') {
          let convId: string | null = null;
          let where = '';
          if (a.to === 'origin') {
            if (!s.originConvId) continue;
            const conv = this.d.messaging.memberConv(s.originConvId, me.id) as unknown as { id: string; kind: string; name: string | null };
            if (conv.kind !== 'space') continue;
            this.d.messaging.ensureMember(conv.id, bot.id);
            convId = conv.id;
            where = conv.name ?? 'the Space';
          } else if (a.to.startsWith('space:')) {
            const id = this.d.messaging.spaceByName(a.to.slice(6));
            if (!id) { notes.push(`Not posted: there is no Space called ${a.to.slice(6)}.`); continue; }
            this.d.messaging.ensureMember(id, bot.id);
            convId = id;
            where = a.to.slice(6);
          } else {
            const who = vars[a.to.slice(7)]?.value ? this.d.store.userById(vars[a.to.slice(7)].value) : null;
            if (!who || who.role === 'bot') continue;
            convId = this.dm(bot, who.id);
            where = who.displayName;
          }
          this.d.messaging.sendAs(bot, this.d.messaging.memberConv(convId, bot.id), fill(a.text).slice(0, 7900), undefined, fileIds, `flow-${ulid()}`, { skipFileCheck: true });
          notes.push(`Posted to ${where}.`);
        } else if (a.do === 'webhook') {
          const reply = await this.callWebhook(bot, {
            type: 'botflow.completed', flow: def.name, sessionId: s.id, at: new Date().toISOString(),
            user: { id: me.id, name: me.displayName, account: me.account },
            answers: Object.fromEntries(Object.entries(vars).filter(([k]) => k !== 'user' && k !== 'user.account').map(([k, v]) => [k, v.value])),
            labels: Object.fromEntries(Object.entries(vars).filter(([k]) => k !== 'user' && k !== 'user.account').map(([k, v]) => [k, v.label])),
            files: fileIds.map((id) => this.d.files.info(id)).filter((f) => f !== null).map((f) => ({ id: f.id, name: f.name, size: f.size, type: f.mime })),
            conversation: s.originConvId ? { id: s.originConvId } : null,
          });
          if (reply === null) notes.push(`${bot.displayName} has no webhook to tell.`);
          else {
            notes.push(`${bot.displayName} has your answers.`);
            if (typeof reply.text === 'string' && reply.text.trim()) this.say(bot, s.convId, reply.text);
          }
        }
      } catch (err) {
        notes.push(`Something at the end did not work: ${(err as Error).message}`);
        this.d.log('warn', 'flow action failed', { flow: def.name, action: a.do, error: (err as Error).message });
      }
    }
    s.status = 'done';
    s.step = null;
    this.save(s);
    const done = fill(def.done ?? 'Done. Thank you.');
    this.postCard(bot, s.convId, done, 'done', s.id, null, { title: def.title, lines, notes, prompt: done });
    this.refreshCard(s.card);
    this.d.store.audit(me.id, 'botflow.completed', s.id, { flow: def.name });
  }

  // ------------------------------------------------------------ integrations with their own logic
  private webhookOf(botId: string): { url: string; secret: string } | null {
    return (this.db.prepare('SELECT url, secret FROM bot_webhooks WHERE bot_id = ?').get(botId) as { url: string; secret: string } | undefined) ?? null;
  }

  /** POST a signed JSON body to the integration's webhook; its JSON reply, or null when it has no webhook. */
  private async callWebhook(bot: PublicUser, body: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const w = this.webhookOf(bot.id);
    if (!w) return null;
    const payload = JSON.stringify(body);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = crypto.createHmac('sha256', w.secret).update(`${ts}.${payload}`).digest('hex');
    let reply: { status: number; text: string };
    try {
      reply = await post(w.url, payload, { 'x-dex-timestamp': ts, 'x-dex-signature': `sha256=${sig}`, 'user-agent': 'DexterityConnectHub' });
    } catch (err) { throw new BotFlowsError(`${bot.displayName} did not answer (${(err as Error).message}).`, 502); }
    if (reply.status < 200 || reply.status >= 300) throw new BotFlowsError(`${bot.displayName} answered with an error (${reply.status}).`, 502);
    if (!reply.text.trim()) return {};
    try { const v = JSON.parse(reply.text) as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}; } catch { return { text: reply.text }; }
  }

  private envelope(s: S | null, me: PublicUser, convId: string) {
    return {
      sessionId: s?.id ?? null, step: s?.step ?? null, session: s ? this.sessionView(s) : null,
      user: { id: me.id, name: me.displayName, account: me.account },
      conversation: { id: convId, kind: 'direct' }, at: new Date().toISOString(),
    };
  }

  /** Tell an integration about Back, Cancel or Start over (it may answer with a new session state). */
  private async notify(bot: PublicUser, s: S, me: PublicUser, what: { type: string }): Promise<void> {
    try {
      const reply = await this.callWebhook(bot, { ...what, ...this.envelope(s, me, s.convId) });
      if (reply) this.applyReply(bot, me, s.convId, reply);
    } catch (err) { this.d.log('warn', 'integration not told', { bot: bot.displayName, type: what.type, error: (err as Error).message }); }
  }

  private applyReply(bot: PublicUser, me: PublicUser, convId: string, reply: Record<string, unknown>): void {
    if (typeof reply.text === 'string' && reply.text.trim()) this.say(bot, convId, reply.text);
    if (reply.session && typeof reply.session === 'object') {
      try { this.putSession(bot, me, reply.session as Record<string, unknown>); } catch (err) { this.say(bot, convId, `(${(err as Error).message})`); }
    }
  }

  private async answerExternal(me: PublicUser, s: S, bot: PublicUser, raw: string): Promise<{ done: boolean }> {
    const p = s.step ? s.prompts[s.step] : undefined;
    if (!p || !s.step) throw new BotFlowsError(`${bot.displayName} is not waiting for an answer.`);
    const answer = checkAnswer({ id: s.step, prompt: p.text, input: p.input }, raw, this.answerContext(me));
    this.setCardAnswer(s.card, answer);
    s.answers[s.step] = answer;
    this.touch(s, this.days(s));
    this.save(s);
    const reply = await this.callWebhook(bot, { type: 'answer', value: answer.value, label: answer.label, ...this.envelope(s, me, s.convId) });
    if (reply) this.applyReply(bot, me, s.convId, reply);
    return { done: this.row(s.id)?.status === 'done' };
  }

  /** PUT /api/sessions/<user> (and the session in a webhook reply): keep an integration's own state. */
  putSession(bot: PublicUser, user: PublicUser, body: Record<string, unknown>): BotSession {
    let s = this.activeFor(bot.id, user.id);
    if (s?.flow) throw new BotFlowsError(`${user.displayName} is in the middle of ${this.usable(s.flow)?.def.title ?? 'a flow'} with this integration.`, 409);
    if (body.end === 'done' || body.end === 'cancelled') {
      if (!s) throw new BotFlowsError('There is no conversation in progress.', 404);
      this.end(s, body.end);
      return this.sessionView(s);
    }
    const step = body.step === undefined ? undefined : typeof body.step === 'string' && /^[\w.:-]{1,60}$/.test(body.step) ? body.step : null;
    if (step === null) throw new BotFlowsError('"step" is letters, digits and . _ : - (up to 60).');
    if (body.data !== undefined && (!body.data || typeof body.data !== 'object' || Array.isArray(body.data))) throw new BotFlowsError('"data" must be a JSON object.');
    if (body.data !== undefined && Buffer.byteLength(JSON.stringify(body.data)) > MAX_DATA) throw new BotFlowsError('"data" can be up to 64 KB.', 413);
    let days = BOTFLOW_DEFAULT_DAYS;
    if (body.expiresInDays !== undefined) {
      if (typeof body.expiresInDays !== 'number' || !(body.expiresInDays > 0)) throw new BotFlowsError('"expiresInDays" is a number of days.');
      days = Math.min(90, body.expiresInDays);
    } else if (s) days = this.days(s);
    let prompt: ExtPrompt | null = null;
    if (body.prompt !== undefined) {
      const p = body.prompt as Record<string, unknown> | null;
      const text = typeof p?.text === 'string' ? p.text.trim().slice(0, 2000) : '';
      if (!text) throw new BotFlowsError('"prompt" needs "text".');
      prompt = { text, input: checkInput(p?.input ?? { kind: 'text' }, 'prompt'), ...(typeof p?.title === 'string' && p.title.trim() ? { title: p.title.trim().slice(0, 80) } : {}), ...(typeof p?.of === 'number' && p.of > 0 && p.of < 100 ? { of: Math.round(p.of) } : {}) };
    }
    const now = Date.now();
    if (!s) {
      s = {
        id: ulid(), botId: bot.id, userId: user.id, flow: null, convId: this.dm(bot, user.id), originConvId: null, step: step ?? null, history: [], answers: {},
        vars: {}, prompts: {}, status: 'active', startedAt: now, updatedAt: now, expiresAt: now + days * DAY, offeredAt: null, card: null,
      };
    } else if (step !== undefined && step !== s.step && s.step) s.history.push(s.step);
    if (step !== undefined) s.step = step;
    if (body.data !== undefined) s.vars = { ...(body.data as Record<string, unknown>) };
    if (body.expiresInDays !== undefined) s.vars.__days = days;
    this.touch(s, days);
    if (prompt) {
      if (!s.step) throw new BotFlowsError('Give the "step" the prompt belongs to.');
      s.prompts[s.step] = prompt;
    }
    this.save(s);
    if (prompt) this.postExtStep(s, bot);
    return this.sessionView(s);
  }

  // ------------------------------------------------------------ people writing to an integration
  /** Messaging tells us about every new message; we answer only Direct messages to an integration. */
  onPosted(author: PublicUser, convId: string, msg: Message): void {
    if (author.role === 'bot' || msg.parentId || msg.system || msg.forwardedFrom) return;
    const members = this.d.messaging.members(convId);
    if (members.length !== 2) return;
    const bot = this.d.store.userById(members.find((m) => m !== author.id) ?? '');
    if (!bot || bot.role !== 'bot' || !this.d.store.botActive(bot.id)) return;
    setImmediate(() => {
      this.incoming(author, bot, convId, msg).catch((err) => this.d.log('warn', 'integration conversation failed', { error: (err as Error).message }));
    });
  }

  private async incoming(author: PublicUser, bot: PublicUser, convId: string, msg: Message): Promise<void> {
    const conv = this.d.messaging.memberConv(convId, author.id) as unknown as { kind: string };
    if (conv.kind !== 'direct' || isSealed(msg.body)) return;
    const text = msg.body.trim();
    const s = this.activeFor(bot.id, author.id);
    if (s?.flow) {
      if (/^(cancel|stop|quit)$/i.test(text)) { await this.cancel(author, s.id); this.say(bot, convId, 'Cancelled. Nothing was sent.'); return; }
      if (/^(back|go back|previous)$/i.test(text)) { await this.back(author, s.id).catch((e: Error) => this.say(bot, convId, e.message)); return; }
      if (/^(resume|continue)$/i.test(text)) { await this.resume(author, s.id, false); return; }
      const u = this.usable(s.flow);
      const step = u ? stepById(u.def, s.step) : undefined;
      if (!u || !step) { this.end(s, 'cancelled'); this.say(bot, convId, 'That flow is no longer available.'); return; }
      let raw = text;
      if (step.input.kind === 'file' && msg.files.length) raw = msg.files[0].id;
      if (step.input.kind === 'person' && msg.mentions.length && msg.mentions[0] !== 'all') raw = msg.mentions[0];
      try { await this.answer(author, s.id, step.id, raw); } catch (err) {
        if (err instanceof BotFlowError || err instanceof BotFlowsError) this.say(bot, convId, `${err.message} (Write "cancel" to stop, or "back" for the step before.)`);
        else throw err;
      }
      return;
    }
    const flows = this.usableFlows(bot.id).map((r) => ({ r, def: parse<BotFlowDefinition | null>(r.def, null) })).filter((x): x is { r: FlowRow; def: BotFlowDefinition } => !!x.def);
    if (s || !flows.length) {
      // an integration with its own logic: what was written goes to its webhook
      const reply = await this.callWebhook(bot, {
        type: 'message', text, files: msg.files.map((f) => ({ id: f.id, name: f.name, size: f.size, type: f.mime })), messageId: msg.id,
        ...this.envelope(s, author, convId),
      }).catch((err: Error) => { this.say(bot, convId, err.message); return null; });
      if (reply) this.applyReply(bot, author, convId, reply);
      return;
    }
    const t = text.toLowerCase().replace(/^\//, '');
    const hit = flows.find(({ def }) => [def.name, def.command ?? '', def.title.toLowerCase(), ...(def.keywords ?? [])].filter((k) => k.length > 1)
      .some((k) => t === k || new RegExp(`(^|\\W)${escapeRe(k)}($|\\W)`, 'i').test(t)));
    if (hit) { await this.start(author, hit.def.name, null); return; }
    this.postCard(bot, convId, `Here is what ${bot.displayName} can do. Choose one, or write its name.`, 'menu', null, null, {
      title: bot.displayName, ownerId: author.id,
      flows: flows.map(({ def }) => ({ name: def.name, title: def.title, description: def.description ?? null })),
    });
  }

  /** A device of someone came online: offer to pick up conversations they left a while ago. */
  onReady(userId: string): void {
    const now = Date.now();
    const rows = this.db.prepare("SELECT * FROM bot_sessions WHERE user_id = ? AND status = 'active' AND updated_at < ? AND (offered_at IS NULL OR offered_at < updated_at)")
      .all(userId, now - this.resumeAfterMs) as unknown as SessionRow[];
    for (const r of rows.map(toS)) {
      try {
        const bot = this.d.store.userById(r.botId);
        if (!bot || !this.d.store.botActive(bot.id)) continue;
        let title = bot.displayName;
        let pos: { stepNo: number; stepCount?: number } = { stepNo: r.history.length + 1 };
        if (r.flow) {
          const u = this.usable(r.flow);
          if (!u || !stepById(u.def, r.step)) continue;
          title = u.def.title;
          pos = this.position(r, u.def);
        } else {
          const p = r.step ? r.prompts[r.step] : undefined;
          if (!p) continue;
          title = p.title ?? bot.displayName;
          if (p.of) pos.stepCount = p.of;
        }
        const where = pos.stepCount ? `step ${pos.stepNo} of ${pos.stepCount}` : `step ${pos.stepNo}`;
        r.offeredAt = now;
        this.postCard(bot, r.convId, `Pick up where you left off: ${title}, ${where}.`, 'resume', r.id, r.step, { title, ...pos, canBack: false }, [], r);
      } catch (err) { this.d.log('warn', 'resume offer failed', { error: (err as Error).message }); }
    }
  }

  /** Called on the hub timer: unfinished conversations expire. */
  tick(now = Date.now()): void {
    const due = this.db.prepare("SELECT * FROM bot_sessions WHERE status = 'active' AND expires_at <= ? LIMIT 200").all(now) as unknown as SessionRow[];
    for (const r of due.map(toS)) this.end(r, 'expired');
    // finished conversations are kept half a year for integrations to read back
    this.db.prepare("DELETE FROM bot_sessions WHERE status != 'active' AND updated_at < ?").run(now - 180 * DAY);
  }

  // ------------------------------------------------------------ slash commands
  commandList(): SlashCommand[] {
    return this.usableFlows().map((r) => ({ r, def: parse<BotFlowDefinition | null>(r.def, null) }))
      .filter((x) => !!x.def?.command).map(({ r, def }) => ({ command: def!.command!, description: def!.description ? `${def!.title}: ${def!.description}` : def!.title, botId: r.bot_id }));
  }

  runCommand(command: string, me: PublicUser, convId: string): Promise<{ text: string | null; ephemeral: boolean; open?: string }> | null {
    const hit = this.usableFlows().find((r) => parse<BotFlowDefinition | null>(r.def, null)?.command === command);
    if (!hit) return null;
    return (async () => {
      const r = await this.start(me, hit.name, convId);
      const u = this.usable(hit.name)!;
      return {
        text: `${r.resumed ? `You already have ${u.def.title} open` : `${u.def.title} started`} in your conversation with ${u.bot.displayName}.`,
        ephemeral: true,
        open: r.convId,
      };
    })();
  }

  /** Commands a flow may not take: the app's own and other integrations'. */
  private commandTaken(command: string, name: string): string | null {
    if (BUILT_IN.includes(command)) return `/${command} is built into the app.`;
    if (this.db.prepare('SELECT 1 FROM bot_commands WHERE command = ?').get(command)) return `/${command} already belongs to an integration.`;
    const other = (this.db.prepare('SELECT name, def FROM bot_flows WHERE name != ?').all(name) as Array<{ name: string; def: string }>)
      .find((r) => parse<BotFlowDefinition | null>(r.def, null)?.command === command);
    return other ? `/${command} already starts ${other.name}.` : null;
  }

  /** Save a flow for an integration (from the Bot API or the Control room). */
  saveFlow(bot: PublicUser, raw: unknown, name: string | undefined, actor: string, source: BotFlowInfo['source']): BotFlowInfo {
    let def: BotFlowDefinition;
    try { def = validateFlow(raw, name); } catch (err) { throw new BotFlowsError((err as Error).message); }
    const existing = this.flowRow(def.name);
    if (existing && existing.bot_id !== bot.id) throw new BotFlowsError('Another integration already has a flow with that name.', 409);
    if (def.command) { const why = this.commandTaken(def.command, def.name); if (why) throw new BotFlowsError(why, 409); }
    this.db.prepare(`INSERT INTO bot_flows (name, bot_id, def, enabled, source, updated_at, updated_by) VALUES (?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET def = excluded.def, source = excluded.source, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .run(def.name, bot.id, JSON.stringify(def), source, Date.now(), actor);
    this.d.store.audit(actor, 'botflow.saved', bot.id, { flow: def.name, steps: def.steps.length, source });
    this.d.broadcast('botflow.catalog', { changed: true });
    return this.info(this.flowRow(def.name)!);
  }

  private removeFlow(name: string, actor: string): void {
    const r = this.flowRow(name);
    if (!r) throw new BotFlowsError('Flow not found.', 404);
    for (const s of (this.db.prepare("SELECT * FROM bot_sessions WHERE flow = ? AND status = 'active'").all(name) as unknown as SessionRow[]).map(toS)) this.end(s, 'cancelled');
    this.db.prepare('DELETE FROM bot_flows WHERE name = ?').run(name);
    this.d.store.audit(actor, 'botflow.removed', r.bot_id, { flow: name });
    this.d.broadcast('botflow.catalog', { changed: true });
  }

  private offer(bot: PublicUser, def: BotFlowDefinition, convId: string): string {
    return this.postCard(bot, convId, `${def.title}${def.description ? `: ${def.description}` : ''}`, 'offer', null, null, {
      title: def.title, flows: [{ name: def.name, title: def.title, description: def.description ?? null }],
    });
  }

  // ------------------------------------------------------------ operations from the apps
  async handle(op: string, me: PublicUser, d: Record<string, unknown>): Promise<unknown> {
    const isAdmin = me.role === 'owner' || me.role === 'admin';
    const admin = () => { if (!isAdmin) throw new BotFlowsError('Only administrators can do that.', 403); };
    const sid = typeof d.sessionId === 'string' ? d.sessionId : '';
    switch (op) {
      case 'botflow.list':
        return this.usableFlows().map((r) => this.info(r)) satisfies Ops['botflow.list']['res'];
      case 'botflow.start':
        return await this.start(me, String(d.flow ?? ''), typeof d.convId === 'string' ? d.convId : null) satisfies Ops['botflow.start']['res'];
      case 'botflow.answer': {
        const r = await this.answer(me, sid, String(d.stepId ?? ''), typeof d.value === 'string' ? d.value : String(d.value ?? ''));
        return { ok: true, done: r.done } satisfies Ops['botflow.answer']['res'];
      }
      case 'botflow.back': await this.back(me, sid); return { ok: true } satisfies Ops['botflow.back']['res'];
      case 'botflow.cancel': await this.cancel(me, sid); return { ok: true } satisfies Ops['botflow.cancel']['res'];
      case 'botflow.resume': await this.resume(me, sid, d.over === true); return { ok: true } satisfies Ops['botflow.resume']['res'];
      case 'botflow.sessions':
        return (this.db.prepare("SELECT * FROM bot_sessions WHERE user_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 50").all(me.id) as unknown as SessionRow[])
          .map((r) => this.sessionView(toS(r))) satisfies Ops['botflow.sessions']['res'];
      case 'botflow.offer': {
        if (me.role === 'guest' || me.role === 'bot') throw new BotFlowsError('Guests cannot offer flows.', 403);
        const u = this.usable(String(d.flow ?? ''));
        if (!u) throw new BotFlowsError('That flow is not available.', 404);
        const conv = this.d.messaging.memberConv(String(d.convId ?? ''), me.id) as unknown as { id: string; kind: string };
        if (conv.kind !== 'space') throw new BotFlowsError('Offer a flow in a Space.');
        this.d.messaging.ensureMember(conv.id, u.bot.id);
        const clientId = this.offer(u.bot, u.def, conv.id);
        const r = this.db.prepare('SELECT message_id FROM bot_cards WHERE client_id = ?').get(clientId) as { message_id: string };
        return this.d.messaging.messageFor(r.message_id, me.id)! satisfies Ops['botflow.offer']['res'];
      }
      case 'admin.botflows.list':
        admin();
        return (this.db.prepare('SELECT * FROM bot_flows ORDER BY name').all() as unknown as FlowRow[])
          .map((r) => ({ ...this.info(r), definition: parse<BotFlowDefinition>(r.def, { name: r.name, title: r.name, steps: [], finish: [] }) })) satisfies Ops['admin.botflows.list']['res'];
      case 'admin.botflows.save': {
        admin();
        const bot = typeof d.botId === 'string' ? this.d.store.userById(d.botId) : null;
        if (!bot || bot.role !== 'bot') throw new BotFlowsError('Choose an integration for the flow.');
        return this.saveFlow(bot, d.definition, undefined, me.id, 'admin') satisfies Ops['admin.botflows.save']['res'];
      }
      case 'admin.botflows.enable': {
        admin();
        const r = this.flowRow(String(d.name ?? ''));
        if (!r) throw new BotFlowsError('Flow not found.', 404);
        const on = d.enabled === true;
        this.db.prepare('UPDATE bot_flows SET enabled = ?, updated_at = ?, updated_by = ? WHERE name = ?').run(on ? 1 : 0, Date.now(), me.id, r.name);
        if (!on) for (const s of (this.db.prepare("SELECT * FROM bot_sessions WHERE flow = ? AND status = 'active'").all(r.name) as unknown as SessionRow[]).map(toS)) this.end(s, 'cancelled');
        this.d.store.audit(me.id, on ? 'botflow.enabled' : 'botflow.disabled', r.bot_id, { flow: r.name });
        this.d.broadcast('botflow.catalog', { changed: true });
        return this.info(this.flowRow(r.name)!) satisfies Ops['admin.botflows.enable']['res'];
      }
      case 'admin.botflows.remove':
        admin();
        this.removeFlow(String(d.name ?? ''), me.id);
        return { ok: true } satisfies Ops['admin.botflows.remove']['res'];
    }
    return undefined;
  }

  // ------------------------------------------------------------ Bot API (HTTP, integration token)
  /**
   *   GET    /api/flows                    this integration's flows
   *   GET    /api/flows/<name>             one flow's definition
   *   PUT    /api/flows/<name>             create or replace a flow (JSON definition)
   *   DELETE /api/flows/<name>             remove it (conversations in progress are cancelled)
   *   POST   /api/flows/<name>/offer       { to?: [accounts], space?: name }: a card with a Start button
   *   POST   /api/flows/<name>/start       { user }: start it for someone (the first card appears in their Direct conversation)
   *   GET    /api/sessions/<user>          the conversation in progress with that person (404 if none)
   *   PUT    /api/sessions/<user>          { step?, data?, prompt?, expiresInDays?, end? }: keep your own state, show a card
   *   DELETE /api/sessions/<user>          end it (cancelled)
   */
  async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const reply = (code: number, body: unknown) => {
      if (res.headersSent) { res.end(); return; }
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7).trim() : '';
    const bot = token ? this.d.store.botByTokenHash(crypto.createHash('sha256').update(token).digest('hex')) : null;
    if (!bot || bot.role !== 'bot') { req.resume(); reply(401, { ok: false, error: 'Unknown or revoked integration token.' }); return; }
    const url = new URL(req.url ?? '/', 'https://hub');
    const parts = url.pathname.split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return ''; } });
    const method = req.method ?? 'GET';
    const readBody = async (): Promise<Record<string, unknown>> => {
      let raw = '';
      for await (const c of req) { raw += c; if (raw.length > MAX_BODY) throw new BotFlowsError('The request is too large.', 413); }
      if (!raw.trim()) return {};
      let v: unknown;
      try { v = JSON.parse(raw); } catch { throw new BotFlowsError('Invalid JSON.'); }
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new BotFlowsError('Send a JSON object.');
      return v as Record<string, unknown>;
    };
    const person = (key: string): PublicUser => {
      const u = ULID_RE.test(key) ? this.d.store.userById(key) : this.d.store.userForAccount(key);
      if (!u || u.role === 'bot' || !this.d.store.activeUsers().some((a) => a.id === u.id)) throw new BotFlowsError(`No one in the office is "${key}".`, 404);
      return u;
    };
    try {
      if (parts[1] === 'flows') {
        const name = parts[2];
        const own = (n: string) => { const r = this.flowRow(n); if (!r || r.bot_id !== bot.id) throw new BotFlowsError('Flow not found.', 404); return r; };
        if (!name) {
          if (method !== 'GET') throw new BotFlowsError('not found', 404);
          req.resume();
          reply(200, { ok: true, flows: (this.db.prepare('SELECT * FROM bot_flows WHERE bot_id = ? ORDER BY name').all(bot.id) as unknown as FlowRow[]).map((r) => ({ ...this.info(r), definition: parse(r.def, null) })) });
          return;
        }
        if (parts.length === 3 && method === 'GET') { req.resume(); const r = own(name); reply(200, { ok: true, flow: { ...this.info(r), definition: parse(r.def, null) } }); return; }
        if (parts.length === 3 && method === 'PUT') { const body = await readBody(); reply(200, { ok: true, flow: this.saveFlow(bot, body, name, bot.id, 'api') }); return; }
        if (parts.length === 3 && method === 'DELETE') { req.resume(); own(name); this.removeFlow(name, bot.id); reply(200, { ok: true }); return; }
        if (parts.length === 4 && method === 'POST' && (parts[3] === 'offer' || parts[3] === 'start')) {
          const body = await readBody();
          own(name);
          const u = this.usable(name);
          if (!u) throw new BotFlowsError('That flow is switched off.', 409);
          if (parts[3] === 'start') {
            const who = person(String(body.user ?? ''));
            const r = await this.start(who, name, null);
            reply(200, { ok: true, sessionId: r.sessionId, resumed: r.resumed });
            return;
          }
          const delivered: string[] = [];
          const unknown: string[] = [];
          for (const who of (Array.isArray(body.to) ? body.to : []).filter((x): x is string => typeof x === 'string').slice(0, 50)) {
            const p = this.d.store.userForAccount(who);
            if (!p || p.role === 'bot') { unknown.push(who); continue; }
            this.offer(bot, u.def, this.dm(bot, p.id));
            delivered.push(p.account);
          }
          if (typeof body.space === 'string' && body.space.trim()) {
            const id = this.d.messaging.spaceByName(body.space.trim());
            if (!id) unknown.push(`space:${body.space}`);
            else { this.d.messaging.ensureMember(id, bot.id); this.offer(bot, u.def, id); delivered.push(`space:${body.space.trim()}`); }
          }
          reply(delivered.length ? 200 : 404, { ok: delivered.length > 0, delivered, unknown });
          return;
        }
        throw new BotFlowsError('not found', 404);
      }
      if (parts[1] === 'sessions' && parts.length === 3) {
        const who = person(parts[2]);
        if (method === 'GET') {
          req.resume();
          const s = this.activeFor(bot.id, who.id);
          if (!s) { reply(404, { ok: false, error: 'No conversation in progress.' }); return; }
          reply(200, { ok: true, session: this.sessionView(s) });
          return;
        }
        if (method === 'PUT') { const body = await readBody(); reply(200, { ok: true, session: this.putSession(bot, who, body) }); return; }
        if (method === 'DELETE') {
          req.resume();
          const s = this.activeFor(bot.id, who.id);
          if (!s) { reply(404, { ok: false, error: 'No conversation in progress.' }); return; }
          if (s.flow) throw new BotFlowsError('A flow run by the hub is in progress: it ends when the person finishes or cancels it.', 409);
          this.end(s, 'cancelled');
          reply(200, { ok: true });
          return;
        }
      }
      req.resume();
      reply(404, { ok: false, error: 'not found' });
    } catch (err) {
      req.resume();
      if (err instanceof BotFlowsError) reply(err.status, { ok: false, error: err.message });
      else if (err instanceof BotFlowError) reply(400, { ok: false, error: err.message });
      else if (err instanceof MsgError) reply(400, { ok: false, error: (err as Error).message });
      else { this.d.log('error', 'flow API failed', { error: (err as Error).message }); reply(500, { ok: false, error: 'internal error' }); }
    }
  }
}
