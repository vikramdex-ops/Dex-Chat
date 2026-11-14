// The call engine: one RTCPeerConnection per other device in the Room (a full mesh, fine on
// a LAN for up to ~8 people). Uses the "perfect negotiation" pattern so cameras and screen
// shares can be switched on and off mid-call without glare. No STUN/TURN: host candidates
// on the office network are enough, and nothing leaves the building.
import { useSyncExternalStore } from 'react';
import type { RoomInfo } from '@dex/core';
import { timeOpts } from '../time.ts';

export interface RemotePeer {
  deviceId: string;
  userId: string;
  streams: MediaStream[]; // [camera+mic, screen?]
}

export interface CallState {
  room: RoomInfo | null;
  incoming: { room: RoomInfo; from: string } | null;
  local: MediaStream | null;
  screen: MediaStream | null;
  peers: Map<string, RemotePeer>;
  muted: boolean;
  camera: boolean;
  minimized: boolean;
  error: string | null;
  /** Rooms running in my conversations (to offer "Join"). */
  active: Map<string, RoomInfo>;
}

let state: CallState = { room: null, incoming: null, local: null, screen: null, peers: new Map(), muted: false, camera: false, minimized: false, error: null, active: new Map() };
const listeners = new Set<() => void>();
const set = (patch: Partial<CallState>) => { state = { ...state, ...patch }; for (const l of listeners) l(); };
export const useCall = <T,>(sel: (s: CallState) => T): T => useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => sel(state));
export const callState = () => state;

interface Link { pc: RTCPeerConnection; polite: boolean; makingOffer: boolean; ignoreOffer: boolean; userId: string; senders: RTCRtpSender[] }
const links = new Map<string, Link>();
let myDevice = '';
let ring: { stop: () => void } | null = null;

// ------------------------------------------------------------------ ringtone (generated, no audio files)
function startRing(outgoing: boolean): void {
  stopRing();
  try {
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(ctx.destination);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = outgoing ? 440 : 660;
    osc.connect(gain);
    osc.start();
    let on = false;
    const timer = setInterval(() => {
      on = !on;
      const t = ctx.currentTime;
      gain.gain.cancelScheduledValues(t);
      if (on) { gain.gain.setTargetAtTime(outgoing ? 0.05 : 0.12, t, 0.02); if (!outgoing) osc.frequency.setValueAtTime(osc.frequency.value === 660 ? 880 : 660, t); }
      else gain.gain.setTargetAtTime(0, t, 0.03);
    }, outgoing ? 1000 : 420);
    ring = { stop: () => { clearInterval(timer); osc.stop(); void ctx.close(); } };
  } catch { ring = null; }
}
function stopRing(): void { ring?.stop(); ring = null; }

// ------------------------------------------------------------------ hub events
let wired = false;
export function startCalls(deviceId: string, notify: (title: string, body: string) => void, nameOf: (userId: string) => string): void {
  myDevice = deviceId;
  if (wired) return;
  wired = true;
  void window.dex.request('room.list').then((rooms) => set({ active: new Map(rooms.map((r) => [r.convId, r])) })).catch(() => {});
  window.dex.onHubEvent((name, data) => {
    if (name === 'room.ring') {
      const d = data as { room: RoomInfo; from: string };
      if (state.room) return; // already in a call: they will see "missed"
      set({ incoming: d, active: new Map(state.active).set(d.room.convId, d.room) });
      startRing(false);
      if (!document.hasFocus()) notify(`${nameOf(d.from)} is opening a Room`, `${d.room.video ? 'Video' : 'Voice'} Room · join with voice or video`);
    } else if (name === 'room.updated') {
      const r = data as RoomInfo;
      const active = new Map(state.active).set(r.convId, r);
      if (state.room?.id === r.id) {
        // close links to devices that left
        for (const [dev] of links) if (!r.participants.some((p) => p.deviceId === dev)) dropLink(dev);
        if (r.participants.length > 1 || r.ringing.length === 0) stopRingIfOutgoing(r);
        set({ room: r, active });
      } else if (state.incoming?.room.id === r.id && !r.ringing.includes(selfUser())) {
        stopRing();
        set({ incoming: null, active });
      } else set({ active });
    } else if (name === 'room.ended') {
      const d = data as { roomId: string; convId: string; missed: boolean; startedBy: string };
      const active = new Map(state.active); active.delete(d.convId);
      if (state.incoming?.room.id === d.roomId) {
        stopRing();
        if (d.missed && !document.hasFocus()) notify(`You missed ${nameOf(d.startedBy)}'s Room · ${clock(state.incoming.room.startedAt)}`, 'Open the conversation to ring back');
        set({ incoming: null, active });
      } else if (state.room?.id === d.roomId) { cleanup(); set({ active }); }
      else set({ active });
    } else if (name === 'room.signal') {
      const d = data as { roomId: string; fromDevice: string; fromUser: string; data: SignalData };
      if (state.room?.id === d.roomId) void onSignal(d.fromDevice, d.fromUser, d.data);
    }
  });
}

