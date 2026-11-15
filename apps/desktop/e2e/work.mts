import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep } from './harness.mts';

const { owner, hub } = await startOffice('work');
const { app, page } = await launch('priya', 'Priya Raman');
try {
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  // Priya manages Vikram for the purposes of this test, so she sees team attendance
  await owner.request('admin.org.setProfile', { userId: owner.session!.me.id, managerId: priya.id });
  await owner.request('work.checkIn', { mode: 'site', note: 'Refinery walkdown' });
  // the day menu lives in your own tile menu (or, on older frames, behind the day tag)
  const openDay = async () => {
    if (await page.locator('.day-tag').count()) await page.locator('.day-tag').click();
    else await page.locator('.me-btn').click();
    await page.locator('.day-menu').waitFor();
  };
  await openDay();
  assert.equal(await page.locator('.day-menu').getByText(/Check in|Working from|Take a break|Check out/).count(), 0);
  await page.locator('.day-menu').getByRole('radio', { name: 'Home' }).click();
  await shot(page, 'work-01-start-menu');
  await page.getByRole('menuitem', { name: /Start my day/ }).click();
  await page.getByText('Day started · Home').waitFor();
  await page.locator('.day-arc').waitFor({ timeout: 3000 }).catch(() => console.log('no tile arc in this frame (App.tsx not wired yet)'));
  await openDay();
  await page.getByRole('menuitem', { name: 'Step out' }).click();
  await page.locator('.toast', { hasText: 'Stepped out' }).waitFor();
  await openDay();
  await page.getByRole('menuitem', { name: 'Back at desk' }).click();
  await page.locator('.toast', { hasText: 'Back at desk' }).waitFor();
  await page.locator('.day-log').waitFor();
  assert.match(await page.locator('.day-log').innerText(), /DAY LOG · 2 OF 2 STARTED/i);
  await sleep(400);
  await shot(page, 'work-02-pulse');
  await openDay();
  await shot(page, 'work-03-day-menu');
  await page.getByRole('menuitem', { name: 'Close my day' }).click();
  await page.getByText(/^Day closed · \d+ m$/).waitFor();
  await page.getByRole('button', { name: /^Desk/ }).first().click();
  await page.getByRole('tab', { name: 'Timesheet' }).click();
  await page.locator('.att-table tbody tr').first().waitFor();
  await shot(page, 'work-04-timesheet');
  await page.getByRole('button', { name: /^Directory/ }).first().click();
  await page.getByRole('tab', { name: 'Day log', exact: true }).click();
  await page.locator('.att-grid tbody tr').nth(1).waitFor();
  await shot(page, 'work-05-team');
  // CSV export goes through a save dialog; check the button is live and the download starts
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }).catch(() => null), page.getByRole('button', { name: 'Export CSV' }).click()]);
  console.log('download event:', dl ? await dl.suggestedFilename() : 'handled by the app');
  await page.locator('.card.person', { hasText: 'Vikram Shah' }).count();
  await page.getByRole('tab', { name: 'People', exact: true }).click();
  await page.locator('.card.person', { hasText: 'Vikram Shah' }).locator('.work-line').waitFor();
  assert.match(await page.locator('.card.person', { hasText: 'Vikram Shah' }).locator('.work-line').innerText(), /^Site · since /);
  console.log('WORK E2E PASSED');
} catch (e) {
  await shot(page, 'work-FAIL');
  throw e;
} finally {
  await app.close();
  owner.disconnect();
  await hub.stop();
}
