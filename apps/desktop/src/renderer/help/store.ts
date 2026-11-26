// The help desk as this app knows it: who is on the IT desk, your own requests, the queue (for
// IT), the support session you are in, what the technician asked for, and recent errors in this
// window (for "Send diagnostics"). The requester's consent is applied here in order: this PC first
// (the frame, the bar, the input gate in the main process), then the hub (the record and audit).
import { useSyncExternalStore } from 'react';
import { ticketRef } from '@dex/core';
import type { HelpTicket, OfficePolicy, SupportSession } from '@dex/core';
import { CLIP_MAX, DROP_MAX_FILES, decodeClip, safeRelativePath } from '@dex/core/assist';
import { callState, enterSpecial, leave, onRoomData, selfDevice, sendRoomData, toggleScreen, watchCall } from '../rooms/engine.ts';
import { policyNow } from '../policy.ts';

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
  /** Files the other side dropped into the session, saved on this PC (policy assistFiles). */
  dropped: { ref: string; count: number; last: string } | null;
}

let state: HelpState = { staff: [], mine: [], queue: [], session: null, invite: null, ask: null, rate: null, control: { available: false, reason: null }, shared: null, dropped: null };
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
      else if (name === 'help.dropped') {
        // files the other person dropped: saved by this person's device that is in the session, one at a time
        const d = data as { sessionId: string; files: Array<{ fileId: string; path: string }> };
        const s = state.session;
        if (s && s.id === d.sessionId && onMyDevice(s) && policyNow().assistFiles === true) for (const f of d.files ?? []) saves = saves.then(() => saveDropped(s, f.fileId, f.path));
      }
    });
    // the technician's input reaches this PC over the session's data channel: only the main process injects it;
    // clipboard text and dropped files come from the other person in the session, when the office allows them
    onRoomData((dev, user, data) => {
      const s = state.session;
      if (!s || callState().room?.purpose?.kind !== 'support' || !onMyDevice(s)) return;
      const peer = meId === s.requesterId ? s.techId : meId === s.techId ? s.requesterId : null;
      if (!peer || user !== peer) return;
      const k = (data as { k?: unknown } | null)?.k;
      if (k === 'in') { if (s.consent.control && meId === s.requesterId) window.dex.assist?.input(data, dev); return; }
      if (k === 'clip') { const text = decodeClip(data); if (text !== null && s.consent.control && policyNow().assistClipboard === true) void clipIn(text); }
    });
    setInterval(() => void clipTick(), 1000);
    window.dex.assist?.onStop((what, context) => {
      // a meeting's "Give control" has its own (meet/control-store.ts)
      if (context === 'meeting' || !state.session) return;
      if (what === 'control') void stopControl();
      else if (what === 'screen') void stopScreen();
      else void endSession();
    });
    caps = window.dex.assist ? window.dex.assist.caps().then((c) => set({ control: { available: c.control, reason: c.reason } })).catch(() => {}) : Promise.resolve();
    // both people coming into the Room is when an automatic share may start
    watchCall(() => void maybeShare());
  }
  try {
    const [staff, mine] = await Promise.all([window.dex.request('help.staff'), window.dex.request('help.mine')]);
    set({ staff, mine });
    await refreshQueue();
  } catch { /* offline: kept as they were */ }
  // this app says whether it can be controlled: unattended access only ever chooses a PC that can
  await caps;
  if (window.dex.assist) void window.dex.request('help.device', { control: state.control.available }).catch(() => {});
  // back online (or the app started): rejoin a session that is waiting for us
  try {
    const policy = await window.dex.request('policy.get');
    for (const s of await window.dex.request('help.live')) {
      if (state.session?.id === s.id) { takeBack(s); set({ session: s }); }
      if (!inSessionRoom(s) && mayRejoin(s)) void rejoin(s, policy);
    }
  } catch { /* offline, or an older hub */ }
}
let caps: Promise<void> = Promise.resolve();

export async function refreshQueue(): Promise<void> {
  if (!isIt()) { if (state.queue.length) set({ queue: [] }); return; }
  try { set({ queue: await window.dex.request('help.queue', { status: 'all' }) }); } catch { /* offline */ }
}

