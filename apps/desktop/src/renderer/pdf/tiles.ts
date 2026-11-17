// The PDF viewer's geometry, with no DOM: zoom limits and fits, where each page sits in the
// scrolling sheet, which pages are near the view, and how a page is drawn at screen resolution.
// A page small enough on screen is one canvas; a big drawing sheet (A0, A1) zoomed in is a cheap
// low-resolution base plus tiles of TILE_PX device pixels covering only what is in view, so a
// 1:1 view of an A0 sheet never allocates the whole sheet at full resolution. Everything drawn is
// counted in device pixels against PIXEL_BUDGET, and what is no longer needed goes first.

/** PDF points (1/72 inch) to CSS pixels (1/96 inch): 100% is the paper's real size on screen. */
export const PDF_TO_CSS = 96 / 72;
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 8;
/** Fit page may go below ZOOM_MIN: an A0 sheet fits a laptop screen at about 15%. */
export const FIT_MIN = 0.02;
/** Side of a tile, in device pixels (4 MB of RGBA). */
export const TILE_PX = 1024;
/** A page is drawn as one canvas while it is at most this many device pixels... */
export const SINGLE_MAX_PX = 12_000_000;
/** ...and neither side is longer than this. */
export const SINGLE_MAX_SIDE = 4096;
/** The blurry stand-in drawn under the tiles of a big page. */
export const BASE_MAX_PX = 2_000_000;
/** Everything the viewer keeps drawn at once (about 160 MB of RGBA). */
export const PIXEL_BUDGET = 40_000_000;
/** Gap between pages and the margin around them, in CSS pixels. */
export const PAGE_GAP = 16;
export const PAGE_PAD = 16;

export interface Size { w: number; h: number }
export interface Rect { x: number; y: number; w: number; h: number }

export const clampZoom = (z: number, min = ZOOM_MIN): number => (Number.isFinite(z) ? Math.min(ZOOM_MAX, Math.max(min, z)) : 1);
export const normRotation = (r: number): 0 | 90 | 180 | 270 => ((((Math.round(r / 90) * 90) % 360) + 360) % 360) as 0 | 90 | 180 | 270;

/** A page's size after rotation (sizes are in PDF points). */
export function rotatedSize(s: Size, rotation: number): Size {
  return normRotation(rotation) % 180 === 0 ? { w: s.w, h: s.h } : { w: s.h, h: s.w };
}

/** The zoom at which the page fills the width of the view (less the margins). */
export function fitWidthZoom(page: Size, rotation: number, viewW: number, pad = PAGE_PAD): number {
  const r = rotatedSize(page, rotation);
  return clampZoom(Math.max(1, viewW - 2 * pad) / (r.w * PDF_TO_CSS), FIT_MIN);
}

/** The zoom at which the whole page is in view. */
export function fitPageZoom(page: Size, rotation: number, viewW: number, viewH: number, pad = PAGE_PAD): number {
  const r = rotatedSize(page, rotation);
  return clampZoom(Math.min(Math.max(1, viewW - 2 * pad) / (r.w * PDF_TO_CSS), Math.max(1, viewH - 2 * pad) / (r.h * PDF_TO_CSS)), FIT_MIN);
}

/** The smallest zoom allowed: 25%, or less when that is what it takes to see the whole page. */
export const minZoomFor = (fitPage: number): number => Math.max(FIT_MIN, Math.min(ZOOM_MIN, fitPage));

/** Zoom in and out by steps people recognise; a zoom between steps goes to the next one. */
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8];
export function stepZoom(z: number, dir: 1 | -1, min = ZOOM_MIN): number {
  if (dir > 0) return ZOOM_STEPS.find((s) => s > z * 1.001) ?? ZOOM_MAX;
  return [...ZOOM_STEPS].reverse().find((s) => s < z * 0.999 && s >= min) ?? Math.min(z, Math.max(min, ZOOM_MIN));
}

export interface Layout {
  /** Each page's box in the sheet, CSS pixels. */
  boxes: Rect[];
  width: number;
  height: number;
}

