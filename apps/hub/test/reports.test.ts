import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity } from '@dex/core';
import { HubClient } from '@dex/core/client';
import { office, nextEvent, me, send, until, cleanups } from './office.ts';

test('reporting a message, administrators removing it with a reason, or dismissing', async () => {
  const { owner, priya, ravi } = await office();
  const space = await owner.request('conv.create', { kind: 'space', name: 'Reports', members: [me(priya), me(ravi)] });
  const bad = await send(ravi, space.id, 'something inappropriate');
  await assert.rejects(ravi.request('msg.report', { messageId: bad.id, reason: 'x' }), /your own/);
  const pinged = nextEvent<{ open: number }>(owner, 'admin.reports');
  await priya.request('msg.report', { messageId: bad.id, reason: 'Not appropriate for work' });
  assert.equal((await pinged).open, 1);
  await assert.rejects(priya.request('msg.report', { messageId: bad.id, reason: 'again' }), /already/);
  await assert.rejects(priya.request('admin.reports.list', {}), /administrators/);
  const [r] = await owner.request('admin.reports.list', {});
  assert.equal(r.text, 'something inappropriate');
  assert.equal(r.reporterId, me(priya));
  const done = await owner.request('admin.reports.resolve', { id: r.id, action: 'remove', reason: 'Against the office policy' });
  assert.equal(done.status, 'removed');
  const after = (await priya.request('msg.list', { convId: space.id })).messages.find((m) => m.id === bad.id)!;
  assert.equal(after.deleted, true);
  assert.deepEqual(after.removed, { by: me(owner), reason: 'Against the office policy' });
  assert.equal((await owner.request('admin.reports.list', {})).length, 0);
  // a moderator removing with a reason; an author deleting their own shows no reason
  const other = await send(ravi, space.id, 'off topic');
  await owner.request('msg.delete', { messageId: other.id, reason: 'Off topic here' });
  assert.equal((await priya.request('msg.list', { convId: space.id })).messages.find((m) => m.id === other.id)!.removed?.reason, 'Off topic here');
  const own = await send(priya, space.id, 'oops');
  await priya.request('msg.delete', { messageId: own.id, reason: 'ignored' });
  assert.equal((await priya.request('msg.list', { convId: space.id })).messages.find((m) => m.id === own.id)!.removed, null);
});

test('a group conversation becomes a private Space; forward to 25; default Spaces for new people', async () => {
  const { owner, priya, ravi, hub } = await office();
  const group = await owner.request('conv.create', { kind: 'direct', members: [me(priya), me(ravi)] });
  await send(owner, group.id, 'kick-off notes');
  const sp = await priya.request('conv.toSpace', { convId: group.id, name: 'Project Falcon' });
  assert.equal(sp.kind, 'space'); assert.equal(sp.private, true); assert.equal(sp.name, 'Project Falcon');
  assert.equal((await owner.request('msg.list', { convId: group.id })).messages.some((m) => m.body === 'kick-off notes'), true);
  const one = await owner.request('conv.create', { kind: 'direct', members: [me(priya)] });
  await assert.rejects(owner.request('conv.toSpace', { convId: one.id, name: 'x' }), /group conversations/);

  const intro = await owner.request('conv.create', { kind: 'space', name: 'Induction', members: [] });
  await owner.request('admin.policy.set', { defaultSpaces: [intro.id], editWindowMinutes: 730 * 1440 });
  assert.equal((await owner.request('policy.get')).editWindowMinutes, 730 * 1440);
  const identity = createIdentity();
  const c = new HubClient({ identity, account: { username: 'asha', domain: 'DEX', displayName: 'Asha', hostname: 'asha-pc' } });
  cleanups.push(() => c.disconnect());
  c.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
  await until(c, (s) => s.kind === 'pending');
  await owner.request('admin.decide', { deviceId: identity.deviceId, approve: true });
  await until(c, (s) => s.kind === 'ready');
  const mine = await c.request('conv.list');
  assert.ok(mine.some((x) => x.id === intro.id && x.joined), 'joined the default Space');
});
