// Meetings, phase M2: guests from a browser, recordings kept on the hub, per-meeting reports,
// breakout rooms and the meeting chat everyone in a Room can read. The types extend the hub
// protocol (protocol.ts) by declaration merging, so the request and event maps stay one map.
import type { LobbyRule, MeetingKind, RoomInfo } from './protocol.ts';

// ---------------------------------------------------------------- guests from a browser
/** People who join from a browser have ids the hub makes up for the meeting; they are never office accounts. */
export const WEB_GUEST_PREFIX = 'guest:';
export const WEB_GUEST_DEVICE_PREFIX = 'guestdev:';
export const isWebGuest = (userId: string): boolean => typeof userId === 'string' && userId.startsWith(WEB_GUEST_PREFIX);
export const isWebGuestDevice = (deviceId: string): boolean => typeof deviceId === 'string' && deviceId.startsWith(WEB_GUEST_DEVICE_PREFIX);

/** Passcodes are 6 to 10 letters and digits, in the link's fragment so no server logs them. */
export const PASSCODE_RE = /^[A-Za-z0-9]{6,10}$/;
/** Letters that are hard to misread when someone types the passcode from an invitation. */
export const PASSCODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
export const GUEST_NAME_MAX = 60;

/** https://gateway.example/m/482913207#Hx7kP2q: the page, the meeting and (after #) the passcode. */
export function guestUrl(gateway: string, meetingId: string, passcode: string): string {
  return `${gateway.replace(/\/+$/, '')}/m/${meetingId}#${passcode}`;
}

/** What a host sees about a meeting's guest link. */
export interface GuestLinkView {
  meetingId: string;
  enabled: boolean;
  /** Shown to hosts only. */
  passcode: string | null;
  /** The whole link, when the office's gateway is set up and the link is on. */
  url: string | null;
  /** The office allows guest links (Control room ▸ Meetings). */
  allowed: boolean;
  /** Why guests cannot join right now, in plain words, or null. */
  problem: string | null;
  /** The meeting runs on the office relay (more than 8 people), which browsers outside cannot reach. */
  relayOnly: boolean;
}

/** A browser guest in a Room or its lobby: only their name is known. */
export interface RoomVisitor { userId: string; deviceId: string; name: string }

// ---------------------------------------------------------------- the meeting chat
/** A line in a Room's meeting chat: everyone in the Room reads it, guests from a browser too. */
export interface RoomChatLine {
  id: string; roomId: string; userId: string; name: string; text: string; at: number; guest: boolean;
  /** The message it was saved as in the meeting's thread. */
  messageId?: string | null;
  /** Said from a breakout room ("B2 · Piping"). */
  breakout?: string | null;
  /** A file sent with it (a guest's, from the browser): its name and size. */
  file?: { id: string; name: string; size: number } | null;
}
export const ROOM_CHAT_MAX = 2000;

// ---------------------------------------------------------------- breakout rooms
export interface BreakoutRoomView {
  /** 0, 1, 2 … shown as B1, B2 … */
  index: number;
  name: string;
  /** The live sub-Room while breakouts run. */
  roomId: string | null;
  /** Devices assigned to it. */
  devices: string[];
}
export interface BreakoutView {
  /** The meeting's main Room. */
  mainRoomId: string;
  rooms: BreakoutRoomView[];
  openedAt: number;
  /** When the timer runs out (then everyone is called back), or null for no timer. */
  endsAt: number | null;
  /** Everyone goes back to the main Room at this moment (the 60-second countdown). */
  returningAt: number | null;
  /** The last note a host sent to every room. */
  note: { text: string; by: string; at: number } | null;
}
export const BREAKOUT_MAX_ROOMS = 20;
export const BREAKOUT_RETURN_MS = 60_000;

// ---------------------------------------------------------------- recordings
/** Who spoke when: a chapter starts each time the speaker changes. */
export interface RecordingChapter { at: number; userId: string; name: string }

