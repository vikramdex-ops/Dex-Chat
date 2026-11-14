// What the Meet lens should open: a recording (from a dexconnect://recording/… link, or after a
// recording was kept on the hub) or a meeting's report. Small and always loaded, so the app can
// ask for it before the lens itself has loaded.
import { useSyncExternalStore } from 'react';

export type MeetTarget = { kind: 'recording'; id?: string; token?: string } | { kind: 'report'; roomId: string };

let target: MeetTarget | null = null;
const subs = new Set<() => void>();
const emit = () => { for (const f of subs) f(); };

/** Open a recording in the player (switches to the Meet lens through the app's deep-link handler). */
export function openRecording(r: { id?: string; token?: string }): void {
  target = { kind: 'recording', ...r };
  emit();
  window.dispatchEvent(new CustomEvent('dex-open-lens', { detail: 'meet' }));
}

export function openReport(roomId: string): void {
  target = { kind: 'report', roomId };
  emit();
}

export const useMeetTarget = () => useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => target);
export const clearMeetTarget = () => { target = null; emit(); };
