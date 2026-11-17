// Several owners: an owner makes a colleague an owner from Control room ▸ People & roles, then steps
// down to administrator; the list locks what an administrator may not change. Screenshots in out/.
import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep } from './harness.mts';
const { owner, hub } = await startOffice('owners');
const { app, page } = await launch('priya', 'Priya Raman');
const roleOf = async (id: string) => (await owner.request('directory.list')).users.find((u: any) => u.id === id).role;
try {
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  const vikram = users.find((u: any) => u.account.endsWith('vikram'))!;
  // Vikram, the first owner, makes Priya an owner too
  await owner.request('admin.setRole', { userId: priya.id, role: 'owner' });
  await page.reload(); await page.locator('.frame').waitFor();
  await page.locator('.me-btn').click();
  await page.getByRole('menuitem', { name: /Control room/ }).click();
  await page.getByRole('button', { name: /^People & roles/ }).click();
  const vikramRole = page.getByLabel('Role for Vikram Shah');
  const myRole = page.getByLabel('Role for Priya Raman');
  await vikramRole.waitFor();
  // two owners: she may change Vikram, and step down herself (Owner or Admin only)
  assert.deepEqual(await myRole.locator('option').allTextContents(), ['Owner', 'Admin']);
  assert.deepEqual(await vikramRole.locator('option').allTextContents(), ['Owner', 'Admin', 'Member', 'Guest']);
  await shot(page, 'owners-01-two-owners');
  // Vikram becomes an administrator (no question for that)
  await vikramRole.selectOption('admin');
  await page.getByText('Vikram Shah is now admin').waitFor();
  assert.equal(await roleOf(vikram.id), 'admin');
  // now she is the only owner: her own role is locked
  await page.locator('.list-row.roles', { hasText: 'Priya Raman' }).locator('.chip', { hasText: 'Owner' }).waitFor();
  // making him an owner again asks first; Keep it changes nothing
  await vikramRole.selectOption('owner');
  const ask = page.getByRole('dialog');
  await ask.getByText('Make Vikram Shah an owner?').waitFor();
  await shot(page, 'owners-02-make-owner');
  await ask.getByRole('button', { name: /Keep it|Cancel/ }).click();
  await sleep(300);
  assert.equal(await roleOf(vikram.id), 'admin');
  assert.equal(await vikramRole.inputValue(), 'admin');
  await vikramRole.selectOption('owner');
  await page.getByRole('dialog').getByRole('button', { name: 'Make owner' }).click();
  await page.getByText('Vikram Shah is now owner').waitFor();
  assert.equal(await roleOf(vikram.id), 'owner');
  // she steps down to administrator
  await myRole.waitFor();
  await myRole.selectOption('admin');
  await page.getByRole('dialog').getByText('Step down to administrator?').waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Step down' }).click();
  await page.getByText('You are now an administrator').first().waitFor();
  assert.equal(await roleOf(priya.id), 'admin');
  // as an administrator she cannot change the owner
  await page.locator('.list-row.roles', { hasText: 'Vikram Shah' }).locator('.chip', { hasText: 'Owner' }).waitFor();
  await page.locator('.list-row.roles', { hasText: 'Priya Raman' }).locator('.chip', { hasText: 'Admin' }).waitFor();
  await shot(page, 'owners-03-stepped-down');
  const trail = await owner.request('admin.audit', {});
  assert.ok(trail.filter((a: any) => a.action === 'user.role').length >= 4, 'every change is in the audit log');
  console.log('OWNERS E2E PASSED');
} finally {
  await app.close();
  owner.disconnect();
  await hub.stop();
}
process.exit(0);
