// Draws the office on a canvas: the general arrangement (reporting lines) and the floor plan, in
// the drawing-office language: hairline plates, chain-line area boundaries, risers with proper
// bends, revision clouds round new joiners, dashed "proposed" outlines for people who had not
// joined yet at the date being looked at, and grid references along the edges like a CAD viewer.
// Only what is in view is drawn, and how much depends on the zoom (level of detail).
import type { PublicUser, WorkMode } from '@dex/core';
import type { Presence } from '../ui.tsx';
import { colorFor, initials } from '../ui.tsx';
import type { Camera } from './camera.ts';
import { GRID, MARGIN, PLATE_H, PLATE_W, RISER, colLetter } from './layout.ts';
import type { GA, Pt } from './layout.ts';
import type { Floor } from './floor.ts';
import { DESK_H, DESK_W, TILE } from './floor.ts';

export interface Ink {
  paper: string; window: string; text: string; text2: string; text3: string;
  accent: string; accentText: string; accentInk: string; accentSoft: string; amber: string; amberInk: string; amberSoft: string;
  stroke: string; strokeStrong: string; subtle: string;
  display: string; body: string; mono: string; dark: boolean; latinCaps: boolean;
}

/** The theme's colours and fonts, read from the page so the drawing follows light and dark. */
export function readInk(): Ink {
  const cs = getComputedStyle(document.documentElement);
  const v = (k: string, d: string) => cs.getPropertyValue(k).trim() || d;
  const lang = document.documentElement.lang;
  return {
    paper: v('--layer-solid', '#fff'), window: v('--window', '#eef3f3'), text: v('--text', '#15191b'), text2: v('--text-2', '#43585b'), text3: v('--text-3', '#56696c'),
    accent: v('--accent', '#1c7680'), accentText: v('--accent-text', '#fff'), accentInk: v('--accent-ink', '#1e6066'), accentSoft: v('--accent-soft', 'rgba(42,140,152,.12)'),
    amber: v('--amber', '#f7af44'), amberInk: v('--amber-ink', '#7a4a00'), amberSoft: v('--amber-soft', 'rgba(247,175,68,.18)'),
    stroke: v('--stroke', 'rgba(19,43,46,.09)'), strokeStrong: v('--stroke-strong', 'rgba(19,43,46,.16)'), subtle: v('--subtle-2', 'rgba(19,43,46,.08)'),
    display: v('--font-display', 'sans-serif'), body: v('--font-body', 'sans-serif'), mono: v('--font-mono', 'monospace'),
    dark: document.documentElement.dataset.theme === 'dark', latinCaps: lang !== 'hi' && lang !== 'ta',
  };
}

/** Words drawn on the sheet, already in the person's language. */
export interface Labels {
  area: string; you: string; isNew: string; years: (n: number) => string; inOffice: (n: number) => string; people: (n: number) => string;
  corridor: string; north: string; home: string; site: string; client: string; noSeat: string; awayKey: string; bay: (b: string) => string; cabin: (c: string) => string;
  reception: string;
}

export interface Marks { isNew: boolean; birthday: boolean; years: number }

export interface Scene {
  users: Map<string, PublicUser>;
  presence: (id: string) => Presence;
  me: string;
  focus: string | null;
  hover: string | null;
  selected: string | null;
  /** Lines lit up: everyone above and the team of the person in focus. */
  hot: Set<string>;
  spotlight: { id: string; t0: number } | null;
  route: { ids: string[]; lines: Pt[][]; t0: number } | null;
  overlay: { name: string; members: Set<string> } | null;
  /** Looking back at the office on this date (ms), or null for today. */
  asAt: number | null;
  joinedAt: Map<string, number>;
  marks: Map<string, Marks>;
  /** Something changed for someone (came online, joined a Room): a pulse runs down their line. */
  pigs: Array<{ id: string; t0: number; room: boolean }>;
  intro: number | null;
  now: number;
  reduced: boolean;
  ink: Ink;
  labels: Labels;
  deptName: (id: string) => string;
  modeOf: (id: string) => WorkMode | null;
}

export const LOD = { far: 0.3, near: 0.62 };
const INTRO_MS = 1300;

// ------------------------------------------------------------------ small drawing helpers
const fitCache = new Map<string, string>();
function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  const key = `${ctx.font}|${max}|${text}`;
  const hit = fitCache.get(key);
  if (hit !== undefined) return hit;
  let out = text;
  if (ctx.measureText(text).width > max) {
    let lo = 0, hi = text.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ctx.measureText(`${text.slice(0, mid)}…`).width <= max) lo = mid; else hi = mid - 1; }
    out = `${text.slice(0, lo).trimEnd()}…`;
  }
  if (fitCache.size > 4000) fitCache.clear();
  fitCache.set(key, out);
  return out;
}

function rrect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

/** A run with rounded bends (elbows), like a routed pipe. */
function run(ctx: CanvasRenderingContext2D, pts: Pt[], r: number): void {
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], [cx, cy] = pts[i + 1];
    const rr = Math.min(r, Math.hypot(bx - ax, by - ay) / 2, Math.hypot(cx - bx, cy - by) / 2);
    if (rr < 0.5) ctx.lineTo(bx, by); else ctx.arcTo(bx, by, cx, cy, rr);
  }
  ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
}

const runLength = (pts: Pt[]) => { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.abs(pts[i][0] - pts[i - 1][0]) + Math.abs(pts[i][1] - pts[i - 1][1]); return s; };
/** The point a fraction of the way along a run. */
function along(pts: Pt[], k: number): Pt {
  let left = runLength(pts) * Math.min(1, Math.max(0, k));
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.abs(pts[i][0] - pts[i - 1][0]) + Math.abs(pts[i][1] - pts[i - 1][1]);
    if (left <= seg && seg > 0) { const t = left / seg; return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t]; }
    left -= seg;
  }
  return pts[pts.length - 1];
}

/** A revision cloud: scallops round a rectangle, the drafter's mark for "this changed". */
function cloud(ctx: CanvasPath, x: number, y: number, w: number, h: number, s: number): void {
  const nx = Math.max(2, Math.round(w / s)), ny = Math.max(2, Math.round(h / s));
  const sx = w / nx, sy = h / ny;
  ctx.moveTo(x, y);
  for (let i = 0; i < nx; i++) ctx.arc(x + sx * (i + 0.5), y, sx / 2, Math.PI, 0);
  for (let i = 0; i < ny; i++) ctx.arc(x + w, y + sy * (i + 0.5), sy / 2, -Math.PI / 2, Math.PI / 2);
  for (let i = nx - 1; i >= 0; i--) ctx.arc(x + sx * (i + 0.5), y + h, sx / 2, 0, Math.PI);
  for (let i = ny - 1; i >= 0; i--) ctx.arc(x, y + sy * (i + 0.5), sy / 2, Math.PI / 2, Math.PI * 1.5);
}

