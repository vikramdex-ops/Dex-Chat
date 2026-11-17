// PDF viewer e2e: PDFs made in code are sent to a Space, shown as chips with their first page,
// opened from the message, zoomed (menu, Ctrl+wheel, 800% tiles), searched, paged, rotated and
// copied from; a protected PDF asks for its password, a broken one says so; an Office file gets
// its card; "Open in the default app" opens a temporary copy. Then the same on a phone-width
// window with a two-finger pinch. Screenshots in light and dark at 1280 and 390 px.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startOffice, launch, shot, both, sleep, OUT } from './harness.mts';
import { a0Sheet, a4Document, brokenPdf, lockedPdf } from '../../../apps/desktop/test/pdf-fixtures.ts';

const { owner, hub } = await startOffice('pdf');
const { app, page } = await launch('priya', 'Priya Raman');
let phone: Awaited<ReturnType<typeof launch>> | null = null;
const files = {
  a0: path.join(OUT, 'P12-GA-0301 Area 3.pdf'),
  a4: path.join(OUT, 'Inspection report.pdf'),
  locked: path.join(OUT, 'Tender figures.pdf'),
  broken: path.join(OUT, 'Scan from site.pdf'),
  xlsx: path.join(OUT, 'Valve list.xlsx'),
};
fs.writeFileSync(files.a0, a0Sheet());
fs.writeFileSync(files.a4, a4Document(12));
fs.writeFileSync(files.locked, lockedPdf('site42'));
fs.writeFileSync(files.broken, brokenPdf());
fs.writeFileSync(files.xlsx, Buffer.from('PK\u0003\u0004 not really a workbook, only its name matters here'));

const canvasStats = () => page.evaluate(() => {
  const cs = [...document.querySelectorAll<HTMLCanvasElement>('.pdfv-layer canvas')];
  return { count: cs.length, tiles: cs.filter((c) => c.classList.contains('pdfv-tile')).length, maxSide: Math.max(0, ...cs.map((c) => Math.max(c.width, c.height))), pixels: cs.reduce((n, c) => n + c.width * c.height, 0) };
});
const zoomLabel = () => page.locator('.pdfv-zoom').innerText();
const settle = async (ms = 600) => { await sleep(ms); await page.waitForFunction(() => document.querySelectorAll('.pdfv-layer canvas').length > 0, null, { timeout: 30000 }); };

