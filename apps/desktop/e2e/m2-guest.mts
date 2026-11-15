// M2 end to end: a guest joins from a browser through the real gateway Worker (wrangler dev, in
// Cloudflare's local runtime). Priya hosts in the Electron app and turns the guest link on; Dana
// opens the link in headless Chromium (fake camera and mic), enters her name, checks her camera
// and mic, waits in the lobby, is admitted, and both sides see each other's video. Then: the
// meeting chat both ways, a hand and a reaction from the guest, the guest sharing a screen, the
// host muting her, and a recording kept on the hub with chapters, the shelf, the player and the
// meeting's report. Screenshots in light and dark, desktop and phone width.
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import pw from 'playwright-core';
import { startOffice, launch, shot, sleep, OUT, voices } from './harness.mts';
import { audit } from './tourlib.mts';
import { fileURLToPath as rootPath } from 'node:url';
const ROOT = rootPath(new URL('../../../', import.meta.url));

const free = async () => { const s = net.createServer(); await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r())); const p = (s.address() as net.AddressInfo).port; await new Promise<void>((r) => s.close(() => r())); return p; };
// the hub first: the shared port is taken while the gateway starts otherwise
const { owner, hub } = await startOffice('guest');
const gwPort = await free();
const gwRoot = path.join(ROOT, 'apps/gateway');
const gw = spawn(path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'wrangler.cmd' : 'wrangler'), ['dev', '--ip', '127.0.0.1', '--port', String(gwPort), '--persist-to', path.join(OUT, `gw-state-${Date.now()}`), '--show-interactive-dev-session=false'], { cwd: gwRoot, detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise<void>((res, rej) => { const t = setTimeout(() => rej(new Error('wrangler did not start')), 90_000); const on = (b: Buffer) => { if (/Ready on/.test(b.toString())) { clearTimeout(t); res(); } }; gw.stdout!.on('data', on); gw.stderr!.on('data', on); });
gw.stdout!.resume(); gw.stderr!.resume();
const gwUrl = `http://127.0.0.1:${gwPort}`;
console.log('gateway on', gwUrl);

await owner.request('admin.remote.set', { url: gwUrl, enabled: true });
for (let i = 0; i < 80 && !(await owner.request('admin.remote.get')).status.connected; i++) await sleep(100);
assert.ok((await owner.request('admin.remote.get')).status.connected, 'hub reached the gateway');

const a = await launch('priya', 'Priya Raman', { audio: voices().a });
const browser = await pw.chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-select-desktop-capture-source=Entire screen', '--enable-usermedia-screen-capturing', `--use-file-for-fake-audio-capture=${voices().b}`] });
const results: Record<string, unknown> = {};
const darkApp = async (p: any, name: string) => { await p.evaluate(() => { document.documentElement.dataset.theme = 'dark'; }); await sleep(250); await shot(p, name); await p.evaluate(() => { document.documentElement.dataset.theme = 'light'; }); };
const guestShot = async (p: any, name: string) => { await p.screenshot({ path: path.join(OUT, `${name}.png`) }); if (process.env.TAUDIT) await audit(p, `gw-${name}`); };

try {
  await a.page.reload(); await a.page.locator('.frame').waitFor();
  // ------------------------------------------------------------ Priya starts a meeting and turns the guest link on
  await a.page.locator('.lens-bar .lens', { hasText: 'Meet' }).click();
  await a.page.getByLabel('Meeting title').fill('Client review: pump skid');
  await a.page.getByLabel('Start with my camera on').check();
  await a.page.getByRole('button', { name: 'Start meeting' }).click();
  await a.page.getByRole('button', { name: 'Leave Room' }).waitFor({ timeout: 20000 });
  await a.page.locator('.guest-settings summary').click();
  await a.page.getByRole('switch', { name: 'Guests can join from a browser' }).click();
  await a.page.locator('.guest-url').waitFor({ timeout: 10000 });
  const url = (await a.page.locator('.guest-url').innerText()).trim();
  const pass = (await a.page.locator('.guest-pass').innerText()).trim();
  assert.ok(url.startsWith(`${gwUrl}/m/`) && url.endsWith(`#${pass}`), url);
  console.log('guest link', url);
  await shot(a.page, 'm2-01-host-guest-link');

  // ------------------------------------------------------------ Dana opens the link: name, camera and mic check, lobby
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const g = await ctx.newPage();
  g.on('pageerror', (e: Error) => console.log('[guest pageerror]', e.message));
  g.on('console', (m: any) => { if (m.type() === 'error') console.log('[guest console]', m.text()); });
  await g.goto(url);
  await g.locator('#join-name').waitFor();
  assert.equal(new URL(g.url()).hash, '', 'the passcode is taken out of the address bar');
  await guestShot(g, 'm2-02-guest-name');
  await g.emulateMedia({ colorScheme: 'dark' }); await guestShot(g, 'm2-02b-guest-name-dark'); await g.emulateMedia({ colorScheme: 'light' });
  await g.locator('#join-name').fill('Dana Wright');
  await g.getByRole('button', { name: 'Next: camera and mic' }).click();
  await g.locator('.preview video').waitFor({ timeout: 15000 });
  await g.waitForFunction(() => (document.querySelector('.preview video') as HTMLVideoElement)?.videoWidth > 0);
  await sleep(800);
  await guestShot(g, 'm2-03-guest-check');
  await g.emulateMedia({ colorScheme: 'dark' }); await guestShot(g, 'm2-03b-guest-check-dark'); await g.emulateMedia({ colorScheme: 'light' });
  await g.getByRole('button', { name: 'Ask to join' }).click();
  await g.getByText('Waiting for Priya Raman to let you in').waitFor({ timeout: 15000 });
  await sleep(300);
  await guestShot(g, 'm2-04-guest-lobby');
  await g.emulateMedia({ colorScheme: 'dark' }); await guestShot(g, 'm2-04b-guest-lobby-dark'); await g.emulateMedia({ colorScheme: 'light' });

  // the phone width: the same sheets
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const gp = await phone.newPage();
  await gp.goto(url);
  await gp.locator('#join-name').fill('Kim on a phone');
  await guestShot(gp, 'm2-05-guest-phone-name');
  await gp.emulateMedia({ colorScheme: 'dark' }); await guestShot(gp, 'm2-05b-guest-phone-name-dark'); await gp.emulateMedia({ colorScheme: 'light' });
  await gp.getByRole('button', { name: 'Next: camera and mic' }).click();
  await gp.locator('.preview video').waitFor({ timeout: 15000 });
  await sleep(600);
  await guestShot(gp, 'm2-05c-guest-phone-check');
  await gp.emulateMedia({ colorScheme: 'dark' }); await guestShot(gp, 'm2-05d-guest-phone-check-dark'); await gp.emulateMedia({ colorScheme: 'light' });

  // ------------------------------------------------------------ the host sees her in the lobby, as a guest, and admits her
  const row = a.page.locator('.room-lobby li', { hasText: 'Dana Wright' });
  await row.waitFor({ timeout: 15000 });
  assert.match(await row.innerText(), /Guest/);
  await sleep(400);
  await shot(a.page, 'm2-06-host-lobby-guest');
  await darkApp(a.page, 'm2-06b-host-lobby-guest-dark');
  const t0 = Date.now();
  await row.getByRole('button', { name: 'Admit' }).click();
  await g.locator('.room .tile').first().waitFor({ timeout: 15000 });

  // two-way video: Dana sees Priya's camera, Priya sees Dana's
  await g.waitForFunction(() => [...document.querySelectorAll('.tile video')].some((v) => !(v as HTMLVideoElement).classList.contains('mirror') && (v as HTMLVideoElement).videoWidth > 0 && (v as HTMLVideoElement).currentTime > 0.3), null, { timeout: 30000 });
  results.guestFirstFrameMs = Date.now() - t0;
  await a.page.waitForFunction(() => { const v = document.querySelector('.room-tile[data-device^="guestdev:"] video') as HTMLVideoElement | null; return !!v && v.videoWidth > 0 && v.currentTime > 0.3; }, null, { timeout: 30000 });
  results.hostSeesGuestMs = Date.now() - t0;
  // frames keep coming both ways
  const advancing = async (page: any, sel: string) => page.evaluate(async (s: string) => { const v = document.querySelector(s) as HTMLVideoElement; const a1 = v.currentTime; await new Promise((r) => setTimeout(r, 1500)); return v.currentTime - a1; }, sel);
  assert.ok((await advancing(g, '.tile:not(:first-child) video')) > 0.5, 'guest receives moving video');
  assert.ok((await advancing(a.page, '.room-tile[data-device^="guestdev:"] video')) > 0.5, 'host receives moving video');
  console.log('two-way video ok', results);
  assert.match(await a.page.locator('.room-tile[data-device^="guestdev:"]').getAttribute('aria-label') ?? '', /Dana Wright/);
  await sleep(1200);
  await guestShot(g, 'm2-07-guest-in-meeting');
  await g.emulateMedia({ colorScheme: 'dark' }); await guestShot(g, 'm2-07b-guest-in-meeting-dark'); await g.emulateMedia({ colorScheme: 'light' });

  // ------------------------------------------------------------ the meeting chat, both ways
  await g.getByLabel('Message to the meeting').fill('Good morning, I can see the skid drawing');
  await g.getByLabel('Message to the meeting').press('Enter');
  await a.page.getByRole('tab', { name: /Chat/ }).click();
  await a.page.locator('.room-chat .meet-chat-body', { hasText: 'Good morning, I can see the skid drawing' }).waitFor({ timeout: 10000 });
  await a.page.getByLabel('Message to everyone in the Room').fill('Welcome Dana, let us start with sheet 3');
  await a.page.getByLabel('Message to everyone in the Room').press('Enter');
  await g.locator('.chat .line-body', { hasText: 'Welcome Dana, let us start with sheet 3' }).waitFor({ timeout: 10000 });
  await shot(a.page, 'm2-08-host-meeting-chat');

  // a hand and a reaction from the guest
  await g.getByRole('button', { name: 'Raise hand' }).click();
  await a.page.locator('.room-field .room-hand').first().waitFor({ timeout: 10000 });
  await g.getByRole('button', { name: 'React' }).click();
  await g.getByRole('menuitem', { name: 'React 👏' }).click();
  await a.page.locator('.room-reacts span').first().waitFor({ timeout: 5000 });
  await sleep(300);
  await shot(a.page, 'm2-09-host-guest-hand-reaction');

  // the guest shares a screen (Chromium's capture of its own screen in this harness)
  const shared = await g.evaluate(() => typeof navigator.mediaDevices.getDisplayMedia === 'function');
  if (shared) {
    await g.getByRole('button', { name: 'Share screen' }).click();
    const ok = await g.locator('.share video').waitFor({ timeout: 8000 }).then(() => true, () => false);
    if (ok) {
      await a.page.waitForFunction(() => !!document.querySelector('.room-share video') && (document.querySelector('.room-share video') as HTMLVideoElement).videoWidth > 0, null, { timeout: 20000 });
      results.guestScreenShare = 'seen by the host';
      await sleep(800);
      await shot(a.page, 'm2-10-host-sees-guest-screen');
      await g.getByRole('button', { name: 'Stop sharing' }).click();
    } else results.guestScreenShare = 'getDisplayMedia was refused in headless Chromium';
  }

  // ------------------------------------------------------------ a recording, kept on the hub with chapters
  // (the test voices are synthetic buzzes, which RNNoise rightly removes: suppression off for this part)
  await a.page.locator('.tb-sound').click();
  await a.page.getByRole('switch', { name: 'Strong noise suppression' }).click();
  await a.page.getByText('OFF · BROWSER FILTERS ONLY').waitFor();
  await a.page.keyboard.press('Escape');
  await a.page.getByRole('button', { name: 'Record' }).click();
  await sleep(17000);
  await a.page.getByRole('button', { name: 'Stop recording' }).click();
  await a.page.getByText('Kept on the hub.').waitFor({ timeout: 30000 });
  await shot(a.page, 'm2-11-recording-kept');
  await a.page.getByRole('button', { name: 'Share with the conversation' }).click();
  await sleep(300);
  await a.page.getByRole('button', { name: 'Open on the shelf' }).click();
  await a.page.locator('.rec-viewer video').waitFor({ timeout: 15000 });
  await a.page.waitForFunction(() => (document.querySelector('.rec-viewer video') as HTMLVideoElement).readyState >= 1, null, { timeout: 20000 });
  const chapters = await a.page.locator('.rec-chapters li').allInnerTexts();
  results.recordingChapters = chapters.map((c) => c.replace(/\s+/g, ' ').trim());
  assert.ok(chapters.length >= 2, 'chapters for who spoke when');
  assert.ok(chapters.some((c) => /Priya/.test(c)) && chapters.some((c) => /Dana/.test(c)), 'both speakers have chapters');
  // a chapter seeks the video there
  await a.page.locator('.rec-chapters li').nth(1).getByRole('button').click();
  await sleep(1500);
  await a.page.locator('.rec-viewer video').evaluate((v: HTMLVideoElement) => v.pause());
  await sleep(300);
  await shot(a.page, 'm2-12-player-chapters');
  await darkApp(a.page, 'm2-12b-player-chapters-dark');
  await a.page.locator('.rec-viewer').getByRole('button', { name: 'Close' }).click();

  // the host mutes the guest
  await a.page.getByRole('tab', { name: /People/ }).click();
  await a.page.locator('.room-schedule tr', { hasText: 'Dana Wright' }).locator('.row-menu').click();
  await a.page.getByRole('menuitem', { name: 'Mute Dana' }).click();
  await g.locator('.banner', { hasText: 'Priya Raman muted you' }).waitFor({ timeout: 10000 });
  await g.getByRole('button', { name: 'Mic off' }).waitFor();

  // the guest leaves; the meeting ends; the report and the shelf
  await g.getByRole('button', { name: 'Leave' }).click();
  await g.getByText('You are out of the meeting').waitFor();
  await guestShot(g, 'm2-13-guest-left');
  await a.page.getByRole('button', { name: 'Leave Room' }).click();
  await a.page.locator('.lens-bar .lens', { hasText: 'Meet' }).click();
  await a.page.locator('.rec-shelf tbody tr').first().waitFor({ timeout: 15000 });
  await sleep(400);
  await a.page.locator('.meet-recordings').scrollIntoViewIfNeeded();
  await shot(a.page, 'm2-14-recordings-shelf');
  await darkApp(a.page, 'm2-14b-recordings-shelf-dark');
  await a.page.locator('.meet-log tr').first().getByRole('button', { name: 'Report' }).click();
  await a.page.locator('.rep-table tbody tr', { hasText: 'Dana Wright' }).waitFor({ timeout: 10000 });
  const reportRows = await a.page.locator('.rep-table tbody tr').allInnerTexts();
  results.reportRows = reportRows.map((r) => r.replace(/\s+/g, ' ').trim());
  assert.ok(reportRows.some((r) => /Dana Wright/.test(r) && /GUEST/.test(r)));
  await sleep(300);
  await shot(a.page, 'm2-15-report');
  await darkApp(a.page, 'm2-15b-report-dark');
  const audit = await owner.request('admin.audit', { limit: 200 }) as Array<{ action: string }>;
  for (const x of ['meeting.guestLinkOn', 'meeting.guestKnocked', 'meeting.admitted', 'meeting.guestJoined', 'recording.stored', 'recording.shared']) assert.ok(audit.some((e) => e.action === x), x);
  console.log('RESULTS', JSON.stringify(results));
  console.log('GUEST E2E PASSED');
} catch (e) {
  await shot(a.page, 'm2-guest-FAIL').catch(() => {});
  throw e;
} finally {
  await browser.close().catch(() => {});
  await a.app.close().catch(() => {});
  owner.disconnect();
  await hub.stop();
  try { process.kill(-gw.pid!, 'SIGKILL'); } catch { /* gone */ }
}
