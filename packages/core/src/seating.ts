// Seating: the office's real floor plan as data, who holds which seat, and how seats change. The
// plan is geometry in feet (x east, y south, the drawing's "up" is plan north): walls, doors with
// their swing, columns, rooms, fixed furniture and every seat with a stable ID. Who sits where is
// kept apart from the geometry, and changes only through a move plan (a list of seats and who will
// hold them) that is published with an effective date and becomes a revision, like a drawing.
// These are the rules the hub and the apps share; the hub keeps the plan (apps/hub/src/seating.ts).
// See docs/SEATING.md for the seat-ID scheme.

export type Pt = [number, number];

/** What kind of place a seat is. */
export type SeatType = 'bench' | 'pod' | 'halfCabin' | 'cabin' | 'clientCabin' | 'reception';
export const SEAT_TYPES: readonly SeatType[] = ['bench', 'pod', 'halfCabin', 'cabin', 'clientCabin', 'reception'];

export interface PlanSeat {
  /** Stable ID, e.g. W-A14, POD1-3, HC-05, CC-02, MD-01, REC-01. */
  id: string;
  x: number;
  y: number;
  /** Which way the person faces, in compass degrees (0 = plan north, 90 = east). */
  facing: number;
  type: SeatType;
  /** The zone (a group of seats people recognise: "Left benches"). */
  zone: string;
  /** The bench row or pod the seat belongs to, for moving them together. */
  group?: string;
  /** The desk in front of the chair, when it is not the standard 4'0" x 2'0" bench desk. */
  desk?: { w: number; d: number };
  /** The room the seat is in, for cabins. */
  room?: string;
}

export interface PlanZone { id: string; code: string; name: string; note?: string }
export interface PlanRoom { id: string; name: string; kind: 'room' | 'cabin' | 'area'; dims?: string; poly: Pt[]; open?: boolean; /** Where its name goes, when not in the middle (clear of the furniture). */ label?: Pt }
export type WallKind = 'partition' | 'glass' | 'solid' | 'exterior';
export interface PlanWall { a?: Pt; b?: Pt; arc?: { c: Pt; r: number; a0: number; a1: number }; t: number; kind: WallKind }
/** A door: the leaf turns on the hinge from its closed tip to its open tip (the swing is drawn between). */
export interface PlanDoor { id: string; hinge: Pt; closed: Pt; open: Pt; kind: 'single' | 'entrance' }
export interface PlanColumn { x: number; y: number; w: number; h: number }
export interface PlanFixture {
  id: string;
  kind: 'table' | 'round' | 'sofa' | 'chair' | 'planter' | 'printer' | 'plant' | 'counter' | 'box' | 'poly' | 'arc' | 'outline';
  x?: number; y?: number; w?: number; h?: number; r?: number; rot?: number;
  pts?: Pt[]; lines?: Pt[][]; rects?: number[][]; solid?: number[][];
  c?: Pt; r0?: number; r1?: number; a0?: number; a1?: number; seats?: number;
}
export interface PlanDim { a: Pt; b: Pt; off: number; text: string }
export interface PlanLabel { at: Pt; text: string }

export interface FloorPlan {
  v: 1;
  name: string;
  drawingNo: string;
  source?: string;
  units: 'ft';
  width: number;
  height: number;
  /** Where plan north points, in degrees clockwise from the top of the sheet. */
  north: number;
  /** The editing grid, in inches. */
  snapInches: number;
  outline: Pt[];
  zones: PlanZone[];
  rooms: PlanRoom[];
  walls: PlanWall[];
  doors: PlanDoor[];
  columns: PlanColumn[];
  fixtures: PlanFixture[];
  seats: PlanSeat[];
  dims: PlanDim[];
  labels: PlanLabel[];
}

/** Who holds a seat: a person, a reservation for a role or department, or a hot desk booked by the day. */
export type SeatHolder =
  | { kind: 'person'; userId: string }
  | { kind: 'reserved'; label: string; departmentId?: string | null }
  | { kind: 'hot'; departmentId?: string | null };
export type Holders = Record<string, SeatHolder>;

/** One line of a move plan: the seat, and who holds it once the plan applies (null: nobody). */
export interface SeatMove { seatId: string; to: SeatHolder | null }

