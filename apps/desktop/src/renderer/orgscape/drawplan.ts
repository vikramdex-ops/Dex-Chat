// Draws the office's real floor plan in the drawing-office language: walls with poché, glazing as
// two hairlines, doors with their swing, columns hatched, fixed furniture as simple symbols, every
// seat with its desk and chair (people on them, empty ones visible), room names and sizes, the
// dimension strings as drawn, the north point. On top: departments as a colour wash, pending moves
// as dashed arrows, revision clouds when two revisions are compared, and the layout editor's
// selection. Only what is in view is drawn, and how much depends on the zoom.
import type { FloorPlan, PlanFixture, PlanSeat, Pt as FPt } from '@dex/core';
import { deskCorners, facingVec } from '@dex/core';
import type { Camera } from './camera.ts';
import type { Floor } from './floor.ts';
import type { Pt } from './layout.ts';
import type { PlanModel, PlanSeatView } from './plan.ts';
import { K } from './plan.ts';
import type { Ink, Scene } from './render.ts';
import { caps, cloud, drawOffsite, drawSpots, drawWalk, fit, intersects, introAlpha, northArrow, rrect, sheetBackground, tag, tile } from './render.ts';

/** What the plan adds to the scene: modes, overlays and the editor's state. */
export interface PlanScene {
  mode: 'view' | 'arrange' | 'layout';
  /** Departments as a colour wash on the seats they hold. */
  wash: boolean;
  deptColor: (id: string) => string;
  /** Moves still to happen: from seat to seat (null: from no seat / to no seat). */
  pending: Array<{ from: string | null; to: string | null; userId: string | null; draft: boolean }>;
  /** Seats changed between two revisions, and the later revision's letter. */
  clouds: { seats: Set<string>; rev: string } | null;
  hoverSeat: string | null;
  focusSeat: string | null;
  selSeats: Set<string>;
  selRoom: string | null;
  /** A person (or people) being dragged to a seat. */
  drag: { ids: string[]; x: number; y: number; target: string | null; swap: boolean } | null;
  /** Seats the editor found a problem with (overlapping). */
  bad: Set<string>;
  underlay: { img: CanvasImageSource; x: number; y: number; w: number; h: number; opacity: number } | null;
  words: { free: string; hot: string; booked: string; nos: (n: number) => string; zoneSeats: (n: number) => string };
}

const lineW = (px: number, w: number) => Math.max(w, w * px);
const X = (m: PlanModel, v: number) => m.ox + v * K;
const Y = (m: PlanModel, v: number) => m.oy + v * K;

function poly(ctx: CanvasRenderingContext2D, m: PlanModel, p: FPt[]): void {
  p.forEach(([x, y], i) => (i ? ctx.lineTo(X(m, x), Y(m, y)) : ctx.moveTo(X(m, x), Y(m, y))));
  ctx.closePath();
}

/** Diagonal hatching (poché) inside the current path. */
function hatch(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, step: number, color: string, width: number): void {
  ctx.save();
  ctx.clip('evenodd');
  ctx.beginPath();
  for (let d = -h; d < w; d += step) { ctx.moveTo(x + d, y + h); ctx.lineTo(x + d + h, y); }
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
  ctx.restore();
}

