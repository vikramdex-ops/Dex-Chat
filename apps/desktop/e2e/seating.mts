// Seating on the real floor plan, end to end (docs/SEATING.md). The hub starts with the office's
// drawing (153 seats); the owner names Bhavna office manager and seats most of the office. Bhavna
// drags three people from the list onto seats (Priya among them), swaps two people on the plan,
// moves the Structural team into the north-east benches with a preview, sets the move plan for
// next Monday and applies it; the hub's clock (hub.seating.setClock, in this process) reaches
// Monday and the moves take effect. Priya sees her notice and walks to her new seat. Revisions D
// and E are compared (clouds round the seats that changed); a bench of 4 is added in the layout
// editor and saved; a small CSV is imported and matched. The plan is filled to 150 seats and its
// frame times measured. Screenshots at 1440 and 390 px, light and dark, and in Hindi, in
// SEATING_OUT (default e2e/out), with the drawing beside our rendering when SEATING_DRAWING points
// at a render of the office's drawing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startOffice, launch, sleep, OUT as BASE_OUT } from './harness.mts';
import { OFFICE, seedOffice, bringOnline, bigOffice } from './officeseed.mts';

const OUT = process.env.SEATING_OUT ?? BASE_OUT;
fs.mkdirSync(OUT, { recursive: true });
const snap = (page: any, name: string) => page.screenshot({ path: path.join(OUT, `seating-${name}.png`) });
const theme = (page: any, t: string) => page.evaluate((x: string) => { document.documentElement.dataset.theme = x; }, t);
const pair = async (page: any, name: string) => {
  for (const t of ['light', 'dark']) { await theme(page, t); await sleep(300); await snap(page, `${name}-${t}`); }
  await theme(page, 'light');
};
const ymd = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const nextMonday = () => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return ymd(d.getTime()); };
const P = (userId: string) => ({ kind: 'person' as const, userId });
/** Nib's start-of-day card can open over the bar after a reload; it is not what this walk is about. */
const quietNib = async (page: any) => { await page.locator('.nib-callout').getByRole('button', { name: 'Not now' }).click({ timeout: 1500 }).catch(() => {}); };

