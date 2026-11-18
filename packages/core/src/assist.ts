// Remote control in a support session. The technician's pointer and keys travel as small JSON
// events over the session's data channel; the requester's PC checks every event before anything
// reaches its input: the requester's consent, a rate limit (120 events a second), a list of system
// chords that are never passed on (Ctrl+Alt+Del, Win+L…), and a mapping from the shared picture
// to the requester's screen. Pure logic, shared by the app's UI and its main process.

import { pictureBox } from './pointers.ts';

export type MouseButton = 'left' | 'right' | 'middle';

/**
 * One input event. Pointer positions are relative to the shared picture: 0..1 from its left and
 * top edges. Keys are KeyboardEvent.code values (physical keys), so they type the requester's
 * layout, as a keyboard plugged into their PC would.
 */
export type InputEvent =
  | { t: 'move'; x: number; y: number }
  | { t: 'button'; b: MouseButton; down: boolean; x: number; y: number }
  | { t: 'wheel'; dx: number; dy: number; x: number; y: number }
  | { t: 'key'; code: string; down: boolean };

/** Events a second the requester's PC accepts at most. */
export const INPUT_RATE = 120;
/** Events in one data-channel message at most. */
export const INPUT_BATCH = 32;
/** The requester stops control from their own keyboard with this chord (shown in the session bar). */
export const STOP_HOTKEY = 'Ctrl+Alt+Shift+S';

export interface KeyInfo {
  /** Windows virtual-key code. */
  vk: number;
  /** Extended key on Windows (the right-hand Ctrl and Alt, the arrows and the block above them). */
  ext?: boolean;
  /** X11 keysym name (xdotool). */
  x: string;
}

function buildKeys(): Record<string, KeyInfo> {
  const k: Record<string, KeyInfo> = {};
  for (let i = 0; i < 26; i++) k[`Key${String.fromCharCode(65 + i)}`] = { vk: 0x41 + i, x: String.fromCharCode(97 + i) };
  for (let i = 0; i < 10; i++) k[`Digit${i}`] = { vk: 0x30 + i, x: String(i) };
  for (let i = 1; i <= 12; i++) k[`F${i}`] = { vk: 0x6f + i, x: `F${i}` };
  for (let i = 0; i < 10; i++) k[`Numpad${i}`] = { vk: 0x60 + i, x: `KP_${i}` };
  const rest: Array<[string, number, string, boolean?]> = [
    ['Enter', 0x0d, 'Return'], ['Escape', 0x1b, 'Escape'], ['Backspace', 0x08, 'BackSpace'], ['Tab', 0x09, 'Tab'], ['Space', 0x20, 'space'],
    ['Minus', 0xbd, 'minus'], ['Equal', 0xbb, 'equal'], ['BracketLeft', 0xdb, 'bracketleft'], ['BracketRight', 0xdd, 'bracketright'],
    ['Backslash', 0xdc, 'backslash'], ['Semicolon', 0xba, 'semicolon'], ['Quote', 0xde, 'apostrophe'], ['Backquote', 0xc0, 'grave'],
    ['Comma', 0xbc, 'comma'], ['Period', 0xbe, 'period'], ['Slash', 0xbf, 'slash'], ['IntlBackslash', 0xe2, 'less'], ['CapsLock', 0x14, 'Caps_Lock'],
    ['PrintScreen', 0x2c, 'Print', true], ['ScrollLock', 0x91, 'Scroll_Lock'], ['Pause', 0x13, 'Pause'],
    ['Insert', 0x2d, 'Insert', true], ['Home', 0x24, 'Home', true], ['PageUp', 0x21, 'Prior', true], ['Delete', 0x2e, 'Delete', true],
    ['End', 0x23, 'End', true], ['PageDown', 0x22, 'Next', true],
    ['ArrowRight', 0x27, 'Right', true], ['ArrowLeft', 0x25, 'Left', true], ['ArrowDown', 0x28, 'Down', true], ['ArrowUp', 0x26, 'Up', true],
    ['NumLock', 0x90, 'Num_Lock', true], ['NumpadDivide', 0x6f, 'KP_Divide', true], ['NumpadMultiply', 0x6a, 'KP_Multiply'],
    ['NumpadSubtract', 0x6d, 'KP_Subtract'], ['NumpadAdd', 0x6b, 'KP_Add'], ['NumpadEnter', 0x0d, 'KP_Enter', true], ['NumpadDecimal', 0x6e, 'KP_Decimal'],
    ['ContextMenu', 0x5d, 'Menu', true],
    ['ShiftLeft', 0xa0, 'Shift_L'], ['ShiftRight', 0xa1, 'Shift_R'], ['ControlLeft', 0xa2, 'Control_L'], ['ControlRight', 0xa3, 'Control_R', true],
    ['AltLeft', 0xa4, 'Alt_L'], ['AltRight', 0xa5, 'Alt_R', true], ['MetaLeft', 0x5b, 'Super_L', true], ['MetaRight', 0x5c, 'Super_R', true],
  ];
  for (const [code, vk, x, ext] of rest) k[code] = ext ? { vk, x, ext } : { vk, x };
  return k;
}

