import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep } from './harness.mts';
const { owner, hub } = await startOffice('parity');
const { app, page } = await launch('priya', 'Priya Raman');
try {
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  const a = await owner.request('conv.create', { kind: 'space', name: 'Announcements', members: [priya.id] });
  const b = await owner.request('conv.create', { kind: 'space', name: 'P-12 Piping', members: [priya.id] });
  await owner.request('conv.create', { kind: 'space', name: 'Old bid', members: [priya.id] });
  await owner.request('conv.settings', { convId: a.id, postPolicy: 'moderators' });
  await owner.request('msg.send', { convId: b.id, body: 'Please check 6"-P-1001-A1B on ISO-1001-01, set is projectopener://open/P12513 and the sheet is dexterity://open/hub/mto-p12', clientId: 'x1' });
  await owner.request('me.update', { ooo: { until: Date.now() + 3 * 86400_000, message: 'At the Jamnagar site', delegateId: priya.id } });
  await page.getByRole('button', { name: /^Spaces/ }).first().click();
  // keep on top and drawers from the row menu (the Switchboard opened from its tile strip)
  await page.getByTitle('Open the Switchboard').click();
  await page.getByRole('button', { name: 'Options for P-12 Piping' }).click({ force: true });
  await page.getByRole('menuitem', { name: 'Keep on top' }).click();
  await page.locator('.sb-group-title', { hasText: 'Kept on top' }).waitFor();
  await page.getByRole('button', { name: 'Options for Old bid' }).click({ force: true });
  await page.getByRole('menuitem', { name: 'New drawer…' }).click();
  await page.getByLabel('Drawer name').fill('Clients');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.locator('.sb-group-title', { hasText: 'Clients' }).waitFor();
  await page.locator('.sb-row', { has: page.locator('.sb-name', { hasText: /^Announcements$/ }) }).click();
  await page.locator('.dock-locked').waitFor();
  await page.locator('.sb-row', { hasText: 'P-12 Piping' }).click();
  await page.locator('.tool-link').first().waitFor();
  assert.equal(await page.locator('.tool-link').count(), 2);
  assert.equal(await page.locator('.line-ref').count(), 2);
  await shot(page, 'parity-01-sidebar-links');
  // out of office shows in a Direct conversation with Vikram
  const dm = await page.evaluate((id) => window.dex.request('conv.create', { kind: 'direct', members: [id] }), users.find((u: any) => u.account.endsWith('vikram'))!.id);
  await page.getByRole('button', { name: /^Direct/ }).first().click();
  await page.locator('.ooo-banner').waitFor();
  await shot(page, 'parity-02-ooo');
  // timed No interruptions from the tile menu: the rest of today
  await page.locator('.me-btn').click();
  await page.getByRole('menuitemradio', { name: /No interruptions/ }).click();
  await page.getByRole('button', { name: 'Rest of today' }).click();
  await sleep(600);
  const me = (await owner.request('directory.list')).users.find((u: any) => u.id === priya.id);
  assert.equal(me.availability, 'dnd');
  const end = new Date(); end.setHours(23, 59, 0, 0);
  assert.equal(me.availabilityUntil, end.getTime());
  // hatched ring on my own tile
  assert.equal(await page.locator('.me-btn .avatar').getAttribute('data-presence'), 'dnd');
  // Hush from the row menu
  await page.getByRole('button', { name: /^Spaces/ }).first().click();
  await page.getByRole('button', { name: 'Options for Old bid' }).click({ force: true });
  await page.getByRole('menuitem', { name: /Until I turn it back on/ }).click();
  await page.getByText('Hushed. Callouts to you still come through.').waitFor();
  await shot(page, 'parity-03-hush');
  void dm;
  console.log('PARITY E2E PASSED');
} catch (e) { await shot(page, 'parity-FAIL'); throw e; } finally { await app.close(); owner.disconnect(); await hub.stop(); }
