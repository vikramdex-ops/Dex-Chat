// The viewer's camera over a drawing sheet: pan, zoom about a point, inertia after a fling, and a
// flight from one place to another that pulls back first when the way is long (like a CAD viewer's
// zoom-previous). Screen = (world - camera) × zoom. Pure: no DOM.

export const MIN_Z = 0.06;
export const MAX_Z = 2.6;

export interface Rect { x: number; y: number; w: number; h: number }

interface Flight { from: { x: number; y: number; z: number }; to: { x: number; y: number; z: number }; t0: number; dur: number; mid: number }

export class Camera {
  /** The world point at the top-left of the view. */
  x = 0;
  y = 0;
  z = 1;
  /** The view's size in CSS pixels. */
  vw = 1;
  vh = 1;
  /** Fling velocity, in screen pixels per millisecond. */
  private vx = 0;
  private vy = 0;
  private last = 0;
  private flight: Flight | null = null;
  bounds: Rect = { x: 0, y: 0, w: 1, h: 1 };

  resize(w: number, h: number): void {
    // keep the centre where it was
    const cx = this.x + this.vw / 2 / this.z, cy = this.y + this.vh / 2 / this.z;
    this.vw = Math.max(1, w); this.vh = Math.max(1, h);
    this.x = cx - this.vw / 2 / this.z; this.y = cy - this.vh / 2 / this.z;
    this.clamp();
  }

  toScreen(wx: number, wy: number): [number, number] { return [(wx - this.x) * this.z, (wy - this.y) * this.z]; }
  toWorld(sx: number, sy: number): [number, number] { return [sx / this.z + this.x, sy / this.z + this.y]; }
  /** The part of the world in view, with a margin in world units. */
  view(margin = 0): Rect { return { x: this.x - margin, y: this.y - margin, w: this.vw / this.z + margin * 2, h: this.vh / this.z + margin * 2 }; }

  /** The zoom that shows a whole rectangle with some room round it. */
  fitZoom(r: Rect, pad = 32): number {
    return Math.min(MAX_Z, Math.max(MIN_Z, Math.min((this.vw - pad * 2) / Math.max(1, r.w), (this.vh - pad * 2) / Math.max(1, r.h))));
  }

  set(x: number, y: number, z: number): void { this.z = z; this.x = x; this.y = y; this.clamp(); }

  centreOn(wx: number, wy: number, z = this.z): void {
    this.z = Math.min(MAX_Z, Math.max(MIN_Z, z));
    this.x = wx - this.vw / 2 / this.z; this.y = wy - this.vh / 2 / this.z;
    this.clamp();
  }

  fit(r: Rect, pad = 32): void { this.centreOn(r.x + r.w / 2, r.y + r.h / 2, this.fitZoom(r, pad)); }

  panBy(dx: number, dy: number): void { this.flight = null; this.x -= dx / this.z; this.y -= dy / this.z; this.clamp(); }

  zoomAt(sx: number, sy: number, factor: number): void {
    this.flight = null;
    const [wx, wy] = this.toWorld(sx, sy);
    this.z = Math.min(MAX_Z, Math.max(MIN_Z, this.z * factor));
    this.x = wx - sx / this.z; this.y = wy - sy / this.z;
    this.clamp();
  }

  /** Keep at least part of the sheet in view. */
  clamp(): void {
    const b = this.bounds;
    const w = this.vw / this.z, h = this.vh / this.z;
    const slackX = Math.max(w * 0.6, (w - b.w) / 2 + w * 0.1), slackY = Math.max(h * 0.6, (h - b.h) / 2 + h * 0.1);
    this.x = Math.min(b.x + b.w - w + slackX, Math.max(b.x - slackX, this.x));
    this.y = Math.min(b.y + b.h - h + slackY, Math.max(b.y - slackY, this.y));
  }

  fling(vx: number, vy: number, now: number): void { this.vx = vx; this.vy = vy; this.last = now; }
  stop(): void { this.vx = 0; this.vy = 0; this.flight = null; }

  /** Fly to a point at a zoom; long trips pull back on the way. `dur` 0 jumps. */
  flyTo(wx: number, wy: number, z: number, now: number, dur = 700): void {
    this.vx = this.vy = 0;
    z = Math.min(MAX_Z, Math.max(MIN_Z, z));
    if (dur <= 0) { this.centreOn(wx, wy, z); this.flight = null; return; }
    const cx = this.x + this.vw / 2 / this.z, cy = this.y + this.vh / 2 / this.z;
    const dist = Math.hypot(wx - cx, wy - cy) * Math.min(this.z, z);
    const span = Math.max(this.vw, this.vh);
    // pull back far enough to see both ends when they are more than a screen apart
    const mid = dist > span * 0.9 ? Math.max(MIN_Z, Math.min(this.z, z) * Math.min(1, span / (dist + span)) * 1.2) : Math.min(this.z, z);
    this.flight = { from: { x: cx, y: cy, z: this.z }, to: { x: wx, y: wy, z }, t0: now, dur: dist > span * 0.9 ? dur * 1.5 : dur, mid };
  }

  get moving(): boolean { return !!this.flight || Math.abs(this.vx) > 0.01 || Math.abs(this.vy) > 0.01; }

  /** Advance flights and flings; true while something is still moving. */
  step(now: number): boolean {
    if (this.flight) {
      const f = this.flight;
      const t = Math.min(1, (now - f.t0) / f.dur);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      // zoom eases through the pull-back in log space; position follows the eased path
      const lz = (a: number, b: number, k: number) => Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * k);
      const z = t < 0.5 ? lz(f.from.z, f.mid, Math.min(1, e * 2)) : lz(f.mid, f.to.z, Math.max(0, e * 2 - 1));
      this.z = z;
      this.x = f.from.x + (f.to.x - f.from.x) * e - this.vw / 2 / z;
      this.y = f.from.y + (f.to.y - f.from.y) * e - this.vh / 2 / z;
      this.clamp();
      if (t >= 1) this.flight = null;
      return true;
    }
    if (Math.abs(this.vx) > 0.01 || Math.abs(this.vy) > 0.01) {
      const dt = Math.min(48, Math.max(1, now - this.last));
      this.last = now;
      this.x -= (this.vx * dt) / this.z; this.y -= (this.vy * dt) / this.z;
      const k = Math.pow(0.94, dt / 16);
      this.vx *= k; this.vy *= k;
      this.clamp();
      return true;
    }
    return false;
  }
}
