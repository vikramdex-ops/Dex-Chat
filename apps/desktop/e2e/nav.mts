import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep } from './harness.mts';
const { owner, hub } = await startOffice('nav');
const { app, page } = await launch('priya', 'Priya Raman');
try {
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  const a = await owner.request('conv.create', { kind: 'space', name: 'Alpha piping', members: [priya.id] });
  const z = await owner.request('conv.create', { kind: 'space', name: 'Zulu civil', members: [priya.id] });
  // old history: 120 messages over 10 days in Alpha
  for (let i = 0; i < 120; i++) {
    const m = await owner.request('msg.send', { convId: a.id, body: `Log entry ${i}`, clientId: `l${i}` });
    hub.store.db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(Date.now() - (120 - i) * 2 * 3600_000, m.id);
  }
  const mine = await page.evaluate((id) => window.dex.request('msg.send', { convId: id, body: 'Who has the nozzle loads?', clientId: 'p1' }), z.id);
  await owner.request('msg.send', { convId: z.id, body: 'I do', parentId: mine.id, clientId: 'r1' });
  await owner.request('msg.send', { convId: a.id, body: `<@${priya.id}> please check stress`, clientId: 'm1' });
  await page.reload(); await page.locator('.frame').waitFor();
  // Desk: Mentions & replies, Side-tracks
  await page.getByRole('button', { name: /^Desk/ }).first().click();
  await page.getByRole('tab', { name: 'Callouts' }).click();
  await page.locator('.desk-row', { hasText: 'please check stress' }).waitFor();
  await page.locator('.desk-row', { hasText: 'I do' }).waitFor();
  assert.equal(await page.locator('.desk-row', { hasText: 'please check stress' }).locator('.desk-tag').innerText(), 'CALLOUT');
  assert.equal(await page.locator('.desk-row', { hasText: 'I do' }).locator('.desk-tag').innerText(), 'SIDE-TRACK REPLY');
  await shot(page, 'nav-01-activity');
  await page.getByRole('button', { name: '@ you' }).click();
  await page.locator('.desk-row', { hasText: 'I do' }).waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Side-track replies' }).click();
  await page.locator('.desk-row', { hasText: 'please check stress' }).waitFor({ state: 'detached' });
  await page.locator('.desk-row', { hasText: 'I do' }).waitFor();
  await page.getByRole('tab', { name: 'Side-tracks' }).click();
  await page.locator('.desk-row', { hasText: 'Who has the nozzle loads?' }).click();
  await page.locator('.msg', { hasText: 'I do' }).waitFor();
  // the Switchboard: folded to tiles while a Pane is open; opened by hand: unread only, sort by name
  await page.getByRole('button', { name: /^Spaces/ }).first().click();
  await page.locator('.switchboard.folded').waitFor();
  await page.getByTitle('Open the Switchboard').click();
  await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Spaces' }).waitFor();
  await page.getByTitle('Show unread only').click();
  const names = async () => page.locator('.sb-row .sb-name').allInnerTexts();
  await sleep(300);
  assert.ok(!(await names()).includes('Office'), 'read conversations hidden');
  await page.getByTitle('Show all').click();
  await page.getByTitle('Sort').click();
  await page.getByRole('menuitemradio', { name: 'Name' }).click();
  await sleep(200);
  const n = await names();
  assert.ok(n.indexOf('Alpha piping') < n.indexOf('Zulu civil'));
  // resize the list
  const handle = page.locator('.sb-resize').first();
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + 4, box.y + 200); await page.mouse.down(); await page.mouse.move(box.x + 84, box.y + 200, { steps: 5 }); await page.mouse.up();
  const w = await page.locator('.switchboard').evaluate((el) => (el as HTMLElement).offsetWidth);
  assert.ok(w > 360, `resized to ${w}`);
  // jump to a date 9 days back
  await page.locator('.sb-row', { hasText: 'Alpha piping' }).click();
  await page.locator('.msg', { hasText: 'please check stress' }).waitFor();
  await page.getByRole('button', { name: 'More for this conversation' }).click();
  await page.getByRole('menuitem', { name: 'Jump to a date…' }).click();
  const d = new Date(Date.now() - 9 * 86400_000);
  await page.getByLabel('Date').fill(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await page.locator('.msg.flash', { hasText: /Log entry/ }).waitFor({ timeout: 15000 });
  // textContent: a run off screen is not laid out (content-visibility), so innerText can be empty
  const t = (await page.locator('.msg.flash', { hasText: /Log entry/ }).textContent()) ?? '';
  const idx = Number(t.match(/Log entry (\d+)/)?.[1]);
  assert.ok(idx >= 0 && idx < 20, `landed on entry ${idx}`);
  await shot(page, 'nav-02-jump');
  // lens chips: People shows Direct conversations only and moves the Lens bar to Direct
  await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'People' }).click();
  await page.locator('.lens[aria-current="page"]', { hasText: 'Direct' }).waitFor();
  assert.equal(await page.locator('.sb-row', { hasText: 'Alpha piping' }).count(), 0);
  await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Projects' }).click();
  await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'All' }).click();
  // Ctrl+click lays a second Pane beside the first; a drag lays a third
  await page.locator('.sb-row', { hasText: 'Zulu civil' }).click({ modifiers: ['Control'] });
  await page.locator('.panes > .pane-wrap').nth(1).waitFor();
  assert.equal(await page.locator('.panes > .pane-wrap').count(), 2);
  await page.locator('.sb-row', { hasText: 'Office' }).dragTo(page.locator('.panes'), { targetPosition: { x: 5, y: 300 } });
  await page.locator('.panes > .pane-wrap').nth(2).waitFor();
  assert.deepEqual(await page.locator('.panes .pane-title h2').allInnerTexts(), ['Office', 'Alpha piping', 'Zulu civil']);
  await page.getByTitle('Fold the Switchboard to tiles').click();
  await shot(page, 'nav-03-three-panes');
  await page.locator('.panes > .pane-wrap').first().getByTitle('Close this Pane').click();
  assert.equal(await page.locator('.panes > .pane-wrap').count(), 2);
  console.log('NAV E2E PASSED');
} catch (e) { await shot(page, 'nav-FAIL'); throw e; } finally { await app.close(); owner.disconnect(); await hub.stop(); }
