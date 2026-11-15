import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep } from './harness.mts';

const { owner, hub } = await startOffice('m5b');
const { app, page } = await launch('priya', 'Priya Raman');
try {
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  const space = await owner.request('conv.create', { kind: 'space', name: 'P-12 Site', members: [priya.id] });
  await page.getByRole('button', { name: /^Spaces/ }).first().click();
  await page.locator('.sb-row', { hasText: 'P-12 Site' }).click();
  // form
  await page.getByTitle('Insert', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Form' }).click();
  await page.getByLabel('Title').fill('Site visit sign-up');
  await page.getByPlaceholder('Question').first().fill('Coming?');
  await page.getByRole('dialog').locator('select').first().selectOption('choice');
  await page.getByPlaceholder(/One choice per line/).fill('Yes\nNo');
  await page.getByRole('button', { name: 'Add a question' }).click();
  await page.getByPlaceholder('Question').nth(1).fill('Shoe size');
  await page.getByRole('dialog').locator('select').nth(1).selectOption('number');
  await shot(page, 'm5b-01-form-builder');
  await page.getByRole('button', { name: 'Post form' }).click();
  await page.locator('.form-card').waitFor();
  const msgs = (await owner.request('msg.list', { convId: space.id })).messages;
  const form = msgs.find((m: any) => m.form).form;
  await owner.request('form.respond', { formId: form.id, answers: { q1: 'Yes', q2: '9' } });
  await page.getByRole('button', { name: 'Fill in' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'No', exact: true }).click();
  await page.getByRole('button', { name: 'Send answers' }).click();
  await page.getByText('Answered').waitFor();
  await page.getByRole('button', { name: /See answers · 2/ }).click();
  await page.locator('.att-table tbody tr').nth(1).waitFor();
  await shot(page, 'm5b-02-form-answers');
  await page.keyboard.press('Escape');
  // shared note, and a colleague editing at the same time
  await page.getByTitle('Notes').click();
  await page.getByRole('button', { name: 'New note' }).click();
  await page.locator('.note-title').fill('Site checklist');
  await page.locator('.note-body').fill('# Checklist\n- PPE\n- Torch');
  await page.getByText('Saved', { exact: true }).waitFor();
  const notes = await owner.request('note.list', { convId: space.id });
  assert.equal(notes[0].title, 'Site checklist');
  await owner.request('note.save', { id: notes[0].id, title: 'Site checklist', body: '# Checklist\n- PPE\n- Torch\n- Gloves (Vikram)', baseVersion: notes[0].version });
  await page.locator('.note-body').waitFor();
  await sleep(500);
  assert.match(await page.locator('.note-body').inputValue(), /Gloves/, 'a colleague’s save shows up when nothing is unsaved');
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  await shot(page, 'm5b-03-note');
  await page.getByRole('button', { name: 'Back to notes' }).click();
  // whiteboard: draw, and see a colleague's stroke arrive
  await page.getByTitle('Whiteboards').click();
  await page.getByRole('button', { name: 'New whiteboard' }).click();
  await page.locator('.board-canvas').waitFor();
  await sleep(400);
  const box = (await page.locator('.board-canvas').boundingBox())!;
  await page.mouse.move(box.x + 200, box.y + 200); await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(box.x + 200 + i * 15, box.y + 200 + Math.sin(i / 3) * 40);
  await page.mouse.up();
  await page.keyboard.press('r');
  await page.mouse.move(box.x + 500, box.y + 300); await page.mouse.down(); await page.mouse.move(box.x + 700, box.y + 420, { steps: 5 }); await page.mouse.up();
  const boards = await owner.request('board.list', { convId: space.id });
  const opened = await owner.request('board.open', { boardId: boards[0].id });
  assert.deepEqual(opened.ops.map((o: any) => o.op.t), ['stroke', 'shape']);
  await owner.request('board.draw', { boardId: boards[0].id, op: { t: 'text', id: 'v1', color: '#b23628', x: 520, y: 280, size: 22, text: 'Pump P-101 here' } });
  await sleep(500);
  await shot(page, 'm5b-04-whiteboard');
  await page.getByRole('button', { name: 'Post as image' }).click();
  await page.getByText('Posted to the conversation').waitFor();
  await page.getByRole('button', { name: 'Close whiteboard' }).click();
  // voice note with the simulated microphone
  await page.getByTitle('Record a voice note').click();
  await page.locator('.voice-rec').waitFor();
  await sleep(1800);
  await page.locator('.voice-rec').getByRole('button', { name: 'Send' }).click();
  await page.locator('.voice-note').waitFor({ timeout: 15000 });
  await sleep(600);
  await shot(page, 'm5b-05-voice');
  const last = (await owner.request('msg.list', { convId: space.id })).messages.at(-1);
  assert.match(last.files[0].name, /^Voice note [12]s\.webm$/);
  console.log('M5B E2E PASSED');
} catch (e) {
  await shot(page, 'm5b-FAIL');
  throw e;
} finally {
  await app.close();
  owner.disconnect();
  await hub.stop();
}
