// The real floor plan as a sheet: the office's drawing (from the hub, in feet) laid on the drafting
// sheet, with people on the seats they hold, the off-site key and people with no seat beside it, a
// walking route that goes round desks and through doors, and hit tests for seats. Pure: no DOM.
import type { FloorPlan, Holders, PlanSeat, PublicUser, SeatHolder, WorkMode } from '@dex/core';
import { deskCorners, pointInPoly, seatOfPeople } from '@dex/core';
import { MARGIN } from './layout.ts';
import type { Pt } from './layout.ts';
import type { Floor, Spot } from './floor.ts';

/** World units per foot. A bench desk (4'0") is 97 units, a tile 34: about the size of a person. */
export const K = 24;
/** Room round the building for dimension strings and the north point. */
const PAD = 200;

export interface PlanSeatView {
  seat: PlanSeat;
  /** The chair, in world units. */
  x: number;
  y: number;
  holder: SeatHolder | null;
  /** Who sits there today: the holder, or whoever booked the hot desk for today. */
  occupant: string | null;
  booked: string | null;
  /** The occupant works elsewhere today. */
  away: boolean;
  /** The department the seat belongs to today (its person's, or its reservation's). */
  dept: string | null;
}

export interface PlanModel {
  plan: FloorPlan;
  version: number;
  ox: number;
  oy: number;
  seats: PlanSeatView[];
  byId: Map<string, PlanSeatView>;
  /** person -> seat */
  seatOf: Map<string, string>;
}

export const wx = (m: { ox: number }, ft: number) => m.ox + ft * K;
export const wy = (m: { oy: number }, ft: number) => m.oy + ft * K;
export const toFt = (m: { ox: number; oy: number }, x: number, y: number): Pt => [(x - m.ox) / K, (y - m.oy) / K];

/**
 * Lay the plan on the sheet. `today` is YYYY-MM-DD for hot-desk bookings; `modeOf` says who works
 * elsewhere today (their seat is drawn dashed and they stand in the off-site key).
 */
export function planFloor(plan: FloorPlan, version: number, holders: Holders, people: PublicUser[], modeOf: (id: string) => WorkMode | null,
  bookings: Array<{ seatId: string; day: string; userId: string }>, today: string): Floor {
  const ox = MARGIN + PAD, oy = MARGIN + PAD;
  const known = new Set(people.map((u) => u.id));
  const byUser = new Map(people.map((u) => [u.id, u] as const));
  const bookedToday = new Map(bookings.filter((b) => b.day === today).map((b) => [b.seatId, b.userId] as const));
  const seatOf = seatOfPeople(holders);
  const isAway = (id: string) => { const m = modeOf(id); return m && m !== 'office' ? m : null; };
  const seats: PlanSeatView[] = plan.seats.map((seat) => {
    const holder = holders[seat.id] ?? null;
    const booked = holder?.kind === 'hot' ? bookedToday.get(seat.id) ?? null : null;
    let occupant = holder?.kind === 'person' ? holder.userId : booked;
    if (occupant && !known.has(occupant)) occupant = null;
    const dept = occupant ? byUser.get(occupant)?.profile.departmentId ?? null : holder && holder.kind !== 'person' ? holder.departmentId ?? null : null;
    return { seat, x: ox + seat.x * K, y: oy + seat.y * K, holder, occupant, booked, away: !!occupant && !!isAway(occupant), dept };
  });
  const byId = new Map(seats.map((s) => [s.seat.id, s] as const));
  const spots = new Map<string, Spot>();
  const awayIds = new Map<WorkMode, string[]>([['home', []], ['site', []], ['client', []]]);
  const unseated: string[] = [];
  const placed = new Set<string>();
  for (const s of seats) {
    if (!s.occupant || placed.has(s.occupant)) continue;
    placed.add(s.occupant);
    const m = isAway(s.occupant);
    if (m) { awayIds.get(m)!.push(s.occupant); continue; }
    spots.set(s.occupant, { id: s.occupant, x: s.x, y: s.y, where: 'desk', room: s.seat.zone, desk: s.seat.id });
  }
  for (const u of [...people].sort((a, b) => a.displayName.localeCompare(b.displayName))) {
    if (placed.has(u.id)) continue;
    const m = isAway(u.id);
    if (m) awayIds.get(m)!.push(u.id); else unseated.push(u.id);
  }
  const building = { x: ox, y: oy, w: plan.width * K, h: plan.height * K };
  // the off-site key, to the right of the building (past the east dimension string)
  const kx = building.x + building.w + PAD;
  let ky = building.y;
  const away: Floor['away'] = [];
  for (const mode of ['home', 'site', 'client'] as WorkMode[]) {
    const ids = awayIds.get(mode)!;
    const cols = 4;
    const h = 52 + Math.max(1, Math.ceil(ids.length / cols)) * 56;
    away.push({ mode, x: kx, y: ky, w: cols * 56 + 32, h, people: ids });
    ids.forEach((id, i) => spots.set(id, { id, x: kx + 44 + (i % cols) * 56, y: ky + 76 + Math.floor(i / cols) * 56, where: 'away', room: null, desk: byIdOf(seatOf, id) }));
    ky += h + 24;
  }
  // no seat on the plan: a strip under the building
  const uy = building.y + building.h + PAD;
  const ucols = Math.max(6, Math.floor((building.w - 32) / 56));
  const uh = unseated.length ? 52 + Math.ceil(unseated.length / ucols) * 56 : 0;
  unseated.forEach((id, i) => spots.set(id, { id, x: building.x + 44 + (i % ucols) * 56, y: uy + 76 + Math.floor(i / ucols) * 56, where: 'unseated', room: null, desk: null }));
  const w = kx + 4 * 56 + 32 + MARGIN + 40;
  const h = Math.max(ky, uy + uh) + MARGIN + 40;
  return {
    rooms: [], desks: [], spots, away, unseated: { x: building.x, y: uy, w: building.w, h: uh, people: unseated }, building, w, h,
    plan: { plan, version, ox, oy, seats, byId, seatOf: new Map([...seatOf].filter(([u]) => known.has(u))) },
  };
}
const byIdOf = (m: Map<string, string>, id: string) => m.get(id) ?? null;

