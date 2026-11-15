import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { startOffice, launch, shot, sleep, OUT } from './harness.mts';
import { fileURLToPath as rootPath } from 'node:url';
const ROOT = rootPath(new URL('../../../', import.meta.url));
const require = (await import('node:module')).createRequire(path.join(ROOT, 'package.json'));
const qrcode = require('qrcode-generator');
const { owner, hub } = await startOffice('pair');
const { app, page } = await launch('priya', 'Priya Raman');
let laptop: any = null; let cam: any = null;
try {
  // Priya adds her laptop from Preferences
  await page.keyboard.press('Control+,');
  await page.getByRole('heading', { name: 'Your devices' }).waitFor();
  await page.getByRole('button', { name: 'Add my laptop' }).click();
  const code = await page.getByLabel('Pairing code').inputValue();
  assert.match(code, /^DXP1-/);
  await shot(page, 'pair-01-laptop-code');
  await page.getByRole('button', { name: 'Copy code' }).click();
  // a laptop at home: no hub on its network; the app offers pairing and finds the copied code
  laptop = await launch('home', 'Home User', { noJoin: true });
  const lp = laptop.page;
  // the copied code is picked up by itself and the screen switches to pairing
  await lp.getByText('Found on your clipboard.').waitFor({ timeout: 20000 });
  assert.equal(await lp.locator('#pair-code').inputValue(), code);
  await shot(lp, 'pair-02-laptop-welcome');
  await lp.getByRole('button', { name: 'Pair this laptop' }).click();
  await lp.locator('.frame').waitFor({ timeout: 20000 });
  // it is Priya, without anyone approving it
  const meName = await lp.evaluate(() => window.dex.getState().then((s: any) => s.session?.me.displayName ?? s.me?.displayName));
  assert.equal(meName, 'Priya Raman');
  // Priya's PC shows it at once
  await page.locator('.pair-done', { hasText: 'is ready' }).waitFor({ timeout: 8000 });
  await shot(page, 'pair-03-done');
  await page.getByRole('button', { name: 'Done' }).click();
  await page.locator('.device-tile').nth(1).waitFor();
  assert.equal(await page.locator('.device-tile').count(), 2);
  await shot(page, 'pair-04-devices');
  // the same code again is refused
  const codeAgain = code;
  // removing the laptop signs it out
  const tile = page.locator('.device-tile').filter({ hasNot: page.locator('.chip', { hasText: 'This one' }) });
  await tile.getByRole('button', { name: /^Remove/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click();
  await lp.getByText('This device was removed from your account.').waitFor({ timeout: 10000 });
  await shot(lp, 'pair-05-removed');
  // a laptop with a webcam scans the QR code instead of pasting
  await page.getByRole('button', { name: 'Add my laptop' }).click();
  const code2 = await page.getByLabel('Pairing code').inputValue();
  assert.notEqual(code2, codeAgain);
  const q = qrcode(0, 'M'); q.addData(`https://dexterity-admin.github.io/dexterity-connect/get/#${code2}`); q.make();
  const png = path.join(OUT, 'pair-qr.pgm');
  const fs = await import('node:fs');
  const n = q.getModuleCount(), cell = 10, m = 4, size = (n + 2 * m) * cell;
  const px = Buffer.alloc(size * size, 255);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) for (let y = 0; y < cell; y++) px.fill(0, ((r + m) * cell + y) * size + (c + m) * cell, ((r + m) * cell + y) * size + (c + m + 1) * cell);
  fs.writeFileSync(png, Buffer.concat([Buffer.from(`P5\n${size} ${size}\n255\n`), px]));
  const y4m = path.join(OUT, 'pair-qr.y4m');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-i', png, '-vf', 'scale=640:640,pad=960:720:160:40:white,format=yuv420p', '-t', '2', '-r', '10', y4m]);
  // the earlier code is still on the clipboard: clear it first, or the new app (rightly) offers to pair with it
  execFileSync('bash', ['-c', 'printf "nothing here" | xclip -selection clipboard 2>/dev/null || true']);
  cam = await launch('home2', 'Home Two', { noJoin: true, video: y4m });
  const cp = cam.page;
  await cp.evaluate(() => navigator.clipboard.writeText('nothing here'));
  const haveCode = cp.getByRole('button', { name: 'I have a pairing code' });
  const scan = cp.getByRole('button', { name: "Scan the QR code with this laptop's camera" });
  await haveCode.or(scan).first().waitFor({ timeout: 20000 });
  if (await haveCode.isVisible()) await haveCode.click();
  await cp.getByRole('button', { name: "Scan the QR code with this laptop's camera" }).click();
  await cp.locator('.frame').waitFor({ timeout: 25000 });
  const n2 = await cp.evaluate(() => window.dex.getState().then((s: any) => s.session?.me.displayName ?? s.me?.displayName));
  assert.equal(n2, 'Priya Raman');
  await shot(cp, 'pair-06-scanned');
  console.log('PAIR E2E PASSED');
} catch (e) {
  await shot(page, 'pair-FAIL'); if (laptop) await shot(laptop.page, 'pair-FAIL-laptop').catch(() => {}); if (cam) await shot(cam.page, 'pair-FAIL-cam').catch(() => {});
  throw e;
} finally { await app.close(); await laptop?.app.close().catch(() => {}); await cam?.app.close().catch(() => {}); owner.disconnect(); await hub.stop(); }
