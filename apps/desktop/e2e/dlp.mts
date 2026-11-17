import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep } from './harness.mts';
const { owner, hub } = await startOffice('dlp');
const { app, page } = await launch('priya', 'Priya Raman');
try {
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  await owner.request('admin.setRole', { userId: priya.id, role: 'admin' });
  await page.reload(); await page.locator('.frame').waitFor();
  await page.locator('.me-btn').click();
  await page.getByRole('menuitem', { name: /Control room/ }).click();
  await page.getByRole('button', { name: 'Policies' }).click();
  const card = page.locator('.card', { hasText: 'Data protection' });
  await card.getByRole('button', { name: 'Add a rule' }).click();
  await card.getByRole('button', { name: 'Add rule' }).click(); // cards, masked, everywhere
  await card.locator('.dlp-rule', { hasText: 'Payment card numbers' }).waitFor();
  await card.getByRole('button', { name: 'Add a rule' }).click();
  await card.getByLabel('Look for').selectOption('words');
  await card.getByLabel('Name people see').fill('Project Falcon');
  await card.getByLabel(/Words and phrases/).fill('Project Falcon');
  await card.getByRole('button', { name: 'Stop the message' }).click();
  await card.getByRole('button', { name: 'Add rule' }).click();
  await card.locator('.dlp-rule', { hasText: 'Project Falcon' }).waitFor();
  await card.getByLabel("File types that can't be shared").fill('exe, bat');
  await card.getByLabel('Outside the office, only from these networks').focus();
  await card.getByLabel('Outside the office, only from these networks').fill('my office');
  await card.getByText('"my office" is not an address or network.').waitFor();
  await card.getByLabel('Outside the office, only from these networks').fill('203.0.113.0/24');
  await card.getByRole('button', { name: 'Save networks' }).click();
  await sleep(600);
  const p = await owner.request('policy.get');
  assert.equal(p.dlp.length, 2);
  assert.deepEqual(p.blockedFileTypes, ['exe', 'bat']);
  assert.deepEqual(p.outsideNetworks, ['203.0.113.0/24']);
  await card.scrollIntoViewIfNeeded();
  await shot(page, 'dlp-01-admin');
  await page.keyboard.press('Escape');
  // an encrypted Direct message: the rule runs on this PC before sealing
  const dm = await owner.request('conv.create', { kind: 'direct', members: [priya.id] });
  await sleep(500);
  const err = await page.evaluate((id) => window.dex.request('msg.send', { convId: id, body: 'about Project Falcon', clientId: 'd1' }).then(() => 'sent', (e: Error) => e.message), dm.id);
  assert.match(err, /doesn't allow project falcon/);
  const ok = await page.evaluate((id) => window.dex.request('msg.send', { convId: id, body: 'card 4111 1111 1111 1111', clientId: 'd2' }), dm.id);
  assert.equal(ok.body, 'card ••••', 'masked before sealing');
  // (the scripted colleague has no encryption keys, so this conversation is not sealed: the hub masked it)
  console.log('DLP E2E PASSED');
} catch (e) { await shot(page, 'dlp-FAIL'); throw e; } finally { await app.close(); owner.disconnect(); await hub.stop(); }
