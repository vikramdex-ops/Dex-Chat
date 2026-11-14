// A small technical drawing for each day, generated from the date: a piping isometric, a truss
// elevation, a flange section, contour lines, a gear pair or a building elevation. Every path is
// drawn in like a pen plotter (pathLength = 1). 600 × 360 units; no images, nothing downloaded.
import { rng } from './lines.ts';

export interface Stroke { d: string; kind: 'main' | 'dim' | 'fine' | 'hatch' | 'centre' }
export interface Label { x: number; y: number; text: string; anchor?: 'start' | 'middle' | 'end'; rotate?: number }
export interface Drawing { title: string; strokes: Stroke[]; labels: Label[]; nodes: Array<{ x: number; y: number; r: number }> }

const f = (n: number) => n.toFixed(1);
const line = (a: [number, number], b: [number, number]) => `M${f(a[0])} ${f(a[1])}L${f(b[0])} ${f(b[1])}`;
const circle = (cx: number, cy: number, r: number) => `M${f(cx - r)} ${f(cy)}a${f(r)} ${f(r)} 0 1 0 ${f(r * 2)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-r * 2)} 0`;

/** A dimension: extension ticks at both ends, the line, and its value. */
function dimension(a: [number, number], b: [number, number], off: number, text: string, out: Drawing): void {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux0 = -dy / len, uy0 = dx / len;
  const nx = ux0 * off, ny = uy0 * off;
  const A: [number, number] = [a[0] + nx, a[1] + ny], B: [number, number] = [b[0] + nx, b[1] + ny];
  out.strokes.push({ kind: 'fine', d: `${line(a, [a[0] + nx * 1.15, a[1] + ny * 1.15])}${line(b, [b[0] + nx * 1.15, b[1] + ny * 1.15])}` });
  out.strokes.push({ kind: 'dim', d: line(A, B) });
  // architectural ticks
  const t = 5, ux = dx / len, uy = dy / len;
  for (const P of [A, B]) out.strokes.push({ kind: 'dim', d: line([P[0] - (ux + ux0) * t, P[1] - (uy + uy0) * t], [P[0] + (ux + ux0) * t, P[1] + (uy + uy0) * t]) });
  const ang = Math.atan2(dy, dx) * 180 / Math.PI;
  out.labels.push({ x: (A[0] + B[0]) / 2 + nx * 0.35, y: (A[1] + B[1]) / 2 + ny * 0.35 - 4, text, anchor: 'middle', rotate: Math.abs(ang) > 90 ? ang + 180 : ang });
}

function isometric(r: () => number): Drawing {
  const out: Drawing = { title: 'PIPING ISOMETRIC', strokes: [], labels: [], nodes: [] };
  const dirs: Array<[number, number]> = [[Math.cos(Math.PI / 6), -Math.sin(Math.PI / 6)], [-Math.cos(Math.PI / 6), -Math.sin(Math.PI / 6)], [0, -1], [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)], [-Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)], [0, 1]];
  // a faint isometric grid
  for (let i = -6; i <= 14; i++) {
    out.strokes.push({ kind: 'hatch', d: line([i * 52, 360], [i * 52 + 360 * Math.tan(Math.PI / 3), 0]) });
    out.strokes.push({ kind: 'hatch', d: line([i * 52, 360], [i * 52 - 360 * Math.tan(Math.PI / 3), 0]) });
  }
  let p: [number, number] = [90 + r() * 60, 280 - r() * 40];
  let last = -1;
  const segs = 5 + Math.floor(r() * 3);
  out.nodes.push({ x: p[0], y: p[1], r: 4 });
  for (let i = 0; i < segs; i++) {
    let d = Math.floor(r() * 6);
    for (let k = 0; k < 6 && (d === last || (last >= 0 && d === (last + 3) % 6)); k++) d = (d + 1) % 6;
    const len = 50 + r() * 70;
    const q: [number, number] = [p[0] + dirs[d][0] * len, p[1] + dirs[d][1] * len];
    if (q[0] < 30 || q[0] > 570 || q[1] < 30 || q[1] > 330) continue;
    out.strokes.push({ kind: 'main', d: line(p, q) });
    if (i === 1 || i === segs - 2) {
      // a valve: two triangles meeting in the middle of the run
      const m: [number, number] = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      const n: [number, number] = [-dirs[d][1] * 7, dirs[d][0] * 7], u: [number, number] = [dirs[d][0] * 9, dirs[d][1] * 9];
      out.strokes.push({ kind: 'main', d: `M${f(m[0] - u[0] + n[0])} ${f(m[1] - u[1] + n[1])}L${f(m[0] + u[0] - n[0])} ${f(m[1] + u[1] - n[1])}L${f(m[0] + u[0] + n[0])} ${f(m[1] + u[1] + n[1])}L${f(m[0] - u[0] - n[0])} ${f(m[1] - u[1] - n[1])}Z` });
    }
    if (len > 80) dimension(p, q, 18, String(Math.round(len * 12.5)), out);
    out.nodes.push({ x: q[0], y: q[1], r: 3 });
    p = q; last = d;
  }
  out.labels.push({ x: p[0] + 8, y: p[1] - 10, text: `EL +${(100 + r() * 10).toFixed(3)}` });
  out.labels.push({ x: 40, y: 40, text: `${[2, 3, 4, 6, 8][Math.floor(r() * 5)]}"-P-${1000 + Math.floor(r() * 900)}-A1B` });
  return out;
}

