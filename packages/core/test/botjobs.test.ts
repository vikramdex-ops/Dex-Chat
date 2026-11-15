// Scheduled bot jobs: the schedule read from plain words, the next runs in the office's time (IST)
// with working days and holidays, the quiet hours, and what a tick does with runs that are due or
// were missed while the hub was off. The clock is passed in everywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CALENDAR, MISSED_AFTER, checkJobs, describeJob, hm, holidaySkips, nextRuns, officeParts, officeTime, parseSchedule, planDue } from '../src/botjobs.ts';
import type { OfficeCalendar, ScheduleRule } from '../src/botjobs.ts';
import { validateFlow } from '../src/botflow-engine.ts';
import { BOT_TEMPLATES } from '../src/botmaker.ts';

// Sunday 15 Nov 2026, 09:30 in the office (IST)
const NOW = officeTime('2026-11-15', 9 * 60 + 30);
const CAL: OfficeCalendar = { ...DEFAULT_CALENDAR, holidays: [{ date: '2026-11-16', name: 'Office holiday' }] };
const at = (ts: number) => { const p = officeParts(ts); return `${p.date} ${hm(p.minutes)}`; };
const rule = (text: string, cal = CAL): ScheduleRule => { const p = parseSchedule(text, NOW, cal); assert.ok(p.ok, `${text}: ${p.ok ? '' : p.error}`); return p.rule; };
const next = (text: string, n = 5, cal = CAL) => nextRuns(rule(text, cal), cal, NOW, n).map(at);

test('office time is IST whatever the machine’s zone', () => {
  assert.equal(officeTime('2026-11-15', 0), Date.UTC(2026, 10, 14, 18, 30));
  assert.deepEqual(officeParts(Date.UTC(2026, 10, 15, 4, 0)), { date: '2026-11-15', dow: 0, minutes: 570, y: 2026, m: 11, d: 15 });
});

test('the schedules people write read as they meant, with what was understood in words', () => {
  const cases: Array<[string, string]> = [
    ['every weekday at 9:15', 'Every working day at 09:15'],
    ['every Monday 10:00', 'Every Monday at 10:00'],
    ['Every Mon and Thu at 17:30', 'Every Monday and Thursday at 17:30'],
    ['last working day of the month at 16:00', 'On the last working day of each month at 16:00'],
    ['first working day of each month 9:30', 'On the first working day of each month at 09:30'],
    ['every 2 hours during office hours', 'Every 2 hours during office hours (09:30 to 18:30), on working days'],
    ['every 30 minutes between 10:00 and 12:00', 'Every 30 minutes from 10:00 to 12:00, on working days'],
    ['daily at 9am', 'Every working day at 09:00'],
    ['on 20 Nov at 15:00', 'Once, on 2026-11-20 at 15:00'],
    ['tomorrow at 10', 'Once, on 2026-11-16 at 10:00'],
  ];
  for (const [text, words] of cases) {
    const p = parseSchedule(text, NOW, CAL);
    assert.ok(p.ok, text);
    assert.equal(p.words, words, text);
    assert.ok(p.marks.length > 0, `${text}: the words that mattered are marked`);
  }
  const fifteenth = parseSchedule('1st and 15th', NOW, CAL);
  assert.ok(fifteenth.ok);
  assert.match(fifteenth.words, /^On the 1st and 15th of each month at 09:30/);
  assert.match(fifteenth.notes.join(' '), /No time given: it runs at 09:30/);
  const five = parseSchedule('every Friday at 5', NOW, CAL);
  assert.ok(five.ok && five.words === 'Every Friday at 17:00' && /taken as evening/.test(five.notes.join(' ')), 'an hour on its own in the afternoon is read as the evening, and said so');
});

test('schedules that cannot run are refused in plain words', () => {
  const bad: Array<[string, RegExp]> = [
    ['', /Write when it runs/],
    ['whenever you like', /Write when it runs/],
    ['every Monday', /Say what time/],
    ['at 10:00', /Say which days/],
    ['every Monday at 23:00', /quiet hours/],
    ['every 5 minutes', /15 minutes is the most often/],
    ['every 45th', /between 1st and 31st/],
    ['every 2 hours between 12:00 and 10:00', /end of the window/],
  ];
  for (const [text, re] of bad) {
    const p = parseSchedule(text, NOW, CAL);
    assert.equal(p.ok, false, text);
    if (!p.ok) assert.match(p.error, re, text);
  }
});

test('the next five runs respect working days, holidays and month ends', () => {
  // Monday 16 is a holiday, Sunday is not a working day
  assert.deepEqual(next('every weekday at 9:15'), ['2026-11-17 09:15', '2026-11-18 09:15', '2026-11-19 09:15', '2026-11-20 09:15', '2026-11-21 09:15']);
  assert.deepEqual(next('every Monday 10:00', 2), ['2026-11-23 10:00', '2026-11-30 10:00']);
  // the 15th is a Sunday, the 16th a holiday: it moves to the next working day
  assert.deepEqual(next('1st and 15th at 11:00', 3), ['2026-11-17 11:00', '2026-12-01 11:00', '2026-12-15 11:00']);
  // the last working day of January 2027 is Saturday the 30th (the office works Saturdays)
  assert.deepEqual(next('last working day of the month at 16:00', 3), ['2026-11-30 16:00', '2026-12-31 16:00', '2027-01-30 16:00']);
  const fiveDay = { ...CAL, workdays: [1, 2, 3, 4, 5] };
  assert.deepEqual(next('last working day of the month at 16:00', 3, fiveDay), ['2026-11-30 16:00', '2026-12-31 16:00', '2027-01-29 16:00']);
  assert.deepEqual(next('every 2 hours during office hours'), ['2026-11-17 09:30', '2026-11-17 11:30', '2026-11-17 13:30', '2026-11-17 15:30', '2026-11-17 17:30']);
  assert.deepEqual(next('on 20 Nov at 15:00'), ['2026-11-20 15:00']);
  assert.deepEqual(holidaySkips(rule('every weekday at 9:15'), CAL, NOW, NOW + 3 * 86400_000), [{ date: '2026-11-16', name: 'Office holiday' }]);
});

