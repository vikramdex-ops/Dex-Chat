import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep } from './harness.mts';
const { owner, hub } = await startOffice('acts');
const { app, page } = await launch('priya', 'Priya Raman');
try {
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  const sp = await owner.request('conv.create', { kind: 'space', name: 'P-12 Piping', members: [priya.id] });
  const other = await owner.request('conv.create', { kind: 'space', name: 'Site team', members: [priya.id] });
  for (let i = 1; i <= 4; i++) await owner.request('msg.send', { convId: sp.id, body: `Update ${i}: line 10${i} checked`, clientId: `c${i}` });
  await page.getByRole('button', { name: /^Spaces/ }).first().click();
  await page.locator('.sb-row', { hasText: 'P-12 Piping' }).click();
  const msg = (n: number) => page.locator('.msg', { hasText: `Update ${n}:` });
  await msg(4).waitFor();
  // quote
  await msg(2).hover(); await msg(2).getByTitle('More', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Quote' }).click();
  const dock = page.locator('.dock textarea').first();
  assert.match(await dock.inputValue(), /^> \*\*Vikram Shah:\*\* Update 2/);
  await dock.fill('');
  // copy link, then paste it as a message and follow it
  await msg(1).hover(); await msg(1).getByTitle('More', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Copy reference' }).click();
  await sleep(400);
  const link = await app.evaluate(({ clipboard }) => clipboard.readText());
  assert.match(link, /^dexconnect:\/\/message\/[\w-]+\/[\w-]+$/);
  await owner.request('msg.send', { convId: other.id, body: `See ${link}`, clientId: 'l1' });
  await page.locator('.sb-row', { hasText: 'Site team' }).click();
  await page.getByRole('button', { name: /Open the message/ }).click();
  await page.locator('.msg.flash, .msg.highlight, .msg', { hasText: 'Update 1:' }).first().waitFor();
  assert.equal(await page.locator('.pane-title, .pane-head').first().innerText().then((t) => t.includes('P-12 Piping')), true);
  // multi-select and forward two messages
  await msg(3).hover(); await msg(3).getByTitle('More', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Pick several' }).click();
  await msg(4).click();
  await page.locator('.select-bar', { hasText: '2 picked' }).waitFor();
  await shot(page, 'acts-01-select');
  await page.locator('.select-bar').getByRole('button', { name: 'Keep' }).click();
  await sleep(500);
  assert.equal((await page.evaluate(() => window.dex.request('desk.saved'))).length, 2);
  await page.locator('.select-bar').getByRole('button', { name: 'Forward' }).click();
  await page.locator('.dialog .picker-row, .dialog button', { hasText: 'Site team' }).first().click();
  await page.locator('.dialog').getByRole('button', { name: /^Forward/ }).last().click();
  await sleep(800);
  const tl = await owner.request('msg.list', { convId: other.id });
  const bodies = (tl.messages ?? tl).map((m: any) => m.body);
  assert.ok(bodies.some((b: string) => b.includes('Update 3')) && bodies.some((b: string) => b.includes('Update 4')), JSON.stringify(bodies));
  assert.equal(await page.locator('.select-bar').count(), 0);
  // Take to Direct opens a Direct conversation with the quote in the dock
  await page.locator('.sb-row', { hasText: 'P-12 Piping' }).click();
  await msg(2).hover(); await msg(2).getByTitle('More', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Take to Direct' }).click();
  await sleep(800);
  assert.match(await page.locator('.dock textarea').first().inputValue(), /Update 2/);
  assert.match(await page.locator('.pane-title h2').first().innerText(), /Vikram Shah/);
  await shot(page, 'acts-02-private');
  console.log('ACTS E2E PASSED');
} catch (e) { await shot(page, 'acts-FAIL'); throw e; } finally { await app.close(); owner.disconnect(); await hub.stop(); }
