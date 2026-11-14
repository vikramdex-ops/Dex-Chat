// Wire protocol shared by the hub, the desktop app and (later) the phone web app.
// Every frame is one JSON object with a `t` discriminator.

export const PROTOCOL_VERSION = 1;
export const APP_ID = 'dexconnect';
export const DEFAULT_HUB_PORT = 47900;
export const DISCOVERY_PORT = 47901;

export type Role = 'owner' | 'admin' | 'member' | 'guest' | 'bot';
export type DeviceStatus = 'pending' | 'approved' | 'rejected' | 'revoked';
/** Chosen by the person. 'invisible' appears offline to everyone else. */
export type Availability = 'available' | 'busy' | 'dnd' | 'invisible';

export interface WindowsAccount {
  /** Windows sign-in name, e.g. "priya.raman" */
  username: string;
  /** Domain, or the PC name on a workgroup machine */
  domain: string;
  /** Friendly name shown to colleagues */
  displayName: string;
  /** PC name */
  hostname: string;
}

export interface HubInfo {
  id: string;
  name: string;
  version: string;
  protocol: number;
}

export interface PublicUser {
  id: string;
  account: string;
  displayName: string;
  role: Role;
  title: string | null;
  statusText: string | null;
  availability: Availability;
  createdAt: number;
}

export interface DeviceRecord {
  id: string;
  userId: string;
  hostname: string;
  status: DeviceStatus;
  createdAt: number;
  lastSeen: number | null;
  account: string;
  displayName: string;
}

export interface AuditEntry {
  id: string;
  at: number;
  actor: string | null;
  action: string;
  target: string | null;
  detail: unknown;
}

export interface UpdateMirrorInfo {
  enabled: boolean;
  checking: boolean;
  lastCheck: number | null;
  lastError: string | null;
  channels: Partial<Record<'stable' | 'beta', { version: string; mirroredAt: number }>>;
}

// ---------------------------------------------------------------- messaging
/** A Space (open or private group with a name) or a Direct conversation (2+ people, no name). */
export type ConvKind = 'space' | 'direct';

export interface MessagePreview {
  id: string;
  authorId: string;
  body: string;
  createdAt: number;
}

export interface Conversation {
  id: string;
  kind: ConvKind;
  name: string | null;
  topic: string | null;
  private: boolean;
  /** The office-wide space everyone belongs to. */
  everyone: boolean;
  createdBy: string;
  createdAt: number;
  members: string[];
  lastMessage: MessagePreview | null;
  /** For the viewer: */
  joined: boolean;
  unread: number;
  mentions: number;
  lastReadId: string | null;
  muted: boolean;
  /** Each member's last read message id (read receipts). */
  reads: Record<string, string | null>;
}

export interface FileInfo {
  id: string;
  name: string;
  mime: string;
  size: number;
  uploaderId: string;
  createdAt: number;
}

export interface Message {
  id: string;
  convId: string;
  authorId: string;
  body: string;
  /** Set for replies in a side-track. */
  parentId: string | null;
  createdAt: number;
  editedAt: number | null;
  deleted: boolean;
  pinned: boolean;
  /** emoji -> user ids */
  reactions: Record<string, string[]>;
  /** user ids mentioned with <@id>; "all" for <@all> */
  mentions: string[];
  replyCount: number;
  lastReplyAt: number | null;
  clientId: string | null;
  files: FileInfo[];
  /** Set when this message was forwarded from another conversation. */
  forwardedFrom: { authorId: string; convId: string; messageId: string; createdAt: number } | null;
  poll: PollView | null;
}

export interface PollView {
  question: string;
  options: Array<{ text: string; votes: number; /** empty for anonymous polls */ voters: string[] }>;
  multi: boolean;
  anonymous: boolean;
  closed: boolean;
  closesAt: number | null;
  /** How many people voted. */
  voterCount: number;
  /** The viewer's own choices. */
  mine: number[];
}

// ---------------------------------------------------------------- desk (personal productivity)
export type RepeatRule = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly';

export interface Reminder {
  id: string;
  /** Who is reminded. */
  userId: string;
  /** Who set it (the same person, or a colleague). */
  createdBy: string;
  text: string;
  dueAt: number;
  repeat: RepeatRule;
  done: boolean;
  doneAt: number | null;
  /** When it last went off. */
  firedAt: number | null;
  createdAt: number;
  /** The message it is about, if any (null once the viewer cannot see it). */
  message: Message | null;
  convId: string | null;
}

