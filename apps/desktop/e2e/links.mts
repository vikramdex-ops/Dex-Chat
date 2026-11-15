import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep } from './harness.mts';
const { owner, hub } = await startOffice('links');
const { app, page } = await launch('priya', 'Priya Raman');
try {
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  const vikram = users.find((u: any) => u.account.endsWith('vikram'))!;
  const sp = await owner.request('conv.create', { kind: 'space', name: 'Piping', members: [priya.id] });
  const src = await owner.request('msg.send', { convId: sp.id, body: 'Rev C of ISO-1001 is the one to use', clientId: 'l1' });
  await owner.request('msg.send', { convId: sp.id, body: `See dexconnect://message/${sp.id}/${src.id}`, clientId: 'l2' });
  await page.getByRole('button', { name: /^Spaces/ }).first().click();
  await page.locator('.sb-row', { hasText: 'Piping' }).click();
  const card = page.locator('.msg-link-card');
  await card.waitFor();
  assert.match(await card.innerText(), /Vikram Shah/);
  assert.match(await card.innerText(), /Rev C of ISO-1001/);
  await shot(page, 'links-01-card');
  // a link to a message priya cannot see falls back to the plain chip
  const hidden = await owner.request('conv.create', { kind: 'space', name: 'Private', members: [] });
  const hm = await owner.request('msg.send', { convId: hidden.id, body: 'secret', clientId: 'l3' });
  await owner.request('msg.send', { convId: sp.id, body: `and dexconnect://message/${hidden.id}/${hm.id}`, clientId: 'l4' });
  await page.locator('.tool-link', { hasText: 'Open the message' }).waitFor();
  assert.equal(await page.locator('.msg-link-card').count(), 1);
  // profile: Spaces and calls in common
  const dm = await owner.request('conv.create', { kind: 'direct', members: [priya.id] });
  hub.policies.logCall('c1', dm.id, vikram.id, false, false, 95_000);
  await page.getByRole('button', { name: /^People|^Directory/ }).first().click();
  await page.getByText('Vikram Shah').first().click();
  const common = page.locator('.in-common');
  await common.waitFor();
  assert.match(await common.innerText(), /Spaces in common · 1/i);
  assert.match(await common.innerText(), /Piping/i);
  assert.match(await common.innerText(), /2 min/);
  await shot(page, 'links-02-common');
  await common.getByRole('button', { name: '# Piping' }).click();
  await page.locator('.msg-link-card').waitFor();
  console.log('LINKS E2E PASSED');
} catch (e) { await shot(page, 'links-FAIL'); throw e; } finally { await app.close(); owner.disconnect(); await hub.stop(); }
