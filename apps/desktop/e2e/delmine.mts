// Deleting your own message, as a person finds it: right-click the message (or its ⋯, now drawn as
// three solid dots in the tool column) → Delete. The message reads "Message deleted" and the
// Switchboard's preview no longer shows what it said.
import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep } from './harness.mts';
const { owner, hub } = await startOffice('delmine');
const { app, page } = await launch('priya', 'Priya Raman');
try {
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  const sp = await owner.request('conv.create', { kind: 'space', name: 'P-12 Piping', members: [priya.id] });
  await page.getByRole('button', { name: /^Spaces/ }).first().click();
  await page.locator('.sb-row', { hasText: 'P-12 Piping' }).click();
  const dock = page.locator('.dock textarea').first();
  for (const text of ['Line 101 checked, please confirm', 'Wrong line, ignore']) { await dock.fill(text); await dock.press('Enter'); await sleep(400); }
  const msg = (text: string) => page.locator('.msg', { hasText: text }).last();
  await msg('Wrong line, ignore').waitFor();
  await page.locator('.sb-row', { hasText: 'P-12 Piping' }).filter({ hasText: 'Wrong line' }).waitFor();

  // the ⋯ in the tool column can be seen: its dots are drawn, not a pixel each
  await msg('Wrong line, ignore').hover();
  await sleep(300);
  const more = msg('Wrong line, ignore').getByTitle('More', { exact: true });
  assert.ok(await more.isVisible(), 'the ⋯ shows in the tool column');
  const dots = await more.locator('svg').boundingBox();
  const ink = await more.evaluate((b) => { const p = b.querySelector('path')!; const r = (p as SVGGraphicsElement).getBBox(); return { w: r.width, h: r.height }; });
  assert.ok(ink.w >= 14 && ink.h >= 2.5, `the dots have size (${JSON.stringify(ink)}, button ${JSON.stringify(dots)})`);
  await shot(page, 'delmine-01-tools');

  // right-click opens the message's menu, with Delete
  await page.mouse.move(5, 5);
  await msg('Wrong line, ignore').locator('.msg-body, .body, p').first().click({ button: 'right' }).catch(async () => { await msg('Wrong line, ignore').click({ button: 'right' }); });
  const del = page.getByRole('menuitem', { name: 'Delete' });
  await del.waitFor();
  await shot(page, 'delmine-02-rightclick');
  await del.click();
  await page.locator('.dialog').getByRole('button', { name: 'Delete' }).click();
  await msg('Message deleted').waitFor();
  // the Switchboard's preview no longer shows the text
  const row = page.locator('.sb-row', { hasText: 'P-12 Piping' });
  await row.filter({ hasText: 'Message deleted' }).waitFor();
  assert.equal(await row.filter({ hasText: 'Wrong line' }).count(), 0);
  await shot(page, 'delmine-03-deleted');
  console.log('DELMINE E2E PASSED');
} catch (e) { await shot(page, 'delmine-FAIL'); throw e; } finally { await app.close(); owner.disconnect(); await hub.stop(); }