export function drawPlanFloor(ctx: CanvasRenderingContext2D, f: Floor, s: Scene, cam: Camera, walk: Pt[] | null): void {
  const m = f.plan!;
  const ps = s.seating!;
  const plan = m.plan;
  const ink = s.ink;
  const z = cam.z, px = 1 / z;
  const v = cam.view(60);
  sheetBackground(ctx, s, f.w, f.h, cam);
  ctx.globalAlpha = introAlpha(s, 0);
  const b = f.building;

  if (ps.underlay) {
    const u = ps.underlay;
    ctx.globalAlpha = u.opacity;
    try { ctx.drawImage(u.img, X(m, u.x), Y(m, u.y), u.w * K, u.h * K); } catch { /* not decoded yet */ }
    ctx.globalAlpha = 1;
  }

  // the outer wall: a band of poché round the floor
  const t = 0.8 * K;
  ctx.beginPath(); ctx.rect(b.x - t, b.y - t, b.w + t * 2, b.h + t * 2); ctx.rect(b.x, b.y, b.w, b.h);
  hatch(ctx, b.x - t, b.y - t, b.w + t * 2, b.h + t * 2, 7, ink.text3, lineW(px, 0.6));
  ctx.beginPath(); ctx.rect(b.x - t, b.y - t, b.w + t * 2, b.h + t * 2); ctx.rect(b.x, b.y, b.w, b.h);
  ctx.strokeStyle = ink.text2; ctx.lineWidth = lineW(px, 1.4); ctx.stroke();

  // rooms: a faint fill so cabins and rooms read apart from the open floor
  for (const r of plan.rooms) {
    if (r.kind === 'area') continue;
    ctx.beginPath(); poly(ctx, m, r.poly);
    ctx.fillStyle = ink.subtle; ctx.globalAlpha = r.kind === 'cabin' ? 0.5 : 0.7; ctx.fill(); ctx.globalAlpha = 1;
    if (ps.selRoom === r.id) { ctx.fillStyle = ink.accentSoft; ctx.fill(); ctx.strokeStyle = ink.accent; ctx.lineWidth = lineW(px, 2); ctx.setLineDash([8 * px, 5 * px]); ctx.stroke(); ctx.setLineDash([]); }
  }

  // departments: a wash under the seats they hold
  if (ps.wash) {
    for (const sv of m.seats) {
      if (!sv.dept) continue;
      const c = deskCorners(sv.seat);
      const xs = [...c.map((q) => q[0]), sv.seat.x], ys = [...c.map((q) => q[1]), sv.seat.y];
      const x0 = X(m, Math.min(...xs) - 0.55), y0 = Y(m, Math.min(...ys) - 0.75), x1 = X(m, Math.max(...xs) + 0.55), y1 = Y(m, Math.max(...ys) + 0.75);
      ctx.beginPath(); rrect(ctx, x0, y0, x1 - x0, y1 - y0, 10);
      ctx.fillStyle = ps.deptColor(sv.dept); ctx.globalAlpha = ink.dark ? 0.42 : 0.3; ctx.fill(); ctx.globalAlpha = 1;
    }
  }

  // fixed furniture
  for (const fx of plan.fixtures) drawFixture(ctx, m, fx, ink, px, v, ps.words);

  // seats: desk, chair, ID; an empty one visible as an open chair
  const near = z > 0.55;
  for (const sv of m.seats) {
    if (!intersects(sv.x - 80, sv.y - 80, 160, 160, v)) continue;
    drawSeat(ctx, m, sv, s, ps, px, near);
  }

  // walls: partitions solid, glazing as two lines, the structural wall hatched
  for (const w of plan.walls) {
    const tw = Math.max(w.t * K, 2 * px);
    if (w.arc) {
      const { c, r, a0, a1 } = w.arc;
      ctx.beginPath(); ctx.arc(X(m, c[0]), Y(m, c[1]), r * K, (a0 * Math.PI) / 180, (a1 * Math.PI) / 180);
      if (w.kind === 'glass') { ctx.strokeStyle = ink.accentInk; ctx.lineWidth = lineW(px, 1); ctx.stroke(); ctx.beginPath(); ctx.arc(X(m, c[0]), Y(m, c[1]), r * K - tw, (a0 * Math.PI) / 180, (a1 * Math.PI) / 180); ctx.stroke(); }
      else { ctx.strokeStyle = ink.text2; ctx.lineWidth = tw; ctx.stroke(); }
      continue;
    }
    const a = w.a!, bb = w.b!;
    const [x1, y1, x2, y2] = [X(m, a[0]), Y(m, a[1]), X(m, bb[0]), Y(m, bb[1])];
    if (!intersects(Math.min(x1, x2) - tw, Math.min(y1, y2) - tw, Math.abs(x2 - x1) + tw * 2, Math.abs(y2 - y1) + tw * 2, v)) continue;
    if (w.kind === 'glass') {
      const len = Math.hypot(x2 - x1, y2 - y1) || 1, nx = (-(y2 - y1) / len) * (tw / 2), ny = ((x2 - x1) / len) * (tw / 2);
      ctx.beginPath(); ctx.moveTo(x1 + nx, y1 + ny); ctx.lineTo(x2 + nx, y2 + ny); ctx.moveTo(x1 - nx, y1 - ny); ctx.lineTo(x2 - nx, y2 - ny);
      ctx.strokeStyle = ink.accentInk; ctx.lineWidth = lineW(px, 1); ctx.stroke();
    } else if (w.kind === 'solid') {
      const x0 = Math.min(x1, x2) - tw / 2, y0 = Math.min(y1, y2), ww = Math.abs(x2 - x1) + tw, hh = Math.abs(y2 - y1) || tw;
      ctx.beginPath(); ctx.rect(x0, y0, ww, hh); ctx.fillStyle = ink.paper; ctx.fill(); ctx.strokeStyle = ink.text2; ctx.lineWidth = lineW(px, 1); ctx.stroke();
      ctx.beginPath(); ctx.rect(x0, y0, ww, hh); hatch(ctx, x0, y0, ww, hh, 6, ink.text3, lineW(px, 0.5));
    } else {
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.strokeStyle = ink.text2; ctx.lineWidth = tw; ctx.lineCap = 'butt'; ctx.stroke();
    }
  }
  // columns
  for (const c of plan.columns) {
    const x0 = X(m, c.x), y0 = Y(m, c.y), w = c.w * K, h = c.h * K;
    if (!intersects(x0, y0, w, h, v)) continue;
    ctx.beginPath(); ctx.rect(x0, y0, w, h); ctx.fillStyle = ink.paper; ctx.fill();
    ctx.beginPath(); ctx.rect(x0, y0, w, h); hatch(ctx, x0, y0, w, h, 5, ink.text3, lineW(px, 0.6));
    ctx.beginPath(); ctx.rect(x0, y0, w, h); ctx.strokeStyle = ink.text2; ctx.lineWidth = lineW(px, 1.4); ctx.stroke();
  }
  // doors: the leaf open, and its swing
  for (const d of plan.doors) {
    const hx = X(m, d.hinge[0]), hy = Y(m, d.hinge[1]);
    const r = Math.hypot(d.open[0] - d.hinge[0], d.open[1] - d.hinge[1]) * K;
    if (!intersects(hx - r, hy - r, r * 2, r * 2, v)) continue;
    const a0 = Math.atan2(d.closed[1] - d.hinge[1], d.closed[0] - d.hinge[0]), a1 = Math.atan2(d.open[1] - d.hinge[1], d.open[0] - d.hinge[0]);
    let diff = a1 - a0; while (diff > Math.PI) diff -= Math.PI * 2; while (diff < -Math.PI) diff += Math.PI * 2;
    // clear the wall where the door is
    ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(X(m, d.closed[0]), Y(m, d.closed[1])); ctx.strokeStyle = ink.paper; ctx.lineWidth = Math.max(9 * px, 0.4 * K); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(X(m, d.open[0]), Y(m, d.open[1])); ctx.strokeStyle = ink.text2; ctx.lineWidth = lineW(px, 1.6); ctx.stroke();
    ctx.beginPath(); ctx.arc(hx, hy, r, a0, a0 + diff, diff < 0); ctx.strokeStyle = ink.text3; ctx.lineWidth = lineW(px, 0.8); ctx.stroke();
  }

  // room names and sizes, and the drawing's own notes
  if (z > 0.16) {
    for (const r of plan.rooms) {
      if (r.kind === 'area') continue;
      const xs = r.poly.map((q) => q[0]), ys = r.poly.map((q) => q[1]);
      const cx = X(m, (Math.min(...xs) + Math.max(...xs)) / 2), top = Y(m, Math.min(...ys)), w = (Math.max(...xs) - Math.min(...xs)) * K;
      if (!intersects(cx - w / 2, top, w, 80, v)) continue;
      const small = r.kind === 'cabin';
      if (small && z < 0.45) continue;
      const size = small ? 9 : Math.max(11, Math.min(15, 11 * px * 0.8));
      ctx.font = `600 ${size}px ${ink.latinCaps ? ink.mono : ink.body}`; ctx.fillStyle = ink.text2; ctx.textAlign = 'center';
      const lx = r.label ? X(m, r.label[0]) : cx;
      const cy = r.label ? Y(m, r.label[1]) : small ? top + 13 : r.id === 'conference' ? top + 46 : top + (Math.max(...ys) - Math.min(...ys)) * K * 0.42;
      ctx.fillText(fit(ctx, caps(ink, r.name), w - 8), lx, cy);
      if (r.dims && !small) { ctx.font = `500 ${size * 0.85}px ${ink.mono}`; ctx.fillStyle = ink.text3; ctx.fillText(r.dims, lx, cy + size * 1.3); }
      ctx.textAlign = 'left';
    }
    for (const l of plan.labels) {
      ctx.font = `600 ${Math.max(10, 10 * px * 0.8)}px ${ink.latinCaps ? ink.mono : ink.body}`; ctx.fillStyle = ink.text3; ctx.textAlign = 'center';
      ctx.fillText(l.text, X(m, l.at[0]), Y(m, l.at[1])); ctx.textAlign = 'left';
    }
  }
  if (z > 0.1) for (const d of plan.dims) drawDim(ctx, m, d.a, d.b, d.off, d.text, ink, px);
  northArrow(ctx, ink, b.x + b.w + 110, b.y - 110, s.labels.north);

  // what is about to change
  drawPending(ctx, m, s, ps, px);
  // revision clouds round seats that changed between the revisions compared
  if (ps.clouds) {
    for (const id of ps.clouds.seats) {
      const sv = m.byId.get(id);
      if (!sv) continue;
      const c = deskCorners(sv.seat);
      const xs = [...c.map((q) => q[0]), sv.seat.x], ys = [...c.map((q) => q[1]), sv.seat.y];
      const x0 = X(m, Math.min(...xs) - 0.9), y0 = Y(m, Math.min(...ys) - 1.1), w = (Math.max(...xs) - Math.min(...xs) + 1.8) * K, h = (Math.max(...ys) - Math.min(...ys) + 2.2) * K;
      ctx.beginPath(); cloud(ctx, x0, y0, w, h, 11); ctx.strokeStyle = ink.accent; ctx.lineWidth = lineW(px, 1.6); ctx.stroke();
      revTriangle(ctx, ink, x0 + w + 4, y0 - 4, ps.clouds.rev, px);
    }
  }
  ctx.globalAlpha = 1;
  drawOffsite(ctx, f, s, cam);
  drawWalk(ctx, s, walk, px);
  drawSpots(ctx, f, s, cam, 30);
  // the drag: a ghost under the pointer, and the seat it would land on
  if (ps.drag) {
    const tgt = ps.drag.target ? m.byId.get(ps.drag.target) : null;
    if (tgt) {
      ctx.beginPath(); ctx.arc(tgt.x, tgt.y, 26, 0, Math.PI * 2); ctx.strokeStyle = ps.drag.swap ? ink.amber : ink.accent; ctx.lineWidth = lineW(px, 3); ctx.stroke();
    }
    const u = s.users.get(ps.drag.ids[0]);
    if (u) {
      ctx.globalAlpha = 0.85; tile(ctx, s, u, ps.drag.x, ps.drag.y, 30); ctx.globalAlpha = 1;
      if (ps.drag.ids.length > 1) tag(ctx, ink, `+${ps.drag.ids.length - 1}`, ps.drag.x + 18, ps.drag.y - 30, 10, ink.accentInk);
    }
  }
}

