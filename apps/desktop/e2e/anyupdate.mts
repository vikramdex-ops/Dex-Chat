// Updates on any network. The office hub's mirror holds a new build; GitHub and its second mirror
// cannot be reached (as on some Indian mobile networks). A phone on mobile data and a laptop at
// home, both connected only through the internet gateway (run locally with Wrangler), find the
// build and download it from the hub through the gateway's encrypted channel.
// - phone (apps/mobile in Chromium with the stand-in native layer, phonemock.mts): with the gateway
//   off, "Check for updates" says what it tried and offers the download page; with it on, the
//   update is found and downloaded through the gateway, verified, and handed to the installer;
// - desktop (Electron, development updater against unreachable feeds): found and downloaded from
//   the hub through the gateway, ready to install.
// Screenshots: out/anyupdate-*.png (390 px light, dark and Hindi; 1440 px).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import pw from 'playwright-core';
import { setupCode } from '../../../packages/core/src/remote.ts';
import { startOffice, launch, shot, sleep, both } from './harness.mts';
import { installPhoneMock, servePhoneApp } from './phonemock.mts';
import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
if (fs.existsSync('/opt/pw-browsers')) process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/pw-browsers';

const free = async () => { const s = net.createServer(); await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r())); const p = (s.address() as net.AddressInfo).port; await new Promise<void>((r) => s.close(() => r())); return p; };
const until = async (what: string, fn: () => Promise<boolean>, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(200); } throw new Error(`timed out: ${what}`); };

