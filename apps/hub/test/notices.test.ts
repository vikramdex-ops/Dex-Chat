import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Conversation, Message } from '@dex/core';
import { office, nextEvent, me, send } from './office.ts';

test('join, leave, add, remove and rename notices; they are not unread and not previews', async () => {
  const { owner, priya, ravi } = await office();
  const space = await owner.request('conv.create', { kind: 'space', name: 'Notices', members: [me(priya)] });
  await send(owner, space.id, 'hello');
  const added = nextEvent<Message>(priya, 'msg.new', (m) => !!m.system);
  await owner.request('conv.addMembers', { convId: space.id, userIds: [me(ravi)] });
  assert.deepEqual((await added).system, { kind: 'added', users: [me(ravi)] });
  await ravi.request('conv.leave', { convId: space.id });
  await ravi.request('conv.join', { convId: space.id });
  await assert.rejects(priya.request('conv.removeMember', { convId: space.id, userId: me(ravi) }), /moderators/);
  await owner.request('conv.removeMember', { convId: space.id, userId: me(ravi) });
  await owner.request('conv.update', { convId: space.id, name: 'Notices 2' });
  const list = (await priya.request('msg.list', { convId: space.id })).messages.filter((m) => m.system).map((m) => [m.system!.kind, m.authorId]);
  assert.deepEqual(list, [['added', me(owner)], ['left', me(ravi)], ['joined', me(ravi)], ['removed', me(owner)], ['renamed', me(owner)]]);
  const conv = (await priya.request('conv.list')).find((c: Conversation) => c.id === space.id)!;
  assert.equal(conv.unread, 1, 'only the real message counts');
  assert.equal(conv.lastMessage?.body, 'hello');
  assert.equal((await priya.request('search', { q: '', convId: space.id })).messages.length, 1);
});

test('read receipts can be switched off, both ways; last seen is shared, not while invisible', async () => {
  const { owner, priya, ravi } = await office();
  const space = await owner.request('conv.create', { kind: 'space', name: 'Receipts', members: [me(priya), me(ravi)] });
  const m = await send(owner, space.id, 'please read');
  await priya.request('conv.read', { convId: space.id, messageId: m.id });
  let v = (await owner.request('conv.list')).find((c: Conversation) => c.id === space.id)!;
  assert.equal(v.reads[me(priya)], m.id);
  await priya.request('me.update', { readReceipts: false });
  v = (await owner.request('conv.list')).find((c: Conversation) => c.id === space.id)!;
  assert.equal(me(priya) in v.reads, false, 'her reads are hidden from others');
  const pv = (await priya.request('conv.list')).find((c: Conversation) => c.id === space.id)!;
  assert.deepEqual(Object.keys(pv.reads), [me(priya)], 'and she sees only her own');
  // no read event reaches others for her
  let leaked = false;
  owner.on('event', (n: string, d: { userId?: string }) => { if (n === 'read' && d.userId === me(priya)) leaked = true; });
  const m2 = await send(owner, space.id, 'again');
  await priya.request('conv.read', { convId: space.id, messageId: m2.id });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(leaked, false);
  await priya.request('me.update', { readReceipts: true });

  const users = (await owner.request('directory.list')).users;
  assert.ok((users.find((u) => u.id === me(ravi))!.lastSeen ?? 0) > Date.now() - 60_000);
  await ravi.request('me.update', { availability: 'invisible' });
  assert.equal((await owner.request('directory.list')).users.find((u) => u.id === me(ravi))!.lastSeen, null);
  await priya.request('me.update', { statusEmoji: '🏗️', statusText: 'On site' });
  assert.equal((await owner.request('directory.list')).users.find((u) => u.id === me(priya))!.statusEmoji, '🏗️');
  await assert.rejects(priya.request('me.update', { statusEmoji: 'not an emoji' }), /emoji/);
});

test('a side-track reply can also go to the conversation, pointing back to the side-track', async () => {
  const { owner, priya } = await office();
  const space = await owner.request('conv.create', { kind: 'space', name: 'Tracks', members: [me(priya)] });
  const q = await send(owner, space.id, 'Which rating for line 12?');
  const reply = await priya.request('msg.send', { convId: space.id, body: '300# per spec', parentId: q.id, clientId: 'a1', alsoToConv: true });
  assert.equal(reply.parentId, q.id);
  // a retry does not post a second copy
  await priya.request('msg.send', { convId: space.id, body: '300# per spec', parentId: q.id, clientId: 'a1', alsoToConv: true });
  const top = (await owner.request('msg.list', { convId: space.id })).messages;
  const copies = top.filter((m) => m.body === '300# per spec');
  assert.equal(copies.length, 1);
  assert.deepEqual(copies[0].inReplyTo, { messageId: q.id, authorId: me(owner) });
  assert.equal(copies[0].parentId, null);
});