const inSessionRoom = (s: SupportSession) => { const p = callState().room?.purpose; return p?.kind === 'support' && p.ticketId === s.ticketId; };
/** Is this the device of mine that is in the session (or nobody's device is set yet)? Others never join or act on it. */
/**
 * May this device join a session by itself? Only an unattended one the hub chose this device for
 * (the requester's), or a paused one this very device was already in. Never an attended session
 * the person has not joined, and never on another device of theirs.
 */
function mayRejoin(s: SupportSession): boolean {
  const me = selfDevice();
  if (meId === s.requesterId) return (s.unattended && s.requesterDevice === me) || (s.pausedAt !== null && s.requesterDevice === me);
  if (meId === s.techId) return s.pausedAt !== null && s.techDevice === me;
  return false;
}

function onMyDevice(s: SupportSession): boolean {
  const mine = meId === s.requesterId ? s.requesterDevice : meId === s.techId ? s.techDevice : null;
  return !mine || mine === selfDevice();
}
/** Saving dropped files one after another (two of the same name never race for it). */
let saves: Promise<void> = Promise.resolve();

function onSession(s: SupportSession): void {
  if (s.endedAt) {
    if (resume?.sessionId === s.id) resume = null;
    // an invite that ends (another session, not joined) only goes away: the session the person is
    // in keeps its frame, bar, stop keys and dock
    if (state.invite?.id === s.id && state.session?.id !== s.id) { set({ invite: null }); return; }
    if (state.session?.id !== s.id) return;
    if (meId === s.requesterId) { void applyLocal(false, false); set({ rate: s.ticketId }); }
    set({ session: null, invite: state.invite?.id === s.id ? null : state.invite, ask: null, shared: null, dropped: null });
    if (inSessionRoom(s)) leave();
    return;
  }
  // the hub took something back (the connection dropped, an administrator turned unattended access
  // off, a stop from another path): this PC stops it too, at once
  takeBack(s);
  if (meId === s.requesterId && !inSessionRoom(s)) {
    set({ invite: s, session: state.session?.id === s.id ? s : state.session });
    if (mayRejoin(s)) void rejoin(s, policyNow());
    return;
  }
  set({ session: s, invite: state.invite?.id === s.id ? null : state.invite });
  if (s.pausedAt !== null && !inSessionRoom(s) && mayRejoin(s)) void rejoin(s, policyNow());
  else void maybeShare();
  void syncPrivacy();
}

/**
 * The privacy screen follows the session: on while IT asked for it and the whole screen is shared,
 * off otherwise. If this PC cannot show it, the hub is told (IT then sees that the person sees all).
 */
let privacyShown = false;
async function syncPrivacy(): Promise<void> {
  const s = state.session;
  const want = !!s && meId === s.requesterId && s.privacy && s.consent.screen && s.consent.scope === 'screen' && !!state.shared && onMyDevice(s);
  if (!window.dex.assist || want === privacyShown) return;
  privacyShown = want;
  const r = await window.dex.assist.privacy({ on: want, peer: s ? techNameOf(s.techId) : 'IT' }).catch((e: Error) => ({ ok: false, error: e.message }));
  if (want && !r.ok) {
    privacyShown = false;
    if (s) void window.dex.request('help.privacy', { id: s.ticketId, on: false, unavailable: true }).catch(() => {});
  }
}

/**
 * What the hub took back (the connection dropped, an administrator turned unattended access off, a
 * stop from another path), this PC stops too, at once. A pause keeps what to share again after it.
 */
function takeBack(s: SupportSession): void {
  const before = state.session?.id === s.id ? state.session.consent : null;
  if (meId !== s.requesterId || !before) return;
  const paused = s.pausedAt !== null;
  if (before.control && !s.consent.control) { if (resume && !paused) resume = { ...resume, control: false }; void applyLocal(!!state.shared && s.consent.screen, false); }
  if (state.shared && !s.consent.screen && (before.screen || paused)) { if (!paused) resume = null; void stopScreenHere(); }
}

