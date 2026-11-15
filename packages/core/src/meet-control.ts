// "Give control" in meetings and on a webinar's stage (docs/MEETINGS.md): while someone shares a
// whole screen, they (the presenter) may let one other person in the Room use their mouse and
// keyboard, with the same separate consent, input path, rate limit and blocked chords as remote
// control in a support session (assist.ts, docs/HELP-DESK.md). The hub keeps who was granted and
// passes input only from them; the presenter's PC checks it again before anything is injected.
import { isWebGuest } from './meet.ts';
import type { RoomInfo, RoomParticipant } from './protocol.ts';

/** Who controls whose screen in a Room, since when. */
export interface RoomControl {
  presenterId: string;
  presenterDevice: string;
  controllerId: string;
  controllerDevice: string;
  since: number;
}

/** Why a presenter's screen cannot be controlled: a Mac (view only), one window shared (not a whole screen), or this PC cannot inject input. */
export type ControlOff = 'mac' | 'window' | 'unavailable';

/** Asks for control one device may make in a minute. */
export const CONTROL_ASKS_PER_MIN = 4;

/** The participant sharing their screen in a Room (the presenter), if anyone is. */
export function presenterOf(room: Pick<RoomInfo, 'participants'>): RoomParticipant | null {
  return room.participants.find((p) => p.screen) ?? null;
}

/**
 * Why this person may not control another's screen in this Room (null: they may). Only people in
 * the office app on a PC: not browser guests, not phones, and on a webinar's stage only the
 * organiser, co-hosts and panelists (never an attendee invited to speak).
 */
export function controllerRefusal(p: RoomParticipant | undefined, onStageStaff: boolean | null): string | null {
  if (!p) return 'They have left the Room.';
  if (isWebGuest(p.userId)) return 'Guests in a browser cannot be given control.';
  if (!p.desktop) return 'Control is given to someone in the desktop app (not a phone or a browser).';
  if (onStageStaff === false) return 'On a webinar\'s stage, only the organiser and panelists can be given control.';
  return null;
}

/** Why a presenter's screen cannot be given to anyone (null: it can). */
export function presenterRefusal(p: RoomParticipant | undefined): string | null {
  if (!p) return 'They have left the Room.';
  if (!p.screen) return 'Share your screen first.';
  if (isWebGuest(p.userId)) return 'A screen shared from a browser cannot be controlled.';
  if (p.controlOff === 'mac') return 'On a Mac the shared screen is view only: remote control needs Accessibility permission, which the app does not ask for.';
  if (p.controlOff === 'window') return 'Only a whole screen can be controlled: share a whole screen, not one window.';
  if (!p.controllable) return 'This screen cannot be controlled remotely.';
  return null;
}

declare module './protocol.ts' {
  interface RoomParticipant {
    /** This PC can be given remote control of its screen (Windows; Linux with xdotool). */
    controllable?: boolean;
    /** Why not, when it cannot (a Mac is view only). */
    controlOff?: ControlOff;
    /** The office app on a PC (not a phone or a browser): it may be given control of another's screen. */
    desktop?: boolean;
  }
  interface RoomInfo {
    /** Someone is using the presenter's mouse and keyboard (one person at a time). */
    control?: RoomControl | null;
  }
  interface Ops {
    /** The viewer asks the presenter for control; the presenter answers. */
    'room.control.ask': { req: { roomId: string }; res: { ok: true } };
    'room.control.refuse': { req: { roomId: string; deviceId: string }; res: { ok: true } };
    /** The presenter (the sharing device) gives control to one device in the Room, after their own consent. */
    'room.control.grant': { req: { roomId: string; deviceId: string }; res: RoomControl };
    /** The presenter takes it back, or the controller releases it. */
    'room.control.stop': { req: { roomId: string }; res: { ok: true } };
  }
  interface Events {
    /** To the presenter's device: someone asks for control. */
    'room.controlAsk': { roomId: string; fromDevice: string; fromUser: string; at: number };
    /** To the asking device: the presenter said no. */
    'room.controlRefused': { roomId: string; by: string };
    /** To the presenter and the controller: control ended, and why. */
    'room.controlEnded': { roomId: string; why: ControlEndReason; by: string | null; durationMs: number };
  }
}

export type ControlEndReason = 'stopped' | 'released' | 'sharing stopped' | 'presenter left' | 'controller left' | 'meeting ended';

/** The words for why control ended, as the presenter or the controller reads them. */
export function controlEndText(why: ControlEndReason, presenter: string, controller: string, iAmPresenter: boolean): string {
  switch (why) {
    case 'stopped': return iAmPresenter ? `You took back control from ${controller}` : `${presenter} took back control`;
    case 'released': return iAmPresenter ? `${controller} gave control back` : `You gave control back to ${presenter}`;
    case 'sharing stopped': return iAmPresenter ? 'Control ended: you stopped sharing' : `Control ended: ${presenter} stopped sharing`;
    case 'presenter left': return `Control ended: ${presenter} left`;
    case 'controller left': return `Control ended: ${controller} left`;
    case 'meeting ended': return 'Control ended with the meeting';
  }
}
