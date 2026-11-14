import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { ulid, ulidTime, createIdentity, signWith, verifySignature, deviceIdFor, isValidIdentity, authPayload, accountKey } from '../src/index.ts';
import { HubAnnouncer, HubFinder, broadcastTargets, parsePacket } from '../src/discovery.ts';
import type { HubBeacon } from '../src/discovery.ts';

const FP = Array.from({ length: 32 }, () => 'AB').join(':');

test('ulid is unique, 26 chars, time-ordered and monotonic within a millisecond', () => {
  const ids = Array.from({ length: 2000 }, () => ulid(1_700_000_000_000));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every((id) => id.length === 26));
  assert.deepEqual([...ids].sort(), ids);
  assert.equal(ulidTime(ids[0]), 1_700_000_000_000);
  assert.ok(ulid(1_800_000_000_000) > ids.at(-1)!);
});

test('device identity signs and verifies; tampering fails', () => {
  const id = createIdentity();
  assert.ok(isValidIdentity(id));
  assert.equal(id.deviceId, deviceIdFor(id.publicKey));
  const payload = authPayload('nonce', FP, id.deviceId);
  const sig = signWith(id, payload);
  assert.ok(verifySignature(id.publicKey, payload, sig));
  assert.ok(!verifySignature(id.publicKey, authPayload('nonce2', FP, id.deviceId), sig));
  assert.ok(!verifySignature(createIdentity().publicKey, payload, sig));
  assert.ok(!verifySignature('not-a-key', payload, sig));
  assert.ok(!isValidIdentity({ ...id, deviceId: 'x' }));
});

test('account keys are case-insensitive domain\\user', () => {
  assert.equal(accountKey({ domain: 'DEXTERITY', username: 'Priya.R' }), 'dexterity\\priya.r');
});

test('discovery packets are validated strictly', () => {
  const good: HubBeacon = { app: 'dexconnect', v: 1, kind: 'hub', id: 'abc', name: 'Hub', port: 47900, fp: FP, version: '0.1.0' };
  assert.deepEqual(parsePacket(Buffer.from(JSON.stringify(good))), good);
  assert.equal(parsePacket(Buffer.from(JSON.stringify({ ...good, fp: 'nope' }))), null);
  assert.equal(parsePacket(Buffer.from(JSON.stringify({ ...good, port: 70000 }))), null);
  assert.equal(parsePacket(Buffer.from(JSON.stringify({ ...good, app: 'other' }))), null);
  assert.equal(parsePacket(Buffer.from('garbage')), null);
  assert.deepEqual(parsePacket(Buffer.from('{"app":"dexconnect","v":1,"kind":"probe"}')), { app: 'dexconnect', v: 1, kind: 'probe' });
  assert.ok(broadcastTargets().includes('255.255.255.255'));
});

async function freeUdpPort(): Promise<number> {
  const s = dgram.createSocket('udp4');
  await new Promise<void>((r) => s.bind(0, r));
  const port = s.address().port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

test('a probing client finds an announcing hub', async () => {
  const port = await freeUdpPort();
  const beacon: HubBeacon = { app: 'dexconnect', v: 1, kind: 'hub', id: 'hub-1', name: 'Office', port: 47900, fp: FP, version: '0.1.0' };
  const announcer = new HubAnnouncer(() => beacon, port);
  await announcer.start();
  const finder = new HubFinder({ port, targets: ['127.0.0.1'], intervalMs: 200 });
  try {
    const found = await new Promise<{ beacon: HubBeacon; address: string }>((resolve) => {
      finder.once('hub', resolve);
      finder.start();
    });
    assert.equal(found.beacon.id, 'hub-1');
    assert.equal(found.address, '127.0.0.1');
    assert.ok(finder.hubs.has('hub-1'));
  } finally {
    finder.stop();
    announcer.stop();
  }
});
