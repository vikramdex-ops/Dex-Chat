// Calendar on the client: conference rooms, a version counter that bumps whenever a meeting
// changes (views refetch their range), invitations and "starting soon" cards.
import { calPrefs } from './tz.ts';
import { alertUser } from '../alerts.ts';
import { useSyncExternalStore } from 'react';
import type { CalEvent, Occurrence, PublicUser, Venue } from '@dex/core';
import { joinMeeting as joinById } from '../rooms/engine.ts';
import { formatTime } from '../time.ts';

interface CalState { venues: Venue[]; version: number; soon: Occurrence[] }
let state: CalState = { venues: [], version: 0, soon: [] };
const listeners = new Set<() => void>();
const set = (patch: Partial<CalState>) => { state = { ...state, ...patch }; for (const l of listeners) l(); };
export function useCal<T>(sel: (s: CalState) => T): T {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => sel(state));
}

let wired = false;
let meId = '';
let directory: () => PublicUser[] = () => [];

export async function startCalendar(me: string, users: () => PublicUser[]): Promise<void> {
  meId = me;
  directory = users;
  if (!wired) {
    wired = true;
    window.dex.onHubEvent((name, data) => {
      if (name === 'cal.updated' || name === 'cal.removed') set({ version: state.version + 1, soon: name === 'cal.updated' && (data as CalEvent).cancelled ? state.soon.filter((o) => o.event.id !== (data as CalEvent).id) : state.soon });
      if (name === 'cal.venues') set({ venues: data as Venue[] });
      if (name === 'cal.invited') {
        const ev = data as CalEvent;
        const who = directory().find((u) => u.id === ev.organizerId)?.displayName ?? 'Someone';
        alertUser('reminder', `${who} invited you`, `${ev.title} · ${describeSpan(ev.startAt, ev.endAt, ev.allDay)}`, 'dexconnect://calendar');
      }
      if (name === 'cal.reminder') {
        const o = data as Occurrence;
        set({ soon: [...state.soon.filter((x) => !(x.event.id === o.event.id && x.startAt === o.startAt)), o] });
        const mins = Math.max(0, Math.round((o.startAt - Date.now()) / 60_000));
        alertUser('reminder', mins ? `${o.event.title} starts in ${mins} min` : `${o.event.title} is starting`, describeSpan(o.startAt, o.endAt, o.event.allDay), 'dexconnect://calendar');
      }
    });
  }
  try { set({ venues: await window.dex.request('cal.venues') }); } catch { /* offline */ }
}

export function dismissSoon(o: Occurrence): void {
  set({ soon: state.soon.filter((x) => x !== o) });
}

/** Join a meeting's call: every Calendar meeting held as a call has a meeting ID; its lobby and host apply. */
export async function joinMeeting(ev: CalEvent, video = true): Promise<string> {
  const m = await window.dex.request('meet.event', { eventId: ev.id });
  await joinById(m.id, video);
  return m.id;
}

// ------------------------------------------------------------------ dates
export const DAY = 86400_000;
export const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const addDays = (t: number, n: number) => { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); };
/** The first day of the week holding t (Monday unless the person chose Sunday or Saturday). */
export const startOfWeek = (t: number, firstDay: number = calPrefs().firstDay) => { const d = new Date(startOfDay(t)); d.setDate(d.getDate() - ((d.getDay() - firstDay + 7) % 7)); return d.getTime(); };
export const hm = (t: number) => formatTime(t);

export function describeSpan(startAt: number, endAt: number, allDay: boolean): string {
  const s = new Date(startAt);
  const date = s.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  if (allDay) {
    const days = Math.round((endAt - startAt) / DAY);
    return days > 1 ? `${date} – ${new Date(endAt - 1).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}` : `${date}, all day`;
  }
  return `${date}, ${hm(startAt)} – ${hm(endAt)}`;
}