/** This PC stops sharing (the frame, the bar, the capture) without telling the hub again. */
async function stopScreenHere(): Promise<void> {
  await applyLocal(false, false);
  privacyShown = false;
  if (callState().screen && callState().room?.purpose?.kind === 'support') await toggleScreen();
  set({ shared: null });
}

// ------------------------------------------------------------------ unattended access and reconnecting
/** What the requester shared before the connection dropped, to share again when it is back (same app run only). */
let resume: { sessionId: string; sourceId: string; scope: 'screen' | 'window'; control: boolean } | null = null;
let joining: string | null = null;
let sharing = false;
/** Counts the person's own stops: one during an automatic share cancels what is left of it. */
let stops = 0;

/**
 * Join a session without a click (only join: what is shared is decided by maybeShare once both
 * people are in the Room): an unattended one (IT connected without asking, policy
 * assistUnattended) or one that waits for its dropped connection (policy assistReconnect).
 * Unattended: this PC comes in with no microphone at all.
 */
async function rejoin(s: SupportSession, policy: OfficePolicy): Promise<void> {
  const requester = meId === s.requesterId;
  if (!mayRejoin(s)) return;
  const unattended = requester && s.unattended && !s.stopped && policy.assistUnattended === true && !!window.dex.assist;
  if (!unattended && policy.assistReconnect !== true) return;
  if (joining === s.id || inSessionRoom(s)) return;
  // someone in another Room or meeting is not pulled out of it: the invite card stays
  if (callState().room) return;
  joining = s.id;
  try {
    await caps;
    // never a live microphone the person did not turn on: every join made by itself has none
    await joinSession(s.ticketId, { noMic: true });
  } catch (e) {
    console.warn('support session: could not join by itself', (e as Error).message);
  } finally {
    joining = null;
  }
  void maybeShare();
}

/**
 * The requester's PC shares by itself only when: the session is running (not waiting for anyone),
 * both people are in the Room, the person has not stopped anything in it, and either it is
 * unattended (with the policy on, checked again before each step) or it is coming back from a
 * dropped connection in this run of the app (what was shared before, shared again).
 */
async function maybeShare(): Promise<void> {
  const s = state.session;
  if (!s || meId !== s.requesterId || sharing || s.pausedAt !== null || s.stopped || !onMyDevice(s) || !inSessionRoom(s)) return;
  if (!callState().room?.participants.some((p) => p.userId === s.techId)) return;
  const auto = () => { const x = state.session; return !!x && x.id === s.id && x.unattended && !x.stopped && x.pausedAt === null && policyNow().assistUnattended === true; };
  const back = resume?.sessionId === s.id ? resume : null;
  if (!(auto() && window.dex.assist) && !back) return;
  if (state.shared) {
    // already sharing: only control may be missing
    if (!(auto() && state.control.available && !s.consent.control && s.consent.scope === 'screen')) return;
  }
  sharing = true;
  const at = stops;
  const stopped = () => stops !== at || state.session?.id !== s.id || !!state.session?.stopped || state.session?.pausedAt !== null;
  try {
    if (auto()) {
      if (!state.shared) {
        const source = await window.dex.assist!.primaryScreen();
        if (!source || stopped() || !auto()) return;
        await shareScreen(source, 'screen');
        if (stopped() || !auto()) { await stopScreen(); return; }
      }
      if (state.control.available && !state.session?.consent.control) {
        if (stopped() || !auto()) return;
        await allowControl();
        if (stopped() || !auto()) { await stopControl(); return; }
      }
      window.dex.notify(`${techNameOf(s.techId)} from IT connected to this PC`, 'Unattended access: they see your screen and can use your mouse and keyboard. Press Shift+Esc to stop control.', 'dexconnect://help');
    } else if (back && !state.shared) {
      await shareScreen(back.sourceId, back.scope);
      if (stopped()) { await stopScreen(); return; }
      if (back.control && state.control.available && back.scope === 'screen') await allowControl();
      if (stopped()) { await stopControl(); return; }
      window.dex.notify(`Reconnected with ${techNameOf(s.techId)}`, back.control ? 'Your screen is shared again and IT has control again. Press Shift+Esc to stop control.' : 'Your screen is shared again.', 'dexconnect://help');
    }
  } catch (e) {
    console.warn('support session: could not share by itself', (e as Error).message);
  } finally {
    sharing = false;
  }
}

