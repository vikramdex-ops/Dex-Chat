import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep } from './harness.mts';
const { owner, hub } = await startOffice('desk2');
const { app, page } = await launch('priya', 'Priya Raman');
try {
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  await owner.request('admin.setRole', { userId: priya.id, role: 'admin' });
  const sp = await owner.request('conv.create', { kind: 'space', name: 'Builds', members: [priya.id] });
  await page.reload(); await page.locator('.frame').waitFor();
  // pop-out window
  await page.getByRole('button', { name: /^Spaces/ }).first().click();
  await page.locator('.sb-row', { hasText: 'Builds' }).click();
  const [pop] = await Promise.all([app.waitForEvent('window'), page.getByRole('button', { name: 'More for this conversation' }).click().then(() => page.getByRole('menuitem', { name: 'Open in a new window' }).click())]);
  await pop.waitForLoadState();
  await pop.locator('.pane').waitFor({ timeout: 15000 });
  await owner.request('msg.send', { convId: sp.id, body: 'Seen in both windows', clientId: 'w1' });
  await pop.locator('.msg', { hasText: 'Seen in both windows' }).waitFor({ timeout: 8000 });
  await page.locator('.msg', { hasText: 'Seen in both windows' }).waitFor();
  await pop.locator('.dock textarea').first().fill('Sent from the pop-out');
  await pop.locator('.dock textarea').first().press('Enter');
  await page.locator('.msg', { hasText: 'Sent from the pop-out' }).waitFor({ timeout: 8000 });
  await pop.setViewportSize({ width: 560, height: 760 }).catch(() => {});
  await pop.screenshot({ path: `${(await import('./harness.mts')).OUT}/desk2-01-popout.png` });
  // a webhook for Jenkins from the Control room, used over HTTPS
  await page.locator('.me-btn').click();
  await page.getByRole('menuitem', { name: /Control room/ }).click();
  await page.getByRole('button', { name: /^Integrations/ }).click();
  await page.getByPlaceholder('Name, e.g. Hopper').fill('Jenkins');
  await page.getByRole('button', { name: 'Create token' }).click();
  await sleep(600);
  await page.getByLabel('Space', { exact: true }).selectOption({ label: 'Builds' });
  await page.getByRole('button', { name: 'Create webhook' }).click();
  const url = await page.locator('.issued code').last().innerText();
  assert.match(url, /^https:\/\/[^/]+\/api\/hooks\/[A-Za-z0-9_-]{20,}$/);
  const path = new URL(url).pathname;
  const https = await import('node:https');
  const status = await new Promise<number>((resolve, reject) => {
    const body = JSON.stringify({ text: '*Build 7* passed' });
    const r = https.request({ host: '127.0.0.1', port: hub.port, path, method: 'POST', rejectUnauthorized: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (x) => { x.resume(); resolve(x.statusCode ?? 0); });
    r.on('error', reject); r.end(body);
  });
  assert.equal(status, 200);
  await page.keyboard.press('Escape');
  await page.locator('.msg', { hasText: 'Build 7' }).locator('strong', { hasText: 'Build 7' }).waitFor({ timeout: 8000 });
  console.log('URL', url);
  console.log('DESK2 E2E PASSED');
} catch (e) { await shot(page, 'desk2-FAIL'); throw e; } finally { await app.close(); owner.disconnect(); await hub.stop(); }
