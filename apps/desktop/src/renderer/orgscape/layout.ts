// The office as a general-arrangement drawing: everyone placed on one sheet, joined by their
// reporting lines. A line manager's plate sits at the top left of their team; a riser drops from
// under their tile and a header runs along each row of their team, with a drop to every plate, like
// a pipe manifold. A department starts an area (a dashed boundary with its name), so the sheet reads
// as a plant layout: areas of people, lines between them. Pure: no DOM, so it can be tested.
import type { Department, PublicUser } from '@dex/core';

export const PLATE_W = 188;
export const PLATE_H = 64;
/** Where a plate's riser leaves it: the centre of its tile. */
export const RISER = 24;
/** How far a team sits to the right of its manager's riser. */
const INDENT = 36;
const GAP_X = 18;
/** The lane above each row, where the header runs. */
const LANE = 32;
const AREA_PAD = 16;
const AREA_BAND = 30;
/** The margin round the whole sheet and the size of one grid square (A1, B4…). */
export const MARGIN = 72;
export const GRID = 420;

export type Pt = [number, number];

export interface Plate {
  id: string;
  /** Top-left corner of the plate. */
  x: number;
  y: number;
  managerId: string | null;
  reports: string[];
  /** Everyone below, at any depth. */
  team: number;
  /** Lines between them and the top of their tree. */
  depth: number;
  /** The area (department) they are drawn in, or -1. */
  area: number;
  /** Grid reference on the sheet, such as "C4". */
  ref: string;
}

export interface Area {
  /** Whoever the area starts with (or a group key for people with no line manager). */
  key: string;
  deptId: string | null;
  name: string;
  num: number;
  x: number; y: number; w: number; h: number;
  /** Everyone inside, including nested areas. */
  members: string[];
  /** Nested inside another area. */
  inner: boolean;
}

export interface GA {
  plates: Map<string, Plate>;
  /** Plates in drawing (and reading) order: depth first, as the tree reads. */
  order: string[];
  /** The reporting line into each person, keyed by the person: manager's riser to their plate. */
  edges: Map<string, Pt[]>;
  areas: Area[];
  roots: string[];
  w: number;
  h: number;
  cols: number;
  rows: number;
  /** True when anyone has a line manager. */
  hasLines: boolean;
}

interface Box {
  id: string | null;
  w: number;
  h: number;
  /** The plate's offset inside the box (absent for a group of people with no lines). */
  px: number;
  py: number;
  kids: Array<{ box: Box; dx: number; dy: number }>;
  /** Header lane y (relative) of each row, and the right end of its header. */
  rows: Array<{ y: number; x1: number; items: number[] }>;
  area: { deptId: string | null; name: string; key: string } | null;
  lines: boolean;
}

export const colLetter = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : colLetter(Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26)));
export const gridRef = (x: number, y: number): string => `${colLetter(Math.max(0, Math.floor((x - MARGIN) / GRID)))}${Math.max(0, Math.floor((y - MARGIN) / GRID)) + 1}`;

/** Each person's line manager, with links that would loop or point outside the set broken. */
export function managerMap(people: PublicUser[]): Map<string, string | null> {
  const ids = new Set(people.map((u) => u.id));
  const parent = new Map<string, string | null>();
  for (const u of people) {
    const m = u.profile.managerId;
    parent.set(u.id, m && m !== u.id && ids.has(m) ? m : null);
  }
  // break loops: walk up from everyone; a walk that comes back to itself cuts its last link
  const done = new Set<string>();
  for (const u of people) {
    const path: string[] = [];
    const onPath = new Set<string>();
    let cur: string | null = u.id;
    while (cur && !done.has(cur)) {
      if (onPath.has(cur)) { parent.set(path[path.length - 1], null); break; }
      onPath.add(cur);
      path.push(cur);
      cur = parent.get(cur) ?? null;
    }
    for (const p of path) done.add(p);
  }
  return parent;
}

/** Pack boxes into rows no wider than `target`, left to right. */
function packRows(boxes: Box[], target: number): Array<{ items: number[]; w: number; h: number }> {
  const rows: Array<{ items: number[]; w: number; h: number }> = [];
  let row: { items: number[]; w: number; h: number } | null = null;
  boxes.forEach((b, i) => {
    if (!row || (row.items.length && row.w + GAP_X + b.w > target)) { row = { items: [], w: 0, h: 0 }; rows.push(row); }
    row.w += (row.items.length ? GAP_X : 0) + b.w;
    row.h = Math.max(row.h, b.h);
    row.items.push(i);
  });
  return rows;
}

