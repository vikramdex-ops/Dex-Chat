import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep } from './harness.mts';
const { owner, hub } = await startOffice('presence');
const { app, page } = await launch('priya', 'Priya Raman');
try {
  const users = (await owner.request('directory.list')).users;
  const vikram = users.find((u: any) => u.account.endsWith('vikram'))!;
  await owner.request('me.update', { ooo: { until: Date.now() + 2 * 86400_000, message: 'At the Dahej site', delegateId: users.find((u: any) => u.account.endsWith('priya'))!.id } });
  const dm = await page.evaluate((id) => window.dex.request('conv.create', { kind: 'direct', members: [id] }), vikram.id);
  await page.getByRole('button', { name: /^Direct/ }).first().click();
  await page.locator('.sb-row').first().click();
  await page.locator('.dock textarea').first().fill('Can you approve the PO?');
  await page.locator('.dock textarea').first().press('Enter');
  await page.locator('.notice-line.away', { hasText: 'Vikram Shah is away from the office' }).waitFor({ timeout: 8000 });
  assert.match(await page.locator('.notice-line.away').innerText(), /At the Dahej site.*You are standing in meanwhile/);
  // in a meeting now
  await owner.request('me.update', { ooo: null });
  await owner.request('cal.create', { title: 'Client call', startAt: Date.now() - 60_000, endAt: Date.now() + 1800_000, attendees: [] });
  (hub as any).presenceTick();
  await page.locator('.pane-head, .pane').getByText(/In a meeting/).first().waitFor({ timeout: 8000 });
  await shot(page, 'presence-01');
  // 24-hour times
  await page.keyboard.press('Control+,');
  await page.getByRole('group', { name: 'Time format' }).getByRole('button', { name: '13:30' }).click();
  await page.getByLabel('Quiet hours').click();
  await page.keyboard.press('Escape');
  await sleep(400);
  const t = await page.locator('.run-time').first().innerText();
  assert.match(t, /^\d{2}:\d{2}$/, `24-hour: ${t}`);
  const s = await page.evaluate(() => window.dex.getState().then((x: any) => x.settings));
  assert.equal(s.quietFrom, '19:00'); assert.equal(s.quietTo, '09:00');
  void dm;
  console.log('PRESENCE E2E PASSED');
} catch (e) { await shot(page, 'presence-FAIL'); throw e; } finally { await app.close(); owner.disconnect(); await hub.stop(); }
