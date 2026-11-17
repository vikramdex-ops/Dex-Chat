import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCalendarFeed } from '../src/ics.ts';
import type { FeedEvent } from '../src/ics.ts';

const ev = (over: Partial<FeedEvent> = {}): FeedEvent => ({
  uid: 'E1@dexconnect-hub', title: 'Pump skid review', startAt: Date.UTC(2026, 10, 18, 4, 30), endAt: Date.UTC(2026, 10, 18, 5, 30),
  allDay: false, recurrence: 'none', until: null, description: null, location: null, url: null,
  organizer: { name: 'Priya Raman', email: null, id: 'U1' }, sequence: 0, modifiedAt: Date.UTC(2026, 10, 14, 12), cancelled: false, ...over,
});

test('a calendar feed: one VEVENT a meeting, repeats as RRULE, all-day dates, cancellations, CRLF and folded lines', () => {
  const stamp = Date.UTC(2026, 10, 15, 0, 0);
  const ics = buildCalendarFeed({
    name: 'Priya · Dexterity Office', office: 'Dexterity Office', stamp, events: [
      ev({ description: 'Join in Dexterity Connect: dexconnect://meet/482-913-207\nMeeting ID: 482-913-207', url: 'dexconnect://meet/482-913-207', location: 'Bay 2 · Dexterity Connect', sequence: 3 }),
      ev({ uid: 'E2@x', title: 'Weekly, piping', recurrence: 'weekdays', until: Date.UTC(2026, 11, 31, 4, 30) }),
      ev({ uid: 'E3@x', title: 'Site visit', allDay: true, startAt: new Date(2026, 10, 20).getTime(), endAt: new Date(2026, 10, 21).getTime() }),
      ev({ uid: 'E4@x', title: 'Old plan', cancelled: true, sequence: 2 }),
      ev({ uid: 'E5@x', title: 'Bad link', url: 'javascript alert(1)' }),
    ],
  });
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!/[^\r]\n/.test(ics));
  for (const l of ics.split('\r\n')) assert.ok(new TextEncoder().encode(l).length <= 75, l);
  const u = ics.replace(/\r\n /g, '');
  assert.match(u, /\r\nMETHOD:PUBLISH\r\n/);
  assert.match(u, /\r\nX-WR-CALNAME:Priya · Dexterity Office\r\n/);
  assert.match(u, /\r\nREFRESH-INTERVAL;VALUE=DURATION:PT1H\r\n/);
  assert.equal(u.match(/BEGIN:VEVENT/g)?.length, 5);
  const block = (uid: string) => u.split('BEGIN:VEVENT').find((b) => b.includes(`UID:${uid}\r\n`))!;
  const a = block('E1@dexconnect-hub');
  assert.match(a, /\r\nDTSTAMP:20261115T000000Z\r\n/);
  assert.match(a, /\r\nDTSTART:20261118T043000Z\r\nDTEND:20261118T053000Z\r\n/);
  assert.match(a, /\r\nSEQUENCE:3\r\n/);
  assert.match(a, /\r\nLAST-MODIFIED:20261114T120000Z\r\n/);
  assert.match(a, /\r\nURL:dexconnect:\/\/meet\/482-913-207\r\n/);
  assert.match(a, /\r\nDESCRIPTION:Join in Dexterity Connect: dexconnect:\/\/meet\/482-913-207\\nMeeting ID: 482-913-207\r\n/);
  assert.match(a, /\r\nORGANIZER;CN="Priya Raman":urn:dexconnect:dexterity-office:U1\r\n/);
  assert.match(block('E2@x'), /\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;UNTIL=20261231T043000Z\r\n/);
  assert.match(block('E2@x'), /\r\nSUMMARY:Weekly\\, piping\r\n/);
  assert.match(block('E3@x'), /\r\nDTSTART;VALUE=DATE:20261120\r\nDTEND;VALUE=DATE:20261121\r\n/);
  assert.match(block('E4@x'), /\r\nSTATUS:CANCELLED\r\nTRANSP:TRANSPARENT\r\n/);
  assert.doesNotMatch(block('E5@x'), /\r\nURL:/, 'only real links');
});

test('a long feed keeps the meetings nearest to now and stays under its limit', () => {
  const now = Date.UTC(2026, 10, 15);
  const events = Array.from({ length: 400 }, (_, i) => ev({ uid: `E${i}@x`, title: `Meeting ${i} ${'x'.repeat(200)}`, startAt: now + (i - 200) * 86_400_000, endAt: now + (i - 200) * 86_400_000 + 3600_000 }));
  const ics = buildCalendarFeed({ name: 'Feed', office: 'Office', events, stamp: now, maxLength: 60_000 });
  assert.ok(ics.length <= 60_000, String(ics.length));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.match(ics, /UID:E200@x\r\n/, 'today is in');
  assert.doesNotMatch(ics, /UID:E0@x\r\n/, 'the farthest are left out');
  const starts = [...ics.matchAll(/DTSTART:(\d{8}T\d{6}Z)/g)].map((m) => m[1]);
  assert.deepEqual(starts, [...starts].sort(), 'in date order');
});
