// Zoho Calendar sync: the office's Zoho data centres, the times and repeat rules Zoho's Calendar
// API reads and writes, and the operations the hub answers (apps/hub/src/zoho.ts). The types
// extend the hub protocol (protocol.ts) by declaration merging. See docs/ZOHO-CALENDAR.md.
import type { Recurrence } from './protocol.ts';

// ---------------------------------------------------------------- data centres
/** Zoho keeps each account in one data centre; the office's default is India (Chennai). */
export type ZohoDc = 'in' | 'com' | 'eu' | 'au' | 'jp' | 'ca' | 'sa' | 'uk' | 'cn';

export interface ZohoDcInfo {
  label: string;
  /** The accounts server: sign-in, tokens and revoking. */
  accounts: string;
  /** Zoho Calendar's API in that data centre (…/api/v1). */
  calendar: string;
}

export const ZOHO_DCS: Record<ZohoDc, ZohoDcInfo> = {
  in: { label: 'India (zoho.in)', accounts: 'https://accounts.zoho.in', calendar: 'https://calendar.zoho.in' },
  com: { label: 'United States (zoho.com)', accounts: 'https://accounts.zoho.com', calendar: 'https://calendar.zoho.com' },
  eu: { label: 'Europe (zoho.eu)', accounts: 'https://accounts.zoho.eu', calendar: 'https://calendar.zoho.eu' },
  au: { label: 'Australia (zoho.com.au)', accounts: 'https://accounts.zoho.com.au', calendar: 'https://calendar.zoho.com.au' },
  jp: { label: 'Japan (zoho.jp)', accounts: 'https://accounts.zoho.jp', calendar: 'https://calendar.zoho.jp' },
  ca: { label: 'Canada (zohocloud.ca)', accounts: 'https://accounts.zohocloud.ca', calendar: 'https://calendar.zohocloud.ca' },
  sa: { label: 'Saudi Arabia (zoho.sa)', accounts: 'https://accounts.zoho.sa', calendar: 'https://calendar.zoho.sa' },
  uk: { label: 'United Kingdom (zoho.uk)', accounts: 'https://accounts.zoho.uk', calendar: 'https://calendar.zoho.uk' },
  cn: { label: 'China (zoho.com.cn)', accounts: 'https://accounts.zoho.com.cn', calendar: 'https://calendar.zoho.com.cn' },
};

export const ZOHO_DEFAULT_DC: ZohoDc = 'in';

/** The `location` Zoho adds to the sign-in redirect ("in", "us", "eu"…) as one of ours. */
export function zohoDcFromLocation(location: unknown): ZohoDc | null {
  if (typeof location !== 'string') return null;
  const l = location.trim().toLowerCase();
  if (l === 'us' || l === 'com') return 'com';
  if (l === 'cn' || l === 'com.cn') return 'cn';
  if (l === 'com.au') return 'au';
  return l in ZOHO_DCS ? l as ZohoDc : null;
}

/** What the hub asks Zoho for: one calendar's events, the calendar list, and the account's email. */
export const ZOHO_SCOPES = ['ZohoCalendar.calendar.READ', 'ZohoCalendar.event.ALL', 'AaaServer.profile.Read'];
/** The loopback address the desktop app listens on for Zoho's answer (registered in Zoho's console). */
export const ZOHO_CALLBACK_PORT = 47917;
export const ZOHO_CALLBACK_PATH = '/zoho/callback';
export const zohoRedirectUri = (port = ZOHO_CALLBACK_PORT) => `http://127.0.0.1:${port}${ZOHO_CALLBACK_PATH}`;

// ---------------------------------------------------------------- times
const pad = (n: number) => String(n).padStart(2, '0');

/** The date and time parts of an instant on the clock of a time zone. */
export function zonedParts(t: number, zone: string): { y: number; m: number; d: number; hh: number; mm: number; ss: number; dow: number } {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hourCycle: 'h23' });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(t))) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour % 24, mm: +p.minute, ss: +p.second, dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}

/** Minutes a zone is ahead of UTC at an instant (330 for India). */
export function zoneOffsetMinutes(t: number, zone: string): number {
  const p = zonedParts(t, zone);
  return Math.round((Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(t / 1000) * 1000) / 60_000);
}

/** The instant a wall-clock time happens in a zone (the earlier one when clocks go back). */
export function zonedTime(y: number, m: number, d: number, hh: number, mm: number, zone: string, ss = 0): number {
  const guess = Date.UTC(y, m - 1, d, hh, mm, ss);
  let t = guess - zoneOffsetMinutes(guess, zone) * 60_000;
  t = guess - zoneOffsetMinutes(t, zone) * 60_000;
  return t;
}

