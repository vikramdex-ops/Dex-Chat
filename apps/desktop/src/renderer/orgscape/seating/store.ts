// Seating on the client (docs/SEATING.md): the plan, who holds each seat and the plans still to take
// effect, kept live from seating.updated; and the editor's draft: the moves an office manager is
// putting together, saved to the hub as they go so another manager sees the same arrows.
import { useEffect, useSyncExternalStore } from 'react';
import type { Holders, MovePlanView, SeatMove, SeatingView } from '@dex/core';
import { applyMoves, effectiveMoves, mergeMoves } from '@dex/core';

let view: SeatingView | null = null;
let loaded = false;
const listeners = new Set<() => void>();
const set = (v: SeatingView | null) => { view = v; loaded = true; for (const l of listeners) l(); };
let loading: Promise<void> | null = null;
let wired = false;
let timer: ReturnType<typeof setTimeout> | null = null;

export function reloadSeating(): Promise<void> {
  loading ??= window.dex.request('seating.get').then(set).catch(() => { if (!view) set(null); }).finally(() => { loading = null; });
  return loading;
}

/** The plan as I may see it (null while loading or when the hub has none, or I am a guest). */
export function useSeating(live: boolean): { view: SeatingView | null; loaded: boolean } {
  useEffect(() => {
    if (!live) return;
    if (!wired) {
      wired = true;
      window.dex.onHubEvent((name) => {
        if (name !== 'seating.updated') return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = null; void reloadSeating(); }, 120);
      });
    }
    void reloadSeating();
  }, [live]);
  const v = useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => view);
  return { view: v, loaded };
}
export const seatingNow = () => view;

/** The draft being put together: the newest draft on the hub. */
export const currentDraft = (v: SeatingView | null): MovePlanView | null => v?.plans.filter((p) => p.status === 'draft').sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;

/** Who would hold each seat once the draft applies. */
export const draftHolders = (v: SeatingView): Holders => { const d = currentDraft(v); return d ? applyMoves(v.holders, d.moves) : v.holders; };

/** Add moves to the draft (making one if there is none). */
export async function addToDraft(add: SeatMove[], title?: string): Promise<MovePlanView | null> {
  const v = view;
  if (!v || !add.length) return null;
  const d = currentDraft(v);
  const moves = effectiveMoves(v.holders, mergeMoves(d?.moves ?? [], add));
  const res = await window.dex.request('seating.draft', d ? { id: d.id, title: title ?? d.title, moves } : { title: title ?? 'Seat moves', moves });
  await reloadSeating();
  return res;
}

/** Take one seat's line out of the draft. */
export async function dropFromDraft(seatId: string): Promise<void> {
  const d = currentDraft(view);
  if (!d) return;
  await window.dex.request('seating.draft', { id: d.id, moves: d.moves.filter((m) => m.seatId !== seatId) });
  await reloadSeating();
}

// ------------------------------------------------------------------ "walk there" from a link
let floorRequest: { seat: string; n: number } | null = null;
let floorN = 0;
/** dexconnect://floor/W-A14: open the floor plan and walk to that seat (the Directory opens it). */
export function requestFloor(seat: string): void {
  floorRequest = { seat: seat.toUpperCase().slice(0, 16), n: ++floorN };
  window.dispatchEvent(new CustomEvent('dex-floor', { detail: floorRequest }));
}
/** The request not yet followed, once. */
export function takeFloorRequest(): { seat: string; n: number } | null { const r = floorRequest; floorRequest = null; return r; }
export const peekFloorRequest = (): boolean => !!floorRequest;
