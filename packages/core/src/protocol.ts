// Wire protocol shared by the hub, the desktop app and (later) the phone web app.
// Every frame is one JSON object with a `t` discriminator.
import type { FlowEvents, FlowOps } from './flows.ts';
import type { DecisionView, MessageKindOps, MessageRef } from './message-kinds.ts';

import type { BotEvents, BotOps, BotFlowCard, MiniAppView } from './bots.ts';

import type { HelpCategory, HelpEntry, HelpFileKind, HelpTicket, SupportSession } from './helpdesk.ts';

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
  /** The internet gateway devices use outside the office, when the administrator has turned it on. */
  remote?: { url: string } | null;
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
  /** Organisation details: department, reporting line, contact and custom fields. */
  profile: Profile;
  /** When a timed availability (for example Do not disturb for 1 hour) ends. */
  availabilityUntil: number | null;
  /** When any of their devices was last connected (hidden while Invisible). */
  lastSeen?: number | null;
  /** An emoji shown before the status message. */
  statusEmoji?: string | null;
  /** Shares when they have read messages (and sees others' in return). */
  readReceipts?: boolean;
  /** Out of office: until when, a note, and who to contact instead. */
  ooo: { until: number; message: string | null; delegateId: string | null } | null;
}

export interface Profile {
  departmentId: string | null;
  /** The person this one reports to. */
  managerId: string | null;
  phone: string | null;
  extension: string | null;
  location: string | null;
  email: string | null;
  employeeId: string | null;
  /** YYYY-MM-DD */
  joinedOn: string | null;
  /** MM-DD (no year) */
  birthday: string | null;
  /** Custom fields set up by an administrator: field id -> value. */
  fields: Record<string, string>;
}

export interface Department {
  id: string;
  name: string;
  parentId: string | null;
  /** The person who leads it. */
  headId: string | null;
  createdAt: number;
}

export interface SlashCommand {
  command: string;
  description: string;
  /** The integration that answers it. */
  botId: string;
}

export interface GuestInvite {
  id: string;
  /** Last four characters, to tell codes apart (the full code is shown once). */
  hint: string;
  spaceIds: string[];
  /** How long guests who use it keep access. */
  accessDays: number;
  expiresAt: number;
  uses: number;
  maxUses: number;
  note: string | null;
  createdBy: string;
  createdAt: number;
  revoked: boolean;
}

export interface CompliancePolicy {
  /** Delete Space messages after this many days (null keeps them forever). */
  spaceRetentionDays: number | null;
  directRetentionDays: number | null;
  /** Keep every version of edited or deleted messages for people or conversations on hold. */
  lastPurgeAt: number | null;
  lastPurged: number;
}

export interface LegalHold {
  id: string;
  kind: 'user' | 'conv';
  targetId: string;
  note: string | null;
  createdBy: string;
  createdAt: number;
}

export interface ProfileField {
  id: string;
  label: string;
}

/** Access from outside the office, through the internet gateway. */
export interface RemoteConfig {
  enabled: boolean;
  /** The gateway's https:// address (the Cloudflare Worker). */
  url: string | null;
  /** New devices may ask to join from outside (an administrator still approves each one). */
  allowJoin: boolean;
  /** Administrators may use the Control room from outside. */
  allowAdmin: boolean;
}
export interface RemoteView {
  config: RemoteConfig;
  status: { connected: boolean; since: number | null; error: string | null; devices: number; pinned: boolean };
  hubId: string;
  fingerprint: string;
  name: string;
}

/** A STUN or TURN server for calls (the browser's RTCIceServer). */
export interface IceServer { urls: string | string[]; username?: string; credential?: string }
/** How calls connect across networks (people outside the office). */
export interface IceConfig {
  mode: 'auto' | 'cloudflare' | 'custom';
  /** Cloudflare Realtime TURN key id (the API token is stored on the hub only). */
  keyId?: string | null;
  servers: IceServer[];
}

/** An office emoji added by an administrator, used as :name:. */
/** An action an integration adds to messages' menus ("Raise an RFI", "Log as defect"). */
export interface BotAction { id: string; label: string; scope: 'everywhere' | 'spaces' | 'direct'; botId: string; botName: string }

/** A card an integration keeps up to date on everyone's Pulse (build status, plotter queue). */
export interface Widget { botId: string; botName: string; key: string; title: string; lines: string[]; url: string | null; updatedAt: number }

export interface CustomEmoji { name: string; fileId: string; createdBy: string; createdAt: number }

/** A sticker: a larger image sent on its own, grouped in packs. Sent as the message body [[sticker:ID]]. */
export interface Sticker { id: string; name: string; pack: string; fileId: string; createdBy: string; createdAt: number }
export const STICKER_RE = /^\[\[sticker:([0-9A-Za-z]{10,40})\]\]$/;

/** Office rules set by an administrator. */
/** A line the office adds to the day's line on Pulse (optionally for a given date). */
export interface OfficeLine { id: string; text: string; by: string | null; date: string | null; addedBy: string; addedAt: number }

export interface OfficePolicy {
  /** Minutes after sending that people can edit or delete their own messages; null = any time. */
  editWindowMinutes: number | null;
  maxUploadMb: number;
  /** Direct messages may pass straight between PCs while the hub is off. */
  peerFallback: boolean;
  /** Calls may be recorded (everyone in the call is told). */
  allowRecording: boolean;
  /** Spaces every newly approved person joins (besides the Office space). */
  defaultSpaces?: string[];
  /** People may add their own phones and laptops with a pairing code (no approval needed). */
  personalDevices?: boolean;
  /** Everyone (not only administrators) may add office emoji and stickers. */
  memberEmoji?: boolean;
  /** Data-loss prevention: sensitive numbers and words stopped or masked in messages. */
  dlp?: import('./dlp.ts').DlpRule[];
  /** File types (extensions without the dot) that cannot be shared. */
  blockedFileTypes?: string[];
  /** Internet addresses (CIDR) that may connect from outside the office; empty = any. */
  outsideNetworks?: string[];
  /** Meetings and Rooms start with the camera off, and the app asks before turning it on. */
  cameraConsent?: boolean;
}

/** A message someone reported to the administrators. */
export interface ReportItem {
  id: string;
  messageId: string;
  convId: string;
  convName: string;
  authorId: string;
  reporterId: string;
  reason: string;
  /** The message text (or, for an encrypted Direct message, what the reporter quoted). */
  text: string;
  quoted: boolean;
  createdAt: number;
  status: 'open' | 'removed' | 'dismissed';
  resolvedBy: string | null;
  resolvedAt: number | null;
}

export interface UsageReport {
  days: number;
  from: number;
  daily: Array<{ day: string; messages: number; direct: number; space: number; activePeople: number; calls: number; callMinutes: number }>;
  totals: { people: number; activePeople: number; activeDevices: number; spaces: number; messages: number; files: number; fileBytes: number; calls: number; callMinutes: number };
  topSpaces: Array<{ id: string; name: string; messages: number }>;
  topPeople: Array<{ userId: string; messages: number }>;
}

