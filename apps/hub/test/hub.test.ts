import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import WebSocket from 'ws';
import { createIdentity, signWith, authPayload } from '@dex/core';
import type { DeviceIdentity, WindowsAccount, ServerFrame } from '@dex/core';
import { HubClient } from '@dex/core/client';
import type { ClientState, HubTarget } from '@dex/core/client';
import { HubFinder } from '@dex/core/discovery';
import { Hub } from '../src/hub.ts';

const dirs: string[] = [];
const cleanups: Array<() => unknown> = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dexhub-'));
  dirs.push(d);
  return d;
}

async function startHub(dataDir = tempDir(), extra: Partial<ConstructorParameters<typeof Hub>[0]> = {}): Promise<Hub> {
  const hub = new Hub({ dataDir, port: 0, host: '127.0.0.1', discoveryPort: false, updates: false, name: 'Test Hub', ...extra });
  await hub.start();
  return hub;
}

const account = (username: string, displayName = username): WindowsAccount =>
  ({ username, domain: 'DEXTERITY', displayName, hostname: `PC-${username.toUpperCase()}` });

function client(hub: Hub, username: string, identity: DeviceIdentity = createIdentity(), fp: string | undefined = hub.fingerprint): HubClient {
  const c = new HubClient({ identity, account: account(username), maxBackoffMs: 200 });
  cleanups.push(() => c.disconnect());
  const target: HubTarget = { host: '127.0.0.1', port: hub.port, fp };
  c.connect(target);
  return c;
}

function until(c: HubClient, pred: (s: ClientState) => boolean, ms = 5000): Promise<ClientState> {
  if (pred(c.state)) return Promise.resolve(c.state);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { c.off('state', on); reject(new Error(`timeout; last state ${c.state.kind}`)); }, ms);
    const on = (s: ClientState) => { if (pred(s)) { clearTimeout(timer); c.off('state', on); resolve(s); } };
    c.on('state', on);
  });
}
const isKind = (k: ClientState['kind']) => (s: ClientState) => s.kind === k;