const rowTarget = (boxes: Box[]): number => {
  if (!boxes.length) return 0;
  const area = boxes.reduce((s, b) => s + (b.w + GAP_X) * (b.h + LANE), 0);
  const widest = Math.max(...boxes.map((b) => b.w));
  return Math.max(widest, Math.sqrt(area) * 1.7, Math.min(boxes.length, 4) * (PLATE_W + GAP_X) - GAP_X);
};

/** Lay out the whole office. `departments` names the areas. */
export function layoutGA(people: PublicUser[], departments: Map<string, Department>): GA {
  const parent = managerMap(people);
  const byId = new Map(people.map((u) => [u.id, u] as const));
  const kids = new Map<string, string[]>();
  for (const u of people) {
    const m = parent.get(u.id);
    if (m) (kids.get(m) ?? kids.set(m, []).get(m)!).push(u.id);
  }
  const team = new Map<string, number>();
  const teamOf = (id: string): number => {
    const known = team.get(id);
    if (known !== undefined) return known;
    // iterative, so a long chain cannot overflow the stack
    const stack: Array<[string, number]> = [[id, 0]];
    while (stack.length) {
      const [cur, i] = stack[stack.length - 1];
      const ks = kids.get(cur) ?? [];
      if (i < ks.length) { stack[stack.length - 1][1]++; if (!team.has(ks[i])) stack.push([ks[i], 0]); continue; }
      team.set(cur, ks.reduce((s, k) => s + 1 + (team.get(k) ?? 0), 0));
      stack.pop();
    }
    return team.get(id) ?? 0;
  };
  for (const u of people) teamOf(u.id);
  const dept = (id: string) => byId.get(id)?.profile.departmentId ?? null;
  const deptName = (d: string | null) => (d ? departments.get(d)?.name ?? null : null);
  const name = (id: string) => byId.get(id)?.displayName ?? '';
  const hasLines = [...parent.values()].some(Boolean);

  // a plate and its team, bottom up (iterative for the same reason)
  const boxes = new Map<string, Box>();
  const build = (rootId: string) => {
    const stack: Array<{ id: string; seen: boolean }> = [{ id: rootId, seen: false }];
    while (stack.length) {
      const top = stack[stack.length - 1];
      const ks = kids.get(top.id) ?? [];
      if (!top.seen) { top.seen = true; for (const k of ks) stack.push({ id: k, seen: false }); continue; }
      stack.pop();
      // their team: people without a team first, then teams, largest first
      const order = [...ks].sort((a, b) => (Math.sign(teamOf(a)) - Math.sign(teamOf(b))) || (teamOf(b) ? boxes.get(b)!.h - boxes.get(a)!.h : 0) || name(a).localeCompare(name(b)));
      const kb = order.map((k) => boxes.get(k)!);
      const m = parent.get(top.id);
      const d = dept(top.id);
      const startsArea = !!d && (!m || dept(m) !== d);
      const pad = startsArea ? AREA_PAD : 0;
      const px = pad, py = pad + (startsArea ? AREA_BAND : 0);
      const rows = packRows(kb, rowTarget(kb));
      let y = py + PLATE_H;
      let w = PLATE_W;
      const placed: Box['kids'] = [];
      const rowsOut: Box['rows'] = [];
      for (const r of rows) {
        y += LANE;
        let x = px + INDENT;
        const items: number[] = [];
        for (const i of r.items) {
          placed.push({ box: kb[i], dx: x, dy: y });
          items.push(placed.length - 1);
          x += kb[i].w + GAP_X;
        }
        const last = placed[placed.length - 1];
        rowsOut.push({ y: y - LANE / 2, x1: last.dx + last.box.px + RISER, items });
        w = Math.max(w, x - GAP_X - px);
        y += r.h;
      }
      boxes.set(top.id, {
        id: top.id, w: w + pad * 2, h: y + pad, px, py, kids: placed, rows: rowsOut, lines: true,
        area: startsArea ? { deptId: d, name: deptName(d) ?? '', key: top.id } : null,
      });
    }
  };

  const rootsAll = people.filter((u) => !parent.get(u.id)).map((u) => u.id);
  const trees = rootsAll.filter((id) => teamOf(id) > 0).sort((a, b) => teamOf(b) - teamOf(a) || name(a).localeCompare(name(b)));
  for (const r of trees) build(r);
  // people with no line manager and no team: grouped by department, no lines
  const loose = rootsAll.filter((id) => teamOf(id) === 0);
  const groups = new Map<string, string[]>();
  for (const id of loose) { const d = dept(id) ?? ''; (groups.get(d) ?? groups.set(d, []).get(d)!).push(id); }
  const groupBoxes: Box[] = [...groups.entries()]
    .sort((a, b) => (deptName(a[0] || null) ?? '￿').localeCompare(deptName(b[0] || null) ?? '￿'))
    .map(([d, ids]) => {
      const leaf = (id: string): Box => ({ id, w: PLATE_W, h: PLATE_H, px: 0, py: 0, kids: [], rows: [], area: null, lines: false });
      const kb = ids.sort((a, b) => name(a).localeCompare(name(b))).map(leaf);
      const cols = Math.max(1, Math.min(kb.length, Math.ceil(Math.sqrt(kb.length * 1.6))));
      const placed: Box['kids'] = kb.map((b, i) => ({ box: b, dx: AREA_PAD + (i % cols) * (PLATE_W + GAP_X), dy: AREA_PAD + AREA_BAND + Math.floor(i / cols) * (PLATE_H + GAP_X) }));
      const rowsN = Math.ceil(kb.length / cols);
      return {
        id: null, w: AREA_PAD * 2 + cols * (PLATE_W + GAP_X) - GAP_X, h: AREA_PAD * 2 + AREA_BAND + rowsN * (PLATE_H + GAP_X) - GAP_X,
        px: 0, py: 0, kids: placed, rows: [], lines: false,
        area: { deptId: d || null, name: deptName(d || null) ?? '', key: `group:${d}` },
      };
    });

  // the sheet: trees, then the groups, packed in rows
  const top = [...trees.map((r) => boxes.get(r)!), ...groupBoxes];
  const sheetRows = packRows(top, Math.max(rowTarget(top), 1200));
  const placedTop: Array<{ box: Box; x: number; y: number }> = [];
  let sy = MARGIN;
  let sw = 0;
  for (const r of sheetRows) {
    let sx = MARGIN;
    for (const i of r.items) { placedTop.push({ box: top[i], x: sx, y: sy }); sx += top[i].w + GAP_X * 3; }
    sw = Math.max(sw, sx - GAP_X * 3);
    sy += r.h + LANE * 2;
  }

  // absolute positions, plates, edges and areas
  const plates = new Map<string, Plate>();
  const order: string[] = [];
  const edges = new Map<string, Pt[]>();
  const areas: Area[] = [];
  const walk = (b: Box, ox: number, oy: number, depth: number, around: number[]) => {
    let inside = around;
    if (b.area) {
      inside = [...around, areas.length];
      areas.push({ key: b.area.key, deptId: b.area.deptId, name: b.area.name, num: areas.length + 1, x: ox, y: oy, w: b.w, h: b.h, members: [], inner: around.length > 0 });
    }
    const myArea = inside.length ? inside[inside.length - 1] : -1;
    if (b.id) {
      const u = byId.get(b.id)!;
      const x = ox + b.px, y = oy + b.py;
      plates.set(b.id, { id: b.id, x, y, managerId: parent.get(b.id) ?? null, reports: (kids.get(b.id) ?? []).slice(), team: teamOf(b.id), depth, area: myArea, ref: gridRef(x + PLATE_W / 2, y + PLATE_H / 2) });
      order.push(u.id);
    }
    // a member of every area this sits in
    if (b.id) for (const a of inside) areas[a].members.push(b.id);
    const rx = ox + b.px + RISER, ry = oy + b.py + PLATE_H;
    b.rows.forEach((row) => {
      for (const i of row.items) {
        const k = b.kids[i];
        if (!k.box.id) continue;
        const cx = ox + k.dx + k.box.px + RISER;
        const cy = oy + k.dy + k.box.py;
        edges.set(k.box.id, [[rx, ry], [rx, oy + row.y], [cx, oy + row.y], [cx, cy]]);
      }
    });
    for (const k of b.kids) walk(k.box, ox + k.dx, oy + k.dy, b.lines ? depth + 1 : depth, inside);
  };
  for (const p of placedTop) walk(p.box, p.x, p.y, 0, []);
  const w = Math.max(sw + MARGIN, MARGIN * 2 + PLATE_W);
  const h = Math.max(sy - LANE * 2 + MARGIN, MARGIN * 2 + PLATE_H);
  return { plates, order, edges, areas, roots: [...trees, ...loose], w, h, cols: Math.ceil((w - MARGIN * 2) / GRID), rows: Math.ceil((h - MARGIN * 2) / GRID), hasLines };
}

