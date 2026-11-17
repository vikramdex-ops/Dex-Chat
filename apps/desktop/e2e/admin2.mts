import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep } from './harness.mts';
const { owner, hub } = await startOffice('admin2');
const { app, page } = await launch('priya', 'Priya Raman');
try {
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  await owner.request('admin.setRole', { userId: priya.id, role: 'admin' });
  const sp = await owner.request('conv.create', { kind: 'space', name: 'General', members: [priya.id] });
  const bad = await owner.request('msg.send', { convId: sp.id, body: 'This message breaks the rules', clientId: 'b1' });
  await owner.request('msg.send', { convId: sp.id, body: 'Should we vote?', clientId: 'b2' });
  await page.reload(); await page.locator('.frame').waitFor();
  await page.getByRole('button', { name: /^Spaces/ }).first().click();
  await page.locator('.sb-row', { hasText: 'General' }).click();
  const msg = page.locator('.msg', { hasText: 'This message breaks the rules' });
  await msg.waitFor(); await msg.hover(); await msg.getByTitle('More', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Report to administrators…' }).click();
  await page.getByLabel('Harassment').check();
  await page.getByRole('dialog').getByRole('button', { name: 'Report' }).click();
  await sleep(500);
  // the Control room shows it; remove it from there
  await page.locator('.me-btn').click();
  await page.getByRole('menuitem', { name: /Control room/ }).click();
  await page.getByRole('button', { name: /^Reports/ }).click();
  await page.locator('.report', { hasText: 'Harassment' }).waitFor();
  await shot(page, 'admin2-01-reports');
  await page.locator('.report').getByRole('button', { name: 'Remove the message' }).click();
  await sleep(400);
  await page.keyboard.press('Escape');
  await page.locator('.msg.deleted', { hasText: 'Removed by you: Harassment' }).waitFor();
  // a moderator removes with a reason
  const q = page.locator('.msg', { hasText: 'Should we vote?' });
  await q.hover(); await q.getByTitle('More', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Remove…' }).click();
  await page.getByLabel('Off topic here').check();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await page.locator('.msg.deleted', { hasText: 'Removed by you: Off topic here' }).waitFor();
  const rows = (await owner.request('msg.list', { convId: sp.id })).messages;
  assert.equal(rows.find((m: any) => m.id === bad.id).removed.reason, 'Harassment');
  await shot(page, 'admin2-02-removed');
  console.log('ADMIN2 E2E PASSED');
} catch (e) { await shot(page, 'admin2-FAIL'); throw e; } finally { await app.close(); owner.disconnect(); await hub.stop(); }
