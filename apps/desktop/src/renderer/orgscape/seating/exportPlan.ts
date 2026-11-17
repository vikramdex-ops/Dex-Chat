// The plan for the notice wall: the current seating drawn on an A3 sheet (portrait, 150 dpi) with
// a border and a title block (drawing, number, revision, date), as a PNG, or as a one-page PDF
// holding that picture. Drawn off screen with the same renderer as the sheet.
import type { PublicUser, SeatingView } from '@dex/core';
import { Camera } from '../camera.ts';
import { drawPlanFloor } from '../drawplan.ts';
import type { PlanScene } from '../drawplan.ts';
import { planFloor } from '../plan.ts';
import type { Ink, Labels } from '../render.ts';

const W = 1754, H = 2480; // A3 at 150 dpi
const TB = 190; // the title block's height

export interface ExportInput {
  view: SeatingView;
  people: PublicUser[];
  users: Map<string, PublicUser>;
  ink: Ink;
  labels: Labels;
  words: PlanScene['words'];
  deptName: (id: string) => string;
  deptColor: (id: string) => string;
  wash: boolean;
  office: string;
  today: string;
  /** Words for the title block, already translated. */
  tb: { drawing: string; drgNo: string; rev: string; date: string; scale: string; seats: string; title: string };
}

export function renderPlan(o: ExportInput): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d')!;
  // a printed plan is the same for everyone: no presence, nobody "away"
  const ink: Ink = { ...o.ink, window: '#ffffff', paper: '#ffffff', dark: false, text: '#15191b', text2: '#3b4e51', text3: '#56696c', subtle: 'rgba(19,43,46,.06)', stroke: 'rgba(19,43,46,.07)', strokeStrong: 'rgba(19,43,46,.22)' };
  const f = planFloor(o.view.plan, o.view.version, o.view.holders, o.people, () => null, o.view.bookings, o.today);
  const m = f.plan!;
  const cam = new Camera();
  const area = { x: 60, y: 60, w: W - 120, h: H - 120 - TB - 20 };
  const world = { x: f.building.x - 140, y: f.building.y - 140, w: f.building.w + 280, h: f.building.h + 280 };
  const z = Math.min(area.w / world.w, area.h / world.h);
  // placed directly: the viewer's clamping to the sheet does not apply to a print
  cam.vw = W; cam.vh = H; cam.z = z;
  cam.x = world.x - (area.x + (area.w - world.w * z) / 2) / z;
  cam.y = world.y - (area.y + (area.h - world.h * z) / 2) / z;
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.beginPath(); ctx.rect(area.x, area.y, area.w, area.h); ctx.clip();
  ctx.setTransform(z, 0, 0, z, -cam.x * z, -cam.y * z);
  // only the building: people with no seat and the off-site key stay off the printed plan
  const printed = { ...f, spots: new Map([...f.spots].filter(([, sp]) => sp.where === 'desk')), away: f.away.map((a) => ({ ...a, people: [] })), unseated: { ...f.unseated, people: [] } };
  const seating: PlanScene = { mode: 'view', wash: o.wash, deptColor: o.deptColor, pending: [], clouds: null, hoverSeat: null, focusSeat: null, selSeats: new Set(), selRoom: null, drag: null, bad: new Set(), underlay: null, words: o.words };
  drawPlanFloor(ctx, printed, {
    users: o.users, presence: () => 'off', me: '', focus: null, hover: null, selected: null, hot: new Set(), spotlight: null, route: null, overlay: null, asAt: null,
    joinedAt: new Map(), marks: new Map(), pigs: [], intro: null, now: 0, reduced: true, ink, labels: o.labels, deptName: o.deptName, modeOf: () => null, seating,
  }, cam, null);
  ctx.restore();
  // the sheet's border
  ctx.strokeStyle = '#15191b'; ctx.lineWidth = 3; ctx.strokeRect(40, 40, W - 80, H - 80);
  ctx.lineWidth = 1; ctx.strokeRect(30, 30, W - 60, H - 60);
  // the title block along the foot
  const ty = H - 40 - TB;
  ctx.beginPath(); ctx.moveTo(40, ty); ctx.lineTo(W - 40, ty); ctx.lineWidth = 2; ctx.stroke();
  const cells: Array<[string, string, number]> = [
    [o.tb.title, o.office, 0.34], [o.tb.drawing, o.tb.seats, 0.22], [o.tb.drgNo, o.view.plan.drawingNo, 0.14], [o.tb.rev, o.view.revisions[0]?.rev ?? 'A', 0.08], [o.tb.date, o.tb.scale, 0.22],
  ];
  let x = 40;
  ctx.textBaseline = 'alphabetic';
  for (const [k, val, frac] of cells) {
    const w = (W - 80) * frac;
    if (x > 40) { ctx.beginPath(); ctx.moveTo(x, ty); ctx.lineTo(x, H - 40); ctx.lineWidth = 1; ctx.stroke(); }
    ctx.fillStyle = '#56696c'; ctx.font = `600 22px ${o.ink.latinCaps ? o.ink.mono : o.ink.body}`; ctx.fillText(o.ink.latinCaps ? k.toUpperCase() : k, x + 18, ty + 42);
    ctx.fillStyle = '#15191b'; ctx.font = `600 ${val.length > 22 ? 30 : 38}px ${o.ink.display}`;
    const lines = val.split('\n');
    lines.forEach((l, i) => ctx.fillText(l, x + 18, ty + 100 + i * 40, w - 30));
    x += w;
  }
  // departments, when washed
  if (o.wash) {
    const depts = [...new Set(m.seats.map((s) => s.dept).filter((d): d is string => !!d))].sort((a, b) => o.deptName(a).localeCompare(o.deptName(b)));
    let lx = 70;
    const ly = ty - 34;
    ctx.font = `500 22px ${o.ink.body}`;
    for (const d of depts.slice(0, 12)) {
      ctx.fillStyle = o.deptColor(d); ctx.globalAlpha = 0.35; ctx.fillRect(lx, ly - 18, 26, 22); ctx.globalAlpha = 1;
      ctx.fillStyle = '#15191b'; ctx.fillText(o.deptName(d), lx + 34, ly);
      lx += 60 + ctx.measureText(o.deptName(d)).width;
      if (lx > W - 260) break;
    }
  }
  return c;
}

