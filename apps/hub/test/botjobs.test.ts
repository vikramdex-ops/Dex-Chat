// Scheduled bot jobs on a real hub, with the clock the test moves: a check that tells its maker,
// a job starting a bot for the maker's team with someone on leave left out, a dry run that sends
// nothing, pause, skip the next run, move one run, missed runs while the hub was off (skipped, or
// caught up once), a failure told to the maker once, the quiet hours, the audit and the job sheet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BotFlowDefinition, BotJob } from '@dex/core';
import type { HubClient } from '@dex/core/client';
import { BOT_TEMPLATES } from '@dex/core/botmaker';
import { officeTime } from '@dex/core/botjobs';
import { office, me } from './office.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async <T>(fn: () => Promise<T | undefined | null | false>, ms = 5000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await sleep(25); }
};
const texts = async (c: HubClient, convId: string): Promise<string[]> => (await c.request('msg.list', { convId, limit: 200 })).messages.filter((m) => !m.botflow).map((m) => m.body);
const dmWith = (c: HubClient, botId: string) => waitFor(async () => (await c.request('conv.list')).find((x) => x.kind === 'direct' && x.members.includes(botId))?.id);
const template = (id: string): BotFlowDefinition => JSON.parse(JSON.stringify(BOT_TEMPLATES.find((t) => t.id === id)!.definition)) as BotFlowDefinition;
/** A Monday in the office's time, some weeks on (the 16th of November 2026 is a Monday). */
const monday = (week: number, h: number, m = 0) => officeTime('2026-11-16', h * 60 + m) + week * 7 * 86400_000;
const MIN = 60_000;

const checker = (job: Partial<BotJob> = {}): BotFlowDefinition => ({
  name: 'seat-report', title: 'Seat report',
  steps: [{ id: 'q', prompt: 'Anything?', input: { kind: 'text' } }], finish: [],
  jobs: [{ id: 'mon', title: 'Monday seats', when: 'every Monday at 10:00', do: { do: 'check', ask: { skill: 'licence-seat.seats', with: { key: 'CAESAR II' } }, if: { var: 'result.free', gt: 0 }, tell: 'owner', text: 'CAESAR II: {{result}} this week.' }, ...job }],
});

async function setup() {
  const o = await office();
  await o.owner.request('botflow.make', { definition: template('licence-seat'), scope: 'office' });
  let clock = monday(0, 9, 0);
  o.hub.botflows.now = () => clock;
  const at = (t: number) => { clock = t; return o.hub.botflows.jobs.tick(t); };
  return { ...o, at, clock: () => clock };
}
const history = (c: HubClient, flow: string, job: string) => c.request('botjob.history', { flow, job });

test('a job runs on its schedule with the injected clock, tells its maker, and nothing runs twice', async () => {
  const { hub, priya, at } = await setup();
  const made = await priya.request('botflow.make', { definition: checker(), scope: 'private' });
  await at(monday(0, 9, 50)); // the job is seen first: nothing before it existed runs
  await at(monday(0, 9, 59));
  assert.equal((await history(priya, 'seat-report', 'mon')).length, 0);
  await at(monday(0, 10, 0) + 5000);
  const runs = await history(priya, 'seat-report', 'mon');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].outcome, 'RAN');
  assert.equal(runs[0].at, monday(0, 10));
  assert.match(runs[0].note, /^1 free\. Told Priya\.$/);
  const dm = await dmWith(priya, made.botId);
  assert.ok((await texts(priya, dm)).includes('CAESAR II: 1 free this week.'));
  await at(monday(0, 10, 0) + 20_000);
  assert.equal((await history(priya, 'seat-report', 'mon')).length, 1, 'not twice');
  assert.ok(hub.store.db.prepare("SELECT 1 FROM audit WHERE action = 'botjob.ran'").get());
  // the job sheet: its lane, the next runs, the past run stamped
  const sheet = await priya.request('botjob.sheet', { scope: 'mine', from: monday(0, 0), to: monday(3, 0) });
  assert.equal(sheet.lanes.length, 1);
  const lane = sheet.lanes[0];
  assert.equal(lane.words, 'Every Monday at 10:00');
  assert.deepEqual(lane.next, [monday(1, 10), monday(2, 10)]);
  assert.equal(lane.past[0].outcome, 'RAN');
  assert.equal(sheet.tzOffset, 330);
});

