// Panes: up to three conversations laid side by side like sheets on a table. One has focus;
// a plain click in the Switchboard swaps the focused Pane, Ctrl+click or a drag lays a new one beside.
import { useSyncExternalStore } from 'react';

export interface PaneLayout { ids: string[]; focus: number }

let layout: PaneLayout = { ids: [], focus: 0 };
const listeners = new Set<() => void>();
const set = (next: PaneLayout) => { layout = next; for (const l of listeners) l(); };

export const usePanes = (): PaneLayout => useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => layout);
export const panesNow = (): PaneLayout => layout;

/** How many Panes fit side by side in this window. */
export function maxPanes(): number {
  const w = typeof window === 'undefined' ? 1280 : window.innerWidth;
  return w >= 1180 ? 3 : w >= 860 ? 2 : 1;
}

/** Show a conversation in the focused Pane, or focus the Pane that already shows it. */
export function openInPane(id: string): void {
  const at = layout.ids.indexOf(id);
  if (at >= 0) { if (at !== layout.focus) set({ ...layout, focus: at }); return; }
  if (!layout.ids.length) { set({ ids: [id], focus: 0 }); return; }
  const ids = layout.ids.slice(0, maxPanes());
  const focus = Math.min(layout.focus, ids.length - 1);
  ids[focus] = id;
  set({ ids, focus });
}

/** Lay a conversation in a Pane of its own beside the others (at a position, or at the end). */
export function openBeside(id: string, index?: number): void {
  const ids = layout.ids.filter((x) => x !== id);
  const max = maxPanes();
  let at = Math.max(0, Math.min(index ?? ids.length, ids.length));
  ids.splice(at, 0, id);
  // full: the Pane farthest from the new one makes way
  while (ids.length > max) {
    const drop = at >= ids.length / 2 ? 0 : ids.length - 1;
    ids.splice(drop, 1);
    if (drop < at) at--;
  }
  set({ ids, focus: at });
}

export function focusPane(index: number): void {
  if (index !== layout.focus && index >= 0 && index < layout.ids.length) set({ ...layout, focus: index });
}

export function closePane(index: number): void {
  const ids = layout.ids.filter((_, i) => i !== index);
  set({ ids, focus: Math.max(0, Math.min(layout.focus > index ? layout.focus - 1 : layout.focus, ids.length - 1)) });
}

/** Drop Panes whose conversation is gone (left, removed), and Panes beyond what the window fits. */
export function prunePanes(keep: (id: string) => boolean): void {
  const ids = layout.ids.filter(keep).slice(0, maxPanes());
  if (ids.length !== layout.ids.length) set({ ids, focus: Math.max(0, Math.min(layout.focus, ids.length - 1)) });
}

/** The drag type a Switchboard row carries, so a Pane area knows to accept it. */
export const CONV_DRAG = 'application/x-dex-conversation';
