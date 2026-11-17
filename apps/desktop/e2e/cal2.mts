import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep } from './harness.mts';
const { owner, hub } = await startOffice('cal2');
const { app, page } = await launch('priya', 'Priya Raman');
try {
  await page.getByRole('button', { name: /^Calendar/ }).first().click();
  await page.locator('.week').waitFor();
  const firstDay = () => page.locator('.week-day b').first().innerText();
  assert.equal((await firstDay()).toLowerCase(), 'mon');
  await page.getByRole('button', { name: 'Calendar settings' }).click();
  await page.getByRole('button', { name: 'Sunday' }).click();
  await page.getByLabel('Also show times in').selectOption('Asia/Dubai');
  await page.getByRole('button', { name: 'Done' }).click();
  assert.equal((await firstDay()).toLowerCase(), 'sun');
  await page.locator('.week.two-zones .week-hours .z2').nth(5).waitFor();
  // the Dubai column is 4 hours ahead of this PC (UTC in the test)
  const tz = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  console.log('local zone', tz);
  // a meeting set at 10:00 Dubai time
  await page.getByRole('button', { name: 'New meeting' }).click();
  await page.getByLabel('Title', { exact: true }).fill('Client call: Dubai site');
  await page.getByLabel('Time zone').selectOption('Asia/Dubai');
  const day = new Date(Date.now() + 2 * 86400_000); const ymd = day.toISOString().slice(0, 10);
  await page.getByLabel('Starts').fill(`${ymd}T10:00`);
  await page.getByText(/your time\. Invitees see it/).waitFor();
  await shot(page, 'cal2-01-dialog');
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await sleep(1200);
  await shot(page, 'cal2-01b-after-save');
  const list = await page.evaluate(() => window.dex.request('cal.list', { from: Date.now() - 86400_000, to: Date.now() + 5 * 86400_000 }));
  const ev = list.find((o: any) => o.event.title === 'Client call: Dubai site');
  assert.ok(ev, 'created');
  assert.equal(ev.event.timeZone, 'Asia/Dubai');
  assert.equal(new Date(ev.startAt).toISOString(), `${ymd}T06:00:00.000Z`);
  if (!(await page.locator('.cal-block', { hasText: 'Client call' }).count())) await page.getByRole('button', { name: 'Next week' }).click();
  await page.locator('.cal-block', { hasText: 'Client call' }).click();
  await page.getByText(/in Dubai/).waitFor();
  await shot(page, 'cal2-02-details');
  await page.keyboard.press('Escape');
  await shot(page, 'cal2-03-week');
  console.log('CAL2 E2E PASSED');
} catch (e) { await shot(page, 'cal2-FAIL'); throw e; } finally { await app.close(); owner.disconnect(); await hub.stop(); }
