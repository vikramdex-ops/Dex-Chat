// Restyle: the Dock's stamps, the marked-up sheet (accept and reject each revision, Use this /
// Keep mine), names kept as written, Restyle a copy from a message's More menu, and the same
// sheet from the bottom at phone width.
import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep, both } from './harness.mts';
const { owner, hub } = await startOffice('restyle');
const { app, page } = await launch('priya', 'Priya Raman');
try {
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  const sp = await owner.request('conv.create', { kind: 'space', name: 'P-12 Piping', members: [priya.id] });
  await owner.request('msg.send', { convId: sp.id, body: 'You never send the MTO on time. Fix it today.', clientId: 'r1' });
  await page.getByRole('button', { name: /^Spaces/ }).first().click();
  await page.locator('.sb-row', { hasText: 'P-12 Piping' }).click();
  const dock = page.locator('.dock textarea').first();
  // empty draft: nothing to restyle
  assert.equal(await page.getByRole('button', { name: 'Restyle' }).isDisabled(), true);
  const draft = "hey guys, can't make it to the 10:30 review with Vikram Shah, pls send me the ISO-1001 Rev B asap!! thx";
  await dock.fill(draft);
  await page.getByRole('button', { name: 'Restyle' }).click();
  await page.locator('.restyle-pick').waitFor();
  await shot(page, 'restyle-01-stamps');
  await page.getByRole('menuitem', { name: /Formal/ }).click();
  const sheet = page.getByRole('dialog', { name: 'Restyle' });
  await sheet.locator('.rev-mark').first().waitFor();
  const marks = await sheet.locator('.rev-mark').count();
  assert.ok(marks >= 5, `revisions shown (${marks})`);
  // names, times and drawing numbers are never touched
  const result = await sheet.locator('.rs-col.result .rs-text').innerText();
  assert.match(result, /Vikram Shah/);
  assert.match(result, /10:30/);
  assert.match(result, /ISO-1001 Rev B/);
  await both(page, 'restyle-02-sheet');
  // reject one revision in the schedule, and one by clicking its mark
  const row = sheet.locator('.rev-schedule tbody tr', { hasText: 'as soon as possible' });
  await row.getByRole('button', { name: 'Reject' }).click();
  assert.match(await sheet.locator('.rs-col.result .rs-text').innerText(), /asap/);
  await sheet.locator('.rev-mark', { hasText: 'please' }).click();
  assert.match(await sheet.locator('.rs-col.result .rs-text').innerText(), /pls/);
  await shot(page, 'restyle-03-two-rejected');
  await sheet.getByRole('button', { name: /^Use this/ }).click();
  const used = await dock.inputValue();
  assert.match(used, /^Hello guys, cannot make it/);
  assert.match(used, /pls send me/);
  assert.match(used, /asap/);
  assert.match(used, /Thank you\.$/);
  // Keep mine changes nothing
  await page.getByRole('button', { name: 'Restyle' }).click();
  await page.getByRole('menuitem', { name: /Concise/ }).click();
  await page.getByRole('dialog', { name: 'Restyle' }).getByRole('button', { name: 'Keep mine' }).click();
  assert.equal(await dock.inputValue(), used);
  await dock.fill('');

  // Restyle a copy of someone else's message, for yourself
  const theirs = page.locator('.msg', { hasText: 'You never send the MTO' });
  await theirs.hover();
  await theirs.getByTitle('More', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Restyle a copy' }).click();
  const copy = page.getByRole('dialog', { name: 'Restyle a copy' });
  await copy.getByRole('radio', { name: 'Diplomatic' }).click();
  await copy.locator('.rev-mark').first().waitFor();
  assert.match(await copy.locator('.rs-col.result .rs-text').innerText(), /Could you fix it today\?/);
  await both(page, 'restyle-04-copy');
  await copy.getByRole('button', { name: 'Copy' }).click();
  await sleep(300);
  assert.match(await app.evaluate(({ clipboard }) => clipboard.readText()), /You rarely send the MTO on time\. Could you fix it today\?/);
  await copy.getByRole('button', { name: 'Done' }).click();
  // the message itself is unchanged
  assert.equal((await owner.request('msg.list', { convId: sp.id })).messages[0].body, 'You never send the MTO on time. Fix it today.');

  // a phone-width window: the same sheet from the bottom
  await page.setViewportSize({ width: 390, height: 800 });
  await sleep(400);
  const narrowDock = page.locator('.dock textarea').first();
  if (!(await narrowDock.isVisible())) await page.locator('.sb-row', { hasText: 'P-12 Piping' }).click();
  await narrowDock.fill('pls review the GA asap, its urgent!!');
  await page.getByRole('button', { name: 'Restyle' }).click();
  await page.getByRole('menuitem', { name: /Formal/ }).click();
  const bottom = page.locator('.restyle-sheet.bottom');
  await bottom.waitFor();
  await bottom.locator('.rev-mark').first().waitFor();
  await both(page, 'restyle-05-phone');
  await bottom.getByRole('button', { name: /^Use this/ }).click();
  assert.match(await narrowDock.inputValue(), /^Please review/);
  console.log('RESTYLE E2E PASSED');
} catch (e) { await shot(page, 'restyle-FAIL'); throw e; } finally { await app.close(); owner.disconnect(); await hub.stop(); }
