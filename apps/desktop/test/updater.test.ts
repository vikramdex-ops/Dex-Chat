// The desktop updater on a network where GitHub cannot be reached: the build is found and
// downloaded from the office hub through the internet gateway, and a route that fails falls back.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { TunnelRequest, TunnelResponse } from '@dex/core/remote';
import type { UpdateFeed } from '@dex/core/updates';
import { Updater } from '../src/main/updater.ts';

const dirs: string[] = [];
const closers: Array<() => void> = [];
after(() => { for (const c of closers) c(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dexupdater-')); dirs.push(d); return d; };

const exe = crypto.randomBytes(400_000);
const sha = crypto.createHash('sha512').update(exe).digest('base64');
const VERSION = '0.1.120';
const FILE = `DexterityConnect-Setup-${VERSION}.exe`;
const feed = (url: string): UpdateFeed => ({
  schema: 1, channel: 'stable', version: VERSION, releasedAt: '2026-11-19T00:00:00Z', notes: 'Updates on any network',
  assets: [{ platform: 'win-x64', file: FILE, url, size: exe.length, sha512: sha }],
});

/** A port where nothing answers: GitHub, blocked on this network. */
async function deadBase(): Promise<string> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

/** The hub's mirror as the gateway's channel serves it: ranges, chunks. */
function hubTunnel(opts: { brokenFile?: boolean } = {}) {
  const seen: string[] = [];
  const tunnel = async (req: TunnelRequest): Promise<TunnelResponse> => {
    seen.push(`${req.method} ${req.path}${req.headers?.range ? ` ${req.headers.range}` : ''}`);
    const body = (b: Uint8Array) => (async function* () { for (let o = 0; o < b.length; o += 65536) yield b.subarray(o, o + 65536); })();
    if (req.path === '/updates/stable.json') return { status: 200, headers: {}, body: body(new TextEncoder().encode(JSON.stringify(feed(`/updates/files/${VERSION}/${FILE}`)))) };
    if (req.path === `/updates/files/${VERSION}/${FILE}`) {
      const file = opts.brokenFile ? crypto.randomBytes(exe.length) : exe;
      const m = /^bytes=(\d+)-$/.exec(req.headers?.range ?? '');
      return m ? { status: 206, headers: {}, body: body(file.subarray(Number(m[1]))) } : { status: 200, headers: {}, body: body(file) };
    }
    return { status: 404, headers: {}, body: body(new Uint8Array()) };
  };
  return { tunnel, seen };
}

const make = (o: Partial<ConstructorParameters<typeof Updater>[0]>) => new Updater({
  version: '0.1.108', enabled: true, downloadDir: tmp(), channel: () => 'stable', autoDownload: () => true,
  hub: () => null, platformOverride: 'win-x64', allowHttp: true, beforeInstall: () => {}, quit: () => {}, ...o,
}, null);

test('GitHub blocked, connected through the gateway: found and downloaded from the office hub', async () => {
  const gh = await deadBase();
  const hub = hubTunnel();
  const u = make({ feedBase: gh, mirrorBase: gh, tunnel: () => hub.tunnel });
  await u.check(true);
  assert.equal(u.state.phase, 'ready', u.state.error ?? '');
  assert.equal(u.state.available?.version, VERSION);
  assert.equal(u.state.available?.source, 'hub');
  assert.deepEqual(u.state.checked, [{ source: 'hub-gateway', ok: true }, { source: 'internet', ok: false }, { source: 'mirror', ok: false }]);
  assert.ok(hub.seen.includes(`GET /updates/files/${VERSION}/${FILE}`));
  u.stop();
});

test('nothing answers: a clear error that lists what was tried', async () => {
  const gh = await deadBase();
  const u = make({ feedBase: gh, mirrorBase: gh });
  await u.check(true);
  assert.equal(u.state.phase, 'error');
  assert.match(u.state.error ?? '', /neither the office hub nor the update servers on the internet answered/);
  assert.deepEqual(u.state.checked, [{ source: 'internet', ok: false }, { source: 'mirror', ok: false }]);
  u.stop();
});

test('a broken copy from one route falls back to the next, and only a verified file is kept', async () => {
  // GitHub's feed answers (so its download is tried first) but serves a damaged file; the hub's is good
  const s = http.createServer((req, res) => {
    if (req.url === '/stable.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(feed(`http://127.0.0.1:${(s.address() as AddressInfo).port}/dl/${FILE}`))); return; }
    if (req.url === `/dl/${FILE}`) { res.writeHead(200); res.end(crypto.randomBytes(exe.length)); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  closers.push(() => s.close());
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const hub = hubTunnel();
  const lines: string[] = [];
  const u = make({ feedBase: base, mirrorBase: await deadBase(), tunnel: () => hub.tunnel, log: (m, e) => lines.push(`${m} ${JSON.stringify(e ?? {})}`) });
  await u.check(true);
  assert.equal(u.state.phase, 'ready', u.state.error ?? '');
  assert.ok(lines.some((l) => /trying the next source/.test(l) && /internet/.test(l) && /integrity/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /update downloaded/.test(l) && /hub-gateway/.test(l)));
  const file = path.join((u as unknown as { opts: { downloadDir: string } }).opts.downloadDir, FILE);
  assert.deepEqual(fs.readFileSync(file), exe);
  u.stop();
});

test('every route broken: the download fails with the last reason and no file is left to install', async () => {
  const gh = await deadBase();
  const hub = hubTunnel({ brokenFile: true });
  const u = make({ feedBase: gh, mirrorBase: gh, tunnel: () => hub.tunnel });
  await u.check(true);
  assert.equal(u.state.phase, 'error');
  assert.match(u.state.error ?? '', /integrity check/);
  assert.equal(u.install(false), false);
  u.stop();
});