const caps = (ink: Ink, s: string) => (ink.latinCaps ? s.toUpperCase() : s);
const intersects = (x: number, y: number, w: number, h: number, v: { x: number; y: number; w: number; h: number }) => x < v.x + v.w && x + w > v.x && y < v.y + v.h && y + h > v.y;

/** The tile with its beacon ring (presence), drawn the way the app draws avatars. */
function tile(ctx: CanvasRenderingContext2D, s: Scene, u: PublicUser, cx: number, cy: number, size: number, opts: { ghost?: boolean; text?: boolean } = {}): void {
  const p = s.presence(u.id);
  const r = size * 0.3, x = cx - size / 2, y = cy - size / 2;
  const ink = s.ink;
  // beacon
  if (!opts.ghost && p !== 'off') {
    ctx.beginPath(); rrect(ctx, x - 3.5, y - 3.5, size + 7, size + 7, r + 3);
    ctx.lineWidth = p === 'away' ? 1.2 : 2;
    ctx.strokeStyle = p === 'room' ? ink.amber : p === 'dnd' ? ink.text2 : ink.accent;
    if (p === 'dnd' || p === 'meeting') ctx.setLineDash([2.2, 2.2]);
    ctx.stroke();
    ctx.setLineDash([]);
    if (p === 'busy') { ctx.beginPath(); rrect(ctx, x - 6.5, y - 6.5, size + 13, size + 13, r + 6); ctx.lineWidth = 1; ctx.stroke(); }
  }
  ctx.beginPath(); rrect(ctx, x, y, size, size, r);
  if (opts.ghost) { ctx.setLineDash([3, 2]); ctx.strokeStyle = ink.text3; ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]); }
  else if (p === 'off') { ctx.fillStyle = ink.paper; ctx.fill(); ctx.strokeStyle = ink.text3; ctx.lineWidth = 1.2; ctx.stroke(); }
  else { ctx.fillStyle = colorFor(u.id); ctx.fill(); }
  if (opts.text !== false && size >= 14) {
    ctx.fillStyle = opts.ghost ? ink.text3 : p === 'off' ? ink.text2 : '#fff';
    ctx.font = `600 ${Math.round(size * 0.4)}px ${ink.display}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(initials(u.displayName), cx, cy + 0.5);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }
}

/** A small mono caption in a hairline box (a tag), its left edge at x. Returns its width. */
function tag(ctx: CanvasRenderingContext2D, ink: Ink, text: string, x: number, y: number, size: number, color: string, fill?: string): number {
  ctx.font = `600 ${size}px ${ink.latinCaps ? ink.mono : ink.body}`;
  const w = ctx.measureText(text).width + size * 0.9, h = size * 1.55;
  ctx.beginPath(); ctx.rect(x, y, w, h);
  ctx.fillStyle = fill ?? ink.paper; ctx.fill();
  ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke();
  ctx.fillStyle = color; ctx.textBaseline = 'middle';
  ctx.fillText(text, x + size * 0.45, y + h / 2 + 0.5);
  ctx.textBaseline = 'alphabetic';
  return w;
}

/** A pennant on a pole: a birthday today. */
function pennant(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  ctx.beginPath(); ctx.moveTo(x, y + 14); ctx.lineTo(x, y); ctx.lineTo(x + 11, y + 3.5); ctx.lineTo(x, y + 7);
  ctx.strokeStyle = color; ctx.lineWidth = 1.3; ctx.stroke();
  ctx.fillStyle = color; ctx.globalAlpha *= 0.85; ctx.fill(); ctx.globalAlpha /= 0.85;
}

function seatShort(loc: string | null): string {
  if (!loc) return '';
  const bay = loc.match(/\bbay\s*([a-z0-9]+)/i), desk = loc.match(/\bdesk\s*(\d+)/i);
  if (bay) return `B${bay[1].toUpperCase()}${desk ? `·D${desk[1]}` : ''}`;
  return loc.length > 14 ? `${loc.slice(0, 13)}…` : loc;
}

function sheetBackground(ctx: CanvasRenderingContext2D, s: Scene, w: number, h: number, cam: Camera): void {
  const ink = s.ink;
  ctx.fillStyle = ink.paper;
  ctx.fillRect(0, 0, w, h);
  // the drafting grid: faint squares, a stronger line every grid reference
  const v = cam.view(0);
  if (cam.z > 0.18) {
    ctx.beginPath();
    const step = 28;
    for (let gx = Math.max(0, Math.floor(v.x / step) * step); gx <= Math.min(w, v.x + v.w); gx += step) { ctx.moveTo(gx, Math.max(0, v.y)); ctx.lineTo(gx, Math.min(h, v.y + v.h)); }
    for (let gy = Math.max(0, Math.floor(v.y / step) * step); gy <= Math.min(h, v.y + v.h); gy += step) { ctx.moveTo(Math.max(0, v.x), gy); ctx.lineTo(Math.min(w, v.x + v.w), gy); }
    ctx.strokeStyle = ink.stroke; ctx.lineWidth = 1 / cam.z * 0.6; ctx.globalAlpha = 0.55; ctx.stroke(); ctx.globalAlpha = 1;
  }
  ctx.beginPath();
  for (let gx = MARGIN; gx <= w - MARGIN + 1; gx += GRID) { ctx.moveTo(gx, MARGIN / 2); ctx.lineTo(gx, h - MARGIN / 2); }
  for (let gy = MARGIN; gy <= h - MARGIN + 1; gy += GRID) { ctx.moveTo(MARGIN / 2, gy); ctx.lineTo(w - MARGIN / 2, gy); }
  ctx.strokeStyle = ink.stroke; ctx.lineWidth = Math.max(1, 1 / cam.z); ctx.stroke();
  // the sheet's frame: a heavy border inside a hairline one
  ctx.strokeStyle = ink.text3; ctx.lineWidth = Math.max(1.5, 1.5 / cam.z);
  ctx.strokeRect(MARGIN / 2, MARGIN / 2, w - MARGIN, h - MARGIN);
  ctx.lineWidth = Math.max(0.6, 0.6 / cam.z);
  ctx.strokeRect(MARGIN / 2 - 8, MARGIN / 2 - 8, w - MARGIN + 16, h - MARGIN + 16);
}

/** How present someone is at the date being looked at: 1 there, 0 not yet joined. */
const there = (s: Scene, id: string) => (s.asAt === null ? 1 : (s.joinedAt.get(id) ?? -Infinity) <= s.asAt ? 1 : 0);

function introAlpha(s: Scene, delay: number): number {
  if (s.intro === null || s.reduced) return 1;
  const t = s.now - s.intro - delay;
  return Math.max(0, Math.min(1, t / 260));
}

// ------------------------------------------------------------------ the general arrangement
export function drawGA(ctx: CanvasRenderingContext2D, ga: GA, s: Scene, cam: Camera): void {
  const ink = s.ink;
  const z = cam.z;
  const v = cam.view(40);
  const lod = z < LOD.far ? 'far' : z < LOD.near ? 'mid' : 'near';
  const px = 1 / z; // one screen pixel in world units
  sheetBackground(ctx, s, ga.w, ga.h, cam);
  const dimmed = (id: string) => (s.route ? !s.route.ids.includes(id) : s.overlay ? !s.overlay.members.has(id) : false);
  const delayOf = (id: string) => { const p = ga.plates.get(id)!; return p.depth * 110 + (p.x / Math.max(1, ga.w)) * 380; };

  // areas: a faint field and a chain-line boundary, the department's name in the corner
  for (const a of ga.areas) {
    if (!intersects(a.x, a.y, a.w, a.h, v)) continue;
    ctx.globalAlpha = introAlpha(s, 0);
    ctx.fillStyle = a.inner ? ink.accentSoft : ink.subtle;
    ctx.globalAlpha *= a.inner ? 0.35 : 0.5;
    ctx.fillRect(a.x, a.y, a.w, a.h);
    ctx.globalAlpha = introAlpha(s, 0);
    ctx.beginPath(); ctx.rect(a.x, a.y, a.w, a.h);
    ctx.setLineDash([18 * Math.max(1, px * 0.6), 5 * Math.max(1, px * 0.6), 3 * Math.max(1, px * 0.6), 5 * Math.max(1, px * 0.6)]);
    ctx.strokeStyle = ink.accent; ctx.lineWidth = Math.max(1.1, 1.1 * px); ctx.stroke(); ctx.setLineDash([]);
    // label: AREA 03 · Piping · 7 · 3 in
    const online = a.members.reduce((n, id) => n + (s.presence(id) !== 'off' ? 1 : 0), 0);
    const size = lod === 'far' ? Math.min(14 * px, a.h / 6, a.w / 10) : 11;
    if (size * z < 5) continue;
    let lx = a.x + 10, ly = a.y + (lod === 'far' ? 8 * Math.max(1, size / 14) : 7);
    const tw = tag(ctx, ink, `${caps(ink, s.labels.area)} ${String(a.num).padStart(2, '0')}`, lx, ly, size * 0.82, ink.accentInk);
    lx += tw + size * 0.6;
    ctx.font = `600 ${size * 1.25}px ${ink.display}`;
    ctx.fillStyle = ink.text;
    const name = a.name || s.labels.noSeat;
    ctx.fillText(fit(ctx, name, Math.max(40, a.w - (lx - a.x) - size * 9)), lx, ly + size * 1.12);
    lx += Math.min(ctx.measureText(name).width, Math.max(40, a.w - (lx - a.x) - size * 9)) + size * 0.7;
    ctx.font = `600 ${size * 0.82}px ${ink.latinCaps ? ink.mono : ink.body}`;
    ctx.fillStyle = ink.text2;
    ctx.fillText(`${s.labels.people(a.members.length)} · ${s.labels.inOffice(online)}`, lx, ly + size * 1.08);
  }
  ctx.globalAlpha = 1;

  // reporting lines
  const r = 9;
  const drawEdges = (filter: (id: string) => boolean, style: () => void) => {
    ctx.beginPath();
    for (const [id, pts] of ga.edges) {
      if (!filter(id)) continue;
      const m = ga.plates.get(id)!.managerId!;
      const mp = ga.plates.get(m)!;
      const minx = Math.min(pts[0][0], pts[2][0]), maxx = Math.max(pts[0][0], pts[2][0]);
      if (!intersects(minx - 2, mp.y, maxx - minx + 4, pts[3][1] - mp.y, v)) continue;
      run(ctx, pts, r);
    }
    style();
  };
  const proposed = (id: string) => there(s, id) === 0;
  const introOn = s.intro !== null && !s.reduced && s.now - s.intro < INTRO_MS + 1200;
  if (introOn) {
    // the plotter draws each line in after its manager appears
    for (const [id, pts] of ga.edges) {
      const k = introAlpha(s, delayOf(id) - 120);
      if (k <= 0) continue;
      const len = runLength(pts);
      ctx.beginPath(); run(ctx, pts, r);
      ctx.setLineDash([len * k, len]);
      ctx.strokeStyle = ink.text3; ctx.lineWidth = Math.max(1.3, 1.1 * px); ctx.stroke();
    }
    ctx.setLineDash([]);
  } else {
    ctx.globalAlpha = s.route || s.overlay ? 0.35 : 1;
    drawEdges((id) => !s.hot.has(id) && !proposed(id), () => { ctx.strokeStyle = ink.text3; ctx.lineWidth = Math.max(1.2, (lod === 'near' ? 1.5 : 1.2) * px * (lod === 'far' ? 1 : 0.9)); ctx.stroke(); });
    drawEdges((id) => !s.hot.has(id) && proposed(id), () => { ctx.setLineDash([6, 4]); ctx.strokeStyle = ink.text3; ctx.lineWidth = Math.max(1, px); ctx.stroke(); ctx.setLineDash([]); });
    ctx.globalAlpha = 1;
    drawEdges((id) => s.hot.has(id), () => { ctx.strokeStyle = ink.accent; ctx.lineWidth = Math.max(2.2, 2.2 * px); ctx.stroke(); });
  }

  // plates
  if (lod === 'far' && !introOn) farPlates(ctx, ga, s, v, px, dimmed);
  else for (const id of ga.order) {
    const p = ga.plates.get(id)!;
    if (!intersects(p.x - 16, p.y - 20, PLATE_W + 32, PLATE_H + 36, v)) continue;
    const u = s.users.get(id);
    if (!u) continue;
    const a = introAlpha(s, delayOf(id));
    if (a <= 0) continue;
    ctx.globalAlpha = a * (dimmed(id) ? 0.28 : 1);
    plate(ctx, s, u, p.x, p.y, lod, z, there(s, id) === 0, p.team, p.ref);
  }
  ctx.globalAlpha = 1;

  // what is shared: a Space drawn as a tag with signal lines (dashed) to its members
  if (s.overlay && !s.route) spaceLoop(ctx, s, [...s.overlay.members].flatMap((id) => { const p = ga.plates.get(id); return p ? [[p.x + PLATE_W / 2, p.y + PLATE_H / 2] as Pt] : []; }), s.overlay.name, z);

  // a route between two people, flowing along the lines
  if (s.route) {
    ctx.beginPath();
    for (const pts of s.route.lines) run(ctx, pts, r);
    ctx.strokeStyle = ink.paper; ctx.lineWidth = Math.max(7, 7 * px); ctx.stroke();
    ctx.strokeStyle = ink.accent; ctx.lineWidth = Math.max(3, 3 * px);
    if (!s.reduced) { ctx.setLineDash([14 * Math.max(1, px), 8 * Math.max(1, px)]); ctx.lineDashOffset = -((s.now - s.route.t0) / 28) * Math.max(1, px); }
    ctx.stroke(); ctx.setLineDash([]); ctx.lineDashOffset = 0;
    s.route.ids.forEach((id, i) => {
      const p = ga.plates.get(id);
      if (!p) return;
      ctx.beginPath(); rrect(ctx, p.x - 4, p.y - 4, PLATE_W + 8, PLATE_H + 8, 6);
      ctx.strokeStyle = ink.accent; ctx.lineWidth = Math.max(2, 2 * px); ctx.stroke();
      tag(ctx, ink, String(i + 1).padStart(2, '0'), p.x - 4, p.y - 4 - Math.max(16, 16 * px), Math.max(10, 10 * px), ink.accentText, ink.accent);
    });
  }

  // a pulse runs down someone's line when something changes for them
  for (const pig of s.pigs) {
    const p = ga.plates.get(pig.id);
    if (!p) continue;
    const t = (s.now - pig.t0) / 1100;
    if (t < 0 || t > 1.6) continue;
    const edge = ga.edges.get(pig.id);
    const color = pig.room ? ink.amber : ink.accent;
    if (edge && t <= 1 && !s.reduced) {
      const [x, y] = along(edge, t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
      ctx.beginPath(); ctx.arc(x, y, Math.max(4, 4 * px), 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, Math.max(8, 8 * px), 0, Math.PI * 2); ctx.globalAlpha = 0.25; ctx.fill(); ctx.globalAlpha = 1;
    }
    if (t > 0.8 || s.reduced || !edge) {
      const k = Math.min(1, Math.max(0, (t - (edge && !s.reduced ? 0.8 : 0)) / 0.8));
      ctx.beginPath(); rrect(ctx, p.x - 4 - k * 10, p.y - 4 - k * 10, PLATE_W + 8 + k * 20, PLATE_H + 8 + k * 20, 6 + k * 6);
      ctx.strokeStyle = color; ctx.lineWidth = Math.max(2, 2 * px); ctx.globalAlpha = 1 - k; ctx.stroke(); ctx.globalAlpha = 1;
    }
  }

  // you are here
  const mine = ga.plates.get(s.me);
  if (mine && introAlpha(s, delayOf(s.me)) > 0) youAreHere(ctx, s, mine.x + PLATE_W, mine.y + PLATE_H / 2, z);

  // the spotlight: everything but one person goes dark for a moment
  if (s.spotlight) {
    const p = ga.plates.get(s.spotlight.id);
    if (p) spotlight(ctx, s, p.x + PLATE_W / 2, p.y + PLATE_H / 2, Math.max(PLATE_W, 120 * px) * 0.75, cam);
  }
}

/**
 * Zoomed right out every plate is a block and a tile: drawn in a handful of batched paths (one per
 * fill) rather than a few calls per person, so 500 people cost little more than 50.
 */
function farPlates(ctx: CanvasRenderingContext2D, ga: GA, s: Scene, v: { x: number; y: number; w: number; h: number }, px: number, dimmed: (id: string) => boolean): void {
  const ink = s.ink;
  for (const pass of [true, false]) {
    const on = new Path2D(), off = new Path2D(), ghost = new Path2D(), ticks = new Path2D(), room = new Path2D(), clouds = new Path2D();
    const tiles = new Map<string, Path2D>();
    let any = false;
    for (const id of ga.order) {
      if (dimmed(id) !== pass) continue;
      const p = ga.plates.get(id)!;
      if (!intersects(p.x - 10, p.y - 10, PLATE_W + 20, PLATE_H + 20, v)) continue;
      any = true;
      const isGhost = there(s, id) === 0;
      const pr = s.presence(id);
      if (isGhost) { ghost.rect(p.x, p.y, PLATE_W, PLATE_H); continue; }
      (pr === 'off' ? off : on).rect(p.x, p.y, PLATE_W, PLATE_H);
      if (pr !== 'off') (pr === 'room' ? room : ticks).rect(p.x, p.y + 3, Math.max(3, 2 * px), PLATE_H - 6);
      const c = pr === 'off' ? ink.strokeStrong : colorFor(id);
      (tiles.get(c) ?? tiles.set(c, new Path2D()).get(c)!).rect(p.x + 9, p.y + 9, 30, PLATE_H - 18);
      if (s.marks.get(id)?.isNew) cloud(clouds, p.x - 7, p.y - 7, PLATE_W + 14, PLATE_H + 14, 14);
    }
    if (!any) continue;
    ctx.globalAlpha = pass ? 0.28 : 1;
    ctx.fillStyle = ink.paper; ctx.fill(on);
    ctx.fillStyle = ink.window; ctx.fill(off);
    ctx.strokeStyle = ink.strokeStrong; ctx.lineWidth = Math.max(1, px); ctx.stroke(on); ctx.stroke(off);
    ctx.fillStyle = ink.accent; ctx.fill(ticks);
    ctx.fillStyle = ink.amber; ctx.fill(room);
    for (const [c, path] of tiles) { ctx.fillStyle = c; ctx.fill(path); }
    ctx.setLineDash([6, 4]); ctx.strokeStyle = ink.text3; ctx.stroke(ghost); ctx.setLineDash([]);
    ctx.strokeStyle = ink.accent; ctx.lineWidth = Math.max(1.5, 1.5 * px); ctx.stroke(clouds);
  }
  ctx.globalAlpha = 1;
  // the few that need a mark of their own: you, the one picked, the one in focus
  for (const id of [s.me, s.selected, s.focus, s.hover]) {
    const p = id ? ga.plates.get(id) : undefined;
    if (!p) continue;
    ctx.beginPath(); rrect(ctx, p.x - 5, p.y - 5, PLATE_W + 10, PLATE_H + 10, 6);
    if (id === s.me) ctx.setLineDash([5 * px, 3 * px]);
    ctx.strokeStyle = ink.accent; ctx.lineWidth = Math.max(2, 2 * px); ctx.stroke(); ctx.setLineDash([]);
  }
}

function plate(ctx: CanvasRenderingContext2D, s: Scene, u: PublicUser, x: number, y: number, lod: 'far' | 'mid' | 'near', z: number, ghost: boolean, team: number, ref: string): void {
  const ink = s.ink;
  const p = s.presence(u.id);
  const on = p !== 'off' && !ghost;
  const px = 1 / z;
  const sel = s.selected === u.id, foc = s.focus === u.id, hov = s.hover === u.id;
  const m = s.marks.get(u.id);
  // the plate: solid when they are in, paper when not, a dashed outline when not joined yet
  ctx.beginPath(); rrect(ctx, x, y, PLATE_W, PLATE_H, 3);
  if (ghost) {
    ctx.setLineDash([6, 4]); ctx.strokeStyle = ink.text3; ctx.lineWidth = Math.max(1, px); ctx.stroke(); ctx.setLineDash([]);
  } else {
    ctx.fillStyle = on ? ink.paper : ink.window;
    ctx.fill();
    if (sel || hov) { ctx.fillStyle = ink.accentSoft; ctx.fill(); }
    ctx.strokeStyle = sel ? ink.accent : ink.strokeStrong; ctx.lineWidth = Math.max(1, (sel ? 1.6 : 1) * px); ctx.stroke();
    if (on) { ctx.fillStyle = p === 'room' ? ink.amber : ink.accent; ctx.fillRect(x, y + 3, Math.max(3, 2 * px), PLATE_H - 6); }
  }
  if (lod === 'far') {
    // a tile and nothing else
    ctx.beginPath(); rrect(ctx, x + 9, y + 9, 30, PLATE_H - 18, 6);
    ctx.fillStyle = ghost ? ink.stroke : colorFor(u.id); ctx.fill();
    if (m?.isNew && !ghost) { ctx.beginPath(); cloud(ctx, x - 7, y - 7, PLATE_W + 14, PLATE_H + 14, 14); ctx.strokeStyle = ink.accent; ctx.lineWidth = Math.max(1.5, 1.5 * px); ctx.stroke(); }
  } else {
    tile(ctx, s, u, x + RISER, y + 24, 30, { ghost });
    ctx.fillStyle = ghost ? ink.text3 : ink.text;
    if (lod === 'mid') {
      ctx.font = `600 19px ${ink.display}`;
      ctx.fillText(fit(ctx, u.displayName, PLATE_W - 52), x + 46, y + 31);
      if (m?.isNew && !ghost) { ctx.beginPath(); cloud(ctx, x - 7, y - 7, PLATE_W + 14, PLATE_H + 14, 14); ctx.strokeStyle = ink.accent; ctx.lineWidth = Math.max(1.4, 1.4 * px); ctx.stroke(); }
    } else {
      const teamW = team > 0 ? 26 : 0;
      ctx.font = `600 13px ${ink.display}`;
      ctx.fillText(fit(ctx, u.displayName, PLATE_W - 52 - teamW), x + 46, y + 22);
      ctx.font = `11.5px ${ink.body}`;
      ctx.fillStyle = ghost ? ink.text3 : ink.text2;
      ctx.fillText(fit(ctx, u.title || s.deptName(u.profile.departmentId ?? ''), PLATE_W - 54), x + 46, y + 38);
      // the plate's ruled strip: extension, seat, grid reference
      ctx.beginPath(); ctx.moveTo(x + 1, y + 46.5); ctx.lineTo(x + PLATE_W - 1, y + 46.5);
      ctx.strokeStyle = ink.stroke; ctx.lineWidth = Math.max(1, px); ctx.stroke();
      ctx.font = `600 9.5px ${ink.mono}`;
      ctx.fillStyle = ink.text3;
      if (u.profile.extension) ctx.fillText(fit(ctx, `EXT ${u.profile.extension}`, 64), x + 9, y + 59);
      const marked = !ghost && !!m && (m.isNew || m.birthday || m.years > 0);
      const seat = seatShort(u.profile.location);
      if (seat) ctx.fillText(fit(ctx, seat, marked ? (m!.isNew && m!.birthday ? 30 : 48) : 70), x + 76, y + 59);
      // the strip's last cell: today's marks when there are any, otherwise the grid reference
      if (!marked) { ctx.textAlign = 'right'; ctx.fillText(ref, x + PLATE_W - 8, y + 59); ctx.textAlign = 'left'; }
      if (team > 0) {
        ctx.font = `600 9.5px ${ink.mono}`;
        const t = String(team), w = ctx.measureText(t).width + 8;
        ctx.beginPath(); ctx.rect(x + PLATE_W - 7 - w, y + 9, w, 14);
        ctx.strokeStyle = ink.strokeStrong; ctx.lineWidth = Math.max(1, px); ctx.stroke();
        ctx.fillStyle = ink.accentInk; ctx.fillText(t, x + PLATE_W - 3 - w, y + 19.5);
      }
      if (marked && m) {
        let mx = x + PLATE_W - 6;
        ctx.font = `600 9px ${ink.latinCaps ? ink.mono : ink.body}`;
        if (m.isNew) {
          // the revision triangle, with the word beside it
          const word = caps(ink, s.labels.isNew), ww = ctx.measureText(word).width;
          ctx.fillStyle = ink.accentInk; ctx.textAlign = 'right'; ctx.fillText(word, mx, y + 59); ctx.textAlign = 'left';
          mx -= ww + 4;
          ctx.beginPath(); ctx.moveTo(mx - 6, y + 50.5); ctx.lineTo(mx, y + 60.5); ctx.lineTo(mx - 12, y + 60.5); ctx.closePath();
          ctx.strokeStyle = ink.accent; ctx.lineWidth = 1.1; ctx.stroke();
          mx -= 18;
        }
        if (m.birthday) { pennant(ctx, mx - 10, y + 49, ink.accent); mx -= 16; }
        if (m.years) {
          const word = s.labels.years(m.years), ww = ctx.measureText(word).width + 6;
          ctx.beginPath(); ctx.rect(mx - ww, y + 50, ww, 12); ctx.strokeStyle = ink.accent; ctx.lineWidth = 1; ctx.stroke();
          ctx.fillStyle = ink.accentInk; ctx.fillText(word, mx - ww + 3, y + 59);
        }
      }
      if (!ghost && m?.isNew) { ctx.beginPath(); cloud(ctx, x - 7, y - 7, PLATE_W + 14, PLATE_H + 14, 14); ctx.strokeStyle = ink.accent; ctx.lineWidth = Math.max(1.3, 1.3 * px); ctx.stroke(); }
    }
  }
  if (u.id === s.me && !ghost) {
    ctx.beginPath(); rrect(ctx, x - 3, y - 3, PLATE_W + 6, PLATE_H + 6, 5);
    ctx.setLineDash([5, 3]); ctx.strokeStyle = ink.accent; ctx.lineWidth = Math.max(1.2, 1.2 * px); ctx.stroke(); ctx.setLineDash([]);
  }
  if (foc) {
    ctx.beginPath(); rrect(ctx, x - 6, y - 6, PLATE_W + 12, PLATE_H + 12, 7);
    ctx.strokeStyle = ink.accent; ctx.lineWidth = Math.max(2.5, 2.5 * px); ctx.stroke();
  }
}

function youAreHere(ctx: CanvasRenderingContext2D, s: Scene, x: number, y: number, z: number, up = false): void {
  const ink = s.ink;
  const k = Math.max(1, 0.8 / z);
  if (up) {
    // straight up from the tile, the tag above the desk row
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - 16 * k);
    ctx.strokeStyle = ink.accent; ctx.lineWidth = 1.2 * k; ctx.stroke();
    ctx.font = `600 ${10 * k}px ${ink.latinCaps ? ink.mono : ink.body}`;
    const w = ctx.measureText(caps(ink, s.labels.you)).width + 9 * k;
    tag(ctx, ink, caps(ink, s.labels.you), x - w / 2, y - 16 * k - 15.5 * k, 10 * k, ink.accentInk);
    return;
  }
  ctx.beginPath(); ctx.moveTo(x + 4, y); ctx.lineTo(x + 26 * k, y - 18 * k); ctx.lineTo(x + 34 * k, y - 18 * k);
  ctx.strokeStyle = ink.accent; ctx.lineWidth = 1.2 * k; ctx.stroke();
  ctx.beginPath(); ctx.arc(x + 4, y, 2.5 * k, 0, Math.PI * 2); ctx.fillStyle = ink.accent; ctx.fill();
  tag(ctx, ink, caps(ink, s.labels.you), x + 34 * k, y - 26 * k, 10 * k, ink.accentInk);
}

function spotlight(ctx: CanvasRenderingContext2D, s: Scene, cx: number, cy: number, rad: number, cam: Camera): void {
  const age = s.now - s.spotlight!.t0;
  // in over 0.4 s, held, then out by 4 s (a spotlight is a moment, not a mode)
  const t = Math.max(0, Math.min(1, age / (s.reduced ? 1 : 420))) * Math.max(0, Math.min(1, (4000 - age) / 700));
  if (t <= 0) return;
  const v = cam.view(200);
  ctx.save();
  ctx.beginPath(); ctx.rect(v.x, v.y, v.w, v.h);
  const rr = rad * (1 + (1 - Math.max(0, Math.min(1, age / (s.reduced ? 1 : 420)))) * 3);
  ctx.moveTo(cx + rr, cy); ctx.arc(cx, cy, rr, 0, Math.PI * 2, true);
  ctx.fillStyle = s.ink.dark ? 'rgba(4, 12, 13, .62)' : 'rgba(19, 43, 46, .38)';
  ctx.globalAlpha = t;
  ctx.fill('evenodd');
  ctx.globalAlpha = 1;
  ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2);
  ctx.setLineDash([10 / cam.z, 6 / cam.z]); ctx.strokeStyle = s.ink.accent; ctx.lineWidth = 1.5 / cam.z; ctx.stroke();
  ctx.restore();
}

/** A Space as an instrument loop: a hexagon tag at its members' centre, signal lines to each. */
function spaceLoop(ctx: CanvasRenderingContext2D, s: Scene, pts: Pt[], name: string, z: number): void {
  if (!pts.length) return;
  const ink = s.ink;
  const px = 1 / z;
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length, cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  ctx.beginPath();
  for (const p of pts) { ctx.moveTo(cx, cy); ctx.lineTo(p[0], p[1]); }
  ctx.setLineDash([7 * Math.max(1, px), 5 * Math.max(1, px)]);
  ctx.strokeStyle = ink.accent; ctx.lineWidth = Math.max(1.4, 1.4 * px); ctx.stroke(); ctx.setLineDash([]);
  for (const p of pts) { ctx.beginPath(); ctx.arc(p[0], p[1], Math.max(3, 3 * px), 0, Math.PI * 2); ctx.fillStyle = ink.accent; ctx.fill(); }
  const size = Math.max(12, 12 * px);
  ctx.font = `600 ${size}px ${ink.display}`;
  const label = `# ${name}`;
  const w = ctx.measureText(label).width + size * 2.4, h = size * 2.4;
  ctx.beginPath();
  ctx.moveTo(cx - w / 2, cy); ctx.lineTo(cx - w / 2 + h / 2, cy - h / 2); ctx.lineTo(cx + w / 2 - h / 2, cy - h / 2); ctx.lineTo(cx + w / 2, cy); ctx.lineTo(cx + w / 2 - h / 2, cy + h / 2); ctx.lineTo(cx - w / 2 + h / 2, cy + h / 2); ctx.closePath();
  ctx.fillStyle = ink.paper; ctx.fill(); ctx.strokeStyle = ink.accent; ctx.lineWidth = Math.max(1.6, 1.6 * px); ctx.stroke();
  ctx.fillStyle = ink.accentInk; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(label, cx, cy + 0.5);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
}