export interface OrgInfo {
  departments: Department[];
  fields: ProfileField[];
}

/** One row of a people import (CSV), matched by Windows account. */
export interface ImportRow {
  account: string;
  displayName?: string;
  title?: string;
  department?: string;
  manager?: string;
  phone?: string;
  extension?: string;
  location?: string;
  email?: string;
  employeeId?: string;
  joinedOn?: string;
  birthday?: string;
  fields?: Record<string, string>;
}

export interface ImportResult {
  updated: number;
  /** Not signed in yet: their details apply when they first join. */
  waiting: number;
  departmentsCreated: number;
  problems: Array<{ row: number; message: string }>;
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
  /** Viewer's own organisation: pinned to the top (when), their section name, muted until. */
  pinnedAt: number | null;
  section: string | null;
  mutedUntil: number | null;
  /** Spaces: read-only after archiving; who may post; who moderates. */
  archived: boolean;
  postPolicy: 'everyone' | 'moderators';
  moderators: string[];
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
  /** A pin that ends by itself. */
  pinnedUntil?: number | null;
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
  /** Removed by a moderator or administrator (not its author), with their reason. */
  removed?: { by: string; reason: string | null } | null;
  /** A side-track reply also shown in the conversation: the message it answers. */
  inReplyTo?: { messageId: string; authorId: string } | null;
  /** A notice rather than something someone wrote: people joining, leaving, a rename. */
  system?: { kind: 'joined' | 'left' | 'added' | 'removed' | 'renamed' | 'away'; users: string[]; name?: string; until?: number } | null;
  poll: PollView | null;
  form: FormView | null;
  /** An integration's interactive card (a step of a flow, Pick up where you left off…). */
  botflow?: BotFlowCard | null;
  /** A tool added to the conversation. */
  miniapp?: MiniAppView | null;
  /** A Decision: a small tree of questions each person walks on their own. */
  decision?: DecisionView | null;
  /** A reference to a message or file elsewhere, as this viewer may see it. */
  ref?: MessageRef | null;
  /** Links whose cards the author removed from this message. */
  hiddenPreviews?: string[];
  /** Set by the app for end-to-end encrypted messages: opened and signed, opened but signer unknown, or not readable on this device. */
  e2e?: 'ok' | 'unverified' | 'locked';
  /** Passed straight between PCs while the hub was off (posted to the hub once it is back). */
  via?: 'direct';
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

// ---------------------------------------------------------------- remote work / attendance
export type WorkMode = 'office' | 'home' | 'site' | 'client';

/** Where someone is in their working day right now. */
export interface WorkState {
  userId: string;
  status: 'in' | 'break' | 'out';
  mode: WorkMode | null;
  /** When the current status began. */
  since: number | null;
  /** Checked in at (start of the day's first session still counted today). */
  checkedInAt: number | null;
  note: string | null;
  /** Time worked today so far (excluding breaks). */
  workedTodayMs: number;
}

export interface WorkSegment {
  id: string;
  userId: string;
  kind: 'work' | 'break';
  mode: WorkMode | null;
  startAt: number;
  endAt: number | null;
  note: string | null;
  /** Closed automatically because the person forgot to check out. */
  auto: boolean;
}

/** One person's day in a report. */
export interface AttendanceDay {
  userId: string;
  /** YYYY-MM-DD, the hub's local date */
  date: string;
  firstIn: number;
  lastOut: number | null;
  workedMs: number;
  breakMs: number;
  modes: WorkMode[];
  autoClosed: boolean;
}

// ---------------------------------------------------------------- forms, notes, whiteboards
/** file: the answer is a file the person uploads (its id); scan: text read from a QR code or barcode (or typed). */
export type FormFieldType = 'text' | 'long' | 'choice' | 'multi' | 'number' | 'date' | 'file' | 'scan';
export interface FormField {
  id: string;
  label: string;
  type: FormFieldType;
  options?: string[];
  required: boolean;
}

export interface FormView {
  id: string;
  title: string;
  description: string | null;
  fields: FormField[];
  closed: boolean;
  responses: number;
  /** The viewer's own answers, if they responded. */
  mine: Record<string, string | string[]> | null;
}

export interface FormResponse {
  userId: string;
  answers: Record<string, string | string[]>;
  at: number;
}

export interface NoteSummary {
  id: string;
  /** Shared in a conversation, or null for a personal note. */
  convId: string | null;
  ownerId: string;
  title: string;
  preview: string;
  version: number;
  updatedBy: string;
  updatedAt: number;
}

export interface Note extends NoteSummary {
  body: string;
}

export type BoardOp =
  | { t: 'stroke'; id: string; color: string; width: number; points: number[] }
  | { t: 'shape'; id: string; shape: 'rect' | 'ellipse' | 'line' | 'arrow'; color: string; width: number; x1: number; y1: number; x2: number; y2: number }
  | { t: 'text'; id: string; color: string; x: number; y: number; size: number; text: string }
  | { t: 'erase'; ids: string[] }
  | { t: 'clear' };

export interface Board {
  id: string;
  convId: string;
  title: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------- calendar and meetings
export type Rsvp = 'pending' | 'yes' | 'no' | 'maybe';
export type Recurrence = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly';

/** A bookable conference room or cabin. */
export interface Venue {
  id: string;
  name: string;
  capacity: number | null;
  note: string | null;
}

export interface CalEvent {
  id: string;
  title: string;
  description: string | null;
  /** Free-text place (used when no venue is booked). */
  location: string | null;
  venueId: string | null;
  startAt: number;
  endAt: number;
  allDay: boolean;
  organizerId: string;
  /** Conversation the meeting belongs to (its Room is used for the call). */
  convId: string | null;
  /** Hold the meeting as a call in Dexterity Connect. */
  online: boolean;
  recurrence: Recurrence;
  /** Last day a repeating meeting can start (inclusive), or null. */
  until: number | null;
  /** Minutes before the start to remind attendees, or null. */
  reminderMin: number | null;
  attendees: Array<{ userId: string; response: Rsvp }>;
  cancelled: boolean;
  createdAt: number;
  /** The time zone the organiser set it in (IANA, e.g. "Asia/Dubai"); null = the office's own. */
  timeZone?: string | null;
}

/** One time a (possibly repeating) event happens. */
export interface Occurrence {
  event: CalEvent;
  startAt: number;
  endAt: number;
}

export interface EventInput {
  title: string;
  description?: string | null;
  location?: string | null;
  venueId?: string | null;
  startAt: number;
  endAt: number;
  allDay?: boolean;
  attendees?: string[];
  convId?: string | null;
  online?: boolean;
  recurrence?: Recurrence;
  until?: number | null;
  reminderMin?: number | null;
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

/** What a kept (saved) message is for, on your Desk. */
export type KeepKind = 'keep' | 'todo' | 'important' | 'follow-up' | 'reference';
export const KEEP_KINDS: KeepKind[] = ['keep', 'todo', 'important', 'follow-up', 'reference'];

export interface SavedMessage {
  message: Message;
  savedAt: number;
  kind?: KeepKind;
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
  /** This person is recording the call (everyone is shown that). */
  recording?: boolean;
  /** Speaking now (lounges only: shown to the Space on the lounge's row). */
  speaking?: boolean;
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
  /** mesh: PCs send to each other (up to 8); relay: everyone sends once to the hub, which passes it on. */
  mode?: 'mesh' | 'relay';
  /** How many people the Room can hold. */
  capacity?: number;
  /** The meeting this Room holds (every Room has one: its short ID and link). */
  meetingId?: string;
  /** The meeting's title (a scheduled meeting, an instant meeting, a personal room). */
  title?: string;
  meetingKind?: MeetingKind;
  /** Who runs the meeting; co-hosts have every host control. */
  hostId?: string;
  coHosts?: string[];
  /** No one new can come in. */
  locked?: boolean;
  /** People waiting to be let in (sent to the host and co-hosts only). */
  lobby?: LobbyEntry[];
  /** Raised hands, oldest first. */
  hands?: RaisedHand[];
  /** The device everyone sees large (set by a host), or null. */
  spotlight?: string | null;
  settings?: MeetingSettings;
  /** A Room with a job of its own: a lounge people drop into, or an IT support session. */
  purpose?: RoomPurpose;
}

/** lounge: a standing audio space in a Space; support: a help-desk session between two people. */
export type RoomPurpose = { kind: 'lounge'; loungeId: string; name: string } | { kind: 'support'; ticketId: string };

/** A drop-in audio space inside a Space ("Piping desk"): it stays when empty; people come and go. */
export interface Lounge {
  id: string;
  convId: string;
  name: string;
  createdBy: string;
  createdAt: number;
  archived: boolean;
  /** Its Room while anyone is in it. */
  roomId: string | null;
  /** Who is in it now, and who of them is muted. */
  people: Array<{ userId: string; deviceId: string; muted: boolean; speaking: boolean }>;
}

// ---------------------------------------------------------------- meetings
/** instant: started from anywhere, with a Space of its own; personal: someone's standing room; conversation: a Room in a conversation; event: a Calendar meeting held as a call. */
export type MeetingKind = 'instant' | 'personal' | 'conversation' | 'event';
/** Who waits in the lobby until a host lets them in: nobody, guests and people from outside the meeting's conversation and invitation, or everyone but the hosts. */
export type LobbyRule = 'off' | 'outside' | 'everyone';
export interface MeetingSettings {
  lobby: LobbyRule;
  /** People can come in before the host (or a co-host) arrives. */
  joinBeforeHost: boolean;
}
export interface MeetingInfo {
  /** Nine digits; shown as 482-913-207. */
  id: string;
  kind: MeetingKind;
  title: string;
  hostId: string;
  convId: string | null;
  eventId: string | null;
  coHosts: string[];
  settings: MeetingSettings;
  /** dexconnect://meet/482-913-207 */
  link: string;
  /** The meeting's Room while it runs. */
  live: { roomId: string; participants: number; startedAt: number } | null;
}
export interface LobbyEntry { userId: string; deviceId: string; at: number; reason: 'admit' | 'host' }
export interface RaisedHand { userId: string; deviceId: string; at: number }
/** A finished meeting or call, for "Recent meetings". */
export interface MeetingRecord { roomId: string; meetingId: string | null; title: string; kind: MeetingKind; convId: string; hostId: string; startedAt: number; endedAt: number; durationMs: number; people: string[] }
/** Reactions that float up a tile. */
export const MEETING_REACTIONS = ['👍', '👏', '😂', '😮', '❤️', '🎉'] as const;
export const MEETING_ID_RE = /^\d{9}$/;
/** 482913207 -> "482-913-207" */
export const formatMeetingId = (id: string): string => (MEETING_ID_RE.test(id) ? `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}` : id);
export const meetingLink = (id: string): string => `dexconnect://meet/${formatMeetingId(id)}`;
/** A meeting ID from what someone typed or pasted: "482-913-207", "482 913 207", or a dexconnect://meet/ link. */
export function parseMeetingId(text: string): string | null {
  const t = String(text ?? '').trim();
  const m = t.match(/^(?:dexconnect:\/\/meet\/)?([\d\s-]{9,20})\/?$/i);
  if (!m) return null;
  const digits = m[1].replace(/[\s-]/g, '');
  return MEETING_ID_RE.test(digits) ? digits : null;
}

/** People looking at the same file or whiteboard together, and whether pointers are on. */
export interface PointSession { surface: string; presenter: string; enabled: boolean; viewers: Array<{ userId: string; deviceId: string }> }

/** A track someone sends to the hub's relay. */
export interface RelayProducer { producerId: string; userId: string; deviceId: string; kind: 'audio' | 'video'; source: 'mic' | 'camera' | 'screen' | 'screen-audio' }

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
  /** People in a meeting on their calendar right now. */
  inMeeting?: string[];
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
  | { t: 'register'; deviceId: string; publicKey: string; account: WindowsAccount; sig: string; /** guest invite code */ invite?: string; /** pairing token from one of the person's own devices */ pair?: string }
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
export interface Ops extends FlowOps, BotOps, MessageKindOps {
  'directory.list': { req: void; res: { users: PublicUser[]; online: string[] } };
  'me.update': { req: { readReceipts?: boolean; statusEmoji?: string | null; displayName?: string; title?: string | null; statusText?: string | null; availability?: Availability; /** availability lasts until */ until?: number | null; ooo?: { until: number; message?: string | null; delegateId?: string | null } | null }; res: PublicUser };
  'me.idle': { req: { idle: boolean }; res: { ok: true } };
  'admin.devices': { req: void; res: DeviceRecord[] };
  /** A one-time code (24 h) that adds a phone or laptop to your account without an administrator. */
  'pair.create': { req: { kind: 'phone' | 'laptop' }; res: { code: string; link: string; expiresAt: number } };
  /** Your own devices. */
  'me.devices': { req: void; res: Array<DeviceRecord & { current: boolean; paired: boolean }> };
  /** Remove one of your own devices (it is signed out at once). */
  'me.devices.remove': { req: { deviceId: string }; res: { ok: true } };
  'admin.decide': { req: { deviceId: string; approve: boolean }; res: DeviceRecord };
  'admin.setRole': { req: { userId: string; role: Exclude<Role, 'owner' | 'bot'> }; res: PublicUser };
  'admin.revoke': { req: { deviceId: string }; res: DeviceRecord };
  'admin.audit': { req: { limit?: number } | void; res: AuditEntry[] };
  'admin.updates': { req: { refresh?: boolean } | void; res: UpdateMirrorInfo };
  'admin.bots': { req: void; res: Array<{ bot: PublicUser; createdAt: number; lastUsed: number | null; active: boolean }> };
  'admin.bots.create': { req: { name: string }; res: { bot: PublicUser; token: string } };
  'admin.bots.revoke': { req: { userId: string }; res: { ok: true } };
  /** Slack-compatible incoming webhooks: a URL that posts into one Space as an integration. */
  'admin.hooks.list': { req: void; res: Array<{ id: string; botId: string; convId: string; convName: string; createdAt: number; lastUsed: number | null }> };
  'admin.hooks.create': { req: { botId: string; convId: string }; res: { id: string; path: string } };
  'admin.hooks.revoke': { req: { id: string }; res: { ok: true } };
  /** Give an integration slash commands that call its webhook. Returns the signing secret once. */
  'admin.bots.commands': { req: { userId: string; webhookUrl: string; commands: Array<{ command: string; description: string }>; actions?: Array<{ label: string; scope?: BotAction['scope'] }> }; res: { secret: string } };
  /** Message actions integrations offer (in a message's menu). */
  'actions.list': { req: void; res: BotAction[] };
  /** Send a message to an integration's action; text is given by the app for an encrypted message. */
  'action.run': { req: { actionId: string; messageId: string; text?: string }; res: { text: string | null; ephemeral: boolean } };
  /** Cards integrations keep up to date on Pulse. */
  'widgets.list': { req: void; res: Widget[] };
  'cmd.list': { req: void; res: SlashCommand[] };
  /** Run an integration's command; its reply is posted (or, if it asks, shown only to you). */
  'cmd.run': { req: { convId: string; command: string; text: string; parentId?: string }; res: { text: string | null; ephemeral: boolean; /** A conversation the app should open (a flow started there). */ open?: string } };
  /** Publish this device's encryption key (signed by its identity). */
  'e2e.publish': { req: { encKey: string; sig: string }; res: { ok: true } };
  /** Encryption keys of everyone's approved devices. */
  'e2e.keys': { req: { userIds: string[] }; res: Array<{ userId: string; deviceId: string; signKey: string; encKey: string; sig: string }> };
  /** Give more devices access to sealed messages (history for a new device of your own). */
  'e2e.addKeys': { req: { items: Array<{ messageId: string; wraps: Record<string, string> }> }; res: { updated: number } };
  'admin.guests.invites': { req: void; res: GuestInvite[] };
  'admin.guests.invite': { req: { spaceIds: string[]; accessDays: number; validDays: number; uses: number; note?: string }; res: GuestInvite & { code: string } };
  'admin.guests.revokeInvite': { req: { id: string }; res: { ok: true } };
  'admin.guests.list': { req: void; res: Array<{ user: PublicUser; until: number | null }> };
  'admin.guests.extend': { req: { userId: string; days: number }; res: { until: number } };
  'admin.guests.end': { req: { userId: string }; res: { ok: true } };
  'admin.compliance.get': { req: void; res: { policy: CompliancePolicy; holds: LegalHold[] } };
  'admin.compliance.setPolicy': { req: { spaceRetentionDays: number | null; directRetentionDays: number | null }; res: CompliancePolicy };
  'admin.compliance.hold': { req: { kind: 'user' | 'conv'; targetId: string; note?: string }; res: LegalHold };
  'admin.compliance.release': { req: { id: string }; res: { ok: true } };
  /** Every conversation, for choosing what to export (admins see names, not contents). */
  'admin.compliance.conversations': { req: void; res: Array<{ id: string; kind: 'space' | 'direct'; name: string; members: string[]; messages: number }> };
  'admin.compliance.export': {
    req: { convIds?: string[]; userIds?: string[]; from: number; to: number; format: 'json' | 'csv' | 'html'; includeHistory?: boolean };
    res: { file: FileInfo; messages: number };
  };
  'ping': { req: void; res: { at: number } };
  'org.get': { req: void; res: OrgInfo };
  'policy.get': { req: void; res: OfficePolicy };
  /** The office's own lines for Pulse. */
  'lines.office': { req: void; res: OfficeLine[] };
  'admin.lines.add': { req: { text: string; by?: string | null; date?: string | null }; res: OfficeLine[] };
  'admin.lines.remove': { req: { id: string }; res: OfficeLine[] };
  'emoji.list': { req: void; res: CustomEmoji[] };
  /** How to reach this hub from outside (for a phone's setup code); null url when it is off. */
  'remote.info': { req: void; res: { url: string | null; hubId: string; fingerprint: string; name: string; viaGateway: boolean } };
  'admin.remote.get': { req: void; res: RemoteView };
  /** STUN/TURN servers for a call (fresh short-lived credentials when Cloudflare TURN is used). */
  'room.ice': { req: void; res: { iceServers: IceServer[] } };
  'admin.ice.get': { req: void; res: IceConfig & { hasToken: boolean } };
  'admin.ice.set': { req: { mode: IceConfig['mode']; keyId?: string | null; token?: string | null; servers?: IceServer[] }; res: IceConfig & { hasToken: boolean } };
  'admin.remote.set': { req: Partial<RemoteConfig>; res: RemoteView };
  /** Text the uploader's PC read from an image, so search can find it (not Direct conversations). */
  'file.setText': { req: { fileId: string; text: string }; res: { ok: true } };
  'admin.emoji.add': { req: { name: string; fileId: string }; res: CustomEmoji };
  /** Anyone may add office emoji when the office allows it; people remove their own. */
  'emoji.add': { req: { name: string; fileId: string }; res: CustomEmoji };
  'emoji.remove': { req: { name: string }; res: { ok: true } };
  'sticker.list': { req: void; res: Sticker[] };
  'sticker.add': { req: { name: string; pack?: string; fileId: string }; res: Sticker };
  'sticker.remove': { req: { id: string }; res: { ok: true } };
  'admin.emoji.remove': { req: { name: string }; res: { ok: true } };
  'admin.policy.set': { req: Partial<OfficePolicy>; res: OfficePolicy };
  'admin.usage': { req: { days?: 7 | 30 | 90 }; res: UsageReport };
  /** Contact details anyone can keep up to date themselves. */
  'me.profile': { req: { phone?: string | null; extension?: string | null; location?: string | null; birthday?: string | null }; res: PublicUser };
  'admin.org.saveDepartment': { req: { id?: string; name: string; parentId?: string | null; headId?: string | null }; res: Department };
  'admin.org.deleteDepartment': { req: { id: string }; res: { ok: true } };
  'admin.org.saveFields': { req: { fields: Array<{ id?: string; label: string }> }; res: ProfileField[] };
  'admin.org.setProfile': {
    req: { userId: string; title?: string | null; departmentId?: string | null; managerId?: string | null; phone?: string | null; extension?: string | null;
      location?: string | null; email?: string | null; employeeId?: string | null; joinedOn?: string | null; birthday?: string | null; fields?: Record<string, string> };
    res: PublicUser;
  };
  'admin.org.import': { req: { rows: ImportRow[]; dryRun?: boolean }; res: ImportResult };

