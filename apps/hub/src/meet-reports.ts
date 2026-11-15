// Per-meeting reports: who joined, when and for how long (rejoins summed, a second device not
// counted twice), hands raised, reactions, the polls asked during the meeting, its recordings and
// breakouts; and the office's meeting totals by week for the Control room. Attendance is written
// as people come and go, so a report survives the hub restarting mid-meeting.
import type { DatabaseSync } from 'node:sqlite';
import { isWebGuest } from '@dex/core';
import type { MeetingKind, MeetingReport, MeetingReportPerson, MeetingUsage, PublicUser, RecordingInfo, RoomInfo, WebinarReport } from '@dex/core';
import type { Meeting } from './meetings.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meeting_sessions (
  room_id TEXT PRIMARY KEY,
  meeting_id TEXT,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  conv_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  peak INTEGER NOT NULL DEFAULT 0,
  breakouts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_meeting_sessions_started ON meeting_sessions(started_at);
CREATE TABLE IF NOT EXISTS meeting_attendance (
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  name TEXT NOT NULL,
  guest INTEGER NOT NULL,
  joined_at INTEGER NOT NULL,
  left_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_meeting_attendance_room ON meeting_attendance(room_id);
CREATE INDEX IF NOT EXISTS idx_meeting_attendance_user ON meeting_attendance(user_id);
CREATE TABLE IF NOT EXISTS meeting_activity (
  room_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meeting_activity_room ON meeting_activity(room_id);
`;

export class ReportError extends Error {}

/** What the Rooms tell the reports as a meeting runs (all keyed by the meeting's main Room). */
export interface RoomTracker {
  opened(room: RoomInfo & { meeting: Meeting | null }): void;
  joined(roomId: string, userId: string, deviceId: string, name: string): void;
  left(roomId: string, userId: string, deviceId: string): void;
  hand(roomId: string, userId: string): void;
  reaction(roomId: string, userId: string, emoji: string): void;
  breakoutsOpened(roomId: string, rooms: number): void;
  breakoutsClosed(roomId: string): void;
  closed(roomId: string): void;
}

interface SessionRow { room_id: string; meeting_id: string | null; title: string; kind: MeetingKind; conv_id: string; host_id: string; started_at: number; ended_at: number | null; peak: number; breakouts: number }
interface Seg { user_id: string; device_id: string; name: string; guest: number; joined_at: number; left_at: number | null }

const DAY = 86400_000;

/** Merge overlapping intervals (two devices of one person) and sum them. */
export function sumIntervals(list: Array<[number, number]>): { total: number; spans: number } {
  const sorted = list.filter(([a, b]) => b >= a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let spans = 0;
  let cur: [number, number] | null = null;
  for (const [a, b] of sorted) {
    if (cur && a <= cur[1]) cur[1] = Math.max(cur[1], b);
    else { if (cur) { total += cur[1] - cur[0]; spans++; } cur = [a, b]; }
  }
  if (cur) { total += cur[1] - cur[0]; spans++; }
  return { total, spans };
}

/** Monday of the week (local time), as 2026-11-09. */
function weekKey(t: number): string {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export class MeetReports implements RoomTracker {
  private readonly db: DatabaseSync;
  /** The recordings of a meeting, as the viewer may see them. */
  recordingsFor: (roomId: string, viewer: PublicUser) => RecordingInfo[] = () => [];
  /** A webinar's own part (webinars.ts): registrants with attended or no-show, questions, poll answers, handout downloads, the survey. */
  webinarFor: (meetingId: string | null) => WebinarReport | null = () => null;
  /** Hosts of the meeting a report belongs to (they may see it even if they were not in it). */
  private readonly isAdmin = (u: PublicUser) => u.role === 'owner' || u.role === 'admin';

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(SCHEMA);
    // meetings that were running when the hub stopped: close them where the last person left
    const open = db.prepare('SELECT room_id, started_at FROM meeting_sessions WHERE ended_at IS NULL').all() as Array<{ room_id: string; started_at: number }>;
    for (const s of open) {
      const last = (db.prepare('SELECT MAX(COALESCE(left_at, joined_at)) AS t FROM meeting_attendance WHERE room_id = ?').get(s.room_id) as { t: number | null }).t ?? s.started_at;
      db.prepare('UPDATE meeting_attendance SET left_at = ? WHERE room_id = ? AND left_at IS NULL').run(last, s.room_id);
      db.prepare('UPDATE meeting_sessions SET ended_at = ? WHERE room_id = ?').run(last, s.room_id);
    }
  }

  // ---------------------------------------------------------------- tracking
  opened(room: RoomInfo & { meeting: Meeting | null }): void {
    this.db.prepare(`INSERT OR IGNORE INTO meeting_sessions (room_id, meeting_id, title, kind, conv_id, host_id, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(room.id, room.meeting?.id ?? null, room.meeting?.title ?? '', room.meeting?.kind ?? 'conversation', room.convId, room.hostId ?? room.startedBy, room.startedAt);
  }

  joined(roomId: string, userId: string, deviceId: string, name: string, now = Date.now()): void {
    if (this.db.prepare('SELECT 1 FROM meeting_attendance WHERE room_id = ? AND device_id = ? AND left_at IS NULL').get(roomId, deviceId)) return;
    this.db.prepare('INSERT INTO meeting_attendance (room_id, user_id, device_id, name, guest, joined_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(roomId, userId, deviceId, name.slice(0, 80), isWebGuest(userId) ? 1 : 0, now);
    const here = (this.db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM meeting_attendance WHERE room_id = ? AND left_at IS NULL').get(roomId) as { n: number }).n;
    this.db.prepare('UPDATE meeting_sessions SET peak = MAX(peak, ?) WHERE room_id = ?').run(here, roomId);
  }

  left(roomId: string, _userId: string, deviceId: string, now = Date.now()): void {
    this.db.prepare('UPDATE meeting_attendance SET left_at = ? WHERE room_id = ? AND device_id = ? AND left_at IS NULL').run(now, roomId, deviceId);
  }

  hand(roomId: string, userId: string): void {
    this.db.prepare(`INSERT INTO meeting_activity (room_id, user_id, kind, detail, at) VALUES (?, ?, 'hand', NULL, ?)`).run(roomId, userId, Date.now());
  }

  reaction(roomId: string, userId: string, emoji: string): void {
    this.db.prepare(`INSERT INTO meeting_activity (room_id, user_id, kind, detail, at) VALUES (?, ?, 'reaction', ?, ?)`).run(roomId, userId, emoji, Date.now());
  }

  breakoutsOpened(roomId: string, rooms: number): void {
    this.db.prepare('UPDATE meeting_sessions SET breakouts = breakouts + ? WHERE room_id = ?').run(Math.max(0, rooms), roomId);
  }

  breakoutsClosed(): void { /* the count is kept when they open */ }

  closed(roomId: string, now = Date.now()): void {
    this.db.prepare('UPDATE meeting_attendance SET left_at = ? WHERE room_id = ? AND left_at IS NULL').run(now, roomId);
    this.db.prepare('UPDATE meeting_sessions SET ended_at = ? WHERE room_id = ? AND ended_at IS NULL').run(now, roomId);
  }

  // ---------------------------------------------------------------- reading
  /** Was this person in the meeting (any device, any time)? */
  attended(roomId: string, userId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM meeting_attendance WHERE room_id = ? AND user_id = ? LIMIT 1').get(roomId, userId);
  }

  report(roomId: unknown, viewer: PublicUser, isHostOf: (meetingId: string | null, userId: string) => boolean, now = Date.now()): MeetingReport {
    const s = typeof roomId === 'string' ? this.db.prepare('SELECT * FROM meeting_sessions WHERE room_id = ?').get(roomId) as SessionRow | undefined : undefined;
    if (!s || !(this.attended(s.room_id, viewer.id) || s.host_id === viewer.id || isHostOf(s.meeting_id, viewer.id) || this.isAdmin(viewer))) throw new ReportError('No report for that meeting.');
    const end = s.ended_at ?? now;
    const segs = this.db.prepare('SELECT * FROM meeting_attendance WHERE room_id = ? ORDER BY joined_at').all(s.room_id) as unknown as Seg[];
    const acts = this.db.prepare('SELECT user_id, kind, detail FROM meeting_activity WHERE room_id = ?').all(s.room_id) as Array<{ user_id: string; kind: string; detail: string | null }>;
    const byUser = new Map<string, Seg[]>();
    for (const g of segs) (byUser.get(g.user_id) ?? byUser.set(g.user_id, []).get(g.user_id)!).push(g);
    const people: MeetingReportPerson[] = [...byUser.entries()].map(([userId, list]) => {
      const spans = list.map((g): [number, number] => [g.joined_at, g.left_at ?? end]);
      const { total, spans: joins } = sumIntervals(spans);
      return {
        userId, name: list[list.length - 1].name, guest: !!list[0].guest,
        firstJoin: Math.min(...spans.map((x) => x[0])), lastLeave: Math.max(...spans.map((x) => x[1])), totalMs: total, joins,
        hands: acts.filter((a) => a.user_id === userId && a.kind === 'hand').length,
        reactions: acts.filter((a) => a.user_id === userId && a.kind === 'reaction').length,
      };
    }).sort((a, b) => a.firstJoin - b.firstJoin);
    const reactions: Record<string, number> = {};
    for (const a of acts) if (a.kind === 'reaction' && a.detail) reactions[a.detail] = (reactions[a.detail] ?? 0) + 1;
    return {
      roomId: s.room_id, meetingId: s.meeting_id, title: s.title, kind: s.kind, hostId: s.host_id,
      startedAt: s.started_at, endedAt: s.ended_at, durationMs: end - s.started_at,
      people, peak: s.peak, hands: acts.filter((a) => a.kind === 'hand').length, reactions,
      polls: this.polls(s.conv_id, s.started_at, end),
      recordings: this.recordingsFor(s.room_id, viewer),
      breakouts: s.breakouts,
      ...(s.kind === 'webinar' ? { webinar: this.webinarFor(s.meeting_id) ?? undefined } : {}),
    };
  }

  /** Polls asked in the meeting's conversation while it ran, with their results. */
  private polls(convId: string, from: number, to: number): MeetingReport['polls'] {
    const rows = this.db.prepare(`SELECT p.message_id, p.question, p.options FROM polls p JOIN messages m ON m.id = p.message_id
      WHERE m.conv_id = ? AND m.created_at BETWEEN ? AND ? AND m.deleted = 0 ORDER BY m.created_at`).all(convId, from, to) as Array<{ message_id: string; question: string; options: string }>;
    return rows.map((r) => {
      let texts: string[] = [];
      try { const v = JSON.parse(r.options) as unknown; if (Array.isArray(v)) texts = v.map(String); } catch { /* none */ }
      const votes = this.db.prepare('SELECT option, COUNT(*) AS n FROM poll_votes WHERE message_id = ? GROUP BY option').all(r.message_id) as Array<{ option: number; n: number }>;
      const voters = (this.db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM poll_votes WHERE message_id = ?').get(r.message_id) as { n: number }).n;
      return { question: r.question, options: texts.map((text, i) => ({ text, votes: votes.find((v) => v.option === i)?.n ?? 0 })), voters };
    });
  }

  /** Office totals by week: meetings held, hours, average size, guests from a browser. */
  usage(days: number, recordings: { count: number; bytes: number }, now = Date.now()): MeetingUsage {
    const from = now - days * DAY;
    const sessions = this.db.prepare('SELECT room_id, started_at, ended_at FROM meeting_sessions WHERE started_at >= ? AND ended_at IS NOT NULL ORDER BY started_at').all(from) as Array<{ room_id: string; started_at: number; ended_at: number }>;
    const weeks = new Map<string, { week: string; meetings: number; hours: number; people: number; guests: number }>();
    // every week in the period, so a quiet week shows as a zero, not a gap
    for (let t = from; t <= now + 7 * DAY; t += 7 * DAY) { const k = weekKey(Math.min(t, now)); if (!weeks.has(k)) weeks.set(k, { week: k, meetings: 0, hours: 0, people: 0, guests: 0 }); }
    let meetings = 0, ms = 0, people = 0, guests = 0;
    for (const s of sessions) {
      const who = this.db.prepare('SELECT COUNT(DISTINCT user_id) AS n, COUNT(DISTINCT CASE WHEN guest = 1 THEN user_id END) AS g FROM meeting_attendance WHERE room_id = ?').get(s.room_id) as { n: number; g: number };
      // a Room nobody else came to is not a meeting
      if (who.n < 2) continue;
      const w = weeks.get(weekKey(s.started_at)) ?? { week: weekKey(s.started_at), meetings: 0, hours: 0, people: 0, guests: 0 };
      w.meetings++; w.hours += (s.ended_at - s.started_at) / 3600_000; w.people += who.n; w.guests += who.g;
      weeks.set(w.week, w);
      meetings++; ms += s.ended_at - s.started_at; people += who.n; guests += who.g;
    }
    const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
    return {
      days, from,
      weeks: [...weeks.values()].sort((a, b) => a.week.localeCompare(b.week)).map((w) => ({ week: w.week, meetings: w.meetings, hours: round(w.hours), averageSize: w.meetings ? round(w.people / w.meetings) : 0, guests: w.guests })),
      totals: { meetings, hours: round(ms / 3600_000), averageSize: meetings ? round(people / meetings) : 0, guests, recordings: recordings.count, recordingBytes: recordings.bytes },
    };
  }
}