/** Every key the technician may send. Anything else is dropped on the requester's PC. */
export const KEYS: Readonly<Record<string, KeyInfo>> = buildKeys();

type Mod = 'ctrl' | 'alt' | 'shift' | 'meta';
const MOD_OF: Record<string, Mod> = {
  ControlLeft: 'ctrl', ControlRight: 'ctrl', AltLeft: 'alt', AltRight: 'alt', ShiftLeft: 'shift', ShiftRight: 'shift', MetaLeft: 'meta', MetaRight: 'meta',
};
export const isModifier = (code: string): boolean => code in MOD_OF;

/**
 * System chords that are never passed on, whoever sends them: the secure attention sequence and
 * its remote twin, locking the PC, killing the X server, switching consoles, the kernel's SysRq,
 * and the requester's own stop chord.
 */
export const BLOCKED_CHORDS: ReadonlyArray<{ mods: Mod[]; keys: string[]; why: string }> = [
  { mods: ['ctrl', 'alt'], keys: ['Delete', 'NumpadDecimal'], why: 'Ctrl+Alt+Del' },
  { mods: ['ctrl', 'alt'], keys: ['End'], why: 'Ctrl+Alt+End' },
  { mods: ['ctrl', 'alt'], keys: ['Backspace'], why: 'Ctrl+Alt+Backspace' },
  { mods: ['meta'], keys: ['KeyL'], why: 'Win+L' },
  { mods: ['ctrl', 'alt'], keys: ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'], why: 'Ctrl+Alt+F-key' },
  { mods: ['alt'], keys: ['PrintScreen'], why: 'Alt+SysRq' },
  { mods: ['ctrl', 'alt', 'shift'], keys: ['KeyS'], why: STOP_HOTKEY },
];

/** The blocked chord a key-down would complete, given the modifiers already held (or null). */
export function blockedChord(code: string, held: ReadonlySet<Mod>): string | null {
  for (const c of BLOCKED_CHORDS) if (c.keys.includes(code) && c.mods.every((m) => held.has(m))) return c.why;
  return null;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const round4 = (v: number) => Math.round(v * 10000) / 10000;
const BUTTONS: readonly MouseButton[] = ['left', 'right', 'middle'];

/** Read one event from the wire. Anything malformed, out of range or unknown is null. */
export function decodeInput(raw: unknown): InputEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  const num = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n : null);
  const pos = () => { const x = num(v.x); const y = num(v.y); return x === null || y === null ? null : { x: round4(clamp01(x)), y: round4(clamp01(y)) }; };
  switch (v.t) {
    case 'move': { const p = pos(); return p ? { t: 'move', ...p } : null; }
    case 'button': {
      const p = pos();
      if (!p || !BUTTONS.includes(v.b as MouseButton) || typeof v.down !== 'boolean') return null;
      return { t: 'button', b: v.b as MouseButton, down: v.down, ...p };
    }
    case 'wheel': {
      const p = pos(); const dx = num(v.dx); const dy = num(v.dy);
      if (!p || dx === null || dy === null) return null;
      const c = (n: number) => Math.max(-10, Math.min(10, Math.round(n)));
      if (!c(dx) && !c(dy)) return null;
      return { t: 'wheel', dx: c(dx), dy: c(dy), ...p };
    }
    case 'key':
      if (typeof v.code !== 'string' || !(v.code in KEYS) || typeof v.down !== 'boolean') return null;
      return { t: 'key', code: v.code, down: v.down };
    default: return null;
  }
}

