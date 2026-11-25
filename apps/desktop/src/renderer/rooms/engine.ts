// The call engine: one RTCPeerConnection per other device in the Room (a full mesh, fine on
// a LAN for up to ~8 people). Uses the "perfect negotiation" pattern so cameras and screen
// shares can be switched on and off mid-call without glare. No STUN/TURN: host candidates
// on the office network are enough, and nothing leaves the building.
import { RelayClient } from './relay.ts';
import { backdropTrack } from './blur.ts';
import type { BackdropSpec, Blurred } from './blur.ts';
import { customBackground, officeBackground } from './backgrounds.ts';
import type { BackgroundId } from './backgrounds.ts';
import { stopVoices } from './speech.ts';
import { isProcessed, processMic, rawMic, releaseNoise, setNoisePref, suppressNoise } from './noise.ts';
import { useSyncExternalStore } from 'react';
import type { ControlOff, MeetingInfo, RelayProducer, RoomInfo } from '@dex/core';
import { formatTime } from '../time.ts';
import { policyNow } from '../policy.ts';

export interface RemotePeer {
  deviceId: string;
  userId: string;
  streams: MediaStream[]; // [camera+mic, screen?]
}

/**
 * Someone's shared screen among their streams: the second one with a picture; or, when they share
 * with no microphone and no camera (Show screen), the only one, which then comes first.
 */
export function screenStreamOf(peer: RemotePeer | undefined, p: { camera?: boolean; screen?: boolean } | null | undefined): MediaStream | null {
  if (!peer) return null;
  const second = peer.streams.find((x, i) => i > 0 && x.getVideoTracks().length);
  if (second) return second;
  if (p?.screen && !p.camera) return peer.streams.find((x) => x.getVideoTracks().length) ?? null;
  return null;
}

export interface CallState {
  room: RoomInfo | null;
  incoming: { room: RoomInfo; from: string } | null;
  local: MediaStream | null;
  screen: MediaStream | null;
  peers: Map<string, RemotePeer>;
  muted: boolean;
  camera: boolean;
  /** The camera's background is blurred (on this PC, before it is sent). */
  blur: boolean;
  /** What is behind you on camera: as it is, blurred, an office background or your own picture. */
  background: BackgroundId;
  minimized: boolean;
  error: string | null;
  /** Rooms running in my conversations (to offer "Join"). */
  active: Map<string, RoomInfo>;
  /** Waiting to be let into a meeting (or for its host to arrive). */
  lobby: { meeting: MeetingInfo; reason: 'admit' | 'host'; video: boolean } | null;
  /** A host asked you to turn your microphone on. */
  unmuteAsk: { by: string; at: number } | null;
  /** Something to tell the person (a host muted you, the meeting ended). */
  notice: { text: string; at: number } | null;
  /** How the Room is laid out on this PC, and the tile pinned for yourself. */
  layout: Layout;
  pinned: string | null;
  /** The ID of the meeting someone asked to join from outside the Room UI (a link, the Meet lens). */
  joining: string | null;
  /**
   * A call this PC has on hold (Hold, or Hold and answer): its seat is kept on the hub, nothing is
   * sent or heard, and Resume brings it back (holding whatever call is live then).
   */
  held: HeldCall | null;
  /** Everyone else in the live Room has put it on hold (a quiet tone plays meanwhile). */
  heldByOthers: boolean;
}
export interface HeldCall { room: RoomInfo; camera: boolean; muted: boolean; at: number }
export type Layout = 'gallery' | 'speaker' | 'presentation';

const BG_KEY = 'dex.room.background';
const LAYOUT_KEY = 'dex.room.layout';
const BACKGROUNDS: BackgroundId[] = ['none', 'blur', 'drafting', 'blueprint', 'studio', 'custom'];
const bgPref = (): BackgroundId => {
  try {
    const v = localStorage.getItem(BG_KEY) as BackgroundId | null;
    if (v && BACKGROUNDS.includes(v)) return v;
    return localStorage.getItem('dex.room.blur') === '1' ? 'blur' : 'none';
  } catch { return 'none'; }
};
const layoutPref = (): Layout => { try { const v = localStorage.getItem(LAYOUT_KEY); return v === 'speaker' ? 'speaker' : 'gallery'; } catch { return 'gallery'; } };
const startBg = bgPref();
let state: CallState = {
  room: null, incoming: null, local: null, screen: null, peers: new Map(), muted: false, camera: false, blur: startBg === 'blur', background: startBg,
  minimized: false, error: null, active: new Map(), lobby: null, unmuteAsk: null, notice: null, layout: layoutPref(), pinned: null, joining: null,
  held: null, heldByOthers: false,
};

// ------------------------------------------------------------------ backgrounds (blur, office backgrounds, your own picture)
/** The camera as it comes from the device, while a composited copy is what is shown and sent. */
let rawCamera: MediaStreamTrack | null = null;
let blurred: Blurred | null = null;

async function backdropFor(id: BackgroundId): Promise<BackdropSpec | null> {
  if (id === 'blur') return { kind: 'blur' };
  if (id === 'drafting' || id === 'blueprint' || id === 'studio') return { kind: 'image', image: officeBackground(id) };
  if (id === 'custom') { const img = await customBackground(); return img ? { kind: 'image', image: img } : null; }
  return null;
}

