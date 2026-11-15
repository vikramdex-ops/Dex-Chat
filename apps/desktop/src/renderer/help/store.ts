// The help desk as this app knows it: who is on the IT desk, your own requests, the queue (for
// IT), the support session you are in, what the technician asked for, and recent errors in this
// window (for "Send diagnostics"). The requester's consent is applied here in order: this PC first
// (the frame, the bar, the input gate in the main process), then the hub (the record and audit).
import { useSyncExternalStore } from 'react';
import type { HelpTicket, SupportSession } from '@dex/core';
import { callState, enterSpecial, leave, onRoomData, toggleScreen } from '../rooms/engine.ts';

export interface HelpState {
  staff: string[];
  mine: HelpTicket[];
  queue: HelpTicket[];
  /** The live session you are part of (as the requester or the technician). */
  session: SupportSession | null;
  /** A technician started a session for you and waits (you have not joined yet). */
  invite: SupportSession | null;
  /** The technician asked for something; the requester answers. */
  ask: { ticketId: string; kind: 'screen' | 'control' | 'diagnostics'; by: string; at: number } | null;
  /** A session ended: ask the requester how it went. */
  rate: string | null;
  /** What this PC can do (desktop only). */
  control: { available: boolean; reason: string | null };
  /** The source the requester shares (for the main process's frame and control mapping). */
  shared: { sourceId: string; scope: 'screen' | 'window' } | null;
}

let state: HelpState = { staff: [], mine: [], queue: [], session: null, invite: null, ask: null, rate: null, control: { available: false, reason: null }, shared: null };
const listeners = new Set<() => void>();
const set = (patch: Partial<HelpState>) => { state = { ...state, ...patch }; for (const l of listeners) l(); };
export const useHelp = <T,>(sel: (s: HelpState) => T): T => useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => sel(state));
export const helpNow = () => state;

// ------------------------------------------------------------------ errors in this window, for diagnostics
const errors: Array<{ at: number; message: string; source?: string }> = [];
function keepError(message: string, source?: string): void {
  errors.push({ at: Date.now(), message: message.slice(0, 400), ...(source ? { source: source.split('/').pop()?.slice(0, 120) } : {}) });
  if (errors.length > 50) errors.splice(0, errors.length - 50);
}
if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) => keepError(e.message || 'Error', e.filename));
  window.addEventListener('unhandledrejection', (e) => keepError(`Unhandled: ${(e.reason as Error)?.message ?? String(e.reason)}`));
}
export const recentErrors = () => errors.slice();

let meId = '';
let started = false;
const upsert = (list: HelpTicket[], t: HelpTicket) => [t, ...list.filter((x) => x.id !== t.id)].sort((a, b) => b.createdAt - a.createdAt);
export const isIt = (s: HelpState = state) => s.staff.includes(meId);
export const ticketById = (id: string) => state.mine.find((t) => t.id === id) ?? state.queue.find((t) => t.id === id) ?? null;

export async function startHelp(me: string): Promise<void> {
  meId = me;
  if (!started) {
    started = true;
    window.dex.onHubEvent((name, data) => {
      if (name === 'help.staff') { set({ staff: data as string[] }); void refreshQueue(); }
      else if (name === 'help.updated') {
        const t = data as HelpTicket;
        set({ mine: t.requesterId === meId ? upsert(state.mine, t) : state.mine, queue: isIt() ? upsert(state.queue, t) : state.queue });
      } else if (name === 'help.session') onSession(data as SupportSession);
      else if (name === 'help.ask') set({ ask: { ...(data as { ticketId: string; kind: 'screen' | 'control' | 'diagnostics'; by: string }), at: Date.now() } });
    });
    // the technician's input reaches this PC over the session's data channel: only the main process injects it
    onRoomData((_dev, user, data) => {
      const s = state.session;
      if (!s || !s.consent.control || user !== s.techId || meId !== s.requesterId) return;
      if ((data as { k?: unknown } | null)?.k === 'in') window.dex.assist?.input(data);
    });
    window.dex.assist?.onStop((what) => {
      if (what === 'control') void stopControl();
      else if (what === 'screen') void stopScreen();
      else void endSession();
    });
    if (window.dex.assist) void window.dex.assist.caps().then((c) => set({ control: { available: c.control, reason: c.reason } })).catch(() => {});
  }
  try {
    const [staff, mine] = await Promise.all([window.dex.request('help.staff'), window.dex.request('help.mine')]);
    set({ staff, mine });
    await refreshQueue();
  } catch { /* offline: kept as they were */ }
}

