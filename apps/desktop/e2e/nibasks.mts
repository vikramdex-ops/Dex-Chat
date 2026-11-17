// Nib's asks with the office's times (docs/NIB.md §3.5): wrap-up 18:00, register 18:30, follow-up
// 19:00, three asks a day. The Control room shows when the asks go and says plainly when a window is
// too short for them all; Karthik gets the quiet drop at 18:00, the wrap-up card at 18:11 and the
// message at 18:22; the register at 18:30 says "asked 3×"; a late sheet brings exactly one
// follow-up at 19:00. Nib's clock is the in-process hub's (hub.nib.setClock).
// Screenshots at 1440 and 390 px, light and dark, and one in Hindi.
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { startOffice, launch, sleep, OUT as BASE_OUT } from './harness.mts';
import { OFFICE, seedOffice, bringOnline } from './officeseed.mts';

const OUT = process.env.NIBASKS_OUT ?? BASE_OUT;
fs.mkdirSync(OUT, { recursive: true });
const snap = (page: any, name: string) => page.screenshot({ path: path.join(OUT, `nibasks-${name}.png`) });
const pair = async (page: any, name: string) => {
  for (const t of ['light', 'dark']) {
    await page.evaluate((x: string) => { document.documentElement.dataset.theme = x; }, t);
    await sleep(250);
    await snap(page, `${name}-${t}`);
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
};

const { hub, owner } = await startOffice('nibasks');
const localToday = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
const at = (h: number, m = 0) => { const [y, mo, d] = localToday.split('-').map(Number); return new Date(y, mo - 1, d, h, m).getTime(); };
const clock = (h: number, m = 0) => { const t = at(h, m); hub.nib.setClock(t); hub.nib.tick(t); return t; };
const seeded = await seedOffice(hub, owner, OFFICE, ['vikram', 'karthik', 'bhavna']);
const apps: any[] = [];
const extra: any[] = [];
let K: any, B: any;
try {
  const k = await launch('karthik', 'Karthik Subramanian', { width: 1440, height: 900 });
  const b = await launch('bhavna', 'Bhavna Shah', { width: 1440, height: 900 });
  apps.push(k.app, b.app);
  K = k.page; B = b.page;
  const dir = (await owner.request('directory.list')).users;
  const id = (u: string) => dir.find((x: any) => x.account.endsWith(`\\${u}`) && x.role !== 'bot')?.id as string;
  await seeded.profiles({ karthik: id('karthik'), bhavna: id('bhavna') });
  const ids = { ...Object.fromEntries(OFFICE.map((o) => [o.u, seeded.ids.get(o.u)])), karthik: id('karthik'), bhavna: id('bhavna') } as Record<string, string>;
  await owner.request('admin.setRole', { userId: ids.bhavna, role: 'admin' });
  // the office's times; Bhavna receives the register; every day a workday, so the walk runs any day
  await owner.request('admin.nib.set', {
    givers: [{ userId: ids.priya, kind: 'area', scope: 'Area 4' }], managers: [ids.bhavna], workdays: [0, 1, 2, 3, 4, 5, 6],
    startPromptAt: '09:45', wrapAt: '18:00', digestAt: '18:30', followUpAt: '19:00', nudgeLimit: 3,
  });
  // Kiran never reports and sends late, after the register
  const [kiran] = await bringOnline(hub.port, hub.fingerprint, [{ u: 'kiran', name: 'Kiran Desai', mode: 'office' }]);
  extra.push(kiran);
  clock(9, 10);
  await kiran.request('nib.start', { givers: [] });

  // ---------------------------------------------------------------- 1. the Control room: when the asks go
  await B.reload(); await B.locator('.frame').waitFor();
  await B.locator('.me-btn').click();
  await B.getByRole('menuitem', { name: /Control room/ }).click();
  await B.getByRole('button', { name: /Nib & day sheets/ }).click();
  await B.locator('.nib-admin').waitFor();
  const asksLine = B.locator('.nib-admin-asks');
  await asksLine.waitFor();
  const line = (await asksLine.textContent()) ?? '';
  console.log('Control room:', line);
  assert.equal(await asksLine.getAttribute('data-fits'), '3');
  assert.match(line, /6:00|18:00/);
  assert.match(line, /6:11|18:11/);
  assert.match(line, /6:22|18:22/);
  assert.equal(await B.locator('.nib-admin-short').count(), 0, 'no note when the asks fit');
  await asksLine.evaluate((el: HTMLElement) => el.closest('section')!.scrollIntoView({ block: 'start' }));
  await sleep(300);
  await pair(B, '01-times-fit');
  // a wrap-up at 18:15 leaves room for two: the note says so, next to the times
  const wrapField = B.locator('.nib-admin-grid label', { hasText: 'Wrap-up' }).locator('input');
  await wrapField.fill('18:15');
  await B.locator('.nib-admin-short').waitFor();
  const note = (await B.locator('.nib-admin-short').textContent()) ?? '';
  console.log('Control room note:', note);
  assert.equal(note, 'With these times Nib can ask 2 times before the register.');
  await B.locator('.nib-admin-short').evaluate((el: HTMLElement) => el.closest('section')!.scrollIntoView({ block: 'start' }));
  await sleep(300);
  await pair(B, '02-times-short');
  await B.setViewportSize({ width: 390, height: 844 });
  await sleep(500);
  await B.locator('.nib-admin-short').evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'center' }));
  await sleep(300);
  await pair(B, '03-times-short-phone');
  const overflow = await B.evaluate(() => document.querySelector<HTMLElement>('.nib-admin')!.scrollWidth - document.querySelector<HTMLElement>('.nib-admin')!.clientWidth);
  assert.ok(overflow <= 1, `the Control room does not scroll sideways at 390 px (${overflow})`);
  await B.setViewportSize({ width: 1440, height: 900 });
  // in Hindi
  await B.evaluate(() => { localStorage.setItem('dex.language', 'hi'); });
  await B.reload(); await B.locator('.frame').waitFor();
  await B.locator('.me-btn').click();
  await B.getByRole('menuitem').nth(0).waitFor();
  await B.locator('[role="menuitem"]').filter({ hasText: /कंट्रोल|Control/ }).first().click();
  await B.getByRole('button', { name: /निब और डे शीट/ }).click();
  await B.locator('.nib-admin').waitFor();
  await B.locator('.nib-admin-grid label').nth(1).locator('input').fill('18:15');
  await B.locator('.nib-admin-short').waitFor();
  await B.locator('.nib-admin-short').evaluate((el: HTMLElement) => el.closest('section')!.scrollIntoView({ block: 'start' }));
  await sleep(300);
  await snap(B, '04-times-short-hi-light');
  const hiNote = (await B.locator('.nib-admin-short').textContent()) ?? '';
  assert.ok(!/With these times/.test(hiNote), `the note is in Hindi: ${hiNote}`);
  await B.evaluate(() => { localStorage.setItem('dex.language', 'en'); });
  await B.reload(); await B.locator('.frame').waitFor();
  // nothing was saved: the office keeps 18:00
  assert.equal((await owner.request('admin.nib.get')).wrapAt, '18:00');

  // ---------------------------------------------------------------- 2. Karthik: drop, card, message
  await K.reload(); await K.locator('.frame').waitFor();
  await K.locator('.nib-btn').waitFor();
  await K.evaluate(() => window.dex.request('nib.start', { givers: [] }));
  await K.evaluate(() => window.dex.request('nib.item.save', { activity: 'Isometrics, area 4 pipe rack', project: 'P-12', qty: { done: 9, total: 12, unit: 'isos' } }));
  const wrapAsks = async () => ((await K.evaluate(() => window.dex.request('nib.me'))).day.asks as any[]).filter((a) => a.kind === 'wrap');
  clock(17, 59);
  assert.equal((await wrapAsks()).length, 0);
  clock(18, 0);
  await K.locator('.nib-tile.ink-quiet').first().waitFor({ timeout: 8000 });
  assert.equal(await K.locator('.nib-callout').count(), 0, 'the drop moves nothing');
  await sleep(300);
  await snap(K, '05-drop-1800-light');
  for (let m = 1; m <= 10; m++) clock(18, m);
  assert.equal((await wrapAsks()).length, 1, 'nothing more until 18:11');
  clock(18, 11);
  await K.locator('.nib-callout').waitFor({ timeout: 8000 });
  await sleep(300);
  await pair(K, '06-card-1811');
  await K.setViewportSize({ width: 390, height: 844 });
  await sleep(500);
  await pair(K, '07-card-1811-phone');
  await K.setViewportSize({ width: 1440, height: 900 });
  await sleep(300);
  // Not now: the card closes until the next ask
  await K.keyboard.press('Escape');
  await K.locator('.nib-callout').waitFor({ state: 'detached', timeout: 5000 });
  for (let m = 12; m <= 21; m++) clock(18, m);
  assert.equal((await wrapAsks()).length, 2, 'nothing more until 18:22');
  clock(18, 22);
  const asks = await wrapAsks();
  assert.deepEqual(asks.map((a: any) => [new Date(a.at).getHours(), new Date(a.at).getMinutes(), a.level]), [[18, 0, 1], [18, 11, 2], [18, 22, 3]], 'the drop at 18:00, the card at 18:11, the message at 18:22');
  // the message, in the conversation with Nib, and the card back under the tile
  await K.locator('.nib-callout').waitFor({ timeout: 8000 });
  await K.getByRole('button', { name: /^Direct/ }).first().click();
  await K.locator('.sb-nib').click();
  await K.locator('.nib-card.k-ask, .msg', { hasText: /still open|before the register/ }).first().waitFor({ timeout: 15000 }).catch(() => {});
  const convId = (await K.evaluate(() => window.dex.request('nib.me'))).convId;
  const msgs = (await K.evaluate((c: string) => window.dex.request('msg.list', { convId: c }), convId)).messages.filter((m: any) => m.nib?.kind === 'ask');
  assert.equal(msgs.length, 1, 'one message');
  await sleep(400);
  await pair(K, '08-message-1822');
  for (let m = 23; m <= 29; m++) clock(18, m);
  assert.equal((await wrapAsks()).length, 3, 'no more than three');

  // ---------------------------------------------------------------- 3. the register at 18:30: asked 3×
  clock(18, 30);
  clock(18, 31);
  const reg = await B.evaluate((d: string) => window.dex.request('nib.card', { kind: 'register', ref: d }), localToday) as any;
  const miss = reg.register.missing.find((m: any) => m.userId === ids.karthik);
  assert.equal(miss?.asks, 3, `Karthik: asked ${miss?.asks} times`);
  await B.getByRole('button', { name: /^Direct/ }).first().click();
  await B.locator('.sb-nib').click();
  await B.locator('.nib-card.k-register').waitFor({ timeout: 15000 });
  await B.locator('.nib-card.k-register [role="tab"]', { hasText: 'Leave and missing' }).click();
  const row = B.locator('.nib-card.k-register .nib-who', { hasText: 'Karthik' }).first();
  await row.waitFor({ timeout: 8000 });
  const rowText = (await row.textContent()) ?? '';
  console.log('register row:', rowText.replace(/\s+/g, ' ').trim());
  assert.match(rowText, /ASKED 3×/);
  await row.evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'center' }));
  await sleep(300);
  await pair(B, '09-register-asked-3');

  // ---------------------------------------------------------------- 4. a late sheet: one follow-up at 19:00
  clock(18, 40);
  await kiran.request('nib.item.save', { activity: 'Support check', project: 'P-12' });
  await kiran.request('nib.wrap', {});
  clock(18, 59);
  const followUps = () => B.evaluate(async () => { const me = await window.dex.request('nib.me'); return (await window.dex.request('msg.list', { convId: me.convId })).messages.filter((m: any) => m.nib?.kind === 'followup').length; });
  assert.equal(await followUps(), 0);
  clock(19, 0);
  clock(19, 20);
  const follow = await followUps();
  assert.equal(follow, 1, 'exactly one follow-up');

  console.log('NIBASKS E2E PASSED');
} catch (e) {
  for (const [pg, n] of [[K, 'karthik'], [B, 'bhavna']] as const) if (pg) await snap(pg, `FAIL-${n}`).catch(() => {});
  throw e;
} finally {
  hub.nib.setClock(null);
  for (const a of apps) await a.close().catch(() => {});
  for (const c of extra) c.disconnect();
  owner.disconnect();
  await hub.stop();
}
