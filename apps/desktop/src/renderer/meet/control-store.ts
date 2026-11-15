// "Give control" in a meeting or on a webinar's stage, as this app knows it. The presenter (the PC
// sharing a whole screen) gives one person their mouse and keyboard after the same separate
// consent as a support session; their input then arrives over the Room's data channel (or the hub
// on the relay, which passes it only from that person) and goes to the main process, which checks
// the device again and applies the same rate limit and blocked chords (main/assist). This PC stops
// first, then the hub is told: Stop, the stop keys, the share bar, sharing ending, either person
// leaving and the meeting ending all end it.
import { useSyncExternalStore } from 'react';
import { controlEndText } from '@dex/core';
import type { ControlEndReason, RoomControl, RoomInfo } from '@dex/core';
import { callState, onRoomData, selfDevice, sendRoomDataTo, sharedSource, tell, toggleScreen, watchCall, setMinimized } from '../rooms/engine.ts';

export interface MeetControlState {
  /** The presenter: someone in the Room asks for control. */
  ask: { roomId: string; fromDevice: string; fromUser: string; at: number } | null;
  /** The presenter: the consent sheet is open for this person. */
  consent: { roomId: string; deviceId: string; userId: string } | null;
  /** The presenter: this PC takes input from this device now. */
  local: { roomId: string; controllerDevice: string; controllerId: string; seen: boolean } | null;
  /** The viewer: asked for control, waiting for the presenter. */
  asked: string | null;
}

let state: MeetControlState = { ask: null, consent: null, local: null, asked: null };
const listeners = new Set<() => void>();
const set = (patch: Partial<MeetControlState>) => { state = { ...state, ...patch }; for (const l of listeners) l(); };
export const useMeetControl = <T,>(sel: (s: MeetControlState) => T): T => useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, () => sel(state));
export const meetControlNow = () => state;

let nameOf: (userId: string) => string = () => 'Someone';
/** Names for the share bar and the toasts (the Room's people, browser guests included). */
export function setControlNames(f: (userId: string) => string): void { nameOf = f; }

/** A meeting's Room, not a support session or a lounge (those have their own rules). */
const meetingRoom = (r: RoomInfo | null): r is RoomInfo => !!r && !r.purpose;

let started = false;
export function startMeetControl(): void {
  if (started) return;
  started = true;
  window.dex.onHubEvent((name, data) => {
    const room = callState().room;
    if (name === 'room.controlAsk') {
      const d = data as { roomId: string; fromDevice: string; fromUser: string; at: number };
      if (room?.id !== d.roomId || !callState().screen) return;
      set({ ask: d });
      // the presenter may be looking at what they share: bring the Room forward and say so
      setMinimized(false);
      if (!document.hasFocus()) window.dex.notify(`${nameOf(d.fromUser)} asks for control`, 'Open Dexterity Connect to accept or refuse');
    } else if (name === 'room.controlRefused') {
      const d = data as { roomId: string; by: string };
      if (room?.id !== d.roomId) return;
      set({ asked: null });
      tell(`${nameOf(d.by)} said no to control for now`);
    } else if (name === 'room.controlEnded') {
      const d = data as { roomId: string; why: ControlEndReason; by: string | null };
      const l = state.local;
      const presenterSide = !!l && l.roomId === d.roomId;
      if (presenterSide) void stopLocal(!!callState().screen);
      const c = room?.control;
      const presenter = presenterSide ? 'You' : nameOf(c?.presenterId ?? '');
      const controller = presenterSide ? nameOf(l!.controllerId) : nameOf(c?.controllerId ?? '');
      if (room?.id === d.roomId && (presenterSide || c?.controllerDevice === selfDevice())) tell(controlEndText(d.why, presenter, controller, presenterSide));
      set({ asked: null });
    }
  });
  // the controller's input: only from the device given control, only while this PC shares in a meeting
  onRoomData((dev, user, data) => {
    const l = state.local;
    if (!l || (data as { k?: unknown } | null)?.k !== 'in') return;
    const room = callState().room;
    if (!meetingRoom(room) || room.id !== l.roomId || dev !== l.controllerDevice || user !== l.controllerId || !callState().screen) return;
    window.dex.assist?.input(data, dev);
  });
  // the share bar and the stop keys (main process), and the window or hub going away
  window.dex.assist?.onStop((what, context) => {
    if (context === 'support' || !state.local) return;
    if (what === 'control') void stopControl();
    else if (what === 'screen') { void stopControl(); if (callState().screen) void toggleScreen(); }
    else void stopControl();
  });
  // this PC ends control on its own when sharing stops, the Room changes or the hub says someone else has it
  watchCall((s) => {
    const l = state.local;
    if (!l) {
      if (state.ask && (s.room?.id !== state.ask.roomId || !s.screen)) set({ ask: null });
      if (state.consent && (s.room?.id !== state.consent.roomId || !s.screen)) set({ consent: null });
      if (state.asked && s.room?.id !== state.asked) set({ asked: null });
      return;
    }
    const room = s.room;
    const c = room?.control ?? null;
    const mine = !!c && c.presenterDevice === selfDevice() && c.controllerDevice === l.controllerDevice;
    if (!room || room.id !== l.roomId || !s.screen) { void stopControl(); return; }
    if (mine && !l.seen) { set({ local: { ...l, seen: true } }); return; }
    if ((c && !mine) || (!c && l.seen) || !room.participants.some((p) => p.deviceId === l.controllerDevice)) void stopLocal(true);
  });
}