// ------------------------------------------------------------------ clipboard (policy assistClipboard)
/** The last text seen on this PC's clipboard and the last one received, so nothing echoes back. */
let clipSeen: string | null = null;
let clipGot: string | null = null;
/** Bumped by every text received: a read that began before it is stale and never sent. */
let clipGen = 0;
let clipBusy = false;

async function clipTick(): Promise<void> {
  const s = state.session;
  const on = !!s && s.consent.control && onMyDevice(s) && policyNow().assistClipboard === true && !!window.dex.assist && callState().room?.purpose?.kind === 'support';
  if (!on) { clipSeen = null; clipGot = null; return; }
  if (clipBusy) return;
  clipBusy = true;
  const gen = clipGen;
  try {
    const text = await window.dex.assist!.clipboard().catch(() => null);
    if (text === null || gen !== clipGen) return;
    // what was on the clipboard before control began is not sent; only what is copied from now on
    if (clipSeen === null) { clipSeen = text; return; }
    if (text === clipSeen) return;
    clipSeen = text;
    if (!text || text === clipGot) return;
    // the message must fit through the hub too (a relayed Room): longer text is not sent, and the person is told
    if (JSON.stringify({ k: 'clip', text }).length > CLIP_MAX) { window.dex.notify('Clipboard not shared', 'That text is too long for the support session. Send it as a file instead.'); return; }
    sendRoomData({ k: 'clip', text });
  } finally { clipBusy = false; }
}

async function clipIn(text: string): Promise<void> {
  clipGen++;
  clipGot = text;
  clipSeen = text;
  await window.dex.assist?.clipboard(text).catch(() => {});
}

// ------------------------------------------------------------------ files and folders dropped in (policy assistFiles)
async function saveDropped(s: SupportSession, fileId: string, rel: string): Promise<void> {
  const t = ticketById(s.ticketId);
  if (!t || !window.dex.assist) return;
  const ref = ticketRef(t.number);
  try {
    await window.dex.assist.saveDropped(fileId, ref, rel);
    const d = state.dropped?.ref === ref ? state.dropped : null;
    set({ dropped: { ref, count: (d?.count ?? 0) + 1, last: rel.split('/').pop() ?? rel } });
  } catch (e) { console.warn('support session: a dropped file was not saved', (e as Error).message); }
}

/** One file from a drop, with its place in the dropped folder. */
export interface DropItem { file: File; path: string }

/** The files of a drop (folders walked, up to DROP_MAX_FILES), with their paths inside the folders dropped. */
export async function dropItems(dt: DataTransfer): Promise<{ items: DropItem[]; folder: string | null; skipped: number }> {
  const items: DropItem[] = [];
  let skipped = 0;
  let folder: string | null = null;
  const fileOf = (e: FileSystemFileEntry) => new Promise<File>((res, rej) => e.file(res, rej));
  const readAll = async (r: FileSystemDirectoryReader) => {
    const out: FileSystemEntry[] = [];
    for (;;) { const batch = await new Promise<FileSystemEntry[]>((res, rej) => r.readEntries(res, rej)); if (!batch.length) return out; out.push(...batch); }
  };
  const walk = async (e: FileSystemEntry, at: string): Promise<void> => {
    if (items.length >= DROP_MAX_FILES) { skipped++; return; }
    if (e.isFile) { items.push({ file: await fileOf(e as FileSystemFileEntry), path: at ? `${at}/${e.name}` : e.name }); return; }
    if (e.isDirectory) for (const c of await readAll((e as FileSystemDirectoryEntry).createReader())) await walk(c, at ? `${at}/${e.name}` : e.name);
  };
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.() ?? null);
  if (entries.some((e) => e)) {
    for (const e of entries) if (e) { if (e.isDirectory && !folder) folder = e.name; await walk(e, ''); }
  } else {
    for (const f of [...dt.files]) { if (items.length >= DROP_MAX_FILES) skipped++; else items.push({ file: f, path: f.name }); }
  }
  return { items: items.filter((i) => safeRelativePath(i.path)), folder, skipped };
}