try {
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  const sp = await owner.request('conv.create', { kind: 'space', name: 'P-12 Drawings', members: [priya.id] });
  await page.getByRole('button', { name: /^Spaces/ }).first().click();
  await page.locator('.sb-row', { hasText: 'P-12 Drawings' }).click();
  await page.locator('.dock input[type=file]').setInputFiles([files.a0, files.a4, files.locked, files.broken, files.xlsx]);
  await page.waitForFunction(() => document.querySelectorAll('.attach-chip.done').length === 5, null, { timeout: 30000 });
  await page.locator('.dock textarea').first().fill('Area 3 GA for review, with the inspection report');
  await page.locator('.dock textarea').first().press('Enter');

  // chips: four PDFs (first pages drawn lazily) and the workbook's card
  await page.locator('.pdf-chip').nth(3).waitFor({ timeout: 20000 });
  assert.equal(await page.locator('.pdf-chip').count(), 4);
  const office = page.locator('.office-card', { hasText: 'Valve list.xlsx' });
  await office.waitFor();
  assert.match(await office.innerText(), /Excel workbook/i);
  assert.equal(await office.getByRole('button', { name: 'Open in the default app' }).count(), 1);
  assert.equal(await office.getByRole('button', { name: 'Download' }).count(), 1);
  await page.locator('.pdf-chip', { hasText: 'P12-GA-0301' }).locator('.pdf-chip-thumb img').waitFor({ timeout: 30000 });
  await page.locator('.pdf-chip', { hasText: 'Inspection report' }).locator('.pdf-chip-thumb img').waitFor({ timeout: 30000 });
  await sleep(1500);
  // the protected and the broken PDF keep the plain tile
  assert.equal(await page.locator('.pdf-chip', { hasText: 'Tender figures' }).locator('img').count(), 0);
  assert.equal(await page.locator('.pdf-chip', { hasText: 'Scan from site' }).locator('img').count(), 0);
  await both(page, 'pdf-01-chips-1280');

  // ---- the A0 sheet, opened from the message
  await page.locator('.pdf-chip', { hasText: 'P12-GA-0301' }).getByRole('button', { name: 'View', exact: true }).click();
  const dlg = page.getByRole('dialog', { name: 'P12-GA-0301 Area 3.pdf' });
  await dlg.waitFor();
  await settle(1200);
  assert.equal(await zoomLabel(), 'Page', 'a drawing sheet opens whole');
  assert.match(await page.locator(".pdfv-meta").innerText(), /A0/);
  let st = await canvasStats();
  assert.equal(st.tiles, 0, 'the whole sheet fits one canvas');
  // 100%: real size, a sheet far bigger than the screen: tiles, never a giant canvas
  await page.locator('.pdfv-zoom').click();
  await page.getByRole('menuitemradio', { name: /100%/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('.pdfv-tile').length > 0, null, { timeout: 30000 });
  await sleep(1500);
  st = await canvasStats();
  console.log('100%:', st);
  assert.equal(await zoomLabel(), '100%');
  assert.ok(st.maxSide <= 4096, 'no canvas side over 4096');
  assert.ok(st.pixels <= 40e6, 'within the pixel budget');
  // Ctrl + wheel zooms smoothly around the pointer
  const box = (await page.locator('.pdfv-stage').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down('Control');
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -60); await sleep(30); }
  await page.keyboard.up('Control');
  await sleep(400);
  const z1 = Number((await zoomLabel()).replace('%', ''));
  assert.ok(z1 > 150 && z1 < 400, `wheel zoom ${z1}`);
  // 800%: still only tiles near the view
  await page.locator('.pdfv-zoom').click();
  await page.getByRole('menuitemradio', { name: '800%' }).click();
  await sleep(2500);
  st = await canvasStats();
  console.log('800%:', st, await page.evaluate(() => [...document.querySelectorAll<HTMLCanvasElement>('.pdfv-layer canvas')].map((c) => `${c.dataset.key} ${c.width}x${c.height}`)));
  assert.equal(await zoomLabel(), '800%');
  assert.ok(st.tiles > 0 && st.tiles <= 40, `tiles ${st.tiles}`);
  assert.ok(st.pixels <= 40e6);
  const sheet = await page.locator('.pdfv-sheet').boundingBox();
  assert.ok(sheet!.width > 30000, 'the sheet is 800% of A0 wide');
  // drag to pan
  const before = await page.locator('.pdfv-stage').evaluate((e) => [e.scrollLeft, e.scrollTop]);
  await page.mouse.move(box.x + 600, box.y + 400);
  await page.mouse.down();
  await page.mouse.move(box.x + 300, box.y + 250, { steps: 8 });
  await page.mouse.up();
  const after = await page.locator('.pdfv-stage').evaluate((e) => [e.scrollLeft, e.scrollTop]);
  assert.ok(Math.abs(after[0] - before[0] - 300) < 3 && Math.abs(after[1] - before[1] - 150) < 3, `panned ${before} -> ${after}`);
  // back to the whole sheet, then search
  await page.getByRole('button', { name: 'Fit page' }).click();
  await settle(800);
  await page.keyboard.press('Control+f');
  await page.getByRole('search').getByLabel('Find in this PDF').fill('v-2201');
  await page.waitForFunction(() => /of 4$/.test(document.querySelector('.pdfv-count')?.textContent ?? ''), null, { timeout: 20000 });
  assert.equal(await page.locator('.pdfv-count').innerText(), '1 of 4');
  assert.ok(await page.locator('.pdfv-hit').count() >= 4);
  await page.getByRole('search').getByLabel('Find in this PDF').press('Enter');
  assert.equal(await page.locator('.pdfv-count').innerText(), '2 of 4');
  assert.equal(await page.locator('.pdfv-hit.on').count(), 1);
  await page.getByRole('search').getByLabel('Find in this PDF').fill('PIPE RACK PR-03');
  await page.waitForFunction(() => document.querySelector('.pdfv-count')?.textContent === '1 of 1', null, { timeout: 20000 });
  await sleep(800);
  await both(page, 'pdf-02-a0-search-1280');
  // copy the page's text
  await page.getByRole('button', { name: 'Copy text' }).click();
  await sleep(300);
  const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
  assert.match(clip, /PIPE RACK PR-03/);
  assert.match(clip, /DWG P12-GA-0301/);
  // rotate a quarter turn: the sheet stands up
  const p0 = (await page.locator('.pdfv-page').first().boundingBox())!;
  await page.getByRole('button', { name: 'Rotate' }).click();
  await settle(900);
  const p1 = (await page.locator('.pdfv-page').first().boundingBox())!;
  assert.ok(p0.width > p0.height && p1.height > p1.width, 'rotated');
  // the highlight turned with the sheet and is still on the words
  assert.equal(await page.locator('.pdfv-hit.on').count(), 1);
  // open in the default app: a temporary copy
  await app.evaluate(({ shell }) => { (globalThis as any).__opened = []; shell.openPath = async (p: string) => { (globalThis as any).__opened.push(p); return ''; }; });
  await dlg.getByRole('button', { name: 'Open in the default app' }).click();
  await sleep(800);
  const opened = await app.evaluate(() => (globalThis as any).__opened as string[]);
  assert.equal(opened.length, 1);
  assert.match(opened[0], /dexterity-connect-open/);
  assert.ok(fs.readFileSync(opened[0]).equals(fs.readFileSync(files.a0)), 'the copy is the file');
  await page.keyboard.press('Escape'); // closes find
  await page.keyboard.press('Escape'); // closes the viewer
  await dlg.waitFor({ state: 'detached' });

  // ---- the 12-page report: fit width, the page strip, go to page, search across pages
  await page.locator('.pdf-chip', { hasText: 'Inspection report' }).getByRole('button', { name: 'View', exact: true }).click();
  await page.getByRole('dialog', { name: 'Inspection report.pdf' }).waitFor();
  await settle(1000);
  assert.equal(await zoomLabel(), 'Width');
  await page.locator('.pdfv-thumb img').first().waitFor({ timeout: 20000 });
  assert.equal(await page.locator('.pdfv-thumb').count(), 12);
  assert.ok((await page.locator('.pdfv-page').count()) <= 5, 'only pages near the view are drawn');
  await page.getByLabel('Go to page').fill('9');
  await page.getByLabel('Go to page').press('Enter');
  await sleep(500);
  assert.equal(await page.getByLabel('Go to page').inputValue(), '9');
  await page.locator('.pdfv-thumb[data-thumb="4"]').click();
  await sleep(500);
  assert.equal(await page.getByLabel('Go to page').inputValue(), '5');
  await page.getByRole('button', { name: 'Next page' }).click();
  await sleep(400);
  assert.equal(await page.getByLabel('Go to page').inputValue(), '6');
  await page.keyboard.press('Control+f');
  await page.getByRole('search').getByLabel('Find in this PDF').fill('flange schedule');
  await page.waitForFunction(() => /of 4$/.test(document.querySelector('.pdfv-count')?.textContent ?? ''), null, { timeout: 20000 });
  await page.getByRole('search').getByLabel('Find in this PDF').press('Enter'); // 2 of 4: page 6
  await sleep(600);
  assert.equal(await page.locator('.pdfv-count').innerText(), '2 of 4');
  assert.equal(await page.getByLabel('Go to page').inputValue(), '6');
  await both(page, 'pdf-03-report-strip-1280');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // ---- protected: asks for the password
  await page.locator('.pdf-chip', { hasText: 'Tender figures' }).getByRole('button', { name: 'View', exact: true }).click();
  await page.getByRole('heading', { name: 'This PDF needs a password' }).waitFor({ timeout: 20000 });
  await page.getByLabel('Password').fill('wrong');
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.getByText('That password did not open it').waitFor({ timeout: 10000 });
  await both(page, 'pdf-04-password-1280');
  await page.getByLabel('Password').fill('site42');
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await settle(800);
  await page.keyboard.press('Control+f');
  await page.getByRole('search').getByLabel('Find in this PDF').fill('confidential');
  await page.waitForFunction(() => document.querySelector('.pdfv-count')?.textContent === '1 of 1', null, { timeout: 20000 });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // ---- broken: a clear message, and Download still works
  await page.locator('.pdf-chip', { hasText: 'Scan from site' }).getByRole('button', { name: 'View', exact: true }).click();
  await page.getByRole('heading', { name: 'This PDF can’t be shown' }).waitFor({ timeout: 20000 });
  await both(page, 'pdf-05-broken-1280');
  const downloads = await app.evaluate(({ app }) => app.getPath('downloads'));
  await page.locator('.pdfv-card').getByRole('button', { name: 'Download' }).click();
  await page.getByText('Saved Scan from site.pdf to Downloads').waitFor({ timeout: 10000 });
  const saved = fs.readdirSync(downloads).filter((n) => n.startsWith('Scan from site')).map((n) => path.join(downloads, n));
  assert.ok(saved.length >= 1 && fs.readFileSync(saved.at(-1)!).equals(fs.readFileSync(files.broken)));
  for (const s of saved) fs.rmSync(s, { force: true });
  await page.keyboard.press('Escape');
  await page.getByRole('dialog', { name: 'Scan from site.pdf' }).waitFor({ state: 'detached' });

  // ---- the Office card opens a temporary copy too
  await office.getByRole('button', { name: 'Open in the default app' }).click();
  await sleep(800);
  const opened2 = await app.evaluate(() => (globalThis as any).__opened as string[]);
  assert.equal(opened2.length, 2);
  assert.match(opened2[1], /Valve list\.xlsx$/);

  // ---- a phone-width window: fit width, the strip folded away, two-finger pinch
  phone = await launch('priya', 'Priya Raman', { width: 390, height: 844, userData: undefined });
  const ph = phone.page;
  const bw = await phone.app.browserWindow(ph);
  await bw.evaluate((w: any) => w.setSize(390, 844));
  await ph.setViewportSize({ width: 390, height: 844 });
  await ph.locator('.lens-dock').getByRole('button', { name: /Switchboard/ }).click();
  await ph.locator('.sb-row', { hasText: 'P-12 Drawings' }).click();
  await ph.locator('.pdf-chip', { hasText: 'P12-GA-0301' }).waitFor({ timeout: 20000 });
  await ph.locator('.pdf-chip', { hasText: 'P12-GA-0301' }).locator('.pdf-chip-thumb img').waitFor({ timeout: 30000 });
  await both(ph, 'pdf-06-chips-390');
  await ph.locator('.pdf-chip', { hasText: 'P12-GA-0301' }).getByRole('button', { name: 'View', exact: true }).click();
  await ph.waitForFunction(() => document.querySelectorAll('.pdfv-layer canvas').length > 0, null, { timeout: 30000 });
  await sleep(1000);
  assert.equal(await ph.locator('.pdfv-zoom').innerText(), 'Width', 'phones open to the width');
  assert.equal(await ph.locator('.pdfv-strip').count(), 0, 'the page strip starts folded away');
  const pw0 = (await ph.locator('.pdfv-page').first().boundingBox())!.width;
  assert.ok(pw0 <= 390 && pw0 > 300);
  await both(ph, 'pdf-07-a0-390');
  // pinch out with two fingers
  await ph.evaluate(async () => {
    const el = document.querySelector('.pdfv-stage')!;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const touches = (d: number) => [new Touch({ identifier: 1, target: el, clientX: cx - d, clientY: cy }), new Touch({ identifier: 2, target: el, clientX: cx + d, clientY: cy })];
    const fire = (type: string, d: number) => el.dispatchEvent(new TouchEvent(type, { touches: type === 'touchend' ? [] : touches(d), changedTouches: touches(d), bubbles: true, cancelable: true }));
    fire('touchstart', 40);
    for (let d = 40; d <= 120; d += 8) { fire('touchmove', d); await new Promise((res) => requestAnimationFrame(() => res(null))); }
    fire('touchend', 120);
  });
  await sleep(900);
  const pinched = Number((await ph.locator('.pdfv-zoom').innerText()).replace('%', ''));
  const pw1 = (await ph.locator('.pdfv-page').first().boundingBox())!.width;
  assert.ok(pw1 > pw0 * 2.5, `pinched ${pw0} -> ${pw1} (${pinched}%)`);
  await ph.getByRole('button', { name: 'Find in this PDF' }).click();
  await ph.getByRole('search').getByLabel('Find in this PDF').fill('V-2201');
  await ph.waitForFunction(() => /of 4$/.test(document.querySelector('.pdfv-count')?.textContent ?? ''), null, { timeout: 20000 });
  await sleep(600);
  await both(ph, 'pdf-08-a0-pinch-search-390');
  console.log('PDF E2E PASSED');
} catch (e) {
  await shot(page, 'pdf-FAIL');
  if (phone) await shot(phone.page, 'pdf-FAIL-phone');
  throw e;
} finally {
  await app.close();
  await phone?.app.close();
  owner.disconnect();
  await hub.stop();
}
