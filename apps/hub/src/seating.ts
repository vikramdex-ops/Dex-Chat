// Seating (docs/SEATING.md): the office's real floor plan, kept on the hub and versioned, and who
// holds each seat. Everyone (not guests) sees it; administrators and the office managers they name
// change it. Seats change only through move plans: a draft of "this seat, this person" lines with an
// effective date, published with Apply (now, or on the date) and undone with Undo. Each change that
// takes effect is a revision (Rev A, B…) with its change list and a snapshot of who held what, so
// two revisions can be compared. People who move are told once, with a link that walks them there,
// and their directory "Seat" field follows the plan. The layout itself (walls, seats) is edited as
// a whole and saved as a new version. The office's drawing of 18-Jul-2026 is the seed (Rev A).
// The clock is injected (now(), setClock) so effective dates can be tested and walked through.
import type { DatabaseSync } from 'node:sqlite';
import {
  SEATING_LIMITS, applyMoves, checkMoves, diffHolders, effectiveMoves, flowMoves, isSeatId, isYmd, matchName, natural, nextRevLetter, parseSeatList,
  sameHolder, seatFromText, seatLabel, seatOfPeople, ulid, validatePlan, ymd,
} from '@dex/core';
import type {
  FloorPlan, Holders, ImportRowMatch, MovePlanStatus, MovePlanView, Ops, PublicUser, SeatChange, SeatHolder, SeatMove, SeatNotice, SeatRevision, SeatingView,
} from '@dex/core';
import type { Store } from './store.ts';
import seed from '../seed/floor-l01.json' with { type: 'json' };