/** A clock time in the person's 12/24-hour preference ("4:12 PM", "16:12"). */
export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { ...timeOpts(), hour: 'numeric', minute: '2-digit' });
}

/** Caption form of a name, as on a drawing: "Priya Raman" -> "PRIYA R.". */
export function capName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = parts[0].toUpperCase();
  return parts.length > 1 ? `${first} ${parts[parts.length - 1][0].toUpperCase()}.` : first;
}

/** Drawing-zone reference of the i-th tile in a grid of `cols` columns: A1, B1, A2, ... */
export function zoneRef(i: number, cols: number): string {
  const c = Math.max(1, cols);
  return `${String.fromCharCode(65 + (i % c))}${Math.floor(i / c) + 1}`;
}

/** Columns for n tiles on the Room sheet (a shared screen puts people in one column). */
export function sheetColumns(n: number, sharing: boolean): number {
  if (sharing) return 1;
  return n <= 2 ? Math.max(1, n) : n <= 4 ? 2 : n <= 9 ? 3 : 4;
}

let meUserId = '';
export function setSelfUser(id: string): void { meUserId = id; }
const selfUser = () => meUserId;
function stopRingIfOutgoing(r: RoomInfo): void { if (r.participants.length > 1) stopRing(); }

// ------------------------------------------------------------------ actions
async function getMedia(video: boolean): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: video ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } : false,
    });
  } catch (err) {
    if (video) return getMedia(false); // no camera: join with sound only
    throw new Error((err as Error).name === 'NotAllowedError' ? 'Microphone access was blocked.' : 'No microphone was found.');
  }
}

/** STUN/TURN for this call: on the office LAN none are needed; across networks the hub supplies them. */
let iceServers: RTCIceServer[] = [];
async function refreshIce(): Promise<void> {
  try {
    const r = await Promise.race([window.dex.request('room.ice'), new Promise<null>((res) => setTimeout(() => res(null), 2500))]);
    if (r) iceServers = r.iceServers as RTCIceServer[];
  } catch { /* a hub without relays: LAN-only calls */ }
}

export async function startCall(convId: string, video: boolean): Promise<void> {
  if (state.room) return;
  try {
    const [local] = await Promise.all([getMedia(video), refreshIce()]);
    const room = await window.dex.request('room.start', { convId, video });
    set({ room, local, camera: local.getVideoTracks().length > 0, muted: false, minimized: false, error: null, peers: new Map() });
    if (room.participants.length > 1) connectAll(room); else startRing(true);
    void announceMedia();
  } catch (err) { set({ error: (err as Error).message }); throw err; }
}

export async function answer(video: boolean): Promise<void> {
  const inc = state.incoming;
  if (!inc) return;
  stopRing();
  await joinRoom(inc.room.id, video);
}

export async function joinRoom(roomId: string, video: boolean): Promise<void> {
  if (state.room) return;
  try {
    const [local] = await Promise.all([getMedia(video), refreshIce()]);
    const room = await window.dex.request('room.join', { roomId });
    set({ room, local, incoming: null, camera: local.getVideoTracks().length > 0, muted: false, minimized: false, error: null, peers: new Map() });
    connectAll(room); // the newcomer reaches out to everyone already there
    void announceMedia();
  } catch (err) { set({ incoming: null, error: (err as Error).message }); throw err; }
}

export function decline(): void {
  const inc = state.incoming;
  stopRing();
  set({ incoming: null });
  if (inc) void window.dex.request('room.decline', { roomId: inc.room.id }).catch(() => {});
}