test('dry run, run now, pause, skip next and move one run', async () => {
  const { hub, priya, at, clock } = await setup();
  const made = await priya.request('botflow.make', { definition: checker(), scope: 'private' });
  await at(monday(0, 9, 0));
  const dry = await priya.request('botjob.run', { flow: 'seat-report', job: 'mon', dry: true });
  assert.equal(dry.outcome, 'DRY');
  assert.match(dry.note, /Would tell: Priya/);
  assert.ok(dry.lines.some((l) => l === 'Would say: CAESAR II: 1 free this week.'));
  assert.equal((await priya.request('conv.list')).find((x) => x.kind === 'direct' && x.members.includes(made.botId)), undefined, 'a dry run sends nothing');
  void hub;
  const now = await priya.request('botjob.run', { flow: 'seat-report', job: 'mon' });
  assert.equal(now.outcome, 'RAN');
  // pause: the run at 10:00 does not happen and leaves no stamp
  await priya.request('botjob.set', { flow: 'seat-report', job: 'mon', paused: true });
  await at(monday(0, 10, 0) + 5000);
  assert.equal((await history(priya, 'seat-report', 'mon')).filter((r) => r.at === monday(0, 10)).length, 0);
  await priya.request('botjob.set', { flow: 'seat-report', job: 'mon', paused: false });
  // skip next: next Monday is stamped SKIPPED
  const lane = await priya.request('botjob.set', { flow: 'seat-report', job: 'mon', skipNext: true });
  assert.equal(lane.skipAt, monday(1, 10));
  await at(monday(1, 10, 0) + 5000);
  const skipped = (await history(priya, 'seat-report', 'mon')).find((r) => r.at === monday(1, 10));
  assert.equal(skipped?.outcome, 'SKIPPED');
  assert.equal(skipped?.note, 'Skipped once, as asked.');
  // move the Monday after to Tuesday 11:30, once
  const to = monday(2, 10) + 86400_000 + 90 * MIN;
  await priya.request('botjob.set', { flow: 'seat-report', job: 'mon', move: { from: monday(2, 10), to } });
  await assert.rejects(priya.request('botjob.set', { flow: 'seat-report', job: 'mon', move: { from: monday(2, 10), to: to + MIN } }), /moved once already/);
  await assert.rejects(priya.request('botjob.set', { flow: 'seat-report', job: 'mon', move: { from: monday(3, 10), to: monday(3, 22) } }), /quiet hours/);
  await at(monday(2, 10, 0) + 5000);
  assert.equal((await history(priya, 'seat-report', 'mon')).filter((r) => r.at === monday(2, 10)).length, 0, 'not at its old time');
  await at(to + 5000);
  assert.equal((await history(priya, 'seat-report', 'mon')).find((r) => r.at === to)?.outcome, 'RAN');
  void clock;
});

test('missed runs while the hub was off: skipped, or caught up once in the morning', async () => {
  const { priya, at } = await setup();
  await priya.request('botflow.make', { definition: checker({ missed: 'skip' }), scope: 'private' });
  await at(monday(0, 9, 0));
  // the hub is off for two weeks and comes back on a Monday at noon
  await at(monday(2, 12, 0));
  let runs = await history(priya, 'seat-report', 'mon');
  assert.deepEqual(runs.map((r) => r.outcome).sort(), ['SKIPPED', 'SKIPPED', 'SKIPPED']);
  assert.ok(runs.every((r) => /the hub was off/.test(r.note)));
  // catch up once: the latest missed run runs, the others are stamped skipped
  await priya.request('botflow.make', { definition: checker({ missed: 'once' }), scope: 'private', baseVersion: 1 });
  await at(monday(4, 22, 0)); // back on at 22:00: quiet hours, it waits for the morning
  runs = await history(priya, 'seat-report', 'mon');
  assert.equal(runs.filter((r) => r.outcome === 'RAN').length, 0);
  await at(monday(4, 22, 0) + 10.5 * 3600_000); // Tuesday 08:30
  runs = await history(priya, 'seat-report', 'mon');
  const ran = runs.filter((r) => r.outcome === 'RAN');
  assert.equal(ran.length, 1);
  assert.equal(ran[0].at, monday(4, 10));
  assert.match(ran[0].note, /^Caught up \(due 10:00, the hub was off\)\./);
  assert.equal(runs.filter((r) => r.outcome === 'SKIPPED' && r.at === monday(3, 10)).length, 1);
});

