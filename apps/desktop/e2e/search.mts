import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep } from './harness.mts';
const { owner, hub } = await startOffice('search');
const { app, page } = await launch('priya', 'Priya Raman');
try {
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  const sp = await owner.request('conv.create', { kind: 'space', name: 'P-12 Piping', members: [priya.id] });
  const site = await owner.request('conv.create', { kind: 'space', name: 'Site team', members: [priya.id] });
  await owner.request('msg.send', { convId: sp.id, body: 'Valve schedule for area 3 is ready', clientId: 'a' });
  await owner.request('msg.send', { convId: site.id, body: 'Valve pit flooded, check the drawings', clientId: 'b' });
  await page.evaluate((id) => window.dex.request('msg.send', { convId: id, body: 'Valve schedule reviewed, two comments', clientId: 'c' }), sp.id);
  await page.keyboard.press('Control+Shift+F');
  await page.getByLabel('Search messages and files').fill('valve');
  await page.locator('.search-hit').nth(2).waitFor();
  assert.equal(await page.locator('.search-hit').count(), 3);
  // from Priya only
  await page.getByRole('button', { name: 'By anyone' }).click();
  await page.locator('.pick-menu input').fill('priya');
  await page.locator('.pick-menu button', { hasText: 'Priya Raman' }).click();
  await sleep(500);
  assert.equal(await page.locator('.search-hit').count(), 1);
  await page.getByRole('button', { name: 'Clear person' }).click();
  // in one conversation
  await page.getByRole('button', { name: 'In every conversation' }).click();
  await page.locator('.pick-menu button', { hasText: 'Site team' }).click();
  await sleep(500);
  assert.equal(await page.locator('.search-hit').count(), 1);
  await page.getByRole('button', { name: 'Clear conversation' }).click();
  await page.getByRole('button', { name: 'When any time' }).click();
  await page.getByRole('menuitemradio', { name: 'Today' }).click();
  await sleep(500);
  assert.equal(await page.locator('.search-hit').count(), 3);
  assert.equal(await page.getByRole('tab', { name: /^Text/ }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.getByText(/From anyone|In any conversation|Has files/).count(), 0);
  await page.getByRole('button', { name: 'Files with or without' }).click();
  await page.getByRole('button', { name: 'Files attached only' }).waitFor();
  await shot(page, 'search-01');
  await page.getByRole('button', { name: 'Files attached only' }).click();
  await sleep(400);
  // open a result
  await page.locator('.search-hit', { hasText: 'pit flooded' }).click();
  await page.locator('.msg', { hasText: 'pit flooded' }).waitFor();
  // search inside a conversation from its header
  await page.getByRole('button', { name: 'More for this conversation' }).click();
  await page.getByRole('menuitem', { name: 'Search this conversation' }).click();
  await page.getByRole('button', { name: /^In Site team/ }).waitFor();
  await shot(page, 'search-02-scoped');
  console.log('SEARCH E2E PASSED');
} catch (e) { await shot(page, 'search-FAIL'); throw e; } finally { await app.close(); owner.disconnect(); await hub.stop(); }