function drawSeat(ctx: CanvasRenderingContext2D, m: PlanModel, sv: PlanSeatView, s: Scene, ps: PlanScene, px: number, near: boolean): void {
  const ink = s.ink;
  const seat = sv.seat;
  const c = deskCorners(seat).map(([x, y]) => [X(m, x), Y(m, y)] as const);
  // the desk
  ctx.beginPath(); c.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath();
  ctx.fillStyle = ink.paper; ctx.fill();
  if (sv.away) ctx.setLineDash([5 * Math.max(1, px * 0.5), 3]);
  const sel = ps.selSeats.has(seat.id), bad = ps.bad.has(seat.id);
  ctx.strokeStyle = bad ? ink.amberInk : sel ? ink.accent : ink.strokeStrong.startsWith('rgba') ? ink.text3 : ink.strokeStrong;
  ctx.lineWidth = lineW(px, sel || bad ? 2 : 1); ctx.stroke(); ctx.setLineDash([]);
  if (sv.holder?.kind === 'reserved') {
    ctx.beginPath(); c.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath();
    const xs = c.map((q) => q[0]), ys = c.map((q) => q[1]);
    hatch(ctx, Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 6, ink.text3, lineW(px, 0.5));
  }
  // the chair (open when nobody sits there)
  const [fx, fy] = facingVec(seat.facing);
  const ang = Math.atan2(fy, fx) + Math.PI / 2;
  ctx.save(); ctx.translate(sv.x, sv.y); ctx.rotate(ang);
  ctx.beginPath(); rrect(ctx, -11, -9, 22, 18, 6);
  const empty = !sv.holder;
  if (empty && ps.mode !== 'view') { ctx.fillStyle = ink.accentSoft; ctx.fill(); }
  ctx.strokeStyle = empty ? ink.accent : ink.text3; ctx.lineWidth = lineW(px, 1);
  if (empty) ctx.setLineDash([3, 2.5]);
  ctx.stroke(); ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(-11, 12); ctx.lineTo(11, 12); ctx.strokeStyle = ink.text3; ctx.lineWidth = lineW(px, 1); ctx.stroke();
  ctx.restore();
  if (sel || bad || ps.hoverSeat === seat.id || ps.focusSeat === seat.id) {
    ctx.beginPath(); ctx.arc(sv.x, sv.y, 22, 0, Math.PI * 2);
    ctx.strokeStyle = bad ? ink.amberInk : ink.accent; ctx.lineWidth = lineW(px, ps.focusSeat === seat.id ? 2.5 : 1.5); ctx.stroke();
  }
  if (!near) return;
  // the seat's ID on the desk, and what holds it when nobody is drawn there
  const dcx = (c[0][0] + c[2][0]) / 2, dcy = (c[0][1] + c[2][1]) / 2;
  ctx.font = `600 9px ${ink.mono}`; ctx.fillStyle = ink.text3; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(seat.id, dcx, dcy);
  if (!sv.occupant || sv.away) {
    const word = sv.holder?.kind === 'reserved' ? sv.holder.label : sv.holder?.kind === 'hot' ? ps.words.hot : !sv.holder ? ps.words.free : '';
    if (word) {
      ctx.font = `600 9.5px ${ink.latinCaps ? ink.mono : ink.body}`;
      ctx.fillStyle = sv.holder ? ink.text2 : ink.accentInk;
      const off = 23;
      ctx.fillText(fit(ctx, caps(ink, word), 92), sv.x - fx * off, sv.y - fy * off);
    }
  }
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
}