/** The seat under a world point (the chair or its desk). */
export function hitSeat(m: PlanModel, x: number, y: number): PlanSeatView | null {
  const [fx, fy] = toFt(m, x, y);
  let best: PlanSeatView | null = null, d = 1.4;
  for (const s of m.seats) {
    const dd = Math.hypot(s.seat.x - fx, s.seat.y - fy);
    if (dd < d) { d = dd; best = s; }
  }
  if (best) return best;
  for (const s of m.seats) if (pointInPoly(fx, fy, deskCorners(s.seat))) return s;
  return null;
}

/** The room under a world point (for renaming it). */
export function hitRoom(m: PlanModel, x: number, y: number): string | null {
  const [fx, fy] = toFt(m, x, y);
  // smallest first: a half-cabin before the area round it
  const rooms = [...m.plan.rooms].sort((a, b) => area(a.poly) - area(b.poly));
  return rooms.find((r) => pointInPoly(fx, fy, r.poly))?.id ?? null;
}
const area = (p: Pt[]) => Math.abs(p.reduce((s, q, i) => { const n = p[(i + 1) % p.length]; return s + q[0] * n[1] - n[0] * q[1]; }, 0) / 2);

/** The nearest seat in a direction (arrow keys over seats, in arrange mode). */
export function nearestSeat(m: PlanModel, from: string, dir: 'up' | 'down' | 'left' | 'right'): string | null {
  const a = m.byId.get(from);
  if (!a) return m.seats[0]?.seat.id ?? null;
  let best: string | null = null, score = Infinity;
  for (const b of m.seats) {
    if (b === a) continue;
    const dx = b.x - a.x, dy = b.y - a.y;
    const along = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy;
    const across = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
    if (along <= 4) continue;
    const s = along + across * 2.5;
    if (s < score) { score = s; best = b.seat.id; }
  }
  return best;
}

// ------------------------------------------------------------------ walking: round desks, through doors
const CELL = 0.5;
interface Grid { w: number; h: number; blocked: Uint8Array }
const grids = new WeakMap<FloorPlan, Grid>();

