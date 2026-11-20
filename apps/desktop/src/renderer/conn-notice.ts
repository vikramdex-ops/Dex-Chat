// When to say the hub connection is down. Reconnecting is routine (a phone brought back from the
// background, a laptop waking, the office network switching to the gateway) and usually takes well
// under a second; saying "Connecting…" every time makes the app feel broken. So the app keeps
// showing what it last had and only says something once the hub has been away for a while.
import { useEffect, useRef, useState } from 'react';
import type { Phase } from '../shared/bridge.ts';

/** How long a reconnect may take before the app says so. */
export const NOTICE_DELAY_MS = 3000;

const DOWN: ReadonlySet<Phase> = new Set(['connecting', 'offline']);

/**
 * Tracks since when the hub has been away. `downSince` is null while connected (or in a phase that
 * is not a reconnect, such as waiting for approval); feed it every phase change.
 */
export function nextDownSince(prev: number | null, phase: Phase, now: number): number | null {
  if (!DOWN.has(phase)) return null;
  return prev ?? now;
}

/** Should the app say the hub is away now? */
export function noticeDue(phase: Phase, downSince: number | null, now: number, delayMs = NOTICE_DELAY_MS): boolean {
  return DOWN.has(phase) && downSince !== null && now - downSince >= delayMs;
}

/** Milliseconds until the notice becomes due (to wake up then), or null when it never will. */
export function noticeIn(phase: Phase, downSince: number | null, now: number, delayMs = NOTICE_DELAY_MS): number | null {
  if (!DOWN.has(phase) || downSince === null) return null;
  return Math.max(0, downSince + delayMs - now);
}

/** True once the hub has been away for NOTICE_DELAY_MS; false again as soon as it is back. */
export function useConnNotice(phase: Phase | undefined, delayMs = NOTICE_DELAY_MS): boolean {
  const since = useRef<number | null>(null);
  since.current = nextDownSince(since.current, phase ?? 'connecting', Date.now());
  const [, wake] = useState(0);
  const wait = noticeIn(phase ?? 'connecting', since.current, Date.now(), delayMs);
  useEffect(() => {
    if (wait === null || wait === 0) return;
    const t = setTimeout(() => wake((n) => n + 1), wait + 20);
    return () => clearTimeout(t);
  }, [phase, wait === null, wait === 0]); // eslint-disable-line react-hooks/exhaustive-deps
  return noticeDue(phase ?? 'connecting', since.current, Date.now(), delayMs);
}
