// First-run office defaults (firstrun.ts): a new hub gets them once; a restart does not apply them
// again; an administrator's change survives a restart; a hub upgraded from an older version keeps
// what it had. The automatic backup folder, with a pretend disk detector: a second disk is chosen
// and backed up to; one disk, another part of the same disk, the Windows disk, a USB disk, a
// full disk or nothing at all are never chosen. And the setup check's report.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createIdentity, NIB_DEFAULTS, setupReportText } from '@dex/core';
import type { SetupReport } from '@dex/core';
import { HubClient } from '@dex/core/client';
import { Hub } from '../src/hub.ts';
import type { HubOptions } from '../src/hub.ts';
import { BACKUP_MIN_FREE, FIRSTRUN_FLAGS, NIB_LEGACY_TIMES, chooseBackupDrive, parseDiskLayout } from '../src/firstrun.ts';
import type { DiskLayout, DiskVolume } from '../src/firstrun.ts';
import { HealthChecks } from '../src/setupcheck.ts';
import { until } from './office.ts';

const GB = 1024 ** 3;
const temp: string[] = [];
const running: Hub[] = [];
after(async () => {
  for (const h of running.splice(0)) await h.stop().catch(() => {});
  for (const d of temp) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (p: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); temp.push(d); return d; };

async function boot(dir: string, extra: Partial<HubOptions> = {}) {
  const hub = new Hub({ dataDir: dir, port: 0, host: '127.0.0.1', discoveryPort: false, updates: false, firstRun: false, ...extra });
  await hub.start();
  running.push(hub);
  return hub;
}
async function stop(hub: Hub) {
  await hub.stop();
  running.splice(running.indexOf(hub), 1);
}
async function owner(hub: Hub, username = 'vikram') {
  const c = new HubClient({ identity: createIdentity(), account: { username, domain: 'DEX', displayName: 'Vikram', hostname: `${username}-pc` } });
  c.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
  await until(c, (s) => s.kind === 'ready');
  return c;
}
const meta = (hub: Hub, key: string) => (hub.store.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
/** What the database looked like under a version without first-run defaults. */
function olderVersion(dir: string, keepNib: boolean) {
  const db = new DatabaseSync(path.join(dir, 'hub.db'));
  db.prepare("DELETE FROM meta WHERE key LIKE 'firstrun_%'").run();
  if (!keepNib) db.prepare("DELETE FROM meta WHERE key = 'nib_config'").run();
  db.close();
}

// ---------------------------------------------------------------- defaults
test('a new hub gets the office defaults: Nib times, private day sheets, the four notice desks, policies, audit', async () => {
  const dir = tmp('dexfr-');
  const hub = await boot(dir);
  const nib = hub.nib.config();
  assert.equal(nib.startPromptAt, '09:45');
  assert.equal(nib.wrapAt, '18:00');
  assert.equal(nib.digestAt, '18:30');
  assert.equal(nib.followUpAt, '19:00');
  assert.deepEqual(nib.workdays, [1, 2, 3, 4, 5, 6], 'Monday to Saturday');
  assert.equal(nib.openSheets, false, 'day sheets are private');
  assert.deepEqual(nib.projects, [], 'no job codes');
  assert.deepEqual(nib.managers, [], 'nobody receives the register until an administrator chooses');
  assert.deepEqual(nib.givers, []);
  // written down, so a later change to the defaults does not move this office's times
  assert.equal(JSON.parse(meta(hub, 'nib_config')!).digestAt, '18:30');
  assert.ok(meta(hub, FIRSTRUN_FLAGS.nib));

  const desks = hub.notices.desks();
  assert.deepEqual(desks.map((d) => d.name).sort(), ['Admin', 'HR', 'IT', 'Management']);
  assert.ok(desks.every((d) => d.issuers.length === 0), 'issuers stay empty');

  // policies have their defaults without anyone opening the Control room
  const p = hub.policies.get();
  assert.equal(p.guestLinks, true);
  assert.equal(p.personalDevices, true);
  assert.equal(p.meetingLobby, 'outside');
  assert.equal(p.allowRecording, true);
  assert.equal(p.requireE2E, false);

  // the defaults are in the audit log, and the log is always on: there is no switch for it
  assert.ok(hub.store.auditTrail().some((a) => a.action === 'setup.defaults'));
  const c = await owner(hub);
  const before = hub.store.auditTrail(1000).length;
  await c.request('admin.backup.set', { time: '03:00' });
  assert.equal(hub.store.auditTrail(1000).length, before + 1, 'a change in the Control room is recorded');
  assert.ok(!Object.keys(p).some((k) => /audit/i.test(k)), 'no policy turns the audit log off');
  c.disconnect();
});

test('Nib: the follow-up at 19:00 comes after the 18:30 register, the same evening', () => {
  const { digestAt, followUpAt } = NIB_DEFAULTS;
  const min = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  assert.ok(min(followUpAt) > min(digestAt), 'not read as "the next morning"');
  assert.ok(min(NIB_DEFAULTS.wrapAt) < min(digestAt), 'wrap-up before the register');
});

test('a restart does not apply the defaults again, and an administrator\'s changes survive it', async () => {
  const dir = tmp('dexfr-');
  let hub = await boot(dir);
  const c = await owner(hub);
  await c.request('admin.nib.set', { digestAt: '20:00', followUpAt: '08:30', openSheets: true });
  const hr = hub.notices.desks().find((d) => d.name === 'HR')!;
  await c.request('admin.notices.removeDesk', { id: hr.id });
  for (const d of hub.notices.desks()) await c.request('admin.notices.removeDesk', { id: d.id });
  assert.equal(hub.notices.desks().length, 0);
  const flags = Object.values(FIRSTRUN_FLAGS).map((k) => meta(hub, k));
  c.disconnect();
  await stop(hub);

  hub = await boot(dir);
  const nib = hub.nib.config();
  assert.equal(nib.digestAt, '20:00');
  assert.equal(nib.followUpAt, '08:30');
  assert.equal(nib.openSheets, true);
  assert.equal(hub.notices.desks().length, 0, 'desks an administrator removed do not come back');
  assert.deepEqual(Object.values(FIRSTRUN_FLAGS).map((k) => meta(hub, k)), flags, 'the flags are not written again');
  assert.equal(hub.store.auditTrail(1000).filter((a) => a.action === 'setup.defaults').length, 1, 'applied once');
});

test('a hub upgraded from an older version keeps what it had', async () => {
  // people, and Nib never saved: it was working to the old times, and keeps them
  const a = tmp('dexfr-');
  let hub = await boot(a);
  (await owner(hub)).disconnect();
  await stop(hub);
  olderVersion(a, false);
  hub = await boot(a);
  assert.equal(hub.nib.config().digestAt, NIB_LEGACY_TIMES.digestAt);
  assert.equal(hub.nib.config().followUpAt, NIB_LEGACY_TIMES.followUpAt);
  assert.equal(hub.notices.desks().length, 4, 'its desks are as they were');
  await stop(hub);

  // Nib saved by an administrator: untouched
  const b = tmp('dexfr-');
  hub = await boot(b);
  const c = await owner(hub);
  await c.request('admin.nib.set', { digestAt: '19:30', followUpAt: '21:30', workdays: [1, 2, 3, 4, 5] });
  c.disconnect();
  await stop(hub);
  olderVersion(b, true);
  hub = await boot(b);
  assert.equal(hub.nib.config().digestAt, '19:30');
  assert.equal(hub.nib.config().followUpAt, '21:30');
  assert.deepEqual(hub.nib.config().workdays, [1, 2, 3, 4, 5]);
  assert.match(meta(hub, FIRSTRUN_FLAGS.nib)!, /"kept"/);
});

// ---------------------------------------------------------------- the backup disk
const vol = (v: Partial<DiskVolume> & Pick<DiskVolume, 'letter'>): DiskVolume => ({ driveType: 'Fixed', disk: 0, bus: 'SATA', boot: false, free: 500 * GB, size: 1000 * GB, label: '', ...v });
const layout = (...volumes: DiskVolume[]): DiskLayout => ({ system: 'C', volumes });

test('choosing a backup disk: only a fixed disk other than the data\'s, not Windows\', not removable, with room', () => {
  const C = vol({ letter: 'C', boot: true, free: 80 * GB });
  // a second disk: chosen
  const two = chooseBackupDrive(layout(C, vol({ letter: 'D', disk: 0 }), vol({ letter: 'E', disk: 1, label: 'Backup' })), 'D', 5 * GB);
  assert.equal(two.kind, 'pick');
  assert.equal(two.kind === 'pick' && two.volume.letter, 'E');
  // the roomiest of two
  const roomy = chooseBackupDrive(layout(C, vol({ letter: 'D' }), vol({ letter: 'E', disk: 1, free: 50 * GB }), vol({ letter: 'F', disk: 2, free: 900 * GB })), 'D', GB);
  assert.equal(roomy.kind === 'pick' && roomy.volume.letter, 'F');
  // only another part of the same disk
  const same = chooseBackupDrive(layout(C, vol({ letter: 'D', disk: 0 }), vol({ letter: 'E', disk: 0 })), 'D', GB);
  assert.equal(same.kind === 'none' && same.reason, 'same-disk-only');
  // one disk, one drive
  const single = chooseBackupDrive(layout(vol({ letter: 'C', boot: true })), 'C', GB);
  assert.equal(single.kind === 'none' && single.reason, 'single-disk');
  // nothing at all
  assert.equal(chooseBackupDrive(layout(), 'D', GB).kind, 'none');
  // the other disk is the Windows disk: never C:
  const sys = chooseBackupDrive(layout(vol({ letter: 'C', disk: 0, boot: true }), vol({ letter: 'D', disk: 1 })), 'D', GB);
  assert.equal(sys.kind === 'none' && sys.reason, 'system-only');
  // a USB disk that Windows calls fixed, a removable drive, a network drive: never
  const usb = chooseBackupDrive(layout(vol({ letter: 'D' }), vol({ letter: 'E', disk: 1, bus: 'USB' }), vol({ letter: 'F', disk: 2, driveType: 'Removable' }), vol({ letter: 'Z', disk: null, driveType: 'Network' })), 'D', GB);
  assert.equal(usb.kind === 'none' && usb.reason, 'removable-only');
  // too little space: 10 GB at least, and twice the hub's data
  const full = chooseBackupDrive(layout(C, vol({ letter: 'D' }), vol({ letter: 'E', disk: 1, free: 9 * GB })), 'D', GB);
  assert.equal(full.kind === 'none' && full.reason, 'no-space');
  const big = chooseBackupDrive(layout(C, vol({ letter: 'D' }), vol({ letter: 'E', disk: 1, free: 30 * GB })), 'D', 20 * GB);
  assert.equal(big.kind === 'none' && big.reason, 'no-space', '30 GB is not twice 20 GB');
  assert.equal(full.need, BACKUP_MIN_FREE);
  // the data's disk not known (a network path, or Windows did not say): never guess
  assert.equal(chooseBackupDrive(layout(C, vol({ letter: 'E', disk: 1 })), null, GB).kind, 'none');
  assert.equal(chooseBackupDrive(layout(C, vol({ letter: 'D', disk: null }), vol({ letter: 'E', disk: 1 })), 'D', GB).kind, 'none');
});

test('PowerShell\'s answer is read, including a single volume and missing numbers', () => {
  const l = parseDiskLayout('{"system":"C:","volumes":[{"letter":"C","driveType":"Fixed","disk":0,"bus":"NVMe","boot":true,"free":1000,"size":2000,"label":""},{"letter":"E","driveType":"Fixed","disk":1,"bus":"SATA","boot":false,"free":5,"size":9,"label":"Data"}]}')!;
  assert.equal(l.system, 'C');
  assert.deepEqual(l.volumes.map((v) => [v.letter, v.disk, v.bus, v.boot]), [['C', 0, 'NVMe', true], ['E', 1, 'SATA', false]]);
  const one = parseDiskLayout('{"system":"C:","volumes":{"letter":"C","driveType":"Fixed","disk":null,"bus":null,"boot":false,"free":1,"size":2,"label":""}}')!;
  assert.equal(one.volumes.length, 1);
  assert.equal(one.volumes[0].disk, null);
  assert.equal(parseDiskLayout('not json'), null);
  assert.equal(parseDiskLayout(''), null);
});

function pretend(l: DiskLayout | null, dest: string, locked: string[] = []): NonNullable<HubOptions['firstRun']> {
  return {
    detector: async () => l, dataDrive: 'D',
    folderOn: (letter) => path.join(dest, `${letter}-DexConnectBackup`),
    lockDown: async (f) => { locked.push(f); },
  };
}

test('a second disk: the hub chooses it, makes it private, backs up to it and checks the copy', async () => {
  const dest = tmp('dexfr-disk-');
  const locked: string[] = [];
  const hub = await boot(tmp('dexfr-'), { firstRun: pretend(layout(vol({ letter: 'C', boot: true }), vol({ letter: 'D' }), vol({ letter: 'E', disk: 1, label: 'Backup' })), dest, locked) });
  const auto = await hub.firstRunBackup;
  const folder = path.join(dest, 'E-DexConnectBackup');
  assert.equal(auto?.state, 'picked');
  assert.equal(auto?.folder, folder);
  assert.deepEqual(locked, [folder], 'made private before it is used');
  const s = hub.backups.status();
  assert.equal(s.config.folder, folder);
  assert.equal(s.config.time, '02:00');
  assert.deepEqual([s.config.keepDaily, s.config.keepWeekly, s.config.keepMonthly], [14, 8, 12]);
  assert.equal(auto?.first?.ok, true, auto?.first?.error ?? '');
  assert.equal(auto?.first?.verified, true);
  assert.ok(s.lastSuccess && s.lastSuccess.check?.integrity === 'ok', 'the first backup ran and was checked');
  assert.equal(s.auto?.state, 'picked');
  assert.ok(hub.store.auditTrail().some((a) => a.action === 'backup.settings' && (a.detail as { auto?: boolean }).auto === true));

  // the setup check shows it passing
  const c = await owner(hub);
  const r = await c.request('admin.setup.report');
  const byId = new Map(r.checks.map((x) => [x.id, x] as const));
  assert.equal(byId.get('backup.folder')?.state, 'pass');
  assert.equal(byId.get('backup.schedule')?.state, 'pass');
  assert.equal(byId.get('backup.last')?.state, 'pass');
  assert.match(byId.get('backup.last')!.detail, /checked: database sound/);
  c.disconnect();
});

for (const [name, l, reason, state] of [
  ['only another part of the same disk', layout(vol({ letter: 'C', boot: true }), vol({ letter: 'D' })), /C:, D: are parts of the same physical disk/, 'needs-disk'],
  ['one disk', layout(vol({ letter: 'D' })), /only one disk/, 'needs-disk'],
  ['no disks found', layout(), /could not tell which disk/, 'unsupported'],
] as const) {
  test(`${name}: no folder is chosen, and the Control room says to add a second disk or a share`, async () => {
    const dest = tmp('dexfr-disk-');
    const dir = tmp('dexfr-');
    let hub = await boot(dir, { firstRun: pretend(l, dest) });
    const auto = await hub.firstRunBackup;
    assert.equal(auto?.state, state);
    assert.match(auto!.message, reason);
    assert.match(auto!.action!, /second internal disk .* network share/);
    assert.equal(hub.backups.config().folder, null, 'never an unsafe destination');
    assert.deepEqual(fs.readdirSync(dest), [], 'nothing was made');
    assert.equal(hub.backups.status().auto?.state, state);
    const c = await owner(hub);
    const r = await c.request('admin.setup.report');
    const folder = r.checks.find((x) => x.id === 'backup.folder')!;
    assert.equal(folder.state, 'action');
    assert.match(folder.fix!, /Backups & leavers/);
    c.disconnect();
    await stop(hub);

    // a second disk is added later: the next start finds it
    hub = await boot(dir, { firstRun: { ...pretend(layout(vol({ letter: 'C', boot: true }), vol({ letter: 'D' }), vol({ letter: 'E', disk: 1 })), dest), firstBackup: false } });
    assert.equal((await hub.firstRunBackup)?.state, 'picked');
  });
}

test('the hub cannot look at the disks (not Windows): nothing chosen, and it says so', async () => {
  const hub = await boot(tmp('dexfr-'), { firstRun: pretend(null, tmp('dexfr-disk-')) });
  const auto = await hub.firstRunBackup;
  assert.equal(auto?.state, 'unsupported');
  assert.equal(hub.backups.config().folder, null);
});

test('a folder that cannot be made private is not used', async () => {
  const hub = await boot(tmp('dexfr-'), { firstRun: { ...pretend(layout(vol({ letter: 'D' }), vol({ letter: 'E', disk: 1 })), tmp('dexfr-disk-')), lockDown: async () => { throw new Error('Access is denied.'); } } });
  const auto = await hub.firstRunBackup;
  assert.equal(auto?.state, 'failed');
  assert.match(auto!.message, /could not make .* private/);
  assert.equal(hub.backups.config().folder, null);
});

test('an administrator\'s backup folder is never replaced, and a picked one is not picked again', async () => {
  const dir = tmp('dexfr-');
  const mine = tmp('dexfr-mine-');
  let hub = await boot(dir);
  const c = await owner(hub);
  await c.request('admin.backup.set', { folder: mine });
  c.disconnect();
  await stop(hub);
  let asked = 0;
  const second = layout(vol({ letter: 'D' }), vol({ letter: 'E', disk: 1 }));
  hub = await boot(dir, { firstRun: { ...pretend(second, tmp('dexfr-disk-')), detector: async () => { asked++; return second; } } });
  assert.equal(await hub.firstRunBackup, null);
  assert.equal(asked, 0, 'the disks are not even looked at');
  assert.equal(hub.backups.config().folder, path.resolve(mine));

  // turned off by an administrator: stays off
  const off = tmp('dexfr-');
  hub = await boot(off);
  const o = await owner(hub);
  await o.request('admin.backup.set', { folder: null });
  o.disconnect();
  await stop(hub);
  hub = await boot(off, { firstRun: pretend(second, tmp('dexfr-disk-')) });
  assert.equal(await hub.firstRunBackup, null);
  assert.equal(hub.backups.config().folder, null);
  await stop(hub);

  // picked once: a restart does not look again
  const p = tmp('dexfr-');
  hub = await boot(p, { firstRun: { ...pretend(second, tmp('dexfr-disk-')), firstBackup: false } });
  assert.equal((await hub.firstRunBackup)?.state, 'picked');
  await stop(hub);
  asked = 0;
  hub = await boot(p, { firstRun: { ...pretend(second, tmp('dexfr-disk-')), detector: async () => { asked++; return second; } } });
  assert.equal(await hub.firstRunBackup, null);
  assert.equal(asked, 0);
});

// ---------------------------------------------------------------- the setup check
test('the setup report: every area, manual checks never passed, administrators only, as text', async () => {
  const hub = await boot(tmp('dexfr-'), { firstRun: pretend(layout(vol({ letter: 'D' })), tmp('dexfr-disk-')) });
  await hub.firstRunBackup;
  const c = await owner(hub);
  const r: SetupReport = await c.request('admin.setup.report');
  const ids = r.checks.map((x) => x.id);
  for (const id of ['hub.service', 'db.integrity', 'db.schema', 'storage.free', 'backup.folder', 'backup.schedule', 'backup.last', 'seating.plan', 'notices.desks', 'nib.times', 'nib.private', 'nib.register', 'audit.log', 'remote.access', 'calls.relay']) {
    assert.ok(ids.includes(id), `${id} is checked`);
  }
  const by = new Map(r.checks.map((x) => [x.id, x] as const));
  assert.equal(by.get('hub.service')!.state, 'pass');
  assert.match(by.get('hub.service')!.detail, /Running for/);
  assert.equal(by.get('db.integrity')!.state, 'pass');
  assert.equal(by.get('db.schema')!.state, 'pass');
  assert.equal(by.get('notices.desks')!.state, 'pass');
  assert.equal(by.get('nib.times')!.state, 'pass');
  assert.match(by.get('nib.times')!.detail, /register 18:30, follow-up 19:00;/);
  assert.equal(by.get('nib.private')!.state, 'pass');
  assert.equal(by.get('nib.register')!.state, 'action', 'nobody chosen to receive the register');
  assert.equal(by.get('audit.log')!.state, 'pass');
  assert.equal(by.get('seating.plan')!.state === 'fail', false);
  assert.equal(by.get('remote.access')!.state, 'action');
  assert.match(by.get('remote.access')!.fix!, /Outside the office/);
  const manual = r.checks.filter((x) => x.id.startsWith('manual.'));
  assert.ok(manual.length >= 3);
  assert.ok(manual.every((x) => x.state === 'manual' && x.fix), 'a person checks these, and is told how');
  assert.ok(r.checks.every((x) => x.state === 'pass' || x.state === 'info' || x.fix), 'everything to do says what to do');
  assert.equal(by.get('backup.schedule')!.state, 'info', 'one thing to do for backups: the folder');
  assert.equal(r.summary.pass + r.summary.fail + r.summary.action + r.summary.manual + r.summary.info, r.checks.length);

  const text = setupReportText(r);
  assert.match(text, /SETUP CHECK/);
  assert.match(text, /\[BY HAND\] By hand: A call between two PCs works/);
  assert.match(text, /\[ACTION\] Backups: Backups need a second disk or a network share/);

  // members may not read it
  const m = new HubClient({ identity: createIdentity(), account: { username: 'priya', domain: 'DEX', displayName: 'Priya', hostname: 'priya-pc' } });
  m.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
  await until(m, (s) => s.kind === 'pending');
  const id = (await c.request('admin.devices')).find((d) => d.status === 'pending')!.id;
  await c.request('admin.decide', { deviceId: id, approve: true });
  await until(m, (s) => s.kind === 'ready');
  await assert.rejects(m.request('admin.setup.report'), /administrators/);
  m.disconnect();
  c.disconnect();
});

test('other parts of the hub add their checks; a broken or slow one is shown as failed without hiding the rest', async () => {
  const h = new HealthChecks();
  h.register('zoho', () => ({ id: 'zoho.calendar', area: 'Zoho Calendar', title: 'Connected', state: 'pass', detail: 'ok', fix: null }));
  h.register('broken', () => { throw new Error('no answer'); });
  const remove = h.register('later', async () => [{ id: 'later.a', area: 'Later', title: 'A', state: 'info', detail: '', fix: null }]);
  const r = await h.report({ id: 'x', name: 'Hub', version: '1', startedAt: Date.now(), uptimeSec: 0 });
  assert.deepEqual(r.checks.map((x) => [x.id, x.state]), [['zoho.calendar', 'pass'], ['broken', 'fail'], ['later.a', 'info']]);
  assert.match(r.checks[1].detail, /no answer/);
  remove();
  assert.deepEqual(h.ids(), ['zoho', 'broken']);

  // and on a running hub
  const hub = await boot(tmp('dexfr-'));
  hub.health.register('zoho', () => ({ id: 'zoho.calendar', area: 'Zoho Calendar', title: 'Connected', state: 'pass', detail: 'ok', fix: null }));
  const c = await owner(hub);
  assert.ok((await c.request('admin.setup.report')).checks.some((x) => x.id === 'zoho.calendar'));
  c.disconnect();
});
