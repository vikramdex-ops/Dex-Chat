// Where updates come from: every source asked at once, the newest build wins, and downloads fall
// back from one route to the next (docs/UPDATES.md).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkSources, downloadRoutes, downloadVerifiedFrom, mirrorFeedUrl, parseFeed, pickUpdate, reportOf, tryRoutes } from '../src/updates.ts';
import type { Route, SourceResult, UpdateFeed } from '../src/updates.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dexsrc-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const blob = crypto.randomBytes(200_000);
const sha = crypto.createHash('sha512').update(blob).digest('base64');
const GH = 'https://github.com/dexterity-admin/dexterity-connect/releases/download';

/** A feed as GitHub (absolute links) or the hub (paths on the hub) publishes it. */
const feed = (version: string, where: 'net' | 'hub', file = blob): UpdateFeed => ({
  schema: 1, channel: 'stable', version, releasedAt: '2026-11-19T00:00:00Z', notes: `Build ${version}`,
  assets: [{
    platform: 'android', file: `DexterityConnect-${version}.apk`,
    url: where === 'net' ? `${GH}/v${version}/DexterityConnect-${version}.apk` : `/updates/files/${version}/DexterityConnect-${version}.apk`,
    size: file.length, sha512: file === blob ? sha : crypto.createHash('sha512').update(file).digest('base64'),
  }],
});
const res = (source: SourceResult['source'], feeds: UpdateFeed[], reachable = true): SourceResult => ({ source, feeds, reachable });

test('feeds parse without Buffer (the phone WebView has none) and still reject a bad digest', () => {
  const saved = (globalThis as { Buffer?: unknown }).Buffer;
  (globalThis as { Buffer?: unknown }).Buffer = undefined;
  try {
    assert.equal(parseFeed(feed('0.1.110', 'net'))?.assets.length, 1);
    assert.equal(parseFeed({ ...feed('0.1.110', 'net'), assets: [{ ...feed('0.1.110', 'net').assets[0], sha512: 'abc' }] })?.assets.length, 0);
  } finally {
    (globalThis as { Buffer?: unknown }).Buffer = saved;
  }
});

test('the second internet mirror is jsDelivr on the update-feed branch', () => {
  assert.equal(mirrorFeedUrl('beta'), 'https://cdn.jsdelivr.net/gh/dexterity-admin/dexterity-connect@update-feed/beta.json');
});

test('all sources are asked at once; a 404 counts as reachable, a failure does not', async () => {
  const order: string[] = [];
  const results = await checkSources({
    'hub-gateway': async (ch) => { order.push(`gw:${ch}`); await new Promise((r) => setTimeout(r, 30)); return feed('0.1.110', 'hub'); },
    internet: async (ch) => { order.push(`net:${ch}`); throw new Error('ECONNRESET'); },
    mirror: async (ch) => { order.push(`mirror:${ch}`); return null; },
  }, ['stable', 'beta']);
  assert.deepEqual(results.map((r) => r.source), ['hub-gateway', 'internet', 'mirror'], 'sources without a fetcher are left out, the rest in order');
  assert.equal(order.length, 6, 'every source and channel was asked before any answered');
  assert.deepEqual(reportOf(results), [{ source: 'hub-gateway', ok: true }, { source: 'internet', ok: false }, { source: 'mirror', ok: true }]);
  assert.equal(results[0].feeds.length, 2);
});

test('the newest build wins wherever it is; for the same version the hub is preferred', () => {
  // the mirror lags behind GitHub: GitHub's newer build wins
  let pick = pickUpdate('0.1.108', [res('mirror', [feed('0.1.109', 'net')]), res('internet', [feed('0.1.110', 'net')])], 'android');
  assert.equal(pick?.feed.version, '0.1.110');
  assert.equal(pick?.source, 'internet');
  // the hub has the same build: its copy is used, GitHub stays as a fallback
  pick = pickUpdate('0.1.108', [res('hub-lan', [feed('0.1.110', 'hub')]), res('internet', [feed('0.1.110', 'net')])], 'android');
  assert.equal(pick?.source, 'hub-lan');
  assert.deepEqual(pick?.routes.map((r) => r.route), ['hub-lan', 'internet']);
  // the hub has not mirrored the new build yet: GitHub's newer one, and no hub route for it
  pick = pickUpdate('0.1.108', [res('hub-lan', [feed('0.1.109', 'hub')]), res('internet', [feed('0.1.110', 'net')])], 'android');
  assert.deepEqual(pick?.routes, [{ route: 'internet', url: `${GH}/v0.1.110/DexterityConnect-0.1.110.apk` }]);
  // nothing newer anywhere
  assert.equal(pickUpdate('0.1.110', [res('hub-lan', [feed('0.1.110', 'hub')]), res('internet', [feed('0.1.109', 'net')])], 'android'), null);
});

