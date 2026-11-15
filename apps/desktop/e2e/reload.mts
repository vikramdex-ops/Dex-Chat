// The app can reload itself (switching offices), but cannot be navigated anywhere else.
import assert from 'node:assert/strict';
import { startOffice, launch, sleep } from './harness.mts';
const { owner, hub } = await startOffice('reload');
const { app, page } = await launch('priya', 'Priya Raman');
try {
  await page.evaluate(() => { (window as any).__mark = 1; });
  await page.evaluate(() => location.reload()).catch(() => {});
  await page.waitForFunction(() => !(window as any).__mark, null, { timeout: 15000 });
  await page.locator('.frame').waitFor();
  await page.evaluate(() => { (window as any).__mark = 2; });
  await page.evaluate(() => { location.href = 'https://example.com/'; }).catch(() => {});
  await sleep(1500);
  assert.equal(await page.evaluate(() => (window as any).__mark), 2, 'navigating away is still refused');
  assert.ok(!page.url().startsWith('https://example.com'));
  console.log('RELOAD E2E PASSED');
} finally { await app.close(); owner.disconnect(); await hub.stop(); }
