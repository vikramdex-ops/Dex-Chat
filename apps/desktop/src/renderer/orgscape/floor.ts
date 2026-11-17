// The floor plan: the office drawn from where people sit ("Bay 2, Desk 4", "Cabin 1"), with who is
// in today. Bays are rooms of benched desks along one side of a corridor; cabins and other named
// places (front office, server room) along the other. People working elsewhere today (home, site,
// a client's office) leave their desk drawn dashed and stand in the off-site key beside the plan.
// Pure: no DOM, so it can be tested.
import type { PublicUser, WorkMode } from '@dex/core';
import { MARGIN } from './layout.ts';
import type { PlanModel } from './plan.ts';

export type Seat =
  | { kind: 'bay'; bay: string; desk: number | null }
  | { kind: 'cabin'; name: string }
  | { kind: 'place'; name: string };

/** Read a seat or location as people type it. Sites ("Site — Dahej") are places, not seats. */
export function parseSeat(loc: string | null | undefined): Seat | null {
  const s = (loc ?? '').trim();
  if (!s) return null;
  const bay = s.match(/\bbay\s*[-#:.]?\s*([a-z]?\d+[a-z]?|[a-z])\b/i);
  if (bay) {
    const desk = s.match(/\b(?:desk|seat|d)\s*[-#:.]?\s*(\d{1,3})\b/i);
    return { kind: 'bay', bay: bay[1].toUpperCase(), desk: desk ? Number(desk[1]) : null };
  }
  const cabin = s.match(/\bcabin\s*[-#:.]?\s*([a-z0-9]+)\b/i);
  if (cabin) return { kind: 'cabin', name: cabin[1].toUpperCase() };
  return { kind: 'place', name: s.slice(0, 40) };
}

export const DESK_W = 120;
export const DESK_H = 84;
const ROOM_PAD = 28;
const CABIN_W = 168;
const CABIN_H = 150;
const CORRIDOR = 96;
const WALL_GAP = 18;
export const TILE = 34;

export interface Room { key: string; kind: 'bay' | 'cabin' | 'place'; name: string; x: number; y: number; w: number; h: number; door: { x: number; side: 'top' | 'bottom' } }
export interface Desk { room: string; label: string; x: number; y: number; w: number; h: number; occupant: string | null; facing: 'up' | 'down' }
/** Where someone's tile is drawn, and why. */
export interface Spot { id: string; x: number; y: number; where: 'desk' | 'cabin' | 'place' | 'away' | 'unseated'; room: string | null; desk: string | null }

export interface Floor {
  rooms: Room[];
  desks: Desk[];
  spots: Map<string, Spot>;
  /** The off-site key: Home, Site, Client, each with its people. */
  away: Array<{ mode: WorkMode; x: number; y: number; w: number; h: number; people: string[] }>;
  /** People with no seat set. */
  unseated: { x: number; y: number; w: number; h: number; people: string[] };
  building: { x: number; y: number; w: number; h: number };
  w: number;
  h: number;
  /** The office's real floor plan, when the hub has one (plan.ts); otherwise the sheet is generated from seats. */
  plan?: PlanModel;
}

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/**
 * Lay out the floor. `modeOf` says where someone works from today, when they started their day;
 * anyone working from home, a site or a client's office is shown in the off-site key.
 */
export function layoutFloor(people: PublicUser[], modeOf: (id: string) => WorkMode | null): Floor {
  const bays = new Map<string, Array<{ id: string; desk: number | null }>>();
  const cabins = new Map<string, string[]>();
  const places = new Map<string, string[]>();
  const unseated: string[] = [];
  const seatOf = new Map<string, Seat>();
  const byName = [...people].sort((a, b) => a.displayName.localeCompare(b.displayName));
  for (const u of byName) {
    const s = parseSeat(u.profile.location);
    if (!s) { unseated.push(u.id); continue; }
    seatOf.set(u.id, s);
    if (s.kind === 'bay') (bays.get(s.bay) ?? bays.set(s.bay, []).get(s.bay)!).push({ id: u.id, desk: s.desk });
    else if (s.kind === 'cabin') (cabins.get(s.name) ?? cabins.set(s.name, []).get(s.name)!).push(u.id);
    else {
      const key = s.name.toLowerCase();
      (places.get(key) ?? places.set(key, []).get(key)!).push(u.id);
    }
  }
  const rooms: Room[] = [];
  const desks: Desk[] = [];
  const spots = new Map<string, Spot>();
  const awayIds = new Map<WorkMode, string[]>([['home', []], ['site', []], ['client', []]]);
  const isAway = (id: string) => { const m = modeOf(id); return m && m !== 'office' ? m : null; };

  // the top row: bays, benched desks in pairs facing each other
  const top = MARGIN + 40;
  let x = MARGIN + 40;
  let bayH = 0;
  for (const name of [...bays.keys()].sort(natural)) {
    const list = bays.get(name)!;
    // numbered desks keep their number; the rest take the next free ones
    const taken = new Map<number, string>();
    for (const p of list) if (p.desk && p.desk <= 400 && !taken.has(p.desk)) taken.set(p.desk, p.id);
    let next = 1;
    for (const p of list) {
      if (p.desk && taken.get(p.desk) === p.id) continue;
      while (taken.has(next)) next++;
      taken.set(next, p.id);
    }
    const count = Math.max(2, ...taken.keys());
    const pairs = Math.ceil(count / 2);
    const w = ROOM_PAD * 2 + pairs * DESK_W;
    const h = ROOM_PAD * 2 + DESK_H * 2 + 40;
    bayH = Math.max(bayH, h);
    const key = `bay:${name}`;
    rooms.push({ key, kind: 'bay', name, x, y: top, w, h, door: { x: x + w / 2, side: 'bottom' } });
    for (let k = 1; k <= count; k++) {
      const col = Math.floor((k - 1) / 2), row = (k - 1) % 2;
      const dx = x + ROOM_PAD + col * DESK_W, dy = top + ROOM_PAD + 20 + row * DESK_H;
      const occupant = taken.get(k) ?? null;
      desks.push({ room: key, label: `D${k}`, x: dx, y: dy, w: DESK_W, h: DESK_H, occupant, facing: row === 0 ? 'down' : 'up' });
      if (occupant) {
        const m = isAway(occupant);
        if (m) awayIds.get(m)!.push(occupant);
        else spots.set(occupant, { id: occupant, x: dx + DESK_W / 2, y: dy + (row === 0 ? 30 : 46), where: 'desk', room: key, desk: `D${k}` });
      }
    }
    x += w + WALL_GAP;
  }
  const rowW1 = x - WALL_GAP - (MARGIN + 40);
  bayH = bayH || 160;

  // the bottom row: cabins, then other named places
  const bottom = top + bayH + CORRIDOR;
  x = MARGIN + 40;
  let lowH = 0;
  for (const name of [...cabins.keys()].sort(natural)) {
    const ids = cabins.get(name)!;
    const key = `cabin:${name}`;
    const h = CABIN_H + Math.max(0, ids.length - 1) * 44;
    lowH = Math.max(lowH, h);
    rooms.push({ key, kind: 'cabin', name, x, y: bottom, w: CABIN_W, h, door: { x: x + CABIN_W / 2, side: 'top' } });
    ids.forEach((id, i) => {
      const m = isAway(id);
      if (m) awayIds.get(m)!.push(id);
      else spots.set(id, { id, x: x + CABIN_W / 2, y: bottom + CABIN_H / 2 + 6 + i * 44, where: 'cabin', room: key, desk: null });
    });
    x += CABIN_W + WALL_GAP;
  }
  for (const [key0, ids] of [...places.entries()].sort((a, b) => natural(a[0], b[0]))) {
    const label = seatOf.get(ids[0]) as { name: string };
    // a site is not a room in the office: its people go to the off-site key
    if (/\bsite\b/i.test(label.name)) { for (const id of ids) awayIds.get('site')!.push(id); continue; }
    const cols = Math.min(ids.length, 3);
    const w = Math.max(CABIN_W, ROOM_PAD * 2 + cols * 64);
    const h = Math.max(CABIN_H, ROOM_PAD * 2 + 36 + Math.ceil(ids.length / 3) * 64);
    lowH = Math.max(lowH, h);
    const key = `place:${key0}`;
    rooms.push({ key, kind: 'place', name: label.name, x, y: bottom, w, h, door: { x: x + w / 2, side: 'top' } });
    ids.forEach((id, i) => {
      const m = isAway(id);
      if (m) awayIds.get(m)!.push(id);
      else spots.set(id, { id, x: x + ROOM_PAD + 32 + (i % 3) * 64 + (w - ROOM_PAD * 2 - cols * 64) / 2, y: bottom + ROOM_PAD + 52 + Math.floor(i / 3) * 64, where: 'place', room: key, desk: null });
    });
    x += w + WALL_GAP;
  }
  const rowW2 = x - WALL_GAP - (MARGIN + 40);
  lowH = lowH || 0;
  const bw = Math.max(rowW1, rowW2, 480) + 80;
  const bh = bayH + CORRIDOR + lowH + 80;
  const building = { x: MARGIN, y: MARGIN, w: bw, h: lowH ? bh : bayH + CORRIDOR + 40 };

  // the off-site key, to the right of the building
  const kx = building.x + building.w + 80;
  let ky = MARGIN;
  const away: Floor['away'] = [];
  for (const mode of ['home', 'site', 'client'] as WorkMode[]) {
    const ids = awayIds.get(mode)!;
    const cols = 4;
    const h = 52 + Math.max(1, Math.ceil(ids.length / cols)) * 56;
    away.push({ mode, x: kx, y: ky, w: cols * 56 + 32, h, people: ids });
    ids.forEach((id, i) => spots.set(id, { id, x: kx + 16 + 28 + (i % cols) * 56, y: ky + 52 + 24 + Math.floor(i / cols) * 56, where: 'away', room: null, desk: null }));
    ky += h + 24;
  }
  // no seat set: a strip under the building
  const uy = building.y + building.h + 60;
  const ucols = Math.max(6, Math.floor((building.w - 32) / 56));
  const uh = unseated.length ? 52 + Math.ceil(unseated.length / ucols) * 56 : 0;
  unseated.forEach((id, i) => spots.set(id, { id, x: building.x + 16 + 28 + (i % ucols) * 56, y: uy + 52 + 24 + Math.floor(i / ucols) * 56, where: 'unseated', room: null, desk: null }));
  const w = kx + 4 * 56 + 32 + MARGIN;
  const h = Math.max(ky, uy + uh) + MARGIN;
  return { rooms, desks, spots, away, unseated: { x: building.x, y: uy, w: building.w, h: uh, people: unseated }, building, w, h };
}

/** The nearest spot in a direction, for moving round the plan with the arrow keys. */
export function nearestSpot(from: string, dir: 'up' | 'down' | 'left' | 'right', floor: Floor): string | null {
  const a = floor.spots.get(from);
  if (!a) return null;
  let best: string | null = null, score = Infinity;
  for (const b of floor.spots.values()) {
    if (b.id === from) continue;
    const dx = b.x - a.x, dy = b.y - a.y;
    const along = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy;
    const across = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
    if (along <= 4) continue;
    const s = along + across * 2.5;
    if (s < score) { score = s; best = b.id; }
  }
  return best;
}
