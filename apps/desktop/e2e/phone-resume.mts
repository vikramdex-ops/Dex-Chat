// Reopening the phone app should feel instant and calm. The phone app's own code (apps/mobile in
// Chromium at 390 px, with the stand-in native layer from phonemock.mts) against a real hub:
// - a short trip to the background whose socket closed meanwhile: no "Connecting" banner, no
//   amber pill, the open conversation stays, and a message sent meanwhile appears;
// - a long outage: after about 3 s one clear row says the hub is away; it goes when the hub is back;
// - the app reopened (the WebView recreated): the mark alone, then the app, never the Connecting card;
// - reopened during an outage: the mark, then (after a few seconds) the Connecting card (also in Hindi).
// Screenshots: out/phoneresume-*.png.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import pw from 'playwright-core';
import { startOffice, shot, sleep, both } from './harness.mts';
import { installPhoneMock, servePhoneApp, setHidden } from './phonemock.mts';
if (fs.existsSync('/opt/pw-browsers')) process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/pw-browsers';

const until = async (what: string, fn: () => Promise<boolean>, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(100); } throw new Error(`timed out: ${what}`); };

const { owner, hub } = await startOffice('phoneresume', { discoveryPort: false });
const site = await servePhoneApp();
const browser = await pw.chromium.launch({ args: ['--ignore-certificate-errors', '--disable-web-security'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true, bypassCSP: true, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[phone pageerror]', e.message));
await installPhoneMock(page, { fp: hub.fingerprint, network: 'wifi', blockInternet: true }); // no real GitHub in a test
// what the screen showed, frame by frame, from the moment the page loads
await page.addInitScript(() => {
  const w = window as any;
  w.__seen = [] as Array<{ t: number; what: string }>;
  w.__mark = () => { w.__seen = []; };
  const tick = () => {
    const t = Math.round(performance.now());
    if (document.querySelector('.conn-notice')) w.__seen.push({ t, what: 'notice' });
    if (document.querySelector('.conn.warn')) w.__seen.push({ t, what: 'amber pill' });
    if (document.querySelector('.onboard')) w.__seen.push({ t, what: 'connecting card' });
    if (document.querySelector('.splash')) w.__seen.push({ t, what: 'splash' });
    if (document.querySelector('.offline-banner')) w.__seen.push({ t, what: 'offline banner' });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
const seen = async () => [...new Set((await page.evaluate(() => (window as any).__seen as Array<{ what: string }>)).map((s) => s.what))];
const phase = async () => (await page.evaluate(() => window.dex.getState())).phase as string;

try {
  await page.goto(site.url);
  await page.waitForFunction(() => !!(window as any).dex, null, { timeout: 30000 });
  await page.evaluate(({ port }) => window.dex.join({ address: `127.0.0.1:${port}`, displayName: 'Priya Raman', officeAccount: 'DEX\\priya' }), { port: hub.port });
  await page.locator('.frame').waitFor({ timeout: 30000 });
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  const space = await owner.request('conv.create', { kind: 'space', name: 'P-12 Site', members: [priya.id] });
  await owner.request('msg.send', { convId: space.id, body: 'Revised isometrics are up.', clientId: 'r1' });
  await page.locator('.lens-dock').getByRole('button', { name: /Switchboard/ }).click();
  await page.locator('.sb-row', { hasText: 'P-12 Site' }).click();
  await page.locator('.msg', { hasText: 'Revised isometrics are up.' }).waitFor({ timeout: 15000 });

  // ---- a short trip to the background; Android closed the socket meanwhile
  const states: string[] = [];
  await page.exposeFunction('__phase', (p: string) => { states.push(p); });
  await page.evaluate(() => { window.dex.onState((s) => (window as any).__phase(s.phase)); });
  await page.evaluate(() => (window as any).__mark());
  await setHidden(page, true);
  await page.evaluate(() => (window as any).__F.drop());
  await owner.request('msg.send', { convId: space.id, body: 'Crane arrives at 3 pm.', clientId: 'r2' }); // while away
  await sleep(400);
  await setHidden(page, false);
  await until('reconnected', async () => (await phase()) === 'ready', 5000);
  await page.locator('.msg', { hasText: 'Crane arrives at 3 pm.' }).waitFor({ timeout: 8000 });
  await sleep(3500); // long enough for any late banner
  assert.ok(states.some((s) => s === 'offline' || s === 'connecting'), `the connection really dropped (${states.join(' → ')})`);
  assert.deepEqual(await seen(), [], 'nothing about the connection was shown for a quick reconnect');
  await shot(page, 'phoneresume-01-back-calm');
  console.log('short trip away: %s, and nothing shown; the message sent meanwhile is there', states.join(' → '));

  // ---- a long outage: one clear row after about 3 s, gone when the hub is back
  await page.evaluate(() => { (window as any).__mark(); (window as any).__F.offline = true; (window as any).__F.drop(); });
  const down = Date.now();
  await sleep(1500);
  assert.deepEqual(await seen(), [], 'not in the first seconds');
  await page.locator('.conn-notice').waitFor({ timeout: 6000 });
  const after = Date.now() - down;
  assert.ok(after >= 2800, `shown after ${after} ms`);
  assert.match(await page.locator('.conn-notice').innerText(), /Not connected to the office hub|Reconnecting to the office hub/);
  assert.ok(await page.locator('.msg', { hasText: 'Crane arrives at 3 pm.' }).isVisible(), 'the conversation stays on screen');
  await both(page, 'phoneresume-02-long-outage');
  await page.setViewportSize({ width: 1440, height: 900 });
  await sleep(300);
  await both(page, 'phoneresume-03-long-outage-1440');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { (window as any).__F.offline = false; });
  await setHidden(page, false); // what Android does when the person looks again: try now
  await until('back', async () => (await phase()) === 'ready', 20000);
  await page.locator('.conn-notice').waitFor({ state: 'detached', timeout: 3000 });
  console.log('long outage: the row appeared after %d ms and went when the hub was back', after);

  // ---- reopened (the WebView recreated): the mark alone, then the app
  await page.reload();
  await page.locator('.frame').waitFor({ timeout: 15000 });
  await sleep(1000);
  const reopen = await seen();
  assert.ok(!reopen.includes('connecting card') && !reopen.includes('notice') && !reopen.includes('amber pill'), `reopening showed: ${reopen.join(', ')}`);
  console.log('reopened: %s, then the app', reopen.join(', ') || 'nothing');

  // ---- reopened during an outage (in Hindi): the mark, then the Connecting card
  await page.evaluate(() => { localStorage.setItem('mock.offline', '1'); localStorage.setItem('dex.language', 'hi'); });
  await page.reload();
  await page.locator('.splash').waitFor({ timeout: 5000 });
  await shot(page, 'phoneresume-04-reopen-splash');
  await page.locator('.onboard').waitFor({ timeout: 8000 });
  await sleep(300);
  await shot(page, 'phoneresume-05-reopen-outage-hindi');
  await page.evaluate(() => { localStorage.removeItem('mock.offline'); localStorage.setItem('dex.language', 'en'); (window as any).__F.offline = false; });
  await setHidden(page, false);
  await page.locator('.frame').waitFor({ timeout: 30000 });
  console.log('PHONE RESUME E2E PASSED');
} catch (e) {
  await shot(page, 'phoneresume-FAIL');
  throw e;
} finally {
  await browser.close();
  owner.disconnect();
  await hub.stop().catch(() => {});
  site.close();
}
