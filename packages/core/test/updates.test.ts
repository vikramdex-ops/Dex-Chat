import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { chooseUpdate, compareVersions, downloadVerified, fetchFeed, parseFeed } from '../src/updates.ts';
import type { UpdateFeed } from '../src/updates.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dexupd-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const blob = crypto.randomBytes(300_000);
const sha = crypto.createHash('sha512').update(blob).digest('base64');

const feed = (version: string, channel: 'stable' | 'beta' = 'stable', extra: Partial<UpdateFeed> = {}): UpdateFeed => ({
  schema: 1, channel, version, releasedAt: '2026-11-14T00:00:00Z', notes: 'notes',
  assets: [{ platform: 'win-x64', file: `DexterityConnect-Setup-${version}.exe`, url: 'https://example.invalid/x.exe', size: blob.length, sha512: sha }],
  ...extra,
});

test('versions compare numerically, not as text', () => {
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1);
  assert.equal(compareVersions('0.2', '0.1.99'), 1);
  assert.equal(compareVersions('1.0.0', '1.0'), 0);
  assert.equal(compareVersions('0.1.5', '0.1.6'), -1);
});

test('feeds are validated and junk is dropped', () => {
  assert.equal(parseFeed({ ...feed('0.1.6'), schema: 2 }), null);
  assert.equal(parseFeed({ ...feed('0.1.6'), version: '1.0.0-rc1' }), null);
  const bad = parseFeed({ ...feed('0.1.6'), assets: [
    { platform: 'win-x64', file: '../evil.exe', url: 'https://x/y', size: 1, sha512: sha },
    { platform: 'win-x64', file: 'ok.exe', url: 'http://plain/y', size: 1, sha512: sha },
    { platform: 'win-x64', file: 'ok.exe', url: 'https://x/y', size: 1, sha512: 'short' },
    { platform: 'nope', file: 'ok.exe', url: 'https://x/y', size: 1, sha512: sha },
  ] });
  assert.deepEqual(bad?.assets, []);
  assert.equal(parseFeed(feed('0.1.6'))?.assets.length, 1);
});

test('the newest applicable build wins; older or missing platforms are ignored', () => {
  assert.equal(chooseUpdate('0.1.6', [feed('0.1.6')], 'win-x64'), null, 'same version is not an update');
  assert.equal(chooseUpdate('0.1.7', [feed('0.1.6')], 'win-x64'), null, 'never downgrade');
  assert.equal(chooseUpdate('0.1.5', [feed('0.1.6')], 'mac-arm64'), null, 'no asset for this platform');
  const pick = chooseUpdate('0.1.5', [feed('0.1.6'), feed('0.1.9', 'beta'), null], 'win-x64');
  assert.equal(pick?.feed.version, '0.1.9');
  assert.equal(pick?.mandatory, false);
  assert.equal(chooseUpdate('0.1.5', [feed('0.1.6', 'stable', { minVersion: '0.1.6' })], 'win-x64')?.mandatory, true);
  assert.equal(chooseUpdate('0.1.5', [feed('0.1.6', 'stable', { mandatory: true })], 'win-x64')?.mandatory, true);
});

function server(handler: http.RequestListener): Promise<{ url: string; close: () => void; hits: http.IncomingHttpHeaders[] }> {
  const hits: http.IncomingHttpHeaders[] = [];
  const s = http.createServer((req, res) => { hits.push(req.headers); handler(req, res); });
  return new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, close: () => s.close(), hits,
  })));
}

function serveBlob(ranges: boolean): http.RequestListener {
  return (req, res) => {
    if (req.url === '/moved') { res.writeHead(302, { location: '/file' }); res.end(); return; }
    if (req.url === '/feed.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(feed('0.1.6'))); return; }
    const m = ranges && /bytes=(\d+)-/.exec(req.headers.range ?? '');
    if (m) {
      const start = Number(m[1]);
      res.writeHead(206, { 'content-range': `bytes ${start}-${blob.length - 1}/${blob.length}` });
      res.end(blob.subarray(start));
    } else {
      res.writeHead(200);
      res.end(blob);
    }
  };
}

test('downloads verify size and SHA-512, follow redirects and report progress', async () => {
  const s = await server(serveBlob(true));
  try {
    const dest = path.join(tmp, 'a', 'setup.exe');
    let last = 0;
    await downloadVerified(`${s.url}/moved`, dest, { size: blob.length, sha512: sha }, { onProgress: (p) => { last = p.received; } });
    assert.deepEqual(fs.readFileSync(dest), blob);
    assert.equal(last, blob.length);
    assert.ok(!fs.existsSync(`${dest}.part`));
    // already present and valid: no network needed
    const before = s.hits.length;
    await downloadVerified(`${s.url}/file`, dest, { size: blob.length, sha512: sha });
    assert.equal(s.hits.length, before);
    assert.equal((await fetchFeed(`${s.url}/feed.json`))?.version, '0.1.6');
  } finally { s.close(); }
});

test('an interrupted download resumes from where it stopped', async () => {
  const s = await server(serveBlob(true));
  try {
    const dest = path.join(tmp, 'b', 'setup.exe');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(`${dest}.part`, blob.subarray(0, 120_000));
    await downloadVerified(`${s.url}/file`, dest, { size: blob.length, sha512: sha });
    assert.equal(s.hits.at(-1)?.range, 'bytes=120000-');
    assert.deepEqual(fs.readFileSync(dest), blob);
  } finally { s.close(); }
});

test('a server without range support restarts the download cleanly', async () => {
  const s = await server(serveBlob(false));
  try {
    const dest = path.join(tmp, 'c', 'setup.exe');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(`${dest}.part`, blob.subarray(0, 50_000));
    await downloadVerified(`${s.url}/file`, dest, { size: blob.length, sha512: sha });
    assert.deepEqual(fs.readFileSync(dest), blob);
  } finally { s.close(); }
});

test('a tampered or oversized download is rejected and discarded', async () => {
  const s = await server(serveBlob(true));
  try {
    const dest = path.join(tmp, 'd', 'setup.exe');
    const wrong = crypto.createHash('sha512').update('other').digest('base64');
    await assert.rejects(downloadVerified(`${s.url}/file`, dest, { size: blob.length, sha512: wrong }), /integrity check/);
    assert.ok(!fs.existsSync(dest) && !fs.existsSync(`${dest}.part`));
    await assert.rejects(downloadVerified(`${s.url}/file`, path.join(tmp, 'e', 'x.exe'), { size: 1000, sha512: sha }), /larger than expected/);
    await assert.rejects(downloadVerified(`${s.url}/missing-but-404`.replace('missing-but-404', 'nope'), path.join(tmp, 'f', 'x.exe'), { size: blob.length, sha512: wrong }));
  } finally { s.close(); }
});