export async function refreshQueue(): Promise<void> {
  if (!isIt()) { if (state.queue.length) set({ queue: [] }); return; }
  try { set({ queue: await window.dex.request('help.queue', { status: 'all' }) }); } catch { /* offline */ }
}

const inSessionRoom = (s: SupportSession) => { const p = callState().room?.purpose; return p?.kind === 'support' && p.ticketId === s.ticketId; };

function onSession(s: SupportSession): void {
  if (s.endedAt) {
    const wasMine = state.session?.id === s.id || state.invite?.id === s.id;
    if (!wasMine) return;
    if (meId === s.requesterId) { void applyLocal(false, false); set({ rate: s.ticketId }); }
    set({ session: null, invite: null, ask: null, shared: null });
    if (inSessionRoom(s)) leave();
    return;
  }
  if (meId === s.requesterId && !inSessionRoom(s)) { set({ invite: s, session: state.session?.id === s.id ? s : state.session }); return; }
  set({ session: s, invite: state.invite?.id === s.id ? null : state.invite });
}

// ------------------------------------------------------------------ requests
export async function createRequest(input: { summary: string; detail: string; category: HelpTicket['category']; screenshot: { data: ArrayBuffer; name: string; mime: string } | null }): Promise<HelpTicket> {
  let screenshot: string | null = null;
  if (input.screenshot && window.dex.uploadFile) {
    const f = await window.dex.uploadFile(`help-${Date.now().toString(36)}`, { data: input.screenshot.data, name: input.screenshot.name, mime: input.screenshot.mime });
    screenshot = f.id;
  }
  const platform = document.documentElement.dataset.platform ?? null;
  const t = await window.dex.request('help.create', { summary: input.summary, detail: input.detail, category: input.category, screenshot, platform });
  set({ mine: upsert(state.mine, t) });
  return t;
}

// ------------------------------------------------------------------ the session
/** The technician opens a session on a ticket they took, and is first in its Room. */
export async function startSession(ticketId: string): Promise<void> {
  await enterSpecial(async () => {
    const r = await window.dex.request('help.session.start', { id: ticketId });
    set({ session: r.session });
    return r.room;
  });
}

/** The requester (or the technician coming back) joins the session's Room. */
export async function joinSession(ticketId: string): Promise<void> {
  await enterSpecial(async () => {
    const r = await window.dex.request('help.session.join', { id: ticketId, controlAvailable: state.control.available });
    set({ session: r.session, invite: null });
    return r.room;
  });
}

export async function endSession(): Promise<void> {
  const s = state.session;
  await applyLocal(false, false);
  if (s) await window.dex.request('help.session.end', { id: s.ticketId }).catch(() => {});
  if (s && inSessionRoom(s)) leave();
}

export const declineInvite = () => set({ invite: null });
export const clearAsk = () => set({ ask: null });
export const clearRate = () => set({ rate: null });

/** This PC's side of consent: the frame and bar, and the input gate. */
async function applyLocal(screen: boolean, control: boolean): Promise<{ screen: boolean; control: boolean; error: string | null }> {
  const s = state.session;
  const techName = s ? techNameOf(s.techId) : 'IT';
  if (!window.dex.assist) return { screen, control: false, error: control ? 'Remote control works from the desktop app.' : null };
  return window.dex.assist.consent({ screen, sourceId: state.shared?.sourceId ?? null, scope: state.shared?.scope ?? 'screen', control, tech: techName });
}
let techNameOf: (id: string) => string = () => 'IT';
export function setNames(f: (id: string) => string): void { techNameOf = f; }