/** Put a track in place of another in the local stream and on every connection. */
function swapVideo(local: MediaStream, from: MediaStreamTrack, to: MediaStreamTrack): void {
  local.removeTrack(from);
  local.addTrack(to);
  for (const l of links.values()) for (const sd of l.senders) if (sd.track === from) void sd.replaceTrack(to).catch(() => {});
  void relay?.replace(from, to).catch(() => {});
}

/** Put a background behind the camera picture in this stream (or take it away). */
async function applyBackground(local: MediaStream, id: BackgroundId): Promise<void> {
  const cur = local.getVideoTracks()[0];
  if (!cur) return;
  const spec = await backdropFor(id);
  if (spec && blurred) blurred.set(spec);
  else if (spec) {
    rawCamera = cur;
    blurred = await backdropTrack(cur, spec);
    swapVideo(local, cur, blurred.track);
  } else if (blurred && rawCamera) {
    swapVideo(local, blurred.track, rawCamera);
    blurred.stop();
    blurred = null;
    rawCamera = null;
  }
}

function stopCameraTracks(local: MediaStream): void {
  for (const t of local.getVideoTracks()) t.stop();
  blurred?.stop(); blurred = null;
  rawCamera?.stop(); rawCamera = null;
}

/** Choose what is behind you on camera; remembered for the next Room. */
export async function setBackground(id: BackgroundId): Promise<void> {
  try { localStorage.setItem(BG_KEY, id); } catch { /* private mode */ }
  if (state.local && state.camera) {
    try { await applyBackground(state.local, id); } catch { set({ error: 'The background could not be changed on this PC.' }); return; }
    set({ blur: id === 'blur', background: id, local: new MediaStream(state.local.getTracks()) });
  } else set({ blur: id === 'blur', background: id });
}
export const toggleBlur = (): Promise<void> => setBackground(state.background === 'blur' ? 'none' : 'blur');

/** Strong noise suppression on or off, now (in a Room) and for the next Rooms. */
export async function setNoiseSuppression(on: boolean): Promise<void> {
  setNoisePref(on);
  const local = state.local;
  const cur = local?.getAudioTracks()[0];
  if (!local || !cur) return;
  if (on && !isProcessed(cur)) {
    const out = await processMic(cur);
    out.enabled = cur.enabled;
    swapVideo(local, cur, out);
  } else if (!on && isProcessed(cur)) {
    const raw = rawMic();
    if (!raw) return;
    raw.enabled = cur.enabled;
    swapVideo(local, cur, raw);
    releaseNoise(false);
  }
  set({ local: new MediaStream(local.getTracks()) });
}

export function setLayout(layout: Layout): void {
  if (layout !== 'presentation') { try { localStorage.setItem(LAYOUT_KEY, layout); } catch { /* private mode */ } }
  set({ layout });
}
/** Pin a tile large for yourself (null to unpin). */
export function setPinned(deviceId: string | null): void { set({ pinned: deviceId, layout: deviceId && state.layout === 'gallery' ? 'speaker' : state.layout }); }

const listeners = new Set<() => void>();
const set = (patch: Partial<CallState>) => { state = { ...state, ...patch }; for (const l of listeners) l(); };
/** Tell the person something as a toast (also used by the meeting's live events, meet/live.ts). */
export const tell = (text: string) => set({ notice: { text, at: Date.now() } });
export const useCall = <T,>(sel: (s: CallState) => T): T => useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => sel(state));
export const callState = () => state;
/** Follow every change of the call's state outside React (the meeting's "Give control" uses it). */
export function watchCall(f: (s: CallState) => void): () => void { const l = () => f(state); listeners.add(l); return () => { listeners.delete(l); }; }

// ------------------------------------------------------------------ small messages to everyone in the Room (live pointers, remote control)
type DataListener = (fromDevice: string, fromUser: string, data: unknown) => void;
const dataSubs = new Set<DataListener>();
/** Follow messages from the others in the Room (over the data channel, or the hub when there is none). */
export function onRoomData(f: DataListener): () => void { dataSubs.add(f); return () => { dataSubs.delete(f); }; }
/**
 * Send a small message to everyone else in the Room: straight over each PC-to-PC data channel when
 * every one is open, otherwise once through the hub (a relayed Room, or while channels connect).
 */
export function sendRoomData(data: unknown): void {
  const r = state.room;
  if (!r) return;
  const others = r.participants.filter((p) => p.deviceId !== myDevice);
  if (!others.length) return;
  const channels = others.map((p) => links.get(p.deviceId)?.dc ?? null);
  if (r.mode !== 'relay' && channels.every((c) => c?.readyState === 'open')) {
    const text = JSON.stringify(data);
    for (const c of channels) { try { c!.send(text); } catch { /* closing */ } }
    return;
  }
  void window.dex.request('room.data', { roomId: r.id, data }).catch(() => {});
}
/**
 * Send a small message to one device in the Room (remote control's input to the presenter): over
 * its data channel when it is open, otherwise through the hub, which passes input on only from
 * the person the presenter gave control to.
 */
export function sendRoomDataTo(deviceId: string, data: unknown): void {
  const r = state.room;
  if (!r || !r.participants.some((p) => p.deviceId === deviceId)) return;
  const c = links.get(deviceId)?.dc ?? null;
  if (r.mode !== 'relay' && c?.readyState === 'open') { try { c.send(JSON.stringify(data)); return; } catch { /* closing: through the hub */ } }
  void window.dex.request('room.data', { roomId: r.id, data }).catch(() => {});
}
/** This PC's device id in Rooms. */
export const selfDevice = () => myDevice;
/** The screen or window this PC is sharing (the source picked), while it shares one. */
let screenSource: string | null = null;
export const sharedSource = () => (state.screen ? screenSource : null);

