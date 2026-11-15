// Fixes from writing the user guide, end to end. Bhavna (an administrator) keeps 12-hour times: a
// meeting in a Space ends and its divider, recap card and recap sheet read "2:38 pm"; an urgent
// notice's banner takes its own row and pushes the Directory down (1440 and 390 px); a standing
// policy that asks for acknowledgement keeps REV, its date and the ACKNOWLEDGE tag tidy on the In
// force shelf (English, Hindi, Tamil); issuer and Nib management chips keep the × beside a long
// name; Control room ▸ Organisation ▸ Office managers names one with the chip picker (audited); a
// hot desk is booked for a working day ahead from the seat callout, which lists its bookings.
// FIXES3_TAG=before runs the shots against an older build (DEX_DESKTOP) and skips the new checks.
// Screenshots in FIXES3_OUT (default e2e/out/fixes3).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startOffice, launch, sleep, OUT as BASE_OUT } from './harness.mts';
import { OFFICE, seedOffice } from './officeseed.mts';
const HI = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../src/renderer/i18n/hi.json'), 'utf8')) as Record<string, string>;

const TAG = process.env.FIXES3_TAG ?? 'after';
const NEW = TAG !== 'before';
const OUT = process.env.FIXES3_OUT ?? path.join(BASE_OUT, 'fixes3');
fs.mkdirSync(OUT, { recursive: true });
const theme = (page: any, t: string) => page.evaluate((x: string) => { document.documentElement.dataset.theme = x; }, t);
const snap = async (page: any, name: string, sizes: Array<[number, number]> = [[1440, 900]], clip?: () => Promise<any>) => {
  for (const [w, h] of sizes) {
    await page.setViewportSize({ width: w, height: h });
    await sleep(400);
    for (const t of ['light', 'dark']) {
      await theme(page, t);
      await sleep(250);
      const c = clip ? await clip() : undefined;
      await page.screenshot({ path: path.join(OUT, `${TAG}-${name}-${w}-${t}.png`), ...(c ? { clip: c } : {}) });
    }
  }
  await theme(page, 'light');
  await page.setViewportSize({ width: 1440, height: 900 });
  await sleep(250);
};
const req = (p: any, op: string, data: unknown) => p.evaluate(([o, d]: [string, unknown]) => (window as any).dex.request(o, d), [op, data]);
const lens = async (page: any, name: string) => { await page.locator('nav.lens-bar, .lens-dock').getByRole('button', { name: new RegExp(`^${name}`) }).first().click(); };
const control = async (page: any, section: string) => {
  await page.locator('.me-btn').click();
  await page.getByRole('menuitem', { name: /Control room/ }).click();
  await page.getByRole('group', { name: 'Admin section' }).getByRole('button', { name: new RegExp(`^${section}`) }).click();
};
const box = async (page: any, sel: string, pad = 12) => {
  const el = page.locator(sel).first();
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await sleep(150);
  const b = await el.boundingBox();
  const vp = page.viewportSize();
  if (!b || !vp) return undefined;
  const x = Math.max(0, b.x - pad), y = Math.max(0, b.y - pad);
  return { x, y, width: Math.min(vp.width - x, b.width + pad * 2), height: Math.min(vp.height - y, b.height + pad * 2) };
};

