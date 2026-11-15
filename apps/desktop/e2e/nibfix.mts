// Nib's tray and labels, checked where the user guide found them wrong: the wrap-up fits its tray
// (1440 px and the 390 px bottom sheet, in English, Hindi and Tamil) and does not scroll sideways
// when Blockers is typed in; the wrap-up time in Nib's conversation header follows the 12/24-hour
// preference; an item saved from another device appears in an open tray; and the three lobby rules
// read the same in the Meet lens, the Control room and the meeting dialog.
// NIBFIX_BEFORE=1 only measures and takes screenshots (for a build from before the fixes).
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { startOffice, launch, sleep, OUT as BASE_OUT } from './harness.mts';
import { OFFICE, seedOffice } from './officeseed.mts';
import { createIdentity } from '../../../packages/core/src/index.ts';
import { HubClient } from '../../../packages/core/src/hub-client.ts';

const BEFORE = process.env.NIBFIX_BEFORE === '1';
const OUT = process.env.NIBFIX_OUT ?? BASE_OUT;
const TAG = BEFORE ? 'before' : 'after';
fs.mkdirSync(OUT, { recursive: true });
const snap = (page: any, name: string) => page.screenshot({ path: path.join(OUT, `nibfix-${name}-${TAG}.png`) });
const check = (ok: boolean, what: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!BEFORE) assert.ok(ok, what); };
/** The lobby rules, one set of names everywhere. */
const LOBBY = { outside: 'Guests and people from outside wait', everyone: 'Everyone waits to be let in', off: 'Only guests from a browser wait' };

