// Office holidays from the year's circular (docs/HOLIDAYS.md): Bhavna, the office administrator,
// drops the holiday circular PDF into her conversation with Nib; Nib's card reads back the
// reference, the period, the days by kind and every row with its check; she registers it; Nib's
// summary follows; "Open Office holidays" lands in the Control room with each day's source (Ref,
// file, fingerprint); the same PDF again is "already registered"; the card at phone width, in the
// dark, and in Hindi.
// The PDF: HOLIDAY_PDF (the real circular), or one drawn here from the circular's text (the fixture
// in packages/core/test/fixtures).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startOffice, launch, shot, both, sleep, OUT } from './harness.mts';
import { circularPdf } from '../../hub/test/pdfs.ts';

const { owner, hub } = await startOffice('holidaypdf');
const pdf = process.env.HOLIDAY_PDF ?? path.join(OUT, 'holidays-2026.pdf');
if (!process.env.HOLIDAY_PDF) {
  const lines = fs.readFileSync(path.join(import.meta.dirname, '../../../packages/core/test/fixtures/holiday-circular-2026.txt'), 'utf8').split('\n');
  fs.writeFileSync(pdf, circularPdf(lines));
}
const { app, page: B } = await launch('bhavna', 'Bhavna Shah', { width: 1440, height: 900 });
const t0 = Date.now();
/** The conversation with Nib, at the top of Direct. */
const openNib = async () => { await B.locator('.lens-bar .lens').nth(1).click(); await B.locator('.sb-nib').click(); };
try {
  const users = (await owner.request('directory.list')).users;
  const bhavna = users.find((u: any) => u.account.endsWith('bhavna'))!;
  await owner.request('admin.setRole', { userId: bhavna.id, role: 'admin' });
  await B.reload(); await B.locator('.frame').waitFor();
  assert.equal((await owner.request('botjob.calendar')).days.length, 0, 'a hub with no holidays yet');

  // ---------------------------------------------------------------- 1. the PDF to Nib
  console.log('step 1', Date.now() - t0);
  await openNib();
  await B.locator('.dock input[type=file]').setInputFiles([pdf]);
  await sleep(1200);
  await B.locator('.dock textarea').first().press('Enter');
  // the first circular card (Nib's summary card comes after it)
  const card = B.locator('.nib-card.k-holidays').first();
  await card.getByRole('button', { name: 'Register 46 days' }).waitFor({ timeout: 20000 });
  // the card is drawn once its details arrive
  await card.locator('.hol-source', { hasText: 'HRD/CIR/2026/011' }).waitFor({ timeout: 10000 });
  const text = await card.innerText();
  for (const s of ['HRD/CIR/2026/011', 'holidays-2026.pdf', 'compensatory work', 'compensatory off', 'holiday']) assert.ok(text.toLowerCase().includes(s.toLowerCase()), `the card shows ${s}`);
  assert.match(text, /26 Mar 2026|Mar 26, 2026/, 'the circular’s date');
  assert.equal(await card.locator('.hol-row.bad').count(), 0, 'no row in doubt in the real circular');
  console.log(`read back in ${Date.now() - t0} ms`);
  await card.scrollIntoViewIfNeeded();
  await both(B, 'hp-01-card-1440');
  await card.getByRole('button', { name: 'Show all 46 rows' }).click();
  const rows = card.locator('.hol-row');
  assert.equal(await rows.count(), 46);
  const nov21 = await card.locator('.hol-row', { hasText: '21-Nov-2026' }).innerText();
  assert.match(nov21, /Compensatory work/i);
  assert.match(nov21, /makes up for (6 Nov 2026|Nov 6, 2026)/);
  await card.locator('.hol-row', { hasText: '21-Nov-2026' }).scrollIntoViewIfNeeded();
  await shot(B, 'hp-02-all-rows-1440-light');

  // ---------------------------------------------------------------- 2. register: Nib's summary
  console.log('step 2', Date.now() - t0);
  await card.getByRole('button', { name: 'Register 46 days' }).click();
  await card.locator('.hol-stamp', { hasText: 'Registered on' }).waitFor({ timeout: 10000 });
  const done = B.locator('.nib-card.k-holidays', { hasText: 'HOLIDAYS REGISTERED' });
  await done.waitFor({ timeout: 10000 });
  assert.match(await done.innerText(), /skip these days/);
  await done.scrollIntoViewIfNeeded();
  await both(B, 'hp-03-registered-1440');
  const cal = await owner.request('botjob.calendar');
  assert.equal(cal.days.length, 46);
  assert.equal(cal.holidays.length, 42, 'compensatory working days are not holidays');

  // ---------------------------------------------------------------- 3. Office holidays, with where each day came from
  console.log('step 3', Date.now() - t0);
  await done.getByRole('button', { name: 'Open Office holidays' }).click();
  const panel = B.locator('#office-holidays');
  await panel.waitFor({ timeout: 10000 });
  await panel.locator('.hol-day', { hasText: 'Diwali' }).waitFor();
  const diwali = await panel.locator('.hol-day', { hasText: 'Diwali' }).innerText();
  assert.match(diwali, /Ref HRD\/CIR\/2026\/011 · holidays-2026\.pdf · SHA [0-9a-f]{8} · Sl\. 42/);
  assert.match(await panel.locator('.hol-circulars').innerText(), /Registered on .* by Bhavna Shah/);
  await panel.locator('.hol-day', { hasText: 'Diwali' }).scrollIntoViewIfNeeded();
  await both(B, 'hp-04-office-holidays-1440');
  await B.keyboard.press('Escape');

  // ---------------------------------------------------------------- 4. the same PDF again changes nothing
  console.log('step 4', Date.now() - t0);
  await openNib();
  await B.locator('.dock input[type=file]').setInputFiles([pdf]);
  await sleep(1200);
  await B.locator('.dock textarea').first().press('Enter');
  const again = B.locator('.nib-card.k-holidays', { hasText: 'Already registered on' });
  await again.waitFor({ timeout: 20000 });
  assert.equal(await again.getByRole('button', { name: /^Register/ }).count(), 0);
  await again.scrollIntoViewIfNeeded();
  await shot(B, 'hp-05-already-1440-light');
  assert.equal((await owner.request('botjob.calendar')).days.length, 46);

  // ---------------------------------------------------------------- 4b. a scan (HOLIDAY_SCAN: the circular as images, no text): read on this PC
  if (process.env.HOLIDAY_SCAN) {
    await B.locator('.dock input[type=file]').setInputFiles([process.env.HOLIDAY_SCAN]);
    await sleep(1200);
    await B.locator('.dock textarea').first().press('Enter');
    const scan = B.locator('.nib-card.k-holidays', { hasText: 'This circular is a scan' });
    await scan.waitFor({ timeout: 20000 });
    await scan.scrollIntoViewIfNeeded();
    await shot(B, 'hp-05b-scan-1440-light');
    const t1 = Date.now();
    await scan.getByRole('button', { name: 'Read the scan on this PC' }).click();
    const ocr = B.locator('.nib-card.k-holidays', { hasText: 'Read from a scan on this PC' });
    await ocr.waitFor({ timeout: 180000 });
    const rowsRead = await ocr.locator('.hol-counts .nib-head-n').allInnerTexts();
    console.log(`scan read on the PC in ${Date.now() - t1} ms; counts ${rowsRead.join(' ')}`);
    // a scan never takes a registered day away, however it was read
    assert.equal(await ocr.locator('.hol-removed').count(), 0);
    assert.ok(rowsRead.slice(0, 4).reduce((n, x) => n + Number(x), 0) >= 40, 'most rows read from the scan');
    await ocr.scrollIntoViewIfNeeded();
    await shot(B, 'hp-05c-scan-read-1440-light');
  }

  // ---------------------------------------------------------------- 5. at phone width, light and dark
  console.log('step 5', Date.now() - t0);
  await B.setViewportSize({ width: 390, height: 844 });
  await sleep(600);
  const first = B.locator('.nib-card.k-holidays').first();
  await first.scrollIntoViewIfNeeded();
  await both(B, 'hp-06-card-390');
  const overflow = await B.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(overflow, false, 'no sideways scrolling at 390 px');
  await B.locator('.me-btn').click();
  await B.getByRole('menuitem', { name: /Control room/ }).click();
  await B.getByRole('button', { name: /^Bots & tools/ }).click();
  await B.locator('#office-holidays').scrollIntoViewIfNeeded();
  await B.locator('#office-holidays .hol-day').first().waitFor();
  await both(B, 'hp-07-office-holidays-390');
  await B.keyboard.press('Escape');

  // ---------------------------------------------------------------- 6. in Hindi
  console.log('step 6', Date.now() - t0);
  await B.setViewportSize({ width: 1440, height: 900 });
  await B.evaluate(() => localStorage.setItem('dex.language', 'hi'));
  await B.reload(); await B.locator('.frame').waitFor(); await sleep(800);
  await openNib();
  const hi = B.locator('.nib-card.k-holidays').first();
  await hi.waitFor({ timeout: 15000 });
  await hi.scrollIntoViewIfNeeded();
  await sleep(400);
  assert.match(await hi.innerText(), /अवकाश परिपत्र/);
  await shot(B, 'hp-08-card-hi-1440-light');
  await B.evaluate(() => localStorage.setItem('dex.language', 'en'));
  console.log('HOLIDAYPDF E2E PASSED');
} catch (e) { await shot(B, 'hp-FAIL'); throw e; } finally { await app.close(); owner.disconnect(); await hub.stop(); }