function drawFixture(ctx: CanvasRenderingContext2D, m: PlanModel, f: PlanFixture, ink: Ink, px: number, v: { x: number; y: number; w: number; h: number }, words: PlanScene['words']): void {
  const hair = lineW(px, 0.9);
  ctx.strokeStyle = ink.text3; ctx.lineWidth = hair;
  if (f.kind === 'poly' && f.pts) {
    ctx.beginPath(); poly(ctx, m, f.pts); ctx.fillStyle = ink.paper; ctx.fill(); ctx.stroke();
    if (f.lines) { ctx.beginPath(); for (const l of f.lines) { ctx.moveTo(X(m, l[0][0]), Y(m, l[0][1])); ctx.lineTo(X(m, l[1][0]), Y(m, l[1][1])); } ctx.stroke(); }
    return;
  }
  if (f.kind === 'outline') {
    ctx.beginPath(); for (const [x0, y0, x1, y1] of f.rects ?? []) ctx.rect(X(m, x0), Y(m, y0), (x1 - x0) * K, (y1 - y0) * K); ctx.stroke();
    ctx.beginPath(); for (const [x0, y0, x1, y1] of f.solid ?? []) ctx.rect(X(m, x0), Y(m, y0), (x1 - x0) * K, (y1 - y0) * K); ctx.strokeStyle = ink.text2; ctx.lineWidth = lineW(px, 1.4); ctx.stroke();
    return;
  }
  if (f.kind === 'arc' && f.c) {
    const cx = X(m, f.c[0]), cy = Y(m, f.c[1]), a0 = ((f.a0 ?? 0) * Math.PI) / 180, a1 = ((f.a1 ?? 0) * Math.PI) / 180;
    ctx.beginPath(); ctx.arc(cx, cy, (f.r1 ?? 1) * K, a0, a1); ctx.arc(cx, cy, (f.r0 ?? 1) * K, a1, a0, true); ctx.closePath();
    ctx.fillStyle = ink.paper; ctx.fill(); ctx.stroke();
    return;
  }
  const x = X(m, f.x ?? 0), y = Y(m, f.y ?? 0);
  if (f.kind === 'round' || f.kind === 'plant') {
    const r = (f.r ?? 0.8) * K;
    if (!intersects(x - r, y - r, r * 2, r * 2, v)) return;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = ink.paper; ctx.fill(); ctx.stroke();
    if (f.kind === 'plant') { ctx.beginPath(); for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * r * 0.9, y + Math.sin(a) * r * 0.9); } ctx.stroke(); }
    return;
  }
  if (f.kind === 'chair') {
    if (!intersects(x - 16, y - 16, 32, 32, v)) return;
    ctx.save(); ctx.translate(x, y); ctx.rotate(((f.rot ?? 0) * Math.PI) / 180);
    ctx.beginPath(); rrect(ctx, -10, -8, 20, 16, 5); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-10, 11); ctx.lineTo(10, 11); ctx.stroke();
    ctx.restore();
    return;
  }
  const w = (f.w ?? 1) * K, h = (f.h ?? 1) * K;
  if (!intersects(x, y, w, h, v)) return;
  if (f.kind === 'planter') {
    const r = h / 2;
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2); ctx.lineTo(x + r, y + h); ctx.arc(x + r, y + r, r, Math.PI / 2, Math.PI * 1.5); ctx.closePath();
    ctx.fillStyle = ink.accentSoft; ctx.fill(); ctx.strokeStyle = ink.accentInk; ctx.stroke();
    // leaves: a row of simple petals along the planter
    ctx.beginPath();
    for (let i = 0; i < 7; i++) { const lx = x + r + ((w - 2 * r) * i) / 6, ly = y + h / 2; ctx.moveTo(lx, ly); ctx.quadraticCurveTo(lx + 14, ly - h * 0.5, lx + 4, ly - h * 0.42); ctx.moveTo(lx, ly); ctx.quadraticCurveTo(lx - 10, ly + h * 0.5, lx - 2, ly + h * 0.42); }
    ctx.stroke();
    return;
  }
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.fillStyle = ink.paper; ctx.fill(); ctx.stroke();
  if (f.kind === 'sofa') {
    // the back along one side, arms at the ends
    const rot = f.rot ?? 0, b = 0.5 * K;
    ctx.beginPath();
    if (rot === 180) { ctx.moveTo(x, y + b); ctx.lineTo(x + w, y + b); } else if (rot === 0) { ctx.moveTo(x, y + h - b); ctx.lineTo(x + w, y + h - b); }
    else if (rot === 270) { ctx.moveTo(x + w - b, y); ctx.lineTo(x + w - b, y + h); } else { ctx.moveTo(x + b, y); ctx.lineTo(x + b, y + h); }
    if (rot === 0 || rot === 180) { ctx.moveTo(x + w / 2, y + b); ctx.lineTo(x + w / 2, y + h - b); } else { ctx.moveTo(x + b, y + h / 2); ctx.lineTo(x + w - b, y + h / 2); }
    ctx.stroke();
  } else if (f.kind === 'printer') {
    ctx.beginPath(); ctx.rect(x + w * 0.2, y + h * 0.15, w * 0.6, h * 0.35); ctx.stroke();
    ctx.font = `600 8px ${ink.mono}`; ctx.fillStyle = ink.text3; ctx.textAlign = 'center'; ctx.fillText('PRN', x + w / 2, y + h * 0.82); ctx.textAlign = 'left';
  } else if (f.kind === 'table' && f.seats) {
    ctx.font = `600 9px ${ink.mono}`; ctx.fillStyle = ink.text3; ctx.textAlign = 'center';
    ctx.save(); ctx.translate(x + w / 2, y + h / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(caps(ink, words.zoneSeats(f.seats)), 0, 3); ctx.restore(); ctx.textAlign = 'left';
  }
}

