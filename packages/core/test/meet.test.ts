// Guest links, passcodes and meeting invitations (.ics).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PASSCODE_RE, guestUrl, isWebGuest, isWebGuestDevice, parseRecordingLink, passcodeFrom, recordingLink, visitorNames } from '../src/meet.ts';
import { buildIcs, icsFold, icsText, icsTime, invitationText } from '../src/ics.ts';
import type { Invitation } from '../src/ics.ts';

test('passcodes are 6 to 10 unambiguous letters and digits, from unbiased bytes', () => {
  const bytes = new Uint8Array(64).map((_, i) => (i * 37 + 11) % 256);
  const code = passcodeFrom(bytes, 8);
  assert.equal(code.length, 8);
  assert.match(code, PASSCODE_RE);
  assert.doesNotMatch(code, /[0O1lI]/);
  assert.match(passcodeFrom(bytes, 6), PASSCODE_RE);
  assert.match(passcodeFrom(bytes, 10), PASSCODE_RE);
  // bytes at the top of the range are skipped rather than wrapped onto some letters
  assert.throws(() => passcodeFrom(new Uint8Array(32).fill(255), 8), /Not enough random bytes/);
  assert.ok(!PASSCODE_RE.test('abc12'));
  assert.ok(!PASSCODE_RE.test('abcdefghijk'));
  assert.ok(!PASSCODE_RE.test('abc 123'));
});

test('a guest link keeps the passcode in the fragment', () => {
  const url = guestUrl('https://gw.example.workers.dev/', '482913207', 'Hx7kP2qR');
  assert.equal(url, 'https://gw.example.workers.dev/m/482913207#Hx7kP2qR');
  const u = new URL(url);
  assert.equal(u.pathname, '/m/482913207');
  assert.equal(u.search, '');
  assert.equal(u.hash, '#Hx7kP2qR');
});

test('browser guests and recording links are recognised', () => {
  assert.ok(isWebGuest('guest:01J0000000000000000000000A'));
  assert.ok(!isWebGuest('01J0000000000000000000000A'));
  assert.ok(isWebGuestDevice('guestdev:01J0000000000000000000000A'));
  const link = recordingLink('abcdefghijklmnop_-123');
  assert.equal(parseRecordingLink(link), 'abcdefghijklmnop_-123');
  assert.equal(parseRecordingLink(` ${link}/ `), 'abcdefghijklmnop_-123');
  assert.equal(parseRecordingLink('dexconnect://recording/short'), null);
  assert.equal(parseRecordingLink('https://example.com'), null);
  assert.deepEqual([...visitorNames({ visitors: [{ userId: 'guest:a', deviceId: 'guestdev:a', name: 'Dana' }] })], [['guest:a', 'Dana']]);
});

const inv = (over: Partial<Invitation> = {}): Invitation => ({
  uid: 'meeting-482913207-ev1@dexconnect', title: 'Pump skid review; site, phase 2', startAt: Date.UTC(2026, 10, 18, 4, 30), endAt: Date.UTC(2026, 10, 18, 5, 30),
  organizer: { name: 'Priya Raman', email: 'priya@dexterity.example', id: 'U1' }, office: 'Dexterity Office',
  meetingId: '482913207', guestUrl: 'https://gw.example.workers.dev/m/482913207#Hx7kP2qR', passcode: 'Hx7kP2qR', appLink: 'dexconnect://meet/482-913-207',
  description: 'Bring the P&ID markups.', stamp: Date.UTC(2026, 10, 14, 12, 0), ...over,
});

