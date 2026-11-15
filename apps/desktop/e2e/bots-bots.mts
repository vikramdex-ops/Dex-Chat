// End to end: a plot request run halfway, the app restarted, resumed and finished (the task is on
// the approver's Desk); then the calculator added in a Space with two people, its tape shared.
import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep } from './harness.mts';

const { owner, hub } = await startOffice('bots');
let priya = await launch('priya', 'Priya Raman');
let ravi: Awaited<ReturnType<typeof launch>> | null = null;
const theme = async (page: any, t: 'light' | 'dark') => { await page.evaluate((x: string) => window.dex.setSettings({ theme: x as 'light' }), t); await sleep(400); };
const card = (page: any) => page.locator('.flow-card.step.active');
try {
  const users = (await owner.request('directory.list')).users;
  const priyaId = users.find((u: any) => u.account.endsWith('priya'))!.id;
  // ------------------------------------------------------------ the plot request, halfway
  await priya.page.getByRole('button', { name: /^Spaces/ }).first().click();
  await priya.page.locator('.sb-row', { hasText: 'Office' }).first().click();
  const dock = priya.page.locator('.dock textarea').first();
  await dock.fill('/plot');
  await dock.press('Enter');
  await card(priya.page).waitFor({ timeout: 15000 });
  await priya.page.locator('.pane-title h2', { hasText: 'Front Office' }).waitFor({ timeout: 8000 });
  assert.match(await card(priya.page).locator('.flow-title').innerText(), /request a plot/i);
  // a wrong job number is refused inline
  await card(priya.page).getByLabel('Your answer').fill('twelve');
  await card(priya.page).getByRole('button', { name: 'Next' }).click();
  await card(priya.page).locator('.flow-err', { hasText: 'job number' }).waitFor({ timeout: 8000 });
  await card(priya.page).getByLabel('Your answer').fill('P-12513');
  await card(priya.page).getByRole('button', { name: 'Next' }).click();
  await card(priya.page).locator('.flow-q', { hasText: 'Which drawings' }).waitFor({ timeout: 8000 });
  await card(priya.page).getByLabel('Your answer').fill('ISO-1001-01 rev C\nGA-200 rev B');
  await card(priya.page).getByRole('button', { name: 'Next' }).click();
  await card(priya.page).locator('.flow-q', { hasText: 'Attach the plot set' }).waitFor({ timeout: 8000 });
  await card(priya.page).getByRole('button', { name: 'Skip' }).click();
  await card(priya.page).locator('.flow-q', { hasText: 'Which sheet size' }).waitFor({ timeout: 8000 });
  await card(priya.page).getByRole('button', { name: 'A1', exact: true }).click();
  await card(priya.page).locator('.flow-q', { hasText: 'Which media' }).waitFor({ timeout: 8000 });
  assert.match(await card(priya.page).locator('.flow-step').innerText(), /05 \/ 09/);
  await shot(priya.page, 'bots-01-flow-halfway-light');
  await theme(priya.page, 'dark');
  await shot(priya.page, 'bots-02-flow-halfway-dark');
  await theme(priya.page, 'light');

  // ------------------------------------------------------------ restart the app, pick up where she left off
  hub.botflows.resumeAfterMs = 0;
  await priya.app.close();
  await sleep(1500);
  priya = await launch('priya', 'Priya Raman', { userData: priya.userData, rejoin: true });
  await priya.page.getByRole('button', { name: /^Direct/ }).first().click();
  await priya.page.locator('.sb-row', { hasText: 'Front Office' }).first().click();
  const resume = priya.page.locator('.flow-card.resume.active');
  await resume.waitFor({ timeout: 15000 });
  assert.match(await resume.innerText(), /Pick up where you left off:\s*step 5 of 9/);
  await shot(priya.page, 'bots-03-pick-up-light');
  await theme(priya.page, 'dark');
  await shot(priya.page, 'bots-04-pick-up-dark');
  await theme(priya.page, 'light');
  await resume.getByRole('button', { name: 'Resume' }).click();
  await card(priya.page).locator('.flow-q', { hasText: 'Which media' }).waitFor({ timeout: 8000 });
  await card(priya.page).getByRole('button', { name: 'Bond: check prints' }).click();
  await card(priya.page).locator('.flow-q', { hasText: 'How many sets' }).waitFor({ timeout: 8000 });
  await card(priya.page).getByLabel('Your answer').fill('2');
  await card(priya.page).getByRole('button', { name: 'Next' }).click();
  await card(priya.page).locator('.flow-q', { hasText: 'When do you need them' }).waitFor({ timeout: 8000 });
  const t = new Date(Date.now() + 2 * 86400_000);
  const due = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  await card(priya.page).getByLabel('Your answer').fill(due);
  await card(priya.page).getByRole('button', { name: 'Next' }).click();
  await card(priya.page).locator('.flow-q', { hasText: 'Who approves' }).waitFor({ timeout: 8000 });
  await card(priya.page).getByLabel('Search for a person').fill('Vikram');
  await card(priya.page).locator('.flow-person-row', { hasText: 'Vikram Shah' }).click();
  await card(priya.page).locator('.flow-q', { hasText: 'Send this plot request' }).waitFor({ timeout: 8000 });
  await shot(priya.page, 'bots-05-confirm-light');
  await card(priya.page).getByRole('button', { name: 'Send for approval' }).click();
  const done = priya.page.locator('.flow-card.done').last();
  await done.waitFor({ timeout: 10000 });
  assert.match(await done.innerText(), /Sent\. It is on Vikram Shah's Desk/);
  const tasks = await owner.request('remind.list');
  const task = tasks.find((x: any) => x.createdBy === priyaId);
  assert.ok(task, 'the approver has a task');
  assert.match(task.text, /^Approve plot for P-12513: 2 × A1 \(Bond: check prints\) for Priya Raman, needed /);
  assert.equal(new Date(task.dueAt).getDate(), t.getDate());
  await shot(priya.page, 'bots-06-finished-light');
  await theme(priya.page, 'dark');
  await shot(priya.page, 'bots-07-finished-dark');
  await theme(priya.page, 'light');
  console.log('FLOW OK', task.text);

  // ------------------------------------------------------------ the calculator in a Space with two people
  ravi = await launch('ravi', 'Ravi Kumar');
  const raviId = (await owner.request('directory.list')).users.find((u: any) => u.account.endsWith('ravi'))!.id;
  await owner.request('conv.create', { kind: 'space', name: 'Pump house', members: [priyaId, raviId] });
  for (const p of [priya.page, ravi.page]) {
    await p.getByRole('button', { name: /^Spaces/ }).first().click();
    await p.locator('.sb-row', { hasText: 'Pump house' }).first().click({ timeout: 15000 });
  }
  await priya.page.getByRole('button', { name: 'More for this conversation' }).click();
  await priya.page.getByRole('menuitem', { name: 'Add a tool…' }).click();
  await priya.page.getByRole('button', { name: 'Add Calculator' }).click();
  const frameOf = (p: any) => p.frameLocator('iframe[title="Calculator (tool)"]').last();
  const pf = frameOf(priya.page);
  await pf.locator('#expr').waitFor({ timeout: 20000 });
  await pf.locator('#expr').fill('12*3');
  await pf.locator('#expr').press('Enter');
  await pf.locator('#tape li', { hasText: '12 × 3' }).waitFor({ timeout: 8000 });
  const rf = frameOf(ravi.page);
  await rf.locator('#tape li', { hasText: '= 36' }).waitFor({ timeout: 15000 });
  assert.match(await rf.locator('#tape li').first().innerText(), /12 × 3\s*= 36/);
  // and back the other way
  await rf.locator('#expr').fill('36/4');
  await rf.locator('#expr').press('Enter');
  await pf.locator('#tape li', { hasText: '36 ÷ 4' }).waitFor({ timeout: 15000 });
  assert.equal(await pf.locator('#tape li').count(), 2);
  assert.match(await pf.locator('#lastby').innerText(), /Ravi Kumar/);
  await sleep(500);
  await shot(priya.page, 'bots-08-calculator-light');
  await shot(ravi.page, 'bots-09-calculator-ravi-light');
  await theme(ravi.page, 'dark');
  await sleep(500);
  await shot(ravi.page, 'bots-10-calculator-ravi-dark');
  // the tools list and the Control room tab
  await priya.page.getByRole('button', { name: 'More for this conversation' }).click();
  await priya.page.getByRole('menuitem', { name: 'Add a tool…' }).click();
  await priya.page.getByRole('button', { name: 'Add Unit converter' }).waitFor();
  await shot(priya.page, 'bots-11-add-a-tool-light');
  await priya.page.keyboard.press('Escape');
  console.log('CALCULATOR OK');
  console.log('BOTS E2E PASSED');
} catch (e) {
  await shot(priya.page, 'bots-FAIL-priya').catch(() => {});
  if (ravi) await shot(ravi.page, 'bots-FAIL-ravi').catch(() => {});
  throw e;
} finally {
  await priya.app.close().catch(() => {});
  await ravi?.app.close().catch(() => {});
  owner.disconnect();
  await hub.stop();
}
