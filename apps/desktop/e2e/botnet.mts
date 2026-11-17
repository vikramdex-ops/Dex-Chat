// End to end: bots talking to bots, and scheduled bot jobs, between colleagues.
//  1. A handoff: Priya's drawing check, once issued, waits on the plot room's bot. The relay card in
//     her conversation draws the two bots as tags with the hop (and its pulse); the stage strip
//     shows the plot room's mark and how its request stands; she collects the plots in the plot
//     room's conversation, and the drawing check carries on by itself: the hop is stamped BACK.
//  2. A query in a flow: Stress check asks Software seat whether a CAESAR II seat is free, and the
//     next question uses the answer ("1 free").
//  3. An event: Priya's Issue watch hears when a drawing check request is issued.
//  4. A refusal: a bot that asks Ravi's private bot cannot be saved.
//  5. A loop: Ping hands to Pong, which hands back; the second hop is stopped.
//  6. Scheduled jobs: Weekly TQ chaser from its template, its schedule rewritten in plain words with
//     the preview of the next runs; a dry run from the job sheet; a run with the hub's clock moved
//     to Monday 10:00; two weeks with the hub off, caught up once; the job sheet.
//  7. The bot network sheet: Priya's bots, then the office's for an administrator, with a live pulse.
// Screenshots at 1440 and 390 px, light and dark, and in Hindi.
import assert from 'node:assert/strict';
import { startOffice, launch, shot, sleep } from './harness.mts';
import { BOT_TEMPLATES } from '../../../packages/core/src/botmaker.ts';
import { nextRuns, officeParts, officeTime, parseSchedule, DEFAULT_CALENDAR } from '../../../packages/core/src/botjobs.ts';

