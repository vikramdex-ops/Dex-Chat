// Keeping the office going: nightly backups of the hub, offboarding someone who leaves (their
// devices signed out, what they looked after handed to a colleague) and a private calendar feed
// each person can add to Outlook or a phone. The types extend the hub protocol (protocol.ts) by
// declaration merging, so the request and event maps stay one map.
import type { PublicUser } from './protocol.ts';

// ---------------------------------------------------------------- backups
export interface BackupConfig {
  /** Where backups go: a second disk (E:\DexConnectBackup) or a network share (\\NAS\backups\dexconnect). Null: off. */
  folder: string | null;
  /** The nightly run, in the hub PC's time ("02:00"). */
  time: string;
  /** How many of each to keep: one a day, one a week, one a month. */
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
}

export const BACKUP_DEFAULTS: BackupConfig = { folder: null, time: '02:00', keepDaily: 14, keepWeekly: 8, keepMonthly: 12 };
/** No successful backup for this long and administrators are told. */
export const BACKUP_ALERT_MS = 2 * 86_400_000;

/** What the check after a run found in the copy. */
export interface BackupCheck {
  /** "ok" from SQLite's integrity check, or what it reported. */
  integrity: string;
  /** Rows in the main tables of the copy. */
  rows: Record<string, number>;
  /** Files the copy refers to, and how many of them were opened and compared by their hash. */
  files: number;
  hashed: number;
  /** Files the copy refers to that are not in the backup folder (removed from the hub while it ran). */
  missing: number;
}

export interface BackupRun {
  startedAt: number;
  finishedAt: number;
  ok: boolean;
  /** Started with "Back up now". */
  manual: boolean;
  /** The copy's folder name (2026-11-15_0200), when it was kept. */
  name: string | null;
  /** What went wrong, in plain words. */
  error: string | null;
  dbBytes: number;
  /** All the files this copy refers to, and the ones copied this time (the rest were already there). */
  filesBytes: number;
  filesAdded: number;
  bytesAdded: number;
  check: BackupCheck | null;
  /** Older copies removed by the keeping rules. */
  removed: number;
}

export interface BackupCopy {
  name: string;
  at: number;
  dbBytes: number;
  /** Why it is kept: the latest, the day's, the week's or the month's. */
  kept: Array<'latest' | 'daily' | 'weekly' | 'monthly'>;
}

export interface BackupStatus {
  config: BackupConfig;
  /** A run in progress, and what it is doing. */
  running: { since: number; step: string; manual: boolean } | null;
  lastRun: BackupRun | null;
  lastSuccess: BackupRun | null;
  nextRunAt: number | null;
  /** Shown in amber when backups need attention (none for two days, or none set up). */
  warning: string | null;
  copies: BackupCopy[];
  /** Everything in the backup folder: the copies' databases and the shared files. */
  folderBytes: number | null;
  history: BackupRun[];
}

// ---------------------------------------------------------------- offboarding
export type MeetingHandover = 'reassign' | 'cancel';

/** Everything that would change when someone is offboarded, for the administrator to check first. */
export interface OffboardPreview {
  user: PublicUser;
  devices: Array<{ id: string; hostname: string; lastSeen: number | null }>;
  pairingCodes: number;
  spacesOwned: Array<{ id: string; name: string }>;
  spacesModerated: Array<{ id: string; name: string }>;
  automations: Array<{ id: string; name: string; where: 'space' | 'direct' | 'office' }>;
  bots: Array<{ id: string; name: string }>;
  tools: Array<{ id: string; name: string }>;
  scheduled: number;
  remindersForOthers: number;
  remindersFromOthers: number;
  meetings: Array<{ id: string; title: string; startAt: number; repeats: boolean }>;
  tickets: Array<{ id: string; number: number; summary: string; role: 'technician' | 'requester' }>;
  webinars: Array<{ meetingId: string; title: string; startsAt: number; role: 'organiser' | 'co-organiser' }>;
  /** Messages they wrote: kept, under the office's retention rules and any legal hold. */
  messages: number;
  onHold: boolean;
}

/** What was done, kept with the departure. */
export interface OffboardSummary {
  devicesSignedOut: number;
  pairingCodesRevoked: number;
  spaces: number;
  moderated: number;
  automations: number;
  automationsTurnedOff: number;
  bots: number;
  tools: number;
  scheduledCancelled: number;
  reminders: number;
  meetingsReassigned: number;
  meetingsCancelled: number;
  tickets: number;
  ticketsClosed: number;
  webinars: number;
  calendarFeed: boolean;
}

export interface Departure {
  id: string;
  user: PublicUser;
  leftAt: number;
  by: string;
  /** The colleague who took over. */
  toId: string;
  meetings: MeetingHandover;
  note: string | null;
  summary: OffboardSummary;
  /** Set when an administrator gave them access again. */
  returnedAt: number | null;
}

/** For everyone: who has left, as shown in the Directory. */
export interface LeftPerson {
  user: PublicUser;
  leftAt: number;
  /** The colleague to ask instead. */
  contactId: string;
}

// ---------------------------------------------------------------- calendar feed
export interface CalendarFeedInfo {
  enabled: boolean;
  /** Only when it was just turned on or reset: the hub keeps a hash, not the address. */
  urls: {
    /** /cal/<token>.ics, for the app to join to the address it reaches the hub at. */
    path: string;
    /** On the office network: this hub's own addresses. */
    office: string[];
    /** Through the gateway, from anywhere (when access from outside is on). */
    outside: string | null;
  } | null;
  createdAt: number | null;
  lastFetchedAt: number | null;
  /** The gateway's address when access from outside is on (the feed also works there). */
  gateway: string | null;
}

/** /cal/<token>.ics: tokens are 43 URL-safe characters (32 random bytes). */
export const CAL_FEED_PATH_RE = /^\/cal\/([A-Za-z0-9_-]{43})\.ics$/;

// ---------------------------------------------------------------- the protocol, extended
declare module './protocol.ts' {
  interface PublicUser {
    /** Set while they have left the office (offboarded). */
    leftAt?: number | null;
  }
  interface Ops {
    'admin.backup.get': { req: void; res: BackupStatus };
    'admin.backup.set': { req: Partial<BackupConfig>; res: BackupStatus };
    /** "Back up now": starts a run (the status says when it finishes). */
    'admin.backup.run': { req: void; res: BackupStatus };
    'admin.offboard.preview': { req: { userId: string }; res: OffboardPreview };
    'admin.offboard.run': { req: { userId: string; toUserId: string; meetings: MeetingHandover; note?: string }; res: Departure };
    'admin.offboard.list': { req: void; res: Departure[] };
    /** Give access back (their devices sign in again); what was handed over stays with the colleague. */
    'admin.offboard.reactivate': { req: { userId: string }; res: { user: PublicUser; devices: number } };
    'directory.left': { req: void; res: LeftPerson[] };
    'cal.feed.get': { req: void; res: CalendarFeedInfo };
    /** Turn the private feed on (a new address) or off (the address stops working). */
    'cal.feed.set': { req: { enabled: boolean }; res: CalendarFeedInfo };
    /** A new address; the old one stops working at once. */
    'cal.feed.reset': { req: void; res: CalendarFeedInfo };
  }
  interface Events {
    /** Someone was offboarded: they leave everyone's list of colleagues (the Directory shows them under "Left the office"). */
    'user.left': { userId: string; leftAt: number; contactId: string };
    'admin.backup': BackupStatus;
    'admin.offboarded': Departure;
  }
}
