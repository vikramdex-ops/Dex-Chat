// The polish pass's behaviour: the "New" line and the way back to the newest messages, the reading
// place kept per conversation, arrow keys through messages, Esc closing a side-track, the in-app
// confirmation, Undo in toasts, and reminder cards staying dismissed after a reload.
import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep } from './harness.mts';
import { join } from './seed.mts';

const { hub, owner } = await startOffice('polish');
const { app, page } = await launch('priya', 'Priya Raman', { width: 1280, height: 800 });
page.setDefaultTimeout(8000);
try {
  const ravi = await join(hub, 'ravi', 'Ravi Kulkarni');
  process.on('exit', () => ravi.disconnect());
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!.id;
  const raviId = users.find((u: any) => u.account.endsWith('ravi'))!.id;
  const sp = await owner.request('conv.create', { kind: 'space', name: 'Piping P-12', members: [priya, raviId] });
  const other = await owner.request('conv.create', { kind: 'space', name: 'Site team', members: [priya, raviId] });
  for (let i = 1; i <= 40; i++) await ravi.request('msg.send', { convId: sp.id, body: `Line ${i}: support S-${100 + i} checked against the model, no clash found at this elevation.`, clientId: `a${i}` });
  await owner.request('msg.send', { convId: other.id, body: 'Crane at 8.', clientId: 'o1' });
  const open = async (name: string) => { await page.locator('.sb-row', { hasText: name }).first().click(); await sleep(700); };
  await page.locator('.lens-bar .lens').nth(2).click(); await sleep(500);
  if (await page.locator('.sb-fold[aria-expanded="false"]').count()) await page.locator('.sb-fold').click();
  await open('Piping P-12');
  await page.locator('.timeline .msg', { hasText: 'Line 40:' }).waitFor();
  // 1. read it all, leave, three new arrive: coming back shows the New line above them
  await open('Site team');
  for (let i = 41; i <= 43; i++) await ravi.request('msg.send', { convId: sp.id, body: `Line ${i}: new since you looked.`, clientId: `b${i}` });
  await sleep(600);
  await open('Piping P-12');
  await page.locator('.new-line').waitFor();
  const next = await page.locator('.new-line + .run .msg').first().innerText();
  assert.match(next, /Line 41:/, `the New line sits above the first new message: ${next}`);
  await shot(page, 'polish-01-new-line');
  // 2. scroll back: the way to the newest shows, counts what arrives, and takes you there
  await page.locator('.timeline').evaluate((el: HTMLElement) => { el.scrollTop = 0; });
  await page.locator('.to-latest').waitFor();
  await ravi.request('msg.send', { convId: sp.id, body: 'Line 44: one more while you read back.', clientId: 'c44' });
  await page.locator('.to-latest.fresh', { hasText: '1 new' }).waitFor();
  await shot(page, 'polish-02-to-latest');
  await page.locator('.to-latest').click();
  await page.locator('.to-latest').waitFor({ state: 'detached' });
  await sleep(1200);
  const atEnd = await page.locator('.timeline').evaluate((el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  assert.ok(atEnd, 'at the newest message');
  // 3. reading back, switch away and back: the same message is still at the top
  await page.locator('.timeline').evaluate((el: HTMLElement) => { const m = el.querySelector('.msg[data-mid]:nth-of-type(1)'); void m; el.scrollTop = el.scrollHeight * 0.35; });
  await sleep(300);
  const before = await page.locator('.timeline').evaluate((el: HTMLElement) => { const box = el.getBoundingClientRect(); const m = [...el.querySelectorAll<HTMLElement>('[data-mid]')].find((x) => x.getBoundingClientRect().bottom > box.top + 8)!; return { id: m.dataset.mid, top: Math.round(m.getBoundingClientRect().top - box.top) }; });
  await open('Site team');
  await open('Piping P-12');
  await sleep(500);
  const after = await page.locator('.timeline').evaluate((el: HTMLElement, id: string) => { const box = el.getBoundingClientRect(); const m = el.querySelector<HTMLElement>(`[data-mid="${id}"]`)!; return Math.round(m.getBoundingClientRect().top - box.top); }, before.id!);
  assert.ok(Math.abs(after - before.top) < 40, `reading place kept: ${before.top} → ${after}`);
  // 4. the keyboard: arrows move between messages and show their tools; Esc closes a side-track
  await page.locator('.timeline').focus();
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowUp');
  const focused = await page.evaluate(() => (document.activeElement as HTMLElement).matches('.msg[data-mid]') && getComputedStyle(document.activeElement!.querySelector('.spine-tools')!).display !== 'none');
  assert.ok(focused, 'a message has the keyboard and shows its tools');
  await shot(page, 'polish-03-keyboard');
  // Tab goes into the message's tools: on to its side-track button, and Enter opens it
  for (let i = 0; i < 8 && await page.evaluate(() => document.activeElement?.getAttribute('title')) !== 'Side-track'; i++) await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.msg .spine-tools')), true, 'Tab reaches the tools');
  await page.keyboard.press('Enter');
  await page.locator('.side-track').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('.side-track').waitFor({ state: 'detached' });
  // 5. deleting asks in the app first; Cancel keeps it
  await page.locator('.dock textarea').first().fill('A message to delete');
  await page.keyboard.press('Enter');
  const mine = page.locator('.timeline .msg', { hasText: 'A message to delete' });
  await mine.waitFor(); await sleep(400);
  await mine.hover(); await mine.getByTitle('More', { exact: true }).click();
  await page.getByRole('menuitem', { name: /^Delete/ }).click();
  const dlg = page.getByRole('dialog', { name: 'Delete this message for everyone?' });
  await dlg.waitFor();
  assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement).textContent), 'Keep it'); // the safe choice has the focus
  await shot(page, 'polish-04-confirm');
  await dlg.getByRole('button', { name: 'Keep it' }).click();
  await dlg.waitFor({ state: 'detached' });
  assert.equal(await mine.count(), 1);
  await mine.hover(); await mine.getByTitle('More', { exact: true }).click();
  await page.getByRole('menuitem', { name: /^Delete/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await page.locator('.msg.deleted').waitFor();
  // 6. a reminder deleted from the Desk comes back with Undo
  await page.evaluate(() => window.dex.request('remind.create', { text: 'Check the bolt list', dueAt: Date.now() + 3 * 3600_000 }));
  await page.locator('.lens-bar .lens').nth(3).click();
  await page.getByRole('tab', { name: /^Reminders/ }).click();
  const row = page.locator('.desk-row', { hasText: 'Check the bolt list' });
  await row.waitFor();
  await row.getByRole('button', { name: 'More for this reminder' }).click();
  await page.keyboard.press('End'); // the menu took the keyboard: End is Delete
  assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement).textContent?.trim()), 'Delete');
  await page.keyboard.press('Enter');
  await page.locator('.toast', { hasText: 'Reminder deleted' }).getByRole('button', { name: 'Undo' }).click();
  await page.locator('.desk-row', { hasText: 'Check the bolt list' }).waitFor();
  await shot(page, 'polish-05-undo');
  // 7. a reminder card closed stays closed after a reload; a new one still rings
  await page.evaluate(() => window.dex.request('remind.create', { text: 'Ring now', dueAt: Date.now() - 1000 }));
  const card = page.locator('.reminder-card', { hasText: 'Ring now' });
  await card.waitFor({ timeout: 15000 });
  await card.locator('.reminder-top > .icon-btn').click();
  await card.waitFor({ state: 'detached' });
  await page.reload(); await page.locator('.frame').waitFor(); await sleep(2500);
  assert.equal(await page.locator('.reminder-card', { hasText: 'Ring now' }).count(), 0, 'the dismissed card stays dismissed');
  console.log('POLISH E2E PASSED');
} catch (e) { await shot(page, 'polish-FAIL'); throw e; } finally { await app.close(); owner.disconnect(); await hub.stop(); setTimeout(() => process.exit(process.exitCode ?? 0), 300); }
