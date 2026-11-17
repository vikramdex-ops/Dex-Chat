// Meeting invitations for people outside the office: an iCalendar file (RFC 5545) with one VEVENT
// that any calendar opens (Outlook, Google, Apple), and the same invitation as plain text to paste
// into an email. Times are written in UTC, so no time-zone table is needed.

export interface Invitation {
  /** Stable for the meeting, so a second invitation updates the first in people's calendars. */
  uid: string;
  title: string;
  startAt: number;
  endAt: number;
  organizer: { name: string; email: string | null; id: string };
  /** The office's name, used in the organiser's address when they have no email. */
  office: string;
  meetingId: string;
  /** The browser link for guests (with the passcode after #), or null when guests cannot join. */
  guestUrl: string | null;
  /** The meeting's page on the office's meeting site without the passcode (shown as the place). */
  pageUrl?: string | null;
  passcode: string | null;
  /** The app link for colleagues (dexconnect://meet/…). */
  appLink: string;
  description?: string | null;
  location?: string | null;
  /** Bumped when the meeting is changed. */
  sequence?: number;
  /** When this file was made (DTSTAMP). */
  stamp?: number;
  /** The calendar entry's text, in place of the meeting invitation's (a webinar's personal link). */
  text?: string;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** 20261114T093000Z */
export function icsTime(t: number): string {
  const d = new Date(t);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

/** TEXT values: backslash, semicolon, comma and newlines escaped. */
export function icsText(s: string): string {
  return s.replace(/\r\n?/g, '\n').replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
}

/** Lines longer than 75 octets are folded: CRLF and one space, never inside a UTF-8 character. */
export function icsFold(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let cur = '';
  let curBytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    const max = parts.length ? 74 : 75; // continuation lines start with a space
    if (curBytes + b > max) { parts.push(cur); cur = ''; curBytes = 0; }
    cur += ch;
    curBytes += b;
  }
  if (cur) parts.push(cur);
  return parts.join('\r\n ');
}

const fmtId = (id: string) => (/^\d{9}$/.test(id) ? `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}` : id);

/** The invitation as plain text: what to paste into an email or a chat with someone outside. */
export function invitationText(inv: Invitation, when: string): string {
  const lines = [
    `${inv.organizer.name} invites you to a meeting: ${inv.title}`,
    when,
    '',
  ];
  if (inv.guestUrl) {
    lines.push('Join from your browser (nothing to install):', inv.guestUrl);
    if (inv.passcode) lines.push(`Passcode: ${inv.passcode}`);
    lines.push('You wait in the lobby until the host lets you in.', '');
  }
  lines.push(`Colleagues with Dexterity Connect: ${inv.appLink}`, `Meeting ID: ${fmtId(inv.meetingId)}`);
  if (inv.description?.trim()) lines.push('', inv.description.trim());
  return lines.join('\n');
}

/** The organiser as a calendar address: their email, or a stable address in the office's name. */
function organizerLine(org: { name: string; email: string | null; id: string }, office: string): string {
  const address = org.email && /^[^\s@<>"]+@[^\s@<>"]+$/.test(org.email)
    ? `mailto:${org.email}`
    : `urn:dexconnect:${encodeURIComponent(office.toLowerCase().replace(/\s+/g, '-'))}:${encodeURIComponent(org.id)}`;
  const cn = org.name.replace(/["\\]/g, '').replace(/[\r\n]/g, ' ');
  return `ORGANIZER;CN="${cn}":${address}`;
}

/** One VEVENT in a VCALENDAR, with CRLF line ends and folded lines. */
export function buildIcs(inv: Invitation, when: string): string {
  const props = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Dexterity Design Services//Dexterity Connect//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${inv.uid}`,
    `DTSTAMP:${icsTime(inv.stamp ?? Date.now())}`,
    `DTSTART:${icsTime(inv.startAt)}`,
    `DTEND:${icsTime(Math.max(inv.endAt, inv.startAt + 60_000))}`,
    `SEQUENCE:${Math.max(0, Math.floor(inv.sequence ?? 0))}`,
    `SUMMARY:${icsText(inv.title)}`,
    `DESCRIPTION:${icsText(inv.text ?? invitationText(inv, when))}`,
    // the place shows in calendars (and on shared screens): the clean page without the passcode;
    // URL, the one-click link, carries it in its #fragment, which no server receives
    `LOCATION:${icsText([inv.location?.trim(), inv.pageUrl || inv.guestUrl || inv.appLink].filter(Boolean).join(' · '))}`,
    ...(inv.guestUrl ? [`URL:${inv.guestUrl}`] : []),
    organizerLine(inv.organizer, inv.office),
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${props.map(icsFold).join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------- a person's calendar feed
/** One meeting in a subscribed calendar (Outlook, a phone): read-only, refreshed by the calendar app. */
export interface FeedEvent {
  /** Stable for the meeting, so a change updates the entry already in people's calendars. */
  uid: string;
  title: string;
  startAt: number;
  endAt: number;
  allDay: boolean;
  recurrence: 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly';
  /** The last time a repeating meeting may start. */
  until: number | null;
  description: string | null;
  location: string | null;
  /** A link to open it (dexconnect://meet/… for a meeting held as a call). */
  url: string | null;
  organizer: { name: string; email: string | null; id: string };
  /** Bumped on every change, so calendars replace their copy. */
  sequence: number;
  /** When it was last changed. */
  modifiedAt: number;
  cancelled: boolean;
  /** Your own answer: a meeting you said maybe to shows as tentative. */
  tentative?: boolean;
}

export interface Feed {
  /** The calendar's name in Outlook or on the phone. */
  name: string;
  /** The office's name, for organiser addresses. */
  office: string;
  events: FeedEvent[];
  /** When the feed was made (DTSTAMP). */
  stamp?: number;
  /** Stop adding meetings once the feed is this long (characters); the nearest meetings come first. */
  maxLength?: number;
}

/** 20261115, in the hub's own time: all-day meetings are whole days where the office is. */
function icsDate(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

const RRULE: Record<Exclude<FeedEvent['recurrence'], 'none'>, string> = {
  daily: 'FREQ=DAILY', weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', weekly: 'FREQ=WEEKLY', monthly: 'FREQ=MONTHLY',
};

function feedEvent(e: FeedEvent, office: string, stamp: number): string[] {
  const lines = ['BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${icsTime(stamp)}`];
  if (e.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${icsDate(e.startAt)}`, `DTEND;VALUE=DATE:${icsDate(Math.max(e.endAt, e.startAt + 86_400_000))}`);
  } else {
    lines.push(`DTSTART:${icsTime(e.startAt)}`, `DTEND:${icsTime(Math.max(e.endAt, e.startAt + 60_000))}`);
  }
  if (e.recurrence !== 'none') {
    const until = e.until === null ? '' : `;UNTIL=${e.allDay ? icsDate(e.until) : icsTime(e.until)}`;
    lines.push(`RRULE:${RRULE[e.recurrence]}${until}`);
  }
  lines.push(
    `SEQUENCE:${Math.max(0, Math.floor(e.sequence))}`,
    `LAST-MODIFIED:${icsTime(e.modifiedAt)}`,
    `SUMMARY:${icsText(e.title)}`,
  );
  if (e.description?.trim()) lines.push(`DESCRIPTION:${icsText(e.description.trim())}`);
  if (e.location?.trim()) lines.push(`LOCATION:${icsText(e.location.trim())}`);
  if (e.url && /^[a-z][a-z0-9+.-]*:\S+$/i.test(e.url)) lines.push(`URL:${e.url}`);
  lines.push(
    organizerLine(e.organizer, office),
    `STATUS:${e.cancelled ? 'CANCELLED' : e.tentative ? 'TENTATIVE' : 'CONFIRMED'}`,
    `TRANSP:${e.cancelled ? 'TRANSPARENT' : 'OPAQUE'}`,
    'END:VEVENT',
  );
  return lines.map(icsFold);
}

/**
 * A whole calendar to subscribe to (RFC 5545, METHOD:PUBLISH): every meeting as a VEVENT with its
 * UID, SEQUENCE and LAST-MODIFIED, so calendars update or cancel what they already show.
 */
export function buildCalendarFeed(feed: Feed): string {
  const stamp = feed.stamp ?? Date.now();
  const head = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Dexterity Design Services//Dexterity Connect//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsText(feed.name)}`,
    `NAME:${icsText(feed.name)}`,
    'X-PUBLISHED-TTL:PT1H',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
  ].map(icsFold);
  const tail = 'END:VCALENDAR';
  const max = feed.maxLength ?? Number.POSITIVE_INFINITY;
  // nearest to now first, so a long history is what gets left out
  const order = [...feed.events].sort((a, b) => Math.abs(a.startAt - stamp) - Math.abs(b.startAt - stamp));
  let length = head.join('\r\n').length + tail.length + 4;
  const blocks: Array<{ at: number; text: string }> = [];
  for (const e of order) {
    const text = feedEvent(e, feed.office, stamp).join('\r\n');
    if (length + text.length + 2 > max) break;
    length += text.length + 2;
    blocks.push({ at: e.startAt, text });
  }
  blocks.sort((a, b) => a.at - b.at);
  return `${[...head, ...blocks.map((b) => b.text), tail].join('\r\n')}\r\n`;
}