/** 20261118T043000Z: what Zoho's Calendar API takes for a timed event's start and end. */
export function zohoUtc(t: number): string {
  const d = new Date(t);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** 20261118: an all-day event's day, on the clock of its zone. */
export function zohoDay(t: number, zone: string): string {
  const p = zonedParts(t, zone);
  return `${p.y}${pad(p.m)}${pad(p.d)}`;
}

/**
 * A time as Zoho writes it back: 20261118T043000Z, 20261118T100000+0530 (or +05:30), or a day
 * (20261118) for all-day events, which is midnight on the clock of `zone`. Null when unreadable.
 */
export function parseZohoTime(s: unknown, zone: string): number | null {
  if (typeof s !== 'string') return null;
  const v = s.trim();
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m) return zonedTime(+m[1], +m[2], +m[3], 0, 0, zone);
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z|[+-]\d{2}:?\d{2})?$/.exec(v);
  if (!m) return null;
  const [y, mo, d, hh, mi, ss] = m.slice(1, 7).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mi > 59 || ss > 60) return null;
  const tz = m[7];
  if (!tz) return zonedTime(y, mo, d, hh, mi, zone, ss);
  const base = Date.UTC(y, mo - 1, d, hh, mi, ss);
  if (tz === 'Z') return base;
  const sign = tz[0] === '-' ? -1 : 1;
  const digits = tz.slice(1).replace(':', '');
  return base - sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60_000;
}

/**
 * The repeat rule for Zoho (RFC 5545 RRULE without "RRULE:"), or null when Zoho's rule would not
 * give the same days as Dexterity Connect and the times must be written one by one instead:
 * monthly on the 29th–31st (Dexterity moves those to the month's last day, a rule skips the month)
 * and weekdays starting on a weekend. `zone` is the zone the repeats are counted in.
 */
export function zohoRrule(recurrence: Recurrence, startAt: number, until: number | null, zone: string): string | null {
  const p = zonedParts(startAt, zone);
  const end = until !== null ? `;UNTIL=${zohoUtc(until)}` : '';
  switch (recurrence) {
    case 'none': return null;
    case 'daily': return `FREQ=DAILY;INTERVAL=1${end}`;
    case 'weekly': return `FREQ=WEEKLY;INTERVAL=1${end}`;
    case 'weekdays': return p.dow === 0 || p.dow === 6 ? null : `FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR${end}`;
    case 'monthly': return p.d > 28 ? null : `FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=${p.d}${end}`;
  }
  return null;
}

// ---------------------------------------------------------------- what people and administrators see
export type ZohoState = 'off' | 'not-connected' | 'connected' | 'reconnect';

export interface ZohoCalendarChoice { uid: string; name: string; isDefault: boolean }

/** Preferences → Calendar: one person's connection. Never holds a token. */
export interface ZohoStatus {
  /** The office has set Zoho up (an administrator, once, in the Control room). */
  available: boolean;
  state: ZohoState;
  /** The Zoho account's email, when Zoho told us. */
  email: string | null;
  calendarUid: string | null;
  calendarName: string | null;
  calendars: ZohoCalendarChoice[];
  connectedAt: number | null;
  /** Last time both directions ran without an error. */
  lastSyncAt: number | null;
  /** Last time Zoho events were read. */
  lastPullAt: number | null;
  /** The last problem, in words (no event contents). */
  lastError: string | null;
  lastErrorAt: number | null;
  /** Meetings copied to Zoho, and Zoho events shown here. */
  pushed: number;
  imported: number;
  /** Changes made in Zoho to Dexterity's own meetings that were put back. */
  restored: number;
}

/** Control room → Integrations → Zoho Calendar: the office's client and who is connected. */
export interface ZohoAdminView {
  configured: boolean;
  enabled: boolean;
  dc: ZohoDc;
  clientId: string | null;
  /** The client secret is never sent back once saved. */
  hasSecret: boolean;
  /** To register in Zoho's API console, exactly as written. */
  redirectUri: string;
  scopes: string[];
  people: Array<{
    userId: string;
    state: ZohoState;
    email: string | null;
    calendarName: string | null;
    connectedAt: number | null;
    lastSyncAt: number | null;
    lastError: string | null;
    lastErrorAt: number | null;
    pushed: number;
    imported: number;
  }>;
}

/** What Zoho sent to the desktop app's loopback address after sign-in. */
export interface ZohoCallback {
  state: string;
  code?: string;
  error?: string;
  location?: string;
  accountsServer?: string;
}

declare module './protocol.ts' {
  interface Ops {
    'zoho.status': { req: void; res: ZohoStatus };
    /** The Zoho sign-in address for this person (state is kept by the hub for ten minutes). */
    'zoho.connect.start': { req: void; res: { authUrl: string; state: string; redirectUri: string } };
    /** Zoho's answer from the loopback page; the hub exchanges the code with the office's client secret. */
    'zoho.connect.finish': { req: ZohoCallback; res: ZohoStatus };
    /** Stop syncing: copies of future meetings are removed from Zoho and the access is revoked. */
    'zoho.disconnect': { req: void; res: ZohoStatus };
    'zoho.calendar.set': { req: { calendarUid: string }; res: ZohoStatus };
    'zoho.syncNow': { req: void; res: ZohoStatus };
    'admin.zoho.get': { req: void; res: ZohoAdminView };
    /** `clientSecret`: a new one replaces the saved one; empty keeps it; null removes it. */
    'admin.zoho.set': { req: { dc?: ZohoDc; clientId?: string | null; clientSecret?: string | null; enabled?: boolean }; res: ZohoAdminView };
  }
  interface Events {
    'zoho.status': ZohoStatus;
    'admin.zoho': ZohoAdminView;
  }
}
