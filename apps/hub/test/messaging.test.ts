import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIdentity } from '@dex/core';
import type { Conversation, Message } from '@dex/core';
import { HubClient } from '@dex/core/client';
import type { ClientState } from '@dex/core/client';
import { Hub } from '../src/hub.ts';

const cleanups: Array<() => unknown> = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

async function office() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexmsg-'));
  const hub = new Hub({ dataDir: dir, port: 0, host: '127.0.0.1', discoveryPort: false, updates: false });
  await hub.start();
  cleanups.push(async () => { await hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const join = async (username: string) => {
    const identity = createIdentity();
    const c = new HubClient({ identity, account: { username, domain: 'DEX', displayName: username[0].toUpperCase() + username.slice(1), hostname: `${username}-pc` } });
    cleanups.push(() => c.disconnect());
    c.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
    await until(c, (s) => s.kind === 'ready' || s.kind === 'pending');
    return { c, identity };
  };
  const owner = (await join('vikram')).c;
  const approve = async (username: string) => {
    const { c, identity } = await join(username);
    await owner.request('admin.decide', { deviceId: identity.deviceId, approve: true });
    await until(c, (s) => s.kind === 'ready');
    return c;
  };
  const priya = await approve('priya');
  const ravi = await approve('ravi');
  return { hub, owner, priya, ravi, join };
}

function until(c: HubClient, pred: (s: ClientState) => boolean, ms = 5000): Promise<void> {
  if (pred(c.state)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout in ${c.state.kind}`)), ms);
    const on = (s: ClientState) => { if (pred(s)) { clearTimeout(t); c.off('state', on); resolve(); } };
    c.on('state', on);
  });
}

function nextEvent<T>(c: HubClient, name: string, pred: (d: T) => boolean = () => true, ms = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { c.off('event', on); reject(new Error(`no ${name}`)); }, ms);
    const on = (n: string, d: unknown) => { if (n === name && pred(d as T)) { clearTimeout(t); c.off('event', on); resolve(d as T); } };
    c.on('event', on);
  });
}

const me = (c: HubClient) => c.session!.me.id;
let seq = 0;
const send = (c: HubClient, convId: string, body: string, parentId?: string) => c.request('msg.send', { convId, body, parentId, clientId: `t${++seq}` });

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