test('a tick: due runs run, missed runs are skipped or caught up once, a skipped run and a moved run are honoured', () => {
  const r = rule('every weekday at 9:15');
  const tue = officeTime('2026-11-17', 9 * 60 + 15);
  const base = { checkedAt: tue - 60_000, paused: false, skipAt: null, moved: [] };
  assert.deepEqual(planDue(r, CAL, {}, base, tue + 10_000), [{ at: tue, act: 'run', why: '' }]);
  // nothing twice: checked past it
  assert.deepEqual(planDue(r, CAL, {}, { ...base, checkedAt: tue + 10_000 }, tue + 20_000), []);
  // the hub was off from Tuesday morning to Thursday noon: three runs missed
  const thuNoon = officeTime('2026-11-19', 12 * 60);
  const off = planDue(r, CAL, { missed: 'skip' }, base, thuNoon);
  assert.deepEqual(off.map((p) => [at(p.at), p.act]), [['2026-11-17 09:15', 'missed'], ['2026-11-18 09:15', 'missed'], ['2026-11-19 09:15', 'missed']]);
  const once = planDue(r, CAL, { missed: 'once' }, base, thuNoon);
  assert.deepEqual(once.map((p) => [at(p.at), p.act]), [['2026-11-17 09:15', 'missed'], ['2026-11-18 09:15', 'missed'], ['2026-11-19 09:15', 'catchup']]);
  // catching up in the quiet hours waits for the morning
  const night = officeTime('2026-11-19', 22 * 60);
  assert.equal(planDue(r, CAL, { missed: 'once' }, base, night).at(-1)?.act, 'wait');
  // a run a little late is not missed
  assert.equal(planDue(r, CAL, {}, base, tue + MISSED_AFTER - 1000)[0].act, 'run');
  assert.equal(planDue(r, CAL, {}, { ...base, skipAt: tue }, tue + 1000)[0].act, 'skip');
  const moved = planDue(r, CAL, {}, { ...base, moved: [{ from: tue, to: tue + 3 * 3600_000 }] }, tue + 1000);
  assert.deepEqual(moved, [], 'the moved run is not at its old time');
  assert.deepEqual(planDue(r, CAL, {}, { ...base, moved: [{ from: tue, to: tue + 3 * 3600_000 }] }, tue + 3 * 3600_000 + 1000).map((p) => p.act), ['run']);
  assert.ok(planDue(r, CAL, {}, { ...base, paused: true }, tue + 1000).every((p) => p.act === 'skip' && p.why === 'paused'));
});

test('jobs in a definition are checked: the schedule must read, each action is complete', () => {
  const base = { name: 'chaser', title: 'Chaser', steps: [{ id: 'q', prompt: 'Q?', input: { kind: 'text' } }], finish: [] };
  const ok = validateFlow({ ...base, jobs: [{ id: 'mon', title: 'Monday', when: 'every Monday at 10:00', do: { do: 'start', people: { from: 'team' } } }] });
  assert.equal(ok.jobs?.length, 1);
  assert.throws(() => validateFlow({ ...base, jobs: [{ title: 'Monday', when: 'sometimes', do: { do: 'start', people: { from: 'team' } } }] }), /Job 1 \(Monday\): Write when it runs/);
  assert.throws(() => validateFlow({ ...base, jobs: [{ title: 'Reg', when: 'every Monday at 10:00', do: { do: 'register' } }] }), /only a bot that tracks requests/);
  assert.throws(() => validateFlow({ ...base, jobs: [{ title: 'Chk', when: 'every Monday at 10:00', do: { do: 'check', ask: { skill: 'rfi-log.open' }, tell: 'lead', text: 'x' } }] }), /say when it acts/);
  assert.throws(() => validateFlow({ ...base, jobs: Array.from({ length: 9 }, (_x, i) => ({ id: `j${i}`, title: 'J', when: 'every Monday at 10:00', do: { do: 'start', people: { from: 'team' } } })) }), /up to 8/);
  // "tomorrow" is kept as the date it meant
  const once = checkJobs([{ title: 'Once', when: 'tomorrow at 10', do: { do: 'start', people: { from: 'team' } } }], { tracked: false, now: NOW });
  assert.equal(once[0].when, 'on 2026-11-16 at 10:00');
  assert.equal(describeJob(ok.jobs![0]), 'Starts it for your team');
});

test('the scheduled templates are valid as they stand', () => {
  for (const id of ['tq-chaser', 'friday-timesheet']) {
    const t = BOT_TEMPLATES.find((x) => x.id === id);
    assert.ok(t, id);
    const def = validateFlow(t.definition);
    assert.ok(def.jobs?.length, `${id} has a job`);
    assert.ok(def.steps.some((s) => s.ask), `${id} asks another bot`);
  }
});
