// Files in end-to-end encrypted Direct messages, between two desktop apps: an image and a PDF are
// encrypted on the sender's PC, the hub stores only ciphertext, the recipient opens both.
// Then: an older app's plain Direct message shows the open lock, the sender sees the notice
// before sending, and the office policy blocks sending until the other person updates.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { startOffice, launch, shot, sleep, both, OUT } from './harness.mts';

const { owner, hub, dir } = await startOffice('files');
const p = await launch('priya', 'Priya Raman');
const r = await launch('ravi', 'Ravi Kumar');
const MARK = 'TENDER-BOQ-4.2-CRORE';
try {
  const users = (await owner.request('directory.list')).users;
  const ravi = users.find((u: any) => u.account.endsWith('ravi'))!;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  const dm = await p.page.evaluate((id) => window.dex.request('conv.create', { kind: 'direct', members: [id] }), ravi.id);
  await sleep(1500);
  await p.page.getByRole('button', { name: /^Direct/ }).first().click();
  await p.page.locator('.sb-row', { hasText: 'Ravi' }).click();
  await p.page.locator('.e2e-chip', { hasText: 'Encrypted' }).waitFor({ timeout: 15000 });

  // a site photo (drawn) and a PDF
  const b64 = await p.page.evaluate((mark) => { const c = document.createElement('canvas'); c.width = 900; c.height = 560; const x = c.getContext('2d')!; x.fillStyle = '#dfe9ea'; x.fillRect(0, 0, 900, 560); x.strokeStyle = '#1e6066'; x.lineWidth = 8; x.strokeRect(80, 80, 740, 400); x.font = 'bold 44px sans-serif'; x.fillStyle = '#132b2e'; x.fillText('GRID C-4 · NOZZLE N2', 170, 270); x.font = '22px monospace'; x.fillText(mark, 250, 330); return c.toDataURL('image/png').split(',')[1]; }, MARK);
  const png = Buffer.from(b64, 'base64');
  const img = path.join(OUT, 'site grid C-4.png'); fs.writeFileSync(img, png);
  const pdfText = `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 44>>stream\nBT /F1 18 Tf 20 70 Td (${MARK}) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`;
  const pdf = Buffer.from(pdfText);
  const doc = path.join(OUT, 'Tender BOQ.pdf'); fs.writeFileSync(doc, pdf);
  await p.page.locator('.dock input[type=file]').setInputFiles([img, doc]);
  await p.page.locator('.attach-chip.done').nth(1).waitFor({ timeout: 15000 });
  await p.page.locator('.dock textarea').first().fill('Site photo and the BOQ');
  await p.page.locator('.dock textarea').first().press('Enter');
  await p.page.locator('.msg', { hasText: 'Site photo and the BOQ' }).locator('.img-tile img').waitFor({ timeout: 15000 });
  await sleep(800);

  // the hub: the files are marked sealed, under a neutral name, and the stored bytes are ciphertext
  const rows = hub.files.db.prepare('SELECT id, name, mime, sealed, sha256, size FROM files ORDER BY created_at').all() as Array<{ id: string; name: string; mime: string; sealed: number; sha256: string; size: number }>;
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.deepEqual([row.name, row.mime, row.sealed], ['Encrypted file', 'application/octet-stream', 1]);
    const blob = fs.readFileSync(path.join(dir, 'files', row.sha256.slice(0, 2), row.sha256));
    assert.equal(blob.indexOf(MARK), -1, 'no plaintext on the hub');
    assert.equal(blob.indexOf('%PDF'), -1);
    assert.ok(!blob.subarray(0, 8).equals(png.subarray(0, 8)), 'not a PNG');
    assert.ok(row.size === png.length + 24 || row.size === pdf.length + 24, 'ciphertext size: header and one chunk tag');
  }
  const raw = (hub as any).messaging.db.prepare('SELECT body FROM messages WHERE conv_id = ? ORDER BY id DESC LIMIT 1').get(dm.id).body as string;
  assert.ok(raw.startsWith('e2e1:'));
  assert.doesNotMatch(Buffer.from(raw.slice(5), 'base64').toString(), /Tender|BOQ|grid|\.pdf|\.png/);
  console.log('hub holds ciphertext only:', rows.map((x) => `${x.id} ${x.size} B`).join(', '));
  await both(p.page, 'files-01-sent');

  // Ravi's app opens both: the photo is decrypted on his PC and shown; the PDF opens and saves intact
  await r.page.getByRole('button', { name: /^Direct/ }).first().click();
  await r.page.locator('.sb-row', { hasText: 'Priya' }).click();
  const tile = r.page.locator('.msg', { hasText: 'Site photo and the BOQ' }).locator('.img-tile img');
  await tile.waitFor({ timeout: 15000 });
  await r.page.waitForFunction(() => { const i = document.querySelector('.img-tile img') as HTMLImageElement | null; return !!i && i.complete && i.naturalWidth > 0; }, null, { timeout: 15000 });
  assert.equal(await tile.evaluate((i: HTMLImageElement) => i.naturalWidth), 900, 'the photo decrypted on the device');
  const card = r.page.locator('.file-card', { hasText: 'Tender BOQ.pdf' });
  await card.waitFor();
  await both(r.page, 'files-02-received');
  await r.page.locator('.img-tile').first().click();
  await r.page.locator('.lb-stage img, .lightbox img').first().waitFor({ timeout: 10000 });
  await r.page.waitForFunction(() => { const i = document.querySelector('.lb-stage img, .lightbox img') as HTMLImageElement | null; return !!i && i.naturalWidth === 900; }, null, { timeout: 10000 });
  await both(r.page, 'files-03-viewer');
  await r.page.keyboard.press('Escape');
  const pdfInfo = (await r.page.evaluate((id) => window.dex.request('msg.list', { convId: id }), dm.id)).messages.at(-1).files.find((f: any) => f.name === 'Tender BOQ.pdf');
  assert.equal(pdfInfo.mime, 'application/pdf');
  assert.equal(pdfInfo.size, pdf.length, 'the real size, from the sealed message');
  const saved = await r.page.evaluate(({ id, name }) => window.dex.saveFile!(id, name), { id: pdfInfo.id, name: pdfInfo.name });
  assert.deepEqual(fs.readFileSync(saved), pdf, 'the saved PDF is the original');
  fs.rmSync(saved, { force: true });
  // the encrypted PDF opens in the app's own viewer, drawn from the copy decrypted on this PC
  await card.getByRole('button', { name: 'View', exact: true }).click();
  await r.page.waitForFunction(() => [...document.querySelectorAll<HTMLCanvasElement>('.pdfv-layer canvas')].some((c) => c.width > 0), null, { timeout: 30000 });
  await both(r.page, 'files-04b-pdf-viewer');
  await r.page.keyboard.press('Escape');
  await r.page.locator('.pdfv').waitFor({ state: 'detached', timeout: 10000 });
  const cached = path.join(r.userData, 'file-cache', pdfInfo.id, 'Tender BOQ.pdf');
  assert.deepEqual(fs.readFileSync(cached), pdf, 'opened from a decrypted copy');
  console.log('recipient opened the photo (900 px) and the PDF (%d bytes, identical)', pdf.length);

  // an older app (Vikram's, no encryption key) in a Direct conversation with Priya
  const old = (await owner.request('conv.create', { kind: 'direct', members: [priya.id] })) as any;
  const plainPng = await new Promise<any>((resolve, reject) => {
    const q = https.request({ host: '127.0.0.1', port: hub.port, path: `/files?name=${encodeURIComponent('old photo.png')}&type=image%2Fpng`, method: 'POST', rejectUnauthorized: false, headers: { authorization: `Bearer ${owner.session!.fileToken}`, 'content-length': String(png.length) } }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve(JSON.parse(t))); });
    q.on('error', reject); q.end(png);
  });
  await owner.request('msg.send', { convId: old.id, body: 'Photo from the old app', clientId: 'old-1', files: [plainPng.id] });
  await p.page.locator('.sb-row', { hasText: 'Vikram' }).click();
  const oldMsg = p.page.locator('.msg', { hasText: 'Photo from the old app' });
  await oldMsg.locator('.img-tile img').waitFor({ timeout: 15000 });
  await p.page.waitForFunction(() => [...document.querySelectorAll('.img-tile img')].some((i) => (i as HTMLImageElement).naturalWidth === 900), null, { timeout: 15000 });
  assert.match(await oldMsg.locator('.plain-mark').getAttribute('aria-label') ?? '', /Not end-to-end encrypted: Vikram Shah had no encryption key yet/);
  await p.page.locator('.e2e-notice', { hasText: 'Not end-to-end encrypted: Vikram Shah is on an older version' }).waitFor({ timeout: 10000 });
  await p.page.locator('.dock textarea').first().fill('Noted, thanks');
  await p.page.locator('.dock textarea').first().press('Enter');
  await p.page.locator('.msg', { hasText: 'Noted, thanks' }).locator('.plain-mark').waitFor({ timeout: 10000 });
  await both(p.page, 'files-04-not-encrypted');

  // the office now requires encryption: Priya cannot write to Vikram until he updates
  await owner.request('admin.policy.set', { requireE2E: true });
  await p.page.locator('.dock-locked.e2e-required', { hasText: 'requires Direct messages to be end-to-end encrypted' }).waitFor({ timeout: 15000 });
  assert.match(await p.page.locator('.dock-locked.e2e-required').innerText(), /once Vikram Shah updates/);
  await both(p.page, 'files-05-required');
  await assert.rejects(owner.request('msg.send', { convId: old.id, body: 'still plain?', clientId: 'old-2' }), /needs to update/);
  // the encrypted conversation with Ravi is unaffected
  await p.page.locator('.sb-row', { hasText: 'Ravi' }).click();
  await p.page.locator('.dock textarea').first().waitFor();
  assert.equal(await p.page.locator('.dock-locked.e2e-required').count(), 0);
  console.log('FILES E2E PASSED');
} catch (e) {
  await shot(p.page, 'files-FAIL-p');
  await shot(r.page, 'files-FAIL-r');
  throw e;
} finally {
  await p.app.close();
  await r.app.close();
  owner.disconnect();
  await hub.stop().catch(() => {});
}