/** The chain of line managers from someone to the top, themselves first. */
export function chainUp(id: string, ga: GA): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = id;
  while (cur && !seen.has(cur) && ga.plates.has(cur)) { out.push(cur); seen.add(cur); cur = ga.plates.get(cur)!.managerId; }
  return out;
}

/**
 * How two people are connected along reporting lines: from `a` up to the nearest manager they
 * share, then down to `b`. Null when no line joins them.
 */
export function routeBetween(a: string, b: string, ga: GA): string[] | null {
  if (!ga.plates.has(a) || !ga.plates.has(b)) return null;
  if (a === b) return [a];
  const up = chainUp(a, ga);
  const down = chainUp(b, ga);
  const at = new Map(up.map((id, i) => [id, i] as const));
  const j = down.findIndex((id) => at.has(id));
  if (j < 0) return null;
  return [...up.slice(0, at.get(down[j])! + 1), ...down.slice(0, j).reverse()];
}

/** The line drawn along a route: each step's reporting line, in order. */
export function routeLines(route: string[], ga: GA): Pt[][] {
  const out: Pt[][] = [];
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1], b = route[i];
    const child = ga.plates.get(b)?.managerId === a ? b : ga.plates.get(a)?.managerId === b ? a : null;
    const e = child ? ga.edges.get(child) : undefined;
    if (e) out.push(child === b ? e : [...e].reverse());
  }
  return out;
}

