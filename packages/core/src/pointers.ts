// Live pointers: while a screen is shared in a Room, or people look at the same file or
// whiteboard together, everyone can point at things. Each person's cursor shows with their name;
// a dragged rectangle or ellipse highlights an area for four seconds (or until unpinned); a click
// drops a numbered marker with an optional short note; freehand ink fades. Positions are relative
// to the shared surface (0..1), so they land on the same spot whatever each person's window size.
// Messages go over the Room's data channel, or through the hub for files and whiteboards, at most
// 30 times a second. Pure logic, shared by the UI on every platform.

export const POINTER_HZ = 30;
/** A highlight or ink stroke fades this long after it is drawn (unless pinned). */
export const HIGHLIGHT_MS = 4000;
export const INK_MS = 4000;
/** Cursors nobody moved for this long are hidden. */
export const CURSOR_IDLE_MS = 8000;
/** Coordinates (x and y, so twice the points) one ink stroke may hold. */
export const MAX_INK = 800;
export const MAX_NOTE = 80;
export const MAX_MARKERS = 40;
const MAX_ID = 24;

export type PointerMsg =
  /** where my pointer is (x < 0: it left the surface) */
  | { k: 'cur'; x: number; y: number }
  /** a highlighted area */
  | { k: 'hl'; id: string; shape: 'rect' | 'ellipse'; x: number; y: number; w: number; h: number; pinned: boolean }
  /** a numbered marker */
  | { k: 'pin'; id: string; n: number; x: number; y: number; note: string }
  /** take one of my marks away (a marker or a pinned highlight) */
  | { k: 'drop'; id: string }
  /** freehand ink: more points for a stroke (flat x, y list), and whether it is finished */
  | { k: 'ink'; id: string; pts: number[]; end: boolean }
  /** the presenter clears every mark */
  | { k: 'clear' }
  /** the presenter turns pointers on or off for everyone */
  | { k: 'mode'; on: boolean };

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const r4 = (v: number) => Math.round(v * 10000) / 10000;
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const okId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID && /^[\w-]+$/.test(v);

/** Read one pointer message from the wire (null when malformed). */
export function readPointerMsg(raw: unknown): PointerMsg | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  switch (v.k) {
    case 'cur':
      if (!fin(v.x) || !fin(v.y)) return null;
      return v.x < 0 || v.y < 0 ? { k: 'cur', x: -1, y: -1 } : { k: 'cur', x: r4(clamp01(v.x)), y: r4(clamp01(v.y)) };
    case 'hl': {
      if (!okId(v.id) || (v.shape !== 'rect' && v.shape !== 'ellipse') || !fin(v.x) || !fin(v.y) || !fin(v.w) || !fin(v.h)) return null;
      const x = clamp01(v.x); const y = clamp01(v.y);
      const w = Math.min(1 - x, Math.max(0, v.w)); const h = Math.min(1 - y, Math.max(0, v.h));
      if (w < 0.002 && h < 0.002) return null;
      return { k: 'hl', id: v.id, shape: v.shape, x: r4(x), y: r4(y), w: r4(w), h: r4(h), pinned: v.pinned === true };
    }
    case 'pin':
      if (!okId(v.id) || !fin(v.x) || !fin(v.y) || !fin(v.n)) return null;
      return { k: 'pin', id: v.id, n: Math.max(1, Math.min(999, Math.round(v.n))), x: r4(clamp01(v.x)), y: r4(clamp01(v.y)), note: typeof v.note === 'string' ? v.note.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, MAX_NOTE) : '' };
    case 'drop':
      return okId(v.id) ? { k: 'drop', id: v.id } : null;
    case 'ink': {
      if (!okId(v.id) || !Array.isArray(v.pts)) return null;
      const pts: number[] = [];
      for (let i = 0; i + 1 < v.pts.length && pts.length < MAX_INK; i += 2) {
        const a = v.pts[i]; const b = v.pts[i + 1];
        if (!fin(a) || !fin(b)) return null;
        pts.push(r4(clamp01(a)), r4(clamp01(b)));
      }
      return { k: 'ink', id: v.id, pts, end: v.end === true };
    }
    case 'clear': return { k: 'clear' };
    case 'mode': return typeof v.on === 'boolean' ? { k: 'mode', on: v.on } : null;
    default: return null;
  }
}

/** A list of pointer messages, as they travel: { k: 'pt', m: [...] }. */
export function readPointerBatch(raw: unknown): PointerMsg[] {
  if (!raw || typeof raw !== 'object' || (raw as { k?: unknown }).k !== 'pt') return [];
  const list = (raw as { m?: unknown }).m;
  if (!Array.isArray(list)) return [];
  const out: PointerMsg[] = [];
  for (const x of list.slice(0, 40)) { const m = readPointerMsg(x); if (m) out.push(m); }
  return out;
}

