// Who is waiting, end to end (docs/MEETINGS.md): a browser guest opens Priya's personal room
// through the real gateway Worker (wrangler dev) while Priya's app is on another lens, not in the
// room. Priya gets the system notification (the call the app makes is recorded in the main
// process), the title bar's indicator and the corner card, and Nib's card in her conversation with
// Nib. A second guest is declined from the indicator and told so. Admit from Nib's card opens the
// room for the guest, who is told Priya is on the way; Join now takes Priya in. Then the meeting
// chat: the Chat tab's unread count and preview, and a notification while the window is in the
// background. End for everyone stays beside Leave on every tab and on the folded chip from any
// lens. An instant meeting ("Start meeting") has the same lobby: a knock while the Room is folded
// away, the indicator, Nib's card, Admit. Screenshots at 1440 and 390, light and dark, and Hindi
// (LOBBY_OUT, else out/).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import pw from 'playwright-core';
import { startOffice, launch, sleep, OUT } from './harness.mts';
import { fileURLToPath as rootPath } from 'node:url';
const ROOT = rootPath(new URL('../../../', import.meta.url));
const SHOTS = process.env.LOBBY_OUT ?? OUT;
fs.mkdirSync(SHOTS, { recursive: true });

const free = async () => { const s = net.createServer(); await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r())); const p = (s.address() as net.AddressInfo).port; await new Promise<void>((r) => s.close(() => r())); return p; };
const { owner, hub } = await startOffice('lobby');
const gwPort = await free();
const gw = spawn(path.join(ROOT, 'node_modules', '.bin', 'wrangler'), ['dev', '--ip', '127.0.0.1', '--port', String(gwPort), '--persist-to', path.join(OUT, `gw-state-lobby-${Date.now()}`), '--show-interactive-dev-session=false'], { cwd: path.join(ROOT, 'apps/gateway'), detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise<void>((res, rej) => { const t = setTimeout(() => rej(new Error('wrangler did not start')), 90_000); const on = (b: Buffer) => { if (/Ready on/.test(b.toString())) { clearTimeout(t); res(); } }; gw.stdout!.on('data', on); gw.stderr!.on('data', on); });
gw.stdout!.resume(); gw.stderr!.resume();
const gwUrl = `http://127.0.0.1:${gwPort}`;
await owner.request('admin.remote.set', { url: gwUrl, enabled: true });
for (let i = 0; i < 80 && !(await owner.request('admin.remote.get')).status.connected; i++) await sleep(100);
assert.ok((await owner.request('admin.remote.get')).status.connected, 'hub reached the gateway');

const a = await launch('priya', 'Priya Raman', { width: 1440, height: 900 });
const P = a.page;
// the system notifications the app asks for, as the main process receives them
await a.app.evaluate(({ ipcMain }) => { (globalThis as any).notes = []; ipcMain.on('app:notify', (_e, t, b, l) => (globalThis as any).notes.push({ title: t, body: b, link: l })); });
const notes = async (): Promise<Array<{ title: string; body: string; link?: string }>> => a.app.evaluate(() => (globalThis as any).notes);
const waitNote = async (re: RegExp, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) { const hit = (await notes()).find((n) => re.test(`${n.title} | ${n.body}`)); if (hit) return hit; if (Date.now() > end) throw new Error(`no notification ${re} (have ${JSON.stringify(await notes())})`); await sleep(150); }
};
const chrome = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'].find((p) => fs.existsSync(p));
const browser = await pw.chromium.launch({ ...(chrome && !process.env.PW_CHROMIUM ? { executablePath: chrome } : {}), args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-sandbox'] });
const shot = (page: any, name: string) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
const both = async (page: any, name: string) => {
  await shot(page, `${name}-light`);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; }); await sleep(250);
  await shot(page, `${name}-dark`);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; }); await sleep(150);
};
const narrow = async (fn: () => Promise<void>) => { await P.setViewportSize({ width: 390, height: 844 }); await sleep(400); try { await fn(); } finally { await P.setViewportSize({ width: 1440, height: 900 }); await sleep(300); } };
/** A guest in a browser asks to join with their name. */
async function guest(url: string, name: string, width = 1280) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 } });
  const g = await ctx.newPage();
  g.on('pageerror', (e: Error) => console.log(`[${name} pageerror]`, e.message));
  await g.goto(url);
  await g.locator('#join-name').fill(name);
  await g.getByRole('button', { name: 'Check camera and mic' }).click();
  await g.locator('.preview video').waitFor({ timeout: 15000 });
  await g.getByRole('button', { name: /Join the meeting|Ask to join/ }).click();
  return g;
}
const openNibConv = async () => {
  const me = await P.evaluate(() => window.dex.request('nib.me'));
  await P.evaluate((c: string) => window.dispatchEvent(new CustomEvent('dex-deeplink', { detail: `dexconnect://conversation/${c}` })), me.convId);
};

