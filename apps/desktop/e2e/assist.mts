// Help desk end to end on one X display (xvfb): Priya asks for help, Ravi (IT) takes it and opens
// a support session, Priya shares her whole screen and allows control, and Ravi's pointer and
// keys, sent over the session's data channel, are injected on Priya's PC by xdotool: they move
// the real X pointer, click a test button in Priya's own window and type into a field there.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { startOffice, launch, shot, sleep } from './harness.mts';

const W = 1000, H = 1000;
const { owner, hub } = await startOffice('assist');
// Priya's PC captures the real X screen (no fake capture device): Ravi sees her actual screen
const a = await launch('priya', 'Priya Raman', { width: W, height: H, realCapture: true });
const b = await launch('ravi', 'Ravi Kumar', { width: W, height: H });
const xpos = () => { const m = execFileSync('xdotool', ['getmouselocation']).toString().match(/x:(\d+) y:(\d+)/)!; return { x: Number(m[1]), y: Number(m[2]) }; };
const theme = (p: any, t: 'light' | 'dark') => p.evaluate((x: string) => { document.documentElement.dataset.theme = x; }, t);
const both = async (p: any, name: string) => { await theme(p, 'light'); await sleep(150); await shot(p, `${name}-light`); await theme(p, 'dark'); await sleep(150); await shot(p, `${name}-dark`); await theme(p, 'light'); };
try {
  // the two app windows side by side on the 2000x1000 screen
  for (const [app, x] of [[a.app, 0], [b.app, W]] as const) {
    await app.evaluate(({ BrowserWindow }, x) => { const w = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('overlay'))!; w.setBounds({ x, y: 0, width: 1000, height: 1000 }); }, x);
  }
  await sleep(500);
  const users = (await owner.request('directory.list')).users;
  const ravi = users.find((u: any) => u.account.endsWith('ravi'))!;
  await owner.request('admin.help.staff', { userId: ravi.id, on: true });

  // ---- Priya asks for help from her tile menu
  await a.page.locator('.me-btn').click();
  await a.page.getByRole('menuitem', { name: 'Help me…' }).click();
  const dlg = a.page.getByRole('dialog', { name: 'Ask IT for help' });
  await dlg.waitFor();
  await dlg.getByLabel('What is wrong?').fill('The plotter will not print A1 sheets');
  await dlg.getByRole('radio', { name: /Printing and plotting/ }).click();
  await dlg.getByLabel(/Details/).fill('The HP plotter on the 2nd floor shows a paper error since this morning.');
  await dlg.getByRole('button', { name: 'Add a picture of my screen' }).click();
  await dlg.locator('.hm-thumb img').waitFor({ timeout: 15000 });
  await both(a.page, 'assist-01-help-me');
  await dlg.getByRole('button', { name: 'Send to IT' }).click();
  await a.page.getByRole('dialog', { name: 'Sent to the IT desk' }).waitFor();
  assert.match(await a.page.locator('.hm-ref').innerText(), /T-0001/);
  await shot(a.page, 'assist-02-sent');
  await a.page.getByRole('button', { name: 'Done' }).click();

  // ---- Ravi sees it in the Help desk queue, takes it, starts a session
  await b.page.locator('.me-btn').click();
  await b.page.getByRole('menuitem', { name: /Help desk/ }).click();
  const row = b.page.locator('.hd-table tr', { hasText: 'The plotter will not print A1 sheets' });
  await row.waitFor({ timeout: 10000 });
  await row.click();
  await b.page.locator('.hd-ticket h2', { hasText: 'plotter' }).waitFor();
  await b.page.locator('.hd-shot').waitFor({ timeout: 10000 });
  await both(b.page, 'assist-03-it-queue');
  await b.page.getByRole('button', { name: 'Take it' }).click();
  await b.page.getByRole('button', { name: 'Start a support session' }).click();
  await b.page.locator('.sup-stage').waitFor({ timeout: 15000 });

  // ---- Priya is told and joins
  const card = a.page.locator('.hd-invite');
  await card.waitFor({ timeout: 15000 });
  assert.match(await card.innerText(), /Ravi Kumar from IT is ready to help/);
  await shot(a.page, 'assist-04-invite');
  await card.getByRole('button', { name: 'Join the session' }).click();
  await a.page.locator('.sup-dock').waitFor({ timeout: 15000 });

  // ---- Ravi asks to see the screen; Priya chooses the whole screen
  await b.page.locator('.sup-empty').getByRole('button', { name: 'Ask to see their screen' }).click();
  await a.page.locator('.sup-ask').waitFor({ timeout: 10000 });
  await a.page.locator('.sup-ask').getByRole('button', { name: 'Choose' }).click();
  const sc = a.page.getByRole('dialog', { name: 'Share your screen with Ravi Kumar?' });
  await sc.waitFor();
  await sc.locator('.cs-source').first().waitFor({ timeout: 15000 });
  await both(a.page, 'assist-05-consent-screen');
  await sc.locator('.cs-source').first().click();
  await sc.getByRole('button', { name: 'Share this screen' }).click();
  await a.page.locator('.sup-perm.on', { hasText: 'sees your screen' }).waitFor({ timeout: 15000 });
  await b.page.locator('.sup-screen video').waitFor({ timeout: 20000 });
  await b.page.waitForFunction(() => { const v = document.querySelector('.sup-screen video') as HTMLVideoElement | null; return !!v && v.videoWidth > 0 && v.currentTime > 0.3; }, null, { timeout: 20000 });
  // the share bar sits on Priya's screen above everything
  const bar = a.app.windows().find((w: any) => w.url().includes('overlay=bar'));
  assert.ok(bar, 'the share bar window is open');
  await bar.locator('.share-bar').waitFor({ timeout: 10000 });
  assert.match(await bar.locator('.share-bar').innerText(), /Sharing your screen with Ravi Kumar/);
  await bar.screenshot({ path: `${import.meta.dirname}/out/assist-06-share-bar.png` });

  // ---- Ravi asks for control; Priya allows it in a second, separate sheet
  await b.page.locator('.sup-perm', { hasText: 'Control' }).getByRole('button', { name: 'Ask' }).click();
  await a.page.locator('.sup-ask', { hasText: 'mouse and keyboard' }).getByRole('button', { name: 'Choose' }).click({ timeout: 10000 });
  const cc = a.page.getByRole('dialog', { name: 'Let Ravi Kumar use your mouse and keyboard?' });
  await cc.waitFor();
  await both(a.page, 'assist-07-consent-control');
  await cc.getByRole('button', { name: 'Allow control' }).click();
  await a.page.locator('.sup-banner').waitFor({ timeout: 15000 });
  await b.page.getByRole('button', { name: 'Use their mouse and keyboard' }).click();
  await b.page.locator('.sup-control').waitFor();

  // a test button and field in Priya's own window
  await a.page.evaluate(() => {
    const box = document.createElement('div');
    box.id = 'e2e-target';
    box.style.cssText = 'position:fixed;left:80px;top:520px;z-index:99999;display:grid;gap:8px;padding:10px;background:#fff;border:2px solid #1c7680;border-radius:8px';
    box.innerHTML = '<button id="e2e-btn" style="width:180px;height:60px;font:600 16px sans-serif">Test button · 0</button><input id="e2e-in" style="width:180px;height:30px;font:15px monospace" placeholder="typed here">';
    document.body.appendChild(box);
    let n = 0;
    document.getElementById('e2e-btn')!.addEventListener('click', () => { n++; (document.getElementById('e2e-btn') as HTMLButtonElement).textContent = `Test button · ${n}`; });
  });
  await sleep(1200); // the next frames of the shared screen show it
  const target = async (sel: string) => a.page.evaluate((s: string) => { const r = document.querySelector(s)!.getBoundingClientRect(); return { x: window.screenX + r.left + r.width / 2, y: window.screenY + r.top + r.height / 2 }; }, sel);
  const screen = await a.app.evaluate(({ screen }) => screen.getPrimaryDisplay().bounds);
  // where a point of Priya's screen is on Ravi's picture of it
  const onPicture = (p: { x: number; y: number }) => b.page.evaluate(({ nx, ny }: { nx: number; ny: number }) => {
    const v = document.querySelector('.sup-screen video') as HTMLVideoElement;
    const r = v.getBoundingClientRect();
    const s = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
    const w = v.videoWidth * s, h = v.videoHeight * s;
    return { x: r.left + (r.width - w) / 2 + nx * w, y: r.top + (r.height - h) / 2 + ny * h };
  }, { nx: (p.x - screen.x) / (screen.width - 1), ny: (p.y - screen.y) / (screen.height - 1) });

  const btn = await target('#e2e-btn');
  const at = await onPicture(btn);
  await b.page.mouse.move(at.x - 40, at.y - 30);
  await b.page.mouse.move(at.x, at.y, { steps: 6 });
  for (let i = 0; i < 40; i++) { const p = xpos(); if (Math.abs(p.x - btn.x) <= 3 && Math.abs(p.y - btn.y) <= 3) break; await sleep(100); }
  const moved = xpos();
  assert.ok(Math.abs(moved.x - btn.x) <= 3 && Math.abs(moved.y - btn.y) <= 3, `the X pointer is on the button (${moved.x},${moved.y} vs ${btn.x},${btn.y})`);
  await b.page.mouse.down();
  await b.page.mouse.up();
  await a.page.waitForFunction(() => document.getElementById('e2e-btn')!.textContent === 'Test button · 1', null, { timeout: 10000 });
  console.log('clicked the button on Priya\'s PC through injection');
  // typing: click the field, then keys
  const field = await onPicture(await target('#e2e-in'));
  await b.page.mouse.move(field.x, field.y, { steps: 4 });
  await sleep(300);
  await b.page.mouse.down();
  await b.page.mouse.up();
  await sleep(400);
  await b.page.keyboard.type('a1 plot', { delay: 40 });
  await a.page.waitForFunction(() => (document.getElementById('e2e-in') as HTMLInputElement).value === 'a1 plot', null, { timeout: 10000 })
    .catch(async (e: Error) => { console.log('field value:', await a.page.evaluate(() => (document.getElementById('e2e-in') as HTMLInputElement).value)); throw e; });
  console.log('typed into Priya\'s field through injection');
  await sleep(600);
  await both(a.page, 'assist-08-session-requester');
  await both(b.page, 'assist-09-session-technician');
  const barNow = a.app.windows().find((w: any) => w.url().includes('overlay=bar'));
  await barNow.locator('.share-bar.control').waitFor({ timeout: 5000 });
  await barNow.screenshot({ path: `${import.meta.dirname}/out/assist-10-share-bar-control.png` });

  // ---- Priya takes control back with the stop keys, even while control is active
  execFileSync('xdotool', ['key', 'ctrl+alt+shift+s']);
  await a.page.locator('.sup-banner').waitFor({ state: 'detached', timeout: 10000 });
  await b.page.locator('.sup-control').waitFor({ state: 'detached', timeout: 10000 });
  // nothing reaches her PC any more
  const before = xpos();
  await b.page.mouse.move(at.x + 120, at.y + 80, { steps: 5 });
  await sleep(800);
  const after = xpos();
  assert.deepEqual(after, before, 'no input after control was taken back');

  // ---- diagnostics: Priya sees everything first
  await a.page.locator('.sup-tools').getByRole('button', { name: 'Diagnostics' }).click();
  const dg = a.page.getByRole('dialog', { name: 'Send diagnostics to IT' });
  await dg.locator('.dg-grid').waitFor({ timeout: 20000 });
  await both(a.page, 'assist-11-diagnostics');
  await dg.getByRole('button', { name: /Send to T-0001/ }).click();
  await b.page.locator('.sup-stage .hd-file', { hasText: 'diagnostics-T-0001' }).waitFor({ timeout: 15000 });

  // ---- a file from Ravi to Priya, inside the session
  const fs = await import('node:fs');
  const tmp = `${import.meta.dirname}/out/acad-reset.txt`;
  fs.writeFileSync(tmp, 'reset the plotter queue\n'.repeat(2000));
  const chooser = b.page.waitForEvent('filechooser');
  await b.page.locator('.sup-tools').getByRole('button', { name: 'Send a file' }).click();
  await (await chooser).setFiles(tmp);
  await a.page.locator('.sup-dock .hd-file', { hasText: 'acad-reset.txt' }).waitFor({ timeout: 15000 });

  // ---- the session ends; Priya rates it and closes the ticket
  await b.page.locator('.sup-tools').getByRole('button', { name: 'End session' }).click();
  const rate = a.page.getByRole('dialog', { name: 'How did it go?' });
  await rate.waitFor({ timeout: 15000 });
  await rate.getByRole('radio').nth(4).click();
  await shot(a.page, 'assist-12-rate');
  await rate.getByRole('button', { name: /Solved/ }).click();
  await sleep(800);
  const t = (await owner.request('admin.audit', { limit: 100 })).filter((x: any) => x.action.startsWith('help.'));
  const actions = t.map((x: any) => x.action);
  for (const want of ['help.opened', 'help.taken', 'help.session.started', 'help.consent.granted', 'help.consent.revoked', 'help.diagnostics', 'help.session.ended', 'help.closed']) assert.ok(actions.includes(want), want);
  const ctl = t.find((x: any) => x.action === 'help.consent.revoked' && x.detail.kind === 'control');
  assert.ok(ctl.detail.durationMs > 0, 'how long control was given');
  console.log('ASSIST E2E PASSED');
} catch (e) { await shot(a.page, 'assist-FAIL-a').catch(() => {}); await shot(b.page, 'assist-FAIL-b').catch(() => {}); throw e; } finally { await a.app.close().catch(() => {}); await b.app.close().catch(() => {}); owner.disconnect(); await hub.stop(); }