export function leave(): void {
  const r = state.room;
  cleanup();
  if (r) void window.dex.request('room.leave', { roomId: r.id }).catch(() => {});
}

function cleanup(): void {
  stopRing();
  for (const dev of [...links.keys()]) dropLink(dev);
  state.local?.getTracks().forEach((t) => t.stop());
  state.screen?.getTracks().forEach((t) => t.stop());
  set({ room: null, local: null, screen: null, peers: new Map(), camera: false, muted: false, minimized: false });
}

export function toggleMute(): void {
  const muted = !state.muted;
  state.local?.getAudioTracks().forEach((t) => { t.enabled = !muted; });
  set({ muted });
  void announceMedia();
}

export async function toggleCamera(): Promise<void> {
  const local = state.local;
  if (!local) return;
  if (state.camera) {
    for (const t of local.getVideoTracks()) {
      t.stop();
      local.removeTrack(t);
      for (const l of links.values()) for (const s of l.senders.filter((x) => x.track === t)) { l.pc.removeTrack(s); l.senders = l.senders.filter((x) => x !== s); }
    }
    set({ camera: false, local: new MediaStream(local.getTracks()) });
  } else {
    try {
      const cam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
      const track = cam.getVideoTracks()[0];
      local.addTrack(track);
      for (const l of links.values()) l.senders.push(l.pc.addTrack(track, local));
      set({ camera: true, local: new MediaStream(local.getTracks()) });
    } catch { set({ error: 'The camera could not be started.' }); }
  }
  void announceMedia();
}

export async function toggleScreen(sourceId?: string, withSound = false): Promise<void> {
  if (state.screen) {
    stopScreen();
    return;
  }
  try {
    if (sourceId) await window.dex.chooseScreen?.(sourceId);
    const screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15 } }, audio: withSound });
    const track = screen.getVideoTracks()[0];
    track.contentHint = 'detail';
    track.onended = () => stopScreen();
    // the computer's sound (Windows) travels with the screen
    for (const l of links.values()) for (const t of screen.getTracks()) l.senders.push(l.pc.addTrack(t, screen));
    set({ screen });
    void announceMedia();
  } catch { /* the person cancelled the picker */ }
}

function stopScreen(): void {
  const screen = state.screen;
  if (!screen) return;
  for (const t of screen.getTracks()) {
    t.stop();
    for (const l of links.values()) for (const s of l.senders.filter((x) => x.track === t)) { l.pc.removeTrack(s); l.senders = l.senders.filter((x) => x !== s); }
  }
  set({ screen: null });
  void announceMedia();
}

export function setMinimized(minimized: boolean): void { set({ minimized }); }

/** How the call's connections are doing: worst round-trip time and packet loss across peers. */
export async function callQuality(): Promise<{ rttMs: number | null; loss: number | null; relayed: boolean; label: 'good' | 'fair' | 'poor' | 'unknown' }> {
  let rtt: number | null = null;
  let lost = 0;
  let got = 0;
  let relayed = false;
  for (const l of links.values()) {
    try {
      const stats = await l.pc.getStats();
      const local = new Map<string, string>();
      stats.forEach((r) => { if (r.type === 'local-candidate') local.set(r.id, (r as { candidateType?: string }).candidateType ?? ''); });
      stats.forEach((r) => {
        if (r.type === 'candidate-pair' && (r as { nominated?: boolean }).nominated && (r as { state?: string }).state === 'succeeded') {
          const t = (r as { currentRoundTripTime?: number }).currentRoundTripTime;
          if (typeof t === 'number') rtt = Math.max(rtt ?? 0, t * 1000);
          if (local.get((r as { localCandidateId?: string }).localCandidateId ?? '') === 'relay') relayed = true;
        }
        if (r.type === 'inbound-rtp') {
          lost += (r as { packetsLost?: number }).packetsLost ?? 0;
          got += (r as { packetsReceived?: number }).packetsReceived ?? 0;
        }
      });
    } catch { /* closing */ }
  }
  const loss = got + lost > 0 ? lost / (got + lost) : null;
  const label = rtt === null && loss === null ? 'unknown' : (rtt ?? 0) > 400 || (loss ?? 0) > 0.08 ? 'poor' : (rtt ?? 0) > 150 || (loss ?? 0) > 0.02 ? 'fair' : 'good';
  return { rttMs: rtt === null ? null : Math.round(rtt), loss, relayed, label };
}
export function clearError(): void { set({ error: null }); }