// ------------------------------------------------------------------ the floor plan
export function drawFloor(ctx: CanvasRenderingContext2D, f: Floor, s: Scene, cam: Camera, walk: Pt[] | null): void {
  const ink = s.ink;
  const z = cam.z;
  const px = 1 / z;
  const v = cam.view(60);
  sheetBackground(ctx, s, f.w, f.h, cam);
  const a0 = introAlpha(s, 0);
  ctx.globalAlpha = a0;
  // the building: a thick outer wall with poché (hatched) between its faces
  const b = f.building;
  ctx.save();
  ctx.beginPath(); ctx.rect(b.x, b.y, b.w, b.h); ctx.rect(b.x + 10, b.y + 10, b.w - 20, b.h - 20); ctx.clip('evenodd');
  ctx.beginPath();
  for (let d = -b.h; d < b.w; d += 7) { ctx.moveTo(b.x + d, b.y + b.h); ctx.lineTo(b.x + d + b.h, b.y); }
  ctx.strokeStyle = ink.text3; ctx.lineWidth = Math.max(0.6, 0.6 * px); ctx.stroke();
  ctx.restore();
  ctx.strokeStyle = ink.text2; ctx.lineWidth = Math.max(1.4, 1.4 * px);
  ctx.strokeRect(b.x, b.y, b.w, b.h); ctx.strokeRect(b.x + 10, b.y + 10, b.w - 20, b.h - 20);
  // the corridor's centre line and name
  const bayBottom = Math.max(...f.rooms.filter((r) => r.kind === 'bay').map((r) => r.y + r.h), b.y + 120);
  const lowTop = Math.min(...f.rooms.filter((r) => r.kind !== 'bay').map((r) => r.y), b.y + b.h - 10);
  const cyL = (bayBottom + lowTop) / 2;
  ctx.beginPath(); ctx.moveTo(b.x + 24, cyL); ctx.lineTo(b.x + b.w - 24, cyL);
  ctx.setLineDash([22, 5, 3, 5]); ctx.strokeStyle = ink.text3; ctx.lineWidth = Math.max(0.8, 0.8 * px); ctx.stroke(); ctx.setLineDash([]);
  ctx.font = `600 ${Math.max(10, 10 * px * 0.9)}px ${ink.latinCaps ? ink.mono : ink.body}`;
  ctx.fillStyle = ink.text3;
  ctx.fillText(caps(ink, s.labels.corridor), b.x + 30, cyL - 6);
  // north point
  northArrow(ctx, ink, b.x + b.w - 44, b.y + 44, s.labels.north);

  // rooms: walls, a door with its swing, the room's name
  for (const r of f.rooms) {
    if (!intersects(r.x - 30, r.y - 30, r.w + 60, r.h + 60, v)) continue;
    const dw = 40, side = r.door.side;
    const wy = side === 'top' ? r.y : r.y + r.h;
    ctx.beginPath();
    ctx.moveTo(r.door.x - dw / 2, wy);
    if (side === 'bottom') { ctx.lineTo(r.x, wy); ctx.lineTo(r.x, r.y); ctx.lineTo(r.x + r.w, r.y); ctx.lineTo(r.x + r.w, wy); }
    else { ctx.lineTo(r.x, wy); ctx.lineTo(r.x, r.y + r.h); ctx.lineTo(r.x + r.w, r.y + r.h); ctx.lineTo(r.x + r.w, wy); }
    ctx.lineTo(r.door.x + dw / 2, wy);
    ctx.strokeStyle = ink.text2; ctx.lineWidth = Math.max(3, 3 * px * 0.7); ctx.stroke();
    // the door leaf and its swing
    const dir = side === 'top' ? 1 : -1;
    ctx.beginPath(); ctx.moveTo(r.door.x - dw / 2, wy); ctx.lineTo(r.door.x - dw / 2, wy + dir * dw);
    ctx.strokeStyle = ink.text2; ctx.lineWidth = Math.max(1.2, 1.2 * px); ctx.stroke();
    ctx.beginPath(); ctx.arc(r.door.x - dw / 2, wy, dw, dir > 0 ? 0 : -Math.PI / 2, dir > 0 ? Math.PI / 2 : 0);
    ctx.strokeStyle = ink.text3; ctx.lineWidth = Math.max(0.7, 0.7 * px); ctx.stroke();
    // name: BAY 2 · Piping (the department most of its people are in)
    const label = r.kind === 'bay' ? s.labels.bay(r.name) : r.kind === 'cabin' ? s.labels.cabin(r.name) : r.name;
    const ts = Math.min(Math.max(10, 10 * px * 0.75), r.w / 9);
    const tw = tag(ctx, ink, caps(ink, label), r.x + 10, side === 'bottom' ? r.y + 8 : r.y + r.h - 8 - ts * 1.55, ts, ink.accentInk);
    if (r.kind === 'bay') {
      const counts = new Map<string, number>();
      for (const d of f.desks) if (d.room === r.key && d.occupant) { const k = s.users.get(d.occupant)?.profile.departmentId ?? ''; if (k) counts.set(k, (counts.get(k) ?? 0) + 1); }
      const top = [...counts.entries()].sort((a, b2) => b2[1] - a[1])[0];
      if (top) { ctx.font = `600 ${ts * 1.3}px ${ink.display}`; ctx.fillStyle = ink.text; ctx.fillText(fit(ctx, s.deptName(top[0]), r.w - tw - 30), r.x + 16 + tw, r.y + 8 + ts * 1.2); }
    }
  }
  // desks: a top with a chair at its edge; the person on it, or the desk left dashed for the day
  for (const d of f.desks) {
    if (!intersects(d.x, d.y, d.w, d.h, v)) continue;
    const away = d.occupant ? f.spots.get(d.occupant)?.where === 'away' : false;
    const dx = d.x + 6, dy = d.y + 6, dwid = DESK_W - 12, dh = DESK_H - 22;
    const top = d.facing === 'down' ? dy : dy + 16;
    ctx.beginPath(); ctx.rect(dx, top, dwid, dh);
    ctx.fillStyle = ink.paper; ctx.fill();
    if (away) ctx.setLineDash([5, 3]);
    ctx.strokeStyle = ink.strokeStrong; ctx.lineWidth = Math.max(1, px); ctx.stroke(); ctx.setLineDash([]);
    // chair
    const chy = d.facing === 'down' ? top + dh + 3 : top - 13;
    ctx.beginPath(); rrect(ctx, dx + dwid / 2 - 12, chy, 24, 10, 4); ctx.strokeStyle = ink.strokeStrong; ctx.stroke();
    ctx.font = `600 9px ${ink.mono}`; ctx.fillStyle = ink.text3; ctx.fillText(d.label, dx + 4, top + 11);
    if (away && d.occupant) {
      const mode = s.modeOf(d.occupant);
      const word = mode === 'home' ? s.labels.home : mode === 'client' ? s.labels.client : s.labels.site;
      ctx.font = `600 9px ${ink.latinCaps ? ink.mono : ink.body}`; ctx.fillStyle = ink.text3;
      ctx.textAlign = 'right'; ctx.fillText(caps(ink, word), dx + dwid - 4, top + dh - 5); ctx.textAlign = 'left';
    }
  }
  // the off-site key and people with no seat
  const keyBox = (x: number, y: number, w: number, h: number, title: string) => {
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.fillStyle = ink.paper; ctx.fill();
    ctx.setLineDash([10, 4, 2, 4]); ctx.strokeStyle = ink.accent; ctx.lineWidth = Math.max(1, px); ctx.stroke(); ctx.setLineDash([]);
    tag(ctx, ink, caps(ink, title), x + 10, y + 10, 10, ink.accentInk);
  };
  if (f.away.some((a) => a.people.length)) {
    const k0 = f.away[0];
    ctx.font = `600 13px ${ink.display}`; ctx.fillStyle = ink.text;
    ctx.fillText(s.labels.awayKey, k0.x, k0.y - 12);
  }
  for (const a of f.away) keyBox(a.x, a.y, a.w, a.h, a.mode === 'home' ? s.labels.home : a.mode === 'site' ? s.labels.site : s.labels.client);
  if (f.unseated.people.length) keyBox(f.unseated.x, f.unseated.y, f.unseated.w, f.unseated.h, s.labels.noSeat);
  ctx.globalAlpha = 1;

  // a walk from one desk to another, along the corridor
  if (walk && walk.length > 1) {
    ctx.beginPath(); run(ctx, walk, 18);
    ctx.strokeStyle = ink.paper; ctx.lineWidth = Math.max(7, 7 * px); ctx.stroke();
    ctx.strokeStyle = ink.accent; ctx.lineWidth = Math.max(3, 3 * px);
    ctx.setLineDash([2 * Math.max(1, px), 9 * Math.max(1, px)]); ctx.lineCap = 'round';
    if (!s.reduced && s.route) ctx.lineDashOffset = -((s.now - s.route.t0) / 30) * Math.max(1, px);
    ctx.stroke(); ctx.setLineDash([]); ctx.lineCap = 'butt'; ctx.lineDashOffset = 0;
  }

  // people
  const dim = (id: string) => (s.route ? !s.route.ids.includes(id) : s.overlay ? !s.overlay.members.has(id) : false);
  for (const sp of f.spots.values()) {
    if (!intersects(sp.x - 40, sp.y - 40, 80, 80, v)) continue;
    const u = s.users.get(sp.id);
    if (!u) continue;
    ctx.globalAlpha = introAlpha(s, (sp.x / Math.max(1, f.w)) * 500) * (dim(sp.id) ? 0.25 : 1);
    const sz = sp.where === 'desk' ? TILE : 32;
    const ty = sp.y;
    if (s.selected === sp.id || s.hover === sp.id) { ctx.beginPath(); rrect(ctx, sp.x - sz / 2 - 8, ty - sz / 2 - 8, sz + 16, sz + 16, 9); ctx.fillStyle = ink.accentSoft; ctx.fill(); }
    tile(ctx, s, u, sp.x, ty, sz);
    if (z > 0.55) {
      ctx.font = `600 10.5px ${ink.body}`; ctx.fillStyle = ink.text; ctx.textAlign = 'center';
      ctx.fillText(fit(ctx, u.displayName.split(/\s+/)[0], 80), sp.x, ty + sz / 2 + 13);
      ctx.textAlign = 'left';
    }
    const m = s.marks.get(sp.id);
    if (m?.isNew) {
      // the cloud goes round the tile and its name together, so no scallop runs through the name
      ctx.font = `600 10.5px ${ink.body}`;
      const nameW = z > 0.55 ? Math.min(80, ctx.measureText(u.displayName.split(/\s+/)[0]).width) : 0;
      const cw = Math.max(sz, nameW) + 18, chh = sz + (z > 0.55 ? 17 : 0) + 18;
      ctx.beginPath(); cloud(ctx, sp.x - cw / 2, ty - sz / 2 - 9, cw, chh, 9); ctx.strokeStyle = ink.accent; ctx.lineWidth = Math.max(1.2, 1.2 * px); ctx.stroke();
    }
    if (m?.birthday) pennant(ctx, sp.x + sz / 2 + (m.isNew ? 16 : 2), ty - sz / 2 - 12, ink.accent);
    if (sp.id === s.me) youAreHere(ctx, s, sp.x, ty - sz / 2 - 4, z, true);
    if (s.focus === sp.id) { ctx.beginPath(); rrect(ctx, sp.x - sz / 2 - 7, ty - sz / 2 - 7, sz + 14, sz + 14, 9); ctx.strokeStyle = ink.accent; ctx.lineWidth = Math.max(2.5, 2.5 * px); ctx.stroke(); }
  }
  ctx.globalAlpha = 1;
  if (s.overlay && !s.route) spaceLoop(ctx, s, [...s.overlay.members].flatMap((id) => { const p = f.spots.get(id); return p ? [[p.x, p.y] as Pt] : []; }), s.overlay.name, z);
  for (const pig of s.pigs) {
    const sp = f.spots.get(pig.id);
    const t = (s.now - pig.t0) / 1200;
    if (!sp || t < 0 || t > 1) continue;
    ctx.beginPath(); ctx.arc(sp.x, sp.y, 22 + t * 26, 0, Math.PI * 2);
    ctx.strokeStyle = pig.room ? ink.amber : ink.accent; ctx.lineWidth = Math.max(2, 2 * px); ctx.globalAlpha = 1 - t; ctx.stroke(); ctx.globalAlpha = 1;
  }
  if (s.spotlight) {
    const sp = f.spots.get(s.spotlight.id);
    if (sp) spotlight(ctx, s, sp.x, sp.y, 70, cam);
  }
}