/** What the plan does to a person (or a reservation): from one seat to another. */
export interface SeatChange { userId: string | null; label: string | null; from: string | null; to: string | null }

export type MovePlanStatus = 'draft' | 'scheduled' | 'applied' | 'undone';
export interface MovePlanView {
  id: string;
  status: MovePlanStatus;
  title: string;
  /** YYYY-MM-DD: the day the moves take effect. */
  effective: string;
  moves: SeatMove[];
  changes: SeatChange[];
  createdBy: string;
  createdAt: number;
  publishedAt: number | null;
  appliedAt: number | null;
  /** The revision it became. */
  rev: string | null;
}

export interface SeatRevision {
  rev: string;
  kind: 'layout' | 'moves' | 'undo' | 'seed';
  at: number;
  by: string | null;
  note: string;
  changes: SeatChange[];
  layoutVersion: number;
  planId: string | null;
}

/** Told once: "From Monday your seat is W-A14 · Left benches". */
export interface SeatNotice { planId: string; seatId: string | null; from: string | null; effective: string; label: string }

export interface SeatingView {
  plan: FloorPlan;
  version: number;
  holders: Holders;
  /** Drafts (editors only) and published plans still to take effect. */
  plans: MovePlanView[];
  revisions: SeatRevision[];
  canEdit: boolean;
  managers: string[];
  notice: SeatNotice | null;
  /** Hot desks booked for days from today: seat -> day -> person. */
  bookings: Array<{ seatId: string; day: string; userId: string }>;
  underlay: { x: number; y: number; w: number; h: number; opacity: number } | null;
}

export interface ImportRowMatch {
  line: number;
  raw: string;
  seatId: string;
  name: string;
  /** The person it matched for certain, or null (then pick from the suggestions). */
  userId: string | null;
  sure: boolean;
  suggestions: Array<{ userId: string; score: number }>;
  problem: string | null;
}

export const SEATING_LIMITS = { seats: 2000, walls: 4000, fixtures: 4000, rooms: 600, zones: 60, dims: 600, labels: 300, moves: 2000, label: 60, title: 120, note: 300, planBytes: 900_000, underlayBytes: 900_000 } as const;
/** Two seats closer than this (centre to centre, feet) overlap. */
export const SEAT_CLEARANCE = 1.6;
const SEAT_ID_RE = /^[A-Z][A-Z0-9]{0,5}(?:-[A-Z0-9]{1,6}){0,2}$/;

export const isSeatId = (v: unknown): v is string => typeof v === 'string' && v.length <= 16 && SEAT_ID_RE.test(v);
export const natural = (a: string, b: string): number => a.localeCompare(b, 'en', { numeric: true });

// ------------------------------------------------------------------ geometry helpers
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const snapTo = (v: number, inches: number): number => { const s = Math.max(1, inches) / 12; return Math.round(v / s) * s; };
/** The unit vector a seat faces (screen axes: y down). */
export const facingVec = (deg: number): Pt => { const a = (deg * Math.PI) / 180; return [Math.sin(a), -Math.cos(a)]; };

