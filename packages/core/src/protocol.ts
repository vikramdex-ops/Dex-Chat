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
export interface CustomEmoji { name: string; fileId: string; createdBy: string; createdAt: number }

/** Office rules set by an administrator. */
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
export type FormFieldType = 'text' | 'long' | 'choice' | 'multi' | 'number' | 'date';
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
  /** This person is recording the call (everyone is shown that). */
  recording?: boolean;
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
  | { t: 'register'; deviceId: string; publicKey: string; account: WindowsAccount; sig: string; /** guest invite code */ invite?: string }
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
  'me.update': { req: { readReceipts?: boolean; statusEmoji?: string | null; displayName?: string; title?: string | null; statusText?: string | null; availability?: Availability; /** availability lasts until */ until?: number | null; ooo?: { until: number; message?: string | null; delegateId?: string | null } | null }; res: PublicUser };
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
  /** Slack-compatible incoming webhooks: a URL that posts into one Space as an integration. */
  'admin.hooks.list': { req: void; res: Array<{ id: string; botId: string; convId: string; convName: string; createdAt: number; lastUsed: number | null }> };
  'admin.hooks.create': { req: { botId: string; convId: string }; res: { id: string; path: string } };
  'admin.hooks.revoke': { req: { id: string }; res: { ok: true } };
  /** Give an integration slash commands that call its webhook. Returns the signing secret once. */
  'admin.bots.commands': { req: { userId: string; webhookUrl: string; commands: Array<{ command: string; description: string }> }; res: { secret: string } };
  'cmd.list': { req: void; res: SlashCommand[] };
  /** Run an integration's command; its reply is posted (or, if it asks, shown only to you). */
  'cmd.run': { req: { convId: string; command: string; text: string; parentId?: string }; res: { text: string | null; ephemeral: boolean } };
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
  /** Ring more of the conversation's members into a running call. */
  'room.invite': { req: { roomId: string; userIds: string[] }; res: RoomInfo };
  'room.record': { req: { roomId: string; on: boolean }; res: { ok: true } };
  'conv.markUnread': { req: { convId: string; messageId: string }; res: Conversation };
  'msg.forward': { req: { messageId: string; convIds: string[]; note?: string; /** per target: the text to post (re-sealed by the app for encrypted Directs) */ bodies?: Record<string, string> }; res: Message[] };
  'msg.star': { req: { messageId: string; on: boolean }; res: { ok: true } };
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

// Server-pushed events.
export interface Events {
  'presence': { userId: string; online: boolean; away?: boolean };
  'user.updated': PublicUser;
  'user.added': PublicUser;
  'admin.pending': DeviceRecord;
  'policy.updated': OfficePolicy;
  'emoji.updated': CustomEmoji[];
  'org.updated': OrgInfo;
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
  'room.ended': { roomId: string; convId: string; missed: boolean; startedBy: string; durationMs: number };
  'room.signal': { roomId: string; fromDevice: string; fromUser: string; data: unknown };
  'room.busy': { userId: string; inRoom: boolean };
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
}
export type EventName = keyof Events;
