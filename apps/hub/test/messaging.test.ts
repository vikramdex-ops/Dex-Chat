import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import type { Conversation, Message } from '@dex/core';
import { office, until, nextEvent, me, send } from './office.ts';

test('everyone lands in the Office space; it cannot be left', async () => {
  const { owner, priya } = await office();
  const list = await priya.request('conv.list');
  const officeSpace = list.find((c) => c.everyone)!;
  assert.equal(officeSpace.name, 'Office');
  assert.equal(officeSpace.members.length, 3);
  assert.ok((await owner.request('conv.list')).some((c) => c.id === officeSpace.id));
  await assert.rejects(priya.request('conv.leave', { convId: officeSpace.id }), /stays in the Office/);
});

test('messages arrive live, count as unread for others and clear when read', async () => {
  const { owner, priya } = await office();
  const space = await owner.request('conv.create', { kind: 'space', name: 'Piping P-12', topic: 'Isometrics and MTOs', members: [priya.session!.me.id] });
  assert.equal(space.joined, true);
  const incoming = nextEvent<Message>(priya, 'msg.new');
  const counts = nextEvent<Conversation>(priya, 'conv.updated', (c) => c.id === space.id && c.unread === 1);
  const sent = await send(owner, space.id, 'Rev B of ISO-1001 is in the folder');
  assert.equal((await incoming).id, sent.id);
  assert.equal((await counts).lastMessage?.body, 'Rev B of ISO-1001 is in the folder');
  // the sender's own message is not unread for the sender
  assert.equal((await owner.request('conv.list')).find((c) => c.id === space.id)!.unread, 0);

  const receipt = nextEvent<{ userId: string; messageId: string }>(owner, 'read');
  const after = await priya.request('conv.read', { convId: space.id, messageId: sent.id });
  assert.equal(after.unread, 0);
  assert.equal((await receipt).userId, me(priya));
});

test('open Spaces can be found and joined; private ones stay hidden', async () => {
  const { owner, priya, ravi } = await office();
  const open = await owner.request('conv.create', { kind: 'space', name: 'Site visits' });
  const secret = await owner.request('conv.create', { kind: 'space', name: 'Bids', private: true, members: [me(priya)] });
  const browse = await ravi.request('conv.browse');
  assert.ok(browse.some((c) => c.id === open.id));
  assert.ok(!browse.some((c) => c.id === secret.id));
  await assert.rejects(ravi.request('conv.join', { convId: secret.id }), /not found/);
  await assert.rejects(ravi.request('msg.list', { convId: secret.id }), /not found/);
  const joined = await ravi.request('conv.join', { convId: open.id });
  assert.equal(joined.members.length, 2);
  await assert.rejects(owner.request('conv.create', { kind: 'space', name: 'site VISITS' }), /already exists/);
  await assert.rejects(ravi.request('conv.update', { convId: open.id, name: 'Mine now' }), /Only the person who created/);
});

test('Direct conversations are reused and closed to others', async () => {
  const { owner, priya, ravi } = await office();
  const a = await owner.request('conv.create', { kind: 'direct', members: [me(priya)] });
  const b = await priya.request('conv.create', { kind: 'direct', members: [me(owner)] });
  assert.equal(a.id, b.id);
  assert.equal(a.kind, 'direct');
  await assert.rejects(ravi.request('msg.list', { convId: a.id }), /not found/);
  await assert.rejects(owner.request('conv.leave', { convId: a.id }), /mute/);
  const muted = await priya.request('conv.mute', { convId: a.id, muted: true });
  assert.equal(muted.muted, true);
});

