// Remote support end to end (docs/HELP-DESK.md, "Remote support"): with the office's policies on,
// Ravi (IT) connects to Priya's PC from the Help desk without her accepting. Her app joins with the
// microphone off, shares its main screen and gives control by itself, and says so (dock, banner,
// share bar). Ravi drops files on her screen and they land in her Downloads\Dexterity IT\T-0001.
// Her app reloading (as after a restart) joins the unattended session again by itself. She stops
// control herself; Ravi ends the session; the audit log has the unattended session.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startOffice, launch, shot, sleep } from './harness.mts';

const W = 1000, H = 1000;
const { owner, hub } = await startOffice('unattended');
const a = await launch('priya', 'Priya Raman', { width: W, height: H, realCapture: true });
const b = await launch('ravi', 'Ravi Kumar', { width: W, height: H });
const downloads = fs.mkdtempSync(path.join(import.meta.dirname, 'out', 'dl-priya-'));
try {
  for (const [app, x] of [[a.app, 0], [b.app, W]] as const) {
    await app.evaluate(({ BrowserWindow }, x) => { const w = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('overlay'))!; w.setBounds({ x, y: 0, width: 1000, height: 1000 }); }, x);
  }
  await a.app.evaluate(({ app }, dir) => app.setPath('downloads', dir), downloads);
  const users = (await owner.request('directory.list')).users;
  const ravi = users.find((u: any) => u.account.endsWith('ravi'))!;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  await owner.request('admin.help.staff', { userId: ravi.id, on: true });

  // ---- off by default: no Connect now on the Help desk
  await b.page.locator('.me-btn').click();
  await b.page.getByRole('menuitem', { name: /Help desk/ }).click();
  await b.page.locator('.hd-view').waitFor();
  assert.equal(await b.page.locator('.hd-connect').count(), 0, 'Connect now is hidden while the policy is off');

  // ---- the administrator turns remote support on
  await owner.request('admin.policy.set', { assistUnattended: true, assistClipboard: true, assistFiles: true, assistReconnect: true, assistPrivacy: true });
  const connect = b.page.locator('.hd-connect');
  await connect.waitFor({ timeout: 10000 });
  await shot(b.page, 'unattended-01-desk');
  await connect.locator('select').selectOption(priya.id);
  await connect.getByRole('button', { name: 'Connect now' }).click();
  await b.page.locator('.sup-stage').waitFor({ timeout: 15000 });

  // ---- Priya's app joins, shares and gives control by itself, and says so
  await a.page.locator('.sup-dock .sup-unattended').waitFor({ timeout: 20000 });
  assert.match(await a.page.locator('.sup-unattended').innerText(), /connected without asking/);
  await a.page.locator('.sup-banner', { hasText: 'connected without asking' }).waitFor({ timeout: 20000 });
  assert.equal(await a.page.evaluate(() => document.querySelector('.sup-tools button[aria-pressed]')?.getAttribute('aria-pressed')), 'false', 'her microphone is off');
  const bar = a.app.windows().find((w: any) => w.url().includes('overlay=bar'));
  assert.ok(bar, 'the share bar window is open');
  await bar!.locator('.share-bar', { hasText: 'IT CONNECTED WITHOUT ASKING' }).waitFor({ timeout: 10000 });
  await b.page.locator('.sup-perm.on', { hasText: 'Allowed by Priya' }).waitFor({ timeout: 20000 });
  await b.page.waitForFunction(() => { const v = document.querySelector('.sup-screen video') as HTMLVideoElement | null; return !!v && v.videoWidth > 0; }, null, { timeout: 20000 });
  await shot(a.page, 'unattended-02-priya');
  await shot(b.page, 'unattended-03-ravi');

  // ---- Ravi drops two files on her screen; they land in her Downloads\Dexterity IT\T-0001
  await b.page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['layer settings\n'], 'acad-layers.txt', { type: 'text/plain' }));
    dt.items.add(new File(['plot styles\n'], 'plot.ctb', { type: 'application/octet-stream' }));
    const field = document.querySelector('.sup-field')!;
    for (const type of ['dragover', 'drop']) field.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await a.page.locator('.sup-dropped', { hasText: 'Saved 2 files' }).waitFor({ timeout: 20000 });
  const folder = path.join(downloads, 'Dexterity IT', 'T-0001');
  assert.equal(fs.readFileSync(path.join(folder, 'acad-layers.txt'), 'utf8'), 'layer settings\n');
  assert.ok(fs.existsSync(path.join(folder, 'plot.ctb')));

  // ---- her app reloads (as after a restart): it joins the unattended session again by itself
  await a.page.reload();
  await a.page.locator('.sup-banner', { hasText: 'connected without asking' }).waitFor({ timeout: 40000 });
  await b.page.locator('.sup-perm.on', { hasText: 'Allowed by Priya' }).waitFor({ timeout: 20000 });

  // ---- the privacy screen: Priya sees it on every display, Ravi's picture does not (it is kept out of capture)
  const privacyWindows = () => a.app.evaluate(({ BrowserWindow, screen }) => {
    const ds = screen.getAllDisplays().map((d) => d.bounds);
    return BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.getOpacity() < 1 && ds.some((b) => { const r = w.getBounds(); return r.width === b.width && r.height === b.height; })).length;
  });
  const sample = () => b.page.evaluate(() => {
    const v = document.querySelector('.sup-screen video') as HTMLVideoElement;
    const c = document.createElement('canvas'); c.width = 64; c.height = 36;
    const g = c.getContext('2d')!; g.drawImage(v, 0, 0, 64, 36);
    const d = g.getImageData(0, 0, 64, 36).data;
    let teal = 0;
    // the privacy screen's teal (#132b2e) covering the picture would make nearly every pixel this colour
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 0x13) < 12 && Math.abs(d[i + 1] - 0x2b) < 12 && Math.abs(d[i + 2] - 0x2e) < 12) teal++;
    return teal / (d.length / 4);
  });
  await b.page.getByRole('button', { name: 'Turn the privacy screen on' }).click();
  await b.page.getByRole('button', { name: 'Privacy screen on' }).waitFor({ timeout: 10000 });
  await sleep(1500);
  assert.ok(await privacyWindows() >= 1, 'the privacy screen covers Priya\'s displays');
  await sleep(1500);
  const covered = await sample();
  console.log(`share of Ravi's picture in the privacy screen's colour: ${covered.toFixed(3)}`);
  assert.ok(covered < 0.6, 'Ravi sees the real screen, not the privacy screen');
  await shot(b.page, 'unattended-04-ravi-privacy');
  await b.page.getByRole('button', { name: 'Privacy screen on' }).click();
  await b.page.getByRole('button', { name: 'Turn the privacy screen on' }).waitFor({ timeout: 10000 });
  await sleep(1000);
  assert.equal(await privacyWindows(), 0, 'the privacy screen is gone when IT turns it off');

  // ---- she can always stop it
  await a.page.locator('.sup-banner').getByRole('button', { name: 'Stop control' }).click();
  await a.page.locator('.sup-banner').waitFor({ state: 'detached', timeout: 10000 });
  await b.page.locator('.sup-perm', { hasText: 'Not allowed' }).waitFor({ timeout: 10000 });
  await sleep(2500);
  assert.equal(await a.page.locator('.sup-banner').count(), 0, 'control is not given again by itself after she stops it');

  // ---- Ravi ends the session; the audit log has it
  await b.page.locator('.sup-tools').getByRole('button', { name: 'End session' }).click();
  await a.page.getByRole('dialog', { name: 'How did it go?' }).waitFor({ timeout: 15000 });
  await sleep(500);
  const audit = (await owner.request('admin.audit', { limit: 200 })).map((x: any) => x.action);
  for (const want of ['policy.set', 'help.unattended.started', 'help.consent.granted', 'help.files.dropped', 'help.consent.revoked', 'help.unattended.ended']) assert.ok(audit.includes(want), want);
  console.log('UNATTENDED E2E PASSED');
} catch (e) { await shot(a.page, 'unattended-FAIL-a').catch(() => {}); await shot(b.page, 'unattended-FAIL-b').catch(() => {}); throw e; } finally {
  await a.app.close().catch(() => {}); await b.app.close().catch(() => {}); owner.disconnect(); await hub.stop();
  fs.rmSync(downloads, { recursive: true, force: true });
}