// the gateway Worker in Cloudflare's local runtime
const gwPort = await free();
const gw = spawn(path.join(ROOT, 'node_modules', '.bin', 'wrangler'), ['dev', '--ip', '127.0.0.1', '--port', String(gwPort), '--show-interactive-dev-session=false'], { cwd: path.join(ROOT, 'apps/gateway'), detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise<void>((res, rej) => { const t = setTimeout(() => rej(new Error('wrangler did not start')), 60000); const on = (b: Buffer) => { if (/Ready on/.test(b.toString())) { clearTimeout(t); res(); } }; gw.stdout!.on('data', on); gw.stderr!.on('data', on); });
gw.stdout!.resume(); gw.stderr!.resume();
const gwUrl = `http://127.0.0.1:${gwPort}`;

// the hub, with a mirrored build on it (its own refresh from GitHub never runs here)
const { hub, owner, dir } = await startOffice('anyupdate', { updates: { firstCheckDelayMs: 3_600_000 }, discoveryPort: false });
const VERSION = '0.1.120';
const apk = crypto.randomBytes(1_300_000); // several of the phone's 512 KB writes
const exe = crypto.randomBytes(900_000);
const sha = (b: Buffer) => crypto.createHash('sha512').update(b).digest('base64');
const files = path.join(dir, 'updates', 'files', VERSION);
fs.mkdirSync(files, { recursive: true });
fs.writeFileSync(path.join(files, `DexterityConnect-${VERSION}.apk`), apk);
fs.writeFileSync(path.join(files, `DexterityConnect-Setup-${VERSION}.exe`), exe);
const gh = `https://github.com/dexterity-admin/dexterity-connect/releases/download/v${VERSION}`;
fs.writeFileSync(path.join(dir, 'updates', 'stable.json'), JSON.stringify({
  schema: 1, channel: 'stable', version: VERSION, releasedAt: new Date().toISOString(), notes: '- Updates arrive on any network, through the office',
  assets: [
    { platform: 'android', file: `DexterityConnect-${VERSION}.apk`, url: `${gh}/DexterityConnect-${VERSION}.apk`, size: apk.length, sha512: sha(apk) },
    { platform: 'win-x64', file: `DexterityConnect-Setup-${VERSION}.exe`, url: `${gh}/DexterityConnect-Setup-${VERSION}.exe`, size: exe.length, sha512: sha(exe) },
  ],
}));
await owner.request('admin.remote.set', { url: gwUrl, enabled: true });
for (let i = 0; i < 50 && !(await owner.request('admin.remote.get')).status.connected; i++) await sleep(100);
const code = setupCode({ url: gwUrl, hubId: hub.info.id, fp: hub.fingerprint, name: 'Dexterity Office' });

const site = await servePhoneApp();
const browser = await pw.chromium.launch({ args: ['--ignore-certificate-errors', '--disable-web-security'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true, bypassCSP: true, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[phone pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error' || /\[update\]/.test(m.text())) console.log('[phone]', m.text()); });
await installPhoneMock(page, { fp: hub.fingerprint, appVersion: '0.1.108', network: 'cellular', blockInternet: true });
const desk = await launch('asha', 'Asha Menon', { width: 1440, height: 900, noJoin: true, env: {
  DEXCONNECT_UPDATER_DEV: '1', DEXCONNECT_UPDATER_PLATFORM: 'win-x64',
  // GitHub and the second mirror do not answer from this laptop's network
  DEXCONNECT_FEED_BASE: `http://127.0.0.1:${await free()}`, DEXCONNECT_MIRROR_BASE: `http://127.0.0.1:${await free()}`,
} });
const prefs = async () => {
  await page.locator('.me-btn').click();
  await page.getByRole('menuitem', { name: /Preferences/ }).click();
  await updateRow(page).scrollIntoViewIfNeeded();
};
/** Preferences ▸ the app's version and updates row. */
const updateRow = (p: typeof page) => p.locator('.setting', { hasText: /Dexterity Connect 0\.1\./ }).first();
try {
  // ---- the phone, on mobile data: joins with a setup code (the gateway only)
  await page.goto(site.url);
  await page.waitForFunction(() => !!(window as any).dex, null, { timeout: 30000 });
  // found by the automatic check on connecting, but kept for "Download" (so the failed check below shows)
  await page.evaluate(() => window.dex.setSettings({ autoDownloadUpdates: false }));
  await page.evaluate((c) => window.dex.join({ setupCode: c, displayName: 'Ravi Kumar', officeAccount: 'DEX\\ravi' }), code);
  await page.locator('.frame').waitFor({ timeout: 30000 });
  assert.equal((await page.evaluate(() => window.dex.getState())).via, 'remote');
  const dismiss = page.getByRole('button', { name: 'Not now' });
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click();

  // the gateway is off: nothing answers; the app says what it tried and what to do
  await owner.request('admin.remote.set', { enabled: false });
  await until('the phone notices the hub is gone', async () => (await page.evaluate(() => window.dex.getState())).phase !== 'ready', 15000);
  await page.evaluate(() => window.dex.checkForUpdates());
  const u0 = (await page.evaluate(() => window.dex.getState())).update;
  assert.equal(u0.phase, 'error');
  assert.deepEqual(u0.checked, [{ source: 'internet', ok: false }, { source: 'mirror', ok: false }]);
  const asked = await page.evaluate(() => (window as any).__F.requests as string[]);
  assert.ok(asked.some((u) => u.startsWith('https://raw.githubusercontent.com/')) && asked.some((u) => u.startsWith('https://cdn.jsdelivr.net/gh/')), `both internet feeds asked natively: ${asked.join(' ')}`);
  await prefs();
  const help = page.locator('.update-help');
  await help.waitFor();
  assert.match(await help.innerText(), /GitHub, where releases are published\s+No answer/);
  assert.equal(await help.getByRole('link', { name: 'Open the download page' }).getAttribute('href'), 'https://dexterity-admin.github.io/dexterity-connect/#download');
  await page.locator('.conn-notice').waitFor({ timeout: 10000 }); // away for more than a few seconds: said once, plainly
  await help.scrollIntoViewIfNeeded();
  await both(page, 'anyupdate-01-phone-nothing-answered');
  console.log('phone: nothing answered → what was tried, and the download page');

  // the gateway is back: the phone reconnects, finds the build on the hub and downloads it through the gateway
  await page.keyboard.press('Escape');
  await owner.request('admin.remote.set', { enabled: true });
  await until('the phone is back through the gateway', async () => (await page.evaluate(() => window.dex.getState())).phase === 'ready', 45000);
  await page.evaluate(() => window.dex.checkForUpdates());
  await until('the update is downloaded', async () => (await page.evaluate(() => window.dex.getState())).update.phase === 'ready', 60000);
  const u1 = (await page.evaluate(() => window.dex.getState())).update;
  assert.equal(u1.available?.version, VERSION);
  assert.equal(u1.available?.source, 'hub');
  assert.deepEqual(u1.checked, [{ source: 'hub-gateway', ok: true }, { source: 'internet', ok: false }, { source: 'mirror', ok: false }]);
  const F = await page.evaluate(async () => { const f = (window as any).__F; const b: Uint8Array = f.files.get([...f.files.keys()].find((k: string) => k.endsWith('.apk'))); return { writes: f.writes, downloads: f.downloads, size: b?.length ?? 0, sha: b ? btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-512', b)))) : '' }; });
  assert.equal(F.size, apk.length);
  assert.equal(F.sha, sha(apk), 'the same build, byte for byte');
  assert.ok(F.writes >= 3, `streamed in pieces (${F.writes} writes)`);
  assert.ok(F.downloads.every((u: string) => !u.includes('127.0.0.1')), 'not fetched from the office address, which mobile data cannot reach');
  await prefs();
  await updateRow(page).getByRole('button', { name: 'Restart to update' }).waitFor();
  await both(page, 'anyupdate-02-phone-ready-through-gateway');
  await updateRow(page).getByRole('button', { name: 'Restart to update' }).click();
  await until('handed to Android\'s installer', async () => (await page.evaluate(() => (window as any).__F.installed.length)) > 0, 10000);
  assert.deepEqual(await page.evaluate(() => (window as any).__F.installed), [`/cache/updates/DexterityConnect-${VERSION}.apk`]);
  console.log('phone: found on the hub through the gateway, %d bytes in %d writes, verified, installer opened', F.size, F.writes);

  // Hindi: the failed check's lines
  await page.evaluate(() => { localStorage.setItem('dex.language', 'hi'); });
  await page.reload();
  await page.locator('.frame').waitFor({ timeout: 30000 });
  await owner.request('admin.remote.set', { enabled: false });
  await until('the phone notices the hub is gone', async () => (await page.evaluate(() => window.dex.getState())).phase !== 'ready', 15000);
  await page.evaluate(() => window.dex.checkForUpdates());
  await page.locator('.me-btn').click();
  await page.locator('.menu [role=menuitem]').last().waitFor();
  await page.locator('.menu [role=menuitem]', { hasText: /प्राथमिकताएँ|Preferences/ }).first().click();
  await updateRow(page).scrollIntoViewIfNeeded();
  await page.locator('.update-help').waitFor();
  await sleep(500);
  await shot(page, 'anyupdate-03-phone-hindi');
  await page.evaluate(() => { localStorage.setItem('dex.language', 'en'); });
  await owner.request('admin.remote.set', { enabled: true });

  // ---- the laptop at home: joins through the gateway; GitHub and the mirror do not answer
  const dp = desk.page;
  await dp.getByRole('button', { name: 'I have a pairing code' }).click({ timeout: 20000 });
  await dp.locator('#pair-code').fill(code);
  await dp.getByRole('button', { name: 'Request access' }).click();
  await dp.locator('.frame').waitFor({ timeout: 30000 });
  await dp.locator('.conn.remote').waitFor({ timeout: 15000 });
  await until('the laptop downloads the update', async () => {
    const s = await dp.evaluate(() => window.dex.getState());
    if (s.update.phase === 'idle' || s.update.phase === 'up-to-date' || s.update.phase === 'error') await dp.evaluate(() => window.dex.checkForUpdates()).catch(() => {});
    return s.update.phase === 'ready';
  }, 90000);
  const du = (await dp.evaluate(() => window.dex.getState())).update;
  assert.equal(du.available?.version, VERSION);
  assert.equal(du.available?.source, 'hub');
  assert.deepEqual(du.checked, [{ source: 'hub-gateway', ok: true }, { source: 'internet', ok: false }, { source: 'mirror', ok: false }]);
  const userData = (await desk.app.evaluate(({ app }) => app.getPath('userData'))) as string;
  const got = fs.readFileSync(path.join(userData, 'updates', `DexterityConnect-Setup-${VERSION}.exe`));
  assert.equal(sha(got), sha(exe), 'the laptop has the same build, verified');
  await dp.keyboard.press('Control+,');
  await updateRow(dp).scrollIntoViewIfNeeded();
  await both(dp, 'anyupdate-04-desktop-ready-through-gateway');
  console.log('desktop: found on the hub through the gateway and downloaded (%d bytes)', got.length);
  console.log('ANYUPDATE E2E PASSED');
} catch (e) {
  await shot(page, 'anyupdate-FAIL-phone').catch(() => {});
  await shot(desk.page, 'anyupdate-FAIL-desk').catch(() => {});
  throw e;
} finally {
  await browser.close();
  await desk.app.close();
  owner.disconnect();
  await hub.stop().catch(() => {});
  site.close();
  try { process.kill(-gw.pid!, 'SIGKILL'); } catch { /* gone */ }
}
