// Client state for the Desk: saved messages, reminders and scheduled messages, kept live by
// hub events. Reminders that go off raise a native notification and an in-app card.
import { alertUser } from '../alerts.ts';
import { useSyncExternalStore } from 'react';
import type { Message, PublicUser, Reminder, SavedMessage, ScheduledMessage } from '@dex/core';
import { plainPreview } from '../chat/format.tsx';
import { timeOpts } from '../time.ts';

interface DeskState {
  saved: Map<string, SavedMessage>;
  reminders: Map<string, Reminder>;
  scheduled: Map<string, ScheduledMessage>;
  /** Reminders that went off and are waiting to be dealt with (shown as cards). */
  ringing: string[];
  loaded: boolean;
}

let state: DeskState = { saved: new Map(), reminders: new Map(), scheduled: new Map(), ringing: [], loaded: false };
const listeners = new Set<() => void>();
const set = (patch: Partial<DeskState>) => { state = { ...state, ...patch }; for (const l of listeners) l(); };

export function useDesk<T>(select: (s: DeskState) => T): T {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => select(state));
}
export const deskState = () => state;

let wired = false;
let directory: () => PublicUser[] = () => [];
let meId = '';

export async function startDesk(me: string, users: () => PublicUser[]): Promise<void> {
  meId = me;
  directory = users;
  if (!wired) {
    wired = true;
    window.dex.onHubEvent((name, data) => onEvent(name, data));
  }
  await refreshDesk();
  void refreshNextMeeting();
}

export async function refreshDesk(): Promise<void> {
  try {
    const [saved, reminders, scheduled] = await Promise.all([
      window.dex.request('desk.saved'),
      window.dex.request('remind.list', { includeDone: true }),
      window.dex.request('sched.list'),
    ]);
    // anything that fired while this device was off and is still open
    const ringing = reminders.filter((r) => r.userId === meId && !r.done && r.firedAt !== null && r.firedAt >= r.dueAt - 1000 && r.repeat === 'none').map((r) => r.id);
    set({
      saved: new Map(saved.map((s) => [s.message.id, s])),
      reminders: new Map(reminders.map((r) => [r.id, r])),
      scheduled: new Map(scheduled.map((s) => [s.id, s])),
      ringing: [...new Set([...state.ringing.filter((id) => ringing.includes(id)), ...ringing])],
      loaded: true,
    });
  } catch { /* offline: keep what we have */ }
}

function onEvent(name: string, data: unknown): void {
  switch (name) {
    case 'star.updated': {
      const { messageId, on } = data as { messageId: string; on: boolean };
      if (on) void refreshSaved(); else { const saved = new Map(state.saved); saved.delete(messageId); set({ saved }); }
      break;
    }
    case 'msg.updated': {
      const m = data as Message;
      const s = state.saved.get(m.id);
      if (s) {
        const saved = new Map(state.saved);
        if (m.deleted) saved.delete(m.id); else saved.set(m.id, { ...s, message: m });
        set({ saved });
      }
      break;
    }
    case 'reminder.updated': {
      const r = data as Reminder;
      const reminders = new Map(state.reminders).set(r.id, r);
      set({ reminders, ringing: r.done ? state.ringing.filter((x) => x !== r.id) : state.ringing });
      break;
    }
    case 'reminder.removed': {
      const { id } = data as { id: string };
      const reminders = new Map(state.reminders);
      reminders.delete(id);
      set({ reminders, ringing: state.ringing.filter((x) => x !== id) });
      break;
    }
    case 'reminder.due': {
      const r = data as Reminder;
      set({ reminders: new Map(state.reminders).set(r.id, r), ringing: [...state.ringing.filter((x) => x !== r.id), r.id] });
      const users = new Map(directory().map((u) => [u.id, u] as const));
      const from = r.createdBy !== meId ? ` · from ${users.get(r.createdBy)?.displayName ?? 'a colleague'}` : '';
      const about = r.message ? plainPreview(r.message.body, users).slice(0, 140) : '';
      alertUser('reminder', `Reminder${from}`, about && r.text === 'About this message' ? about : r.text, r.convId ? `dexconnect://conversation/${r.convId}` : 'dexconnect://desk');
      break;
    }
    case 'sched.updated': {
      const s = data as ScheduledMessage;
      set({ scheduled: new Map(state.scheduled).set(s.id, s) });
      if (s.status === 'failed') alertUser('reminder', 'A scheduled message was not sent', s.error ?? 'Open your Desk to see why.', 'dexconnect://desk');
      break;
    }
    case 'sched.removed': {
      const { id } = data as { id: string };
      const scheduled = new Map(state.scheduled);
      scheduled.delete(id);
      set({ scheduled });
      break;
    }
  }
}

async function refreshSaved(): Promise<void> {
  try {
    const saved = await window.dex.request('desk.saved');
    set({ saved: new Map(saved.map((s) => [s.message.id, s])) });
  } catch { /* offline */ }
}

export async function toggleSaved(m: Message): Promise<boolean> {
  const on = !state.saved.has(m.id);
  // optimistic: the star lights up at once
  const saved = new Map(state.saved);
  if (on) saved.set(m.id, { message: m, savedAt: Date.now() }); else saved.delete(m.id);
  set({ saved });
  try {
    await window.dex.request('msg.star', { messageId: m.id, on });
  } catch (err) {
    const back = new Map(state.saved);
    if (on) back.delete(m.id); else back.set(m.id, { message: m, savedAt: Date.now() });
    set({ saved: back });
    throw err;
  }
  return on;
}

