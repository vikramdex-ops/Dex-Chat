import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startOffice, launch, shot, sleep, OUT } from './harness.mts';

const { owner, hub } = await startOffice('org');
const { app, page } = await launch('priya', 'Priya Raman');
try {
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  await owner.request('admin.setRole', { userId: priya.id, role: 'admin' });
  await owner.request('admin.org.saveFields', { fields: [{ label: 'Software' }] });
  // admin imports the office from a CSV in the Control room
  const csv = path.join(OUT, 'people.csv');
  fs.writeFileSync(csv, [
    'Account,Name,Designation,Department,Reports to,Extension,Seat,Date of joining,Software',
    'vikram,Vikram Shah,Managing Director,Management,,201,Cabin 1,01/06/2009,',
    'priya,Priya Raman,Lead Piping Designer,Piping,vikram,214,Bay 2 Desk 4,12/04/2021,AutoCAD Plant 3D',
    'ravi,Ravi Kumar,Piping Designer,Piping,priya,215,Bay 2 Desk 5,03/01/2023,"SP3D, Navisworks"',
    'anita,Anita Rao,Civil Lead,Civil,vikram,301,Bay 4 Desk 1,15/08/2018,STAAD',
    'sanjay,Sanjay Iyer,Draughtsman,Civil,anita,302,Bay 4 Desk 2,10/10/2022,AutoCAD',
  ].join('\r\n'));
  await page.locator('.me-btn').click();
  await page.getByRole('menuitem', { name: /Control room/ }).click();
  await page.getByRole('button', { name: 'Organisation' }).click();
  await page.locator('input[type=file][accept*=csv]').setInputFiles(csv);
  await page.locator('.import-preview').waitFor();
  await shot(page, 'org-01-import-preview');
  await page.getByRole('button', { name: /^Import \d+ rows/ }).click();
  await page.getByText(/Imported:/).waitFor();
  await sleep(400);
  await shot(page, 'org-02-org-admin');
  await page.keyboard.press('Escape');
  // directory
  await page.getByRole('button', { name: /^Directory/ }).first().click();
  await page.locator('.card.person', { hasText: 'Priya Raman' }).click();
  await page.locator('.profile-panel').waitFor();
  assert.ok(await page.locator('.profile-facts', { hasText: 'Bay 2 Desk 4' }).isVisible());
  // the profile is a title block: small-caps cells, the line manager in its own cell
  for (const k of ['Name', 'Title', 'Dept', 'Ext', 'Seat', 'Line manager']) assert.ok(await page.locator('.tblock .tb-k', { hasText: new RegExp(`^${k}$`, 'i') }).first().isVisible(), k);
  assert.ok(await page.locator('.tblock .tb-cell', { hasText: /Line manager/i }).getByRole('button', { name: 'Vikram Shah' }).isVisible());
  assert.equal(await page.locator('.profile-panel').getByText(/Reports to|Last seen|Out of office/).count(), 0);
  await shot(page, 'org-03-profile');
  await page.getByRole('tab', { name: 'Org chart', exact: true }).click();
  // the office drawing: walk up the reporting lines from Priya to the top with the arrow keys
  await page.locator('.os-stage').waitFor();
  await sleep(1500);
  await shot(page, 'org-04-chart');
  await page.locator('.os-stage').focus();
  await page.keyboard.press('Home');
  await page.locator('#os-live', { hasText: /^Priya Raman/ }).waitFor();
  await page.keyboard.press('ArrowUp');
  await page.locator('#os-live', { hasText: /^Vikram Shah/ }).waitFor();
  await page.keyboard.press('Enter');
  await page.locator('.os-callout', { hasText: 'Vikram Shah' }).waitFor();
  await shot(page, 'org-05-chart-top');
  await page.getByRole('tab', { name: 'Departments', exact: true }).click();
  await page.locator('.dept-card', { hasText: 'Piping' }).waitFor();
  await shot(page, 'org-06-departments');
  // edit someone's details as an admin
  await page.locator('.dept-card', { hasText: 'Piping' }).click();
  await page.locator('.card.person', { hasText: 'Priya Raman' }).click();
  await page.getByRole('button', { name: 'Edit details' }).click();
  await page.getByLabel('Phone').fill('+91 98450 11111');
  await shot(page, 'org-07-editor');
  await page.getByRole('dialog').getByRole('button', { name: 'Save details' }).click();
  await page.getByText(/Saved Priya Raman's details/).waitFor();
  const me = (await owner.request('directory.list')).users.find((u: any) => u.id === priya.id);
  assert.equal(me.profile.phone, '+91 98450 11111');
  assert.equal(me.profile.joinedOn, '2021-04-12');
  // Preferences: own contact details
  await page.keyboard.press('Control+,');
  await page.getByLabel('Seat or location').fill('Bay 3 Desk 1');
  await page.getByRole('button', { name: 'Save contact details' }).click();
  await page.getByText('Contact details saved').waitFor();
  console.log('ORG E2E PASSED');
} catch (e) {
  await shot(page, 'org-FAIL');
  throw e;
} finally {
  await app.close();
  owner.disconnect();
  await hub.stop();
}
