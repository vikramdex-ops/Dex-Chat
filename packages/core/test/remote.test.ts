import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import forge from 'node-forge';
import { Channel, F, deviceFinish, deviceHello, fingerprintOf, hubAnswer, parseSetupCode, setupCode } from '../src/remote.ts';

function makeHub() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const c = forge.pki.createCertificate();
  c.publicKey = keys.publicKey;
  c.serialNumber = '01';
  c.validity.notBefore = new Date();
  c.validity.notAfter = new Date(Date.now() + 86400_000);
  c.setSubject([{ name: 'commonName', value: 'hub' }]);
  c.setIssuer([{ name: 'commonName', value: 'hub' }]);
  c.sign(keys.privateKey, forge.md.sha256.create());
  const pem = forge.pki.certificateToPem(c);
  const x = new crypto.X509Certificate(pem);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
  return {
    fp: x.fingerprint256,
    id: {
      hubId: 'HUB123',
      certDer: new Uint8Array(x.raw),
      spkiDer: new Uint8Array(x.publicKey.export({ type: 'spki', format: 'der' })),
      sign: (d: Uint8Array) => new Uint8Array(crypto.sign('sha256', d, keyPem)),
    },
  };
}
const hub = makeHub();
const other = makeHub();

test('device and hub agree on keys, only with the pinned certificate', async () => {
  assert.equal(fingerprintOf(hub.id.certDer), hub.fp);
  const d = deviceHello();
  const { channel: hubSide, answer } = await hubAnswer(hub.id, d.hello);
  const { channel: dev, fingerprint } = await deviceFinish(d, answer, 'HUB123', hub.fp);
  assert.equal(fingerprint, hub.fp);
  const sealed = await dev.seal(F.TEXT, new TextEncoder().encode('{"t":"auth"}'));
  const opened = await hubSide.open(sealed);
  assert.equal(opened.type, F.TEXT);
  assert.equal(new TextDecoder().decode(opened.body), '{"t":"auth"}');
  const back = await hubSide.open(await dev.seal(F.PING, new Uint8Array(0))).then(() => hubSide.seal(F.PONG, new Uint8Array([7])));
  assert.deepEqual([...(await dev.open(back)).body], [7]);

  // another hub (or the gateway itself) cannot pass as this one
  const d2 = deviceHello();
  const fake = await hubAnswer(other.id, d2.hello);
  await assert.rejects(deviceFinish(d2, fake.answer, 'HUB123', hub.fp), /not the one this device trusts/);
  // a valid certificate with someone else's key and signature
  const d3 = deviceHello();
  const mixed = await hubAnswer({ ...other.id, certDer: hub.id.certDer }, d3.hello);
  await assert.rejects(deviceFinish(d3, mixed.answer, 'HUB123', hub.fp), /does not belong|signature/);
  // signed for a different hub id
  const d4 = deviceHello();
  const wrongId = await hubAnswer({ ...hub.id, hubId: 'OTHER' }, d4.hello);
  await assert.rejects(deviceFinish(d4, wrongId.answer, 'HUB123', hub.fp), /signature/);
});

test('frames cannot be tampered with, replayed or reordered', async () => {
  const d = deviceHello();
  const { channel: hubSide, answer } = await hubAnswer(hub.id, d.hello);
  const { channel: dev } = await deviceFinish(d, answer, 'HUB123', hub.fp);
  const a = await dev.seal(F.TEXT, new TextEncoder().encode('one'));
  const b = await dev.seal(F.TEXT, new TextEncoder().encode('two'));
  const flipped = a.slice(); flipped[3] ^= 1;
  await assert.rejects(hubSide.open(flipped));
  // the failed frame used up counter 0: the real first frame no longer opens either (the channel must close)
  await assert.rejects(hubSide.open(a));
  const fresh = deviceHello();
  const h2 = await hubAnswer(hub.id, fresh.hello);
  const d2 = await deviceFinish(fresh, h2.answer, 'HUB123', hub.fp);
  const x = await d2.channel.seal(F.TEXT, new Uint8Array([1]));
  const y = await d2.channel.seal(F.TEXT, new Uint8Array([2]));
  await assert.rejects(h2.channel.open(y), 'out of order');
  void x; void b; void Channel;
});

test('setup codes round-trip and reject anything malformed', () => {
  const code = setupCode({ url: 'https://dex-gateway.example.workers.dev', hubId: 'HUB123', fp: hub.fp, name: 'Dexterity Office' });
  assert.match(code, /^DXC1-[A-Za-z0-9_-]+$/);
  assert.deepEqual(parseSetupCode(`Here is the code: ${code} thanks`), { url: 'https://dex-gateway.example.workers.dev', hubId: 'HUB123', fp: hub.fp, name: 'Dexterity Office' });
  assert.equal(parseSetupCode('DXC1-nope'), null);
  assert.equal(parseSetupCode(setupCode({ url: 'http://insecure.example', hubId: 'HUB123', fp: hub.fp })), null, 'gateway must be https');
  assert.equal(parseSetupCode(setupCode({ url: 'https://x.example', hubId: 'HUB123', fp: 'AB:CD' })), null);
});
