// Adding your own phone or laptop with a pairing code: no administrator, one use, 24 hours.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity } from '@dex/core';
import { HubClient } from '@dex/core/client';
import { parsePairCode, GET_PAGE } from '@dex/core/remote';
import { office, until, nextEvent, me, cleanups } from './office.ts';

const device = (hub: { port: number; fingerprint: string }, pair: string, hostname = 'Pixel 8') => {
  const identity = createIdentity();
  const c = new HubClient({ identity, account: { username: `phone-${identity.deviceId.slice(0, 8)}`, domain: 'PHONE', displayName: 'Phone', hostname } });
  c.setPair(pair);
  cleanups.push(() => c.disconnect());
  c.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
  return { c, identity };
};

test('a pairing code adds a phone to your own account at once, and only once', async () => {
  const { hub, priya } = await office();
  const made = await priya.request('pair.create', { kind: 'phone' });
  assert.ok(made.link.startsWith(`${GET_PAGE}#DXP1-`));
  const info = parsePairCode(made.code)!;
  assert.equal(info.fp, hub.fingerprint);
  assert.equal(info.kind, 'phone');
  assert.ok(made.expiresAt > Date.now() + 23 * 3600_000);
  const told = nextEvent<{ hostname: string }>(priya, 'me.devicePaired');
  const phone = device(hub, info.token);
  await until(phone.c, (s) => s.kind === 'ready');
  assert.equal(me(phone.c), me(priya), 'the phone is Priya');
  assert.equal((await told).hostname, 'Pixel 8');
  const mine = await priya.request('me.devices');
  assert.equal(mine.length, 2);
  assert.ok(mine.find((d) => d.id === phone.identity.deviceId)?.paired);
  assert.ok(mine.find((d) => d.current && !d.paired));
  // the same code again: refused
  const again = device(hub, info.token, 'Other phone');
  await until(again.c, (s) => s.kind === 'rejected');
  assert.match((again.c.state as { reason: string }).reason, /already used/);
  // a made-up code: refused
  const fake = device(hub, 'A'.repeat(24));
  await until(fake.c, (s) => s.kind === 'rejected');
  // removing it signs it out
  await priya.request('me.devices.remove', { deviceId: phone.identity.deviceId });
  await until(phone.c, (s) => s.kind === 'rejected');
  await assert.rejects(priya.request('me.devices.remove', { deviceId: priya.session!.deviceId }), /cannot remove the device you are using/);
});

test('expired codes, guests and the office policy', async () => {
  const { hub, owner, ravi } = await office();
  const old = hub.pairing.create(me(ravi), 'laptop', Date.now() - 25 * 3600_000);
  const late = device(hub, old.token, 'Home laptop');
  await until(late.c, (s) => s.kind === 'rejected');
  assert.match((late.c.state as { reason: string }).reason, /expired/);
  // someone else's device list stays private
  await assert.rejects(owner.request('me.devices.remove', { deviceId: ravi.session!.deviceId }), /not found/);
  await owner.request('admin.policy.set', { personalDevices: false });
  await assert.rejects(ravi.request('pair.create', { kind: 'phone' }), /turned off/);
  await owner.request('admin.policy.set', { personalDevices: true });
  const ok = await ravi.request('pair.create', { kind: 'laptop' });
  assert.equal(parsePairCode(ok.code)!.kind, 'laptop');
});