/**
 * Sends at most `hz` batches a second. Pointer moves coalesce (the latest wins), ink points for the
 * same stroke join up, and everything else keeps its order. Strokes stop growing at MAX_INK.
 */
export class PointerThrottle {
  private queue: PointerMsg[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private last = -Infinity;
  private readonly inkSize = new Map<string, number>();
  private readonly gap: number;
  private readonly send: (batch: { k: 'pt'; m: PointerMsg[] }) => void;
  private readonly now: () => number;
  private readonly later: (f: () => void, ms: number) => ReturnType<typeof setTimeout>;

  constructor(send: (batch: { k: 'pt'; m: PointerMsg[] }) => void, opts: { hz?: number; now?: () => number; later?: (f: () => void, ms: number) => ReturnType<typeof setTimeout> } = {}) {
    this.send = send;
    this.gap = 1000 / (opts.hz ?? POINTER_HZ);
    this.now = opts.now ?? (() => Date.now());
    this.later = opts.later ?? ((f, ms) => setTimeout(f, ms));
  }

  /** How many more coordinates the stroke may take. */
  inkRoom(id: string): number { return MAX_INK - (this.inkSize.get(id) ?? 0); }

  push(m: PointerMsg): void {
    if (m.k === 'cur') {
      const at = this.queue.findIndex((q) => q.k === 'cur');
      if (at >= 0) this.queue.splice(at, 1);
      this.queue.push(m);
    } else if (m.k === 'ink') {
      const room = this.inkRoom(m.id);
      const pts = m.pts.slice(0, Math.max(0, room - (room % 2)));
      this.inkSize.set(m.id, (this.inkSize.get(m.id) ?? 0) + pts.length);
      if (this.inkSize.size > 200) this.inkSize.delete(this.inkSize.keys().next().value as string);
      const prev = this.queue.findLast((q): q is Extract<PointerMsg, { k: 'ink' }> => q.k === 'ink' && q.id === m.id && !q.end);
      if (prev) { prev.pts.push(...pts); prev.end = m.end; } else this.queue.push({ ...m, pts: [...pts] });
    } else this.queue.push(m);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    const wait = Math.max(0, this.last + this.gap - this.now());
    if (wait === 0) { this.flush(); return; }
    this.timer = this.later(() => { this.timer = null; this.flush(); }, wait);
  }

  /** Send what waits now (the timer calls this; tests may too). */
  flush(): void {
    if (!this.queue.length) return;
    const m = this.queue;
    this.queue = [];
    this.last = this.now();
    this.send({ k: 'pt', m });
  }

  stop(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; this.queue = []; }
}

// ------------------------------------------------------------------ what everyone has drawn
export interface Cursor { from: string; x: number; y: number; at: number }
export interface Highlight { id: string; from: string; shape: 'rect' | 'ellipse'; x: number; y: number; w: number; h: number; pinned: boolean; at: number }
export interface Marker { id: string; from: string; n: number; x: number; y: number; note: string; at: number }
export interface Ink { id: string; from: string; pts: number[]; done: boolean; at: number }

/**
 * The marks on one shared surface, as one viewer sees them. `from` is whoever sent a message
 * (a device id); the presenter alone may clear everything or turn pointers off.
 */
export class PointerBoard {
  readonly cursors = new Map<string, Cursor>();
  readonly highlights = new Map<string, Highlight>();
  readonly markers = new Map<string, Marker>();
  readonly inks = new Map<string, Ink>();
  enabled = true;

  private key(from: string, id: string): string { return `${from}:${id}`; }