export function pointInPoly(x: number, y: number, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The four corners of a seat's desk (the desk in front of the chair). */
export function deskCorners(s: PlanSeat): Pt[] {
  const w = s.desk?.w ?? 4.03, d = s.desk?.d ?? 1.93;
  const [fx, fy] = facingVec(s.facing);
  const [px, py] = [-fy, fx];
  const near = 0.9, far = near + d;
  const c = (k: number, side: number): Pt => [s.x + fx * k + px * side * (w / 2), s.y + fy * k + py * side * (w / 2)];
  return [c(near, -1), c(near, 1), c(far, 1), c(far, -1)];
}

// ------------------------------------------------------------------ validating a plan
/** Problems with a plan, in words for an administrator. An empty list means it can be saved. */
export function validatePlan(p: unknown): string[] {
  const out: string[] = [];
  const plan = p as FloorPlan;
  if (!plan || typeof plan !== 'object') return ['The plan is empty.'];
  if (plan.v !== 1) out.push('The plan is not in a format this hub understands.');
  if (!finite(plan.width) || !finite(plan.height) || plan.width <= 0 || plan.height <= 0 || plan.width > 2000 || plan.height > 2000) out.push('The floor size is not right.');
  const arrays: Array<[keyof FloorPlan, number]> = [['seats', SEATING_LIMITS.seats], ['walls', SEATING_LIMITS.walls], ['fixtures', SEATING_LIMITS.fixtures], ['rooms', SEATING_LIMITS.rooms], ['zones', SEATING_LIMITS.zones], ['dims', SEATING_LIMITS.dims], ['labels', SEATING_LIMITS.labels], ['doors', SEATING_LIMITS.walls], ['columns', SEATING_LIMITS.walls], ['outline', 400]];
  for (const [k, max] of arrays) {
    const v = plan[k];
    if (!Array.isArray(v)) { out.push(`The plan has no ${k} list.`); continue; }
    if (v.length > max) out.push(`Too many ${k} (up to ${max}).`);
  }
  if (out.length) return out;
  const zones = new Set<string>();
  for (const z of plan.zones) {
    if (!z || typeof z.id !== 'string' || !z.id || typeof z.name !== 'string' || !z.name.trim()) { out.push('A zone has no name.'); continue; }
    if (zones.has(z.id)) out.push(`Zone ${z.id} appears twice.`);
    zones.add(z.id);
  }
  const ids = new Set<string>();
  const seats = plan.seats;
  for (const s of seats) {
    if (!s || !isSeatId(s.id)) { out.push(`"${String(s?.id ?? '').slice(0, 20)}" is not a seat ID (letters, digits and dashes, like W-A14).`); continue; }
    if (ids.has(s.id)) out.push(`Seat ${s.id} appears twice.`);
    ids.add(s.id);
    if (!finite(s.x) || !finite(s.y) || !finite(s.facing)) { out.push(`Seat ${s.id} has no position.`); continue; }
    if (s.x < -2 || s.y < -2 || s.x > plan.width + 2 || s.y > plan.height + 2) out.push(`Seat ${s.id} is outside the floor.`);
    if (!SEAT_TYPES.includes(s.type)) out.push(`Seat ${s.id} has an unknown type.`);
    if (!zones.has(s.zone)) out.push(`Seat ${s.id} is in a zone that does not exist.`);
    if (s.desk && (!finite(s.desk.w) || !finite(s.desk.d) || s.desk.w <= 0 || s.desk.d <= 0 || s.desk.w > 20 || s.desk.d > 20)) out.push(`Seat ${s.id} has a desk of the wrong size.`);
  }
  for (const [a, b] of overlappingSeats(seats)) out.push(`Seats ${a} and ${b} overlap.`);
  for (const r of plan.rooms) {
    if (!r || typeof r.name !== 'string' || !r.name.trim() || r.name.length > SEATING_LIMITS.label) out.push('A room has no name, or one that is too long.');
    else if (!Array.isArray(r.poly) || r.poly.length < 3 || !r.poly.every((q) => Array.isArray(q) && finite(q[0]) && finite(q[1]))) out.push(`Room "${r.name}" has no outline.`);
  }
  return out.slice(0, 50);
}

/** Pairs of seats whose chairs are on top of each other. A grid keeps it fast for big plans. */
export function overlappingSeats(seats: PlanSeat[], clearance = SEAT_CLEARANCE): Array<[string, string]> {
  const cell = new Map<string, PlanSeat[]>();
  const key = (x: number, y: number) => `${Math.floor(x / clearance)},${Math.floor(y / clearance)}`;
  const out: Array<[string, string]> = [];
  for (const s of seats) {
    if (!finite(s?.x) || !finite(s?.y)) continue;
    const cx = Math.floor(s.x / clearance), cy = Math.floor(s.y / clearance);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const o of cell.get(`${cx + dx},${cy + dy}`) ?? []) if (Math.hypot(o.x - s.x, o.y - s.y) < clearance) out.push([o.id, s.id]);
    }
    const k = key(s.x, s.y);
    (cell.get(k) ?? cell.set(k, []).get(k)!).push(s);
  }
  return out;
}

// ------------------------------------------------------------------ holders and moves
export const sameHolder = (a: SeatHolder | null | undefined, b: SeatHolder | null | undefined): boolean => {
  if (!a || !b) return !a && !b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'person') return a.userId === (b as typeof a).userId;
  if (a.kind === 'reserved') return a.label === (b as typeof a).label && (a.departmentId ?? null) === ((b as typeof a).departmentId ?? null);
  return (a.departmentId ?? null) === ((b as { departmentId?: string | null }).departmentId ?? null);
};