/** A dimension string as a drafter draws it: extension lines, a dimension line with ticks, the figure above. */
function drawDim(ctx: CanvasRenderingContext2D, m: PlanModel, a: FPt, b: FPt, off: number, text: string, ink: Ink, px: number): void {
  const horiz = Math.abs(b[1] - a[1]) < Math.abs(b[0] - a[0]);
  const ax = X(m, a[0]) + (horiz ? 0 : off * K), ay = Y(m, a[1]) + (horiz ? off * K : 0);
  const bx = X(m, b[0]) + (horiz ? 0 : off * K), by = Y(m, b[1]) + (horiz ? off * K : 0);
  ctx.beginPath();
  if (off) { ctx.moveTo(X(m, a[0]), Y(m, a[1])); ctx.lineTo(ax, ay); ctx.moveTo(X(m, b[0]), Y(m, b[1])); ctx.lineTo(bx, by); }
  ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
  const tk = 5;
  for (const [x, y] of [[ax, ay], [bx, by]]) { ctx.moveTo(x - tk, y + tk); ctx.lineTo(x + tk, y - tk); }
  ctx.strokeStyle = ink.text3; ctx.lineWidth = lineW(px, 0.7); ctx.stroke();
  const size = Math.max(10, Math.min(14, 10 * px * 0.75));
  ctx.font = `500 ${size}px ${ink.mono}`; ctx.fillStyle = ink.text2; ctx.textAlign = 'center';
  ctx.save(); ctx.translate((ax + bx) / 2, (ay + by) / 2); if (!horiz) ctx.rotate(-Math.PI / 2);
  const tw = ctx.measureText(text).width;
  if (tw < Math.hypot(bx - ax, by - ay) - 6 || Math.hypot(bx - ax, by - ay) > 60) ctx.fillText(text, 0, -4);
  ctx.restore(); ctx.textAlign = 'left';
}

