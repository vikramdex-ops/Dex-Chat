// The iPhone web app's notifications: the hub pushes to a device's subscription while the app is
// in the background, encrypted to the device, signed with the office's VAPID key, following the
// person's notification preferences; a subscription the push service has dropped is forgotten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { b64url, decryptPush, verifyVapid } from '@dex/core/webpush';
import type { PushPayload } from '@dex/core/webpush';
import { office, me, send, cleanups } from './office.ts';
import { cleanPrefs, quietNow } from '../src/webpush.ts';

interface Got { path: string; headers: http.IncomingHttpHeaders; payload: PushPayload }

/** A stand-in push service on this machine, and a browser's subscription keys for it. */
async function pushService() {
  const got: Got[] = [];
  let status = 201;
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
  const privateKey = Uint8Array.from(Buffer.from((await crypto.subtle.exportKey('jwk', ua.privateKey)).d!, 'base64url'));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const waiters: Array<() => void> = [];
  const server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => parts.push(c));
    req.on('end', async () => {
      try {
        const plain = await decryptPush(new Uint8Array(Buffer.concat(parts)), { publicKey, privateKey, auth });
        got.push({ path: req.url ?? '', headers: req.headers, payload: JSON.parse(new TextDecoder().decode(plain)) });
      } catch (e) { got.push({ path: req.url ?? '', headers: req.headers, payload: { title: 'UNREADABLE', body: (e as Error).message } }); }
      res.writeHead(status).end();
      for (const w of waiters.splice(0)) w();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/push/device-1`;
  return {
    got, endpoint,
    keys: { p256dh: b64url(publicKey), auth: b64url(auth) },
    setStatus: (s: number) => { status = s; },
    next: (n: number, ms = 6000) => new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`expected ${n} pushes, got ${got.length}`)), ms);
      const check = () => { if (got.length >= n) { clearTimeout(t); resolve(); } else waiters.push(check); };
      check();
    }),
  };
}

const prefs = (p: Record<string, unknown> = {}) => ({ notifyFor: 'all', showPreviews: true, quietFrom: null, quietTo: null, zone: 'Asia/Kolkata', silent: false, ...p }) as never;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('pushes go to a device in the background only, encrypted to it and signed with the office key, one per conversation', async () => {
  const { priya, ravi, owner } = await office({ webPush: { allowLocal: true } });
  const ps = await pushService();
  const { publicKey } = await priya.request('push.key');
  assert.equal(Buffer.from(publicKey, 'base64url').length, 65);
  assert.equal((await priya.request('push.key')).publicKey, publicKey, 'the same key every time');
  await priya.request('push.subscribe', { endpoint: ps.endpoint, keys: ps.keys, prefs: prefs() });
  assert.equal((await priya.request('push.status')).subscribed, true);
  const dm = await ravi.request('conv.create', { kind: 'direct', members: [me(priya)] });

  // on screen: the app shows it, nothing is pushed
  await send(ravi, dm.id, 'On screen');
  await sleep(1800);
  assert.equal(ps.got.length, 0);

  // in the background: pushed
  await priya.request('push.active', { active: false });
  await send(ravi, dm.id, 'Can you check ISO-1001?');
  await send(ravi, dm.id, 'And the nozzle loads');
  await ps.next(1);
  await sleep(400);
  assert.equal(ps.got.length, 1, 'gathered into one notification for the conversation');
  const p = ps.got[0];
  assert.equal(p.payload.title, 'Ravi');
  assert.equal(p.payload.body, '2 new messages · And the nozzle loads');
  assert.equal(p.payload.link, `dexconnect://conversation/${dm.id}`);
  assert.equal(p.payload.tag, dm.id);
  assert.equal(p.payload.badge, 2);
  assert.equal(p.headers['content-encoding'], 'aes128gcm');
  assert.equal(p.headers.ttl, '86400');
  assert.equal(p.headers.urgency, 'high');
  assert.ok(p.headers.topic);
  const v = await verifyVapid(String(p.headers.authorization));
  assert.ok(v.ok, 'a valid VAPID token');
  assert.equal(v.publicKey, publicKey);
  assert.equal(v.claims!.aud, new URL(ps.endpoint).origin);

  // previews off: the push service and the lock screen see no text
  await priya.request('push.subscribe', { endpoint: ps.endpoint, keys: ps.keys, prefs: prefs({ showPreviews: false }) });
  await priya.request('push.active', { active: false });
  await send(ravi, dm.id, 'The password for the site office is on the board');
  await ps.next(2);
  assert.equal(ps.got[1].payload.title, 'Dexterity Connect');
  assert.equal(ps.got[1].payload.body, 'New message');
  assert.ok(!JSON.stringify(ps.got[1].payload).includes('password'));

  // mentions only: a general Space message stays quiet, a mention comes through
  await priya.request('push.subscribe', { endpoint: ps.endpoint, keys: ps.keys, prefs: prefs({ notifyFor: 'mentions' }) });
  await priya.request('push.active', { active: false });
  const space = await owner.request('conv.create', { kind: 'space', name: 'P-12 Piping', members: [me(priya), me(ravi)] });
  await send(owner, space.id, 'General note for everyone');
  await sleep(1800);
  assert.equal(ps.got.length, 2);
  await send(owner, space.id, `<@${me(priya)}> the loads are in`);
  await ps.next(3);
  assert.equal(ps.got[2].payload.title, '@ you in P-12 Piping · Vikram');

  // back on screen: the badge starts again
  await priya.request('push.active', { active: true });
  await priya.request('push.active', { active: false });
  await send(ravi, dm.id, 'One more');
  await ps.next(4);
  assert.equal(ps.got[3].payload.badge, 1);

  // the test notification
  assert.deepEqual(await priya.request('push.test'), { ok: true, error: null });
  assert.equal(ps.got[4].payload.test, true);
});

