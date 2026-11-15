// Meeting threads, action points and recaps (docs/MEETINGS.md, "Meeting threads, action points and
// recaps"). A meeting's thread is a conversation; this module keeps what a conversation does not:
// each occurrence (when the meeting was held, its Rooms, its note-taker), the meeting chat saved as
// it is said (who said it, guests by name, from which breakout), the action point register, the
// agenda, and the cards it posts in the thread (an occurrence started, its recap, a cancellation).
// Everything it shows is read back from the thread, so deleted and purged messages never return.
import type { DatabaseSync } from 'node:sqlite';
import { isSealed } from '@dex/core/e2e';
import {
  ACTION_TEXT_MAX, AGENDA_MAX, RESUME_MS, SLOT_EARLY_MS, SLOT_LATE_MS, actionTrigger, apRef, inWorkingHours, isWebGuest, occurrenceNo, ulid,
} from '@dex/core';
import type {
  ActionPoint, ActionSource, ActionStatus, AgendaItem, Conversation, MeetCard, MeetLine, MeetOccurrence, MeetRecap, Message, MeetingKind,
  PublicUser, RecapDecision, RecapFile, RecapLine, RecapNote, RecapPerson, RecapPoll, RecordingInfo, RoomChatLine, RoomInfo,
} from '@dex/core';
import { expand } from './calendar.ts';
import { sumIntervals } from './meet-reports.ts';
import type { Meeting } from './meetings.ts';
import { MsgError } from './messaging.ts';
import type { Messaging, MsgRow } from './messaging.ts';

