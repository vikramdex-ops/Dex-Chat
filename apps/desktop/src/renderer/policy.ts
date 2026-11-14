// The office policy (set by an administrator), kept live for the UI: hide Edit once a message
// is past the edit window, refuse oversized files before uploading, offer call recording.
import { useSyncExternalStore } from 'react';
import type { OfficePolicy } from '@dex/core';

let policy: OfficePolicy = { editWindowMinutes: null, maxUploadMb: 1024, peerFallback: true, allowRecording: true };
const subs = new Set<() => void>();
const set = (p: OfficePolicy) => { policy = p; for (const f of subs) f(); };
let started = false;

export function startPolicy(): void {
  if (!started) {
    started = true;
    window.dex.onHubEvent((name, data) => { if (name === 'policy.updated') set(data as OfficePolicy); });
  }
  void window.dex.request('policy.get').then(set).catch(() => {});
}
export const policyNow = () => policy;
export function usePolicy(): OfficePolicy {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => policy);
}
/** Can the author still edit or delete this message? */
export const withinEditWindow = (createdAt: number, p = policy) => p.editWindowMinutes === null || Date.now() - createdAt <= p.editWindowMinutes * 60_000;
