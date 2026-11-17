// Cross-conversation references: drag a message by its grip from one Pane into another (with
// the "can't open the source" sheet), press-and-hold a message onto the Switchboard, drag a file
// onto the Dock, and Reference in… from the keyboard. People without access see only that it exists.
import assert from 'node:assert/strict';
import { createIdentity } from '../../../packages/core/src/index.ts';
import { HubClient } from '../../../packages/core/src/hub-client.ts';
import { startOffice, launch, shot, sleep, both } from './harness.mts';
const { owner, hub } = await startOffice('refs');
const { app, page } = await launch('priya', 'Priya Raman', { width: 1440, height: 860 });
const ravi = new HubClient({ identity: createIdentity(), account: { username: 'ravi', domain: 'DEX', displayName: 'Ravi Kulkarni', hostname: 'ravi-pc' } });
try {
  ravi.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
  await new Promise<void>((res) => { const on = (s: { kind: string }) => { if (s.kind === 'ready') { ravi.off('state', on); res(); } }; ravi.on('state', on); });
  const users = (await owner.request('directory.list')).users;
  const id = (acc: string) => users.find((u: any) => u.account.endsWith(acc))!.id;
  const src = await owner.request('conv.create', { kind: 'space', name: 'P-12 Piping', private: true, members: [id('priya')] });
  const site = await owner.request('conv.create', { kind: 'space', name: 'Site team', private: true, members: [id('priya'), id('ravi')] });
  const leads = await owner.request('conv.create', { kind: 'space', name: 'Leads', private: true, members: [id('priya')] });
  await owner.request('msg.send', { convId: src.id, body: 'Rev C of ISO-1001 is the one to use on site', clientId: 's1' });
  await owner.request('msg.send', { convId: src.id, body: 'Nozzle N3 clashes with the platform at EL 104.500', clientId: 's2' });
  const f = hub.files.storeBuffer(id('vikram'), 'Clash report P-12.pdf', 'application/pdf', Buffer.from('%PDF-1.4\n%%EOF'));
  await owner.request('msg.send', { convId: src.id, body: 'Clash report attached', files: [f.id], clientId: 's3' });
  await owner.request('msg.send', { convId: site.id, body: 'Morning, site team', clientId: 't1' });

  await page.getByRole('button', { name: /^Spaces/ }).first().click();
  await page.locator('.sb-row', { hasText: 'P-12 Piping' }).click();
  await page.locator('.sb-row', { hasText: 'Site team' }).click({ modifiers: ['Control'] });
  const left = page.locator('.pane-wrap').nth(0);
  const right = page.locator('.pane-wrap').nth(1);
  await right.locator('.pane-title', { hasText: 'Site team' }).waitFor();
  await left.locator('.pane-title', { hasText: 'P-12 Piping' }).waitFor();

  // 1. drag the grip of a message from one Pane into the other
  const rev = left.locator('.msg', { hasText: 'Rev C of ISO-1001' });
  await rev.hover();
  const grip = rev.locator('button.grip');
  assert.equal(await grip.getAttribute('aria-label'), 'Drag to reference');
  // HTML drag and drop, as the browser fires it (synthetic mouse input cannot start a native drag here)
  const dt = await page.evaluateHandle(() => new DataTransfer());
  await grip.dispatchEvent('dragstart', { dataTransfer: dt });
  const target = right.locator('.ref-zone');
  await right.locator('.ref-zone.ref-valid').waitFor();
  await target.dispatchEvent('dragenter', { dataTransfer: dt });
  await target.dispatchEvent('dragover', { dataTransfer: dt });
  await right.locator('.ref-zone.ref-over').waitFor();
  assert.equal(await right.locator('.ref-zone > .ref-drop-label').innerText(), 'DROP TO REFERENCE HERE');
  assert.ok(await page.locator('.sb-row-wrap.ref-valid').count() >= 2, 'the Switchboard rows that can take it are outlined');
  assert.equal(await left.locator('.ref-zone.ref-valid').count(), 0, 'not into its own conversation');
  await both(page, 'refs-01-dragging');
  await target.dispatchEvent('drop', { dataTransfer: dt });
  await grip.dispatchEvent('dragend', { dataTransfer: dt });
  // the sheet: Ravi is in Site team but cannot open P-12 Piping
  const ask = page.getByRole('dialog', { name: 'Reference it here?' });
  await ask.waitFor();
  assert.match(await ask.innerText(), /1 person in Site team can't open the source; they'll see only that it exists/);
  await both(page, 'refs-02-sheet');
  const forRavi = new Promise<any>((resolve) => ravi.on('event', (name: string, d: any) => { if (name === 'msg.new' && d.convId === site.id && d.ref) resolve(d); }));
  await ask.getByRole('button', { name: 'Reference it' }).click();
  const card = right.locator('.ref-card', { hasText: 'Rev C of ISO-1001' });
  await card.waitFor();
  assert.match((await card.textContent())!, /Reference · from[\s\S]*P-12 Piping[\s\S]*Vikram Shah/);
  const r = await forRavi;
  assert.deepEqual(r.ref, { kind: 'message', authorId: id('vikram'), access: false });
  assert.equal(JSON.stringify(r).includes('ISO-1001'), false, 'nothing about the source reaches Ravi');
  await both(page, 'refs-03-posted');
  // open the source from the card
  await card.getByRole('button', { name: 'Open the source' }).click();
  await page.locator('.msg.flash', { hasText: 'Rev C of ISO-1001' }).waitFor();

  // 2. press and hold a message, then drag it onto a conversation in the Switchboard
  await sleep(1200); // the jump scrolls smoothly; let it settle
  const nozzle = left.locator('.msg', { hasText: 'Nozzle N3 clashes' });
  const nb = (await nozzle.locator('.msg-text').boundingBox())!;
  await page.mouse.move(nb.x + 30, nb.y + nb.height / 2, { steps: 4 });
  await sleep(300);
  await page.mouse.down();
  await sleep(650);
  const leadsRow = page.locator('.sb-row-wrap').filter({ has: page.locator('.sb-row[title^="Leads"]') }).or(page.locator('.sb-row-wrap').filter({ hasText: 'Leads' })).first();
  const lb = (await leadsRow.boundingBox())!;
  await page.mouse.move(lb.x + lb.width / 2, lb.y + lb.height / 2, { steps: 12 });
  await page.locator('.sb-row-wrap.ref-over').waitFor();
  await page.locator('.ref-ghost').waitFor();
  await shot(page, 'refs-04-hold-drag');
  await page.mouse.up();
  // everyone in Leads can open it: no sheet
  await page.locator('.toast', { hasText: 'Referenced in Leads' }).waitFor();
  const inLeads = (await owner.request('msg.list', { convId: leads.id })).messages.at(-1);
  assert.equal(inLeads.ref?.messageId !== undefined, true);
  assert.match(inLeads.ref.message.body, /Nozzle N3 clashes/);

  // 3. a file chip onto the other Pane's Dock: a reference to the same file, sent with the message
  const chip = left.locator('.file-card', { hasText: 'Clash report P-12.pdf' });
  await chip.scrollIntoViewIfNeeded();
  const dock = right.locator('.dock-wrap');
  const dt2 = await page.evaluateHandle(() => new DataTransfer());
  await chip.dispatchEvent('dragstart', { dataTransfer: dt2 });
  await dock.dispatchEvent('dragover', { dataTransfer: dt2 });
  await right.locator('.dock.ref-over').waitFor();
  await dock.dispatchEvent('drop', { dataTransfer: dt2 });
  await chip.dispatchEvent('dragend', { dataTransfer: dt2 });
  await right.locator('.ref-chip', { hasText: 'Clash report P-12.pdf' }).waitFor();
  await right.locator('.dock textarea').fill('See the clash report');
  await shot(page, 'refs-05-dock-chip');
  await right.locator('.dock textarea').press('Enter');
  await page.getByRole('dialog', { name: 'Reference it here?' }).getByRole('button', { name: 'Reference it' }).click();
  await right.locator('.ref-card', { hasText: 'Clash report P-12.pdf' }).waitFor();
  const last = (await owner.request('msg.list', { convId: site.id })).messages.slice(-2);
  assert.equal(last[0].body, 'See the clash report');
  assert.equal(last[1].ref.file.id, f.id, 'the same file, not a copy');
  assert.equal(last[1].files.length, 0);
  assert.equal(hub.files.canRead(id('ravi'), f.id), false, 'Ravi still cannot open the file');

  // 4. keyboard: Reference in… from the More menu
  await rev.hover();
  await rev.getByTitle('More', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Reference in…' }).click();
  const pick = page.getByRole('dialog', { name: 'Reference in…' });
  await pick.getByLabel('Search conversations').fill('Leads');
  await both(page, 'refs-06-reference-in');
  await pick.getByRole('option', { name: /Leads/ }).click();
  await page.locator('.toast', { hasText: 'Referenced in Leads' }).last().waitFor();
  // what Ravi sees: only that it exists, and who wrote it
  const other = await launch('ravi', 'Ravi Kulkarni');
  try {
    // the desktop signs in as its own office account: add that Ravi to Site team too
    await sleep(500);
    const desk = (await owner.request('directory.list')).users.filter((u: any) => u.displayName === 'Ravi Kulkarni' && u.id !== id('ravi'));
    if (desk.length) await owner.request('conv.addMembers', { convId: site.id, userIds: desk.map((u: any) => u.id) });
    await other.page.getByRole('button', { name: /^Spaces/ }).first().click();
    await other.page.locator('.sb-row[title^="Site team"]').or(other.page.locator('.sb-row', { hasText: 'Site team' })).first().click();
    const none = other.page.locator('.ref-card.none').first();
    await none.waitFor();
    assert.match(await none.innerText(), /From a conversation you're not in[\s\S]*Written by[\s\S]*Vikram Shah/);
    assert.equal(await other.page.locator('.timeline').innerText().then((t: string) => t.includes('ISO-1001')), false);
    await both(other.page, 'refs-07-no-access');
  } catch (e) { await shot(other.page, 'refs-FAIL-ravi'); throw e; } finally { await other.app.close(); }
  console.log('REFS E2E PASSED');
} catch (e) { await shot(page, 'refs-FAIL'); throw e; } finally { await app.close(); ravi.disconnect(); owner.disconnect(); await hub.stop(); }
