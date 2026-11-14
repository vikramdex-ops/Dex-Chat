import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkState } from '@dex/core';
import { localDate } from '../src/work.ts';
import { office, nextEvent, me } from './office.ts';

test('check in, break, change place, check out; colleagues see it live', async () => {
  const { owner, priya } = await office();
  const seen = nextEvent<WorkState>(owner, 'work.updated', (s) => s.userId === me(priya) && s.status === 'in');
  const s1 = await priya.request('work.checkIn', { mode: 'home', note: 'Plumber visiting' });
  assert.equal(s1.status, 'in');
  assert.equal(s1.mode, 'home');
  assert.equal((await seen).note, 'Plumber visiting');
  await assert.rejects(priya.request('work.checkIn', { mode: 'office' }), /already checked in/);
  assert.equal((await priya.request('work.break', { on: true })).status, 'break');
  assert.equal((await priya.request('work.break', { on: false })).status, 'in');
  const moved = await priya.request('work.setMode', { mode: 'site', note: 'Refinery walkdown' });
  assert.equal(moved.mode, 'site');
  assert.equal(moved.checkedInAt, s1.checkedInAt, 'still the same working day');
  const team = await owner.request('work.team');
  assert.equal(team.find((t) => t.userId === me(priya))?.status, 'in');
  assert.equal(team.find((t) => t.userId === me(owner))?.status, 'out');
  const out = await priya.request('work.checkOut');
  assert.equal(out.status, 'out');
  await assert.rejects(priya.request('work.checkOut'), /not checked in/);
  await assert.rejects(priya.request('work.checkIn', { mode: 'moon' as never }), /where/);
  const today = localDate(Date.now());
  const rep = await priya.request('work.report', { from: today, to: today });
  assert.equal(rep.days.length, 1);
  assert.deepEqual(rep.days[0].modes, ['home', 'site']);
  assert.equal(rep.segments.filter((s) => s.kind === 'break').length, 1);
});

test('reports: yourself, your reporting line, or everyone for administrators', async () => {
  const { owner, priya, ravi } = await office();
  await owner.request('admin.org.setProfile', { userId: me(ravi), managerId: me(priya) });
  for (const c of [owner, priya, ravi]) { await c.request('work.checkIn', { mode: 'office' }); await c.request('work.checkOut'); }
  const today = localDate(Date.now());
  const users = (r: { days: Array<{ userId: string }> }) => [...new Set(r.days.map((x) => x.userId))].sort();
  assert.deepEqual(users(await ravi.request('work.report', { from: today, to: today })), [me(ravi)]);
  assert.deepEqual(users(await priya.request('work.report', { from: today, to: today })), [me(priya), me(ravi)].sort());
  assert.deepEqual(users(await owner.request('work.report', { from: today, to: today })), [me(owner), me(priya), me(ravi)].sort());
  await assert.rejects(ravi.request('work.report', { from: today, to: today, userIds: [me(priya)] }), /your own/);
  await assert.rejects(ravi.request('work.report', { from: today, to: '2001-01-01' }), /valid date/);
});

test('a forgotten check-out is closed automatically', async () => {
  const { hub, priya } = await office();
  await priya.request('work.checkIn', { mode: 'office' });
  const closed = nextEvent<WorkState>(priya, 'work.updated', (s) => s.status === 'out');
  hub.work.tick(Date.now() + 15 * 3600_000);
  assert.equal((await closed).status, 'out');
  const today = localDate(Date.now());
  const rep = await priya.request('work.report', { from: today, to: today });
  assert.equal(rep.days[0].autoClosed, true);
  assert.ok(rep.days[0].lastOut! <= Date.now(), 'closed at the last activity, not in the future');
});
