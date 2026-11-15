// Draws a PDF's pages into the viewer, outside React. A page in view gets one canvas when it is
// small enough on screen, or a low-resolution base plus tiles over what is in view (tiles.ts);
// new resolutions are drawn beside the old and swapped in when ready, so zooming never flashes
// white. Every canvas is counted against a pixel budget, and pages that leave the view are
// emptied, so memory stays bounded however big the sheet and however far it is zoomed. Each page
// in view also gets PDF.js's text layer (for selecting and copying text) and its text, for search.
import type { PDFDocumentProxy, PDFPageProxy, RenderTask, TextLayer } from 'pdfjs-dist';
import type { PdfLib } from './pdfjs.ts';
import { PIXEL_BUDGET, evict, planPage, rotatedSize, tilesFor } from './tiles.ts';
import type { Rect, Size } from './tiles.ts';
import { pageText } from './textsearch.ts';
import type { PageText, TextRun } from './textsearch.ts';

export interface PageInfo {
  /** Size in points as the page is meant to be seen (its own rotation and user unit applied). */
  size: Size;
  /** The page's own rotation (degrees). */
  rotate: number;
  /** The page's box [x0, y0, x1, y1] in PDF units (search highlights are placed against it). */
  view: number[];
  userUnit: number;
}

/** The view to draw: CSS pixels per point, the screen's pixel ratio, the reader's rotation, and for each page near the view the part in view as fractions of the (rotated) page. */
export interface DrawView { scale: number; dpr: number; rotation: number; visible: Map<number, Rect> }

type TextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>;

interface Drawn { key: string; canvas: HTMLCanvasElement; pixels: number; needed: boolean; lastUsed: number; page: number }
interface Job { key: string; page: number; prio: number; keep?: boolean; cancelled?: boolean; task?: RenderTask | null; run: (job: Job) => Promise<void> }
interface Slot { layer: HTMLElement; text: HTMLElement; textLayer?: TextLayer; textGen: number }

const CONCURRENCY = 2;
const THUMBS_KEPT = 300;

export class PdfEngine {
  readonly doc: PDFDocumentProxy;
  readonly count: number;
  private readonly lib: PdfLib;
  private readonly infos: Array<PageInfo | null>;
  private readonly proxies = new Map<number, Promise<PDFPageProxy>>();
  private readonly slots = new Map<number, Slot>();
  private readonly drawn = new Map<string, Drawn>();
  private readonly wanted = new Map<number, Set<string>>();
  private queue: Job[] = [];
  private readonly running = new Map<string, Job>();
  private readonly texts = new Map<number, Promise<{ content: TextContent; text: PageText }>>();
  private readonly thumbs = new Map<string, Promise<string>>();
  private readonly thumbUrls = new Map<string, string>();
  private clock = 0;
  private last: DrawView | null = null;
  private dead = false;
  /** Called after something new is drawn (the viewer's status, and tests). */
  onDrawn: (() => void) | null = null;

  constructor(lib: PdfLib, doc: PDFDocumentProxy) {
    this.lib = lib;
    this.doc = doc;
    this.count = doc.numPages;
    this.infos = Array.from({ length: doc.numPages }, () => null);
  }

  page(i: number): Promise<PDFPageProxy> {
    let p = this.proxies.get(i);
    if (!p) { p = this.doc.getPage(i + 1); this.proxies.set(i, p); p.catch(() => this.proxies.delete(i)); }
    return p;
  }

  info(i: number): PageInfo | null { return this.infos[i] ?? null; }

  async loadInfo(i: number): Promise<PageInfo> {
    const have = this.infos[i];
    if (have) return have;
    const p = await this.page(i);
    const vp = p.getViewport({ scale: 1, rotation: p.rotate });
    const info: PageInfo = { size: { w: vp.width, h: vp.height }, rotate: p.rotate, view: [...p.view], userUnit: p.userUnit || 1 };
    this.infos[i] = info;
    return info;
  }

