import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep } from './harness.mts';

const { owner, hub } = await startOffice('cal');
const { app, page } = await launch('priya', 'Priya Raman');
try {
  const users = (await owner.request('directory.list')).users;
  const priya = users.find((u: any) => u.account.endsWith('priya'))!;
  const room = await owner.request('admin.cal.saveVenue', { name: 'Conference room A', capacity: 8 });
  // Vikram books the room every weekday at 11:00 starting today
  const d = new Date(); d.setHours(11, 0, 0, 0);
  await owner.request('cal.create', { title: 'Morning coordination', startAt: d.getTime(), endAt: d.getTime() + 3600_000, recurrence: 'weekdays', venueId: room.id, attendees: [priya.id], online: true });
  const t = new Date(); t.setDate(t.getDate() + 1); t.setHours(15, 0, 0, 0);
  await owner.request('cal.create', { title: 'Client: P-12 review', startAt: t.getTime(), endAt: t.getTime() + 5400_000, attendees: [priya.id], online: true, description: 'Walk through the **isometrics** and the MTO.' });
  await page.getByRole('button', { name: /^Calendar/ }).first().click();
  // on a Sunday, tomorrow and the weekdays from today are in next week's sheet
  if (new Date().getDay() === 0) await page.getByRole('button', { name: 'Next week' }).click();
  await page.locator('.cal-block').first().waitFor();
  await sleep(400);
  await shot(page, 'cal-01-week');
  // reply to an invitation
  await page.locator('.cal-block', { hasText: 'Client: P-12 review' }).click();
  await page.getByRole('dialog', { name: 'Client: P-12 review' }).getByRole('button', { name: 'Going', exact: true }).click();
  await page.locator('.ev-person.r-yes', { hasText: 'You' }).waitFor();
  await shot(page, 'cal-02-details');
  await page.keyboard.press('Escape');
  // plan a meeting that clashes with the room booking
  await page.getByRole('button', { name: 'New meeting' }).click();
  await page.getByLabel('Title', { exact: true }).fill('Stress check');
  const s = new Date(); s.setDate(s.getDate() + (s.getDay() === 6 ? 2 : s.getDay() === 5 ? 3 : 1)); s.setHours(11, 30, 0, 0);
  const local = new Date(s.getTime() - s.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  await page.getByLabel('Starts').fill(local);
  await page.getByPlaceholder('Invite people').fill('Vik');
  await page.locator('.ev-suggest button', { hasText: 'Vikram Shah' }).click();
  await page.getByLabel('Conference room').selectOption(room.id);
  await page.locator('.ev-clash').waitFor();
  await shot(page, 'cal-03-new-clash');
  await page.getByRole('button', { name: 'Send invitations' }).click();
  await page.getByText(/already booked by Vikram Shah/).waitFor();
  // move it to 14:00 and it books
  s.setHours(14, 0, 0, 0);
  await page.getByLabel('Starts').fill(new Date(s.getTime() - s.getTimezoneOffset() * 60000).toISOString().slice(0, 16));
  await page.getByRole('button', { name: 'Send invitations' }).click();
  await page.getByText(/Invitations sent to 1 person/).waitFor();
  const mine = await owner.request('cal.list', { from: s.getTime() - 1, to: s.getTime() + 3600_000 });
  assert.ok(mine.some((o: any) => o.event.title === 'Stress check' && o.event.venueId === room.id));
  // starting soon card
  const soon = Date.now() + 4 * 60_000;
  await owner.request('cal.create', { title: 'Quick sync', startAt: soon, endAt: soon + 900_000, attendees: [priya.id], online: true, reminderMin: 5 });
  hub.calendar.tick();
  await page.locator('.meeting-card').waitFor();
  await sleep(800);
  console.log('blocks', await page.locator('.cal-block').count(), 'cols', await page.locator('.week-col').count(), 'now', await page.locator('.now-line').count());
  console.log('list', JSON.stringify((await page.evaluate(async () => { const d = new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return (await window.dex.request('cal.list', { from: d.getTime(), to: d.getTime() + 7 * 86400000 })).map((o) => o.event.title); }))));
  console.log('boxes', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.cal-block, .now-line')].map((e) => { const r = e.getBoundingClientRect(); const st = getComputedStyle(e); return [e.className, Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height), st.opacity, st.visibility, document.elementFromPoint(r.x + 5, r.y + 5)?.className]; }))));
  console.log('scroll', await page.evaluate(() => document.querySelector('.week-body')!.scrollTop));
  await shot(page, 'cal-04-soon');
  await page.getByRole('button', { name: 'Agenda' }).click();
  await page.locator('.agenda-row').first().waitFor();
  await shot(page, 'cal-05-agenda');
  await page.getByRole('button', { name: /^Pulse/ }).first().click();
  await page.locator('.next-row').first().waitFor();
  await shot(page, 'cal-06-pulse');
  console.log('CAL E2E PASSED');
} catch (e) {
  await shot(page, 'cal-FAIL');
  throw e;
} finally {
  await app.close();
  owner.disconnect();
  await hub.stop();
}