function nextEvent(c: HubClient, name: string, ms = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${name} event`)), ms);
    const on = (n: string, data: unknown) => { if (n === name) { clearTimeout(timer); c.off('event', on); resolve(data); } };
    c.on('event', on);
  });
}

test('the first device becomes the owner and signs in without approval', async () => {
  const hub = await startHub();
  cleanups.push(() => hub.stop());
  const owner = client(hub, 'vikram');
  const s = await until(owner, isKind('ready'));
  assert.equal(s.kind, 'ready');
  if (s.kind !== 'ready') return;
  assert.equal(s.session.me.role, 'owner');
  assert.equal(s.session.me.account, 'dexterity\\vikram');
  assert.deepEqual(s.session.online, [s.session.me.id]);
  assert.equal(s.session.hub.name, 'Test Hub');
});

test('new devices wait for approval, then join live; presence and directory follow', async () => {
  const hub = await startHub();
  cleanups.push(() => hub.stop());
  const owner = client(hub, 'vikram');
  await until(owner, isKind('ready'));

  const pendingEvt = nextEvent(owner, 'admin.pending');
  const priya = client(hub, 'priya');
  const pending = await until(priya, isKind('pending'));
  assert.equal(pending.kind === 'pending' && pending.position, 1);
  const device = await pendingEvt as { id: string; account: string; hostname: string };
  assert.equal(device.account, 'dexterity\\priya');
  assert.equal(device.hostname, 'PC-PRIYA');

  // members cannot see people who are not yet approved
  const list = await owner.request('directory.list');
  assert.equal(list.users.length, 1);

  const presence = nextEvent(owner, 'presence');
  const added = nextEvent(owner, 'user.added');
  await owner.request('admin.decide', { deviceId: device.id, approve: true });
  const ready = await until(priya, isKind('ready'));
  assert.equal(ready.kind === 'ready' && ready.session.me.role, 'member');
  assert.equal((await added as { account: string }).account, 'dexterity\\priya');
  assert.deepEqual(await presence, { userId: ready.kind === 'ready' ? ready.session.me.id : '', online: true });
  assert.equal(owner.session!.users.length, 2);
  assert.equal(owner.session!.online.length, 2);

  // going offline is broadcast
  const offline = nextEvent(owner, 'presence');
  priya.disconnect();
  assert.equal((await offline as { online: boolean }).online, false);
  assert.equal(owner.session!.online.length, 1);
});

test('an approved device signs in silently on every later connection', async () => {
  const hub = await startHub();
  cleanups.push(() => hub.stop());
  const ownerId = createIdentity();
  const first = client(hub, 'vikram', ownerId);
  await until(first, isKind('ready'));
  first.disconnect();
  const again = client(hub, 'vikram', ownerId);
  const s = await until(again, isKind('ready'));
  assert.equal(s.kind === 'ready' && s.session.me.role, 'owner');
});

test('declined and removed devices are locked out', async () => {
  const hub = await startHub();
  cleanups.push(() => hub.stop());
  const owner = client(hub, 'vikram');
  await until(owner, isKind('ready'));

  const strangerId = createIdentity();
  const stranger = client(hub, 'stranger', strangerId);
  await until(stranger, isKind('pending'));
  await owner.request('admin.decide', { deviceId: strangerId.deviceId, approve: false });
  const r = await until(stranger, isKind('rejected'));
  assert.match(r.kind === 'rejected' ? r.reason : '', /declined/);
  const retry = client(hub, 'stranger', strangerId);
  await until(retry, isKind('rejected'));

  const raviId = createIdentity();
  const ravi = client(hub, 'ravi', raviId);
  await until(ravi, isKind('pending'));
  await owner.request('admin.decide', { deviceId: raviId.deviceId, approve: true });
  await until(ravi, isKind('ready'));
  await owner.request('admin.revoke', { deviceId: raviId.deviceId });
  const rr = await until(ravi, isKind('rejected'));
  assert.match(rr.kind === 'rejected' ? rr.reason : '', /removed/);

  await assert.rejects(owner.request('admin.decide', { deviceId: raviId.deviceId, approve: true }), /already handled/);
  const devices = await owner.request('admin.devices');
  assert.deepEqual(devices.map((d) => d.status).sort(), ['approved', 'rejected', 'revoked']);
  const audit = await owner.request('admin.audit');
  assert.ok(audit.some((a) => a.action === 'device.revoked'));
  assert.ok(audit.some((a) => a.action === 'device.rejected'));
});

test('only administrators can manage devices and roles', async () => {
  const hub = await startHub();
  cleanups.push(() => hub.stop());
  const owner = client(hub, 'vikram');
  await until(owner, isKind('ready'));
  const anuId = createIdentity();
  const anu = client(hub, 'anu', anuId);
  await until(anu, isKind('pending'));
  await owner.request('admin.decide', { deviceId: anuId.deviceId, approve: true });
  await until(anu, isKind('ready'));

  await assert.rejects(anu.request('admin.devices'), /Only administrators/);
  await assert.rejects(anu.request('admin.setRole', { userId: owner.session!.me.id, role: 'member' }), /Only administrators/);
  await assert.rejects(owner.request('admin.setRole', { userId: owner.session!.me.id, role: 'member' }), /own role/);
  await assert.rejects(owner.request('admin.revoke', { deviceId: owner.session!.deviceId }), /device you are using/);

  const updated = nextEvent(anu, 'user.updated');
  const promoted = await owner.request('admin.setRole', { userId: anu.session!.me.id, role: 'admin' });
  assert.equal(promoted.role, 'admin');
  await updated;
  assert.equal(anu.session!.me.role, 'admin');
  assert.ok((await anu.request('admin.devices')).length >= 2);
  await assert.rejects(anu.request('admin.setRole', { userId: owner.session!.me.id, role: 'member' }), /owner cannot be changed/);
});

test('profile updates reach everyone', async () => {
  const hub = await startHub();
  cleanups.push(() => hub.stop());
  const owner = client(hub, 'vikram');
  await until(owner, isKind('ready'));
  const me = await owner.request('me.update', { displayName: '  Vikram S  ', title: 'Lead Engineer', statusText: 'On site at P-12' });
  assert.equal(me.displayName, 'Vikram S');
  assert.equal(me.title, 'Lead Engineer');
  await assert.rejects(owner.request('me.update', { displayName: '   ' }), /cannot be empty/);
  assert.equal(owner.session!.me.statusText, 'On site at P-12');
});

test('a hub with an unexpected certificate is refused and never retried', async () => {
  const hub = await startHub();
  cleanups.push(() => hub.stop());
  const wrong = Array.from({ length: 32 }, () => '00').join(':');
  const c = client(hub, 'vikram', createIdentity(), wrong);
  const s = await until(c, isKind('identity-mismatch'));
  assert.equal(s.kind === 'identity-mismatch' && s.actual, hub.fingerprint);
});

test('first contact by address pins the certificate it sees', async () => {
  const hub = await startHub();
  cleanups.push(() => hub.stop());
  const c = new HubClient({ identity: createIdentity(), account: account('vikram') });
  cleanups.push(() => c.disconnect());
  const pinned = new Promise<HubTarget>((r) => c.once('pinned', r));
  c.connect({ host: '127.0.0.1', port: hub.port });
  assert.equal((await pinned).fp, hub.fingerprint);
  await until(c, isKind('ready'));
});

function rawSession(hub: Hub): Promise<{ ws: WebSocket; hello: Extract<ServerFrame, { t: 'hello' }>; next: () => Promise<ServerFrame> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://127.0.0.1:${hub.port}/ws`, { rejectUnauthorized: false });
    const queue: ServerFrame[] = [];
    const waiters: Array<(f: ServerFrame) => void> = [];
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString()) as ServerFrame;
      const w = waiters.shift();
      if (w) w(f); else queue.push(f);
    });
    const next = () => new Promise<ServerFrame>((r) => { const f = queue.shift(); if (f) r(f); else waiters.push(r); });
    ws.on('error', reject);
    cleanups.push(() => ws.terminate());
    next().then((hello) => resolve({ ws, hello: hello as Extract<ServerFrame, { t: 'hello' }>, next }));
  });
}