/** A data-channel message of input events: { k: 'in', e: [...] }. Returns the valid events (at most INPUT_BATCH). */
export function decodeInputBatch(raw: unknown): InputEvent[] {
  if (!raw || typeof raw !== 'object' || (raw as { k?: unknown }).k !== 'in') return [];
  const list = (raw as { e?: unknown }).e;
  if (!Array.isArray(list)) return [];
  const out: InputEvent[] = [];
  for (const item of list.slice(0, INPUT_BATCH)) { const e = decodeInput(item); if (e) out.push(e); }
  return out;
}

export type GateResult = { ok: true; ev: InputEvent } | { ok: false; reason: 'off' | 'rate' | 'chord' | 'stray'; detail?: string };

/**
 * The requester's side of control: checks each event against consent, the rate limit and the
 * chord list, and remembers which keys and buttons are held so that taking control back (or a
 * dropped event) never leaves a key stuck down.
 */
export class InputGate {
  private on = false;
  private times: number[] = [];
  private readonly heldKeys = new Set<string>();
  private readonly heldButtons = new Set<MouseButton>();
  private readonly rate: number;
  constructor(rate = INPUT_RATE) { this.rate = rate; }

  get enabled(): boolean { return this.on; }
  /** Consent given (true) or taken back (false). Taking it back returns the releases to inject. */
  set(on: boolean): InputEvent[] {
    if (on) { this.on = true; this.times = []; return []; }
    this.on = false;
    return this.release();
  }

  private mods(): Set<Mod> {
    const s = new Set<Mod>();
    for (const k of this.heldKeys) { const m = MOD_OF[k]; if (m) s.add(m); }
    return s;
  }

  accept(ev: InputEvent, now = Date.now()): GateResult {
    if (!this.on) return { ok: false, reason: 'off' };
    // releasing something held always goes through, so nothing stays stuck
    const release = (ev.t === 'key' && !ev.down) || (ev.t === 'button' && !ev.down);
    if (release) {
      const held = ev.t === 'key' ? this.heldKeys.has(ev.code) : this.heldButtons.has(ev.b);
      if (!held) return { ok: false, reason: 'stray' };
      if (ev.t === 'key') this.heldKeys.delete(ev.code); else this.heldButtons.delete(ev.b);
      this.times.push(now);
      return { ok: true, ev };
    }
    this.times = this.times.filter((t) => now - t < 1000);
    if (this.times.length >= this.rate) return { ok: false, reason: 'rate' };
    if (ev.t === 'key') {
      // a key held down repeats (another key-down for a held key is fine)
      const chord = blockedChord(ev.code, this.mods());
      if (chord) return { ok: false, reason: 'chord', detail: chord };
      this.heldKeys.add(ev.code);
    } else if (ev.t === 'button') {
      this.heldButtons.add(ev.b);
    }
    this.times.push(now);
    return { ok: true, ev };
  }

  /** Up events for every key and button still held (and forget them). */
  release(): InputEvent[] {
    const out: InputEvent[] = [];
    for (const code of this.heldKeys) out.push({ t: 'key', code, down: false });
    // x/y -1: where the pointer is now (no move first)
    for (const b of this.heldButtons) out.push({ t: 'button', b, down: false, x: -1, y: -1 });
    this.heldKeys.clear();
    this.heldButtons.clear();
    return out;
  }
}