test('side-tracks, mentions, reactions, pins, edits and deletes', async () => {
  const { owner, priya, ravi } = await office();
  const space = await owner.request('conv.create', { kind: 'space', name: 'Checking', members: [me(priya), me(ravi)] });
  const root = await send(owner, space.id, `<@${me(priya)}> can you check line 6"-P-1001?`);
  assert.deepEqual(root.mentions, [me(priya)]);
  assert.equal((await priya.request('conv.list')).find((c) => c.id === space.id)!.mentions, 1);

  // replies live in the side-track and do not add to the top-level unread count
  const parentUpdate = nextEvent<Message>(owner, 'msg.updated', (m) => m.id === root.id && m.replyCount === 1);
  const reply = await send(priya, space.id, 'On it', root.id);
  assert.equal(reply.parentId, root.id);
  await parentUpdate;
  const track = await owner.request('msg.list', { convId: space.id, parentId: root.id });
  assert.deepEqual(track.messages.map((m) => m.body), ['On it']);
  assert.equal((await ravi.request('conv.list')).find((c) => c.id === space.id)!.unread, 1);
  await assert.rejects(send(priya, space.id, 'nested', reply.id), /cannot be replied/);

  const everyone = await send(owner, space.id, '<@all> review at 4');
  assert.ok(everyone.mentions.includes('all'));

  const r1 = await priya.request('msg.react', { messageId: root.id, emoji: '👍', on: true });
  await ravi.request('msg.react', { messageId: root.id, emoji: '👍', on: true });
  const r2 = await priya.request('msg.react', { messageId: root.id, emoji: '👍', on: false });
  assert.deepEqual(r1.reactions['👍'], [me(priya)]);
  assert.deepEqual(r2.reactions['👍'], [me(ravi)]);
  await assert.rejects(priya.request('msg.react', { messageId: root.id, emoji: 'lol', on: true }), /not supported/);

  await priya.request('msg.pin', { messageId: root.id, pinned: true });
  assert.deepEqual((await ravi.request('msg.pins', { convId: space.id })).map((m) => m.id), [root.id]);

  await assert.rejects(priya.request('msg.edit', { messageId: root.id, body: 'hijack' }), /your own/);
  const edited = await owner.request('msg.edit', { messageId: root.id, body: 'Can someone check line 6"-P-1001?' });
  assert.ok(edited.editedAt);
  assert.deepEqual(edited.mentions, []);

  await assert.rejects(ravi.request('msg.delete', { messageId: reply.id }), /your own/);
  const gone = await owner.request('msg.delete', { messageId: reply.id }); // admins moderate Spaces
  assert.equal(gone.deleted, true);
  assert.equal(gone.body, '');
});

test('retries are idempotent, history pages backwards, typing reaches others only', async () => {
  const { owner, priya } = await office();
  const dm = await owner.request('conv.create', { kind: 'direct', members: [me(priya)] });
  const a = await owner.request('msg.send', { convId: dm.id, body: 'once', clientId: 'same' });
  const b = await owner.request('msg.send', { convId: dm.id, body: 'once', clientId: 'same' });
  assert.equal(a.id, b.id);

  for (let i = 0; i < 70; i++) await send(priya, dm.id, `message ${i}`);
  const page1 = await owner.request('msg.list', { convId: dm.id, limit: 50 });
  assert.equal(page1.messages.length, 50);
  assert.equal(page1.hasMore, true);
  assert.equal(page1.messages.at(-1)!.body, 'message 69');
  const page2 = await owner.request('msg.list', { convId: dm.id, limit: 50, before: page1.messages[0].id });
  assert.equal(page2.messages.length, 21);
  assert.equal(page2.hasMore, false);
  assert.equal(page2.messages[0].body, 'once');

  const typing = nextEvent<{ userId: string }>(priya, 'typing');
  let selfTyping = false;
  const onSelf = (n: string) => { if (n === 'typing') selfTyping = true; };
  owner.on('event', onSelf);
  await owner.request('typing', { convId: dm.id });
  assert.equal((await typing).userId, me(owner));
  await new Promise((r) => setTimeout(r, 100));
  owner.off('event', onSelf);
  assert.equal(selfTyping, false);
});

test('search finds words, line numbers and mentions, only in your conversations', async () => {
  const { owner, priya, ravi } = await office();
  const space = await owner.request('conv.create', { kind: 'space', name: 'Search test', members: [me(priya)] });
  await send(owner, space.id, 'Support spacing on line 6"-P-1001-A1B needs a check');
  await send(owner, space.id, `<@${me(priya)}> please review the MTO`);
  const secret = await owner.request('conv.create', { kind: 'direct', members: [me(ravi)] });
  await send(owner, secret.id, 'support budget for ravi only');

  const r1 = await priya.request('search', { q: 'support' });
  assert.equal(r1.messages.length, 1);
  assert.match(r1.messages[0].snippet, /\[\[Support\]\]/);
  const r2 = await priya.request('search', { q: '1001' });
  assert.equal(r2.messages.length, 1);
  const r3 = await priya.request('search', { q: 'priy' });
  assert.equal(r3.messages[0].message.body.includes('please review'), true, 'mentions are searchable by name');
  assert.equal((await ravi.request('search', { q: 'spacing' })).messages.length, 0, 'not a member');
  assert.equal((await priya.request('search', { q: '  ' })).messages.length, 0);

  const edited = r1.messages[0].message;
  await owner.request('msg.edit', { messageId: edited.id, body: 'Pipe rack PR-03 needs a check' });
  assert.equal((await priya.request('search', { q: 'support' })).messages.length, 0, 'edits re-index');
  assert.equal((await priya.request('search', { q: 'rack' })).messages.length, 1);
  await owner.request('msg.delete', { messageId: edited.id });
  assert.equal((await priya.request('search', { q: 'rack' })).messages.length, 0, 'deleted messages disappear');
});