/** Where each person sits. */
export function seatOfPeople(h: Holders): Map<string, string> {
  const out = new Map<string, string>();
  for (const [seat, v] of Object.entries(h)) if (v.kind === 'person' && !out.has(v.userId)) out.set(v.userId, seat);
  return out;
}

/**
 * The holders once a plan's moves apply. Putting someone in a seat takes them out of any other seat
 * they held (unless the plan also says who holds that one), so a person is never in two places.
 */
export function applyMoves(h: Holders, moves: SeatMove[]): Holders {
  const out: Holders = { ...h };
  const named = new Set(moves.map((m) => m.seatId));
  for (const m of moves) {
    if (m.to?.kind === 'person') {
      const uid = m.to.userId;
      for (const [seat, v] of Object.entries(out)) if (seat !== m.seatId && !named.has(seat) && v.kind === 'person' && v.userId === uid) delete out[seat];
    }
  }
  for (const m of moves) { if (m.to) out[m.seatId] = m.to; else delete out[m.seatId]; }
  return out;
}

/** Problems with a plan's moves against a floor plan: unknown seats, a person in two seats. */
export function checkMoves(plan: FloorPlan, h: Holders, moves: SeatMove[]): string[] {
  const out: string[] = [];
  const ids = new Set(plan.seats.map((s) => s.id));
  const seen = new Set<string>();
  for (const m of moves) {
    if (!ids.has(m.seatId)) out.push(`There is no seat ${m.seatId} on the plan.`);
    if (seen.has(m.seatId)) out.push(`Seat ${m.seatId} is in the plan twice.`);
    seen.add(m.seatId);
  }
  const after = applyMoves(h, moves);
  const count = new Map<string, number>();
  for (const v of Object.values(after)) if (v.kind === 'person') count.set(v.userId, (count.get(v.userId) ?? 0) + 1);
  for (const [uid, n] of count) if (n > 1) out.push(`person:${uid} would hold ${n} seats.`);
  return out;
}

/** The changes a plan makes, person by person (and reservation by reservation), for the change list. */
export function diffHolders(before: Holders, after: Holders): SeatChange[] {
  const out: SeatChange[] = [];
  const b = seatOfPeople(before), a = seatOfPeople(after);
  for (const uid of new Set([...b.keys(), ...a.keys()])) {
    const from = b.get(uid) ?? null, to = a.get(uid) ?? null;
    if (from !== to) out.push({ userId: uid, label: null, from, to });
  }
  for (const seat of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const x = before[seat], y = after[seat];
    if (sameHolder(x, y)) continue;
    if (x && x.kind !== 'person') out.push({ userId: null, label: holderLabel(x), from: seat, to: null });
    if (y && y.kind !== 'person') out.push({ userId: null, label: holderLabel(y), from: null, to: seat });
  }
  return out.sort((p, q) => natural(p.to ?? p.from ?? '', q.to ?? q.from ?? ''));
}

export const holderLabel = (h: SeatHolder): string => (h.kind === 'reserved' ? h.label : h.kind === 'hot' ? 'Hot desk' : '');

/** Seats in reading order: by ID, numerically (W-A2 before W-A10). */
export const seatOrder = (a: { id: string }, b: { id: string }): number => natural(a.id, b.id);

/**
 * Put one person on a seat. If someone else holds it, the two swap (the other person takes the
 * mover's old seat, or no seat when the mover had none).
 */
export function placeMoves(h: Holders, userId: string, seatId: string): SeatMove[] {
  const mine = seatOfPeople(h).get(userId) ?? null;
  if (mine === seatId) return [];
  const there = h[seatId] ?? null;
  const moves: SeatMove[] = [{ seatId, to: { kind: 'person', userId } }];
  if (mine) moves.push({ seatId: mine, to: there && there.kind === 'person' ? there : null });
  return moves;
}

/** Swap whoever holds two seats. */
export function swapMoves(h: Holders, a: string, b: string): SeatMove[] {
  if (a === b) return [];
  return [{ seatId: a, to: h[b] ?? null }, { seatId: b, to: h[a] ?? null }];
}

/**
 * Flow people into the free seats of a set of seats (a zone, or a zone from a given seat on), in
 * seat order. Seats held by anyone in the group count as free (they are moving anyway); people who
 * already sit in the target stay where they are. Returns the moves and who did not fit.
 */
