// Zoho Calendar, end to end against a mock Zoho (apps/hub/test/zoho-mock.ts; never the real
// Zoho): before the office's client is set up the button is there but disabled; an administrator
// saves the client once in the Control room and everyone is invited; Priya connects from the
// Calendar lens (no browser: DEXCONNECT_TEST_ZOHO_BROWSER=fetch follows the mock's sign-in page
// to the app's loopback address); her 10:00 IST meeting appears in Zoho at 04:30Z; a Zoho
// appointment shows hatched and read-only in her week; a revoked connection asks to reconnect.
// Screenshots at 1440 and 390 px, light and dark, and in Hindi, in ZOHO_OUT (default e2e/out).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { ZohoMock } from '../../hub/test/zoho-mock.ts';
import { OUT as BASE_OUT, launch, sleep, startOffice } from './harness.mts';

const OUT = process.env.ZOHO_OUT ?? BASE_OUT;
fs.mkdirSync(OUT, { recursive: true });
const snap = (page: any, name: string) => page.screenshot({ path: path.join(OUT, `zoho-${name}.png`) });
async function both(page: any, name: string) {
  for (const t of ['light', 'dark']) {
    await page.evaluate((x: string) => { document.documentElement.dataset.theme = x; }, t);
    await sleep(250);
    await snap(page, `${name}-${t}`);
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}
const freePort = () => new Promise<number>((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });

const mock = await new ZohoMock().start(['com', 'in']);
const port = await freePort();
mock.redirectUri = `http://127.0.0.1:${port}/zoho/callback`;
mock.addUser('priya@dexterity.example', 'in');
mock.signIn = 'priya@dexterity.example'; // who "signs in" on the mock's page
// the hub runs in this process: point it at the mock (tests only)
process.env.DEX_ZOHO_TEST_DCS = JSON.stringify(mock.dcs());
process.env.DEX_ZOHO_CALLBACK_PORT = String(port);
const { owner, hub } = await startOffice('zoho');
const { app, page } = await launch('priya', 'Priya Raman', { width: 1440, height: 900, env: { DEXCONNECT_TEST_ZOHO_BROWSER: 'fetch', TZ: 'Asia/Kolkata' } });
const H = 3600_000;
try {
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;

  // 1. the office has not set Zoho up: the call to action is there, disabled, and says why
  await page.getByRole('button', { name: /^Calendar/ }).first().click();
  await page.locator('.week').waitFor();
  const card = page.locator('.zoho-card');
  await card.getByText("Your office's Zoho connection isn't set up yet.").waitFor();
  assert.equal(await card.getByRole('button', { name: 'Connect Zoho Calendar' }).isDisabled(), true);
  await both(page, '01-calendar-not-set-up');

  // 2. an administrator registers the office's client once (Priya is made an admin for this)
  await owner.request('admin.setRole', { userId: priya.id, role: 'admin' });
  await sleep(600);
  await page.locator('.me-btn').click();
  await page.getByRole('menuitem', { name: /Control room/ }).click();
  await page.getByRole('button', { name: /^Integrations/ }).click();
  const form = page.locator('.zoho-admin');
  await form.waitFor();
  assert.equal(await form.locator('select').inputValue(), 'in', 'India is the default data centre');
  await form.getByText(mock.redirectUri).waitFor();
  await form.getByPlaceholder('1000.XXXXXXXXXXXX').fill(mock.clientId);
  await form.getByPlaceholder('Paste the client secret').fill(mock.clientSecret);
  await both(page, '02-control-room-form');
  await form.getByRole('button', { name: 'Save and invite everyone' }).click();
  await form.getByPlaceholder('Saved. Leave empty to keep it').waitFor();
  assert.equal(await form.getByPlaceholder('Saved. Leave empty to keep it').inputValue(), '', 'the secret is not shown again');
  const nudge = hub.store.db.prepare(`SELECT body FROM messages WHERE author_id = ? AND body LIKE '%Connect Zoho Calendar%'`).all(hub.system.id);
  assert.ok(nudge.length >= 1, 'everyone gets the one-time invitation');
  await page.keyboard.press('Escape');

  // 3. Priya connects from the Calendar lens: one click, the sign-in comes back, the first sync runs
  await page.getByRole('button', { name: /^Calendar/ }).first().click();
  await card.getByRole('button', { name: 'Connect Zoho Calendar' }).click();
  await page.locator('.zoho-strip', { hasText: 'Connected as priya@dexterity.example' }).waitFor({ timeout: 20000 });
  assert.ok(mock.log.some((l) => l.dc === 'in' && l.path === '/oauth/v2/token'), 'her data centre (India) came from the redirect');

  // 4. a 10:00 meeting in Chennai is 04:30Z in Zoho
  const day = new Date(); day.setUTCDate(day.getUTCDate() + 1); day.setUTCHours(4, 30, 0, 0);
  const at = day.getTime();
  await page.evaluate((t) => window.dex.request('cal.create', { title: 'Pump skid review', startAt: t, endAt: t + 3600_000, timeZone: 'Asia/Kolkata', online: true }), at);
  await hub.zoho.runNow(priya.id);
  const copy = mock.eventsOf('priya@dexterity.example').find((e) => e.title === 'Pump skid review');
  assert.ok(copy, 'the meeting is in Zoho');
  assert.equal(copy!.dateandtime.start, `${day.toISOString().slice(0, 10).replace(/-/g, '')}T043000Z`);
  assert.doesNotMatch(copy!.description ?? '', /asscode/);

  // 5. a Zoho appointment shows hatched, read-only, in her week
  const zt = at + 3 * H;
  const z = (t: number) => new Date(t).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  mock.addZohoEvent('priya@dexterity.example', { title: 'Vendor call (Zoho)', start: z(zt), end: z(zt + H) });
  await page.evaluate(() => window.dex.request('zoho.syncNow'));
  await sleep(800);
  if (!(await page.locator('.cal-block.ext').count())) await page.getByRole('button', { name: 'Next week' }).click();
  const ext = page.locator('.cal-block.ext', { hasText: 'Vendor call (Zoho)' });
  await ext.waitFor({ timeout: 10000 });
  await page.locator('.cal-block', { hasText: 'Pump skid review' }).scrollIntoViewIfNeeded();
  await both(page, '03-calendar-connected-week');
  await ext.click();
  await page.getByRole('dialog').getByText('From your Zoho Calendar').waitFor();
  await both(page, '04-zoho-event-readonly');
  await page.getByRole('dialog').getByRole('button', { name: 'Done' }).click();

  // 6. Preferences → Calendar: the status, the calendar choice, sync now and disconnect
  await page.keyboard.press('Control+,');
  const prefs = page.locator('.zoho-box');
  await prefs.waitFor();
  await prefs.scrollIntoViewIfNeeded();
  const line = await prefs.locator('[data-zoho-line]').innerText();
  assert.match(line, /Connected as priya@dexterity\.example · last synced/);
  await both(page, '05-preferences-connected');

  // 7. phone width
  await page.setViewportSize({ width: 390, height: 844 });
  await sleep(400);
  await prefs.scrollIntoViewIfNeeded();
  await both(page, '06-preferences-390');
  await page.keyboard.press('Escape'); // back to the Calendar lens
  await page.locator('.view.calendar').waitFor();
  await sleep(500);
  await both(page, '07-calendar-390');
  await page.setViewportSize({ width: 1440, height: 900 });

  // 8. revoked in Zoho: "Reconnect needed", then reconnecting from the card
  mock.revokeAll('priya@dexterity.example');
  mock.expireAccess();
  await page.evaluate((t) => window.dex.request('cal.create', { title: 'After revoke', startAt: t, endAt: t + 3600_000 }), at + 6 * H);
  await hub.zoho.runNow(priya.id);
  const warn = page.locator('.zoho-card.warn');
  await warn.waitFor({ timeout: 10000 });
  await both(page, '08-reconnect-needed');
  await warn.getByRole('button', { name: 'Reconnect Zoho Calendar' }).click();
  await page.locator('.zoho-strip', { hasText: 'Connected as' }).waitFor({ timeout: 20000 });
  await hub.zoho.runNow(priya.id);
  assert.deepEqual(mock.eventsOf('priya@dexterity.example').filter((e) => !e.title.includes('Zoho')).map((e) => e.title).sort(), ['After revoke', 'Pump skid review'], 'nothing twice');

  // 9. the Control room shows who is connected, never their events
  await page.locator('.me-btn').click();
  await page.getByRole('menuitem', { name: /Control room/ }).click();
  await page.getByRole('button', { name: /^Integrations/ }).click();
  await page.locator('.zoho-people .list-row', { hasText: 'priya@dexterity.example' }).waitFor();
  assert.doesNotMatch(await page.locator('.zoho-admin').innerText(), /Vendor call|Pump skid/);
  await page.locator('.zoho-people').scrollIntoViewIfNeeded();
  await both(page, '09-control-room-people');
  await page.keyboard.press('Escape');

  // 10. in Hindi
  await page.evaluate(() => localStorage.setItem('dex.language', 'hi'));
  await page.reload(); await page.locator('.frame').waitFor(); await sleep(800);
  await page.keyboard.press('Control+,');
  await page.locator('.zoho-box').waitFor();
  await page.locator('.zoho-box').scrollIntoViewIfNeeded();
  await snap(page, '10-preferences-hi');
  await page.evaluate(() => localStorage.setItem('dex.language', 'en'));
  console.log('ZOHO E2E PASSED');
} catch (e) { await snap(page, 'FAIL'); throw e; } finally { await app.close(); owner.disconnect(); await hub.stop(); await mock.stop(); }
