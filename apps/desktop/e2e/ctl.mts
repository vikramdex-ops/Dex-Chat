// "Give control" in a meeting, end to end on one X display (xvfb) with xdotool: Priya starts a
// meeting with Ravi, shares her whole screen and gives Ravi control from his person menu (after
// the consent sheet). Ravi's pointer and clicks on her shared screen travel over the Room's data
// channel and are injected on Priya's PC by xdotool: the real X pointer moves and a button in
// Priya's own window is clicked. Stop on the banner ends it, and input after Stop is ignored (from
// Ravi's surface, through the hub, and straight into Priya's main process). Then Ravi asks for
// control, Priya accepts, and the stop keys end it; then stopping the share ends it on its own.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { startOffice, launch, shot, sleep, OUT } from './harness.mts';

const W = 1000, H = 1000;
const { owner, hub } = await startOffice('ctl');
const a = await launch('priya', 'Priya Raman', { width: W, height: H });
const b = await launch('ravi', 'Ravi Kumar', { width: W, height: H });
const xpos = () => { const m = execFileSync('xdotool', ['getmouselocation']).toString().match(/x:(\d+) y:(\d+)/)!; return { x: Number(m[1]), y: Number(m[2]) }; };
const theme = (p: any, t: 'light' | 'dark') => p.evaluate((x: string) => { document.documentElement.dataset.theme = x; }, t);
const both = async (p: any, name: string) => { await theme(p, 'light'); await sleep(200); await shot(p, `${name}-light`); await theme(p, 'dark'); await sleep(200); await shot(p, `${name}-dark`); await theme(p, 'light'); };
const shotsOf = (el: any, name: string) => el.screenshot({ path: `${OUT}/${name}.png` });
try {
  for (const [app, x] of [[a.app, 0], [b.app, W]] as const) {
    await app.evaluate(({ BrowserWindow }, x) => { const w = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('overlay'))!; w.setBounds({ x, y: 0, width: 1000, height: 1000 }); }, x);
  }
  await sleep(500);
  const users = (await owner.request('directory.list')).users;
  const ravi = users.find((u: any) => u.account.endsWith('ravi'))!;

  // ---- Priya starts a meeting and rings Ravi; he joins
  await a.page.locator('.lens-bar .lens', { hasText: 'Meet' }).click();
  await a.page.getByLabel('Meeting title').fill('Pump skid model review');
  await a.page.getByLabel('Ring people in').fill('ravi');
  await a.page.locator('.meet-suggest button', { hasText: 'Ravi Kumar' }).click();
  await a.page.getByRole('button', { name: 'Start meeting' }).click();
  await a.page.getByRole('button', { name: 'Leave Room' }).waitFor({ timeout: 20000 });
  const banner = b.page.locator('.room-banner');
  await banner.waitFor({ timeout: 20000 });
  await banner.getByRole('button', { name: 'Join with voice' }).click();
  await b.page.getByRole('button', { name: 'Leave Room' }).waitFor({ timeout: 20000 });
  await a.page.locator('.room-schedule tr', { hasText: 'Ravi Kumar' }).waitFor({ timeout: 15000 });

  // before sharing, nobody is offered control
  await a.page.locator('.room-schedule tr', { hasText: 'Ravi Kumar' }).locator('.row-menu').click();
  await a.page.locator('.room-person-menu').waitFor();
  assert.equal(await a.page.locator('.room-person-menu .ctl-item').count(), 0, 'not offered before sharing');
  await a.page.keyboard.press('Escape');
  await a.page.locator('.room-person-menu').waitFor({ state: 'detached' }).catch(() => {});

  // ---- Priya shares her whole screen
  await a.page.getByRole('button', { name: 'Share sheet' }).click();
  await a.page.locator('.screen-option').first().click({ timeout: 15000 });
  await b.page.locator('.room-field.layout-presentation .room-share video').waitFor({ timeout: 20000 });
  await b.page.waitForFunction(() => { const v = document.querySelector('.room-share video') as HTMLVideoElement | null; return !!v && v.videoWidth > 0 && v.currentTime > 0.3; }, null, { timeout: 20000 });
  // the Room hears that this screen can be controlled
  await a.page.waitForFunction(async () => { const r = (await (window as any).dex.request('room.list'))[0]; return r.participants.some((p: any) => p.screen && p.controllable); }, null, { timeout: 15000 });
  // Ravi (desktop app) sees Ask for control; Priya's own view has none
  await b.page.locator('.room-share .ctl-ask', { hasText: 'Ask for control' }).waitFor({ timeout: 10000 });
  assert.equal(await a.page.locator('.room-share .ctl-ask').count(), 0);

  // ---- Give control from Ravi's person menu (only the sharer has it), then the consent sheet
  await b.page.locator('.room-schedule tr', { hasText: 'Priya Raman' }).locator('.row-menu').click();
  await b.page.locator('.room-person-menu').waitFor();
  assert.equal(await b.page.locator('.room-person-menu .ctl-item').count(), 0, 'Ravi is not sharing: no Give control');
  await b.page.keyboard.press('Escape');
  await a.page.locator('.room-schedule tr', { hasText: 'Ravi Kumar' }).locator('.row-menu').click();
  const item = a.page.locator('.room-person-menu .ctl-item', { hasText: 'Give control' });
  await item.waitFor({ timeout: 10000 });
  await both(a.page, 'ctl-01-person-menu');
  await item.click();
  const consent = a.page.getByRole('dialog', { name: 'Let Ravi Kumar use your mouse and keyboard?' });
  await consent.waitFor();
  await both(a.page, 'ctl-02-consent');
  await consent.getByRole('button', { name: 'Allow control' }).click();

  // ---- while control is on: Priya's banner with a big Stop, the share bar on top; Ravi's surface
  await a.page.locator('.sup-banner', { hasText: 'Ravi Kumar is using your mouse and keyboard' }).waitFor({ timeout: 15000 });
  const surface = b.page.locator('.room-share .sup-control');
  await surface.waitFor({ timeout: 15000 });
  assert.match(await surface.locator('.sup-control-tag').innerText(), /You are controlling Priya Raman's screen/);
  let bar: any = null;
  for (let i = 0; i < 50 && !bar; i++) { bar = a.app.windows().find((w: any) => w.url().includes('overlay=bar')); if (!bar) await sleep(200); }
  assert.ok(bar, 'the share bar window is open while control is on');
  await bar.locator('.share-bar.control').waitFor({ timeout: 10000 });
  assert.match(await bar.locator('.share-bar').innerText(), /Ravi Kumar is using your mouse and keyboard/);
  await shotsOf(bar, 'ctl-05-share-bar-control');

  // a test button in Priya's own window
  await a.page.evaluate(() => {
    const box = document.createElement('div');
    box.id = 'e2e-target';
    box.style.cssText = 'position:fixed;left:80px;top:560px;z-index:99999;display:grid;gap:8px;padding:10px;background:#fff;border:2px solid #1c7680;border-radius:8px';
    box.innerHTML = '<button id="e2e-btn" style="width:200px;height:70px;font:600 16px sans-serif">Test button · 0</button>';
    document.body.appendChild(box);
    let n = 0;
    document.getElementById('e2e-btn')!.addEventListener('click', () => { n++; (document.getElementById('e2e-btn') as HTMLButtonElement).textContent = `Test button · ${n}`; });
  });
  const target = async (sel: string) => a.page.evaluate((s: string) => { const r = document.querySelector(s)!.getBoundingClientRect(); return { x: window.screenX + r.left + r.width / 2, y: window.screenY + r.top + r.height / 2 }; }, sel);
  const screen = await a.app.evaluate(({ screen }) => screen.getPrimaryDisplay().bounds);
  const onPicture = (p: { x: number; y: number }) => b.page.evaluate(({ nx, ny }: { nx: number; ny: number }) => {
    const v = document.querySelector('.room-share video') as HTMLVideoElement;
    const r = v.getBoundingClientRect();
    const s = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
    const w = v.videoWidth * s, h = v.videoHeight * s;
    return { x: r.left + (r.width - w) / 2 + nx * w, y: r.top + (r.height - h) / 2 + ny * h };
  }, { nx: (p.x - screen.x) / (screen.width - 1), ny: (p.y - screen.y) / (screen.height - 1) });
  const pointerOn = async (want: { x: number; y: number }) => {
    for (let i = 0; i < 40; i++) { const p = xpos(); if (Math.abs(p.x - want.x) <= 4 && Math.abs(p.y - want.y) <= 4) return p; await sleep(100); }
    return xpos();
  };

  const btn = await target('#e2e-btn');
  const at = await onPicture(btn);
  await b.page.mouse.move(at.x - 40, at.y - 30);
  await b.page.mouse.move(at.x, at.y, { steps: 6 });
  const moved = await pointerOn(btn);
  assert.ok(Math.abs(moved.x - btn.x) <= 4 && Math.abs(moved.y - btn.y) <= 4, `the X pointer is on the button (${moved.x},${moved.y} vs ${btn.x},${btn.y})`);
  console.log('the real pointer followed Ravi onto Priya\'s button');
  await b.page.mouse.down();
  await b.page.mouse.up();
  await a.page.waitForFunction(() => document.getElementById('e2e-btn')!.textContent === 'Test button · 1', null, { timeout: 10000 });
  console.log('clicked the button in Priya\'s window through injection');
  await b.page.mouse.move(at.x + 60, at.y + 90, { steps: 4 });
  await sleep(500);
  await both(a.page, 'ctl-03-presenter-banner');
  await both(b.page, 'ctl-04-controller');

  // ---- Stop on the banner ends it; input after Stop is ignored
  await a.page.locator('.sup-banner').getByRole('button', { name: 'Stop control' }).click();
  await a.page.locator('.sup-banner').waitFor({ state: 'detached', timeout: 10000 });
  await surface.waitFor({ state: 'detached', timeout: 10000 });
  await b.page.locator('.toast', { hasText: 'Priya Raman took back control' }).first().waitFor({ timeout: 10000 });
  assert.ok(!a.app.windows().some((w: any) => w.url().includes('overlay=bar') && !w.isClosed()), 'the share bar is gone with control');
  const roomId = (await a.page.evaluate(() => (window as any).dex.request('room.list')))[0].id;
  const raviDev = (await b.page.evaluate(() => (window as any).dex.request('room.list')))[0].participants.find((p: any) => p.userId === ravi.id).deviceId;
  const before = xpos();
  // Ravi's pointer over the picture: no surface, nothing sent
  await b.page.mouse.move(at.x + 150, at.y - 120, { steps: 5 });
  await b.page.mouse.down(); await b.page.mouse.up();
  // input sent anyway through the hub is dropped there
  const viaHub = await b.page.evaluate(({ roomId }: { roomId: string }) => (window as any).dex.request('room.data', { roomId, data: { k: 'in', e: [{ t: 'move', x: 0.9, y: 0.9 }, { t: 'button', b: 'left', down: true, x: 0.9, y: 0.9 }] } }), { roomId });
  assert.deepEqual(viaHub, { ok: true, dropped: true });
  // and input handed to Priya's main process as if it came from Ravi is ignored there (control is off)
  await a.page.evaluate(({ dev }: { dev: string }) => (window as any).dex.assist.input({ k: 'in', e: [{ t: 'move', x: 0.95, y: 0.95 }] }, dev), { dev: raviDev });
  await sleep(1000);
  assert.deepEqual(xpos(), before, 'no input reaches Priya\'s PC after Stop');
  assert.equal(await a.page.locator('#e2e-btn').innerText(), 'Test button · 1');
  console.log('input after Stop is ignored');

  // ---- Ravi asks for control; Priya sees the request, accepts, consents; the stop keys end it
  await a.page.evaluate(() => { document.getElementById('e2e-target')!.style.display = 'none'; });
  await both(b.page, 'ctl-07-ask-for-control');
  await b.page.locator('.room-share .ctl-ask').click();
  const req = a.page.getByRole('dialog', { name: 'Ravi Kumar asks for control' });
  await req.waitFor({ timeout: 10000 });
  await both(a.page, 'ctl-06-request');
  await req.getByRole('button', { name: 'Accept…' }).click();
  await consent.waitFor();
  await consent.getByRole('button', { name: 'Allow control' }).click();
  await surface.waitFor({ timeout: 15000 });
  await a.page.evaluate(() => { document.getElementById('e2e-target')!.style.display = 'grid'; });
  await sleep(300);
  // someone other than the person given control is ignored on Priya's side (a made-up device)
  const before2 = xpos();
  await a.page.evaluate(() => (window as any).dex.assist.input({ k: 'in', e: [{ t: 'move', x: 0.97, y: 0.03 }] }, 'SOMEONE-ELSE'));
  await sleep(600);
  assert.deepEqual(xpos(), before2, 'input from another device is ignored');
  // Ravi clicks the button again
  await b.page.mouse.move(at.x, at.y, { steps: 5 });
  await pointerOn(btn);
  await b.page.mouse.down(); await b.page.mouse.up();
  await a.page.waitForFunction(() => document.getElementById('e2e-btn')!.textContent === 'Test button · 2', null, { timeout: 10000 });
  execFileSync('xdotool', ['key', 'ctrl+alt+shift+s']);
  await a.page.locator('.sup-banner').waitFor({ state: 'detached', timeout: 10000 });
  await surface.waitFor({ state: 'detached', timeout: 10000 });
  console.log('the stop keys ended control');

  // ---- with control on, stopping the share ends it on its own
  await a.page.locator('.room-schedule tr', { hasText: 'Ravi Kumar' }).locator('.row-menu').click();
  await a.page.locator('.room-person-menu .ctl-item', { hasText: 'Give control' }).click();
  await consent.getByRole('button', { name: 'Allow control' }).click();
  await surface.waitFor({ timeout: 15000 });
  await a.page.locator('.tb-controls').getByRole('button', { name: 'Stop sharing' }).click();
  await surface.waitFor({ state: 'detached', timeout: 10000 });
  await a.page.locator('.sup-banner').waitFor({ state: 'detached', timeout: 10000 });
  await b.page.locator('.toast', { hasText: 'Control ended: Priya Raman stopped sharing' }).first().waitFor({ timeout: 10000 });
  console.log('stopping the share ended control');

  await sleep(500);
  const audit = (await owner.request('admin.audit', { limit: 100 })).filter((x: any) => x.action.startsWith('meeting.control'));
  const granted = audit.filter((x: any) => x.action === 'meeting.control.granted');
  const revoked = audit.filter((x: any) => x.action === 'meeting.control.revoked');
  assert.equal(granted.length, 3);
  assert.deepEqual(revoked.map((x: any) => x.detail.why).sort(), ['sharing stopped', 'stopped', 'stopped']);
  assert.ok(revoked.every((x: any) => x.detail.durationMs > 0 && x.detail.controller === ravi.id), 'who and how long');
  console.log('CTL E2E PASSED');
} catch (e) { await shot(a.page, 'ctl-FAIL-a').catch(() => {}); await shot(b.page, 'ctl-FAIL-b').catch(() => {}); throw e; } finally { await a.app.close().catch(() => {}); await b.app.close().catch(() => {}); owner.disconnect(); await hub.stop(); }
