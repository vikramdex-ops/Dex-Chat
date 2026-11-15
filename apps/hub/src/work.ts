// Remote work and attendance: check in (office, home, site or client), breaks, check out.
// Colleagues see who is working and where; managers and administrators get reports.
// Forgotten check-outs are closed automatically at the person's last activity.
import type { DatabaseSync } from 'node:sqlite';
import { ulid } from '@dex/core';
import type { AttendanceDay, Ops, PublicUser, WorkMode, WorkSegment, WorkState } from '@dex/core';

export class WorkError extends Error {}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS work_segments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  mode TEXT,
  start_at INTEGER NOT NULL,
  end_at INTEGER,
  note TEXT,
  auto INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_work_user ON work_segments(user_id, start_at);
CREATE INDEX IF NOT EXISTS idx_work_open ON work_segments(end_at);
`;

interface SegRow { id: string; user_id: string; kind: 'work' | 'break'; mode: WorkMode | null; start_at: number; end_at: number | null; note: string | null; auto: number }

const MODES: WorkMode[] = ['office', 'home', 'site', 'client'];
const HOUR = 3600_000;
/** A session still open after this long was a forgotten check-out. */
const STALE_WORK = 14 * HOUR;
const STALE_BREAK = 4 * HOUR;
const MAX_REPORT_DAYS = 400;

const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const localDate = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const parseDate = (s: unknown): number | null => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(y, m - 1, d).getTime();
  return Number.isNaN(t) ? null : t;
};

export class Work {
  private readonly db: DatabaseSync;
  private readonly users: () => PublicUser[];
  private readonly lastSeen: (userId: string) => number | null;
  private readonly broadcast: (state: WorkState) => void;

  constructor(db: DatabaseSync, users: Work['users'], lastSeen: Work['lastSeen'], broadcast: Work['broadcast']) {
    this.db = db;
    this.users = users;
    this.lastSeen = lastSeen;
    this.broadcast = broadcast;
    db.exec(SCHEMA);
  }

  private open(userId: string): SegRow[] {
    return this.db.prepare('SELECT * FROM work_segments WHERE user_id = ? AND end_at IS NULL ORDER BY start_at').all(userId) as unknown as SegRow[];
  }

  private close(id: string, at: number, auto = false): void {
    this.db.prepare('UPDATE work_segments SET end_at = MAX(start_at, ?), auto = MAX(auto, ?) WHERE id = ?').run(at, auto ? 1 : 0, id);
  }

  private insert(userId: string, kind: 'work' | 'break', mode: WorkMode | null, at: number, note: string | null): void {
    this.db.prepare('INSERT INTO work_segments (id, user_id, kind, mode, start_at, note) VALUES (?, ?, ?, ?, ?, ?)').run(ulid(), userId, kind, mode, at, note);
  }

  state(userId: string, now = Date.now()): WorkState {
    const open = this.open(userId);
    const work = open.find((s) => s.kind === 'work');
    const brk = open.find((s) => s.kind === 'break');
    const today = startOfDay(now);
    const rows = this.db.prepare(`SELECT start_at, end_at FROM work_segments WHERE user_id = ? AND kind = 'work' AND (end_at IS NULL OR end_at > ?)`).all(userId, today) as Array<{ start_at: number; end_at: number | null }>;
    const breaks = this.db.prepare(`SELECT start_at, end_at FROM work_segments WHERE user_id = ? AND kind = 'break' AND (end_at IS NULL OR end_at > ?)`).all(userId, today) as Array<{ start_at: number; end_at: number | null }>;
    const span = (r: { start_at: number; end_at: number | null }) => Math.max(0, Math.min(r.end_at ?? now, now) - Math.max(r.start_at, today));
    const worked = rows.reduce((n, r) => n + span(r), 0) - breaks.reduce((n, r) => n + span(r), 0);
    const first = this.db.prepare(`SELECT MIN(start_at) AS t FROM work_segments WHERE user_id = ? AND kind = 'work' AND start_at >= ?`).get(userId, today) as { t: number | null };
    return {
      userId,
      status: brk ? 'break' : work ? 'in' : 'out',
      mode: work?.mode ?? null,
      since: brk?.start_at ?? work?.start_at ?? null,
      checkedInAt: work ? (first.t ?? work.start_at) : null,
      note: work?.note ?? null,
      workedTodayMs: Math.max(0, worked),
    };
  }

  private changed(userId: string): WorkState {
    const s = this.state(userId);
    this.broadcast(s);
    return s;
  }

  /** Close sessions people forgot to end. Runs on the hub timer and before each check-in. */
  tick(now = Date.now()): void {
    const stale = this.db.prepare(`SELECT * FROM work_segments WHERE end_at IS NULL AND ((kind = 'work' AND start_at < ?) OR (kind = 'break' AND start_at < ?))`)
      .all(now - STALE_WORK, now - STALE_BREAK) as unknown as SegRow[];
    const touched = new Set<string>();
    for (const s of stale) this.autoClose(s, now, touched);
    for (const u of touched) this.changed(u);
  }

  private autoClose(s: SegRow, now: number, touched: Set<string>): void {
    touched.add(s.user_id);
    if (s.kind === 'break') {
      // a break that never ended: they left at the start of it
      this.close(s.id, s.start_at, true);
      for (const w of this.open(s.user_id)) if (w.kind === 'work') this.close(w.id, s.start_at, true);
      return;
    }
    const seen = this.lastSeen(s.user_id);
    const end = seen && seen > s.start_at && seen < now ? Math.min(seen, s.start_at + STALE_WORK) : s.start_at + 9 * HOUR;
    this.close(s.id, Math.min(end, now), true);
  }

  /** Who may see whose reports: yourself, everyone below you, or everyone for administrators. */
  private visible(me: PublicUser): Set<string> {
    const all = this.users().filter((u) => u.role !== 'bot');
    if (me.role === 'owner' || me.role === 'admin') return new Set(all.map((u) => u.id));
    const out = new Set([me.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const u of all) if (u.profile.managerId && out.has(u.profile.managerId) && !out.has(u.id)) { out.add(u.id); grew = true; }
    }
    return out;
  }

  handle(op: string, me: PublicUser, d: Record<string, unknown>): unknown {
    const now = Date.now();
    const note = (v: unknown) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 120) || null : null);
    if (op !== 'work.team' && op !== 'work.report' && (me.role === 'bot' || me.role === 'guest')) throw new WorkError('The day log is for members of the office.');

    switch (op) {
      case 'work.checkIn': {
        const mode = MODES.includes(d.mode as WorkMode) ? d.mode as WorkMode : null;
        if (!mode) throw new WorkError('Choose where you are working.');
        // yesterday's session that was never closed
        const touched = new Set<string>();
        for (const s of this.open(me.id)) if (startOfDay(s.start_at) < startOfDay(now)) this.autoClose(s, now, touched);
        if (this.open(me.id).some((s) => s.kind === 'work')) throw new WorkError('You are already checked in.');
        this.insert(me.id, 'work', mode, now, note(d.note));
        return this.changed(me.id) satisfies Ops['work.checkIn']['res'];
      }

      case 'work.checkOut': {
        const open = this.open(me.id);
        if (!open.some((s) => s.kind === 'work')) throw new WorkError('You are not checked in.');
        for (const s of open) this.close(s.id, now);
        return this.changed(me.id);
      }

      case 'work.break': {
        const open = this.open(me.id);
        if (!open.some((s) => s.kind === 'work')) throw new WorkError('Start your day first.');
        const brk = open.find((s) => s.kind === 'break');
        if (d.on === true && !brk) this.insert(me.id, 'break', null, now, null);
        if (d.on !== true && brk) this.close(brk.id, now);
        return this.changed(me.id);
      }

      case 'work.setMode': {
        const mode = MODES.includes(d.mode as WorkMode) ? d.mode as WorkMode : null;
        if (!mode) throw new WorkError('Choose where you are working.');
        const work = this.open(me.id).find((s) => s.kind === 'work');
        if (!work) throw new WorkError('Start your day first.');
        if (work.mode !== mode) {
          // moving (say from the office to a site visit) starts a new segment so reports show both
          this.close(work.id, now);
          this.insert(me.id, 'work', mode, now, d.note !== undefined ? note(d.note) : work.note);
        } else if (d.note !== undefined) {
          this.db.prepare('UPDATE work_segments SET note = ? WHERE id = ?').run(note(d.note), work.id);
        }
        return this.changed(me.id);
      }

      case 'work.team':
        return this.users().filter((u) => u.role !== 'bot').map((u) => this.state(u.id, now)) satisfies Ops['work.team']['res'];

      case 'work.report': {
        const from = parseDate(d.from);
        const to = parseDate(d.to);
        if (from === null || to === null || to < from) throw new WorkError('Choose a valid date range.');
        if ((to - from) / (24 * HOUR) > MAX_REPORT_DAYS) throw new WorkError('Choose up to about a year at a time.');
        const end = new Date(to); end.setDate(end.getDate() + 1);
        const allowed = this.visible(me);
        const wanted = Array.isArray(d.userIds) ? d.userIds.filter((x): x is string => typeof x === 'string') : [...allowed];
        if (wanted.some((id) => !allowed.has(id))) throw new WorkError('You can see your own attendance and your team\'s.');
        if (!wanted.length) return { days: [], segments: [] };
        const rows = this.db.prepare(`SELECT * FROM work_segments WHERE start_at >= ? AND start_at < ? AND user_id IN (${wanted.map(() => '?').join(',')}) ORDER BY start_at`)
          .all(from, end.getTime(), ...wanted) as unknown as SegRow[];
        const segments: WorkSegment[] = rows.map((r) => ({ id: r.id, userId: r.user_id, kind: r.kind, mode: r.mode, startAt: r.start_at, endAt: r.end_at, note: r.note, auto: !!r.auto }));
        const days = new Map<string, AttendanceDay>();
        for (const r of rows) {
          const key = `${r.user_id}|${localDate(r.start_at)}`;
          const day = days.get(key) ?? { userId: r.user_id, date: localDate(r.start_at), firstIn: r.start_at, lastOut: null, workedMs: 0, breakMs: 0, modes: [], autoClosed: false };
          const len = Math.max(0, (r.end_at ?? now) - r.start_at);
          if (r.kind === 'work') {
            day.workedMs += len;
            day.firstIn = Math.min(day.firstIn, r.start_at);
            day.lastOut = r.end_at === null ? null : Math.max(day.lastOut ?? 0, r.end_at);
            if (r.mode && !day.modes.includes(r.mode)) day.modes.push(r.mode);
          } else day.breakMs += len;
          if (r.auto) day.autoClosed = true;
          days.set(key, day);
        }
        for (const day of days.values()) day.workedMs = Math.max(0, day.workedMs - day.breakMs);
        return { days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date) || a.userId.localeCompare(b.userId)), segments } satisfies Ops['work.report']['res'];
      }
    }
    return undefined;
  }
}