// ------------------------------------------------------------------ coordinates
export interface Rect { x: number; y: number; width: number; height: number }

/**
 * A point in the shared picture (0..1) as a pixel on the requester's display (inside it, always):
 * the pixel the point falls in (scaling by width - 1 instead drifted by up to two pixels near the
 * right and bottom edges of a 4K screen).
 */
export function toScreen(x: number, y: number, display: Rect): { x: number; y: number } {
  const w = Math.max(1, Math.round(display.width));
  const h = Math.max(1, Math.round(display.height));
  return {
    x: Math.round(display.x) + Math.min(w - 1, Math.max(0, Math.floor(clamp01(x) * w + 1e-6))),
    y: Math.round(display.y) + Math.min(h - 1, Math.max(0, Math.floor(clamp01(y) * h + 1e-6))),
  };
}

/**
 * A pixel on the Windows virtual screen (every monitor, which may start left of or above the
 * primary one) in the 0..65535 range SendInput takes with MOUSEEVENTF_ABSOLUTE | VIRTUALDESK.
 */
export function toVirtualDesk(px: number, py: number, vs: Rect): { x: number; y: number } {
  const w = Math.max(2, vs.width);
  const h = Math.max(2, vs.height);
  const nx = Math.round(((px - vs.x) * 65535) / (w - 1));
  const ny = Math.round(((py - vs.y) * 65535) / (h - 1));
  return { x: Math.max(0, Math.min(65535, nx)), y: Math.max(0, Math.min(65535, ny)) };
}

/** Where a picture of srcW x srcH is drawn inside an element with object-fit: contain (the same mapping live pointers use). */
export function containBox(el: Rect, srcW: number, srcH: number): Rect { return pictureBox(el, srcW, srcH); }

/** A point on the technician's screen over the shared video, as 0..1 in the picture (null in the letterbox). */
export function fromPicture(clientX: number, clientY: number, el: Rect, srcW: number, srcH: number): { x: number; y: number } | null {
  const box = containBox(el, srcW, srcH);
  if (!(box.width > 0) || !(box.height > 0)) return null;
  const x = (clientX - box.x) / box.width;
  const y = (clientY - box.y) / box.height;
  if (x < 0 || y < 0 || x > 1 || y > 1) return null;
  return { x: round4(x), y: round4(y) };
}

/** DOM MouseEvent.button to ours. */
export function domButton(button: number): MouseButton | null {
  return button === 0 ? 'left' : button === 1 ? 'middle' : button === 2 ? 'right' : null;
}

/** A wheel event's movement in notches (positive = down / right), whatever the delta mode. */
export function wheelNotches(delta: number, deltaMode: number): number {
  if (!Number.isFinite(delta) || delta === 0) return 0;
  const lines = deltaMode === 1 ? delta / 3 : deltaMode === 2 ? delta * 3 : delta / 100;
  const n = Math.round(lines);
  return n === 0 ? Math.sign(delta) : Math.max(-10, Math.min(10, n));
}

/**
 * The technician's side: collects events and hands them out in batches, with pointer moves
 * coalesced (only the latest position between two batches is sent).
 */
export class InputBatcher {
  private queue: InputEvent[] = [];
  push(ev: InputEvent): void {
    const last = this.queue[this.queue.length - 1];
    if (ev.t === 'move' && last?.t === 'move') this.queue[this.queue.length - 1] = ev;
    else this.queue.push(ev);
  }
  get pending(): number { return this.queue.length; }
  /** The next message to send ({ k: 'in', e }), or null when nothing waits. */
  take(): { k: 'in'; e: InputEvent[] } | null {
    if (!this.queue.length) return null;
    const e = this.queue.splice(0, INPUT_BATCH);
    return { k: 'in', e };
  }
}
