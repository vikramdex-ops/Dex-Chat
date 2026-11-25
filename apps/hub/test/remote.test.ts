// Outside the office: a real gateway (the Cloudflare Worker, run locally in Cloudflare's workerd
// runtime by wrangler), the hub connected to it, and devices that cannot reach the office network.
import { parsePairCode } from '@dex/core/remote';
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { createIdentity } from '@dex/core';
import { HubClient } from '@dex/core/client';
import type { Message } from '@dex/core';
import { office, until, nextEvent, me, send, cleanups } from './office.ts';

let gateway: { url: string; stop: () => Promise<void> } | null = null;
let skip: string | false = false;

before(async () => {
  // the real gateway Worker, in Cloudflare's local runtime, as its own process group we can stop
  const root = path.resolve(import.meta.dirname, '../../gateway');
  // wrangler's own script under this node: the .bin shim is a shell script that Windows cannot spawn
  const bin = path.resolve(import.meta.dirname, '../../../node_modules/wrangler/bin/wrangler.js');
  const win = process.platform === 'win32';
  const port = await deadPort();
  const child = spawn(process.execPath, [bin, 'dev', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(await deadPort()), '--config', path.join(root, 'wrangler.jsonc'), '--show-interactive-dev-session=false', '--log-level', 'info'],
    { cwd: root, detached: !win, windowsHide: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', () => { /* reported through 'exit' */ });
  // the whole tree (wrangler and its workerd): a process group here, taskkill /T on Windows
  const stop = async () => { try { if (win) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); else process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ } };
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('wrangler did not start in 60 s')), 60_000);
      const seen = (b: Buffer) => { if (/Ready on/.test(b.toString())) { clearTimeout(t); resolve(); } };
      child.stdout!.on('data', seen);
      child.stderr!.on('data', seen);
      child.on('exit', (code) => { clearTimeout(t); reject(new Error(`wrangler exited (${code})`)); });
    });
    child.stdout!.resume(); child.stderr!.resume();
    gateway = { url: `http://127.0.0.1:${port}`, stop };
  } catch (err) {
    await stop();
    skip = `the gateway could not run here: ${(err as Error).message}`;
  }
});
after(async () => {
  // devices and the hub first, so nothing is still knocking on the gateway while it stops
  for (const c of cleanups.splice(0).reverse()) await c();
  await gateway?.stop();
});

/** A port with nothing listening: "the office network is not reachable". */
async function deadPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const p = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