export interface ScheduledMessage {
  id: string;
  convId: string;
  parentId: string | null;
  body: string;
  files: FileInfo[];
  sendAt: number;
  createdAt: number;
  status: 'pending' | 'failed';
  error: string | null;
}

export interface SavedMessage {
  message: Message;
  savedAt: number;
}

/** Mention markup inside message bodies: <@USERID> or <@all>. */
export const MENTION_RE = /<@([0-9A-Z]{26}|all)>/g;

// ---------------------------------------------------------------- rooms (calls)
export interface RoomParticipant {
  userId: string;
  deviceId: string;
  joinedAt: number;
  muted: boolean;
  camera: boolean;
  screen: boolean;
}

export interface RoomInfo {
  id: string;
  convId: string;
  startedBy: string;
  startedAt: number;
  video: boolean;
  participants: RoomParticipant[];
  /** People invited who have not answered yet. */
  ringing: string[];
}

export interface Session {
  hub: HubInfo;
  me: PublicUser;
  deviceId: string;
  users: PublicUser[];
  online: string[];
  /** Online but idle (no input for a while, or the screen is locked). */
  away: string[];
  /** People currently in a Room (call). */
  inRoom: string[];
  /** Bearer token for this connection's file uploads and downloads over HTTPS. */
  fileToken: string;
}

// ---- hub -> client
export type ServerFrame =
  | { t: 'hello'; hub: HubInfo; nonce: string }
  | { t: 'unknown' }
  | { t: 'pending'; position: number }
  | { t: 'rejected'; reason: string }
  | { t: 'ready'; session: Session }
  | { t: 'res'; id: string; ok: true; data: unknown }
  | { t: 'res'; id: string; ok: false; error: string }
  | { t: 'evt'; name: string; data: unknown }
  | { t: 'error'; error: string };

// ---- client -> hub
export type ClientFrame =
  | { t: 'auth'; deviceId: string; sig: string }
  | { t: 'register'; deviceId: string; publicKey: string; account: WindowsAccount; sig: string }
  | { t: 'req'; id: string; op: string; data?: unknown };

/**
 * What a device signs to prove possession of its key. Binding the hub's TLS certificate
 * fingerprint means a relay with a different certificate cannot reuse the signature.
 */
export function authPayload(nonce: string, hubFingerprint: string, deviceId: string): Uint8Array {
  return new TextEncoder().encode(`${APP_ID}-auth-v${PROTOCOL_VERSION}|${nonce}|${hubFingerprint}|${deviceId}`);
}

export function accountKey(account: Pick<WindowsAccount, 'domain' | 'username'>): string {
  return `${account.domain}\\${account.username}`.toLowerCase();
}

// Request/response operations available in a session.
export interface Ops {
  'directory.list': { req: void; res: { users: PublicUser[]; online: string[] } };
  'me.update': { req: { displayName?: string; title?: string | null; statusText?: string | null; availability?: Availability }; res: PublicUser };
  'me.idle': { req: { idle: boolean }; res: { ok: true } };
  'admin.devices': { req: void; res: DeviceRecord[] };
  'admin.decide': { req: { deviceId: string; approve: boolean }; res: DeviceRecord };
  'admin.setRole': { req: { userId: string; role: Exclude<Role, 'owner' | 'bot'> }; res: PublicUser };
  'admin.revoke': { req: { deviceId: string }; res: DeviceRecord };
  'admin.audit': { req: { limit?: number } | void; res: AuditEntry[] };
  'admin.updates': { req: { refresh?: boolean } | void; res: UpdateMirrorInfo };
  'admin.bots': { req: void; res: Array<{ bot: PublicUser; createdAt: number; lastUsed: number | null; active: boolean }> };
  'admin.bots.create': { req: { name: string }; res: { bot: PublicUser; token: string } };
  'admin.bots.revoke': { req: { userId: string }; res: { ok: true } };
  'ping': { req: void; res: { at: number } };

