// Nib, the office's companion (docs/NIB.md): day sheets, the leads' transmittals, the management's
// register, the leave note and the welcome back. Nib is one permanent bot identity; its cards are
// messages in each person's conversation with Nib that the app draws from `nib.card`, checked
// against the viewer's permissions every time. Nib keeps its own clock (real time plus an offset)
// so tests can move through a day in seconds; nothing a client sends can move it.
import type { DatabaseSync } from 'node:sqlite';
import { ulid } from '@dex/core';
import { isSealed } from '@dex/core/e2e';
import type { Conversation, Department, KnockView, Message, PublicUser } from '@dex/core';
import {
  NIB_ACCOUNT, NIB_DEFAULTS, NIB_NAME, NIB_WORK_INTENTS, addDays, buildLeadCard, buildRegister, buildWeek, checkNibConfig, effectiveWrapAt,
  liteItem, minutesOf, nudgePlan, nudgePolicy, parseWork, qtyText, sheetAccess, visibleItems, weekdayOf,
} from '@dex/core/nib';
import type {
  LeadCardView, NibAsk, NibCard, NibCardKind, NibConfig, NibDay, NibDayState, NibItem, NibItemInput, NibLeave, NibLeaveInput, NibLeaveKind,
  NibLeavePlan, NibMe, NibNudgeView, NibParse, NibQty, NibRegister, NibSheetView, NibSource, NibStatus, NibWeek, NibWelcome,
} from '@dex/core/nib';
import type { Messaging, MsgRow } from './messaging.ts';
import type { Store } from './store.ts';
import type { Desk } from './desk.ts';
import type { Calendar } from './calendar.ts';
import type { Work } from './work.ts';
import type { Holidays } from './holidays.ts';
import type { HolidayReadView } from '@dex/core/holidays';
import { assignedAnswer, isOpenItem, matchBook, mentionsAnswer, safeWorkbookLink, sheetsAsk, whoAnswer } from '@dex/core/sheets';
import type { SheetsAsk } from '@dex/core/sheets';
import { localDate } from './work.ts';
import { SheetsError } from './sheets.ts';
import type { SheetsLink } from './sheets.ts';

