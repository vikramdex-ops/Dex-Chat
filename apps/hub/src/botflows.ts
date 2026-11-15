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
import type { BotSession, Conversation, BotFlowAnswer, BotFlowCard, BotFlowDefinition, BotFlowInfo, BotFlowInput, BotMakerBot, BotScope, BotStats, BotStatus, Message, Ops, PublicUser, SlashCommand } from '@dex/core';
import { BOTFLOW_DEFAULT_DAYS, BOTFLOW_NAME_RE, BotFlowError, checkAnswer, checkInput, doneLine, effectiveVars, flowPosition, hoursText, isUserVar, localDate, nextAfter, nextOpening, rememberable, renderTemplate, saveKey, startVars, stepById, stepCard, summaryLines, summaryText, validateFlow, voiceOf, withinHours } from '@dex/core/botflows';
import type { BotFlowVars } from '@dex/core/botflows';
import { isSealed } from '@dex/core/e2e';
import { BUILT_IN, post } from './commands.ts';
import type { Desk } from './desk.ts';
import type { FileStore } from './files.ts';
import { MsgError } from './messaging.ts';
import type { Messaging, MsgRow } from './messaging.ts';
import type { Store } from './store.ts';
import { BUILTIN_FLOWS, FRONT_OFFICE_ACCOUNT, FRONT_OFFICE_NAME } from './botflows-builtin.ts';
import { BotItems } from './botitems.ts';
import { BotNet, BotNetError } from './botnet.ts';
import type { NetBot, NetHost } from './botnet.ts';
import { BotJobs } from './botjobs.ts';
import { DEFAULT_CALENDAR } from '@dex/core/botjobs';
import type { OfficeCalendar } from '@dex/core/botjobs';
import { trailOf } from '@dex/core/botnet';

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
CREATE TABLE IF NOT EXISTS bot_flow_versions (
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  def TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT,
  PRIMARY KEY (name, version)
);
CREATE TABLE IF NOT EXISTS bot_memory (
  flow TEXT NOT NULL,
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  label TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (flow, user_id, key)
);
`;

/** Columns added after the first release (each added once, on an older hub's database). */
const COLUMNS: Array<[string, string, string]> = [
  ['bot_flows', 'owner_id', 'TEXT'],
  ['bot_flows', 'scope', "TEXT NOT NULL DEFAULT 'office'"],
  ['bot_flows', 'space_id', 'TEXT'],
  ['bot_flows', 'status', "TEXT NOT NULL DEFAULT 'live'"],
  ['bot_flows', 'version', 'INTEGER NOT NULL DEFAULT 1'],
  ['bot_flows', 'requested', 'TEXT'],
  ['bot_flows', 'pending_version', 'INTEGER'],
  ['bot_flows', 'review', 'TEXT'],
  ['bot_sessions', 'flow_version', 'INTEGER'],
];

/** Member-made bots each get their own identity in conversations, under this account prefix. */
const MADE_PREFIX = 'botmaker\\';

const DAY = 24 * 3600_000;
const MAX_BODY = 256 * 1024;
const MAX_DATA = 64 * 1024;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** A prompt an integration with its own logic shows as a card. */
interface ExtPrompt { text: string; input: BotFlowInput; title?: string; of?: number }

interface SessionRow {
  id: string; bot_id: string; user_id: string; flow: string | null; conv_id: string; origin_conv_id: string | null;
  step: string | null; history: string; answers: string; vars: string; prompts: string; status: BotSession['status'];
  started_at: number; updated_at: number; expires_at: number; offered_at: number | null; card: string | null; flow_version: number | null;
}
interface S {
  id: string; botId: string; userId: string; flow: string | null; convId: string; originConvId: string | null;
  step: string | null; history: string[]; answers: Record<string, BotFlowAnswer>; vars: Record<string, unknown>;
  prompts: Record<string, ExtPrompt>; status: BotSession['status']; startedAt: number; updatedAt: number; expiresAt: number;
  offeredAt: number | null; card: string | null;
  /** The flow revision this run started on (an edit does not change a run in progress). */
  flowVersion: number | null;
}
interface FlowRow {
  name: string; bot_id: string; def: string; enabled: number; source: BotFlowInfo['source']; updated_at: number; updated_by: string | null;
  owner_id: string | null; scope: BotScope; space_id: string | null; status: BotStatus; version: number; requested: 'office' | null; pending_version: number | null; review: string | null;
}
interface CardRow { client_id: string; bot_id: string; session_id: string | null; kind: BotFlowCard['kind']; step: string | null; data: string; message_id: string | null; created_at: number }
type CardData = Partial<Pick<BotFlowCard, 'title' | 'stepNo' | 'stepCount' | 'prompt' | 'input' | 'answer' | 'previous' | 'canBack' | 'flows' | 'lines' | 'notes' | 'requesterId' | 'persona' | 'intro' | 'lastTime' | 'lastTimeWords' | 'suggested' | 'suggestedWhy'>> & {
  ownerId?: string;
  /** A tracked request's cards (and the done card of a tracked bot): the request they follow. */
  itemId?: string;
  /** A register card: the bot, what it lists, and for whom. */
  flow?: string; mode?: 'all' | 'mine' | 'team'; itemIds?: string[]; space?: boolean;
  /** A relay card: the run or request whose hops it draws. */
  group?: string;
};

function parse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

const toS = (r: SessionRow): S => ({
  id: r.id, botId: r.bot_id, userId: r.user_id, flow: r.flow, convId: r.conv_id, originConvId: r.origin_conv_id, step: r.step,
  history: parse(r.history, []), answers: parse(r.answers, {}), vars: parse(r.vars, {}), prompts: parse(r.prompts, {}),
  status: r.status, startedAt: r.started_at, updatedAt: r.updated_at, expiresAt: r.expires_at, offeredAt: r.offered_at, card: r.card, flowVersion: r.flow_version ?? null,
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
  /** Tell some people's apps (the network sheet's pulses, the job sheet). */
  deliver?: (userIds: string[], name: string, data: unknown) => void;
  /** The office's working days, holidays and hours, in its time zone (Nib's working days). */
  calendar?: () => Pick<OfficeCalendar, 'workdays'>;
}

export class BotFlows {
  private readonly db: DatabaseSync;
  private readonly d: BotFlowsDeps;
  /** Offer "Pick up where you left off" when someone comes back after this long. */
  resumeAfterMs = 2 * 60_000;
  /** The "Mark me away" end action: Nib's leave note (set by the hub). Returns the line for the person. */
  away: ((me: PublicUser, answers: { kind?: string; from?: string; to?: string; cover?: string | null; note?: string | null; leads?: string[] }) => string) | null = null;
  /** Answers to cards are given one at a time per session. */
  private readonly busy = new Set<string>();
  /** The clock for tracked requests (reminders, registers, due dates); tests move it. */
  now: () => number = () => Date.now();
  /** Requests a tracked bot carries on after they are sent. */
  readonly items: BotItems;
  /** Bots talking to bots: skills, handoffs, events (botnet.ts). */
  readonly net: BotNet;
  /** Scheduled jobs (botjobs.ts). */
  readonly jobs: BotJobs;
  private itemsTickedAt = 0;

  constructor(deps: BotFlowsDeps) {
    this.d = deps;
    this.db = deps.store.db;
    this.db.exec(SCHEMA);
    for (const [table, col, type] of COLUMNS) {
      if (!(this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === col)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
    }
    this.seed();
    this.items = new BotItems({
      db: this.db, store: deps.store, messaging: deps.messaging, desk: deps.desk, log: deps.log, now: () => this.now(),
      flowOf: (flow, version) => {
        const u = this.usable(flow);
        if (!u) return null;
        const def = version && version !== (u.row.version ?? 1) ? this.versionDef(flow, version) ?? u.def : u.def;
        return { def, bot: u.bot, ownerId: u.row.owner_id ?? null };
      },
      postCard: (bot, convId, body, kind, data) => this.postCard(bot, convId, body, kind, null, null, data as CardData),
      refreshCard: (clientId) => this.refreshCard(clientId),
      dm: (bot, userId) => this.dm(bot, userId),
      say: (bot, convId, text) => this.say(bot, convId, text),
    });
    const host: NetHost = {
      live: (name) => this.netBot(name),
      all: () => (this.db.prepare('SELECT name FROM bot_flows WHERE enabled = 1').all() as Array<{ name: string }>).map((r) => this.netBot(r.name)).filter((x): x is NetBot => !!x),
      mayUse: (name, userId) => this.mayUse(name, userId),
      startCarried: (person, name, carried, o) => this.startCarried(person, name, carried, o),
      postCard: (bot, convId, body, kind, data) => this.postCard(bot, convId, body, kind, null, null, data as CardData),
      refreshCard: (clientId) => this.refreshCard(clientId),
      dm: (bot, userId) => this.dm(bot, userId),
      say: (bot, convId, text) => this.say(bot, convId, text),
      sent: (name, since) => (this.db.prepare("SELECT COUNT(*) AS n FROM bot_sessions WHERE flow = ? AND status = 'done' AND updated_at > ?").get(name, since) as { n: number }).n,
    };
    this.net = new BotNet({
      db: this.db, store: deps.store, messaging: deps.messaging, items: this.items, host, log: deps.log, now: () => this.now(),
      deliver: (u, n, d) => deps.deliver?.(u, n, d), calendar: () => this.calendar(),
    });
    this.items.hooks = {
      moved: (def, before, after) => {
        if (after.vars.__link?.value || before) this.net.targetMoved(after.id);
        if (!before) this.net.emit(def, after, 'opened');
        else if (after.status !== 'open' && before.status === 'open') this.net.itemClosed(def, after);
        else if (after.status === 'open' && (before.stage !== after.stage || before.since !== after.since)) this.net.emit(def, after, 'stage');
        const st = after.status === 'open' && (!before || before.stage !== after.stage || before.since !== after.since) ? def.track?.stages.find((x) => x.id === after.stage) : undefined;
        if (st?.who.startsWith('bot:')) {
          const owner = this.flowRow(def.name)?.owner_id ?? null;
          setImmediate(() => { this.net.botStage(def, after, owner).catch((err: Error) => this.d.log('warn', 'stage handoff failed', { error: err.message })); });
        }
      },
      acted: (def, item, action, by) => {
        if (!action.handoff) return;
        const h = action.handoff;
        setImmediate(() => {
          const vars = { ...item.vars, ref: { value: item.ref, label: item.ref }, title: { value: item.title, label: item.title } };
          this.net.handoff({ from: def.name, person: by, trail: trailOf(item.vars.__trail?.value), group: item.id, key: `act:${item.id}:${item.history.length}`, originItem: item.id, card: true }, h, vars, { ref: item.ref, what: action.label })
            .catch((err: Error) => this.d.log('warn', 'button handoff failed', { error: err.message }));
        });
      },
      stageBot: (item, stageId, flow) => this.net.stageBot(item, stageId, flow),
    };
    this.jobs = new BotJobs({
      db: this.db, store: deps.store, messaging: deps.messaging, desk: deps.desk, log: deps.log, now: () => this.now(), calendar: () => this.calendar(),
      deliver: (u, n, d) => deps.deliver?.(u, n, d), host, net: this.net, items: this.items,
      startFor: (person, name) => this.startForJob(person, name),
      leadOf: (uid) => this.items.leadOf(uid),
    });
  }

  /** The office's working week and holidays, in IST. */
  calendar(): OfficeCalendar {
    const holidays = (() => { try { return JSON.parse(this.d.store.meta('office_holidays', () => '[]')) as OfficeCalendar['holidays']; } catch { return []; } })();
    return { ...DEFAULT_CALENDAR, workdays: this.d.calendar?.().workdays ?? DEFAULT_CALENDAR.workdays, holidays: Array.isArray(holidays) ? holidays : [] };
  }

  /** A live bot as the network sees it. */
  private netBot(name: string): NetBot | null {
    const u = this.usable(name);
    if (!u) return null;
    return { def: u.def, bot: u.bot, ownerId: u.row.owner_id ?? null, source: u.row.source, scope: u.row.scope ?? 'office', status: u.row.status ?? 'live', version: u.row.version ?? 1 };
  }

  /** May this person (null: the office itself) start that bot? */
  mayUse(name: string, userId: string | null): boolean {
    const u = this.usable(name);
    if (!u) return false;
    if (userId === null) return u.row.source !== 'member' || (u.row.scope ?? 'office') === 'office';
    const me = this.d.store.userById(userId);
    return !!me && me.role !== 'bot' && this.canUse(u.row, me);
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
      persona: def?.persona ?? null, ownerId: r.owner_id ?? null, scope: r.scope ?? 'office', spaceId: r.space_id ?? null, status: r.status ?? 'live',
      version: r.version ?? 1, requested: r.requested ?? null, pendingVersion: r.pending_version ?? null, openNow: withinHours(def?.persona?.hours, Date.now()),
    };
  }

  /** A flow people can use now: switched on, and its integration not revoked (the live revision). */
  private usable(name: string): { def: BotFlowDefinition; bot: PublicUser; row: FlowRow } | null {
    const r = this.flowRow(name);
    if (!r || !r.enabled || !this.d.store.botActive(r.bot_id)) return null;
    const bot = this.d.store.userById(r.bot_id);
    const def = parse<BotFlowDefinition | null>(r.def, null);
    return bot && def ? { def, bot, row: r } : null;
  }

  /**
   * Who may start a flow: an integration's or the office's flows, everyone; a member's bot, its
   * maker, the people of the Space it is shared with, or everyone once approved office-wide.
   */
  private canUse(r: FlowRow, me: PublicUser): boolean {
    if (r.owner_id && r.owner_id === me.id) return true;
    if (r.scope === 'private') return false;
    if (r.scope === 'space') return !!r.space_id && this.d.messaging.members(r.space_id).includes(me.id);
    return true;
  }

  /** A flow this person may start now: usable, live, theirs to use. */
  private startable(name: string, me: PublicUser): { def: BotFlowDefinition; bot: PublicUser; row: FlowRow } | null {
    const u = this.usable(name);
    if (!u || !this.canUse(u.row, me)) return null;
    if (u.row.status === 'paused') throw new BotFlowsError(`${u.def.title} is paused by the person who made it.`, 409);
    if (u.row.status === 'retired') throw new BotFlowsError(`${u.def.title} has been retired.`, 409);
    return u;
  }

  /** The revision a run started on (runs in progress are not changed by later edits). */
  private versionDef(name: string, version: number): BotFlowDefinition | null {
    const r = this.db.prepare('SELECT def FROM bot_flow_versions WHERE name = ? AND version = ?').get(name, version) as { def: string } | undefined;
    return r ? parse<BotFlowDefinition | null>(r.def, null) : null;
  }

  /** The flow a run in progress follows: switched on and its integration active, at the revision it started on. */
  private running(s: S): { def: BotFlowDefinition; bot: PublicUser } | null {
    if (!s.flow) return null;
    const u = this.usable(s.flow);
    if (!u) return null;
    if (s.flowVersion && s.flowVersion !== u.row.version) {
      const def = this.versionDef(s.flow, s.flowVersion);
      if (def) return { def, bot: u.bot };
    }
    return { def: u.def, bot: u.bot };
  }

  private usableFlows(botId?: string, me?: PublicUser): FlowRow[] {
    const rows = (botId
      ? this.db.prepare('SELECT * FROM bot_flows WHERE bot_id = ? AND enabled = 1 ORDER BY name').all(botId)
      : this.db.prepare('SELECT * FROM bot_flows WHERE enabled = 1 ORDER BY name').all()) as unknown as FlowRow[];
    return rows.filter((r) => this.d.store.botActive(r.bot_id) && (r.status ?? 'live') === 'live' && (me ? this.canUse(r, me) : (r.scope ?? 'office') === 'office'));
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
    this.db.prepare(`INSERT INTO bot_sessions (id, bot_id, user_id, flow, conv_id, origin_conv_id, step, history, answers, vars, prompts, status, started_at, updated_at, expires_at, offered_at, card, flow_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET step = excluded.step, history = excluded.history, answers = excluded.answers, vars = excluded.vars, prompts = excluded.prompts,
        status = excluded.status, updated_at = excluded.updated_at, expires_at = excluded.expires_at, offered_at = excluded.offered_at, card = excluded.card, origin_conv_id = excluded.origin_conv_id,
        flow_version = excluded.flow_version`)
      .run(s.id, s.botId, s.userId, s.flow, s.convId, s.originConvId, s.step, JSON.stringify(s.history), JSON.stringify(s.answers), JSON.stringify(s.vars),
        JSON.stringify(s.prompts), s.status, s.startedAt, s.updatedAt, s.expiresAt, s.offeredAt, s.card, s.flowVersion);
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
    if (c.kind === 'relay') {
      return { botflow: { kind: 'relay', botId: c.bot_id, sessionId: null, ownerId: data.ownerId ?? null, title: data.title ?? '', state: 'active', ...(data.persona ? { persona: data.persona } : {}), relay: data.group ? this.net.relayView(c.client_id, data.group, null) : null } };
    }
    if (c.kind === 'track' || c.kind === 'register' || (c.kind === 'done' && data.itemId)) {
      // a tracked request's card is drawn from the request as it is now
      const live = this.items.cardView(c.client_id, data);
      return { botflow: {
        kind: c.kind, botId: c.bot_id, sessionId: c.session_id, ownerId: data.ownerId ?? null, title: data.title ?? '', state: c.kind === 'done' ? 'done' : 'active',
        ...(data.persona ? { persona: data.persona } : {}), ...(data.prompt !== undefined ? { prompt: data.prompt } : {}),
        ...(data.lines ? { lines: data.lines } : {}), ...(data.notes ? { notes: data.notes } : {}), ...(live ?? {}),
      } };
    }
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
      ...(data.persona ? { persona: data.persona } : {}),
      ...(data.intro ? { intro: data.intro } : {}),
      ...(data.lastTime && state === 'active' ? { lastTime: data.lastTime, lastTimeWords: data.lastTimeWords ?? '' } : {}),
      ...(data.suggested && state === 'active' ? { suggested: data.suggested, suggestedWhy: data.suggestedWhy ?? 'lead' } : {}),
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
    const def = this.running(s)?.def;
    if (def) return effectiveVars(def, { step: s.step, history: s.history, answers: s.answers, vars: s.vars as BotFlowVars });
    const vars = { ...(s.vars as BotFlowVars) };
    for (const id of s.history) if (s.answers[id]) vars[id] = s.answers[id];
    return vars;
  }

  private position(s: S, def: BotFlowDefinition): { stepNo: number; stepCount: number } {
    return flowPosition(def, s.step, s.history, { ...(s.vars as BotFlowVars), ...s.answers });
  }

  private summaryOf(def: BotFlowDefinition, s: S): { lines: Array<{ label: string; value: string }>; text: string } {
    const lines = summaryLines(def, s.history, this.effective(s));
    return { lines, text: summaryText(lines) };
  }

  /** This person's answer to a step last time, if the bot remembers and it is still a good answer. */
  private lastTime(s: S, def: BotFlowDefinition, me: PublicUser | null): BotFlowAnswer | null {
    const step = stepById(def, s.step);
    if (!def.persona?.remember || !step || !rememberable(step) || !s.flow) return null;
    const r = this.db.prepare('SELECT value, label FROM bot_memory WHERE flow = ? AND user_id = ? AND key = ?').get(s.flow, s.userId, saveKey(step)) as { value: string; label: string } | undefined;
    if (!r) return null;
    const who = me ?? this.d.store.userById(s.userId);
    if (!who) return null;
    try { return checkAnswer(step, r.value, this.answerContext(who, def)); } catch { return null; }
  }

  /** Defaults from the office's records for a step: the person's lead, job numbers from their Spaces. */
  private officeDefaults(s: S, def: BotFlowDefinition): { suggested: BotFlowAnswer | null; jobs: string[] } {
    const step = stepById(def, s.step);
    let suggested: BotFlowAnswer | null = null;
    let jobs: string[] = [];
    if (step?.input.suggest === 'lead') {
      const lead = this.items.leadOf(s.userId);
      if (lead) suggested = { value: lead.id, label: lead.displayName };
    }
    if (step?.input.suggest === 'jobs') {
      const names = this.db.prepare("SELECT c.name FROM conversations c JOIN conv_members m ON m.conv_id = c.id WHERE m.user_id = ? AND c.kind = 'space' AND c.name IS NOT NULL LIMIT 300").all(s.userId) as Array<{ name: string }>;
      const re = /\b([A-Z]{1,4}-?\d{3,6})\b/;
      jobs = [...new Set(names.map((n) => re.exec(n.name)?.[1]).filter((x): x is string => !!x))].sort().slice(0, 4);
    }
    return { suggested, jobs };
  }

  private postStep(s: S, def: BotFlowDefinition, bot: PublicUser, fresh = false): void {
    let data;
    try {
      data = stepCard(def, { step: s.step, history: s.history, answers: s.answers, vars: s.vars as BotFlowVars }, { fresh, lastTime: this.lastTime(s, def, null), ...this.officeDefaults(s, def) });
    } catch (err) { throw new BotFlowsError((err as Error).message); }
    this.postCard(bot, s.convId, data.prompt, 'step', s.id, s.step, data, [], s);
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
    const def = this.running(s)?.def;
    return def?.expiresInDays ?? (typeof (s.vars as { __days?: unknown }).__days === 'number' ? (s.vars as { __days: number }).__days : BOTFLOW_DEFAULT_DAYS);
  }

  /** Start a flow for someone: the first step appears in their conversation with the integration. */
  async start(me: PublicUser, name: string, originConvId: string | null): Promise<{ sessionId: string; convId: string; resumed: boolean }> {
    if (me.role === 'bot') throw new BotFlowsError('Integrations cannot start flows.');
    const u = this.startable(name, me);
    if (!u) throw new BotFlowsError('That flow is not available.', 404);
    const { def, bot } = u;
    const existing = this.activeFor(bot.id, me.id);
    if (existing?.flow === name) {
      // the same flow again: carry on where they are (on the revision they started)
      const r = this.running(existing);
      if (r) {
        this.postStep(existing, r.def, bot);
        return { sessionId: existing.id, convId: existing.convId, resumed: true };
      }
    }
    const hours = def.persona?.hours;
    if (hours && !withinHours(hours, Date.now())) throw new BotFlowsError(voiceOf(def.persona?.tone).closed(def.title, hoursText(hours), nextOpening(hours, Date.now())), 409);
    if (existing) this.end(existing, 'cancelled');
    const dm = this.dm(bot, me.id);
    let origin: string | null = null;
    if (originConvId && originConvId !== dm) origin = this.d.messaging.memberConv(originConvId, me.id).id;
    const now = Date.now();
    const s: S = {
      id: ulid(), botId: bot.id, userId: me.id, flow: name, convId: dm, originConvId: origin, step: def.steps[0].id, history: [], answers: {},
      vars: startVars(def, { id: me.id, name: me.displayName, account: me.account }), prompts: {}, status: 'active',
      startedAt: now, updatedAt: now, expiresAt: now + (def.expiresInDays ?? BOTFLOW_DEFAULT_DAYS) * DAY, offeredAt: null, card: null, flowVersion: u.row.version ?? 1,
    };
    this.save(s);
    await this.proceed(s, def, bot, true);
    return { sessionId: s.id, convId: dm, resumed: false };
  }

  /**
   * Carry a run on from where it stands: a step that asks another bot is asked (and the answer
   * kept) without the person; the first step that is the person's gets its card. A bot that
   * cannot answer falls back to asking the person (or, as its maker chose, carries on or stops).
   */
  private async proceed(s: S, def: BotFlowDefinition, bot: PublicUser, fresh = false, retry = false): Promise<{ done: boolean }> {
    for (let i = 0; i < 60; i++) {
      const step = stepById(def, s.step);
      if (!step) throw new BotFlowsError('This flow changed while you were in it. Start it again.');
      if (!step.ask || !s.flow) { this.postStep(s, def, bot, fresh); return { done: false }; }
      const me = this.d.store.userById(s.userId);
      if (!me) throw new BotFlowsError('That person is not in the office any more.');
      const res = await this.net.ask({
        from: def.name, person: me, trail: trailOf((s.vars as BotFlowVars).__trail?.value), group: s.id, card: true, originSession: s.id, step: step.id,
        ...(retry ? {} : { key: `ask:${s.id}:${step.id}:${s.history.length}` }),
      }, step.ask, this.effective(s));
      retry = false;
      let answer: BotFlowAnswer;
      if (res.ok && res.answer) {
        answer = res.answer;
        for (const [k, v] of Object.entries(res.values)) (s.vars as BotFlowVars)[`${saveKey(step)}.${k}`] = v;
      } else {
        const onFail = step.ask.onFail ?? 'ask';
        const voice = voiceOf(def.persona?.tone);
        if (onFail === 'stop') {
          this.end(s, 'cancelled');
          this.say(bot, s.convId, `${res.reason ?? 'Another bot did not answer.'} It stops here; start it again later.`);
          return { done: true };
        }
        if (onFail === 'ask') {
          this.say(bot, s.convId, `${res.reason ?? 'Another bot did not answer.'} ${voice.typedHint}`);
          this.postStep(s, def, bot, fresh);
          return { done: false };
        }
        answer = { value: '', label: '—' };
      }
      s.answers[saveKey(step)] = answer;
      s.history.push(step.id);
      const next = nextAfter(def, step, this.effective(s));
      for (const [k, v] of Object.entries(next.set)) (s.vars as BotFlowVars)[k] = { value: v, label: v };
      this.touch(s, this.days(s));
      if (next.goto === 'end') { await this.finish(me, s, def, bot); return { done: true }; }
      s.step = next.goto;
      this.save(s);
    }
    this.end(s, 'cancelled');
    throw new BotFlowsError('This bot keeps asking other bots without asking you anything. Its maker should look at it.');
  }

  /**
   * Start a bot for someone with answers another bot carried across (a handoff, or an event it
   * listens to). Each carried answer is checked as if the person had written it; the steps they
   * answer are passed over, and the person carries on from the first one left (a confirmation
   * is always theirs). The run remembers the bots it came through, so it cannot loop.
   */
  async startCarried(person: PublicUser, name: string, carried: Record<string, string>, o: { trail: string; link: string; from: string }): Promise<{ sessionId: string; convId: string; itemId: string | null; done: boolean }> {
    const u = this.startable(name, person);
    if (!u) throw new BotFlowsError(`${person.displayName} cannot use that bot.`);
    const { def, bot } = u;
    const hours = def.persona?.hours;
    if (hours && !withinHours(hours, Date.now())) throw new BotFlowsError(voiceOf(def.persona?.tone).closed(def.title, hoursText(hours), nextOpening(hours, Date.now())));
    const existing = this.activeFor(bot.id, person.id);
    if (existing) throw new BotFlowsError(`${person.displayName} is in the middle of ${this.running(existing)?.def.title ?? def.title} already.`);
    const dm = this.dm(bot, person.id);
    const now = Date.now();
    const vars = startVars(def, { id: person.id, name: person.displayName, account: person.account });
    vars.__trail = { value: o.trail, label: o.trail };
    vars.__link = { value: o.link, label: o.link };
    vars.__from = { value: o.from, label: o.from };
    const s: S = {
      id: ulid(), botId: bot.id, userId: person.id, flow: name, convId: dm, originConvId: null, step: def.steps[0].id, history: [], answers: {}, vars, prompts: {}, status: 'active',
      startedAt: now, updatedAt: now, expiresAt: now + (def.expiresInDays ?? BOTFLOW_DEFAULT_DAYS) * DAY, offeredAt: null, card: null, flowVersion: u.row.version ?? 1,
    };
    let carriedIn = 0;
    for (let i = 0; i < def.steps.length + 5; i++) {
      const step = stepById(def, s.step);
      if (!step || step.ask || step.input.kind === 'confirm') break;
      const key = saveKey(step);
      if (!(key in carried)) break;
      let answer: BotFlowAnswer;
      try { answer = checkAnswer(step, carried[key], this.answerContext(person, def)); } catch { break; }
      s.answers[key] = answer;
      s.history.push(step.id);
      carriedIn++;
      const next = nextAfter(def, step, this.effective(s));
      for (const [k, v] of Object.entries(next.set)) (s.vars as BotFlowVars)[k] = { value: v, label: v };
      if (next.goto === 'end') {
        this.save(s);
        const itemId = await this.finish(person, s, def, bot);
        return { sessionId: s.id, convId: dm, itemId, done: true };
      }
      s.step = next.goto;
    }
    this.save(s);
    const fromTitle = this.usable(o.from)?.def.title ?? (o.from === 'nib' ? 'Nib' : o.from);
    this.say(bot, dm, carriedIn === 1 ? `From ${fromTitle}: 1 answer carried across.` : carriedIn ? `From ${fromTitle}: ${carriedIn} answers carried across.` : `From ${fromTitle}.`);
    const r = await this.proceed(s, def, bot, carriedIn === 0);
    const after = this.row(s.id);
    const itemId = after?.status === 'done' ? (this.db.prepare("SELECT target_item FROM bot_links WHERE id = ?").get(o.link) as { target_item: string | null } | undefined)?.target_item ?? null : null;
    return { sessionId: s.id, convId: dm, itemId, done: r.done };
  }

  /** A scheduled job starts the bot for someone: not when they are in the middle of it already. */
  async startForJob(person: PublicUser, name: string): Promise<'started' | 'busy' | 'cannot'> {
    let u;
    try { u = this.startable(name, person); } catch { return 'cannot'; }
    if (!u) return 'cannot';
    if (this.activeFor(u.bot.id, person.id)) return 'busy';
    await this.start(person, name, null);
    return 'started';
  }

  /** The person asks a bot again after it failed; the run carries on when it answers. */
  async retryAsk(me: PublicUser, hopId: string): Promise<void> {
    const { session, step } = this.net.retryOf(hopId, me);
    const s = this.mine(me, session);
    if (s.step !== step) throw new BotFlowsError('That step was already answered.');
    const u = this.running(s);
    if (!u) throw new BotFlowsError('This flow was switched off by an administrator.');
    await this.proceed(s, u.def, u.bot, false, true);
  }

  private end(s: S, status: 'cancelled' | 'expired' | 'done'): void {
    s.status = status;
    if (status !== 'done') s.updatedAt = Date.now();
    this.save(s);
    this.refreshCard(s.card);
  }

  private answerContext(me: PublicUser, def?: BotFlowDefinition | null) {
    const people = () => this.d.store.activeUsers().filter((u) => u.role !== 'bot' && u.id !== me.id);
    return {
      now: Date.now(),
      tone: def?.persona?.tone,
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
      const u = this.running(s);
      if (!u) { this.end(s, 'cancelled'); throw new BotFlowsError('This flow was switched off by an administrator.'); }
      const step = stepById(u.def, s.step);
      if (!step) { this.end(s, 'cancelled'); throw new BotFlowsError('This flow changed while you were in it. Start it again.'); }
      const answer = checkAnswer(step, raw, this.answerContext(me, u.def));
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
      return await this.proceed(s, u.def, u.bot);
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
    const u = this.running(s);
    if (!u) { this.end(s, 'cancelled'); throw new BotFlowsError('This flow was switched off by an administrator.'); }
    // a step another bot answered is gone back over, to the person's own step before it
    let to = s.history.length;
    while (to > 0 && stepById(u.def, s.history[to - 1])?.ask) to--;
    if (to === 0) throw new BotFlowsError('This is the first step.');
    s.step = s.history[to - 1];
    s.history = s.history.slice(0, to - 1);
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
    let u = this.running(s);
    if (!u) { this.end(s, 'cancelled'); throw new BotFlowsError('This flow was switched off by an administrator.'); }
    if (over) {
      // beginning again: on the newest live revision
      const live = this.usable(s.flow);
      if (live) { u = { def: live.def, bot: live.bot }; s.flowVersion = live.row.version ?? 1; }
      s.history = [];
      s.answers = {};
      s.vars = startVars(u.def, { id: me.id, name: me.displayName, account: me.account });
      s.step = u.def.steps[0].id;
    }
    this.touch(s, this.days(s));
    if (over) await this.proceed(s, u.def, u.bot, true);
    else this.postStep(s, u.def, u.bot, over);
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

  private async finish(me: PublicUser, s: S, def: BotFlowDefinition, bot: PublicUser): Promise<string | null> {
    const vars = this.effective(s);
    const { lines, text: summary } = this.summaryOf(def, s);
    const fileIds = def.steps.filter((st) => st.input.kind === 'file' && s.history.includes(st.id)).map((st) => vars[saveKey(st)]?.value).filter((v): v is string => !!v);
    const fill = (t: string) => renderTemplate(t, vars, { summary, title: def.title });
    const notes: string[] = [];
    for (const a of def.finish) {
      try {
        if (a.do === 'remind') {
          const dueAt = this.dueAt(vars, a);
          this.d.desk.handle('remind.create', me, { text: fill(a.text).slice(0, 500), dueAt });
          notes.push(`A reminder is on your Desk for ${localDate(dueAt) === localDate(Date.now()) ? 'today' : new Date(dueAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}.`);
        } else if (a.do === 'task') {
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
        } else if (a.do === 'away') {
          if (!this.away) { notes.push('Nobody was told: Nib is not running.'); continue; }
          const v = (k?: string) => (k ? vars[k]?.value ?? null : null);
          notes.push(this.away(me, { kind: v(a.kind) ?? undefined, from: v(a.from) ?? undefined, to: v(a.to) ?? undefined, cover: v(a.cover), note: v(a.note), leads: v(a.lead) ? [v(a.lead)!] : [] }));
        } else if (a.do === 'handoff') {
          const res = await this.net.handoff({ from: def.name, person: me, trail: trailOf(vars.__trail?.value), group: s.id, key: `fin:${s.id}:${a.to}`, originSession: s.id, card: true }, a, vars);
          notes.push(res.line);
        } else if (a.do === 'webhook') {
          const reply = await this.callWebhook(bot, {
            type: 'botflow.completed', flow: def.name, sessionId: s.id, at: new Date().toISOString(),
            user: { id: me.id, name: me.displayName, account: me.account },
            answers: Object.fromEntries(Object.entries(vars).filter(([k]) => !isUserVar(k) && !k.startsWith('__')).map(([k, v]) => [k, v.value])),
            labels: Object.fromEntries(Object.entries(vars).filter(([k]) => !isUserVar(k) && !k.startsWith('__')).map(([k, v]) => [k, v.label])),
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
    // a tracked bot: the request lives on, and the done card follows it
    let itemId: string | null = null;
    if (def.track && s.flow) {
      try {
        const owner = this.flowRow(s.flow)?.owner_id ?? null;
        const item = this.items.create(def, s.flowVersion, bot, owner, me, vars, lines);
        itemId = item.id;
        notes.push(...this.items.notesFor(def, item));
        // it came in from another bot: that bot's hop follows this request now
        if (vars.__link?.value) this.net.sessionTracked(vars.__link.value, item.id, item.ref);
      } catch (err) {
        notes.push(`It could not be tracked: ${(err as Error).message}`);
        this.d.log('warn', 'tracked request not created', { flow: def.name, error: (err as Error).message });
      }
    }
    s.status = 'done';
    s.step = null;
    this.save(s);
    if (def.persona?.remember && s.flow) {
      // next time, these answers are offered as the default
      const keep = this.db.prepare('INSERT INTO bot_memory (flow, user_id, key, value, label, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(flow, user_id, key) DO UPDATE SET value = excluded.value, label = excluded.label, updated_at = excluded.updated_at');
      for (const st of def.steps) {
        const a = vars[saveKey(st)];
        if (rememberable(st) && s.history.includes(st.id) && a?.value) keep.run(s.flow, me.id, saveKey(st), a.value.slice(0, 500), a.label.slice(0, 500), Date.now());
      }
    }
    const done = doneLine(def, vars, summary);
    if (!itemId && vars.__link?.value) this.net.sessionDone(vars.__link.value, done);
    const doneCard = this.postCard(bot, s.convId, done, 'done', s.id, null, { title: def.title, lines, notes, prompt: done, ...(itemId ? { itemId, ownerId: me.id } : {}), ...(def.persona ? { persona: { mark: def.persona.mark, colour: def.persona.colour } } : {}) });
    if (itemId) this.items.attachRequesterCard(doneCard, { id: itemId, flow: def.name, requesterId: me.id }, s.convId);
    this.refreshCard(s.card);
    this.d.store.audit(me.id, 'botflow.completed', s.id, { flow: def.name });
    return itemId;
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
    if (s?.flow) throw new BotFlowsError(`${user.displayName} is in the middle of ${this.running(s)?.def.title ?? 'a flow'} with this integration.`, 409);
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
        vars: {}, prompts: {}, status: 'active', startedAt: now, updatedAt: now, expiresAt: now + days * DAY, offeredAt: null, card: null, flowVersion: null,
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
      const voice = voiceOf(this.running(s)?.def.persona?.tone);
      if (/^(cancel|stop|quit)$/i.test(text)) { await this.cancel(author, s.id); this.say(bot, convId, voice.cancelled); return; }
      if (/^(back|go back|previous)$/i.test(text)) { await this.back(author, s.id).catch((e: Error) => this.say(bot, convId, e.message)); return; }
      if (/^(resume|continue)$/i.test(text)) { await this.resume(author, s.id, false); return; }
      const u = this.running(s);
      const step = u ? stepById(u.def, s.step) : undefined;
      if (!u || !step) { this.end(s, 'cancelled'); this.say(bot, convId, 'That flow is no longer available.'); return; }
      let raw = text;
      if (step.input.kind === 'file' && msg.files.length) raw = msg.files[0].id;
      if (step.input.kind === 'person' && msg.mentions.length && msg.mentions[0] !== 'all') raw = msg.mentions[0];
      try { await this.answer(author, s.id, step.id, raw); } catch (err) {
        if (err instanceof BotFlowError || err instanceof BotFlowsError) this.say(bot, convId, `${err.message} ${voice.typedHint}`);
        else throw err;
      }
      return;
    }
    const flows = this.usableFlows(bot.id, author).map((r) => ({ r, def: parse<BotFlowDefinition | null>(r.def, null) })).filter((x): x is { r: FlowRow; def: BotFlowDefinition } => !!x.def);
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
    // a tracked bot's register, on asking
    const tracked = flows.find(({ def }) => def.track);
    if (tracked && /^(register|status|open|list|queue|who has one)$/.test(t)) {
      const v = this.items.register(tracked.def.name, author.id, 'all');
      if (v) this.items.postRegister(bot, tracked.def, convId, author.id, 'all', v.counts.open === 1 ? `${tracked.def.title}: 1 open request.` : `${tracked.def.title}: ${v.counts.open} open requests.`);
      return;
    }
    const hit = flows.find(({ def }) => [def.name, def.command ?? '', def.title.toLowerCase(), ...(def.keywords ?? [])].filter((k) => k.length > 1)
      .some((k) => t === k || new RegExp(`(^|\\W)${escapeRe(k)}($|\\W)`, 'i').test(t)));
    if (hit) { await this.start(author, hit.def.name, null).catch((e: Error) => this.say(bot, convId, e.message)); return; }
    this.postCard(bot, convId, voiceOf(flows[0]?.def.persona?.tone).menu(bot.displayName), 'menu', null, null, {
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
          const u = this.running(r);
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
    // tracked requests: reminders, passing up, and the registers of the day (once a minute is plenty)
    if (now - this.itemsTickedAt >= 60_000 || now < this.itemsTickedAt) { this.itemsTickedAt = now; this.tickItems(now); }
    // finished conversations are kept half a year for integrations to read back
    this.db.prepare("DELETE FROM bot_sessions WHERE status != 'active' AND updated_at < ?").run(now - 180 * DAY);
  }

  /** Reminders and scheduled registers of tracked bots (on the hub timer; tests call it with their clock). */
  tickItems(now = this.now()): void {
    try { this.items.tick(now); } catch (err) { this.d.log('warn', 'tracked requests timer failed', { error: (err as Error).message }); }
    const live = (this.db.prepare("SELECT * FROM bot_flows WHERE enabled = 1 AND status = 'live'").all() as unknown as FlowRow[])
      .map((r) => ({ r, def: parse<BotFlowDefinition | null>(r.def, null) }))
      .filter((x) => !!x.def?.track?.register?.at && this.d.store.botActive(x.r.bot_id))
      .map(({ r, def }) => ({ def: def!, bot: this.d.store.userById(r.bot_id)!, ownerId: r.owner_id ?? null })).filter((x) => !!x.bot);
    if (live.length) this.items.tickRegisters(now, live);
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
      const u = this.usable(hit.name);
      if (!u) return { text: null, ephemeral: true };
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

  /** The next revision number of a flow (every saved revision is kept, so runs in progress keep theirs). */
  private nextVersion(name: string): number {
    const r = this.db.prepare('SELECT MAX(version) AS v FROM bot_flow_versions WHERE name = ?').get(name) as { v: number | null };
    const row = this.flowRow(name);
    return Math.max(r.v ?? 0, row?.version ?? 0, row?.pending_version ?? 0) + 1;
  }

  /** Keep a revision; the one it replaces is kept first if it never was (flows saved before revisions). */
  private keepVersion(name: string, version: number, def: BotFlowDefinition, actor: string | null): void {
    const row = this.flowRow(name);
    if (row && !this.versionDef(name, row.version ?? 1)) {
      this.db.prepare('INSERT OR IGNORE INTO bot_flow_versions (name, version, def, created_at, created_by) VALUES (?, ?, ?, ?, ?)').run(name, row.version ?? 1, row.def, row.updated_at, row.updated_by);
    }
    this.db.prepare('INSERT OR REPLACE INTO bot_flow_versions (name, version, def, created_at, created_by) VALUES (?, ?, ?, ?, ?)').run(name, version, JSON.stringify(def), Date.now(), actor);
  }

  /** Save a flow for an integration (from the Bot API or the Control room): it goes live as a new revision. */
  saveFlow(bot: PublicUser, raw: unknown, name: string | undefined, actor: string, source: BotFlowInfo['source']): BotFlowInfo {
    let def: BotFlowDefinition;
    try { def = validateFlow(raw, name); } catch (err) { throw new BotFlowsError((err as Error).message); }
    const existing = this.flowRow(def.name);
    if (existing && existing.bot_id !== bot.id) throw new BotFlowsError('Another integration already has a flow with that name.', 409);
    if (def.command) { const why = this.commandTaken(def.command, def.name); if (why) throw new BotFlowsError(why, 409); }
    const version = existing ? this.nextVersion(def.name) : 1;
    this.keepVersion(def.name, version, def, actor);
    // an administrator saving a member's bot keeps it theirs, and settles anything waiting for review
    const keep = existing?.source === 'member' ? 'member' : source;
    this.db.prepare(`INSERT INTO bot_flows (name, bot_id, def, enabled, source, updated_at, updated_by, version) VALUES (?, ?, ?, 1, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET def = excluded.def, source = excluded.source, updated_at = excluded.updated_at, updated_by = excluded.updated_by,
        version = excluded.version, pending_version = NULL, requested = NULL`)
      .run(def.name, bot.id, JSON.stringify(def), keep, Date.now(), actor, version);
    if (keep === 'member' && bot.displayName !== def.title) this.d.broadcast('user.updated', this.d.store.updateUser(bot.id, { displayName: def.title }));
    this.d.store.audit(actor, 'botflow.saved', bot.id, { flow: def.name, steps: def.steps.length, source, version });
    this.d.broadcast('botflow.catalog', { changed: true });
    return this.info(this.flowRow(def.name)!);
  }

  private removeFlow(name: string, actor: string): void {
    const r = this.flowRow(name);
    if (!r) throw new BotFlowsError('Flow not found.', 404);
    for (const s of (this.db.prepare("SELECT * FROM bot_sessions WHERE flow = ? AND status = 'active'").all(name) as unknown as SessionRow[]).map(toS)) this.end(s, 'cancelled');
    this.db.prepare('DELETE FROM bot_flows WHERE name = ?').run(name);
    this.db.prepare('DELETE FROM bot_flow_versions WHERE name = ?').run(name);
    this.db.prepare('DELETE FROM bot_memory WHERE flow = ?').run(name);
    // a member's bot speaks for no one once it is gone (its old messages stay, read-only)
    if (r.source === 'member') this.d.store.revokeBotTokens(r.bot_id);
    this.d.store.audit(actor, 'botflow.removed', r.bot_id, { flow: name });
    this.d.broadcast('botflow.catalog', { changed: true });
  }

  // ------------------------------------------------------------ bots members make
  private isAdmin = (me: PublicUser) => me.role === 'owner' || me.role === 'admin';

  /** The live definition, and the newest revision waiting for review (if any). */
  private latest(r: FlowRow): BotFlowDefinition {
    const live = parse<BotFlowDefinition>(r.def, { name: r.name, title: r.name, steps: [], finish: [] });
    return (r.pending_version ? this.versionDef(r.name, r.pending_version) : null) ?? live;
  }

  private mineView(r: FlowRow): BotMakerBot {
    const n = this.db.prepare("SELECT COUNT(*) AS runs, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS finished FROM bot_sessions WHERE flow = ?").get(r.name) as { runs: number; finished: number | null };
    return { ...this.info(r), definition: this.latest(r), runs: n.runs, finished: n.finished ?? 0, review: parse(r.review, null) };
  }

  /** A member's own bot (or any, for an administrator). */
  private ownBot(me: PublicUser, name: string, adminToo = true): FlowRow {
    const r = this.flowRow(name);
    if (!r || r.source !== 'member') throw new BotFlowsError('That bot was not found.', 404);
    if (r.owner_id !== me.id && !(adminToo && this.isAdmin(me))) throw new BotFlowsError('Only the person who made this bot can change it.', 403);
    return r;
  }

  /** The identity a member's bot speaks with in conversations (created once; renamed with the bot). */
  private botUser(name: string, title: string, me: PublicUser): PublicUser {
    const account = `${MADE_PREFIX}${name}`;
    let bot = this.d.store.userByAccount(account);
    // everyone's apps learn the bot's name (and their tiles its mark) as soon as it exists
    if (!bot) { bot = this.d.store.createUser(account, title, 'bot'); this.d.broadcast('user.added', bot); }
    else if (bot.displayName !== title) { bot = this.d.store.updateUser(bot.id, { displayName: title }); this.d.broadcast('user.updated', bot); }
    // active while it has a token; no one is ever given this one
    if (!this.d.store.botActive(bot.id)) this.d.store.createBotToken(bot.id, crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex'), me.id);
    return bot;
  }

  /** Make or change one's own bot; see `botflow.make`. */
  make(me: PublicUser, d: Record<string, unknown>): BotMakerBot {
    if (me.role === 'guest' || me.role === 'bot') throw new BotFlowsError('Guests cannot make bots.', 403);
    let def: BotFlowDefinition;
    try { def = validateFlow(d.definition); } catch (err) { throw new BotFlowsError((err as Error).message); }
    if (!BOTFLOW_NAME_RE.test(def.name)) throw new BotFlowsError('Give the bot a name.');
    // a new bot whose short name is taken gets the next free one (plot-request-2)
    if (d.newBot === true && this.flowRow(def.name)) {
      const base = def.name.slice(0, 36).replace(/-+$/, '');
      for (let n = 2; n < 1000; n++) if (!this.flowRow(`${base}-${n}`)) { def = { ...def, name: `${base}-${n}` }; break; }
    }
    const admin = this.isAdmin(me);
    const existing = this.flowRow(def.name);
    if (existing && (existing.source !== 'member' || existing.owner_id !== me.id)) throw new BotFlowsError('Another bot already uses that name. Choose a different short name.', 409);
    if (existing && typeof d.baseVersion === 'number' && d.baseVersion !== (existing.pending_version ?? existing.version)) {
      throw new BotFlowsError(`This bot was saved elsewhere since you opened it (now revision ${existing.pending_version ?? existing.version}). Open it again to see the changes.`, 409);
    }
    if (!admin && def.finish.some((a) => a.do === 'webhook')) throw new BotFlowsError('Only administrators can call a webhook at the end. Use a Desk task, a post or a reminder.', 403);
    for (const a of def.finish) {
      if (a.do !== 'post' || !a.to.startsWith('space:')) continue;
      const id = this.d.messaging.spaceByName(a.to.slice(6));
      if (!id) throw new BotFlowsError(`There is no Space called ${a.to.slice(6)}.`);
      if (!this.d.messaging.members(id).includes(me.id)) throw new BotFlowsError(`You can post to ${a.to.slice(6)} only if you are in that Space.`, 403);
    }
    const scope: BotScope = d.scope === 'space' || d.scope === 'office' ? d.scope : 'private';
    let spaceId: string | null = null;
    if (scope === 'space') {
      spaceId = typeof d.spaceId === 'string' ? d.spaceId : '';
      const conv = (() => { try { return this.d.messaging.memberConv(spaceId, me.id) as unknown as { id: string; kind: string }; } catch { return null; } })();
      if (!conv || conv.kind !== 'space') throw new BotFlowsError('Choose a Space you are in to share it with.');
    }
    // what it asks of other bots, hands to them and listens for: only bots this person may use
    try { this.net.checkSave(me, def); this.jobs.checkSave(me, def); } catch (err) { throw new BotFlowsError((err as Error).message, 403); }
    // a slash command belongs to the whole office
    if (def.command && scope !== 'office' && existing?.scope !== 'office') throw new BotFlowsError('A slash command is for office-wide bots. Share it with the office, or leave the command out.');
    if (def.command) { const why = this.commandTaken(def.command, def.name); if (why) throw new BotFlowsError(why, 409); }
    const holdsBack = scope === 'office' && !admin && existing?.scope === 'office';
    const liveTitle = existing ? parse<BotFlowDefinition | null>(existing.def, null)?.title ?? def.title : def.title;
    const bot = this.botUser(def.name, holdsBack ? liveTitle : def.title, me);
    const version = existing ? this.nextVersion(def.name) : 1;
    this.keepVersion(def.name, version, def, me.id);
    const now = Date.now();
    // office-wide needs an administrator: until then it stays as it was (private when new)
    const wasOffice = existing?.scope === 'office';
    const asksOffice = scope === 'office' && !admin;
    const liveScope: BotScope = scope === 'office' ? (admin || wasOffice ? 'office' : existing?.scope === 'space' ? 'space' : 'private') : scope;
    const liveSpace = liveScope === 'space' ? (scope === 'space' ? spaceId : existing?.space_id ?? null) : null;
    // a newer revision of an office-wide bot waits for review; everyone keeps using the approved one
    const holdBack = asksOffice && wasOffice;
    if (!existing) {
      this.db.prepare(`INSERT INTO bot_flows (name, bot_id, def, enabled, source, updated_at, updated_by, owner_id, scope, space_id, status, version, requested, pending_version)
        VALUES (?, ?, ?, 1, 'member', ?, ?, ?, ?, ?, 'live', ?, ?, NULL)`).run(def.name, bot.id, JSON.stringify(def), now, me.id, me.id, liveScope, liveSpace, version, asksOffice ? 'office' : null);
    } else if (holdBack) {
      this.db.prepare('UPDATE bot_flows SET requested = ?, pending_version = ?, updated_at = ?, updated_by = ? WHERE name = ?').run('office', version, now, me.id, def.name);
    } else {
      this.db.prepare('UPDATE bot_flows SET def = ?, version = ?, scope = ?, space_id = ?, requested = ?, pending_version = NULL, updated_at = ?, updated_by = ? WHERE name = ?')
        .run(JSON.stringify(def), version, liveScope, liveSpace, asksOffice ? 'office' : null, now, me.id, def.name);
    }
    this.d.store.audit(me.id, asksOffice ? 'botflow.requested' : 'botflow.saved', bot.id, { flow: def.name, steps: def.steps.length, source: 'member', version, scope });
    // shared with a Space for the first time: offer it there
    if (liveScope === 'space' && liveSpace && (existing?.scope !== 'space' || existing.space_id !== liveSpace)) {
      try { this.d.messaging.ensureMember(liveSpace, bot.id); this.offer(bot, def, liveSpace); } catch (err) { this.d.log('warn', 'bot offer not posted', { error: (err as Error).message }); }
    }
    this.d.broadcast('botflow.catalog', { changed: true });
    return this.mineView(this.flowRow(def.name)!);
  }

  /** How a bot is used: runs, where people stop, recent runs (who, only for finished ones). */
  stats(r: FlowRow): BotStats {
    const def = parse<BotFlowDefinition>(r.def, { name: r.name, title: r.name, steps: [], finish: [] });
    const rows = this.db.prepare('SELECT status, step, history, started_at, user_id, flow_version FROM bot_sessions WHERE flow = ? ORDER BY started_at DESC LIMIT 5000').all(r.name) as unknown as Array<{ status: BotSession['status']; step: string | null; history: string; started_at: number; user_id: string; flow_version: number | null }>;
    const runs = rows.map((x) => ({ ...x, h: new Set(parse<string[]>(x.history, [])) }));
    const count = (st: BotSession['status']) => runs.filter((x) => x.status === st).length;
    return {
      runs: runs.length, finished: count('done'), cancelled: count('cancelled'), expired: count('expired'), active: count('active'),
      steps: def.steps.map((st) => ({
        id: st.id, label: st.label ?? (st.input.kind === 'confirm' ? 'Confirmation' : st.id),
        reached: runs.filter((x) => x.h.has(st.id) || x.step === st.id).length,
        stopped: runs.filter((x) => (x.status === 'cancelled' || x.status === 'expired') && x.step === st.id).length,
        waiting: runs.filter((x) => x.status === 'active' && x.step === st.id).length,
      })),
      recent: runs.slice(0, 15).map((x) => ({ at: x.started_at, status: x.status, reached: x.h.size, userId: x.status === 'done' ? x.user_id : null, version: x.flow_version ?? 1 })),
      versions: (this.db.prepare('SELECT version, created_at, created_by FROM bot_flow_versions WHERE name = ? ORDER BY version DESC LIMIT 30').all(r.name) as Array<{ version: number; created_at: number; created_by: string | null }>)
        .map((v) => ({ version: v.version, at: v.created_at, by: v.created_by })),
    };
  }

  private review(me: PublicUser, name: string, approve: boolean, note: string | null): BotFlowInfo {
    const r = this.flowRow(name);
    if (!r || r.source !== 'member' || r.requested !== 'office') throw new BotFlowsError('Nothing is waiting for review on that bot.', 404);
    const review = JSON.stringify({ approved: approve, note, by: me.id, at: Date.now() });
    if (approve) {
      const def = r.pending_version ? this.versionDef(name, r.pending_version) : null;
      this.db.prepare('UPDATE bot_flows SET scope = ?, space_id = NULL, requested = NULL, pending_version = NULL, review = ?, def = ?, version = ?, updated_at = ? WHERE name = ?')
        .run('office', review, def ? JSON.stringify(def) : r.def, r.pending_version ?? r.version, Date.now(), name);
      if (def && this.d.store.userById(r.bot_id)?.displayName !== def.title) this.d.broadcast('user.updated', this.d.store.updateUser(r.bot_id, { displayName: def.title }));
    } else {
      this.db.prepare('UPDATE bot_flows SET requested = NULL, pending_version = NULL, review = ? WHERE name = ?').run(review, name);
    }
    this.d.store.audit(me.id, approve ? 'botflow.approved' : 'botflow.rejected', r.bot_id, { flow: name, version: r.pending_version ?? r.version, note });
    this.d.broadcast('botflow.catalog', { changed: true });
    return this.info(this.flowRow(name)!);
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
        return this.usableFlows(undefined, me).map((r) => this.info(r)) satisfies Ops['botflow.list']['res'];
      case 'botflow.mine':
        return (this.db.prepare("SELECT * FROM bot_flows WHERE source = 'member' AND owner_id = ? ORDER BY updated_at DESC").all(me.id) as unknown as FlowRow[])
          .map((r) => this.mineView(r)) satisfies Ops['botflow.mine']['res'];
      case 'botflow.make':
        return this.make(me, d) satisfies Ops['botflow.make']['res'];
      case 'botflow.status': {
        const r = this.ownBot(me, String(d.name ?? ''));
        const st = d.status === 'paused' || d.status === 'retired' ? d.status : d.status === 'live' ? 'live' : null;
        if (!st) throw new BotFlowsError('The status is live, paused or retired.');
        // runs in progress may finish; only new runs are refused
        this.db.prepare('UPDATE bot_flows SET status = ?, updated_at = ?, updated_by = ? WHERE name = ?').run(st, Date.now(), me.id, r.name);
        this.d.store.audit(me.id, `botflow.${st === 'live' ? 'resumed' : st}`, r.bot_id, { flow: r.name });
        this.d.broadcast('botflow.catalog', { changed: true });
        return this.info(this.flowRow(r.name)!) satisfies Ops['botflow.status']['res'];
      }
      case 'botflow.delete':
        this.removeFlow(this.ownBot(me, String(d.name ?? '')).name, me.id);
        return { ok: true } satisfies Ops['botflow.delete']['res'];
      case 'botflow.stats':
        return this.stats(this.ownBot(me, String(d.name ?? ''))) satisfies Ops['botflow.stats']['res'];
      case 'botflow.definition': {
        const r = this.flowRow(String(d.name ?? ''));
        const mine = r && r.source === 'member' && r.owner_id === me.id;
        if (!r || (!mine && (!this.usable(r.name) || !this.canUse(r, me)))) throw new BotFlowsError('That bot was not found.', 404);
        return { definition: mine ? this.latest(r) : parse<BotFlowDefinition>(r.def, { name: r.name, title: r.name, steps: [], finish: [] }) } satisfies Ops['botflow.definition']['res'];
      }
      case 'botflow.act': case 'botflow.tick': case 'botflow.withdraw': case 'botflow.takeover': case 'botflow.item':
        if (me.role === 'bot') throw new BotFlowsError('Integrations cannot act on requests.', 403);
        try { return this.items.handle(op, me, d); } catch (err) { if (err instanceof BotFlowError) throw new BotFlowsError(err.message); throw err; }
      case 'botflow.about': {
        const botId = String(d.botId ?? '');
        const bot = this.d.store.userById(botId);
        if (!bot || bot.role !== 'bot') throw new BotFlowsError('That bot was not found.', 404);
        const rows = (this.db.prepare('SELECT * FROM bot_flows WHERE bot_id = ? AND enabled = 1 ORDER BY name').all(botId) as unknown as FlowRow[]).filter((r) => this.canUse(r, me));
        const defs = rows.map((r) => ({ r, def: parse<BotFlowDefinition | null>(r.def, null) })).filter((x): x is { r: FlowRow; def: BotFlowDefinition } => !!x.def);
        const main = defs[0];
        let open = 0; let yours = 0;
        for (const { def } of defs.filter((x) => x.def.track)) { const c = this.items.countsFor(def.name, me.id); open += c.open; yours += c.yours; }
        const persona = main?.def.persona ?? null;
        return {
          botId, title: defs.length === 1 ? main.def.title : bot.displayName, about: persona?.about ?? main?.def.description ?? null,
          ownerId: main?.r.owner_id ?? null, source: main?.r.source ?? null, persona, hours: persona?.hours ?? null,
          openNow: withinHours(persona?.hours, Date.now()), flows: defs.map(({ def }) => ({ name: def.name, title: def.title })),
          tracked: defs.some((x) => !!x.def.track), open, yours,
        } satisfies Ops['botflow.about']['res'];
      }
      case 'botflow.register': {
        const u = this.usable(String(d.flow ?? ''));
        if (!u || !u.def.track || !this.canUse(u.row, me)) throw new BotFlowsError('That bot was not found.', 404);
        const register = this.items.register(u.def.name, me.id, 'all');
        if (!register) throw new BotFlowsError('That bot was not found.', 404);
        if (d.post !== true) return { register } satisfies Ops['botflow.register']['res'];
        const convId = this.dm(u.bot, me.id);
        this.items.postRegister(u.bot, u.def, convId, me.id, 'all', register.counts.open === 1 ? `${u.def.title}: 1 open request.` : `${u.def.title}: ${register.counts.open} open requests.`);
        return { register, convId } satisfies Ops['botflow.register']['res'];
      }
      case 'botflow.forget':
        this.db.prepare('DELETE FROM bot_memory WHERE flow = ? AND user_id = ?').run(String(d.name ?? ''), me.id);
        return { ok: true } satisfies Ops['botflow.forget']['res'];
      case 'botflow.marks':
        return (this.db.prepare("SELECT * FROM bot_flows WHERE source = 'member'").all() as unknown as FlowRow[])
          .map((r) => ({ r, p: parse<BotFlowDefinition | null>(r.def, null) }))
          .filter((x) => !!x.p?.persona)
          .map(({ r, p }) => ({ botId: r.bot_id, name: p!.title, mark: p!.persona!.mark, colour: p!.persona!.colour })) satisfies Ops['botflow.marks']['res'];
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
        const u = this.startable(String(d.flow ?? ''), me);
        if (!u) throw new BotFlowsError('That flow is not available.', 404);
        const conv = this.d.messaging.memberConv(String(d.convId ?? ''), me.id) as unknown as { id: string; kind: string };
        if (conv.kind !== 'space') throw new BotFlowsError('Offer a flow in a Space.');
        if (u.row.scope === 'private') throw new BotFlowsError('Share the bot before offering it: it is private to you.');
        if (u.row.scope === 'space' && u.row.space_id !== conv.id) throw new BotFlowsError('This bot is shared with another Space only.');
        this.d.messaging.ensureMember(conv.id, u.bot.id);
        const clientId = this.offer(u.bot, u.def, conv.id);
        const r = this.db.prepare('SELECT message_id FROM bot_cards WHERE client_id = ?').get(clientId) as { message_id: string };
        return this.d.messaging.messageFor(r.message_id, me.id)! satisfies Ops['botflow.offer']['res'];
      }
      case 'admin.botflows.list':
        admin();
        return (this.db.prepare('SELECT * FROM bot_flows ORDER BY name').all() as unknown as FlowRow[])
          .map((r) => ({
            ...this.info(r), definition: parse<BotFlowDefinition>(r.def, { name: r.name, title: r.name, steps: [], finish: [] }),
            pending: r.pending_version ? this.versionDef(r.name, r.pending_version) : null,
          })) satisfies Ops['admin.botflows.list']['res'];
      case 'admin.botflows.review':
        admin();
        return this.review(me, String(d.name ?? ''), d.approve === true, typeof d.note === 'string' && d.note.trim() ? d.note.trim().slice(0, 300) : null) satisfies Ops['admin.botflows.review']['res'];
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
      // ---------------------------------------------------------- bots talking to bots
      case 'botnet.skills':
        if (me.role === 'guest' || me.role === 'bot') throw new BotFlowsError('Guests cannot make bots.', 403);
        return this.net.skillsFor(me.id, typeof d.flow === 'string' ? d.flow : undefined) satisfies Ops['botnet.skills']['res'];
      case 'botnet.try': {
        if (me.role === 'guest' || me.role === 'bot') throw new BotFlowsError('Guests cannot make bots.', 403);
        const w = d.with && typeof d.with === 'object' && !Array.isArray(d.with) ? Object.fromEntries(Object.entries(d.with as Record<string, unknown>).slice(0, 10).map(([k, v]) => [k, String(v ?? '')])) : {};
        const r = await this.net.ask({ from: '__test', person: me, trail: [], group: `try:${me.id}`, dry: true, ownerOverride: me.id }, { skill: String(d.skill ?? ''), with: w }, {});
        return { ok: r.ok, answer: r.answer, values: r.values, words: r.words, reason: r.reason } satisfies Ops['botnet.try']['res'];
      }
      case 'botnet.retry': {
        try { await this.retryAsk(me, String(d.hopId ?? '')); } catch (err) { if (err instanceof BotNetError) throw new BotFlowsError(err.message); throw err; }
        const hop = this.net.hop(String(d.hopId ?? ''));
        if (!hop) throw new BotFlowsError('That was not found.', 404);
        return { ok: true, hop } satisfies Ops['botnet.retry']['res'];
      }
      case 'botnet.map':
        if (me.role === 'guest' || me.role === 'bot') throw new BotFlowsError('Guests cannot see the bot network.', 403);
        return this.net.map(me, d.scope === 'office' ? 'office' : 'mine') satisfies Ops['botnet.map']['res'];
      case 'botnet.edge':
        try { return { exchanges: this.net.edge(me, String(d.from ?? ''), String(d.to ?? '')) } satisfies Ops['botnet.edge']['res']; } catch (err) { if (err instanceof BotNetError) throw new BotFlowsError(err.message, 403); throw err; }
      case 'botjob.sheet': case 'botjob.set': case 'botjob.run': case 'botjob.history': case 'botjob.calendar': case 'admin.botjob.holidays':
        if (me.role === 'guest' || me.role === 'bot') throw new BotFlowsError('Guests cannot schedule bots.', 403);
        try { return await this.jobs.handle(op, me, d); } catch (err) { if (err instanceof Error && err.name === 'BotJobsError') throw new BotFlowsError(err.message, 403); throw err; }
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
