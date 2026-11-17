// The notice board on the client (docs/ANNOUNCEMENTS.md): the register as I may see it, kept live
// from notices.changed; one notification when a notice is issued for me; which notices arrived
// during this session (their rows plot in once); and opening a notice or the composer from
// anywhere (Pulse, search, a link, Nib's line).
import { useSyncExternalStore } from 'react';
import type { NoticeList, NoticeSummary } from '@dex/core';
import { alertUser } from '../alerts.ts';
import { tr } from '../i18n/index.ts';

interface NoticeState {
  list: NoticeList | null;
  /** Arrived while the app was open: their register rows plot in once. */
  fresh: ReadonlySet<string>;
}
let state: NoticeState = { list: null, fresh: new Set() };
const listeners = new Set<() => void>();
const set = (patch: Partial<NoticeState>) => { state = { ...state, ...patch }; for (const l of listeners) l(); };
export function useNotices<T>(sel: (s: NoticeState) => T): T {
  return useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => sel(state));
}
export const noticesNow = () => state;

let wired = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let loading: Promise<void> | null = null;

export function reloadNotices(): Promise<void> {
  loading ??= window.dex.request('notices.list').then((list) => set({ list })).catch(() => { /* offline: keep what we have */ }).finally(() => { loading = null; });
  return loading;
}
const soon = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => { timer = null; void reloadNotices(); }, 150); };

/** Load the register on sign-in and after reconnecting, and follow it while the app runs. */
export function startNotices(): void {
  if (!wired) {
    wired = true;
    window.dex.onHubEvent((name, data) => {
      if (name !== 'notices.changed') return;
      const d = data as { id: string; issued?: NoticeSummary };
      if (d.issued) {
        set({ fresh: new Set([...state.fresh, d.id]) });
        const n = d.issued;
        const what = n.urgent ? 'Urgent notice' : n.ackRequired ? 'A notice for you to acknowledge' : 'A new notice';
        alertUser(n.urgent || n.ackRequired ? 'personal' : 'message', `${tr(what)} · ${n.deskName}`, `${n.number ?? ''} ${n.title}`.trim(), `dexconnect://notices/${n.id}`);
      }
      soon();
    });
  }
  void reloadNotices();
}

// ---------------------------------------------------------------- opening, from anywhere
export type NoticeOpen = { kind: 'read'; id: string } | { kind: 'compose'; id?: string; deskId?: string };
export function openNotice(id: string): void { window.dispatchEvent(new CustomEvent<NoticeOpen>('dex-notice', { detail: { kind: 'read', id } })); }
export function openComposer(o: { id?: string; deskId?: string } = {}): void { window.dispatchEvent(new CustomEvent<NoticeOpen>('dex-notice', { detail: { kind: 'compose', ...o } })); }

/** Notices waiting for my acknowledgement, oldest first. */
export const waitingForMe = (l: NoticeList | null): NoticeSummary[] => (l?.notices ?? []).filter((n) => n.needsAck).sort((a, b) => (a.issuedAt ?? 0) - (b.issuedAt ?? 0));
