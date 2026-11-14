// Each person's Desk: saved messages, reminders (for yourself or a colleague, one-off or
// repeating) and messages scheduled to send later. A timer on the hub fires reminders and
// sends scheduled messages, so they work even when the author's PC is switched off.
import type { DatabaseSync } from 'node:sqlite';
import { ulid } from '@dex/core';
import { isSealed } from '@dex/core/e2e';
import type { Ops, PublicUser, Reminder, RepeatRule, SavedMessage, ScheduledMessage } from '@dex/core';
import type { FileStore } from './files.ts';
import { MsgError } from './messaging.ts';
import type { Messaging } from './messaging.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS stars (
  user_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, message_id)
);
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  text TEXT NOT NULL,
  message_id TEXT,
  conv_id TEXT,
  due_at INTEGER NOT NULL,
  repeat TEXT NOT NULL DEFAULT 'none',
  done_at INTEGER,
  fired_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(done_at, due_at);
CREATE INDEX IF NOT EXISTS idx_reminders_user ON reminders(user_id);
CREATE TABLE IF NOT EXISTS scheduled (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  conv_id TEXT NOT NULL,
  parent_id TEXT,
  body TEXT NOT NULL,
  files TEXT NOT NULL DEFAULT '[]',
  send_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled(status, send_at);
`;

interface ReminderRow { id: string; user_id: string; created_by: string; text: string; message_id: string | null; conv_id: string | null; due_at: number; repeat: RepeatRule; done_at: number | null; fired_at: number | null; created_at: number }
interface SchedRow { id: string; user_id: string; conv_id: string; parent_id: string | null; body: string; files: string; send_at: number; created_at: number; status: 'pending' | 'failed'; error: string | null }

const REPEATS: RepeatRule[] = ['none', 'daily', 'weekdays', 'weekly', 'monthly'];
const YEAR = 366 * 24 * 3600 * 1000;
const MAX_OPEN_REMINDERS = 500;
const MAX_SCHEDULED = 200;

/** The next time a repeating reminder is due after `from` (local time on the hub). */
export function nextOccurrence(dueAt: number, rule: RepeatRule, now: number): number | null {
  if (rule === 'none') return null;
  const d = new Date(dueAt);
  const day = d.getDate();
  // step until it is in the future, so a reminder that was missed for days fires once
  for (let i = 0; i < 2000 && d.getTime() <= now; i++) {
    if (rule === 'daily') d.setDate(d.getDate() + 1);
    else if (rule === 'weekly') d.setDate(d.getDate() + 7);
    else if (rule === 'weekdays') { do d.setDate(d.getDate() + 1); while (d.getDay() === 0 || d.getDay() === 6); }
    else if (rule === 'monthly') {
      const m = d.getMonth() + 1;
      d.setDate(1);
      d.setMonth(m);
      const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(day, last));
    }
  }
  return d.getTime();
}

export class Desk {
  private readonly db: DatabaseSync;
  private readonly messaging: Messaging;
  private readonly files: FileStore;
  private readonly deliver: (userIds: string[], name: string, data: (userId: string) => unknown) => void;
  private readonly user: (id: string) => PublicUser | null;

  constructor(db: DatabaseSync, messaging: Messaging, files: FileStore, deliver: Desk['deliver'], user: Desk['user']) {
    this.db = db;
    this.messaging = messaging;
    this.files = files;
    this.deliver = deliver;
    this.user = user;
    db.exec(SCHEMA);
  }

  // ------------------------------------------------------------ views
  private reminderView(r: ReminderRow, viewer: string): Reminder {
    return {
      id: r.id, userId: r.user_id, createdBy: r.created_by, text: r.text, dueAt: r.due_at, repeat: r.repeat,
      done: r.done_at !== null, doneAt: r.done_at, firedAt: r.fired_at, createdAt: r.created_at,
      message: r.message_id ? this.messaging.messageFor(r.message_id, viewer) : null, convId: r.conv_id,
    };
  }

  private schedView(r: SchedRow): ScheduledMessage {
    let ids: string[] = [];
    try { ids = JSON.parse(r.files) as string[]; } catch { /* none */ }
    return {
      id: r.id, convId: r.conv_id, parentId: r.parent_id, body: r.body, sendAt: r.send_at, createdAt: r.created_at,
      status: r.status, error: r.error, files: ids.map((f) => this.files.info(f)).filter((f) => f !== null),
    };
  }

  private reminder(id: unknown): ReminderRow | undefined {
    return typeof id === 'string' ? this.db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as ReminderRow | undefined : undefined;
  }

  private pushReminder(r: ReminderRow, name: 'reminder.updated' | 'reminder.due' = 'reminder.updated'): void {
    const to = [...new Set([r.user_id, r.created_by])];
    if (name === 'reminder.due') {
      this.deliver([r.user_id], 'reminder.due', (uid) => this.reminderView(r, uid));
      this.deliver(to, 'reminder.updated', (uid) => this.reminderView(r, uid));
    } else this.deliver(to, name, (uid) => this.reminderView(r, uid));
  }

  // ------------------------------------------------------------ timer
  /** Fire due reminders and send due scheduled messages. Called every few seconds. */
  tick(now = Date.now()): void {
    const due = this.db.prepare(`SELECT * FROM reminders WHERE done_at IS NULL AND due_at <= ? AND (fired_at IS NULL OR fired_at < due_at) LIMIT 200`).all(now) as unknown as ReminderRow[];
    for (const r of due) {
      const next = nextOccurrence(r.due_at, r.repeat, now);
      this.db.prepare('UPDATE reminders SET fired_at = ? WHERE id = ?').run(now, r.id);
      const fired = { ...r, fired_at: now };
      this.pushReminder(fired, 'reminder.due');
      // a repeating reminder moves on to its next time and stays open
      if (next !== null) {
        this.db.prepare('UPDATE reminders SET due_at = ? WHERE id = ?').run(next, r.id);
        this.pushReminder({ ...fired, due_at: next });
      }
    }
    const sends = this.db.prepare(`SELECT * FROM scheduled WHERE status = 'pending' AND send_at <= ? ORDER BY send_at LIMIT 100`).all(now) as unknown as SchedRow[];
    for (const s of sends) this.sendScheduled(s);
  }

  private sendScheduled(s: SchedRow): string | null {
    const author = this.user(s.user_id);
    try {
      if (!author) throw new MsgError('Your account is no longer active.');
      let files: string[] = [];
      try { files = JSON.parse(s.files) as string[]; } catch { /* none */ }
      const c = this.messaging.memberConv(s.conv_id, author.id);
      const sent = this.messaging.sendAs(author, c, s.body, s.parent_id ?? undefined, files, `sched-${s.id}`, {});
      this.db.prepare('DELETE FROM scheduled WHERE id = ?').run(s.id);
      this.deliver([s.user_id], 'sched.removed', () => ({ id: s.id, sentMessageId: sent.id }));
      return sent.id;
    } catch (err) {
      const error = err instanceof MsgError ? err.message : 'It could not be sent.';
      this.db.prepare(`UPDATE scheduled SET status = 'failed', error = ? WHERE id = ?`).run(error, s.id);
      const row = this.db.prepare('SELECT * FROM scheduled WHERE id = ?').get(s.id) as unknown as SchedRow;
      this.deliver([s.user_id], 'sched.updated', () => this.schedView(row));
      return null;
    }
  }

  // ------------------------------------------------------------ operations
  handle(op: string, me: PublicUser, d: Record<string, unknown>): unknown {
    const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max) : '');
    const time = (v: unknown, label: string): number => {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new MsgError(`Choose a ${label} time.`);
      if (v > Date.now() + 5 * YEAR) throw new MsgError(`That ${label} time is too far away.`);
      return Math.floor(v);
    };

    switch (op) {
      case 'msg.star': {
        const msg = typeof d.messageId === 'string' ? this.messaging.messageFor(d.messageId, me.id) : null;
        if (!msg || msg.deleted) throw new MsgError('Message not found.');
        if (d.on === true) this.db.prepare('INSERT OR IGNORE INTO stars (user_id, message_id, created_at) VALUES (?, ?, ?)').run(me.id, msg.id, Date.now());
        else this.db.prepare('DELETE FROM stars WHERE user_id = ? AND message_id = ?').run(me.id, msg.id);
        this.deliver([me.id], 'star.updated', () => ({ messageId: msg.id, on: d.on === true }));
        return { ok: true } satisfies Ops['msg.star']['res'];
      }

      case 'desk.saved': {
        const rows = this.db.prepare('SELECT message_id, created_at FROM stars WHERE user_id = ? ORDER BY created_at DESC LIMIT 500').all(me.id) as Array<{ message_id: string; created_at: number }>;
        const out: SavedMessage[] = [];
        for (const r of rows) {
          const m = this.messaging.messageFor(r.message_id, me.id);
          if (m && !m.deleted) out.push({ message: m, savedAt: r.created_at });
        }
        return out satisfies Ops['desk.saved']['res'];
      }

      case 'remind.create': {
        if (me.role === 'bot') throw new MsgError('Integrations cannot set reminders.');
        const dueAt = time(d.dueAt, 'reminder');
        const repeat = REPEATS.includes(d.repeat as RepeatRule) ? d.repeat as RepeatRule : 'none';
        const target = typeof d.forUserId === 'string' && d.forUserId !== me.id ? this.user(d.forUserId) : me;
        if (!target || target.role === 'bot') throw new MsgError('That person was not found.');
        if (target.id !== me.id && me.role === 'guest') throw new MsgError('Guests can only set reminders for themselves.');
        let messageId: string | null = null;
        let convId: string | null = null;
        if (typeof d.messageId === 'string') {
          const m = this.messaging.messageFor(d.messageId, me.id);
          if (!m || m.deleted) throw new MsgError('Message not found.');
          if (!this.messaging.isMember(m.convId, target.id)) throw new MsgError(`${target.displayName} cannot see that conversation.`);
          messageId = m.id;
          convId = m.convId;
        }
        const text = str(d.text, 500) || (messageId ? 'About this message' : '');
        if (!text) throw new MsgError('What should the reminder say?');
        const open = (this.db.prepare('SELECT COUNT(*) AS n FROM reminders WHERE user_id = ? AND done_at IS NULL').get(target.id) as { n: number }).n;
        if (open >= MAX_OPEN_REMINDERS) throw new MsgError('There are too many open reminders. Mark some as done first.');
        const id = ulid();
        this.db.prepare(`INSERT INTO reminders (id, user_id, created_by, text, message_id, conv_id, due_at, repeat, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, target.id, me.id, text, messageId, convId, dueAt, repeat, Date.now());
        const row = this.reminder(id)!;
        this.pushReminder(row);
        return this.reminderView(row, me.id);
      }

      case 'remind.list': {
        const all = d.includeDone === true;
        const rows = this.db.prepare(`SELECT * FROM reminders WHERE (user_id = ? OR created_by = ?) ${all ? '' : 'AND done_at IS NULL'} ORDER BY due_at LIMIT 1000`).all(me.id, me.id) as unknown as ReminderRow[];
        return rows.map((r) => this.reminderView(r, me.id)) satisfies Ops['remind.list']['res'];
      }

      case 'remind.update': {
        const r = this.reminder(d.id);
        if (!r || (r.user_id !== me.id && r.created_by !== me.id)) throw new MsgError('Reminder not found.');
        const text = d.text !== undefined ? str(d.text, 500) : r.text;
        if (!text) throw new MsgError('What should the reminder say?');
        const dueAt = d.dueAt !== undefined ? time(d.dueAt, 'reminder') : r.due_at;
        const repeat = d.repeat !== undefined ? (REPEATS.includes(d.repeat as RepeatRule) ? d.repeat as RepeatRule : r.repeat) : r.repeat;
        let doneAt = r.done_at;
        if (d.done === true && doneAt === null) doneAt = Date.now();
        if (d.done === false) doneAt = null;
        // a repeating reminder marked done is finished for good; snoozing re-arms it
        const firedAt = d.dueAt !== undefined ? null : r.fired_at;
        this.db.prepare('UPDATE reminders SET text = ?, due_at = ?, repeat = ?, done_at = ?, fired_at = ? WHERE id = ?').run(text, dueAt, repeat, doneAt, firedAt, r.id);
        const row = this.reminder(r.id)!;
        this.pushReminder(row);
        return this.reminderView(row, me.id);
      }

      case 'remind.delete': {
        const r = this.reminder(d.id);
        if (!r || (r.user_id !== me.id && r.created_by !== me.id)) throw new MsgError('Reminder not found.');
        this.db.prepare('DELETE FROM reminders WHERE id = ?').run(r.id);
        this.deliver([...new Set([r.user_id, r.created_by])], 'reminder.removed', () => ({ id: r.id }));
        return { ok: true } satisfies Ops['remind.delete']['res'];
      }

      case 'sched.create': {
        if (me.role === 'bot') throw new MsgError('Integrations post straight away.');
        const c = this.messaging.memberConv(String(d.convId), me.id);
        const sendAt = time(d.sendAt, 'send');
        if (sendAt < Date.now() + 30_000) throw new MsgError('Choose a time at least a minute from now, or just send it.');
        const body = typeof d.body === 'string' ? d.body.replace(/\r\n/g, '\n').trim() : '';
        const files = Array.isArray(d.files) ? [...new Set(d.files.filter((f): f is string => typeof f === 'string'))] : [];
        if (files.length > 20) throw new MsgError('Attach up to 20 files at a time.');
        for (const f of files) if (!this.files.info(f) || !this.files.canRead(me.id, f)) throw new MsgError('One of the files is no longer available.');
        if (!body && !files.length) throw new MsgError('Write something first.');
        if (body.length > (isSealed(body) ? 96_000 : 8000)) throw new MsgError('Messages can be up to 8000 characters.');
        const open = (this.db.prepare('SELECT COUNT(*) AS n FROM scheduled WHERE user_id = ?').get(me.id) as { n: number }).n;
        if (open >= MAX_SCHEDULED) throw new MsgError('You have too many scheduled messages.');
        let parentId: string | null = null;
        if (typeof d.parentId === 'string') {
          const p = this.messaging.messageFor(d.parentId, me.id);
          if (!p || p.convId !== c.id || p.parentId) throw new MsgError('That message cannot be replied to.');
          parentId = p.id;
        }
        const id = ulid();
        this.db.prepare('INSERT INTO scheduled (id, user_id, conv_id, parent_id, body, files, send_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, me.id, c.id, parentId, body, JSON.stringify(files), sendAt, Date.now());
        const row = this.db.prepare('SELECT * FROM scheduled WHERE id = ?').get(id) as unknown as SchedRow;
        this.deliver([me.id], 'sched.updated', () => this.schedView(row));
        return this.schedView(row);
      }

      case 'sched.list': {
        const rows = this.db.prepare('SELECT * FROM scheduled WHERE user_id = ? ORDER BY send_at').all(me.id) as unknown as SchedRow[];
        return rows.map((r) => this.schedView(r)) satisfies Ops['sched.list']['res'];
      }

      case 'sched.update': {
        const s = typeof d.id === 'string' ? this.db.prepare('SELECT * FROM scheduled WHERE id = ? AND user_id = ?').get(d.id, me.id) as SchedRow | undefined : undefined;
        if (!s) throw new MsgError('That scheduled message was already sent or cancelled.');
        const body = d.body !== undefined ? (typeof d.body === 'string' ? d.body.replace(/\r\n/g, '\n').trim() : '') : s.body;
        if (!body && s.files === '[]') throw new MsgError('Write something first.');
        if (body.length > (isSealed(body) ? 96_000 : 8000)) throw new MsgError('Messages can be up to 8000 characters.');
        const sendAt = d.sendAt !== undefined ? time(d.sendAt, 'send') : s.send_at;
        if (d.sendAt !== undefined && sendAt < Date.now() + 30_000) throw new MsgError('Choose a time at least a minute from now, or send it now.');
        this.db.prepare(`UPDATE scheduled SET body = ?, send_at = ?, status = 'pending', error = NULL WHERE id = ?`).run(body, sendAt, s.id);
        const row = this.db.prepare('SELECT * FROM scheduled WHERE id = ?').get(s.id) as unknown as SchedRow;
        this.deliver([me.id], 'sched.updated', () => this.schedView(row));
        return this.schedView(row);
      }

      case 'sched.cancel': {
        const s = typeof d.id === 'string' ? this.db.prepare('SELECT id FROM scheduled WHERE id = ? AND user_id = ?').get(d.id, me.id) as { id: string } | undefined : undefined;
        if (!s) throw new MsgError('That scheduled message was already sent or cancelled.');
        this.db.prepare('DELETE FROM scheduled WHERE id = ?').run(s.id);
        this.deliver([me.id], 'sched.removed', () => ({ id: s.id, sentMessageId: null }));
        return { ok: true } satisfies Ops['sched.cancel']['res'];
      }

      case 'sched.sendNow': {
        const s = typeof d.id === 'string' ? this.db.prepare('SELECT * FROM scheduled WHERE id = ? AND user_id = ?').get(d.id, me.id) as SchedRow | undefined : undefined;
        if (!s) throw new MsgError('That scheduled message was already sent or cancelled.');
        const sent = this.sendScheduled(s);
        const msg = sent ? this.messaging.messageFor(sent, me.id) : null;
        if (!msg) {
          const row = this.db.prepare('SELECT error FROM scheduled WHERE id = ?').get(s.id) as { error: string | null } | undefined;
          throw new MsgError(row?.error ?? 'It could not be sent.');
        }
        return msg satisfies Ops['sched.sendNow']['res'];
      }
    }
    return undefined;
  }
}