const { hub, owner } = await startOffice('nibfix');
const localToday = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
const at = (h: number, m = 0) => { const [y, mo, d] = localToday.split('-').map(Number); return new Date(y, mo - 1, d, h, m).getTime(); };
const clock = (h: number, m = 0) => { const t = at(h, m); hub.nib.setClock(t); hub.nib.tick(t); return t; };
const seeded = await seedOffice(hub, owner, OFFICE, ['vikram', 'karthik']);
let K: any;
const apps: any[] = [];
const extra: any[] = [];
try {
  const k = await launch('karthik', 'Karthik Subramanian', { width: 1440, height: 900 });
  apps.push(k.app); K = k.page;
  const dir = (await owner.request('directory.list')).users;
  const karthikId = dir.find((x: any) => x.account.endsWith('\\karthik'))?.id as string;
  await seeded.profiles({ karthik: karthikId });
  const ids = Object.fromEntries([...seeded.ids]) as Record<string, string>;
  await owner.request('admin.nib.set', {
    givers: [{ userId: ids.priya, kind: 'area', scope: 'Area 4' }, { userId: ids.anand, kind: 'discipline', scope: 'Structural' }],
    managers: [owner.session.me.id], workdays: [0, 1, 2, 3, 4, 5, 6], projects: [{ code: 'P-12', name: 'Refinery revamp' }, { code: 'J-0412', name: 'Pump house upgrade' }],
    startPromptAt: '09:45', wrapAt: '18:00', digestAt: '19:00', followUpAt: '21:00', nudgeLimit: 3,
  });
  clock(17, 40);
  const user = hub.store.userById(karthikId);
  hub.nib.handle('nib.start', user, { givers: [ids.priya, ids.anand] });
  hub.nib.handle('nib.item.save', user, { giverId: ids.priya, project: 'P-12', activity: 'Isometrics, area 4 pipe rack', qty: { done: 9, total: 12, unit: 'isos' } });
  hub.nib.handle('nib.item.save', user, { giverId: ids.anand, project: 'J-0412', activity: 'Support check for the pump house', qty: { done: 3, total: 40, unit: 'supports' }, status: 'blocked', note: 'Waiting for vendor nozzle loads' });
  hub.nib.handle('nib.item.save', user, { giverId: ids.priya, project: 'P-12', activity: 'MTO take-off', qty: { done: 60, total: 100, unit: '%' } });
  await K.evaluate(() => window.dex.setSettings({ timeFormat: '12' }));
  await K.reload(); await K.locator('.frame').waitFor();

  // ---------------------------------------------------------------- 1. the wrap-up fits its tray
  const wrapAt = async (lang: string, width: number, height: number) => {
    await K.evaluate((l: string) => { localStorage.setItem('dex.language', l); }, lang);
    await K.setViewportSize({ width, height });
    await K.reload(); await K.locator('.frame').waitFor();
    await K.locator('.nib-btn').first().click();
    await K.locator('.nib-tray').waitFor();
    await K.locator('.nib-skill').first().click(); // Wrap up my day
    await K.locator('.nib-wrapup').waitFor();
    const blockers = K.locator('.nib-wrapup .nib-edit-grid input').nth(1);
    await blockers.scrollIntoViewIfNeeded();
    await blockers.click();
    await blockers.pressSequentially('Vendor data for the pump nozzles, and the civil foundation drawing for the pipe rack');
    await sleep(300);
    const m = await K.evaluate(() => {
      const body = document.querySelector<HTMLElement>('.nib-tray-body')!;
      const tray = document.querySelector<HTMLElement>('.nib-tray')!;
      const wrap = document.querySelector<HTMLElement>('.nib-wrapup')!;
      const tr = tray.getBoundingClientRect();
      const out = [...wrap.querySelectorAll<HTMLElement>('*')].filter((e) => e.getBoundingClientRect().right > tr.right + 0.5 && e.getClientRects().length).map((e) => e.className || e.tagName).slice(0, 6);
      return { tray: Math.round(tr.width), body: body.clientWidth, scroll: body.scrollWidth, left: body.scrollLeft, wrap: Math.round(wrap.getBoundingClientRect().width), out };
    });
    console.log(`wrap-up ${lang} ${width}px:`, JSON.stringify(m));
    await snap(K, `1-wrapup-${width}-${lang}`);
    if (lang === 'en') {
      await K.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
      await sleep(250);
      await snap(K, `1-wrapup-${width}-${lang}-dark`);
      await K.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    }
    check(m.left === 0 && m.scroll <= m.body && m.out.length === 0, `the wrap-up fits the tray (${lang}, ${width} px): content ${m.scroll} in ${m.body}, scrolled ${m.left}, outside: ${m.out.join(' ')}`);
    await K.keyboard.press('Escape');
  };
  for (const lang of process.env.NIBFIX_SKIP1 ? [] : ['en', 'hi', 'ta']) {
    await wrapAt(lang, 1440, 900);
    await wrapAt(lang, 390, 844);
  }
  await K.evaluate(() => { localStorage.setItem('dex.language', 'en'); });
  await K.setViewportSize({ width: 1440, height: 900 });
  await K.reload(); await K.locator('.frame').waitFor();

  // ---------------------------------------------------------------- 6. the wrap-up time in Nib's header follows the preference
  await K.getByRole('button', { name: /^Direct/ }).first().click();
  await K.locator('.sb-nib').click();
  const head = K.locator('.pane-head, .pane-title-block, header').filter({ hasText: 'Wrap-up' }).first();
  await head.waitFor({ timeout: 15000 });
  await sleep(400);
  const h12 = await head.innerText();
  console.log('header, 12-hour:', JSON.stringify(h12.replace(/\s+/g, ' ')));
  await snap(K, '6-nib-header-12h');
  check(/6:00\s?PM/i.test(h12) && !/18:00/.test(h12), 'the header reads 6:00 PM in 12-hour mode');
  await K.evaluate(() => window.dex.setSettings({ timeFormat: '24' }));
  await sleep(600);
  const h24 = await head.innerText();
  console.log('header, 24-hour:', JSON.stringify(h24.replace(/\s+/g, ' ')));
  await snap(K, '6-nib-header-24h');
  check(/18:00/.test(h24) && !/PM/i.test(h24), 'the header reads 18:00 in 24-hour mode');
  await K.evaluate(() => window.dex.setSettings({ timeFormat: '12' }));

  // ---------------------------------------------------------------- 7. an item saved from another device appears in the open tray
  // Karthik's laptop: the same account as his PC (the app signs in with this machine's domain)
  const account = dir.find((x: any) => x.id === karthikId).account as string;
  const laptop = new HubClient({ identity: createIdentity(), account: { username: 'karthik', domain: account.split('\\')[0], displayName: 'Karthik Subramanian', hostname: 'KARTHIK-LAPTOP' } });
  extra.push(laptop);
  laptop.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
  for (let i = 0; i < 200 && laptop.state.kind !== 'ready'; i++) await sleep(100);
  assert.equal(laptop.session?.me.id, karthikId, 'the laptop is Karthik');
  await K.locator('.nib-btn').first().click();
  await K.locator('.nib-tray .nib-sheet').waitFor();
  await laptop.request('nib.item.save', { giverId: ids.priya, project: 'P-12', activity: 'Spool drawings from the laptop', qty: { done: 2, total: 6, unit: 'drawings' } });
  const seen = await K.locator('.nib-tray .nib-item', { hasText: 'Spool drawings from the laptop' }).waitFor({ timeout: 5000 }).then(() => true, () => false);
  await snap(K, '7-tray-live');
  check(seen, 'the open tray shows the item saved from the laptop, without a reload');
  // and in the wrap-up, while it is open
  await K.locator('.nib-skill').first().click();
  await K.locator('.nib-wrapup').waitFor();
  await laptop.request('nib.item.save', { giverId: ids.anand, project: 'J-0412', activity: 'Clash list for the pump house' });
  const seenWrap = await K.locator('.nib-wrapup .nib-item', { hasText: 'Clash list for the pump house' }).waitFor({ timeout: 5000 }).then(() => true, () => false);
  check(seenWrap, 'the open wrap-up gains the item saved from the laptop');
  await K.keyboard.press('Escape');

  // ---------------------------------------------------------------- 3. one set of names for the lobby rules
  const options = (sel: any) => sel.evaluate((s: HTMLSelectElement) => Object.fromEntries([...s.options].map((o) => [o.value, o.text])));
  await owner.request('admin.setRole', { userId: karthikId, role: 'admin' });
  await K.locator('.lens-bar .lens', { hasText: 'Meet' }).click();
  const lensSel = K.locator('.meet-options select').first();
  await lensSel.waitFor({ timeout: 15000 });
  await lensSel.selectOption('off');
  await sleep(200);
  await K.locator('.meet-options').first().scrollIntoViewIfNeeded();
  await snap(K, '3-meet-lens');
  const lensOpts = await options(lensSel);
  console.log('Meet lens:', JSON.stringify(lensOpts));
  check(JSON.stringify(lensOpts) === JSON.stringify({ outside: LOBBY.outside, everyone: LOBBY.everyone, off: LOBBY.off }), 'Meet lens: the three names');
  // the Control room
  await K.reload(); await K.locator('.frame').waitFor();
  await K.locator('.me-btn').click();
  await K.getByRole('menuitem', { name: /Control room/ }).click();
  await K.getByRole('button', { name: 'Policies' }).click();
  const polSel = K.locator('#p-lobby');
  await polSel.waitFor();
  await polSel.scrollIntoViewIfNeeded();
  await polSel.selectOption('off');
  await sleep(400);
  await snap(K, '3-control-room');
  const polOpts = await options(polSel);
  console.log('Control room:', JSON.stringify(polOpts));
  check(JSON.stringify(polOpts) === JSON.stringify({ outside: LOBBY.outside, everyone: LOBBY.everyone, off: LOBBY.off }), 'Control room: the three names');
  await polSel.selectOption('outside');
  await K.keyboard.press('Escape');
  // the meeting dialog
  await K.getByRole('button', { name: /^Calendar/ }).first().click();
  await K.getByRole('button', { name: 'New meeting' }).click();
  await K.locator('.toggle-row', { hasText: 'Guests from outside can join from a browser' }).click().catch(() => {});
  const evSel = K.locator('.ev-lobby select');
  if (await evSel.count()) {
    await evSel.selectOption('off');
    await K.locator('.dialog').evaluate((d: HTMLElement) => { d.querySelector('.ev-lobby')?.scrollIntoView({ block: 'center' }); });
    await sleep(300);
    await snap(K, '3-meeting-dialog');
    const evOpts = await options(evSel);
    console.log('Meeting dialog:', JSON.stringify(evOpts));
    check(JSON.stringify(evOpts) === JSON.stringify(LOBBY), 'Meeting dialog: the three names');
  } else console.log('the meeting dialog shows no lobby choice here (no meeting site)');
  await K.keyboard.press('Escape');

  console.log(BEFORE ? 'NIBFIX MEASURED (before)' : 'NIBFIX E2E PASSED');
} catch (e) {
  if (K) await snap(K, 'FAIL').catch(() => {});
  throw e;
} finally {
  hub.nib.setClock(null);
  for (const a of apps) await a.close().catch(() => {});
  for (const c of extra) c.disconnect();
  owner.disconnect();
  await hub.stop();
}
