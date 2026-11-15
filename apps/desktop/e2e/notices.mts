// The notice board end to end (docs/ANNOUNCEMENTS.md). Bhavna (an administrator) makes Revathi an
// issuer for the HR desk in the Control room; Revathi drafts a leave policy with a PDF for Piping
// and Drafting, asks for acknowledgement with a check question, and schedules it; the hub's clock
// (hub.notices.setClock, in this process) reaches the time and it issues; Karthik sees it in
// Pulse's Needs you, reads it with the PDF inline and acknowledges it (the stamp lands); the
// acknowledgement register fills live as two colleagues acknowledge; Rev B issues with a change
// note and asks again; search finds it by a phrase inside the PDF; an urgent IT notice shows its
// banner once; a holiday notice expires into the archive; and a look in Hindi. Screenshots at 1440
// and 390 px, light and dark, in NOTICES_OUT (default e2e/out).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startOffice, launch, sleep, OUT as BASE_OUT } from './harness.mts';
import { OFFICE, seedOffice, bringOnline } from './officeseed.mts';
import { buildPdf } from '../../hub/test/pdfs.ts';

const OUT = process.env.NOTICES_OUT ?? BASE_OUT;
fs.mkdirSync(OUT, { recursive: true });
const snap = (page: any, name: string) => page.screenshot({ path: path.join(OUT, `notices-${name}.png`) });
const pair = async (page: any, name: string) => {
  for (const t of ['light', 'dark']) {
    await page.evaluate((x: string) => { document.documentElement.dataset.theme = x; }, t);
    await sleep(250);
    await snap(page, `${name}-${t}`);
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
};
const lens = (page: any, name: string) => page.locator('nav.lens-bar').getByRole('button', { name: new RegExp(`^${name}`) }).click();

const { hub, owner } = await startOffice('notices');
const seeded = await seedOffice(hub, owner, OFFICE, ['vikram', 'karthik', 'revathi', 'bhavna', 'ravi', 'manoj']);
const apps: any[] = [];
const extra: any[] = [];
const clock = (t: number) => { hub.notices.setClock(t); hub.notices.tick(t); return t; };
try {
  const k = await launch('karthik', 'Karthik Subramanian', { width: 1440, height: 900 });
  const r = await launch('revathi', 'Revathi Iyer', { width: 1440, height: 900 });
  const b = await launch('bhavna', 'Bhavna Shah', { width: 1440, height: 900 });
  apps.push(k.app, r.app, b.app);
  const K = k.page, R = r.page, B = b.page;
  const [ravi, manoj] = await bringOnline(hub.port, hub.fingerprint, [{ u: 'ravi', name: 'Ravi Kumar' }, { u: 'manoj', name: 'Manoj Patil' }]);
  extra.push(ravi, manoj);
  const dir = (await owner.request('directory.list')).users;
  const id = (u: string) => dir.find((x: any) => x.account.endsWith(`\\${u}`) && x.role !== 'bot')?.id as string;
  await seeded.profiles({ karthik: id('karthik'), revathi: id('revathi'), bhavna: id('bhavna'), ravi: id('ravi'), manoj: id('manoj') });
  await owner.request('admin.setRole', { userId: id('bhavna'), role: 'admin' });

  // ---------------------------------------------------------------- 1. the administrator makes HR an issuing desk
  console.log('step 1: the administrator makes HR an issuing desk');
  await B.reload(); await B.locator('.frame').waitFor();
  await B.locator('.me-btn').click();
  await B.getByRole('menuitem', { name: /Control room/ }).click();
  await B.getByRole('button', { name: /Notice desks/ }).click();
  await B.locator('.nb-admin').waitFor();
  await B.getByRole('combobox', { name: 'Add an issuer for HR' }).selectOption({ label: 'Revathi Iyer' });
  await B.getByText('Revathi Iyer now issues for HR').waitFor();
  await sleep(300);
  await pair(B, '01-control-room-desks');
  const desks = (await owner.request('admin.notices.get')).desks;
  const hrDesk = desks.find((d: any) => d.code === 'HR');
  assert.deepEqual(hrDesk.issuers, [id('revathi')]);
  assert.ok((await owner.request('admin.audit', { limit: 30 })).some((a: any) => a.action === 'notice.desk'), 'audited');
  await B.keyboard.press('Escape');

  // ---------------------------------------------------------------- 2. Revathi drafts the leave policy and schedules it
  console.log('step 2: Revathi drafts the leave policy and schedules it');
  const pdfPath = path.join(OUT, 'HR-leave-policy-2026.pdf');
  // a letterhead in the PDF's own drawing (landscape A4: 842 × 595 points)
  const line = (x: number, y: number, size: number, text: string) => `BT /F1 ${size} Tf ${x} ${y} Td (${text}) Tj ET`;
  fs.writeFileSync(pdfPath, buildPdf({ pages: [
    { content: ['0.11 0.46 0.5 RG 2 w 40 40 762 515 re S 0.5 w 40 500 m 802 500 l S',
      line(60, 520, 20, 'Dexterity Design Services Pvt Ltd: Leave policy 2026'), line(640, 520, 10, 'HR-POL-0001 Rev A'),
      line(60, 460, 13, '1. Earned leave is 18 days a year, credited monthly.'), line(60, 436, 13, '2. Leave encashment applies after 240 days of service.'),
      line(60, 412, 13, '3. Carry forward is up to 30 days. Apply in the HR portal a week ahead.'), line(60, 388, 13, '4. Sick leave needs a certificate after two days.'),
      line(60, 80, 9, 'Issued by HR. Questions: ask the issuer on the notice board.')].join(' ') },
    { content: ['0.11 0.46 0.5 RG 2 w 40 40 762 515 re S', line(60, 520, 16, 'Annexure: leave calendar'), line(60, 470, 12, 'Holidays follow the office calendar on the notice board.')].join(' ') },
  ] }));
  await R.reload(); await R.locator('.frame').waitFor();
  await lens(R, 'Notices');
  await R.locator('.nb-view').waitFor();
  await R.getByRole('button', { name: 'Draft a notice' }).first().click();
  await R.locator('.nb-compose').waitFor();
  await R.getByLabel('Kind', { exact: true }).selectOption('policy');
  await R.getByLabel('Title', { exact: true }).fill('Leave policy 2026');
  await R.getByLabel('The notice', { exact: true }).fill('Earned leave is 18 days a year, credited monthly.\n\nCarry forward is up to 30 days.\n\nApply for leave in the HR portal at least a week ahead.');
  await R.locator('input[type=file][aria-label="PDF to attach"]').setInputFiles(pdfPath);
  await R.locator('.nb-attached').waitFor();
  await R.locator('.toggle-row', { hasText: 'Everyone in the office' }).click();
  await R.locator('.nb-aud-set').getByText('Piping', { exact: true }).click();
  await R.locator('.nb-aud-set').getByText('Drafting', { exact: true }).click();
  await R.locator('.toggle-row', { hasText: 'Ask readers to acknowledge' }).click();
  await R.getByRole('button', { name: 'Add a check question' }).click();
  await R.getByLabel('Check question 1').fill('How many days of earned leave a year?');
  await R.getByLabel('Answer 1', { exact: true }).fill('12');
  await R.getByLabel('Answer 2', { exact: true }).fill('18');
  await R.getByLabel('Answer 2 is right').check();
  const count = await R.locator('.nb-num', { hasText: '04' }).innerText();
  assert.match(count, /\d+ people now/i);
  await sleep(200);
  await pair(R, '02-composer');
  await R.getByRole('button', { name: 'Preview' }).click();
  await R.locator('.nb-preview-bar').waitFor();
  await R.locator('.nb-pdf .pdfv-inline').waitFor({ timeout: 15000 });
  await sleep(1200);
  await pair(R, '03-composer-preview');
  await R.getByRole('button', { name: 'Back to the draft' }).click();
  const issueAt = new Date(Date.now() + 2 * 3600_000);
  issueAt.setSeconds(0, 0);
  const local = `${issueAt.getFullYear()}-${String(issueAt.getMonth() + 1).padStart(2, '0')}-${String(issueAt.getDate()).padStart(2, '0')}T${String(issueAt.getHours()).padStart(2, '0')}:${String(issueAt.getMinutes()).padStart(2, '0')}`;
  await R.getByRole('button', { name: 'Schedule…' }).click();
  await R.getByLabel('Issue on').fill(local);
  await R.getByRole('button', { name: 'Schedule', exact: true }).click();
  await R.getByText(/^Scheduled for/).waitFor();
  await R.locator('.nb-table .nb-row', { hasText: 'Leave policy 2026' }).waitFor();
  await snap(R, '04-desk-table-scheduled-light');
  let reg = (await owner.request('notices.list')).notices.find((n: any) => n.title === 'Leave policy 2026');
  assert.equal(reg.status, 'scheduled');
  assert.equal(reg.number, null);
  assert.equal((await K.evaluate(() => window.dex.request('notices.list'))).notices.length, 0, 'not on the readers’ board yet');

  // ---------------------------------------------------------------- 3. it issues on time
  console.log('step 3: it issues on time');
  clock(issueAt.getTime() + 60_000);
  reg = (await owner.request('notices.list')).notices.find((n: any) => n.title === 'Leave policy 2026');
  assert.equal(reg.status, 'issued');
  assert.equal(reg.number, 'HR-POL-0001');
  const noticeId = reg.id;

  // ---------------------------------------------------------------- 4. Karthik sees it in Pulse and acknowledges it
  console.log('step 4: Karthik sees it in Pulse and acknowledges it');
  await lens(K, 'Pulse');
  await K.locator('.nb-pulse-rows .pulse-row', { hasText: 'Leave policy 2026' }).waitFor({ timeout: 10000 });
  assert.equal(await K.locator('nav.lens-bar .lens', { hasText: 'Notices' }).locator('.badge').innerText(), '1', 'an amber count on the lens');
  await sleep(300);
  await pair(K, '05-pulse-needs-you');
  await K.locator('.nb-pulse-rows .pulse-row', { hasText: 'Leave policy 2026' }).click();
  await K.locator('.nb-sheet .nb-tb').waitFor();
  await K.locator('.nb-sheet .pdfv-inline .pdfv-page').first().waitFor({ timeout: 20000 });
  await sleep(1500);
  await pair(K, '06-reading-sheet');
  await K.locator('.nb-ack').scrollIntoViewIfNeeded();
  await K.locator('.nb-check').getByText('18', { exact: true }).click();
  await K.locator('.nb-sure input').check();
  await K.getByRole('button', { name: 'Acknowledge', exact: true }).click();
  await K.locator('.nb-stamp.landing').waitFor();
  await K.locator('.nb-tb').scrollIntoViewIfNeeded();
  await sleep(500);
  await pair(K, '07-acknowledged-stamp');
  const kv = await K.evaluate((nid: string) => window.dex.request('notices.get', { id: nid }), noticeId);
  assert.equal(kv.acked, true);
  await K.keyboard.press('Escape');

  // ---------------------------------------------------------------- 5. the acknowledgement register fills live
  console.log('step 5: the acknowledgement register fills live');
  await lens(R, 'Notices');
  await R.locator('.nb-row', { hasText: 'Leave policy 2026' }).first().click();
  await R.getByRole('tab', { name: /Acknowledgements/ }).click();
  await R.locator('.nb-acks').waitFor();
  const done = () => R.locator('.nb-cellp.done').count();
  assert.equal(await done(), 1);
  await ravi.request('notices.ack', { id: noticeId, answers: [1] });
  await R.waitForFunction(() => document.querySelectorAll('.nb-cellp.done').length === 2, null, { timeout: 8000 });
  await manoj.request('notices.ack', { id: noticeId, answers: [1] });
  await R.waitForFunction(() => document.querySelectorAll('.nb-cellp.done').length === 3, null, { timeout: 8000 });
  await sleep(400);
  await pair(R, '08-ack-register');
  const chart = await owner.request('notices.acks', { id: noticeId });
  assert.equal(chart.done, 3);
  assert.ok(chart.departments.some((d: any) => d.name === 'Piping') && chart.departments.some((d: any) => d.name === 'Drafting'));

  // ---------------------------------------------------------------- 6. Rev B with a change note, asking again
  console.log('step 6: Rev B with a change note, asking again');
  await R.getByRole('tab', { name: /^Notice/ }).click();
  await R.getByRole('button', { name: /Revise \(Rev B\)/ }).click();
  await R.locator('.nb-compose').waitFor();
  await R.getByLabel('The notice', { exact: true }).fill('Earned leave is 18 days a year, credited monthly.\n\nCarry forward is up to 45 days, and unused leave beyond that is encashed in April.\n\nApply for leave in the HR portal at least a week ahead.');
  await R.getByLabel('What changed').fill('Carry forward raised from 30 to 45 days; encashment in April.');
  await R.locator('.toggle-row', { hasText: 'Ask everyone to acknowledge again' }).click();
  await R.getByRole('button', { name: 'Add a check question' }).click();
  await R.getByLabel('Check question 1').fill('How many days carry forward?');
  await R.getByLabel('Answer 1', { exact: true }).fill('30');
  await R.getByLabel('Answer 2', { exact: true }).fill('45');
  await R.getByLabel('Answer 2 is right').check();
  await R.getByRole('button', { name: 'Issue Rev B' }).click();
  await R.locator('.confirm-actions').getByRole('button', { name: 'Issue now' }).click();
  await R.locator('.nb-sheet .nb-change').waitFor();
  const rb = await owner.request('notices.get', { id: noticeId });
  assert.equal(rb.rev, 'B');
  assert.deepEqual(rb.revisions.map((x: any) => [x.rev, x.status]), [['B', 'issued'], ['A', 'superseded']]);
  assert.deepEqual(rb.current.changed, [1]);
  await R.keyboard.press('Escape');
  await lens(K, 'Pulse');
  await K.locator('.nb-pulse-rows .pulse-row', { hasText: 'Leave policy 2026' }).waitFor({ timeout: 10000 });
  await K.locator('.nb-pulse-rows .pulse-row', { hasText: 'Leave policy 2026' }).click();
  await K.locator('.nb-sheet .nb-cloud').waitFor();
  await K.locator('.nb-sheet .nb-change').scrollIntoViewIfNeeded();
  await sleep(600);
  await pair(K, '09-rev-b-cloud');
  await K.locator('.nb-check').getByText('45', { exact: true }).click();
  await K.locator('.nb-sure input').check();
  await K.getByRole('button', { name: 'Acknowledge', exact: true }).click();
  await K.locator('.nb-stamp').waitFor();
  assert.equal((await K.evaluate((nid: string) => window.dex.request('notices.get', { id: nid }), noticeId)).ackedRev, 'B');
  await K.keyboard.press('Escape');

  // ---------------------------------------------------------------- 7. search finds it by the PDF's text
  console.log('step 7: search finds it by the PDFs text');
  await lens(K, 'Notices');
  await K.locator('.nb-view').waitFor();
  await K.getByRole('searchbox', { name: 'Search notices and their PDFs' }).fill('encashment');
  await K.locator('.nb-hit', { hasText: 'Leave policy 2026' }).waitFor({ timeout: 8000 });
  await K.locator('.nb-hit .chip', { hasText: 'In the PDF' }).first().waitFor().catch(() => {});
  const hits = await K.evaluate(() => window.dex.request('notices.search', { q: 'service encashment' }));
  assert.equal(hits.hits[0]?.where, 'pdf', 'found inside the PDF');
  await sleep(300);
  await pair(K, '10-search-pdf-text');
  await K.getByRole('searchbox', { name: 'Search notices and their PDFs' }).fill('');

  // ---------------------------------------------------------------- 8. an urgent IT notice: a banner, once
  console.log('step 8: an urgent IT notice: a banner, once');
  const itDesk = desks.find((d: any) => d.code === 'IT');
  const urgent = await B.evaluate(async (deskId: string) => {
    const v = await window.dex.request('notices.save', { deskId, category: 'it', title: 'Mail server down until 3 pm', body: 'Outlook cannot send or receive. Use Dexterity Connect for anything urgent; IT will post here when mail is back.', audience: { everyone: true, departments: [], roles: [], locations: [], people: [] }, ackRequired: false, urgent: true });
    return window.dex.request('notices.issue', { id: v.id });
  }, itDesk.id);
  assert.equal(urgent.number, 'IT-ITA-0001');
  await K.locator('.nb-banner', { hasText: 'Mail server down' }).waitFor({ timeout: 10000 });
  await sleep(300);
  await pair(K, '11-urgent-banner');
  await K.locator('.nb-banner').getByRole('button', { name: 'Dismiss' }).click();
  await K.locator('.nb-banner').waitFor({ state: 'detached' });
  await K.reload(); await K.locator('.frame').waitFor();
  await sleep(1500);
  assert.equal(await K.locator('.nb-banner').count(), 0, 'once dismissed, it does not come back');

  // ---------------------------------------------------------------- 9. this week, then expiry archives a notice
  console.log('step 9: this week, then expiry archives a notice');
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const hol = await R.evaluate(async ({ deskId, at, until }: { deskId: string; at: number; until: number }) => {
    const v = await window.dex.request('notices.save', { deskId, category: 'holiday', title: 'Office closed for Guru Nanak Jayanti', body: 'The office is closed. Site teams follow the client’s calendar.', audience: { everyone: true, departments: [], roles: [], locations: [], people: [] }, ackRequired: false, effectiveAt: at, expiresAt: until });
    return window.dex.request('notices.issue', { id: v.id });
  }, { deskId: hrDesk.id, at: today.getTime() + 12 * 3600_000, until: today.getTime() + 36 * 3600_000 });
  await lens(K, 'Pulse');
  await K.locator('.nb-week .nb-day-item', { hasText: 'Guru Nanak' }).waitFor({ timeout: 10000 });
  await K.locator('.nb-week').scrollIntoViewIfNeeded();
  await sleep(300);
  await pair(K, '12-pulse-this-week');
  clock(today.getTime() + 4 * 86400_000 + 9 * 3600_000);
  assert.equal((await owner.request('notices.get', { id: hol.id })).status, 'expired');
  await lens(K, 'Notices');
  await K.getByRole('button', { name: 'Archive' }).click();
  await K.locator('.nb-row', { hasText: 'Guru Nanak' }).waitFor({ timeout: 8000 });
  await sleep(300);
  await pair(K, '13-archive');
  await K.getByRole('button', { name: 'Archive' }).click();
  await K.locator('.nb-shelf .nb-stack').first().waitFor();
  await pair(K, '14-board');

  // ---------------------------------------------------------------- 10. on a phone (390 px)
  console.log('step 10: on a phone (390 px)');
  await K.setViewportSize({ width: 390, height: 844 });
  await sleep(500);
  await snap(K, '15-phone-board-light');
  await K.locator('nav.lens-dock').getByRole('button', { name: /Pulse/ }).click();
  await K.locator('.nb-week').scrollIntoViewIfNeeded();
  await sleep(300);
  await pair(K, '16-phone-pulse');
  await K.locator('.nb-week-open').click();
  await K.locator('.nb-view').waitFor();
  await K.locator('.nb-row', { hasText: 'Leave policy 2026' }).first().click();
  await K.locator('.nb-sheet .nb-tb').waitFor();
  await sleep(1200);
  await pair(K, '17-phone-sheet');
  await K.keyboard.press('Escape');
  await K.setViewportSize({ width: 1440, height: 900 });

  // ---------------------------------------------------------------- 11. Hindi
  console.log('step 11: Hindi');
  await K.evaluate(() => { localStorage.setItem('dex.language', 'hi'); });
  await K.reload(); await K.locator('.frame').waitFor();
  await K.locator('nav.lens-bar .lens').last().click();
  await K.locator('.nb-view').waitFor();
  await sleep(600);
  await snap(K, '18-hindi-board-light');
  await K.locator('.nb-row', { hasText: 'Leave policy 2026' }).first().click();
  await K.locator('.nb-sheet .nb-tb').waitFor();
  await sleep(800);
  await snap(K, '19-hindi-sheet-light');
  const heading = await K.locator('.nb-head h1').innerText().catch(() => '');
  await K.keyboard.press('Escape');
  await K.evaluate(() => { localStorage.setItem('dex.language', 'en'); });
  assert.notEqual(heading, 'Notice board', 'the board is translated');

  console.log('NOTICES E2E PASSED');
} finally {
  for (const c of extra) { try { c.disconnect(); } catch { /* gone */ } }
  for (const a of apps) await a.close().catch(() => {});
  await hub.stop().catch(() => {});
}
process.exit(0);