const { hub, owner } = await startOffice('fixes3');
const seeded = await seedOffice(hub, owner, OFFICE, ['vikram', 'bhavna', 'priya']);
const apps: any[] = [];
try {
  const b = await launch('bhavna', 'Bhavna Shah', { width: 1440, height: 900 });
  const p = await launch('priya', 'Priya Raman', { width: 1280, height: 800 });
  apps.push(b.app, p.app);
  const B = b.page, PR = p.page;
  const dir = (await owner.request('directory.list')).users;
  const id = (u: string) => dir.find((x: any) => x.account.endsWith(`\\${u}`) && x.role !== 'bot')?.id as string;
  seeded.ids.set('bhavna', id('bhavna')); seeded.ids.set('priya', id('priya'));
  await seeded.profiles();
  await owner.request('admin.setRole', { userId: id('bhavna'), role: 'admin' });
  await B.evaluate(() => (window as any).dex.setSettings({ timeFormat: '12' }));
  await B.reload(); await B.locator('.frame').waitFor();

  // ------------------------------------------------------------ 1. a meeting's thread in 12-hour times
  console.log('step 1: recap times follow the 12-hour setting');
  const space = await req(B, 'conv.create', { kind: 'space', name: 'Pump skid P-12', private: true, members: [id('priya')] });
  const m = await req(B, 'meet.create', { convId: space.id });
  const room = (await req(B, 'meet.join', { id: m.id })).room;
  await req(PR, 'meet.join', { id: m.id });
  await req(B, 'room.chat', { roomId: room.id, text: 'Nozzle loads first, then the GA comments' });
  if (NEW) {
    // what a late joiner missed is counted on the hub, whatever the app has loaded
    assert.equal((await req(PR, 'room.missed', { roomId: room.id, before: Date.now() + 1 })).messages, 1);
  }
  await req(B, 'room.end', { roomId: room.id });
  await lens(B, 'Spaces');
  await B.locator('.sb-row', { hasText: 'Pump skid P-12' }).first().click({ timeout: 15000 });
  const card = B.locator('.recap-card').last();
  await card.waitFor({ timeout: 20000 });
  await sleep(600);
  const when = (await card.locator('.rc-when').innerText()).trim();
  const divider = (await B.locator('.meet-divider').count()) ? (await B.locator('.meet-divider').last().innerText()).trim() : '';
  console.log('recap card:', when, '| divider:', divider.replace(/\s+/g, ' '));
  if (NEW) {
    assert.match(when, /\d{1,2}:\d{2}\s?(am|pm|AM|PM)/, 'the recap card reads 12-hour times');
    if (divider) assert.match(divider, /(am|pm|AM|PM)/, 'the divider reads 12-hour times');
  }
  await snap(B, '1-recap-card', [[1440, 900]], () => box(B, '.recap-card', 60));
  await card.getByRole('button', { name: 'Open the recap' }).click();
  const sheet = B.locator('.recap-sheet');
  await sheet.waitFor({ timeout: 15000 });
  await sleep(800);
  const tb = (await sheet.innerText());
  if (NEW) assert.match(tb, /\d{1,2}:\d{2}\s?(am|pm|AM|PM)/, 'the recap sheet reads 12-hour times');
  await snap(B, '1-recap-sheet', [[1440, 900], [390, 844]]);
  await B.keyboard.press('Escape');
  await sleep(300);

  // ------------------------------------------------------------ 2. the urgent banner takes its own row
  console.log('step 2: the urgent banner pushes the lens down');
  const desks = (await owner.request('admin.notices.get')).desks;
  const itDesk = desks.find((d: any) => d.code === 'IT');
  const hrDesk = desks.find((d: any) => d.code === 'HR');
  await req(B, 'notices.issue', { id: (await req(B, 'notices.save', { deskId: itDesk.id, category: 'it', title: 'Mail server down until 3 pm', body: 'Outlook cannot send or receive. Use Dexterity Connect for anything urgent.', audience: { everyone: true, departments: [], roles: [], locations: [], people: [] }, ackRequired: false, urgent: true })).id });
  await lens(B, 'Directory');
  await B.locator('.nb-banner').waitFor({ timeout: 10000 });
  await sleep(800);
  for (const [w, h] of [[1440, 900], [390, 844]] as Array<[number, number]>) {
    await B.setViewportSize({ width: w, height: h });
    await sleep(500);
    // scrolled down a little: nothing of the lens may slide under the banner
    await B.locator('.stage').evaluate((el: HTMLElement) => { el.scrollTop = 0; });
    const ban = await B.locator('.nb-banner').boundingBox();
    const stage = await B.locator('.stage').boundingBox();
    const head = await B.locator('.stage .view-head h1').first().boundingBox();
    console.log(`banner at ${w}:`, ban, 'stage:', stage, 'heading:', head);
    if (NEW) assert.ok(ban && stage && stage.y >= ban.y + ban.height - 1, `the lens starts below the banner at ${w} px`);
    if (NEW) assert.ok(ban && head && head.y >= ban.y + ban.height, `the Directory heading shows in full at ${w} px`);
  }
  await B.setViewportSize({ width: 1440, height: 900 });
  await snap(B, '2-banner-directory', [[1440, 900], [390, 844]]);

  // ------------------------------------------------------------ 3. the In force shelf with an ACKNOWLEDGE tag
  console.log('step 3: the In force shelf stays tidy');
  await B.locator('.nb-banner').getByRole('button', { name: 'Dismiss' }).click();
  await B.locator('.nb-banner').waitFor({ state: 'detached' });
  for (const t of ['Leave policy 2026', 'Travel and site allowance policy', 'CAD workstation use']) {
    await req(B, 'notices.issue', { id: (await req(B, 'notices.save', { deskId: hrDesk.id, category: 'policy', title: t, body: 'Read it and acknowledge it.', audience: { everyone: true, departments: [], roles: [], locations: [], people: [] }, ackRequired: t !== 'CAD workstation use', standing: true })).id });
  }
  await lens(B, 'Notices');
  await B.locator('.nb-shelf .nb-stack').first().waitFor({ timeout: 15000 });
  await sleep(800);
  // each part of a sheet's foot (REV A, the date, the tag) stays on one line
  const tidy = async () => B.evaluate(() => [...document.querySelectorAll('.nb-stack-top')].map((f) => [...f.querySelectorAll('.nb-stack-foot > span, .nb-stack-head > span')].every((k) => {
    const r = document.createRange(); r.selectNodeContents(k);
    const tops = new Set([...r.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top)));
    return tops.size <= 1;
  })));
  for (const lang of ['en', 'hi', 'ta']) {
    if (lang !== 'en') { await B.evaluate((c: string) => localStorage.setItem('dex.language', c), lang); await B.reload(); await B.locator('.frame').waitFor(); await B.locator('nav.lens-bar .lens').last().click(); await B.locator('.nb-shelf .nb-stack').first().waitFor({ timeout: 15000 }); await sleep(800); }
    for (const [w, h] of [[1440, 900], [390, 844]] as Array<[number, number]>) {
      await B.setViewportSize({ width: w, height: h });
      await sleep(400);
      const ok = await tidy();
      console.log(`shelf ${lang} ${w}:`, ok);
      if (NEW) assert.ok(ok.every(Boolean), `no part of a shelf sheet's foot wraps (${lang}, ${w} px)`);
    }
    await snap(B, `3-shelf-${lang}`, lang === 'en' ? [[1440, 900], [390, 844]] : [[1440, 900], [390, 844]], () => box(B, '.nb-shelf', 8));
  }
  await B.evaluate(() => localStorage.setItem('dex.language', 'en')); await B.reload(); await B.locator('.frame').waitFor();

  // ------------------------------------------------------------ 6. chips with a ×: beside the name
  console.log('step 6: issuer and management chips keep the × beside the name');
  await owner.request('admin.notices.setDesk', { id: hrDesk.id, code: hrDesk.code, name: hrDesk.name, issuers: [id('karthik'), id('lakshmi'), id('harini')] });
  await owner.request('admin.nib.set', { managers: [id('meera'), id('lakshmi')] });
  await control(B, 'Notice desks');
  await B.locator('.nb-admin .nib-giver').first().waitFor({ timeout: 10000 });
  await sleep(500);
  const chipOk = async (sel: string) => B.evaluate((s: string) => [...document.querySelectorAll(s)].map((c) => {
    const name = c.querySelector('.nib-giver-name')!.getBoundingClientRect();
    const x = c.querySelector('svg')!.getBoundingClientRect();
    return x.left >= name.right - 1 && Math.abs((x.top + x.bottom) / 2 - (name.top + name.bottom) / 2) < 10;
  }), sel);
  for (const [w, h] of [[1440, 900], [390, 844]] as Array<[number, number]>) {
    await B.setViewportSize({ width: w, height: h }); await sleep(400);
    const ok = await chipOk('.nb-admin .nib-giver.on');
    console.log(`issuer chips ${w}:`, ok);
    if (NEW) assert.ok(ok.length && ok.every(Boolean), `the × is beside the name (${w} px)`);
  }
  await B.setViewportSize({ width: 1440, height: 900 });
  await snap(B, '6-issuer-chips', [[1440, 900], [390, 844]], () => box(B, '.nb-admin .nb-desk:has(.nib-giver)', 6));
  await B.getByRole('group', { name: 'Admin section' }).getByRole('button', { name: /^Nib & day sheets/ }).click();
  await B.locator('.nib-admin .nib-giver.on').first().waitFor({ timeout: 10000 });
  await sleep(400);
  if (NEW) assert.ok((await chipOk('.nib-admin .nib-giver.on')).every(Boolean), 'Nib management chips too');
  await snap(B, '6-nib-chips', [[1440, 900]], () => box(B, '.nib-admin .nib-pick', 40));

  // ------------------------------------------------------------ 7. Control room ▸ Organisation ▸ Office managers
  console.log('step 7: office managers in the Control room');
  await B.getByRole('group', { name: 'Admin section' }).getByRole('button', { name: /^Organisation/ }).click();
  await B.locator('.org-admin').waitFor();
  await sleep(500);
  if (NEW) {
    const sec = B.locator('.org-managers');
    await sec.scrollIntoViewIfNeeded();
    await sec.getByRole('combobox', { name: 'Add an office manager' }).fill('Lak');
    await sec.getByRole('option', { name: /Lakshmi Venkatesh/ }).click();
    await B.getByText('Lakshmi Venkatesh is now an office manager').waitFor({ timeout: 10000 });
    await sec.getByRole('combobox', { name: 'Add an office manager' }).fill('Karthik');
    await sec.getByRole('combobox', { name: 'Add an office manager' }).press('Enter');
    await B.getByText('Karthik Subramanian is now an office manager').waitFor({ timeout: 10000 });
    assert.deepEqual([...(await owner.request('admin.seating.managers', {})).managers].sort(), [id('lakshmi'), id('karthik')].sort());
    await sec.getByRole('button', { name: 'Remove Karthik Subramanian from the office managers' }).click();
    await B.getByText('Karthik Subramanian is no longer an office manager').waitFor({ timeout: 10000 });
    assert.deepEqual((await owner.request('admin.seating.managers', {})).managers, [id('lakshmi')]);
    const audit = (await owner.request('admin.audit', { limit: 30 })).filter((a: any) => a.action === 'seating.managers');
    assert.equal(audit.length, 3, 'each change is audited');
    assert.deepEqual(audit[0].detail.removed, [id('karthik')]);
    await sleep(500);
    await snap(B, '7-office-managers', [[1440, 900], [390, 844]], async () => { await B.locator('.org-managers').scrollIntoViewIfNeeded(); return box(B, '.org-managers', 10); });
    await B.evaluate(() => localStorage.setItem('dex.language', 'hi')); await B.reload(); await B.locator('.frame').waitFor();
    await B.locator('.me-btn').click();
    await B.getByRole('menuitem', { name: new RegExp(HI['Control room'] ?? 'Control room') }).click();
    await B.getByRole('group').first().getByRole('button', { name: new RegExp(`^${HI['Organisation'] ?? 'Organisation'}`) }).click().catch(() => {});
    await B.locator('.org-managers').waitFor({ timeout: 10000 }).catch(() => {});
    await sleep(600);
    if (await B.locator('.org-managers').count()) await B.screenshot({ path: path.join(OUT, `${TAG}-7-office-managers-hi.png`), clip: await (async () => { await B.locator('.org-managers').scrollIntoViewIfNeeded(); return box(B, '.org-managers', 10); })() });
    await B.evaluate(() => localStorage.setItem('dex.language', 'en')); await B.reload(); await B.locator('.frame').waitFor();
    // the audit log reads it
    await control(B, 'Audit log');
    await B.getByText('changed the office managers').first().waitFor({ timeout: 10000 });
  } else {
    await snap(B, '7-organisation', [[1440, 900]]);
  }
  await B.keyboard.press('Escape');

  // ------------------------------------------------------------ 8. a hot desk booked ahead
  console.log('step 8: a hot desk booked for a working day ahead');
  const d0 = await owner.request('seating.draft', { title: 'Hot desks', moves: [{ seatId: 'W-C42', to: { kind: 'hot' } }, { seatId: 'W-C41', to: { kind: 'hot' } }] });
  await owner.request('seating.apply', { id: d0.id });
  await B.reload(); await B.locator('.frame').waitFor();
  await lens(B, 'Directory');
  await B.getByRole('tab', { name: 'Org chart', exact: true }).click();
  await B.locator('.os-stage').waitFor();
  await B.getByRole('button', { name: 'Floor', exact: true }).click();
  await sleep(2600);
  if (await B.locator('.seat-notice').count()) await B.locator('.seat-notice').getByRole('button', { name: 'Got it' }).click().catch(() => {});
  const openSeat = async (seat: string) => {
    await B.locator('.os-find-input').fill(seat);
    await B.locator('.os-results li', { hasText: `Seat ${seat}` }).click();
    await B.locator('.seat-callout', { hasText: seat }).waitFor();
    await sleep(900);
  };
  await openSeat('W-C42');
  if (NEW) {
    const days = (await owner.request('seating.get')).bookDays as string[];
    assert.ok(days.length > 5, 'working days to choose from');
    // Priya has it on the third working day ahead; Bhavna books the last one
    await req(PR, 'seating.book', { seatId: 'W-C42', day: days[3] });
    await B.locator('.seat-bookings', { hasText: 'Priya Raman' }).waitFor({ timeout: 10000 });
    await B.locator('#seat-book-day').selectOption(days[days.length - 1]);
    const btn = B.locator('.seat-callout').getByRole('button', { name: /^Book for / });
    assert.doesNotMatch(await btn.innerText(), /today/);
    await btn.click();
    await B.locator('.seat-bookings li', { hasText: 'You' }).waitFor({ timeout: 10000 });
    const mine = (await owner.request('seating.get')).bookings.filter((x: any) => x.userId === id('bhavna'));
    assert.deepEqual(mine.map((x: any) => x.day), [days[days.length - 1]]);
    await B.locator('#seat-book-day').selectOption(days[3]);
    assert.equal(await B.locator('.seat-callout').getByRole('button', { name: /^Book for / }).count(), 0, 'no booking a day someone has it');
    await B.locator('#seat-book-day').selectOption(days[days.length - 1]);
    await B.locator('.seat-callout').getByRole('button', { name: 'Cancel my booking' }).waitFor();
    await B.locator('#seat-book-day').selectOption(days[0]);
  }
  await snap(B, '8-hot-desk', [[1440, 900], [390, 844]], async () => { await sleep(200); return box(B, '.seat-callout', 10); });

  console.log(`FIXES3 (${TAG}) E2E PASSED`);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
  for (const [i, a] of apps.entries()) { try { const pg = await a.firstWindow(); await pg.screenshot({ path: path.join(OUT, `${TAG}-FAIL-${i}.png`) }); } catch { /* closed */ } }
} finally {
  for (const a of apps) await a.close().catch(() => {});
  await hub.stop?.();
  process.exit(process.exitCode ?? 0);
}
