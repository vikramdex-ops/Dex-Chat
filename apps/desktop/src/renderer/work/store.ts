// Client copy of everyone's day log (day started, stepped out, where), kept live, and the
// actions that change your own day. The words here are ours: you start and close your day,
// step out and come back to your desk, and work from a place (Office, Home, Site, Client).
import { useSyncExternalStore } from 'react';
import type { WorkMode, WorkState } from '@dex/core';
import { timeOpts } from '../time.ts';

/** A state plus when we received it, so the day's clock can keep ticking locally. */
export type LiveWork = WorkState & { at: number };

let team = new Map<string, LiveWork>();
let meId = '';
const listeners = new Set<() => void>();
let wired = false;

export const useWork = (): Map<string, LiveWork> => useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => team);
const emit = () => { for (const l of listeners) l(); };

export const workOf = (userId: string): LiveWork | undefined => team.get(userId);
/** Your own id, once the session is known (used by the tile arc and the day menu). */
export const workMe = (): string => meId;

export function setWork(s: WorkState): void {
  team = new Map(team).set(s.userId, { ...s, at: Date.now() });
  emit();
}

export async function startWork(me?: string): Promise<void> {
  if (me) meId = me;
  if (!wired) {
    wired = true;
    window.dex.onHubEvent((name, data) => { if (name === 'work.updated') setWork(data as WorkState); });
  }
  if (!meId) {
    try { meId = (await window.dex.getState()).session?.me.id ?? ''; } catch { /* not signed in yet */ }
  }
  try {
    const list = await window.dex.request('work.team');
    const at = Date.now();
    team = new Map(list.map((s) => [s.userId, { ...s, at }] as const));
    emit();
  } catch { /* offline */ }
}

/** Worked time today, ticking while the day is open (not while stepped out). */
export function workedNow(s: LiveWork | undefined, now = Date.now()): number {
  if (!s) return 0;
  return s.workedTodayMs + (s.status === 'in' ? Math.max(0, now - s.at) : 0);
}

/** Places you can work from, in the order the chips show them. */
export const MODES: WorkMode[] = ['office', 'home', 'site', 'client'];
/** A place is one word on a chip: never "Working from …". */
export const MODE_SHORT: Record<WorkMode, string> = { office: 'Office', home: 'Home', site: 'Site', client: 'Client' };

/** A full working day: the tile arc closes at this mark. */
export const DAY_MS = 8 * 3600_000;

export function duration(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(m / 60);
  return h ? `${h} h ${String(m % 60).padStart(2, '0')} m` : `${m} m`;
}

export const clockTime = (t: number) => new Date(t).toLocaleTimeString([], { ...timeOpts(), hour: 'numeric', minute: '2-digit' });

/** One line for a person card or profile: "Site · since 9:12 AM", "Stepped out · since 1:05 PM". */
export function workLine(s: WorkState | undefined): string | null {
  if (!s || s.status === 'out' || !s.mode) return null;
  const since = s.since ? ` · since ${clockTime(s.since)}` : '';
  return s.status === 'break' ? `Stepped out${since}` : `${MODE_SHORT[s.mode]}${since}`;
}

/** Read a place from free text, for /startday site and the like. */
export function placeFrom(text: string): WorkMode | null {
  const t = text.trim().toLowerCase();
  if (!t) return null;
  const hit = MODES.find((m) => m.startsWith(t) || t.startsWith(m));
  if (hit) return hit;
  if (/wfh|remote|house/.test(t)) return 'home';
  if (/plant|field|refinery|yard/.test(t)) return 'site';
  if (/customer|owner/.test(t)) return 'client';
  return null;
}

// The place you last started from, so the menu and Pulse suggest it next morning.
const PLACE_KEY = 'dex-day-place';
export function lastPlace(): WorkMode {
  try {
    const v = localStorage.getItem(PLACE_KEY) as WorkMode | null;
    if (v && MODES.includes(v)) return v;
  } catch { /* storage off */ }
  return 'office';
}
function rememberPlace(m: WorkMode): void {
  try { localStorage.setItem(PLACE_KEY, m); } catch { /* storage off */ }
}

// ------------------------------------------------------------------ your own day
// Each action updates the store and returns the line to show in a toast.

export async function startDay(mode: WorkMode = lastPlace()): Promise<string> {
  setWork(await window.dex.request('work.checkIn', { mode }));
  rememberPlace(mode);
  return `Day started · ${MODE_SHORT[mode]}`;
}

export async function closeDay(): Promise<string> {
  const before = meId ? workedNow(team.get(meId)) : 0;
  const s = await window.dex.request('work.checkOut');
  setWork(s);
  return `Day closed · ${duration(Math.max(before, s.workedTodayMs))}`;
}

/** Step out, or come back to your desk if you already stepped out. */
export async function stepOut(on?: boolean): Promise<string> {
  const out = on ?? team.get(meId)?.status !== 'break';
  setWork(await window.dex.request('work.break', { on: out }));
  return out ? 'Stepped out' : 'Back at desk';
}

export async function movePlace(mode: WorkMode): Promise<string> {
  setWork(await window.dex.request('work.setMode', { mode }));
  rememberPlace(mode);
  return `Now at ${MODE_SHORT[mode]}`;
}

/** Save text as a file through the browser's download flow (the app asks where). */
export function downloadText(name: string, text: string, type = 'text/csv'): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