function gridFor(plan: FloorPlan): Grid {
  const hit = grids.get(plan);
  if (hit) return hit;
  const w = Math.ceil(plan.width / CELL) + 1, h = Math.ceil(plan.height / CELL) + 1;
  const blocked = new Uint8Array(w * h);
  const mark = (x0: number, y0: number, x1: number, y1: number) => {
    for (let gy = Math.max(0, Math.floor(Math.min(y0, y1) / CELL)); gy <= Math.min(h - 1, Math.floor(Math.max(y0, y1) / CELL)); gy++)
      for (let gx = Math.max(0, Math.floor(Math.min(x0, x1) / CELL)); gx <= Math.min(w - 1, Math.floor(Math.max(x0, x1) / CELL)); gx++) blocked[gy * w + gx] = 1;
  };
  const markPoly = (p: Pt[], grow = 0.3) => {
    const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]);
    for (let gy = Math.max(0, Math.floor((Math.min(...ys) - grow) / CELL)); gy <= Math.min(h - 1, Math.ceil((Math.max(...ys) + grow) / CELL)); gy++)
      for (let gx = Math.max(0, Math.floor((Math.min(...xs) - grow) / CELL)); gx <= Math.min(w - 1, Math.ceil((Math.max(...xs) + grow) / CELL)); gx++) {
        const cx = gx * CELL, cy = gy * CELL;
        if (pointInPoly(cx, cy, p) || [[grow, 0], [-grow, 0], [0, grow], [0, -grow]].some(([dx, dy]) => pointInPoly(cx + dx, cy + dy, p))) blocked[gy * w + gx] = 1;
      }
  };
  const seg = (a: Pt, b: Pt, t: number) => {
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (CELL / 2)));
    const r = t / 2 + 0.35;
    for (let i = 0; i <= n; i++) { const x = a[0] + ((b[0] - a[0]) * i) / n, y = a[1] + ((b[1] - a[1]) * i) / n; mark(x - r, y - r, x + r, y + r); }
  };
  for (const wl of plan.walls) {
    if (wl.a && wl.b) seg(wl.a, wl.b, wl.t);
    else if (wl.arc) { const { c, r, a0, a1 } = wl.arc; let prev: Pt | null = null; for (let k = 0; k <= 12; k++) { const a = ((a0 + ((a1 - a0) * k) / 12) * Math.PI) / 180; const p: Pt = [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]; if (prev) seg(prev, p, wl.t); prev = p; } }
  }
  for (const c of plan.columns) mark(c.x - 0.3, c.y - 0.3, c.x + c.w + 0.3, c.y + c.h + 0.3);
  for (const f of plan.fixtures) {
    if (f.kind === 'poly' && f.pts) markPoly(f.pts, 0.2);
    else if ((f.kind === 'table' || f.kind === 'counter' || f.kind === 'sofa' || f.kind === 'printer' || f.kind === 'planter' || f.kind === 'box') && f.x !== undefined && f.y !== undefined && f.w && f.h) mark(f.x - 0.2, f.y - 0.2, f.x + f.w + 0.2, f.y + f.h + 0.2);
    else if (f.kind === 'round' && f.x !== undefined && f.y !== undefined) mark(f.x - (f.r ?? 1), f.y - (f.r ?? 1), f.x + (f.r ?? 1), f.y + (f.r ?? 1));
  }
  for (const s of plan.seats) markPoly(deskCorners(s), 0.15);
  const g = { w, h, blocked };
  grids.set(plan, g);
  return g;
}

/**
 * The walk between two points of the plan (feet), as a polyline in feet: A* over half-foot cells,
 * then straightened where the way is clear. When the end is shut in (a closed cabin), the walk
 * ends at the nearest point it can reach.
 */