/**
 * Come into a lounge or support session: audio only (a microphone is not required: without one you
 * listen), then the hub's answer is the Room to enter.
 */
export async function enterSpecial(open: () => Promise<RoomInfo>): Promise<RoomInfo> {
  if (state.room) throw new Error('You are in another Room. Leave it first.');
  let local: MediaStream | null = null;
  try {
    const [media] = await Promise.all([getMedia(false).catch(() => new MediaStream()), refreshIce()]);
    local = media;
    const room = await open();
    enter(room, local);
    if (!local.getAudioTracks().length) set({ muted: true });
    return room;
  } catch (err) { dropMedia(local); set({ error: (err as Error).message }); throw err; }
}

// ------------------------------------------------------------------ reactions (to the tiles that show them)
type ReactionListener = (emoji: string, at: number) => void;
const reactionSubs = new Map<string, Set<ReactionListener>>();
/** Follow the reactions someone sends (by device). Returns a function that stops following. */
export function onReaction(deviceId: string, f: ReactionListener): () => void {
  const s = reactionSubs.get(deviceId) ?? new Set();
  s.add(f);
  reactionSubs.set(deviceId, s);
  return () => { s.delete(f); if (!s.size) reactionSubs.delete(deviceId); };
}

interface Link { pc: RTCPeerConnection; polite: boolean; makingOffer: boolean; ignoreOffer: boolean; userId: string; senders: RTCRtpSender[]; dc: RTCDataChannel | null; chain: Promise<void> }
const links = new Map<string, Link>();

// ------------------------------------------------------------------ large Rooms: the hub's relay
let relay: RelayClient | null = null;
function startRelay(room: RoomInfo): void {
  relay?.close();
  const r = new RelayClient(room.id, (peers) => { if (relay === r) set({ peers }); });
  relay = r;
  r.join(state.local, state.screen).catch((err: Error) => { if (relay === r) set({ error: `The Room's relay could not be reached: ${err.message}` }); });
}
/** Join the Room's media the way the Room works: PC to PC, or through the hub. */
function connectRoom(room: RoomInfo): void {
  if (room.mode === 'relay') startRelay(room); else connectAll(room);
}
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

/** Tones made on this PC (no audio files): a few notes, repeated every `every` ms until stopped. */
function tones(notes: Array<[number, number, number]>, every: number, level: number): { stop: () => void } | null {
  try {
    const ctx = new AudioContext();
    const play = () => {
      const t0 = ctx.currentTime;
      for (const [freq, at, len] of notes) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, t0 + at);
        gain.gain.linearRampToValueAtTime(level, t0 + at + 0.02);
        gain.gain.linearRampToValueAtTime(0, t0 + at + len);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t0 + at);
        osc.stop(t0 + at + len + 0.05);
      }
    };
    play();
    const timer = every > 0 ? setInterval(play, every) : null;
    return { stop: () => { if (timer) clearInterval(timer); setTimeout(() => void ctx.close().catch(() => {}), 600); } };
  } catch { return null; }
}
/** Call waiting: two short beeps every few seconds, quiet enough to talk over. */
function startWaiting(): void { stopRing(); ring = tones([[620, 0, 0.12], [620, 0.22, 0.12]], 3500, 0.06); }
/** A screen offered to watch: one soft tick, once. */
function startTick(): void { stopRing(); ring = tones([[880, 0, 0.08], [1320, 0.1, 0.1]], 0, 0.05); }

// on hold by everyone else: a calm two-note figure now and then, so silence does not read as a dropped call
let holdTone: { stop: () => void } | null = null;
let nameFor: (userId: string) => string = () => 'Someone';
function heldNews(was: RoomInfo, now: RoomInfo, nameOf: (userId: string) => string): void {
  for (const p of now.participants) {
    if (p.deviceId === myDevice) continue;
    const before = was.participants.find((x) => x.deviceId === p.deviceId);
    if (before && !before.held && p.held) tell(`${nameOf(p.userId)} put the call on hold`);
    else if (before?.held && !p.held) tell(`${nameOf(p.userId)} is back from hold`);
  }
  const others = now.participants.filter((p) => p.deviceId !== myDevice);
  const byOthers = others.length > 0 && others.every((p) => p.held);
  if (byOthers !== state.heldByOthers) set({ heldByOthers: byOthers });
  if (byOthers && !holdTone) holdTone = tones([[392, 0, 0.35], [523, 0.4, 0.5]], 6000, 0.03);
  else if (!byOthers && holdTone) { holdTone.stop(); holdTone = null; }
}
function stopHoldTone(): void { holdTone?.stop(); holdTone = null; if (state.heldByOthers) set({ heldByOthers: false }); }