export function flowMoves(plan: FloorPlan, h: Holders, userIds: string[], target: { zoneId?: string; seatIds?: string[]; fromSeat?: string }): { moves: SeatMove[]; unplaced: string[] } {
  let seats = target.seatIds ? plan.seats.filter((s) => target.seatIds!.includes(s.id)) : plan.seats.filter((s) => s.zone === target.zoneId);
  seats = [...seats].sort(seatOrder);
  if (target.fromSeat) { const i = seats.findIndex((s) => s.id === target.fromSeat); if (i > 0) seats = [...seats.slice(i), ...seats.slice(0, i)]; }
  const group = new Set(userIds);
  const where = seatOfPeople(h);
  const inTarget = new Set(seats.map((s) => s.id));
  const staying = userIds.filter((u) => inTarget.has(where.get(u) ?? ''));
  const moving = userIds.filter((u) => !staying.includes(u));
  const free = seats.filter((s) => { const v = h[s.id]; return !v || (v.kind === 'person' && group.has(v.userId) && !staying.includes(v.userId)); });
  const moves: SeatMove[] = [];
  const unplaced: string[] = [];
  const taken = new Set<string>();
  for (const uid of moving) {
    const s = free.find((q) => !taken.has(q.id));
    if (!s) { unplaced.push(uid); continue; }
    taken.add(s.id);
    moves.push({ seatId: s.id, to: { kind: 'person', userId: uid } });
  }
  // seats the movers leave behind (outside the target) become free
  for (const uid of moving) {
    const old = where.get(uid);
    if (old && !inTarget.has(old) && !unplaced.includes(uid)) moves.push({ seatId: old, to: null });
  }
  // seats in the target freed by movers that nobody took
  for (const s of free) if (!taken.has(s.id) && h[s.id]) moves.push({ seatId: s.id, to: null });
  return { moves, unplaced };
}

/** Merge new moves into a plan's moves: a later line for a seat replaces the earlier one. */
export function mergeMoves(base: SeatMove[], add: SeatMove[]): SeatMove[] {
  const out = new Map(base.map((m) => [m.seatId, m] as const));
  // someone placed again: drop their earlier placement in the plan
  for (const m of add) if (m.to?.kind === 'person') { const uid = m.to.userId; for (const [k, v] of out) if (v.to?.kind === 'person' && v.to.userId === uid && k !== m.seatId) out.set(k, { seatId: k, to: null }); }
  for (const m of add) out.set(m.seatId, m);
  return [...out.values()];
}

/** Moves that change nothing against the current holders are dropped. */
export const effectiveMoves = (h: Holders, moves: SeatMove[]): SeatMove[] => moves.filter((m) => !sameHolder(h[m.seatId] ?? null, m.to));

// ------------------------------------------------------------------ revisions and labels
export function nextRevLetter(rev: string | null): string {
  if (!rev) return 'A';
  const chars = rev.toUpperCase().replace(/[^A-Z]/g, '').split('');
  if (!chars.length) return 'A';
  for (let i = chars.length - 1; i >= 0; i--) {
    if (chars[i] !== 'Z') { chars[i] = String.fromCharCode(chars[i].charCodeAt(0) + 1); return chars.join(''); }
    chars[i] = 'A';
  }
  return `A${chars.join('')}`;
}

/** "W-A14 · Left benches": what the directory shows as someone's seat. */
export function seatLabel(plan: FloorPlan, seatId: string): string {
  const s = plan.seats.find((q) => q.id === seatId);
  if (!s) return seatId;
  const zone = plan.zones.find((z) => z.id === s.zone)?.name;
  return zone ? `${s.id} · ${zone}` : s.id;
}

/** Seats whose holder differs between two revisions (for revision clouds). */
export function changedSeats(a: Holders, b: Holders): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !sameHolder(a[k], b[k])).sort(natural);
}

