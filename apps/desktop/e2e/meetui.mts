// Meeting fixes end to end, through the real gateway Worker (wrangler dev) on one X display (xvfb)
// with xdotool, so remote control really moves the pointer and clicks:
//  1. the browser meeting page's toolbar: a pressed Raise hand keeps the size and layout of every
//     other tool, at 1440 and 390 px, light and dark;
//  2. meeting chat boxes grow with the text (browser and app), Enter sends, Shift+Enter and an input
//     method's composition do not, and a half-written line survives incoming lines;
//  3. numbered markers on a shared screen land exactly where they were placed: on the viewer's
//     video and on the presenter's own screen (the pointer window), even when that window is not
//     where the display is;
//  4. Give control: a guest in a browser asks, the presenter accepts (marked GUEST) and the guest
//     clicks a button on the presenter's PC; Shift+Esc takes it back; then app to app; a screen
//     shared from a browser is view only.
// Ravi uses the app in Hindi (the Hindi screenshots).
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import pw from 'playwright-core';
import { startOffice, launch, shot, sleep, OUT } from './harness.mts';
import { fileURLToPath as rootPath } from 'node:url';
const ROOT = rootPath(new URL('../../../', import.meta.url));

process.env.DEXCONNECT_POINTER_OVERLAY = '1'; // Xvfb has no compositor; the pointer window still draws, for these checks
const W = 1000, H = 1000;
const free = async () => { const s = net.createServer(); await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r())); const p = (s.address() as net.AddressInfo).port; await new Promise<void>((r) => s.close(() => r())); return p; };
const { owner, hub } = await startOffice('meetui');
const gwPort = await free();
const gw = spawn(path.join(ROOT, 'node_modules', '.bin', 'wrangler'), ['dev', '--ip', '127.0.0.1', '--port', String(gwPort), '--persist-to', path.join(OUT, `gw-state-${Date.now()}`), '--show-interactive-dev-session=false'], { cwd: path.join(ROOT, 'apps/gateway'), detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise<void>((res, rej) => { const t = setTimeout(() => rej(new Error('wrangler did not start')), 90_000); const on = (b: Buffer) => { if (/Ready on/.test(b.toString())) { clearTimeout(t); res(); } }; gw.stdout!.on('data', on); gw.stderr!.on('data', on); });
gw.stdout!.resume(); gw.stderr!.resume();
const gwUrl = `http://127.0.0.1:${gwPort}`;
await owner.request('admin.remote.set', { url: gwUrl, enabled: true });
for (let i = 0; i < 80 && !(await owner.request('admin.remote.get')).status.connected; i++) await sleep(100);

const a = await launch('priya', 'Priya Raman', { width: W, height: H });
const b = await launch('ravi', 'Ravi Kumar', { width: W, height: H });
const browser = await pw.chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-select-desktop-capture-source=Entire screen', '--enable-usermedia-screen-capturing'] });
const xpos = () => { const m = execFileSync('xdotool', ['getmouselocation']).toString().match(/x:(\d+) y:(\d+)/)!; return { x: Number(m[1]), y: Number(m[2]) }; };
const theme = (p: any, t: 'light' | 'dark') => p.evaluate((x: string) => { document.documentElement.dataset.theme = x; }, t);
const both = async (p: any, name: string) => { await theme(p, 'light'); await sleep(200); await shot(p, `${name}-light`); await theme(p, 'dark'); await sleep(200); await shot(p, `${name}-dark`); await theme(p, 'light'); };
const gShot = (g: any, name: string) => g.screenshot({ path: path.join(OUT, `${name}.png`) });
const gBoth = async (g: any, name: string) => { await g.emulateMedia({ colorScheme: 'light' }); await sleep(150); await gShot(g, `${name}-light`); await g.emulateMedia({ colorScheme: 'dark' }); await sleep(150); await gShot(g, `${name}-dark`); await g.emulateMedia({ colorScheme: 'light' }); };
const translateOf = (t: string | null) => { const m = (t ?? '').match(/translate\(([-\d.]+)[ ,]([-\d.]+)\)/); assert.ok(m, `a translate in ${t}`); return { x: Number(m![1]), y: Number(m![2]) }; };
let g: any = null;
try {
  for (const [app, x] of [[a.app, 0], [b.app, W]] as const) {
    await app.evaluate(({ BrowserWindow }, x) => { const w = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('overlay'))!; w.setBounds({ x, y: 0, width: 1000, height: 1000 }); }, x);
  }
  // Ravi reads the app in Hindi
  await b.page.evaluate(() => localStorage.setItem('dex.language', 'hi'));
  await b.page.reload(); await b.page.locator('.frame').waitFor();
  await sleep(500);

  // ------------------------------------------------------------ a meeting with Ravi, and a guest link
  await a.page.locator('.lens-bar .lens', { hasText: 'Meet' }).click();
  await a.page.getByLabel('Meeting title').fill('Pump skid model review');
  await a.page.getByLabel('Ring people in').fill('ravi');
  await a.page.locator('.meet-suggest button', { hasText: 'Ravi Kumar' }).click();
  await a.page.getByRole('button', { name: 'Start meeting' }).click();
  await a.page.getByRole('button', { name: 'Leave Room' }).waitFor({ timeout: 20000 });
  await b.page.locator('.room-banner .rb-btn').first().click({ timeout: 20000 });
  await a.page.locator('.room-schedule tr', { hasText: 'Ravi Kumar' }).waitFor({ timeout: 20000 });
  await a.page.locator('.guest-settings summary').click();
  await a.page.getByRole('switch', { name: 'Guests can join from a browser' }).click();
  await a.page.locator('.guest-url').waitFor({ timeout: 10000 });
  const url = (await a.page.locator('.guest-url').innerText()).trim();

  // Dana joins from a browser
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  g = await ctx.newPage();
  g.on('pageerror', (e: Error) => console.log('[guest pageerror]', e.message));
  await g.goto(url);
  await g.locator('#join-name').fill('Dana Wright');
  await g.getByRole('button', { name: /Join the meeting|Ask to join/ }).click();
  const row = a.page.locator('.room-lobby li', { hasText: 'Dana Wright' });
  await row.waitFor({ timeout: 20000 });
  await row.getByRole('button', { name: 'Admit' }).click();
  await g.locator('.room .tile').first().waitFor({ timeout: 20000 });
  await sleep(800);

  // ------------------------------------------------------------ 1. Raise hand keeps its size
  const tools = async () => g.$$eval('.controls .tool', (els: Element[]) => els.map((e) => {
    const r = e.getBoundingClientRect(); const i = e.querySelector('svg')!.getBoundingClientRect();
    const span = [...e.querySelectorAll('span')].find((x) => x.getClientRects().length)!;
    const s = span.getBoundingClientRect();
    // the label shown fits on one line, whole (no ellipsis)
    return { label: e.getAttribute('aria-label') ?? '', shown: span.textContent, w: Math.round(r.width), h: Math.round(r.height), iconAbove: i.bottom <= s.top + 0.5, spanFits: s.width <= r.width + 0.5 && s.height < 20 && span.scrollWidth <= span.clientWidth + 1 };
  }));
  for (const [vw, vh] of [[1440, 900], [390, 844]] as const) {
    await g.setViewportSize({ width: vw, height: vh });
    await sleep(300);
    const before = await tools();
    await g.getByRole('button', { name: 'Raise hand' }).click();
    await g.locator('.controls .tool.raised').waitFor();
    await sleep(200);
    const after = await tools();
    const hand = after.find((t: any) => t.label === 'Hand up')!;
    const other = after.find((t: any) => t.label.startsWith('React'))!;
    assert.equal(hand.h, other.h, `${vw}px: Hand up is as tall as React (${hand.h} vs ${other.h})`);
    assert.ok(hand.iconAbove && hand.spanFits, `${vw}px: icon above a one-line label ${JSON.stringify(hand)}`);
    assert.ok(Math.abs(hand.w - before.find((t: any) => t.label === 'Raise hand')!.w) <= 1, `${vw}px: same width pressed and not`);
    for (const t of after) assert.ok(t.iconAbove && t.spanFits && t.h === other.h, `${vw}px: ${t.label} keeps the layout ${JSON.stringify(t)}`);
    // every toggle pressed at once: mic off, camera off, chat, hand
    await gBoth(g, `meetui-01-hand-up-${vw}`);
    await g.getByRole('button', { name: 'Hand up' }).click();
    await g.locator('.controls .tool.raised').waitFor({ state: 'detached' });
  }
  for (const label of ['Mic on', 'Camera on']) await g.getByRole('button', { name: label }).click();
  await sleep(300);
  for (const t of await tools()) assert.ok(t.iconAbove && t.spanFits, `390px toggled: ${t.label}`);
  await gShot(g, 'meetui-01-toggles-390');
  for (const label of ['Mic off', 'Camera off']) await g.getByRole('button', { name: label }).click();
  console.log('Raise hand and every toggle keep the toolbar layout at 1440 and 390');

  // ------------------------------------------------------------ 2. growing chat boxes
  await g.setViewportSize({ width: 1440, height: 900 });
  await sleep(300);
  if (!(await g.locator('.room.chat-open').count())) await g.getByRole('button', { name: /^Chat/ }).click();
  const box = g.getByLabel('Message to the meeting');
  const one = (await box.boundingBox())!.height;
  const long = 'The hydrotest pack for line 12-P-1043 has to reach site by Friday COB without fail, and it has to be made clear to the contractor that the spool numbers follow the revised isometrics.';
  await box.fill(long);
  const grown = (await box.boundingBox())!.height;
  assert.ok(grown > one + 30, `the box grows with the text (${one} → ${grown})`);
  assert.equal(await box.evaluate((e: HTMLTextAreaElement) => e.classList.contains('grown')), true);
  await box.press('End');
  await box.press('Shift+Enter');
  await box.pressSequentially('Shift+Enter starts a new line');
  assert.match(await box.inputValue(), /\nShift\+Enter starts a new line$/, 'Shift+Enter is a new line, not a send');
  // an input method choosing a word: Enter is the input method's
  const sentBefore = await g.locator('.chat .line-body').count();
  await box.evaluate((e: HTMLTextAreaElement) => e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
  await sleep(300);
  assert.equal(await g.locator('.chat .line-body').count(), sentBefore, 'not sent while composing');
  await gBoth(g, 'meetui-02-guest-chat-grown-1440');
  // ten more lines: six at most, then it scrolls
  await box.fill(Array.from({ length: 14 }, (_, i) => `Line ${i + 1} of the punch list`).join('\n'));
  const capped = await box.evaluate((e: HTMLTextAreaElement) => ({ h: e.getBoundingClientRect().height, sh: e.scrollHeight, ch: e.clientHeight, oy: getComputedStyle(e).overflowY }));
  assert.ok(capped.h <= 6 * 20 + 20 && capped.sh > capped.ch && capped.oy === 'auto', `six lines, then it scrolls ${JSON.stringify(capped)}`);
  // a half-written line survives a line from someone else (the box used to be rebuilt)
  await box.fill('Half written…');
  await box.focus();
  await a.page.getByRole('tab', { name: /Chat/ }).click();
  const appBox = a.page.getByLabel('Message to everyone in the Room');
  await appBox.fill('Welcome Dana');
  await appBox.press('Enter');
  await g.locator('.chat .line-body', { hasText: 'Welcome Dana' }).waitFor({ timeout: 10000 });
  assert.equal(await box.inputValue(), 'Half written…');
  assert.equal(await g.evaluate(() => (document.activeElement as HTMLElement)?.getAttribute('aria-label')), 'Message to the meeting', 'still focused');
  await box.fill(long);
  await box.press('Enter');
  await g.locator('.chat .line-body', { hasText: 'Friday COB' }).waitFor({ timeout: 10000 });
  assert.equal(await box.inputValue(), '');
  assert.ok(Math.abs((await box.boundingBox())!.height - one) <= 1, 'back to one line after sending');
  await g.setViewportSize({ width: 390, height: 844 });
  await sleep(300);
  await g.getByRole('button', { name: /^Chat/ }).click();
  await box.fill(long);
  await gBoth(g, 'meetui-02-guest-chat-grown-390');
  await box.fill('');
  await g.getByRole('button', { name: 'Close the chat' }).click();
  await g.setViewportSize({ width: 1440, height: 900 });
  // the app's meeting chat
  const appOne = (await appBox.boundingBox())!.height;
  await appBox.fill(long);
  const appGrown = (await appBox.boundingBox())!.height;
  assert.ok(appGrown > appOne + 25, `the app's box grows (${appOne} → ${appGrown})`);
  await both(a.page, 'meetui-03-app-chat-grown');
  await appBox.press('Enter');
  await a.page.locator('.room-chat .meet-chat-body', { hasText: 'Friday COB' }).nth(1).waitFor({ timeout: 10000 });
  assert.ok(Math.abs((await appBox.boundingBox())!.height - appOne) <= 1, 'the app box is one line again');
  console.log('chat boxes grow, scroll after six lines, Enter sends, Shift+Enter and composition do not');

  // ------------------------------------------------------------ 3. markers on a shared screen
  await a.page.getByRole('button', { name: 'Share sheet' }).click();
  await a.page.locator('.screen-option').first().click({ timeout: 15000 });
  await b.page.waitForFunction(() => { const v = document.querySelector('.room-share video') as HTMLVideoElement | null; return !!v && v.videoWidth > 0 && v.currentTime > 0.3; }, null, { timeout: 30000 });
  const display = await a.app.evaluate(({ screen }) => screen.getPrimaryDisplay().bounds);
  let pwin: any = null;
  for (let i = 0; i < 50 && !pwin; i++) { pwin = a.app.windows().find((w: any) => w.url().includes('overlay=pointers')); if (!pwin) await sleep(200); }
  assert.ok(pwin, 'the presenter has the pointer window');
  const picture = () => b.page.evaluate(() => {
    const v = document.querySelector('.room-share video') as HTMLVideoElement;
    const r = v.getBoundingClientRect();
    const s = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
    const w = v.videoWidth * s, h = v.videoHeight * s;
    return { x: r.left + (r.width - w) / 2, y: r.top + (r.height - h) / 2, width: w, height: h };
  });
  const pic = await picture();
  const points = [[0.25, 0.3], [0.8, 0.72], [0.52, 0.11]] as const;
  for (const [i, [fx, fy]] of points.entries()) {
    await b.page.mouse.move(pic.x + 5, pic.y + 5);
    await b.page.keyboard.press('m');
    const cx = Math.round(pic.x + fx * pic.width), cy = Math.round(pic.y + fy * pic.height);
    await b.page.mouse.click(cx, cy);
    await b.page.locator('.room-share .pt-note input').fill(`Point ${i + 1}`);
    await b.page.keyboard.press('Enter');
    // on Ravi's video: exactly where he clicked
    const pin = b.page.locator(`.room-share .pt-pin[data-n="${i + 1}"]`);
    await pin.waitFor({ timeout: 10000 });
    const t = translateOf(await pin.getAttribute('transform'));
    const layer = (await b.page.locator('.room-share .pt-layer').boundingBox())!;
    assert.ok(Math.abs(layer.x + t.x - cx) <= 1 && Math.abs(layer.y + t.y - cy) <= 1, `viewer marker ${i + 1} at ${layer.x + t.x},${layer.y + t.y} vs ${cx},${cy}`);
    // on Priya's own screen: the same spot of the display
    const op = pwin.locator(`.pt-pin[data-n="${i + 1}"]`);
    await op.waitFor({ timeout: 10000 });
    const o = translateOf(await op.getAttribute('transform'));
    const want = { x: ((cx - pic.x) / pic.width) * display.width, y: ((cy - pic.y) / pic.height) * display.height };
    assert.ok(Math.abs(o.x - want.x) <= 1 && Math.abs(o.y - want.y) <= 1, `presenter marker ${i + 1} at ${o.x},${o.y} vs ${want.x},${want.y}`);
  }
  await sleep(300);
  await both(b.page, 'meetui-04-markers-viewer-hi');
  await pwin.screenshot({ path: `${OUT}/meetui-05-markers-presenter-screen.png`, omitBackground: true });
  // the pointer window put somewhere else (as Windows may, at another monitor's scaling): the marks stay on the display
  await a.app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('overlay=pointers'))!; w.setBounds({ x: 40, y: 30, width: 1960 - 40, height: 1000 - 78 }); });
  await sleep(800);
  const [fx0, fy0] = points[0];
  const moved = translateOf(await pwin.locator('.pt-pin[data-n="1"]').getAttribute('transform'));
  const cx0 = Math.round(pic.x + fx0 * pic.width), cy0 = Math.round(pic.y + fy0 * pic.height);
  const want0 = { x: ((cx0 - pic.x) / pic.width) * display.width - 40, y: ((cy0 - pic.y) / pic.height) * display.height - 30 };
  assert.ok(Math.abs(moved.x - want0.x) <= 1 && Math.abs(moved.y - want0.y) <= 1, `after the window moved: ${moved.x},${moved.y} vs ${want0.x},${want0.y}`);
  await a.app.evaluate(({ BrowserWindow, screen }) => { const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('overlay=pointers'))!; w.setBounds(screen.getPrimaryDisplay().bounds); });
  // the presenter clears every mark (for everyone, the pointer window too)
  await a.page.locator('.room-share .pt-tools').getByRole('button', { name: 'Clear all' }).click();
  await b.page.locator('.room-share .pt-pin').first().waitFor({ state: 'detached', timeout: 10000 });
  await pwin.locator('.pt-pin').first().waitFor({ state: 'detached', timeout: 10000 });
  console.log('markers land within 1 px on the viewer and on the presenter\'s screen, wherever the pointer window is');

  // ------------------------------------------------------------ 4. Give control: a guest in a browser asks
  await a.page.evaluate(() => {
    const box = document.createElement('div');
    box.id = 'e2e-target';
    box.style.cssText = 'position:fixed;left:80px;top:560px;z-index:99999;display:grid;padding:10px;background:#fff;border:2px solid #1c7680;border-radius:8px';
    box.innerHTML = '<button id="e2e-btn" style="width:200px;height:70px;font:600 16px sans-serif">Test button · 0</button>';
    document.body.appendChild(box);
    let n = 0;
    document.getElementById('e2e-btn')!.addEventListener('click', () => { n++; (document.getElementById('e2e-btn') as HTMLButtonElement).textContent = `Test button · ${n}`; });
  });
  const btn = await a.page.evaluate(() => { const r = document.getElementById('e2e-btn')!.getBoundingClientRect(); return { x: Math.round(window.screenX + r.left + r.width / 2), y: Math.round(window.screenY + r.top + r.height / 2) }; });
  await g.waitForFunction(() => { const v = document.querySelector('.share video') as HTMLVideoElement | null; return !!v && v.videoWidth > 0 && v.currentTime > 0.3; }, null, { timeout: 30000 });
  const ask = g.locator('.share .ctl-ask');
  await ask.waitFor({ timeout: 15000 });
  await gBoth(g, 'meetui-06-guest-ask-for-control');
  await ask.click();
  assert.match(await ask.innerText(), /Asked for control/);
  const req = a.page.getByRole('dialog', { name: 'Dana Wright asks for control' });
  await req.waitFor({ timeout: 15000 });
  assert.match(await req.innerText(), /GUEST/);
  assert.match(await req.innerText(), /guest from outside the office/);
  await both(a.page, 'meetui-07-guest-request');
  await req.getByRole('button', { name: 'Accept…' }).click();
  const consent = a.page.getByRole('dialog', { name: 'Let Dana Wright use your mouse and keyboard?' });
  await consent.waitFor();
  assert.match(await consent.innerText(), /guest from outside the office/);
  assert.match(await consent.innerText(), /Shift\+Esc/);
  await both(a.page, 'meetui-08-guest-consent');
  await consent.getByRole('button', { name: 'Allow control' }).click();
  await a.page.locator('.sup-banner', { hasText: 'is using your mouse and keyboard' }).waitFor({ timeout: 15000 });
  assert.match(await a.page.locator('.sup-banner').innerText(), /Dana Wright\s*GUEST/);
  const surf = g.locator('.share .ctl-surface');
  await surf.waitFor({ timeout: 15000 });
  assert.match(await surf.innerText(), /You are controlling Priya Raman's screen/);
  // Ravi sees who has it
  await b.page.locator('.room-share .ctl-flag').waitFor({ timeout: 10000 });
  // Dana's pointer over Priya's button on the picture: the real X pointer moves there, and her click clicks it
  const onGuestPicture = (p: { x: number; y: number }) => g.evaluate(({ nx, ny }: { nx: number; ny: number }) => {
    const v = document.querySelector('.share video') as HTMLVideoElement;
    const r = v.getBoundingClientRect();
    const s = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
    const w = v.videoWidth * s, h = v.videoHeight * s;
    return { x: r.left + (r.width - w) / 2 + nx * w, y: r.top + (r.height - h) / 2 + ny * h };
  }, { nx: (p.x + 0.5 - display.x) / display.width, ny: (p.y + 0.5 - display.y) / display.height });
  const at = await onGuestPicture(btn);
  await g.mouse.move(at.x - 40, at.y - 30);
  await g.mouse.move(at.x, at.y, { steps: 6 });
  let xp = xpos();
  for (let i = 0; i < 50 && (Math.abs(xp.x - btn.x) > 3 || Math.abs(xp.y - btn.y) > 3); i++) { await sleep(100); xp = xpos(); }
  assert.ok(Math.abs(xp.x - btn.x) <= 3 && Math.abs(xp.y - btn.y) <= 3, `the X pointer followed Dana onto the button (${xp.x},${xp.y} vs ${btn.x},${btn.y})`);
  await g.mouse.down(); await g.mouse.up();
  await a.page.waitForFunction(() => document.getElementById('e2e-btn')!.textContent === 'Test button · 1', null, { timeout: 10000 });
  console.log('a guest in a browser clicked a button on Priya\'s PC through the gateway');
  await gBoth(g, 'meetui-09-guest-in-control');
  await both(a.page, 'meetui-10-presenter-guest-in-control');
  await g.setViewportSize({ width: 390, height: 844 }); await sleep(300); await gBoth(g, 'meetui-09-guest-in-control-390'); await g.setViewportSize({ width: 1440, height: 900 });
  // Shift+Esc on Priya's keyboard takes it back at once
  execFileSync('xdotool', ['key', 'shift+Escape']);
  await a.page.locator('.sup-banner').waitFor({ state: 'detached', timeout: 10000 });
  await surf.waitFor({ state: 'detached', timeout: 10000 });
  await g.locator('.banner', { hasText: 'Priya Raman took back control' }).waitFor({ timeout: 10000 });
  // her input afterwards goes nowhere
  const still = xpos();
  await g.mouse.move(at.x + 120, at.y + 80, { steps: 4 }); await g.mouse.down(); await g.mouse.up();
  await sleep(800);
  assert.deepEqual(xpos(), still, 'nothing reaches Priya\'s PC after Shift+Esc');
  console.log('Shift+Esc took control back from the guest');

  // ------------------------------------------------------------ app to app, and the guest's item in the person menu
  await a.page.getByRole('tab', { name: /People/ }).click();
  await a.page.locator('.room-schedule tr', { hasText: 'Dana Wright' }).locator('.row-menu').click();
  await a.page.locator('.room-person-menu .ctl-item', { hasText: 'Give control to this guest' }).waitFor({ timeout: 10000 });
  await both(a.page, 'meetui-11-person-menu-guest');
  await a.page.keyboard.press('Escape');
  await a.page.locator('.room-schedule tr', { hasText: 'Ravi Kumar' }).locator('.row-menu').click();
  await a.page.locator('.room-person-menu .ctl-item', { hasText: 'Give control…' }).click();
  await a.page.getByRole('dialog', { name: 'Let Ravi Kumar use your mouse and keyboard?' }).getByRole('button', { name: 'Allow control' }).click();
  const rs = b.page.locator('.room-share .sup-control');
  await rs.waitFor({ timeout: 15000 });
  await g.locator('.share .ctl-flag', { hasText: 'RAVI K. IS CONTROLLING' }).waitFor({ timeout: 10000 });
  const rv = (await picture());
  const rat = { x: rv.x + ((btn.x + 0.5 - display.x) / display.width) * rv.width, y: rv.y + ((btn.y + 0.5 - display.y) / display.height) * rv.height };
  await b.page.mouse.move(rat.x - 30, rat.y - 20);
  await b.page.mouse.move(rat.x, rat.y, { steps: 5 });
  await sleep(500);
  await b.page.mouse.down(); await b.page.mouse.up();
  await a.page.waitForFunction(() => document.getElementById('e2e-btn')!.textContent === 'Test button · 2', null, { timeout: 10000 });
  await both(b.page, 'meetui-12-app-controller-hi');
  await gShot(g, 'meetui-12-guest-sees-controller');
  // stopping the share ends it on its own
  await a.page.locator('.tb-controls').getByRole('button', { name: 'Stop sharing' }).click();
  await rs.waitFor({ state: 'detached', timeout: 10000 });
  await a.page.locator('.sup-banner').waitFor({ state: 'detached', timeout: 10000 });
  console.log('app to app control, and it ended with the share');

  // ------------------------------------------------------------ a screen shared from a browser is view only
  if (await g.evaluate(() => typeof navigator.mediaDevices.getDisplayMedia === 'function')) {
    await g.getByRole('button', { name: 'Share screen' }).click();
    const ok = await g.locator('.share video').waitFor({ timeout: 8000 }).then(() => true, () => false);
    if (ok) {
      await g.locator('.share .share-note', { hasText: 'view only' }).waitFor({ timeout: 5000 });
      await gBoth(g, 'meetui-13-guest-shares-view-only');
      await b.page.locator('.room-share .ctl-flag', { hasText: 'ब्राउज़र' }).waitFor({ timeout: 20000 }); // VIEW ONLY · BROWSER, in Hindi
      assert.equal(await b.page.locator('.room-share .ctl-ask').count(), 0, 'nobody can ask for a browser\'s screen');
      await both(b.page, 'meetui-14-viewer-browser-view-only-hi');
      await g.getByRole('button', { name: 'Stop sharing' }).click();
      console.log('a screen shared from a browser says it is view only');
    } else console.log('NOTE: headless Chromium refused getDisplayMedia; the view-only note was not seen here');
  }

  await sleep(500);
  const audit = (await owner.request('admin.audit', { limit: 200 })).filter((x: any) => x.action.startsWith('meeting.control'));
  const granted = audit.filter((x: any) => x.action === 'meeting.control.granted');
  assert.equal(granted.length, 2);
  assert.ok(granted.some((x: any) => x.detail.guest === true && x.detail.controllerName === 'Dana Wright'), 'the guest grant is audited by name');
  assert.deepEqual(audit.filter((x: any) => x.action === 'meeting.control.revoked').map((x: any) => x.detail.why).sort(), ['sharing stopped', 'stopped']);
  console.log('MEETUI E2E PASSED');
} catch (e) {
  await shot(a.page, 'meetui-FAIL-a').catch(() => {}); await shot(b.page, 'meetui-FAIL-b').catch(() => {}); if (g) await gShot(g, 'meetui-FAIL-g').catch(() => {});
  throw e;
} finally {
  await browser.close().catch(() => {});
  for (const x of [a, b]) await x.app.close().catch(() => {});
  owner.disconnect(); await hub.stop();
  try { process.kill(-gw.pid!, 'SIGTERM'); } catch { /* gone */ }
}
