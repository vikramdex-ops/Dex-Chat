// Backgrounds for the camera, drawn in code (no image files): a drafting sheet, a blueprint and a
// plain studio wall, plus a picture of the person's own, kept on this PC only.

export type BackgroundId = 'none' | 'blur' | 'drafting' | 'blueprint' | 'studio' | 'custom';
export const OFFICE_BACKGROUNDS: Array<{ id: Exclude<BackgroundId, 'none' | 'blur' | 'custom'>; label: string }> = [
  { id: 'drafting', label: 'Drafting sheet' },
  { id: 'blueprint', label: 'Blueprint' },
  { id: 'studio', label: 'Plain studio' },
];

const W = 1280, H = 720;
const MONO = '"Cascadia Mono", "JetBrains Mono", Consolas, monospace';
const CUSTOM_KEY = 'dex.room.background.image';

function grid(ctx: CanvasRenderingContext2D, w: number, h: number, step: number, color: string): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = step; x < w; x += step) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); }
  for (let y = step; y < h; y += step) { ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); }
  ctx.stroke();
}

/** A dimension line with ticks and a figure, as on a drawing. */
function dimension(ctx: CanvasRenderingContext2D, x1: number, x2: number, y: number, label: string): void {
  ctx.beginPath();
  ctx.moveTo(x1, y); ctx.lineTo(x2, y);
  for (const x of [x1, x2]) { ctx.moveTo(x - 5, y + 5); ctx.lineTo(x + 5, y - 5); ctx.moveTo(x, y - 12); ctx.lineTo(x, y + 12); }
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.fillText(label, (x1 + x2) / 2, y - 8);
}

function drafting(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#f3f1ea';
  ctx.fillRect(0, 0, W, H);
  grid(ctx, W, H, 8, 'rgba(30, 96, 102, 0.06)');
  grid(ctx, W, H, 40, 'rgba(30, 96, 102, 0.13)');
  // the sheet border, doubled, with centring marks
  ctx.strokeStyle = 'rgba(19, 43, 46, 0.55)';
  ctx.lineWidth = 2;
  ctx.strokeRect(28, 28, W - 56, H - 56);
  ctx.lineWidth = 1;
  ctx.strokeRect(38, 38, W - 76, H - 76);
  ctx.beginPath();
  for (const [x, y, dx, dy] of [[W / 2, 18, 0, 20], [W / 2, H - 38, 0, 20], [18, H / 2, 20, 0], [W - 38, H / 2, 20, 0]]) { ctx.moveTo(x, y); ctx.lineTo(x + dx, y + dy); }
  ctx.stroke();
  // a title block in the corner
  const bx = W - 38 - 360, by = H - 38 - 96;
  ctx.fillStyle = 'rgba(243, 241, 234, 0.92)';
  ctx.fillRect(bx, by, 360, 96);
  ctx.strokeRect(bx, by, 360, 96);
  ctx.beginPath();
  ctx.moveTo(bx, by + 40); ctx.lineTo(bx + 360, by + 40);
  ctx.moveTo(bx + 120, by + 40); ctx.lineTo(bx + 120, by + 96);
  ctx.moveTo(bx + 240, by + 40); ctx.lineTo(bx + 240, by + 96);
  ctx.stroke();
  ctx.fillStyle = 'rgba(19, 43, 46, 0.78)';
  ctx.textAlign = 'left';
  ctx.font = `600 18px ${MONO}`;
  ctx.fillText('DEXTERITY · ROOM', bx + 14, by + 27);
  ctx.font = `600 10px ${MONO}`;
  ctx.fillStyle = 'rgba(19, 43, 46, 0.55)';
  for (const [i, t] of ['SCALE', 'SHEET', 'REV'].entries()) ctx.fillText(t, bx + 14 + i * 120, by + 56);
  ctx.font = `600 15px ${MONO}`;
  ctx.fillStyle = 'rgba(19, 43, 46, 0.78)';
  for (const [i, t] of ['1:1', '1 OF 1', 'A'].entries()) ctx.fillText(t, bx + 14 + i * 120, by + 81);
  // a faint dimension across the top
  ctx.strokeStyle = 'rgba(30, 96, 102, 0.35)';
  ctx.fillStyle = 'rgba(30, 96, 102, 0.55)';
  ctx.font = `500 12px ${MONO}`;
  dimension(ctx, 120, 520, 80, '4000');
}