/** Pages one under another, each centred across the width (the view's, or the widest page's). */
export function layoutPages(sizes: Size[], zoom: number, rotation: number, viewW: number, gap = PAGE_GAP, pad = PAGE_PAD): Layout {
  const s = clampZoom(zoom, FIT_MIN) * PDF_TO_CSS;
  const dims = sizes.map((p) => { const r = rotatedSize(p, rotation); return { w: Math.max(1, Math.round(r.w * s)), h: Math.max(1, Math.round(r.h * s)) }; });
  const widest = dims.reduce((m, d) => Math.max(m, d.w), 0);
  const width = Math.max(viewW, widest + 2 * pad);
  const boxes: Rect[] = [];
  let y = pad;
  for (const d of dims) {
    boxes.push({ x: Math.round((width - d.w) / 2), y, w: d.w, h: d.h });
    y += d.h + gap;
  }
  return { boxes, width, height: Math.max(0, y - gap) + pad };
}

/** The first page whose box reaches below y (binary search; boxes run top to bottom). */
function firstBelow(boxes: Rect[], y: number): number {
  let lo = 0;
  let hi = boxes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (boxes[mid].y + boxes[mid].h <= y) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Pages that touch the view, widened by `margin` CSS pixels above and below. */
export function pagesInView(layout: Layout, view: Rect, margin = 0): number[] {
  const out: number[] = [];
  const top = view.y - margin;
  const bottom = view.y + view.h + margin;
  for (let i = firstBelow(layout.boxes, top); i < layout.boxes.length && layout.boxes[i].y < bottom; i++) out.push(i);
  return out;
}

/** The page at the middle of the view, for "page 3 of 12" (the nearest one when it falls in a gap). */
export function currentPage(layout: Layout, view: Rect): number {
  if (!layout.boxes.length) return 0;
  const mid = view.y + view.h / 2;
  const i = Math.min(layout.boxes.length - 1, firstBelow(layout.boxes, mid));
  if (i > 0 && layout.boxes[i].y > mid && mid - (layout.boxes[i - 1].y + layout.boxes[i - 1].h) < layout.boxes[i].y - mid) return i - 1;
  return i;
}

/** Where a point of the view is, as a page and a fraction across it, so a zoom can keep it still. */
export interface Anchor { page: number; fx: number; fy: number; vx: number; vy: number }

export function anchorAt(layout: Layout, scroll: { left: number; top: number }, vx: number, vy: number): Anchor | null {
  if (!layout.boxes.length) return null;
  const x = scroll.left + vx;
  const y = scroll.top + vy;
  let page = Math.min(layout.boxes.length - 1, firstBelow(layout.boxes, y));
  const b = layout.boxes[page];
  if (y < b.y && page > 0 && y - (layout.boxes[page - 1].y + layout.boxes[page - 1].h) < b.y - y) page -= 1;
  const p = layout.boxes[page];
  return { page, fx: (x - p.x) / p.w, fy: (y - p.y) / p.h, vx, vy };
}

/** The scroll position that puts the anchored point back under the same spot of the view. */
export function scrollForAnchor(layout: Layout, a: Anchor, view: Size): { left: number; top: number } {
  const b = layout.boxes[Math.min(a.page, layout.boxes.length - 1)];
  if (!b) return { left: 0, top: 0 };
  const left = b.x + a.fx * b.w - a.vx;
  const top = b.y + a.fy * b.h - a.vy;
  return {
    left: Math.max(0, Math.min(Math.max(0, layout.width - view.w), left)),
    top: Math.max(0, Math.min(Math.max(0, layout.height - view.h), top)),
  };
}

/** The part of a page that is in view, relative to the page's top-left corner (CSS pixels). */
export function visibleInPage(box: Rect, view: Rect, margin = 0): Rect | null {
  const x0 = Math.max(box.x, view.x - margin);
  const y0 = Math.max(box.y, view.y - margin);
  const x1 = Math.min(box.x + box.w, view.x + view.w + margin);
  const y1 = Math.min(box.y + box.h, view.y + view.h + margin);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0 - box.x, y: y0 - box.y, w: x1 - x0, h: y1 - y0 };
}

export type PagePlan =
  | { mode: 'single'; devW: number; devH: number }
  | { mode: 'tiled'; devW: number; devH: number; base: number; baseW: number; baseH: number };

