// Large Rooms go through the hub's relay (mediasoup): the Room's mode, capacity and transports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity } from '@dex/core';
import { HubClient } from '@dex/core/client';
import { office, until, me, cleanups } from './office.ts';
import { workerBin } from '../src/relay.ts';

const skip = workerBin() ? false : 'the mediasoup worker is not installed here';

test('a conversation of more than 8 holds its Room in the relay; up to 50 people', { skip }, async () => {
  const { hub, owner, priya, ravi } = await office();
  // six more approved people
  const extra: HubClient[] = [];
  for (let i = 0; i < 6; i++) {
    const identity = createIdentity();
    const c = new HubClient({ identity, account: { username: `p${i}`, domain: 'DEX', displayName: `Person ${i}`, hostname: `p${i}-pc` } });
    cleanups.push(() => c.disconnect());
    c.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
    await until(c, (s) => s.kind === 'pending' || s.kind === 'ready');
    await owner.request('admin.decide', { deviceId: identity.deviceId, approve: true });
    await until(c, (s) => s.kind === 'ready');
    extra.push(c);
  }
  const small = await owner.request('conv.create', { kind: 'space', name: 'Small', members: [me(priya)] });
  const big = await owner.request('conv.create', { kind: 'space', name: 'All hands', members: [me(priya), me(ravi), ...extra.map(me)] });
  const s = await owner.request('room.start', { convId: small.id, video: false });
  assert.equal(s.mode, 'mesh');
  assert.equal(s.capacity, 8);
  await owner.request('room.leave', { roomId: s.id });
  const r = await owner.request('room.start', { convId: big.id, video: true });
  assert.equal(r.mode, 'relay');
  assert.equal(r.capacity, 50);
  const caps = await owner.request('relay.caps', { roomId: r.id }) as { rtpCapabilities: { codecs: Array<{ mimeType: string }> } };
  assert.ok(caps.rtpCapabilities.codecs.some((c) => c.mimeType === 'audio/opus'));
  assert.ok(caps.rtpCapabilities.codecs.some((c) => c.mimeType === 'video/VP8'));
  const t = await owner.request('relay.transport', { roomId: r.id, direction: 'send' }) as { id: string; iceCandidates: Array<{ address: string; port: number; protocol: string }> };
  assert.ok(t.iceCandidates.some((c) => c.address === '127.0.0.1' && c.protocol === 'udp' && c.port >= 47910 && c.port <= 47999));
  // someone not in the Room gets nothing from the relay
  await assert.rejects(ravi.request('relay.transport', { roomId: r.id, direction: 'recv' }), /ended|Join/);
  await ravi.request('room.join', { roomId: r.id });
  assert.deepEqual(await ravi.request('relay.producers', { roomId: r.id }), []);
  await owner.request('room.leave', { roomId: r.id });
  await ravi.request('room.leave', { roomId: r.id });
});