async function connected(owner: HubClient) {
  for (let i = 0; i < 100; i++) {
    const v = await owner.request('admin.remote.get');
    if (v.status.connected) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('hub never reached the gateway');
}

const outside = (username: string, hub: { info: { id: string }; fingerprint: string }, port: number, fp = hub.fingerprint) => {
  const identity = createIdentity();
  const c = new HubClient({ identity, account: { username, domain: 'DEX', displayName: username, hostname: `${username}-laptop` } });
  cleanups.push(() => c.disconnect());
  c.connect({ host: '127.0.0.1', port, fp, remote: { url: gateway!.url, hubId: hub.info.id } });
  return { c, identity };
};

test('from outside the office: join, approval, messages both ways, files, and the limits', async (t) => {
  if (skip) { t.skip(skip); return; }
  const { hub, owner } = await office();
  const off = await outside('asha', hub, await deadPort());
  // the gateway is off: nothing to fall back on yet

  await until(off.c, (s) => s.kind === 'offline', 8000);

  const v0 = await owner.request('admin.remote.set', { url: gateway!.url, enabled: true });
  assert.equal(v0.config.enabled, true);
  const view = await connected(owner);
  assert.equal(view.fingerprint, hub.fingerprint);

  // a new laptop at home asks to join through the gateway and waits for approval
  const asha = outside('asha2', hub, await deadPort());

  await until(asha.c, (s) => s.kind === 'pending', 15000);
  const audit = await owner.request('admin.devices');
  assert.ok(audit.some((d) => d.id === asha.identity.deviceId && d.status === 'pending'));
  await owner.request('admin.decide', { deviceId: asha.identity.deviceId, approve: true });

  await until(asha.c, (s) => s.kind === 'ready', 15000);
  assert.equal(asha.c.state.kind === 'ready' && asha.c.state.via, 'remote');
  assert.equal(asha.c.viaGateway, true);
  assert.ok((await owner.request('admin.audit')).some((a) => a.action === 'device.registered' && JSON.stringify(a.detail).includes('internet')), 'the audit log says it came from outside');

  // messages both ways
  const dm = await owner.request('conv.create', { kind: 'direct', members: [me(asha.c)] });
  const got = nextEvent<Message>(asha.c, 'msg.new', (m) => m.convId === dm.id, 8000);
  await send(owner, dm.id, 'Can you check the MTO from home?');
  assert.equal((await got).body, 'Can you check the MTO from home?');
  const back = nextEvent<Message>(owner, 'msg.new', (m) => m.convId === dm.id, 8000);
  await send(asha.c, dm.id, 'On it');
  assert.equal((await back).body, 'On it');

  // files through the encrypted channel, larger than one frame
  const data = new Uint8Array(700_000).map((_, i) => (i * 31) % 251);
  const up = await asha.c.http({ method: 'POST', path: '/files?name=MTO%20rev%20C.xlsx', headers: { authorization: `Bearer ${asha.c.session!.fileToken}`, 'content-length': String(data.length) }, body: data });
  assert.equal(up.status, 200);
  let raw = '';
  for await (const p of up.body) raw += new TextDecoder().decode(p);
  const info = JSON.parse(raw) as { id: string; size: number };
  assert.equal(info.size, data.length);
  const down = await asha.c.http({ method: 'GET', path: `/files/${info.id}?download=1`, headers: { authorization: `Bearer ${asha.c.session!.fileToken}` } });
  assert.equal(down.status, 200);
  const parts: Uint8Array[] = [];
  for await (const p of down.body) parts.push(p);
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
  assert.deepEqual(all, data);
  // only files and updates are reachable over HTTP from outside
  const bot = await asha.c.http({ method: 'POST', path: '/api/bot/message', body: new TextEncoder().encode('{}') });
  assert.equal(bot.status, 403);

  // the Control room stays on the office network unless the administrator allows it
  await owner.request('admin.setRole', { userId: me(asha.c), role: 'admin' });
  await assert.rejects(asha.c.request('admin.devices'), /only available on the office network/);
  await owner.request('admin.remote.set', { allowAdmin: true });
  assert.ok(Array.isArray(await asha.c.request('admin.devices')));

  // new devices from outside can be turned off; approved ones keep working
  await owner.request('admin.remote.set', { allowJoin: false });
  const stranger = outside('stranger', hub, await deadPort());

  await until(stranger.c, (s) => s.kind === 'rejected', 15000);
  assert.match(stranger.c.state.kind === 'rejected' ? stranger.c.state.reason : '', /join from the office network/);

  // a device that pinned another hub refuses whatever answers through the gateway
  const wrong = outside('wrong', hub, await deadPort(), 'AA:'.repeat(31) + 'AA');

  await until(wrong.c, (s) => s.kind === 'identity-mismatch', 15000);

  // a person's own phone pairs from outside with their code, even with joins from outside off
  const made = await asha.c.request('pair.create', { kind: 'phone' });
  const pairInfo = parsePairCode(made.code)!;
  assert.equal(pairInfo.url, gateway!.url);
  const pid = createIdentity();
  const phone = new HubClient({ identity: pid, account: { username: 'phone-x', domain: 'PHONE', displayName: 'Phone', hostname: 'Pixel 8' } });
  phone.setPair(pairInfo.token);
  cleanups.push(() => phone.disconnect());
  phone.connect({ host: '127.0.0.1', port: await deadPort(), fp: pairInfo.fp, remote: { url: pairInfo.url!, hubId: pairInfo.hubId } });
  await until(phone, (s) => s.kind === 'ready', 15000);
  assert.equal(me(phone), me(asha.c), 'the phone is Asha');
  assert.equal(phone.viaGateway, true);

  // outside access only from approved networks: a device elsewhere is signed out at once
  await owner.request('admin.policy.set', { outsideNetworks: ['198.51.100.0/24'] });
  await until(phone, (s) => s.kind === 'rejected', 8000);
  assert.match(phone.state.kind === 'rejected' ? phone.state.reason : '', /approved networks/);
  await owner.request('admin.policy.set', { outsideNetworks: [] });

  // turning remote access off disconnects everyone outside at once
  await owner.request('admin.remote.set', { enabled: false });

  await until(asha.c, (s) => s.kind !== 'ready', 8000);
  assert.equal((await owner.request('admin.remote.get')).status.connected, false);
});

test('from outside the office: the update mirror through the gateway (feed, then the build in two ranges)', async (t) => {
  if (skip) { t.skip(skip); return; }
  // a hub whose mirror already holds a build (the public feed itself is never asked here)
  const { hub, owner, dir } = await office({ updates: { firstCheckDelayMs: 3_600_000 } });
  const apk = new Uint8Array(300_000).map((_, i) => (i * 7) % 253);
  const sha512 = crypto.createHash('sha512').update(apk).digest('base64');
  const version = '0.1.120';
  fs.mkdirSync(path.join(dir, 'updates', 'files', version), { recursive: true });
  fs.writeFileSync(path.join(dir, 'updates', 'files', version, `DexterityConnect-${version}.apk`), apk);
  fs.writeFileSync(path.join(dir, 'updates', 'stable.json'), JSON.stringify({
    schema: 1, channel: 'stable', version, releasedAt: '2026-11-19T00:00:00Z', notes: 'Through the gateway',
    assets: [{ platform: 'android', file: `DexterityConnect-${version}.apk`, url: `https://github.com/dexterity-admin/dexterity-connect/releases/download/v${version}/DexterityConnect-${version}.apk`, size: apk.length, sha512 }],
  }));
  await owner.request('admin.remote.set', { url: gateway!.url, enabled: true });
  await connected(owner);
  const phone = outside('ravi-phone', hub, await deadPort());
  await until(phone.c, (s) => s.kind === 'pending', 15000);
  await owner.request('admin.decide', { deviceId: phone.identity.deviceId, approve: true });
  await until(phone.c, (s) => s.kind === 'ready', 15000);
  assert.equal(phone.c.viaGateway, true);

  const read = async (r: { body: AsyncIterable<Uint8Array> }) => { const parts: Uint8Array[] = []; for await (const p of r.body) parts.push(p); return Buffer.concat(parts); };
  // the feed, with the hub's own links (no sign-in needed, as on the office network)
  const f = await phone.c.http({ method: 'GET', path: '/updates/stable.json', headers: { 'cache-control': 'no-cache' } });
  assert.equal(f.status, 200);
  const feed = JSON.parse((await read(f)).toString()) as { version: string; assets: Array<{ url: string; sha512: string }> };
  assert.equal(feed.version, version);
  assert.equal(feed.assets[0].url, `/updates/files/${version}/DexterityConnect-${version}.apk`);
  // the build, resumed: the first part, then the rest with a range
  const first = await phone.c.http({ method: 'GET', path: feed.assets[0].url, headers: { range: 'bytes=0-99999' } });
  assert.equal(first.status, 206);
  const a = await read(first);
  const rest = await phone.c.http({ method: 'GET', path: feed.assets[0].url, headers: { range: `bytes=${a.length}-` } });
  assert.equal(rest.status, 206);
  const whole = Buffer.concat([a, await read(rest)]);
  assert.equal(crypto.createHash('sha512').update(whole).digest('base64'), feed.assets[0].sha512);
  // nothing else on the hub is reachable this way, and no path escapes the mirror
  assert.ok([403, 404].includes((await phone.c.http({ method: 'GET', path: '/updates/files/0.1.120/..%2F..%2Fhub.db' })).status));
  assert.equal((await phone.c.http({ method: 'GET', path: '/updates/files/0.1.119/DexterityConnect-0.1.119.apk' })).status, 404);
  assert.equal((await phone.c.http({ method: 'GET', path: '/notify/wait' })).status, 403);
  await owner.request('admin.remote.set', { enabled: false });
});
