import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { startOffice, launch, shot, sleep, OUT } from './harness.mts';

// a 32x32 PNG drawn here: an orange disc with a teal ring
function png(): Buffer {
  const W = 32, raw = Buffer.alloc((W * 4 + 1) * W);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const d = Math.hypot(x - 15.5, y - 15.5), o = y * (W * 4 + 1) + 1 + x * 4;
    const [r, g, b, a] = d < 9 ? [240, 150, 40, 255] : d < 14 ? [28, 118, 128, 255] : [0, 0, 0, 0];
    raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
  }
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const file = path.join(OUT, 'pipe-rack.png');
fs.writeFileSync(file, png());

const { owner, hub } = await startOffice('emoji');
const { app, page } = await launch('priya', 'Priya Raman');
try {
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  await owner.request('admin.setRole', { userId: priya.id, role: 'admin' });
  const sp = await owner.request('conv.create', { kind: 'space', name: 'P-12 Piping', members: [priya.id] });
  await page.reload(); await page.locator('.frame').waitFor();
  await page.locator('.me-btn').click();
  await page.getByRole('menuitem', { name: /Control room/ }).click();
  await page.getByRole('button', { name: 'Policies' }).click();
  await page.locator('.card', { hasText: 'Office emoji' }).locator('input[type=file]').setInputFiles(file);
  assert.equal(await page.getByLabel('Emoji name').inputValue(), 'pipe-rack');
  await page.locator('.card', { hasText: 'Office emoji' }).getByRole('button', { name: 'Add' }).click();
  await page.locator('.emoji-admin-item', { hasText: ':pipe-rack:' }).waitFor();
  await page.locator('.emoji-admin-item img').waitFor();
  await shot(page, 'emoji-01-admin');
  await page.keyboard.press('Escape');
  await owner.request('msg.send', { convId: sp.id, body: 'Rack 3 is up :pipe-rack: well done', clientId: 'x' });
  await page.getByRole('button', { name: /^Spaces/ }).first().click();
  await page.locator('.sb-row', { hasText: 'P-12 Piping' }).click();
  const msg = page.locator('.msg', { hasText: 'Rack 3' });
  await msg.locator('img.custom-emoji').waitFor();
  const w = await msg.locator('img.custom-emoji').evaluate((i: HTMLImageElement) => new Promise((r) => (i.complete ? r(i.naturalWidth) : (i.onload = () => r(i.naturalWidth)))));
  assert.equal(w, 32);
  await msg.hover();
  await msg.getByTitle('Stamp', { exact: true }).click();
  await page.getByRole('button', { name: 'More stamps' }).click();
  await page.locator('.emoji-picker button[title=":pipe-rack:"]').click();
  await msg.locator('.reaction img.custom-emoji').waitFor();
  const m = (await owner.request('msg.list', { convId: sp.id })).messages ?? [];
  void m;
  await shot(page, 'emoji-02-message');
  console.log('EMOJI E2E PASSED');
} catch (e) { await shot(page, 'emoji-FAIL'); throw e; } finally { await app.close(); owner.disconnect(); await hub.stop(); }
