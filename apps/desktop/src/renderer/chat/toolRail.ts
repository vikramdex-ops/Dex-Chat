// Which message shows its tool column (side-track, stamp, keep, more). One message at a time, the
// one under the pointer, with hover intent: the column hangs outside the message (on the spine to
// its left, beside a card, above a side-track reply), so moving the pointer to it crosses ground
// that belongs to no message, or to the next one. The column stays while the pointer is on its way:
// for 300 ms after it leaves, and as long as it moves inside the corridor between where it left
// and the column (the column's message keeps its tools; a neighbour it crosses does not take them).
// Stop over a neighbour, or move away from the column, and the neighbour takes them; so the column
// never jitters between two messages and no stale column is left to catch a click.
// Touch: a tap on a message shows its tools (a tap elsewhere puts them away); a long press still
// lifts the message to reference it. The keyboard: focus inside a message shows them (CSS).
const GRACE_MS = 300;
/** The longest a way to the column may take while it keeps closing in. */
const WAY_MS = 1500;
/** How far around the column the corridor reaches, for a hand that is not quite on target. */
const SLACK = 8;

type Pt = { x: number; y: number };

let active: HTMLElement | null = null;
/** Where the pointer last was inside the active message (the corridor's apex). */
let anchor: Pt | null = null;
let leftAt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let pendingTarget: HTMLElement | null = null;
let users = 0;
let down: { x: number; y: number; t: number; msg: HTMLElement | null } | null = null;

/** A message with a tool column of its own (not one being edited, deleted or picked). */
function messageAt(t: EventTarget | null): HTMLElement | null {
  const el = t instanceof Element ? t.closest<HTMLElement>('.msg') : null;
  return el && el.querySelector(':scope > .spine-tools') ? el : null;
}

/** The column hangs down from a message; near the bottom of its list it hangs up instead. */
export function fitTools(el: HTMLElement): void {
  const box = el.closest('.timeline')?.getBoundingClientRect();
  if (box) el.classList.toggle('tools-up', el.getBoundingClientRect().top + 150 > box.bottom);
}

function show(el: HTMLElement | null): void {
  if (timer) { clearTimeout(timer); timer = null; }
  pendingTarget = null;
  if (active === el) return;
  active?.classList.remove('tools-on');
  active = el && el.isConnected ? el : null;
  if (active) { fitTools(active); active.classList.add('tools-on'); }
}

/** Is p inside the hull of the apex and the rectangle (a triangle fan from the apex to its sides)? */
function inCorridor(apex: Pt, r: DOMRect, p: Pt): boolean {
  const x0 = r.left - SLACK; const x1 = r.right + SLACK; const y0 = r.top - SLACK; const y1 = r.bottom + SLACK;
  if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) return true;
  const c: Pt[] = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
  const side = (a: Pt, b: Pt, q: Pt) => (b.x - a.x) * (q.y - a.y) - (b.y - a.y) * (q.x - a.x);
  for (let i = 0; i < 4; i++) {
    const a = c[i]; const b = c[(i + 1) % 4];
    const d1 = side(apex, a, p); const d2 = side(a, b, p); const d3 = side(b, apex, p);
    const neg = d1 < 0 || d2 < 0 || d3 < 0; const pos = d1 > 0 || d2 > 0 || d3 > 0;
    if (!(neg && pos)) return true;
  }
  return false;
}

/** After `ms`: whatever the pointer rests on takes the tools (or nothing does). */
function later(target: HTMLElement | null, ms: number, restart = false): void {
  pendingTarget = target;
  if (timer && !restart) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; const t = pendingTarget; pendingTarget = null; show(t); }, Math.max(0, ms));
}

/** How far p is from the rectangle (0 inside it). */
const distance = (r: DOMRect, p: Pt) => Math.hypot(Math.max(r.left - p.x, 0, p.x - r.right), Math.max(r.top - p.y, 0, p.y - r.bottom));
/** The closest the pointer has come to the column since it left its message. */
let closest = Infinity;

function onMove(e: PointerEvent): void {
  if (e.pointerType === 'touch') return;
  const p = { x: e.clientX, y: e.clientY };
  const msg = messageAt(e.target);
  if (msg && msg === active) { anchor = p; leftAt = 0; closest = Infinity; if (timer) { clearTimeout(timer); timer = null; } pendingTarget = null; return; }
  if (!active) { show(msg); return; }
  const now = Date.now();
  // just left the active message: the grace starts now
  if (!leftAt) { leftAt = now; closest = Infinity; }
  const rail = active.querySelector<HTMLElement>(':scope > .spine-tools');
  const r = rail?.getBoundingClientRect();
  // on its way: inside the corridor and still closing in. Each such move gives it another moment;
  // resting (no move) for that moment hands the tools to what is under the pointer.
  const d = r && r.width ? distance(r, p) : Infinity;
  const heading = !!(r && r.width && anchor && inCorridor(anchor, r, p)) && d <= closest + 2 && now - leftAt < WAY_MS;
  closest = Math.min(closest, d);
  if (heading) { later(msg, GRACE_MS, true); return; }
  // crossing a gap that is no message's (the spine, between runs): the grace from when it left
  if (!msg && now - leftAt < GRACE_MS) { later(null, GRACE_MS - (now - leftAt)); return; }
  show(msg);
}

/** The pointer left the window or went somewhere that is not a list of messages. */
function onOut(e: PointerEvent): void {
  if (e.pointerType === 'touch' || e.relatedTarget) return;
  if (active) { if (!leftAt) leftAt = Date.now(); later(null, GRACE_MS - (Date.now() - leftAt)); }
}

function onDown(e: PointerEvent): void {
  if (e.pointerType !== 'touch') return;
  down = { x: e.clientX, y: e.clientY, t: Date.now(), msg: messageAt(e.target) };
}

/** A tap: on a message (not on one of its buttons or links) shows its tools; anywhere else puts them away. */
function onUp(e: PointerEvent): void {
  if (e.pointerType !== 'touch' || !down) return;
  const d = down; down = null;
  if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10 || Date.now() - d.t > 450) return;
  const t = e.target instanceof Element ? e.target : null;
  if (t?.closest('.spine-tools, .popover, .menu, .scrim')) return;
  if (d.msg && t?.closest('button, a, input, textarea, select, video, audio, [contenteditable]')) return;
  show(d.msg && d.msg === active ? null : d.msg);
}

/** A message removed while it showed its tools (scrolled out of the window, deleted). */
function onScroll(): void { if (active && !active.isConnected) show(null); }

/** Use the tool-column intent while a message list is on screen (one set of listeners, however many lists). */
export function startToolRail(): () => void {
  if (users++ === 0) {
    document.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('pointerout', onOut, { passive: true });
    document.addEventListener('pointerdown', onDown, { passive: true });
    document.addEventListener('pointerup', onUp, { passive: true });
    document.addEventListener('scroll', onScroll, { passive: true, capture: true });
  }
  return () => {
    if (--users > 0) return;
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerout', onOut);
    document.removeEventListener('pointerdown', onDown);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('scroll', onScroll, { capture: true });
    show(null);
  };
}

