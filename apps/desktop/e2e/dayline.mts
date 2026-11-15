// The day's line on Pulse: a line and a drawing a day, browsing back, office lines, the morning moment, both themes.
import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep } from './harness.mts';
const { owner, hub } = await startOffice('dayline');
const { app, page } = await launch('priya', 'Priya Raman');
try {
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  await owner.request('admin.setRole', { userId: priya.id, role: 'admin' });
  await page.reload(); await page.locator('.frame').waitFor();
  await page.getByRole('button', { name: /^Pulse/ }).first().click();
  const card = page.locator('section.dayline');
  await card.waitFor();
  // the very first start shows no full-screen moment
  assert.equal(await page.locator('.dl-moment').count(), 0, 'no moment on the first day');
  const quote = card.locator('.dl-quote');
  const first = (await quote.innerText()).trim();
  assert.ok(first.length > 10, `a line: ${first}`);
  const strokes = await card.locator('svg.dl-plot path').count();
  assert.ok(strokes > 8, `drawing strokes: ${strokes}`);
  // already seen today (the page was reloaded): it is drawn at once, without plotting in again
  assert.ok(!(await card.locator('svg.dl-plot').evaluate((s) => s.classList.contains('draw'))), 'no replay on the second view of the day');
  await sleep(2500);
  await shot(page, 'dayline-01-light');
  // the day before and back
  assert.ok(await card.getByRole('button', { name: 'The day after' }).isDisabled());
  await card.getByRole('button', { name: 'The day before' }).click();
  await sleep(300);
  const prev = (await quote.innerText()).trim();
  assert.notEqual(prev, first, 'yesterday has another line');
  await card.getByRole('button', { name: 'The day after' }).click();
  await sleep(300);
  assert.equal((await quote.innerText()).trim(), first);
  // an office line set for today replaces it for everyone, live
  const today = new Date().toLocaleDateString('en-CA');
  await owner.request('admin.lines.add', { text: 'Twenty years of drawings, one sheet at a time.', by: 'The partners', date: today });
  await page.waitForFunction(() => document.querySelector('.dayline .dl-quote')?.textContent?.includes('Twenty years of drawings'), null, { timeout: 10000 });
  assert.match(await card.locator('.dl-by').innerText(), /The partners/);
  // members cannot add lines
  const m = await page.evaluate(() => window.dex.request('admin.lines.add', { text: 'nope nope', by: null, date: null }).then(() => 'ok', (e: Error) => e.message));
  assert.equal(m, 'ok', 'an admin may add a line');
  // full screen
  await card.getByRole('button', { name: 'Full screen' }).click();
  const moment = page.locator('.dl-moment');
  await moment.waitFor();
  await sleep(1500);
  await shot(page, 'dayline-02-moment');
  await moment.click({ position: { x: 20, y: 20 } });
  await moment.waitFor({ state: 'detached' });
  // the next day: the moment greets on the first open
  await page.evaluate(() => localStorage.setItem('dex.dayline.seen', '1'));
  await page.reload(); await page.locator('.frame').waitFor();
  await page.locator('.dl-moment').waitFor({ timeout: 10000 });
  assert.ok(await page.locator('section.dayline svg.dl-plot').evaluate((s) => s.classList.contains('draw')), 'the drawing plots itself in on the first view of the day');
  // any key closes it, and it does not come back that day
  await page.keyboard.press('Escape');
  await page.locator('.dl-moment').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: /^Spaces/ }).first().click();
  await page.getByRole('button', { name: /^Pulse/ }).first().click();
  await page.locator('section.dayline').waitFor();
  await sleep(400);
  assert.equal(await page.locator('.dl-moment').count(), 0, 'once a day');
  assert.ok(!(await page.locator('section.dayline svg.dl-plot').evaluate((s) => s.classList.contains('draw'))), 'the plot plays once a day, not on every return to Pulse');
  // dark
  await page.evaluate(() => window.dex.setSettings({ theme: 'dark' as never }));
  await sleep(800);
  await page.getByRole('button', { name: /^Pulse/ }).first().click();
  await sleep(600);
  await shot(page, 'dayline-03-dark');
  // the Control room card
  await page.evaluate(() => window.dex.setSettings({ theme: 'light' as never }));
  await page.locator('.me-btn').click();
  await page.getByRole('menuitem', { name: /Control room/ }).click();
  await page.getByRole('button', { name: 'Policies' }).click();
  const lines = page.locator('section.card', { hasText: "The day's line" });
  await lines.scrollIntoViewIfNeeded();
  await lines.locator('.dlp-rule', { hasText: 'Twenty years' }).waitFor();
  await lines.screenshot({ path: `${import.meta.dirname}/out/dayline-04-admin.png` });
  // a member is refused
  await owner.request('admin.setRole', { userId: priya.id, role: 'member' });
  await sleep(500);
  const refused = await page.evaluate(() => window.dex.request('admin.lines.add', { text: 'not allowed', by: null, date: null }).then(() => 'ok', (e: Error) => e.message));
  assert.notEqual(refused, 'ok', 'a member cannot add a line');
  console.log('DAYLINE E2E PASSED');
} catch (e) {
  await shot(page, 'dayline-FAIL').catch(() => {});
  throw e;
} finally { await app.close(); owner.disconnect(); await hub.stop(); }
