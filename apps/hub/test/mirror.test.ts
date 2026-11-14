import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createIdentity } from '@dex/core';
import { HubClient } from '@dex/core/client';
import { downloadVerified, fetchFeed } from '@dex/core/updates';
import type { UpdateFeed } from '@dex/core/updates';
import { Hub } from '../src/hub.ts';

const dirs: string[] = [];
const closers: Array<() => unknown> = [];
after(async () => { for (const c of closers.reverse()) await c(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dexmirror-')); dirs.push(d); return d; };

const sha = (b: Buffer) => crypto.createHash('sha512').update(b).digest('base64');

/** Stands in for the public release feed on GitHub. */
async function publicFeed() {
  const files = new Map<string, Buffer>();
  const feeds = new Map<string, UpdateFeed>();
  const s = http.createServer((req, res) => {
    const url = req.url ?? '';
    const feed = feeds.get(url);
    if (feed) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(feed)); return; }
    const f = files.get(url);
    if (f) { res.writeHead(200); res.end(f); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  closers.push(() => s.close());
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  return {
    base,
    publish(channel: 'stable' | 'beta', version: string, opts: { tamper?: boolean } = {}) {
      const exe = crypto.randomBytes(50_000);
      const apk = crypto.randomBytes(30_000);
      files.set(`/dl/${version}/setup.exe`, opts.tamper ? crypto.randomBytes(50_000) : exe);
      files.set(`/dl/${version}/app.apk`, apk);
      feeds.set(`/${channel}.json`, {
        schema: 1, channel, version, releasedAt: new Date().toISOString(), notes: `Build ${version}`,
        assets: [
          { platform: 'win-x64', file: `DexterityConnect-Setup-${version}.exe`, url: `${base}/dl/${version}/setup.exe`, size: exe.length, sha512: sha(exe) },
          { platform: 'android', file: `DexterityConnect-${version}.apk`, url: `${base}/dl/${version}/app.apk`, size: apk.length, sha512: sha(apk) },
        ],
      });
      return { exe, apk };
    },
  };
}

async function hubWith(feed: { base: string }) {
  const hub = new Hub({
    dataDir: tmp(), port: 0, host: '127.0.0.1', discoveryPort: false, name: 'Mirror Hub',
    updates: { feedUrls: { stable: `${feed.base}/stable.json`, beta: `${feed.base}/beta.json` }, firstCheckDelayMs: 10_000_000, allowHttp: true },
  });
  await hub.start();
  closers.push(() => hub.stop());
  return hub;
}

test('the hub mirrors new builds and serves them to the LAN over pinned TLS', async () => {
  const feed = await publicFeed();
  const { exe } = feed.publish('stable', '0.1.20');
  const hub = await hubWith(feed);
  const base = `https://127.0.0.1:${hub.port}`;
  const pin = { pinnedFingerprint: hub.fingerprint };

  await assert.rejects(fetchFeed(`${base}/updates/stable.json`, pin), /HTTP 404/);
  await hub.mirror!.refresh();
  assert.equal(hub.mirror!.status.lastError, null);
  assert.equal(hub.mirror!.status.channels.stable?.version, '0.1.20');

  const local = await fetchFeed(`${base}/updates/stable.json`, pin);
  assert.equal(local?.version, '0.1.20');
  const asset = local!.assets.find((a) => a.platform === 'win-x64')!;
  assert.equal(asset.url, '/updates/files/0.1.20/DexterityConnect-Setup-0.1.20.exe');

  // a PC downloads it from the hub, resuming a partial copy
  const dest = path.join(tmp(), 'setup.exe');
  fs.writeFileSync(`${dest}.part`, exe.subarray(0, 20_000));
  await downloadVerified(`${base}${asset.url}`, dest, asset, pin);
  assert.deepEqual(fs.readFileSync(dest), exe);

  // a different certificate is refused
  await assert.rejects(fetchFeed(`${base}/updates/stable.json`, { pinnedFingerprint: '00:11' }), /unexpected certificate/);
  // path traversal goes nowhere
  const r = await new Promise<number>((resolve) => {
    https_get(`${base}/updates/files/0.1.20/..%2F..%2Fhub.db`, resolve);
  });
  assert.equal(r, 404);
});

import https from 'node:https';
function https_get(url: string, done: (status: number) => void) {
  https.get(url, { rejectUnauthorized: false }, (res) => { res.resume(); done(res.statusCode ?? 0); });
}

test('newer releases replace older ones, and tampered builds are never served', async () => {
  const feed = await publicFeed();
  feed.publish('stable', '0.1.20');
  const hub = await hubWith(feed);
  await hub.mirror!.refresh();
  const filesDir = path.join(hub.mirror!['dir' as never] as string, 'files');
  assert.deepEqual(fs.readdirSync(filesDir), ['0.1.20']);

  feed.publish('stable', '0.1.21', { tamper: true });
  await hub.mirror!.refresh();
  assert.match(hub.mirror!.status.lastError ?? '', /integrity check/);
  assert.equal(hub.mirror!.readManifest('stable')?.version, '0.1.20', 'keeps serving the last good build');

  feed.publish('stable', '0.1.22');
  feed.publish('beta', '0.1.23');
  await hub.mirror!.refresh();
  assert.equal(hub.mirror!.status.lastError, null);
  assert.deepEqual(fs.readdirSync(filesDir).sort(), ['0.1.22', '0.1.23']);
});

test('administrators can see mirror status and trigger a check', async () => {
  const feed = await publicFeed();
  feed.publish('beta', '0.1.30');
  const hub = await hubWith(feed);
  const c = new HubClient({ identity: createIdentity(), account: { username: 'vikram', domain: 'DEX', displayName: 'Vikram', hostname: 'PC1' } });
  closers.push(() => c.disconnect());
  c.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
  await new Promise<void>((r) => { const on = () => { if (c.state.kind === 'ready') { c.off('state', on); r(); } }; c.on('state', on); });
  const before = await c.request('admin.updates');
  assert.equal(before.enabled, true);
  assert.equal(before.channels.beta, undefined);
  await c.request('admin.updates', { refresh: true });
  await hub.mirror!.refresh();
  const afterStatus = await c.request('admin.updates');
  assert.equal(afterStatus.channels.beta?.version, '0.1.30');
});
