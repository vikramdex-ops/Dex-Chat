// Client copy of everyone's working state (checked in, on a break, where), kept live.
import { useSyncExternalStore } from 'react';
import type { WorkMode, WorkState } from '@dex/core';

/** A state plus when we received it, so the day's clock can keep ticking locally. */
export type LiveWork = WorkState & { at: number };

let team = new Map<string, LiveWork>();
const listeners = new Set<() => void>();
let wired = false;

export const useWork = (): Map<string, LiveWork> => useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => team);
const emit = () => { for (const l of listeners) l(); };

export function setWork(s: WorkState): void {
  team = new Map(team).set(s.userId, { ...s, at: Date.now() });
  emit();
}

export async function startWork(): Promise<void> {
  if (!wired) {
    wired = true;
    window.dex.onHubEvent((name, data) => { if (name === 'work.updated') setWork(data as WorkState); });
  }
  try {
    const list = await window.dex.request('work.team');
    const at = Date.now();
    team = new Map(list.map((s) => [s.userId, { ...s, at }] as const));
    emit();
  } catch { /* offline */ }
}

/** Worked time today, ticking while checked in (not during a break). */
export function workedNow(s: LiveWork | undefined, now = Date.now()): number {
  if (!s) return 0;
  return s.workedTodayMs + (s.status === 'in' ? Math.max(0, now - s.at) : 0);
}

export const MODE_LABEL: Record<WorkMode, string> = { office: 'In the office', home: 'Working from home', site: 'On site', client: 'At a client' };
export const MODE_SHORT: Record<WorkMode, string> = { office: 'Office', home: 'Home', site: 'Site', client: 'Client' };
export const MODES: WorkMode[] = ['office', 'home', 'site', 'client'];

export function duration(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
}

export function workLine(s: WorkState | undefined): string | null {
  if (!s || s.status === 'out' || !s.mode) return null;
  const since = s.since ? new Date(s.since).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  return s.status === 'break' ? `On a break since ${since}` : `${MODE_LABEL[s.mode]} since ${since}`;
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