// ------------------------------------------------------------------ hub events
let wired = false;
export function startCalls(deviceId: string, notify: (title: string, body: string) => void, nameOf: (userId: string) => string): void {
  myDevice = deviceId;
  nameFor = nameOf;
  if (wired) return;
  wired = true;
  // what this PC can do about remote control, told to the Room with its media
  if (window.dex.assist) {
    void window.dex.assist.caps().then((c) => {
      controlCaps = { controllable: c.control, off: c.control ? null : c.platform === 'darwin' ? 'mac' : 'unavailable', desktop: true };
      void announceMedia();
    }).catch(() => {});
  }
  // breakout rooms, lounges and support sessions are not "the" Room of their conversation
  void window.dex.request('room.list').then((rooms) => set({ active: new Map(rooms.filter((r) => !r.parentId && !r.purpose).map((r) => [r.convId, r])) })).catch(() => {});
  window.dex.onHubEvent((name, data) => {
    if (name === 'room.ring') {
      const d = data as { room: RoomInfo; from: string };
      // already on this call (another device rang it back, or it is the call on hold): nothing to answer
      if (state.room?.id === d.room.id || state.held?.room.id === d.room.id) return;
      set({ incoming: d, active: new Map(state.active).set(d.room.convId, d.room) });
      // in a call: a short call-waiting tone, never the full ring over the people you are talking to;
      // a shared screen is an invitation to watch, not a call: one soft tick
      if (d.room.share) startTick(); else if (state.room) startWaiting(); else startRing(false);
      if (!document.hasFocus()) notify(d.room.share ? `${nameOf(d.from)} is showing their screen` : `${nameOf(d.from)} is opening a Room`,
        d.room.share ? 'Watch it: no microphone or camera needed' : state.room ? 'You are in a call: hold it and answer, or not now' : `${d.room.video ? 'Video' : 'Voice'} Room · join with voice or video`);
    } else if (name === 'room.updated') {
      const r = data as RoomInfo;
      const active = r.parentId || r.purpose ? state.active : new Map(state.active).set(r.convId, r);
      if (state.held?.room.id === r.id) { set({ held: { ...state.held, room: r }, active }); return; }
      if (state.room?.id === r.id) {
        // close links to devices that left, or went on hold (they reach out again when they come back)
        const live = new Set(r.participants.filter((p) => !p.held).map((p) => p.deviceId));
        for (const [dev] of links) if (!live.has(dev)) dropLink(dev);
        relay?.keepOnly(live);
        heldNews(state.room, r, nameOf);
        if (r.participants.length > 1 || r.ringing.length === 0) stopRingIfOutgoing(r);
        // someone starts sharing a sheet: it takes the stage; when they stop, the layout comes back
        const wasSharing = state.room.participants.some((p) => p.screen && p.deviceId !== myDevice);
        const sharing = r.participants.some((p) => p.screen && p.deviceId !== myDevice);
        const layout = sharing && !wasSharing ? 'presentation' : !sharing && wasSharing && state.layout === 'presentation' && !state.screen ? layoutPref() : state.layout;
        const pinned = state.pinned && r.participants.some((p) => p.deviceId === state.pinned) ? state.pinned : null;
        set({ room: r, active, layout, pinned });
      } else if (state.incoming?.room.id === r.id && !r.ringing.includes(selfUser())) {
        stopRing();
        set({ incoming: null, active });
      } else set({ active });
    } else if (name === 'room.moved') {
      // a host moved this PC to another Room of the meeting (a breakout, or back to the main Room)
      const d = data as { from: string; room: RoomInfo };
      if (state.room?.id === d.from) moveTo(d.room);
    } else if (name === 'room.ended') {
      const d = data as { roomId: string; convId: string; missed: boolean; startedBy: string; endedBy?: string };
      const active = new Map(state.active);
      if (active.get(d.convId)?.id === d.roomId || (state.room?.id === d.roomId && !state.room.purpose)) active.delete(d.convId);
      if (state.held?.room.id === d.roomId) {
        set({ held: null, active });
        tell(d.endedBy && d.endedBy !== selfUser() ? `${nameOf(d.endedBy)} ended the call you had on hold` : 'The call you had on hold has ended');
      } else if (state.incoming?.room.id === d.roomId) {
        stopRing();
        if (d.missed && !document.hasFocus()) notify(`You missed ${nameOf(d.startedBy)}'s Room · ${clock(state.incoming.room.startedAt)}`, 'Open the conversation to ring back');
        set({ incoming: null, active });
      } else if (state.room?.id === d.roomId) {
        const kind = state.room.purpose?.kind;
        cleanup();
        set({ active });
        // a support session or a lounge is not a meeting: say what actually ended
        if (d.endedBy && d.endedBy !== selfUser()) tell(kind === 'support' ? `${nameOf(d.endedBy)} ended the support session` : kind === 'lounge' ? `${nameOf(d.endedBy)} closed the lounge` : `${nameOf(d.endedBy)} ended the meeting for everyone`);
      } else set({ active });
    } else if (name === 'meet.lobby') {
      const d = data as { meetingId: string; state: 'admitted' | 'denied' | 'waiting'; reason?: 'admit' | 'host' };
      const lobby = state.lobby;
      if (!lobby || lobby.meeting.id !== d.meetingId) return;
      if (d.state === 'admitted') void joinMeeting(d.meetingId, lobby.video).catch((err: Error) => set({ error: err.message }));
      else if (d.state === 'denied') { leaveLobby(false); tell(`You were not let into ${lobby.meeting.title || 'the meeting'}`); }
      else set({ lobby: { ...lobby, reason: d.reason ?? lobby.reason } });
    } else if (name === 'room.muted') {
      const d = data as { roomId: string; by: string };
      if (state.room?.id !== d.roomId) return;
      if (!state.muted) {
        state.local?.getAudioTracks().forEach((t) => { t.enabled = false; });
        set({ muted: true });
      }
      void announceMedia();
      if (d.by !== selfUser()) tell(`${nameOf(d.by)} muted you`);
    } else if (name === 'room.unmuteAsk') {
      const d = data as { roomId: string; by: string };
      if (state.room?.id === d.roomId && state.muted) set({ unmuteAsk: { by: d.by, at: Date.now() } });
    } else if (name === 'room.removed') {
      const d = data as { roomId: string; by: string };
      if (state.held?.room.id === d.roomId) { set({ held: null }); tell(`${nameOf(d.by)} took you out of the call you had on hold`); return; }
      if (state.room?.id !== d.roomId) return;
      cleanup();
      tell(`${nameOf(d.by)} took you out of the meeting`);
    } else if (name === 'room.reaction') {
      const d = data as { roomId: string; deviceId: string; emoji: string; at: number };
      if (state.room?.id !== d.roomId) return;
      for (const f of reactionSubs.get(d.deviceId) ?? []) f(d.emoji, d.at);
    } else if (name === 'relay.producer') {
      const d = data as RelayProducer & { roomId: string };
      if (relay && relay.roomId === d.roomId) void relay.consume(d).catch(() => {});
    } else if (name === 'relay.producerClosed') {
      const d = data as { roomId: string; producerId: string };
      if (relay && relay.roomId === d.roomId) relay.drop(d.producerId);
    } else if (name === 'relay.reset') {
      // the hub restarted its relay: connect again
      if (state.room?.mode === 'relay') startRelay(state.room);
    } else if (name === 'room.data') {
      const d = data as { roomId: string; fromDevice: string; fromUser: string; data: unknown };
      if (state.room?.id === d.roomId) for (const f of dataSubs) f(d.fromDevice, d.fromUser, d.data);
    } else if (name === 'room.signal') {
      const d = data as { roomId: string; fromDevice: string; fromUser: string; data: SignalData };
      // one signal at a time per link, in the order they came: an answer and the next offer must not overlap
      if (state.room?.id === d.roomId) { const l = ensureLink(d.fromDevice, d.fromUser); l.chain = l.chain.then(() => onSignal(d.fromDevice, d.fromUser, d.data)).catch(() => {}); }
    }
  });
}