  /** Every page's size, a few at a time (a long set of drawings need not wait for all). */
  async loadAllInfo(onBatch: () => void): Promise<void> {
    for (let i = 0; i < this.count && !this.dead; i += 8) {
      await Promise.all(Array.from({ length: Math.min(8, this.count - i) }, (_, k) => this.loadInfo(i + k).catch(() => null)));
      onBatch();
    }
  }

  // ---------------------------------------------------------------- pages in view
  attach(i: number, layer: HTMLElement, text: HTMLElement): void {
    if (this.dead) return;
    const prev = this.slots.get(i);
    if (prev && prev.layer === layer) return;
    if (prev) this.detach(i);
    const slot: Slot = { layer, text, textGen: 0 };
    this.slots.set(i, slot);
    void this.buildText(i, slot);
    if (this.last) this.update(this.last);
  }

  detach(i: number): void {
    const slot = this.slots.get(i);
    if (!slot) return;
    this.slots.delete(i);
    this.wanted.delete(i);
    slot.textGen++;
    slot.textLayer?.cancel();
    slot.text.replaceChildren();
    for (const d of [...this.drawn.values()]) if (d.page === i) this.drop(d.key);
    for (const j of this.queue) if (j.page === i && !j.keep) j.cancelled = true;
    this.queue = this.queue.filter((j) => !j.cancelled);
    for (const j of this.running.values()) if (j.page === i && !j.keep) { j.cancelled = true; j.task?.cancel(); }
  }

  private async buildText(i: number, slot: Slot): Promise<void> {
    const gen = ++slot.textGen;
    try {
      const [{ content }, page] = await Promise.all([this.textContent(i), this.page(i)]);
      if (gen !== slot.textGen || this.slots.get(i) !== slot) return;
      slot.text.replaceChildren();
      const tl = new this.lib.TextLayer({ textContentSource: content, container: slot.text, viewport: page.getViewport({ scale: 1, rotation: 0 }) });
      slot.textLayer = tl;
      await tl.render();
      // the text layer fills its page box; the box's size follows the zoom
      slot.text.style.width = '100%';
      slot.text.style.height = '100%';
    } catch { /* no text (a scan) or cancelled */ }
  }

  /** Draw what this view needs, drop what it does not. */
  update(view: DrawView): void {
    if (this.dead) return;
    this.last = view;
    this.clock++;
    const needed = new Set<string>();
    for (const [i, frac] of view.visible) {
      const slot = this.slots.get(i);
      const info = this.infos[i];
      if (!slot) continue;
      if (!info) { void this.loadInfo(i).then(() => { if (this.last === view) this.update(view); }).catch(() => {}); continue; }
      const disp = rotatedSize(info.size, view.rotation);
      const rot = (info.rotate + view.rotation) % 360;
      const plan = planPage(disp.w * view.scale, disp.h * view.scale, view.dpr);
      const devScale = plan.devW / disp.w;
      const sig = `${rot}@${devScale.toFixed(5)}`;
      const keys = new Set<string>();
      const center = { x: frac.x + frac.w / 2, y: frac.y + frac.h / 2 };
      if (plan.mode === 'single') {
        keys.add(this.need(`${i}|s|${sig}`, i, 1, (job) => this.drawWhole(job, i, devScale, rot, slot, false)));
      } else {
        keys.add(this.need(`${i}|b|${sig}`, i, 0, (job) => this.drawWhole(job, i, devScale * plan.base, rot, slot, true)));
        const devRect = { x: frac.x * plan.devW, y: frac.y * plan.devH, w: frac.w * plan.devW, h: frac.h * plan.devH };
        for (const t of tilesFor(plan.devW, plan.devH, devRect)) {
          const d = Math.hypot((t.x + t.w / 2) / plan.devW - center.x, (t.y + t.h / 2) / plan.devH - center.y);
          keys.add(this.need(`${i}|t|${sig}|${t.col},${t.row}`, i, 2 + d, (job) => this.drawTile(job, i, devScale, rot, slot, t, plan.devW, plan.devH)));
        }
      }
      this.wanted.set(i, keys);
      for (const k of keys) needed.add(k);
    }
    for (const d of this.drawn.values()) d.needed = needed.has(d.key);
    // what is queued or drawing but no longer in view
    for (const j of this.queue) if (!j.keep && !needed.has(j.key)) j.cancelled = true;
    this.queue = this.queue.filter((j) => !j.cancelled);
    for (const j of this.running.values()) if (!j.keep && !needed.has(j.key)) { j.cancelled = true; j.task?.cancel(); }
    for (const i of this.slots.keys()) this.sweep(i);
    this.budget();
    this.pump();
  }

