// Backups: a copy taken while people keep writing, checked after each run; only new files are
// copied; the keeping rules; a restore round trip (refused while the hub runs, the old data kept
// aside); and a backup folder that cannot be used, with the two-day alert.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createIdentity } from '@dex/core';
import type { BackupStatus, Message } from '@dex/core';
import { HubClient } from '@dex/core/client';
import { Hub } from '../src/hub.ts';
import { chooseKeep, copyName, hashFile, restoreBackup } from '../src/backup.ts';
import { office, me, nextEvent, send, until } from './office.ts';

const temp: string[] = [];
after(() => { for (const d of temp) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); temp.push(d); return d; };
const DAY = 86_400_000;

function poolFiles(root: string): string[] {
  const pool = path.join(root, 'files');
  return fs.readdirSync(pool).filter((d) => /^[0-9a-f]{2}$/.test(d)).flatMap((d) => fs.readdirSync(path.join(pool, d)));
}

test('a backup taken while people keep writing is consistent and checked; the next run copies only new files', async () => {
  const { hub, owner, priya } = await office();
  const dest = tmp('dexbk-dest-');
  await assert.rejects(priya.request('admin.backup.set', { folder: dest }), /administrators/);
  await assert.rejects(owner.request('admin.backup.set', { folder: 'relative\\folder' }), /whole folder path/);
  await assert.rejects(owner.request('admin.backup.set', { folder: path.join(hub.backups['h'].dataDir, 'inside') }), /outside the hub's data folder/);
  await assert.rejects(owner.request('admin.backup.set', { time: '25:00' }), /like 02:00/);
  const set = await owner.request('admin.backup.set', { folder: dest, time: '02:00' });
  assert.equal(set.config.folder, path.resolve(dest));
  assert.equal(set.config.keepDaily, 14);
  assert.ok(set.nextRunAt! > Date.now() && set.nextRunAt! <= Date.now() + DAY, 'the first run is tonight');
  assert.ok(fs.existsSync(path.join(dest, 'README.txt')));

  const space = await priya.request('conv.create', { kind: 'space', name: 'Pump skid P-12' });
  const files = ['GA drawing rev C', 'Valve list', 'Datasheet'].map((n, i) => hub.files.storeBuffer(me(priya), `${n}.pdf`, 'application/pdf', Buffer.from(`${n} `.repeat(500 + i))));
  // people keep writing while the copy is taken
  let writing = true;
  let sent = 0;
  const writer = (async () => { while (writing) { await send(priya, space.id, `Markup ${sent++}`); } })();
  await new Promise((r) => setTimeout(r, 50));
  const first = await hub.backups.start(true);
  writing = false;
  await writer;
  assert.equal(first.ok, true, first.error ?? '');
  assert.equal(first.check?.integrity, 'ok');
  assert.ok(first.check!.rows.messages > 0);
  assert.ok(first.check!.rows.users >= 3);
  assert.equal(first.filesAdded, 3);
  assert.equal(first.check!.files, 3);
  assert.equal(first.check!.hashed, 3, 'a sample of files is read back and compared with its hash');
  assert.ok(sent > 5, `messages were written during the backup (${sent})`);

  // the copy opens read-only, passes the check, and has what was there when it was taken
  const snap = path.join(dest, 'snapshots', first.name!);
  assert.ok(!fs.existsSync(path.join(snap, 'hub.db-wal')), 'one file, no write-ahead log beside it');
  const copy = new DatabaseSync(path.join(snap, 'hub.db'), { readOnly: true });
  assert.equal((copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
  const inCopy = (copy.prepare('SELECT COUNT(*) AS n FROM messages WHERE conv_id = ?').get(space.id) as { n: number }).n;
  copy.close();
  const live = (hub.store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conv_id = ?').get(space.id) as { n: number }).n;
  assert.ok(inCopy > 0 && inCopy <= live, `${inCopy} of ${live}`);
  for (const f of files) {
    const sha = (hub.store.db.prepare('SELECT sha256 FROM files WHERE id = ?').get(f.id) as { sha256: string }).sha256;
    assert.equal(await hashFile(path.join(dest, 'files', sha.slice(0, 2), sha)), sha);
  }
  assert.ok(fs.existsSync(path.join(snap, 'hub-key.pem')) && fs.existsSync(path.join(snap, 'hub-cert.pem')), 'the hub identity is in the copy');
  const manifest = JSON.parse(fs.readFileSync(path.join(snap, 'manifest.json'), 'utf8')) as { hubId: string; check: { integrity: string } };
  assert.equal(manifest.hubId, hub.info.id);

  // the next run: one new file is copied, the others are already there
  const fourth = hub.files.storeBuffer(me(priya), 'Isometric.dwg', 'image/vnd.dwg', Buffer.from('ISO'.repeat(4000)));
  const second = await hub.backups.start(false);
  assert.equal(second.ok, true, second.error ?? '');
  assert.equal(second.filesAdded, 1);
  assert.equal(second.bytesAdded, fourth.size);
  assert.equal(second.check!.files, 4);
  assert.equal(poolFiles(dest).length, 4);
  // two copies the same day: the day keeps its newest
  assert.equal(second.removed, 1);
  assert.ok(!fs.existsSync(snap));

  // the status, and "Back up now" from the Control room
  const done = nextEvent<BackupStatus>(owner, 'admin.backup', (s) => !s.running && !!s.lastRun && s.lastRun.startedAt > second.startedAt, 15_000);
  const started = await owner.request('admin.backup.run');
  assert.ok(started.running, 'it runs in the background');
  const status = await done;
  assert.equal(status.lastSuccess?.ok, true);
  assert.equal(status.warning, null);
  assert.equal(status.copies.length, 1);
  assert.deepEqual(status.copies[0].kept.sort(), ['daily', 'latest', 'monthly', 'weekly']);
  assert.ok(status.folderBytes! > fourth.size);
  assert.equal(status.history.length, 3);
  assert.ok(hub.store.auditTrail(50).some((a) => a.action === 'backup.done'));
  assert.ok(hub.store.auditTrail(50).some((a) => a.action === 'backup.settings'));
});

test('the keeping rules: one a day for 14 days, a week for 8 weeks, a month for 12 months; old copies and their files go', async () => {
  const now = new Date(2026, 10, 15, 2, 0).getTime();
  // a copy every night for 500 days, and a second one on the latest day
  const copies = Array.from({ length: 500 }, (_, i) => ({ name: copyName(now - i * DAY), at: now - i * DAY }));
  copies.push({ name: `${copyName(now - 3600_000)}`, at: now - 3600_000 });
  const keep = chooseKeep(copies, { keepDaily: 14, keepWeekly: 8, keepMonthly: 12 }, now);
  const why = (k: string) => [...keep.values()].filter((l) => l.includes(k as never)).length;
  assert.equal(why('daily'), 14);
  assert.equal(why('weekly'), 8);
  assert.equal(why('monthly'), 12);
  assert.deepEqual(keep.get(copyName(now)), ['latest', 'daily', 'weekly', 'monthly']);
  assert.ok(!keep.has(copyName(now - 3600_000)), 'the earlier copy of the same day is not kept');
  const oldest = Math.min(...copies.filter((c) => keep.has(c.name)).map((c) => c.at));
  assert.ok(now - oldest < 366 * DAY, 'nothing older than the twelve months');
  assert.ok(keep.size < 14 + 8 + 12 + 1);
  // a rule set to keep nothing weekly or monthly
  assert.equal(chooseKeep(copies, { keepDaily: 3, keepWeekly: 0, keepMonthly: 0 }, now).size, 3);

  // in a backup folder: old copies are removed, and files only they used leave the pool
  const { hub, owner, priya } = await office();
  const dest = tmp('dexbk-keep-');
  await owner.request('admin.backup.set', { folder: dest });
  const oldSha = 'ab'.repeat(32);
  const old = path.join(dest, 'snapshots', '2024-01-01_0200');
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'manifest.json'), JSON.stringify({ format: 1, hubId: hub.info.id, hubName: 'x', version: '0', takenAt: new Date(2024, 0, 1, 2).getTime(), dbBytes: 1, filesBytes: 0, files: 1, missing: 0, check: null }));
  fs.writeFileSync(path.join(old, 'files.txt'), oldSha);
  fs.mkdirSync(path.join(dest, 'files', 'ab'), { recursive: true });
  fs.writeFileSync(path.join(dest, 'files', 'ab', oldSha), 'old');
  // a copy from last month stays as the month's
  const lastMonth = path.join(dest, 'snapshots', 'last-month');
  fs.cpSync(old, lastMonth, { recursive: true });
  const lm = new Date(); lm.setMonth(lm.getMonth() - 1);
  fs.writeFileSync(path.join(lastMonth, 'manifest.json'), JSON.stringify({ format: 1, hubId: hub.info.id, hubName: 'x', version: '0', takenAt: lm.getTime(), dbBytes: 1, filesBytes: 0, files: 1, missing: 0, check: null }));
  // a half-written copy from a run that stopped two days ago
  const partial = path.join(dest, 'snapshots', '.partial-2026-01-01_0200-abc');
  fs.mkdirSync(partial);
  fs.utimesSync(partial, new Date(Date.now() - 2 * DAY), new Date(Date.now() - 2 * DAY));
  hub.files.storeBuffer(me(priya), 'Note.txt', 'text/plain', Buffer.from('kept'));
  const run = await hub.backups.start(true);
  assert.equal(run.ok, true, run.error ?? '');
  assert.equal(run.removed, 1);
  assert.ok(!fs.existsSync(old), 'the copy from 2024 is removed');
  assert.ok(fs.existsSync(lastMonth), "last month's copy is kept");
  assert.ok(fs.existsSync(path.join(dest, 'files', 'ab', oldSha)), 'still used by last month');
  assert.ok(!fs.existsSync(partial), 'half-written copies are cleared away');
  fs.rmSync(lastMonth, { recursive: true });
  const again = await hub.backups.start(true);
  assert.equal(again.ok, true);
  assert.ok(!fs.existsSync(path.join(dest, 'files', 'ab', oldSha)), 'a file no copy uses leaves the pool');
  assert.equal(poolFiles(dest).length, 1);
  // settings for the rules
  await assert.rejects(owner.request('admin.backup.set', { keepDaily: 0 }), /between 1 and/);
  const s = await owner.request('admin.backup.set', { keepDaily: 7, keepWeekly: 4, keepMonthly: 6 });
  assert.deepEqual([s.config.keepDaily, s.config.keepWeekly, s.config.keepMonthly], [7, 4, 6]);
});

test('restore: refused while the hub runs; the current data is kept aside; the restored hub has what the backup had', async () => {
  const dataDir = tmp('dexbk-data-');
  const dest = tmp('dexbk-rest-');
  const hub = new Hub({ dataDir, port: 0, host: '127.0.0.1', discoveryPort: false, updates: false });
  await hub.start();
  let stopped = false;
  const stop = async () => { if (!stopped) { stopped = true; await hub.stop(); } };
  const identity = createIdentity();
  const owner = new HubClient({ identity, account: { username: 'vikram', domain: 'DEX', displayName: 'Vikram', hostname: 'vikram-pc' } });
  owner.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
  await until(owner, (s) => s.kind === 'ready');
  const fingerprint = hub.fingerprint;
  const space = await owner.request('conv.create', { kind: 'space', name: 'Site photos' });
  const kept = await send(owner, space.id, 'Before the backup');
  const file = hub.files.storeBuffer(me(owner), 'Survey.pdf', 'application/pdf', Buffer.from('survey '.repeat(300)));
  await owner.request('admin.backup.set', { folder: dest });
  const run = await hub.backups.start(true);
  assert.equal(run.ok, true, run.error ?? '');
  await send(owner, space.id, 'After the backup');

  await assert.rejects(restoreBackup({ from: dest, dataDir, port: hub.port }), /The hub is running/);
  assert.ok(fs.existsSync(path.join(dataDir, 'hub.db')), 'nothing was touched');
  owner.disconnect();
  await stop();
  await assert.rejects(restoreBackup({ from: tmp('dexbk-empty-'), dataDir, port: 1 }), /No backup was found/);

  const lines: string[] = [];
  const r = await restoreBackup({ from: dest, dataDir, port: 1, log: (l) => lines.push(l) });
  assert.ok(r.aside && fs.existsSync(path.join(r.aside, 'hub.db')), 'the data that was there is kept aside');
  temp.push(r.aside!);
  assert.equal(r.files, 1);
  assert.ok(lines.some((l) => /passed SQLite's check/.test(l)));
  assert.ok(fs.existsSync(path.join(dataDir, 'restored-from.txt')));

  // the restored hub: same identity, the device still signs in, the message from after the backup is not there
  const back = new Hub({ dataDir, port: 0, host: '127.0.0.1', discoveryPort: false, updates: false });
  await back.start();
  try {
    assert.equal(back.fingerprint, fingerprint, 'devices trust the restored hub');
    const again = new HubClient({ identity, account: { username: 'vikram', domain: 'DEX', displayName: 'Vikram', hostname: 'vikram-pc' } });
    again.connect({ host: '127.0.0.1', port: back.port, fp: back.fingerprint });
    await until(again, (s) => s.kind === 'ready');
    const list = await again.request('msg.list', { convId: space.id });
    const bodies = list.messages.map((m: Message) => m.body);
    assert.ok(bodies.includes(kept.body));
    assert.ok(!bodies.includes('After the backup'));
    assert.equal(back.files.read(file.id, 1e6)?.toString(), 'survey '.repeat(300));
    again.disconnect();
    // a restore from a copy's own folder works too (here: refused, as this hub is running)
    await assert.rejects(restoreBackup({ from: path.join(dest, 'snapshots', run.name!), dataDir, port: back.port }), /running/);
  } finally { await back.stop(); }
});

test('a backup folder that cannot be used: plain words, the next try in an hour, and administrators told after two days', async () => {
  const { hub, owner } = await office();
  const parent = tmp('dexbk-bad-');
  const notAFolder = path.join(parent, 'disk.txt');
  fs.writeFileSync(notAFolder, 'a file, not a folder');
  await assert.rejects(owner.request('admin.backup.set', { folder: path.join(notAFolder, 'backups') }), /could not be reached/);

  const dest = path.join(parent, 'usb');
  await owner.request('admin.backup.set', { folder: dest });
  // the disk goes away and something else takes its name
  fs.rmSync(dest, { recursive: true });
  fs.writeFileSync(dest, 'not a folder any more');
  const run = await hub.backups.start(true);
  assert.equal(run.ok, false);
  assert.match(run.error!, /could not be reached\. Check that the disk is plugged in/);
  const status = hub.backups.status();
  assert.equal(status.lastSuccess, null);
  assert.equal(status.lastRun?.error, run.error);
  assert.ok(Math.abs(status.nextRunAt! - (run.finishedAt + 3600_000)) < 1000, 'tried again in an hour');
  assert.equal(status.warning, null, 'not yet two days');
  assert.ok(hub.store.auditTrail(20).some((a) => a.action === 'backup.failed'));
  assert.ok(!fs.readdirSync(parent).some((n) => n.startsWith('.partial')));

  // two days on with no backup: the Control room warns and the system bot tells administrators once a day
  const later = Date.now() + 2 * DAY + 3600_000;
  assert.match(hub.backups.warning(later)!, /No backup has worked yet/);
  assert.match(hub.backups.warning(later)!, /could not be reached/);
  const told = nextEvent<Message>(owner, 'msg.new', (m) => /Backups need attention/.test(m.body));
  hub.backups.tick(later);
  assert.match((await told).body, /Backup/);
  const before = hub.store.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE body LIKE '%Backups need attention%'`).get() as { n: number };
  hub.backups.tick(later + 60_000);
  const afterTick = hub.store.db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE body LIKE '%Backups need attention%'`).get() as { n: number };
  assert.equal(afterTick.n, before.n, 'once a day, not every tick');
  // the timer also tried again (an hour had passed): that run fails the same way
  assert.equal((await hub.backups.start(false)).ok, false);
  // the folder works again: the next run succeeds and the warning clears
  fs.rmSync(dest);
  fs.mkdirSync(dest);
  const ok = await hub.backups.start(false);
  assert.equal(ok.ok, true, ok.error ?? '');
  assert.equal(hub.backups.warning(), null);

  // a hub with no backup folder at all warns once it is two days old
  const fresh = await office();
  assert.equal(fresh.hub.backups.warning(), null);
  assert.match(fresh.hub.backups.warning(Date.now() + 3 * DAY)!, /not set up/);
  await assert.rejects(fresh.owner.request('admin.backup.run'), /Choose a backup folder first/);
});