const { hub, owner } = await startOffice('seating');
const s = await seedOffice(hub, owner, OFFICE, ['vikram', 'bhavna', 'priya']);
const apps: any[] = [];
let clients: any[] = [];
try {
  const b = await launch('bhavna', 'Bhavna Shah', { width: 1440, height: 900 });
  const p = await launch('priya', 'Priya Raman', { width: 1440, height: 900 });
  apps.push(b.app, p.app);
  const B = b.page, PR = p.page;
  const users = (await owner.request('directory.list')).users;
  const idOf = (acct: string) => users.find((u: any) => u.account.endsWith(`\\${acct}`))?.id;
  s.ids.set('bhavna', idOf('bhavna')); s.ids.set('priya', idOf('priya'));
  await s.profiles();
  const id = (u: string) => s.ids.get(u)!;

  // the owner names Bhavna office manager, and seats most of the office as it is today
  await owner.request('admin.seating.managers', { userIds: [id('bhavna')] });
  const start: Array<[string, string]> = [
    ['W-A01', 'lalitha'], ['W-A02', 'manoj'], ['W-A03', 'asha'], ['W-A04', 'prakash'], ['W-A05', 'selvi'], ['W-A06', 'kiran'],
    ['W-A11', 'ravi'], ['W-A12', 'lakshmi'], ['W-A13', 'imran'],
    ['W-C07', 'anand'], ['W-C08', 'sneha'], ['W-C09', 'vivek'], ['W-C10', 'pooja'], ['W-C11', 'farhan'],
    ['W-A21', 'anita'], ['W-A22', 'sanjay'], ['W-A23', 'kavya'],
    ['POD1-1', 'suresh'], ['POD1-2', 'nikhil'], ['POD1-3', 'divya'],
    ['HC-07', 'ramesh'], ['POD2-1', 'harini'], ['POD2-2', 'gopal'],
    ['W-B01', 'rohan'], ['W-B02', 'neha'], ['W-B03', 'aditya'], ['W-B11', 'fatima'], ['W-B12', 'joseph'],
    ['REC-01', 'bhavna'], ['MD-01', 'vikram'], ['MD-02', 'meera'], ['CC-01', 'arjun'], ['HC-03', 'sunil'], ['HC-06', 'revathi'], ['W-A07', 'ganesh'],
  ];
  const d0 = await owner.request('seating.draft', { title: 'The office as it is', moves: start.map(([seat, u]) => ({ seatId: seat, to: P(id(u)) })) });
  await owner.request('seating.apply', { id: d0.id });
  clients = await bringOnline(hub.port, hub.fingerprint, [
    { u: 'lalitha', name: 'Lalitha Murthy', mode: 'office' }, { u: 'anand', name: 'Anand Pillai', mode: 'office' }, { u: 'sneha', name: 'Sneha Kulkarni', mode: 'home' },
    { u: 'ravi', name: 'Ravi Kumar', mode: 'office' }, { u: 'rohan', name: 'Rohan Kapoor', mode: 'client' }, { u: 'suresh', name: 'Suresh Babu', mode: 'office' },
  ]);

  // 1. the seeded real plan, in Bhavna's Directory ▸ Org chart ▸ Floor
  const openFloor = async (page: any) => {
    await page.reload(); await page.locator('.frame').waitFor();
    await quietNib(page);
    await page.locator('nav.lens-bar, .lens-dock').getByRole('button', { name: /^Directory/ }).first().click();
    await page.getByRole('tab', { name: 'Org chart', exact: true }).click();
    await page.locator('.os-stage').waitFor();
    await page.getByRole('button', { name: 'Floor', exact: true }).click();
    await sleep(2600);
  };
  await openFloor(B);
  assert.match((await B.locator('.os-titleblock').textContent())!, /Floor plan · Level 01/);
  assert.match((await B.locator('.os-titleblock').textContent())!, /DDS-FLR-001/);
  await pair(B, '01-plan-1440');
  // Bhavna was given the reception seat in the office's set-up: she is told once
  await B.locator('.seat-notice', { hasText: 'REC-01 · Reception' }).waitFor();
  await B.locator('.seat-notice').getByRole('button', { name: 'Got it' }).click();
  await B.locator('.seat-notice').waitFor({ state: 'detached' });
  // find a seat by its ID: an empty seat shows itself, with its own callout; clicking a seat does the same
  const at = (page: any, seat: string) => page.evaluate((x: string) => (globalThis as any).__seatScreen(x), seat);
  await B.locator('.os-find-input').fill('W-A08');
  await B.locator('.os-results li', { hasText: 'Seat W-A08' }).click();
  await B.locator('.seat-callout', { hasText: 'W-A08' }).waitFor();
  await sleep(900);
  await B.locator('.seat-callout').getByRole('button', { name: 'Close' }).click();
  const free = await at(B, 'W-A09');
  await B.mouse.click(free.x, free.y);
  await B.locator('.seat-callout', { hasText: 'W-A09' }).waitFor();
  assert.match((await B.locator('.seat-callout').textContent())!, /Nobody: free/);
  await snap(B, '02-empty-seat-callout');
  await B.locator('.seat-callout').getByRole('button', { name: 'Close' }).click();

  // 2. Arrange: three people dragged from the list onto seats
  await B.getByRole('button', { name: 'Arrange' }).click();
  await B.locator('.seat-panel').waitFor();
  await B.getByRole('button', { name: 'Show the whole sheet' }).click(); await sleep(700);
  const dragTo = async (who: string, seat: string) => {
    const grip = B.locator(`.seat-grip[data-person="${id(who)}"]`);
    await grip.scrollIntoViewIfNeeded();
    const g = (await grip.boundingBox())!;
    const t = await at(B, seat);
    await B.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await B.mouse.down();
    for (let i = 1; i <= 12; i++) { await B.mouse.move(g.x + (t.x - g.x) * (i / 12), g.y + (t.y - g.y) * (i / 12)); await sleep(16); }
    await sleep(120);
    await B.mouse.up();
    await sleep(700);
  };
  await B.getByLabel('Show people').selectOption('none');
  await dragTo('priya', 'W-A14');
  await dragTo('karthik', 'W-A15');
  await dragTo('deepa', 'W-A16');
  let v = await owner.request('seating.get');
  let draft = v.plans.find((x: any) => x.status === 'draft');
  assert.deepEqual(draft.changes.filter((c: any) => c.userId).map((c: any) => c.to).sort(), ['W-A14', 'W-A15', 'W-A16']);
  await snap(B, '03-dragged-three');

  // 3. swap two people on the plan: drag Ravi (W-A11) onto Lakshmi (W-A12)
  const ra = await at(B, 'W-A11'), la = await at(B, 'W-A12');
  await B.mouse.move(ra.x, ra.y); await B.mouse.down();
  for (let i = 1; i <= 10; i++) { await B.mouse.move(ra.x + (la.x - ra.x) * (i / 10), ra.y + (la.y - ra.y) * (i / 10)); await sleep(16); }
  await sleep(100); await B.mouse.up(); await sleep(800);
  v = await owner.request('seating.get');
  draft = v.plans.find((x: any) => x.status === 'draft');
  const after = (seat: string) => { const m = draft.moves.find((x: any) => x.seatId === seat); return m ? m.to?.userId : v.holders[seat]?.userId; };
  assert.equal(after('W-A11'), id('lakshmi'), 'Lakshmi takes Ravi\'s seat');
  assert.equal(after('W-A12'), id('ravi'), 'Ravi takes Lakshmi\'s');
  await B.locator('.seat-tabs').getByRole('tab', { name: /Move plan/ }).click();
  await B.locator('.seat-changes li', { hasText: 'Ravi Kumar' }).waitFor();
  await pair(B, '04-move-plan-arrows');

  // 4. the Structural team to the north-east benches, with a preview
  await B.locator('.seat-tabs').getByRole('tab', { name: 'Move a team' }).click();
  await B.getByLabel('Department').selectOption({ label: 'Structural' });
  await B.getByLabel('To', { exact: true }).selectOption({ label: 'North-east benches' });
  await B.getByRole('button', { name: 'Preview' }).click();
  await B.locator('.seat-preview li', { hasText: 'Anand Pillai' }).waitFor();
  assert.match((await B.locator('.seat-preview').textContent())!, /W-C07 → W-B05/);
  await sleep(500);
  await snap(B, '05-team-preview');
  await B.getByRole('button', { name: 'Add to the move plan' }).click();
  await sleep(800);

  // 5. the plan for next Monday, applied
  await B.locator('.seat-tabs').getByRole('tab', { name: /Move plan/ }).click();
  const monday = nextMonday();
  await B.getByLabel('From').fill(monday);
  await B.getByRole('button', { name: /^Apply from/ }).click();
  await B.locator('.seat-plan', { hasText: 'From' }).waitFor();
  v = await owner.request('seating.get');
  assert.equal(v.plans.find((x: any) => x.status === 'scheduled')?.effective, monday);
  assert.equal(v.holders['W-A14'], undefined, 'not yet: Monday');
  await snap(B, '06-published-for-monday');

  // 6. Monday comes: the moves take effect; Priya is told and walks to her new seat
  hub.seating.setClock(Date.parse(`${monday}T09:00:00`));
  hub.seating.tick();
  v = await owner.request('seating.get');
  assert.deepEqual(v.holders['W-A14'], P(id('priya')));
  // Rev B: Vikram took the seat the drawing names him on as he set the hub up; C: Manoj and Ganesh
  // as their profiles came in; D: the office as it is
  assert.equal(v.revisions[0].rev, 'E');
  const pv = (await owner.request('directory.list')).users.find((u: any) => u.id === id('priya'));
  assert.equal(pv.profile.location, 'W-A14 · Left benches', 'her directory seat follows the plan');
  hub.seating.setClock(null);
  await openFloor(PR);
  await PR.locator('.seat-notice', { hasText: 'W-A14 · Left benches' }).waitFor();
  await snap(PR, '07-priya-notice');
  await PR.locator('.seat-notice').getByRole('button', { name: 'Walk there' }).click();
  await PR.locator('.os-route', { hasText: 'round the desks' }).waitFor();
  await sleep(1400);
  await pair(PR, '08-priya-walks-there');
  await PR.locator('.seat-notice').getByRole('button', { name: 'Got it' }).click();
  await PR.locator('.seat-notice').waitFor({ state: 'detached' });
  // her own profile: the seat is derived and read-only
  await PR.getByRole('button', { name: 'Clear the route' }).click();

  // 7. revisions D and E compared: clouds round the seats that changed
  await B.locator('.seat-panel').getByRole('button', { name: 'Close arranging' }).click();
  await B.getByRole('button', { name: 'Revisions' }).click();
  await B.locator('.seat-revs').waitFor();
  await B.getByLabel('Compare', { exact: true }).selectOption('D');
  await B.getByLabel('with', { exact: true }).selectOption('E');
  await B.locator('.seat-compare').getByRole('button', { name: 'Compare' }).click();
  await B.locator('.seat-comparing', { hasText: /seats changed/ }).waitFor();
  await sleep(700);
  await pair(B, '09-compare-D-E');
  // the plan for the notice wall
  await B.evaluate(() => { (globalThis as any).__seatingExport = (name: string, blob: Blob) => { (globalThis as any).__exported = { name, size: blob.size, type: blob.type }; }; });
  await B.locator('.seat-revs').getByRole('button', { name: 'PDF' }).click();
  await B.waitForFunction(() => (globalThis as any).__exported);
  const ex = await B.evaluate(() => (globalThis as any).__exported);
  assert.equal(ex.type, 'application/pdf');
  assert.ok(ex.size > 50_000, `a real drawing (${ex.size} bytes)`);
  await B.evaluate(() => { (globalThis as any).__seatingExport = async (name: string, blob: Blob) => { (globalThis as any).__png = Array.from(new Uint8Array(await blob.arrayBuffer())); }; (globalThis as any).__png = null; });
  await B.locator('.seat-revs').getByRole('button', { name: 'PNG' }).click();
  await B.waitForFunction(() => (globalThis as any).__png);
  fs.writeFileSync(path.join(OUT, 'seating-10-notice-wall.png'), Buffer.from(await B.evaluate(() => (globalThis as any).__png)));
  await B.locator('.seat-revs').getByRole('button', { name: 'Stop comparing' }).click();
  await B.locator('.seat-revs').getByRole('button', { name: 'Close the revisions' }).click();

  // 8. the layout: a bench of 4 added, nudged with the keyboard, saved as a revision
  await B.getByRole('button', { name: 'Arrange' }).click();
  await B.locator('.seat-tabs').getByRole('tab', { name: 'Layout' }).click();
  await B.getByRole('button', { name: 'Edit the layout' }).click();
  await B.getByLabel('Add a bench of').fill('4');
  await B.getByRole('button', { name: 'Add bench' }).click();
  await sleep(500);
  assert.match((await B.locator('.seat-layout').textContent())!, /4 seats selected/);
  await B.locator('.os-stage').focus();
  for (let i = 0; i < 4; i++) await B.keyboard.press('ArrowRight');
  await sleep(300);
  await pair(B, '11-layout-bench-of-4');
  await B.getByLabel('What changed').fill('A bench of 4 added');
  await B.getByRole('button', { name: 'Save layout' }).click();
  await B.locator('.toast', { hasText: /Layout saved as Rev F/ }).first().waitFor();
  v = await owner.request('seating.get');
  assert.equal(v.plan.seats.length, 157);
  assert.ok(v.plan.seats.some((q: any) => q.id === 'W-A57' || q.id === 'W-B21' || q.id === 'W-C43'));

  // 9. a small CSV imported and matched against the directory
  await B.locator('.seat-tabs').getByRole('tab', { name: 'Import' }).click();
  await B.getByLabel('Seats and names').fill('seat_id,name_on_drawing\nW-C30, Asha Thomas\nW-C31, Mathew\nW-C32, Neha Agarwal\nW-C33, Nobody Here\n');
  await B.getByRole('button', { name: 'Match names' }).click();
  await B.locator('.seat-import tbody tr').nth(3).waitFor();
  assert.equal(await B.locator('.seat-import tr.check').count(), 1, 'one name to check (a first name only)');
  assert.match((await B.locator('.seat-import tbody tr').nth(3).textContent())!, /No one in the directory/);
  await snap(B, '12-import-matched');
  // an uncertain name is confirmed by ticking it
  await B.getByLabel('Use line 3').check();
  await B.getByRole('button', { name: /^Add 3 seats to the move plan/ }).click();
  await sleep(800);
  v = await owner.request('seating.get');
  draft = v.plans.find((x: any) => x.status === 'draft');
  assert.deepEqual(draft.changes.filter((c: any) => c.to?.startsWith('W-C3')).map((c: any) => c.to).sort(), ['W-C30', 'W-C31', 'W-C32']);
  await owner.request('seating.discard', { id: draft.id });

  // 10. departments as a wash
  await B.locator('.seat-panel').getByRole('button', { name: 'Close arranging' }).click();
  await B.getByRole('button', { name: 'Departments' }).click();
  await B.getByRole('button', { name: 'Show the whole sheet' }).click(); await sleep(800);
  await pair(B, '13-departments');
  await B.getByRole('button', { name: 'Departments' }).click();

  // 10b. across the two sheets for one person: Lines ▸ Find on the floor, Floor ▸ See in the reporting lines
  const findPerson = async (name: string) => {
    await B.locator('.os-find-input').fill(name);
    await B.locator('.os-results li', { hasText: name }).first().click();
    await B.locator('.os-callout', { hasText: name }).waitFor();
    await sleep(1200);
  };
  const raviSeat = Object.entries((await owner.request('seating.get')).holders).find(([, h]: [string, any]) => h.kind === 'person' && h.userId === id('ravi'))![0];
  await B.getByRole('button', { name: 'Lines', exact: true }).click();
  await sleep(1800);
  await findPerson('Ravi Kumar');
  await pair(B, '12a-lines-callout');
  const across = B.locator('.os-callout').getByRole('button', { name: 'Find on the floor' });
  await across.focus();
  await B.keyboard.press('Enter'); // keyboard reachable
  await B.locator('.os-sheets button[aria-pressed="true"]', { hasText: 'Floor' }).waitFor();
  await B.locator('.os-callout', { hasText: 'Ravi Kumar' }).locator('.os-co-across').getByRole('button', { name: 'See in the reporting lines' }).waitFor({ timeout: 8000 });
  await sleep(1400);
  const seatAt = await at(B, raviSeat);
  const st = await B.locator('.os-stage').boundingBox();
  assert.ok(seatAt && st && seatAt.x > st.x && seatAt.x < st.x + st.width && seatAt.y > st.y && seatAt.y < st.y + st.height, `the camera is at Ravi's seat ${raviSeat}`);
  await pair(B, '12b-found-on-floor');
  await B.locator('.os-callout').getByRole('button', { name: 'See in the reporting lines' }).click();
  await B.locator('.os-sheets button[aria-pressed="true"]', { hasText: 'Lines' }).waitFor();
  await B.locator('.os-callout', { hasText: 'Ravi Kumar' }).getByRole('button', { name: 'Find on the floor' }).waitFor({ timeout: 8000 });
  await sleep(800);
  await snap(B, '12c-back-on-lines');
  // working away today, and no seat: said in the callout instead
  await findPerson('Sneha Kulkarni');
  assert.match((await B.locator('.os-co-across').textContent())!, /Working from home today/);
  assert.equal(await B.locator('.os-callout').getByRole('button', { name: 'Find on the floor' }).count(), 0);
  const seated = new Set(Object.values((await owner.request('seating.get')).holders).filter((h: any) => h.kind === 'person').map((h: any) => h.userId));
  const unseated = (await owner.request('directory.list')).users.find((u: any) => u.role === 'member' && !seated.has(u.id) && u.id !== id('sneha'));
  if (unseated) {
    await findPerson(unseated.displayName);
    assert.match((await B.locator('.os-co-across').textContent())!, /No seat on the plan|from home today|On site today|At a client today/);
    await snap(B, '12d-no-seat');
  }
  await B.locator('.os-callout').getByRole('button', { name: 'Close' }).click();
  await B.getByRole('button', { name: 'Floor', exact: true }).click();
  await sleep(1500);

  // 11. 150 seats held: frame times while panning and zooming
  const extra = bigOffice(150).slice(0, 110);
  const extraIds: string[] = [];
  for (const q of extra) {
    const key = `dex\\x${q.u}`;
    const u = hub.store.userByAccount(key) ?? hub.store.createUser(key, q.name, 'member');
    extraIds.push(u.id);
  }
  const vv = await owner.request('seating.get');
  const freeSeats = vv.plan.seats.map((q: any) => q.id).filter((sid: string) => !vv.holders[sid]);
  const fill = await owner.request('seating.draft', { title: 'Fill', moves: freeSeats.slice(0, extraIds.length).map((sid: string, i: number) => ({ seatId: sid, to: P(extraIds[i]) })) });
  await owner.request('seating.apply', { id: fill.id });
  // people on their seats, and the names from the drawing still waiting for theirs
  const held = Object.values((await owner.request('seating.get')).holders).filter((h: any) => h.kind === 'person' || h.kind === 'named').length;
  await B.reload(); await B.locator('.frame').waitFor();
  await quietNib(B);
  await B.locator('nav.lens-bar, .lens-dock').getByRole('button', { name: /^Directory/ }).first().click();
  await B.getByRole('tab', { name: 'Org chart', exact: true }).click();
  await B.getByRole('button', { name: 'Floor', exact: true }).click();
  await sleep(2600);
  await B.evaluate(() => (globalThis as any).__orgscapePerf.reset());
  const box = (await B.locator('.os-stage').boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await B.mouse.move(cx, cy);
  for (let i = 0; i < 8; i++) { await B.mouse.wheel(0, -120); await sleep(40); }
  await B.mouse.down();
  for (let i = 1; i <= 60; i++) { await B.mouse.move(cx - i * 9, cy - i * 5); await sleep(16); }
  await B.mouse.up();
  for (let i = 0; i < 8; i++) { await B.mouse.wheel(0, 120); await sleep(40); }
  await sleep(600);
  const frames: Array<{ dt: number; draw: number }> = await B.evaluate(() => (globalThis as any).__orgscapePerf.frames.slice());
  const draws = frames.map((f) => f.draw).sort((a, z) => a - z);
  const dts = frames.map((f) => f.dt).sort((a, z) => a - z);
  const q = (xs: number[], k: number) => xs[Math.min(xs.length - 1, Math.floor(xs.length * k))] ?? 0;
  const perf = { seats: vv.plan.seats.length, held, frames: frames.length, drawMedianMs: +q(draws, 0.5).toFixed(2), drawP95Ms: +q(draws, 0.95).toFixed(2), frameP95Ms: +q(dts, 0.95).toFixed(1) };
  console.log('SEATING PERF', JSON.stringify(perf));
  fs.writeFileSync(path.join(OUT, 'seating-perf.json'), JSON.stringify(perf, null, 2));
  assert.ok(held >= 140, `the plan is full (${held})`);
  assert.ok(perf.drawP95Ms < 16, `drawing a frame stays under 16 ms at the 95th percentile (${perf.drawP95Ms})`);
  await B.getByRole('button', { name: 'Show the whole sheet' }).click(); await sleep(700);
  await B.getByRole('button', { name: 'Zoom in' }).click(); await sleep(700);
  await snap(B, '14-full-150');

  // 12. the phone: 390 px, light and dark; and Hindi
  await PR.setViewportSize({ width: 390, height: 844 });
  await PR.reload(); await PR.locator('.frame').waitFor();
  await PR.locator('.lens-dock').getByRole('button', { name: /Directory/ }).click();
  await PR.getByRole('tab', { name: 'Org chart', exact: true }).click();
  await PR.getByRole('button', { name: 'Floor', exact: true }).click();
  await sleep(2600);
  const wide = await PR.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(wide <= 390, `no sideways scroll (${wide})`);
  await pair(PR, '15-phone-plan');
  const pz = await at(PR, 'W-A14');
  await PR.getByRole('button', { name: 'Go to me' }).click();
  await PR.locator('.os-callout', { hasText: 'Priya Raman' }).waitFor();
  await sleep(1000);
  assert.ok(pz, 'her seat is on the phone plan');
  await pair(PR, '16-phone-callout');
  await PR.evaluate(() => localStorage.setItem('dex.language', 'hi'));
  await PR.setViewportSize({ width: 1440, height: 900 });
  await PR.reload(); await PR.locator('.frame').waitFor();
  await PR.getByRole('button', { name: /^(Directory|निर्देशिका)/ }).first().click();
  await PR.locator('.sheet-tab').nth(1).click();
  await PR.locator('.os-stage').waitFor();
  await PR.locator('.os-sheets button').nth(1).click();
  await sleep(2600);
  await snap(PR, '17-hindi-plan');
  await PR.evaluate(() => localStorage.setItem('dex.language', 'en'));
  console.log('SEATING E2E PASSED');
} catch (e) {
  for (const [i, a] of apps.entries()) { try { const pg = await a.firstWindow(); await pg.screenshot({ path: path.join(OUT, `seating-FAIL-${i}.png`) }); } catch { /* closed */ } }
  throw e;
} finally {
  for (const c of clients) c.disconnect();
  for (const a of apps) await a.close().catch(() => {});
  owner.disconnect(); await hub.stop();
}