/** Share a screen or one window with the technician (the requester chose it in the consent sheet). */
export async function shareScreen(sourceId: string, scope: 'screen' | 'window'): Promise<void> {
  const s = state.session;
  if (!s) throw new Error('The session has ended.');
  if (callState().screen) await toggleScreen();
  await toggleScreen(sourceId);
  if (!callState().screen) throw new Error('The screen could not be shared.');
  set({ shared: { sourceId, scope } });
  await applyLocal(true, false);
  try { set({ session: await window.dex.request('help.consent', { id: s.ticketId, kind: 'screen', on: true, scope }) }); } catch (e) { await stopScreen(); throw e; }
}

export async function stopScreen(): Promise<void> {
  const s = state.session;
  await applyLocal(false, false);
  if (callState().screen && callState().room?.purpose?.kind === 'support') await toggleScreen();
  set({ shared: null });
  if (s && (s.consent.screen || s.consent.control)) set({ session: await window.dex.request('help.consent', { id: s.ticketId, kind: 'screen', on: false }).catch(() => s) });
}

/** The second consent: the technician may use this PC's mouse and keyboard. */
export async function allowControl(): Promise<void> {
  const s = state.session;
  if (!s) throw new Error('The session has ended.');
  const r = await applyLocal(true, true);
  if (!r.control) throw new Error(r.error ?? 'Remote control could not start.');
  try { set({ session: await window.dex.request('help.consent', { id: s.ticketId, kind: 'control', on: true }) }); } catch (e) { await applyLocal(true, false); throw e; }
}

export async function stopControl(): Promise<void> {
  const s = state.session;
  // this PC stops first, whatever the hub says
  await applyLocal(!!state.shared, false);
  if (s?.consent.control) set({ session: await window.dex.request('help.consent', { id: s.ticketId, kind: 'control', on: false }).catch(() => s) });
}

/** The requester's screen stopped on its own (they closed the window they shared): tell everyone. */
export async function screenEnded(): Promise<void> {
  if (state.shared) await stopScreen();
}

/** Upload a file to the ticket from inside the session, with progress. */
export async function sendFile(ticketId: string, file: File, onProgress: (sent: number, total: number) => void): Promise<void> {
  if (!window.dex.uploadFile) throw new Error('Sending files works from the desktop and phone apps.');
  const id = `help-file-${Date.now().toString(36)}`;
  const off = window.dex.onUploadProgress?.((u, sent, total) => { if (u === id) onProgress(sent, total); });
  try {
    const path = window.dex.pathForFile?.(file);
    const info = await window.dex.uploadFile(id, path ? { path, name: file.name, mime: file.type || undefined } : { data: await file.arrayBuffer(), name: file.name, mime: file.type || undefined });
    await window.dex.request('help.attach', { id: ticketId, fileId: info.id, kind: 'file' });
  } finally { off?.(); }
}

/** Send the diagnostics the requester has seen, as a JSON file on the ticket. */
export async function sendDiagnostics(ticketId: string, ref: string, report: unknown): Promise<void> {
  if (!window.dex.uploadFile) throw new Error('Diagnostics are sent from the desktop app.');
  const data = new TextEncoder().encode(JSON.stringify(report, null, 2));
  const info = await window.dex.uploadFile(`diag-${Date.now().toString(36)}`, { data: data.buffer as ArrayBuffer, name: `diagnostics-${ref}-${new Date().toISOString().slice(0, 10)}.json`, mime: 'application/json' });
  await window.dex.request('help.attach', { id: ticketId, fileId: info.id, kind: 'diagnostics' });
}
