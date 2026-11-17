// Links inside the app: dexconnect:// links go to the app's own router (through the main process
// on PCs, straight to the window on phones), and screens that are not on show yet pick up what
// they were asked to open (a Calendar meeting, a Desk task, a file) once they are.
import type { FileInfo } from '@dex/core';

/** Open any link a message or card holds: our own, an office tool's, a web page. */
export function openUrl(url: string): Promise<void> {
  if (window.dex.openLink) return window.dex.openLink(url);
  if (/^dexconnect:\/\//i.test(url)) { window.dispatchEvent(new CustomEvent('dex-deeplink', { detail: url })); return Promise.resolve(); }
  if (/^https?:\/\//i.test(url)) { window.open(url, '_blank', 'noopener'); return Promise.resolve(); }
  return Promise.reject(new Error('Links for office tools open on a PC.'));
}

type Pending = { kind: 'event'; id: string } | { kind: 'task'; id: string } | { kind: 'file'; file: FileInfo };
const pending = new Map<Pending['kind'], Pending>();

/** Ask a screen to open something; it may not be on show yet, so it is kept until taken. */
export function requestOpen(p: Pending): void {
  pending.set(p.kind, p);
  window.dispatchEvent(new CustomEvent('dex-open-item', { detail: p.kind }));
}

/** A screen takes what it was asked to open (on mount, and when asked while on show). */
export function takeOpen<K extends Pending['kind']>(kind: K): Extract<Pending, { kind: K }> | null {
  const p = pending.get(kind);
  if (!p) return null;
  pending.delete(kind);
  return p as Extract<Pending, { kind: K }>;
}

/** Run `on` for anything a screen of this kind is asked to open, now and later. */
export function onOpenRequest<K extends Pending['kind']>(kind: K, on: (p: Extract<Pending, { kind: K }>) => void): () => void {
  const first = takeOpen(kind);
  if (first) on(first);
  const handler = (e: Event) => { if ((e as CustomEvent).detail !== kind) return; const p = takeOpen(kind); if (p) on(p); };
  window.addEventListener('dex-open-item', handler);
  return () => window.removeEventListener('dex-open-item', handler);
}