/** Seats added, removed or moved between two layouts. */
export function layoutChanges(a: FloorPlan, b: FloorPlan): { added: string[]; removed: string[]; moved: string[] } {
  const A = new Map(a.seats.map((s) => [s.id, s] as const)), B = new Map(b.seats.map((s) => [s.id, s] as const));
  const added = [...B.keys()].filter((k) => !A.has(k)).sort(natural);
  const removed = [...A.keys()].filter((k) => !B.has(k)).sort(natural);
  const moved = [...B.keys()].filter((k) => { const p = A.get(k), q = B.get(k)!; return p && (Math.abs(p.x - q.x) > 0.05 || Math.abs(p.y - q.y) > 0.05 || Math.round(p.facing) !== Math.round(q.facing)); }).sort(natural);
  return { added, removed, moved };
}

// ------------------------------------------------------------------ editing the layout (pure)
/** The next free number for a seat code: W-A -> W-A54 when W-A53 is the highest. */
export function nextSeatIds(plan: FloorPlan, code: string, n: number): string[] {
  const used = new Set(plan.seats.map((s) => s.id));
  const re = new RegExp(`^${code.replace(/[-]/g, '\\-')}(\\d+)$`);
  let max = 0, width = 2;
  for (const s of plan.seats) { const m = s.id.match(re); if (m) { max = Math.max(max, Number(m[1])); width = Math.max(width, m[1].length); } }
  const out: string[] = [];
  for (let i = max + 1; out.length < n && i < max + 10_000; i++) { const id = `${code}${String(i).padStart(width, '0')}`; if (!used.has(id)) out.push(id); }
  return out;
}

const groupName = (plan: FloorPlan, prefix: string): string => {
  const used = new Set(plan.seats.map((s) => s.group).filter(Boolean));
  for (let i = 1; i < 1000; i++) if (!used.has(`${prefix}${i}`)) return `${prefix}${i}`;
  return `${prefix}${Date.now() % 1000}`;
};

/**
 * A bench of n seats: two facing rows of desks (the north row facing south, the south row north),
 * the extra seat on the north row when n is odd. (x, y) is the bench's north-west corner.
 */
export function benchSeats(plan: FloorPlan, opts: { zone: string; code: string; x: number; y: number; n: number }): PlanSeat[] {
  const n = Math.max(1, Math.min(40, Math.round(opts.n)));
  const north = Math.ceil(n / 2), south = n - north;
  const ids = nextSeatIds(plan, opts.code, n);
  const group = groupName(plan, `${opts.zone}-new`);
  const out: PlanSeat[] = [];
  let k = 0;
  for (let i = 0; i < north; i++) out.push({ id: ids[k++], x: opts.x + 2.0 + i * 4.03, y: opts.y + 0.9, facing: 180, type: 'bench', zone: opts.zone, group });
  for (let i = 0; i < south; i++) out.push({ id: ids[k++], x: opts.x + 2.0 + i * 4.03, y: opts.y + 0.9 + 0.9 + 1.93 * 2 + 0.9, facing: 0, type: 'bench', zone: opts.zone, group });
  return out;
}

/** A pod of n seats round a centre, facing in (a hexagonal pod has 6). */
export function podSeats(plan: FloorPlan, opts: { zone: string; code: string; x: number; y: number; n?: number }): PlanSeat[] {
  const n = Math.max(3, Math.min(12, Math.round(opts.n ?? 6)));
  const ids = nextSeatIds(plan, opts.code, n);
  const group = groupName(plan, `${opts.zone}-pod`);
  const r = 3.4;
  return ids.map((id, i) => {
    const deg = (360 / n) * i;
    const [fx, fy] = facingVec(deg);
    return { id, x: opts.x + fx * r, y: opts.y + fy * r, facing: (deg + 180) % 360, type: 'pod' as const, zone: opts.zone, group };
  });
}

/** Turn seats about their centre by a number of degrees. */
export function rotateSeats(seats: PlanSeat[], deg: number): PlanSeat[] {
  if (!seats.length) return seats;
  const cx = seats.reduce((s, q) => s + q.x, 0) / seats.length, cy = seats.reduce((s, q) => s + q.y, 0) / seats.length;
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return seats.map((q) => ({ ...q, x: cx + (q.x - cx) * c - (q.y - cy) * s, y: cy + (q.x - cx) * s + (q.y - cy) * c, facing: (((q.facing + deg) % 360) + 360) % 360 }));
}

// ------------------------------------------------------------------ reading seats from text
const clean = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Lines of "seat → name" as people paste them or a CSV holds them: "W-A14, Priya Raman",
 * "W-A14 → Priya", "W-A14<tab>Priya", "Priya - W-A14". A header line is skipped.
 */
