import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startOffice, launch, shot, sleep, OUT } from './harness.mts';
// a camera picture with fine detail (a 4 px checkerboard), so a blur shows in the edge energy
const clip = path.join(OUT, 'texture.y4m');
if (!fs.existsSync(clip)) {
  const W = 320, H = 240;
  const y = Buffer.alloc(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) y[r * W + c] = ((r >> 2) + (c >> 2)) % 2 ? 210 : 40;
  const uv = Buffer.alloc((W / 2) * (H / 2), 128);
  const parts: Buffer[] = [Buffer.from(`YUV4MPEG2 W${W} H${H} F15:1 Ip A1:1 C420jpeg\n`)];
  for (let f = 0; f < 15; f++) parts.push(Buffer.from('FRAME\n'), y, uv, uv);
  fs.writeFileSync(clip, Buffer.concat(parts));
}
const { owner, hub } = await startOffice('blur');
const { app, page } = await launch('priya', 'Priya Raman', { video: clip });
try {
  const users = (await owner.request('directory.list')).users;
  const vikram = users.find((u: any) => u.account.endsWith('vikram'))!;
  const dm = await page.evaluate((id) => window.dex.request('conv.create', { kind: 'direct', members: [id] }), vikram.id);
  // start a video Room from the conversation
  await page.getByRole('button', { name: /^Direct/ }).first().click();
  await page.locator('.sb-row').first().click();
  await page.locator('[title="Open a Room with voice"]').first().waitFor();
  const opener = page.getByRole('button', { name: /Open a Room/ }).first();
  await opener.click();
  const withVideo = page.getByRole('menuitem', { name: /With video/ });
  if (await withVideo.count()) await withVideo.click();
  await page.getByRole('button', { name: /Camera (on|off)/ }).waitFor({ timeout: 15000 });
  if (await page.getByRole('button', { name: 'Camera off' }).count()) await page.getByRole('button', { name: 'Camera off' }).click();
  await sleep(1500);
  const sharpness = () => page.evaluate(() => {
    const v = [...document.querySelectorAll('video')].find((x) => (x as HTMLVideoElement).videoWidth > 0) as HTMLVideoElement | undefined;
    if (!v) return -1;
    const c = document.createElement('canvas'); c.width = 320; c.height = 180;
    const x = c.getContext('2d')!; x.drawImage(v, 0, 0, 320, 180);
    const d = x.getImageData(0, 0, 320, 180).data;
    let e = 0;
    for (let y = 0; y < 180; y++) for (let i = 1; i < 320; i++) { const a = (y * 320 + i) * 4; e += Math.abs(d[a] - d[a - 4]); }
    return e / (320 * 180);
  });
  const before = await sharpness();
  // the Background picker in the title block: Blur
  await page.getByRole('button', { name: 'Background' }).click();
  await page.getByRole('radio', { name: 'Blur' }).click();
  await page.getByRole('button', { name: 'Blur on' }).waitFor({ timeout: 20000 });
  await page.keyboard.press('Escape');
  await sleep(3000);
  const after = await sharpness();
  console.log('edge energy before', before.toFixed(2), 'after', after.toFixed(2));
  assert.ok(before > 0 && after > 0, 'video is playing');
  assert.ok(after < before * 0.6, 'the picture is blurred');
  await shot(page, 'blur-01-on');
  // remembered for the next Room, and turned off again
  assert.equal(await page.evaluate(() => localStorage.getItem('dex.room.background')), 'blur');
  await page.getByRole('button', { name: 'Blur on' }).click();
  await page.getByRole('radio', { name: 'As it is' }).click();
  await page.getByRole('button', { name: 'Background' }).waitFor();
  await page.keyboard.press('Escape');
  await sleep(1500);
  const again = await sharpness();
  console.log('edge energy off', again.toFixed(2));
  assert.ok(again > after * 1.3, 'sharp again');
  console.log('BLUR E2E PASSED');
} catch (e) { await shot(page, 'blur-FAIL'); throw e; } finally { await app.close(); owner.disconnect(); await hub.stop(); }
