// The hub updating itself (src/hub-update.ts), against a stand-in release feed and a stand-in
// "launcher" in place of really running the setup: a newer version is found, downloaded and checked,
// installed in the quiet window after a backup, never while a meeting is live; a restart with the
// new version is recorded as done, one with the old version as failed (and that version is not tried
// again by itself); no downgrade, no beta on stable, and the administrators' switch is obeyed.
// Installing for real (the scheduled task, the setup, the rollback) is the Windows install test:
// apps/hub/installer/smoke-test.ps1 in the hub-smoke job.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { HubUpdateView } from '@dex/core';
import type { UpdateFeed } from '@dex/core/updates';
import { HubUpdater, SETUP_FILE_RE, selfUpdateSupport, taskXml, windowsLauncher } from '../src/hub-update.ts';
import type { HubUpdateHost, LaunchPlan } from '../src/hub-update.ts';
import { office } from './office.ts';

const dirs: string[] = [];
const closers: Array<() => unknown> = [];
after(async () => { for (const c of closers.reverse()) await c(); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dexhubupd-')); dirs.push(d); return d; };
const sha = (b: Buffer) => crypto.createHash('sha512').update(b).digest('base64');
const HOUR = 3600_000;
/** 18 Nov 2026 at hh:mm, hub-local time. */
const at = (hh: number, mm = 0, day = 18) => new Date(2026, 10, day, hh, mm).getTime();

/** Stands in for the public release feed. */
async function releaseFeed() {
  const files = new Map<string, Buffer>();
  const feeds = new Map<string, unknown>();
  let downloads = 0;
  const s = http.createServer((req, res) => {
    const url = req.url ?? '';
    if (feeds.has(url)) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(feeds.get(url))); return; }
    const f = files.get(url);
    if (f) { downloads++; res.writeHead(200); res.end(f); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  closers.push(() => s.close());
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  return {
    base,
    urls: { stable: `${base}/stable.json`, beta: `${base}/beta.json` },
    get downloads() { return downloads; },
    publish(channel: 'stable' | 'beta', version: string, opts: { tamper?: boolean; zip?: boolean; claim?: 'stable' | 'beta'; name?: string } = {}) {
      const exe = Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(40_000)]);
      const file = opts.name ?? (opts.zip ? `DexterityConnectHub-${version}-win-x64.zip` : `DexterityConnectHub-Setup-${version}.exe`);
      files.set(`/dl/${version}/${file}`, opts.tamper ? crypto.randomBytes(exe.length) : exe);
      const feed: UpdateFeed = {
        schema: 1, channel: opts.claim ?? channel, version, releasedAt: new Date().toISOString(), notes: `Hub ${version}`,
        assets: [
          { platform: 'win-x64', file: `DexterityConnect-Setup-${version}.exe`, url: `${base}/dl/${version}/app.exe`, size: 10, sha512: sha(Buffer.alloc(10)) },
          { platform: 'hub-win-x64', file, url: `${base}/dl/${version}/${file}`, size: exe.length, sha512: sha(exe) },
        ],
      };
      feeds.set(`/${channel}.json`, feed);
      return exe;
    },
  };
}

interface Told { uid: string; text: string; key: string }

/** A hub stand-in: its settings table, clock, meetings, backups, administrators and audit log. */
function host(feed: { urls: Record<'stable' | 'beta', string> }, o: { version?: string; dataDir?: string; meta?: Map<string, string>; clock?: { t: number } } = {}) {
  const meta = o.meta ?? new Map<string, string>();
  const clock = o.clock ?? { t: at(14) };
  const launched: LaunchPlan[] = [];
  const told: Told[] = [];
  const audit: Array<{ actor: string | null; action: string; detail: Record<string, unknown> }> = [];
  const backup = { configured: true, running: false, ok: true, last: at(2, 5) as number | null, runs: 0 };
  const state = { live: null as 'meeting' | 'call' | 'webinar' | null, launchFails: false };
  const views: HubUpdateView[] = [];
  const h: HubUpdateHost = {
    dataDir: o.dataDir ?? tmp(),
    version: o.version ?? '0.1.40',
    unsupported: null,
    launcher: async (plan) => { if (state.launchFails) throw new Error('schtasks.exe /Create: access denied'); launched.push(plan); },
    feedUrls: feed.urls,
    allowHttp: true,
    meta: (k) => meta.get(k) ?? '',
    setMeta: (k, v) => { meta.set(k, v); },
    live: () => state.live,
    backups: {
      configured: () => backup.configured,
      running: () => backup.running,
      lastSuccessAt: () => backup.last,
      run: async () => { backup.runs++; if (backup.ok) backup.last = clock.t; return { ok: backup.ok, error: backup.ok ? null : 'E:\\ is not there' }; },
    },
    admins: () => [{ id: 'owner' }, { id: 'admin2' }],
    tell: (uid, text, key) => { if (!told.some((t) => t.uid === uid && t.key === key)) told.push({ uid, text, key }); },
    audit: (actor, action, _target, detail) => { audit.push({ actor, action, detail }); },
    changed: (v) => { views.push(v); },
    log: () => {},
    setupLog: 'C:\\ProgramData\\Dexterity Connect Hub\\setup.log',
    now: () => clock.t,
    firstCheckDelayMs: 0,
    checkEveryMs: 4 * HOUR,
  };
  const u = new HubUpdater(h);
  /** One timer tick at `t`, and whatever it started. */
  const tick = async (t?: number) => { if (t !== undefined) clock.t = t; u.tick(); await u.idle(); };
  return { u, h, meta, clock, launched, told, audit, backup, state, views, tick };
}

/** The hub after the setup restarted it: same settings and data, the version the setup left. */
function restart(prev: ReturnType<typeof host>, feed: { urls: Record<'stable' | 'beta', string> }, version: string) {
  const next = host(feed, { version, dataDir: prev.h.dataDir, meta: prev.meta, clock: prev.clock });
  return next;
}

test('a newer hub is found, downloaded and checked, announced once, and installed at 03:00 after a fresh backup', async () => {
  const feed = await releaseFeed();
  const exe = feed.publish('stable', '0.1.42');
  const t = host(feed);
  await t.tick(at(14));
  let v = t.u.view();
  assert.equal(v.available?.version, '0.1.42');
  assert.equal(v.downloaded, true);
  const file = path.join(t.h.dataDir, 'hub-update', 'DexterityConnectHub-Setup-0.1.42.exe');
  assert.deepEqual(fs.readFileSync(file), exe, 'the setup is kept on the hub, as the feed described it');
  assert.equal(v.nextAt, at(3, 0, 19), 'it installs at 03:00 tomorrow');
  assert.equal(t.launched.length, 0, 'not in the afternoon');
  assert.deepEqual(t.told.map((x) => x.uid), ['owner', 'admin2']);
  assert.match(t.told[0].text, /updates itself to 0\.1\.42 at 03:00.*offline for about a minute/s);

  // the next ticks do not download again or tell again
  await t.tick(at(15));
  await t.tick(at(23, 59));
  assert.equal(feed.downloads, 1);
  assert.equal(t.told.length, 2);

  // 03:00: a fresh backup first, then the setup, with the intent written down before it runs
  t.backup.last = at(2, 10);
  await t.tick(at(3, 0, 19));
  assert.equal(t.backup.runs, 1, 'a fresh backup is made just before');
  assert.equal(t.launched.length, 1);
  const plan = t.launched[0];
  assert.equal(plan.setup, file);
  assert.deepEqual(plan.args, ['/S', '/SELFUPDATE', '/NOPOWER']);
  assert.equal(plan.version, '0.1.42');
  assert.equal(plan.from, '0.1.40');
  v = t.u.view();
  assert.deepEqual(v.installing, { version: '0.1.42', since: at(3, 0, 19) });
  assert.ok(t.audit.some((a) => a.action === 'hub.update.started' && a.detail.backup === 'fresh' && a.detail.to === '0.1.42'));
  // nothing more happens while the setup runs
  await t.tick(at(3, 1, 19));
  assert.equal(t.launched.length, 1);

  // the setup restarts the hub with the new version
  const after1 = restart(t, feed, '0.1.42');
  await after1.tick(at(3, 2, 19));
  v = after1.u.view();
  assert.equal(v.installing, null);
  assert.equal(v.available, null);
  assert.equal(v.failed, null);
  assert.equal(v.history[0].ok, true);
  assert.equal(v.history[0].message, 'Updated from 0.1.40 to 0.1.42.');
  assert.equal(v.history[0].backup, 'fresh');
  assert.ok(after1.audit.some((a) => a.action === 'hub.updated' && a.actor === null && a.detail.from === '0.1.40' && a.detail.to === '0.1.42'));
  assert.equal(after1.told.length, 2);
  assert.match(after1.told[0].text, /updated itself.*from 0\.1\.40 to 0\.1\.42/s);
  await after1.tick(at(3, 3, 19));
  assert.equal(after1.told.length, 2, 'told once');
  assert.equal(fs.existsSync(file), false, 'the used setup is removed');
});

test('a setup whose hash or size does not match the feed is refused and never run', async () => {
  const feed = await releaseFeed();
  feed.publish('stable', '0.1.42', { tamper: true });
  const t = host(feed);
  await t.tick(at(3, 0));
  const v = t.u.view();
  assert.equal(v.available?.version, '0.1.42');
  assert.equal(v.downloaded, false);
  assert.match(v.lastError ?? '', /integrity check/);
  assert.equal(t.launched.length, 0);
  assert.equal(fs.readdirSync(path.join(t.h.dataDir, 'hub-update')).length, 0, 'nothing kept');

  // a good file, then changed on disk before 03:00: checked again just before it runs, so not run
  const good = await releaseFeed();
  good.publish('stable', '0.1.43');
  const t2 = host(good);
  await t2.tick(at(14));
  assert.equal(t2.u.view().downloaded, true);
  const file = path.join(t2.h.dataDir, 'hub-update', 'DexterityConnectHub-Setup-0.1.43.exe');
  const bytes = fs.readFileSync(file);
  bytes[100] ^= 0xff;
  fs.writeFileSync(file, bytes);
  await t2.tick(at(3, 0, 19));
  assert.equal(t2.launched.length, 0);
  assert.match(t2.u.view().lastError ?? '', /no longer matched the release feed/);
  assert.equal(fs.existsSync(file), false);
});

test('it waits for the quiet window, and while a meeting is live it waits until it ends, up to the window\'s end', async () => {
  const feed = await releaseFeed();
  feed.publish('stable', '0.1.42');
  const t = host(feed);
  await t.tick(at(14));
  await t.tick(at(2, 59, 19));
  assert.equal(t.launched.length, 0, 'not before 03:00');

  t.state.live = 'meeting';
  await t.tick(at(3, 0, 19));
  assert.equal(t.launched.length, 0);
  assert.equal(t.u.view().waiting, 'meeting');
  t.state.live = 'webinar';
  await t.tick(at(4, 30, 19));
  assert.equal(t.u.view().waiting, 'webinar');
  // the window closes at 05:00: after that, nothing until the next night
  t.state.live = null;
  await t.tick(at(5, 0, 19));
  assert.equal(t.launched.length, 0, 'not after the quiet window');
  assert.equal(t.u.view().nextAt, at(3, 0, 20));
  assert.equal(t.u.view().waiting, null);
  await t.tick(at(3, 0, 20));
  assert.equal(t.launched.length, 1, 'the next night');

  // a call that ends inside the window: it goes as soon as it has ended
  const f2 = await releaseFeed();
  f2.publish('stable', '0.1.42');
  const t2 = host(f2);
  await t2.tick(at(14));
  t2.state.live = 'call';
  await t2.tick(at(3, 0, 19));
  assert.equal(t2.u.view().waiting, 'call');
  t2.state.live = null;
  await t2.tick(at(3, 40, 19));
  assert.equal(t2.launched.length, 1);
});

test('backups: a fresh one first; if it fails, tonight\'s will do; without any good backup in a day it waits; without backups it updates and says so', async () => {
  const feed = await releaseFeed();
  feed.publish('stable', '0.1.42');

  // the fresh backup fails, but the 02:00 one worked
  const a = host(feed);
  await a.tick(at(14));
  a.backup.ok = false;
  a.backup.last = at(2, 5, 19);
  await a.tick(at(3, 0, 19));
  assert.equal(a.backup.runs, 1);
  assert.equal(a.launched.length, 1);
  assert.ok(a.audit.some((x) => x.action === 'hub.update.started' && x.detail.backup === 'recent'));

  // no good backup for two days: it does not update, and tries the backup once per window
  const b = host(feed);
  await b.tick(at(14));
  b.backup.ok = false;
  b.backup.last = at(2, 0, 16);
  await b.tick(at(3, 0, 19));
  await b.tick(at(3, 5, 19));
  assert.equal(b.launched.length, 0);
  assert.equal(b.backup.runs, 1, 'one try per quiet window');
  assert.equal(b.u.view().waiting, 'backup-failed');
  b.backup.ok = true;
  await b.tick(at(3, 0, 20));
  assert.equal(b.backup.runs, 2);
  assert.equal(b.launched.length, 1, 'the next night, after a backup that worked');

  // the night's backup still running at 03:00: it waits for it
  const c = host(feed);
  await c.tick(at(14));
  c.backup.running = true;
  await c.tick(at(3, 0, 19));
  assert.equal(c.u.view().waiting, 'backup-running');
  assert.equal(c.launched.length, 0);
  c.backup.running = false;
  c.backup.last = at(3, 4, 19);
  await c.tick(at(3, 5, 19));
  assert.equal(c.backup.runs, 0, 'the backup that just finished is fresh enough');
  assert.equal(c.launched.length, 1);

  // no backups set up: it still updates, and says so afterwards
  const d = host(feed);
  d.backup.configured = false;
  await d.tick(at(14));
  await d.tick(at(3, 0, 19));
  assert.equal(d.backup.runs, 0);
  assert.equal(d.launched.length, 1);
  const r = restart(d, feed, '0.1.42');
  await r.tick(at(3, 2, 19));
  assert.equal(r.u.view().history[0].backup, 'none');
  assert.match(r.told[0].text, /Backups are not set up/);
});

test('a failed update (the setup went back to the old version) is recorded and not tried again by itself; Try again allows it', async () => {
  const feed = await releaseFeed();
  feed.publish('stable', '0.1.42');
  const t = host(feed);
  await t.tick(at(14));
  await t.tick(at(3, 0, 19));
  assert.equal(t.launched.length, 1);

  // the setup put 0.1.40 back and restarted it; it reports a moment later, after /health answers
  const back = restart(t, feed, '0.1.40');
  await back.tick(at(3, 3, 19));
  assert.ok(back.u.view().installing, 'waits for the setup to report');
  fs.writeFileSync(t.launched[0].result, `\uFEFF${JSON.stringify({ mode: 'install', code: 3, version: '0.1.42', previous: '0.1.40', message: 'The update to 0.1.42 did not work, so the hub went back to 0.1.40 and is running.', log: 'C:\\ProgramData\\Dexterity Connect Hub\\setup.log', at: new Date().toISOString() })}`);
  await back.tick(at(3, 4, 19));
  let v = back.u.view();
  assert.equal(v.installing, null);
  assert.equal(v.failed?.version, '0.1.42');
  assert.match(v.failed?.message ?? '', /went back to 0\.1\.40/);
  assert.equal(v.failed?.log, 'C:\\ProgramData\\Dexterity Connect Hub\\setup.log');
  assert.equal(v.history[0].ok, false);
  assert.ok(back.audit.some((x) => x.action === 'hub.update.failed'));
  assert.equal(back.told.length, 2);
  assert.match(back.told[0].text, /could not update itself to 0\.1\.42.*does not try 0\.1\.42 again by itself.*Try again/s);
  assert.equal(v.nextAt, null);

  // the next nights: no loop on the same version
  await back.tick(at(3, 0, 20));
  await back.tick(at(3, 0, 21));
  assert.equal(back.launched.length, 0);

  // an administrator reads the log and clicks Try again: it goes at the next quiet time
  v = back.u.retry('owner');
  assert.equal(v.failed, null);
  assert.ok(back.audit.some((x) => x.action === 'hub.update.retry' && x.actor === 'owner'));
  await back.tick(at(14, 0, 21));
  assert.equal(back.launched.length, 0);
  await back.tick(at(3, 0, 22));
  assert.equal(back.launched.length, 1);
  assert.throws(() => back.u.retry('owner'), /No update has failed/);
});

test('a setup that refuses before stopping the hub, or never reports, or cannot be started, is a failure too', async () => {
  const feed = await releaseFeed();
  feed.publish('stable', '0.1.42');
  // refused at the check (the hub keeps running the whole time)
  const a = host(feed);
  await a.tick(at(14));
  await a.tick(at(3, 0, 19));
  fs.writeFileSync(a.launched[0].result, JSON.stringify({ mode: 'check', code: 2, version: '0.1.42', previous: '', message: 'Drive C: has only 0.1 GB free.', log: 'x.log', at: '' }));
  await a.tick(at(3, 1, 19));
  assert.equal(a.u.view().failed?.message, 'Drive C: has only 0.1 GB free.');

  // nothing reported for half an hour
  const b = host(feed);
  await b.tick(at(14));
  await b.tick(at(3, 0, 19));
  await b.tick(at(3, 20, 19));
  assert.ok(b.u.view().installing);
  await b.tick(at(3, 31, 19));
  assert.match(b.u.view().failed?.message ?? '', /did not finish/);

  // Task Scheduler refused
  const c = host(feed);
  c.state.launchFails = true;
  await c.tick(at(14));
  await c.tick(at(3, 0, 19));
  assert.match(c.u.view().failed?.message ?? '', /could not be started: schtasks\.exe \/Create: access denied/);
  assert.equal(c.u.view().installing, null);
});

test('never a downgrade or the same version; never a beta on stable; only the hub setup named for the feed\'s version', async () => {
  const feed = await releaseFeed();
  feed.publish('stable', '0.1.39');
  const t = host(feed);
  await t.tick(at(3, 0));
  assert.equal(t.u.view().available, null, 'older');
  feed.publish('stable', '0.1.40');
  await t.tick(at(8, 0));
  assert.equal(t.u.view().available, null, 'the same');

  // a newer beta is not for a stable hub
  feed.publish('beta', '0.1.50');
  await t.tick(at(12, 0));
  assert.equal(t.u.view().available, null);
  // a feed on the stable address that says it is beta is not trusted
  feed.publish('stable', '0.1.51', { claim: 'beta' });
  await t.tick(at(16, 0));
  assert.equal(t.u.view().available, null);
  // the hub zip (what feeds listed before) and a setup named for another version are ignored
  feed.publish('stable', '0.1.52', { zip: true });
  await t.tick(at(20, 0));
  assert.equal(t.u.view().available, null);
  feed.publish('stable', '0.1.53', { name: 'DexterityConnectHub-Setup-0.1.99.exe' });
  await t.tick(at(23, 59));
  assert.equal(t.u.view().available, null);
  assert.equal(feed.downloads, 0);
  assert.ok(SETUP_FILE_RE.test('DexterityConnectHub-Setup-0.1.26111712.exe'));
  assert.ok(!SETUP_FILE_RE.test('DexterityConnectHub-Setup.exe'), 'the fixed-name copy is not a feed entry');

  // the beta channel takes the newer of the two feeds
  t.u.configure('owner', { channel: 'beta' });
  await t.tick(at(23, 59, 19));
  assert.equal(t.u.view().available?.version, '0.1.50');
  assert.equal(t.u.view().available?.channel, 'beta');
  // back on stable, the beta is dropped, never installed
  t.u.configure('owner', { channel: 'stable' });
  await t.tick(at(3, 0, 20));
  assert.equal(t.u.view().available, null);
  assert.equal(t.launched.length, 0);
});

test('administrators: automatic updates off stops it; Update now waits for a live meeting unless forced; settings are checked', async () => {
  const feed = await releaseFeed();
  feed.publish('stable', '0.1.42');
  const t = host(feed);
  t.u.configure('owner', { auto: false });
  await t.tick(at(14));
  assert.equal(t.u.view().available?.version, '0.1.42', 'it still looks');
  assert.equal(t.u.view().nextAt, null);
  await t.tick(at(3, 0, 19));
  assert.equal(t.launched.length, 0, 'off means off');
  assert.equal(t.told.length, 0, 'nobody is told of an update that will not happen by itself');
  assert.throws(() => t.u.configure('owner', { time: '3am' }), /like 03:00/);
  assert.throws(() => t.u.configure('owner', { channel: 'nightly' }), /stable or beta/);
  assert.throws(() => t.u.configure('owner', { auto: 'yes' }), /on or off/);
  t.u.configure('owner', { time: '01:30' });
  assert.equal(t.u.config().time, '01:30');
  assert.ok(t.audit.some((a) => a.action === 'hub.update.settings' && a.actor === 'owner'));

  // Update now in the afternoon, with a meeting going on: it waits
  t.state.live = 'meeting';
  let v = await t.u.updateNow('owner', false);
  assert.equal(v.requested?.by, 'owner');
  await t.u.idle();
  await t.tick(at(14, 5, 19));
  assert.equal(t.launched.length, 0);
  assert.equal(t.u.view().waiting, 'meeting');
  // the meeting ends: it goes, after a fresh backup
  t.state.live = null;
  await t.tick(at(14, 40, 19));
  assert.equal(t.launched.length, 1);
  assert.ok(t.audit.some((a) => a.action === 'hub.update.started' && a.actor === 'owner'));
  await assert.rejects(t.u.updateNow('owner', false), /already installing/);

  // forced: it does not wait for the meeting
  const f2 = await releaseFeed();
  f2.publish('stable', '0.1.42');
  const u2 = host(f2);
  await u2.tick(at(14));
  u2.state.live = 'webinar';
  v = await u2.u.updateNow('admin2', true);
  await u2.u.idle();
  await u2.tick(at(14, 1));
  assert.equal(u2.launched.length, 1);

  // nothing newer: Update now says so
  const f3 = await releaseFeed();
  f3.publish('stable', '0.1.40');
  const u3 = host(f3);
  await assert.rejects(u3.u.updateNow('owner', false), /already the newest/);
  // a hub that cannot update itself refuses, and does not look at the internet by itself
  const f4 = await releaseFeed();
  f4.publish('stable', '0.1.42');
  const u4 = host(f4);
  u4.h.unsupported = 'This hub runs from source.';
  await assert.rejects(u4.u.updateNow('owner', false), /cannot update itself/);
});

test('the hub: admin-only ops, the switch, the setup check line, and events to administrators', async () => {
  const feed = await releaseFeed();
  feed.publish('stable', '0.1.42');
  const launched: LaunchPlan[] = [];
  const { hub, owner, priya } = await office({ hubUpdate: { feedUrls: feed.urls, allowHttp: true, unsupported: null, launcher: async (p) => { launched.push(p); }, firstCheckDelayMs: 10_000_000, version: '0.1.40' } });
  await assert.rejects(priya.request('admin.hubUpdate.get', {}), /administrators/);
  await assert.rejects(priya.request('admin.hubUpdate.set', { auto: false }), /administrators/);
  await assert.rejects(priya.request('admin.hubUpdate.now', {}), /administrators/);
  let v = await owner.request('admin.hubUpdate.get', { check: true });
  assert.equal(v.version, '0.1.40');
  assert.equal(v.available?.version, '0.1.42');
  assert.equal(v.config.auto, true);
  assert.equal(v.config.time, '03:00');
  assert.equal(v.config.channel, 'stable');
  const r = await owner.request('admin.setup.report');
  const line = r.checks.find((c) => c.id === 'hub.update');
  assert.equal(line?.title, 'A newer hub is ready to install');
  assert.match(line?.detail ?? '', /Version 0\.1\.40, stable channel; last looked/);
  v = await owner.request('admin.hubUpdate.set', { auto: false });
  assert.equal(v.config.auto, false);
  const r2 = await owner.request('admin.setup.report');
  assert.equal(r2.checks.find((c) => c.id === 'hub.update')?.title, 'Automatic hub updates are off');
  await assert.rejects(owner.request('admin.hubUpdate.set', { time: '25:00' }), /like 03:00/);
  await assert.rejects(owner.request('admin.hubUpdate.retry'), /No update has failed/);
  const audit = await owner.request('admin.audit', { limit: 20 });
  assert.ok(audit.some((a) => a.action === 'hub.update.settings'));
  assert.ok(hub.hubUpdate);
  assert.equal(launched.length, 0);

  // Update now while a call is going on in the office: it waits for the call to end (the hub's own Rooms)
  const space = await owner.request('conv.create', { kind: 'space', name: 'Site visit', members: [priya.session!.me.id] });
  const call = await owner.request('room.start', { convId: space.id, video: false });
  v = await owner.request('admin.hubUpdate.now', {});
  assert.equal(v.requested?.by, owner.session!.me.id);
  await hub.hubUpdate.idle();
  hub.hubUpdate.tick();
  await hub.hubUpdate.idle();
  assert.ok(['call', 'meeting'].includes(hub.hubUpdate.view().waiting ?? ''), 'a Space call is held as a meeting');
  assert.equal(launched.length, 0);
  await owner.request('room.leave', { roomId: call.id });
  hub.hubUpdate.tick();
  await hub.hubUpdate.idle();
  assert.equal(launched.length, 1, 'the call ended: the setup runs');
  assert.deepEqual(launched[0].args, ['/S', '/SELFUPDATE', '/NOPOWER']);
  v = await owner.request('admin.hubUpdate.get', {});
  assert.equal(v.installing?.version, '0.1.42');
  assert.ok((await owner.request('admin.audit', { limit: 20 })).some((a) => a.action === 'hub.update.started' && a.actor === owner.session!.me.id));

  // a hub that is not the installed Windows service says so in the setup check
  const plain = await office({ hubUpdate: { unsupported: 'This hub runs from source, not from DexterityConnectHub.exe, so it does not update itself.' } });
  const r3 = await plain.owner.request('admin.setup.report');
  const l3 = r3.checks.find((c) => c.id === 'hub.update');
  assert.equal(l3?.title, 'This hub is updated by hand');
  assert.equal(l3?.state, 'info');
});

test('Windows: the setup runs from a one-off scheduled task as SYSTEM, so it outlives the service it stops', async () => {
  const dir = tmp();
  const calls: Array<[string, string[]]> = [];
  const plan: LaunchPlan = { setup: 'C:\\ProgramData\\Dexterity Connect Hub\\hub-data\\hub-update\\DexterityConnectHub-Setup-0.1.42.exe', args: ['/S', '/SELFUPDATE', '/NOPOWER'], version: '0.1.42', from: '0.1.40', result: 'x' };
  await windowsLauncher(dir, async (file, args) => { calls.push([file, args]); })(plan);
  assert.match(calls[0][0], /System32[\\/]schtasks\.exe$/);
  assert.deepEqual(calls[0][1], ['/Create', '/TN', 'Dexterity Connect Hub update', '/XML', path.join(dir, 'task.xml'), '/F']);
  assert.deepEqual(calls[1][1], ['/Run', '/TN', 'Dexterity Connect Hub update']);
  const raw = fs.readFileSync(path.join(dir, 'task.xml'));
  assert.deepEqual([...raw.subarray(0, 2)], [0xff, 0xfe], 'UTF-16 with its byte-order mark, as schtasks /XML reads it');
  const xml = raw.subarray(2).toString('utf16le');
  assert.equal(xml, taskXml(plan));
  assert.match(xml, /<UserId>S-1-5-18<\/UserId>/);
  assert.match(xml, /<Command>C:\\ProgramData\\Dexterity Connect Hub\\hub-data\\hub-update\\DexterityConnectHub-Setup-0\.1\.42\.exe<\/Command>/);
  assert.match(xml, /<Arguments>\/S \/SELFUPDATE \/NOPOWER<\/Arguments>/);
  assert.match(xml, /<WorkingDirectory>C:\\ProgramData\\Dexterity Connect Hub\\hub-data\\hub-update<\/WorkingDirectory>/);
  assert.doesNotMatch(xml, /<Triggers>/, 'no trigger: it runs once, when asked');
  assert.match(taskXml({ ...plan, setup: 'C:\\A&B\\<x>.exe' }), /<Command>C:\\A&amp;B\\&lt;x&gt;\.exe<\/Command>/);

  assert.match(selfUpdateSupport('/usr/bin/node', 'linux') ?? '', /only on the Windows hub PC/);
  assert.match(selfUpdateSupport('C:\\Program Files\\nodejs\\node.exe', 'win32') ?? '', /runs from source/);
  assert.match(selfUpdateSupport('C:\\Hub\\DexterityConnectHub.exe', 'win32') ?? '', /does not run as the Windows service/);
});

test('the release feed lists the hub setup (not the zip) with its size and SHA-512, and a hub accepts it', async () => {
  const dir = tmp();
  const out = tmp();
  const files: Record<string, Buffer> = {
    'DexterityConnect-Setup-0.1.42.exe': crypto.randomBytes(3000),
    'DexterityConnectHub-Setup-0.1.42.exe': Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(5000)]),
    'DexterityConnectHub-0.1.42-win-x64.zip': crypto.randomBytes(4000),
    // the fixed-name copies (a re-run downloads them too) are not feed entries
    'DexterityConnectHub-Setup.exe': crypto.randomBytes(100),
    'DexterityConnect-Setup.exe': crypto.randomBytes(100),
  };
  for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), b);
  const script = path.resolve(import.meta.dirname, '../../../scripts/release/make-feed.mjs');
  const { execFileSync } = await import('node:child_process');
  const make = (version: string) => execFileSync(process.execPath, [script, '--dir', dir, '--channel', 'stable', '--version', version, '--base-url', 'https://example.invalid/v0.1.42', '--out', path.join(out, 'stable.json')], { stdio: 'pipe' });
  make('0.1.42');
  const feed = JSON.parse(fs.readFileSync(path.join(out, 'stable.json'), 'utf8')) as UpdateFeed;
  assert.deepEqual(feed.assets.map((a) => [a.platform, a.file]), [['win-x64', 'DexterityConnect-Setup-0.1.42.exe'], ['hub-win-x64', 'DexterityConnectHub-Setup-0.1.42.exe']]);
  const hubAsset = feed.assets[1];
  assert.equal(hubAsset.size, files['DexterityConnectHub-Setup-0.1.42.exe'].length);
  assert.equal(hubAsset.sha512, sha(files['DexterityConnectHub-Setup-0.1.42.exe']));
  assert.equal(hubAsset.url, 'https://example.invalid/v0.1.42/DexterityConnectHub-Setup-0.1.42.exe');
  const sums = fs.readFileSync(path.join(dir, 'SHA256SUMS.txt'), 'utf8');
  assert.match(sums, /DexterityConnectHub-0\.1\.42-win-x64\.zip/, 'the zip is still a release file, with its checksum');
  assert.throws(() => make('0.1.43'), /not this release's version/);

  // the feed as written, served: a hub on 0.1.40 takes it
  const s = http.createServer((req, res) => {
    if (req.url === '/stable.json') { res.end(JSON.stringify({ ...feed, assets: feed.assets.map((a) => ({ ...a, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/${a.file}` })) })); return; }
    const f = files[(req.url ?? '').slice(1)];
    if (f) res.end(f); else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  closers.push(() => s.close());
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const t = host({ urls: { stable: `${base}/stable.json`, beta: `${base}/beta.json` } });
  await t.tick(at(3, 0, 19));
  assert.equal(t.launched.length, 1);
  assert.deepEqual(fs.readFileSync(t.launched[0].setup), files['DexterityConnectHub-Setup-0.1.42.exe']);
});