export class NibError extends Error {}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nib_items (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, date TEXT NOT NULL, giver_id TEXT, giver_name TEXT, project TEXT,
  activity TEXT NOT NULL, unit TEXT, qty_done REAL, qty_total REAL, note TEXT, status TEXT NOT NULL, due TEXT,
  source TEXT NOT NULL, carried INTEGER NOT NULL DEFAULT 0, message_id TEXT, cover_for TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nib_items_user ON nib_items(user_id, date);
CREATE INDEX IF NOT EXISTS idx_nib_items_giver ON nib_items(date, giver_id);
CREATE TABLE IF NOT EXISTS nib_days (
  user_id TEXT NOT NULL, date TEXT NOT NULL, givers TEXT NOT NULL DEFAULT '[]', started INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'open', sent_at INTEGER, changed_at INTEGER, note TEXT, blockers TEXT,
  asks TEXT NOT NULL DEFAULT '[]', snooze_until INTEGER, snooze_free INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);
CREATE INDEX IF NOT EXISTS idx_nib_days_date ON nib_days(date);
CREATE TABLE IF NOT EXISTS nib_posts (kind TEXT NOT NULL, ref TEXT NOT NULL, user_id TEXT NOT NULL, message_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (kind, ref, user_id));
CREATE TABLE IF NOT EXISTS nib_snapshots (kind TEXT NOT NULL, ref TEXT NOT NULL, data TEXT, sent_at INTEGER NOT NULL, PRIMARY KEY (kind, ref));
CREATE TABLE IF NOT EXISTS nib_leave (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, from_date TEXT NOT NULL, to_date TEXT NOT NULL, half TEXT,
  cover_id TEXT, note TEXT, handover TEXT, lead_ids TEXT NOT NULL DEFAULT '[]', space_ids TEXT NOT NULL DEFAULT '[]',
  reminders TEXT NOT NULL DEFAULT 'move', items TEXT NOT NULL DEFAULT '[]', event_id TEXT, status_before TEXT,
  applied INTEGER NOT NULL DEFAULT 0, moved INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, cancelled INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_nib_leave_user ON nib_leave(user_id, to_date);
CREATE TABLE IF NOT EXISTS nib_acks (date TEXT NOT NULL, giver_id TEXT NOT NULL, user_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (date, giver_id, user_id));
CREATE TABLE IF NOT EXISTS nib_prefs (user_id TEXT PRIMARY KEY, wrap_at TEXT, welcome_seen TEXT, pinned INTEGER NOT NULL DEFAULT 0, hello INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS nib_replies (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, text TEXT NOT NULL, parse TEXT NOT NULL, item_id TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS nib_sheets (user_id TEXT PRIMARY KEY, digest INTEGER NOT NULL DEFAULT 0, last_digest TEXT);
`;

interface ItemRow {
  id: string; user_id: string; date: string; giver_id: string | null; giver_name: string | null; project: string | null; activity: string;
  unit: string | null; qty_done: number | null; qty_total: number | null; note: string | null; status: NibStatus; due: string | null;
  source: NibSource; carried: number; message_id: string | null; cover_for: string | null; created_at: number; updated_at: number;
}
interface DayRow { user_id: string; date: string; givers: string; started: number; state: NibDayState; sent_at: number | null; changed_at: number | null; note: string | null; blockers: string | null; asks: string; snooze_until: number | null; snooze_free: number }
interface LeaveRow {
  id: string; user_id: string; kind: NibLeaveKind; from_date: string; to_date: string; half: 'am' | 'pm' | null; cover_id: string | null; note: string | null;
  handover: string | null; lead_ids: string; space_ids: string; reminders: 'move' | 'cover' | 'keep'; items: string; event_id: string | null;
  status_before: string | null; applied: number; moved: number; created_at: number; cancelled: number;
}

const parse = <T>(s: string | null | undefined, d: T): T => { if (!s) return d; try { return JSON.parse(s) as T; } catch { return d; } };
const line = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max) : '');
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T12:00:00`).getTime());
const STATUSES: NibStatus[] = ['going', 'done', 'blocked'];
const KINDS: NibLeaveKind[] = ['annual', 'sick', 'comp', 'half'];
const SOURCES: NibSource[] = ['start', 'words', 'offer', 'slash', 'wrap', 'carried', 'cover', 'flow', 'meeting'];
const MAX_ITEMS_A_DAY = 60;
/** Operations that change the person's own day (their apps are sent nib.me after each). */
const SHEET_OPS = new Set(['nib.start', 'nib.item.save', 'nib.item.delete', 'nib.wrap', 'nib.day', 'nib.leave.cancel', 'nib.cover.take', 'nib.welcome.seen']);
const DAY_MS = 86400_000;

const toItem = (r: ItemRow): NibItem => ({
  id: r.id, userId: r.user_id, date: r.date, giverId: r.giver_id, giverName: r.giver_name, project: r.project, activity: r.activity,
  qty: r.unit !== null || r.qty_done !== null || r.qty_total !== null ? { done: r.qty_done, total: r.qty_total, unit: r.unit } : null,
  note: r.note, status: r.status, due: r.due, source: r.source, carried: !!r.carried, messageId: r.message_id, coverFor: r.cover_for, createdAt: r.created_at, updatedAt: r.updated_at,
});
const toLeave = (r: LeaveRow): NibLeave => ({
  id: r.id, userId: r.user_id, kind: r.kind, from: r.from_date, to: r.to_date, half: r.half, coverId: r.cover_id, note: r.note, handover: r.handover,
  leadIds: parse<string[]>(r.lead_ids, []), spaceIds: parse<string[]>(r.space_ids, []), reminders: r.reminders, createdAt: r.created_at, cancelled: !!r.cancelled,
});

function qtyIn(v: unknown): NibQty | null {
  if (!v || typeof v !== 'object') return null;
  const q = v as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? Math.max(0, Math.min(1_000_000, Math.round(x * 10) / 10)) : null);
  const out = { done: n(q.done), total: n(q.total), unit: line(q.unit, 20) || null };
  if (out.done === null && out.total === null) return null;
  if (out.unit === '%') { out.total = 100; out.done = Math.min(100, out.done ?? 0); }
  return out;
}

export interface NibDeps {
  db: DatabaseSync;
  store: Store;
  messaging: Messaging;
  desk: Desk;
  calendar: Calendar;
  work: Work;
  /** The office's days off and compensatory working days: Nib does not ask or send on a day off. */
  days?: Holidays;
  /** Events to people: each gets their own copy. */
  deliver: (userIds: string[], name: string, data: (uid: string) => unknown) => void;
  /** One of their devices is connected now. */
  online: (userId: string) => boolean;
  /** Why someone should not be interrupted now: 'room', 'meeting', 'dnd' or 'busy' (Heads-down); null when free. */
  busy: (userId: string) => 'room' | 'meeting' | 'dnd' | 'busy' | null;
  departments: () => Department[];
  audit: (actor: string | null, action: string, target: string | null, detail?: unknown) => void;
  userChanged: (userId: string) => void;
  userAdded: (u: PublicUser) => void;
  log: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
  /** Dexterity Sheets' read API (sheets.ts): people ask Nib about their own Sheets items. */
  sheets?: SheetsLink;
}

/** How long after the morning time Nib keeps trying a Sheets server that did not answer. */
const SHEETS_DIGEST_TRIES_MS = 3 * 3600_000;

export class Nib {
  private nibId: string | null;
  private readonly d: NibDeps;
  private readonly db: DatabaseSync;
  /** Milliseconds added to real time (tests and the end-to-end script move the clock this way). */
  private offset = 0;
  private lastTick = 0;
  private cfgCache: NibConfig | null = null;
  private readonly convs = new Map<string, string>();
  private readonly nudges = new Map<string, NibNudgeView | null>();
  /** Why someone was not asked through the wrap-up window ("room", "meeting"…), per date. */
  private readonly busyNotes = new Map<string, Map<string, Set<string>>>();

  constructor(d: NibDeps) {
    this.d = d;
    this.db = d.db;
    this.db.exec(SCHEMA);
    // Nib's identity is made the first time anyone uses Nib (an office that never opens the app has none)
    this.nibId = d.store.userByAccount(NIB_ACCOUNT)?.id ?? null;
    d.messaging.viewExtras.push((r) => this.view(r));
    d.messaging.purgeExtras.push((id) => { this.db.prepare('DELETE FROM nib_posts WHERE message_id = ?').run(id); });
  }

  /** Nib's user id (made on first use). */
  get id(): string {
    if (!this.nibId) {
      const had = this.d.store.userByAccount(NIB_ACCOUNT);
      let u = had ?? this.d.store.createUser(NIB_ACCOUNT, NIB_NAME, 'bot');
      if (!had) u = this.d.store.updateUser(u.id, { title: 'Day sheets, leave and reminders' });
      this.nibId = u.id;
      if (!had) this.d.userAdded(u);
    }
    return this.nibId;
  }

  // ------------------------------------------------------------ the clock
  now(): number { return Date.now() + this.offset; }
  /** Tests only (the hub object in the same process): set Nib's clock to a moment, or back to real time with null. */
  setClock(at: number | null): void { this.offset = at === null ? 0 : at - Date.now(); this.lastTick = 0; }
  private today(): string { return localDate(this.now()); }
  private at(date: string, hm: string): number { const [y, m, dd] = date.split('-').map(Number); const t = minutesOf(hm); return new Date(y, m - 1, dd, Math.floor(t / 60), t % 60).getTime(); }
  private endOf(date: string): number { return this.at(date, '23:59') + 59_000; }

  // ------------------------------------------------------------ configuration
  config(): NibConfig {
    if (this.cfgCache) return this.cfgCache;
    const raw = this.d.store.meta('nib_config', () => '');
    const cfg = { ...NIB_DEFAULTS, ...parse<Partial<NibConfig>>(raw, {}) };
    this.cfgCache = cfg;
    return cfg;
  }
  /** Has an administrator (or the first start) saved a configuration? */
  hasSavedConfig(): boolean { return this.d.store.meta('nib_config', () => '') !== ''; }
  /** The first start's defaults (firstrun.ts): written once, so later changes to NIB_DEFAULTS do not move an office's times. */
  seedConfig(cfg: NibConfig): void { this.setConfig(cfg); }
  private setConfig(cfg: NibConfig): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('nib_config', JSON.stringify(cfg));
    this.cfgCache = cfg;
  }
  private exempt(uid: string, cfg = this.config()): boolean { return (cfg.exempt ?? cfg.managers).includes(uid); }
  /** One of the office's workdays (or a compensatory working day), and not a holiday or a day off. */
  private workday(date: string, cfg = this.config()): boolean {
    const days = this.d.days;
    return (cfg.workdays.includes(weekdayOf(date)) || !!days?.isExtra(date)) && !days?.isOff(date);
  }
  /** For the hub's other clocks (meeting action points): a working day as Nib counts one. */
  isWorkday(date: string): boolean { return this.workday(date); }
  private prevWorkday(date: string): string | null {
    for (let i = 1; i <= 7; i++) { const d = addDays(date, -i); if (this.workday(d)) return d; }
    return null;
  }
  private nextWorkday(date: string): string {
    for (let i = 1; i <= 7; i++) { const d = addDays(date, i); if (this.workday(d)) return d; }
    return addDays(date, 1);
  }

  /** Members who keep a day sheet: people (not bots or guests) who can sign in, minus the exempt. */
  private people(): PublicUser[] {
    const cfg = this.config();
    return this.d.store.activeUsers().filter((u) => (u.role === 'member' || u.role === 'admin' || u.role === 'owner') && !this.exempt(u.id, cfg));
  }
  private member(uid: string): PublicUser | null {
    const u = this.d.store.userById(uid);
    return u && u.role !== 'bot' && u.role !== 'guest' && this.d.store.activeUsers().some((a) => a.id === u.id) ? u : null;
  }

  // ------------------------------------------------------------ rows
  private items(uid: string, date: string): NibItem[] {
    return (this.db.prepare('SELECT * FROM nib_items WHERE user_id = ? AND date = ? ORDER BY created_at').all(uid, date) as unknown as ItemRow[]).map(toItem);
  }
  private itemsOn(date: string): NibItem[] {
    return (this.db.prepare('SELECT * FROM nib_items WHERE date = ? ORDER BY created_at').all(date) as unknown as ItemRow[]).map(toItem);
  }
  private item(id: string): NibItem | null {
    const r = this.db.prepare('SELECT * FROM nib_items WHERE id = ?').get(id) as ItemRow | undefined;
    return r ? toItem(r) : null;
  }
  private dayRow(uid: string, date: string): DayRow | undefined {
    return this.db.prepare('SELECT * FROM nib_days WHERE user_id = ? AND date = ?').get(uid, date) as DayRow | undefined;
  }
  private dayOf(uid: string, date: string, r = this.dayRow(uid, date)): NibDay {
    if (!r) return { userId: uid, date, givers: [], started: false, state: this.leaveOn(uid, date) ? 'leave' : 'open', sentAt: null, changedAt: null, note: null, blockers: null, asks: [], snoozeUntil: null };
    return {
      userId: r.user_id, date: r.date, givers: parse<string[]>(r.givers, []), started: !!r.started, state: r.state, sentAt: r.sent_at, changedAt: r.changed_at,
      note: r.note, blockers: r.blockers, asks: parse<NibAsk[]>(r.asks, []), snoozeUntil: r.snooze_until,
    };
  }
  private daysOn(date: string): Map<string, NibDay> {
    const rows = this.db.prepare('SELECT * FROM nib_days WHERE date = ?').all(date) as unknown as DayRow[];
    return new Map(rows.map((r) => [r.user_id, this.dayOf(r.user_id, date, r)] as const));
  }
  /** The day's row, made the first time (and yesterday's open items carried over to it). */
  private ensureDay(uid: string, date: string): NibDay {
    if (this.dayRow(uid, date)) return this.dayOf(uid, date);
    const leave = this.leaveOn(uid, date);
    this.db.prepare('INSERT OR IGNORE INTO nib_days (user_id, date, state) VALUES (?, ?, ?)').run(uid, date, leave ? 'leave' : 'open');
    if (date === this.today() && this.workday(date)) this.carryOver(uid, date);
    return this.dayOf(uid, date);
  }
  private carryOver(uid: string, date: string): void {
    const last = this.db.prepare('SELECT MAX(date) AS d FROM nib_items WHERE user_id = ? AND date < ? AND date >= ?').get(uid, date, addDays(date, -10)) as { d: string | null };
    if (!last.d) return;
    const open = this.items(uid, last.d).filter((x) => x.status !== 'done');
    const now = this.now();
    const ins = this.db.prepare('INSERT INTO nib_items (id, user_id, date, giver_id, giver_name, project, activity, unit, qty_done, qty_total, note, status, due, source, carried, message_id, cover_for, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)');
    for (const x of open.slice(0, MAX_ITEMS_A_DAY)) ins.run(ulid(), uid, date, x.giverId, x.giverName, x.project, x.activity, x.qty?.unit ?? null, x.qty?.done ?? null, x.qty?.total ?? null, x.note, x.status, x.due, 'carried', x.messageId, x.coverFor, now, now);
  }
  private saveDay(day: NibDay): void {
    this.db.prepare(`INSERT INTO nib_days (user_id, date, givers, started, state, sent_at, changed_at, note, blockers, asks, snooze_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, date) DO UPDATE SET givers = excluded.givers, started = excluded.started, state = excluded.state, sent_at = excluded.sent_at, changed_at = excluded.changed_at,
      note = excluded.note, blockers = excluded.blockers, asks = excluded.asks, snooze_until = excluded.snooze_until`)
      .run(day.userId, day.date, JSON.stringify(day.givers.slice(0, 30)), day.started ? 1 : 0, day.state, day.sentAt, day.changedAt, day.note, day.blockers, JSON.stringify(day.asks.slice(-20)), day.snoozeUntil);
  }

  private leaveRows(uid: string): LeaveRow[] {
    return this.db.prepare('SELECT * FROM nib_leave WHERE user_id = ? AND cancelled = 0 ORDER BY from_date').all(uid) as unknown as LeaveRow[];
  }
  /** Leave covering a date (a half day counts). */
  private leaveOn(uid: string, date: string): NibLeave | null {
    const r = this.db.prepare('SELECT * FROM nib_leave WHERE user_id = ? AND cancelled = 0 AND from_date <= ? AND to_date >= ? ORDER BY created_at DESC LIMIT 1').get(uid, date, date) as LeaveRow | undefined;
    return r ? toLeave(r) : null;
  }
  private leaveById(id: string): LeaveRow | undefined {
    return this.db.prepare('SELECT * FROM nib_leave WHERE id = ?').get(id) as LeaveRow | undefined;
  }

  // ------------------------------------------------------------ the conversation with Nib
  private bot(): PublicUser { return this.d.store.userById(this.id)!; }
  /** Each person's conversation with Nib (the app shows it above the Switchboard's lists). */
  convFor(uid: string): string | null {
    const hit = this.convs.get(uid);
    if (hit) return hit;
    const u = this.d.store.userById(uid);
    if (!u || u.role === 'bot' || u.role === 'guest') return null;
    try {
      const conv = this.d.messaging.handle('conv.create', this.bot(), { kind: 'direct', members: [uid] }) as Conversation;
      this.convs.set(uid, conv.id);
      return conv.id;
    } catch (err) {
      this.d.log('warn', 'nib conversation', { error: (err as Error).message });
      return null;
    }
  }
  isNibConv(convId: string): boolean {
    if (!this.nibId) return false;
    const m = this.d.messaging.members(convId);
    return m.length === 2 && m.includes(this.nibId);
  }

  /** Knock cards (meet-lobby.ts): the knock as the viewer may see it; set by the hub. */
  knockCard: ((me: PublicUser, ref: string) => KnockView | null) | null = null;
  /**
   * Someone waits in the lobby of a meeting this person may let people into: a card with Admit
   * and Decline in their conversation with Nib (once per knock and person). Posted whether or not
   * day sheets are on: Nib is how the office's own news reaches a person.
   */
  postKnock(uid: string, ref: string, body: string): boolean { return !!this.post(uid, 'knock', ref, body); }
  /** Cards of a kind changed for these people (their apps fetch them again). */
  touch(uids: string[], kind: NibCardKind): void { this.changed(this.today(), [kind], uids); }

  /** A card in someone's conversation with Nib, once per kind, reference and person. */
  private post(uid: string, kind: NibCardKind, ref: string, body: string): string | null {
    const had = this.db.prepare('SELECT message_id FROM nib_posts WHERE kind = ? AND ref = ? AND user_id = ?').get(kind, ref, uid) as { message_id: string } | undefined;
    if (had) return had.message_id;
    const convId = this.convFor(uid);
    if (!convId) return null;
    try {
      const msg = this.d.messaging.sendAs(this.bot(), this.d.messaging.memberConv(convId, this.id), body.slice(0, 2000), undefined, [], `nib|${kind}|${ref}|${uid}`.slice(0, 96), {});
      this.db.prepare('INSERT OR IGNORE INTO nib_posts (kind, ref, user_id, message_id, created_at) VALUES (?, ?, ?, ?, ?)').run(kind, ref, uid, msg.id, this.now());
      return msg.id;
    } catch (err) {
      this.d.log('warn', 'nib card not posted', { kind, error: (err as Error).message });
      return null;
    }
  }
  private posted(kind: NibCardKind, ref: string, uid: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM nib_posts WHERE kind = ? AND ref = ? AND user_id = ?').get(kind, ref, uid);
  }
  /**
   * One plain line from Nib in someone's conversation with Nib, once per key (the notice board's
   * reminders and answers). False when Nib is off or cannot reach them, so the caller can use the
   * system bot instead.
   */
  note(uid: string, key: string, text: string): boolean {
    if (!this.config().enabled) return false;
    const ref = key.slice(0, 80);
    if (this.db.prepare(`SELECT 1 FROM nib_posts WHERE kind = 'line' AND ref = ? AND user_id = ?`).get(ref, uid)) return true;
    const convId = this.convFor(uid);
    if (!convId) return false;
    try {
      const msg = this.d.messaging.sendAs(this.bot(), this.d.messaging.memberConv(convId, this.id), text.slice(0, 2000), undefined, [], `nibline|${ref}|${uid}`.slice(0, 96), {});
      this.db.prepare('INSERT OR IGNORE INTO nib_posts (kind, ref, user_id, message_id, created_at) VALUES (?, ?, ?, ?, ?)').run('line', ref, uid, msg.id, this.now());
      return true;
    } catch (err) {
      this.d.log('warn', 'nib line not posted', { error: (err as Error).message });
      return false;
    }
  }
  /** A Space line from Nib (a leave notice). */
  private postInSpace(convId: string, ref: string, body: string): void {
    try {
      this.d.messaging.ensureMember(convId, this.id);
      const msg = this.d.messaging.sendAs(this.bot(), this.d.messaging.memberConv(convId, this.id), body.slice(0, 2000), undefined, [], `nib|leaveSpace|${ref}|${convId}`.slice(0, 96), {});
      this.db.prepare('INSERT OR IGNORE INTO nib_posts (kind, ref, user_id, message_id, created_at) VALUES (?, ?, ?, ?, ?)').run('leaveSpace', ref, convId, msg.id, this.now());
    } catch (err) { this.d.log('warn', 'nib space notice', { error: (err as Error).message }); }
  }

  /** The card a message carries (most messages are not Nib's). */
  private view(r: MsgRow): Partial<Message> {
    if (!this.nibId || r.author_id !== this.nibId || !r.client_id?.startsWith('nib|') || r.deleted) return {};
    const [, kind, ref] = r.client_id.split('|');
    return kind && ref ? { nib: { kind: kind as NibCardKind, ref } } : {};
  }

  // ------------------------------------------------------------ what someone sees of their own day
  me(u: PublicUser): NibMe {
    const cfg = this.config();
    const date = this.today();
    const exempt = this.exempt(u.id, cfg);
    const day = this.ensureDay(u.id, date);
    const pref = this.db.prepare('SELECT wrap_at, welcome_seen FROM nib_prefs WHERE user_id = ?').get(u.id) as { wrap_at: string | null; welcome_seen: string | null } | undefined;
    const since = addDays(date, -14);
    const usual = (this.db.prepare(`SELECT giver_id, COUNT(DISTINCT date) AS n FROM nib_items WHERE user_id = ? AND date >= ? AND date < ? AND giver_id IS NOT NULL GROUP BY giver_id ORDER BY n DESC LIMIT 8`).all(u.id, since, date) as Array<{ giver_id: string }>).map((r) => r.giver_id);
    const recentProjects = (this.db.prepare(`SELECT project, MAX(date) AS last FROM nib_items WHERE user_id = ? AND date >= ? AND project IS NOT NULL GROUP BY project ORDER BY last DESC LIMIT 8`).all(u.id, since) as Array<{ project: string }>).map((r) => r.project);
    const seen = Object.fromEntries((this.db.prepare('SELECT giver_id, at FROM nib_acks WHERE date = ? AND user_id = ?').all(date, u.id) as Array<{ giver_id: string; at: number }>).map((r) => [r.giver_id, r.at]));
    const upcoming = this.leaveRows(u.id).find((l) => l.to_date >= date) ?? null;
    let yesterday: NibMe['yesterday'] = null;
    const prev = this.prevWorkday(date);
    if (prev && !exempt && this.workday(prev)) {
      const pd = this.dayRow(u.id, prev);
      const n = this.items(u.id, prev).length;
      if (pd && pd.state === 'open' && (n > 0 || pd.started)) yesterday = { date: prev, items: n };
    }
    return {
      enabled: cfg.enabled, botId: this.id, convId: this.convFor(u.id), date, workday: this.workday(date, cfg), exempt,
      isManager: cfg.managers.includes(u.id), isGiver: cfg.givers.some((g) => g.userId === u.id),
      day, items: this.items(u.id, date), nudge: this.nudges.get(u.id) ?? null,
      wrapAt: this.wrapFor(u.id, pref?.wrap_at ?? null), ownWrapAt: pref?.wrap_at ?? null, digestAt: cfg.digestAt,
      givers: cfg.givers.filter((g) => g.userId !== u.id), projects: cfg.projects, usual: usual.filter((g) => g !== u.id), recentProjects, seen,
      leave: upcoming ? toLeave(upcoming) : null, welcome: this.welcomeFor(u.id, date, pref?.welcome_seen ?? null), yesterday,
    };
  }
  private wrapFor(uid: string, own: string | null): string {
    const cfg = this.config();
    const sends = (this.db.prepare('SELECT sent_at FROM nib_days WHERE user_id = ? AND sent_at IS NOT NULL ORDER BY date DESC LIMIT 10').all(uid) as Array<{ sent_at: number }>)
      .map((r) => { const t = new Date(r.sent_at); return t.getHours() * 60 + t.getMinutes(); });
    return effectiveWrapAt(cfg.wrapAt, own, sends, cfg.digestAt, cfg.nudgeLimit);
  }
  private welcomeFor(uid: string, date: string, seen: string | null): NibWelcome | null {
    const r = this.db.prepare('SELECT * FROM nib_leave WHERE user_id = ? AND cancelled = 0 AND to_date < ? AND to_date >= ? ORDER BY to_date DESC LIMIT 1').get(uid, date, addDays(date, -10)) as LeaveRow | undefined;
    if (!r || r.id === seen) return null;
    const leave = toLeave(r);
    const coverItems = leave.coverId ? (this.db.prepare('SELECT * FROM nib_items WHERE user_id = ? AND cover_for = ? AND date >= ? AND date <= ? ORDER BY date, created_at LIMIT 30').all(leave.coverId, uid, leave.from, leave.to) as unknown as ItemRow[])
      .map(toItem).map((x) => ({ activity: x.activity, project: x.project, qty: x.qty, note: x.note, status: x.status, by: x.userId })) : [];
    return { leave, reminders: r.moved, coverItems };
  }
  private pushMe(uids: string[]): void {
    const list = [...new Set(uids)].filter((u) => this.d.online(u));
    if (!list.length) return;
    this.d.deliver(list, 'nib.me', (uid) => { const u = this.d.store.userById(uid); return u ? this.me(u) : null; });
  }
  private changed(date: string, kinds: NibCardKind[], uids: string[]): void {
    const list = [...new Set(uids)];
    if (list.length) this.d.deliver(list, 'nib.changed', () => ({ date, kinds }));
  }

  // ------------------------------------------------------------ items
  private saveItem(me: PublicUser, input: NibItemInput & { date?: string }, now = this.now()): NibItem {
    const date = isDate(input.date) ? input.date : this.today();
    if (date > this.today() || date < addDays(this.today(), -7)) throw new NibError('Day sheets can be changed for the last week only.');
    const prev = typeof input.id === 'string' ? this.item(input.id) : null;
    if (input.id !== undefined && (!prev || prev.userId !== me.id)) throw new NibError('That item is not on your day sheet.');
    const activity = input.activity !== undefined ? line(input.activity, 160) : prev?.activity ?? '';
    const giverId = input.giverId !== undefined ? (input.giverId && input.giverId !== me.id && this.member(input.giverId) ? input.giverId : null) : prev?.giverId ?? null;
    const giverName = input.giverName !== undefined ? line(input.giverName, 60) || null : prev?.giverName ?? null;
    const project = input.project !== undefined ? line(input.project, 24).toUpperCase() || null : prev?.project ?? null;
    if (!activity && !project && !giverId && !giverName) throw new NibError('Say what the work is.');
    const qty = input.qty !== undefined ? qtyIn(input.qty) : prev?.qty ?? null;
    const status = STATUSES.includes(input.status as NibStatus) ? input.status as NibStatus : prev?.status ?? 'going';
    const note = input.note !== undefined ? text(input.note, 400) || null : prev?.note ?? null;
    const due = input.due !== undefined ? (isDate(input.due) ? input.due : null) : prev?.due ?? null;
    const source = SOURCES.includes(input.source as NibSource) ? input.source as NibSource : prev?.source ?? 'words';
    const day = this.ensureDay(me.id, date);
    if (prev) {
      if (prev.date !== date) throw new NibError('That item is on another day.');
      this.db.prepare('UPDATE nib_items SET giver_id = ?, giver_name = ?, project = ?, activity = ?, unit = ?, qty_done = ?, qty_total = ?, note = ?, status = ?, due = ?, updated_at = ? WHERE id = ?')
        .run(giverId, giverName, project, activity || project || 'Work', qty?.unit ?? null, qty?.done ?? null, qty?.total ?? null, note, status, due, now, prev.id);
    } else {
      const n = (this.db.prepare('SELECT COUNT(*) AS n FROM nib_items WHERE user_id = ? AND date = ?').get(me.id, date) as { n: number }).n;
      if (n >= MAX_ITEMS_A_DAY) throw new NibError(`A day sheet holds up to ${MAX_ITEMS_A_DAY} items.`);
      // the same message offered twice adds it once
      const messageId = typeof input.messageId === 'string' ? input.messageId.slice(0, 40) : null;
      if (messageId) {
        const dup = this.db.prepare('SELECT id FROM nib_items WHERE user_id = ? AND date = ? AND message_id = ?').get(me.id, date, messageId) as { id: string } | undefined;
        if (dup) return this.item(dup.id)!;
      }
      const id = ulid();
      this.db.prepare('INSERT INTO nib_items (id, user_id, date, giver_id, giver_name, project, activity, unit, qty_done, qty_total, note, status, due, source, carried, message_id, cover_for, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)')
        .run(id, me.id, date, giverId, giverName, project, activity || project || 'Work', qty?.unit ?? null, qty?.done ?? null, qty?.total ?? null, note, status, due, source, messageId, typeof input.coverFor === 'string' ? input.coverFor : null, now, now);
      input = { ...input, id };
    }
    if (giverId && !day.givers.includes(giverId)) day.givers.push(giverId);
    day.started = true;
    if (day.state === 'nothing') day.state = 'open';
    if (day.state === 'sent') day.changedAt = now;
    this.saveDay(day);
    if (day.state === 'sent') this.afterSent(me, date, day);
    if (prev && prev.source === 'meeting' && prev.status !== status) { try { this.onMeetingItem?.(prev.id, status, me.id); } catch (err) { this.d.log('warn', 'nib: meeting item hook failed', { error: (err as Error).message }); } }
    return this.item(String(input.id))!;
  }

  // ------------------------------------------------------------ action points from meetings (meet-threads.ts)
  /** An action point's status changed on the day sheet (ticked done there): the meeting's register follows. */
  onMeetingItem: ((itemId: string, status: NibStatus, by: string) => void) | null = null;

  /**
   * An action point from a meeting on its owner's day sheet, given by the meeting's organiser.
   * Returns the item's id, or null when the owner keeps no day sheet (Nib off, exempt, a bot).
   */
  meetingItem(owner: PublicUser, a: { activity: string; giverId: string | null; due: string | null; messageId: string }): string | null {
    const cfg = this.config();
    if (!cfg.enabled || owner.role === 'bot' || owner.role === 'guest' || this.exempt(owner.id, cfg)) return null;
    try {
      // the giver must be a colleague other than the owner; the item stays the owner's own work
      const it = this.saveItem(owner, { activity: a.activity, giverId: a.giverId && a.giverId !== owner.id ? a.giverId : null, due: a.due, messageId: a.messageId, source: 'meeting', status: 'going' });
      this.pushMe([owner.id]);
      return it.id;
    } catch (err) { this.d.log('info', 'nib: action point not added to the day sheet', { error: (err as Error).message }); return null; }
  }

  /** The action point was ticked (or reopened) in the meeting: its day-sheet item follows, whatever day it is on. */
  meetingItemStatus(itemId: string, status: NibStatus): void {
    const it = this.item(itemId);
    if (!it || it.status === status) return;
    this.db.prepare('UPDATE nib_items SET status = ?, updated_at = ? WHERE id = ?').run(status, this.now(), it.id);
    this.pushMe([it.userId]);
  }

  /** The action point went to someone else, or was dropped: its item leaves the day sheet (only if still not done). */
  meetingItemGone(itemId: string): void {
    const it = this.item(itemId);
    if (!it || it.source !== 'meeting' || it.status === 'done') return;
    this.db.prepare('DELETE FROM nib_items WHERE id = ?').run(it.id);
    this.pushMe([it.userId]);
  }

  /** For other bots (the nib.away skill): on leave that day, the last day away, who covers. */
  leaveInfo(uid: string, date: string): { back: string | null; coverId: string | null } | null {
    const r = this.db.prepare('SELECT to_date, cover_id FROM nib_leave WHERE user_id = ? AND cancelled = 0 AND from_date <= ? AND to_date >= ? ORDER BY created_at DESC LIMIT 1').get(uid, date, date) as { to_date: string; cover_id: string | null } | undefined;
    return r ? { back: addDays(r.to_date, 1), coverId: r.cover_id } : null;
  }

  /** On leave on that day (overdue reminders wait until they are back). */
  awayOn(uid: string, date: string): boolean { return !!this.leaveOn(uid, date); }

  /** The working day, for reminders that should only arrive in working hours. */
  workingDay(): { workdays: number[]; start: string; end: string; isWorkday: (date: string) => boolean } {
    const cfg = this.config();
    return { workdays: cfg.workdays, start: cfg.startPromptAt, end: cfg.wrapAt, isWorkday: (date) => this.workday(date, cfg) };
  }

  /** After a sheet is sent (or changed after sending): every lead it names gets their card, or sees it change. */
  private afterSent(me: PublicUser, date: string, day: NibDay): void {
    const givers = [...new Set(this.items(me.id, date).map((x) => x.giverId).filter((g): g is string => !!g && g !== me.id))];
    const label = new Date(`${date}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    for (const g of givers) {
      if (!this.member(g)) continue;
      if (!this.posted('lead', date, g)) this.post(g, 'lead', date, `Day sheets for ${label}: ${me.displayName} sent work from you.`);
    }
    this.changed(date, ['lead'], givers);
    this.changed(date, ['ask'], [me.id]);
    void day;
  }

  // ------------------------------------------------------------ operations
  handle(op: string, me: PublicUser, d: Record<string, unknown>): unknown {
    if (op.startsWith('admin.nib.')) return this.admin(op, me, d);
    if (me.role === 'bot' || me.role === 'guest') throw new NibError('Nib keeps day sheets for members of the office.');
    const out = this.op(op, me, d);
    // the person's day changed: every app they have open (another PC, the phone, a tray left open)
    // sees it now, whichever path changed it, not only the one that asked
    if (SHEET_OPS.has(op)) this.pushMe([me.id]);
    return out;
  }

  private op(op: string, me: PublicUser, d: Record<string, unknown>): unknown {
    const now = this.now();
    switch (op) {
      case 'nib.me': this.welcomeMember(me); return this.me(me);

      case 'nib.start': {
        const date = this.today();
        const day = this.ensureDay(me.id, date);
        const givers = (Array.isArray(d.givers) ? d.givers : []).filter((g): g is string => typeof g === 'string' && g !== me.id && !!this.member(g)).slice(0, 20);
        day.givers = [...new Set([...day.givers, ...givers])];
        day.started = true;
        this.saveDay(day);
        for (const it of Array.isArray(d.items) ? d.items.slice(0, 20) : []) {
          try { this.saveItem(me, { ...(it as NibItemInput), id: undefined, source: 'start' }); } catch { /* an empty line on the card */ }
        }
        if (d.yesterday === 'send') {
          const prev = this.prevWorkday(date);
          if (prev) this.send(me, prev, {});
        }
        this.nudges.delete(me.id);
        return this.me(me);
      }

      case 'nib.item.save': {
        this.saveItem(me, d as NibItemInput & { date?: string });
        return this.me(me);
      }

      case 'nib.item.delete': {
        const it = typeof d.id === 'string' ? this.item(d.id) : null;
        if (!it || it.userId !== me.id) throw new NibError('That item is not on your day sheet.');
        this.db.prepare('DELETE FROM nib_items WHERE id = ?').run(it.id);
        const day = this.dayOf(me.id, it.date);
        if (day.state === 'sent') { day.changedAt = now; this.saveDay(day); this.afterSent(me, it.date, day); }
        return this.me(me);
      }

      case 'nib.wrap': {
        const date = isDate(d.date) ? d.date : this.today();
        if (date > this.today() || date < addDays(this.today(), -7)) throw new NibError('Day sheets can be sent for the last week only.');
        this.send(me, date, d);
        return this.me(me);
      }

      case 'nib.day': {
        const date = isDate(d.date) ? d.date : this.today();
        const day = this.ensureDay(me.id, date);
        if (d.nothing === true) {
          if (this.items(me.id, date).some((x) => !x.carried)) throw new NibError('Your sheet already has work on it. Send it instead.');
          day.state = 'nothing'; day.started = true;
        }
        if (d.reopen === true && day.state === 'nothing') day.state = 'open';
        if (typeof d.snoozeMinutes === 'number' && d.snoozeMinutes > 0) {
          day.snoozeUntil = now + Math.min(240, Math.round(d.snoozeMinutes)) * 60_000;
          // a snooze never skips the register: in a short window it ends at the last ask before it
          if (date === this.today()) {
            const cfg = this.config();
            const wrapAt = this.at(date, this.wrapFor(me.id, (this.db.prepare('SELECT wrap_at FROM nib_prefs WHERE user_id = ?').get(me.id) as { wrap_at: string | null } | undefined)?.wrap_at ?? null));
            const plan = nudgePlan((this.at(date, cfg.digestAt) - wrapAt) / 60_000, cfg.nudgeLimit);
            const last = wrapAt + plan.offsets[plan.offsets.length - 1] * 60_000;
            if (now < last && day.snoozeUntil > last) day.snoozeUntil = last;
          }
        }
        if (d.snoozeUntilFree === true) {
          day.snoozeUntil = now + 3 * 3600_000;
          this.db.prepare('UPDATE nib_days SET snooze_free = 1 WHERE user_id = ? AND date = ?').run(me.id, date);
        }
        this.saveDay(day);
        if (d.snoozeUntilFree === true) this.db.prepare('UPDATE nib_days SET snooze_free = 1 WHERE user_id = ? AND date = ?').run(me.id, date);
        if (d.wrapAt !== undefined) {
          const w = d.wrapAt === null ? null : typeof d.wrapAt === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(d.wrapAt) ? d.wrapAt : undefined;
          if (w === undefined) throw new NibError('Write the time like 18:15.');
          this.db.prepare('INSERT INTO nib_prefs (user_id, wrap_at) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET wrap_at = excluded.wrap_at').run(me.id, w);
        }
        this.nudges.set(me.id, null);
        return this.me(me);
      }

      case 'nib.card': return this.card(me, String(d.kind ?? ''), String(d.ref ?? ''), typeof d.messageId === 'string' ? d.messageId : null);

      // holiday circulars (docs/HOLIDAYS.md): read one picked in Office holidays (the card also goes
      // to the conversation with Nib), take the text the desktop read from a scan, register one
      case 'nib.holidays.read': {
        const days = this.d.days;
        if (!days) throw new NibError('Holiday circulars are not available on this hub.');
        if (typeof d.id === 'string' && typeof d.text === 'string') {
          const v = days.readText(me, d.id, d.text);
          this.d.deliver([me.id], 'nib.changed', () => ({ date: this.today(), kinds: ['holidays'] }));
          return v;
        }
        if (typeof d.fileId !== 'string') throw new NibError('Choose the circular’s PDF.');
        const v = days.read(me, d.fileId);
        this.postCircular(me, v);
        return v;
      }
      case 'nib.holidays.register': {
        const days = this.d.days;
        if (!days) throw new NibError('Holiday circulars are not available on this hub.');
        const v = days.register(me, String(d.id ?? ''));
        const c = v.done?.counts;
        const summary = c ? `Registered ${v.plan?.rows.length ?? 0} days from Ref ${v.read?.ref ?? '—'}: ${c.holiday} holidays, ${c.weekoff} Saturdays off, ${c.compoff} compensatory days off, ${c.compwork} compensatory working days.` : 'Registered.';
        this.post(me.id, 'holidaysDone', v.id, summary);
        // the read's card, wherever it is open, shows it registered
        this.d.deliver([me.id], 'nib.changed', () => ({ date: this.today(), kinds: ['holidays'] }));
        return v;
      }

      case 'nib.ack': {
        const date = isDate(d.date) ? d.date : this.today();
        const card = this.leadCard(me.id, date);
        const who = typeof d.userId === 'string' ? [d.userId] : card.rows.map((r) => r.userId);
        const ins = this.db.prepare('INSERT OR IGNORE INTO nib_acks (date, giver_id, user_id, at) VALUES (?, ?, ?, ?)');
        const marked: string[] = [];
        for (const uid of who) if (card.rows.some((r) => r.userId === uid)) { ins.run(date, me.id, uid, now); marked.push(uid); }
        this.pushMe(marked);
        this.changed(date, ['lead'], [me.id]);
        return this.leadCard(me.id, date) satisfies LeadCardView;
      }

      case 'nib.sheet': {
        const uid = String(d.userId ?? '');
        const date = isDate(d.date) ? d.date : this.today();
        const owner = this.d.store.userById(uid);
        if (!owner) throw new NibError('That person was not found.');
        const cfg = this.config();
        const access = sheetAccess(me, uid, cfg);
        const items = visibleItems(me, uid, this.items(uid, date), cfg);
        if (access === 'none' || (access === 'given' && !items.length)) throw new NibError('That day sheet is private.');
        const day = this.dayRow(uid, date) ? this.dayOf(uid, date) : null;
        return { userId: uid, date, day: day ? (access === 'all' ? day : { ...day, asks: [] }) : null, items, access } satisfies NibSheetView;
      }

      case 'nib.leave.plan': return this.leavePlan(me, d);
      case 'nib.leave': return this.leave(me, d as unknown as NibLeaveInput);

      case 'nib.leave.cancel': {
        const r = typeof d.id === 'string' ? this.leaveById(d.id) : undefined;
        if (!r || r.user_id !== me.id || r.cancelled) throw new NibError('That leave was not found.');
        this.db.prepare('UPDATE nib_leave SET cancelled = 1 WHERE id = ?').run(r.id);
        if (r.applied === 1) this.unapply(r);
        if (r.event_id) { try { this.d.calendar.handle('cal.cancel', me, { eventId: r.event_id }); } catch { /* already gone */ } }
        this.db.prepare(`UPDATE nib_days SET state = 'open' WHERE user_id = ? AND state = 'leave' AND date >= ? AND date <= ?`).run(me.id, r.from_date, r.to_date);
        this.d.audit(me.id, 'nib.leaveCancelled', r.id, { from: r.from_date, to: r.to_date });
        return this.me(me);
      }

      case 'nib.cover.take': {
        const r = typeof d.leaveId === 'string' ? this.leaveById(d.leaveId) : undefined;
        if (!r || r.cover_id !== me.id) throw new NibError('You are not covering that leave.');
        const src = (parse<NibItem[]>(r.items, [])).find((x) => x.id === d.itemId);
        if (!src) throw new NibError('That item is not in the handover.');
        this.saveItem(me, { giverId: src.giverId, giverName: src.giverName, project: src.project, activity: src.activity, qty: src.qty, note: src.note, status: src.status === 'done' ? 'going' : src.status, due: src.due, source: 'cover', messageId: src.id, coverFor: r.user_id });
        this.changed(this.today(), ['cover'], [me.id]);
        return this.me(me);
      }

      case 'nib.welcome.seen': {
        const w = this.welcomeFor(me.id, this.today(), null);
        if (w) this.db.prepare('INSERT INTO nib_prefs (user_id, welcome_seen) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET welcome_seen = excluded.welcome_seen').run(me.id, w.leave.id);
        return this.me(me);
      }
    }
    return undefined;
  }

  private send(me: PublicUser, date: string, d: Record<string, unknown>): void {
    const now = this.now();
    for (const u of Array.isArray(d.items) ? d.items.slice(0, MAX_ITEMS_A_DAY) : []) {
      const x = u as { id?: unknown; done?: unknown; total?: unknown; status?: unknown; note?: unknown };
      const it = typeof x.id === 'string' ? this.item(x.id) : null;
      if (!it || it.userId !== me.id || it.date !== date) continue;
      const qty = it.qty || typeof x.done === 'number' || typeof x.total === 'number'
        ? qtyIn({ done: typeof x.done === 'number' ? x.done : it.qty?.done ?? null, total: typeof x.total === 'number' ? x.total : it.qty?.total ?? null, unit: it.qty?.unit ?? null })
        : null;
      const status = STATUSES.includes(x.status as NibStatus) ? x.status as NibStatus : it.status;
      this.db.prepare('UPDATE nib_items SET qty_done = ?, qty_total = ?, unit = ?, status = ?, note = ?, updated_at = ? WHERE id = ?')
        .run(qty?.done ?? null, qty?.total ?? null, qty?.unit ?? null, status, x.note !== undefined ? text(x.note, 400) || null : it.note, now, it.id);
    }
    const day = this.ensureDay(me.id, date);
    if (day.state === 'leave') throw new NibError('You are on leave that day.');
    if (d.note !== undefined) day.note = text(d.note, 600) || null;
    if (d.blockers !== undefined) day.blockers = text(d.blockers, 400) || null;
    if (day.state === 'sent') day.changedAt = now; else { day.state = 'sent'; day.sentAt = now; }
    day.started = true;
    day.snoozeUntil = null;
    this.saveDay(day);
    this.nudges.set(me.id, null);
    this.afterSent(me, date, day);
  }

  // ------------------------------------------------------------ cards
  private leadCard(giverId: string, date: string): LeadCardView {
    const items = this.db.prepare('SELECT * FROM nib_items WHERE date = ? AND giver_id = ?').all(date, giverId) as unknown as ItemRow[];
    const users = [...new Set(items.map((r) => r.user_id))];
    const days = this.daysOn(date);
    // people who named this lead at the start of the day but have nothing from them yet are waiting too
    const named = [...days.values()].filter((x) => x.givers.includes(giverId));
    const list = [...new Map([...users.map((u) => days.get(u) ?? this.dayOf(u, date)), ...named].map((x) => [x.userId, x] as const)).values()];
    const seen = new Map((this.db.prepare('SELECT user_id, at FROM nib_acks WHERE date = ? AND giver_id = ?').all(date, giverId) as Array<{ user_id: string; at: number }>).map((r) => [r.user_id, r.at] as const));
    const reg = this.db.prepare(`SELECT sent_at FROM nib_snapshots WHERE kind = 'register' AND ref = ?`).get(date) as { sent_at: number } | undefined;
    return buildLeadCard({ date, giverId, days: list, items: items.map(toItem), seen, digestSentAt: reg?.sent_at ?? null });
  }

  private card(me: PublicUser, kind: string, ref: string, messageId: string | null): NibCard {
    const cfg = this.config();
    const denied = () => new NibError('This card is not for you.');
    switch (kind) {
      case 'lead': {
        if (!isDate(ref)) throw denied();
        return { kind: 'lead', lead: this.leadCard(me.id, ref) };
      }
      case 'register': case 'followup': case 'week': {
        const preview = ref.endsWith('.p');
        const isAdmin = me.role === 'owner' || me.role === 'admin';
        if (!cfg.managers.includes(me.id) && !(preview && isAdmin) && !this.posted(kind as NibCardKind, ref, me.id)) throw denied();
        const snap = this.db.prepare('SELECT data, sent_at FROM nib_snapshots WHERE kind = ? AND ref = ?').get(kind, ref) as { data: string | null; sent_at: number } | undefined;
        if (!snap?.data) throw new NibError('This register is no longer kept.');
        if (kind === 'week') return { kind: 'week', week: parse<NibWeek>(snap.data, null as unknown as NibWeek) };
        return { kind: kind as 'register' | 'followup', register: parse<NibRegister>(snap.data, null as unknown as NibRegister), sentAt: snap.sent_at };
      }
      case 'ask': {
        if (!isDate(ref)) throw denied();
        const day = this.dayOf(me.id, ref);
        return { kind: 'ask', date: ref, userId: me.id, state: day.state, items: this.items(me.id, ref).length };
      }
      case 'leave': case 'leaveSpace': case 'cover': case 'welcome': {
        const r = this.leaveById(ref);
        if (!r) throw new NibError('That leave was not found.');
        const leave = toLeave(r);
        const inSpace = kind === 'leaveSpace' && messageId && (() => { const m = this.d.messaging.row(messageId); return !!m && m.author_id === this.id && this.d.messaging.isMember(m.conv_id, me.id); })();
        const ok = me.id === r.user_id || (kind === 'leave' && leave.leadIds.includes(me.id)) || (kind === 'cover' && r.cover_id === me.id) || inSpace;
        if (!ok) throw denied();
        if (kind === 'cover') {
          const taken = (this.db.prepare('SELECT message_id FROM nib_items WHERE user_id = ? AND cover_for = ? AND source = ?').all(me.id, r.user_id, 'cover') as Array<{ message_id: string | null }>).map((x) => x.message_id).filter((x): x is string => !!x);
          return { kind: 'cover', leave, items: parse<NibItem[]>(r.items, []).map(liteItem), taken };
        }
        // a Space sees when and who covers, never the note or the handover
        if (kind === 'leaveSpace' && me.id !== r.user_id) return { kind, leave: { ...leave, note: null, handover: null, leadIds: [], spaceIds: [] } };
        if (kind === 'leave' && me.id !== r.user_id) return { kind, leave: { ...leave, handover: null, spaceIds: [] } };
        return { kind: kind as 'leave' | 'welcome', leave };
      }
      case 'joiner': case 'hello': {
        if (ref !== me.id) throw denied();
        return kind === 'joiner' ? { kind, userId: me.id, meet: this.peopleToMeet(me) } : { kind, userId: me.id };
      }
      case 'holidays': case 'holidaysDone': {
        if (!this.d.days) throw denied();
        return { kind, view: this.d.days.view(me, ref) };
      }
      case 'knock': {
        if (!this.posted('knock', ref, me.id)) throw denied();
        try { return { kind: 'knock', knock: this.knockCard?.(me, ref) ?? null }; } catch (err) { throw new NibError((err as Error).message); }
      }
      case 'reply': {
        const r = this.db.prepare('SELECT * FROM nib_replies WHERE id = ? AND user_id = ?').get(ref, me.id) as { text: string; parse: string; item_id: string | null } | undefined;
        if (!r) throw denied();
        const itemId = r.item_id && this.item(r.item_id) ? r.item_id : null;
        return { kind: 'reply', parse: parse<NibParse>(r.parse, null as unknown as NibParse), text: r.text, itemId, userId: me.id };
      }
    }
    throw new NibError('Unknown card.');
  }

  /** A new joiner's first people: their manager, their department's head and three colleagues there. */
  private peopleToMeet(me: PublicUser): string[] {
    const all = this.d.store.activeUsers().filter((u) => u.role !== 'bot' && u.role !== 'guest' && u.id !== me.id);
    const out: string[] = [];
    if (me.profile.managerId) out.push(me.profile.managerId);
    const dept = this.d.departments().find((x) => x.id === me.profile.departmentId);
    if (dept?.headId && dept.headId !== me.id && !out.includes(dept.headId)) out.push(dept.headId);
    for (const u of all) if (u.profile.departmentId && u.profile.departmentId === me.profile.departmentId && !out.includes(u.id) && out.length < 5) out.push(u.id);
    for (const u of all) if (out.length < 3 && !out.includes(u.id)) out.push(u.id);
    return out.filter((id) => all.some((u) => u.id === id)).slice(0, 5);
  }

  // ------------------------------------------------------------ the leave note
  private leavePlan(me: PublicUser, d: Record<string, unknown>): NibLeavePlan {
    const from = isDate(d.from) ? d.from : this.today();
    const to = isDate(d.to) && d.to >= from ? d.to : from;
    const today = this.today();
    const day = this.dayOf(me.id, today);
    const usual = (this.db.prepare(`SELECT giver_id, COUNT(*) AS n FROM nib_items WHERE user_id = ? AND date >= ? AND giver_id IS NOT NULL GROUP BY giver_id ORDER BY n DESC LIMIT 3`).all(me.id, addDays(today, -14)) as Array<{ giver_id: string }>).map((r) => r.giver_id);
    const leads = [...new Set([...day.givers, ...usual, ...(me.profile.managerId ? [me.profile.managerId] : [])])].filter((id) => id !== me.id && !!this.member(id)).slice(0, 6);
    const spaces = (this.db.prepare(`SELECT c.id, c.name, COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conv_id
      WHERE m.author_id = ? AND m.created_at > ? AND c.kind = 'space' AND COALESCE(c.everyone, 0) = 0 AND COALESCE(c.archived, 0) = 0 GROUP BY c.id ORDER BY n DESC LIMIT 3`).all(me.id, this.now() - 14 * DAY_MS) as Array<{ id: string; name: string | null }>)
      .filter((r) => this.d.messaging.isMember(r.id, me.id)).map((r) => ({ id: r.id, name: r.name ?? 'Space' }));
    const start = this.at(from, '00:00');
    const end = this.endOf(to);
    const reminders = (this.d.desk.handle('remind.list', me, {}) as Array<{ id: string; text: string; dueAt: number; userId: string; done: boolean }>)
      .filter((r) => r.userId === me.id && !r.done && r.dueAt >= start && r.dueAt <= end).slice(0, 30).map((r) => ({ id: r.id, text: r.text, dueAt: r.dueAt }));
    return { leads, spaces, reminders };
  }

  private leave(me: PublicUser, d: NibLeaveInput): { leave: NibLeave; done: string[] } {
    const today = this.today();
    const kind = KINDS.includes(d.kind) ? d.kind : 'annual';
    if (!isDate(d.from) || !isDate(d.to)) throw new NibError('Choose the days you are away.');
    if (d.to < d.from) throw new NibError('The last day comes after the first.');
    if (d.from < today) throw new NibError('Leave starts today or later.');
    if (d.to > addDays(today, 120)) throw new NibError('Leave can be noted up to four months ahead.');
    const half = kind === 'half' ? (d.half === 'pm' ? 'pm' : 'am') : null;
    const to = half ? d.from : d.to;
    const overlap = this.db.prepare('SELECT 1 FROM nib_leave WHERE user_id = ? AND cancelled = 0 AND from_date <= ? AND to_date >= ?').get(me.id, to, d.from);
    if (overlap) throw new NibError('You already have leave on those days. Cancel it first to change it.');
    const coverId = typeof d.coverId === 'string' && d.coverId !== me.id && this.member(d.coverId) ? d.coverId : null;
    const leadIds = [...new Set((Array.isArray(d.leadIds) ? d.leadIds : []).filter((x): x is string => typeof x === 'string' && x !== me.id && !!this.member(x)))].slice(0, 8);
    const spaceIds = [...new Set((Array.isArray(d.spaceIds) ? d.spaceIds : []).filter((x): x is string => typeof x === 'string' && this.d.messaging.isMember(x, me.id)))].slice(0, 5);
    const reminders = d.reminders === 'cover' && coverId ? 'cover' : d.reminders === 'keep' ? 'keep' : 'move';
    const open = this.items(me.id, today).filter((x) => x.status !== 'done').slice(0, 30);
    const id = ulid();
    const now = this.now();
    this.db.prepare(`INSERT INTO nib_leave (id, user_id, kind, from_date, to_date, half, cover_id, note, handover, lead_ids, space_ids, reminders, items, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, me.id, kind, d.from, to, half, coverId, line(d.note, 300) || null, text(d.handover, 1200) || null, JSON.stringify(leadIds), JSON.stringify(spaceIds), reminders, JSON.stringify(open), now);
    const row = this.leaveById(id)!;
    const leave = toLeave(row);
    const done: string[] = [];
    // the days themselves: no nudges, one grouped line in the register
    for (let x = d.from; x <= to; x = addDays(x, 1)) {
      const day = this.ensureDay(me.id, x);
      if (day.state !== 'sent' && !(half && x === today && day.state === 'open' && this.items(me.id, x).some((i) => !i.carried))) { day.state = 'leave'; this.saveDay(day); }
    }
    // away from the office, now or on the first day
    if (d.from <= today) { this.apply(row); done.push('away'); } else done.push('away-later');
    // the calendar
    try {
      const startAt = half === 'pm' ? this.at(d.from, '13:30') : half === 'am' ? this.at(d.from, '09:30') : this.at(d.from, '00:00');
      const endAt = half === 'am' ? this.at(d.from, '13:30') : half === 'pm' ? this.at(d.from, '18:30') : this.at(addDays(to, 1), '00:00');
      const ev = this.d.calendar.handle('cal.create', me, { title: half ? 'On leave (half day)' : 'On leave', startAt, endAt, allDay: !half, attendees: [] }) as { id: string };
      this.db.prepare('UPDATE nib_leave SET event_id = ? WHERE id = ?').run(ev.id, id);
      done.push('calendar');
    } catch (err) { this.d.log('warn', 'nib leave calendar', { error: (err as Error).message }); }
    // leads (the management sees it in the register instead), the Spaces, the cover
    const cfg = this.config();
    const when = this.span(leave);
    let told = 0;
    for (const lead of leadIds) {
      if (cfg.managers.includes(lead) || lead === coverId) continue;
      if (this.post(lead, 'leave', id, `${me.displayName} is on leave ${when}.${coverId ? ` Cover: ${this.d.store.userById(coverId)?.displayName}.` : ''}`)) told++;
    }
    if (told) done.push(`leads:${told}`);
    for (const s of spaceIds) this.postInSpace(s, id, `${me.displayName} is away ${when}.${coverId ? ` For anything urgent, ask ${this.d.store.userById(coverId)?.displayName}.` : ''}`);
    if (spaceIds.length) done.push(`spaces:${spaceIds.length}`);
    if (coverId && this.post(coverId, 'cover', id, `${me.displayName} is on leave ${when}, and you are covering.`)) done.push('cover');
    // Desk reminders due while away
    if (reminders !== 'keep') {
      const plan = this.leavePlan(me, { from: d.from, to });
      const back = this.at(this.nextWorkday(to), '09:30');
      let moved = 0;
      for (const r of plan.reminders) {
        try {
          if (reminders === 'cover' && coverId) {
            this.d.desk.handle('remind.create', me, { forUserId: coverId, text: `${r.text} (for ${me.displayName})`.slice(0, 500), dueAt: r.dueAt });
            this.d.desk.handle('remind.update', me, { id: r.id, done: true });
          } else this.d.desk.handle('remind.update', me, { id: r.id, dueAt: back });
          moved++;
        } catch { /* a reminder that cannot move stays */ }
      }
      this.db.prepare('UPDATE nib_leave SET moved = ? WHERE id = ?').run(moved, id);
      if (moved) done.push(`reminders:${moved}`);
    }
    this.d.audit(me.id, 'nib.leave', id, { from: d.from, to, kind, cover: coverId, leads: leadIds.length, spaces: spaceIds.length });
    this.pushMe([me.id]);
    return { leave: toLeave(this.leaveById(id)!), done };
  }
  private span(l: NibLeave): string {
    const f = (s: string) => new Date(`${s}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    if (l.half) return `${l.half === 'am' ? 'the morning' : 'the afternoon'} of ${f(l.from)}`;
    return l.from === l.to ? `on ${f(l.from)}` : `${f(l.from)} – ${f(l.to)}`;
  }
  /** Out of office until the end of the leave, with the cover as the contact, and the status saying when they are back. */
  private apply(r: LeaveRow): void {
    const u = this.d.store.userById(r.user_id);
    if (!u) return;
    const until = r.half === 'am' ? this.at(r.from_date, '13:30') : r.half === 'pm' ? this.endOf(r.from_date) : this.endOf(r.to_date);
    if (until <= Date.now()) return;
    this.d.store.setPresenceExtras(r.user_id, { ooo: { until, message: r.note, delegateId: r.cover_id } });
    const back = r.half ? null : new Date(`${this.nextWorkday(r.to_date)}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    this.db.prepare('UPDATE nib_leave SET applied = 1, status_before = ? WHERE id = ?').run(JSON.stringify({ text: u.statusText }), r.id);
    this.d.store.updateUser(r.user_id, { statusText: back ? `On leave · back ${back}` : 'On leave this half day' });
    this.d.userChanged(r.user_id);
  }
  private unapply(r: LeaveRow): void {
    const before = parse<{ text: string | null }>(r.status_before, { text: null });
    const u = this.d.store.userById(r.user_id);
    if (u?.ooo) this.d.store.setPresenceExtras(r.user_id, { ooo: null });
    if (u && (u.statusText ?? '').startsWith('On leave')) this.d.store.updateUser(r.user_id, { statusText: before.text });
    this.db.prepare('UPDATE nib_leave SET applied = 2 WHERE id = ?').run(r.id);
    this.d.userChanged(r.user_id);
  }

  /** The bot maker's "Mark me away" end action: the leave note from a flow's answers. */
  leaveFromFlow(me: PublicUser, a: { kind?: string; from?: string; to?: string; cover?: string | null; note?: string | null; leads?: string[] }): string {
    const kind = (KINDS.includes(a.kind as NibLeaveKind) ? a.kind : /sick/i.test(a.kind ?? '') ? 'sick' : /comp/i.test(a.kind ?? '') ? 'comp' : /half/i.test(a.kind ?? '') ? 'half' : 'annual') as NibLeaveKind;
    const from = isDate(a.from) ? a.from : this.today();
    // the flow asks for the day they are back: the leave ends on the workday before it
    let to = isDate(a.to) ? a.to : from;
    if (to > from) { let x = addDays(to, -1); while (x > from && !this.workday(x)) x = addDays(x, -1); to = x; }
    const r = this.leave(me, { kind, from, to, coverId: a.cover ?? null, note: a.note ?? null, handover: a.note ?? null, leadIds: a.leads ?? [], spaceIds: [], reminders: 'move' });
    return `Marked away ${this.span(r.leave)}${r.leave.coverId ? `, ${this.d.store.userById(r.leave.coverId)?.displayName} covering` : ''}.`;
  }

  // ------------------------------------------------------------ the conversation with Nib
  /** Someone wrote to Nib: read it with the same rules as the app, act, and answer with a card. */
  onPosted(author: PublicUser, convId: string, msg: Message): void {
    if (!this.nibId || author.id === this.nibId || author.role === 'bot' || author.role === 'guest' || msg.parentId) return;
    // a PDF given to Nib: a holiday circular to read (docs/HOLIDAYS.md)
    const pdfs = (msg.files ?? []).filter((f) => f.mime === 'application/pdf' || /\.pdf$/i.test(f.name));
    if (pdfs.length && this.d.days && this.isNibConv(convId)) {
      for (const f of pdfs.slice(0, 3)) this.readCircular(author, f.id);
      return;
    }
    if (!msg.body || isSealed(msg.body) || !this.isNibConv(convId)) return;
    const said = msg.body.replace(/^\/(?:got|done|nib)\s+/i, '');
    // a question for Dexterity Sheets is answered from Sheets, never written on the day sheet;
    // "who's in X" without saying Sheets is a Sheets question only when Sheets has a book called X
    const ask = sheetsAsk(said);
    if (ask && (ask.kind !== 'who' || ask.named || this.d.sheets?.configured())) {
      void this.sheetsReply(author, ask).then((text) => {
        if (text === null) this.answerWords(author, said);
        else this.sheetsSay(author.id, text);
      }).catch((err: Error) => this.d.log('warn', 'nib sheets answer', { error: err.message }));
      return;
    }
    this.answerWords(author, said);
  }

  /** Words to Nib about the day: noted on the day sheet when they are work, answered with a card. */
  private answerWords(author: PublicUser, body: string): void {
    const cfg = this.config();
    const users = this.d.store.activeUsers().filter((u) => u.role !== 'bot' && u.role !== 'guest');
    const giverIds = new Set(cfg.givers.map((g) => g.userId));
    const p = parseWork(body, { people: users.map((u) => ({ id: u.id, name: u.displayName, giver: giverIds.has(u.id) })), projects: cfg.projects, today: this.today(), meId: author.id });
    let itemId: string | null = null;
    try {
      if (NIB_WORK_INTENTS.includes(p.intent) && cfg.enabled && !this.exempt(author.id)) {
        const it = this.saveItem(author, { giverId: p.giver?.id ?? null, project: p.project, activity: p.activity, qty: p.qty, note: p.note, status: p.status ?? 'going', due: p.due, source: 'words' });
        itemId = it.id;
      } else if (p.intent === 'nothing' && cfg.enabled) {
        try { this.handle('nib.day', author, { nothing: true }); } catch { /* already has work */ }
      }
    } catch (err) { this.d.log('warn', 'nib could not note it', { error: (err as Error).message }); }
    const id = ulid();
    this.db.prepare('INSERT INTO nib_replies (id, user_id, text, parse, item_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, author.id, body.slice(0, 400), JSON.stringify(p), itemId, this.now());
    const fallback = itemId ? `Noted: ${[p.activity, p.project, qtyText(p.qty)].filter(Boolean).join(' · ')}` : p.intent === 'nothing' ? 'Nothing today. Fair enough.' : 'Here is what I found.';
    this.post(author.id, 'reply', id, fallback);
    if (itemId) this.pushMe([author.id]);
  }

  // ------------------------------------------------------------ Dexterity Sheets
  /** People who asked for the morning list of their open Sheets items. */
  sheetsDigestPeople(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM nib_sheets WHERE digest = 1').get() as { n: number }).n;
  }
  private sheetsDigestOn(uid: string): boolean {
    return !!(this.db.prepare('SELECT digest FROM nib_sheets WHERE user_id = ?').get(uid) as { digest: number } | undefined)?.digest;
  }

  /** A plain Markdown line from Nib in someone's conversation with Nib (its workbook links get cards). */
  private sheetsSay(uid: string, text: string): { convId: string; messageId: string } | null {
    const convId = this.convFor(uid);
    if (!convId) return null;
    try {
      const msg = this.d.messaging.sendAs(this.bot(), this.d.messaging.memberConv(convId, this.id), text.slice(0, 4000), undefined, [], `nibsheets|${ulid()}|${uid}`.slice(0, 96), {});
      return { convId, messageId: msg.id };
    } catch (err) {
      this.d.log('warn', 'nib sheets line not posted', { error: (err as Error).message });
      return null;
    }
  }

  /**
   * A notice an office tool asked the hub to pass on (toolnotices.ts): a plain line in the person's
   * conversation with Nib. The text already starts with the tool's name, written by the hub. Posted
   * whether or not day sheets are on (as knocks are); null for someone Nib does not write to (a
   * guest), so the caller can send it in the tool's own name instead.
   */
  toolLine(uid: string, text: string): { convId: string; messageId: string } | null {
    const convId = this.convFor(uid);
    if (!convId) return null;
    try {
      const msg = this.d.messaging.sendAs(this.bot(), this.d.messaging.memberConv(convId, this.id), text.slice(0, 4000), undefined, [], `nibtool|${ulid()}|${uid}`.slice(0, 96), {});
      return { convId, messageId: msg.id };
    } catch (err) {
      this.d.log('warn', 'nib tool notice not posted', { error: (err as Error).message });
      return null;
    }
  }

  /** `nib.sheets.ask`: the app's Nib box asked; the answer goes in the conversation with Nib too. */
  async sheetsAnswer(me: PublicUser, text: string): Promise<{ convId: string | null; messageId: string | null; text: string }> {
    if (me.role === 'bot' || me.role === 'guest') throw new NibError('Nib answers members of the office.');
    const ask = sheetsAsk(String(text ?? ''));
    if (!ask) throw new NibError('Ask about Dexterity Sheets, for example “what’s assigned to me in Sheets?”.');
    const answer = await this.sheetsReply(me, ask.kind === 'who' ? { ...ask, named: true } : ask) ?? '';
    const posted = this.sheetsSay(me.id, answer);
    return { convId: posted?.convId ?? null, messageId: posted?.messageId ?? null, text: answer };
  }

  /**
   * Nib's answer to a Sheets question, always about the person asking (their own Windows account);
   * null when "who's in X" turns out not to be about a workbook.
   */
  private async sheetsReply(me: PublicUser, ask: SheetsAsk): Promise<string | null> {
    const sheets = this.d.sheets;
    if (ask.kind === 'digest') {
      this.db.prepare('INSERT INTO nib_sheets (user_id, digest) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET digest = excluded.digest').run(me.id, ask.on ? 1 : 0);
      if (!ask.on) return 'Done. No more morning list from Dexterity Sheets.';
      const note = sheets?.configured() ? '' : ' Dexterity Sheets is not connected to the hub yet, so the list starts once an administrator connects it.';
      return `Done. Each workday at ${this.config().startPromptAt} I’ll list your open items in Dexterity Sheets, only when there are any. Say “Sheets digest off” to stop.${note}`;
    }
    if (!sheets?.configured()) {
      if (ask.kind === 'who' && !ask.named) return null;
      return 'Dexterity Sheets is not connected to the hub yet. An administrator connects it in Control room → Integrations.';
    }
    try {
      if (ask.kind === 'assigned') return assignedAnswer(await sheets.assigned(me.account), this.today(), { digestOn: this.sheetsDigestOn(me.id) });
      if (ask.kind === 'mentions') return mentionsAnswer(await sheets.mentions(me.account, new Date(this.now() - 7 * DAY_MS)), 'in the last 7 days');
      const books = await sheets.books();
      const book = matchBook(books, ask.book);
      if (!book) return ask.named ? `I couldn’t find a workbook called “${ask.book}” on the Sheets server.` : null;
      const names = book.online.map((acct) => this.d.store.userByAccount(acct.toLowerCase())?.displayName ?? acct);
      return whoAnswer(book, safeWorkbookLink(book.link), [...new Set(names)]);
    } catch (err) {
      if (err instanceof SheetsError) return `I couldn’t ask Dexterity Sheets: ${err.message}`;
      throw err;
    }
  }

  /** The morning list, for people who asked for it: their open Sheets items, once a workday. */
  private sheetsRunning = false;
  private sheetsTick(now: number, date: string, cfg: NibConfig): void {
    const sheets = this.d.sheets;
    if (this.sheetsRunning || !sheets?.configured() || !this.workday(date, cfg)) return;
    const from = this.at(date, cfg.startPromptAt);
    if (now < from || now > from + SHEETS_DIGEST_TRIES_MS) return;
    const due = (this.db.prepare('SELECT user_id FROM nib_sheets WHERE digest = 1 AND (last_digest IS NULL OR last_digest <> ?)').all(date) as Array<{ user_id: string }>)
      .map((r) => this.member(r.user_id)).filter((u): u is PublicUser => !!u && !this.leaveOn(u.id, date));
    if (!due.length) return;
    this.sheetsRunning = true;
    void (async () => {
      for (const u of due) {
        try {
          const items = await sheets.assigned(u.account);
          this.db.prepare('UPDATE nib_sheets SET last_digest = ? WHERE user_id = ?').run(date, u.id);
          if (items.some(isOpenItem)) this.sheetsSay(u.id, assignedAnswer(items, date, { digest: true }));
        } catch (err) {
          // the server did not answer: tried again next minute, for a while
          this.d.log('warn', 'nib sheets morning list', { error: (err as Error).message });
          break;
        }
      }
    })().finally(() => { this.sheetsRunning = false; });
  }

  /** Read a holiday circular and answer with what it says (a card the app draws from nib.card). */
  private readCircular(me: PublicUser, fileId: string): HolidayReadView | null {
    const days = this.d.days;
    if (!days) return null;
    let v: HolidayReadView;
    try { v = days.read(me, fileId); } catch (err) { this.d.log('warn', 'nib could not read the circular', { error: (err as Error).message }); return null; }
    this.postCircular(me, v);
    return v;
  }
  private postCircular(me: PublicUser, v: HolidayReadView): void {
    const fallback = v.state === 'denied' ? 'Office holidays are registered by an administrator.'
      : v.state === 'textless' ? 'That PDF is a scan with no text in it.'
      : v.state === 'notCircular' ? 'That PDF does not read like a holiday circular.'
      : v.state === 'unreadable' ? `I could not read that PDF: ${v.error ?? ''}`
      : `Holiday circular ${v.read?.ref ?? ''} for ${v.read?.year ?? ''}: ${v.plan?.rows.length ?? 0} days read.`.replace(/\s+/g, ' ');
    this.post(me.id, 'holidays', v.id, fallback);
  }

  /** A new member: Nib says hello (with a tour on their first days). */
  welcomeMember(u: PublicUser): void {
    if (u.role === 'bot' || u.role === 'guest') return;
    const pref = this.db.prepare('SELECT hello FROM nib_prefs WHERE user_id = ?').get(u.id) as { hello: number } | undefined;
    if (pref?.hello) return;
    this.db.prepare('INSERT INTO nib_prefs (user_id, hello) VALUES (?, 1) ON CONFLICT(user_id) DO UPDATE SET hello = 1').run(u.id);
    const fresh = this.now() - u.createdAt < 14 * DAY_MS;
    const id = this.post(u.id, fresh ? 'joiner' : 'hello', u.id, fresh ? `Welcome to the office, ${u.displayName.split(' ')[0]}. I'm Nib.` : `I'm Nib. I keep day sheets, leave notes and the odd reminder.`);
    // people who were here before Nib are not shown an unread message for an introduction
    const conv = this.convs.get(u.id);
    if (id && conv && !fresh) { this.db.prepare('UPDATE conv_members SET last_read_id = ? WHERE conv_id = ? AND user_id = ?').run(id, conv, u.id); this.d.messaging.pushConvTo(conv); }
  }

  // ------------------------------------------------------------ the clock ticks
  /** Once a minute: leave starting and ending, asks, the register, the follow-up and the week. */
  tick(at?: number): void {
    const now = at ?? this.now();
    if (at === undefined && now - this.lastTick < 55_000) return;
    this.lastTick = now;
    // nobody has used Nib yet: nothing to ask or send
    if (!this.nibId) return;
    const cfg = this.config();
    const date = localDate(now);
    this.leaveTick(date);
    // asked for by each person, so it runs whether or not the office keeps day sheets
    this.sheetsTick(now, date, cfg);
    if (!cfg.enabled) return;
    if (this.workday(date, cfg)) {
      this.askTick(now, date, cfg);
      if (now >= this.at(date, cfg.digestAt) && !this.snapshot('register', date)) this.sendRegister(date, now, false);
    }
    this.followUpTick(now, date, cfg);
  }

  private leaveTick(date: string): void {
    const start = this.db.prepare('SELECT * FROM nib_leave WHERE cancelled = 0 AND applied = 0 AND from_date <= ? AND to_date >= ?').all(date, date) as unknown as LeaveRow[];
    for (const r of start) this.apply(r);
    const ended = this.db.prepare('SELECT * FROM nib_leave WHERE cancelled = 0 AND applied = 1 AND to_date < ?').all(date) as unknown as LeaveRow[];
    for (const r of ended) this.unapply(r);
  }

  private askTick(now: number, date: string, cfg: NibConfig): void {
    const startAt = this.at(date, cfg.startPromptAt);
    const digestAt = this.at(date, cfg.digestAt);
    if (now < startAt) return;
    const days = this.daysOn(date);
    const prefs = new Map((this.db.prepare('SELECT user_id, wrap_at FROM nib_prefs').all() as Array<{ user_id: string; wrap_at: string | null }>).map((r) => [r.user_id, r.wrap_at] as const));
    const changed: string[] = [];
    const notes = this.busyNotes.get(date) ?? new Map<string, Set<string>>();
    this.busyNotes.set(date, notes);
    for (const k of this.busyNotes.keys()) if (k < addDays(date, -3)) this.busyNotes.delete(k);
    for (const u of this.people()) {
      const day = days.get(u.id) ?? this.dayOf(u.id, date);
      const busy = this.d.busy(u.id);
      const online = this.d.online(u.id);
      // "until this meeting ends": the snooze lifts once they are free
      if (day.snoozeUntil && !busy) {
        const free = this.db.prepare('SELECT snooze_free FROM nib_days WHERE user_id = ? AND date = ?').get(u.id, date) as { snooze_free: number } | undefined;
        if (free?.snooze_free) { day.snoozeUntil = null; this.db.prepare('UPDATE nib_days SET snooze_free = 0, snooze_until = NULL WHERE user_id = ? AND date = ?').run(u.id, date); }
      }
      const wrapAt = this.at(date, this.wrapFor(u.id, prefs.get(u.id) ?? null));
      if (busy && now >= wrapAt && now < digestAt) { const s = notes.get(u.id) ?? new Set(); s.add(busy); notes.set(u.id, s); }
      const r = nudgePolicy({ now, workday: true, exempt: false, onLeave: !!this.leaveOn(u.id, date), day, busy: !!busy, online, startPromptAt: startAt, wrapAt, digestAt, limit: cfg.nudgeLimit });
      if (r.ask) {
        const d2 = this.ensureDay(u.id, date);
        d2.asks.push({ at: now, level: r.ask, kind: r.kind ?? 'wrap' });
        this.saveDay(d2);
        if (r.kind === 'start') {
          // the morning after: yesterday's open sheet is asked about once, on the same card
          const prev = this.prevWorkday(date);
          const pd = prev ? this.dayRow(u.id, prev) : undefined;
          if (prev && pd && pd.state === 'open') { const y = this.dayOf(u.id, prev, pd); if (!y.asks.some((a) => a.kind === 'yesterday')) { y.asks.push({ at: now, level: 2, kind: 'yesterday' }); this.saveDay(y); } }
        }
        if (r.ask === 3) this.post(u.id, 'ask', date, `Your day sheet for today is still open. Thirty seconds, before the register.`);
      }
      const view: NibNudgeView | null = r.kind && r.level ? { kind: r.kind, level: r.level as 1 | 2 | 3, asks: (r.ask ? day.asks.length + 1 : day.asks.length) } : null;
      const before = this.nudges.get(u.id) ?? null;
      if (JSON.stringify(before) !== JSON.stringify(view)) { this.nudges.set(u.id, view); changed.push(u.id); }
    }
    this.pushMe(changed);
  }

  private snapshot(kind: string, ref: string): { data: string | null; sent_at: number } | undefined {
    return this.db.prepare('SELECT data, sent_at FROM nib_snapshots WHERE kind = ? AND ref = ?').get(kind, ref) as { data: string | null; sent_at: number } | undefined;
  }

  /** The register for a date as it stands now. */
  register(date: string, now: number, kind: 'daily' | 'followup' = 'daily', since: number | null = null): NibRegister {
    const depts = new Map(this.d.departments().map((x) => [x.id, x.name] as const));
    const people = this.people().map((u) => ({ id: u.id, name: u.displayName, departmentId: u.profile.departmentId, departmentName: u.profile.departmentId ? depts.get(u.profile.departmentId) ?? null : null }));
    const leave = new Map<string, Pick<NibLeave, 'kind' | 'to' | 'half'>>();
    for (const r of this.db.prepare('SELECT * FROM nib_leave WHERE cancelled = 0 AND from_date <= ? AND to_date >= ?').all(date, date) as unknown as LeaveRow[]) leave.set(r.user_id, { kind: r.kind, to: r.to_date, half: r.half });
    const days = this.daysOn(date);
    const started = new Set<string>();
    if (date === localDate(now)) for (const u of people) if (this.d.work.state(u.id, now).checkedInAt) started.add(u.id);
    const asks = new Map([...days.values()].map((x) => [x.userId, x.asks.filter((a) => a.kind !== 'yesterday').length + (this.dayOf(x.userId, this.nextWorkday(date)).asks.some((a) => a.kind === 'yesterday') ? 1 : 0)] as const));
    const busy = new Map<string, string>();
    for (const [uid, s] of this.busyNotes.get(date) ?? []) busy.set(uid, s.has('room') ? 'room' : s.has('meeting') ? 'meeting' : s.has('dnd') ? 'dnd' : 'busy');
    return buildRegister({ kind, date, now, people, days, items: this.itemsOn(date), leave, started, asks, busy, projects: this.config().projects, since });
  }

  private sendRegister(date: string, now: number, preview: boolean, to?: string): void {
    const cfg = this.config();
    const reg = this.register(date, now);
    const ref = preview ? `${date}.p` : date;
    this.db.prepare('INSERT INTO nib_snapshots (kind, ref, data, sent_at) VALUES (?, ?, ?, ?) ON CONFLICT(kind, ref) DO UPDATE SET data = excluded.data, sent_at = excluded.sent_at').run('register', ref, JSON.stringify(reg), now);
    const h = reg.headline;
    const body = `Register for ${new Date(`${date}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}: ${h.reported} reported, ${h.missing + h.away} not yet, ${h.leave} on leave.`;
    const recipients = to ? [to] : cfg.managers.filter((m) => this.member(m));
    if (preview) this.db.prepare(`DELETE FROM nib_posts WHERE kind = 'register' AND ref = ?`).run(ref);
    for (const m of recipients) this.post(m, 'register', ref, body);
    if (!preview) {
      // lead cards learn which sheets are late from now on
      const givers = [...new Set(this.itemsOn(date).map((x) => x.giverId).filter((g): g is string => !!g))];
      this.changed(date, ['lead'], givers);
      if (this.lastWorkdayOfWeek(date)) this.sendWeek(date, now);
    }
  }

  private lastWorkdayOfWeek(date: string): boolean {
    // weeks run Monday to Sunday; no workday later this week
    const wd = weekdayOf(date);
    const left = wd === 0 ? 0 : 7 - wd;
    for (let i = 1; i <= left; i++) if (this.workday(addDays(date, i))) return false;
    return true;
  }

  private sendWeek(date: string, now: number): void {
    const cfg = this.config();
    const wd = weekdayOf(date);
    const monday = addDays(date, -((wd + 6) % 7));
    const dates: string[] = [];
    for (let i = 0; i < 7; i++) { const x = addDays(monday, i); if (x <= date && this.workday(x)) dates.push(x); }
    const regs = dates.map((x) => { const s = this.snapshot('register', x); return s?.data ? parse<NibRegister | null>(s.data, null) : x === date ? this.register(x, now) : null; });
    const week = buildWeek(dates, regs, new Map(dates.map((x) => [x, this.itemsOn(x)] as const)), cfg.projects);
    this.db.prepare('INSERT OR REPLACE INTO nib_snapshots (kind, ref, data, sent_at) VALUES (?, ?, ?, ?)').run('week', date, JSON.stringify(week), now);
    const reported = week.days.reduce((n, x) => n + x.reported, 0);
    const expected = week.days.reduce((n, x) => n + x.expected, 0);
    for (const m of cfg.managers.filter((x) => this.member(x))) this.post(m, 'week', date, `The week to ${new Date(`${date}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}: ${reported} of ${expected} day sheets.`);
  }

  private followUpTick(now: number, today: string, cfg: NibConfig): void {
    const nextMorning = minutesOf(cfg.followUpAt) < minutesOf(cfg.digestAt);
    const date = nextMorning ? this.prevWorkday(today) : today;
    if (!date || !this.workday(date, cfg)) return;
    const when = nextMorning ? this.at(today, cfg.followUpAt) : this.at(date, cfg.followUpAt);
    if (nextMorning && !this.workday(today, cfg)) return;
    if (now < when) return;
    const reg = this.snapshot('register', date);
    if (!reg || this.snapshot('followup', date)) return;
    const late = this.register(date, now, 'followup', reg.sent_at);
    if (!late.late.length) {
      // nothing came in late: no follow-up (recorded, so it is not looked for again)
      this.db.prepare('INSERT OR IGNORE INTO nib_snapshots (kind, ref, data, sent_at) VALUES (?, ?, NULL, ?)').run('followup', date, now);
      return;
    }
    this.db.prepare('INSERT OR IGNORE INTO nib_snapshots (kind, ref, data, sent_at) VALUES (?, ?, ?, ?)').run('followup', date, JSON.stringify(late), now);
    const body = `Late day sheets for ${new Date(`${date}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}: ${late.late.length} came in after the register; ${late.missing.length} still missing.`;
    for (const m of cfg.managers.filter((x) => this.member(x))) this.post(m, 'followup', date, body);
  }

  // ------------------------------------------------------------ the Control room
  private admin(op: string, me: PublicUser, d: Record<string, unknown>): unknown {
    if (me.role !== 'owner' && me.role !== 'admin') throw new NibError('Only administrators can do that.');
    if (op === 'admin.nib.get') return this.config();
    if (op === 'admin.nib.set') {
      const before = this.config();
      let cfg: NibConfig;
      try { cfg = checkNibConfig({ ...before, ...d }, (id) => !!this.member(id)); } catch (err) { throw new NibError((err as Error).message); }
      this.setConfig(cfg);
      const changed = (Object.keys(cfg) as Array<keyof NibConfig>).filter((k) => JSON.stringify(cfg[k]) !== JSON.stringify(before[k]));
      this.d.audit(me.id, 'nib.config', null, { changed, givers: cfg.givers.length, managers: cfg.managers.length, digestAt: cfg.digestAt, followUpAt: cfg.followUpAt, wrapAt: cfg.wrapAt, startPromptAt: cfg.startPromptAt, nudgeLimit: cfg.nudgeLimit, workdays: cfg.workdays, openSheets: cfg.openSheets, enabled: cfg.enabled });
      this.nudges.clear();
      this.pushMe(this.d.store.activeUsers().filter((u) => u.role !== 'bot' && u.role !== 'guest').map((u) => u.id));
      return cfg;
    }
    if (op === 'admin.nib.preview') {
      this.sendRegister(this.today(), this.now(), true, me.id);
      return { ok: true };
    }
    return undefined;
  }
}
