// The IT Support service's frames as the hub reads them: the machine key and signature check,
// pictures, and input events as virtual-key commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { FRAME_MAX, decodeFrame, machineIdFor, machineInputs, verifyMachineSignature } from '../src/machine.ts';

test('a machine id is its P-256 key hashed; only that key signs for it', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const id = machineIdFor(pub);
  assert.match(id, /^m[0-9a-f]{31}$/);
  const payload = new TextEncoder().encode('dexconnect-auth-v1|nonce|FP|' + id);
  const sig = crypto.sign('sha256', payload, { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
  assert.equal(verifyMachineSignature(pub, payload, sig), true);
  assert.equal(verifyMachineSignature(pub, new TextEncoder().encode('other'), sig), false);
  // an Ed25519 key (people's devices) is not a machine key
  const ed = crypto.generateKeyPairSync('ed25519');
  const edPub = ed.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  assert.equal(verifyMachineSignature(edPub, payload, crypto.sign(null, payload, ed.privateKey).toString('base64')), false);
  assert.equal(verifyMachineSignature('not a key', payload, sig), false);
});

test('pictures: sizes and base64 checked, bounded', () => {
  const ok = { t: 'm.frame', s: 'S1', w: 1920, h: 1080, seq: 3, d: Buffer.from([0xff, 0xd8, 1, 2]).toString('base64') };
  assert.deepEqual(decodeFrame(ok), { s: 'S1', w: 1920, h: 1080, seq: 3, d: ok.d });
  assert.equal(decodeFrame({ ...ok, w: 0 }), null);
  assert.equal(decodeFrame({ ...ok, h: 1.5 }), null);
  assert.equal(decodeFrame({ ...ok, d: '' }), null);
  assert.equal(decodeFrame({ ...ok, d: '<script>' }), null);
  assert.equal(decodeFrame({ ...ok, d: 'A'.repeat(FRAME_MAX + 1) }), null);
  assert.equal(decodeFrame(null), null);
});

test('input events become the service commands: keys as virtual-key codes', () => {
  assert.deepEqual(machineInputs([
    { t: 'key', code: 'KeyA', down: true },
    { t: 'key', code: 'ArrowLeft', down: false },
    { t: 'move', x: 0.1, y: 0.2 },
    { t: 'button', b: 'right', down: true, x: 0.5, y: 0.5 },
  ]), [
    { t: 'key', vk: 0x41, ext: false, down: true },
    { t: 'key', vk: 0x25, ext: true, down: false },
    { t: 'move', x: 0.1, y: 0.2 },
    { t: 'button', b: 'right', down: true, x: 0.5, y: 0.5 },
  ]);
});