  private need(key: string, page: number, prio: number, run: (job: Job) => Promise<void>): string {
    const d = this.drawn.get(key);
    if (d) { d.lastUsed = this.clock; return key; }
    if (this.running.has(key)) return key;
    const q = this.queue.find((j) => j.key === key);
    if (q) q.prio = prio; else this.queue.push({ key, page, prio, run });
    return key;
  }

  private pump(): void {
    while (!this.dead && this.running.size < CONCURRENCY && this.queue.length) {
      this.queue.sort((a, b) => a.prio - b.prio);
      const job = this.queue.shift()!;
      if (job.cancelled) continue;
      this.running.set(job.key, job);
      void job.run(job).catch(() => { /* cancelled, or the page could not be drawn */ }).finally(() => {
        this.running.delete(job.key);
        this.pump();
      });
    }
  }

  private place(job: Job, i: number, slot: Slot, canvas: HTMLCanvasElement, style: Partial<CSSStyleDeclaration>): void {
    if (job.cancelled || this.dead || this.slots.get(i) !== slot) { canvas.width = 0; canvas.height = 0; return; }
    Object.assign(canvas.style, { position: 'absolute', ...style });
    canvas.setAttribute('aria-hidden', 'true');
    canvas.dataset.key = job.key;
    slot.layer.appendChild(canvas);
    this.drawn.set(job.key, { key: job.key, canvas, pixels: canvas.width * canvas.height, needed: true, lastUsed: this.clock, page: i });
    this.sweep(i);
    this.budget();
    this.onDrawn?.();
  }