/** A clock time in the person's 12/24-hour preference ("4:12 PM", "16:12"). */
export function clock(ts: number): string {
  return formatTime(ts);
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

/** The office may ask that people join with the camera off (and the app asks before turning it on). */
const cameraAllowed = (video: boolean) => video && policyNow().cameraConsent !== true;

/** Media for a Room: the microphone, the camera when asked for, and the chosen background. */
async function prepareMedia(video: boolean): Promise<MediaStream> {
  const [local] = await Promise.all([getMedia(cameraAllowed(video)), refreshIce()]);
  // strong noise suppression (RNNoise, on this PC), unless turned off in the Room's sound menu
  await suppressNoise(local).catch(() => {});
  if (state.background !== 'none' && local.getVideoTracks().length) await applyBackground(local, state.background).catch(() => {});
  return local;
}

/** In the Room: show it and connect to everyone already there. */
function enter(room: RoomInfo, local: MediaStream): void {
  joinedAt = performance.now();
  // a mic turned off while waiting in the lobby stays off; come in with no microphone (watching a screen) and it reads off
  const muted = (!!state.lobby && state.local === local && state.muted) || !local.getAudioTracks().length;
  local.getAudioTracks().forEach((t) => { t.enabled = !muted; });
  set({ room, local, incoming: null, lobby: null, joining: null, unmuteAsk: null, camera: local.getVideoTracks().length > 0, muted, minimized: false, error: null, peers: new Map(), pinned: null });
  const quiet = !!room.share;
  if (room.mode === 'relay') { startRelay(room); if (room.participants.length <= 1 && room.ringing.length && !quiet) startRing(true); }
  else if (room.participants.filter((p) => !p.held).length > 1) connectAll(room); // the newcomer reaches out to everyone already there
  else if (room.ringing.length && !quiet) startRing(true);
  if (room.share) set({ layout: 'presentation' });
  heldNews(room, room, nameFor);
  void announceMedia();
}
/** Into another Room of the same meeting: the same microphone and camera, new connections. */
function moveTo(room: RoomInfo): void {
  for (const dev of [...links.keys()]) dropLink(dev);
  relay?.close();
  relay = null;
  // a shared screen stays with the Room it was shared in
  if (state.screen) { state.screen.getTracks().forEach((t) => t.stop()); state.screen = null; }
  set({ room, screen: null, peers: new Map(), pinned: null, unmuteAsk: null, layout: state.layout === 'presentation' ? layoutPref() : state.layout, minimized: false });
  connectRoom(room);
  void announceMedia();
}

/** When this PC came into its current Room (for measuring how fast the first picture arrives). */
let joinedAt = 0;
export const roomJoinedAt = () => joinedAt;

export async function startCall(convId: string, video: boolean): Promise<void> {
  if (state.room) return;
  let local: MediaStream | null = null;
  try {
    local = await prepareMedia(video);
    const room = await window.dex.request('room.start', { convId, video: cameraAllowed(video) });
    enter(room, local);
  } catch (err) { dropMedia(local); set({ error: (err as Error).message }); throw err; }
}

export async function answer(video: boolean, how: 'hold' | 'end' = 'hold'): Promise<void> {
  const inc = state.incoming;
  if (!inc) return;
  stopRing();
  // in a call already: hold it (or end it) and answer; a lounge is simply left
  if (state.room) {
    if (how === 'end' || !holdable(state.room) || state.held) leave();
    else await hold();
  }
  await joinRoom(inc.room.id, video, { watch: !!inc.room.share && !video });
}

// ------------------------------------------------------------------ hold
/** Lounges are left, not held; a webinar's stage is left too. */
export const holdable = (r: RoomInfo | null): boolean => !!r && r.purpose?.kind !== 'lounge' && r.meetingKind !== 'webinar';

/** Take this PC out of the live Room's media, keeping its seat; returns what Resume needs. */
function detach(): HeldCall | null {
  const r = state.room;
  if (!r) return null;
  const held: HeldCall = { room: r, camera: state.camera, muted: state.muted, at: Date.now() };
  stopRing();
  stopHoldTone();
  for (const dev of [...links.keys()]) dropLink(dev);
  relay?.close();
  relay = null;
  if (state.local) stopCameraTracks(state.local);
  state.local?.getTracks().forEach((t) => t.stop());
  state.screen?.getTracks().forEach((t) => t.stop());
  releaseNoise();
  stopVoices();
  set({ room: null, local: null, screen: null, peers: new Map(), camera: false, muted: false, minimized: false, unmuteAsk: null, pinned: null, layout: state.layout === 'presentation' ? layoutPref() : state.layout });
  return held;
}

/**
 * Put the live call on hold: the seat is kept, the microphone, camera and any shared screen stop,
 * nothing is heard, and everyone else is shown "On hold". One call can be on hold at a time.
 */
export async function hold(): Promise<void> {
  const r = state.room;
  if (!r) return;
  if (!holdable(r)) throw new Error(r.purpose?.kind === 'lounge' ? 'A lounge is not put on hold: leave it and drop in again later.' : 'A webinar stage is not put on hold.');
  if (state.held) throw new Error('Another call is already on hold. End it or resume it first.');
  const room = await window.dex.request('room.hold', { roomId: r.id, on: true });
  // the Room may have changed while asking (left, ended)
  if (state.room?.id !== r.id) return;
  const held = detach();
  if (held) set({ held: { ...held, room } });
}

/** Back from hold: media again, and whatever call is live now goes on hold in its place (a lounge is left). */
export async function resume(): Promise<void> {
  const h = state.held;
  if (!h) return;
  let local: MediaStream | null = null;
  try {
    local = h.room.share && !h.camera && h.muted ? (await refreshIce(), new MediaStream()) : await prepareMedia(h.camera);
    const live = state.room;
    if (live && !holdable(live)) leave();
    const room = await window.dex.request('room.hold', { roomId: h.room.id, on: false });
    // the hub put the live call on hold in its place: move its media out and keep it as the held one
    const swapped = state.room && state.room.id !== room.id ? detach() : null;
    set({ held: swapped ? { ...swapped, room: { ...swapped.room, participants: swapped.room.participants.map((p) => (p.deviceId === myDevice ? { ...p, held: true } : p)) } } : null });
    local.getAudioTracks().forEach((t) => { t.enabled = !h.muted; });
    enter(room, local);
    if (h.muted) { set({ muted: true }); void announceMedia(); }
  } catch (err) { dropMedia(local); set({ error: (err as Error).message }); throw err; }
}

/** Hang up the call on hold (the live one carries on). */
export function leaveHeld(): void {
  const h = state.held;
  if (!h) return;
  set({ held: null });
  void window.dex.request('room.leave', { roomId: h.room.id }).catch(() => {});
}

// ------------------------------------------------------------------ show my screen (no voice, no camera)
/**
 * Show a screen in a conversation: a Room that asks for no microphone or camera, opened straight on
 * the presentation. Its members are told calmly ("is showing their screen · Watch"), not rung. If the
 * screen is not shared after all (the picker was closed), the Room closes again.
 */
export async function startShare(convId: string, sourceId: string, withSound = false): Promise<void> {
  if (state.room?.convId === convId) { if (!state.screen) await toggleScreen(sourceId, withSound); set({ minimized: false, layout: 'presentation' }); return; }
  if (state.room) throw new Error('You are in a Room. Share your screen from its sheet, or leave it first.');
  try {
    await refreshIce();
    const room = await window.dex.request('room.start', { convId, video: false, share: true });
    enter(room, new MediaStream());
    set({ muted: true, layout: 'presentation' });
    await toggleScreen(sourceId, withSound);
    if (!state.screen) { leave(); throw new Error('The screen could not be shared.'); }
  } catch (err) { set({ error: (err as Error).message }); throw err; }
}

/** Your voice into a Room you came into without a microphone (watching a shared screen). */
async function addVoice(): Promise<boolean> {
  const local = state.local;
  if (!local) return false;
  try {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    await suppressNoise(mic).catch(() => {});
    const track = mic.getAudioTracks()[0];
    if (!track) return false;
    local.addTrack(track);
    for (const l of links.values()) l.senders.push(l.pc.addTrack(track, local));
    void relay?.add(track, 'mic').catch(() => {});
    set({ local: new MediaStream(local.getTracks()) });
    return true;
  } catch { set({ error: 'The microphone could not be started.' }); return false; }
}

export async function joinRoom(roomId: string, video: boolean, opts: { watch?: boolean } = {}): Promise<void> {
  if (state.room) return;
  if (state.held?.room.id === roomId) { await resume(); return; }
  // a Room held under a meeting is joined by the meeting's ID, so its lobby and lock apply
  const known = [...state.active.values()].find((r) => r.id === roomId) ?? (state.incoming?.room.id === roomId ? state.incoming.room : undefined);
  if (known?.meetingId && !known.share) { set({ incoming: null }); await joinMeeting(known.meetingId, video); return; }
  // watching a shared screen asks for no microphone or camera (Mic on adds your voice later)
  const watch = opts.watch ?? !!known?.share;
  let local: MediaStream | null = null;
  try {
    local = watch ? (await refreshIce(), new MediaStream()) : await prepareMedia(video);
    const room = await window.dex.request('room.join', { roomId });
    enter(room, local);
  } catch (err) { dropMedia(local); set({ incoming: null, error: (err as Error).message }); throw err; }
}

/** Join a meeting by its ID: straight into the Room, or into its lobby to wait. */
export async function joinMeeting(meetingId: string, video: boolean): Promise<void> {
  if (state.room) {
    if (state.room.meetingId === meetingId) { set({ minimized: false }); return; }
    throw new Error('You are in another Room. Leave it first.');
  }
  // waiting for another meeting: stop waiting there first
  if (state.lobby && state.lobby.meeting.id !== meetingId) leaveLobby();
  // the lobby keeps its camera preview: the same media is used once let in
  const kept = state.lobby?.meeting.id === meetingId ? state.local : null;
  // the media and the hub's answer are fetched together: joining waits for whichever is slower
  const media = kept ? Promise.resolve(kept) : prepareMedia(video);
  try {
    set({ joining: meetingId, error: null });
    const [local, res] = await Promise.all([media, window.dex.request('meet.join', { id: meetingId })]);
    if (res.waiting) {
      set({ lobby: { meeting: res.meeting, reason: res.waiting, video }, local, camera: local.getVideoTracks().length > 0, joining: null, incoming: null });
      return;
    }
    enter(res.room, local);
  } catch (err) {
    void media.then(dropMedia, () => {});
    set({ joining: null, lobby: null, local: state.room ? state.local : null, camera: state.room ? state.camera : false, error: (err as Error).message });
    throw err;
  }
}

/** Stop waiting in a meeting's lobby. */
export function leaveLobby(tellHub = true): void {
  const l = state.lobby;
  if (!l) return;
  if (tellHub) void window.dex.request('meet.leaveLobby', { id: l.meeting.id }).catch(() => {});
  if (!state.room) dropMedia(state.local);
  set({ lobby: null, local: state.room ? state.local : null, camera: state.room ? state.camera : false });
}

function dropMedia(local: MediaStream | null): void {
  if (!local || (local === state.local && state.room)) return;
  releaseNoise();
  stopCameraTracks(local);
  local.getTracks().forEach((t) => t.stop());
}

/** Raise or lower your hand. */
export async function raiseHand(up: boolean): Promise<void> {
  const r = state.room;
  if (r) await window.dex.request('room.hand', { roomId: r.id, up });
}

let lastReaction = 0;
/** Send a reaction to everyone in the Room (it floats up your tile). */
export async function react(emoji: string): Promise<void> {
  const r = state.room;
  if (!r || performance.now() - lastReaction < 250) return;
  lastReaction = performance.now();
  await window.dex.request('room.react', { roomId: r.id, emoji });
}

/** Accept a host's request to unmute (or dismiss it). */
export function answerUnmute(accept: boolean): void {
  set({ unmuteAsk: null });
  if (accept && state.muted) toggleMute();
}
export const clearNotice = () => set({ notice: null });

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
  stopHoldTone();
  for (const dev of [...links.keys()]) dropLink(dev);
  relay?.close();
  relay = null;
  if (state.local) stopCameraTracks(state.local);
  state.local?.getTracks().forEach((t) => t.stop());
  state.screen?.getTracks().forEach((t) => t.stop());
  releaseNoise();
  stopVoices();
  set({ room: null, local: null, screen: null, peers: new Map(), camera: false, muted: false, minimized: false, unmuteAsk: null, pinned: null, layout: state.layout === 'presentation' ? layoutPref() : state.layout });
}