async function announceMedia(): Promise<void> {
  const r = state.room;
  if (!r) return;
  await window.dex.request('room.media', { roomId: r.id, muted: state.muted, camera: state.camera, screen: !!state.screen }).catch(() => {});
}

// ------------------------------------------------------------------ peer connections
type SignalData = { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit | null };

function signal(toDevice: string, data: SignalData): void {
  const r = state.room;
  if (r) void window.dex.request('room.signal', { roomId: r.id, toDevice, data }).catch(() => {});
}

function connectAll(room: RoomInfo): void {
  for (const p of room.participants) if (p.deviceId !== myDevice) ensureLink(p.deviceId, p.userId);
}

function ensureLink(deviceId: string, userId: string): Link {
  const existing = links.get(deviceId);
  if (existing) return existing;
  const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
  const link: Link = { pc, polite: myDevice > deviceId, makingOffer: false, ignoreOffer: false, userId, senders: [] };
  links.set(deviceId, link);
  const local = state.local;
  if (local) for (const t of local.getTracks()) link.senders.push(pc.addTrack(t, local));
  if (state.screen) for (const t of state.screen.getTracks()) link.senders.push(pc.addTrack(t, state.screen));

  pc.onicecandidate = (e) => signal(deviceId, { candidate: e.candidate ? e.candidate.toJSON() : null });
  pc.onnegotiationneeded = async () => {
    try {
      link.makingOffer = true;
      await pc.setLocalDescription();
      signal(deviceId, { description: pc.localDescription!.toJSON() });
    } catch { /* retried on the next negotiation */ } finally { link.makingOffer = false; }
  };
  pc.ontrack = (e) => {
    const stream = e.streams[0] ?? new MediaStream([e.track]);
    const peers = new Map(state.peers);
    const peer = peers.get(deviceId) ?? { deviceId, userId, streams: [] };
    if (!peer.streams.some((s) => s.id === stream.id)) peer.streams = [...peer.streams, stream];
    peers.set(deviceId, { ...peer });
    stream.onremovetrack = () => {
      if (!stream.getTracks().length) {
        const ps = new Map(state.peers);
        const pr = ps.get(deviceId);
        if (pr) { ps.set(deviceId, { ...pr, streams: pr.streams.filter((s) => s.id !== stream.id) }); set({ peers: ps }); }
      } else set({ peers: new Map(state.peers) });
    };
    set({ peers });
  };
  pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') pc.restartIce(); };
  return link;
}

async function onSignal(fromDevice: string, fromUser: string, data: SignalData): Promise<void> {
  const link = ensureLink(fromDevice, fromUser);
  const pc = link.pc;
  try {
    if (data.description) {
      const offerCollision = data.description.type === 'offer' && (link.makingOffer || pc.signalingState !== 'stable');
      link.ignoreOffer = !link.polite && offerCollision;
      if (link.ignoreOffer) return;
      await pc.setRemoteDescription(data.description);
      if (data.description.type === 'offer') {
        await pc.setLocalDescription();
        signal(fromDevice, { description: pc.localDescription!.toJSON() });
      }
    } else if (data.candidate !== undefined) {
      try { await pc.addIceCandidate(data.candidate ?? undefined); } catch (err) { if (!link.ignoreOffer) throw err; }
    }
  } catch { /* a broken negotiation recovers on the next offer */ }
}

function dropLink(deviceId: string): void {
  const l = links.get(deviceId);
  if (!l) return;
  l.pc.close();
  links.delete(deviceId);
  const peers = new Map(state.peers);
  peers.delete(deviceId);
  set({ peers });
}

/** Speaking detection for a stream (0..1), polled by the UI. */
export function levelMeter(stream: MediaStream): { read: () => number; stop: () => void } | null {
  if (!stream.getAudioTracks().length) return null;
  try {
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    return {
      read: () => { an.getByteTimeDomainData(buf); let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v - 128)); return peak / 128; },
      stop: () => { void ctx.close(); },
    };
  } catch { return null; }
}
