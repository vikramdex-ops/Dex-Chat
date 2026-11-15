// 12- or 24-hour times everywhere in the app (Preferences ▸ Appearance), or the system's choice.
import { useSyncExternalStore } from 'react';

let hour12: boolean | undefined;
const subs = new Set<() => void>();
export function setTimeFormat(f: 'system' | '12' | '24' | undefined): void {
  const next = f === '12' ? true : f === '24' ? false : undefined;
  if (next === hour12) return;
  hour12 = next;
  // screens that keep what they drew (the timeline) draw their times again
  for (const s of subs) s();
}
/** Spread into toLocaleTimeString options. */
export const timeOpts = (): { hour12?: boolean } => (hour12 === undefined ? {} : { hour12 });
/** The time format, for screens that must draw again when it changes. */
export function useTimeFormat(): string {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => (hour12 === undefined ? 'system' : hour12 ? '12' : '24'));
}