  private async drawWhole(job: Job, i: number, scale: number, rot: number, slot: Slot, base: boolean): Promise<void> {
    const page = await this.page(i);
    if (job.cancelled) return;
    const vp = page.getViewport({ scale, rotation: rot });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(vp.width));
    canvas.height = Math.max(1, Math.round(vp.height));
    if (base) canvas.className = 'pdfv-base';
    job.task = page.render({ canvas, viewport: vp, background: '#ffffff' });
    await job.task.promise;
    this.place(job, i, slot, canvas, { left: '0', top: '0', width: '100%', height: '100%', zIndex: base ? '0' : '1' });
  }

  private async drawTile(job: Job, i: number, scale: number, rot: number, slot: Slot, t: { x: number; y: number; w: number; h: number }, devW: number, devH: number): Promise<void> {
    const page = await this.page(i);
    if (job.cancelled) return;
    const vp = page.getViewport({ scale, rotation: rot });
    const canvas = document.createElement('canvas');
    canvas.width = t.w;
    canvas.height = t.h;
    canvas.className = 'pdfv-tile';
    job.task = page.render({ canvas, viewport: vp, transform: [1, 0, 0, 1, -t.x, -t.y], background: '#ffffff' });
    await job.task.promise;
    const pct = (v: number, of: number) => `${(100 * v) / of}%`;
    // a hair of overlap hides seams between neighbouring tiles at fractional positions
    this.place(job, i, slot, canvas, { left: pct(t.x, devW), top: pct(t.y, devH), width: `calc(${pct(t.w, devW)} + 0.6px)`, height: `calc(${pct(t.h, devH)} + 0.6px)`, zIndex: '2' });
  }

  /** Once everything a page needs is drawn, remove what it showed before (another zoom or rotation). */
  private sweep(i: number): void {
    const want = this.wanted.get(i);
    if (!want) return;
    for (const k of want) if (!this.drawn.has(k)) return;
    for (const d of [...this.drawn.values()]) if (d.page === i && !want.has(d.key)) this.drop(d.key);
  }

  private budget(): void {
    for (const key of evict([...this.drawn.values()], PIXEL_BUDGET)) this.drop(key);
  }

  private drop(key: string): void {
    const d = this.drawn.get(key);
    if (!d) return;
    this.drawn.delete(key);
    d.canvas.remove();
    // give the memory back now, not when the canvas is collected
    d.canvas.width = 0;
    d.canvas.height = 0;
  }

  /** Device pixels drawn right now (the budget's measure). */
  get pixels(): number { let n = 0; for (const d of this.drawn.values()) n += d.pixels; return n; }
  get pending(): number { return this.queue.length + this.running.size; }

  // ---------------------------------------------------------------- text
  textContent(i: number): Promise<{ content: TextContent; text: PageText }> {
    let p = this.texts.get(i);
    if (!p) {
      p = this.page(i).then(async (page) => {
        const content = await page.getTextContent();
        const runs = content.items.filter((x) => typeof (x as { str?: unknown }).str === 'string') as unknown as TextRun[];
        return { content, text: pageText(runs) };
      });
      this.texts.set(i, p);
      p.catch(() => this.texts.delete(i));
    }
    return p;
  }

  async text(i: number): Promise<PageText> { return (await this.textContent(i)).text; }

  // ---------------------------------------------------------------- thumbnails
  /** A small picture of a page (an object URL), drawn when there is nothing in view to draw. */
  thumbnail(i: number, cssWidth: number, dpr: number, rotation: number): Promise<string> {
    const key = `${i}@${cssWidth}x${dpr}r${rotation}`;
    let p = this.thumbs.get(key);
    if (p) return p;
    p = new Promise<string>((resolve, reject) => {
      this.queue.push({
        key: `thumb:${key}`, page: i, prio: 50 + i, keep: true,
        run: async (job) => {
          try {
            const page = await this.page(i);
            const info = await this.loadInfo(i);
            const rot = (info.rotate + rotation) % 360;
            const disp = rotatedSize(info.size, rotation);
            const vp = page.getViewport({ scale: (cssWidth * dpr) / disp.w, rotation: rot });
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(vp.width));
            canvas.height = Math.max(1, Math.round(vp.height));
            job.task = page.render({ canvas, viewport: vp, background: '#ffffff' });
            await job.task.promise;
            const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
            canvas.width = 0;
            canvas.height = 0;
            if (!blob || this.dead) throw new Error('No thumbnail');
            const url = URL.createObjectURL(blob);
            this.thumbUrls.set(key, url);
            if (this.thumbUrls.size > THUMBS_KEPT) {
              const [old, oldUrl] = this.thumbUrls.entries().next().value!;
              URL.revokeObjectURL(oldUrl);
              this.thumbUrls.delete(old);
              this.thumbs.delete(old);
            }
            resolve(url);
          } catch (e) { this.thumbs.delete(key); reject(e); }
        },
      });
      this.pump();
    });
    this.thumbs.set(key, p);
    return p;
  }

  destroy(): void {
    if (this.dead) return;
    this.dead = true;
    for (const i of [...this.slots.keys()]) this.detach(i);
    for (const j of this.running.values()) { j.cancelled = true; j.task?.cancel(); }
    this.queue = [];
    for (const u of this.thumbUrls.values()) URL.revokeObjectURL(u);
    this.thumbUrls.clear();
    void this.doc.loadingTask.destroy().catch(() => {});
  }
}
