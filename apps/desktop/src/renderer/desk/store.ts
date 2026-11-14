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
export interface WhenPreset { id: string; label: string; at: () => number }

const at = (days: number, hour: number, minute = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
};

function nextMonday(hour: number): number {
  const d = new Date();
  d.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7));
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

export function whenPresets(kind: 'remind' | 'send'): WhenPreset[] {
  const now = new Date();
  const list: WhenPreset[] = [];
  if (kind === 'remind') {
    list.push({ id: '20m', label: 'In 20 minutes', at: () => Date.now() + 20 * 60_000 });
    list.push({ id: '1h', label: 'In 1 hour', at: () => Date.now() + 3600_000 });
    list.push({ id: '3h', label: 'In 3 hours', at: () => Date.now() + 3 * 3600_000 });
  }
  if (now.getHours() < 16) list.push({ id: 'evening', label: 'This evening at 5:00 PM', at: () => at(0, 17) });
  list.push({ id: 'tomorrow', label: 'Tomorrow at 9:30 AM', at: () => at(1, 9, 30) });
  list.push({ id: 'monday', label: 'Monday at 9:30 AM', at: () => nextMonday(9) + 30 * 60_000 });
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