function blueprint(ctx: CanvasRenderingContext2D): void {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#14406b');
  g.addColorStop(1, '#0d2c4d');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  grid(ctx, W, H, 16, 'rgba(255, 255, 255, 0.05)');
  grid(ctx, W, H, 80, 'rgba(255, 255, 255, 0.12)');
  ctx.strokeStyle = 'rgba(214, 233, 255, 0.42)';
  ctx.fillStyle = 'rgba(214, 233, 255, 0.6)';
  ctx.lineWidth = 2;
  // a pipe run in isometric: header, a riser and a flanged branch
  const iso = (x: number, y: number, z: number): [number, number] => [140 + (x - y) * 0.866, 560 + (x + y) * 0.5 - z];
  const run = (pts: Array<[number, number, number]>) => { ctx.beginPath(); pts.forEach((p, i) => { const [x, y] = iso(...p); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.stroke(); };
  run([[0, 0, 0], [300, 0, 0], [300, 0, 220], [300, -260, 220]]);
  run([[150, 0, 0], [150, 180, 0]]);
  for (const p of [[300, 0, 0], [300, 0, 220], [150, 0, 0]] as Array<[number, number, number]>) {
    const [x, y] = iso(...p);
    ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke();
  }
  // a flange, in elevation, on the right
  ctx.lineWidth = 1.5;
  for (const r of [70, 52, 30]) { ctx.beginPath(); ctx.arc(1080, 190, r, 0, Math.PI * 2); ctx.stroke(); }
  for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; ctx.beginPath(); ctx.arc(1080 + Math.cos(a) * 61, 190 + Math.sin(a) * 61, 4, 0, Math.PI * 2); ctx.stroke(); }
  ctx.lineWidth = 1;
  ctx.font = `500 13px ${MONO}`;
  dimension(ctx, 1010, 1150, 290, 'Ø 140');
  ctx.textAlign = 'left';
  ctx.font = `600 13px ${MONO}`;
  ctx.fillText('LINE 6"-P-1042-A1', 60, 660);
}

function studio(ctx: CanvasRenderingContext2D): void {
  const g = ctx.createRadialGradient(W * 0.5, H * 0.38, 60, W * 0.5, H * 0.5, W * 0.72);
  g.addColorStop(0, '#eef2f2');
  g.addColorStop(0.6, '#d5dfe0');
  g.addColorStop(1, '#a9babd');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // a soft floor line, and a little grain so the wall is not flat
  const f = ctx.createLinearGradient(0, H * 0.78, 0, H);
  f.addColorStop(0, 'rgba(19, 43, 46, 0)');
  f.addColorStop(1, 'rgba(19, 43, 46, 0.18)');
  ctx.fillStyle = f;
  ctx.fillRect(0, H * 0.78, W, H * 0.22);
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  ctx.fillStyle = 'rgba(19, 43, 46, 0.035)';
  for (let i = 0; i < 4000; i++) ctx.fillRect(rnd() * W, rnd() * H, 1, 1);
}

const painted = new Map<string, HTMLCanvasElement>();

/** An office background as a canvas (drawn once, then reused). */
export function officeBackground(id: 'drafting' | 'blueprint' | 'studio'): HTMLCanvasElement {
  let c = painted.get(id);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d')!;
  if (id === 'drafting') drafting(ctx); else if (id === 'blueprint') blueprint(ctx); else studio(ctx);
  painted.set(id, c);
  return c;
}

let customImage: HTMLCanvasElement | null = null;

/** The person's own background, from this PC (null when none was chosen). */
export async function customBackground(): Promise<HTMLCanvasElement | null> {
  if (customImage) return customImage;
  let url: string | null = null;
  try { url = localStorage.getItem(CUSTOM_KEY); } catch { /* private mode */ }
  if (!url) return null;
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d')!.drawImage(img, 0, 0);
    customImage = c;
    return c;
  } catch { return null; }
}

/** Keep a picture as the person's own background: scaled to the camera's size and stored on this PC. */
export async function setCustomBackground(file: Blob): Promise<HTMLCanvasElement> {
  if (!/^image\//.test(file.type)) throw new Error('Choose a picture (PNG, JPEG or WebP).');
  if (file.size > 25 * 1024 * 1024) throw new Error('That picture is too large. Choose one under 25 MB.');
  const bmp = await createImageBitmap(file);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d')!;
  const s = Math.max(W / bmp.width, H / bmp.height);
  ctx.drawImage(bmp, (W - bmp.width * s) / 2, (H - bmp.height * s) / 2, bmp.width * s, bmp.height * s);
  bmp.close();
  customImage = c;
  try { localStorage.setItem(CUSTOM_KEY, c.toDataURL('image/jpeg', 0.84)); } catch { /* kept for this session only */ }
  return c;
}

/** A small preview of a background for the picker. */
export function backgroundThumb(id: 'drafting' | 'blueprint' | 'studio'): string {
  const big = officeBackground(id);
  const c = document.createElement('canvas');
  c.width = 160; c.height = 90;
  c.getContext('2d')!.drawImage(big, 0, 0, 160, 90);
  return c.toDataURL('image/png');
}
