// End to end: Priya makes her own bot from the Plot request template on her Desk, gives it its own
// name, symbol, colour and a warm voice, test-runs it beside the editor (nothing is sent), shares it
// with the Piping desk Space and saves it. Ravi starts it from the card in the Space, answers it in
// his conversation with the bot, and the task lands on Priya's Desk. Priya reads the bot's page.
// Screenshots at 1440 and 390 px, light and dark.
import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep } from './harness.mts';

const { owner, hub } = await startOffice('botmaker');
let priya = await launch('priya', 'Priya Raman', { width: 1440, height: 900 });
let ravi: Awaited<ReturnType<typeof launch>> | null = null;
const theme = async (page: any, t: string) => { await page.evaluate((x: string) => window.dex.setSettings({ theme: x as 'light' }), t); await sleep(450); };
const both = async (page: any, name: string) => { for (const t of ['light', 'dark']) { await theme(page, t); await shot(page, `${name}-${t}`); } await theme(page, 'light'); };
const pv = (page: any) => page.locator('.bm-preview .flow-card.step.active');
try {
  const users = (await owner.request('directory.list')).users;
  const priyaId = users.find((u: any) => u.account.endsWith('priya'))!.id;
  ravi = await launch('ravi', 'Ravi Kumar', { width: 1440, height: 900 });
  const raviId = (await owner.request('directory.list')).users.find((u: any) => u.account.endsWith('ravi'))!.id;
  await owner.request('conv.create', { kind: 'space', name: 'Piping desk', members: [priyaId, raviId] });
  await priya.page.reload(); await priya.page.locator('.frame').waitFor();

  // ------------------------------------------------------------ Desk → Bots → Make a bot
  const P = priya.page;
  await P.getByRole('button', { name: /^Desk/ }).first().click();
  await P.getByRole('tab', { name: 'Bots' }).click();
  await P.locator('.mybots-empty').waitFor({ timeout: 8000 });
  await both(P, 'bm-01-desk-empty-1440');
  await P.locator('.mybots-empty').getByRole('button', { name: 'Make a bot' }).click();
  await P.locator('.bm-start').waitFor({ timeout: 10000 });
  await P.locator('.bm-template', { hasText: 'Plot request' }).hover();
  await P.locator('.bm-preview .flow-card').first().waitFor({ timeout: 8000 });
  await both(P, 'bm-02-start-templates-1440');
  // describe in words (keyword fallback is fine in the harness)
  await P.getByRole('button', { name: /Describe it in words/ }).click();
  await P.getByLabel(/What should it do/).fill('A friendly bot for site visit bookings. Ask which site (Refinery, Pump house or Depot), which day, how many people and who hosts us. Confirm, then put a task on their Desk.');
  await P.getByRole('button', { name: 'Draft my bot' }).click();
  await P.locator('.bm-steps').waitFor({ timeout: 60000 });
  await shot(P, 'bm-03-drafted-from-words-1440-light');
  const drafted = await P.locator('.bm-step').count();
  assert.ok(drafted >= 4, `drafted ${drafted} steps`);
  // back to the start: close (discarding) and use the template instead
  await P.getByRole('button', { name: 'Close' }).first().click();
  await P.getByRole('button', { name: 'Leave' }).click();
  await P.locator('.mybots-empty').getByRole('button', { name: 'Make a bot' }).click();
  await P.getByRole('button', { name: 'Start from Plot request' }).click();
  await P.locator('.bm-steps').waitFor();

  // ------------------------------------------------------------ personalise
  await P.getByRole('tab', { name: /Identity/ }).click();
  await P.getByLabel('Name', { exact: true }).fill('Plot desk');
  await P.getByRole('button', { name: 'Plotter' }).click();
  await P.getByRole('button', { name: 'Ochre' }).click();
  await P.locator('.bm-tone', { hasText: 'Warm' }).click();
  await P.getByLabel(/Greeting/).fill('Hi {{user.first}}! Plot desk here: a few quick questions and it is with your lead.');
  await sleep(300);
  assert.match(await P.locator('.bm-preview .flow-intro').innerText(), /Hi Priya! Plot desk here/);
  await both(P, 'bm-04-identity-1440');

  // ------------------------------------------------------------ the questions, a problem shown beside its step
  await P.getByRole('tab', { name: /Questions/ }).click();
  await P.locator('#bm-step-sets .bm-step-head').click();
  const q = P.locator('#bm-step-sets-edit').getByLabel('What the bot asks');
  await q.fill('');
  await P.locator('#bm-step-sets .bm-problem', { hasText: 'Write the question.' }).waitFor({ timeout: 5000 });
  await shot(P, 'bm-05-problem-beside-step-1440-light');
  await q.fill('How many sets? Usually one for checking.');
  await P.locator('#bm-step-sets .bm-problem').waitFor({ state: 'detached', timeout: 5000 });
  await both(P, 'bm-06-questions-1440');

  // ------------------------------------------------------------ test run with the real cards
  await P.getByRole('button', { name: 'Test run' }).click();
  await pv(P).getByLabel('Your answer').fill('twelve');
  await pv(P).getByRole('button', { name: 'Next' }).click();
  await P.locator('.bm-preview .flow-err', { hasText: 'job number' }).waitFor({ timeout: 5000 });
  await pv(P).getByLabel('Your answer').fill('P-12513');
  await pv(P).getByRole('button', { name: 'Next' }).click();
  await pv(P).locator('.flow-q', { hasText: 'Which drawings' }).waitFor();
  await pv(P).getByLabel('Your answer').fill('ISO-1001-01 rev C');
  await pv(P).getByRole('button', { name: 'Next' }).click();
  await pv(P).getByRole('button', { name: 'A1', exact: true }).click();
  await pv(P).locator('.flow-quick-btn', { hasText: '2' }).click();
  await pv(P).locator('.flow-q', { hasText: 'When do you need them' }).waitFor();
  await both(P, 'bm-07-test-run-1440');

  // ------------------------------------------------------------ share with the Space, save
  await P.getByRole('tab', { name: /Sharing/ }).click();
  await P.getByRole('radio', { name: /A Space/ }).click();
  await P.getByLabel('Which Space').selectOption({ label: 'Piping desk' });
  await P.getByRole('button', { name: 'Save bot' }).click();
  await P.locator('.toast', { hasText: 'shared with Piping desk' }).waitFor({ timeout: 8000 });
  await both(P, 'bm-08-saved-shared-1440');

  // phone layout of the maker
  await P.setViewportSize({ width: 390, height: 844 }); await sleep(600);
  await P.locator('.bm-phone-switch').getByRole('button', { name: 'Build' }).click();
  await P.getByRole('tab', { name: /Questions/ }).click();
  await both(P, 'bm-09-maker-build-390');
  await P.locator('.bm-phone-switch').getByRole('button', { name: 'Try it' }).click();
  await sleep(300);
  await both(P, 'bm-10-maker-try-390');
  await P.locator('.bm-phone-switch').getByRole('button', { name: 'Build' }).click();
  await P.getByRole('tab', { name: /Identity/ }).click();
  await shot(P, 'bm-11-maker-identity-390-light');
  await P.setViewportSize({ width: 1440, height: 900 }); await sleep(400);
  await P.getByRole('button', { name: 'Close' }).first().click();

  // ------------------------------------------------------------ Ravi starts it from the Space
  const R = ravi.page;
  await R.reload(); await R.locator('.frame').waitFor();
  await R.getByRole('button', { name: /^Spaces/ }).first().click();
  await R.locator('.sb-row', { hasText: 'Piping desk' }).first().click({ timeout: 15000 });
  const offer = R.locator('.flow-card', { hasText: 'Plot desk' }).last();
  await offer.waitFor({ timeout: 15000 });
  await both(R, 'bm-12-offer-in-space-ravi-1440');
  await offer.getByRole('button', { name: 'Start' }).click();
  const card = () => R.locator('.flow-card.step.active');
  await card().waitFor({ timeout: 15000 });
  assert.match(await card().locator('.flow-intro').innerText(), /Hi Ravi! Plot desk here/);
  await card().getByLabel('Your answer').fill('P-20410');
  await card().getByRole('button', { name: 'Next' }).click();
  await card().locator('.flow-q', { hasText: 'Which drawings' }).waitFor();
  await card().getByLabel('Your answer').fill('GA-200 rev B');
  await card().getByRole('button', { name: 'Next' }).click();
  await card().getByRole('button', { name: 'A0', exact: true }).click();
  await card().locator('.flow-quick-btn', { hasText: '1' }).click();
  const t = new Date(Date.now() + 3 * 86400_000);
  await card().getByLabel('Your answer').fill(`${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`);
  await card().getByRole('button', { name: 'Next' }).click();
  await card().getByLabel('Search for a person').fill('Priya');
  await card().locator('.flow-person-row', { hasText: 'Priya Raman' }).click();
  await card().getByRole('button', { name: 'Send for approval' }).waitFor();
  await both(R, 'bm-13-ravi-confirm-1440');
  await card().getByRole('button', { name: 'Send for approval' }).click();
  const done = R.locator('.flow-card.done').last();
  await done.waitFor({ timeout: 10000 });
  assert.match(await done.innerText(), /Sent to Priya Raman/);
  await R.setViewportSize({ width: 390, height: 844 }); await sleep(600);
  await both(R, 'bm-14-ravi-done-390');
  const tasks = await owner.request('admin.audit');
  assert.ok(tasks.some((a: any) => a.action === 'botflow.completed'));
  console.log('RAVI USED IT');

  // ------------------------------------------------------------ Priya: the task, and the bot's page
  await P.getByRole('button', { name: /^Desk/ }).first().click();
  await P.getByRole('tab', { name: 'Bots' }).click();
  await P.locator('.bm-reg-row', { hasText: 'Plot desk' }).waitFor({ timeout: 8000 });
  await both(P, 'bm-15-desk-bots-1440');
  await P.getByRole('button', { name: 'Plot desk: open its page' }).click();
  await P.locator('.bm-numbers').waitFor({ timeout: 8000 });
  assert.match(await P.locator('.bm-numbers').innerText(), /Runs\s*1/i);
  assert.match(await P.locator('.bm-runs').first().innerText(), /Ravi Kumar finished it/);
  await both(P, 'bm-16-bot-page-1440');
  await P.setViewportSize({ width: 390, height: 844 }); await sleep(600);
  await both(P, 'bm-17-bot-page-390');
  await P.setViewportSize({ width: 1440, height: 900 }); await sleep(300);
  // pause it: no one can start it
  await P.getByRole('button', { name: 'Pause' }).click();
  await P.locator('.bm-page-tb .chip', { hasText: 'Paused' }).waitFor({ timeout: 8000 });
  await assert.rejects(owner.request('botflow.start', { flow: 'plot-desk' }), /not available|paused/);
  // office-wide: asked from the maker's Sharing part, reviewed by an administrator in the Control room
  await P.getByRole('button', { name: 'Resume' }).click();
  await P.getByRole('button', { name: 'Share' }).click();
  await P.getByRole('radio', { name: /The whole office/ }).click();
  await P.getByRole('button', { name: 'Save changes' }).click();
  await P.locator('.toast', { hasText: 'An administrator will look' }).waitFor({ timeout: 8000 });
  await P.locator('.bm-review.warn').waitFor();
  await shot(P, 'bm-20-asked-office-1440-light');
  await P.getByRole('button', { name: 'Close' }).first().click();
  await owner.request('admin.setRole', { userId: raviId, role: 'admin' });
  await R.setViewportSize({ width: 1440, height: 900 });
  await R.reload(); await R.locator('.frame').waitFor();
  await R.locator('.me-btn').click();
  await R.getByRole('menuitem', { name: /Control room/ }).click();
  await R.getByRole('button', { name: /^Bots & tools/ }).click();
  const review = R.locator('.bm-review-card', { hasText: 'Plot desk' });
  await review.waitFor({ timeout: 8000 });
  await review.getByLabel(/Note for/).fill('Fine for the whole office.');
  await both(R, 'bm-21-control-review-1440');
  await review.getByRole('button', { name: 'Approve for the office' }).click();
  await review.waitFor({ state: 'detached', timeout: 8000 });
  assert.ok((await owner.request('botflow.list')).some((f: any) => f.name === 'plot-desk'), 'office-wide after approval');
  await R.keyboard.press('Escape');

  // Hindi and Tamil: the Desk register, and the maker's Identity part
  for (const lang of ['hi', 'ta']) {
    await P.evaluate((l: string) => { localStorage.setItem('dex.language', l); }, lang);
    await P.reload(); await P.locator('.frame').waitFor();
    await P.getByRole('button', { name: /^(Desk|डेस्क|மேசை)/ }).first().click().catch(async () => { await P.locator('.lens').nth(3).click(); });
    await sleep(500);
    await P.locator('.sheet-tab').filter({ hasText: /बॉट|பாட்/ }).click();
    await P.locator('.bm-reg-row').first().waitFor({ timeout: 8000 });
    await shot(P, `bm-18-desk-bots-${lang}-1440-light`);
    await P.locator('.bm-reg-actions .btn').first().click();
    await P.locator('.bm-register [role=tab]').first().click();
    await sleep(500);
    await shot(P, `bm-19-maker-identity-${lang}-1440-light`);
    await P.keyboard.press('Escape');
    await sleep(300);
  }
  await P.evaluate(() => { localStorage.setItem('dex.language', 'en'); });
  console.log('BOTMAKER E2E PASSED');
} catch (e) {
  await shot(priya.page, 'bm-FAIL-priya').catch(() => {});
  if (ravi) await shot(ravi.page, 'bm-FAIL-ravi').catch(() => {});
  throw e;
} finally {
  await priya.app.close().catch(() => {});
  await ravi?.app.close().catch(() => {});
  owner.disconnect();
  await hub.stop();
}
