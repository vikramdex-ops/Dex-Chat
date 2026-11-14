// Office times used by status and Hush durations: lunch at 1:30 PM, the office closes at 5:30 PM,
// the week starts Monday at 9:30 AM.
import { timeOpts } from '../time.ts';

export const LUNCH = [13, 30] as const;
export const CLOSE = [17, 30] as const;

export function todayAt(h: number, m: number, now = new Date()): number {
  const d = new Date(now); d.setHours(h, m, 0, 0); return d.getTime();
}

export function endOfToday(now = new Date()): number {
  const d = new Date(now); d.setHours(23, 59, 0, 0); return d.getTime();
}

/** Next Monday at 9:30 (a week ahead on a Monday). */
export function nextMonday(now = new Date()): number {
  const d = new Date(now);
  d.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7));
  d.setHours(9, 30, 0, 0);
  return d.getTime();
}

/** "1:30 PM" or "13:30", following Preferences. */
export const hm = (ts: number): string => new Date(ts).toLocaleTimeString([], { ...timeOpts(), hour: 'numeric', minute: '2-digit' });
