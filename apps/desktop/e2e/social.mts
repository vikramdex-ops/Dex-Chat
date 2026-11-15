import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep } from './harness.mts';
const { owner, hub } = await startOffice('social');
const { app, page } = await launch('priya', 'Priya Raman');
try {
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  const vikram = users.find((u: any) => u.account.endsWith('vikram'))!;
  const sp = await owner.request('conv.create', { kind: 'space', name: 'Site team', members: [priya.id] });
  await page.getByRole('button', { name: /^Spaces/ }).first().click();
  await page.locator('.sb-row', { hasText: 'Site team' }).click();
  // my message: a hollow amber notch, solid once Vikram has seen it; "Who has seen it" lists him
  const mine = await page.evaluate((id) => window.dex.request('msg.send', { convId: id, body: 'Drawings uploaded', clientId: 's1' }), sp.id);
  const msg = page.locator('.msg', { hasText: 'Drawings uploaded' });
  await msg.locator('.notch.sent').waitFor();
  assert.equal(await page.locator('.tick, .seen').count(), 0, 'no tick glyphs');
  await owner.request('conv.read', { convId: sp.id, messageId: mine.id });
  await msg.locator('.notch.all').waitFor();
  await msg.hover();
  assert.equal(await msg.locator('.seen-tag').innerText(), 'SEEN');
  await msg.getByTitle('More', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Who has seen it' }).click();
  await page.getByRole('dialog', { name: 'Who has seen it' }).getByText('Vikram Shah').waitFor();
  await shot(page, 'social-01-readby');
  await page.keyboard.press('Escape');
  // notices
  await owner.request('conv.update', { convId: sp.id, name: 'Site team (Jamnagar)' });
  await page.locator('.notice-line', { hasText: 'renamed the Space to “Site team (Jamnagar)”' }).waitFor();
  // side-track reply also sent to the Space
  await owner.request('msg.send', { convId: sp.id, body: 'Is the rack fabricated?', clientId: 'q1' });
  const q = page.locator('.msg', { hasText: 'Is the rack fabricated?' });
  await q.waitFor(); await q.hover();
  await q.getByTitle('Side-track').first().click();
  const track = page.locator('.track, .side-track, aside').filter({ has: page.locator('textarea') }).last();
  await page.locator('.track-leader path').waitFor({ state: 'attached' });
  await page.getByLabel(/Echo in the Space/).check();
  const tdock = page.locator('textarea').last();
  await tdock.fill('Yes, painted too');
  await tdock.press('Enter');
  await page.locator('.in-reply', { hasText: 'Replied in a side-track to Vikram Shah' }).waitFor({ timeout: 8000 });
  await q.locator('.branch-tag', { hasText: /Side-track · 1/i }).waitFor();
  await shot(page, 'social-02-track');
  void track;
  // stamps on hand are mine to choose
  await page.keyboard.press('Control+,');
  await page.getByRole('heading', { name: 'Stamps on hand' }).waitFor();
  await page.getByRole('button', { name: 'Stamp 1: 👍' }).click();
  await page.getByLabel('Find an emoji').fill('chai');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Stamp 1: 🍵' }).waitFor();
  // status emoji and read receipts off
  await page.getByLabel('Status emoji').click();
  await page.getByLabel('Find an emoji').fill('construction');
  await page.keyboard.press('Enter');
  await page.locator('#s-status').fill('At the Jamnagar site');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await sleep(500);
  let me = (await owner.request('directory.list')).users.find((u: any) => u.id === priya.id);
  assert.equal(me.statusEmoji, '🏗️'); assert.equal(me.statusText, 'At the Jamnagar site');
  await page.getByLabel("Show when I've seen messages").click();
  await sleep(500);
  me = (await owner.request('directory.list')).users.find((u: any) => u.id === priya.id);
  assert.equal(me.readReceipts, false);
  await shot(page, 'social-03-prefs');
  await page.keyboard.press('Escape');
  // no seen state when that is off: a plain notch
  await msg.locator('.notch.plain').waitFor();
  assert.equal(await msg.locator('.notch.sent, .notch.some, .notch.all').count(), 0);
  // the Stamp flyout on the spine tool column holds the chosen stamp
  await q.hover();
  await q.getByTitle('Stamp', { exact: true }).click();
  await page.getByRole('button', { name: 'Stamp 🍵' }).click();
  await q.locator('.reaction', { hasText: '🍵' }).waitFor();
  // last seen in a Direct conversation with someone offline
  owner.disconnect();
  await sleep(1200);
  const dm = await page.evaluate((id) => window.dex.request('conv.create', { kind: 'direct', members: [id] }), vikram.id);
  void dm;
  await page.getByRole('button', { name: /^Direct/ }).first().click();
  await page.locator('.sb-row').first().click();
  const lastOn = page.locator('.title-block div', { hasText: 'Last on' }).locator('dd');
  for (let i = 0; i < 40 && !/\d/.test(await lastOn.innerText()); i++) await sleep(200);
  assert.match(await lastOn.innerText(), /\d/, 'last on shows a time once he is offline');
  await shot(page, 'social-04-lastseen');
  console.log('SOCIAL E2E PASSED');
} catch (e) { await shot(page, 'social-FAIL'); throw e; } finally { await app.close(); owner.disconnect(); await hub.stop(); }