/**
 * How to draw a page whose box is cssW × cssH on a screen with this pixel ratio: one canvas at
 * full resolution, or a base at `base` × full resolution plus tiles over what is in view.
 */
export function planPage(cssW: number, cssH: number, dpr: number): PagePlan {
  const ratio = Number.isFinite(dpr) && dpr > 0 ? Math.min(dpr, 4) : 1;
  const devW = Math.max(1, Math.round(cssW * ratio));
  const devH = Math.max(1, Math.round(cssH * ratio));
  if (devW * devH <= SINGLE_MAX_PX && Math.max(devW, devH) <= SINGLE_MAX_SIDE) return { mode: 'single', devW, devH };
  const base = Math.min(1, Math.sqrt(BASE_MAX_PX / (devW * devH)), SINGLE_MAX_SIDE / Math.max(devW, devH));
  return { mode: 'tiled', devW, devH, base, baseW: Math.max(1, Math.floor(devW * base)), baseH: Math.max(1, Math.floor(devH * base)) };
}

export interface Tile { col: number; row: number; x: number; y: number; w: number; h: number }

/** Tiles of a page (device pixels) that cover `visible` (device pixels, relative to the page). */
export function tilesFor(devW: number, devH: number, visible: Rect, tile = TILE_PX): Tile[] {
  const vx0 = Math.max(0, visible.x);
  const vy0 = Math.max(0, visible.y);
  const vx1 = Math.min(devW, visible.x + visible.w);
  const vy1 = Math.min(devH, visible.y + visible.h);
  if (!(vx1 > vx0 && vy1 > vy0) || !(tile > 0)) return [];
  const x0 = Math.floor(vx0 / tile);
  const y0 = Math.floor(vy0 / tile);
  const x1 = Math.ceil(vx1 / tile);
  const y1 = Math.ceil(vy1 / tile);
  const out: Tile[] = [];
  for (let row = y0; row < y1; row++) {
    for (let col = x0; col < x1; col++) {
      const x = col * tile;
      const y = row * tile;
      out.push({ col, row, x, y, w: Math.min(tile, devW - x), h: Math.min(tile, devH - y) });
    }
  }
  return out;
}

/** Something drawn: a page canvas, a base or a tile. */
export interface Drawn { key: string; pixels: number; needed: boolean; lastUsed: number }

/**
 * What to drop so that everything drawn fits the budget: things no longer needed first, the
 * least recently used of them first; then, if what is needed still does not fit, the least
 * recently used of those too.
 */
export function evict(items: Drawn[], budget = PIXEL_BUDGET): string[] {
  let total = items.reduce((n, d) => n + d.pixels, 0);
  const drop: string[] = [];
  const order = [...items].sort((a, b) => (a.needed === b.needed ? a.lastUsed - b.lastUsed : a.needed ? 1 : -1));
  for (const d of order) {
    if (total <= budget) break;
    drop.push(d.key);
    total -= d.pixels;
  }
  return drop;
}

/** ISO and ANSI paper names for a page size in points (drawings are told apart by sheet size). */
const PAPER: Array<[string, number, number]> = [
  ['A0', 841, 1189], ['A1', 594, 841], ['A2', 420, 594], ['A3', 297, 420], ['A4', 210, 297], ['A5', 148, 210],
  ['ANSI A', 215.9, 279.4], ['ANSI B', 279.4, 431.8], ['ANSI C', 431.8, 558.8], ['ANSI D', 558.8, 863.6], ['ANSI E', 863.6, 1117.6],
];
export function paperName(s: Size): string | null {
  const mm = (pt: number) => (pt / 72) * 25.4;
  const a = Math.min(mm(s.w), mm(s.h));
  const b = Math.max(mm(s.w), mm(s.h));
  const hit = PAPER.find(([, w, h]) => Math.abs(w - a) <= 3 && Math.abs(h - b) <= 3);
  return hit ? hit[0] : null;
}
export const sizeInMm = (s: Size): string => `${Math.round((s.w / 72) * 25.4)} × ${Math.round((s.h / 72) * 25.4)} mm`;