export function toggleMute(): void {
  const muted = !state.muted;
  // came in to watch without a microphone: turning it on asks for one first
  if (!muted && state.local && !state.local.getAudioTracks().length) {
    void addVoice().then((ok) => { if (ok) { set({ muted: false, unmuteAsk: null }); void announceMedia(); } });
    return;
  }
  state.local?.getAudioTracks().forEach((t) => { t.enabled = !muted; });
  set({ muted, unmuteAsk: muted ? state.unmuteAsk : null });
  void announceMedia();
}

export async function toggleCamera(): Promise<void> {
  const local = state.local;
  if (!local) return;
  if (state.camera) {
    const live = local.getVideoTracks();
    for (const t of live) relay?.remove(t);
    stopCameraTracks(local);
    for (const t of live) {
      local.removeTrack(t);
      for (const l of links.values()) for (const s of l.senders.filter((x) => x.track === t)) { l.pc.removeTrack(s); l.senders = l.senders.filter((x) => x !== s); }
    }
    set({ camera: false, local: new MediaStream(local.getTracks()) });
  } else {
    try {
      const cam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
      let track = cam.getVideoTracks()[0];
      const spec = await backdropFor(state.background).catch(() => null);
      if (spec) {
        try { rawCamera = track; blurred = await backdropTrack(track, spec); track = blurred.track; } catch { rawCamera = null; blurred = null; }
      }
      local.addTrack(track);
      for (const l of links.values()) l.senders.push(l.pc.addTrack(track, local));
      void relay?.add(track, 'camera').catch(() => {});
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
    screenSource = sourceId ?? null;
    let screen: MediaStream;
    try {
      screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15 } }, audio: withSound });
    } catch (err) {
      // some Linux desktops cannot start getDisplayMedia's capturer: the chosen screen still opens the older way
      if (!sourceId || (err as Error).name !== 'NotReadableError') throw err;
      screen = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxWidth: 3840, maxHeight: 2160, maxFrameRate: 15 } } } as unknown as MediaStreamConstraints);
    }
    const track = screen.getVideoTracks()[0];
    track.contentHint = 'detail';
    track.onended = () => stopScreen();
    // the computer's sound (Windows) travels with the screen
    for (const l of links.values()) for (const t of screen.getTracks()) l.senders.push(l.pc.addTrack(t, screen));
    for (const t of screen.getTracks()) void relay?.add(t, t.kind === 'audio' ? 'screen-audio' : 'screen').catch(() => {});
    set({ screen });
    void announceMedia();
  } catch { /* the person cancelled the picker */ }
}

