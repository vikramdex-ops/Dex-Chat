// The layout editor's state: a working copy of the plan, the selection, and undo/redo. Every change
// goes through edit(), which keeps the step for Undo; validation runs on the copy as it changes.
// Pure: no DOM, so it can be tested.
import type { FloorPlan, PlanSeat } from '@dex/core';
import { standsClear } from '../plan.ts';
import { benchSeats, isSeatId, nextSeatIds, overlappingSeats, podSeats, rotateSeats, snapTo, validatePlan } from '@dex/core';

export interface EditorState {
  plan: FloorPlan;
  /** The version it was opened from (a save against a newer version is refused). */
  base: number;
  sel: string[];
  room: string | null;
  undo: FloorPlan[];
  redo: FloorPlan[];
  dirty: boolean;
}

export type EditorAction =
  | { t: 'open'; plan: FloorPlan; base: number }
  | { t: 'select'; ids: string[]; add?: boolean }
  | { t: 'selectGroup'; id: string }
  | { t: 'room'; id: string | null }
  | { t: 'move'; dx: number; dy: number; snap?: boolean }
  /** A drag in progress: from where the seats were when it began. */
  | { t: 'dragTo'; origin: FloorPlan; dx: number; dy: number }
  | { t: 'set'; id: string; patch: Partial<PlanSeat> }
  | { t: 'rotate'; deg: number }
  | { t: 'duplicate' }
  | { t: 'delete' }
  | { t: 'addBench'; zone: string; n: number; x: number; y: number }
  | { t: 'addPod'; zone: string; n: number; x: number; y: number }
  | { t: 'renameRoom'; id: string; name: string }
  | { t: 'undo' }
  | { t: 'redo' }
  | { t: 'saved'; base: number }
  | { t: 'close' };

const MAX_STEPS = 80;
const zoneCode = (plan: FloorPlan, zone: string): string => {
  const z = plan.zones.find((q) => q.id === zone);
  const code = z?.code ?? zone;
  return /\d$/.test(code) ? `${code}-` : code;
};

function edit(s: EditorState, next: FloorPlan, sel = s.sel): EditorState {
  return { ...s, plan: next, sel, undo: [...s.undo, s.plan].slice(-MAX_STEPS), redo: [], dirty: true };
}

function mapSel(plan: FloorPlan, sel: string[], f: (q: PlanSeat[]) => PlanSeat[]): FloorPlan {
  const picked = plan.seats.filter((q) => sel.includes(q.id));
  const changed = new Map(f(picked).map((q) => [q.id, q] as const));
  return { ...plan, seats: plan.seats.map((q) => changed.get(q.id) ?? q) };
}