  'conv.list': { req: void; res: Conversation[] };
  'conv.browse': { req: void; res: Conversation[] };
  'conv.create': {
    req: { kind: 'space'; name: string; topic?: string; private?: boolean; members?: string[] } | { kind: 'direct'; members: string[] };
    res: Conversation;
  };
  /** Start a new Space from a message: it and its side-track replies are copied in (with credit). */
  'conv.fork': { req: { messageId: string; name: string; private?: boolean; members?: string[] }; res: Conversation };
  'conv.join': { req: { convId: string }; res: Conversation };
  'conv.leave': { req: { convId: string }; res: { ok: true } };
  /** Report a message to the administrators (quote: the text of an encrypted message, from the reporter's device). */
  'msg.report': { req: { messageId: string; reason: string; quote?: string }; res: { ok: true } };
  'admin.reports.list': { req: { status?: 'open' | 'all' }; res: ReportItem[] };
  'admin.reports.resolve': { req: { id: string; action: 'remove' | 'dismiss'; reason?: string }; res: ReportItem };
  /** A group Direct conversation becomes a private Space (history stays). */
  'conv.toSpace': { req: { convId: string; name: string }; res: Conversation };
  /** A Space's moderator takes someone out of it. */
  'conv.removeMember': { req: { convId: string; userId: string }; res: Conversation };
  'conv.addMembers': { req: { convId: string; userIds: string[] }; res: Conversation };
  'conv.update': { req: { convId: string; name?: string; topic?: string | null }; res: Conversation };
  'conv.read': { req: { convId: string; messageId: string }; res: Conversation };
  'conv.mute': { req: { convId: string; muted: boolean; /** mute until this time (then notifications come back) */ until?: number | null }; res: Conversation };
  /** The viewer's own sidebar: pin to the top, or file under a section of their own. */
  'conv.organise': { req: { convId: string; pinned?: boolean; section?: string | null }; res: Conversation };
  /** Spaces: archive (read-only) or restore; only its creator, a moderator or an administrator. */
  'conv.archive': { req: { convId: string; archived: boolean }; res: Conversation };
  /** Spaces: who may post, and moderators (they can pin, delete and change the Space). */
  'conv.settings': { req: { convId: string; postPolicy?: 'everyone' | 'moderators'; moderators?: string[] }; res: Conversation };
  /** Mentions of you and replies in side-tracks you are part of (last 60 days), newest first. */
  'activity.list': { req: { kind?: 'all' | 'mentions' | 'replies'; before?: string }; res: { items: Array<{ kind: 'mention' | 'reply'; message: Message }>; hasMore: boolean } };
  /** Side-tracks you started or replied in, by latest reply. */
  'activity.tracks': { req: void; res: Array<{ parent: Message; lastReplyAt: number; replyCount: number }> };
  /** One message you can see (for previews of message links). */
  'msg.get': { req: { messageId: string }; res: Message };
  /** Spaces you share with someone, and your calls with them (newest first). */
  'people.common': { req: { userId: string }; res: { spaces: Array<{ id: string; name: string }>; calls: Array<{ at: number; durationMs: number; missed: boolean; video: boolean; convId: string }> } };
  /** The first message on or after a moment, for "jump to date". */
  'msg.at': { req: { convId: string; at: number }; res: { messageId: string | null } };
  'msg.list': { req: { convId: string; before?: string; parentId?: string; limit?: number }; res: { messages: Message[]; hasMore: boolean } };
  'msg.send': { req: { /** a side-track reply that also appears in the conversation */ alsoToConv?: boolean; convId: string; body: string; parentId?: string; clientId: string; files?: string[] }; res: Message };
  'file.list': { req: { convId: string; before?: string; limit?: number }; res: Array<FileInfo & { messageId: string; authorId: string }> };
  'msg.edit': { req: { messageId: string; body: string }; res: Message };
  'msg.delete': { req: { messageId: string; /** a moderator's reason, shown in its place */ reason?: string }; res: Message };
  'msg.react': { req: { messageId: string; emoji: string; on: boolean }; res: Message };
  /** until: unpin by itself then (at most a year ahead); null or absent = until someone unpins it. */
  'msg.pin': { req: { messageId: string; pinned: boolean; until?: number | null }; res: Message };
  'msg.pins': { req: { convId: string }; res: Message[] };
  'typing': { req: { convId: string; parentId?: string }; res: { ok: true } };
  'room.start': { req: { convId: string; video: boolean }; res: RoomInfo };
  'room.join': { req: { roomId: string }; res: RoomInfo };
  'room.leave': { req: { roomId: string }; res: { ok: true } };
  'room.decline': { req: { roomId: string }; res: { ok: true } };
  'room.signal': { req: { roomId: string; toDevice: string; data: unknown }; res: { ok: true } };
  'room.media': { req: { roomId: string; muted: boolean; camera: boolean; screen: boolean }; res: { ok: true } };
  'room.list': { req: void; res: RoomInfo[] };
  /** The hub's relay for large Rooms (mediasoup); parameters are mediasoup's, passed through. */
  'relay.caps': { req: { roomId: string }; res: { rtpCapabilities: unknown } };
  'relay.transport': { req: { roomId: string; direction: 'send' | 'recv' }; res: { id: string; iceParameters: unknown; iceCandidates: unknown[]; dtlsParameters: unknown } };
  'relay.connect': { req: { transportId: string; dtlsParameters: unknown }; res: { ok: true } };
  'relay.produce': { req: { transportId: string; kind: 'audio' | 'video'; rtpParameters: unknown; source: RelayProducer['source'] }; res: { id: string } };
  'relay.producers': { req: { roomId: string }; res: RelayProducer[] };
  'relay.consume': { req: { transportId: string; producerId: string; rtpCapabilities: unknown }; res: { id: string; producerId: string; kind: 'audio' | 'video'; rtpParameters: unknown } };
  'relay.resume': { req: { consumerId: string }; res: { ok: true } };
  'relay.close': { req: { producerId: string }; res: { ok: true } };
  /** Ring more of the conversation's members into a running call. */
  'room.invite': { req: { roomId: string; userIds: string[] }; res: RoomInfo };
  'room.record': { req: { roomId: string; on: boolean }; res: { ok: true } };
  /** Meetings: an instant meeting (a new Space of its own, people invited are rung), or a conversation's meeting. */
  'meet.create': { req: { title?: string; convId?: string; invite?: string[]; settings?: Partial<MeetingSettings> }; res: MeetingInfo };
  /** The meeting a Calendar event is held in. */
  'meet.event': { req: { eventId: string }; res: MeetingInfo };
  /** Your personal room: your standing meeting ID. */
  'meet.personal': { req: void; res: MeetingInfo };
  /** What a meeting ID is (before joining). */
  'meet.get': { req: { id: string }; res: MeetingInfo };
  'meet.settings': { req: { id: string; title?: string; lobby?: LobbyRule; joinBeforeHost?: boolean }; res: MeetingInfo };
  /** Join by ID: straight in, or wait in the lobby (until admitted, or until the host arrives). */
  'meet.join': { req: { id: string }; res: { room: RoomInfo; waiting?: undefined } | { room?: undefined; waiting: 'admit' | 'host'; meeting: MeetingInfo } };
  'meet.leaveLobby': { req: { id: string }; res: { ok: true } };
  /** Meetings and calls you were in, newest first. */
  'meet.recent': { req: { limit?: number } | void; res: MeetingRecord[] };
  /** Host controls (the host and co-hosts). */
  'room.admit': { req: { roomId: string; deviceIds?: string[]; all?: boolean; allow: boolean }; res: { ok: true } };
  'room.lock': { req: { roomId: string; locked: boolean }; res: { ok: true } };
  'room.cohost': { req: { roomId: string; userId: string; on: boolean }; res: { ok: true } };
  /** Mute one device or everyone else; the app on that device turns its microphone off. */
  'room.mute': { req: { roomId: string; deviceId?: string; all?: boolean }; res: { ok: true } };
  /** Ask someone to turn their microphone on (they choose). */
  'room.askUnmute': { req: { roomId: string; deviceId: string }; res: { ok: true } };
  'room.remove': { req: { roomId: string; deviceId: string }; res: { ok: true } };
  'room.spotlight': { req: { roomId: string; deviceId: string | null }; res: { ok: true } };
  /** End the meeting for everyone. */
  'room.end': { req: { roomId: string }; res: { ok: true } };
  /** Raise or lower your hand; hosts lower someone's (deviceId) or everyone's (all). */
  'room.hand': { req: { roomId: string; up: boolean; deviceId?: string; all?: boolean }; res: { ok: true } };
  'room.react': { req: { roomId: string; emoji: string }; res: { ok: true } };
  'conv.markUnread': { req: { convId: string; messageId: string }; res: Conversation };
  'msg.forward': { req: { messageId: string; convIds: string[]; note?: string; /** per target: the text to post (re-sealed by the app for encrypted Directs) */ bodies?: Record<string, string> }; res: Message[] };
  'msg.star': { req: { messageId: string; on: boolean; kind?: KeepKind }; res: { ok: true } };
  'poll.create': {
    req: { convId: string; question: string; options: string[]; multi?: boolean; anonymous?: boolean; closesAt?: number | null; parentId?: string; clientId: string };
    res: Message;
  };
  'poll.vote': { req: { messageId: string; options: number[] }; res: Message };
  'poll.close': { req: { messageId: string }; res: Message };
  'desk.saved': { req: void; res: SavedMessage[] };
  'form.create': { req: { convId: string; title: string; description?: string; fields: Array<Omit<FormField, 'id'> & { id?: string }>; clientId: string }; res: Message };
  'form.respond': { req: { formId: string; answers: Record<string, string | string[]> }; res: Message };
  'form.responses': { req: { formId: string }; res: { form: FormView; responses: FormResponse[] } };
  'form.close': { req: { formId: string }; res: Message };
  'note.list': { req: { convId?: string | null }; res: NoteSummary[] };
  'note.get': { req: { id: string }; res: Note };
  /** Save; pass the version you edited so a colleague's newer save is never overwritten. */
  'note.save': { req: { id?: string; convId?: string | null; title: string; body: string; baseVersion?: number }; res: Note };
  'note.delete': { req: { id: string }; res: { ok: true } };
  'board.list': { req: { convId: string }; res: Board[] };
  'board.create': { req: { convId: string; title: string }; res: Board };
  'board.open': { req: { boardId: string }; res: { board: Board; ops: Array<{ seq: number; userId: string; op: BoardOp }> } };
  'board.draw': { req: { boardId: string; op: BoardOp }; res: { seq: number } };
  'board.rename': { req: { boardId: string; title: string }; res: Board };
  'board.delete': { req: { boardId: string }; res: { ok: true } };
  'cal.list': { req: { from: number; to: number }; res: Occurrence[] };
  'cal.get': { req: { eventId: string }; res: CalEvent };
  'cal.create': { req: EventInput; res: CalEvent };
  'cal.update': { req: { eventId: string } & Partial<EventInput>; res: CalEvent };
  'cal.cancel': { req: { eventId: string }; res: CalEvent };
  'cal.respond': { req: { eventId: string; response: Exclude<Rsvp, 'pending'> }; res: CalEvent };
  /** When people (and optionally a venue) are busy; no titles, just blocks. */
  'cal.busy': { req: { userIds: string[]; venueId?: string; from: number; to: number }; res: Array<{ id: string; startAt: number; endAt: number }> };
  'cal.venues': { req: void; res: Venue[] };
  'admin.cal.saveVenue': { req: { id?: string; name: string; capacity?: number | null; note?: string | null }; res: Venue };
  'admin.cal.deleteVenue': { req: { id: string }; res: { ok: true } };
  'work.checkIn': { req: { mode: WorkMode; note?: string }; res: WorkState };
  'work.checkOut': { req: void; res: WorkState };
  'work.break': { req: { on: boolean }; res: WorkState };
  'work.setMode': { req: { mode: WorkMode; note?: string | null }; res: WorkState };
  /** Everyone's state now (what colleagues see). */
  'work.team': { req: void; res: WorkState[] };
  /** Days between two dates (inclusive, YYYY-MM-DD). Yourself, your reports (managers) or anyone (admins). */
  'work.report': { req: { from: string; to: string; userIds?: string[] }; res: { days: AttendanceDay[]; segments: WorkSegment[] } };
  'remind.create': { req: { text?: string; messageId?: string; dueAt: number; repeat?: RepeatRule; forUserId?: string }; res: Reminder };
  'remind.list': { req: { includeDone?: boolean } | void; res: Reminder[] };
  'remind.update': { req: { id: string; text?: string; dueAt?: number; repeat?: RepeatRule; done?: boolean }; res: Reminder };
  'remind.delete': { req: { id: string }; res: { ok: true } };
  'sched.create': { req: { convId: string; body: string; parentId?: string; files?: string[]; sendAt: number }; res: ScheduledMessage };
  'sched.list': { req: void; res: ScheduledMessage[] };
  'sched.update': { req: { id: string; body?: string; sendAt?: number }; res: ScheduledMessage };
  'sched.cancel': { req: { id: string }; res: { ok: true } };
  'sched.sendNow': { req: { id: string }; res: Message };
  /** Hashtags people use, most used first (in conversations you are part of). */
  'tags.top': { req: { prefix?: string; convId?: string } | void; res: Array<{ tag: string; count: number }> };
  // ------------------------------------------------------------ help desk (docs/HELP-DESK.md)
  'help.create': { req: { summary: string; detail?: string; category: HelpCategory; screenshot?: string | null; platform?: string | null }; res: HelpTicket };
  /** Tickets you asked for, newest first. */
  'help.mine': { req: void; res: HelpTicket[] };
  /** IT: the queue (open and taken first, then recently closed). */
  'help.queue': { req: { status?: 'active' | 'closed' | 'all' } | void; res: HelpTicket[] };
  'help.get': { req: { id: string }; res: { ticket: HelpTicket; timeline: HelpEntry[] } };
  'help.take': { req: { id: string }; res: HelpTicket };
  'help.release': { req: { id: string }; res: HelpTicket };
  'help.note': { req: { id: string; text: string }; res: HelpEntry };
  'help.attach': { req: { id: string; fileId: string; kind: HelpFileKind }; res: HelpTicket };
  'help.close': { req: { id: string; note?: string }; res: HelpTicket };
  'help.reopen': { req: { id: string; note?: string }; res: HelpTicket };
  'help.rate': { req: { id: string; rating: number; note?: string }; res: HelpTicket };
  /** The assigned technician opens a support session (and is first in its Room). */
  'help.session.start': { req: { id: string }; res: { session: SupportSession; room: RoomInfo } };
  /** The requester (or the assigned technician, again) comes into the session's Room. */
  'help.session.join': { req: { id: string; controlAvailable?: boolean }; res: { session: SupportSession; room: RoomInfo } };
  'help.session.end': { req: { id: string }; res: { ok: true } };
  /** The requester grants or takes back screen sharing or control; recorded on the ticket and in the audit log. */
  'help.consent': { req: { id: string; kind: 'screen' | 'control'; on: boolean; scope?: 'screen' | 'window' }; res: SupportSession };
  /** The technician asks the requester for something (each needs the requester's own yes). */
  'help.ask': { req: { id: string; kind: 'screen' | 'control' | 'diagnostics' }; res: { ok: true } };
  /** People with the IT capability. */
  'help.staff': { req: void; res: string[] };
  'admin.help.staff': { req: { userId: string; on: boolean }; res: string[] };
  // ------------------------------------------------------------ lounges
  'lounge.list': { req: { convId?: string } | void; res: Lounge[] };
  'lounge.create': { req: { convId: string; name: string }; res: Lounge };
  'lounge.rename': { req: { id: string; name: string }; res: Lounge };
  'lounge.archive': { req: { id: string; archived: boolean }; res: Lounge };
  /** Come into a lounge (audio only; screen sharing allowed). */
  'lounge.join': { req: { id: string }; res: RoomInfo };
  /** Which lounge each person is in (the lounge's name only for Spaces you are in). */
  'lounge.presence': { req: void; res: Array<{ userId: string; loungeId: string; name: string | null }> };
  // ------------------------------------------------------------ live pointers
  /** A small message to everyone else in your Room (pointers when the data channel is not there, e.g. on the relay). */
  'room.data': { req: { roomId: string; data: unknown }; res: { ok: true } };
  /** In a lounge: you started or stopped speaking (the Space sees a live pip on the lounge). */
  'room.speaking': { req: { roomId: string; speaking: boolean }; res: { ok: true } };
  /** Look at a file or whiteboard together: join its pointer session (invite: tell the conversation). */
  'point.join': { req: { surface: string; convId?: string; invite?: boolean; name?: string }; res: PointSession };
  'point.leave': { req: { surface: string }; res: { ok: true } };
  'point.send': { req: { surface: string; data: unknown }; res: { ok: true } };
  /** The presenter (whoever opened the session) turns pointers on or off for everyone. */
  'point.set': { req: { surface: string; enabled: boolean }; res: PointSession };
  'search': {
    req: {
      q: string; convId?: string; limit?: number;
      /** Filters: who wrote it, Direct or Spaces, a date range (ms), only messages with files. */
      from?: string; kind?: 'direct' | 'space'; after?: number; before?: number; hasFile?: boolean;
      /** Page further back: only results older than this message id. */
      olderThan?: string;
    };
    res: { messages: Array<{ message: Message; snippet: string }>; files: Array<FileInfo & { messageId: string; convId: string; textMatch?: string }> };
  };
}
export type OpName = keyof Ops;

/** #tags in message text: a letter first, then letters, digits, _ or - (not inside words or links). */
export const HASHTAG_RE = /(?<![\p{L}\p{N}&/#])#([\p{L}][\p{L}\p{N}_-]{1,48})/gu;
export const hashtags = (body: string): string[] => [...new Set([...body.matchAll(HASHTAG_RE)].map((m) => m[1].toLowerCase()))].slice(0, 20);

// Server-pushed events.
export interface Events extends FlowEvents, BotEvents {
  'presence': { userId: string; online: boolean; away?: boolean };
  'user.updated': PublicUser;
  'user.added': PublicUser;
  'admin.pending': DeviceRecord;
  'policy.updated': OfficePolicy;
  'emoji.updated': CustomEmoji[];
  'sticker.updated': Sticker[];
  'widgets.updated': Widget[];
  'lines.updated': OfficeLine[];
  'org.updated': OrgInfo;
  /** One of your devices was added with a pairing code. */
  'me.devicePaired': DeviceRecord;
  'device.updated': DeviceRecord;
  /** The viewer's copy of a conversation changed (new member, name, unread counts...). */
  'conv.updated': Conversation;
  'conv.removed': { convId: string };
  'msg.new': Message;
  'msg.updated': Message;
  /** Messages removed for good (retention). */
  'msg.removed': { convId: string; messageIds: string[] };
  'typing': { convId: string; userId: string; parentId: string | null };
  'read': { convId: string; userId: string; messageId: string };
  'room.ring': { room: RoomInfo; from: string };
  'room.updated': RoomInfo;
  'room.ended': { roomId: string; convId: string; missed: boolean; startedBy: string; durationMs: number; /** a host ended it for everyone */ endedBy?: string };
  'room.signal': { roomId: string; fromDevice: string; fromUser: string; data: unknown };
  'room.busy': { userId: string; inRoom: boolean };
  /** To a device waiting in a meeting's lobby: let in (join now), turned away, or still waiting. */
  'meet.lobby': { meetingId: string; state: 'admitted' | 'denied' | 'waiting'; reason?: 'admit' | 'host' };
  /** To one device: a host muted you (the app turns the microphone off). */
  'room.muted': { roomId: string; by: string };
  /** To one device: a host asks you to unmute. */
  'room.unmuteAsk': { roomId: string; by: string };
  /** To one device: a host took you out of the meeting. */
  'room.removed': { roomId: string; by: string };
  'room.reaction': { roomId: string; deviceId: string; userId: string; emoji: string; at: number };
  /** Administrators: how many reports wait. */
  'admin.reports': { open: number };
  /** Someone's calendar says they are in a meeting now (or no longer). */
  'meeting.busy': { userId: string; inMeeting: boolean };
  'star.updated': { messageId: string; on: boolean };
  'work.updated': WorkState;
  /** Someone's devices or encryption keys changed. */
  'e2e.keysChanged': { userId: string; deviceId: string };
  'note.updated': Note;
  'note.removed': { id: string };
  'board.op': { boardId: string; seq: number; userId: string; op: BoardOp };
  'board.updated': Board;
  'board.removed': { boardId: string };
  'cal.updated': CalEvent;
  /** You were invited (only to the new attendees). */
  'cal.invited': CalEvent;
  'cal.removed': { eventId: string };
  /** A meeting is about to start. */
  'cal.reminder': Occurrence;
  'cal.venues': Venue[];
  /** A reminder went off (to the person reminded). */
  'reminder.due': Reminder;
  'reminder.updated': Reminder;
  'reminder.removed': { id: string };
  'sched.updated': ScheduledMessage;
  'sched.removed': { id: string; sentMessageId: string | null };
  'help.updated': HelpTicket;
  'help.entry': HelpEntry;
  /** A support session started, changed (consent) or ended. */
  'help.session': SupportSession;
  /** To the requester: the technician asks for screen, control or diagnostics. */
  'help.ask': { ticketId: string; kind: 'screen' | 'control' | 'diagnostics'; by: string };
  'help.staff': string[];
  'lounge.updated': Lounge;
  /** Someone came into or left a lounge (name is null for Spaces you are not in). */
  'lounge.where': { userId: string; loungeId: string | null; name: string | null };
  'room.data': { roomId: string; fromDevice: string; fromUser: string; data: unknown };
  'point.data': { surface: string; fromDevice: string; fromUser: string; data: unknown };
  'point.session': PointSession;
  /** Someone asks the conversation to look at a file with them. */
  'point.invite': { surface: string; convId: string; name: string; by: string };
}
export type EventName = keyof Events;

// ---------------------------------------------------------------- link cards
/** What a link points at. 'restricted' hides everything about something the viewer cannot see. */
export type LinkCardKind =
  | 'message' | 'conversation' | 'person' | 'file' | 'event' | 'task'
  | 'search' | 'workbook' | 'project' | 'component' | 'calculator' | 'tool'
  | 'folder' | 'path' | 'meeting'
  | 'web' | 'video' | 'repo' | 'issue' | 'pull' | 'pdf' | 'image'
  | 'restricted' | 'unavailable';

export interface LinkAction {
  kind: 'open' | 'reply' | 'join' | 'copy-path' | 'open-in-tool';
  label: string;
  /** What to open, copy or join: a dexconnect:// link, a tool link, a path or a web address. */
  target: string;
  /** For open-in-tool: the tool ('sleuth', 'sheets', 'project-opener', 'datum', 'folder', 'browser'). */
  tool?: string;
}

export interface LinkCardMeta {
  key: 'author' | 'updated' | 'size' | 'members' | 'status' | 'type' | 'site' | 'path' | 'when' | 'dimensions' | 'tool' | 'department' | 'replies' | 'location';
  label: string;
  value: string;
  /** For author: the person's id; for updated/when: the time (ms); for size: bytes. */
  ref?: string | number;
}

export interface LinkCard {
  url: string;
  kind: LinkCardKind;
  title: string | null;
  subtitle: string | null;
  meta: LinkCardMeta[];
  preview: {
    /** Message text or page description (plain text, at most 300 characters). */
    excerpt?: string;
    /** A file on the hub to show as a thumbnail (images). */
    fileId?: string;
    /** A picture on the web (og:image, a YouTube thumbnail, the image itself). */
    imageUrl?: string;
    favicon?: string;
  } | null;
  actions: LinkAction[];
  /** Ids behind an internal card, for the app to act on. */
  ref?: { convId?: string; messageId?: string; userId?: string; fileId?: string; eventId?: string; taskId?: string };
  /** Web pages: 'ok', or why there is no preview. */
  status?: 'ok' | 'disabled' | 'blocked' | 'failed';
  /** Why a preview failed or was blocked (plain English). */
  reason?: string;
  fetchedAt: number;
  /** Served from the hub's cache (web pages only). */
  cached?: boolean;
}

/** Administrators: web previews and which office-network hosts the hub may fetch. */
export interface LinkSettings {
  /** The hub fetches web pages to preview them (members). */
  externalPreviews: boolean;
  /** The same for guests (off by default: nothing about outside pages is fetched for them). */
  guestExternalPreviews: boolean;
  /** Host names on the office network the hub may fetch although they resolve to private addresses. */
  allowLanHosts: string[];
}

/** A side-track in a conversation anchored to one link. */
export interface LinkThread {
  convId: string;
  url: string;
  urlHash: string;
  rootMessageId: string;
  root: Message;
  /** The side-track was started now (with a new message holding the link). */
  created: boolean;
}

// ---------------------------------------------------------------- reaction insights
/** Descriptive numbers about a message's reactions. Reactions are not approvals. */
export interface ReactionInsights {
  messageId: string;
  convId: string;
  note: 'Reactions are not approvals';
  total: number;
  /** Distinct people who reacted. */
  people: number;
  distribution: Array<{ emoji: string; count: number; percent: number }>;
  /** Conversation members other than the author (integrations left out). */
  audience: {
    members: number;
    reacted: number;
    /** Read it (by read receipts) but did not react. */
    seenNoReaction: number;
    notSeen: number;
    /** Read receipts off, or a side-track reply (receipts cover the main timeline only). */
    unknown: number;
    reactedPercent: number;
    seenNoReactionPercent: number;
    /** False when read receipts cannot be shown to this viewer (theirs are off) or do not apply. */
    receipts: boolean;
  };
  timeline: { bucketMs: number; buckets: Array<{ start: number; added: number; removed: number; cumulative: number }> };
  firstAt: number | null;
  lastAt: number | null;
  /** Reactors per department (null for anonymous polls, or when the office has no departments). */
  byDepartment: Array<{ departmentId: string | null; name: string; members: number; reacted: number; percent: number }> | null;
  /** Announcements (Spaces where only moderators post, and the Office space): this message against the office's recent ones. */
  announcement: { responseRate: number; officeAverage: number | null; compared: number } | null;
  /** The message is an anonymous poll: only counts are given. */
  anonymous: boolean;
}

export interface Ops {
  /** A card for a link: internal links as the viewer may see them, web pages fetched by the hub (cached 24 h). */
  'links.preview': { req: { url: string }; res: LinkCard };
  /** Find or start the side-track about a link in a conversation (messageId: the message to anchor to, needed in Direct conversations). */
  'links.discuss': { req: { url: string; convId: string; messageId?: string }; res: LinkThread };
  /** The author removes (or brings back) the card for one link in their own message. */
  'links.hide': { req: { messageId: string; url: string; hidden: boolean }; res: Message };
  'admin.links.get': { req: void; res: LinkSettings };
  'admin.links.set': { req: Partial<LinkSettings>; res: LinkSettings };
  /** Who reacted how, and when; members of the conversation only. */
  'reactions.insights': { req: { messageId: string }; res: ReactionInsights };
}
