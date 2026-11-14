// Client copy of the organisation structure (departments and custom profile fields).
import { useSyncExternalStore } from 'react';
import type { OrgInfo, PublicUser } from '@dex/core';

let info: OrgInfo = { departments: [], fields: [] };
const listeners = new Set<() => void>();
let wired = false;

export const useOrg = (): OrgInfo => useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => info);

function set(next: OrgInfo): void {
  info = next;
  for (const l of listeners) l();
}

export async function startOrg(): Promise<void> {
  if (!wired) {
    wired = true;
    window.dex.onHubEvent((name, data) => { if (name === 'org.updated') set(data as OrgInfo); });
  }
  try { set(await window.dex.request('org.get')); } catch { /* offline */ }
}

/** The chain of managers above someone, nearest first (stops on a loop or a missing link). */
export function managersOf(userId: string, users: Map<string, PublicUser>): PublicUser[] {
  const out: PublicUser[] = [];
  const seen = new Set([userId]);
  let cur = users.get(userId)?.profile.managerId ?? null;
  while (cur && !seen.has(cur) && out.length < 30) {
    const u = users.get(cur);
    if (!u) break;
    out.push(u);
    seen.add(cur);
    cur = u.profile.managerId;
  }
  return out;
}

export function reportsOf(userId: string, people: PublicUser[]): PublicUser[] {
  return people.filter((u) => u.profile.managerId === userId).sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** Everyone below someone, at any depth. */
export function teamSize(userId: string, people: PublicUser[]): number {
  let n = 0;
  const stack = [userId];
  const seen = new Set(stack);
  while (stack.length) {
    const id = stack.pop()!;
    for (const u of people) if (u.profile.managerId === id && !seen.has(u.id)) { seen.add(u.id); n++; stack.push(u.id); }
  }
  return n;
}

export function formatBirthday(mmdd: string | null): string | null {
  if (!mmdd) return null;
  const [m, d] = mmdd.split('-').map(Number);
  const date = new Date(2000, m - 1, d);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString([], { day: 'numeric', month: 'long' });
}

export function formatJoined(ymd: string | null): string | null {
  if (!ymd) return null;
  const d = new Date(`${ymd}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}
