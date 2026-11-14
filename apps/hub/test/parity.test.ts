import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PublicUser } from '@dex/core';
import { office, nextEvent, me, send } from './office.ts';

test('sidebar organisation, timed mute, archive, announcement Spaces and moderators', async () => {
  const { hub, owner, priya, ravi } = await office();
  const space = await priya.request('conv.create', { kind: 'space', name: 'Notices', members: [me(ravi), me(owner)] });
  const pinned = await ravi.request('conv.organise', { convId: space.id, pinned: true, section: 'Projects' });
  assert.ok(pinned.pinnedAt);
  assert.equal(pinned.section, 'Projects');
  assert.equal((await priya.request('conv.list')).find((c) => c.id === space.id)?.pinnedAt, null, 'organisation is per person');
  const muted = await ravi.request('conv.mute', { convId: space.id, muted: true, until: Date.now() + 3600_000 });
  assert.equal(muted.muted, true);
  assert.ok(muted.mutedUntil);
  const back = nextEvent<{ id: string; muted: boolean }>(ravi, 'conv.updated', (c) => c.id === space.id && !c.muted);
  hub.messaging.tick(Date.now() + 3601_000);
  assert.equal((await back).muted, false);
  // announcements: only moderators start messages; others reply in side-tracks
  await assert.rejects(ravi.request('conv.settings', { convId: space.id, postPolicy: 'moderators' }), /moderator/);
  const set = await priya.request('conv.settings', { convId: space.id, postPolicy: 'moderators', moderators: [me(owner)] });
  assert.deepEqual(set.moderators, [me(owner)]);
  const post = await send(owner, space.id, 'Office closed on Friday');
  await assert.rejects(send(ravi, space.id, 'Why?'), /Only moderators/);
  await send(ravi, space.id, 'Thanks', post.id);
  // a moderator can remove someone else's message
  const r = await send(ravi, space.id, 'side note', post.id);
  await owner.request('msg.delete', { messageId: r.id });
  // archive: read-only
  await assert.rejects(ravi.request('conv.archive', { convId: space.id, archived: true }), /archive/);
  await priya.request('conv.archive', { convId: space.id, archived: true });
  await assert.rejects(send(owner, space.id, 'hello?'), /archived/);
  await priya.request('conv.archive', { convId: space.id, archived: false });
  await send(owner, space.id, 'back again');
});

test('timed availability and out of office', async () => {
  const { hub, owner, priya, ravi } = await office();
  const until = Date.now() + 3600_000;
  const u = await priya.request('me.update', { availability: 'dnd', until });
  assert.equal(u.availability, 'dnd');
  assert.equal(u.availabilityUntil, until);
  const ooo = await priya.request('me.update', { ooo: { until: Date.now() + 5 * 86400_000, message: 'At site in Jamnagar', delegateId: me(ravi) } });
  assert.equal(ooo.ooo?.delegateId, me(ravi));
  await assert.rejects(priya.request('me.update', { ooo: { until: Date.now() - 1 } }), /back/);
  const reset = nextEvent<PublicUser>(owner, 'user.updated', (x) => x.id === me(priya) && x.availability === 'available');
  (hub as unknown as { presenceTick: (n: number) => void }).presenceTick(until + 1000);
  const fresh = await reset;
  assert.equal(fresh.availabilityUntil, null);
  assert.ok(fresh.ooo, 'out of office continues');
  (hub as unknown as { presenceTick: (n: number) => void }).presenceTick(Date.now() + 6 * 86400_000);
  assert.equal((await owner.request('directory.list')).users.find((x) => x.id === me(priya))?.ooo, null);
});