  /** Apply a message; true when something visible changed. */
  apply(from: string, m: PointerMsg, now: number, fromPresenter: boolean): boolean {
    if (m.k === 'mode') {
      if (!fromPresenter || this.enabled === m.on) return false;
      this.enabled = m.on;
      if (!m.on) this.cursors.clear();
      return true;
    }
    if (m.k === 'clear') {
      if (!fromPresenter) return false;
      this.highlights.clear(); this.markers.clear(); this.inks.clear();
      return true;
    }
    if (!this.enabled) return false;
    switch (m.k) {
      case 'cur':
        if (m.x < 0) return this.cursors.delete(from);
        this.cursors.set(from, { from, x: m.x, y: m.y, at: now });
        return true;
      case 'hl':
        this.highlights.set(this.key(from, m.id), { id: m.id, from, shape: m.shape, x: m.x, y: m.y, w: m.w, h: m.h, pinned: m.pinned, at: now });
        return true;
      case 'pin': {
        if (this.markers.size >= MAX_MARKERS) {
          const oldest = [...this.markers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
          if (oldest) this.markers.delete(oldest[0]);
        }
        this.markers.set(this.key(from, m.id), { id: m.id, from, n: m.n, x: m.x, y: m.y, note: m.note, at: now });
        return true;
      }
      case 'drop': {
        const k = this.key(from, m.id);
        return this.markers.delete(k) || this.highlights.delete(k);
      }
      case 'ink': {
        const k = this.key(from, m.id);
        const cur = this.inks.get(k);
        if (cur) {
          const room = MAX_INK - cur.pts.length;
          if (room > 0) cur.pts.push(...m.pts.slice(0, room - (room % 2)));
          cur.done = cur.done || m.end;
          cur.at = now;
        } else this.inks.set(k, { id: m.id, from, pts: m.pts.slice(0, MAX_INK), done: m.end, at: now });
        return true;
      }
    }
  }

  /** Forget what has faded; true when something went. */
  prune(now: number): boolean {
    let changed = false;
    for (const [k, h] of this.highlights) if (!h.pinned && now - h.at > HIGHLIGHT_MS) { this.highlights.delete(k); changed = true; }
    for (const [k, s] of this.inks) if (s.done && now - s.at > INK_MS) { this.inks.delete(k); changed = true; }
    for (const [k, c] of this.cursors) if (now - c.at > CURSOR_IDLE_MS) { this.cursors.delete(k); changed = true; }
    return changed;
  }

  /** The next marker number (one more than any shown). */
  nextMarker(): number {
    let n = 0;
    for (const m of this.markers.values()) n = Math.max(n, m.n);
    return n + 1;
  }

  /** Someone left: their cursor goes (their marks stay until they fade or are cleared). */
  forget(from: string): void { this.cursors.delete(from); }
}

/** How visible a fading mark is now (1 = fully, 0 = gone): the last second fades out. */
export function fade(at: number, now: number, lifeMs: number): number {
  const left = lifeMs - (now - at);
  return left <= 0 ? 0 : left >= 1000 ? 1 : left / 1000;
}

// ------------------------------------------------------------------ coordinates
export interface Box { x: number; y: number; width: number; height: number }

/**
 * A point on screen as a position on the surface (0..1), for a surface drawn in `box` and turned
 * clockwise by `rot` degrees (0, 90, 180 or 270, as the image viewer turns pictures).
 */
export function toSurface(clientX: number, clientY: number, box: Box, rot = 0): { x: number; y: number } | null {
  if (!(box.width > 0) || !(box.height > 0)) return null;
  const u = (clientX - box.x) / box.width;
  const v = (clientY - box.y) / box.height;
  if (u < 0 || v < 0 || u > 1 || v > 1) return null;
  const r = ((Math.round(rot / 90) % 4) + 4) % 4;
  const [x, y] = r === 0 ? [u, v] : r === 1 ? [v, 1 - u] : r === 2 ? [1 - u, 1 - v] : [1 - v, u];
  return { x: r4(x), y: r4(y) };
}

/** The other way: where a surface position is on screen, for a surface drawn in `box` turned by `rot`. */
export function fromSurface(x: number, y: number, box: Box, rot = 0): { x: number; y: number } {
  const r = ((Math.round(rot / 90) % 4) + 4) % 4;
  const [u, v] = r === 0 ? [x, y] : r === 1 ? [1 - y, x] : r === 2 ? [1 - x, 1 - y] : [y, 1 - x];
  return { x: box.x + u * box.width, y: box.y + v * box.height };
}

/**
 * Where a shared picture of srcW x srcH is drawn inside an element with object-fit: contain (the
 * shared screen's <video>): the letterbox bars are not the picture. The same mapping turns the
 * controller's pointer into input positions (assist.ts fromPicture), so a marker and a click land
 * on the same pixel.
 */
export function pictureBox(el: Box, srcW: number, srcH: number): Box {
  if (!(srcW > 0) || !(srcH > 0) || !(el.width > 0) || !(el.height > 0)) return { ...el };
  const scale = Math.min(el.width / srcW, el.height / srcH);
  const width = srcW * scale;
  const height = srcH * scale;
  return { x: el.x + (el.width - width) / 2, y: el.y + (el.height - height) / 2, width, height };
}

/**
 * Where the shared display is inside the presenter's own pointer window, in that window's CSS
 * pixels. `display` and `win` are in the same screen coordinates (Electron's DIPs, which may be
 * negative on a monitor left of or above the main one); `inner` is the window's viewport
 * (innerWidth x innerHeight). The window should cover the display exactly, but Windows may size or
 * place it differently (a monitor with another scaling, a taskbar, the window moved by the system),
 * and a page zoom changes CSS pixels: the marks follow the display, not the window.
 */
export function overlayBox(display: Box, win: Box, inner: { width: number; height: number }): Box {
  if (!(win.width > 0) || !(win.height > 0) || !(inner.width > 0) || !(inner.height > 0)) return { x: 0, y: 0, width: Math.max(0, inner.width), height: Math.max(0, inner.height) };
  const kx = inner.width / win.width;
  const ky = inner.height / win.height;
  return { x: (display.x - win.x) * kx, y: (display.y - win.y) * ky, width: display.width * kx, height: display.height * ky };
}

/** Make a short id for a mark. */
export function markId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`.slice(0, MAX_ID);
}