export function parseSeatList(text: string, plan: FloorPlan): Array<{ line: number; raw: string; seatId: string; name: string; problem: string | null }> {
  const ids = new Map(plan.seats.map((s) => [s.id.replace(/[^A-Z0-9]/gi, '').toUpperCase(), s.id] as const));
  const out: Array<{ line: number; raw: string; seatId: string; name: string; problem: string | null }> = [];
  const lines = text.replace(/\r/g, '').split('\n').slice(0, 3000);
  lines.forEach((raw0, i) => {
    const raw = raw0.trim();
    if (!raw || raw.startsWith('#')) return;
    const parts = raw.split(/\s*(?:\t|,|;|→|->|=>|\s-\s|:)\s*/).map((p) => p.replace(/^"|"$/g, '').trim()).filter(Boolean);
    if (!parts.length) return;
    let seatId = '', name = '';
    for (const p of parts) {
      const k = p.replace(/[^A-Z0-9]/gi, '').toUpperCase();
      if (!seatId && ids.has(k)) seatId = ids.get(k)!;
      else if (!name && !ids.has(k)) name = p;
    }
    if (i === 0 && !seatId && /seat/i.test(raw)) return; // a header
    if (!seatId) { out.push({ line: i + 1, raw, seatId: parts[0].slice(0, 16), name: (parts[1] ?? '').slice(0, 80), problem: 'No seat with that ID on the plan.' }); return; }
    out.push({ line: i + 1, raw, seatId, name: name.slice(0, 80), problem: name ? null : 'No name on this line.' });
  });
  return out;
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 9;
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
  }
  return d[b.length];
}

/**
 * How well a name as written ("Logesh M", "Anandh") fits a person in the directory, 0 to 1.
 * Every written word must match a word of their name (whole, as a prefix or initial, or one typo
 * away); a full match of the name or the Windows user name scores 1.
 */
export function nameScore(written: string, person: { displayName: string; account?: string }): number {
  const w = clean(written), n = clean(person.displayName);
  if (!w) return 0;
  if (w === n) return 1;
  const user = clean((person.account ?? '').split('\\').pop() ?? '');
  if (user && w.replace(/\s/g, '') === user.replace(/\s/g, '')) return 1;
  const wt = w.split(' '), nt = n.split(' ');
  let score = 0;
  const used = new Set<number>();
  for (const [i, t] of wt.entries()) {
    let best = 0, at = -1;
    nt.forEach((x, j) => {
      if (used.has(j)) return;
      let s = 0;
      if (x === t) s = 1;
      else if (t.length === 1 && x.startsWith(t)) s = 0.8;
      else if (t.length >= 3 && x.startsWith(t)) s = 0.85;
      else if (t.length >= 4 && editDistance(t, x) <= 1) s = 0.75;
      else if (t.length >= 6 && editDistance(t, x) <= 2) s = 0.6;
      if (s > best) { best = s; at = j; }
    });
    if (!best) return 0;
    used.add(at);
    score += best * (i === 0 ? 1.2 : 1);
  }
  const base = score / (wt.length + 0.2);
  // written words cover less of the full name: a little less sure
  const cover = wt.length / Math.max(wt.length, nt.length);
  return Math.min(0.97, base * (0.85 + 0.15 * cover));
}

/** Match a written name against the directory: sure when one person fits clearly, else suggestions. */
export function matchName(written: string, people: Array<{ id: string; displayName: string; account?: string }>): { userId: string | null; sure: boolean; suggestions: Array<{ userId: string; score: number }> } {
  const scored = people.map((p) => ({ userId: p.id, score: Math.round(nameScore(written, p) * 100) / 100 })).filter((s) => s.score >= 0.45).sort((a, b) => b.score - a.score);
  const top = scored[0];
  if (!top) return { userId: null, sure: false, suggestions: [] };
  const second = scored[1]?.score ?? 0;
  const sure = top.score >= 0.99 ? second < 0.99 : top.score >= 0.8 && top.score - second >= 0.15 && clean(written).split(' ').length >= 2;
  return { userId: sure ? top.userId : null, sure, suggestions: scored.slice(0, 4) };
}