const { owner, hub } = await startOffice('botnet');
let priya = await launch('priya', 'Priya Raman', { width: 1440, height: 900 });
let ravi: Awaited<ReturnType<typeof launch>> | null = null;
const theme = async (page: any, t: string) => { await page.evaluate((x: string) => window.dex.setSettings({ theme: x as 'light' }), t); await sleep(450); };
const both = async (page: any, name: string) => { for (const t of ['light', 'dark']) { await theme(page, t); await shot(page, `${name}-${t}`); } await theme(page, 'light'); };
const day = (n: number) => { const t = new Date(Date.now() + n * 86400_000); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };
const scrollEnd = async (page: any) => { await page.evaluate(() => document.querySelectorAll('.timeline').forEach((t) => { t.scrollTop = t.scrollHeight; })); await sleep(300); };
const tpl = (id: string) => JSON.parse(JSON.stringify(BOT_TEMPLATES.find((t) => t.id === id)!.definition));
const waitFor = async <T,>(fn: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms = 10000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await sleep(50); }
};
const bf = hub.botflows as any;
/** Waits until a locator's text reads as expected (cards are drawn again as the hub refreshes them). */
const sees = async (loc: any, re: RegExp, ms = 10000) => {
  let last = '';
  const end = Date.now() + ms;
  for (;;) {
    last = await loc.innerText({ timeout: 2000 }).catch(() => '');
    if (re.test(last)) return last;
    if (Date.now() > end) throw new assert.AssertionError({ message: `expected ${re} in: ${last}` });
    await sleep(150);
  }
};
try {
  const users = () => owner.request('directory.list').then((r: any) => r.users);
  const priyaId = (await users()).find((u: any) => u.account.endsWith('priya'))!.id;
  ravi = await launch('ravi', 'Ravi Kumar', { width: 1440, height: 900 });
  const raviId = (await users()).find((u: any) => u.account.endsWith('ravi'))!.id;
  const vikramId = owner.session!.me.id;
  const P = priya.page;
  const R = ravi.page;
  const U = (id: string) => hub.store.userById(id)!;
  const as = (id: string, op: string, d: Record<string, unknown> = {}) => bf.handle(op, U(id), d);
  const run = async (id: string, flow: string, answers: Array<[string, string]>) => {
    const r = await as(id, 'botflow.start', { flow });
    for (const [stepId, value] of answers) {
      await waitFor(() => hub.store.db.prepare("SELECT 1 FROM bot_sessions WHERE id = ? AND step = ? AND status = 'active'").get(r.sessionId, stepId));
      await as(id, 'botflow.answer', { sessionId: r.sessionId, stepId, value });
    }
    return r;
  };
  await owner.request('admin.org.setProfile', { userId: priyaId, managerId: vikramId, title: 'Piping designer' });
  await owner.request('admin.org.setProfile', { userId: raviId, managerId: vikramId, title: 'Piping checker' });
  await owner.request('conv.create', { kind: 'space', name: 'Piping desk', members: [priyaId, raviId] });
  // the office's own bots, from the templates: the plot room (Vikram), software seats, TQs
  const plot = tpl('plot-request');
  plot.name = 'plot-room'; plot.title = 'Plot room'; plot.track.roles.plotroom.person = vikramId;
  await owner.request('botflow.make', { definition: plot, scope: 'office' });
  await owner.request('botflow.make', { definition: tpl('licence-seat'), scope: 'office' });
  const tq = tpl('rfi-log');
  tq.track.roles.client.person = vikramId;
  await owner.request('botflow.make', { definition: tq, scope: 'office' });
  await P.reload(); await P.locator('.frame').waitFor();

  // ------------------------------------------------------------ 1. a handoff, with the relay card
  const dc = tpl('drawing-issue');
  dc.track.roles.doccontrol.person = vikramId;
  dc.track.stages.find((s: any) => s.id === 'issue').actions[0].to = 'plot';
  dc.track.stages.splice(4, 0, {
    id: 'plot', label: 'Plot', who: 'bot:plot-room', prompt: 'With the plot room',
    handoff: { to: 'plot-room', start: 'queue', carry: { size: 'A1', sets: '2', drawings: '{{drawings}} rev {{rev}}', due: '{{due.value}}' } },
    actions: [{ id: 'plotted', label: 'Plotted', to: 'receipt', tone: 'go' }, { id: 'none', label: 'Not plotted', to: 'receipt', tone: 'stop' }],
  });
  await as(priyaId, 'botflow.make', { definition: dc, scope: 'private', newBot: true });
  // Issue watch listens for issued drawing checks (event)
  await as(priyaId, 'botflow.make', { scope: 'private', newBot: true, definition: { name: 'issue-watch', title: 'Issue watch', persona: { mark: { kind: 'glyph', glyph: 'stamp' }, colour: 'olive', tone: 'brief' }, steps: [{ id: 'q', prompt: 'Anything?', input: { kind: 'text' } }], finish: [], network: { on: [{ id: 'issued', on: 'drawing-issue.closed', stamp: 'ISSUED', do: 'tell', text: '{{ref}} is issued: {{title}}.' }] } } });
  const s1 = await run(priyaId, 'drawing-issue', [['job', 'P-12513'], ['drawings', 'ISO-1001-01\nISO-1001-02'], ['rev', 'C'], ['purpose', 'IFC'], ['checker', raviId], ['print', ''], ['due', day(3)], ['ok', 'yes']]);
  const itemId = (hub.store.db.prepare("SELECT id FROM bot_items WHERE flow = 'drawing-issue'").get() as any).id;
  for (let i = 0; i < 4; i++) await as(raviId, 'botflow.tick', { itemId, index: i, on: true });
  await as(raviId, 'botflow.act', { itemId, action: 'pass' });
  await as(vikramId, 'botflow.act', { itemId, action: 'ok' });
  // Priya watches her conversation with the drawing check bot as it is handed over
  await P.getByRole('button', { name: /^Direct/ }).first().click();
  await P.locator('.sb-row', { hasText: 'Drawing check and issue' }).first().click({ timeout: 15000 });
  await P.locator('.flow-card.done.track').last().waitFor({ timeout: 15000 });
  await as(vikramId, 'botflow.act', { itemId, action: 'issued', note: 'TR-0042' });
  const relay = P.locator('.flow-card.relay').last();
  await relay.waitFor({ timeout: 15000 });
  // the pulse travels along the line when the hop is fresh
  await relay.locator('.rl-pulse').first().waitFor({ state: 'attached', timeout: 5000 });
  await scrollEnd(P);
  await sleep(700);
  await shot(P, 'bn-01-relay-pulse-1440-light');
  await relay.locator('.rl-row').first().waitFor();
  assert.equal(await relay.locator('.rl-tag').count(), 2, 'two bots as tags');
  await sees(relay.locator('.rl-row').first(), /Drawing check and issue → Plot room[\s\S]*PLOT DC-0001[\s\S]*PLT-0001[\s\S]*HANDED/);
  // the stage strip: the plot room's mark and how its request stands
  const dcCard = P.locator('.flow-card.done.track').last();
  const cell = dcCard.locator('.trk-cell.here');
  await cell.locator('.trk-bot', { hasText: 'PLT-0001' }).waitFor({ timeout: 10000 });
  await sees(cell, /PLOT[\s\S]*PLT-0001 · Plot queue/);
  await sees(dcCard, /With the bot Plot room/);
  await sleep(1800);
  await both(P, 'bn-02-handoff-relay-and-strip-1440');
  // the plot room plots it; Priya collects it in the plot room's conversation
  const pltId = (hub.store.db.prepare("SELECT id FROM bot_items WHERE flow = 'plot-room'").get() as any).id;
  await as(vikramId, 'botflow.act', { itemId: pltId, action: 'start' });
  await as(vikramId, 'botflow.act', { itemId: pltId, action: 'ready', note: 'Rack 3, by the plotter' });
  await P.locator('.sb-row', { hasText: 'Plot room' }).first().click({ timeout: 15000 });
  const collect = P.locator('.flow-card.track.acting').last();
  await collect.waitFor({ timeout: 15000 });
  await collect.locator('.trk-ask', { hasText: 'Rack 3' }).waitFor({ timeout: 8000 });
  await collect.locator('.trk-cell.done', { hasText: 'Approve' }).waitFor({ timeout: 8000 });
  await collect.getByRole('button', { name: 'Collected' }).click();
  await P.locator('.sb-row', { hasText: 'Drawing check and issue' }).first().click();
  await P.locator('.flow-card.relay .rl-row .rl-mini-stamp', { hasText: 'BACK' }).last().waitFor({ timeout: 15000 });
  await P.locator('.flow-card.relay .rl-back', { hasText: 'PLT-0001 · COLLECTED' }).last().waitFor({ timeout: 8000 });
  const done = P.locator('.flow-card.done.track').last();
  await done.locator('.trk-cell.done .trk-bot', { hasText: 'COLLECTED' }).waitFor({ timeout: 10000 });
  await done.locator('.trk-cell.here', { hasText: 'Client receipt' }).waitFor();
  await scrollEnd(P);
  await both(P, 'bn-03-handed-back-1440');
  console.log('HANDOFF OK');

  // ------------------------------------------------------------ 3. an event between bots
  await as(vikramId, 'botflow.act', { itemId, action: 'ack', note: 'ACK-77' });
  await bf.net.settle();
  await P.locator('.sb-row', { hasText: 'Issue watch' }).first().click({ timeout: 15000 });
  await P.locator('.msg', { hasText: 'DC-0001 is issued: P-12513 · rev C IFC.' }).first().waitFor({ timeout: 10000 });
  await shot(P, 'bn-04-event-heard-1440-light');
  console.log('EVENT OK');

  // ------------------------------------------------------------ 2. a query used in a flow
  await as(priyaId, 'botflow.make', { scope: 'private', newBot: true, definition: {
    name: 'stress-check', title: 'Stress check', persona: { mark: { kind: 'glyph', glyph: 'flange' }, colour: 'petrol', tone: 'plain' },
    steps: [
      { id: 'line', label: 'Line', prompt: 'Which line needs a stress check?', input: { kind: 'text' } },
      { id: 'seat', label: 'CAESAR II seat', prompt: 'Is a CAESAR II seat free?', input: { kind: 'text', validate: { type: 'number', integer: true, min: 0 } }, ask: { skill: 'licence-seat.seats', with: { key: 'CAESAR II' } }, branches: [{ if: { equals: '0' }, goto: 'wait' }] },
      { id: 'go', label: 'Start', prompt: 'A CAESAR II seat is free ({{seat}}). Start the model now?', input: { kind: 'choice', options: [{ value: 'now', label: 'Start now' }, { value: 'later', label: 'Later today' }] }, next: 'end' },
      { id: 'wait', label: 'Wait', prompt: 'No seat is free. Wait in line?', input: { kind: 'choice', options: [{ value: 'yes', label: 'Wait in line' }, { value: 'no', label: 'Not now' }] } },
    ],
    finish: [{ do: 'remind', text: 'Stress check {{line}}', dueInDays: 1 }],
  } });
  await as(priyaId, 'botflow.start', { flow: 'stress-check' });
  await P.locator('.sb-row', { hasText: 'Stress check' }).first().click({ timeout: 15000 });
  const step = () => P.locator('.flow-card.step.active');
  await step().getByLabel('Your answer').fill('10"-P-1001-A1');
  await step().getByRole('button', { name: 'Next' }).click();
  await step().locator('.flow-q', { hasText: 'A CAESAR II seat is free (1 free)' }).waitFor({ timeout: 10000 });
  const qrelay = P.locator('.flow-card.relay').last();
  await sees(qrelay.locator('.rl-row').first(), /SEAT\?[\s\S]*CAESAR II[\s\S]*1 free[\s\S]*ANSWERED/);
  await sees(step().locator('.flow-step'), /02 \/ 02/);
  await scrollEnd(P);
  await both(P, 'bn-05-query-in-a-flow-1440');
  await step().getByRole('button', { name: 'Start now' }).click();
  console.log('QUERY OK');

  // ------------------------------------------------------------ 5. a loop is stopped
  const pp = (name: string, title: string, to: string | null) => ({ name, title, persona: { mark: { kind: 'monogram', letters: title.slice(0, 2).toUpperCase() }, colour: 'slate', tone: 'brief' }, steps: [{ id: 'job', label: 'Job', prompt: 'Which job?', input: { kind: 'text' } }], finish: to ? [{ do: 'handoff', to }] : [] });
  await as(priyaId, 'botflow.make', { scope: 'private', newBot: true, definition: pp('ping-bot', 'Ping', null) });
  await as(priyaId, 'botflow.make', { scope: 'private', newBot: true, definition: pp('pong-bot', 'Pong', 'ping-bot') });
  await as(priyaId, 'botflow.make', { scope: 'private', definition: pp('ping-bot', 'Ping', 'pong-bot') });
  await run(priyaId, 'ping-bot', [['job', 'P-1']]);
  await P.locator('.sb-row', { hasText: 'Pong' }).first().click({ timeout: 15000 });
  const stopped = P.locator('.flow-card.relay .rl-row', { hasText: 'STOPPED' }).last();
  await stopped.waitFor({ timeout: 15000 });
  await sees(stopped, /Stopped a loop: Ping already had this request/);
  await scrollEnd(P);
  await shot(P, 'bn-06-loop-stopped-1440-light');
  console.log('LOOP OK');

  // ------------------------------------------------------------ 4. a refusal: Ravi's private bot
  await as(raviId, 'botflow.make', { scope: 'private', newBot: true, definition: { ...tpl('licence-seat'), name: 'ravi-seat', title: 'Ravi’s seats' } });
  await P.evaluate(() => window.dispatchEvent(new CustomEvent('dex-botmaker', { detail: { name: 'stress-check', section: 'json' } })));
  const json = P.locator('#bm-json');
  await json.waitFor({ timeout: 10000 });
  const text = (await json.inputValue()).replace('licence-seat.seats', 'ravi-seat.seats');
  await json.fill(text);
  await P.getByRole('button', { name: 'Save changes' }).click();
  await P.locator('.bm-save-err', { hasText: 'not a skill your bots can ask' }).waitFor({ timeout: 8000 });
  await shot(P, 'bn-07-refused-1440-light');
  await json.fill(text.replace('ravi-seat.seats', 'licence-seat.seats'));
  // the Other bots part, as the maker reads it
  await P.getByRole('tab', { name: /Other bots/ }).click();
  await P.locator('.sk-blocks').first().waitFor();
  await P.getByRole('tab', { name: /Questions/ }).click();
  await P.locator('#bm-step-seat .bm-step-head').click();
  await P.locator('.bm-askbot').first().waitFor();
  await both(P, 'bn-08-maker-asks-a-bot-1440');
  await P.getByRole('button', { name: 'Close' }).first().click();
  const leave = P.getByRole('button', { name: 'Leave' });
  if (await leave.isVisible().catch(() => false)) await leave.click();
  console.log('REFUSAL OK');

  // ------------------------------------------------------------ 6. a scheduled job, in plain words
  // TQs: two raised three weeks ago (the hub's clock moved back), one this week
  const real = Date.now();
  bf.now = () => real - 21 * 86400_000;
  const tqAnswers = (job: string): Array<[string, string]> => [['job', job], ['discipline', 'piping'], ['ref', 'GA-200 rev B'], ['question', 'Nozzle orientation on V-101?'], ['proposal', ''], ['markup', ''], ['due', day(5)], ['ok', 'yes']];
  await run(priyaId, 'rfi-log', tqAnswers('P-12513'));
  await run(priyaId, 'rfi-log', tqAnswers('P-12514'));
  bf.now = () => Date.now();
  await run(priyaId, 'rfi-log', tqAnswers('P-12515'));
  // Priya makes the Weekly TQ chaser from its template
  await P.getByRole('button', { name: /^Desk/ }).first().click();
  await P.getByRole('tab', { name: 'Bots' }).click();
  await P.getByRole('button', { name: 'Make a bot' }).first().click();
  await P.locator('.bm-start').waitFor({ timeout: 10000 });
  await P.getByRole('button', { name: 'Start from Weekly TQ chaser' }).click();
  await P.getByRole('tab', { name: /Schedule/ }).click();
  const when = P.getByLabel('When it runs, in plain words');
  await when.waitFor();
  await when.fill('every weekday at 9:15');
  await P.locator('.js-understood', { hasText: 'Every working day at 09:15' }).waitFor();
  assert.equal(await P.locator('.js-next li').count(), 5, 'the next five runs');
  assert.ok(await P.locator('.js-mark').count() >= 2, 'what was read is marked');
  await when.fill('every Monday at 23:00');
  await P.locator('.js-understood.bad', { hasText: 'quiet hours' }).waitFor();
  await when.fill('every Monday at 10:00');
  await P.locator('.js-understood', { hasText: 'Every Monday at 10:00' }).waitFor();
  await both(P, 'bn-09-schedule-in-plain-words-1440');
  await P.getByRole('button', { name: 'Save bot' }).click();
  await P.locator('.toast', { hasText: 'Weekly TQ chaser saved' }).waitFor({ timeout: 8000 });
  await P.getByRole('button', { name: 'Close' }).first().click();
  console.log('SCHEDULE OK');

  // the hub's clock: the Monday after next, 09:00 in the office; the job is seen first, then runs at 10:00
  const rule = parseSchedule('every Monday at 10:00', real);
  if (!rule.ok) throw new Error('schedule');
  const monday = nextRuns(rule.rule, DEFAULT_CALENDAR, real + 86400_000, 1)[0];
  let clock = monday - 3600_000;
  bf.now = () => clock;
  await bf.jobs.tick(clock);
  // a dry run from the job sheet: what it would do, with nothing sent
  await P.getByRole('button', { name: 'Job sheet' }).click();
  const lane = P.locator('.js-lane', { hasText: 'Monday chase' });
  await lane.waitFor({ timeout: 10000 });
  await lane.getByRole('button', { name: 'Dry run' }).click();
  const detail = P.locator('.js-detail');
  await detail.waitFor({ timeout: 10000 });
  await sees(detail, /DRY[\s\S]*2 open\. Would tell: Vikram Shah/);
  await sees(detail, /Would say: 2 TQs are older than 10 days: TQ-0001 \(\d+ d\), TQ-0002 \(\d+ d\)/);
  const chaser = hub.store.userByAccount('botmaker\\tq-chaser')!;
  assert.equal((hub.store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE author_id = ?').get(chaser.id) as any).n, 0, 'a dry run sends nothing');
  await both(P, 'bn-10-dry-run-1440');
  // the run, with the clock at Monday 10:00
  clock = monday + 5000;
  await bf.jobs.tick(clock);
  const runs = await as(priyaId, 'botjob.history', { flow: 'tq-chaser', job: 'monday' });
  assert.equal(runs[0].outcome, 'RAN');
  assert.equal(runs[0].note, '2 open. Told Vikram Shah.');
  await lane.locator('.js-stamp.RAN').first().waitFor({ timeout: 10000 });
  // two weeks with the hub off: the runs it missed are stamped; with "catch up once", the latest runs
  clock = monday + 14 * 86400_000 + 2 * 3600_000;
  await bf.jobs.tick(clock);
  const after = await as(priyaId, 'botjob.history', { flow: 'tq-chaser', job: 'monday' });
  assert.equal(after.filter((r: any) => r.outcome === 'SKIPPED' && /the hub was off/.test(r.note)).length, 1);
  assert.match(after.find((r: any) => r.outcome === 'RAN' && r.at === monday + 14 * 86400_000)?.note ?? '', /^Caught up \(due 10:00, the hub was off\)\. 3 open\. Told Vikram Shah\.$/);
  await P.getByRole('button', { name: 'Close' }).first().click();
  await P.getByRole('button', { name: 'Job sheet' }).click();
  await P.getByRole('button', { name: 'This month' }).click();
  await P.locator('.js-lane .js-stamp').first().waitFor({ timeout: 10000 });
  await sleep(500);
  const stamps = await P.locator('.js-lane .js-stamp').allTextContents();
  const sameMonth = officeParts(monday + 7 * 86400_000).m === officeParts(monday + 14 * 86400_000).m;
  assert.ok(stamps.some((t) => /RAN/.test(t)) && (!sameMonth || stamps.some((t) => /SKIPPED/.test(t))), `stamps on the month: ${stamps.join(',')}`);
  await P.locator('.js-lane .js-run.past').first().focus();
  await P.locator('.js-pop').waitFor();
  await both(P, 'bn-11-job-sheet-month-1440');
  await P.getByRole('button', { name: 'This week' }).click();
  await sleep(400);
  await both(P, 'bn-12-job-sheet-week-1440');
  await P.setViewportSize({ width: 390, height: 844 }); await sleep(700);
  await both(P, 'bn-13-job-sheet-390');
  await P.setViewportSize({ width: 1440, height: 900 }); await sleep(400);
  await P.getByRole('button', { name: 'Close' }).first().click();
  bf.now = () => Date.now();
  console.log('JOBS OK');

  // ------------------------------------------------------------ 7. the bot network sheet
  await P.getByRole('button', { name: 'Bot network' }).click();
  const sheet = P.locator('.net-sheet');
  await sheet.locator('.nw-svg').waitFor({ timeout: 10000 });
  const edges = await sheet.locator('.nw-list li').allInnerTexts();
  assert.ok(edges.some((t) => /HANDS TO[\s\S]*Drawing check and issue[\s\S]*Plot room/.test(t)), edges.join(' | '));
  assert.ok(edges.some((t) => /ASKS[\s\S]*Stress check[\s\S]*Software seat/.test(t)));
  assert.ok(edges.some((t) => /LISTENS[\s\S]*Drawing check and issue[\s\S]*Issue watch/.test(t)));
  assert.ok(edges.some((t) => /ASKS[\s\S]*Weekly TQ chaser[\s\S]*Technical query/.test(t)));
  await sheet.locator('.nw-list button', { hasText: 'Stress check' }).first().click();
  await sheet.locator('.nw-ex li').first().waitFor({ timeout: 8000 });
  await sees(sheet.locator('.nw-ex'), /SEAT\? · CAESAR II[\s\S]*1 free/);
  // a live pulse as a bot asks again while the sheet is open
  await run(priyaId, 'stress-check', [['line', '6"-P-2002']]);
  await sheet.locator('.nw-pulse').first().waitFor({ state: 'attached', timeout: 5000 });
  await sleep(500);
  await both(P, 'bn-14-network-mine-1440');
  await P.setViewportSize({ width: 390, height: 844 }); await sleep(700);
  await both(P, 'bn-15-network-mine-390');
  await P.setViewportSize({ width: 1440, height: 900 }); await sleep(400);
  await P.keyboard.press('Escape'); await P.keyboard.press('Escape');
  // an administrator: the office's sheet from the Control room
  await owner.request('admin.setRole', { userId: raviId, role: 'admin' });
  await R.reload(); await R.locator('.frame').waitFor();
  await R.locator('.me-btn').click();
  await R.getByRole('menuitem', { name: /Control room/ }).click();
  await R.getByRole('button', { name: /^Bots & tools/ }).click();
  await R.getByRole('button', { name: 'Bot network' }).click();
  const office = R.locator('.net-sheet');
  await office.locator('.nw-svg').waitFor({ timeout: 10000 });
  await sees(office.locator('.net-tb'), /the office/i);
  assert.ok(await office.locator('.nw-node').count() >= 8, 'every bot in the office');
  await office.locator('.nw-list button', { hasText: 'Drawing check and issue' }).first().click();
  await office.locator('.nw-ex li').first().waitFor({ timeout: 8000 });
  await sees(office.locator('.nw-ex'), /Priya Raman/);
  await both(R, 'bn-16-network-office-1440');
  await office.getByRole('button', { name: 'Close' }).first().click();
  await R.getByRole('button', { name: /^Bots & tools/ }).click().catch(() => {});
  await R.getByRole('button', { name: 'Job sheet' }).click();
  await R.locator('.js-lane', { hasText: 'Monday chase' }).waitFor({ timeout: 10000 });
  await shot(R, 'bn-17-job-sheet-office-1440-light');
  await R.keyboard.press('Escape');
  console.log('NETWORK OK');

  // ------------------------------------------------------------ the phone, and Hindi
  await P.getByRole('button', { name: /^Direct/ }).first().click().catch(() => {});
  await P.locator('.sb-row', { hasText: 'Drawing check and issue' }).first().click({ timeout: 15000 });
  await P.locator('.flow-card.relay').last().waitFor({ timeout: 10000 });
  await P.setViewportSize({ width: 390, height: 844 }); await sleep(700);
  await scrollEnd(P);
  await both(P, 'bn-18-relay-390');
  await P.setViewportSize({ width: 1440, height: 900 }); await sleep(400);
  await P.evaluate(() => { localStorage.setItem('dex.language', 'hi'); });
  await P.reload(); await P.locator('.frame').waitFor();
  await P.locator('.lens').nth(1).click().catch(() => {});
  await P.locator('.sb-row', { hasText: 'Drawing check and issue' }).first().click({ timeout: 15000 });
  await P.locator('.flow-card.relay').last().waitFor({ timeout: 10000 });
  await scrollEnd(P);
  await shot(P, 'bn-19-relay-hi-1440-light');
  await P.setViewportSize({ width: 390, height: 844 }); await sleep(600);
  await shot(P, 'bn-20-relay-hi-390-light');
  await P.setViewportSize({ width: 1440, height: 900 }); await sleep(400);
  await P.evaluate(() => window.dispatchEvent(new CustomEvent('dex-botjobs', { detail: { scope: 'mine' } })));
  await P.locator('.js-lane').first().waitFor({ timeout: 10000 });
  await shot(P, 'bn-21-job-sheet-hi-1440-light');
  await P.keyboard.press('Escape');
  await P.evaluate(() => { localStorage.setItem('dex.language', 'en'); });
  void s1; void officeTime;
  console.log('BOTNET E2E PASSED');
} catch (e) {
  await shot(priya.page, 'bn-FAIL-priya').catch(() => {});
  if (ravi) await shot(ravi.page, 'bn-FAIL-ravi').catch(() => {});
  throw e;
} finally {
  await priya.app.close().catch(() => {});
  await ravi?.app.close().catch(() => {});
  owner.disconnect();
  await hub.stop();
}