function stopScreen(): void {
  const screen = state.screen;
  if (!screen) return;
  for (const t of screen.getTracks()) {
    relay?.remove(t);
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
  const reports: Array<() => Promise<RTCStatsReport>> = [...links.values()].map((l) => () => l.pc.getStats());
  if (relay) for (const r of await relay.stats()) reports.push(async () => r);
  for (const get of reports) {
    try {
      const stats = await get();
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

/**
 * Remote control: whether this PC can be given control of its shared screen (Windows; Linux with
 * xdotool; a Mac is view only), and whether it is the desktop app (which may control another's).
 * Phones have no window.dex.assist, so they are neither.
 */
let controlCaps: { controllable: boolean; off: ControlOff | null; desktop: boolean } = { controllable: false, off: null, desktop: false };
export const controlCapsNow = () => controlCaps;
const wholeScreen = () => (screenSource ?? '').startsWith('screen:');

async function announceMedia(): Promise<void> {
  const r = state.room;
  if (!r) return;
  await window.dex.request('room.media', {
    roomId: r.id, muted: state.muted, camera: state.camera, screen: !!state.screen,
    // a single window cannot be controlled: only a whole screen
    controllable: controlCaps.controllable && !!state.screen && wholeScreen(), controlOff: controlCaps.off ?? (state.screen && !wholeScreen() ? 'window' : null), desktop: controlCaps.desktop,
  }).catch(() => {});
}

// ------------------------------------------------------------------ peer connections
type SignalData = { description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit | null };

function signal(toDevice: string, data: SignalData): void {
  const r = state.room;
  if (r) void window.dex.request('room.signal', { roomId: r.id, toDevice, data }).catch(() => {});
}

function connectAll(room: RoomInfo): void {
  // a seat on hold is not dialled: it reaches out itself when it comes back
  for (const p of room.participants) if (p.deviceId !== myDevice && !p.held) ensureLink(p.deviceId, p.userId);
}

function ensureLink(deviceId: string, userId: string): Link {
  const existing = links.get(deviceId);
  if (existing) return existing;
  const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
  const link: Link = { pc, polite: myDevice > deviceId, makingOffer: false, ignoreOffer: false, userId, senders: [], dc: null, chain: Promise.resolve() };
  links.set(deviceId, link);
  // one data channel per link, agreed on both sides (no extra negotiation): pointers and remote control
  try {
    const dc = pc.createDataChannel('dex', { negotiated: true, id: 0, ordered: true });
    dc.onmessage = (e) => {
      if (typeof e.data !== 'string' || e.data.length > 16_384) return;
      let msg: unknown;
      try { msg = JSON.parse(e.data); } catch { return; }
      for (const f of dataSubs) f(deviceId, userId, msg);
    };
    link.dc = dc;
  } catch { /* no data channels: messages go through the hub */ }
  const local = state.local;
  if (local) for (const t of local.getTracks()) link.senders.push(pc.addTrack(t, local));
  if (state.screen) for (const t of state.screen.getTracks()) link.senders.push(pc.addTrack(t, state.screen));
  // watching with nothing to send (Show screen): ask to receive voice and pictures from the first offer
  // on, so a screen already shown arrives at once (a microphone added later takes the audio slot)
  if (!local?.getTracks().length && !state.screen) {
    try { pc.addTransceiver('audio', { direction: 'recvonly' }); pc.addTransceiver('video', { direction: 'recvonly' }); pc.addTransceiver('video', { direction: 'recvonly' }); } catch { /* older engines negotiate on the next offer */ }
  }

  pc.onicecandidate = (e) => signal(deviceId, { candidate: e.candidate ? e.candidate.toJSON() : null });
  pc.onnegotiationneeded = async () => {
    try {
      // only from a settled state: mid-negotiation, setLocalDescription() would answer, not offer
      if (pc.signalingState !== 'stable') return;
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