function northArrow(ctx: CanvasRenderingContext2D, ink: Ink, x: number, y: number, n: string): void {
  ctx.beginPath(); ctx.arc(x, y, 18, 0, Math.PI * 2); ctx.strokeStyle = ink.text2; ctx.lineWidth = 1; ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x, y - 24); ctx.lineTo(x + 7, y + 10); ctx.lineTo(x, y + 4); ctx.closePath(); ctx.fillStyle = ink.text2; ctx.fill();
  ctx.beginPath(); ctx.moveTo(x, y - 24); ctx.lineTo(x - 7, y + 10); ctx.lineTo(x, y + 4); ctx.closePath(); ctx.stroke();
  ctx.font = `600 11px ${ink.display}`; ctx.fillStyle = ink.text2; ctx.textAlign = 'center'; ctx.fillText(n, x, y - 28); ctx.textAlign = 'left';
}

/** The walking route between two spots: out of one room's door, along the corridor, into the other's. */
export function walkBetween(f: Floor, a: string, b: string): Pt[] | null {
  const A = f.spots.get(a), B = f.spots.get(b);
  if (!A || !B || !A.room || !B.room) return null;
  const ra = f.rooms.find((r) => r.key === A.room)!, rb = f.rooms.find((r) => r.key === B.room)!;
  const bayBottom = Math.max(...f.rooms.filter((r) => r.kind === 'bay').map((r) => r.y + r.h));
  const low = f.rooms.filter((r) => r.kind !== 'bay');
  const cy = low.length ? (bayBottom + Math.min(...low.map((r) => r.y))) / 2 : bayBottom + 48;
  const door = (r: typeof ra): Pt => [r.door.x, r.door.side === 'top' ? r.y : r.y + r.h];
  if (ra === rb) return [[A.x, A.y], [B.x, A.y], [B.x, B.y]];
  const da = door(ra), db = door(rb);
  return [[A.x, A.y], [A.x, (A.y + da[1]) / 2], [da[0], (A.y + da[1]) / 2], [da[0], cy], [db[0], cy], [db[0], (B.y + db[1]) / 2], [B.x, (B.y + db[1]) / 2], [B.x, B.y]];
}