test('Rooms: ring, join, relay signals device-to-device, busy state, decline and end', async () => {
  const { owner, priya, ravi } = await office();
  const dm = await owner.request('conv.create', { kind: 'direct', members: [me(priya)] });

  const ring = nextEvent<{ room: { id: string }; from: string }>(priya, 'room.ring');
  const busy = nextEvent<{ userId: string; inRoom: boolean }>(ravi, 'room.busy');
  const room = await owner.request('room.start', { convId: dm.id, video: true });
  assert.equal((await ring).from, me(owner));
  assert.deepEqual(await busy, { userId: me(owner), inRoom: true });
  assert.deepEqual(room.ringing, [me(priya)]);
  await assert.rejects(ravi.request('room.join', { roomId: room.id }), /ended/, 'not a member of the conversation');

  const updated = nextEvent<{ participants: unknown[] }>(owner, 'room.updated', (r) => r.participants.length === 2);
  const joined = await priya.request('room.join', { roomId: room.id });
  assert.equal(joined.participants.length, 2);
  assert.deepEqual(joined.ringing, []);
  await updated;

  // offers and ICE go to exactly one device
  const ownerDevice = owner.session!.deviceId;
  const signal = nextEvent<{ fromUser: string; data: { sdp: string } }>(owner, 'room.signal');
  await priya.request('room.signal', { roomId: room.id, toDevice: ownerDevice, data: { sdp: 'offer' } });
  assert.deepEqual((await signal).data, { sdp: 'offer' });
  await priya.request('room.media', { roomId: room.id, muted: true, camera: false, screen: false });
  assert.equal((await owner.request('room.list'))[0].participants.find((p) => p.userId === me(priya))!.muted, true);

  const ended = nextEvent<{ missed: boolean }>(priya, 'room.ended');
  await owner.request('room.leave', { roomId: room.id }); // one-to-one: hanging up ends it for both
  assert.equal((await ended).missed, false);
  assert.deepEqual(await owner.request('room.list'), []);

  // a declined call ends as missed
  const r2 = await owner.request('room.start', { convId: dm.id, video: false });
  const missed = nextEvent<{ missed: boolean }>(owner, 'room.ended');
  await priya.request('room.decline', { roomId: r2.id });
  assert.equal((await missed).missed, true);
});

test('integrations: admins mint bot tokens; bots message people by Windows sign-in and post to Spaces', async () => {
  const { hub, owner, priya, ravi } = await office();
  await assert.rejects(priya.request('admin.bots.create', { name: 'Hopper' }), /Only administrators/);
  const { bot, token } = await owner.request('admin.bots.create', { name: 'Hopper' });
  assert.equal(bot.role, 'bot');
  assert.match(token, /^dxc_/);
  await owner.request('conv.create', { kind: 'space', name: 'Piping P-12', members: [me(priya)] });

  const post = (t: string, payload: unknown) => new Promise<{ status: number; body: { ok: boolean; delivered: string[]; unknown: string[] } }>((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(payload));
    const r = https.request({ host: '127.0.0.1', port: hub.port, path: '/api/bot/message', method: 'POST', rejectUnauthorized: false,
      headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json', 'content-length': data.length } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(b) }));
    });
    r.on('error', reject); r.end(data);
  });

  const incoming = nextEvent<Message>(priya, 'msg.new', (m) => m.authorId === bot.id);
  const r = await post(token, { text: 'Vikram sent you 3 files (12 MB)', to: ['priya', 'DEX\\ravi', 'nobody'], card: { title: 'Saved to your Hopper Inbox', lines: ['ISO-1001.pdf'] } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.delivered.sort(), ['dex\\priya', 'dex\\ravi']);
  assert.deepEqual(r.body.unknown, ['nobody']);
  const m = await incoming;
  assert.match(m.body, /\*\*Saved to your Hopper Inbox\*\*\n- ISO-1001.pdf/);
  assert.ok((await ravi.request('conv.list')).some((c) => c.kind === 'direct' && c.members.includes(bot.id)));

  const toSpace = await post(token, { text: 'Link P-12 transmittal closes in 2 days', space: 'piping p-12' });
  assert.deepEqual(toSpace.body.delivered, ['space:piping p-12']);
  assert.equal((await post('dxc_wrong', { text: 'x', to: ['priya'] })).status, 401);
  assert.equal((await post(token, { to: ['priya'] })).status, 400);

  await owner.request('admin.bots.revoke', { userId: bot.id });
  assert.equal((await post(token, { text: 'after revoke', to: ['priya'] })).status, 401);
  assert.equal((await owner.request('admin.bots'))[0].active, false);
});