try {
  await P.reload(); await P.locator('.frame').waitFor();
  // ------------------------------------------------------------ Priya's personal room, with its guest link; Priya is on the Calendar
  const room = await P.evaluate(() => window.dex.request('meet.personal'));
  const link = await P.evaluate((id: string) => window.dex.request('meet.guestLink', { id, enabled: true }), room.id);
  assert.ok(link.url, `a guest link (${link.problem})`);
  await P.locator('.lens-bar .lens', { hasText: 'Calendar' }).click();
  assert.equal(await P.locator('.lobby-bell').count(), 0, 'no indicator while nobody waits');

  // ------------------------------------------------------------ Dana knocks; the page says Priya has been told
  const dana = await guest(link.url, 'Dana Wright');
  await dana.getByRole('heading', { name: 'The host has been told' }).waitFor({ timeout: 20000 });
  assert.match(await dana.locator('.lead').first().innerText(), /Priya Raman is not in the meeting yet\. They have been told you are waiting/);
  await sleep(400);
  await both(dana, 'lobby-01-guest-host-told');

  // Priya: the notification, the indicator, the corner card
  const n1 = await waitNote(/Dana Wright \(guest, name not verified\) asks to join/);
  assert.match(n1.title, /Waiting in the lobby · your personal room/);
  assert.match(n1.link ?? '', /^dexconnect:\/\/lobby\//);
  await P.locator('.lobby-bell.is-waiting', { hasText: '1 WAITING' }).waitFor({ timeout: 10000 });
  const card = P.locator('.knock-card', { hasText: 'Dana Wright' });
  await card.waitFor();
  assert.match(await card.innerText(), /GUEST · NAME NOT VERIFIED/);
  assert.match(await card.innerText(), /the room is not open yet/);
  await sleep(300);
  await both(P, 'lobby-02-host-indicator-card-1440');

  // a second guest; Priya declines him from the indicator's list, and his page says so
  const sam = await guest(link.url, 'Sam Okafor');
  await sam.getByRole('heading', { name: 'The host has been told' }).waitFor({ timeout: 20000 });
  await P.locator('.lobby-bell.is-waiting', { hasText: '2 WAITING' }).waitFor({ timeout: 10000 });
  await P.locator('.lobby-bell').click();
  const list = P.locator('.lobby-pop');
  await list.locator('.lobby-row', { hasText: 'Sam Okafor' }).waitFor();
  assert.match(await list.innerText(), /The room is not open\. Admit opens it for them/);
  await sleep(300);
  await both(P, 'lobby-03-indicator-list-1440');
  await narrow(async () => { await P.locator('.lobby-bell').click(); await list.locator('.lobby-row', { hasText: 'Sam Okafor' }).waitFor(); await sleep(300); await both(P, 'lobby-03b-indicator-list-390'); });
  // the list closes when the window changes size: open it again
  if (!(await list.isVisible().catch(() => false))) await P.locator('.lobby-bell').click();
  await list.locator('.lobby-row', { hasText: 'Sam Okafor' }).waitFor();
  await list.getByRole('button', { name: 'Decline Sam Okafor' }).click();
  await sam.getByText('The host did not let you in').first().waitFor({ timeout: 15000 });
  await shot(sam, 'lobby-04-guest-declined');
  await P.locator('.lobby-bell.is-waiting', { hasText: '1 WAITING' }).waitFor({ timeout: 10000 });
  await P.keyboard.press('Escape');

  // ------------------------------------------------------------ Nib's card: Admit from it
  await openNibConv();
  const nib = P.locator('.k-knock', { hasText: 'Dana Wright' });
  await nib.waitFor({ timeout: 15000 });
  assert.match(await nib.innerText(), /WAITING SINCE/);
  assert.match(await nib.innerText(), /The room is not open\. Admit opens it for them; they wait there for you\./);
  // Sam's card shows who turned him away, no buttons left on it
  const samCard = P.locator('.k-knock', { hasText: 'Sam Okafor' });
  await samCard.getByText(/You turned them away at/).waitFor({ timeout: 10000 });
  assert.equal(await samCard.getByRole('button').count(), 0, 'no stale buttons on an answered card');
  await nib.scrollIntoViewIfNeeded();
  await sleep(300);
  await both(P, 'lobby-05-nib-card-1440');
  await narrow(async () => { await nib.scrollIntoViewIfNeeded(); await both(P, 'lobby-05b-nib-card-390'); });
  await nib.getByRole('button', { name: 'Admit Dana Wright' }).click();
  // the guest is let in: the room opens for her, and she is told Priya is on the way
  await dana.locator('.room .tile').first().waitFor({ timeout: 20000 });
  await dana.getByText('HOST · ON THE WAY').waitFor({ timeout: 10000 });
  await sleep(500);
  await both(dana, 'lobby-06-guest-admitted-host-on-the-way');
  await nib.getByText(/You let them in at/).waitFor({ timeout: 10000 });
  await nib.getByText(/In the meeting since/).waitFor({ timeout: 10000 });
  await P.locator('.lobby-bell.is-quiet', { hasText: 'IN YOUR ROOM' }).waitFor({ timeout: 10000 });
  await sleep(300);
  await both(P, 'lobby-07-nib-card-admitted-1440');

  // Join now: Priya comes into her room; the guest's page drops the "on the way" note
  await nib.getByRole('button', { name: 'Join now' }).click();
  await P.getByRole('button', { name: 'Leave Room' }).waitFor({ timeout: 20000 });
  await dana.locator('.room .tile').nth(1).waitFor({ timeout: 20000 });
  await dana.getByText('HOST · ON THE WAY').waitFor({ state: 'detached', timeout: 10000 });
  assert.equal(await P.locator('.lobby-bell').count(), 0, 'nothing waits, nothing runs without her');

  // ------------------------------------------------------------ End for everyone, on every tab
  for (const tab of ['People', 'Polls', 'Files']) {
    await P.getByRole('tab', { name: new RegExp(`^${tab}`) }).click();
    await P.getByRole('button', { name: 'End for everyone' }).waitFor({ timeout: 5000 });
  }
  await P.getByRole('tab', { name: /^People/ }).click();
  await sleep(300);
  await both(P, 'lobby-08-room-end-beside-leave-1440');

  // ------------------------------------------------------------ the meeting chat: unread count and preview, then a background notification
  await dana.getByLabel('Message to the meeting').fill('Hello Priya, the skid drawing is on my screen');
  await dana.getByLabel('Message to the meeting').press('Enter');
  const badge = P.locator('.room-tab-badge.chat');
  await badge.waitFor({ timeout: 10000 });
  assert.equal((await badge.innerText()).trim(), '1');
  await P.locator('.room-chat-peek', { hasText: 'skid drawing' }).waitFor({ timeout: 5000 });
  await sleep(200);
  await both(P, 'lobby-09-chat-badge-peek-1440');
  await narrow(async () => { await P.locator('.room-tab-badge.chat').waitFor(); await both(P, 'lobby-09b-chat-badge-390'); });
  // the window goes to the background: the next line is a system notification that opens the chat
  await a.app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.minimize(); w.blur(); });
  await P.evaluate(() => { (document as any).hasFocus = () => false; });
  await dana.getByLabel('Message to the meeting').fill('Shall we start with sheet 3?');
  await dana.getByLabel('Message to the meeting').press('Enter');
  const n2 = await waitNote(/Meeting chat · Priya Raman's room \| Dana Wright \(guest\): Shall we start with sheet 3\?/);
  assert.equal(n2.link, 'dexconnect://meetchat');
  assert.equal((await badge.innerText()).trim(), '2');
  // her own line is never news
  const before = (await notes()).length;
  await P.evaluate(async () => { const r = (await window.dex.request('room.list')).find((x: any) => x.meetingId); await window.dex.request('room.chat', { roomId: r.id, text: 'My own line' }); });
  await sleep(800);
  assert.equal((await notes()).length, before, 'no notification for her own line');
  await a.app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.restore(); w.focus(); });
  await P.evaluate(() => { delete (document as any).hasFocus; });
  // clicking the notification opens the meeting's chat
  await P.evaluate(() => window.dispatchEvent(new CustomEvent('dex-deeplink', { detail: 'dexconnect://meetchat' })));
  await P.locator('.room-chat .meet-chat-body', { hasText: 'Shall we start with sheet 3?' }).waitFor({ timeout: 5000 });
  await P.locator('.room-tab-badge.chat').waitFor({ state: 'detached', timeout: 5000 });

  // folded away, on another lens: the chip keeps End for everyone
  await P.getByRole('button', { name: 'Fold' }).click();
  await P.locator('.lens-bar .lens', { hasText: 'Calendar' }).click();
  await P.locator('.room-chip .room-chip-end').waitFor({ timeout: 5000 });
  await sleep(200);
  await both(P, 'lobby-10-chip-end-other-lens-1440');
  await P.locator('.room-chip-main').click();
  await P.getByRole('button', { name: 'Leave Room' }).click();
  await dana.close();

  // ------------------------------------------------------------ an instant meeting: the same lobby, while the Room is folded away
  await P.locator('.lens-bar .lens', { hasText: 'Meet' }).click();
  await P.getByLabel('Meeting title').fill('Client review: pump skid');
  await P.getByRole('button', { name: 'Start meeting' }).click();
  await P.getByRole('button', { name: 'Leave Room' }).waitFor({ timeout: 20000 });
  const instant = await P.evaluate(async () => (await window.dex.request('room.list')).find((x: any) => x.meetingKind === 'instant'));
  const ilink = await P.evaluate((id: string) => window.dex.request('meet.guestLink', { id, enabled: true }), instant.meetingId);
  await P.getByRole('button', { name: 'Fold' }).click();
  await P.locator('.lens-bar .lens', { hasText: 'Pulse' }).click();
  const kim = await guest(ilink.url, 'Kim Lee');
  // a host is in the meeting: her page says the host sees her waiting
  await kim.getByRole('heading', { name: 'The host will let you in' }).waitFor({ timeout: 20000 });
  await waitNote(/Waiting in the lobby · Client review: pump skid/);
  await P.locator('.lobby-bell.is-waiting', { hasText: '1 WAITING' }).waitFor({ timeout: 10000 });
  await P.locator('.knock-card', { hasText: 'Kim Lee' }).waitFor();
  await openNibConv();
  const kcard = P.locator('.k-knock', { hasText: 'Kim Lee' });
  await kcard.waitFor({ timeout: 15000 });
  assert.match(await kcard.innerText(), /Client review: pump skid/);
  await kcard.scrollIntoViewIfNeeded();
  await sleep(300);
  await both(P, 'lobby-11-instant-knock-1440');
  // in the Room, the lobby strip shows her too, whatever tab is open
  await P.locator('.room-chip-main').click();
  await P.getByRole('tab', { name: /^Files/ }).click();
  const strip = P.locator('.lobby-strip', { hasText: 'Kim Lee' });
  await strip.waitFor({ timeout: 5000 });
  await sleep(300);
  await both(P, 'lobby-12-room-lobby-strip-1440');
  await narrow(async () => { await strip.waitFor(); await both(P, 'lobby-12b-room-lobby-strip-390'); });
  await strip.getByRole('button', { name: 'Admit Kim Lee' }).click();
  await kim.locator('.room .tile').nth(1).waitFor({ timeout: 20000 });
  // the card follows: no buttons left
  await P.getByRole('button', { name: 'Fold' }).click();
  await kcard.getByText(/You let them in at/).waitFor({ timeout: 10000 });
  assert.equal(await kcard.getByRole('button', { name: /Admit|Decline/ }).count(), 0);

  // End for everyone from the folded chip, asked first: the guest's meeting ends
  await P.locator('.room-chip-end').click();
  await P.locator('.confirm-actions').getByRole('button', { name: 'End for everyone' }).click();
  await kim.getByText(/The meeting has ended|The host ended the meeting/).first().waitFor({ timeout: 15000 });
  await kim.close();

  // ------------------------------------------------------------ Hindi: someone waiting while Priya is elsewhere
  const lee = await guest(link.url, 'Lee Chen');
  await lee.getByRole('heading', { name: 'The host has been told' }).waitFor({ timeout: 20000 });
  await P.evaluate(() => localStorage.setItem('dex.language', 'hi'));
  await P.reload(); await P.locator('.frame').waitFor(); await sleep(800);
  await P.locator('.lobby-bell.is-waiting').waitFor({ timeout: 10000 });
  await P.locator('.lobby-bell').click();
  await P.locator('.lobby-pop .lobby-row', { hasText: 'Lee Chen' }).waitFor();
  await sleep(300);
  await shot(P, 'lobby-13-hindi-indicator-1440');
  assert.match(await P.locator('.lobby-pop').innerText(), /अंदर आने दें/);
  await P.keyboard.press('Escape');
  await P.evaluate(() => localStorage.setItem('dex.language', 'en'));
  await lee.close();

  console.log('LOBBY E2E PASSED');
} catch (e) {
  await shot(P, 'lobby-FAIL').catch(() => {});
  throw e;
} finally {
  await browser.close().catch(() => {});
  await a.app.close().catch(() => {});
  owner.disconnect();
  await hub.stop();
  try { process.kill(-gw.pid!, 'SIGKILL'); } catch { /* gone */ }
}
