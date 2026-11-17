// The setup check at the top of the Control room, and the backup folder the hub chooses on its first
// start. The hub is given a pretend disk detector (the real one asks PowerShell on Windows): first a
// PC with one disk, so no folder is chosen and the Control room says to add a second disk or a
// network share; then a second disk appears, the hub chooses it, backs up and checks the copy, and
// the sheet turns to passes. Manual checks are listed "by hand", never passed. Copy report gives
// the text. Screenshots at 1440 and 390 px, light and dark, and in Hindi, in SETUPCHECK_OUT
// (default e2e/out).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startOffice, launch, sleep, OUT as BASE_OUT } from './harness.mts';
import { autoBackup } from '../../../apps/hub/src/firstrun.ts';
import type { DiskLayout, DiskVolume } from '../../../apps/hub/src/firstrun.ts';

const OUT = process.env.SETUPCHECK_OUT ?? BASE_OUT;
fs.mkdirSync(OUT, { recursive: true });
const snap = (page: any, name: string) => page.screenshot({ path: path.join(OUT, `setupcheck-${name}.png`) });
async function themes(page: any, name: string) {
  for (const t of ['light', 'dark']) {
    await page.evaluate((x: string) => { document.documentElement.dataset.theme = x; }, t);
    await sleep(250);
    await snap(page, `${name}-${t}`);
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}

const GB = 1024 ** 3;
const vol = (v: Partial<DiskVolume> & Pick<DiskVolume, 'letter'>): DiskVolume => ({ driveType: 'Fixed', disk: 0, bus: 'SATA', boot: false, free: 400 * GB, size: 930 * GB, label: '', ...v });
const oneDisk: DiskLayout = { system: 'C', volumes: [vol({ letter: 'C', boot: true, label: 'Windows', free: 120 * GB, size: 240 * GB }), vol({ letter: 'D', label: 'Data' })] };
const twoDisks: DiskLayout = { system: 'C', volumes: [...oneDisk.volumes, vol({ letter: 'E', disk: 1, label: 'Backup', free: 1700 * GB, size: 1860 * GB })] };
const disks = fs.mkdtempSync(path.join(BASE_OUT, 'setupcheck-disk-'));
const pretend = (l: DiskLayout) => ({ detector: async () => l, dataDrive: 'D', folderOn: (letter: string) => path.join(disks, `${letter}-DexConnectBackup`), lockDown: async () => {} });

const { owner, hub } = await startOffice('setupcheck', { firstRun: pretend(oneDisk) });
const first = await hub.firstRunBackup;
assert.equal(first?.state, 'needs-disk', 'one disk: the hub does not choose a folder');
const { app, page } = await launch('priya', 'Priya Raman', { width: 1440, height: 900 });
try {
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  await owner.request('admin.setRole', { userId: priya.id, role: 'admin' });
  await page.reload(); await page.locator('.frame').waitFor();
  await page.locator('.me-btn').click();
  await page.getByRole('menuitem', { name: /Control room/ }).click();

  // the sheet sits above the sections, with what needs doing
  const sheet = page.locator('.sc-sheet');
  await sheet.locator('.sc-block').waitFor({ timeout: 20000 });
  assert.ok(await page.locator('.sc-sheet + .toolbar .seg-register').count(), 'the sections follow the sheet, unchanged');
  await sheet.locator('.sc-state', { hasText: /things? needs? doing/ }).waitFor();
  const backupRow = sheet.locator('[data-check="backup.folder"]');
  await backupRow.waitFor();
  assert.match(await backupRow.innerText(), /Backups need a second disk or a network share/);
  assert.match(await backupRow.innerText(), /C:, D: are parts of the same physical disk/);
  assert.equal((await backupRow.locator('.sc-stamp').innerText()).trim().toLowerCase(), 'to do');
  assert.equal(await sheet.locator('[data-check="db.integrity"]').count(), 0, 'passes are folded away');
  assert.equal(await sheet.locator('[data-check^="manual."]').count(), 0);
  await themes(page, '01-1440-needs');

  // everything, with the checks a person makes listed by hand
  const toggle = sheet.locator('.sc-toggle');
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  await sheet.locator('[data-check="db.integrity"] .sc-stamp', { hasText: /pass/i }).waitFor();
  for (const id of ['hub.service', 'db.schema', 'storage.free', 'notices.desks', 'nib.times', 'nib.private', 'audit.log', 'seating.plan', 'remote.access', 'calls.relay']) {
    assert.equal(await sheet.locator(`[data-check="${id}"]`).count(), 1, `${id} is shown`);
  }
  const manual = sheet.locator('[data-check^="manual."]');
  assert.ok(await manual.count() >= 3);
  for (const s of await manual.locator('.sc-stamp').allInnerTexts()) assert.equal(s.trim().toLowerCase(), 'by hand', 'never shown as passed');
  assert.match(await sheet.locator('[data-check="nib.times"]').innerText(), /register 18:30, follow-up 19:00/);
  assert.match(await sheet.locator('[data-check="hub.service"]').innerText(), /Running for/);
  await themes(page, '02-1440-all');

  // Copy report: the text the owner keeps
  await sheet.getByRole('button', { name: 'Copy report' }).click();
  await page.getByText('Setup report copied').first().waitFor();
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  assert.match(copied, /DEXTERITY CONNECT · SETUP CHECK/);
  assert.match(copied, /\[ACTION\] Backups: Backups need a second disk or a network share/);
  assert.match(copied, /\[BY HAND\] By hand: A phone on mobile data can send a message/);

  // Backups & leavers says the same, prominently
  await page.getByRole('button', { name: /^Backups & leavers/ }).click();
  const auto = page.locator('.bk-auto');
  await auto.waitFor();
  assert.match(await auto.innerText(), /Backups need a second disk or a network share/);
  assert.match(await auto.innerText(), /Add a second internal disk/);
  await toggle.click();
  await page.evaluate(() => document.querySelector('.bk-auto')?.scrollIntoView({ block: 'center' }));
  await themes(page, '03-1440-backups-needs');

  // a phone-width screen
  await page.setViewportSize({ width: 390, height: 844 }); await sleep(500);
  await page.evaluate(() => document.querySelector('.sc-sheet')?.scrollIntoView({ block: 'start' }));
  await themes(page, '04-390-needs');
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1 || [...document.querySelectorAll('.sc-sheet *')].some((e) => (e as HTMLElement).getBoundingClientRect().right > window.innerWidth + 1));
  assert.equal(wide, false, 'nothing runs off a phone-width screen');

  // a second disk is added: the hub (on its next start, here at once) chooses it, backs up and checks the copy
  const picked = await autoBackup((hub as any).firstRunHost(), pretend(twoDisks));
  assert.equal(picked?.state, 'picked');
  assert.equal(picked?.first?.verified, true, picked?.first?.error ?? '');
  await page.setViewportSize({ width: 1440, height: 900 }); await sleep(300);
  await sheet.getByRole('button', { name: 'Check again' }).click();
  await sheet.locator('.sc-state', { hasText: /need/ }).waitFor();
  await toggle.click();
  await sheet.locator('[data-check="backup.folder"] .sc-stamp', { hasText: /pass/i }).waitFor();
  await sheet.locator('[data-check="backup.last"] .sc-stamp', { hasText: /pass/i }).waitFor();
  assert.match(await sheet.locator('[data-check="backup.last"]').innerText(), /checked: database sound/);
  await page.locator('.bk-auto.picked').waitFor();
  assert.match(await page.locator('.bk-auto.picked').innerText(), /Chosen by the hub on its first start/);
  assert.equal(await page.locator('#bk-folder').inputValue(), picked!.folder, 'the folder box follows what the hub chose');
  await page.evaluate(() => document.querySelector('.sc-sheet')?.scrollIntoView({ block: 'start' }));
  await themes(page, '05-1440-picked');
  await page.evaluate(() => document.querySelector('.bk-auto')?.scrollIntoView({ block: 'center' }));
  await snap(page, '06-1440-backups-picked-light');

  // the Nib register and outside access are what is left; Nib's register is chosen in Control room
  const report = await owner.request('admin.setup.report');
  assert.ok(!report.checks.some((c: any) => c.state === 'fail'), JSON.stringify(report.checks.filter((c: any) => c.state === 'fail')));

  // in Hindi
  await page.evaluate(() => localStorage.setItem('dex.language', 'hi'));
  await page.reload(); await page.locator('.frame').waitFor(); await sleep(600);
  await page.locator('.me-btn').click();
  await page.getByRole('menuitem', { name: /कंट्रोल रूम/ }).click();
  await page.locator('.sc-sheet .sc-block').waitFor();
  assert.match(await page.locator('.sc-sheet .eyebrow').first().innerText(), /सेटअप जाँच/);
  await snap(page, '07-1440-hindi-light');
  await page.setViewportSize({ width: 390, height: 844 }); await sleep(500);
  await snap(page, '08-390-hindi-light');
  await page.evaluate(() => localStorage.setItem('dex.language', 'en'));
  console.log('SETUPCHECK E2E PASSED');
} catch (e) {
  await snap(page, 'FAIL').catch(() => {});
  throw e;
} finally {
  await app.close();
  owner.disconnect();
  await hub.stop();
  fs.rmSync(disks, { recursive: true, force: true });
}
process.exit(0);
