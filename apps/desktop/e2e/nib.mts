// Nib end to end (docs/NIB.md): an administrator sets up givers and the management in the Control
// room; Karthik starts his day and picks who gave him work, captures work in plain words, from an
// offer under his lead's message and with slash commands, reports numbers and words, and sends the
// wrap-up when Nib asks; Priya (his lead) gets one live card; three people are on leave through the
// leave note; Kiran never reports; Deepa is in a meeting through the wrap-up (no asks) and reports
// late; the management's register comes once, and exactly one follow-up with the late sheet and
// the missing person's ask count. Nib's clock is the in-process hub's (hub.nib.setClock): nothing a
// client can reach. Screenshots at 1440 and 390 px, light and dark, and one in Hindi.
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { startOffice, launch, sleep, OUT as BASE_OUT } from './harness.mts';
import { OFFICE, bigOffice, seedOffice, bringOnline } from './officeseed.mts';

const OUT = process.env.NIB_OUT ?? BASE_OUT;
fs.mkdirSync(OUT, { recursive: true });
const snap = (page: any, name: string) => page.screenshot({ path: path.join(OUT, `nib-${name}.png`) });
const pair = async (page: any, name: string) => {
  for (const t of ['light', 'dark']) {
    await page.evaluate((x: string) => { document.documentElement.dataset.theme = x; }, t);
    await sleep(250);
    await snap(page, `${name}-${t}`);
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
};

const { hub, owner } = await startOffice('nib');
const localToday = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
const at = (h: number, m = 0) => { const [y, mo, d] = localToday.split('-').map(Number); return new Date(y, mo - 1, d, h, m).getTime(); };
const clock = (h: number, m = 0) => { const t = at(h, m); hub.nib.setClock(t); hub.nib.tick(t); return t; };

const seeded = await seedOffice(hub, owner, OFFICE, ['vikram', 'karthik', 'priya', 'bhavna']);
// the walk below is timed to the 25-minute steps before a 19:00 register (a new hub's defaults, register 18:30 and
// follow-up 19:00, fit the three asks closer together: nibasks.mts); the follow-up at 21:00 as the walk expects
await owner.request('admin.nib.set' as never, { digestAt: '19:00', followUpAt: '21:00' } as never);
const apps: any[] = [];
let K: any, P: any, B: any;
const extraClients: any[] = [];
try {
  // ---------------------------------------------------------------- three people in the app
  const k = await launch('karthik', 'Karthik Subramanian', { width: 1440, height: 900 });
  const p = await launch('priya', 'Priya Raman', { width: 1440, height: 900 });
  const b = await launch('bhavna', 'Bhavna Shah', { width: 1440, height: 900 });
  apps.push(k.app, p.app, b.app);
  K = k.page; P = p.page; B = b.page;
  const dir = (await owner.request('directory.list')).users;
  const id = (u: string) => dir.find((x: any) => x.account.endsWith(`\\${u}`) && x.role !== "bot")?.id as string;
  await seeded.profiles({ karthik: id('karthik'), priya: id('priya'), bhavna: id('bhavna') });
  const ids = { ...Object.fromEntries(OFFICE.map((o) => [o.u, seeded.ids.get(o.u)])), karthik: id('karthik'), priya: id('priya'), bhavna: id('bhavna'), vikram: owner.session.me.id } as Record<string, string>;
  // Bhavna, the office administrator, runs the Control room
  await owner.request('admin.setRole', { userId: ids.bhavna, role: 'admin' });
  // Kiran never reports; Deepa reports late; both are online
  const [kiran, deepa] = await bringOnline(hub.port, hub.fingerprint, [{ u: 'kiran', name: 'Kiran Desai', mode: 'office' }, { u: 'deepa', name: 'Deepa Krishnan', mode: 'office' }]);
  extraClients.push(kiran, deepa);
  for (const c of [kiran, deepa]) await c.request('nib.me');

  // ---------------------------------------------------------------- 1. the administrator sets Nib up
  clock(9, 0);
  await B.reload(); await B.locator('.frame').waitFor();
  await B.locator('.me-btn').click();
  await B.getByRole('menuitem', { name: /Control room/ }).click();
  await B.getByRole('button', { name: /Nib & day sheets/ }).click();
  await B.locator('.nib-admin').waitFor();
  // discipline leads: the department heads, in one go; Priya as the area lead for P-12 area 4
  await B.getByRole('button', { name: /Add the \d+ department heads/ }).click();
  const area = B.getByRole('combobox', { name: 'Add one of the area leads' });
  await area.fill('Priya'); await area.press('Enter');
  await B.getByRole('textbox', { name: 'Scope for Priya Raman' }).first().fill('Area 4');
  const team = B.getByRole('combobox', { name: 'Add one of the team leads' });
  await team.fill('Manoj'); await team.press('Enter');
  for (const n of ['Vikram', 'Arjun', 'Bhavna']) { const f = B.getByRole('combobox', { name: 'Add someone to the management' }); await f.fill(n); await f.press('Enter'); }
  await B.getByRole('textbox', { name: 'Job codes' }).fill('P-12 Refinery revamp, Jamnagar\nP-14 Tank farm, Dahej\nJ-0412 Pump house upgrade');
  // every day a workday, so the walk does not depend on the day it runs
  for (const d of ['Sun']) { const btn = B.locator('.nib-admin .seg[aria-label="Workdays"] button', { hasText: d }); if ((await btn.getAttribute('aria-pressed')) !== 'true') await btn.click(); }
  await sleep(300);
  await B.locator('.nib-admin-intro').scrollIntoViewIfNeeded();
  await pair(B, '01-control-room');
  await B.locator('.nib-admin-actions').scrollIntoViewIfNeeded();
  await snap(B, '01-control-room-times-light');
  await B.getByRole('button', { name: 'Save', exact: true }).click();
  await B.getByText('Saved. Nib uses it from now.').waitFor();
  const cfg = await owner.request('admin.nib.get');
  assert.ok(cfg.givers.some((g: any) => g.userId === ids.priya && g.kind === 'area' && g.scope === 'Area 4'));
  assert.ok(cfg.givers.some((g: any) => g.userId === ids.anand && g.kind === 'discipline'), 'department heads added');
  assert.deepEqual([...cfg.managers].sort(), [ids.vikram, ids.arjun, ids.bhavna].sort());
  assert.equal(cfg.projects.length, 3);
  assert.ok((await owner.request('admin.audit', { limit: 50 })).some((a: any) => a.action === 'nib.config'), 'audited');
  await B.keyboard.press('Escape');

  // ---------------------------------------------------------------- 2. Karthik starts his day: who gave you work?
  await K.reload(); await K.locator('.frame').waitFor();
  await K.locator('.nib-btn').waitFor();
  clock(9, 40);
  await K.locator('.me-btn').click();
  await K.locator('.day-menu').waitFor();
  await K.getByRole('menuitem', { name: /Start my day/ }).click();
  await K.locator('.nib-callout').waitFor({ timeout: 10000 });
  await sleep(300);
  await pair(K, '02-start-callout');
  await K.locator('.nib-callout .nib-giver', { hasText: 'Priya' }).click();
  await K.locator('.nib-callout .nib-giver', { hasText: 'Manoj' }).click();
  await K.locator('.nib-callout').getByRole('button', { name: 'Log these' }).click();
  await K.getByText('Noted. Tell me as more comes in.').waitFor();
  let km = await K.evaluate(() => window.dex.request('nib.me'));
  assert.deepEqual([...km.day.givers].sort(), [ids.priya, ids.manoj].sort());

  // ---------------------------------------------------------------- 3. capture in plain words, read on the PC as you type
  await K.locator('.nib-btn').click();
  await K.locator('.nib-tray').waitFor();
  await K.locator('.nib-input').fill('got 12 isos from Priya for P-12 area 4 by Friday');
  await K.locator('.nib-ann.giver').waitFor();
  assert.equal(await K.locator('.nib-ann').count(), 4, 'giver, job, quantity and due marked');
  await sleep(200);
  await pair(K, '03-tray-annotations');
  await K.locator('.nib-input').press('Enter');
  await K.getByText(/Noted for Priya: /).waitFor();
  await K.locator('.nib-input').fill('Anand: support check for P-14, half day');
  await K.locator('.nib-input').press('Enter');
  await K.getByText(/Noted for Anand: /).waitFor();
  km = await K.evaluate(() => window.dex.request('nib.me'));
  const iso = km.items.find((x: any) => x.project === 'P-12');
  assert.deepEqual(iso.qty, { done: 0, total: 12, unit: 'isos' });
  assert.equal(iso.giverId, ids.priya);
  assert.ok(km.items.some((x: any) => x.giverId === ids.anand && x.qty?.unit === 'hours'));
  await K.keyboard.press('Escape');

  // ---------------------------------------------------------------- 4. an offer under a lead's message, in place
  const dm = await P.evaluate((to: string) => window.dex.request('conv.create', { kind: 'direct', members: [to] }), ids.karthik);
  await P.evaluate((c: string) => window.dex.request('msg.send', { convId: c, body: 'Karthik, please check the MTO for J-0412 by tomorrow. 40 lines.', clientId: 'nib-offer-1' }), dm.id);
  await K.getByRole('button', { name: /^Direct/ }).first().click();
  await K.locator('.sb-nib').waitFor();
  await K.locator('.sb-row', { hasText: 'Priya Raman' }).first().click();
  await K.locator('.nib-offer-add').waitFor({ timeout: 15000 });
  await sleep(300);
  await pair(K, '04-offer');
  await K.locator('.nib-offer-add').click();
  await K.locator('.nib-offer.done').waitFor();
  km = await K.evaluate(() => window.dex.request('nib.me'));
  const mto = km.items.find((x: any) => x.source === 'offer');
  assert.equal(mto.giverId, ids.priya);
  assert.equal(mto.project, 'J-0412');
  assert.match(mto.activity, /^Check (?:the )?MTO/, 'the greeting to Karthik is not part of the work');
  assert.equal(mto.qty.total, 40);

  // ---------------------------------------------------------------- 5. slash commands, anywhere
  const dock = K.locator('.dock textarea').first();
  // two commands typed back to back: the second must survive the first finishing (it once wiped the Dock)
  await dock.fill('/got 6 GAs from Anand for P-14');
  await dock.press('Enter');
  await dock.fill('/done 9 of 12 isos P-12');
  await dock.press('Enter');
  await K.getByText(/Noted for Anand: GAs/).waitFor();
  const seenToasts = new Set<string>();
  for (let i = 0; i < 60; i++) {
    for (const t of await K.locator('.toast').allInnerTexts()) seenToasts.add(t);
    km = await K.evaluate(() => window.dex.request('nib.me'));
    if (km.items.find((x: any) => x.id === iso.id)?.qty?.done === 9) break;
    await sleep(250);
  }
  if (km.items.find((x: any) => x.id === iso.id)?.qty?.done !== 9) console.log('DEBUG /done', [...seenToasts], JSON.stringify(km.items.map((x: any) => [x.activity, x.project, x.qty, x.status, x.source])), await K.locator('.nib-tray').count());
  assert.deepEqual(km.items.find((x: any) => x.id === iso.id).qty, { done: 9, total: 12, unit: 'isos' }, 'progress updates the item, not a new line');
  assert.ok(km.items.some((x: any) => x.source === 'slash' && x.qty?.unit === 'GAs'));
  const msgs = await K.evaluate((c: string) => window.dex.request('msg.list', { convId: c }), dm.id);
  assert.ok(!msgs.messages.some((m: any) => m.body.startsWith('/')), 'slash commands post nothing');
  // and in the conversation with Nib, as you would write to anyone
  await K.locator('.sb-nib').click();
  await K.locator('.dock textarea').first().fill('nozzle orientation for Anand, 3 drawings done');
  await K.locator('.dock textarea').first().press('Enter');
  await K.locator('.nib-card.k-reply').first().waitFor({ timeout: 15000 });
  await sleep(400);
  await pair(K, '05-nib-conversation');

  // ---------------------------------------------------------------- 6. words for progress, in the tray
  await K.locator('.nib-btn').click();
  await K.locator('.nib-item-row', { hasText: 'Isometrics' }).click();
  await K.getByRole('textbox', { name: 'In words' }).fill('Area 4 routing nearly done, waiting for vendor data on the pump nozzles');
  await K.locator('.nib-edit').getByRole('button', { name: 'Save' }).click();
  await K.getByText('Saved').first().waitFor();
  await sleep(200);
  await pair(K, '06-tray-sheet');
  await K.setViewportSize({ width: 390, height: 844 });
  await sleep(400);
  await pair(K, '06-tray-sheet-phone');
  await K.setViewportSize({ width: 1440, height: 900 });
  await K.keyboard.press('Escape');

  // ---------------------------------------------------------------- the rest of the office, through the hub as they would through their apps
  const users = (u: string) => hub.store.userById(ids[u]);
  // three on leave through the leave note (one half day), never nagged, one grouped line
  for (const [u, kind, cover] of [['ravi', 'annual', 'lakshmi'], ['sneha', 'sick', 'vivek'], ['gopal', 'half', 'harini']] as const) {
    hub.nib.handle('nib.leave', users(u), { kind, from: localToday, to: localToday, half: kind === 'half' ? 'pm' : null, coverId: ids[cover], leadIds: [ids.priya], reminders: 'move', handover: 'Spool drawings 4–9 left on P-12; vendor data due Friday.' });
  }
  const PROJ = ['P-12', 'P-14', 'J-0412'];
  const UNITS = ['isos', 'sheets', 'drawings', 'GAs', 'MTOs', 'supports'];
  const GIVE = ['priya', 'anand', 'anita', 'suresh', 'ramesh', 'lalitha', 'manoj'];
  const others = OFFICE.filter((o) => !['vikram', 'arjun', 'bhavna', 'karthik', 'priya', 'kiran', 'deepa', 'ravi', 'sneha', 'gopal'].includes(o.u));
  let n = 0;
  for (const o of others) {
    const u = users(o.u);
    if (!u) continue;
    // most of the office sends before the wrap-up time (Nib asks Kiran, online, at the start of the day meanwhile)
    clock(17, n % 50);
    const g = GIVE[n % GIVE.length] === o.u ? GIVE[(n + 1) % GIVE.length] : GIVE[n % GIVE.length];
    try { hub.work.handle('work.checkIn', u, { mode: n % 6 === 0 ? 'site' : n % 7 === 0 ? 'home' : 'office' }); } catch { /* already in */ }
    if (n === 7) { hub.nib.handle('nib.day', u, { nothing: true }); n++; continue; }
    hub.nib.handle('nib.start', u, { givers: [ids[g]] });
    const total = 6 + (n * 7) % 30;
    hub.nib.handle('nib.item.save', u, { giverId: ids[g], project: PROJ[n % 3], activity: ['Routing', 'Model review', 'Checking', 'Detailing', 'MTO take-off', 'Mark-ups'][n % 6], qty: { done: Math.round(total * ((n * 37) % 100) / 100), total, unit: UNITS[n % 6] } });
    if (n % 4 === 1) hub.nib.handle('nib.item.save', u, { giverId: ids[GIVE[(n + 2) % GIVE.length]], project: PROJ[(n + 1) % 3], activity: 'Clash review', note: 'Waiting for the vendor’s nozzle loads', status: 'blocked' });
    if (n % 5 === 2) hub.nib.handle('nib.item.save', u, { giverId: ids[g], activity: 'Site queries answered', note: 'Three RFIs closed with the client' });
    hub.nib.handle('nib.wrap', u, n % 6 === 3 ? { blockers: 'Waiting for the civil foundation drawing' } : {});
    n++;
  }

  // ---------------------------------------------------------------- 7. the wrap-up: Nib asks gently, never in a meeting
  const meet = await deepa.request('cal.create', { title: 'Model review', startAt: Date.now() - 5 * 60_000, endAt: Date.now() + 55 * 60_000, attendees: [] });
  (hub as any).presenceTick();
  await deepa.request('nib.start', { givers: [ids.priya] });
  clock(18, 0);
  await sleep(300);
  await K.locator('.nib-tile.ink-quiet').first().waitFor({ timeout: 8000 });
  clock(18, 26);
  await K.locator('.nib-callout').waitFor({ timeout: 8000 });
  await sleep(300);
  await pair(K, '07-wrap-callout');
  clock(18, 46);
  const deepaMe = await deepa.request('nib.me');
  assert.equal(deepaMe.day.asks.filter((a: any) => a.kind === 'wrap').length, 0, 'not asked while in a meeting');
  const kiranMe = await kiran.request('nib.me');
  assert.equal(kiranMe.day.asks.filter((a: any) => a.kind === 'wrap').length, 3, 'Kiran asked three times');
  await deepa.request('cal.cancel', { eventId: meet.id });
  (hub as any).presenceTick();
  clock(18, 52);
  assert.equal((await deepa.request('nib.me')).day.asks.filter((a: any) => a.kind === 'wrap').length, 1, 'asked once the meeting ended');
  // Karthik checks and sends
  await K.locator('.nib-callout').getByRole('button', { name: 'Check and send' }).click();
  await K.locator('.nib-wrapup').waitFor();
  await sleep(300);
  await pair(K, '08-wrap-up');
  await K.getByRole('textbox', { name: 'Blockers' }).fill('Vendor data for the pump nozzles');
  await K.locator('.nib-wrapup .btn.primary', { hasText: /^Send to / }).click();
  await K.getByText(/^Sent to /).waitFor();
  km = await K.evaluate(() => window.dex.request('nib.me'));
  assert.equal(km.day.state, 'sent');

  // ---------------------------------------------------------------- 8. Priya: one live card for everyone who sent work from her
  await P.getByRole('button', { name: /^Direct/ }).first().click();
  await P.locator('.sb-nib').click();
  await P.locator('.nib-card.k-lead').waitFor({ timeout: 15000 });
  await sleep(500);
  const leadCards = (await P.evaluate((c: string) => window.dex.request('msg.list', { convId: c }), (await P.evaluate(() => window.dex.request('nib.me'))).convId)).messages.filter((m: any) => m.nib?.kind === 'lead');
  assert.equal(leadCards.length, 1, 'one card a day');
  await P.locator('.nib-card.k-lead .nib-row', { hasText: 'Karthik' }).getByRole('button', { name: 'Seen' }).click();
  await P.locator('.nib-card.k-lead .nib-row', { hasText: 'Karthik' }).locator('.nib-seen').waitFor();
  await P.locator('.nib-card.k-lead').first().evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'start' }));
  await sleep(300);
  await pair(P, '09-lead-card');
  assert.ok((await K.evaluate(() => window.dex.request('nib.me'))).seen[ids.priya], 'Karthik sees that Priya saw it');

  // ---------------------------------------------------------------- 9. the register: once, to the management
  clock(19, 0);
  clock(19, 5);
  await B.getByRole('button', { name: /^Direct/ }).first().click();
  await B.locator('.sb-nib').click();
  await B.locator('.nib-card.k-register').waitFor({ timeout: 15000 });
  const bConv = (await B.evaluate(() => window.dex.request('nib.me'))).convId;
  const regs = (await B.evaluate((c: string) => window.dex.request('msg.list', { convId: c }), bConv)).messages.filter((m: any) => m.nib?.kind === 'register');
  assert.equal(regs.length, 1, 'the register arrives once');
  const reg = await B.evaluate((d: string) => window.dex.request('nib.card', { kind: 'register', ref: d }), localToday);
  assert.equal(reg.register.leave.length, 3, 'three on leave, one grouped line');
  assert.ok(reg.register.missing.some((m: any) => m.userId === ids.kiran && m.asks >= 3), 'Kiran missing, with the asks');
  assert.ok(!(await owner.request('msg.list', { convId: (await owner.request('nib.me')).convId })).messages.some((m: any) => m.nib?.kind === 'leave'), 'no individual leave messages to the management');
  await B.locator('.nib-card.k-register').first().evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'start' }));
  await sleep(500);
  await pair(B, '10-register');
  await B.locator('.nib-card.k-register .nib-cell.s-blocked').first().click();
  await B.locator('.nib-person-panel').waitFor();
  await B.locator('.nib-person-panel .nib-lines li').first().waitFor();
  await B.locator('.nib-person-panel').evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'center' }));
  await sleep(300);
  await pair(B, '11-register-person');
  // Write on a person's row opens the conversation with them (it used to fail silently)
  const who = (await B.locator('.nib-person-panel .nib-row-name').innerText()).trim();
  await B.locator('.nib-person-panel').getByRole('button', { name: 'Write', exact: true }).click();
  await B.locator(`[placeholder^="Write to ${who.split(' ')[0]}"], [data-placeholder^="Write to ${who.split(' ')[0]}"], [aria-placeholder^="Write to ${who.split(' ')[0]}"]`).first().waitFor({ timeout: 10000 });
  assert.equal(await B.locator('.toast.bad, .toast.error').count(), 0, 'no error from Write');
  await B.evaluate((c: string) => window.dispatchEvent(new CustomEvent('dex-deeplink', { detail: `dexconnect://conversation/${c}` })), bConv);
  await B.locator('.nib-card.k-register').first().waitFor({ timeout: 10000 });
  await B.locator('.nib-card.k-register .nib-cell.s-blocked').first().click();
  await B.locator('.nib-person-panel').waitFor();
  await B.locator('.nib-card.k-register [role="tab"]', { hasText: 'Call-outs' }).click();
  await sleep(200);
  await snap(B, '12-register-callouts-light');
  await B.locator('.nib-card.k-register [role="tab"]', { hasText: 'Leave and missing' }).click();
  await sleep(200);
  await snap(B, '12-register-missing-light');
  await B.setViewportSize({ width: 390, height: 844 });
  await sleep(500);
  await B.locator('.nib-card.k-register').first().evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'start' }));
  await sleep(300);
  await pair(B, '13-register-phone');
  await B.setViewportSize({ width: 1440, height: 900 });

  // ---------------------------------------------------------------- 10. a late sheet: Priya's card fills in place; exactly one follow-up
  clock(20, 15);
  await deepa.request('nib.item.save', { giverId: ids.priya, project: 'P-12', activity: 'Stress check, line 6"-P-1001', qty: { done: 60, total: 100, unit: '%' } });
  await deepa.request('nib.wrap', {});
  await P.locator('.nib-card.k-lead .nib-row.late', { hasText: 'Deepa' }).waitFor({ timeout: 15000 });
  clock(20, 59);
  clock(21, 0);
  clock(21, 30);
  await B.locator('.nib-card.k-followup').waitFor({ timeout: 15000 });
  const fus = (await B.evaluate((c: string) => window.dex.request('msg.list', { convId: c }), bConv)).messages.filter((m: any) => m.nib?.kind === 'followup');
  assert.equal(fus.length, 1, 'exactly one follow-up');
  const fu = await B.evaluate((d: string) => window.dex.request('nib.card', { kind: 'followup', ref: d }), localToday);
  assert.deepEqual(fu.register.late.map((x: any) => x.userId), [ids.deepa]);
  const kiranRow = fu.register.missing.find((m: any) => m.userId === ids.kiran);
  assert.ok(kiranRow && kiranRow.asks === 4, `Kiran: asked ${kiranRow?.asks} times (the start card and three wrap-up asks)`);
  await B.locator('.nib-card.k-followup').evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'start' }));
  await sleep(400);
  await pair(B, '14-followup');
  if (await B.locator('.nib-card.k-week').count()) { await B.locator('.nib-card.k-week').evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'start' })); await sleep(200); await pair(B, '15-week'); }

  // ---------------------------------------------------------------- 11. Karthik notes leave for tomorrow in one short sheet
  clock(21, 40);
  await K.locator('.dock textarea').first().fill('/leave tomorrow');
  await K.locator('.dock textarea').first().press('Enter');
  await K.locator('.nib-leave').waitFor();
  await K.locator('.nib-leave .seg[aria-label="When"] button', { hasText: 'Tomorrow' }).click();
  const coverBox = K.getByRole('combobox', { name: 'Who covers your work' });
  await coverBox.fill('Lakshmi'); await coverBox.press('Enter');
  await K.getByRole('textbox', { name: 'Handover note' }).fill('P-12 area 4 isos: 3 left, routed to the vendor nozzle loads. MTO for J-0412 half done.');
  await sleep(300);
  await pair(K, '16-leave-note');
  await K.locator('.nib-leave').getByRole('button', { name: 'Do it' }).click();
  await K.getByText('Done. Enjoy the time off. I’ll keep your desk.').waitFor();
  await pair(K, '17-leave-done');
  const kLeave = hub.nib['leaveRows'](ids.karthik);
  assert.equal(kLeave.length, 1);
  const coverPosts = hub.store.db.prepare(`SELECT COUNT(*) AS n FROM nib_posts WHERE kind = 'cover' AND user_id = ? AND ref = ?`).get(ids.lakshmi, kLeave[0].id) as { n: number };
  assert.equal(coverPosts.n, 1, 'the cover has the handover');
  assert.ok(hub.store.db.prepare(`SELECT 1 FROM nib_posts WHERE kind = 'leave' AND user_id = ? AND ref = ?`).get(ids.priya, kLeave[0].id), 'Priya, his lead, is told');
  await K.keyboard.press('Escape');

  // ---------------------------------------------------------------- 12. a Hindi look at the tray
  await K.evaluate(() => { localStorage.setItem('dex.language', 'hi'); });
  await K.reload(); await K.locator('.frame').waitFor();
  await K.locator('.nib-btn').waitFor();
  await K.locator('.nib-btn').click();
  await K.locator('.nib-tray').waitFor();
  await sleep(500);
  await snap(K, '18-tray-hindi-light');
  await K.evaluate(() => { localStorage.setItem('dex.language', 'en'); });

  // ---------------------------------------------------------------- 13. the register for 200 people draws at once
  const big = bigOffice(200).filter((x) => !OFFICE.some((o) => o.u === x.u));
  const bigIds = new Map<string, string>();
  for (const x of big) {
    const u = hub.store.createUser(`dex\\${x.u}`, x.name, 'member');
    hub.store.createDevice(`dev-${x.u}-${Date.now()}`, u.id, 'AAAA', `${x.u.toUpperCase()}-PC`, 'approved');
    bigIds.set(x.u, u.id);
    await owner.request('admin.org.setProfile', { userId: u.id, title: x.title, departmentId: seeded.depts.get(x.dept) ?? null });
  }
  clock(18, 30);
  let i = 0;
  for (const x of big) {
    const u = hub.store.userById(bigIds.get(x.u)!);
    if (!u || i % 9 === 4) { i++; continue; }
    try { if (i % 7) hub.work.handle('work.checkIn', u, { mode: 'office' }); } catch { /* already in */ }
    hub.nib.handle('nib.item.save', u, { giverId: ids.priya, project: PROJ[i % 3], activity: 'Routing', qty: { done: i % 11, total: 10 + (i % 5), unit: UNITS[i % 6] }, ...(i % 13 === 0 ? { status: 'blocked', note: 'Vendor data' } : {}) });
    hub.nib.handle('nib.wrap', u, {});
    i++;
  }
  clock(21, 45);
  const t0 = Date.now();
  await B.evaluate(() => window.dex.request('admin.nib.preview'));
  await B.locator('.nib-card.k-register').last().locator('.nib-grid.big').waitFor({ timeout: 15000 });
  const cells = await B.locator('.nib-card.k-register').last().locator('.nib-cell:not(.mini)').count();
  const ms = Date.now() - t0;
  const paint = await B.evaluate(async () => {
    const el = [...document.querySelectorAll('.nib-card.k-register')].pop() as HTMLElement;
    const t = performance.now();
    el.querySelector<HTMLButtonElement>('[role="tab"]:nth-child(2)')?.click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    el.querySelector<HTMLButtonElement>('[role="tab"]:nth-child(1)')?.click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return performance.now() - t;
  });
  console.log(`register for ${cells} people: on screen ${ms} ms after the hub was asked (posting, fetching, drawing); a redraw takes ${paint.toFixed(1)} ms`);
  assert.ok(cells >= 190, `${cells} cells`);
  assert.ok(ms < 3000);
  await B.locator('.nib-card.k-register').last().evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'start' }));
  await sleep(400);
  await pair(B, '19-register-200');

  console.log('NIB E2E PASSED');
} catch (e) {
  for (const [pg, n] of [[K, 'karthik'], [P, 'priya'], [B, 'bhavna']] as const) if (pg) await snap(pg, `FAIL-${n}`).catch(() => {});
  throw e;
} finally {
  hub.nib.setClock(null);
  for (const a of apps) await a.close().catch(() => {});
  for (const c of extraClients) c.disconnect();
  owner.disconnect();
  await hub.stop();
}