export class SeatingError extends Error {}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS seat_layouts (
  version INTEGER PRIMARY KEY,
  plan TEXT NOT NULL,
  note TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS seat_holders (
  seat_id TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  since INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS seat_plans (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  effective TEXT NOT NULL,
  moves TEXT NOT NULL,
  before TEXT,
  after TEXT,
  rev TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  applied_at INTEGER,
  undone_at INTEGER
);
CREATE TABLE IF NOT EXISTS seat_revs (
  rev TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  by TEXT,
  note TEXT NOT NULL,
  changes TEXT NOT NULL,
  holders TEXT NOT NULL,
  layout INTEGER NOT NULL,
  plan_id TEXT
);
CREATE TABLE IF NOT EXISTS seat_told (
  user_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  seat_id TEXT,
  from_seat TEXT,
  effective TEXT NOT NULL,
  told_at INTEGER NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, plan_id)
);
CREATE TABLE IF NOT EXISTS seat_managers (
  user_id TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS seat_bookings (
  seat_id TEXT NOT NULL,
  day TEXT NOT NULL,
  user_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (seat_id, day)
);
CREATE TABLE IF NOT EXISTS seat_underlay (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  image TEXT NOT NULL,
  x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
  opacity REAL NOT NULL
);
`;

interface PlanRow { id: string; status: MovePlanStatus; title: string; effective: string; moves: string; before: string | null; after: string | null; rev: string | null; created_by: string; created_at: number; published_at: number | null; applied_at: number | null; undone_at: number | null }
interface RevRow { rev: string; n: number; kind: SeatRevision['kind']; at: number; by: string | null; note: string; changes: string; holders: string; layout: number; plan_id: string | null }

/** Role names on the drawing's half-cabins: the seed reserves those seats for the role. */
const SEED_RESERVED: Record<string, string> = { 'HC-04': 'Knowledge HUB', 'HC-05': '3D-Manager', 'HC-07': 'E&I Manager', 'HC-08': 'Civil-Manager', 'HC-10': 'Piping-Manager' };

const parse = <T>(s: string | null | undefined, d: T): T => { try { return s ? JSON.parse(s) as T : d; } catch { return d; } };
const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max) : '');
const dayName = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });

export interface SeatingDeps {
  db: DatabaseSync;
  store: Store;
  /** Tell everyone who may see the plan that it changed. */
  broadcast: (name: string, data: unknown) => void;
  /** One quiet line to someone (from Nib, or the system bot). */
  tell: (userId: string, key: string, text: string) => void;
  /** A person's details changed (their seat field). */
  userChanged: (userId: string) => void;
  audit: (actor: string, action: string, target: string | null, detail?: Record<string, unknown>) => void;
  log: (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void;
  /** The office's working days (0 = Sunday) and holidays, for booking hot desks ahead. */
  calendar?: () => { workdays: number[]; holidays: Array<{ date: string }> };
}

export class Seating {
  private readonly d: SeatingDeps;
  private readonly db: DatabaseSync;
  private offset = 0;
  private cache: { version: number; plan: FloorPlan } | null = null;

  constructor(d: SeatingDeps) {
    this.d = d;
    this.db = d.db;
    this.db.exec(SCHEMA);
    if (!this.db.prepare('SELECT 1 FROM seat_layouts LIMIT 1').get()) this.seed();
  }

  // ------------------------------------------------------------ the clock
  now(): number { return Date.now() + this.offset; }
  /** Tests and the end-to-end walk: move the clock (effective dates), or back to real time with null. */
  setClock(at: number | null): void { this.offset = at === null ? 0 : at - Date.now(); }
  private today(): string { return ymd(this.now()); }

  /** The drawing of 18-Jul-2026, built in as Rev A: its seats, and the half-cabins it names by role. */
  private seed(): void {
    const plan = seed as unknown as FloorPlan;
    const problems = validatePlan(plan);
    if (problems.length) { this.d.log('error', 'the seed floor plan is not valid', { problems }); return; }
    const now = this.now();
    this.db.prepare('INSERT INTO seat_layouts (version, plan, note, created_by, created_at) VALUES (1, ?, ?, NULL, ?)').run(JSON.stringify(plan), 'The office drawing of 18-Jul-2026', now);
    const holders: Holders = {};
    for (const [seat, label] of Object.entries(SEED_RESERVED)) if (plan.seats.some((s) => s.id === seat)) holders[seat] = { kind: 'reserved', label };
    for (const [seat, h] of Object.entries(holders)) this.db.prepare('INSERT INTO seat_holders (seat_id, holder, since) VALUES (?, ?, ?)').run(seat, JSON.stringify(h), now);
    this.db.prepare('INSERT INTO seat_revs (rev, n, kind, at, by, note, changes, holders, layout, plan_id) VALUES (?, 1, ?, ?, NULL, ?, ?, ?, 1, NULL)')
      .run('A', 'seed', now, 'The office drawing of 18-Jul-2026 built in', JSON.stringify(diffHolders({}, holders)), JSON.stringify(holders));
  }

  // ------------------------------------------------------------ reading
  layout(): { version: number; plan: FloorPlan } {
    const row = this.db.prepare('SELECT version, plan FROM seat_layouts ORDER BY version DESC LIMIT 1').get() as { version: number; plan: string } | undefined;
    if (!row) throw new SeatingError('There is no floor plan yet.');
    if (this.cache?.version === row.version) return this.cache;
    this.cache = { version: row.version, plan: JSON.parse(row.plan) as FloorPlan };
    return this.cache;
  }

  holders(): Holders {
    const out: Holders = {};
    for (const r of this.db.prepare('SELECT seat_id, holder FROM seat_holders').all() as Array<{ seat_id: string; holder: string }>) {
      const h = parse<SeatHolder | null>(r.holder, null);
      if (h) out[r.seat_id] = h;
    }
    return out;
  }

  private planView(r: PlanRow): MovePlanView {
    const moves = parse<SeatMove[]>(r.moves, []);
    const before = r.before ? parse<{ holders: Holders }>(r.before, { holders: {} }).holders : this.holders();
    const after = r.after ? parse<Holders>(r.after, {}) : applyMoves(before, moves);
    return {
      id: r.id, status: r.status, title: r.title, effective: r.effective, moves, changes: diffHolders(before, after), createdBy: r.created_by, createdAt: r.created_at,
      publishedAt: r.published_at, appliedAt: r.applied_at, rev: r.rev,
    };
  }

  private revView(r: RevRow): SeatRevision {
    return { rev: r.rev, kind: r.kind, at: r.at, by: r.by, note: r.note, changes: parse<SeatChange[]>(r.changes, []), layoutVersion: r.layout, planId: r.plan_id };
  }

  canEdit(u: PublicUser): boolean {
    if (u.role === 'owner' || u.role === 'admin') return true;
    if (u.role !== 'member') return false;
    return !!this.db.prepare('SELECT 1 FROM seat_managers WHERE user_id = ?').get(u.id);
  }

  /** Today, then each working day (not a holiday) up to two weeks ahead: the days a hot desk can be booked. */
  bookDays(): string[] {
    const cal = this.d.calendar?.();
    const off = new Set((cal?.holidays ?? []).map((h) => h.date));
    const out: string[] = [];
    const now = this.now();
    for (let i = 0; i <= 14; i++) {
      const t = new Date(now);
      t.setDate(t.getDate() + i);
      const day = ymd(t.getTime());
      if (i === 0 || ((cal?.workdays ?? [1, 2, 3, 4, 5, 6]).includes(t.getDay()) && !off.has(day))) out.push(day);
    }
    return out;
  }

  managers(): string[] { return (this.db.prepare('SELECT user_id FROM seat_managers').all() as Array<{ user_id: string }>).map((r) => r.user_id); }

  view(me: PublicUser): SeatingView {
    const { version, plan } = this.layout();
    const edit = this.canEdit(me);
    const rows = this.db.prepare(`SELECT * FROM seat_plans WHERE status IN ('draft', 'scheduled') ORDER BY created_at`).all() as unknown as PlanRow[];
    const plans = rows.filter((r) => r.status === 'scheduled' || edit).map((r) => this.planView(r));
    const revisions = (this.db.prepare('SELECT * FROM seat_revs ORDER BY n DESC LIMIT 60').all() as unknown as RevRow[]).map((r) => this.revView(r));
    const told = this.db.prepare('SELECT * FROM seat_told WHERE user_id = ? AND seen = 0 ORDER BY told_at DESC LIMIT 1').get(me.id) as { plan_id: string; seat_id: string | null; from_seat: string | null; effective: string } | undefined;
    const notice: SeatNotice | null = told ? { planId: told.plan_id, seatId: told.seat_id, from: told.from_seat, effective: told.effective, label: told.seat_id ? seatLabel(plan, told.seat_id) : '' } : null;
    const bookings = (this.db.prepare('SELECT seat_id, day, user_id FROM seat_bookings WHERE day >= ? ORDER BY day LIMIT 2000').all(this.today()) as Array<{ seat_id: string; day: string; user_id: string }>)
      .map((b) => ({ seatId: b.seat_id, day: b.day, userId: b.user_id }));
    const ul = edit ? this.db.prepare('SELECT x, y, w, h, opacity FROM seat_underlay WHERE id = 1').get() as SeatingView['underlay'] | undefined : undefined;
    return { plan, version, holders: this.holders(), plans, revisions, canEdit: edit, managers: this.managers(), notice, bookings, bookDays: this.bookDays(), underlay: ul ?? null };
  }

  // ------------------------------------------------------------ changing who sits where
  private person(uid: unknown): PublicUser {
    const u = typeof uid === 'string' ? this.d.store.userById(uid) : null;
    if (!u || u.role === 'bot' || u.role === 'guest') throw new SeatingError('That person is not in the directory.');
    if ((u as PublicUser & { leftAt?: number }).leftAt) throw new SeatingError(`${u.displayName} has left the office.`);
    return u;
  }

  /** Read and check moves from a request. */
  private readMoves(raw: unknown): SeatMove[] {
    if (!Array.isArray(raw)) throw new SeatingError('No moves.');
    if (raw.length > SEATING_LIMITS.moves) throw new SeatingError(`Up to ${SEATING_LIMITS.moves} moves at a time.`);
    const { plan } = this.layout();
    const ids = new Set(plan.seats.map((s) => s.id));
    const deps = new Set(this.db.prepare('SELECT id FROM departments').all().map((r) => (r as { id: string }).id));
    const out: SeatMove[] = [];
    for (const m of raw as Array<Record<string, unknown>>) {
      const seatId = m?.seatId;
      if (!isSeatId(seatId) || !ids.has(seatId)) throw new SeatingError(`There is no seat ${clean(seatId, 16)} on the plan.`);
      const to = m.to as Record<string, unknown> | null;
      let h: SeatHolder | null = null;
      if (to && typeof to === 'object') {
        const dept = typeof to.departmentId === 'string' && deps.has(to.departmentId) ? to.departmentId : null;
        if (to.kind === 'person') h = { kind: 'person', userId: this.person(to.userId).id };
        else if (to.kind === 'reserved') {
          const label = clean(to.label, SEATING_LIMITS.label);
          if (!label) throw new SeatingError('Say who the seat is reserved for.');
          h = { kind: 'reserved', label, ...(dept ? { departmentId: dept } : {}) };
        } else if (to.kind === 'hot') h = { kind: 'hot', ...(dept ? { departmentId: dept } : {}) };
        else throw new SeatingError('A seat is held by a person, a reservation or a hot desk.');
      }
      out.push({ seatId, to: h });
    }
    return out;
  }

  private check(moves: SeatMove[]): void {
    const { plan } = this.layout();
    const problems = checkMoves(plan, this.holders(), moves);
    if (!problems.length) return;
    const first = problems[0].replace(/^person:(\S+)/, (_, uid: string) => this.d.store.userById(uid)?.displayName ?? 'Someone');
    throw new SeatingError(first);
  }

  private planRow(id: unknown): PlanRow {
    const r = typeof id === 'string' ? this.db.prepare('SELECT * FROM seat_plans WHERE id = ?').get(id) as PlanRow | undefined : undefined;
    if (!r) throw new SeatingError('That move plan was not found.');
    return r;
  }

  private nextRev(): { rev: string; n: number } {
    const last = this.db.prepare('SELECT rev, n FROM seat_revs ORDER BY n DESC LIMIT 1').get() as { rev: string; n: number } | undefined;
    return { rev: nextRevLetter(last?.rev ?? null), n: (last?.n ?? 0) + 1 };
  }

  /** Write holders, keep the people's seat field in step, and record a revision. */
  private commit(after: Holders, kind: SeatRevision['kind'], note: string, by: string | null, planId: string | null): { rev: string; changes: SeatChange[] } {
    const before = this.holders();
    const { version, plan } = this.layout();
    const now = this.now();
    const changes = diffHolders(before, after);
    this.db.exec('BEGIN');
    try {
      for (const seat of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (sameHolder(before[seat], after[seat])) continue;
        if (after[seat]) this.db.prepare('INSERT INTO seat_holders (seat_id, holder, since) VALUES (?, ?, ?) ON CONFLICT(seat_id) DO UPDATE SET holder = excluded.holder, since = excluded.since').run(seat, JSON.stringify(after[seat]), now);
        else this.db.prepare('DELETE FROM seat_holders WHERE seat_id = ?').run(seat);
      }
      const { rev, n } = this.nextRev();
      this.db.prepare('INSERT INTO seat_revs (rev, n, kind, at, by, note, changes, holders, layout, plan_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(rev, n, kind, now, by, note.slice(0, SEATING_LIMITS.note), JSON.stringify(changes), JSON.stringify(after), version, planId);
      this.db.exec('COMMIT');
      this.syncProfiles(plan, before, after);
      return { rev, changes };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** The directory's "Seat" field follows the plan: set for people with a seat, cleared for people who lost theirs. */
  private syncProfiles(plan: FloorPlan, before: Holders, after: Holders): void {
    const b = seatOfPeople(before), a = seatOfPeople(after);
    for (const uid of new Set([...b.keys(), ...a.keys()])) {
      if (b.get(uid) === a.get(uid)) continue;
      const u = this.d.store.userById(uid);
      if (!u) continue;
      const seat = a.get(uid) ?? null;
      this.db.prepare('INSERT OR IGNORE INTO profiles (account) VALUES (?)').run(u.account);
      this.db.prepare('UPDATE profiles SET seat_id = ?, location = ? WHERE account = ?').run(seat, seat ? seatLabel(plan, seat) : null, u.account);
      this.d.userChanged(uid);
    }
  }

  /** Bring every seated person's field into step (after a layout change renames a zone, say). */
  private resyncAll(): void {
    const { plan } = this.layout();
    for (const [uid, seat] of seatOfPeople(this.holders())) {
      const u = this.d.store.userById(uid);
      if (!u) continue;
      const label = seatLabel(plan, seat);
      if (u.profile.seatId === seat && u.profile.location === label) continue;
      this.db.prepare('INSERT OR IGNORE INTO profiles (account) VALUES (?)').run(u.account);
      this.db.prepare('UPDATE profiles SET seat_id = ?, location = ? WHERE account = ?').run(seat, label, u.account);
      this.d.userChanged(uid);
    }
  }

  private changed(): void { this.d.broadcast('seating.updated', { version: this.layout().version, at: this.now() }); }

  /** Tell each person the plan moves, once: their new seat and the day, with a link that walks them there. */
  private tellMoved(r: PlanRow, changes: SeatChange[]): void {
    const { plan } = this.layout();
    const when = r.effective <= this.today() ? 'From today' : `From ${dayName(r.effective)}`;
    for (const c of changes) {
      if (!c.userId) continue;
      if (this.db.prepare('SELECT 1 FROM seat_told WHERE user_id = ? AND plan_id = ?').get(c.userId, r.id)) continue;
      this.db.prepare('INSERT INTO seat_told (user_id, plan_id, seat_id, from_seat, effective, told_at) VALUES (?, ?, ?, ?, ?, ?)').run(c.userId, r.id, c.to, c.from, r.effective, this.now());
      const text = c.to
        ? `${when} your seat is ${seatLabel(plan, c.to)}.${c.from ? ` (Before: ${c.from}.)` : ''} Walk there: dexconnect://floor/${c.to}`
        : `${when} you no longer have a fixed seat${c.from ? ` (${c.from} is being freed)` : ''}. Ask the office manager if this is not right.`;
      try { this.d.tell(c.userId, `seat-${r.id}`, text); } catch (err) { this.d.log('warn', 'seat notice not sent', { error: (err as Error).message }); }
    }
  }

  /** Make a published plan take effect. */
  private takeEffect(r: PlanRow, by: string | null): PlanRow {
    const moves = effectiveMoves(this.holders(), parse<SeatMove[]>(r.moves, []));
    this.check(moves);
    const before = this.holders();
    const after = applyMoves(before, moves);
    const touched = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !sameHolder(before[k], after[k]));
    const snapBefore: Holders = {}, snapAfter: Holders = {};
    for (const k of touched) { if (before[k]) snapBefore[k] = before[k]; if (after[k]) snapAfter[k] = after[k]; }
    const { rev } = this.commit(after, 'moves', r.title, by, r.id);
    // before/after keep only the seats the plan touched, for Undo
    this.db.prepare(`UPDATE seat_plans SET status = 'applied', applied_at = ?, rev = ?, before = ?, after = ? WHERE id = ?`)
      .run(this.now(), rev, JSON.stringify({ holders: snapBefore, touched }), JSON.stringify(snapAfter), r.id);
    return this.planRow(r.id);
  }

  /** Scheduled plans whose day has come. */
  tick(): void {
    const due = this.db.prepare(`SELECT * FROM seat_plans WHERE status = 'scheduled' AND effective <= ? ORDER BY published_at`).all(this.today()) as unknown as PlanRow[];
    for (const r of due) {
      try { this.takeEffect(r, r.created_by); this.changed(); } catch (err) {
        // a plan that no longer fits (someone left, a seat was removed) goes back to draft for a look
        this.db.prepare(`UPDATE seat_plans SET status = 'draft', published_at = NULL WHERE id = ?`).run(r.id);
        this.d.log('warn', 'a scheduled seating plan could not take effect', { id: r.id, error: (err as Error).message });
        this.changed();
      }
    }
    // old bookings go
    this.db.prepare('DELETE FROM seat_bookings WHERE day < ?').run(ymd(this.now() - 40 * 86_400_000));
  }

  // ------------------------------------------------------------ ops
  handle(op: string, me: PublicUser, d: Record<string, unknown>): unknown {
    if (me.role === 'guest' || me.role === 'bot') throw new SeatingError('The floor plan is for people in the office.');
    const edit = () => { if (!this.canEdit(me)) throw new SeatingError('Only administrators and office managers can change the seating.'); };
    switch (op) {
      case 'seating.get':
        return this.view(me) satisfies Ops['seating.get']['res'];

      case 'seating.rev': {
        const r = this.db.prepare('SELECT * FROM seat_revs WHERE rev = ?').get(clean(d.rev, 8).toUpperCase()) as RevRow | undefined;
        if (!r) throw new SeatingError('That revision was not found.');
        const layout = this.db.prepare('SELECT plan FROM seat_layouts WHERE version = ?').get(r.layout) as { plan: string } | undefined;
        return { rev: this.revView(r), holders: parse<Holders>(r.holders, {}), plan: layout ? JSON.parse(layout.plan) as FloorPlan : this.layout().plan } satisfies Ops['seating.rev']['res'];
      }

      case 'seating.draft': {
        edit();
        const moves = this.readMoves(d.moves);
        this.check(moves);
        const title = clean(d.title, SEATING_LIMITS.title) || 'Seat moves';
        const effective = d.effective === undefined ? null : isYmd(d.effective) ? d.effective : (() => { throw new SeatingError('The day should look like 2026-11-17.'); })();
        const now = this.now();
        if (d.id !== undefined) {
          const r = this.planRow(d.id);
          if (r.status !== 'draft') throw new SeatingError('Only a draft can be changed. Undo it first.');
          this.db.prepare('UPDATE seat_plans SET title = ?, effective = ?, moves = ? WHERE id = ?').run(title, effective ?? r.effective, JSON.stringify(moves), r.id);
          this.changed();
          return this.planView(this.planRow(r.id)) satisfies MovePlanView;
        }
        const id = ulid();
        this.db.prepare(`INSERT INTO seat_plans (id, status, title, effective, moves, created_by, created_at) VALUES (?, 'draft', ?, ?, ?, ?, ?)`).run(id, title, effective ?? this.today(), JSON.stringify(moves), me.id, now);
        this.changed();
        return this.planView(this.planRow(id)) satisfies MovePlanView;
      }

      case 'seating.discard': {
        edit();
        const r = this.planRow(d.id);
        if (r.status !== 'draft') throw new SeatingError('Only a draft can be thrown away.');
        this.db.prepare('DELETE FROM seat_plans WHERE id = ?').run(r.id);
        this.changed();
        return { ok: true } satisfies Ops['seating.discard']['res'];
      }

      case 'seating.flow': {
        edit();
        const { plan } = this.layout();
        let userIds: string[];
        if (typeof d.departmentId === 'string') {
          const dep = this.db.prepare('SELECT id FROM departments WHERE id = ?').get(d.departmentId);
          if (!dep) throw new SeatingError('Department not found.');
          userIds = this.d.store.activeUsers().filter((u) => u.profile.departmentId === d.departmentId && (u.role === 'member' || u.role === 'admin' || u.role === 'owner'))
            .sort((a, b) => a.displayName.localeCompare(b.displayName)).map((u) => u.id);
        } else userIds = (Array.isArray(d.userIds) ? d.userIds : []).slice(0, 500).map((u) => this.person(u).id);
        if (!userIds.length) throw new SeatingError('No one to move.');
        const zoneId = typeof d.zoneId === 'string' ? d.zoneId : undefined;
        const seatIds = Array.isArray(d.seatIds) ? d.seatIds.filter(isSeatId) : undefined;
        if (!seatIds?.length && !plan.zones.some((z) => z.id === zoneId)) throw new SeatingError('Choose a zone to move them to.');
        const h = this.holders();
        const r = flowMoves(plan, h, userIds, { zoneId, seatIds: seatIds?.length ? seatIds : undefined, fromSeat: isSeatId(d.fromSeat) ? d.fromSeat : undefined });
        return { moves: r.moves, changes: diffHolders(h, applyMoves(h, r.moves)), unplaced: r.unplaced } satisfies Ops['seating.flow']['res'];
      }

      case 'seating.apply': {
        edit();
        let r = this.planRow(d.id);
        if (r.status !== 'draft') throw new SeatingError('That plan has already been published.');
        const effective = d.effective === undefined ? r.effective : isYmd(d.effective) ? d.effective : null;
        if (!effective) throw new SeatingError('The day should look like 2026-11-17.');
        const moves = effectiveMoves(this.holders(), parse<SeatMove[]>(r.moves, []));
        if (!moves.length) throw new SeatingError('The plan changes nothing.');
        this.check(moves);
        const now = this.now();
        const changes = diffHolders(this.holders(), applyMoves(this.holders(), moves));
        this.db.prepare(`UPDATE seat_plans SET status = 'scheduled', effective = ?, moves = ?, published_at = ? WHERE id = ?`).run(effective, JSON.stringify(moves), now, r.id);
        r = this.planRow(r.id);
        if (effective <= this.today()) r = this.takeEffect(r, me.id);
        this.tellMoved(r, changes);
        this.d.audit(me.id, 'seating.apply', r.id, { title: r.title, effective, moves: moves.length });
        this.changed();
        return this.planView(r) satisfies MovePlanView;
      }

      case 'seating.undo': {
        edit();
        const r = this.planRow(d.id);
        if (r.status === 'scheduled') {
          this.db.prepare(`UPDATE seat_plans SET status = 'draft', published_at = NULL WHERE id = ?`).run(r.id);
          this.db.prepare('DELETE FROM seat_told WHERE plan_id = ?').run(r.id);
          this.d.audit(me.id, 'seating.unschedule', r.id, { title: r.title });
          this.changed();
          return this.planView(this.planRow(r.id)) satisfies MovePlanView;
        }
        if (r.status !== 'applied') throw new SeatingError('Only a published plan can be undone.');
        const later = this.db.prepare(`SELECT 1 FROM seat_plans WHERE status = 'applied' AND applied_at > ?`).get(r.applied_at ?? 0);
        if (later) throw new SeatingError('A later plan has taken effect since. Undo that one first.');
        const { holders: before, touched } = parse<{ holders: Holders; touched: string[] }>(r.before, { holders: {}, touched: [] });
        const after = parse<Holders>(r.after, {});
        const now = this.holders();
        for (const k of touched) if (!sameHolder(now[k], after[k])) throw new SeatingError(`Seat ${k} has changed since. Move it back by hand, or undo the later change first.`);
        const back: Holders = { ...now };
        for (const k of touched) { const v = before[k]; if (v) back[k] = v; else delete back[k]; }
        const { rev } = this.commit(back, 'undo', `Undo of Rev ${r.rev ?? '?'}: ${r.title}`, me.id, r.id);
        this.db.prepare(`UPDATE seat_plans SET status = 'undone', undone_at = ? WHERE id = ?`).run(this.now(), r.id);
        this.db.prepare('UPDATE seat_told SET seen = 1 WHERE plan_id = ?').run(r.id);
        this.d.audit(me.id, 'seating.undo', r.id, { title: r.title, rev });
        this.changed();
        return this.planView(this.planRow(r.id)) satisfies MovePlanView;
      }

      case 'seating.layout': {
        edit();
        const raw = d.plan;
        if (JSON.stringify(raw ?? null).length > SEATING_LIMITS.planBytes) throw new SeatingError('The plan is too big to save.');
        const problems = validatePlan(raw);
        if (problems.length) throw new SeatingError(problems.slice(0, 3).join(' '));
        const plan = raw as FloorPlan;
        const cur = this.layout();
        if (d.baseVersion !== cur.version) throw new SeatingError('Someone else saved the layout meanwhile. Reload it and make your changes again.');
        const ids = new Set(plan.seats.map((s) => s.id));
        const held = Object.keys(this.holders()).filter((k) => !ids.has(k)).sort(natural);
        if (held.length === 1) throw new SeatingError(`${held[0]} is still held. Move people off a seat before removing it.`);
        if (held.length) throw new SeatingError(`${held.slice(0, 4).join(', ')} are still held. Move people off a seat before removing it.`);
        const version = cur.version + 1;
        const note = clean(d.note, SEATING_LIMITS.note) || 'Layout changed';
        this.db.prepare('INSERT INTO seat_layouts (version, plan, note, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(version, JSON.stringify(plan), note, me.id, this.now());
        this.cache = null;
        // pending plans that name seats no longer there lose those lines
        for (const p of this.db.prepare(`SELECT id, moves FROM seat_plans WHERE status IN ('draft', 'scheduled')`).all() as Array<{ id: string; moves: string }>) {
          const moves = parse<SeatMove[]>(p.moves, []);
          const kept = moves.filter((m) => ids.has(m.seatId));
          if (kept.length !== moves.length) this.db.prepare('UPDATE seat_plans SET moves = ? WHERE id = ?').run(JSON.stringify(kept), p.id);
        }
        const { rev } = this.commit(this.holders(), 'layout', note, me.id, null);
        this.resyncAll();
        this.d.audit(me.id, 'seating.layout', null, { version, seats: plan.seats.length, rev });
        this.changed();
        return { version, rev } satisfies Ops['seating.layout']['res'];
      }

      case 'seating.underlay': {
        edit();
        if (d.image === null) { this.db.prepare('DELETE FROM seat_underlay').run(); this.changed(); return { ok: true }; }
        const num = (v: unknown, def: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);
        const cur = this.db.prepare('SELECT image FROM seat_underlay WHERE id = 1').get() as { image: string } | undefined;
        let image = cur?.image ?? null;
        if (typeof d.image === 'string') {
          if (d.image.length > SEATING_LIMITS.underlayBytes) throw new SeatingError('That drawing is too big. Use a smaller image (under 650 KB).');
          if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(d.image)) throw new SeatingError('The underlay should be a PNG, JPEG or WebP image.');
          image = d.image;
        }
        if (!image) throw new SeatingError('Choose a drawing to trace.');
        const { plan } = this.layout();
        this.db.prepare('INSERT INTO seat_underlay (id, image, x, y, w, h, opacity) VALUES (1, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET image = excluded.image, x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h, opacity = excluded.opacity')
          .run(image, num(d.x, 0, -500, 500), num(d.y, 0, -500, 500), num(d.w, plan.width, 1, 2000), num(d.h, plan.height, 1, 2000), num(d.opacity, 0.35, 0.05, 1));
        this.d.audit(me.id, 'seating.underlay', null, {});
        this.changed();
        return { ok: true } satisfies Ops['seating.underlay']['res'];
      }

      case 'seating.underlayImage': {
        edit();
        const r = this.db.prepare('SELECT image FROM seat_underlay WHERE id = 1').get() as { image: string } | undefined;
        return { image: r?.image ?? null } satisfies Ops['seating.underlayImage']['res'];
      }

      case 'seating.importMatch': {
        edit();
        const text = typeof d.text === 'string' ? d.text.slice(0, 200_000) : '';
        const { plan } = this.layout();
        const people = this.d.store.activeUsers().filter((u) => u.role !== 'bot' && u.role !== 'guest' && !(u as PublicUser & { leftAt?: number }).leftAt);
        const rows: ImportRowMatch[] = parseSeatList(text, plan).map((r) => {
          if (r.problem) return { ...r, userId: null, sure: false, suggestions: [] };
          const m = matchName(r.name, people);
          return { ...r, userId: m.userId, sure: m.sure, suggestions: m.suggestions, problem: m.suggestions.length ? null : 'No one in the directory has that name.' };
        });
        // the same seat twice: the later line is a problem
        const seen = new Set<string>();
        for (const r of rows) { if (r.problem) continue; if (seen.has(r.seatId)) r.problem = 'This seat is on an earlier line too.'; seen.add(r.seatId); }
        return { rows } satisfies Ops['seating.importMatch']['res'];
      }

      case 'seating.importProfiles': {
        edit();
        const { plan } = this.layout();
        const h = this.holders();
        const seated = seatOfPeople(h);
        const moves: SeatMove[] = [];
        const skipped: Array<{ userId: string; location: string }> = [];
        const claimed = new Set<string>();
        for (const u of this.d.store.activeUsers()) {
          if (u.role === 'bot' || u.role === 'guest' || seated.has(u.id) || !u.profile.location) continue;
          const seat = seatFromText(u.profile.location, plan);
          if (!seat || claimed.has(seat) || (h[seat] && h[seat].kind === 'person')) { skipped.push({ userId: u.id, location: u.profile.location }); continue; }
          claimed.add(seat);
          moves.push({ seatId: seat, to: { kind: 'person', userId: u.id } });
        }
        return { moves, skipped: skipped.slice(0, 500) } satisfies Ops['seating.importProfiles']['res'];
      }

      case 'seating.book': {
        const day = isYmd(d.day) ? d.day : null;
        if (!day) throw new SeatingError('The day should look like 2026-11-17.');
        if (day < this.today() || day > ymd(this.now() + 14 * 86_400_000)) throw new SeatingError('Hot desks can be booked for today and up to two weeks ahead.');
        if (d.seatId !== null && !this.bookDays().includes(day)) throw new SeatingError('That is not a working day: book a working day.');
        if (d.seatId === null) { this.db.prepare('DELETE FROM seat_bookings WHERE user_id = ? AND day = ?').run(me.id, day); this.changed(); return { ok: true }; }
        if (!isSeatId(d.seatId)) throw new SeatingError('Choose a seat.');
        const h = this.holders()[d.seatId];
        if (h?.kind !== 'hot') throw new SeatingError('That seat is not a hot desk.');
        const other = this.db.prepare('SELECT user_id FROM seat_bookings WHERE seat_id = ? AND day = ?').get(d.seatId, day) as { user_id: string } | undefined;
        if (other && other.user_id !== me.id) throw new SeatingError(`${this.d.store.userById(other.user_id)?.displayName ?? 'Someone'} has booked it that day.`);
        this.db.prepare('DELETE FROM seat_bookings WHERE user_id = ? AND day = ?').run(me.id, day);
        this.db.prepare('INSERT INTO seat_bookings (seat_id, day, user_id, at) VALUES (?, ?, ?, ?)').run(d.seatId, day, me.id, this.now());
        this.changed();
        return { ok: true } satisfies Ops['seating.book']['res'];
      }

      case 'seating.seen':
        this.db.prepare('UPDATE seat_told SET seen = 1 WHERE user_id = ? AND plan_id = ?').run(me.id, clean(d.planId, 40));
        return { ok: true } satisfies Ops['seating.seen']['res'];

      case 'admin.seating.managers': {
        if (me.role !== 'owner' && me.role !== 'admin') throw new SeatingError('Only administrators can choose the office managers.');
        if (Array.isArray(d.userIds)) {
          const ids = [...new Set(d.userIds.slice(0, 50).map((u) => this.person(u)).filter((u) => u.role === 'member').map((u) => u.id))];
          this.db.exec('BEGIN');
          try {
            this.db.prepare('DELETE FROM seat_managers').run();
            for (const id of ids) this.db.prepare('INSERT INTO seat_managers (user_id) VALUES (?)').run(id);
            this.db.exec('COMMIT');
          } catch (e) { this.db.exec('ROLLBACK'); throw e; }
          this.d.audit(me.id, 'seating.managers', null, { count: ids.length });
          this.changed();
        }
        return { managers: this.managers() } satisfies Ops['admin.seating.managers']['res'];
      }
    }
    return undefined;
  }

  /** Someone left the office: free their seat (a quiet revision), so the plan never shows a leaver. */
  personLeft(userId: string): void {
    const h = this.holders();
    const seat = seatOfPeople(h).get(userId);
    if (!seat) return;
    const after = { ...h };
    delete after[seat];
    this.commit(after, 'moves', `${seat} freed: ${this.d.store.userById(userId)?.displayName ?? 'someone'} left`, null, null);
    this.changed();
  }
}
