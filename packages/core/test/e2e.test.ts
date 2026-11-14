import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addWraps, createEncKeys, encKeyStatement, isSealed, open, rawEd25519FromSpki, rewrap, safetyCode, seal, sealedFor, verifyDeviceKey } from '../src/e2e.ts';
import { createIdentity, signWith } from '../src/identity.ts';

function device(userId: string) {
  const id = createIdentity();
  const keys = createEncKeys();
  return {
    userId, id, keys,
    pub: { userId, deviceId: id.deviceId, signKey: id.publicKey, encKey: keys.public, sig: signWith(id, encKeyStatement(id.deviceId, keys.public)) },
    sign: (p: Uint8Array) => signWith(id, p),
  };
}

test('sealed Direct messages open only on the devices they were sealed for', async () => {
  const priyaPc = device('priya');
  const priyaPhone = device('priya');
  const ravi = device('ravi');
  const outsider = device('anita');
  for (const d of [priyaPc, priyaPhone, ravi]) assert.ok(verifyDeviceKey(d.pub));
  assert.equal(verifyDeviceKey({ ...ravi.pub, encKey: outsider.keys.public }), false, 'a swapped key is caught');

  const body = await seal({ convId: 'C1', text: 'The bid is ₹4.2 crore 🤐', senderDeviceId: priyaPc.id.deviceId, sign: priyaPc.sign, recipients: [priyaPc.pub, priyaPhone.pub, ravi.pub] });
  assert.ok(isSealed(body));
  assert.doesNotMatch(body, /crore/);
  const signKeyOf = (id: string) => (id === priyaPc.id.deviceId ? rawEd25519FromSpki(priyaPc.id.publicKey) : null);
  for (const d of [priyaPc, priyaPhone, ravi]) {
    assert.deepEqual(await open({ convId: 'C1', body, myDeviceId: d.id.deviceId, mySecret: d.keys.secret, signKeyOf }), { text: 'The bid is ₹4.2 crore 🤐', verified: true });
  }
  assert.deepEqual(await open({ convId: 'C1', body, myDeviceId: outsider.id.deviceId, mySecret: outsider.keys.secret, signKeyOf }), { error: 'not-for-this-device' });
  // moved to another conversation by a malicious relay: refuses to open
  assert.deepEqual(await open({ convId: 'C2', body, myDeviceId: ravi.id.deviceId, mySecret: ravi.keys.secret, signKeyOf }), { error: 'damaged' });
  // unknown sender key: readable but not verified
  assert.deepEqual(await open({ convId: 'C1', body, myDeviceId: ravi.id.deviceId, mySecret: ravi.keys.secret, signKeyOf: () => null }), { text: 'The bid is ₹4.2 crore 🤐', verified: false });

  // Priya gets a new laptop: her PC shares the key with it
  const laptop = device('priya');
  const wraps = await rewrap({ body, myDeviceId: priyaPc.id.deviceId, mySecret: priyaPc.keys.secret, devices: [laptop.pub] });
  const updated = addWraps(body, wraps!)!;
  assert.deepEqual(sealedFor(updated).sort(), [priyaPc, priyaPhone, ravi, laptop].map((d) => d.id.deviceId).sort());
  assert.equal(((await open({ convId: 'C1', body: updated, myDeviceId: laptop.id.deviceId, mySecret: laptop.keys.secret, signKeyOf })) as { text: string }).text, 'The bid is ₹4.2 crore 🤐');
  // an outsider cannot add a working wrap without the content key
  assert.equal(await rewrap({ body, myDeviceId: outsider.id.deviceId, mySecret: outsider.keys.secret, devices: [outsider.pub] }), null);
});

test('safety codes match on both sides and change when a key changes', () => {
  const a = device('a').pub;
  const b = device('b').pub;
  assert.equal(safetyCode([a, b]), safetyCode([b, a]));
  assert.match(safetyCode([a, b]), /^\d{5} \d{5} \d{5} \d{5} \d{5} \d{5}$/);
  assert.notEqual(safetyCode([a, b]), safetyCode([a, device('b').pub]));
});