test('a subscription the push service has dropped is forgotten; removing the device removes it; bad subscriptions are refused', async () => {
  const { priya, ravi, owner } = await office({ webPush: { allowLocal: true } });
  const ps = await pushService();
  await assert.rejects(priya.request('push.subscribe', { endpoint: 'https://192.168.1.20/push', keys: ps.keys, prefs: prefs() }), /internet/);
  await assert.rejects(priya.request('push.subscribe', { endpoint: ps.endpoint, keys: { p256dh: 'short', auth: 'x' }, prefs: prefs() }), /not complete/);
  await priya.request('push.subscribe', { endpoint: ps.endpoint, keys: ps.keys, prefs: prefs() });
  await priya.request('push.active', { active: false });
  ps.setStatus(410);
  const dm = await ravi.request('conv.create', { kind: 'direct', members: [me(priya)] });
  await send(ravi, dm.id, 'Hello');
  await ps.next(1);
  await sleep(200);
  assert.equal((await priya.request('push.status')).subscribed, false, 'gone at the push service, gone here');

  ps.setStatus(201);
  await priya.request('push.subscribe', { endpoint: ps.endpoint, keys: ps.keys, prefs: prefs() });
  assert.equal((await priya.request('push.status')).subscribed, true);
  await owner.request('admin.revoke', { deviceId: priya.session!.deviceId });
  await sleep(200);
  await send(ravi, dm.id, 'After removal');
  await sleep(1800);
  assert.equal(ps.got.length, 1, 'a removed device gets nothing');
});

test('preferences: cleaned on the way in; quiet hours in the device\'s own time zone', () => {
  const p = cleanPrefs({ notifyFor: 'everything', showPreviews: 'no', quietFrom: '22:00', quietTo: '7:00', zone: 'Not/AZone', silent: 1 });
  assert.deepEqual(p, { notifyFor: 'all', showPreviews: true, quietFrom: '22:00', quietTo: null, zone: 'UTC', silent: false });
  const q = cleanPrefs({ quietFrom: '22:00', quietTo: '07:00', zone: 'Asia/Kolkata' });
  // 23:30 IST is 18:00 UTC; 12:00 IST is 06:30 UTC
  assert.equal(quietNow(q, Date.UTC(2026, 10, 18, 18, 0)), true);
  assert.equal(quietNow(q, Date.UTC(2026, 10, 18, 6, 30)), false);
  assert.equal(quietNow(cleanPrefs({ quietFrom: '13:00', quietTo: '14:00', zone: 'Asia/Kolkata' }), Date.UTC(2026, 10, 18, 7, 45)), true);
});