function truss(r: () => number): Drawing {
  const out: Drawing = { title: 'TRUSS ELEVATION', strokes: [], labels: [], nodes: [] };
  const bays = 6 + Math.floor(r() * 3), x0 = 50, x1 = 550, yb = 250, rise = 70 + r() * 50;
  const w = (x1 - x0) / bays;
  const top = (x: number) => yb - rise * (1 - Math.abs((x - (x0 + x1) / 2) / ((x1 - x0) / 2))) - 20;
  out.strokes.push({ kind: 'main', d: line([x0, yb], [x1, yb]) });
  for (let i = 0; i < bays; i++) {
    const a = x0 + i * w, b = a + w;
    out.strokes.push({ kind: 'main', d: line([a, top(a)], [b, top(b)]) });
    out.strokes.push({ kind: 'main', d: line([b, yb], [b, top(b)]) });
    out.strokes.push({ kind: 'main', d: i < bays / 2 ? line([a, yb], [b, top(b)]) : line([a, top(a)], [b, yb]) });
    out.nodes.push({ x: b, y: yb, r: 2.5 }, { x: b, y: top(b), r: 2.5 });
  }
  out.strokes.push({ kind: 'main', d: line([x0, yb], [x0, top(x0)]) });
  for (const x of [x0, x1]) out.strokes.push({ kind: 'main', d: `M${x} ${yb}l-10 16h20z` });
  dimension([x0, yb + 26], [x1, yb + 26], 18, `${Math.round((x1 - x0) * 48)}`, out);
  dimension([x1 + 20, yb], [x1 + 20, top((x0 + x1) / 2)], 0, `${Math.round(rise * 30)}`, out);
  out.strokes.push({ kind: 'centre', d: line([(x0 + x1) / 2, 30], [(x0 + x1) / 2, yb + 50]) });
  return out;
}

function flange(r: () => number): Drawing {
  const out: Drawing = { title: 'FLANGE SECTION', strokes: [], labels: [], nodes: [] };
  const cx = 230 + r() * 60, cy = 180, R = 120, pcd = 90, bore = 42 + r() * 12, bolts = [4, 8, 8, 12][Math.floor(r() * 4)];
  out.strokes.push({ kind: 'main', d: circle(cx, cy, R) }, { kind: 'main', d: circle(cx, cy, bore) }, { kind: 'centre', d: circle(cx, cy, pcd) });
  for (let i = 0; i < bolts; i++) {
    const a = (i / bolts) * Math.PI * 2 + Math.PI / bolts;
    out.strokes.push({ kind: 'main', d: circle(cx + Math.cos(a) * pcd, cy + Math.sin(a) * pcd, 8) });
  }
  out.strokes.push({ kind: 'centre', d: line([cx - R - 24, cy], [cx + R + 24, cy]) }, { kind: 'centre', d: line([cx, cy - R - 24], [cx, cy + R + 24]) });
  // a hatched quarter
  for (let k = -R; k < R; k += 9) {
    const x = cx + k;
    if (x < cx + bore) continue;
    const h = Math.sqrt(Math.max(0, R * R - k * k));
    out.strokes.push({ kind: 'hatch', d: line([x, cy], [Math.min(x + h * 0.7, cx + R), cy - Math.min(h, (x - cx) * 0.7)]) });
  }
  dimension([cx - R, cy + R + 22], [cx + R, cy + R + 22], 8, `Ø ${(R * 2.1).toFixed(1)}`, out);
  out.labels.push({ x: cx + R + 30, y: cy - pcd * 0.7, text: `PCD ${(pcd * 2.1).toFixed(1)}` }, { x: cx + R + 30, y: cy - pcd * 0.7 + 16, text: `${bolts} HOLES Ø ${(16.5 + r() * 6).toFixed(1)}` });
  return out;
}

