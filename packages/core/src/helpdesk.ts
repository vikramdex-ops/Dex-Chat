// The help desk: people ask IT for help from inside the app, IT works a queue of tickets, and a
// technician may open a support session (a two-person Room) in which the requester shares their
// screen, sends diagnostics, swaps files and, after a second consent, lets the technician use
// their mouse and keyboard. These are the records the hub keeps and sends.

export type HelpCategory = 'hardware' | 'software' | 'network' | 'printing' | 'account' | 'drawings' | 'other';

/** Categories in the order the request form lists them, with the words people see. */
export const HELP_CATEGORIES: ReadonlyArray<{ id: HelpCategory; label: string; hint: string }> = [
  { id: 'software', label: 'An application', hint: 'CAD, Office, a tool that will not open or crashes' },
  { id: 'hardware', label: 'This PC or a device', hint: 'Screen, keyboard, mouse, headset, slow PC' },
  { id: 'network', label: 'Network or internet', hint: 'Shared drives, Wi-Fi, VPN, the hub' },
  { id: 'printing', label: 'Printing and plotting', hint: 'Printers, plotters, scanners' },
  { id: 'account', label: 'Sign-in and access', hint: 'Passwords, permissions, a locked account' },
  { id: 'drawings', label: 'Drawings and files', hint: 'A file that will not open, a lost revision' },
  { id: 'other', label: 'Something else', hint: '' },
];

/** open: waiting in the IT queue; taken: a technician is on it; closed: done (the requester can reopen it). */
export type TicketStatus = 'open' | 'taken' | 'closed';

export type HelpFileKind = 'screenshot' | 'diagnostics' | 'file';

export interface HelpFile {
  fileId: string;
  name: string;
  size: number;
  mime: string;
  kind: HelpFileKind;
  /** Who attached it. */
  by: string;
  at: number;
}

/** What the requester has allowed in a support session right now. */
export interface SupportConsent {
  /** Their screen (or one window) is shared with the technician. */
  screen: boolean;
  /** 'screen' for a whole display, 'window' for one window; null while not sharing. */
  scope: 'screen' | 'window' | null;
  /** The technician may use their mouse and keyboard (needs the whole screen shared). */
  control: boolean;
  /** When the current screen share and the current control grant began. */
  screenSince: number | null;
  controlSince: number | null;
}

export interface SupportSession {
  id: string;
  ticketId: string;
  /** The Room the session's sound, screen and data channel travel in. */
  roomId: string | null;
  requesterId: string;
  techId: string;
  startedAt: number;
  endedAt: number | null;
  consent: SupportConsent;
  /** The requester's PC can take remote mouse and keyboard input (Windows and Linux; not macOS). */
  controlAvailable: boolean;
}

export interface HelpTicket {
  id: string;
  /** Running number shown as T-0042. */
  number: number;
  requesterId: string;
  summary: string;
  detail: string;
  category: HelpCategory;
  status: TicketStatus;
  techId: string | null;
  createdAt: number;
  updatedAt: number;
  takenAt: number | null;
  closedAt: number | null;
  /** 1 to 5, from the requester after a session or when closing. */
  rating: number | null;
  ratingNote: string | null;
  /** The requester's platform when they asked (win32, darwin, linux, android). */
  platform: string | null;
  files: HelpFile[];
  /** The support session while one runs. */
  session: SupportSession | null;
}

export type HelpEntryKind =
  | 'opened' | 'taken' | 'released' | 'note' | 'file' | 'diagnostics'
  | 'session.started' | 'session.joined' | 'session.ended'
  | 'consent.granted' | 'consent.revoked' | 'asked'
  | 'closed' | 'reopened' | 'rated';

/** One line of a ticket's timeline. */
export interface HelpEntry {
  id: string;
  ticketId: string;
  at: number;
  actor: string | null;
  kind: HelpEntryKind;
  text: string | null;
  detail: Record<string, unknown> | null;
}

/** "T-0042" */
export const ticketRef = (n: number): string => `T-${String(Math.max(0, Math.floor(n))).padStart(4, '0')}`;
