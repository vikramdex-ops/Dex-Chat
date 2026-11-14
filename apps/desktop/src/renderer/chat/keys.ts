// Keys people choose for the main actions (Go to, Search, Preferences, quieting sounds, Send later,
// Edit last and the lenses), kept on this device and checked for clashes; and "G then a letter",
// which moves between lenses outside text fields. Everything that listens for these keys or shows
// them as a hint reads them from here.
import { useSyncExternalStore } from 'react';

export type KeyAction = 'goto' | 'search' | 'prefs' | 'mute' | 'sendLater' | 'editLast' | `lens:${string}`;

export const ACTIONS: Array<{ id: KeyAction; label: string; fallback: string }> = [
  { id: 'goto', label: 'Go to a person, conversation or command', fallback: 'Ctrl+G' },
  { id: 'search', label: 'Search messages and files, with filters', fallback: 'Ctrl+Shift+F' },
  { id: 'prefs', label: 'Preferences', fallback: 'Ctrl+,' },
  { id: 'mute', label: 'Sounds quiet, or back on', fallback: 'Ctrl+Shift+Q' },
  { id: 'sendLater', label: 'Send later', fallback: 'Ctrl+Shift+Enter' },
  { id: 'editLast', label: 'Edit your last message', fallback: 'Ctrl+ArrowUp' },
];

/** The lenses' own keys: Ctrl and their place in the lens bar. */
export const lensFallback = (index: number) => (index < 9 ? `Ctrl+${index + 1}` : '');

/** Keys that already do something else, and what. They cannot be given to an action. */
export const RESERVED: Record<string, string> = {
  'Ctrl+/': 'opens the keyboard shortcuts', 'Ctrl+B': 'makes text bold', 'Ctrl+I': 'makes text italic', 'Ctrl+U': 'underlines text',
  'Ctrl+K': 'adds a link', 'Ctrl+.': 'opens the emoji', 'Ctrl+=': 'makes text larger', 'Ctrl+-': 'makes text smaller', 'Ctrl+0': 'sets the default text size',
  'Ctrl+C': 'copies', 'Ctrl+V': 'pastes', 'Ctrl+X': 'cuts', 'Ctrl+Z': 'undoes', 'Ctrl+Y': 'redoes', 'Ctrl+A': 'selects everything',
  'Enter': 'sends', 'Shift+Enter': 'starts a new line', 'Escape': 'closes', 'Tab': 'moves between controls', 'Ctrl+Alt+D': 'shows Dexterity Connect from any app',
  'Alt+ArrowUp': 'goes to the previous conversation', 'Alt+ArrowDown': 'goes to the next conversation', 'Alt+F4': 'closes the window',
};

/** G then a letter, outside text fields. */
export const G_KEYS: Array<{ letter: string; lens: string; label: string }> = [
  { letter: 'P', lens: 'pulse', label: 'Pulse' }, { letter: 'D', lens: 'direct', label: 'Direct' }, { letter: 'S', lens: 'spaces', label: 'Spaces' },
  { letter: 'K', lens: 'desk', label: 'Desk' }, { letter: 'C', lens: 'calendar', label: 'Calendar' }, { letter: 'Y', lens: 'directory', label: 'Directory' },
  { letter: 'M', lens: 'meet', label: 'Meet' },
];

const STORE = 'dex.keys';
function load(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? '{}') as unknown;
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k, x]) => typeof k === 'string' && typeof x === 'string')) as Record<string, string>;
  } catch { /* storage off or damaged */ }
  return {};
}
let chosen = load();
const subs = new Set<() => void>();
const save = (next: Record<string, string>) => {
  chosen = next;
  try { localStorage.setItem(STORE, JSON.stringify(next)); } catch { /* storage off */ }
  for (const f of subs) f();
};

/** The keys for an action: the person's choice, or the usual ones. Empty means none. */
export function keyFor(action: KeyAction, fallback?: string): string {
  if (action in chosen) return chosen[action];
  return fallback ?? ACTIONS.find((a) => a.id === action)?.fallback ?? '';
}
export const isChosen = (action: KeyAction) => action in chosen;
export function setKey(action: KeyAction, combo: string): void { save({ ...chosen, [action]: combo }); }
export function resetKey(action: KeyAction): void { const next = { ...chosen }; delete next[action]; save(next); }
export function resetAllKeys(): void { save({}); }
/** Re-render when keys change. */
export const useKeys = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => chosen);

const CODE_KEYS: Record<string, string> = {
  Comma: ',', Period: '.', Slash: '/', Equal: '=', Minus: '-', Backquote: '`', BracketLeft: '[', BracketRight: ']',
  Semicolon: ';', Quote: "'", Backslash: '\\', Space: 'Space', NumpadAdd: '=', NumpadSubtract: '-',
};

interface KeyLike { key: string; code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey?: boolean }

/** A key press written the way shortcuts are stored: "Ctrl+Shift+F", "Ctrl+ArrowUp". Null for a lone modifier. */
export function comboOf(e: KeyLike): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'CapsLock'].includes(e.key)) return null;
  const key = /^Key([A-Z])$/.exec(e.code)?.[1] ?? /^(?:Digit|Numpad)(\d)$/.exec(e.code)?.[1] ?? CODE_KEYS[e.code]
    ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key === 'Esc' ? 'Escape' : e.key);
  return [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', key].filter(Boolean).join('+');
}

/** Does this key press match these keys? */
export const pressed = (e: KeyLike, combo: string) => !!combo && comboOf(e) === combo;

/** Can these keys be given to an action at all (a letter alone would stop people typing)? */
export function usable(combo: string): string | null {
  const parts = combo.split('+');
  const key = parts[parts.length - 1];
  if (/^F\d{1,2}$/.test(key)) return null;
  if (!parts.includes('Ctrl') && !parts.includes('Alt')) return 'Use Ctrl or Alt with a key, or a function key (F1 to F12).';
  return null;
}

const NICE: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc', Space: 'Space' };
/** The keys one by one, for <kbd> chips: ["Ctrl", "Shift", "F"]. */
export const keyParts = (combo: string) => (combo ? combo.split('+').map((p) => NICE[p] ?? p) : []);
/** A short hint for menus: "Ctrl ⇧ Enter". */
export const keyHint = (combo: string) => keyParts(combo).map((p) => (p === 'Shift' ? '⇧' : p)).join(' ');
/** In running text: "Ctrl+Shift+F". */
export const keyText = (combo: string) => keyParts(combo).join('+');

/** Is the key press happening in a place where people type? */
export function typingIn(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'range'].includes((el as HTMLInputElement).type));
}
