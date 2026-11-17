// Lounges as this app knows them: every lounge in the Spaces you are in (who is in each, who is
// speaking), where colleagues are ("In Piping desk"), and joining or leaving one with a soft sound.
import { useSyncExternalStore } from 'react';
import type { Lounge } from '@dex/core';
import { callState, enterSpecial, leave } from '../rooms/engine.ts';
import { playSound } from '../sounds.ts';
import { setPresenceNote } from '../ui.tsx';

interface LoungeState {
  lounges: Map<string, Lounge>;
  /** Who is in a lounge: its id and name (null for a Space you are not in). */
  where: Map<string, { loungeId: string; name: string | null }>;
  ready: boolean;
}

let state: LoungeState = { lounges: new Map(), where: new Map(), ready: false };
const listeners = new Set<() => void>();
const set = (patch: Partial<LoungeState>) => { state = { ...state, ...patch }; for (const l of listeners) l(); };
export const useLounges = <T,>(sel: (s: LoungeState) => T): T => useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => sel(state));
export const loungesNow = () => state;

/** The lounge this PC is in now (from the Room it is in). */
export function myLounge(): Lounge | null {
  const p = callState().room?.purpose;
  return p?.kind === 'lounge' ? state.lounges.get(p.loungeId) ?? null : null;
}

/** A soft sound for coming and going (never a ring). */
const soft = (arrive: boolean) => playSound(arrive ? 'tick' : 'drop', 0.35, true);

let started = false;
let meId = '';
export async function startLounges(me: string): Promise<void> {
  meId = me;
  setPresenceNote((id) => { const w = state.where.get(id); return w ? (w.name ? `in ${w.name}` : 'in a lounge') : null; });
  if (!started) {
    started = true;
    window.dex.onHubEvent((name, data) => {
      if (name === 'lounge.updated') {
        const l = data as Lounge;
        const before = state.lounges.get(l.id);
        const lounges = new Map(state.lounges);
        lounges.set(l.id, l);
        // people coming into or leaving the lounge I am in: a soft sound
        const mine = callState().room?.purpose;
        if (mine?.kind === 'lounge' && mine.loungeId === l.id && before) {
          const was = new Set(before.people.map((p) => p.deviceId));
          const now = new Set(l.people.map((p) => p.deviceId));
          const came = l.people.some((p) => !was.has(p.deviceId) && p.userId !== meId);
          const went = before.people.some((p) => !now.has(p.deviceId) && p.userId !== meId);
          if (came) soft(true); else if (went) soft(false);
        }
        set({ lounges });
      } else if (name === 'lounge.where') {
        const d = data as { userId: string; loungeId: string | null; name: string | null };
        const where = new Map(state.where);
        if (d.loungeId) where.set(d.userId, { loungeId: d.loungeId, name: d.name }); else where.delete(d.userId);
        set({ where });
      } else if (name === 'conv.removed') {
        const convId = (data as { convId: string }).convId;
        set({ lounges: new Map([...state.lounges].filter(([, l]) => l.convId !== convId)) });
      }
    });
  }
  await refreshLounges();
}

export async function refreshLounges(): Promise<void> {
  try {
    const [list, where] = await Promise.all([window.dex.request('lounge.list'), window.dex.request('lounge.presence')]);
    set({ lounges: new Map(list.map((l) => [l.id, l] as const)), where: new Map(where.map((w) => [w.userId, { loungeId: w.loungeId, name: w.name }] as const)), ready: true });
  } catch { set({ ready: true }); }
}

/** Come into a lounge: audio only, nobody is rung. */
export async function joinLounge(id: string): Promise<void> {
  const cur = callState().room;
  if (cur?.purpose?.kind === 'lounge' && cur.purpose.loungeId === id) return;
  if (cur?.purpose?.kind === 'lounge') leave();
  else if (cur) throw new Error('You are in another Room. Leave it first.');
  await enterSpecial(() => window.dex.request('lounge.join', { id }));
  soft(true);
}

export function leaveLounge(): void {
  if (callState().room?.purpose?.kind !== 'lounge') return;
  leave();
  soft(false);
}

export const createLounge = (convId: string, name: string) => window.dex.request('lounge.create', { convId, name });
export const renameLounge = (id: string, name: string) => window.dex.request('lounge.rename', { id, name });
export const archiveLounge = (id: string, archived: boolean) => window.dex.request('lounge.archive', { id, archived });
