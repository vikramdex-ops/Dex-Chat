import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep } from './harness.mts';
const { owner, hub } = await startOffice('policy');
const { app, page } = await launch('priya', 'Priya Raman');
try {
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  await owner.request('admin.setRole', { userId: priya.id, role: 'admin' });
  const sp = await owner.request('conv.create', { kind: 'space', name: 'P-12 Piping', members: [priya.id] });
  const site = await owner.request('conv.create', { kind: 'space', name: 'Site team', members: [priya.id] });
  const dm = await owner.request('conv.create', { kind: 'direct', members: [priya.id] });
  // a month of activity
  let n = 0;
  for (let day = 29; day >= 0; day--) {
    const count = 3 + Math.round(6 + 5 * Math.sin(day / 3)) + (day % 7 < 2 ? -4 : 0);
    for (let i = 0; i < count; i++) {
      const m = await owner.request('msg.send', { convId: i % 3 === 0 ? site.id : i % 4 === 0 ? dm.id : sp.id, body: `Day ${day} note ${i}`, clientId: `u${n++}` });
      hub.store.db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(Date.now() - day * 86400_000 - i * 60_000, m.id);
    }
    if (day % 3 === 0) hub.policies.logCall(`call${day}`, dm.id, owner.session!.me.id, false, false, (10 + day) * 60_000, Date.now() - day * 86400_000);
  }
  const mine = await page.evaluate((id) => window.dex.request('msg.send', { convId: id, body: 'My old note', clientId: 'mine1' }), sp.id);
  hub.store.db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(Date.now() - 2 * 3600_000, mine.id);
  await sleep(400);
  await page.reload(); await page.locator('.frame').waitFor();
  await page.locator('.me-btn').click();
  await page.getByRole('menuitem', { name: /Control room/ }).click();
  await page.getByRole('button', { name: 'Policies' }).click();
  await page.getByLabel('People can edit or delete their messages').selectOption({ label: 'For 1 hour after sending' });
  await sleep(500);
  assert.equal((await owner.request('policy.get')).editWindowMinutes, 60);
  await shot(page, 'policy-01-policies');
  await page.getByRole('button', { name: 'Usage' }).click();
  await page.locator('.usage-plot svg').waitFor();
  await page.locator('.usage-plot g').nth(20).hover();
  await page.locator('.usage-tip').waitFor();
  await shot(page, 'policy-02-usage');
  await page.keyboard.press('Escape');
  // the edit button is gone on the two-hour-old message
  await page.getByRole('button', { name: /^Spaces/ }).first().click();
  await page.locator('.sb-row', { hasText: 'P-12 Piping' }).click();
  const msg = page.locator('.msg', { hasText: 'My old note' });
  await msg.waitFor(); await msg.hover();
  await msg.getByTitle('More', { exact: true }).click();
  await page.getByRole('menuitem', { name: 'Copy text' }).waitFor();
  assert.equal(await page.getByRole('menuitem', { name: /^Edit/ }).count(), 0, 'no Edit after the edit window');
  console.log('POLICY E2E PASSED');
} catch (e) { await shot(page, 'policy-FAIL'); throw e; } finally { await app.close(); owner.disconnect(); await hub.stop(); }