test('a job for the maker’s team leaves people on leave out; a failure is told once; quiet hours and permissions hold', async () => {
  const { hub, owner, priya, ravi, at } = await setup();
  await owner.request('admin.org.setProfile', { userId: me(priya), managerId: me(owner) });
  await owner.request('admin.org.setProfile', { userId: me(ravi), managerId: me(owner) });
  await ravi.request('me.update', { ooo: { until: monday(1, 9), message: 'On leave', delegateId: null } });
  const ts = template('friday-timesheet');
  ts.jobs![0].when = 'every Monday at 17:00';
  const made = await owner.request('botflow.make', { definition: ts, scope: 'office' });
  await at(monday(0, 16, 0));
  await at(monday(0, 17, 0) + 5000);
  const run = (await history(owner, 'friday-timesheet', 'friday'))[0];
  assert.equal(run.outcome, 'RAN');
  assert.equal(run.note, 'Started for 1 person. 1 on leave was left out.');
  const pdm = await dmWith(priya, made.botId);
  await waitFor(async () => (await priya.request('msg.list', { convId: pdm, limit: 50 })).messages.find((m) => m.botflow?.kind === 'step' && m.botflow.stepId === 'job'));
  // Priya's job for her own team: she has none, so it fails, and she hears once
  const mine = await priya.request('botflow.make', { scope: 'private', definition: { name: 'my-team', title: 'My team', steps: [{ id: 'q', prompt: 'Q?', input: { kind: 'text' } }], finish: [], jobs: [{ id: 'j', title: 'Team ping', when: 'every 30 minutes between 17:00 and 19:00', do: { do: 'remind', people: { from: 'team' }, text: 'Hours, please' } }] } });
  await at(monday(0, 17, 29));
  await at(monday(0, 17, 30) + 5000);
  await at(monday(0, 18, 0) + 5000);
  const fails = await history(priya, 'my-team', 'j');
  assert.equal(fails.length, 2);
  const failed = fails[0];
  assert.equal(failed.outcome, 'FAILED');
  assert.equal(failed.note, 'There is no one to do it for.');
  const dm = await dmWith(priya, mine.botId);
  const alerts = (await texts(priya, dm)).filter((t) => /could not run/.test(t));
  assert.equal(alerts.length, 1, 'told once a day, not per run');
  // run now in the quiet hours is refused; a dry run is fine
  await at(monday(0, 22, 0));
  await assert.rejects(priya.request('botjob.run', { flow: 'my-team', job: 'j' }), /quiet hours/);
  assert.equal((await priya.request('botjob.run', { flow: 'my-team', job: 'j', dry: true })).outcome, 'DRY');
  // only its maker or an administrator changes or runs it; a Space she is not in is refused at save
  await assert.rejects(ravi.request('botjob.run', { flow: 'my-team', job: 'j', dry: true }), /Only the person who made this bot/);
  await owner.request('conv.create', { kind: 'space', name: 'Structural', members: [me(ravi)] });
  await assert.rejects(priya.request('botflow.make', { scope: 'private', definition: { name: 'struct-ping', title: 'Struct ping', steps: [{ id: 'q', prompt: 'Q?', input: { kind: 'text' } }], finish: [], jobs: [{ id: 'j', title: 'Ping', when: 'every Monday at 11:00', do: { do: 'start', people: { from: 'space', space: 'Structural' } } }] } }), /only if you are in that Space/);
  // the office's job sheet is for administrators; holidays are theirs to set
  await assert.rejects(priya.request('botjob.sheet', { scope: 'office' }), /Only administrators/);
  const office = await owner.request('botjob.sheet', { scope: 'office', from: monday(0, 0), to: monday(1, 0) });
  assert.deepEqual(office.lanes.map((l) => l.flow).sort(), ['friday-timesheet', 'my-team']);
  await assert.rejects(priya.request('admin.botjob.holidays', { holidays: [] }), /Only administrators/);
  await owner.request('admin.botjob.holidays', { holidays: [{ date: '2026-11-23', name: 'Office holiday' }] });
  const lane = (await owner.request('botjob.sheet', { scope: 'bot', flow: 'friday-timesheet', from: monday(0, 18), to: monday(2, 18) })).lanes[0];
  assert.deepEqual(lane.next, [monday(2, 17)], 'the holiday Monday is passed over');
  void hub;
});
