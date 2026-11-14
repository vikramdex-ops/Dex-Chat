import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity, signWith } from '@dex/core';
import { createEncKeys, isSealed } from '@dex/core/e2e';
import { E2EClient } from '@dex/core/e2e-client';
import type { Message } from '@dex/core';
import { HubClient } from '@dex/core/client';
import { office, until, me, cleanups } from './office.ts';

async function person(hub: { port: number; fingerprint: string }, owner: HubClient, username: string) {
  const identity = createIdentity();
  const c = new HubClient({ identity, account: { username, domain: 'DEX', displayName: username, hostname: `${username}-pc` } });
  cleanups.push(() => c.disconnect());
  c.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
  await until(c, (s) => s.kind === 'pending' || s.kind === 'ready');
  if (c.state.kind === 'pending') await owner.request('admin.decide', { deviceId: identity.deviceId, approve: true });
  await until(c, (s) => s.kind === 'ready');
  const keys = createEncKeys();
  const e2e = new E2EClient({ deviceId: identity.deviceId, encSecret: keys.secret, encPublic: keys.public, sign: (p) => signWith(identity, p), request: (op, d) => c.request(op as never, d as never) });
  await e2e.ready(c.session!.me.id, []);
  // what the app does: everything through the E2E layer
  const req = async (op: string, d?: unknown) => e2e.incoming(await c.request(op as never, await e2e.outgoing(op, d) as never));
  return { c, e2e, req, identity };
}

test('Direct messages are sealed end to end; the hub never sees the text; new devices get history', async () => {
  const { hub, owner } = await office();
  const a = await person(hub, owner, 'asha');
  const b = await person(hub, owner, 'bala');
  const dm = await a.c.request('conv.create', { kind: 'direct', members: [me(b.c)] });
  await a.e2e.ready(me(a.c), []);
  assert.equal((await a.e2e.status(dm.id)).encrypted, true);
  const sent = await a.req('msg.send', { convId: dm.id, body: 'Tender price is 4.2 crore', clientId: 'x1' }) as Message;
  assert.equal(sent.body, 'Tender price is 4.2 crore');
  assert.equal(sent.e2e, 'ok');
  // on the hub: only the envelope
  const raw = hub.messaging['db'].prepare('SELECT body FROM messages WHERE id = ?').get(sent.id) as { body: string };
  assert.ok(isSealed(raw.body));
  assert.doesNotMatch(raw.body, /crore/);
  assert.equal((await owner.request('search', { q: 'crore' })).messages.length, 0);
  const preview = (await b.c.request('conv.list')).find((c) => c.id === dm.id)!.lastMessage!.body;
  assert.equal(preview, '🔒 Encrypted message');
  // Bala reads it
  const list = await b.req('msg.list', { convId: dm.id }) as { messages: Message[] };
  assert.equal(list.messages[0].body, 'Tender price is 4.2 crore');
  assert.equal(list.messages[0].e2e, 'ok');
  // edits stay sealed
  await a.req('msg.edit', { messageId: sent.id, body: 'Tender price is 4.1 crore' });
  const edited = await b.req('msg.list', { convId: dm.id }) as { messages: Message[] };
  assert.equal(edited.messages[0].body, 'Tender price is 4.1 crore');
  // Bala's new laptop: cannot read old messages until one of his devices shares them
  const laptopId = createIdentity();
  const lc = new HubClient({ identity: laptopId, account: { username: 'bala', domain: 'DEX', displayName: 'bala', hostname: 'bala-laptop' } });
  cleanups.push(() => lc.disconnect());
  lc.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
  await until(lc, (s) => s.kind === 'pending');
  await owner.request('admin.decide', { deviceId: laptopId.deviceId, approve: true });
  await until(lc, (s) => s.kind === 'ready');
  const lkeys = createEncKeys();
  const le2e = new E2EClient({ deviceId: laptopId.deviceId, encSecret: lkeys.secret, encPublic: lkeys.public, sign: (p) => signWith(laptopId, p), request: (op, d) => lc.request(op as never, d as never) });
  await le2e.ready(me(lc), []);
  const before = await le2e.incoming(await lc.request('msg.list', { convId: dm.id }));
  assert.equal(before.messages[0].e2e, 'locked');
  // Bala's PC hears about the new key and shares
  await b.e2e.onEvent('e2e.keysChanged', { userId: me(b.c), deviceId: laptopId.deviceId });
  const after = await le2e.incoming(await lc.request('msg.list', { convId: dm.id }));
  assert.equal(after.messages[0].body, 'Tender price is 4.1 crore');
  // forwarding an encrypted message into a Space posts readable text there
  const space = await a.c.request('conv.create', { kind: 'space', name: 'Bids', members: [me(b.c)] });
  const fwd = await a.req('msg.forward', { messageId: sent.id, convIds: [space.id] }) as Message[];
  assert.equal(fwd[0].body, 'Tender price is 4.1 crore');
  await assert.rejects(a.c.request('msg.forward', { messageId: sent.id, convIds: [space.id] }), /only be forwarded from the app/);
  lc.disconnect();
});

test('a Direct conversation with someone on an old app stays readable (not sealed)', async () => {
  const { hub, owner, priya } = await office();
  const a = await person(hub, owner, 'asha');
  const dm = await a.c.request('conv.create', { kind: 'direct', members: [me(priya)] });
  assert.deepEqual((await a.e2e.status(dm.id)).missing, [me(priya)]);
  const sent = await a.req('msg.send', { convId: dm.id, body: 'hello', clientId: 'y1' }) as Message;
  assert.equal(sent.e2e, undefined);
  assert.equal((await priya.request('msg.list', { convId: dm.id })).messages[0].body, 'hello');
});

test("the office's data-loss rules run on the sender's device before a Direct message is sealed", async () => {
  const { hub, owner } = await office();
  await owner.request('admin.policy.set', { dlp: [
    { id: 'c', name: 'Card numbers', detector: 'card', action: 'mask', scope: 'everywhere' },
    { id: 'w', name: 'Project Falcon', detector: 'words', words: 'Project Falcon', action: 'block', scope: 'everywhere' },
  ] });
  const a = await person(hub, owner, 'asha');
  const b = await person(hub, owner, 'bala');
  const dm = await a.c.request('conv.create', { kind: 'direct', members: [me(b.c)] });
  await a.e2e.ready(me(a.c), []);
  assert.equal((await a.e2e.status(dm.id)).encrypted, true);
  await assert.rejects(a.req('msg.send', { convId: dm.id, body: 'Project Falcon numbers', clientId: 'f1' }), /doesn't allow project falcon/);
  const sent = await a.req('msg.send', { convId: dm.id, body: 'Pay with 4111 1111 1111 1111', clientId: 'f2' }) as Message;
  assert.equal(sent.body, 'Pay with ••••');
  const raw = hub.messaging['db'].prepare('SELECT body FROM messages WHERE id = ?').get(sent.id) as { body: string };
  assert.ok(isSealed(raw.body), 'sealed after masking');
  const list = await b.req('msg.list', { convId: dm.id }) as { messages: Message[] };
  assert.equal(list.messages[0].body, 'Pay with ••••');
});
