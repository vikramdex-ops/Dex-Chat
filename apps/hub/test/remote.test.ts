// Outside the office: a real gateway (the Cloudflare Worker, run locally in Cloudflare's workerd
// runtime by wrangler), the hub connected to it, and devices that cannot reach the office network.
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createIdentity } from '@dex/core';
import { HubClient } from '@dex/core/client';
import type { Message } from '@dex/core';
import { office, until, nextEvent, me, send, cleanups } from './office.ts';

let gateway: { url: string; stop: () => Promise<void> } | null = null;
let skip: string | false = false;

before(async () => {
  // the real gateway Worker, in Cloudflare's local runtime, as its own process group we can stop
  const root = path.resolve(import.meta.dirname, '../../gateway');
  const bin = path.resolve(import.meta.dirname, '../../../node_modules/.bin/wrangler');
  const port = await deadPort();
  const child = spawn(bin, ['dev', '--ip', '127.0.0.1', '--port', String(port), '--config', path.join(root, 'wrangler.jsonc'), '--show-interactive-dev-session=false', '--log-level', 'info'],
    { cwd: root, detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const stop = async () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ } };
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

  // turning remote access off disconnects everyone outside at once
  await owner.request('admin.remote.set', { enabled: false });

  await until(asha.c, (s) => s.kind !== 'ready', 8000);
  assert.equal((await owner.request('admin.remote.get')).status.connected, false);
});