function revTriangle(ctx: CanvasRenderingContext2D, ink: Ink, x: number, y: number, rev: string, px: number): void {
  const s = Math.max(12, 12 * Math.min(px, 2));
  ctx.beginPath(); ctx.moveTo(x, y - s); ctx.lineTo(x + s * 0.95, y + s * 0.6); ctx.lineTo(x - s * 0.95, y + s * 0.6); ctx.closePath();
  ctx.fillStyle = ink.paper; ctx.fill(); ctx.strokeStyle = ink.accent; ctx.lineWidth = lineW(px, 1.4); ctx.stroke();
  ctx.font = `700 ${s * 0.75}px ${ink.mono}`; ctx.fillStyle = ink.accentInk; ctx.textAlign = 'center'; ctx.fillText(rev, x, y + s * 0.38); ctx.textAlign = 'left';
}

/** Pending moves: a dashed arrow from the old seat to the new one; a ghost of who is coming. */
function drawPending(ctx: CanvasRenderingContext2D, m: PlanModel, s: Scene, ps: PlanScene, px: number): void {
  const ink = s.ink;
  for (const p of ps.pending) {
    const a = p.from ? m.byId.get(p.from) : null, b = p.to ? m.byId.get(p.to) : null;
    const color = p.draft ? ink.amberInk : ink.accent;
    if (a && b) {
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
      const mx = (a.x + b.x) / 2 - (dy / len) * Math.min(80, len * 0.18), my = (a.y + b.y) / 2 + (dx / len) * Math.min(80, len * 0.18);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(mx, my, b.x, b.y);
      ctx.setLineDash([8 * Math.max(1, px * 0.6), 6 * Math.max(1, px * 0.6)]); ctx.strokeStyle = color; ctx.lineWidth = lineW(px, 2); ctx.stroke(); ctx.setLineDash([]);
      const ang = Math.atan2(b.y - my, b.x - mx), hl = Math.max(12, 12 * Math.min(px, 2));
      const tx = b.x - Math.cos(ang) * 20, ty = b.y - Math.sin(ang) * 20;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(tx - Math.cos(ang - 0.4) * hl, ty - Math.sin(ang - 0.4) * hl); ctx.lineTo(tx - Math.cos(ang + 0.4) * hl, ty - Math.sin(ang + 0.4) * hl); ctx.closePath();
      ctx.fillStyle = color; ctx.fill();
    }
    if (b && p.userId) {
      const u = s.users.get(p.userId);
      if (u && !(b.occupant === p.userId)) { ctx.globalAlpha = 0.55; tile(ctx, s, u, b.x, b.y, 26, { ghost: true }); ctx.globalAlpha = 1; }
      ctx.beginPath(); ctx.arc(b.x, b.y, 19, 0, Math.PI * 2); ctx.setLineDash([3, 3]); ctx.strokeStyle = color; ctx.lineWidth = lineW(px, 1.5); ctx.stroke(); ctx.setLineDash([]);
    }
    if (a && !b) {
      // a seat being freed: a cross on its chair
      ctx.beginPath(); ctx.moveTo(a.x - 9, a.y - 9); ctx.lineTo(a.x + 9, a.y + 9); ctx.moveTo(a.x + 9, a.y - 9); ctx.lineTo(a.x - 9, a.y + 9);
      ctx.strokeStyle = color; ctx.lineWidth = lineW(px, 2); ctx.stroke();
    }
  }
}

/** The seat's position in world units (for flying to a seat). */
export const seatBox = (m: PlanModel, id: string): { x: number; y: number; w: number; h: number } | null => {
  const s = m.byId.get(id);
  return s ? { x: s.x - 24, y: s.y - 24, w: 48, h: 48 } : null;
};

/** A plan's seat, by id. */
export const seatIn = (plan: FloorPlan, id: string): PlanSeat | undefined => plan.seats.find((s) => s.id === id);
