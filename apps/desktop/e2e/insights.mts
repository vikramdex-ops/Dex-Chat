// Reaction insights: opened from the reactions row and from the More menu; the note that
// reactions are not approvals; distribution, members, timeline, departments and the
// announcement rate as charts (with a hover readout) and as a table, in both themes.
import assert from 'node:assert/strict';
import { createIdentity } from '../../../packages/core/src/index.ts';
import { HubClient } from '../../../packages/core/src/hub-client.ts';
import { startOffice, launch, shot, sleep, both } from './harness.mts';
const { owner, hub } = await startOffice('insights');
const { app, page } = await launch('priya', 'Priya Raman');
const people: HubClient[] = [];
try {
  const join = async (username: string, name: string) => {
    const c = new HubClient({ identity: createIdentity(), account: { username, domain: 'DEX', displayName: name, hostname: `${username}-pc` } });
    c.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
    await new Promise<void>((res) => { const on = (s: { kind: string }) => { if (s.kind === 'ready') { c.off('state', on); res(); } }; c.on('state', on); });
    people.push(c);
    return c;
  };
  const crew = [await join('ravi', 'Ravi Kulkarni'), await join('asha', 'Asha Menon'), await join('meera', 'Meera Iyer'), await join('kiran', 'Kiran Rao'), await join('john', 'John Mathew'), await join('lata', 'Lata Pillai')];
  const users = (await owner.request('directory.list')).users;
  const id = (acc: string) => users.find((u: any) => u.account.endsWith(acc))!.id;
  const piping = await owner.request('admin.org.saveDepartment', { name: 'Piping' });
  const civil = await owner.request('admin.org.saveDepartment', { name: 'Civil' });
  const elec = await owner.request('admin.org.saveDepartment', { name: 'Electrical' });
  for (const [acc, dep] of [['priya', piping], ['ravi', piping], ['asha', piping], ['meera', civil], ['kiran', civil], ['john', elec], ['lata', elec]] as const) await owner.request('admin.org.setProfile', { userId: id(acc), departmentId: dep.id });
  const office = (await owner.request('conv.list')).find((c: any) => c.everyone)!;
  // two earlier announcements, for the office average
  for (const [i, n] of [[0, 2], [1, 4]] as const) {
    const old = await owner.request('msg.send', { convId: office.id, body: `Earlier notice ${i + 1}`, clientId: `old${i}` });
    for (const c of crew.slice(0, n)) await c.request('msg.react', { messageId: old.id, emoji: '👍', on: true });
  }
  const ann = await owner.request('msg.send', { convId: office.id, body: 'The site office is closed on Friday for the inspection. Work from the main office.', clientId: 'ann' });
  const stamps: Array<[number, string, number]> = [[0, '👍', 4], [1, '👍', 9], [2, '✅', 15], [3, '👍', 31], [4, '🙏', 55], [5, '✅', 80]];
  for (const [i, e] of stamps) await crew[i].request('msg.react', { messageId: ann.id, emoji: e, on: true });
  // spread the stamps over the morning; two people read it without reacting
  const t0 = Date.now() - 2 * 3600_000;
  hub.store.db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(t0, ann.id);
  const ev = hub.store.db.prepare('SELECT id FROM reaction_events WHERE message_id = ? ORDER BY id').all(ann.id) as Array<{ id: number }>;
  ev.forEach((r, i) => hub.store.db.prepare('UPDATE reaction_events SET at = ? WHERE id = ?').run(t0 + stamps[i][2] * 60_000, r.id));
  await crew[4].request('msg.react', { messageId: ann.id, emoji: '🙏', on: false });
  await crew[4].request('msg.react', { messageId: ann.id, emoji: '👍', on: true });

  await page.getByRole('button', { name: /^Spaces/ }).first().click();
  await page.locator('.sb-row', { hasText: 'Office' }).first().click();
  const msg = page.locator('.msg', { hasText: 'The site office is closed' });
  await msg.locator('.reaction-count').waitFor();
  await msg.locator('.reaction-count').click();
  const panel = page.getByRole('dialog', { name: 'Reaction insights' });
  await panel.locator('.ri-note', { hasText: 'Reactions are not approvals' }).waitFor();
  await panel.locator('.ri-bar').first().waitFor();
  const text = await panel.innerText();
  assert.match(text, /STAMPS\s*6/i);
  assert.match(text, /4 · 67%/, 'thumbs up: 4 of 6 stamps, with the exact count');
  assert.match(text, /Piping/);
  assert.match(text, /This announcement/);
  assert.match(text, /Office average, last 90 days/);
  assert.equal(await panel.locator('.ri-sheet').count(), 5, 'distribution, members, timeline, departments, announcement');
  // hover readout on a bar
  await panel.locator('.ri-mark').first().hover();
  await panel.locator('.ri-tip').first().waitFor();
  await both(page, 'insights-01-charts');
  await panel.locator('.ri-sheet').nth(2).scrollIntoViewIfNeeded();
  await panel.locator('.ri-chart svg').nth(2).hover({ position: { x: 200, y: 60 } });
  await sleep(150);
  await shot(page, 'insights-02-timeline-hover');
  await panel.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await both(page, 'insights-03-departments');
  // the same numbers as a table; the note is still there
  await panel.getByRole('button', { name: 'Table' }).click();
  await panel.locator('.ri-tables').waitFor();
  assert.match(await panel.locator('.ri-tables').innerText(), /Piping[\s\S]*of 3/);
  assert.equal(await panel.locator('.ri-note').isVisible(), true);
  await both(page, 'insights-04-table');
  await page.keyboard.press('Escape');
  // also from the More menu
  await msg.hover();
  await msg.getByTitle('More', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Reaction insights' }).click();
  await page.getByRole('dialog', { name: 'Reaction insights' }).locator('.ri-bar').first().waitFor();
  console.log('INSIGHTS E2E PASSED');
} catch (e) { await shot(page, 'insights-FAIL'); throw e; } finally { await app.close(); for (const c of people) c.disconnect(); owner.disconnect(); await hub.stop(); }