// ------------------------------------------------------------------ rulers along the edges
export function drawRulers(ctx: CanvasRenderingContext2D, cam: Camera, ink: Ink, cols: number, rows: number): void {
  const band = 18;
  ctx.fillStyle = ink.paper;
  ctx.globalAlpha = 0.94;
  ctx.fillRect(0, 0, cam.vw, band); ctx.fillRect(0, 0, band, cam.vh);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = ink.strokeStrong; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, band + 0.5); ctx.lineTo(cam.vw, band + 0.5); ctx.moveTo(band + 0.5, 0); ctx.lineTo(band + 0.5, cam.vh); ctx.stroke();
  ctx.font = `600 10px ${ink.mono}`;
  ctx.fillStyle = ink.text3; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.beginPath();
  for (let i = 0; i <= cols; i++) {
    const [sx] = cam.toScreen(MARGIN + i * GRID, 0);
    if (sx > band && sx < cam.vw) { ctx.moveTo(Math.round(sx) + 0.5, band - 6); ctx.lineTo(Math.round(sx) + 0.5, band); }
    if (i < cols) { const [cx] = cam.toScreen(MARGIN + (i + 0.5) * GRID, 0); if (cx > band + 6 && cx < cam.vw - 6) ctx.fillText(colLetter(i), cx, band / 2 + 1); }
  }
  for (let j = 0; j <= rows; j++) {
    const [, sy] = cam.toScreen(0, MARGIN + j * GRID);
    if (sy > band && sy < cam.vh) { ctx.moveTo(band - 6, Math.round(sy) + 0.5); ctx.lineTo(band, Math.round(sy) + 0.5); }
    if (j < rows) { const [, cy] = cam.toScreen(0, MARGIN + (j + 0.5) * GRID); if (cy > band + 6 && cy < cam.vh - 6) ctx.fillText(String(j + 1), band / 2, cy); }
  }
  ctx.strokeStyle = ink.text3; ctx.stroke();
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = ink.paper; ctx.fillRect(0, 0, band, band);
}

/** Hit test: the plate or spot under a world point. */
export function hitGA(ga: GA, wx: number, wy: number): string | null {
  for (const p of ga.plates.values()) if (wx >= p.x - 4 && wx <= p.x + PLATE_W + 4 && wy >= p.y - 4 && wy <= p.y + PLATE_H + 4) return p.id;
  return null;
}
export function hitFloor(f: Floor, wx: number, wy: number): string | null {
  let best: string | null = null, d = 30;
  for (const sp of f.spots.values()) { const dd = Math.hypot(sp.x - wx, sp.y - wy); if (dd < d) { d = dd; best = sp.id; } }
  return best;
}
