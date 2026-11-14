// Calendar on the client: conference rooms, a version counter that bumps whenever a meeting
// changes (views refetch their range), invitations and "starting soon" cards.
import { useSyncExternalStore } from 'react';
import type { CalEvent, Occurrence, PublicUser, Venue } from '@dex/core';
import { addConversation } from '../chat/store.ts';
import { callState, joinRoom, startCall } from '../rooms/engine.ts';

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
        window.dex.notify(`${who} invited you`, `${ev.title} · ${describeSpan(ev.startAt, ev.endAt, ev.allDay)}`, 'dexconnect://calendar');
      }
      if (name === 'cal.reminder') {
        const o = data as Occurrence;
        set({ soon: [...state.soon.filter((x) => !(x.event.id === o.event.id && x.startAt === o.startAt)), o] });
        const mins = Math.max(0, Math.round((o.startAt - Date.now()) / 60_000));
        window.dex.notify(mins ? `${o.event.title} starts in ${mins} min` : `${o.event.title} is starting`, describeSpan(o.startAt, o.endAt, o.event.allDay), 'dexconnect://calendar');
      }
    });
  }
  try { set({ venues: await window.dex.request('cal.venues') }); } catch { /* offline */ }
}

export function dismissSoon(o: Occurrence): void {
  set({ soon: state.soon.filter((x) => x !== o) });
}

/** Join a meeting's call: its conversation's Room, or a Direct group with the attendees. */
export async function joinMeeting(ev: CalEvent, video = true): Promise<string> {
  let convId = ev.convId;
  if (!convId) {
    const others = ev.attendees.map((a) => a.userId).filter((u) => u !== meId);
    if (!others.length) throw new Error('Invite someone to hold a call.');
    const c = await window.dex.request('conv.create', { kind: 'direct', members: others });
    addConversation(c);
    convId = c.id;
  }
  const active = callState().active.get(convId);
  if (active && active.participants.length) await joinRoom(active.id, video);
  else await startCall(convId, video);
  return convId;
}

// ------------------------------------------------------------------ dates
export const DAY = 86400_000;
export const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const addDays = (t: number, n: number) => { const d = new Date(t); d.setDate(d.getDate() + n); return d.getTime(); };
export const startOfWeek = (t: number) => { const d = new Date(startOfDay(t)); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); };
export const hm = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function describeSpan(startAt: number, endAt: number, allDay: boolean): string {
  const s = new Date(startAt);
  const date = s.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  if (allDay) {
    const days = Math.round((endAt - startAt) / DAY);
    return days > 1 ? `${date} – ${new Date(endAt - 1).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}` : `${date}, all day`;
  }
  return `${date}, ${hm(startAt)} – ${hm(endAt)}`;
}