export function dismissRinging(id: string): void {
  set({ ringing: state.ringing.filter((x) => x !== id) });
}

// ------------------------------------------------------------------ times
// Presets read like the office day, not a stopwatch: after lunch, before you leave, first thing.
export interface WhenPreset { id: string; label: string; at: () => number }

/** Lunch ends and the office empties at these times (hour, minute). */
const AFTER_LUNCH: [number, number] = [14, 0];
const BEFORE_LEAVING: [number, number] = [17, 15];
const FIRST_THING: [number, number] = [9, 30];

const hm = (h: number, m: number) => new Date(2000, 0, 1, h, m).toLocaleTimeString([], { ...timeOpts(), hour: 'numeric', minute: '2-digit' });

const at = (days: number, [hour, minute]: [number, number], from = new Date()) => {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
};

function nextMonday([hour, minute]: [number, number], from = new Date()): number {
  const d = new Date(from);
  d.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7));
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

// The next meeting you are in today, from the Calendar, so "Before my next meeting" can offer it.
let nextMeeting: { startAt: number; title: string } | null = null;
let meetingCheckedAt = 0;
let calWired = false;

export async function refreshNextMeeting(): Promise<void> {
  meetingCheckedAt = Date.now();
  if (!calWired) {
    calWired = true;
    window.dex.onHubEvent((name) => { if (name === 'cal.updated' || name === 'cal.removed' || name === 'cal.invited') void refreshNextMeeting(); });
  }
  try {
    const now = Date.now();
    const end = new Date(); end.setHours(23, 59, 59, 999);
    const list = await window.dex.request('cal.list', { from: now, to: Math.max(end.getTime(), now + 60_000) });
    const next = list.find((o) => !o.event.allDay && !o.event.cancelled && o.startAt > now + 10 * 60_000
      && o.event.attendees.find((a) => a.userId === meId)?.response !== 'no');
    nextMeeting = next ? { startAt: next.startAt, title: next.event.title } : null;
  } catch { /* offline: keep the last answer */ }
}

/** Ten minutes before your next meeting today, or null. */
function beforeNextMeeting(): number | null {
  if (Date.now() - meetingCheckedAt > 5 * 60_000) void refreshNextMeeting();
  if (!nextMeeting) return null;
  const t = nextMeeting.startAt - 10 * 60_000;
  const end = new Date(); end.setHours(23, 59, 59, 999);
  return t > Date.now() + 60_000 && t <= end.getTime() ? t : null;
}

export function whenPresets(_kind: 'remind' | 'send'): WhenPreset[] {
  const now = new Date();
  const list: WhenPreset[] = [];
  const meeting = beforeNextMeeting();
  if (meeting) list.push({ id: 'meeting', label: `Before my next meeting · ${hm(new Date(meeting).getHours(), new Date(meeting).getMinutes())}`, at: () => meeting });
  if (at(0, AFTER_LUNCH, now) > now.getTime() + 5 * 60_000) list.push({ id: 'lunch', label: `After lunch · ${hm(...AFTER_LUNCH)}`, at: () => at(0, AFTER_LUNCH) });
  if (at(0, BEFORE_LEAVING, now) > now.getTime() + 5 * 60_000) list.push({ id: 'leave', label: `Before I leave · ${hm(...BEFORE_LEAVING)}`, at: () => at(0, BEFORE_LEAVING) });
  const tomorrow = new Date(at(1, FIRST_THING, now));
  const weekend = tomorrow.getDay() === 0 || tomorrow.getDay() === 6;
  if (!weekend) list.push({ id: 'tomorrow', label: `Tomorrow, first thing · ${hm(...FIRST_THING)}`, at: () => at(1, FIRST_THING) });
  if (tomorrow.getDay() !== 1) list.push({ id: 'monday', label: `Monday, first thing · ${hm(...FIRST_THING)}`, at: () => nextMonday(FIRST_THING) });
  return list;
}

/** Snooze choices for a reminder that went off: a short one, the rest of the day, tomorrow. */
export function snoozePresets(): WhenPreset[] {
  const now = new Date();
  const list: WhenPreset[] = [{ id: '15m', label: '15 min', at: () => Date.now() + 15 * 60_000 }];
  if (at(0, AFTER_LUNCH, now) > now.getTime() + 20 * 60_000) list.push({ id: 'lunch', label: 'After lunch', at: () => at(0, AFTER_LUNCH) });
  else if (at(0, BEFORE_LEAVING, now) > now.getTime() + 20 * 60_000) list.push({ id: 'leave', label: 'Before I leave', at: () => at(0, BEFORE_LEAVING) });
  list.push({ id: 'tomorrow', label: `Tomorrow ${hm(...FIRST_THING)}`, at: () => at(1, FIRST_THING) });
  return list;
}

export function describeWhen(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const today = new Date(now);
  const tomorrow = new Date(now); tomorrow.setDate(today.getDate() + 1);
  const time = d.toLocaleTimeString([], { ...timeOpts(), hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `Today, ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `Tomorrow, ${time}`;
  const sameYear = d.getFullYear() === today.getFullYear();
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: sameYear ? undefined : 'numeric' })}, ${time}`;
}

/** Value for <input type="datetime-local"> in local time. */
export function toLocalInput(ts: number): string {
  const d = new Date(ts - new Date(ts).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

export const REPEAT_LABEL: Record<Reminder['repeat'], string> = {
  none: 'Does not repeat', daily: 'Every day', weekdays: 'Every weekday', weekly: 'Every week', monthly: 'Every month',
};
