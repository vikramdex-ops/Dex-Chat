import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep } from './harness.mts';

const { owner, hub } = await startOffice('m5a');
const { app, page } = await launch('priya', 'Priya Raman');
let guestApp: any = null;
try {
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  await owner.request('admin.setRole', { userId: priya.id, role: 'admin' });
  const space = await owner.request('conv.create', { kind: 'space', name: 'Client P-12', members: [priya.id] });
  // slash commands
  await page.getByRole('button', { name: /^Spaces/ }).first().click();
  await page.locator('.sb-row, .switch-row, [class*=sb]').filter({ hasText: 'Client P-12' }).first().click();
  const dock = page.locator('.dock textarea').first();
  await dock.fill('/re');
  await page.locator('.slash-pop').waitFor();
  await shot(page, 'm5a-01-slash');
  await dock.press('Tab');
  await dock.type('in 30m Send the GA drawing');
  await dock.press('Enter');
  await page.getByText(/Reminder set for/).waitFor();
  await dock.fill('/poll Site visit day? | Wed | Thu | Fri');
  await dock.press('Enter');
  await page.locator('.poll').waitFor();
  await dock.fill('/shrug no idea');
  await dock.press('Enter');
  await page.locator('.timeline').getByText('¯\\_(ツ)_/¯').waitFor();
  await dock.fill('/status At the client office');
  await dock.press('Enter');
  await page.getByText('Status updated').waitFor();
  // renamed status and day commands are offered
  await dock.fill('/head');
  await page.locator('.slash-pop', { hasText: '/headsdown' }).waitFor();
  await dock.fill('/startday site');
  await dock.press('Enter');
  await page.getByText('Day started · Site').waitFor();
  await dock.fill('/stepout');
  await page.locator('.slash-pop', { hasText: '/stepout' }).waitFor();
  await dock.fill('/checkin');
  await dock.press('Enter');
  await page.getByText(/There is no \/checkin command/).waitFor();
  await dock.fill('/nonsense');
  await dock.press('Enter');
  await page.getByText(/There is no \/nonsense command/).waitFor();
  const rems = await page.evaluate(() => window.dex.request('remind.list'));
  assert.equal(rems[0].text, 'Send the GA drawing');
  await shot(page, 'm5a-02-after-commands');
  // guests tab: create an invite
  await page.locator('.me-btn').click();
  await page.getByRole('menuitem', { name: /Control room/ }).click();
  await page.getByRole('button', { name: 'Guests', exact: true }).click();
  await page.getByRole('button', { name: 'Client P-12', exact: true }).click();
  await page.getByRole('button', { name: 'Create invite code' }).click();
  const code = (await page.locator('.code.big').innerText()).trim();
  assert.match(code, /^DEX-/);
  await shot(page, 'm5a-03-invite');
  // a guest joins with it through the join screen
  const g = await launch('ana', 'Ana Client', { invite: code });
  guestApp = g.app;
  await g.page.getByRole('button', { name: /^Spaces/ }).first().click();
  // the Space shows on the Switchboard's tile strip (its name is in the tile) and opens in a Pane
  await g.page.locator('.sb-row', { hasText: 'Client P-12' }).waitFor();
  await g.page.locator('.pane-title h2', { hasText: 'Client P-12' }).waitFor();
  await shot(g.page, 'm5a-04-guest-view');
  const gs = await g.page.evaluate(() => window.dex.getState());
  assert.equal(gs.session.me.role, 'guest');
  assert.deepEqual(gs.session.users.map((u: any) => u.displayName).sort(), ['Ana Client', 'Priya Raman', 'Vikram Shah']);
  // compliance tab
  await page.getByRole('button', { name: 'Compliance', exact: true }).click();
  await page.getByLabel('Messages in Spaces').waitFor();
  await page.locator('select[multiple]').first().selectOption(space.id);
  await shot(page, 'm5a-05-compliance');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByText(/Exported \d+ messages/).waitFor();
  console.log('M5A E2E PASSED');
} catch (e) {
  await shot(page, 'm5a-FAIL');
  throw e;
} finally {
  await guestApp?.close();
  await app.close();
  owner.disconnect();
  await hub.stop();
}
