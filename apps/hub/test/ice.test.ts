import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ice } from '../src/ice.ts';
import { office } from './office.ts';

test('calls get relay servers: none on the LAN only, STUN when remote access is on, custom, or Cloudflare TURN', async () => {
  const { owner, priya } = await office();
  assert.deepEqual((await priya.request('room.ice')).iceServers, []);
  await assert.rejects(priya.request('admin.ice.set', { mode: 'custom', servers: [{ urls: 'turn:turn.example.com:3478' }] }), /administrators/);
  await assert.rejects(owner.request('admin.ice.set', { mode: 'custom', servers: [{ urls: 'http://evil.example' }] }), /stun:, turn:/);
  const saved = await owner.request('admin.ice.set', { mode: 'custom', servers: [{ urls: ['turn:turn.example.com:3478?transport=udp', 'turns:turn.example.com:5349'], username: 'dex', credential: 'secret-pass' }] });
  assert.equal(saved.servers[0].credential, '••••••', 'the credential is not shown back');
  const ice = (await priya.request('room.ice')).iceServers;
  assert.deepEqual(ice, [{ urls: ['turn:turn.example.com:3478?transport=udp', 'turns:turn.example.com:5349'], username: 'dex', credential: 'secret-pass' }]);
  await assert.rejects(owner.request('admin.ice.set', { mode: 'cloudflare', keyId: 'short' }), /32 letters/);
  const cf = await owner.request('admin.ice.set', { mode: 'cloudflare', keyId: 'a'.repeat(32), token: 'tok' });
  assert.equal(cf.hasToken, true);
  assert.equal(JSON.stringify(cf).includes('tok"'), false, 'the token never comes back');
});

test('Cloudflare TURN credentials are minted on the hub, cached, and port 53 dropped', async () => {
  let calls = 0;
  const fake = (async (url: string, init: RequestInit) => {
    calls++;
    assert.match(url, /\/v1\/turn\/keys\/K{32}\/credentials\/generate-ice-servers$/);
    assert.equal((init.headers as Record<string, string>).authorization, 'Bearer T');
    return new Response(JSON.stringify({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'c' }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const ice = new Ice(() => ({ mode: 'cloudflare', keyId: 'K'.repeat(32), token: 'T', servers: [] }), () => true, fake);
  const a = await ice.servers();
  assert.deepEqual(a[0].urls, ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp']);
  await ice.servers();
  assert.equal(calls, 1, 'cached');
  const down = new Ice(() => ({ mode: 'cloudflare', keyId: 'K'.repeat(32), token: 'T', servers: [] }), () => true, (async () => new Response('no', { status: 500 })) as unknown as typeof fetch);
  assert.deepEqual(await down.servers(), [{ urls: ['stun:stun.cloudflare.com:3478'] }], 'falls back to STUN');
});

test('saving a TURN server without retyping its password keeps the password', async () => {
  const { owner, priya } = await office();
  await owner.request('admin.ice.set', { mode: 'custom', servers: [{ urls: ['turn:t.example.com:3478'], username: 'dex', credential: 'p1' }] });
  await owner.request('admin.ice.set', { mode: 'custom', servers: [{ urls: ['turn:t.example.com:3478'], username: 'dex2' }] });
  assert.deepEqual((await priya.request('room.ice')).iceServers, [{ urls: ['turn:t.example.com:3478'], username: 'dex2', credential: 'p1' }]);
});
