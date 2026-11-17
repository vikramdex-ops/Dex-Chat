// Handing the office over keeps every setting: they belong to the office, not to the person who
// typed them. The first owner configures, makes others owner and administrator, steps down and
// leaves; the new owner and administrator find everything as it was, without entering anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanups, me, office } from './office.ts';

test.after(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

test('handing over: the gateway, meeting site, call keys, backups, policies, Nib and holidays stay as configured', async () => {
  const { owner, priya, ravi } = await office();
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexhandover-'));
  cleanups.push(() => fs.rmSync(backupDir, { recursive: true, force: true }));

  // the first owner sets the office up
  await owner.request('admin.remote.set', { url: 'https://dexconnect-gateway.example.workers.dev', enabled: true, allowAdmin: true, siteUrl: 'https://meet.dexteritydesign.co.in', orgName: 'Dexterity Design Services' });
  await owner.request('admin.ice.set', { mode: 'cloudflare', keyId: '0123456789abcdef0123456789abcdef', token: 'turn-secret-token-4567890abcdef' });
  await owner.request('admin.backup.set', { folder: backupDir, time: '01:30', keepDaily: 10 });
  await owner.request('admin.policy.set', { maxUploadMb: 250, editWindowMinutes: 30 });
  await owner.request('admin.nib.set', { managers: [me(priya)], digestAt: '19:30' });
  await owner.request('admin.botjob.holidays', { holidays: [{ date: '2026-12-25', name: 'Christmas' }] });
  const before = {
    remote: (await owner.request('admin.remote.get')).config,
    site: await owner.request('remote.info'),
    ice: await owner.request('admin.ice.get'),
    backup: (await owner.request('admin.backup.get')).config,
    policy: await owner.request('policy.get'),
    nib: await owner.request('admin.nib.get'),
    holidays: (await owner.request('botjob.calendar')).holidays,
  };

  // hand over: Priya (management) becomes an owner, Ravi (IT) an administrator; the first owner steps down and leaves
  await owner.request('admin.setRole', { userId: me(priya), role: 'owner' });
  await owner.request('admin.setRole', { userId: me(ravi), role: 'admin' });
  await owner.request('admin.setRole', { userId: me(owner), role: 'admin' });
  await priya.request('admin.offboard.run', { userId: me(owner), toUserId: me(ravi), meetings: 'reassign' });

  // the new owner and the administrator see exactly the same office, with nothing re-entered
  for (const who of [priya, ravi]) {
    assert.deepEqual((await who.request('admin.remote.get')).config, before.remote, 'the gateway');
    const site = await who.request('remote.info');
    assert.equal(site.site, before.site.site, 'the meeting site address');
    assert.deepEqual(await who.request('admin.ice.get'), before.ice, 'the call keys (the secret stays on the hub)');
    assert.deepEqual((await who.request('admin.backup.get')).config, before.backup, 'the backups');
    assert.deepEqual(await who.request('policy.get'), before.policy, 'the policies');
    assert.deepEqual(await who.request('admin.nib.get'), before.nib, 'Nib and the day sheets');
    assert.deepEqual((await who.request('botjob.calendar')).holidays, before.holidays, 'the holidays');
  }
  assert.equal(before.ice.hasToken, true);
  assert.equal(before.remote.url, 'https://dexconnect-gateway.example.workers.dev');
  // and they can go on changing them
  assert.equal((await ravi.request('admin.policy.set', { maxUploadMb: 300 })).maxUploadMb, 300);
});