function contours(r: () => number): Drawing {
  const out: Drawing = { title: 'SITE CONTOURS', strokes: [], labels: [], nodes: [] };
  const cx = 280 + r() * 80, cy = 180 + r() * 30;
  const wob = Array.from({ length: 6 }, () => r() * Math.PI * 2);
  for (let k = 1; k <= 9; k++) {
    const pts: string[] = [];
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      const rad = k * 22 * (1 + 0.16 * Math.sin(a * 2 + wob[0]) + 0.1 * Math.sin(a * 3 + wob[1] + k * 0.2) + 0.06 * Math.sin(a * 5 + wob[2]));
      pts.push(`${i ? 'L' : 'M'}${f(cx + Math.cos(a) * rad * 1.5)} ${f(cy + Math.sin(a) * rad)}`);
    }
    out.strokes.push({ kind: k % 5 === 0 ? 'main' : 'fine', d: `${pts.join('')}Z` });
    if (k % 2 === 1) out.labels.push({ x: cx + k * 22 * 1.5 + 4, y: cy - 3, text: `+${(120 - k * 2.5).toFixed(1)}` });
  }
  out.nodes.push({ x: cx, y: cy, r: 3 });
  out.labels.push({ x: cx + 8, y: cy + 14, text: `SPOT +${(121 + r() * 2).toFixed(2)}` });
  // a north arrow
  out.strokes.push({ kind: 'main', d: 'M540 70l12 32l-12-8l-12 8z' });
  out.labels.push({ x: 540, y: 60, text: 'N', anchor: 'middle' });
  return out;
}

function gears(r: () => number): Drawing {
  const out: Drawing = { title: 'GEAR PAIR', strokes: [], labels: [], nodes: [] };
  const gear = (cx: number, cy: number, teeth: number, R: number, phase: number) => {
    const pts: string[] = [];
    const n = teeth * 4;
    for (let i = 0; i <= n; i++) {
      const a = phase + (i / n) * Math.PI * 2;
      const tooth = (i % 4 === 1 || i % 4 === 2) ? 1 : 0;
      const rad = R + tooth * 12;
      pts.push(`${i ? 'L' : 'M'}${f(cx + Math.cos(a) * rad)} ${f(cy + Math.sin(a) * rad)}`);
    }
    out.strokes.push({ kind: 'main', d: `${pts.join('')}Z` }, { kind: 'main', d: circle(cx, cy, R * 0.28) }, { kind: 'centre', d: circle(cx, cy, R + 6) });
    out.strokes.push({ kind: 'centre', d: line([cx - R - 26, cy], [cx + R + 26, cy]) }, { kind: 'centre', d: line([cx, cy - R - 26], [cx, cy + R + 26]) });
  };
  const t1 = 18 + Math.floor(r() * 10), t2 = 10 + Math.floor(r() * 6);
  const R1 = 100, R2 = R1 * t2 / t1;
  gear(220, 190, t1, R1, r());
  gear(220 + R1 + R2 + 12, 190, t2, R2, r());
  dimension([220, 330], [220 + R1 + R2 + 12, 330], 0, `C ${((R1 + R2 + 12) * 1.6).toFixed(1)}`, out);
  out.labels.push({ x: 60, y: 40, text: `z₁ = ${t1}   z₂ = ${t2}   i = ${(t1 / t2).toFixed(2)}` });
  return out;
}

function elevation(r: () => number): Drawing {
  const out: Drawing = { title: 'ELEVATION', strokes: [], labels: [], nodes: [] };
  const floors = 3 + Math.floor(r() * 3), x0 = 110, x1 = 470, h = 260 / (floors + 0.6), yb = 320;
  out.strokes.push({ kind: 'main', d: line([40, yb], [560, yb]) });
  for (let i = 0; i <= floors; i++) {
    const y = yb - i * h;
    out.strokes.push({ kind: i === floors ? 'main' : 'fine', d: line([x0, y], [x1, y]) });
    out.labels.push({ x: x1 + 54, y: y - 3, text: `FFL +${(i * 3.6).toFixed(3)}`, anchor: 'start' });
    out.strokes.push({ kind: 'dim', d: `M${x1 + 44} ${f(y)}l6 -6h4` });
    if (i < floors) {
      const bays = 5 + Math.floor(r() * 3);
      for (let b = 0; b < bays; b++) {
        const wx = x0 + 16 + b * ((x1 - x0 - 32) / bays), ww = (x1 - x0 - 32) / bays - 14;
        out.strokes.push({ kind: 'fine', d: `M${f(wx)} ${f(y - h * 0.22)}h${f(ww)}v${f(-h * 0.5)}h${f(-ww)}z` });
      }
    }
  }
  out.strokes.push({ kind: 'main', d: line([x0, yb], [x0, yb - floors * h]) }, { kind: 'main', d: line([x1, yb], [x1, yb - floors * h]) });
  out.strokes.push({ kind: 'main', d: `M${x0 - 12} ${f(yb - floors * h)}L${(x0 + x1) / 2} ${f(yb - floors * h - 34)}L${x1 + 12} ${f(yb - floors * h)}` });
  dimension([x0, yb + 18], [x1, yb + 18], 8, `${Math.round((x1 - x0) * 60)}`, out);
  return out;
}

const KINDS = [isometric, truss, flange, contours, gears, elevation];

export function drawingForDay(day: number): Drawing {
  const r = rng(day * 2654435761);
  return KINDS[day % KINDS.length](r);
}
