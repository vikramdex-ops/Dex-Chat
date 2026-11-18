// Web Push for the iPhone web app: message encryption against RFC 8291's own example, round trips,
// the VAPID token (RFC 8292) and which push addresses a hub may send to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _derive, b64url, decryptPush, encryptPush, generateVapidKeys, pushEndpointProblem, unb64url, validVapidKeys, vapidAuthorization, verifyVapid } from '../src/webpush.ts';

// RFC 8291 section 5 and appendix A
const V = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  ecdh: 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs',
  ikm: 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg',
  prk: '09_eUZGrsvxChDCGRCdkLiDXrReGOEVeSCdCcPBSJSc',
  cek: 'oIhVW04MRdy2XN9CiKLxTg',
  nonce: '4h_95klXJ5E_qnoN',
  result: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

test('RFC 8291: the intermediate values and the encrypted message of the RFC\'s example', async () => {
  const d = await _derive(unb64url(V.ecdh), unb64url(V.auth), unb64url(V.uaPublic), unb64url(V.asPublic), unb64url(V.salt));
  assert.equal(b64url(d.ikm), V.ikm);
  assert.equal(b64url(d.prk), V.prk);
  assert.equal(b64url(d.cek), V.cek);
  assert.equal(b64url(d.nonce), V.nonce);
  const out = await encryptPush({ p256dh: V.uaPublic, auth: V.auth }, unb64url(V.plaintext), { salt: unb64url(V.salt), sender: { publicKey: unb64url(V.asPublic), privateKey: unb64url(V.asPrivate) } });
  assert.equal(b64url(out), V.result);
  // 86-byte header + 42 bytes of plaintext and delimiter + 16-byte tag (the RFC's example header says 145: a known erratum)
  assert.equal(out.length, 144);
  // and the receiving side opens it
  const plain = await decryptPush(out, { publicKey: unb64url(V.uaPublic), privateKey: unb64url(V.uaPrivate), auth: unb64url(V.auth) });
  assert.equal(new TextDecoder().decode(plain), 'When I grow up, I want to be a watermelon');
});

test('every message gets a fresh salt and sender key; a wrong auth secret cannot open it', async () => {
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
  const priv = unb64url((await crypto.subtle.exportKey('jwk', ua.privateKey)).d!);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const keys = { p256dh: b64url(pub), auth: b64url(auth) };
  const msg = new TextEncoder().encode(JSON.stringify({ title: 'Site visit · Vikram', body: 'नमस्ते — photos please' }));
  const a = await encryptPush(keys, msg);
  const b = await encryptPush(keys, msg);
  assert.notDeepEqual(a.subarray(0, 16), b.subarray(0, 16));
  assert.notDeepEqual(a.subarray(21, 86), b.subarray(21, 86));
  assert.equal(new TextDecoder().decode(await decryptPush(a, { publicKey: pub, privateKey: priv, auth })), new TextDecoder().decode(msg));
  await assert.rejects(decryptPush(a, { publicKey: pub, privateKey: priv, auth: crypto.getRandomValues(new Uint8Array(16)) }));
  await assert.rejects(encryptPush({ p256dh: 'AAAA', auth: keys.auth }, msg), /P-256/);
  await assert.rejects(encryptPush(keys, new Uint8Array(5000)), /too long/);
});

test('VAPID: an ES256 token for the push service\'s origin, at most a day long, that verifies with the public key', async () => {
  const keys = await generateVapidKeys();
  assert.ok(validVapidKeys(keys));
  assert.equal(unb64url(keys.publicKey).length, 65);
  const now = Date.UTC(2026, 10, 18, 10, 0, 0);
  const h = await vapidAuthorization({ endpoint: 'https://web.push.apple.com/QGuQyavXutnMH8/abc?x=1', subject: 'mailto:it@example.com', keys, now, ttlSeconds: 999_999 });
  assert.match(h, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  const v = await verifyVapid(h);
  assert.ok(v.ok);
  assert.equal(v.publicKey, keys.publicKey);
  assert.equal(v.claims!.aud, 'https://web.push.apple.com');
  assert.equal(v.claims!.sub, 'mailto:it@example.com');
  assert.equal(v.claims!.exp, now / 1000 + 24 * 3600);
  // the signature is 64 bytes (r‖s), as JWS wants
  assert.equal(unb64url(h.split('.')[2].split(',')[0]).length, 64);
  // another office's key does not verify it
  const other = await generateVapidKeys();
  const forged = h.replace(`k=${keys.publicKey}`, `k=${other.publicKey}`);
  assert.equal((await verifyVapid(forged)).ok, false);
  assert.equal(validVapidKeys({ publicKey: 'x', privateKey: 'y' }), false);
});

test('push addresses: https on the internet only (the office network is never a push service)', () => {
  assert.equal(pushEndpointProblem('https://web.push.apple.com/abc'), null);
  assert.equal(pushEndpointProblem('https://fcm.googleapis.com/fcm/send/x'), null);
  for (const bad of ['http://web.push.apple.com/x', 'https://192.168.1.20/x', 'https://hub-pc/x', 'https://hub.local/x', 'https://[::1]/x', 'https://u:p@push.example.com/x', 'not a url', 'http://127.0.0.1:9/x']) {
    assert.ok(pushEndpointProblem(bad), bad);
  }
  // only the local test push service, and only when asked
  assert.equal(pushEndpointProblem('http://127.0.0.1:9/x', true), null);
});
