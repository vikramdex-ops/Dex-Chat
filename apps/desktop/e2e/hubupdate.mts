// The hub updating itself (apps/hub/src/hub-update.ts), seen from Control room ▸ Backups & leavers ▸
// Hub updates. A stand-in release feed offers 0.1.42 to a hub on 0.1.40, and a stand-in launcher takes
// the place of running the setup. An administrator finds the new version, sees when it installs,
// clicks Update now while a call is going on (it waits, with "Update now anyway"), the call ends and
// the setup starts; then an update that went back is shown with its setup log and Try again, and
// the setup check has the hub's line. Screenshots at 1440 and 390 px, light and dark, and in Hindi,
// in HUBUPDATE_OUT (default e2e/out).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { startOffice, launch, sleep, OUT as BASE_OUT } from './harness.mts';
import type { LaunchPlan } from '../../../apps/hub/src/hub-update.ts';

const OUT = process.env.HUBUPDATE_OUT ?? BASE_OUT;
fs.mkdirSync(OUT, { recursive: true });
const snap = (page: any, name: string) => page.screenshot({ path: path.join(OUT, `hubupdate-${name}.png`) });
async function themes(page: any, name: string) {
  await page.evaluate(() => document.querySelector('.hu-sheet')?.scrollIntoView({ block: 'start' }));
  for (const t of ['light', 'dark']) {
    await page.evaluate((x: string) => { document.documentElement.dataset.theme = x; }, t);
    await sleep(250);
    await snap(page, `${name}-${t}`);
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}

// the release feed, with a hub setup for 0.1.42
const exe = Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(300_000)]);
const file = 'DexterityConnectHub-Setup-0.1.42.exe';
const server = http.createServer((req, res) => {
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  if (req.url === '/stable.json') {
    res.end(JSON.stringify({
      schema: 1, channel: 'stable', version: '0.1.42', releasedAt: new Date().toISOString(), notes: 'Hub 0.1.42',
      assets: [{ platform: 'hub-win-x64', file, url: `${base}/${file}`, size: exe.length, sha512: crypto.createHash('sha512').update(exe).digest('base64') }],
    }));
    return;
  }
  if (req.url === `/${file}`) { res.end(exe); return; }
  res.writeHead(404); res.end();
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const feedBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const launched: LaunchPlan[] = [];

const { owner, hub } = await startOffice('hubupdate', {
  hubUpdate: { feedUrls: { stable: `${feedBase}/stable.json`, beta: `${feedBase}/beta.json` }, allowHttp: true, unsupported: null, version: '0.1.40', firstCheckDelayMs: 1e9, launcher: async (p) => { launched.push(p); } },
});
const u = hub.hubUpdate!;
const step = async () => { u.tick(); await u.idle(); };
const { app, page } = await launch('priya', 'Priya Raman', { width: 1440, height: 900 });
try {
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((x: any) => x.account.endsWith('priya'))!;
  await owner.request('admin.setRole', { userId: priya.id, role: 'admin' });
  await page.reload(); await page.locator('.frame').waitFor();
  await page.locator('.me-btn').click();
  await page.getByRole('menuitem', { name: /Control room/ }).click();
  await page.getByRole('button', { name: /^Backups & leavers/ }).click();
  await page.getByRole('button', { name: /^Hub updates/ }).click();

  // up to date until someone looks; Look now finds 0.1.42, downloads and checks it
  const sheet = page.locator('.hu-sheet');
  await sheet.waitFor();
  assert.match(await sheet.locator('.bk-state').innerText(), /up to date/);
  assert.match(await sheet.locator('.bk-block').innerText(), /0\.1\.40/);
  await sheet.getByRole('button', { name: 'Look now' }).click();
  await sheet.locator('.bk-state', { hasText: /0\.1\.42 is (on its way|ready to install)/ }).waitFor();
  await step();
  await sheet.locator('.bk-state', { hasText: '0.1.42 is ready to install' }).waitFor();
  const next = await sheet.locator('.bk-cell', { hasText: 'Next update' }).innerText();
  assert.match(next, /(Tonight|Today|Tomorrow) at 3:00|at 03:00/i, next);
  assert.ok(await page.locator('.setting', { hasText: 'Install new versions by themselves' }).count());
  await themes(page, '01-1440-ready');

  // Update now while a call is going on in the office: it waits, and says why
  const space = await owner.request('conv.create', { kind: 'space', name: 'Line list review', members: [priya.id] });
  const call = await owner.request('room.start', { convId: space.id, video: false });
  await sheet.getByRole('button', { name: 'Update now' }).click();
  await page.getByRole('dialog', { name: /Update the hub to 0\.1\.42 now/ }).getByRole('button', { name: 'Update now' }).click();
  await step();
  await sheet.locator('.bk-problem', { hasText: /is live|is going on/ }).waitFor();
  assert.ok(await sheet.getByRole('button', { name: 'Update now anyway' }).count(), 'forcing is offered');
  assert.equal(launched.length, 0);
  await themes(page, '02-1440-waiting-for-meeting');

  // the call ends: the setup starts (here the stand-in launcher), and the sheet says so
  await owner.request('room.leave', { roomId: call.id });
  await step();
  assert.equal(launched.length, 1);
  assert.deepEqual(launched[0].args, ['/S', '/SELFUPDATE', '/NOPOWER']);
  await sheet.locator('.bk-state', { hasText: 'Installing 0.1.42' }).waitFor();
  await page.evaluate(() => document.querySelector('.hu-sheet')?.scrollIntoView({ block: 'start' }));
  await sleep(400);
  await snap(page, '03-1440-installing-light');

  // the setup reports that 0.1.42 did not answer and it went back: shown with its log and Try again
  fs.writeFileSync(launched[0].result, JSON.stringify({ mode: 'install', code: 3, version: '0.1.42', previous: '0.1.40', message: 'The update to 0.1.42 did not work, so the hub went back to 0.1.40 and is running. What went wrong: The hub service did not start.', log: 'C:\\ProgramData\\Dexterity Connect Hub\\setup.log', at: new Date().toISOString() }));
  await step();
  const failed = sheet.locator('.hu-failed');
  await failed.waitFor();
  assert.match(await failed.innerText(), /went back to 0\.1\.40/);
  assert.match(await failed.innerText(), /does not try 0\.1\.42 again by itself/);
  assert.match(await failed.innerText(), /setup\.log/);
  await page.locator('.bk-run', { hasText: 'Went back' }).waitFor();
  await themes(page, '04-1440-went-back');

  // the setup check has the same, as something to do
  const sc = page.locator('.sc-sheet');
  await sc.getByRole('button', { name: 'Check again' }).click();
  const row = sc.locator('[data-check="hub.update"]');
  await row.waitFor();
  assert.match(await row.innerText(), /The last hub update did not work/);
  await page.evaluate(() => document.querySelector('[data-check="hub.update"]')?.scrollIntoView({ block: 'center' }));
  await snap(page, '05-1440-setupcheck-light');

  // a phone-width screen
  await page.setViewportSize({ width: 390, height: 844 }); await sleep(500);
  await themes(page, '06-390-went-back');
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1 || [...document.querySelectorAll('.hu-sheet *, .continuity .card *')].some((e) => (e as HTMLElement).getBoundingClientRect().right > window.innerWidth + 1));
  assert.equal(wide, false, 'nothing runs off a phone-width screen');
  await page.evaluate(() => document.querySelector('.setting .hu-channel')?.scrollIntoView({ block: 'center' }));
  await snap(page, '07-390-settings-light');

  // Try again, and turning automatic updates off
  await page.setViewportSize({ width: 1440, height: 900 }); await sleep(300);
  await failed.getByRole('button', { name: 'Try again' }).click();
  await page.getByText('0.1.42 is tried again at the next quiet time').first().waitFor();
  await failed.waitFor({ state: 'detached' });
  const auto = page.getByRole('switch', { name: 'Install new hub versions by themselves' });
  assert.equal(await auto.getAttribute('aria-checked'), 'true');
  await auto.click();
  await page.getByText('The hub no longer updates itself').first().waitFor();
  assert.equal(await auto.getAttribute('aria-checked'), 'false');
  assert.equal(u.config().auto, false);
  await sheet.locator('.bk-cell', { hasText: 'When you click Update now' }).waitFor();
  const audit = await owner.request('admin.audit', { limit: 30 });
  for (const a of ['hub.update.requested', 'hub.update.started', 'hub.update.failed', 'hub.update.retry', 'hub.update.settings']) assert.ok(audit.some((x: any) => x.action === a), a);

  // in Hindi
  await page.evaluate(() => localStorage.setItem('dex.language', 'hi'));
  await page.reload(); await page.locator('.frame').waitFor(); await sleep(600);
  await page.locator('.me-btn').click();
  await page.getByRole('menuitem', { name: /कंट्रोल रूम/ }).click();
  await page.getByRole('button', { name: /^बैकअप और छोड़कर गए लोग/ }).click();
  await page.getByRole('button', { name: /^हब अपडेट/ }).click();
  await page.locator('.hu-sheet').waitFor();
  assert.match(await page.locator('.hu-sheet .eyebrow').first().innerText(), /हब अपडेट/);
  await snap(page, '08-1440-hindi-light');
  await page.evaluate(() => localStorage.setItem('dex.language', 'en'));
  console.log('HUBUPDATE E2E PASSED');
} catch (e) {
  await snap(page, 'FAIL').catch(() => {});
  throw e;
} finally {
  await app.close();
  owner.disconnect();
  await hub.stop();
  server.close();
}
process.exit(0);