/**
 * A seat from someone's old free-text "Seat or location", when it names one plainly: a seat ID
 * ("W-A14", "Desk WA14"), or a room that has exactly one seat ("MD's cabin 01", "Reception").
 */
export function seatFromText(text: string | null | undefined, plan: FloorPlan): string | null {
  const s = (text ?? '').trim();
  if (!s) return null;
  const norm = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const byKey = new Map(plan.seats.map((q) => [q.id.replace(/[^A-Z0-9]/g, ''), q.id] as const));
  const tokens = s.toUpperCase().split(/[\s,;/·|]+/).map((t) => t.replace(/[^A-Z0-9]/g, '')).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    if (byKey.has(tokens[i])) return byKey.get(tokens[i])!;
    if (i + 1 < tokens.length && byKey.has(tokens[i] + tokens[i + 1])) return byKey.get(tokens[i] + tokens[i + 1])!;
    if (i + 2 < tokens.length && byKey.has(tokens[i] + tokens[i + 1] + tokens[i + 2])) return byKey.get(tokens[i] + tokens[i + 1] + tokens[i + 2])!;
  }
  if (byKey.has(norm)) return byKey.get(norm)!;
  const name = clean(s);
  for (const r of plan.rooms) {
    if (clean(r.name) !== name) continue;
    const inRoom = plan.seats.filter((q) => q.room === r.id);
    if (inRoom.length === 1) return inRoom[0].id;
  }
  return null;
}

/** The YYYY-MM-DD of a time in the hub's (or app's) local zone. */
export const ymd = (t: number): string => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const isYmd = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00`));
/** The next Monday after a day (a move "from Monday"). */
export function nextMonday(t: number): string { const d = new Date(t); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return ymd(d.getTime()); }

declare module './protocol.ts' {
  interface Ops {
    /** The floor plan, who holds each seat, pending plans and revisions. Not for guests. */
    'seating.get': { req: void; res: SeatingView };
    /** A past revision: its holders and the layout it was drawn on (for comparing). */
    'seating.rev': { req: { rev: string }; res: { rev: SeatRevision; holders: Holders; plan: FloorPlan } };
    /** Write a draft move plan (editors). */
    'seating.draft': { req: { id?: string; title?: string; effective?: string; moves: SeatMove[] }; res: MovePlanView };
    'seating.discard': { req: { id: string }; res: { ok: true } };
    /** People (or a department) flowed into a zone's free seats: the moves, to preview before adding them. */
    'seating.flow': { req: { userIds?: string[]; departmentId?: string; zoneId?: string; seatIds?: string[]; fromSeat?: string }; res: { moves: SeatMove[]; changes: SeatChange[]; unplaced: string[] } };
    /** Publish a draft: it takes effect now, or on its effective date. Moved people are told once. */
    'seating.apply': { req: { id: string; effective?: string }; res: MovePlanView };
    /** Take back a plan: a scheduled one goes back to draft; an applied one is reversed (the latest only). */
    'seating.undo': { req: { id: string }; res: MovePlanView };
    /** Save an edited layout (editors). Seats that someone holds cannot be removed. */
    'seating.layout': { req: { plan: FloorPlan; baseVersion: number; note?: string }; res: { version: number; rev: string } };
    'seating.underlay': { req: { image?: string | null; x?: number; y?: number; w?: number; h?: number; opacity?: number }; res: { ok: true } };
    'seating.underlayImage': { req: void; res: { image: string | null } };
    /** Match "seat → name" lines against the directory (nothing is changed). */
    'seating.importMatch': { req: { text: string }; res: { rows: ImportRowMatch[] } };
    /** Seats from people's old free-text "Seat or location", where it names a seat plainly. */
    'seating.importProfiles': { req: void; res: { moves: SeatMove[]; skipped: Array<{ userId: string; location: string }> } };
    /** Book a hot desk for a day (today or up to two weeks ahead); null seat cancels my booking that day. */
    'seating.book': { req: { seatId: string | null; day: string }; res: { ok: true } };
    /** I have seen my seat notice. */
    'seating.seen': { req: { planId: string }; res: { ok: true } };
    'admin.seating.managers': { req: { userIds?: string[] }; res: { managers: string[] } };
  }
  interface Events {
    /** The plan, holders or pending plans changed: fetch seating.get again. */
    'seating.updated': { version: number; at: number };
  }
}