  'conv.list': { req: void; res: Conversation[] };
  'conv.browse': { req: void; res: Conversation[] };
  'conv.create': {
    req: { kind: 'space'; name: string; topic?: string; private?: boolean; members?: string[] } | { kind: 'direct'; members: string[] };
    res: Conversation;
  };
  'conv.join': { req: { convId: string }; res: Conversation };
  'conv.leave': { req: { convId: string }; res: { ok: true } };
  'conv.addMembers': { req: { convId: string; userIds: string[] }; res: Conversation };
  'conv.update': { req: { convId: string; name?: string; topic?: string | null }; res: Conversation };
  'conv.read': { req: { convId: string; messageId: string }; res: Conversation };
  'conv.mute': { req: { convId: string; muted: boolean }; res: Conversation };
  'msg.list': { req: { convId: string; before?: string; parentId?: string; limit?: number }; res: { messages: Message[]; hasMore: boolean } };
  'msg.send': { req: { convId: string; body: string; parentId?: string; clientId: string; files?: string[] }; res: Message };
  'file.list': { req: { convId: string; before?: string; limit?: number }; res: Array<FileInfo & { messageId: string; authorId: string }> };
  'msg.edit': { req: { messageId: string; body: string }; res: Message };
  'msg.delete': { req: { messageId: string }; res: Message };
  'msg.react': { req: { messageId: string; emoji: string; on: boolean }; res: Message };
  'msg.pin': { req: { messageId: string; pinned: boolean }; res: Message };
  'msg.pins': { req: { convId: string }; res: Message[] };
  'typing': { req: { convId: string; parentId?: string }; res: { ok: true } };
  'room.start': { req: { convId: string; video: boolean }; res: RoomInfo };
  'room.join': { req: { roomId: string }; res: RoomInfo };
  'room.leave': { req: { roomId: string }; res: { ok: true } };
  'room.decline': { req: { roomId: string }; res: { ok: true } };
  'room.signal': { req: { roomId: string; toDevice: string; data: unknown }; res: { ok: true } };
  'room.media': { req: { roomId: string; muted: boolean; camera: boolean; screen: boolean }; res: { ok: true } };
  'room.list': { req: void; res: RoomInfo[] };
  'conv.markUnread': { req: { convId: string; messageId: string }; res: Conversation };
  'msg.forward': { req: { messageId: string; convIds: string[]; note?: string }; res: Message[] };
  'msg.star': { req: { messageId: string; on: boolean }; res: { ok: true } };
  'poll.create': {
    req: { convId: string; question: string; options: string[]; multi?: boolean; anonymous?: boolean; closesAt?: number | null; parentId?: string; clientId: string };
    res: Message;
  };
  'poll.vote': { req: { messageId: string; options: number[] }; res: Message };
  'poll.close': { req: { messageId: string }; res: Message };
  'desk.saved': { req: void; res: SavedMessage[] };
  'remind.create': { req: { text?: string; messageId?: string; dueAt: number; repeat?: RepeatRule; forUserId?: string }; res: Reminder };
  'remind.list': { req: { includeDone?: boolean } | void; res: Reminder[] };
  'remind.update': { req: { id: string; text?: string; dueAt?: number; repeat?: RepeatRule; done?: boolean }; res: Reminder };
  'remind.delete': { req: { id: string }; res: { ok: true } };
  'sched.create': { req: { convId: string; body: string; parentId?: string; files?: string[]; sendAt: number }; res: ScheduledMessage };
  'sched.list': { req: void; res: ScheduledMessage[] };
  'sched.update': { req: { id: string; body?: string; sendAt?: number }; res: ScheduledMessage };
  'sched.cancel': { req: { id: string }; res: { ok: true } };
  'sched.sendNow': { req: { id: string }; res: Message };
  'search': {
    req: { q: string; convId?: string; limit?: number };
    res: { messages: Array<{ message: Message; snippet: string }>; files: Array<FileInfo & { messageId: string; convId: string }> };
  };
}
export type OpName = keyof Ops;

// Server-pushed events.
export interface Events {
  'presence': { userId: string; online: boolean; away?: boolean };
  'user.updated': PublicUser;
  'user.added': PublicUser;
  'admin.pending': DeviceRecord;
  'device.updated': DeviceRecord;
  /** The viewer's copy of a conversation changed (new member, name, unread counts...). */
  'conv.updated': Conversation;
  'conv.removed': { convId: string };
  'msg.new': Message;
  'msg.updated': Message;
  'typing': { convId: string; userId: string; parentId: string | null };
  'read': { convId: string; userId: string; messageId: string };
  'room.ring': { room: RoomInfo; from: string };
  'room.updated': RoomInfo;
  'room.ended': { roomId: string; convId: string; missed: boolean; startedBy: string; durationMs: number };
  'room.signal': { roomId: string; fromDevice: string; fromUser: string; data: unknown };
  'room.busy': { userId: string; inRoom: boolean };
  'star.updated': { messageId: string; on: boolean };
  /** A reminder went off (to the person reminded). */
  'reminder.due': Reminder;
  'reminder.updated': Reminder;
  'reminder.removed': { id: string };
  'sched.updated': ScheduledMessage;
  'sched.removed': { id: string; sentMessageId: string | null };
}
export type EventName = keyof Events;
