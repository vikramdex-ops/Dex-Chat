import { startOffice, launch, shot, sleep } from './harness.mts';
const { owner, hub } = await startOffice('phone');
const { app, page } = await launch('priya', 'Priya Raman', { width: 390, height: 844 });
try {
  const win = await app.browserWindow(page);
  await win.evaluate((w: any) => w.setSize(390, 844));
  await page.setViewportSize({ width: 390, height: 844 });
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  const space = await owner.request('conv.create', { kind: 'space', name: 'P-12 Site', members: [priya.id] });
  await owner.request('msg.send', { convId: space.id, body: 'Morning! Revised **isometrics** are up.', clientId: 'p1' });
  await owner.request('poll.create', { convId: space.id, question: 'Site visit day?', options: ['Wed', 'Thu'], clientId: 'p2' });
  const t = new Date(); t.setHours(t.getHours() + 2, 0, 0, 0);
  await owner.request('cal.create', { title: 'Design review', startAt: t.getTime(), endAt: t.getTime() + 3600_000, attendees: [priya.id], online: true });
  await sleep(1500);
  await shot(page, 'phone-01-pulse');
  // at most five lenses on the strip, Preferences lives in the tile menu
  const lenses = await page.locator('.lens-dock .lens').allInnerTexts();
  if (lenses.length > 5 || lenses.some((l) => /Preferences/.test(l))) throw new Error(`lens strip: ${lenses.join(', ')}`);
  await page.locator('.lens-dock').getByRole('button', { name: /Switchboard/ }).click();
  await page.locator('.sb-row', { hasText: 'P-12 Site' }).waitFor();
  await shot(page, 'phone-02-switchboard');
  await page.locator('.sb-row', { hasText: 'P-12 Site' }).click();
  await page.locator('.poll').waitFor();
  await page.evaluate((id) => window.dex.request('msg.send', { convId: id, body: 'On my way to site.', clientId: 'm1' }), space.id);
  await sleep(500);
  await shot(page, 'phone-03-space');
  // sheets come from the ⋯ menu on a phone
  await page.getByRole('button', { name: 'More for this conversation' }).click();
  await page.getByRole('menuitem', { name: 'People' }).click();
  await page.locator('.side-panel[aria-label="People"]').waitFor();
  await shot(page, 'phone-04-people-sheet');
  await page.getByRole('button', { name: 'Close' }).click();
  // tapping the Switchboard lens again goes back to the list
  await page.locator('.lens-dock').getByRole('button', { name: /Switchboard/ }).click();
  await page.locator('.switchboard').waitFor();
  await page.locator('.lens-dock').getByRole('button', { name: /Calendar/ }).click();
  await sleep(600);
  await shot(page, 'phone-05-calendar');
  await page.locator('.lens-dock').getByRole('button', { name: /Desk/ }).click();
  await sleep(400);
  await shot(page, 'phone-06-desk');
  await page.locator('.me-btn').click();
  await page.getByRole('menuitem', { name: /Preferences/ }).waitFor();
  await shot(page, 'phone-07-tile-menu');
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.dex.setSettings({ theme: 'dark' }));
  await page.locator('.lens-dock').getByRole('button', { name: /Switchboard/ }).click();
  await page.locator('.sb-row', { hasText: 'P-12 Site' }).click();
  await sleep(500);
  await shot(page, 'phone-08-space-dark');
  console.log('PHONE SHOTS DONE');
} catch (e) { await shot(page, 'phone-FAIL'); throw e; } finally {
  await app.close(); owner.disconnect(); await hub.stop();
}