export const toPng = (c: HTMLCanvasElement): Promise<Blob> => new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not draw the plan.'))), 'image/png'));

/** A one-page A3 PDF holding the drawing as a JPEG. */
export async function toPdf(c: HTMLCanvasElement): Promise<Blob> {
  const jpeg = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not draw the plan.'))), 'image/jpeg', 0.9));
  const img = new Uint8Array(await jpeg.arrayBuffer());
  const pw = 841.89, ph = 1190.55; // A3 in points
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let len = 0;
  const push = (b: Uint8Array | string) => { const u = typeof b === 'string' ? enc.encode(b) : b; parts.push(u); len += u.length; };
  const obj = (n: number, body: string | (() => void)) => { offsets[n] = len; push(`${n} 0 obj\n`); if (typeof body === 'string') push(body); else body(); push('\nendobj\n'); };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  obj(4, () => { push(`<< /Type /XObject /Subtype /Image /Width ${c.width} /Height ${c.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.length} >>\nstream\n`); push(img); push('\nendstream'); });
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  const xref = len;
  push(`xref\n0 6\n0000000000 65535 f \n${[1, 2, 3, 4, 5].map((n) => `${String(offsets[n]).padStart(10, '0')} 00000 n \n`).join('')}`);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts as BlobPart[], { type: 'application/pdf' });
}

/** Save a file the app made (the app asks where, starting in Downloads). */
export function download(blob: Blob, name: string): void {
  const hook = (globalThis as { __seatingExport?: (name: string, blob: Blob) => void }).__seatingExport;
  if (hook) { hook(name, blob); return; }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
