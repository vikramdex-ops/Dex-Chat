import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CalEvent, Message, Occurrence } from '@dex/core';
import { expand } from '../src/calendar.ts';
import { office, nextEvent, me } from './office.ts';

const H = 3600_000;
const at = (y: number, m: number, d: number, h = 10, min = 0) => new Date(y, m - 1, d, h, min).getTime();

test('repeating meetings expand within a window', () => {
  const base = { start_at: at(2026, 11, 13, 10), end_at: at(2026, 11, 13, 11), until_at: null };
  const days = (r: Parameters<typeof expand>[0], from: number, to: number) => expand(r, from, to).map((o) => new Date(o.startAt).getDate());
  assert.deepEqual(days({ ...base, recurrence: 'weekdays' }, at(2026, 11, 13, 0), at(2026, 11, 19, 0)), [13, 16, 17, 18]); // Fri, then Mon to Wed
  assert.deepEqual(days({ ...base, recurrence: 'weekly' }, at(2026, 11, 1, 0), at(2026, 12, 1, 0)), [13, 20, 27]);
  assert.deepEqual(days({ ...base, recurrence: 'daily', until_at: at(2026, 11, 15, 23) }, at(2026, 11, 1, 0), at(2026, 12, 1, 0)), [13, 14, 15]);
  const jan31 = { start_at: at(2027, 1, 31, 9), end_at: at(2027, 1, 31, 10), until_at: null, recurrence: 'monthly' as const };
  assert.deepEqual(expand(jan31, at(2027, 1, 1), at(2027, 5, 1)).map((o) => new Date(o.startAt).toDateString().slice(4, 10)), ['Jan 31', 'Feb 28', 'Mar 31', 'Apr 30']);
  // a meeting still running at the window start is included; far-future windows are fast
  assert.equal(expand({ ...base, recurrence: 'none' }, at(2026, 11, 13, 10, 30), at(2026, 11, 14)).length, 1);
  const t0 = Date.now();
  assert.equal(expand({ ...base, recurrence: 'daily' }, at(2036, 1, 1), at(2036, 1, 8)).length, 7);
  assert.ok(Date.now() - t0 < 50);
});

test('invites, replies, announcement in the Space, edits, cancelling and visibility', async () => {
  const { owner, priya, ravi } = await office();
  const space = await owner.request('conv.create', { kind: 'space', name: 'Project P-12', members: [me(priya)] });
  const start = Date.now() + 2 * 86400_000;
  const invited = nextEvent<CalEvent>(priya, 'cal.invited');
  const posted = nextEvent<Message>(priya, 'msg.new', (m) => m.convId === space.id);
  const ev = await owner.request('cal.create', { title: 'Design review', startAt: start, endAt: start + H, attendees: [me(priya)], convId: space.id, online: true, reminderMin: 10 });
  assert.equal((await invited).id, ev.id);
  assert.match((await posted).body, /📅 \*\*Design review\*\*/);
  assert.deepEqual(ev.attendees.map((a) => a.response), ['yes', 'pending']);
  const yes = await priya.request('cal.respond', { eventId: ev.id, response: 'yes' });
  assert.equal(yes.attendees.find((a) => a.userId === me(priya))?.response, 'yes');
  // outsiders cannot see it; Space members can
  const window = { from: start - H, to: start + 2 * H };
  assert.equal((await ravi.request('cal.list', window)).length, 0);
  await assert.rejects(ravi.request('cal.get', { eventId: ev.id }), /not found/);
  assert.equal((await priya.request('cal.list', window)).length, 1);
  // only the organiser edits; a new time asks everyone again
  await assert.rejects(priya.request('cal.update', { eventId: ev.id, title: 'Mine now' }), /organiser/);
  const moved = await owner.request('cal.update', { eventId: ev.id, startAt: start + H, endAt: start + 2 * H, attendees: [me(priya), me(ravi)] });
  assert.equal(moved.attendees.find((a) => a.userId === me(priya))?.response, 'pending');
  assert.equal((await ravi.request('cal.list', { from: start, to: start + 3 * H })).length, 1);
  await assert.rejects(owner.request('cal.create', { title: 'Backwards', startAt: start, endAt: start - 1 }), /end after/);
  await assert.rejects(owner.request('cal.create', { title: '', startAt: start, endAt: start + H }), /title/);
  const cancelled = await owner.request('cal.cancel', { eventId: ev.id });
  assert.equal(cancelled.cancelled, true);
  assert.equal((await priya.request('cal.list', { from: start, to: start + 3 * H })).length, 0);
});

test('conference rooms cannot be double-booked, even by a repeating meeting', async () => {
  const { owner, priya } = await office();
  await assert.rejects(priya.request('admin.cal.saveVenue', { name: 'Cabin' }), /administrators/);
  const room = await owner.request('admin.cal.saveVenue', { name: 'Conference room A', capacity: 10 });
  const monday = at(2027, 3, 1, 15);
  await owner.request('cal.create', { title: 'Weekly sync', startAt: monday, endAt: monday + H, venueId: room.id, recurrence: 'weekly' });
  // three weeks later, overlapping the series
  const later = monday + 21 * 86400_000 + 30 * 60_000;
  await assert.rejects(priya.request('cal.create', { title: 'Client call', startAt: later, endAt: later + H, venueId: room.id }), /already booked by Vikram/);
  // an hour later is free
  const ok = await priya.request('cal.create', { title: 'Client call', startAt: monday + 21 * 86400_000 + H, endAt: monday + 21 * 86400_000 + 2 * H, venueId: room.id });
  assert.equal(ok.venueId, room.id);
  const busy = await priya.request('cal.busy', { userIds: [me(owner)], venueId: room.id, from: monday, to: monday + 7 * 86400_000 });
  assert.deepEqual(busy.map((b) => b.id), [me(owner), `venue:${room.id}`]);
  await owner.request('admin.cal.deleteVenue', { id: room.id });
  assert.equal((await owner.request('cal.venues')).length, 0);
});

test('meeting reminders go to people who are coming, once per occurrence', async () => {
  const { hub, owner, priya, ravi } = await office();
  const start = Date.now() + 3 * 86400_000;
  const ev = await owner.request('cal.create', { title: 'Stand-up', startAt: start, endAt: start + 15 * 60_000, attendees: [me(priya), me(ravi)], reminderMin: 5, recurrence: 'daily' });
  await ravi.request('cal.respond', { eventId: ev.id, response: 'no' });
  const got = nextEvent<Occurrence>(priya, 'cal.reminder');
  let raviHeard = false;
  ravi.on('event', (n: string) => { if (n === 'cal.reminder') raviHeard = true; });
  hub.calendar.tick(start - 4 * 60_000);
  assert.equal((await got).startAt, start);
  let again = false;
  priya.on('event', (n: string) => { if (n === 'cal.reminder') again = true; });
  hub.calendar.tick(start - 3 * 60_000);
  // the next day's occurrence gets its own reminder
  const next = nextEvent<Occurrence>(priya, 'cal.reminder');
  hub.calendar.tick(start + 86400_000 - 4 * 60_000);
  assert.equal((await next).startAt, start + 86400_000);
  assert.equal(raviHeard, false);
  assert.equal(again, true, 'only the next day fired after the first');
});