/** Where the arrow keys go from someone: up to their manager, down to their team, along to their peers. */
export function neighbour(id: string, dir: 'up' | 'down' | 'left' | 'right', ga: GA): string | null {
  const p = ga.plates.get(id);
  if (!p) return null;
  if (dir === 'up') return p.managerId;
  if (dir === 'down') return p.reports.length ? nearestBy(p.reports, p, ga) : null;
  // peers: the same line manager; with none, the next plate along in reading order
  const peers = p.managerId ? ga.plates.get(p.managerId)!.reports : ga.roots.filter((r) => ga.plates.has(r));
  const sorted = [...peers].sort((x, y) => ga.plates.get(x)!.y - ga.plates.get(y)!.y || ga.plates.get(x)!.x - ga.plates.get(y)!.x);
  const i = sorted.indexOf(id);
  const j = dir === 'left' ? i - 1 : i + 1;
  return j >= 0 && j < sorted.length ? sorted[j] : null;
}

function nearestBy(ids: string[], from: Plate, ga: GA): string {
  let best = ids[0], d = Infinity;
  for (const id of ids) { const q = ga.plates.get(id)!; const dd = Math.hypot(q.x - from.x, q.y - from.y); if (dd < d) { d = dd; best = id; } }
  return best;
}

/** Whole days since someone joined (negative before they join), or null when unknown. */
export function daysSince(ymd: string | null, now = Date.now()): number | null {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const t = Date.parse(`${ymd}T00:00:00`);
  return Number.isNaN(t) ? null : Math.floor((now - t) / 86400_000);
}

/** Marks for a person today: new (joined in the last 30 days), birthday, work anniversary (years). */
export function marksFor(u: Pick<PublicUser, 'profile'>, now = new Date()): { isNew: boolean; birthday: boolean; years: number } {
  const since = daysSince(u.profile.joinedOn, now.getTime());
  const mmdd = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const joined = u.profile.joinedOn;
  const years = joined && joined.slice(5) === mmdd && since !== null && since > 300 ? now.getFullYear() - Number(joined.slice(0, 4)) : 0;
  return { isNew: since !== null && since >= 0 && since <= 30, birthday: u.profile.birthday === mmdd, years };
}
