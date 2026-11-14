// Calendar and meetings: events with invitees and replies, repeating meetings, reminders,
// bookable conference rooms (no double booking) and free/busy. A meeting can belong to a
// conversation, whose Room is then used for the call.
import type { DatabaseSync } from 'node:sqlite';
import { ulid } from '@dex/core';
import type { CalEvent, Occurrence, Ops, PublicUser, Recurrence, Rsvp, Venue } from '@dex/core';
import type { Messaging } from './messaging.ts';

export class CalError extends Error {}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  location TEXT,
  venue_id TEXT,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  organizer_id TEXT NOT NULL,
  conv_id TEXT,
  online INTEGER NOT NULL DEFAULT 0,
  recurrence TEXT NOT NULL DEFAULT 'none',
  until_at INTEGER,
  reminder_min INTEGER,
  cancelled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_at);
CREATE TABLE IF NOT EXISTS event_attendees (
  event_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  response TEXT NOT NULL DEFAULT 'pending',
  PRIMARY KEY (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_attendees_user ON event_attendees(user_id);
CREATE TABLE IF NOT EXISTS venues (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  capacity INTEGER,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS event_reminders_sent (
  event_id TEXT NOT NULL,
  occurrence_start INTEGER NOT NULL,
  PRIMARY KEY (event_id, occurrence_start)
);
`;

interface EventRow {
  id: string; title: string; description: string | null; location: string | null; venue_id: string | null; start_at: number; end_at: number;
  all_day: number; organizer_id: string; conv_id: string | null; online: number; recurrence: Recurrence; until_at: number | null;
  reminder_min: number | null; cancelled: number; created_at: number; time_zone?: string | null;
}

const RECURRENCES: Recurrence[] = ['none', 'daily', 'weekdays', 'weekly', 'monthly'];
const DAY = 86400_000;
const MAX_ATTENDEES = 200;
/** How far ahead repeating bookings are checked for clashes. */
const CLASH_HORIZON = 366 * DAY;

/** Start times of an event between `from` and `to` (local time on the hub). */
export function expand(ev: Pick<EventRow, 'start_at' | 'end_at' | 'recurrence' | 'until_at'>, from: number, to: number, max = 500): Array<{ startAt: number; endAt: number }> {
  const dur = Math.max(0, ev.end_at - ev.start_at);
  if (ev.recurrence === 'none') return ev.end_at > from && ev.start_at < to ? [{ startAt: ev.start_at, endAt: ev.end_at }] : [];
  const out: Array<{ startAt: number; endAt: number }> = [];
  const d = new Date(ev.start_at);
  const day = d.getDate();
  const last = ev.until_at ?? Number.POSITIVE_INFINITY;
  // jump close to the window for fast rules, then step
  if ((ev.recurrence === 'daily' || ev.recurrence === 'weekly') && from - dur > ev.start_at + 14 * DAY) {
    const step = ev.recurrence === 'daily' ? 1 : 7;
    const skip = Math.floor((from - dur - ev.start_at) / (step * DAY)) - 2;
    if (skip > 0) d.setDate(d.getDate() + skip * step);
  }
  for (let i = 0, k = 0; i < 20000 && out.length < max; i++) {
    const t = d.getTime();
    if (t >= to || t > last) break;
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    if (!(ev.recurrence === 'weekdays' && weekend) && t + dur > from) out.push({ startAt: t, endAt: t + dur });
    if (ev.recurrence === 'daily' || ev.recurrence === 'weekdays') d.setDate(d.getDate() + 1);
    else if (ev.recurrence === 'weekly') d.setDate(d.getDate() + 7);
    else {
      k++;
      const base = new Date(ev.start_at);
      const target = new Date(base.getFullYear(), base.getMonth() + k, 1, base.getHours(), base.getMinutes());
      const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
      target.setDate(Math.min(day, lastDay));
      d.setTime(target.getTime());
    }
  }
  return out;
}

const overlaps = (a: { startAt: number; endAt: number }, b: { startAt: number; endAt: number }) => a.startAt < b.endAt && b.startAt < a.endAt;

function when(startAt: number, endAt: number, allDay: boolean): string {
  const date = new Date(startAt).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  if (allDay) return `${date}, all day`;
  const t = (x: number) => new Date(x).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
  return `${date}, ${t(startAt)} – ${t(endAt)}`;
}

export class Calendar {
  private readonly db: DatabaseSync;
  private readonly messaging: Messaging;
  private readonly users: () => PublicUser[];
  private readonly deliver: (userIds: string[], name: string, data: (userId: string) => unknown) => void;
  private readonly broadcast: (name: string, data: unknown) => void;

  constructor(db: DatabaseSync, messaging: Messaging, users: Calendar['users'], deliver: Calendar['deliver'], broadcast: Calendar['broadcast']) {
    this.db = db;
    this.messaging = messaging;
    this.users = users;
    this.deliver = deliver;
    this.broadcast = broadcast;
    db.exec(SCHEMA);
    try { db.exec('ALTER TABLE events ADD COLUMN time_zone TEXT'); } catch { /* already there */ }
  }

  // ------------------------------------------------------------ views
  private row(id: unknown): EventRow | undefined {
    return typeof id === 'string' ? this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRow | undefined : undefined;
  }

  private attendees(id: string): Array<{ userId: string; response: Rsvp }> {
    return (this.db.prepare('SELECT user_id, response FROM event_attendees WHERE event_id = ? ORDER BY rowid').all(id) as Array<{ user_id: string; response: Rsvp }>)
      .map((a) => ({ userId: a.user_id, response: a.response }));
  }

  private view(r: EventRow): CalEvent {
    return {
      id: r.id, title: r.title, description: r.description, location: r.location, venueId: r.venue_id, startAt: r.start_at, endAt: r.end_at,
      allDay: !!r.all_day, organizerId: r.organizer_id, convId: r.conv_id, online: !!r.online, recurrence: r.recurrence, until: r.until_at,
      reminderMin: r.reminder_min, attendees: this.attendees(r.id), cancelled: !!r.cancelled, createdAt: r.created_at, timeZone: r.time_zone ?? null,
    };
  }

  /** Everyone who should hear about an event: organiser, attendees and the conversation's members. */
  private audience(r: EventRow): string[] {
    const set = new Set([r.organizer_id, ...this.attendees(r.id).map((a) => a.userId)]);
    if (r.conv_id) for (const m of this.messaging.members(r.conv_id)) set.add(m);
    return [...set];
  }

  private canSee(r: EventRow, userId: string): boolean {
    return r.organizer_id === userId || !!this.db.prepare('SELECT 1 FROM event_attendees WHERE event_id = ? AND user_id = ?').get(r.id, userId)
      || (!!r.conv_id && this.messaging.isMember(r.conv_id, userId));
  }

  venues(): Venue[] {
    return (this.db.prepare('SELECT * FROM venues ORDER BY name COLLATE NOCASE').all() as Array<{ id: string; name: string; capacity: number | null; note: string | null }>)
      .map((v) => ({ id: v.id, name: v.name, capacity: v.capacity, note: v.note }));
  }

  // ------------------------------------------------------------ checks
  private validate(input: Record<string, unknown>, existing: EventRow | undefined, me: PublicUser) {
    const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max) || null : null);
    const pick = <T>(k: string, cur: T, f: (v: unknown) => T): T => (input[k] === undefined ? cur : f(input[k]));
    const title = pick('title', existing?.title ?? null, (v) => text(v, 140));
    if (!title) throw new CalError('Give the meeting a title.');
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : NaN);
    let startAt = pick('startAt', existing?.start_at ?? NaN, num);
    let endAt = pick('endAt', existing?.end_at ?? NaN, num);
    if (Number.isNaN(startAt) || Number.isNaN(endAt)) throw new CalError('Choose when it starts and ends.');
    const allDay = pick('allDay', !!existing?.all_day, (v) => v === true);
    if (allDay) {
      const s = new Date(startAt); s.setHours(0, 0, 0, 0);
      const e = new Date(Math.max(endAt - 1, startAt)); e.setHours(0, 0, 0, 0); e.setDate(e.getDate() + 1);
      startAt = s.getTime(); endAt = e.getTime();
    }
    if (endAt <= startAt) throw new CalError('It has to end after it starts.');
    if (endAt - startAt > 14 * DAY) throw new CalError('A single meeting can last up to two weeks.');
    const recurrence = pick('recurrence', existing?.recurrence ?? 'none', (v) => (RECURRENCES.includes(v as Recurrence) ? v as Recurrence : 'none'));
    const until = recurrence === 'none' ? null : pick('until', existing?.until_at ?? null, (v) => (v === null ? null : num(v)));
    if (until !== null && (Number.isNaN(until) || until < startAt)) throw new CalError('A repeating meeting must end after its first time.');
    const reminderMin = pick('reminderMin', existing?.reminder_min ?? null, (v) => (v === null ? null : Math.max(0, Math.min(10080, num(v)))));
    if (reminderMin !== null && Number.isNaN(reminderMin)) throw new CalError('Choose a valid reminder.');
    const venueId = pick('venueId', existing?.venue_id ?? null, (v) => (typeof v === 'string' ? v : null));
    if (venueId && !this.db.prepare('SELECT 1 FROM venues WHERE id = ?').get(venueId)) throw new CalError('That room no longer exists.');
    const convId = pick('convId', existing?.conv_id ?? null, (v) => (typeof v === 'string' ? v : null));
    if (convId && !this.messaging.isMember(convId, me.id)) throw new CalError('Conversation not found.');
    const known = new Set(this.users().filter((u) => u.role !== 'bot').map((u) => u.id));
    const attendees = input.attendees === undefined ? null
      : [...new Set((Array.isArray(input.attendees) ? input.attendees : []).filter((x): x is string => typeof x === 'string' && known.has(x)))];
    if (attendees && attendees.length > MAX_ATTENDEES) throw new CalError(`Invite up to ${MAX_ATTENDEES} people.`);
    return {
      title, startAt, endAt, allDay, recurrence, until, reminderMin, venueId, convId, attendees,
      description: pick('description', existing?.description ?? null, (v) => text(v, 4000)),
      location: pick('location', existing?.location ?? null, (v) => text(v, 140)),
      online: pick('online', !!existing?.online, (v) => v === true),
      timeZone: pick('timeZone', existing?.time_zone ?? null, (v) => {
        if (v === null || v === '') return null;
        if (typeof v !== 'string' || v.length > 64) throw new CalError('Choose a time zone from the list.');
        try { new Intl.DateTimeFormat('en', { timeZone: v }); } catch { throw new CalError('Choose a time zone from the list.'); }
        return v;
      }),
    };
  }

  /** Refuse a booking that overlaps another meeting in the same room. */
  private checkVenue(venueId: string, ev: Pick<EventRow, 'start_at' | 'end_at' | 'recurrence' | 'until_at'>, exceptId: string | null): void {
    const horizon = ev.start_at + CLASH_HORIZON;
    const mine = expand(ev, ev.start_at, horizon, 400);
    if (!mine.length) return;
    const others = this.db.prepare(`SELECT * FROM events WHERE venue_id = ? AND cancelled = 0 AND id != ? AND start_at < ?`).all(venueId, exceptId ?? '', horizon) as unknown as EventRow[];
    for (const o of others) {
      const theirs = expand(o, mine[0].startAt, mine[mine.length - 1].endAt, 2000);
      for (const a of mine) {
        const hit = theirs.find((b) => overlaps(a, b));
        if (hit) {
          const venue = (this.db.prepare('SELECT name FROM venues WHERE id = ?').get(venueId) as { name: string }).name;
          const who = this.users().find((u) => u.id === o.organizer_id)?.displayName ?? 'someone';
          throw new CalError(`${venue} is already booked by ${who} for ${when(hit.startAt, hit.endAt, !!o.all_day)}.`);
        }
      }
    }
  }

  // ------------------------------------------------------------ reminders
  /** People in a meeting right now: organisers and everyone who said they are going, not all-day events. */
  inMeetingNow(now = Date.now()): Set<string> {
    const out = new Set<string>();
    const rows = this.db.prepare(`SELECT * FROM events WHERE cancelled = 0 AND all_day = 0 AND start_at <= ? AND (recurrence != 'none' AND (until_at IS NULL OR until_at >= ?) OR end_at >= ?)`).all(now, now - DAY, now) as unknown as EventRow[];
    for (const r of rows) {
      if (!expand(r, now - DAY, now + 1, 50).some((o) => o.startAt <= now && o.endAt > now)) continue;
      out.add(r.organizer_id);
      for (const a of this.attendees(r.id)) if (a.response === 'yes') out.add(a.userId);
    }
    return out;
  }

  tick(now = Date.now()): void {
    const rows = this.db.prepare(`SELECT * FROM events WHERE cancelled = 0 AND reminder_min IS NOT NULL AND start_at <= ?
      AND (end_at >= ? OR (recurrence != 'none' AND (until_at IS NULL OR until_at >= ?)))`).all(now + 8 * DAY, now - DAY, now - DAY) as unknown as EventRow[];
    for (const r of rows) {
      const lead = (r.reminder_min ?? 0) * 60_000;
      for (const occ of expand(r, now - 60_000, now + lead + 60_000, 5)) {
        if (occ.startAt - lead > now || occ.startAt < now - 60_000) continue;
        const sent = this.db.prepare('INSERT OR IGNORE INTO event_reminders_sent (event_id, occurrence_start) VALUES (?, ?)').run(r.id, occ.startAt);
        if (!sent.changes) continue;
        const going = new Set([r.organizer_id, ...this.attendees(r.id).filter((a) => a.response !== 'no').map((a) => a.userId)]);
        const ev = this.view(r);
        this.deliver([...going], 'cal.reminder', () => ({ event: ev, startAt: occ.startAt, endAt: occ.endAt } satisfies Occurrence));
      }
    }
  }

  // ------------------------------------------------------------ operations
  handle(op: string, me: PublicUser, d: Record<string, unknown>): unknown {
    const isAdmin = me.role === 'owner' || me.role === 'admin';
    if (op.startsWith('admin.') && !isAdmin) throw new CalError('Only administrators can do that.');

    switch (op) {
      case 'cal.venues':
        return this.venues() satisfies Ops['cal.venues']['res'];

      case 'admin.cal.saveVenue': {
        const name = typeof d.name === 'string' ? d.name.trim().slice(0, 60) : '';
        if (!name) throw new CalError('Give the room a name.');
        const capacity = typeof d.capacity === 'number' && d.capacity > 0 ? Math.min(1000, Math.floor(d.capacity)) : null;
        const note = typeof d.note === 'string' ? d.note.trim().slice(0, 140) || null : null;
        const clash = this.db.prepare('SELECT id FROM venues WHERE name = ? COLLATE NOCASE').get(name) as { id: string } | undefined;
        if (clash && clash.id !== d.id) throw new CalError('A room with that name already exists.');
        let id = typeof d.id === 'string' ? d.id : null;
        if (id) {
          if (!this.db.prepare('UPDATE venues SET name = ?, capacity = ?, note = ? WHERE id = ?').run(name, capacity, note, id).changes) throw new CalError('Room not found.');
        } else {
          id = ulid();
          this.db.prepare('INSERT INTO venues (id, name, capacity, note, created_at) VALUES (?, ?, ?, ?, ?)').run(id, name, capacity, note, Date.now());
        }
        const list = this.venues();
        this.broadcast('cal.venues', list);
        return list.find((v) => v.id === id)!;
      }

      case 'admin.cal.deleteVenue': {
        const id = typeof d.id === 'string' ? d.id : '';
        if (!this.db.prepare('DELETE FROM venues WHERE id = ?').run(id).changes) throw new CalError('Room not found.');
        // meetings keep their time; the room booking is dropped and the name kept as a location
        this.db.prepare('UPDATE events SET location = COALESCE(location, ?), venue_id = NULL WHERE venue_id = ?').run('Room removed', id);
        this.broadcast('cal.venues', this.venues());
        return { ok: true };
      }

      case 'cal.list': {
        const from = typeof d.from === 'number' ? d.from : NaN;
        const to = typeof d.to === 'number' ? d.to : NaN;
        if (Number.isNaN(from) || Number.isNaN(to) || to <= from || to - from > 100 * DAY) throw new CalError('Choose a range of up to 100 days.');
        const rows = this.db.prepare(`SELECT DISTINCT e.* FROM events e LEFT JOIN event_attendees a ON a.event_id = e.id
          LEFT JOIN conv_members cm ON cm.conv_id = e.conv_id AND cm.user_id = ?
          WHERE e.cancelled = 0 AND e.start_at < ? AND (e.end_at > ? OR (e.recurrence != 'none' AND (e.until_at IS NULL OR e.until_at + ? > ?)))
          AND (e.organizer_id = ? OR a.user_id = ? OR cm.user_id IS NOT NULL)`)
          .all(me.id, to, from, DAY, from, me.id, me.id) as unknown as EventRow[];
        const out: Occurrence[] = [];
        for (const r of rows) {
          const ev = this.view(r);
          for (const o of expand(r, from, to, 400)) out.push({ event: ev, ...o });
        }
        return out.sort((a, b) => a.startAt - b.startAt).slice(0, 2000) satisfies Ops['cal.list']['res'];
      }

      case 'cal.get': {
        const r = this.row(d.eventId);
        if (!r || !this.canSee(r, me.id)) throw new CalError('Meeting not found.');
        return this.view(r);
      }

      case 'cal.create': {
        if (me.role === 'guest' || me.role === 'bot') throw new CalError('Only members of the office can create meetings.');
        const v = this.validate(d, undefined, me);
        const id = ulid();
        const row = { start_at: v.startAt, end_at: v.endAt, recurrence: v.recurrence, until_at: v.until };
        if (v.venueId) this.checkVenue(v.venueId, row, null);
        this.db.prepare(`INSERT INTO events (id, title, description, location, venue_id, start_at, end_at, all_day, organizer_id, conv_id, online, recurrence, until_at, reminder_min, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, v.title, v.description, v.location, v.venueId, v.startAt, v.endAt, v.allDay ? 1 : 0, me.id,
          v.convId, v.online ? 1 : 0, v.recurrence, v.until, v.reminderMin, Date.now());
        this.db.prepare('UPDATE events SET time_zone = ? WHERE id = ?').run(v.timeZone, id);
        const ins = this.db.prepare('INSERT OR IGNORE INTO event_attendees (event_id, user_id, response) VALUES (?, ?, ?)');
        ins.run(id, me.id, 'yes');
        for (const u of v.attendees ?? []) ins.run(id, u, 'pending');
        const r = this.row(id)!;
        const ev = this.view(r);
        this.deliver(this.audience(r), 'cal.updated', () => ev);
        this.deliver((v.attendees ?? []).filter((u) => u !== me.id), 'cal.invited', () => ev);
        // a meeting set in a conversation is announced there
        if (v.convId) {
          const venue = v.venueId ? this.venues().find((x) => x.id === v.venueId)?.name : v.location;
          const repeat = v.recurrence === 'none' ? '' : ` · repeats ${v.recurrence === 'weekdays' ? 'every weekday' : v.recurrence}`;
          try {
            this.messaging.sendAs(me, this.messaging.memberConv(v.convId, me.id), `📅 **${v.title}**\n${when(v.startAt, v.endAt, v.allDay)}${repeat}${venue ? ` · ${venue}` : ''}${v.online ? ' · call in Dexterity Connect' : ''}`, undefined, [], `cal-${id}`, {});
          } catch { /* the meeting stands even if the announcement could not be posted */ }
        }
        return ev satisfies Ops['cal.create']['res'];
      }

      case 'cal.update': {
        const r = this.row(d.eventId);
        if (!r || !this.canSee(r, me.id)) throw new CalError('Meeting not found.');
        if (r.organizer_id !== me.id && !isAdmin) throw new CalError('Only the organiser can change this meeting.');
        if (r.cancelled) throw new CalError('This meeting was cancelled.');
        const v = this.validate(d, r, me);
        if (v.venueId) this.checkVenue(v.venueId, { start_at: v.startAt, end_at: v.endAt, recurrence: v.recurrence, until_at: v.until }, r.id);
        const timeChanged = v.startAt !== r.start_at || v.endAt !== r.end_at || v.recurrence !== r.recurrence;
        const before = new Set(this.audience(r));
        this.db.prepare(`UPDATE events SET title = ?, description = ?, location = ?, venue_id = ?, start_at = ?, end_at = ?, all_day = ?, conv_id = ?, online = ?,
          recurrence = ?, until_at = ?, reminder_min = ? WHERE id = ?`).run(v.title, v.description, v.location, v.venueId, v.startAt, v.endAt, v.allDay ? 1 : 0,
          v.convId, v.online ? 1 : 0, v.recurrence, v.until, v.reminderMin, r.id);
        this.db.prepare('UPDATE events SET time_zone = ? WHERE id = ?').run(v.timeZone, r.id);
        let added: string[] = [];
        if (v.attendees) {
          const cur = new Set(this.attendees(r.id).map((a) => a.userId));
          const want = new Set([r.organizer_id, ...v.attendees]);
          for (const u of cur) if (!want.has(u)) this.db.prepare('DELETE FROM event_attendees WHERE event_id = ? AND user_id = ?').run(r.id, u);
          added = [...want].filter((u) => !cur.has(u));
          for (const u of added) this.db.prepare('INSERT OR IGNORE INTO event_attendees (event_id, user_id, response) VALUES (?, ?, ?)').run(r.id, u, 'pending');
        }
        // a new time needs everyone to answer again
        if (timeChanged) this.db.prepare(`UPDATE event_attendees SET response = 'pending' WHERE event_id = ? AND user_id != ?`).run(r.id, r.organizer_id);
        const row = this.row(r.id)!;
        const ev = this.view(row);
        const after = new Set(this.audience(row));
        this.deliver([...after], 'cal.updated', () => ev);
        this.deliver([...before].filter((u) => !after.has(u)), 'cal.removed', () => ({ eventId: r.id }));
        this.deliver(added.filter((u) => u !== me.id), 'cal.invited', () => ev);
        return ev;
      }

      case 'cal.cancel': {
        const r = this.row(d.eventId);
        if (!r || !this.canSee(r, me.id)) throw new CalError('Meeting not found.');
        if (r.organizer_id !== me.id && !isAdmin) throw new CalError('Only the organiser can cancel this meeting.');
        this.db.prepare('UPDATE events SET cancelled = 1 WHERE id = ?').run(r.id);
        const ev = this.view(this.row(r.id)!);
        this.deliver(this.audience(r), 'cal.updated', () => ev);
        return ev;
      }

      case 'cal.respond': {
        const r = this.row(d.eventId);
        if (!r || !this.canSee(r, me.id)) throw new CalError('Meeting not found.');
        const response = d.response === 'yes' || d.response === 'no' || d.response === 'maybe' ? d.response : null;
        if (!response) throw new CalError('Answer yes, no or maybe.');
        // members of the meeting's conversation can join it by answering
        this.db.prepare(`INSERT INTO event_attendees (event_id, user_id, response) VALUES (?, ?, ?)
          ON CONFLICT(event_id, user_id) DO UPDATE SET response = excluded.response`).run(r.id, me.id, response);
        const ev = this.view(r);
        this.deliver(this.audience(r), 'cal.updated', () => ev);
        return ev;
      }

      case 'cal.busy': {
        const from = typeof d.from === 'number' ? d.from : NaN;
        const to = typeof d.to === 'number' ? d.to : NaN;
        if (Number.isNaN(from) || Number.isNaN(to) || to <= from || to - from > 31 * DAY) throw new CalError('Choose a range of up to a month.');
        const ids = Array.isArray(d.userIds) ? d.userIds.filter((x): x is string => typeof x === 'string').slice(0, MAX_ATTENDEES) : [];
        const venue = typeof d.venueId === 'string' ? d.venueId : null;
        const out: Array<{ id: string; startAt: number; endAt: number }> = [];
        if (ids.length) {
          const rows = this.db.prepare(`SELECT DISTINCT e.*, a.user_id AS who FROM events e JOIN event_attendees a ON a.event_id = e.id
            WHERE e.cancelled = 0 AND a.response != 'no' AND a.user_id IN (${ids.map(() => '?').join(',')}) AND e.start_at < ?`).all(...ids, to) as unknown as Array<EventRow & { who: string }>;
          for (const r of rows) for (const o of expand(r, from, to, 200)) out.push({ id: r.who, ...o });
        }
        if (venue) {
          const rows = this.db.prepare('SELECT * FROM events WHERE cancelled = 0 AND venue_id = ? AND start_at < ?').all(venue, to) as unknown as EventRow[];
          for (const r of rows) for (const o of expand(r, from, to, 200)) out.push({ id: `venue:${venue}`, ...o });
        }
        return out.sort((a, b) => a.startAt - b.startAt) satisfies Ops['cal.busy']['res'];
      }
    }
    return undefined;
  }
}

