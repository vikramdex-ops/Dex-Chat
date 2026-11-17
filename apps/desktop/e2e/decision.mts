// Decisions: built from the Dock's Insert menu as a tree, answered step by step (a follow-up and
// a written answer), the results sheet with CSV export, and an Automation run when someone
// reaches an end.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startOffice, launch, shot, sleep, both } from './harness.mts';
const { owner, hub } = await startOffice('decision');
const { app, page } = await launch('priya', 'Priya Raman');
try {
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  const sp = await owner.request('conv.create', { kind: 'space', name: 'Pump skid', members: [priya.id] });
  await owner.request('flow.save', { convId: sp.id, name: 'Approved: tell the owner', graph: {
    trigger: { id: 't1', kind: 'response.confirmed', source: 'decision', choice: 'Approved' }, conditions: [],
    actions: [{ id: 'a1', kind: 'notify', to: [{ kind: 'role', id: 'owner' }], text: '{{actor.name}} approved it' }],
  } } as any);
  await page.getByRole('button', { name: /^Spaces/ }).first().click();
  await page.locator('.sb-row', { hasText: 'Pump skid' }).click();

  // build: Q1 with three options, a follow-up with a written answer
  await page.getByRole('button', { name: 'Insert' }).first().click();
  await page.getByRole('menuitem', { name: 'Decision' }).click();
  const dlg = page.getByRole('dialog', { name: 'New Decision' });
  await dlg.getByLabel('The question').fill('Issue the pump skid GA for construction?');
  await dlg.getByRole('button', { name: /Start from: approve, change or reject/ }).click();
  assert.equal(await dlg.getByLabel('The question').inputValue(), 'Issue the pump skid GA for construction?');
  // Needs changes asks which part, with options; one of them asks for a written answer
  await dlg.getByLabel('Kind of step 2').first().selectOption('choice');
  await dlg.getByLabel('Question at step 2').first().fill('Which part?');
  await dlg.getByLabel('Option 1 of Q1.2').fill('Nozzle loads');
  await dlg.getByLabel('Option 2 of Q1.2').fill('Something else');
  await dlg.getByRole('radiogroup', { name: 'After “Something else”' }).getByRole('radio', { name: 'Asks more' }).click();
  await dlg.getByLabel('Question at step 3').fill('Describe it');
  await dlg.getByLabel('Kind of step 3').selectOption('text');
  await dlg.getByLabel('Closing note for Approved').fill('Send the drawings to site by Friday.');
  await both(page, 'decision-01-builder');
  await dlg.getByRole('button', { name: 'Post Decision' }).click();
  const card = page.locator('.decision-card');
  await page.locator('.decision-card .poll-q', { hasText: 'Issue the pump skid GA for construction?' }).waitFor();

  // Vikram (scripted) approves; Priya walks Needs changes → Something else → writes
  const msg = (await owner.request('msg.list', { convId: sp.id })).messages.find((m: any) => m.decision)!;
  const told = new Promise<void>((resolve) => owner.on('event', (name: string, d: any) => { if (name === 'msg.new' && /approved it/.test(d.body)) resolve(); }));
  await owner.request('decision.answer', { messageId: msg.id, stepId: 's1', optionId: 's1.1' });
  await Promise.race([told, sleep(5000).then(() => { throw new Error('no Automation for Approved'); })]);
  await card.getByRole('button', { name: /Needs changes/ }).click();
  await card.locator('.dc-prompt', { hasText: 'Which part?' }).waitFor();
  await both(page, 'decision-02-step2');
  await card.getByRole('button', { name: /Something else/ }).click();
  await card.getByLabel('Describe it').fill('The platform clashes with the cable tray');
  await card.getByRole('button', { name: 'Send answer' }).click();
  await card.locator('.dc-stamp', { hasText: 'Something else' }).waitFor();
  assert.match(await card.locator('.dc-trail').innerText(), /Needs changes[\s\S]*Something else[\s\S]*The platform clashes/);
  await both(page, 'decision-03-done');

  // results: who is where, with the written answer; CSV export
  await card.getByRole('button', { name: /^Results/ }).click();
  const res = page.getByRole('dialog', { name: 'Decision results' });
  await res.locator('.dr-table tbody tr').nth(1).waitFor();
  const table = await res.locator('.dr-table').innerText();
  assert.match(table, /Vikram Shah[\s\S]*Approved/);
  assert.match(table, /Priya Raman[\s\S]*Needs changes › Something else › The platform clashes with the cable tray/);
  await both(page, 'decision-04-results');
  await page.evaluate(() => {
    const w = window as any; w.__csv = [];
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (b: Blob) => { w.__csv.push(b); return orig(b); };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { if (!this.download) click.call(this); else w.__name = this.download; };
  });
  await res.getByRole('button', { name: 'Export CSV' }).click();
  const csv: string = await page.evaluate(async () => (window as any).__csv.at(-1).text());
  assert.match(await page.evaluate(() => (window as any).__name), /^Decision - Issue the pump skid GA for construction\.csv$/);
  fs.writeFileSync(new URL('./out/decision-results.csv', import.meta.url), csv);
  assert.match(csv, /Person,Account,Status,Outcome,Step 1,Answer 1/);
  assert.match(csv, /Priya Raman,.*Reached an end,Something else,Issue the pump skid GA for construction\?,Needs changes,Which part\?,Something else,Describe it,The platform clashes with the cable tray/);
  await res.getByRole('button', { name: 'Done' }).click();

  // start again, then close it: no more answers
  await card.getByRole('button', { name: 'Start again' }).click();
  await card.getByRole('button', { name: /Approved/ }).waitFor();
  await card.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Close the Decision' }).click();
  await card.locator('.poll-head', { hasText: 'closed' }).waitFor();
  assert.equal(await card.getByRole('button', { name: /Approved/ }).count(), 0);
  console.log('DECISION E2E PASSED');
} catch (e) { await shot(page, 'decision-FAIL'); throw e; } finally { await app.close(); owner.disconnect(); await hub.stop(); }