test('signatures are bound to the device key, the nonce and the hub certificate', async () => {
  const hub = await startHub();
  cleanups.push(() => hub.stop());
  const victim = createIdentity();
  const c = client(hub, 'vikram', victim);
  await until(c, isKind('ready'));

  // an attacker claims the victim's device id with its own key
  const attacker = createIdentity();
  const a = await rawSession(hub);
  a.ws.send(JSON.stringify({ t: 'auth', deviceId: victim.deviceId, sig: signWith(attacker, authPayload(a.hello.nonce, hub.fingerprint, victim.deviceId)) }));
  assert.equal((await a.next()).t, 'rejected');

  // a relay presenting a different certificate cannot reuse a genuine signature
  const b = await rawSession(hub);
  const relayFp = Array.from({ length: 32 }, () => '11').join(':');
  b.ws.send(JSON.stringify({ t: 'auth', deviceId: victim.deviceId, sig: signWith(victim, authPayload(b.hello.nonce, relayFp, victim.deviceId)) }));
  assert.equal((await b.next()).t, 'rejected');

  // registering someone else's key without its private half fails too
  const d = await rawSession(hub);
  d.ws.send(JSON.stringify({ t: 'register', deviceId: victim.deviceId, publicKey: victim.publicKey, account: account('mallory'), sig: signWith(attacker, authPayload(d.hello.nonce, hub.fingerprint, victim.deviceId)) }));
  assert.equal((await d.next()).t, 'rejected');

  // requests before sign-in are refused
  const e = await rawSession(hub);
  e.ws.send(JSON.stringify({ t: 'req', id: '1', op: 'directory.list' }));
  assert.equal((await e.next()).t, 'error');
});

test('identity, certificate and approvals survive a hub restart', async () => {
  const dir = tempDir();
  const hub1 = await startHub(dir);
  const ownerId = createIdentity();
  const c1 = client(hub1, 'vikram', ownerId);
  await until(c1, isKind('ready'));
  const { id, } = hub1.info;
  const fp = hub1.fingerprint;
  c1.disconnect();
  await hub1.stop();

  const hub2 = await startHub(dir);
  cleanups.push(() => hub2.stop());
  assert.equal(hub2.info.id, id);
  assert.equal(hub2.fingerprint, fp);
  const c2 = client(hub2, 'vikram', ownerId);
  const s = await until(c2, isKind('ready'));
  assert.equal(s.kind === 'ready' && s.session.me.role, 'owner');
});

test('apps on the LAN find the hub by probing, and /health reports status', async () => {
  const discoveryPort = 40000 + Math.floor(Math.random() * 20000);
  const hub = await startHub(tempDir(), { discoveryPort });
  cleanups.push(() => hub.stop());
  const finder = new HubFinder({ port: discoveryPort, targets: ['127.0.0.1'], intervalMs: 200 });
  cleanups.push(() => finder.stop());
  const found = await new Promise<{ beacon: { id: string; port: number; fp: string } }>((r) => { finder.once('hub', r); finder.start(); });
  assert.equal(found.beacon.id, hub.info.id);
  assert.equal(found.beacon.port, hub.port);
  assert.equal(found.beacon.fp, hub.fingerprint);

  const health = await new Promise<Record<string, unknown>>((resolve, reject) => {
    https.get({ host: '127.0.0.1', port: hub.port, path: '/health', rejectUnauthorized: false }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });
  assert.equal(health.ok, true);
  assert.equal(health.fingerprint, hub.fingerprint);
});