test('on a network that blocks GitHub, the gateway route comes before GitHub', () => {
  // GitHub's raw feed is blocked, jsDelivr answers, the hub answers through the gateway
  const blocked = [res('hub-gateway', [feed('0.1.110', 'hub')]), res('internet', [], false), res('mirror', [feed('0.1.110', 'net')])];
  const pick = pickUpdate('0.1.108', blocked, 'android')!;
  assert.equal(pick.source, 'hub-gateway');
  assert.deepEqual(pick.routes.map((r) => r.route), ['hub-gateway', 'internet']);
  // GitHub answers: its download goes first (it does not use the office's upload), the gateway after
  const open = [res('hub-gateway', [feed('0.1.110', 'hub')]), res('internet', [feed('0.1.110', 'net')])];
  assert.deepEqual(downloadRoutes(pickUpdate('0.1.108', open, 'android')!, open, 'android').map((r) => r.route), ['internet', 'hub-gateway']);
  // the hub on the office network is always first
  const office = [res('hub-lan', [feed('0.1.110', 'hub')]), res('hub-gateway', [feed('0.1.110', 'hub')]), res('internet', [feed('0.1.110', 'net')])];
  assert.deepEqual(pickUpdate('0.1.108', office, 'android')!.routes.map((r) => r.route), ['hub-lan', 'internet', 'hub-gateway']);
});

test('a route is only offered for exactly the chosen file, and hub routes only for hub paths', () => {
  const other = crypto.randomBytes(1000);
  const results = [
    res('hub-lan', [feed('0.1.110', 'hub', other)]), // same version, different file: not this build
    res('hub-gateway', [{ ...feed('0.1.110', 'hub'), assets: [{ ...feed('0.1.110', 'hub').assets[0], url: 'https://evil.example/x.apk' }] }]),
    res('internet', [feed('0.1.110', 'net')]),
  ];
  const pick = pickUpdate('0.1.108', results.slice(2), 'android')!;
  assert.deepEqual(downloadRoutes(pick, results, 'android').map((r) => r.route), ['internet']);
});

test('downloads fall back to the next route, but a cancelled one stops', async () => {
  const routes: Route[] = [{ route: 'hub-lan', url: '/a' }, { route: 'internet', url: 'https://b' }, { route: 'hub-gateway', url: '/c' }];
  const failed: string[] = [];
  const got = await tryRoutes(routes, async (r) => { if (r.route !== 'hub-gateway') throw new Error(`${r.route} down`); return 'ok'; }, (r, e) => failed.push(`${r.route}: ${e.message}`));
  assert.equal(got.route.route, 'hub-gateway');
  assert.deepEqual(failed, ['hub-lan: hub-lan down', 'internet: internet down']);
  await assert.rejects(tryRoutes(routes, async () => { throw Object.assign(new Error('Download cancelled.'), { name: 'AbortError' }); }), /cancelled/);
  await assert.rejects(tryRoutes(routes, async (r) => { throw new Error(`${r.route} down`); }), /hub-gateway down/, 'the last error is reported');
});

/** Stands in for the hub through the gateway: chunks, ranges and a connection that drops. */
function tunnel(opts: { dropAt?: number; ranges?: boolean } = {}) {
  const calls: Array<Record<string, string>> = [];
  const open = async (headers: Record<string, string>) => {
    calls.push(headers);
    const m = opts.ranges !== false && /^bytes=(\d+)-$/.exec(headers.range ?? '');
    const start = m ? Number(m[1]) : 0;
    const drop = opts.dropAt;
    opts.dropAt = undefined;
    return {
      status: m ? 206 : 200,
      body: (async function* () {
        for (let o = start; o < blob.length; o += 16_384) {
          if (drop !== undefined && o >= drop) throw new Error('gateway connection closed');
          yield new Uint8Array(blob.subarray(o, Math.min(o + 16_384, blob.length)));
        }
      })(),
    };
  };
  return { open, calls };
}

test('a download through the gateway resumes after a dropped connection and is verified', async () => {
  const dest = path.join(tmp, 'gw', 'DexterityConnect-0.1.110.apk');
  const t = tunnel({ dropAt: 100_000 });
  await assert.rejects(downloadVerifiedFrom(t.open, dest, { size: blob.length, sha512: sha }), /it will resume/);
  assert.ok(fs.statSync(`${dest}.part`).size >= 98_000, 'what arrived is kept');
  let last = 0;
  await downloadVerifiedFrom(t.open, dest, { size: blob.length, sha512: sha }, { onProgress: (p) => { last = p.received; } });
  assert.match(t.calls[1].range ?? '', /^bytes=\d+-$/, 'the second attempt asked for the rest');
  assert.deepEqual(fs.readFileSync(dest), blob);
  assert.equal(last, blob.length);
  // a hub answer other than the file (an old hub without that build) is an error, not a file
  await assert.rejects(downloadVerifiedFrom(async () => ({ status: 404, body: (async function* () { yield new Uint8Array(2); })() }), path.join(tmp, 'gw2', 'x.apk'), { size: blob.length, sha512: sha }), /HTTP 404/);
  // a tampered copy is discarded
  const bad = crypto.createHash('sha512').update('other').digest('base64');
  await assert.rejects(downloadVerifiedFrom(tunnel().open, path.join(tmp, 'gw3', 'x.apk'), { size: blob.length, sha512: bad }), /integrity check/);
  assert.ok(!fs.existsSync(path.join(tmp, 'gw3', 'x.apk.part')));
});
