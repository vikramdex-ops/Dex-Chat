// The office drawing, end to end: Pulse's card opens it at someone, pan and zoom (drag, wheel,
// buttons), search spotlights and flies, the route between two people, a profile's "See in the
// org chart", the arrow keys along the lines, the schedule tree, Spaces overlay, growth, the floor
// plan, the phone layout, light and dark, Hindi. Screenshots in out/.
import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep } from './harness.mts';
import { OFFICE, seedOffice, bringOnline } from './officeseed.mts';

const { owner, hub } = await startOffice('orgscape');
const s = await seedOffice(hub, owner, OFFICE, ['vikram', 'priya']);
const { app, page } = await launch('priya', 'Priya Raman', { width: 1440, height: 900 });
const theme = (t: string) => page.evaluate((x) => { document.documentElement.dataset.theme = x; }, t);
const live = () => page.locator('#os-live').textContent();
const scale = async () => Number((await page.locator('.os-titleblock .os-tb-cell').nth(2).locator('.mono').textContent())!.split(':')[1]);
let clients: any[] = [];
try {
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'));
  await s.profiles({ priya: priya.id });
  const id = (u: string) => s.ids.get(u)!;
  // the floor is the office's real plan (seating): seat the people the walk looks at
  const seats: Array<[string, string]> = [['W-A01', 'priya'], ['W-A02', 'ravi'], ['W-C07', 'anand'], ['W-C08', 'sneha'], ['POD1-1', 'kiran'], ['POD1-2', 'deepa'], ['MD-01', 'vikram'], ['MD-02', 'meera'], ['HC-03', 'lalitha'], ['W-B01', 'rohan'], ['W-B02', 'imran']];
  const seated = await owner.request('seating.draft', { title: 'Seats', moves: seats.map(([seatId, u]) => ({ seatId, to: { kind: 'person', userId: id(u) } })) });
  await owner.request('seating.apply', { id: seated.id });
  // a Space Priya shares with Structural people, and one private Space she is not in
  await owner.request('conv.create', { kind: 'space', name: 'P-12 Pipe rack', members: [priya.id, id('anand'), id('sneha'), id('ravi'), id('deepa')] });
  await owner.request('conv.create', { kind: 'space', name: 'Board only', private: true, members: [id('meera'), id('arjun')] });
  clients = await bringOnline(hub.port, hub.fingerprint, [
    { u: 'meera', name: 'Meera Nair', mode: 'office' }, { u: 'ravi', name: 'Ravi Kumar', mode: 'office', status: 'Checking P-12 isometrics' }, { u: 'anand', name: 'Anand Pillai', mode: 'office' },
    { u: 'sneha', name: 'Sneha Kulkarni', mode: 'home' }, { u: 'lalitha', name: 'Lalitha Murthy', mode: 'office' }, { u: 'rohan', name: 'Rohan Kapoor', mode: 'client' },
    { u: 'kiran', name: 'Kiran Desai', mode: 'office' }, { u: 'deepa', name: 'Deepa Krishnan', mode: 'office' }, { u: 'imran', name: 'Imran Shaikh', mode: 'site' },
  ]);
  await page.reload(); await page.locator('.frame').waitFor();
  await sleep(800);

  // 1. Pulse: the office drawing card; "Meet someone" opens the drawing at them
  const card = page.locator('.office-card');
  await card.waitFor();
  assert.ok(await card.getByText(/New this month · 3/).isVisible(), 'three new joiners');
  assert.ok(await card.getByText(/Birthday today: Karthik/).isVisible());
  assert.ok(await card.getByText(/Deepa: 5 years here today/).isVisible());
  await card.scrollIntoViewIfNeeded();
  await shot(page, 'os-01-pulse-card');
  const meetName = (await card.locator('.oc-meet b').textContent())!;
  await card.locator('.oc-meet').click();
  await page.locator('.os-stage').waitFor();
  await page.locator('.os-callout', { hasText: meetName }).waitFor({ timeout: 8000 });
  await shot(page, 'os-02-opened-from-pulse');

  // 2. the whole sheet, then pan and zoom with the mouse
  await page.getByRole('button', { name: 'Show the whole sheet' }).click();
  await sleep(900);
  const zFit = await scale();
  await shot(page, 'os-03-whole-sheet-light');
  const box = (await page.locator('.os-stage').boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -120); await sleep(30); }
  await sleep(200);
  assert.ok(await scale() < zFit, `wheel zooms in (1:${zFit} -> 1:${await scale()})`);
  await page.mouse.move(cx, cy); await page.mouse.down();
  for (let i = 1; i <= 10; i++) { await page.mouse.move(cx - i * 20, cy - i * 8); await sleep(16); }
  await page.mouse.up();
  await sleep(500);
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await sleep(400);
  await shot(page, 'os-04-panned-zoomed');

  // 3. search spotlights a person and flies there; Enter picks it
  await page.locator('.os-find-input').fill('stress');
  await page.locator('#os-results [role=option]', { hasText: 'Deepa Krishnan' }).waitFor();
  await shot(page, 'os-05-search-results');
  await page.keyboard.press('Enter');
  await page.locator('.os-callout', { hasText: 'Deepa Krishnan' }).waitFor();
  assert.match((await live())!, /Deepa Krishnan, Stress Engineer, Piping/);
  await sleep(1200);
  await shot(page, 'os-06-search-spotlight');

  // 4. how I connect to someone in Structural
  await page.locator('.os-find-input').fill('Farhan');
  await page.keyboard.press('Enter');
  await page.locator('.os-callout', { hasText: 'Farhan Qureshi' }).waitFor();
  await page.locator('.os-callout').getByRole('button', { name: 'How we connect' }).click();
  const steps = page.locator('.os-route .os-steps li');
  await steps.first().waitFor();
  assert.deepEqual(await steps.locator('.tb-link').allTextContents(), ['Priya Raman', 'Meera Nair', 'Anand Pillai', 'Sneha Kulkarni', 'Farhan Qureshi']);
  await sleep(1200);
  await page.locator('.os-callout').getByRole('button', { name: 'Close' }).click();
  await sleep(300);
  await shot(page, 'os-07-route-light');
  await theme('dark'); await sleep(300);
  await shot(page, 'os-08-route-dark');
  await theme('light');
  await page.getByRole('button', { name: 'Clear the route' }).click();

  // 5. keyboard: arrows walk along the lines, Enter opens the person, Home goes to me
  await page.locator('.os-stage').focus();
  await page.keyboard.press('Home');
  await sleep(300);
  assert.match((await live())!, /^Priya Raman/);
  await page.keyboard.press('ArrowUp');
  await sleep(200);
  assert.match((await live())!, /^Meera Nair/, 'up: the line manager');
  await page.keyboard.press('ArrowDown');
  await sleep(200);
  const down = (await live())!;
  assert.ok(/^(Priya Raman|Anand Pillai|Anita Rao|Suresh Babu|Ramesh Chandran)/.test(down), `down: a direct report (${down})`);
  await page.keyboard.press('ArrowRight');
  await sleep(200);
  assert.notEqual(await live(), down, 'right: a peer');
  await page.keyboard.press('Enter');
  await page.locator('.os-callout').waitFor();
  await sleep(800);
  await shot(page, 'os-09-keyboard-focus');
  await page.keyboard.press('Escape');

  // 6. the schedule: a tree with every person, for keyboards and screen readers
  await page.getByRole('button', { name: 'Schedule' }).click();
  const tree = page.getByRole('tree', { name: 'Reporting lines' });
  await tree.waitFor();
  assert.equal(await tree.getByRole('treeitem').count(), 40);
  assert.equal(await tree.locator('[role=treeitem][aria-level="1"]').first().locator('.os-sch-name').textContent(), 'Vikram Shah');
  await tree.locator('[role=treeitem][tabindex="0"]').focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await sleep(500);
  assert.match((await live())!, /^(Arjun Mehta|Meera Nair|Revathi Iyer|Sunil Varghese)/);
  await shot(page, 'os-10-schedule');
  await page.getByRole('button', { name: 'Close the schedule' }).click();

  // 7. Spaces overlay: the shared Space is offered, the private one she is not in is not
  await page.locator('.os-tools').getByRole('button', { name: 'Spaces', exact: true }).click();
  await page.locator('.os-menu-item', { hasText: 'P-12 Pipe rack' }).waitFor();
  assert.equal(await page.locator('.os-menu-item', { hasText: 'Board only' }).count(), 0);
  await page.locator('.os-menu-item', { hasText: 'P-12 Pipe rack' }).click();
  await page.getByRole('button', { name: 'Show the whole sheet' }).click();
  await sleep(900);
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await sleep(500);
  await shot(page, 'os-11-space-overlay');
  await page.locator('.os-stage').focus();
  await page.keyboard.press('Escape');

  // 8. growth: the office as it was
  await page.getByRole('button', { name: 'Growth' }).click();
  const range = page.getByRole('slider', { name: 'As at' });
  await range.waitFor();
  await range.fill('80');
  await sleep(300);
  const asAt = (await page.locator('.os-asat').textContent())!;
  assert.match(asAt, /\d+ of 40 people/);
  assert.ok(!/40 of 40/.test(asAt));
  await page.getByRole('button', { name: 'Show the whole sheet' }).click();
  await sleep(900);
  await shot(page, 'os-12-growth');
  await page.getByRole('button', { name: 'Growth' }).click();

  // 9. a profile's "See in the org chart" flies to them
  await page.getByRole('tab', { name: 'People', exact: true }).click();
  await page.locator('.card.person', { hasText: 'Lalitha Murthy' }).click();
  await page.locator('.profile-panel').getByRole('button', { name: 'See in the org chart' }).click();
  await page.locator('.os-callout', { hasText: 'Lalitha Murthy' }).waitFor({ timeout: 8000 });
  await sleep(1200);
  await shot(page, 'os-13-see-in-chart');
  await page.locator('.profile-panel').getByRole('button', { name: 'Close profile' }).click();

  // 10. the floor plan: who is in, at which desk; the walk to someone's desk
  await page.getByRole('button', { name: 'Floor', exact: true }).click();
  await sleep(2400);
  assert.match((await page.locator('.os-titleblock').textContent())!, /Floor plan/);
  await shot(page, 'os-14-floor-light');
  await page.locator('.os-find-input').fill('Anand');
  await page.keyboard.press('Enter');
  await page.locator('.os-callout', { hasText: 'Anand Pillai' }).waitFor();
  await page.locator('.os-callout').getByRole('button', { name: 'Walk there' }).click();
  await page.locator('.os-route', { hasText: 'round the desks' }).waitFor();
  await page.locator('.os-callout').getByRole('button', { name: 'Close' }).click();
  await sleep(1300);
  await shot(page, 'os-15-floor-walk');
  await page.getByRole('button', { name: 'Clear the route' }).click();
  await page.getByRole('button', { name: 'Schedule' }).click();
  await page.getByRole('tree', { name: 'People by room' }).getByText('Working away from the office').waitFor();
  await page.getByRole('button', { name: 'Close the schedule' }).click();
  await page.getByRole('button', { name: 'Show the whole sheet' }).click();
  await sleep(800);
  await theme('dark'); await sleep(300);
  await shot(page, 'os-16-floor-dark');
  await page.getByRole('button', { name: 'Lines', exact: true }).click();
  await sleep(1500);
  await shot(page, 'os-17-lines-dark');
  await page.getByRole('button', { name: 'Key' }).click();
  await sleep(300);
  await shot(page, 'os-18-key-dark');
  await page.getByRole('button', { name: 'Close the key' }).click();
  await theme('light');

  // 11. Hindi
  await page.evaluate(() => localStorage.setItem('dex.language', 'hi'));
  await page.reload(); await page.locator('.frame').waitFor();
  await page.getByRole('button', { name: /^(Directory|निर्देशिका)/ }).first().click();
  await page.locator('.sheet-tab').nth(1).click();
  await page.locator('.os-stage').waitFor();
  await sleep(2600);
  await shot(page, 'os-19-hindi-lines');
  await page.locator('.os-sheets button').nth(1).click();
  await sleep(2400);
  await shot(page, 'os-20-hindi-floor');
  await page.evaluate(() => localStorage.setItem('dex.language', 'en'));

  // 12. the phone: 390 px, light and dark, pinch-free controls
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload(); await page.locator('.frame').waitFor();
  await page.locator('.lens-dock').getByRole('button', { name: /Directory/ }).click();
  await page.getByRole('tab', { name: 'Org chart', exact: true }).click();
  await page.locator('.os-stage').waitFor();
  await sleep(2600);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(wide <= 390, `no sideways scroll (${wide})`);
  await shot(page, 'os-21-phone-lines-light');
  await page.locator('.os-find-input').fill('kiran');
  await page.keyboard.press('Enter');
  await page.locator('.os-callout', { hasText: 'Kiran Desai' }).waitFor();
  await sleep(1200);
  await shot(page, 'os-22-phone-callout');
  await page.locator('.os-callout').getByRole('button', { name: 'Close' }).click();
  await theme('dark'); await sleep(300);
  await shot(page, 'os-23-phone-lines-dark');
  await page.getByRole('button', { name: 'Floor', exact: true }).click();
  await sleep(2400);
  await shot(page, 'os-24-phone-floor-dark');
  await theme('light');
  console.log('ORGSCAPE E2E PASSED');
} catch (e) {
  await shot(page, 'os-FAIL');
  throw e;
} finally {
  for (const c of clients) c.disconnect();
  await app.close(); owner.disconnect(); await hub.stop();
}
