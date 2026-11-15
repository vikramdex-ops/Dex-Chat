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

/** One VEVENT in a VCALENDAR, with CRLF line ends and folded lines. */
export function buildIcs(inv: Invitation, when: string): string {
  const org = inv.organizer;
  const orgAddress = org.email && /^[^\s@<>"]+@[^\s@<>"]+$/.test(org.email)
    ? `mailto:${org.email}`
    : `urn:dexconnect:${encodeURIComponent(inv.office.toLowerCase().replace(/\s+/g, '-'))}:${encodeURIComponent(org.id)}`;
  const cn = org.name.replace(/["\\]/g, '').replace(/[\r\n]/g, ' ');
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
    `LOCATION:${icsText(inv.location?.trim() || inv.guestUrl || inv.appLink)}`,
    ...(inv.guestUrl ? [`URL:${inv.guestUrl}`] : []),
    `ORGANIZER;CN="${cn}":${orgAddress}`,
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${props.map(icsFold).join('\r\n')}\r\n`;
}