export class ThreadError extends Error {}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meet_threads (
  conv_id TEXT PRIMARY KEY, event_id TEXT, meeting_id TEXT, own INTEGER NOT NULL DEFAULT 0,
  cancelled INTEGER NOT NULL DEFAULT 0, next_ap INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meet_threads_event ON meet_threads(event_id);
CREATE TABLE IF NOT EXISTS meet_occurrences (
  id TEXT PRIMARY KEY, conv_id TEXT NOT NULL, meeting_id TEXT, event_id TEXT, title TEXT NOT NULL, kind TEXT NOT NULL,
  host_id TEXT NOT NULL, slot_start INTEGER, slot_end INTEGER, started_at INTEGER NOT NULL, ended_at INTEGER,
  last_at INTEGER NOT NULL, state TEXT NOT NULL, seq INTEGER NOT NULL, note_taker TEXT, start_msg TEXT, recap_msg TEXT
);
CREATE INDEX IF NOT EXISTS idx_meet_occ_conv ON meet_occurrences(conv_id, started_at);
CREATE INDEX IF NOT EXISTS idx_meet_occ_state ON meet_occurrences(state);
CREATE INDEX IF NOT EXISTS idx_meet_occ_event ON meet_occurrences(event_id, slot_start);
CREATE TABLE IF NOT EXISTS meet_occ_rooms (room_id TEXT PRIMARY KEY, occ_id TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_meet_occ_rooms_occ ON meet_occ_rooms(occ_id);
CREATE TABLE IF NOT EXISTS meet_lines (
  message_id TEXT PRIMARY KEY, occ_id TEXT, conv_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL,
  guest INTEGER NOT NULL, breakout TEXT, file_id TEXT, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meet_lines_occ ON meet_lines(occ_id, at);
CREATE TABLE IF NOT EXISTS meet_cards (message_id TEXT PRIMARY KEY, occ_id TEXT, conv_id TEXT NOT NULL, kind TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS action_points (
  id TEXT PRIMARY KEY, conv_id TEXT NOT NULL, occ_id TEXT, n INTEGER NOT NULL, message_id TEXT NOT NULL UNIQUE,
  text TEXT NOT NULL, sealed INTEGER NOT NULL DEFAULT 0, owner_id TEXT, owner_name TEXT, due TEXT,
  status TEXT NOT NULL DEFAULT 'open', created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  done_at INTEGER, done_by TEXT, source TEXT NOT NULL, nib_item TEXT, reminder_id TEXT, reminded_on TEXT
);
CREATE INDEX IF NOT EXISTS idx_ap_conv ON action_points(conv_id, n);
CREATE INDEX IF NOT EXISTS idx_ap_owner ON action_points(owner_id, status);
CREATE TABLE IF NOT EXISTS meet_agenda (
  id TEXT PRIMARY KEY, conv_id TEXT NOT NULL, occ_id TEXT, n INTEGER NOT NULL, text TEXT NOT NULL, minutes INTEGER,
  done_at INTEGER, created_by TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meet_agenda ON meet_agenda(conv_id, occ_id, n);
`;

interface OccRow {
  id: string; conv_id: string; meeting_id: string | null; event_id: string | null; title: string; kind: MeetingKind; host_id: string;
  slot_start: number | null; slot_end: number | null; started_at: number; ended_at: number | null; last_at: number; state: MeetOccurrence['state'];
  seq: number; note_taker: string | null; start_msg: string | null; recap_msg: string | null;
}
interface ApRow {
  id: string; conv_id: string; occ_id: string | null; n: number; message_id: string; text: string; sealed: number; owner_id: string | null; owner_name: string | null;
  due: string | null; status: ActionStatus; created_by: string; created_at: number; updated_at: number; done_at: number | null; done_by: string | null;
  source: ActionSource; nib_item: string | null; reminder_id: string | null; reminded_on: string | null;
}
interface EventRow { id: string; title: string; organizer_id: string; conv_id: string | null; online: number; cancelled: number; start_at: number; end_at: number; recurrence: 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly'; until_at: number | null; all_day: number }

/** What the module needs from the rest of the hub. */
export interface ThreadDeps {
  db: DatabaseSync;
  messaging: Messaging;
  userById(id: string): PublicUser | null;
  activeUsers(): PublicUser[];
  deliver(userIds: string[], name: string, data: (uid: string) => unknown): void;
  /** The account that posts the thread's cards (the system bot). */
  cardAuthor(): PublicUser | null;
  /** A short Direct message to someone (overdue reminders). */
  tell(userId: string, text: string, key: string): void;
  /** Recordings of these Rooms the viewer may watch. */
  recordings(roomIds: string[], viewer: PublicUser): RecordingInfo[];
  /** A Room of these is running now. */
  roomLive(roomIds: string[]): boolean;
  /** Desk: file the card as a To-do for the owner, and a reminder on the due date. */
  desk: {
    todo(owner: PublicUser, messageId: string, on: boolean): void;
    remind(by: PublicUser, owner: PublicUser, messageId: string, text: string, dueAt: number): string | null;
    reminderDone(id: string, done: boolean, dueAt?: number): void;
    reminderGone(id: string): void;
  };
  /** Nib: the item on the owner's day sheet (null when they keep none). */
  nib: {
    add(owner: PublicUser, a: { activity: string; giverId: string | null; due: string | null; messageId: string }): string | null;
    status(itemId: string, status: 'going' | 'done'): void;
    gone(itemId: string): void;
    away(uid: string, date: string): boolean;
    hours(): { workdays: number[]; start: string; end: string };
  };
  audit(actor: string | null, action: string, target: string | null, meta?: Record<string, unknown>): void;
  log(level: 'info' | 'warn', msg: string, extra?: Record<string, unknown>): void;
  now?(): number;
}

const line = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T12:00:00`).getTime());
const localDate = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const CHAT_PAGE = 200;
const FILES_MAX = 200;
const LOG_LINES = 200;

export class MeetThreads {
  private readonly d: ThreadDeps;
  private readonly db: DatabaseSync;

  constructor(d: ThreadDeps) {
    this.d = d;
    this.db = d.db;
    this.db.exec(SCHEMA);
    const m = d.messaging;
    // what a message in a thread carries: its card, its action point, or that it was said in the meeting chat
    m.viewExtras.push((r) => this.extras(r));
    m.purgeExtras.push((id) => this.forget(id));
  }

  /** Milliseconds added to real time (tests move the clock this way). */
  private offset = 0;
  now(): number { return (this.d.now?.() ?? Date.now()) + this.offset; }
  /** Tests only: set the clock to a moment, or back to real time with null. */
  setClock(at: number | null): void { this.offset = at === null ? 0 : at - (this.d.now?.() ?? Date.now()); }
  private today(): string { return localDate(this.now()); }

  // ------------------------------------------------------------ threads
  private thread(convId: string): { conv_id: string; event_id: string | null; meeting_id: string | null; own: number; cancelled: number; next_ap: number } | undefined {
    return this.db.prepare('SELECT * FROM meet_threads WHERE conv_id = ?').get(convId) as never;
  }

  private ensureThreadRow(convId: string, fields: { eventId?: string | null; meetingId?: string | null; own?: boolean } = {}): void {
    this.db.prepare(`INSERT INTO meet_threads (conv_id, event_id, meeting_id, own, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(conv_id) DO UPDATE SET event_id = COALESCE(meet_threads.event_id, excluded.event_id), meeting_id = COALESCE(meet_threads.meeting_id, excluded.meeting_id), own = MAX(meet_threads.own, excluded.own)`)
      .run(convId, fields.eventId ?? null, fields.meetingId ?? null, fields.own ? 1 : 0, this.now());
  }

  /** Is this conversation a meeting's own thread (made for it), rather than a conversation it was held in? */
  isOwn(convId: string): boolean { return !!this.thread(convId)?.own; }

  private event(id: string | null | undefined): EventRow | undefined {
    return id ? this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRow | undefined : undefined;
  }

  private attendees(eventId: string): string[] {
    return (this.db.prepare('SELECT user_id FROM event_attendees WHERE event_id = ? ORDER BY rowid').all(eventId) as Array<{ user_id: string }>).map((r) => r.user_id);
  }

  private freeName(want: string): string {
    const taken = (n: string) => !!this.d.messaging.spaceByName(n);
    if (!taken(want)) return want;
    for (let i = 2; i < 50; i++) { const alt = `${want.slice(0, 54)} (${i})`; if (!taken(alt)) return alt; }
    return `${want.slice(0, 40)} ${ulid().slice(-6)}`;
  }

  /**
   * A Calendar meeting's thread: its conversation, or a private Space made for it (with the
   * organiser and everyone invited). Null for an event that needs none (just the organiser, not a call).
   */
  ensureEventThread(eventId: string, force = false): string | null {
    const ev = this.event(eventId);
    if (!ev) return null;
    if (ev.conv_id) { this.ensureThreadRow(ev.conv_id, { eventId: ev.id }); return ev.conv_id; }
    const invited = this.attendees(ev.id).filter((u) => u !== ev.organizer_id && this.active(u));
    if (!force && !invited.length && !ev.online) return null;
    const organiser = this.d.userById(ev.organizer_id);
    if (!organiser) return null;
    const name = this.freeName(`${ev.title.slice(0, 50)} · meeting`);
    const conv = this.d.messaging.handle('conv.create', organiser, { kind: 'space', name, topic: `Meeting thread: ${ev.title}`.slice(0, 200), private: true, members: invited }) as Conversation;
    this.db.prepare('UPDATE events SET conv_id = ? WHERE id = ? AND conv_id IS NULL').run(conv.id, ev.id);
    this.db.prepare('UPDATE meetings SET conv_id = ? WHERE event_id = ? AND conv_id IS NULL').run(conv.id, ev.id);
    this.ensureThreadRow(conv.id, { eventId: ev.id, own: true });
    this.d.audit(organiser.id, 'meeting.threadCreated', ev.id, { convId: conv.id });
    return conv.id;
  }

  private active(uid: string): boolean { const u = this.d.userById(uid); return !!u && u.role !== 'bot'; }

  /**
   * A Calendar meeting was saved: its thread follows the invitations. New invitees join it; someone
   * taken off before attending any occurrence leaves it (after attending, they keep it).
   */
  eventSaved(eventId: string, before: string[] = []): void {
    const convId = this.ensureEventThread(eventId);
    const ev = this.event(eventId);
    if (!convId || !ev || !this.isOwn(convId)) return;
    const now = new Set([ev.organizer_id, ...this.attendees(ev.id)]);
    for (const u of now) if (this.active(u) && !this.d.messaging.isMember(convId, u)) this.d.messaging.ensureMember(convId, u);
    const organiser = this.d.userById(ev.organizer_id);
    for (const u of before) {
      if (now.has(u) || !organiser || !this.d.messaging.isMember(convId, u) || this.attendedThread(convId, u)) continue;
      try { this.d.messaging.handle('conv.removeMember', organiser, { convId, userId: u }); } catch { /* they may have left already */ }
    }
  }

  /** The meeting was cancelled: the thread stays, with a card that says so. */
  eventCancelled(eventId: string): void {
    const ev = this.event(eventId);
    if (!ev?.conv_id) return;
    this.ensureThreadRow(ev.conv_id, { eventId: ev.id });
    this.db.prepare('UPDATE meet_threads SET cancelled = 1 WHERE conv_id = ?').run(ev.conv_id);
    this.postCard(ev.conv_id, null, 'cancelled', `Cancelled: ${ev.title}`, `cancel-${ev.id}`);
  }

  /** Was this person in any occurrence held in this thread? */
  private attendedThread(convId: string, userId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM meeting_attendance a JOIN meet_occ_rooms r ON r.room_id = a.room_id JOIN meet_occurrences o ON o.id = r.occ_id
      WHERE o.conv_id = ? AND a.user_id = ? LIMIT 1`).get(convId, userId);
  }

  private attendedOcc(occId: string, userId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM meeting_attendance a JOIN meet_occ_rooms r ON r.room_id = a.room_id WHERE r.occ_id = ? AND a.user_id = ? LIMIT 1').get(occId, userId);
  }

  // ------------------------------------------------------------ occurrences
  private occ(id: unknown): OccRow | undefined {
    return typeof id === 'string' ? this.db.prepare('SELECT * FROM meet_occurrences WHERE id = ?').get(id) as OccRow | undefined : undefined;
  }

  private roomIds(occId: string): string[] {
    return (this.db.prepare('SELECT room_id FROM meet_occ_rooms WHERE occ_id = ?').all(occId) as Array<{ room_id: string }>).map((r) => r.room_id);
  }

  /** The occurrence a Room (its main Room) belongs to. */
  occurrenceOf(roomId: string): string | null {
    return (this.db.prepare('SELECT occ_id FROM meet_occ_rooms WHERE room_id = ?').get(roomId) as { occ_id: string } | undefined)?.occ_id ?? null;
  }

  private view(o: OccRow): MeetOccurrence {
    return {
      id: o.id, meetingId: o.meeting_id, convId: o.conv_id, eventId: o.event_id, title: o.title, kind: o.kind, hostId: o.host_id,
      slotStart: o.slot_start, slotEnd: o.slot_end, startedAt: o.started_at, endedAt: o.ended_at, state: o.state, seq: o.seq,
      noteTakerId: o.note_taker, sealed: this.d.messaging.convKind(o.conv_id) === 'direct',
    };
  }

  /** The Calendar slot running at `t` (from an hour before to an hour after). */
  private slotOf(ev: EventRow, t: number): { startAt: number; endAt: number } | null {
    if (ev.cancelled || ev.all_day) return null;
    const list = expand(ev, t - SLOT_LATE_MS - 14 * 86400_000 < 0 ? 0 : t - SLOT_LATE_MS, t + SLOT_EARLY_MS + 1, 20)
      .filter((o) => o.startAt - SLOT_EARLY_MS <= t && t <= o.endAt + SLOT_LATE_MS);
    if (!list.length) return null;
    return list.sort((a, b) => Math.abs(a.startAt - t) - Math.abs(b.startAt - t))[0];
  }

  /** The event a Room of this meeting is held for at `t`: its own, or one set in its conversation with a slot now. */
  private eventFor(m: Meeting | null, convId: string, t: number): { ev: EventRow; slot: { startAt: number; endAt: number } | null } | null {
    const own = this.event(m?.eventId);
    if (own) return { ev: own, slot: this.slotOf(own, t) };
    const rows = this.db.prepare('SELECT * FROM events WHERE conv_id = ? AND cancelled = 0 AND start_at < ?').all(convId, t + SLOT_EARLY_MS + 1) as unknown as EventRow[];
    for (const ev of rows) { const slot = this.slotOf(ev, t); if (slot) return { ev, slot }; }
    return null;
  }

  /**
   * A meeting's Room opened. It continues the occurrence still open for this thread (the hub
   * restarted, everyone dropped and came back within 15 minutes, the same Calendar slot), or
   * starts a new one, with a divider card in the thread.
   */
  roomOpened(room: RoomInfo, m: Meeting | null): MeetOccurrence | null {
    if (room.purpose || room.parentId || m?.kind === 'webinar') return null;
    const t = this.now();
    const convId = room.convId;
    const found = this.eventFor(m, convId, t);
    const slot = found?.slot ?? null;
    const resume = this.db.prepare(`SELECT * FROM meet_occurrences WHERE conv_id = ? AND (state = 'live' OR (state = 'ended' AND ended_at > ?)
      OR (? IS NOT NULL AND event_id = ? AND slot_start = ?)) ORDER BY started_at DESC LIMIT 1`)
      .get(convId, t - RESUME_MS, slot?.startAt ?? null, found?.ev.id ?? null, slot?.startAt ?? null) as OccRow | undefined;
    if (resume) {
      this.db.prepare(`UPDATE meet_occurrences SET state = 'live', ended_at = NULL, last_at = ? WHERE id = ?`).run(t, resume.id);
      this.db.prepare('INSERT OR IGNORE INTO meet_occ_rooms (room_id, occ_id) VALUES (?, ?)').run(room.id, resume.id);
      const o = this.occ(resume.id)!;
      this.push(o);
      return this.view(o);
    }
    const kind: MeetingKind = m?.kind ?? 'conversation';
    const title = (found?.ev.title || m?.title || this.convName(convId) || 'Meeting').slice(0, 140);
    const host = m && m.kind !== 'conversation' ? m.hostId : found?.ev.organizer_id ?? room.hostId ?? room.startedBy;
    const seq = ((this.db.prepare('SELECT MAX(seq) AS n FROM meet_occurrences WHERE conv_id = ?').get(convId) as { n: number | null }).n ?? 0) + 1;
    const id = ulid(t);
    this.db.prepare(`INSERT INTO meet_occurrences (id, conv_id, meeting_id, event_id, title, kind, host_id, slot_start, slot_end, started_at, last_at, state, seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', ?)`)
      .run(id, convId, m?.id ?? null, found?.ev.id ?? null, title, kind, host, slot?.startAt ?? null, slot?.endAt ?? null, room.startedAt || t, t, seq);
    this.db.prepare('INSERT OR IGNORE INTO meet_occ_rooms (room_id, occ_id) VALUES (?, ?)').run(room.id, id);
    this.ensureThreadRow(convId, { eventId: found?.ev.id ?? null, meetingId: m?.id ?? null, own: kind === 'instant' || kind === 'personal' });
    // the agenda written beforehand belongs to this occurrence now
    this.db.prepare('UPDATE meet_agenda SET occ_id = ? WHERE conv_id = ? AND occ_id IS NULL').run(id, convId);
    // a plain call in a conversation gets no divider; a meeting does
    if (kind !== 'conversation' || found) {
      const msg = this.postCard(convId, id, 'started', `Meeting started: ${title}`, `occ-start-${id}`);
      if (msg) this.db.prepare('UPDATE meet_occurrences SET start_msg = ? WHERE id = ?').run(msg, id);
    }
    const o = this.occ(id)!;
    this.push(o);
    return this.view(o);
  }

  private convName(convId: string): string | null {
    return (this.db.prepare('SELECT name FROM conversations WHERE id = ?').get(convId) as { name: string | null } | undefined)?.name ?? null;
  }

  /** The Room ended: the occurrence ends with it, and its recap card is posted (or updated). */
  roomEnded(room: RoomInfo): void {
    const occId = this.occurrenceOf(room.id);
    const o = occId ? this.occ(occId) : undefined;
    if (!o || o.state !== 'live') return;
    this.finish(o, this.now());
  }

  private finish(o: OccRow, endedAt: number): void {
    this.db.prepare(`UPDATE meet_occurrences SET state = 'ended', ended_at = ?, last_at = MAX(last_at, ?) WHERE id = ?`).run(endedAt, endedAt, o.id);
    const ended = this.occ(o.id)!;
    const c = this.counts(ended);
    // nothing to gather: someone opened it alone and left
    const worth = c.people >= 2 || c.lines > 0 || c.actions > 0 || c.files > 0;
    if (ended.recap_msg && this.d.messaging.row(ended.recap_msg)) this.d.messaging.pushUpdate(ended.recap_msg);
    else if (worth) {
      const msg = this.postCard(ended.conv_id, ended.id, 'recap', `Recap: ${ended.title}`, `occ-recap-${ended.id}`);
      if (msg) this.db.prepare('UPDATE meet_occurrences SET recap_msg = ? WHERE id = ?').run(msg, ended.id);
    }
    if (ended.start_msg && this.d.messaging.row(ended.start_msg)) this.d.messaging.pushUpdate(ended.start_msg);
    this.push(this.occ(o.id)!);
  }

  private counts(o: OccRow): { people: number; lines: number; actions: number; open: number; done: number; files: number; decisions: number } {
    const rooms = this.roomIds(o.id);
    const people = rooms.length ? (this.db.prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM meeting_attendance WHERE room_id IN (${rooms.map(() => '?').join(',')})`).get(...rooms) as { n: number }).n : 0;
    const lines = (this.db.prepare('SELECT COUNT(*) AS n FROM meet_lines l JOIN messages m ON m.id = l.message_id WHERE l.occ_id = ? AND m.deleted = 0').get(o.id) as { n: number }).n;
    const aps = this.db.prepare(`SELECT a.status, COUNT(*) AS n FROM action_points a JOIN messages m ON m.id = a.message_id WHERE a.occ_id = ? AND m.deleted = 0 GROUP BY a.status`).all(o.id) as Array<{ status: string; n: number }>;
    const end = o.ended_at ?? this.now();
    const files = (this.db.prepare(`SELECT COUNT(DISTINCT mf.file_id) AS n FROM message_files mf JOIN messages m ON m.id = mf.message_id
      WHERE m.conv_id = ? AND m.created_at BETWEEN ? AND ? AND m.deleted = 0`).get(o.conv_id, o.started_at, end) as { n: number }).n;
    const decisions = (this.db.prepare(`SELECT COUNT(*) AS n FROM decisions d JOIN messages m ON m.id = d.message_id WHERE m.conv_id = ? AND m.created_at BETWEEN ? AND ? AND m.deleted = 0`).get(o.conv_id, o.started_at, end) as { n: number }).n;
    const n = (s: string) => aps.find((a) => a.status === s)?.n ?? 0;
    return { people, lines, actions: n('open') + n('done'), open: n('open'), done: n('done'), files, decisions };
  }

  /** Once a minute: occurrences nobody came back to (the hub restarted, the last Room is gone) close; overdue reminders. */
  tick(at?: number): void {
    const now = at ?? this.now();
    const live = this.db.prepare(`SELECT * FROM meet_occurrences WHERE state = 'live'`).all() as unknown as OccRow[];
    for (const o of live) {
      const rooms = this.roomIds(o.id);
      if (this.d.roomLive(rooms)) continue;
      const last = rooms.length ? (this.db.prepare(`SELECT MAX(COALESCE(left_at, joined_at)) AS t FROM meeting_attendance WHERE room_id IN (${rooms.map(() => '?').join(',')})`).get(...rooms) as { t: number | null }).t : null;
      const end = Math.max(o.last_at, last ?? 0, o.started_at);
      if (now - end >= RESUME_MS) this.finish(o, end);
    }
    this.remindOverdue(now);
  }

  setNoteTaker(roomId: string, userId: string | null): MeetOccurrence | null {
    const occId = this.occurrenceOf(roomId);
    if (!occId) return null;
    this.db.prepare('UPDATE meet_occurrences SET note_taker = ? WHERE id = ?').run(userId, occId);
    const o = this.occ(occId)!;
    this.push(o);
    return this.view(o);
  }

  noteTakerOf(roomId: string): string | null {
    const occId = this.occurrenceOf(roomId);
    return occId ? this.occ(occId)?.note_taker ?? null : null;
  }

  private push(o: OccRow): void {
    const v = this.view(o);
    this.d.deliver(this.d.messaging.members(o.conv_id), 'meet.occurrence', () => v);
  }

  // ------------------------------------------------------------ cards
  private postCard(convId: string, occId: string | null, kind: MeetCard['kind'], body: string, key: string): string | null {
    const bot = this.d.cardAuthor();
    if (!bot) return null;
    try {
      const msg = this.d.messaging.sendAs(bot, this.d.messaging.memberConv(convId, this.d.messaging.members(convId)[0] ?? bot.id), body.slice(0, 300), undefined, [], `meetcard-${key}`, {});
      this.db.prepare('INSERT OR IGNORE INTO meet_cards (message_id, occ_id, conv_id, kind) VALUES (?, ?, ?, ?)').run(msg.id, occId, convId, kind);
      this.d.messaging.pushUpdate(msg.id);
      return msg.id;
    } catch (err) { this.d.log('warn', 'meeting card not posted', { error: (err as Error).message }); return null; }
  }

  private cardView(messageId: string): MeetCard | null {
    const c = this.db.prepare('SELECT * FROM meet_cards WHERE message_id = ?').get(messageId) as { occ_id: string | null; conv_id: string; kind: MeetCard['kind'] } | undefined;
    if (!c) return null;
    const o = c.occ_id ? this.occ(c.occ_id) : undefined;
    if (!o) {
      const t = this.thread(c.conv_id);
      const ev = this.event(t?.event_id);
      return { kind: c.kind, occurrenceId: null, title: ev?.title ?? 'Meeting', no: '', startedAt: ev?.start_at ?? 0, endedAt: null };
    }
    const base: MeetCard = { kind: c.kind, occurrenceId: o.id, title: o.title, no: occurrenceNo({ meetingId: o.meeting_id, seq: o.seq, id: o.id }), startedAt: o.started_at, endedAt: o.ended_at };
    if (c.kind !== 'recap') return base;
    const n = this.counts(o);
    return { ...base, people: n.people, files: n.files, actionsOpen: n.open, actionsDone: n.done, decisions: n.decisions, minutes: Math.round(((o.ended_at ?? this.now()) - o.started_at) / 60_000) };
  }

  // ------------------------------------------------------------ the meeting chat, saved as it is said
  /**
   * A line said in the meeting chat: saved in the thread now (not at the end), so a hub restart or
   * a dropped Room loses nothing. Returns the saved message's id; throws a MsgError when the
   * office's data-loss rules block it. Guests are named, and two guests of the same name in one
   * occurrence are told apart with (2).
   */
  said(room: RoomInfo, me: PublicUser, text: string, opts: { breakout?: string | null; fileId?: string | null } = {}): { messageId: string | null; name: string; text: string } {
    const occId = this.occurrenceOf(room.id);
    const o = occId ? this.occ(occId) : undefined;
    const guest = isWebGuest(me.id);
    let name = me.displayName.slice(0, 80) || (guest ? 'Guest' : 'Someone');
    if (guest && o) name = this.guestName(o.id, me.id, name);
    if (!o) return { messageId: null, name, text };
    const row = this.d.messaging.postMeetLine(me, o.conv_id, text, opts.fileId ? [opts.fileId] : [], this.now());
    this.db.prepare('INSERT OR IGNORE INTO meet_lines (message_id, occ_id, conv_id, user_id, name, guest, breakout, file_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, o.id, o.conv_id, me.id, name, guest ? 1 : 0, opts.breakout ?? null, opts.fileId ?? null, row.created_at);
    this.db.prepare('UPDATE meet_occurrences SET last_at = ? WHERE id = ?').run(row.created_at, o.id);
    this.d.messaging.pushUpdate(row.id);
    return { messageId: row.id, name, text: row.body };
  }

  /** "Mr Rao", or "Mr Rao (2)" when another guest of that name already spoke in this occurrence. */
  private guestName(occId: string, guestId: string, want: string): string {
    const mine = this.db.prepare('SELECT name FROM meet_lines WHERE occ_id = ? AND user_id = ? LIMIT 1').get(occId, guestId) as { name: string } | undefined;
    if (mine) return mine.name;
    const others = new Set((this.db.prepare('SELECT DISTINCT name FROM meet_lines WHERE occ_id = ? AND guest = 1 AND user_id != ?').all(occId, guestId) as Array<{ name: string }>).map((r) => r.name.toLowerCase()));
    if (!others.has(want.toLowerCase())) return want;
    for (let i = 2; i < 100; i++) { const n = `${want} (${i})`; if (!others.has(n.toLowerCase())) return n; }
    return want;
  }

  /** The meeting chat of the occurrence a Room belongs to, from the thread (after a restart too). */
  chatLog(room: RoomInfo): RoomChatLine[] | null {
    const occId = this.occurrenceOf(room.id);
    if (!occId) return null;
    const rows = this.db.prepare(`SELECT l.*, m.body, m.deleted FROM meet_lines l JOIN messages m ON m.id = l.message_id WHERE l.occ_id = ? AND m.deleted = 0 ORDER BY l.at DESC LIMIT ?`)
      .all(occId, LOG_LINES) as Array<{ message_id: string; user_id: string; name: string; guest: number; breakout: string | null; file_id: string | null; at: number; body: string }>;
    return rows.reverse().map((r) => {
      const f = r.file_id ? this.db.prepare('SELECT id, name, size FROM files WHERE id = ?').get(r.file_id) as { id: string; name: string; size: number } | undefined : undefined;
      return { id: r.message_id, messageId: r.message_id, roomId: room.id, userId: r.user_id, name: r.name, text: isSealed(r.body) ? '' : r.body, at: r.at, guest: !!r.guest, breakout: r.breakout, file: f ?? null };
    });
  }

  // ------------------------------------------------------------ what messages carry
  private extras(r: MsgRow): Partial<Message> {
    const out: Partial<Message> = {};
    const l = this.db.prepare('SELECT occ_id, name, guest, breakout FROM meet_lines WHERE message_id = ?').get(r.id) as { occ_id: string | null; name: string; guest: number; breakout: string | null } | undefined;
    if (l) out.meetLine = { name: l.name, guest: !!l.guest, breakout: l.breakout, occurrenceId: l.occ_id } satisfies MeetLine;
    const ap = this.db.prepare('SELECT * FROM action_points WHERE message_id = ?').get(r.id) as ApRow | undefined;
    if (ap) out.actionPoint = this.apView(ap, r);
    const card = this.cardView(r.id);
    if (card) out.meetCard = card;
    return out;
  }

  /** A message removed for good (retention): its chat record, card and action point go with it. */
  private forget(messageId: string): void {
    const ap = this.db.prepare('SELECT * FROM action_points WHERE message_id = ?').get(messageId) as ApRow | undefined;
    if (ap) {
      if (ap.reminder_id) this.d.desk.reminderGone(ap.reminder_id);
      if (ap.nib_item) this.d.nib.gone(ap.nib_item);
      this.db.prepare('DELETE FROM action_points WHERE id = ?').run(ap.id);
    }
    this.db.prepare('DELETE FROM meet_lines WHERE message_id = ?').run(messageId);
    this.db.prepare('DELETE FROM meet_cards WHERE message_id = ?').run(messageId);
    this.db.prepare('UPDATE meet_occurrences SET recap_msg = NULL WHERE recap_msg = ?').run(messageId);
    this.db.prepare('UPDATE meet_occurrences SET start_msg = NULL WHERE start_msg = ?').run(messageId);
  }

  /** A message was deleted: an action point on it leaves the register (its Desk reminder and day-sheet item too). */
  messageDeleted(messageId: string): void {
    const ap = this.db.prepare('SELECT * FROM action_points WHERE message_id = ?').get(messageId) as ApRow | undefined;
    if (!ap || ap.status === 'dropped') return;
    this.db.prepare(`UPDATE action_points SET status = 'dropped', updated_at = ? WHERE id = ?`).run(this.now(), ap.id);
    if (ap.reminder_id) this.d.desk.reminderGone(ap.reminder_id);
    if (ap.nib_item) this.d.nib.gone(ap.nib_item);
  }

  // ------------------------------------------------------------ action points
  private apRow(id: unknown): ApRow | undefined {
    return typeof id === 'string' ? this.db.prepare('SELECT * FROM action_points WHERE id = ?').get(id) as ApRow | undefined : undefined;
  }

  private apView(a: ApRow, msg?: MsgRow | null, carried = false): ActionPoint {
    const m = msg ?? this.d.messaging.row(a.message_id) ?? null;
    // the card's message is the task: an edit to it is an edit to the action point
    const sealed = !!a.sealed || (!!m && isSealed(m.body));
    const body = m && !sealed ? (actionTrigger(m.body) ?? m.body) : '';
    // the words given when it was logged, unless its message was edited since (an edit to the card is an edit to the point)
    const edited = !!m?.edited_at && m.edited_at > a.created_at;
    const text = sealed ? '' : (edited ? body.trim() || a.text : a.text).slice(0, ACTION_TEXT_MAX);
    return {
      id: a.id, convId: a.conv_id, occurrenceId: a.occ_id, n: a.n, text, sealed, ownerId: a.owner_id, ownerName: a.owner_name, due: a.due,
      status: m?.deleted ? 'dropped' : a.status, createdBy: a.created_by, createdAt: a.created_at, updatedAt: a.updated_at, doneAt: a.done_at, doneBy: a.done_by,
      messageId: a.message_id, source: a.source, ...(carried ? { carried: true } : {}),
    };
  }

  /** The person who runs this thread's meetings (the organiser), for permissions and day sheets. */
  private organiserOf(convId: string, occId: string | null): string | null {
    const o = occId ? this.occ(occId) : undefined;
    if (o) return o.host_id;
    const t = this.thread(convId);
    const ev = this.event(t?.event_id);
    if (ev) return ev.organizer_id;
    const last = this.db.prepare('SELECT host_id FROM meet_occurrences WHERE conv_id = ? ORDER BY started_at DESC LIMIT 1').get(convId) as { host_id: string } | undefined;
    return last?.host_id ?? null;
  }

  private mayChange(a: ApRow, me: PublicUser): boolean {
    return a.created_by === me.id || a.owner_id === me.id || this.organiserOf(a.conv_id, a.occ_id) === me.id || me.role === 'owner' || me.role === 'admin';
  }

  /** The occurrence an action point logged now belongs to: the one running, else the one that just ended (within two hours). */
  private currentOcc(convId: string): OccRow | undefined {
    return this.db.prepare(`SELECT * FROM meet_occurrences WHERE conv_id = ? AND (state = 'live' OR ended_at > ?) ORDER BY started_at DESC LIMIT 1`).get(convId, this.now() - 2 * 3600_000) as OccRow | undefined;
  }

  private ownerIn(d: Record<string, unknown>, convId: string, me: PublicUser, prev?: ApRow): { ownerId: string | null; ownerName: string | null } {
    if (d.ownerId === undefined && d.ownerName === undefined) return { ownerId: prev?.owner_id ?? null, ownerName: prev?.owner_name ?? null };
    if (typeof d.ownerId === 'string' && d.ownerId) {
      const u = this.d.userById(d.ownerId);
      if (!u || u.role === 'bot') throw new ThreadError('That person was not found.');
      if (!this.d.messaging.isMember(convId, u.id)) {
        // the organiser of the meeting's own thread brings the owner in; elsewhere they must be added first
        if (this.isOwn(convId) && this.organiserOf(convId, prev?.occ_id ?? this.currentOcc(convId)?.id ?? null) === me.id) this.d.messaging.ensureMember(convId, u.id);
        else throw new ThreadError(`${u.displayName} is not in this conversation. Add them first, or ask the organiser.`);
      }
      return { ownerId: u.id, ownerName: null };
    }
    const name = line(d.ownerName, 60);
    return { ownerId: null, ownerName: name || null };
  }

  private dueIn(v: unknown, prev: string | null): string | null {
    if (v === undefined) return prev;
    if (v === null || v === '') return null;
    if (!isDate(v)) throw new ThreadError('Choose a date for it.');
    return v;
  }

  /** When a Desk reminder for a due date fires: the start of that working day. */
  private dueAt(due: string): number {
    const { start } = this.d.nib.hours();
    const [y, m, dd] = due.split('-').map(Number);
    const [h, mi] = start.split(':').map(Number);
    return new Date(y, m - 1, dd, h || 10, mi || 0).getTime();
  }

  createAction(me: PublicUser, d: Record<string, unknown>): ActionPoint {
    if (me.role === 'bot' || me.role === 'guest') throw new ThreadError('Only members of the office log action points.');
    const msg = typeof d.messageId === 'string' ? this.d.messaging.messageFor(d.messageId, me.id) : null;
    if (!msg || msg.deleted) throw new ThreadError('Message not found.');
    if (!this.d.messaging.isMember(msg.convId, me.id)) throw new ThreadError('Message not found.');
    if (msg.meetCard) throw new ThreadError('A meeting card cannot be an action point.');
    const had = this.db.prepare('SELECT * FROM action_points WHERE message_id = ?').get(msg.id) as ApRow | undefined;
    if (had) return this.apView(had);
    const row = this.d.messaging.row(msg.id)!;
    const sealed = isSealed(row.body);
    const source: ActionSource = (['chat', 'strip', 'promote', 'register'] as const).includes(d.source as ActionSource) ? d.source as ActionSource : 'chat';
    const text = sealed ? '' : (line(d.text, ACTION_TEXT_MAX) || line(actionTrigger(row.body) ?? row.body, ACTION_TEXT_MAX) || (msg.files[0]?.name ?? ''));
    if (!sealed && !text) throw new ThreadError('Say what needs doing.');
    const owner = this.ownerIn(d, msg.convId, me);
    const due = this.dueIn(d.due, null);
    const occ = this.currentOcc(msg.convId);
    this.ensureThreadRow(msg.convId);
    const n = (this.db.prepare('SELECT next_ap FROM meet_threads WHERE conv_id = ?').get(msg.convId) as { next_ap: number }).next_ap;
    this.db.prepare('UPDATE meet_threads SET next_ap = next_ap + 1 WHERE conv_id = ?').run(msg.convId);
    const id = ulid();
    const now = this.now();
    this.db.prepare(`INSERT INTO action_points (id, conv_id, occ_id, n, message_id, text, sealed, owner_id, owner_name, due, status, created_by, created_at, updated_at, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`)
      .run(id, msg.convId, occ?.id ?? null, n, msg.id, text, sealed ? 1 : 0, owner.ownerId, owner.ownerName, due, me.id, now, now, source);
    const a = this.apRow(id)!;
    this.assign(a, me);
    this.d.audit(me.id, 'meeting.actionLogged', msg.convId, { ref: apRef(n), owner: owner.ownerId ?? owner.ownerName, due });
    this.changed(a.id);
    return this.apView(this.apRow(id)!);
  }

  /** The owner hears once, and the point lands on their Desk and their day sheet (a guest owner gets neither). */
  private assign(a: ApRow, by: PublicUser): void {
    if (!a.owner_id) return;
    const owner = this.d.userById(a.owner_id);
    if (!owner) return;
    const view = this.apView(a);
    const label = view.text || `${apRef(a.n)} (encrypted: open it to read)`;
    const title = this.occ(a.occ_id)?.title ?? this.convName(a.conv_id) ?? 'the meeting';
    try { this.d.desk.todo(owner, a.message_id, true); } catch (err) { this.d.log('info', 'action point not filed on the Desk', { error: (err as Error).message }); }
    const reminder = a.due ? this.d.desk.remind(by, owner, a.message_id, `${apRef(a.n)} · ${label}`.slice(0, 500), this.dueAt(a.due)) : null;
    const giver = this.organiserOf(a.conv_id, a.occ_id);
    const nib = owner.role !== 'guest' ? this.d.nib.add(owner, { activity: `${apRef(a.n)} ${label}`.slice(0, 160), giverId: giver && giver !== owner.id ? giver : by.id !== owner.id ? by.id : null, due: a.due, messageId: a.message_id }) : null;
    this.db.prepare('UPDATE action_points SET reminder_id = ?, nib_item = ? WHERE id = ?').run(reminder, nib, a.id);
    if (owner.id !== by.id) this.d.deliver([owner.id], 'ap.assigned', () => ({ action: view, by: by.id, title }));
  }

  /** Undo what assign did for the previous owner (the point went to someone else). */
  private unassign(a: ApRow): void {
    if (a.reminder_id) this.d.desk.reminderGone(a.reminder_id);
    if (a.nib_item) this.d.nib.gone(a.nib_item);
    const owner = a.owner_id ? this.d.userById(a.owner_id) : null;
    if (owner) { try { this.d.desk.todo(owner, a.message_id, false); } catch { /* not on their Desk */ } }
    this.db.prepare('UPDATE action_points SET reminder_id = NULL, nib_item = NULL WHERE id = ?').run(a.id);
  }

  updateAction(me: PublicUser, d: Record<string, unknown>): ActionPoint {
    const a = this.apRow(d.id);
    if (!a || !this.d.messaging.isMember(a.conv_id, me.id)) throw new ThreadError('Action point not found.');
    if (!this.mayChange(a, me)) throw new ThreadError('Only its owner, whoever logged it and the organiser can change it.');
    const msg = this.d.messaging.row(a.message_id);
    if (!msg || msg.deleted) throw new ThreadError('That action point was removed with its message.');
    const status: ActionStatus = d.status === undefined ? a.status : (['open', 'done', 'dropped'] as const).includes(d.status as ActionStatus) ? d.status as ActionStatus : a.status;
    const owner = this.ownerIn(d, a.conv_id, me, a);
    const due = this.dueIn(d.due, a.due);
    const text = d.text !== undefined && !a.sealed ? line(d.text, ACTION_TEXT_MAX) || a.text : a.text;
    const now = this.now();
    const ownerChanged = owner.ownerId !== a.owner_id || owner.ownerName !== a.owner_name;
    if (ownerChanged) this.unassign(a);
    this.db.prepare(`UPDATE action_points SET text = ?, owner_id = ?, owner_name = ?, due = ?, status = ?, updated_at = ?, done_at = ?, done_by = ?,
      reminded_on = CASE WHEN ? != COALESCE(due, '') THEN NULL ELSE reminded_on END WHERE id = ?`)
      .run(text, owner.ownerId, owner.ownerName, due, status, now, status === 'done' ? (a.done_at ?? now) : null, status === 'done' ? (a.done_by ?? me.id) : null, due ?? '', a.id);
    const next = this.apRow(a.id)!;
    if (ownerChanged) this.assign(next, me);
    else {
      if (next.reminder_id) this.d.desk.reminderDone(next.reminder_id, status !== 'open', due !== a.due && due ? this.dueAt(due) : undefined);
      else if (due && !a.due && status === 'open' && next.owner_id) {
        const o = this.d.userById(next.owner_id);
        if (o) this.db.prepare('UPDATE action_points SET reminder_id = ? WHERE id = ?').run(this.d.desk.remind(me, o, next.message_id, `${apRef(next.n)} · ${this.apView(next).text}`.slice(0, 500), this.dueAt(due)), next.id);
      }
      if (next.nib_item && status !== a.status) { if (status === 'dropped') this.d.nib.gone(next.nib_item); else this.d.nib.status(next.nib_item, status === 'done' ? 'done' : 'going'); }
    }
    if (status !== a.status) this.d.audit(me.id, 'meeting.actionStatus', a.conv_id, { ref: apRef(a.n), status });
    this.changed(a.id);
    return this.apView(this.apRow(a.id)!);
  }

  /** Ticked done on the day sheet: the register follows. */
  nibChanged(itemId: string, status: 'going' | 'done' | 'blocked', by: string): void {
    const a = this.db.prepare('SELECT * FROM action_points WHERE nib_item = ?').get(itemId) as ApRow | undefined;
    const u = this.d.userById(by);
    if (!a || !u || status === 'blocked') return;
    const want: ActionStatus = status === 'done' ? 'done' : 'open';
    if (a.status === want || a.status === 'dropped') return;
    const now = this.now();
    this.db.prepare('UPDATE action_points SET status = ?, updated_at = ?, done_at = ?, done_by = ? WHERE id = ?').run(want, now, want === 'done' ? now : null, want === 'done' ? by : null, a.id);
    if (a.reminder_id) this.d.desk.reminderDone(a.reminder_id, want === 'done');
    this.changed(a.id);
  }

  private changed(apId: string): void {
    const a = this.apRow(apId);
    if (!a) return;
    this.d.messaging.pushUpdate(a.message_id);
    const view = this.apView(a);
    this.d.deliver(this.d.messaging.members(a.conv_id), 'ap.updated', () => view);
    const o = a.occ_id ? this.occ(a.occ_id) : undefined;
    if (o?.recap_msg && this.d.messaging.row(o.recap_msg)) this.d.messaging.pushUpdate(o.recap_msg);
  }

  /**
   * A thread's register: for an occurrence, its own points and, first, the open ones brought
   * forward from before it; for the thread, all of them; or my own open points across threads.
   */
  listActions(me: PublicUser, d: Record<string, unknown>): { actions: ActionPoint[]; next: number } {
    if (d.mine === true) {
      const rows = this.db.prepare(`SELECT a.* FROM action_points a JOIN messages m ON m.id = a.message_id WHERE a.owner_id = ? AND a.status = 'open' AND m.deleted = 0 ORDER BY COALESCE(a.due, '9999'), a.created_at LIMIT 300`).all(me.id) as unknown as ApRow[];
      return { actions: rows.filter((r) => this.d.messaging.isMember(r.conv_id, me.id)).map((r) => this.apView(r)), next: 0 };
    }
    let convId = typeof d.convId === 'string' ? d.convId : '';
    const o = typeof d.occurrenceId === 'string' ? this.occ(d.occurrenceId) : undefined;
    if (o) convId = o.conv_id;
    if (!convId || !(this.d.messaging.isMember(convId, me.id) || (o && this.attendedOcc(o.id, me.id)))) throw new ThreadError('Conversation not found.');
    const next = (this.thread(convId)?.next_ap ?? 1);
    const live = o ?? this.currentOcc(convId);
    const all = this.db.prepare(`SELECT a.* FROM action_points a JOIN messages m ON m.id = a.message_id WHERE a.conv_id = ? AND m.deleted = 0 AND a.status != 'dropped' ORDER BY a.n`).all(convId) as unknown as ApRow[];
    if (!live) return { actions: all.map((r) => this.apView(r)), next };
    const before = all.filter((r) => r.occ_id !== live.id && r.created_at < live.started_at && (r.status === 'open' || (r.done_at ?? 0) >= live.started_at));
    const mine = all.filter((r) => r.occ_id === live.id);
    return { actions: [...before.map((r) => this.apView(r, null, true)), ...mine.map((r) => this.apView(r))], next };
  }

  /** Once a working day, in working hours, each owner gets one message listing their overdue points. */
  private remindOverdue(now: number): void {
    const h = this.d.nib.hours();
    if (!inWorkingHours(now, h.workdays, h.start, h.end)) return;
    const today = localDate(now);
    const rows = this.db.prepare(`SELECT a.* FROM action_points a JOIN messages m ON m.id = a.message_id WHERE a.status = 'open' AND a.owner_id IS NOT NULL
      AND a.due IS NOT NULL AND a.due < ? AND m.deleted = 0 AND (a.reminded_on IS NULL OR a.reminded_on < ?) ORDER BY a.due LIMIT 2000`).all(today, today) as unknown as ApRow[];
    const by = new Map<string, ApRow[]>();
    for (const r of rows) (by.get(r.owner_id!) ?? by.set(r.owner_id!, []).get(r.owner_id!)!).push(r);
    for (const [uid, list] of by) {
      const u = this.d.userById(uid);
      if (!u || u.role === 'bot' || this.d.nib.away(uid, today) || !list.some((r) => this.d.messaging.isMember(r.conv_id, uid))) continue;
      const items = list.filter((r) => this.d.messaging.isMember(r.conv_id, uid)).slice(0, 20);
      const lines = items.map((r) => {
        const v = this.apView(r);
        const where = this.occ(r.occ_id)?.title ?? this.convName(r.conv_id) ?? 'a meeting';
        return `• ${apRef(r.n)} ${v.text || '(encrypted)'} · ${where} · due ${r.due}`;
      });
      const head = items.length === 1 ? 'One action point is past its date:' : `${items.length} action points are past their date:`;
      this.d.tell(uid, `${head}\n${lines.join('\n')}\nTick them done on your Desk or in the meeting's thread, or move the date.`, `ap-overdue-${uid}-${today}`);
      const mark = this.db.prepare('UPDATE action_points SET reminded_on = ? WHERE id = ?');
      for (const r of list) mark.run(today, r.id);
    }
  }

  // ------------------------------------------------------------ the agenda
  private agendaFor(convId: string): { occId: string | null; items: AgendaItem[] } {
    const live = this.db.prepare(`SELECT id FROM meet_occurrences WHERE conv_id = ? AND state = 'live' ORDER BY started_at DESC LIMIT 1`).get(convId) as { id: string } | undefined;
    const occId = live?.id ?? null;
    const rows = this.db.prepare(`SELECT * FROM meet_agenda WHERE conv_id = ? AND occ_id IS ? ORDER BY n`).all(convId, occId) as Array<{ id: string; n: number; text: string; minutes: number | null; done_at: number | null }>;
    return { occId, items: rows.map((r) => ({ id: r.id, n: r.n, text: r.text, minutes: r.minutes, doneAt: r.done_at })) };
  }

  agenda(me: PublicUser, op: string, d: Record<string, unknown>): { occurrenceId: string | null; items: AgendaItem[] } {
    const convId = typeof d.convId === 'string' ? d.convId : '';
    if (!convId || !this.d.messaging.isMember(convId, me.id)) throw new ThreadError('Conversation not found.');
    if (me.role === 'guest' && op !== 'agenda.get') throw new ThreadError('Guests cannot change the agenda.');
    const cur = this.agendaFor(convId);
    if (op === 'agenda.set') {
      const list = Array.isArray(d.items) ? d.items.slice(0, AGENDA_MAX + 1) as Array<Record<string, unknown>> : [];
      if (list.length > AGENDA_MAX) throw new ThreadError(`An agenda holds up to ${AGENDA_MAX} items.`);
      const keep = new Map(cur.items.map((i) => [i.id, i]));
      this.db.exec('BEGIN');
      try {
        this.db.prepare('DELETE FROM meet_agenda WHERE conv_id = ? AND occ_id IS ?').run(convId, cur.occId);
        let n = 0;
        for (const it of list) {
          const text = line(it.text, 140);
          if (!text) continue;
          const minutes = typeof it.minutes === 'number' && Number.isFinite(it.minutes) ? Math.max(1, Math.min(480, Math.round(it.minutes))) : null;
          const was = typeof it.id === 'string' ? keep.get(it.id) : undefined;
          this.db.prepare('INSERT INTO meet_agenda (id, conv_id, occ_id, n, text, minutes, done_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(was?.id ?? ulid(), convId, cur.occId, ++n, text, minutes, was?.doneAt ?? null, me.id, this.now());
        }
        this.db.exec('COMMIT');
      } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    } else if (op === 'agenda.tick') {
      const id = typeof d.id === 'string' ? d.id : '';
      if (!this.db.prepare('UPDATE meet_agenda SET done_at = ? WHERE id = ? AND conv_id = ?').run(d.done === true ? this.now() : null, id, convId).changes) throw new ThreadError('That agenda item is gone.');
    }
    const out = this.agendaFor(convId);
    const res = { occurrenceId: out.occId, items: out.items };
    if (op !== 'agenda.get') this.d.deliver(this.d.messaging.members(convId), 'agenda.updated', () => ({ convId, ...res }));
    return res;
  }

  // ------------------------------------------------------------ reading: the thread and the recap
  threadInfo(me: PublicUser, d: Record<string, unknown>, meetingOf: (id: string) => Meeting | null): { convId: string; occurrences: MeetOccurrence[]; live: MeetOccurrence | null; next: { slotStart: number; slotEnd: number } | null } {
    let convId = '';
    let ev: EventRow | undefined;
    if (typeof d.eventId === 'string') {
      ev = this.event(d.eventId);
      const sees = ev && (ev.organizer_id === me.id || this.attendees(ev.id).includes(me.id) || (!!ev.conv_id && this.d.messaging.isMember(ev.conv_id, me.id)));
      if (!ev || !sees) throw new ThreadError('Meeting not found.');
      convId = this.ensureEventThread(ev.id, true) ?? '';
      ev = this.event(ev.id);
    } else if (typeof d.meetingId === 'string') {
      const m = meetingOf(d.meetingId);
      if (!m?.convId) throw new ThreadError('Meeting not found.');
      convId = m.convId;
    } else if (typeof d.convId === 'string') convId = d.convId;
    if (!convId || !this.d.messaging.isMember(convId, me.id)) throw new ThreadError('Conversation not found.');
    const rows = this.db.prepare('SELECT * FROM meet_occurrences WHERE conv_id = ? ORDER BY started_at DESC LIMIT 100').all(convId) as unknown as OccRow[];
    const occurrences = rows.map((r) => this.view(r));
    const t = this.now();
    let next: { slotStart: number; slotEnd: number } | null = null;
    if (ev && !ev.cancelled) { const o = expand(ev, t, t + 120 * 86400_000, 1)[0]; if (o) next = { slotStart: o.startAt, slotEnd: o.endAt }; }
    return { convId, occurrences, live: occurrences.find((o) => o.state === 'live') ?? null, next };
  }

  recapFor(me: PublicUser, eventId: unknown, slotStart: unknown): { occurrenceId: string | null } {
    if (typeof eventId !== 'string' || typeof slotStart !== 'number') return { occurrenceId: null };
    const r = this.db.prepare(`SELECT * FROM meet_occurrences WHERE event_id = ? AND (slot_start = ? OR (slot_start IS NULL AND started_at BETWEEN ? AND ?)) ORDER BY started_at DESC LIMIT 1`)
      .get(eventId, slotStart, slotStart - SLOT_EARLY_MS, slotStart + 12 * 3600_000) as OccRow | undefined;
    if (!r || !this.mayRead(r, me)) return { occurrenceId: null };
    return { occurrenceId: r.id };
  }

  private mayRead(o: OccRow, me: PublicUser): boolean {
    return this.d.messaging.isMember(o.conv_id, me.id) || this.attendedOcc(o.id, me.id) || o.host_id === me.id;
  }

  recap(me: PublicUser, occurrenceId: unknown): MeetRecap {
    const o = this.occ(occurrenceId);
    if (!o || !this.mayRead(o, me)) throw new ThreadError('No recap for that meeting.');
    const member = this.d.messaging.isMember(o.conv_id, me.id);
    const end = o.ended_at ?? this.now();
    const rooms = this.roomIds(o.id);
    // attendance: every Room of the occurrence, two devices counted once, rejoins summed
    const segs = rooms.length ? this.db.prepare(`SELECT user_id, name, guest, joined_at, left_at FROM meeting_attendance WHERE room_id IN (${rooms.map(() => '?').join(',')}) ORDER BY joined_at`).all(...rooms) as Array<{ user_id: string; name: string; guest: number; joined_at: number; left_at: number | null }> : [];
    const byUser = new Map<string, typeof segs>();
    for (const s of segs) (byUser.get(s.user_id) ?? byUser.set(s.user_id, []).get(s.user_id)!).push(s);
    const guestNames = new Map((this.db.prepare('SELECT user_id, name FROM meet_lines WHERE occ_id = ? AND guest = 1').all(o.id) as Array<{ user_id: string; name: string }>).map((r) => [r.user_id, r.name]));
    const attendance: RecapPerson[] = [...byUser.entries()].map(([userId, list]) => {
      const spans = list.map((s): [number, number] => [s.joined_at, s.left_at ?? end]);
      const { total, spans: joins } = sumIntervals(spans);
      return { userId, name: guestNames.get(userId) ?? this.d.userById(userId)?.displayName ?? list[list.length - 1].name, guest: !!list[0].guest, firstJoin: Math.min(...spans.map((x) => x[0])), lastLeave: Math.max(...spans.map((x) => x[1])), totalMs: total, joins };
    }).sort((a, b) => a.firstJoin - b.firstJoin);
    const came = new Set(attendance.map((p) => p.userId));
    const invited = o.event_id ? this.attendees(o.event_id) : this.isOwn(o.conv_id) ? this.d.messaging.members(o.conv_id) : [];
    const absent = invited.filter((u) => !came.has(u) && this.active(u));
    // what was shared while it ran; someone who is not in the thread sees only the meeting chat's part
    const inWindow = member
      ? this.db.prepare(`SELECT id FROM messages WHERE conv_id = ? AND created_at BETWEEN ? AND ? AND deleted = 0 AND parent_id IS NULL`).all(o.conv_id, o.started_at, end) as Array<{ id: string }>
      : this.db.prepare(`SELECT l.message_id AS id FROM meet_lines l JOIN messages m ON m.id = l.message_id WHERE l.occ_id = ? AND m.deleted = 0`).all(o.id) as Array<{ id: string }>;
    const ids = new Set(inWindow.map((r) => r.id));
    const files: RecapFile[] = [];
    let filesMore = 0;
    const fileRows = this.db.prepare(`SELECT mf.message_id, mf.file_id, m.author_id, m.created_at FROM message_files mf JOIN messages m ON m.id = mf.message_id
      WHERE m.conv_id = ? AND m.created_at BETWEEN ? AND ? AND m.deleted = 0 ORDER BY m.created_at`).all(o.conv_id, o.started_at, end) as Array<{ message_id: string; file_id: string; author_id: string; created_at: number }>;
    for (const f of fileRows) {
      if (!ids.has(f.message_id)) continue;
      const info = this.d.messaging.filesOf(f.message_id).find((x) => x.id === f.file_id) ?? null;
      if (!info) continue;
      if (files.length >= FILES_MAX) { filesMore++; continue; }
      files.push({ file: info, messageId: f.message_id, authorId: f.author_id, authorName: this.nameOf(f.author_id, o.id), at: f.created_at });
    }
    const polls: RecapPoll[] = member ? (this.db.prepare(`SELECT p.message_id, p.question, p.options FROM polls p JOIN messages m ON m.id = p.message_id WHERE m.conv_id = ? AND m.created_at BETWEEN ? AND ? AND m.deleted = 0 ORDER BY m.created_at`)
      .all(o.conv_id, o.started_at, end) as Array<{ message_id: string; question: string; options: string }>).map((p) => {
      let texts: string[] = [];
      try { const v = JSON.parse(p.options) as unknown; if (Array.isArray(v)) texts = v.map(String); } catch { /* none */ }
      const votes = this.db.prepare('SELECT option, COUNT(*) AS n FROM poll_votes WHERE message_id = ? GROUP BY option').all(p.message_id) as Array<{ option: number; n: number }>;
      const voters = (this.db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM poll_votes WHERE message_id = ?').get(p.message_id) as { n: number }).n;
      return { messageId: p.message_id, question: p.question, options: texts.map((text, i) => ({ text, votes: votes.find((v) => v.option === i)?.n ?? 0 })), voters };
    }) : [];
    const decisions: RecapDecision[] = member ? (this.db.prepare(`SELECT d.message_id, d.tree, m.author_id, m.created_at FROM decisions d JOIN messages m ON m.id = d.message_id WHERE m.conv_id = ? AND m.created_at BETWEEN ? AND ? AND m.deleted = 0 ORDER BY m.created_at`)
      .all(o.conv_id, o.started_at, end) as Array<{ message_id: string; tree: string; author_id: string; created_at: number }>).map((x) => {
      let question = 'Decision';
      try { question = String((JSON.parse(x.tree) as { prompt?: string }).prompt ?? question); } catch { /* keep */ }
      const outs = this.db.prepare('SELECT outcome, COUNT(*) AS n FROM decision_paths WHERE message_id = ? AND done = 1 GROUP BY outcome ORDER BY n DESC').all(x.message_id) as Array<{ outcome: string | null; n: number }>;
      return { messageId: x.message_id, question, authorId: x.author_id, at: x.created_at, reached: outs.reduce((s, r) => s + r.n, 0), outcomes: outs.map((r) => ({ label: r.outcome ?? '—', count: r.n })) };
    }) : [];
    const notes: RecapNote[] = member ? [
      ...(this.db.prepare('SELECT id, title, updated_at FROM notes WHERE conv_id = ? AND updated_at BETWEEN ? AND ? ORDER BY updated_at').all(o.conv_id, o.started_at, end + 30 * 60_000) as Array<{ id: string; title: string; updated_at: number }>).map((n) => ({ kind: 'note' as const, id: n.id, title: n.title, updatedAt: n.updated_at })),
      ...(this.db.prepare('SELECT id, title, updated_at FROM boards WHERE conv_id = ? AND updated_at BETWEEN ? AND ? ORDER BY updated_at').all(o.conv_id, o.started_at, end + 30 * 60_000) as Array<{ id: string; title: string; updated_at: number }>).map((n) => ({ kind: 'board' as const, id: n.id, title: n.title, updatedAt: n.updated_at })),
    ] : [];
    const agenda = (this.db.prepare('SELECT * FROM meet_agenda WHERE occ_id = ? ORDER BY n').all(o.id) as Array<{ id: string; n: number; text: string; minutes: number | null; done_at: number | null }>).map((r) => ({ id: r.id, n: r.n, text: r.text, minutes: r.minutes, doneAt: r.done_at }));
    const actions = this.listActions(me, { occurrenceId: o.id }).actions;
    const page = this.chatPage(o, me, member, '', '');
    const total = member
      ? (this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conv_id = ? AND created_at BETWEEN ? AND ? AND deleted = 0 AND parent_id IS NULL AND id NOT IN (SELECT message_id FROM meet_cards)').get(o.conv_id, o.started_at, end) as { n: number }).n
      : ids.size;
    return {
      occurrence: this.view(o), viewer: { member, organiser: o.host_id === me.id },
      attendance, absent, recordings: rooms.length ? this.d.recordings(rooms, me) : [], actions, decisions, files, filesMore, polls, notes, agenda,
      chat: { lines: page.lines, total, next: page.next, from: o.started_at, to: end, sealed: this.d.messaging.convKind(o.conv_id) === 'direct' },
    };
  }

  /** A file said in the meeting chat opens for those who attended that occurrence, even outside the thread. */
  mayReadFile(userId: string, fileId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM meet_lines l JOIN meet_occ_rooms r ON r.occ_id = l.occ_id JOIN meeting_attendance a ON a.room_id = r.room_id
      WHERE l.file_id = ? AND a.user_id = ? LIMIT 1`).get(fileId, userId);
  }

  private nameOf(userId: string, occId: string): string {
    const g = this.db.prepare('SELECT name FROM meet_lines WHERE user_id = ? AND occ_id = ? LIMIT 1').get(userId, occId) as { name: string } | undefined;
    return g?.name ?? this.d.userById(userId)?.displayName ?? 'Someone';
  }

  recapChat(me: PublicUser, d: Record<string, unknown>): { lines: RecapLine[]; next: string | null } {
    const o = this.occ(d.occurrenceId);
    if (!o || !this.mayRead(o, me)) throw new ThreadError('No recap for that meeting.');
    return this.chatPage(o, me, this.d.messaging.isMember(o.conv_id, me.id), typeof d.after === 'string' ? d.after : '', line(d.q, 80));
  }

  /** A page of the chat said while the occurrence ran (sealed lines are read on the PC). */
  private chatPage(o: OccRow, me: PublicUser, member: boolean, after: string, q: string): { lines: RecapLine[]; next: string | null } {
    const end = o.ended_at ?? this.now();
    const like = q ? `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
    const rows = (member
      ? this.db.prepare(`SELECT m.*, l.name AS l_name, l.guest AS l_guest, l.breakout AS l_breakout FROM messages m LEFT JOIN meet_lines l ON l.message_id = m.id
          WHERE m.conv_id = ? AND m.created_at BETWEEN ? AND ? AND m.deleted = 0 AND m.parent_id IS NULL AND m.id > ? AND m.id NOT IN (SELECT message_id FROM meet_cards)
          ${like ? "AND (m.body LIKE ? ESCAPE '\\' OR l.name LIKE ? ESCAPE '\\')" : ''} ORDER BY m.id LIMIT ?`)
        .all(...[o.conv_id, o.started_at, end, after, ...(like ? [like, like] : []), CHAT_PAGE + 1])
      : this.db.prepare(`SELECT m.*, l.name AS l_name, l.guest AS l_guest, l.breakout AS l_breakout FROM meet_lines l JOIN messages m ON m.id = l.message_id
          WHERE l.occ_id = ? AND m.deleted = 0 AND m.id > ? ${like ? "AND (m.body LIKE ? ESCAPE '\\' OR l.name LIKE ? ESCAPE '\\')" : ''} ORDER BY m.id LIMIT ?`)
        .all(...[o.id, after, ...(like ? [like, like] : []), CHAT_PAGE + 1])) as unknown as Array<MsgRow & { l_name: string | null; l_guest: number | null; l_breakout: string | null }>;
    const more = rows.length > CHAT_PAGE;
    const page = rows.slice(0, CHAT_PAGE);
    const lines: RecapLine[] = page.map((r) => {
      const files = (this.db.prepare('SELECT f.name FROM message_files mf JOIN files f ON f.id = mf.file_id WHERE mf.message_id = ?').all(r.id) as Array<{ name: string }>).map((f) => f.name);
      const sealed = isSealed(r.body);
      return {
        messageId: r.id, authorId: r.author_id, name: r.l_name ?? this.d.userById(r.author_id)?.displayName ?? 'Someone', guest: !!r.l_guest,
        text: sealed ? '' : r.body, at: r.created_at, everyone: r.l_name !== null, breakout: r.l_breakout, files: sealed ? [] : files,
      };
    });
    void me;
    return { lines, next: more ? page[page.length - 1].id : null };
  }
}

export { MsgError };
