import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep } from './harness.mts';

const { hub, owner } = await startOffice('desk');
const { app, page } = await launch('priya', 'Priya Raman');
try {
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  const space = await owner.request('conv.create', { kind: 'space', name: 'Piping P-12', topic: 'Isometrics and MTOs', members: [priya.id] });
  const m1 = await owner.request('msg.send', { convId: space.id, body: 'Revised MTO for area 3 is on the share. Please check line 40-120 before Friday.', clientId: 'e1' });
  await page.getByRole('button', { name: /Spaces/ }).first().click();
  await page.locator(`[data-mid="${m1.id}"]`).waitFor();
  // save
  await page.locator(`[data-mid="${m1.id}"]`).hover();
  await page.locator(`[data-mid="${m1.id}"] .spine-tools button[title="Keep on my Desk"]`).click();
  // keeping files it as Kept at once and offers the other kinds
  await page.getByRole('menuitemradio', { name: 'Kept' }).or(page.locator('.menu-label', { hasText: /file on my desk as/i })).first().waitFor();
  await page.locator(`[data-mid="${m1.id}"] .kept-corner`).waitFor();
  await page.keyboard.press('Escape');
  // remind
  await page.locator(`[data-mid="${m1.id}"]`).hover();
  await page.locator(`[data-mid="${m1.id}"] .spine-tools button[title="Remind me"]`).click();
  await page.getByRole('dialog', { name: 'Remind about this message' }).waitFor();
  // presets read like the office day; none of the stopwatch ones are left
  const chips = await page.locator('.when-chip').allInnerTexts();
  assert.ok(chips.some((c) => /^Monday, first thing · |^Tomorrow, first thing · /.test(c)), `presets: ${chips.join(' | ')}`);
  assert.ok(!chips.some((c) => /In 20 minutes|In 1 hour|at 9:30 AM/.test(c)), `old presets: ${chips.join(' | ')}`);
  const in20 = new Date(Date.now() + 20 * 60_000 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  await page.getByLabel('Or pick a date and time').fill(in20);
  await shot(page, 'desk-01-remind-dialog');
  await page.getByRole('button', { name: 'Set reminder' }).click();
  await page.getByText(/Reminder set for/).waitFor();
  // poll
  await page.getByTitle('Insert', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Poll' }).click();
  await page.getByLabel('Question').fill('Which day suits the site visit?');
  await page.getByPlaceholder('Choice 1').fill('Wednesday');
  await page.getByPlaceholder('Choice 2').fill('Thursday');
  await page.getByPlaceholder('Choice 3').fill('Friday');
  await shot(page, 'desk-02-poll-dialog');
  await page.getByRole('button', { name: 'Post poll' }).click();
  await page.locator('.poll').waitFor();
  const pollMsg = (await owner.request('msg.list', { convId: space.id })).messages.find((x: any) => x.poll);
  await owner.request('poll.vote', { messageId: pollMsg.id, options: [1] });
  await page.locator('.poll-opt', { hasText: 'Thursday' }).click();
  await page.locator('.poll-opt.mine').waitFor();
  await sleep(500);
  await shot(page, 'desk-03-poll-voted');
  // schedule
  await page.locator('.dock textarea').first().fill('Good morning! Site visit confirmed for Thursday.');
  await page.getByRole('button', { name: 'More ways to send' }).click();
  await page.getByRole('menuitem', { name: /Send later/ }).click();
  await page.getByRole('dialog').locator('.when-chip', { hasText: /first thing/ }).first().click();
  await shot(page, 'desk-04-schedule-dialog');
  await page.getByRole('dialog', { name: 'Send later' }).getByRole('button', { name: 'Send at this time' }).click();
  await page.getByText(/Goes out/i).waitFor();
  await page.locator('.sched-note').waitFor();
  assert.equal(await page.locator('.dock textarea').first().inputValue(), '');
  // forward to a direct conversation with Vikram
  const dm = await owner.request('conv.create', { kind: 'direct', members: [priya.id] });
  await owner.request('msg.send', { convId: dm.id, body: 'Hi Priya', clientId: 'e2' });
  await sleep(300);
  await page.locator(`[data-mid="${m1.id}"]`).hover();
  await page.locator(`[data-mid="${m1.id}"] .spine-tools button[title="More"]`).click();
  await page.getByRole('menuitem', { name: 'Forward' }).click();
  await page.getByRole('dialog', { name: 'Forward' }).locator('.picker-row', { hasText: 'Vikram Shah' }).click();
  await page.getByPlaceholder('Add a note (optional)').fill('See this');
  await page.getByRole('dialog', { name: 'Forward' }).getByRole('button', { name: /^Forward/ }).click();
  await page.getByText('Forwarded to Vikram Shah').waitFor();
  const inDm = (await owner.request('msg.list', { convId: dm.id })).messages;
  assert.equal(inDm.at(-1).forwardedFrom.authorId, owner.session!.me.id);
  // reminder fires (hub clock moved forward)
  hub.desk.tick(Date.now() + 21 * 60_000);
  await page.locator('.reminder-card').waitFor();
  await page.locator('.reminder-card').getByRole('button', { name: '15 min' }).waitFor();
  await page.locator('.reminder-card').getByRole('button', { name: /^Tomorrow / }).waitFor();
  assert.equal(await page.locator('.reminder-card').getByRole('button', { name: /^(OK|10 min|1 hour)$/ }).count(), 0);
  await shot(page, 'desk-05-reminder-card');
  // Desk lens
  await page.getByRole('button', { name: /^Desk/ }).first().click();
  await page.locator('.desk-row').first().waitFor();
  await shot(page, 'desk-06-desk-reminders');
  // the due reminder's card is up in the corner over the row's tools: reach them from the keyboard
  await page.locator('.desk-row').first().getByRole('button', { name: 'More' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: /^Tomorrow / }).waitFor();
  await shot(page, 'desk-06b-snooze-menu');
  await page.keyboard.press('Escape');
  await page.locator('.reminder-card').getByRole('button', { name: 'Done' }).click();
  await page.locator('.reminder-card').waitFor({ state: 'detached' });
  await page.getByRole('tab', { name: /^Kept/ }).click();
  await page.locator('.desk-row.saved').waitFor();
  await page.locator('.desk-row.saved').getByRole('button', { name: 'Take off Desk' }).waitFor();
  assert.match(await page.locator('.desk-row.saved .desk-tag').innerText(), /^KEPT · TODAY/);
  await shot(page, 'desk-07-desk-saved');
  await page.getByRole('tab', { name: /^Waiting to send/ }).click();
  await page.getByRole('button', { name: 'Send now' }).waitFor();
  await shot(page, 'desk-08-desk-scheduled');
  await page.getByRole('button', { name: 'Send now' }).click();
  await page.getByText('Nothing scheduled').waitFor();
  // forwarded message shows its credit
  await page.getByRole('button', { name: /^Direct/ }).first().click();
  await page.locator('.fwd-tag').waitFor();
  await shot(page, 'desk-09-forwarded');
  // mark unread
  await page.getByRole('button', { name: /^Spaces/ }).first().click();
  await page.locator(`[data-mid="${m1.id}"]`).hover();
  await page.locator(`[data-mid="${m1.id}"] .spine-tools button[title="More"]`).click();
  await page.getByRole('menuitem', { name: 'Come back to this' }).click();
  await page.getByText('Left unread from here').waitFor();
  await sleep(600);
  const conv = (await (async () => { const list = await owner.request('conv.list'); return list; })()).find((c: any) => c.id === space.id);
  void conv;
  const unread = await page.evaluate(async (id) => (await window.dex.request('conv.list')).find((c: any) => c.id === id)?.unread, space.id);
  assert.ok(unread >= 1, `still unread: ${unread}`);
  await shot(page, 'desk-10-marked-unread');
  console.log('DESK E2E PASSED');
} catch (e) {
  await shot(page, 'desk-FAIL');
  throw e;
} finally {
  await app.close();
  owner.disconnect();
  await hub.stop();
}
