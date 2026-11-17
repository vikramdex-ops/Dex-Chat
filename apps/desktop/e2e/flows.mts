// Automations end to end: Priya describes a rule in her own words in the Design Space, the on-device
// model drafts it, she approves it, uploads a drawing PDF, and Ravi (Document Review) is told its
// title and revision by the system bot. Screenshots of the graph editor in light and dark.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startOffice, launch, shot, sleep, OUT } from './harness.mts';
import { HubClient } from '../../../packages/core/src/hub-client.ts';
import { createIdentity } from '../../../packages/core/src/index.ts';
import { buildPdf, drawingSheet } from '../../../apps/hub/test/pdfs.ts';

const { owner, hub } = await startOffice('flows');
const ravi = new HubClient({ identity: createIdentity(), account: { username: 'ravi', domain: 'DEX', displayName: 'Ravi Kumar', hostname: 'RAVI-PC' } });
ravi.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
await new Promise<void>((res, rej) => { const t = setTimeout(() => rej(new Error('ravi not ready')), 15000); const on = (s: { kind: string }) => { if (s.kind === 'ready') { clearTimeout(t); ravi.off('state', on); res(); } }; ravi.on('state', on); });
const { app, page } = await launch('priya', 'Priya Raman');
const theme = async (t: 'light' | 'dark') => { await page.evaluate((x) => (window as any).dex.setSettings({ theme: x }), t); await sleep(500); };
try {
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  const raviId = ravi.session!.me.id;
  const review = await owner.request('admin.org.saveDepartment', { name: 'Document Review' });
  await owner.request('admin.org.setProfile', { userId: raviId, departmentId: review.id });
  // Priya starts the Design Space, so she may add its rules
  const design = await page.evaluate((ids) => (window as any).dex.request('conv.create', { kind: 'space', name: 'Design', topic: 'GA and layout drawings', members: ids }), [raviId, owner.session!.me.id]);
  await page.evaluate((id) => (window as any).dex.request('msg.send', { convId: id, body: 'Uploading the pump house GA for review this afternoon.', clientId: 'e2e-1' }), design.id);
  await page.getByRole('button', { name: /^Spaces/ }).first().click();
  await page.locator('.sb-row', { hasText: 'Design' }).click();
  await page.locator('.msg', { hasText: 'pump house GA' }).waitFor({ timeout: 10000 });

  // the header menu opens Automations
  await page.getByRole('button', { name: 'More for this conversation' }).click();
  await page.getByRole('menuitem', { name: 'Automations…' }).click();
  const sheet = page.getByRole('dialog', { name: 'Automations' });
  await sheet.waitFor();
  await sheet.locator('.fl-empty').waitFor();
  await shot(page, 'flows-00-empty');

  // describe it in plain words: the model drafts the graph
  await sheet.getByLabel('Describe a rule in your own words').fill('When someone uploads a PDF in the design channel, extract its title and revision, then notify the document review group.');
  await sheet.getByRole('button', { name: 'Draft the rule' }).click();
  await sheet.locator('.fl-note.proposed').waitFor({ timeout: 90000 });
  const note = await sheet.locator('.fl-note.proposed').innerText();
  assert.match(note, /with the on-device model/, note);
  assert.equal(await sheet.locator('.fl-model').innerText(), 'On-device model ready');
  const titles = await sheet.locator('.fl-node .fl-node-title').allInnerTexts();
  assert.deepEqual(titles, ['A file is attached', 'Read the PDF title block', 'Notify people']);
  assert.match(await sheet.locator('.fl-node').nth(0).innerText(), /\.pdf/);
  assert.match(await sheet.locator('.fl-node').nth(2).innerText(), /Document Review \(group\)/);
  assert.equal(await sheet.locator('.fl-node.unsure').count(), 0, 'every part was resolved');
  assert.match(await sheet.locator('.fl-titleblock').innerText(), /Design/);
  // look at the notify step
  await sheet.locator('.fl-node').nth(2).click();
  await sheet.locator('.fl-inspector .fl-chip.group', { hasText: 'Document Review' }).waitFor();
  await shot(page, 'flows-01-draft-light');
  await theme('dark');
  await shot(page, 'flows-02-draft-dark');
  await theme('light');

  // a test run on made-up details does nothing but says what would happen
  await sheet.getByLabel('File name').fill('GA-101 Rev C.pdf');
  await sheet.getByRole('button', { name: 'Test run' }).click();
  await sheet.locator('.fl-result .chip', { hasText: 'Would run' }).waitFor();
  assert.match(await sheet.locator('.fl-result').innerText(), /Would tell Ravi Kumar/);

  // approve
  await sheet.getByRole('button', { name: 'Approve and turn on' }).click();
  await sheet.locator('.fl-titleblock', { hasText: 'On' }).waitFor();
  await sheet.locator('.fl-tab[aria-selected="true"]', { hasText: 'A-01' }).waitFor();
  const saved = await page.evaluate((id) => (window as any).dex.request('flow.list', { convId: id }), design.id);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].enabled, true);
  assert.deepEqual(saved[0].graph.actions.map((a: any) => a.kind), ['extract', 'notify']);
  assert.deepEqual(saved[0].graph.actions[1].to, [{ kind: 'group', id: review.id }]);
  await page.keyboard.press('Escape');
  await sheet.waitFor({ state: 'detached' });

  // upload a drawing in the Space
  const pdf = path.join(OUT, 'DDS-JR-GA-101 Rev C.pdf');
  fs.writeFileSync(pdf, buildPdf({ pages: [{ content: drawingSheet({ title: ['GENERAL ARRANGEMENT', 'PUMP HOUSE P-12'], rev: 'C', number: 'DDS-JR-GA-101' }), compress: true }], info: { Title: 'GA-101.dwg' } }));
  const told = new Promise<any>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Ravi was not told')), 30000);
    const on = (name: string, d: any) => { if (name === 'msg.new' && d.authorId === hub.system.id && d.body.includes('GA-101')) { clearTimeout(t); ravi.off('event', on); resolve(d); } };
    ravi.on('event', on);
  });
  await page.locator('.dock input[type=file]').setInputFiles([pdf]);
  await sleep(1500);
  await page.locator('.dock textarea').first().press('Enter');
  const msg = await told;
  console.log('Ravi was told:\n' + msg.body);
  assert.match(msg.body, /^Priya Raman shared DDS-JR-GA-101 Rev C\.pdf in Design\./);
  assert.match(msg.body, /Title: GENERAL ARRANGEMENT PUMP HOUSE P-12/);
  assert.match(msg.body, /Revision: C/);
  assert.match(msg.body, new RegExp(`dexconnect://message/${design.id}/`));

  // the run log shows it
  await page.getByRole('button', { name: 'More for this conversation' }).click();
  await page.getByRole('menuitem', { name: 'Automations…' }).click();
  await sheet.waitFor();
  await sheet.locator('.fl-log-table .chip', { hasText: 'Ran' }).waitFor({ timeout: 10000 });
  assert.match(await sheet.locator('.fl-log-table').innerText(), /Priya Raman shared DDS-JR-GA-101 Rev C\.pdf in Design/);
  await sheet.locator('.fl-node').nth(1).click();
  await shot(page, 'flows-03-saved-light');
  await sheet.locator('.fl-log').scrollIntoViewIfNeeded();
  await shot(page, 'flows-04-runlog-light');
  await theme('dark');
  await sheet.locator('.fl-sheet').scrollIntoViewIfNeeded();
  await shot(page, 'flows-05-saved-dark');
  await theme('light');
  await page.keyboard.press('Escape');

  // the Control room lists every rule
  await owner.request('admin.setRole', { userId: priya.id, role: 'admin' });
  await page.reload();
  await page.locator('.frame').waitFor();
  await page.locator('.me-btn').click();
  await page.getByRole('menuitem', { name: /Control room/ }).click();
  await page.getByRole('button', { name: /^Automations/ }).click();
  await page.locator('.fl-admin .fl-tab', { hasText: 'Design' }).waitFor({ timeout: 10000 });
  await shot(page, 'flows-06-control-room');
  // a longer rule wraps onto a second row of the sheet
  const describe = page.getByLabel('Describe a rule in your own words');
  await describe.fill("Whenever a DWG or DXF is attached in Design during office hours, tag it #cad, remind Ravi to check it in 2 hours and post 'New CAD file {{file.name}}' in Design");
  await page.getByRole('button', { name: 'Draft the rule' }).click();
  await page.locator('.fl-admin .fl-note.proposed').waitFor({ timeout: 60000 });
  assert.deepEqual(await page.locator('.fl-admin .fl-node .fl-node-title').allInnerTexts(), ['A file is attached', 'Only at these times', 'Tag the message', 'Reminder or To do', 'Post a message']);
  await page.locator('.fl-admin .fl-sheet').scrollIntoViewIfNeeded();
  await shot(page, 'flows-07-wrapped-light');
  // names the office does not have are marked for the person to fill in
  await page.locator('.fl-admin .fl-describe').scrollIntoViewIfNeeded();
  await describe.fill('When someone reacts in the marketing channel, tag it and notify the finance group');
  await page.getByRole('button', { name: 'Draft the rule' }).click();
  await page.locator('.fl-admin .fl-note.proposed', { hasText: 'marketing' }).waitFor({ timeout: 60000 });
  assert.equal(await page.locator('.fl-admin .fl-node.unsure').count(), 3);
  await page.locator('.fl-admin .fl-sheet').scrollIntoViewIfNeeded();
  await shot(page, 'flows-08-unresolved-light');
  await theme('dark');
  await shot(page, 'flows-09-unresolved-dark');
  await theme('light');
  // approving is refused until the missing parts are filled
  await page.getByRole('button', { name: 'Approve and turn on' }).click();
  await page.locator('.toast.bad').waitFor();
  console.log('FLOWS E2E PASSED');
} catch (e) { await shot(page, 'flows-FAIL'); throw e; } finally { await app.close(); ravi.disconnect(); owner.disconnect(); await hub.stop(); }