export interface RecordingInfo {
  id: string;
  title: string;
  meetingId: string | null;
  roomId: string | null;
  convId: string | null;
  recordedBy: string;
  recordedByName: string;
  startedAt: number;
  durationMs: number;
  size: number;
  mime: string;
  /** The stored video, once the upload finished. */
  fileId: string | null;
  status: 'uploading' | 'ready';
  /** Bytes the hub has, while uploading. */
  received: number;
  chapters: RecordingChapter[];
  sharedWithConv: boolean;
  /** dexconnect://recording/<token>: anyone in the office with it can watch (shown to whoever may share). */
  link: string | null;
  linkOn: boolean;
  createdAt: number;
  /** When the office's retention removes it, or null to keep. */
  expiresAt: number | null;
  /** The recorder or an administrator: may share and delete. */
  canManage: boolean;
}
export const RECORDING_CHUNK = 512 * 1024;
export const recordingLink = (token: string): string => `dexconnect://recording/${token}`;
export function parseRecordingLink(text: string): string | null {
  const m = String(text ?? '').trim().match(/^dexconnect:\/\/recording\/([A-Za-z0-9_-]{16,64})\/?$/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- reports
export interface MeetingReportPerson {
  userId: string;
  name: string;
  guest: boolean;
  firstJoin: number;
  lastLeave: number;
  /** Time in the meeting, rejoins summed. */
  totalMs: number;
  joins: number;
  hands: number;
  reactions: number;
}
export interface MeetingReport {
  roomId: string;
  meetingId: string | null;
  title: string;
  kind: MeetingKind;
  hostId: string;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  people: MeetingReportPerson[];
  /** The most people in at once. */
  peak: number;
  hands: number;
  reactions: Record<string, number>;
  polls: Array<{ question: string; options: Array<{ text: string; votes: number }>; voters: number }>;
  recordings: RecordingInfo[];
  breakouts: number;
}
export interface MeetingUsage {
  days: number;
  from: number;
  weeks: Array<{ week: string; meetings: number; hours: number; averageSize: number; guests: number }>;
  totals: { meetings: number; hours: number; averageSize: number; guests: number; recordings: number; recordingBytes: number };
}

// ---------------------------------------------------------------- the guest page's frames
/** From the browser guest, through the gateway, to the hub. */
export type GuestUp =
  | { t: 'join'; name: string; passcode: string }
  | { t: 'signal'; to: string; data: unknown }
  | { t: 'media'; muted: boolean; camera: boolean; screen: boolean }
  | { t: 'hand'; up: boolean }
  | { t: 'react'; emoji: string }
  | { t: 'chat'; text: string }
  /** A file for the meeting chat, sent in chunks (base64) after this header. */
  | { t: 'file'; id: string; name: string; mime: string; size: number }
  | { t: 'fileChunk'; id: string; i: number; data: string }
  | { t: 'leave' }
  | { t: 'ping' };

/** A participant as a guest sees them: a name and their media, nothing else about them. */
export interface GuestSeat { deviceId: string; name: string; muted: boolean; camera: boolean; screen: boolean; host: boolean; guest: boolean; hand: number }
export interface GuestRoomView { roomId: string; meetingId: string; title: string; startedAt: number; seats: GuestSeat[]; locked: boolean; breakout: string | null; returningAt: number | null; note: { text: string; at: number } | null }

/** From the hub to the browser guest. */
export type GuestDown =
  | { t: 'lobby'; meetingId: string; title: string; host: string }
  | { t: 'admitted'; self: { deviceId: string; name: string }; room: GuestRoomView; iceServers: Array<{ urls: string | string[]; username?: string; credential?: string }>; chat: RoomChatLine[] }
  | { t: 'room'; room: GuestRoomView }
  | { t: 'moved'; room: GuestRoomView }
  | { t: 'signal'; from: string; data: unknown }
  | { t: 'chat'; line: RoomChatLine }
  /** The hub took the guest's file (or refused it, with the reason). */
  | { t: 'fileDone'; id: string; ok: boolean; reason?: string }
  | { t: 'reaction'; deviceId: string; emoji: string }
  | { t: 'muted'; by: string }
  | { t: 'unmuteAsk'; by: string }
  | { t: 'denied'; reason: string }
  | { t: 'removed' }
  | { t: 'ended'; reason: string }
  | { t: 'error'; message: string }
  /** A webinar speaker going back to the audience: the page returns to the webinar's watch page. */
  | { t: 'demoted'; to: string }
  | { t: 'pong' };

// ---------------------------------------------------------------- the protocol, extended
declare module './protocol.ts' {
  interface RoomInfo {
    /** Browser guests in the Room or its lobby (their names; they have no office account). */
    visitors?: RoomVisitor[];
    /** Breakout rooms while they run (on the main Room and on each breakout). */
    breakouts?: BreakoutView | null;
    /** Set on a breakout: the meeting's main Room. */
    parentId?: string;
    /** Set on a breakout: its name ("B2 · Piping"). */
    breakoutName?: string;
  }
  interface OfficePolicy {
    /** New meetings start with this lobby rule. */
    meetingLobby?: LobbyRule;
    /** Hosts may turn on a guest link for browsers (through the gateway). */
    guestLinks?: boolean;
    /** New meetings let people in before the host (personal rooms excepted). */
    joinBeforeHost?: boolean;
    /** The largest recording kept on the hub, in MB. */
    recordingMaxMb?: number;
  }
  interface Ops {
    'meet.guestLink': { req: { id: string; enabled?: boolean; regenerate?: boolean }; res: GuestLinkView };
    'room.chat': { req: { roomId: string; text: string }; res: RoomChatLine };
    'room.chatLog': { req: { roomId: string }; res: RoomChatLine[] };
    'room.breakout.open': { req: { roomId: string; rooms: Array<{ name: string; devices: string[] }>; minutes: number | null }; res: BreakoutView };
    'room.breakout.note': { req: { roomId: string; text: string }; res: { ok: true } };
    'room.breakout.visit': { req: { roomId: string; to: number | 'main' }; res: RoomInfo };
    'room.breakout.move': { req: { roomId: string; deviceId: string; to: number }; res: BreakoutView };
    'room.breakout.close': { req: { roomId: string; now?: boolean }; res: BreakoutView | null };
    'rec.begin': { req: { roomId?: string | null; title: string; startedAt: number; size: number; mime: string }; res: { id: string; received: number; chunk: number } };
    'rec.chunk': { req: { id: string; offset: number; data: string }; res: { received: number } };
    'rec.status': { req: { id: string }; res: { received: number; size: number; status: 'uploading' | 'ready' } };
    'rec.finish': { req: { id: string; durationMs: number; chapters: RecordingChapter[] }; res: RecordingInfo };
    'rec.list': { req: { limit?: number } | void; res: RecordingInfo[] };
    'rec.get': { req: { id?: string; token?: string }; res: RecordingInfo };
    'rec.share': { req: { id: string; conv?: boolean; link?: boolean }; res: RecordingInfo };
    'rec.delete': { req: { id: string }; res: { ok: true } };
    'rec.title': { req: { id: string; title: string }; res: RecordingInfo };
    'meet.report': { req: { roomId: string }; res: MeetingReport };
    'admin.meetings.usage': { req: { days?: number }; res: MeetingUsage };
  }
  interface Events {
    'room.chat': RoomChatLine;
    /** To one device: you are now in another Room of the same meeting (a breakout, or back to the main Room). */
    'room.moved': { from: string; room: RoomInfo };
    'room.breakoutNote': { mainRoomId: string; text: string; by: string; at: number };
    /** To the hosts: a browser guest could not be let in, and why. */
    'meet.guestRefused': { roomId: string; name: string; reason: string };
    'rec.updated': RecordingInfo;
    'rec.removed': { id: string };
  }
}

/** The ids of a Room's browser guests, for naming them in the app. */
export function visitorNames(room: Pick<RoomInfo, 'visitors'> | null | undefined): Map<string, string> {
  return new Map((room?.visitors ?? []).map((v) => [v.userId, v.name] as const));
}

/**
 * A fresh passcode from crypto-quality random bytes (the caller passes them in, so this runs
 * anywhere). Bytes that would favour some letters are skipped; pass at least 32.
 */
export function passcodeFrom(bytes: Uint8Array, length = 8): string {
  const n = PASSCODE_ALPHABET.length;
  const limit = 256 - (256 % n);
  let s = '';
  for (const b of bytes) {
    if (s.length >= length) break;
    if (b < limit) s += PASSCODE_ALPHABET[b % n];
  }
  if (s.length < length) throw new Error('Not enough random bytes for a passcode.');
  return s;
}