export function walkFeet(plan: FloorPlan, from: Pt, to: Pt): Pt[] | null {
  const g = gridFor(plan);
  const idx = (p: Pt) => { const gx = Math.max(0, Math.min(g.w - 1, Math.round(p[0] / CELL))), gy = Math.max(0, Math.min(g.h - 1, Math.round(p[1] / CELL))); return gy * g.w + gx; };
  const s = idx(from), t = idx(to);
  // the chairs themselves are free, and a little round them
  const free = new Set<number>();
  for (const c of [s, t]) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const x = (c % g.w) + dx, y = Math.floor(c / g.w) + dy; if (x >= 0 && y >= 0 && x < g.w && y < g.h) free.add(y * g.w + x); }
  const open = (i: number) => !g.blocked[i] || free.has(i);
  const tx = t % g.w, ty = Math.floor(t / g.w);
  const hcost = (i: number) => { const dx = Math.abs((i % g.w) - tx), dy = Math.abs(Math.floor(i / g.w) - ty); return Math.max(dx, dy) + 0.414 * Math.min(dx, dy); };
  const gcost = new Float32Array(g.w * g.h).fill(Infinity);
  const came = new Int32Array(g.w * g.h).fill(-1);
  const heap: Array<[number, number]> = [];
  const push = (f: number, i: number) => { heap.push([f, i]); let k = heap.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
  const pop = (): number => { const top = heap[0]; const last = heap.pop()!; if (heap.length) { heap[0] = last; let k = 0; for (;;) { const l = k * 2 + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } } return top[1]; };
  gcost[s] = 0;
  push(hcost(s), s);
  let best = s, bestH = hcost(s), steps = 0;
  while (heap.length && steps++ < 200_000) {
    const i = pop();
    if (i === t) { best = t; break; }
    const hc = hcost(i);
    if (hc < bestH) { bestH = hc; best = i; }
    const x = i % g.w, y = Math.floor(i / g.w);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= g.w || ny >= g.h) continue;
      const j = ny * g.w + nx;
      if (!open(j)) continue;
      // no cutting a corner through a wall
      if (dx && dy && (!open(y * g.w + nx) || !open(ny * g.w + x))) continue;
      const c = gcost[i] + (dx && dy ? 1.414 : 1);
      if (c < gcost[j]) { gcost[j] = c; came[j] = i; push(c + hcost(j), j); }
    }
  }
  const cells: number[] = [];
  for (let i = best; i !== -1; i = came[i]) cells.push(i);
  cells.reverse();
  if (!cells.length) return null;
  const pts: Pt[] = cells.map((i) => [(i % g.w) * CELL, Math.floor(i / g.w) * CELL]);
  // straighten: keep a point only where the line of sight from the last kept one is blocked
  const clear = (a: Pt, b: Pt) => {
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (CELL / 2));
    for (let k = 1; k < n; k++) { const i = idx([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]); if (!open(i)) return false; }
    return true;
  };
  const out: Pt[] = [from];
  let anchor: Pt = from;
  for (let k = 1; k < pts.length; k++) if (!clear(anchor, pts[k])) { anchor = pts[k - 1]; out.push(anchor); }
  out.push(best === t ? to : pts[pts.length - 1]);
  return out;
}

/**
 * Whether new seats stand clear of walls, columns and furniture (and of the desks already there):
 * their chairs and desks fall on open floor.
 */
export function standsClear(plan: FloorPlan, seats: PlanSeat[]): boolean {
  const g = gridFor(plan);
  const open = (x: number, y: number) => { const gx = Math.round(x / CELL), gy = Math.round(y / CELL); return gx >= 0 && gy >= 0 && gx < g.w && gy < g.h && !g.blocked[gy * g.w + gx]; };
  return seats.every((q) => open(q.x, q.y) && deskCorners(q).every(([x, y]) => open(x, y)));
}

/** Where someone with no seat starts a walk: just inside the entrance. */
export function entrance(plan: FloorPlan): Pt {
  const d = plan.doors.find((x) => x.kind === 'entrance');
  return d ? [d.hinge[0] + (d.closed[0] - d.hinge[0]), d.hinge[1] + 3] : [plan.width / 2, 2];
}

/** The walk on the sheet (world units) from one person (or the entrance) to a person or a seat. */
export function planWalk(f: Floor, from: string, to: { id?: string; seat?: string }, startAt?: string): Pt[] | null {
  const m = f.plan;
  if (!m) return null;
  const at = (id: string): Pt | null => { const sp = f.spots.get(id); if (sp && sp.where === 'desk') return toFt(m, sp.x, sp.y); return null; };
  const fromSeat = startAt && startAt !== 'entrance' ? m.byId.get(startAt) : null;
  const start: Pt = startAt === 'entrance' ? entrance(m.plan) : fromSeat ? [fromSeat.seat.x, fromSeat.seat.y]
    : at(from) ?? (() => { const seat = m.seatOf.get(from); const s = seat ? m.byId.get(seat) : null; return s ? [s.seat.x, s.seat.y] as Pt : entrance(m.plan); })();
  let end: Pt | null = null;
  if (to.seat) { const s = m.byId.get(to.seat); if (s) end = [s.seat.x, s.seat.y]; }
  else if (to.id) end = at(to.id);
  if (!end) return null;
  const ft = walkFeet(m.plan, start, end);
  return ft ? ft.map(([x, y]) => [wx(m, x), wy(m, y)] as Pt) : null;
}