export function editorReducer(s: EditorState | null, a: EditorAction): EditorState | null {
  if (a.t === 'close') return null;
  if (a.t === 'open') return { plan: structuredClone(a.plan), base: a.base, sel: [], room: null, undo: [], redo: [], dirty: false };
  if (!s) return s;
  const snap = s.plan.snapInches || 3;
  switch (a.t) {
    case 'select': {
      const ids = a.ids.filter((id) => s.plan.seats.some((q) => q.id === id));
      return { ...s, room: null, sel: a.add ? [...new Set(s.sel.includes(ids[0]) && ids.length === 1 ? s.sel.filter((x) => x !== ids[0]) : [...s.sel, ...ids])] : ids };
    }
    case 'selectGroup': {
      const g = s.plan.seats.find((q) => q.id === a.id)?.group;
      return { ...s, room: null, sel: g ? s.plan.seats.filter((q) => q.group === g).map((q) => q.id) : [a.id] };
    }
    case 'room':
      return { ...s, room: a.id, sel: [] };
    case 'move': {
      if (!s.sel.length) return s;
      const dx = a.snap === false ? a.dx : snapTo(a.dx, snap), dy = a.snap === false ? a.dy : snapTo(a.dy, snap);
      return edit(s, mapSel(s.plan, s.sel, (q) => q.map((x) => ({ ...x, x: round(x.x + dx), y: round(x.y + dy) }))));
    }
    case 'dragTo': {
      const dx = snapTo(a.dx, snap), dy = snapTo(a.dy, snap);
      const next = mapSel(a.origin, s.sel, (q) => q.map((x) => ({ ...x, x: round(x.x + dx), y: round(x.y + dy) })));
      // one undo step for the whole drag: the step is the plan before the drag began
      return { ...s, plan: next, undo: s.undo[s.undo.length - 1] === a.origin ? s.undo : [...s.undo, a.origin].slice(-MAX_STEPS), redo: [], dirty: true };
    }
    case 'set': {
      const cur = s.plan.seats.find((q) => q.id === a.id);
      if (!cur) return s;
      const patch = { ...a.patch };
      if (patch.id !== undefined) {
        patch.id = patch.id.trim().toUpperCase();
        if (!isSeatId(patch.id)) return s;
      }
      if (patch.x !== undefined) patch.x = round(patch.x);
      if (patch.y !== undefined) patch.y = round(patch.y);
      if (patch.facing !== undefined) patch.facing = ((Math.round(patch.facing) % 360) + 360) % 360;
      const next = { ...s.plan, seats: s.plan.seats.map((q) => (q.id === a.id ? { ...q, ...patch } : q)) };
      return edit(s, next, s.sel.map((x) => (x === a.id && patch.id ? patch.id : x)));
    }
    case 'rotate':
      if (!s.sel.length) return s;
      return edit(s, mapSel(s.plan, s.sel, (q) => rotateSeats(q, a.deg).map((x) => ({ ...x, x: round(x.x), y: round(x.y) }))));
    case 'duplicate': {
      if (!s.sel.length) return s;
      const picked = s.plan.seats.filter((q) => s.sel.includes(q.id));
      let plan = s.plan;
      const copies: PlanSeat[] = [];
      const groups = new Map<string, string>();
      for (const q of picked) {
        const [id] = nextSeatIds({ ...plan, seats: [...plan.seats, ...copies] }, zoneCode(plan, q.zone), 1);
        const g = q.group ? groups.get(q.group) ?? `${q.group}-copy${Date.now() % 1000}` : undefined;
        if (q.group && g) groups.set(q.group, g);
        copies.push({ ...q, id, x: round(q.x + 6), y: round(q.y + 6), ...(g ? { group: g } : {}) });
      }
      plan = { ...plan, seats: [...plan.seats, ...copies] };
      return edit(s, plan, copies.map((q) => q.id));
    }
    case 'delete':
      if (!s.sel.length) return s;
      return edit(s, { ...s.plan, seats: s.plan.seats.filter((q) => !s.sel.includes(q.id)) }, []);
    case 'addBench': {
      const seats = freeSpot(s.plan, (x, y) => benchSeats(s.plan, { zone: a.zone, code: zoneCode(s.plan, a.zone), x: snapTo(x, snap), y: snapTo(y, snap), n: a.n }), a.x, a.y);
      return edit(s, { ...s.plan, seats: [...s.plan.seats, ...seats] }, seats.map((q) => q.id));
    }
    case 'addPod': {
      const code = s.plan.zones.find((z) => z.id === a.zone)?.code === 'POD' ? `POD${podNumber(s.plan)}-` : zoneCode(s.plan, a.zone);
      const seats = freeSpot(s.plan, (x, y) => podSeats(s.plan, { zone: a.zone, code, x: snapTo(x, snap), y: snapTo(y, snap), n: a.n }), a.x, a.y);
      return edit(s, { ...s.plan, seats: [...s.plan.seats, ...seats] }, seats.map((q) => q.id));
    }
    case 'renameRoom': {
      const name = a.name.replace(/[\u0000-\u001f]/g, ' ').slice(0, 60);
      if (!name.trim()) return s;
      return { ...edit(s, { ...s.plan, rooms: s.plan.rooms.map((r) => (r.id === a.id ? { ...r, name } : r)) }, []), room: a.id };
    }
    case 'undo': {
      const prev = s.undo[s.undo.length - 1];
      if (!prev) return s;
      return { ...s, plan: prev, undo: s.undo.slice(0, -1), redo: [...s.redo, s.plan], sel: s.sel.filter((id) => prev.seats.some((q) => q.id === id)), dirty: true };
    }
    case 'redo': {
      const next = s.redo[s.redo.length - 1];
      if (!next) return s;
      return { ...s, plan: next, redo: s.redo.slice(0, -1), undo: [...s.undo, s.plan], sel: s.sel.filter((id) => next.seats.some((q) => q.id === id)), dirty: true };
    }
    case 'saved':
      return { ...s, base: a.base, dirty: false, undo: [], redo: [] };
  }
  return s;
}

const round = (v: number) => Math.round(v * 100) / 100;

/**
 * New seats where asked, or, when they would sit on other seats, at the nearest place round it
 * (a widening square of one-foot steps) where they fit inside the floor.
 */
function freeSpot(plan: FloorPlan, make: (x: number, y: number) => PlanSeat[], x0: number, y0: number): PlanSeat[] {
  const fits = (seats: PlanSeat[]) => seats.every((q) => q.x > 1 && q.y > 1 && q.x < plan.width - 1 && q.y < plan.height - 1) && standsClear(plan, seats)
    && !overlappingSeats([...plan.seats, ...seats]).some(([a, b]) => seats.some((q) => q.id === a || q.id === b) && !(seats.some((q) => q.id === a) && seats.some((q) => q.id === b)));
  for (let r = 0; r <= 40; r++) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const seats = make(x0 + dx, y0 + dy);
      if (fits(seats)) return seats;
    }
  }
  return make(x0, y0);
}
const podNumber = (plan: FloorPlan) => { let n = 1; while (plan.seats.some((q) => q.id.startsWith(`POD${n}-`))) n++; return n; };

/** What is wrong with the working copy: problems in words, and the seats to mark. */
export function problems(plan: FloorPlan): { list: string[]; seats: Set<string> } {
  const list = validatePlan(plan);
  const seats = new Set<string>();
  for (const [a, b] of overlappingSeats(plan.seats)) { seats.add(a); seats.add(b); }
  const ids = new Map<string, number>();
  for (const q of plan.seats) ids.set(q.id, (ids.get(q.id) ?? 0) + 1);
  for (const [id, n] of ids) if (n > 1) seats.add(id);
  return { list, seats };
}
