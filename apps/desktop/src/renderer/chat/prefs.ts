// How messages are drawn on this device: on the spine (the default), or as compact cards with your
// own aligned to the right. Switching redraws every open Pane at once.
import { useSyncExternalStore } from 'react';

export type MsgLayout = 'spine' | 'cards';
const STORE = 'dex.msgLayout';

function load(): MsgLayout {
  try { return localStorage.getItem(STORE) === 'cards' ? 'cards' : 'spine'; } catch { return 'spine'; }
}
let layout = load();
const subs = new Set<() => void>();

export const msgLayout = () => layout;
export function setMsgLayout(next: MsgLayout): void {
  layout = next;
  try { localStorage.setItem(STORE, next); } catch { /* storage off */ }
  for (const f of subs) f();
}
export const useMsgLayout = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => layout);

// another window of this app (a popped-out conversation) follows the change
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => { if (e.key === STORE) { layout = load(); for (const f of subs) f(); } });
}
