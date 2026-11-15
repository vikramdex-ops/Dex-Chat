// End to end: two tracked bots made from templates and used between three colleagues.
//  1. Priya makes "Drawing check and issue" from its template, names Vikram as document control
//     (Meena) in Afterwards, plays every part in the test run, and shares it with the Piping desk Space.
//  2. She sends drawings for checking; Ravi gets the request card with its checklist, returns it
//     with comments; Priya's own card follows live; she corrects it; Ravi back-checks; Meena (their
//     lead, and document control) approves and issues it on a transmittal. Priya asks for the
//     register; Meena asks for hers and opens a request in it.
//  3. Priya makes "Software seat" and takes the only CAESAR II seat; Ravi waits in line, sees his
//     place and who holds it, and moves up live when she releases it.
// Screenshots at 1440 and 390 px, light and dark, and in Hindi.
import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep } from './harness.mts';

const { owner, hub } = await startOffice('templates');
let priya = await launch('priya', 'Priya Raman', { width: 1440, height: 900 });
let ravi: Awaited<ReturnType<typeof launch>> | null = null;
let vikram: Awaited<ReturnType<typeof launch>> | null = null;
const theme = async (page: any, t: string) => { await page.evaluate((x: string) => window.dex.setSettings({ theme: x as 'light' }), t); await sleep(450); };
const both = async (page: any, name: string) => { for (const t of ['light', 'dark']) { await theme(page, t); await shot(page, `${name}-${t}`); } await theme(page, 'light'); };
const day = (n: number) => { const t = new Date(Date.now() + n * 86400_000); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };
const scrollEnd = async (page: any) => { await page.evaluate(() => document.querySelectorAll('.timeline').forEach((t) => { t.scrollTop = t.scrollHeight; })); await sleep(300); };
try {
  const users = () => owner.request('directory.list').then((r: any) => r.users);
  const priyaId = (await users()).find((u: any) => u.account.endsWith('priya'))!.id;
  ravi = await launch('ravi', 'Ravi Kumar', { width: 1440, height: 900 });
  const raviId = (await users()).find((u: any) => u.account.endsWith('ravi'))!.id;
  vikram = await launch('meena', 'Meena Iyer', { width: 1440, height: 900 });
  const meenaId = (await users()).find((u: any) => u.account.endsWith('meena'))!.id;
  // the directory: Meena leads Priya and Ravi
  await owner.request('admin.org.setProfile', { userId: priyaId, managerId: meenaId, title: 'Piping designer' });
  await owner.request('admin.org.setProfile', { userId: raviId, managerId: meenaId, title: 'Piping checker' });
  await owner.request('admin.org.setProfile', { userId: meenaId, title: 'Piping lead' });
  await owner.request('conv.create', { kind: 'space', name: 'Piping desk', members: [priyaId, raviId, meenaId] });
  await owner.request('conv.create', { kind: 'space', name: 'P-12513 Refinery revamp', members: [priyaId, raviId] });
  const P = priya.page;
  const R = ravi.page;
  await P.reload(); await P.locator('.frame').waitFor();

  // ------------------------------------------------------------ 1. the template, Afterwards, the test run
  await P.getByRole('button', { name: /^Desk/ }).first().click();
  await P.getByRole('tab', { name: 'Bots' }).click();
  await P.locator('.mybots-empty').getByRole('button', { name: 'Make a bot' }).click();
  await P.locator('.bm-start').waitFor({ timeout: 10000 });
  await P.locator('.bm-template', { hasText: 'Drawing check and issue' }).hover();
  await P.locator('.bm-template-track').first().waitFor();
  await both(P, 'tp-01-templates-1440');
  await P.getByRole('button', { name: 'Start from Drawing check and issue' }).click();
  await P.locator('.bm-steps').waitFor();
  await P.getByRole('tab', { name: /Afterwards/ }).click();
  await P.locator('.bm-stages').waitFor();
  await P.getByLabel('Who is Document control').selectOption({ label: 'Meena Iyer' });
  await P.locator('#bm-stage-check .bm-step-head').click();
  await P.locator('#bm-stage-check-edit').waitFor();
  await both(P, 'tp-02-afterwards-1440');

  // the test run: Priya plays every part
  const pv = () => P.locator('.bm-preview .flow-card.step.active');
  await P.getByRole('button', { name: 'Test run' }).click();
  await pv().getByLabel('Your answer').fill('P-12513');
  await pv().getByRole('button', { name: 'Next' }).click();
  await pv().getByLabel('Your answer').fill('ISO-1001-01\nISO-1001-02');
  await pv().getByRole('button', { name: 'Next' }).click();
  await pv().locator('.flow-quick-btn', { hasText: 'C' }).click();
  await pv().getByRole('button', { name: 'Construction (IFC)' }).click();
  await pv().getByLabel('Search for a person').fill('Ravi');
  await pv().locator('.flow-person-row', { hasText: 'Ravi Kumar' }).click();
  await pv().getByRole('button', { name: 'Skip' }).click();
  await pv().getByLabel('Your answer').fill(day(3));
  await pv().getByRole('button', { name: 'Next' }).click();
  await pv().getByRole('button', { name: 'Send for check' }).click();
  const tc = P.locator('.bm-preview .flow-card.done.track');
  await tc.waitFor({ timeout: 8000 });
  assert.match(await tc.innerText(), /DC-0001/);
  assert.match(await tc.innerText(), /Trying it as: Checker/i);
  for (const box of await tc.locator('.trk-check input').all()) await box.check();
  await tc.getByRole('button', { name: 'Checked, no comments' }).click();
  await tc.locator('.trk-cell.here', { hasText: 'Approve' }).waitFor({ timeout: 5000 });
  await both(P, 'tp-03-test-run-plays-each-part-1440');

  // share with the Space and save
  await P.getByRole('tab', { name: /Sharing/ }).click();
  await P.getByRole('radio', { name: /A Space/ }).click();
  await P.getByLabel('Which Space').selectOption({ label: 'Piping desk' });
  await P.getByRole('button', { name: 'Save bot' }).click();
  await P.locator('.toast', { hasText: 'shared with Piping desk' }).waitFor({ timeout: 8000 });
  await P.getByRole('button', { name: 'Close' }).first().click();


  // ------------------------------------------------------------ 2. Priya sends drawings to be checked
  await P.getByRole('button', { name: /^Spaces/ }).first().click();
  await P.locator('.sb-row', { hasText: 'Piping desk' }).first().click({ timeout: 15000 });
  const offer = P.locator('.flow-card', { hasText: 'Drawing check and issue' }).last();
  await offer.waitFor({ timeout: 15000 });
  await offer.getByRole('button', { name: 'Start' }).click();
  const card = () => P.locator('.flow-card.step.active');
  await card().waitFor({ timeout: 15000 });
  // job numbers from her Spaces, one tap
  await card().locator('.flow-quick-btn', { hasText: 'P-12513' }).waitFor({ timeout: 8000 });
  await shot(P, 'tp-04-job-from-spaces-1440-light');
  await card().locator('.flow-quick-btn', { hasText: 'P-12513' }).click();
  await card().locator('.flow-q', { hasText: 'Which drawings' }).waitFor();
  await card().getByLabel('Your answer').fill('ISO-1001-01\nISO-1001-02');
  await card().getByRole('button', { name: 'Next' }).click();
  await card().locator('.flow-quick-btn', { hasText: 'C' }).click();
  await card().getByRole('button', { name: 'Construction (IFC)' }).click();
  await card().getByLabel('Search for a person').fill('Ravi');
  await card().locator('.flow-person-row', { hasText: 'Ravi Kumar' }).click();
  await card().getByRole('button', { name: 'Skip' }).click();
  await card().getByLabel('Your answer').fill(day(3));
  await card().getByRole('button', { name: 'Next' }).click();
  await card().getByRole('button', { name: 'Send for check' }).click();
  const mine = P.locator('.flow-card.done.track').last();
  await mine.waitFor({ timeout: 10000 });
  assert.match(await mine.innerText(), /With Ravi Kumar to check/);
  assert.match(await mine.innerText(), /With Ravi Kumar/);
  await scrollEnd(P);
  await both(P, 'tp-05-priya-sent-1440');

  // Ravi: the request card with the checklist
  await R.reload(); await R.locator('.frame').waitFor();
  await R.getByRole('button', { name: /^Direct/ }).first().click();
  await R.locator('.sb-row', { hasText: 'Drawing check and issue' }).first().click({ timeout: 15000 });
  const rc = () => R.locator('.flow-card.track.acting').last();
  await rc().waitFor({ timeout: 15000 });
  assert.match(await rc().innerText(), /Waiting for you/i);
  await scrollEnd(R);
  await both(R, 'tp-06-ravi-checks-1440');
  // returned with comments
  await rc().getByRole('button', { name: 'Return with comments' }).click();
  await rc().getByLabel('Comments').fill('Tag 101-P-02 is missing on ISO-1001-02, and the BOM still shows rev B.');
  await shot(R, 'tp-07-ravi-comments-1440-light');
  await rc().locator('.trk-note').getByRole('button', { name: 'Return with comments' }).click();
  await R.locator('.flow-card.track').last().locator('.trk-holder', { hasText: 'With Priya Raman' }).waitFor({ timeout: 8000 });

  // Priya's own card followed it live; a card asks her to correct
  await mine.locator('.trk-cell.returned', { hasText: 'Check' }).waitFor({ timeout: 8000 });
  const fix = P.locator('.flow-card.track.acting').last();
  await fix.waitFor({ timeout: 8000 });
  assert.match(await fix.innerText(), /Tag 101-P-02 is missing/);
  await scrollEnd(P);
  await both(P, 'tp-08-priya-returned-live-1440');
  await fix.getByRole('button', { name: 'Corrected, send for back-check' }).click();
  await fix.getByLabel('What changed').fill('Tag added; BOM at rev C.');
  await fix.locator('.trk-note').getByRole('button', { name: 'Corrected, send for back-check' }).click();

  // Ravi: the back-check (round 2), his first card folded
  await R.locator('.flow-card.track.acting', { hasText: 'Round 2' }).waitFor({ timeout: 10000 });
  await R.locator('.flow-card.track.moved').first().waitFor();
  const back = R.locator('.flow-card.track.acting').last();
  for (const box of await back.locator('.trk-check input').all()) { await box.check(); await sleep(120); }
  await back.getByRole('button', { name: 'Checked, no comments' }).click();
  await R.locator('.flow-card.track').last().locator('.trk-cell.here', { hasText: 'Approve' }).waitFor({ timeout: 8000 });
  console.log('CHECKED AND BACK-CHECKED');

  // Meena (their lead from the directory) approves, then issues it as document control
  const V = vikram.page;
  await V.reload(); await V.locator('.frame').waitFor();
  await V.getByRole('button', { name: /^Direct/ }).first().click();
  await V.locator('.sb-row', { hasText: 'Drawing check and issue' }).first().click({ timeout: 15000 });
  const mc = () => V.locator('.flow-card.track.acting').last();
  await mc().getByRole('button', { name: 'Approve for issue' }).click({ timeout: 15000 });
  await V.locator('.flow-card.track.acting', { hasText: 'Issued on transmittal' }).last().waitFor({ timeout: 10000 });
  await mc().getByRole('button', { name: 'Issued on transmittal' }).click();
  await mc().getByLabel('Transmittal number').fill('DDS-P12513-TR-0412');
  await scrollEnd(V);
  await shot(V, 'tp-09a-meena-issues-1440-light');
  await mc().locator('.trk-note').getByRole('button', { name: 'Issued on transmittal' }).click();
  await mine.locator('.trk-cell.here', { hasText: 'Client receipt' }).waitFor({ timeout: 8000 });
  await scrollEnd(P);
  await both(P, 'tp-09-priya-issued-live-1440');

  // Priya asks for the register in the bot's conversation
  const dock = P.locator('.dock textarea').first();
  await dock.fill('register');
  await dock.press('Enter');
  const reg = P.locator('.flow-card.register').last();
  await reg.waitFor({ timeout: 10000 });
  assert.match(await reg.innerText(), /DC-0001/);
  await scrollEnd(P);
  await both(P, 'tp-10-register-priya-1440');
  // the lead's digest: Meena asks for the register in her conversation with the bot
  const vdock = V.locator('.dock textarea').first();
  await vdock.fill('register');
  await vdock.press('Enter');
  const vreg = V.locator('.flow-card.register').last();
  await vreg.waitFor({ timeout: 10000 });
  await scrollEnd(V);
  await both(V, 'tp-11-digest-vikram-1440');

  // ------------------------------------------------------------ 3. software seats between Priya and Ravi
  await P.getByRole('button', { name: /^Desk/ }).first().click();
  await P.getByRole('tab', { name: 'Bots' }).click();
  await P.getByRole('button', { name: 'Make a bot' }).first().click();
  await P.getByRole('button', { name: 'Start from Software seat' }).click();
  await P.locator('.bm-steps').waitFor();
  await P.getByRole('tab', { name: /Sharing/ }).click();
  await P.getByRole('radio', { name: /A Space/ }).click();
  await P.getByLabel('Which Space').selectOption({ label: 'Piping desk' });
  await P.getByRole('button', { name: 'Save bot' }).click();
  await P.locator('.toast', { hasText: 'shared with Piping desk' }).waitFor({ timeout: 8000 });
  await P.getByRole('button', { name: 'Close' }).first().click();
  const seatName = (await priya.page.evaluate(() => window.dex.request('botflow.mine'))).find((b: any) => b.title === 'Software seat').name;
  const take = async (page: any, job: string) => {
    await page.getByRole('button', { name: /^Spaces/ }).first().click();
    await page.locator('.sb-row', { hasText: 'Piping desk' }).first().click({ timeout: 15000 });
    const o = page.locator('.flow-card:has(.flow-list)', { hasText: 'Software seat' }).last();
    await o.waitFor({ timeout: 15000 });
    await o.getByRole('button', { name: 'Start' }).click();
    const c = () => page.locator('.flow-card.step.active');
    await c().getByRole('button', { name: 'CAESAR II' }).click({ timeout: 15000 });
    await c().getByLabel('Your answer').fill(job);
    await c().getByRole('button', { name: 'Next' }).click();
    const d = page.locator('.flow-card.done.track').last();
    await d.waitFor({ timeout: 10000 });
    return d;
  };
  const pSeat = await take(P, 'P-12513');
  assert.match(await pSeat.innerText(), /Release the seat/);
  const rSeat = await take(R, 'P-20410');
  await rSeat.locator('.chip', { hasText: 'In line for CAESAR II: place 1 of 1' }).waitFor({ timeout: 8000 });
  assert.match(await rSeat.innerText(), /Held by Priya Raman/);
  await scrollEnd(R);
  await both(R, 'tp-12-ravi-waits-for-seat-1440');
  await scrollEnd(P);
  await shot(P, 'tp-13-priya-asked-to-release-1440-light');
  await pSeat.getByRole('button', { name: 'Release the seat' }).click();
  await R.locator('.flow-card.track.acting', { hasText: 'Release the seat' }).last().waitFor({ timeout: 10000 });
  await rSeat.locator('.trk-cell.here').waitFor({ timeout: 8000 });
  await scrollEnd(R);
  await both(R, 'tp-14-ravi-seat-is-his-1440');
  // who has one now
  const seats = (await ravi.page.evaluate((n: string) => window.dex.request('botflow.register', { flow: n }), seatName)).register.seats.find((s: any) => s.key === 'CAESAR II');
  assert.equal(seats.used[0].userId, raviId);
  console.log('SEATS MOVED UP');

  // ------------------------------------------------------------ phones, and Hindi
  await R.setViewportSize({ width: 390, height: 844 }); await sleep(700);
  await scrollEnd(R);
  await both(R, 'tp-15-seat-card-390');
  await V.setViewportSize({ width: 390, height: 844 }); await sleep(700);
  await scrollEnd(V);
  await V.locator('.flow-card.register .reg-row-head').first().click();
  await sleep(300);
  await both(V, 'tp-16-digest-drill-down-390');
  await P.getByRole('button', { name: /^Direct/ }).first().click();
  await P.locator('.sb-row', { hasText: 'Drawing check and issue' }).first().click({ timeout: 15000 });
  await P.locator('.flow-card.done.track').last().waitFor({ timeout: 10000 });
  await P.setViewportSize({ width: 390, height: 844 }); await sleep(700);
  await scrollEnd(P);
  await both(P, 'tp-17-request-card-390');
  await P.setViewportSize({ width: 1440, height: 900 }); await sleep(400);
  for (const lang of ['hi', 'ta']) {
    await P.evaluate((l: string) => { localStorage.setItem('dex.language', l); }, lang);
    await P.reload(); await P.locator('.frame').waitFor();
    await P.locator('.lens').nth(1).click().catch(() => {});
    await P.locator('.sb-row', { hasText: 'Drawing check and issue' }).first().click({ timeout: 15000 });
    await P.locator('.flow-card.done.track').last().waitFor({ timeout: 10000 });
    await sleep(500);
    await scrollEnd(P);
    await shot(P, `tp-18-request-card-${lang}-1440-light`);
  }
  await P.evaluate(() => { localStorage.setItem('dex.language', 'en'); });
  console.log('TEMPLATES E2E PASSED');
} catch (e) {
  await shot(priya.page, 'tp-FAIL-priya').catch(() => {});
  if (ravi) await shot(ravi.page, 'tp-FAIL-ravi').catch(() => {});
  if (vikram) await shot(vikram.page, 'tp-FAIL-vikram').catch(() => {});
  throw e;
} finally {
  await priya.app.close().catch(() => {});
  await ravi?.app.close().catch(() => {});
  await vikram?.app.close().catch(() => {});
  owner.disconnect();
  await hub.stop();
}