/** Send dropped files to the other side of the session: through the hub's file store, saved at their end. */
export async function sendDropped(ticketId: string, drop: { items: DropItem[]; folder: string | null }, onProgress: (done: number, total: number, name: string) => void): Promise<number> {
  if (!window.dex.uploadFile) throw new Error('Dropping files works from the desktop app.');
  if (policyNow().assistFiles !== true) throw new Error('Dropping files into a session is off for this office. Use Send a file.');
  const total = drop.items.length;
  const files: Array<{ fileId: string; path: string }> = [];
  // every file uploaded first, then the drop handed over in one go: all of it or none, one line on the ticket
  for (const it of drop.items) {
    onProgress(files.length, total, it.path);
    const path = window.dex.pathForFile?.(it.file);
    const info = await window.dex.uploadFile(`help-drop-${Date.now().toString(36)}-${files.length}`, path ? { path, name: it.file.name, mime: it.file.type || undefined } : { data: await it.file.arrayBuffer(), name: it.file.name, mime: it.file.type || undefined });
    files.push({ fileId: info.id, path: it.path });
  }
  await window.dex.request('help.drop', { id: ticketId, files, folder: drop.folder });
  onProgress(total, total, '');
  return total;
}

export const clearDropped = () => set({ dropped: null });

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

/** IT connects to a person's PC without them accepting (policy assistUnattended): on a ticket, or a new one for them. */
export async function connectNow(target: { id: string } | { userId: string }, privacy = false): Promise<void> {
  await enterSpecial(async () => {
    const r = await window.dex.request('help.connect', { ...target, privacy });
    set({ session: r.session });
    return r.room;
  });
}

/** The requester (or the technician coming back) joins the session's Room. */
export async function joinSession(ticketId: string, opts: { noMic?: boolean } = {}): Promise<void> {
  await enterSpecial(async () => {
    const r = await window.dex.request('help.session.join', { id: ticketId, controlAvailable: state.control.available });
    takeBack(r.session);
    set({ session: r.session, invite: null });
    return r.room;
  }, opts);
}

export async function endSession(): Promise<void> {
  const s = state.session;
  resume = null;
  stops++;
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
  return window.dex.assist.consent({ screen, sourceId: state.shared?.sourceId ?? null, scope: state.shared?.scope ?? 'screen', control, peer: techName, context: 'support', unattended: !!s?.unattended });
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
  resume = { sessionId: s.id, sourceId, scope, control: false };
  await applyLocal(true, false);
  void syncPrivacy();
  try { set({ session: await window.dex.request('help.consent', { id: s.ticketId, kind: 'screen', on: true, scope }) }); } catch (e) { await stopScreen(); throw e; }
}

export async function stopScreen(): Promise<void> {
  const s = state.session;
  resume = null;
  stops++;
  await applyLocal(false, false);
  if (callState().screen && callState().room?.purpose?.kind === 'support') await toggleScreen();
  set({ shared: null });
  // always told: a share may be on its way to the hub (an automatic one) even if this window has not heard it yet
  if (s) set({ session: await window.dex.request('help.consent', { id: s.ticketId, kind: 'screen', on: false }).catch(() => s) });
}

/** The second consent: the technician may use this PC's mouse and keyboard. */
export async function allowControl(): Promise<void> {
  const s = state.session;
  if (!s) throw new Error('The session has ended.');
  const r = await applyLocal(true, true);
  if (!r.control) throw new Error(r.error ?? 'Remote control could not start.');
  try { set({ session: await window.dex.request('help.consent', { id: s.ticketId, kind: 'control', on: true }) }); } catch (e) { await applyLocal(true, false); throw e; }
  if (resume?.sessionId === s.id) resume = { ...resume, control: true };
}

export async function stopControl(): Promise<void> {
  const s = state.session;
  if (resume) resume = { ...resume, control: false };
  stops++;
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
