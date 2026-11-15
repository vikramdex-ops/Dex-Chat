// Who is in the office and who this is, for parts of the app that are mounted deep inside others
// (a whiteboard's pointers) and cannot be handed them. Set by the app frame on every change.
import { useSyncExternalStore } from 'react';
import type { PublicUser } from '@dex/core';

let state: { users: Map<string, PublicUser>; meId: string } = { users: new Map(), meId: '' };
const listeners = new Set<() => void>();

export function setPeople(users: Map<string, PublicUser>, meId: string): void {
  if (users === state.users && meId === state.meId) return;
  state = { users, meId };
  for (const l of listeners) l();
}
export const peopleNow = () => state;
export const usePeople = () => useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => state);