test('iCalendar text: UTC times, escaping and folding at 75 octets', () => {
  assert.equal(icsTime(Date.UTC(2026, 0, 2, 3, 4, 5)), '20260102T030405Z');
  assert.equal(icsText('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne');
  const long = `DESCRIPTION:${'x'.repeat(200)}`;
  const folded = icsFold(long);
  for (const l of folded.split('\r\n')) assert.ok(new TextEncoder().encode(l).length <= 75, l);
  assert.equal(folded.split('\r\n').map((l, i) => (i ? l.slice(1) : l)).join(''), long);
  // multi-byte characters are never split
  const hindi = icsFold(`SUMMARY:${'बैठक '.repeat(30)}`);
  assert.ok(!hindi.includes('�'));
  assert.equal(hindi.split('\r\n').map((l, i) => (i ? l.slice(1) : l)).join(''), `SUMMARY:${'बैठक '.repeat(30)}`);
});

test('an invitation is one VEVENT with UID, UTC times, the organiser and the guest link', () => {
  const ics = buildIcs(inv(), 'Wednesday 18 November 2026, 10:00 – 11:00 (India Standard Time)');
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.equal(ics.match(/BEGIN:VEVENT/g)?.length, 1);
  assert.ok(!/[^\r]\n/.test(ics), 'every line ends with CRLF');
  const unfolded = ics.replace(/\r\n /g, '');
  assert.match(unfolded, /\r\nUID:meeting-482913207-ev1@dexconnect\r\n/);
  assert.match(unfolded, /\r\nDTSTART:20261118T043000Z\r\n/);
  assert.match(unfolded, /\r\nDTEND:20261118T053000Z\r\n/);
  assert.match(unfolded, /\r\nDTSTAMP:20261114T120000Z\r\n/);
  assert.match(unfolded, /\r\nORGANIZER;CN="Priya Raman":mailto:priya@dexterity.example\r\n/);
  assert.match(unfolded, /\r\nSUMMARY:Pump skid review\\; site\\, phase 2\r\n/);
  assert.match(unfolded, /\r\nURL:https:\/\/gw.example.workers.dev\/m\/482913207#Hx7kP2qR\r\n/);
  assert.match(unfolded, /Passcode: Hx7kP2qR/);
  assert.match(unfolded, /Meeting ID: 482-913-207/);
  // an organiser without an email still has a valid calendar address
  const noMail = buildIcs(inv({ organizer: { name: 'Ravi "R" Kumar', email: null, id: 'U2' } }), 'today').replace(/\r\n /g, '');
  assert.match(noMail, /\r\nORGANIZER;CN="Ravi R Kumar":urn:dexconnect:dexterity-office:U2\r\n/);
});

test('without a guest link the invitation is for colleagues only', () => {
  const text = invitationText(inv({ guestUrl: null, passcode: null }), 'Today 10:00');
  assert.doesNotMatch(text, /browser|Passcode/);
  assert.match(text, /dexconnect:\/\/meet\/482-913-207/);
  const ics = buildIcs(inv({ guestUrl: null, passcode: null }), 'Today').replace(/\r\n /g, '');
  assert.doesNotMatch(ics, /\r\nURL:/);
  assert.match(ics, /\r\nLOCATION:dexconnect:\/\/meet\/482-913-207\r\n/);
});

test('a meeting report and the office totals as CSV', async () => {
  const { reportCsv, usageCsv } = await import('../src/meet-csv.ts');
  const { parseCsv } = await import('../src/csv.ts');
  const t0 = Date.UTC(2026, 10, 14, 4, 30);
  const csv = reportCsv({
    roomId: 'R1', meetingId: '482913207', title: 'Review, rev C', kind: 'instant', hostId: 'U1', startedAt: t0, endedAt: t0 + 3600_000, durationMs: 3600_000,
    people: [
      { userId: 'U1', name: 'Priya Raman', guest: false, firstJoin: t0, lastLeave: t0 + 3600_000, totalMs: 3600_000, joins: 1, hands: 0, reactions: 2 },
      { userId: 'guest:1', name: '=HYPERLINK("x")', guest: true, firstJoin: t0 + 60_000, lastLeave: t0 + 1800_000, totalMs: 1500_000, joins: 2, hands: 1, reactions: 0 },
    ],
    peak: 2, hands: 1, reactions: { '👏': 2 }, polls: [{ question: 'Ship?', options: [{ text: 'Yes', votes: 1 }, { text: 'No', votes: 0 }], voters: 1 }],
    recordings: [], breakouts: 0,
  });
  assert.ok(csv.startsWith('﻿'));
  const rows = parseCsv(csv);
  assert.deepEqual(rows[0], ['Meeting', 'Review, rev C']);
  const head = rows.findIndex((r) => r[0] === 'Name');
  assert.deepEqual(rows[head + 1], ['Priya Raman', 'no', '2026-11-14 04:30:00', '2026-11-14 05:30:00', '60', '1', '0', '2']);
  // a name that looks like a formula is written as text
  assert.equal(rows[head + 2][0], `'=HYPERLINK("x")`);
  assert.equal(rows[head + 2][4], '25');
  assert.ok(rows.some((r) => r[0] === 'Poll' && r[1] === 'Ship?'));
  const u = parseCsv(usageCsv({ days: 28, from: t0, weeks: [{ week: '2026-11-09', meetings: 3, hours: 2.5, averageSize: 4.3, guests: 1 }], totals: { meetings: 3, hours: 2.5, averageSize: 4.3, guests: 1, recordings: 1, recordingBytes: 10 } }));
  assert.deepEqual(u[1], ['2026-11-09', '3', '2.5', '4.3', '1']);
  assert.deepEqual(u[2], ['Total', '3', '2.5', '4.3', '1']);
});