/** This PC's side: the main process stops injecting (and the frame and bar go). */
async function stopLocal(sharing: boolean): Promise<void> {
  const l = state.local;
  set({ local: null });
  if (!l || !window.dex.assist) return;
  await window.dex.assist.consent({ screen: sharing, sourceId: sharedSource(), scope: 'screen', control: false, peer: nameOf(l.controllerId), context: 'meeting' }).catch(() => {});
}

// ------------------------------------------------------------------ the presenter
/** "Give control" in a person's menu, or Accept on their ask: the consent sheet comes first. */
export function offerControl(deviceId: string, userId: string): void {
  const r = callState().room;
  if (!meetingRoom(r)) return;
  set({ consent: { roomId: r.id, deviceId, userId }, ask: state.ask?.fromDevice === deviceId ? null : state.ask });
}
export const closeConsent = () => set({ consent: null });

/** The presenter allowed control in the consent sheet: this PC first, then the hub. */
export async function giveControl(deviceId: string, userId: string): Promise<void> {
  const r = callState().room;
  if (!meetingRoom(r)) throw new Error('The meeting has ended.');
  if (!callState().screen) throw new Error('Share your screen first.');
  const source = sharedSource();
  if (!source?.startsWith('screen:')) throw new Error('Share your whole screen (not one window) to give control.');
  if (!window.dex.assist) throw new Error('Control is given from the desktop app.');
  if (state.local && state.local.controllerDevice !== deviceId) await stopControl();
  const res = await window.dex.assist.consent({ screen: true, sourceId: source, scope: 'screen', control: true, peer: nameOf(userId), context: 'meeting', from: deviceId });
  if (!res.control) throw new Error(res.error ?? 'Remote control could not start on this PC.');
  set({ local: { roomId: r.id, controllerDevice: deviceId, controllerId: userId, seen: false }, consent: null });
  try {
    const c: RoomControl = await window.dex.request('room.control.grant', { roomId: r.id, deviceId });
    if (c.controllerDevice !== deviceId) throw new Error('Someone else has control now.');
  } catch (e) { await stopLocal(true); throw e; }
}

/** The presenter takes control back (Stop control, the share bar, the stop keys). */
export async function stopControl(): Promise<void> {
  const l = state.local;
  // this PC stops first, whatever the hub says
  await stopLocal(!!callState().screen);
  const r = callState().room;
  if (l && r?.id === l.roomId) await window.dex.request('room.control.stop', { roomId: r.id }).catch(() => {});
}

/** Refuse someone's ask (they are told). */
export function refuseAsk(): void {
  const a = state.ask;
  set({ ask: null });
  if (a) void window.dex.request('room.control.refuse', { roomId: a.roomId, deviceId: a.fromDevice }).catch(() => {});
}

// ------------------------------------------------------------------ the viewer
/** "Ask for control" on the shared screen: the presenter is asked and chooses. */
export async function askControl(): Promise<void> {
  const r = callState().room;
  if (!meetingRoom(r)) return;
  await window.dex.request('room.control.ask', { roomId: r.id });
  set({ asked: r.id });
}

/** The controller gives control back (Release). */
export async function releaseControl(): Promise<void> {
  const r = callState().room;
  if (r?.control?.controllerDevice === selfDevice()) await window.dex.request('room.control.stop', { roomId: r.id });
}

/** The controller's input, to the presenter only (the data channel, or the hub on the relay). */
export function sendInput(presenterDevice: string, msg: unknown): void { sendRoomDataTo(presenterDevice, msg); }
