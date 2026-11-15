import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startOffice, launch, shot, sleep, OUT } from './harness.mts';
const { owner, hub } = await startOffice('ocr');
const { app, page } = await launch('priya', 'Priya Raman');
try {
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  await owner.request('conv.create', { kind: 'space', name: 'Site photos', members: [priya.id] });
  page.on('console', (m: any) => { if (m.type() === 'warning' || /ocr|tesseract|wasm/i.test(m.text())) console.log('[console]', m.type(), m.text().slice(0, 300)); });
  // a "photo" of a nameplate, drawn in the page
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas'); c.width = 900; c.height = 360;
    const x = c.getContext('2d')!;
    x.fillStyle = '#f4f1ea'; x.fillRect(0, 0, 900, 360);
    x.fillStyle = '#1b1b1b'; x.font = 'bold 54px sans-serif'; x.fillText('PRESSURE VESSEL', 60, 110);
    x.font = '46px sans-serif'; x.fillText('TAG NO. V-2201', 60, 200); x.fillText('DESIGN 18 BARG', 60, 280);
    return c.toDataURL('image/png').split(',')[1];
  });
  const file = path.join(OUT, 'nameplate.png');
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  await page.getByRole('button', { name: /^Spaces/ }).first().click();
  await page.locator('.sb-row', { hasText: 'Site photos' }).click();
  await page.locator('.dock input[type=file]').setInputFiles(file);
  await sleep(1500);
  await page.locator('.dock textarea').first().press('Enter');
  await page.locator('.img-tile').waitFor({ timeout: 15000 });
  // wait for the background reading
  let found: any = null;
  for (let i = 0; i < 40 && !found; i++) {
    await sleep(1000);
    const r = await owner.request('search', { q: 'V-2201' }).catch(() => null);
    if (r?.files.length) found = r.files[0];
  }
  assert.ok(found, 'the text in the image became searchable');
  assert.match(found.textMatch, /V-2201/);
  await page.keyboard.press('Control+Shift+F');
  await page.getByLabel('Search messages and files').fill('pressure vessel');
  await page.getByRole('tab', { name: /^Files/ }).click();
  await page.locator('.search-hit', { hasText: 'nameplate.png' }).waitFor();
  await shot(page, 'ocr-01-search');
  console.log('OCR E2E PASSED', JSON.stringify(found.textMatch));
} catch (e) { await shot(page, 'ocr-FAIL'); throw e; } finally { await app.close(); owner.disconnect(); await hub.stop(); }
