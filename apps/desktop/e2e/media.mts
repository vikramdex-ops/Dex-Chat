import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startOffice, launch, shot, sleep, OUT } from './harness.mts';
const { owner, hub } = await startOffice('media');
const { app, page } = await launch('priya', 'Priya Raman');
try {
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  const sp = await owner.request('conv.create', { kind: 'space', name: 'Markups', members: [priya.id] });
  await page.getByRole('button', { name: /^Spaces/ }).first().click();
  await page.locator('.sb-row', { hasText: 'Markups' }).click();
  const b64 = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 800; c.height = 500; const x = c.getContext('2d')!; x.fillStyle = '#e9eef0'; x.fillRect(0, 0, 800, 500); x.strokeStyle = '#333'; x.lineWidth = 6; x.strokeRect(100, 100, 600, 300); x.font = '40px sans-serif'; x.fillStyle = '#333'; x.fillText('PIPE RACK PR-03', 220, 260); return c.toDataURL('image/png').split(',')[1]; });
  const img = path.join(OUT, 'rack.png'); fs.writeFileSync(img, Buffer.from(b64, 'base64'));
  fs.writeFileSync(path.join(OUT, 'README.md'), '# Handover notes\n\n- **Area 3** done\n  - lines 101–120\n\n```sql\nselect * from lines;\n```\n');
  await page.locator('.dock input[type=file]').setInputFiles([img, path.join(OUT, 'README.md')]);
  await sleep(1500);
  await page.locator('.dock textarea').first().press('Enter');
  await page.locator('.img-tile img').waitFor({ timeout: 15000 });
  // markdown preview
  await page.locator('.file-card', { hasText: 'README.md' }).getByRole('button', { name: 'Preview' }).click();
  await page.getByRole('dialog', { name: 'README.md' }).locator('h3', { hasText: 'Handover notes' }).waitFor();
  assert.equal(await page.locator('.md-preview ul ul li').innerText(), 'lines 101–120');
  await page.keyboard.press('Escape');
  // the viewer: zoom, rotate, mark up and send
  await page.locator('.img-tile').click();
  await page.getByTitle('Zoom in (+)').click();
  await page.getByTitle('Zoom in (+)').click();
  assert.equal(await page.locator('.lb-zoom').innerText(), '156%');
  await page.getByTitle('Rotate (R)').click();
  assert.match(await page.locator('.lb-stage img').getAttribute('style') ?? '', /rotate\(90deg\)/);
  await shot(page, 'media-01-viewer');
  await page.getByRole('button', { name: 'Mark up' }).click();
  await page.getByRole('button', { name: 'Arrow' }).click();
  const c = (await page.locator('.markup-stage canvas').boundingBox())!;
  await page.mouse.move(c.x + c.width * 0.2, c.y + c.height * 0.8); await page.mouse.down();
  await page.mouse.move(c.x + c.width * 0.45, c.y + c.height * 0.55, { steps: 6 }); await page.mouse.up();
  await page.getByRole('button', { name: 'Box' }).click();
  await page.mouse.move(c.x + c.width * 0.5, c.y + c.height * 0.4); await page.mouse.down();
  await page.mouse.move(c.x + c.width * 0.8, c.y + c.height * 0.6, { steps: 4 }); await page.mouse.up();
  await page.getByPlaceholder('Add a note (optional)').fill('Check this support');
  await shot(page, 'media-02-markup');
  await page.locator('.markup-bar').getByRole('button', { name: 'Send' }).click();
  await page.locator('.msg', { hasText: 'Check this support' }).locator('.img-tile img').waitFor({ timeout: 15000 });
  const list = await owner.request('msg.list', { convId: sp.id });
  const f = (list.messages ?? list).flatMap((m: any) => m.files).find((x: any) => /marked up/.test(x.name));
  assert.equal(f?.name, 'rack (marked up).png');
  console.log('MEDIA E2E PASSED');
} catch (e) { await shot(page, 'media-FAIL'); throw e; } finally { await app.close(); owner.disconnect(); await hub.stop(); }
