import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, buildLeadCard, buildRegister, buildWeek, checkNibConfig, effectiveWrapAt, findPerson, nudgePolicy, parseWork,
  progressOf, projectsFromText, qtyText, sheetAccess, unitOf, unitTotals, visibleItems, whenFromWords, NIB_DEFAULTS,
} from '../src/nib.ts';
import type { NibDay, NibItem, NudgeInput, RegisterPerson } from '../src/nib.ts';

const people = [
  { id: 'meera', name: 'Meera Iyer', giver: true },
  { id: 'ravi', name: 'Ravi Kumar', giver: true },
  { id: 'anil', name: 'Anil Deshpande' },
  { id: 'priya', name: 'Priya Raman' },
  { id: 'sundar', name: 'Sundar Rajan', giver: true },
];
const ctx = { people, projects: [{ code: 'P-12', name: 'Refinery revamp' }, { code: 'P-14', name: 'Tank farm' }], today: '2026-11-12', meId: 'priya' };
const p = (s: string) => parseWork(s, ctx);

// ---------------------------------------------------------------- the parser: English
test('the examples from the brief', () => {
  const a = p('got 12 isos from Meera for P-12 area 4');
  assert.equal(a.intent, 'got');
  assert.equal(a.giver?.id, 'meera');
  assert.equal(a.project, 'P-12');
  assert.deepEqual(a.qty, { done: 0, total: 12, unit: 'isos' });
  assert.match(a.activity, /area 4/i);
  assert.equal(a.status, 'going');

  const b = p('Ravi: check MTO for P-14, half day');
  assert.equal(b.giver?.id, 'ravi');
  assert.equal(b.project, 'P-14');
  assert.deepEqual(b.qty, { done: null, total: 4, unit: 'hours' });
  assert.equal(b.activity, 'Check MTO');
  assert.equal(b.intent, 'got');

  const c = p('12 isos done for P-12');
  assert.equal(c.intent, 'done');
  assert.equal(c.status, 'done');
  assert.deepEqual(c.qty, { done: 12, total: 12, unit: 'isos' });
  assert.equal(c.project, 'P-12');

  const d = p('MTO pending from Meera side');
  assert.equal(d.giver?.id, 'meera');
  assert.equal(d.note, 'Pending');
  assert.equal(d.activity, 'MTO');
});

test('progress as numbers: x of y, slashes, percentages, ranges', () => {
  assert.deepEqual(p('18 of 40 sheets P-12').qty, { done: 18, total: 40, unit: 'sheets' });
  assert.equal(p('18 of 40 sheets P-12').intent, 'progress');
  assert.deepEqual(p('routing 18/40').qty, { done: 18, total: 40, unit: null });
  assert.deepEqual(p('stress check 60% done').qty, { done: 60, total: 100, unit: '%' });
  assert.deepEqual(p('model review 75 percent').qty, { done: 75, total: 100, unit: '%' });
  assert.deepEqual(p('12-15 drawings for Sundar').qty, { done: 0, total: 15, unit: 'drawings' });
  assert.equal(p('12-15 drawings for Sundar').giver?.id, 'sundar');
  assert.equal(p('40 of 40 sheets').status, 'done');
  assert.equal(p('2.5 hrs on the line list').qty?.unit, 'hours');
  assert.equal(p('2.5 hrs on the line list').qty?.total, 2.5);
});

test('units: plurals, abbreviations and office spellings', () => {
  for (const [w, u] of [['iso', 'isos'], ['Isometrics', 'isos'], ['shts', 'sheets'], ['dwg', 'drawings'], ['GAs', 'GAs'], ['MTO', 'MTOs'], ['spools', 'spools'], ['mark-ups', 'mark-ups'], ['hrs', 'hours'], ['%', '%'], ['banana', null]] as const) assert.equal(unitOf(w), u, w);
  assert.deepEqual(p('twelve sheets from Meera').qty, { done: 0, total: 12, unit: 'sheets' });
  assert.deepEqual(p('a dozen supports for P-14').qty, { done: 0, total: 12, unit: 'supports' });
});

test('who gave it: colon, from, side, @, for, typos', () => {
  assert.equal(p('from meera iyer: 6 GAs').giver?.id, 'meera');
  assert.equal(p('@Ravi wants the spool list').giver?.id, 'ravi');
  assert.equal(p('Sundar sir ka kaam: support check').giver?.id, 'sundar');
  assert.equal(p('Mera gave me 4 drawings').giver?.id, 'meera', 'a small slip in a name');
  assert.equal(p('nozzle orientation for Ravi').giver?.id, 'ravi');
  assert.equal(p('check the GA from the client').giver, null, 'no colleague called "the"');
  assert.equal(p('Priya: my own note').giver, null, 'never yourself');
  const greet = p('Priya, please check the MTO for P-14 by Friday');
  assert.equal(greet.activity, 'Check MTO');
  assert.equal(greet.giver, null, 'the greeting names you, not who gave it');
  const m = parseWork('<@meera> needs 3 isos', ctx);
  assert.equal(m.giver?.id, 'meera');
});

test('jobs: configured codes first, then anything shaped like a job; drawing numbers are not jobs', () => {
  assert.equal(p('p12 routing').project, 'P-12');
  assert.equal(p('J-0412 drawings').project, 'J-0412');
  assert.equal(p('revise ISO-1001 for Meera').project, null);
  assert.equal(p('GA-200 check').project, null);
  assert.equal(p('area 4 routing').project, null);
});

test('due dates: by Friday, kal tak, EOD, on 20 Nov, 20/11', () => {
  // 12 Nov 2026 is a Thursday
  assert.equal(p('GA check by Friday').due, '2026-11-13');
  assert.equal(p('MTO kal tak').due, '2026-11-13');
  assert.equal(p('send the isos EOD').due, '2026-11-12');
  assert.equal(p('stress report by 20 Nov').due, '2026-11-20');
  assert.equal(p('line list due 2/12').due, '2026-12-02');
  assert.equal(p('model review by Monday').due, '2026-11-16');
});

test('blocked and done', () => {
  const b = p('Area 4 routing waiting for vendor data');
  assert.equal(b.status, 'blocked');
  assert.match(b.note ?? '', /vendor data/);
  assert.equal(b.activity, 'Area 4 routing');
  const d = p('issued 6 GAs for P-14');
  assert.equal(d.status, 'done');
  assert.equal(d.qty?.done, 6);
});

// ---------------------------------------------------------------- the parser: Hinglish
test('Hinglish phrasing common in our office', () => {
  const a = p('Meera ne diya 8 isos P-12');
  assert.equal(a.giver?.id, 'meera');
  assert.equal(a.qty?.total, 8);
  assert.equal(a.intent, 'got');
  const b = p('12 iso ho gaye P-12 ke');
  assert.equal(b.intent, 'done');
  assert.equal(b.qty?.done, 12);
  assert.equal(b.project, 'P-12');
  const c = p('Ravi se mila naya kaam: spool drawings');
  assert.equal(c.giver?.id, 'ravi');
  assert.match(c.activity, /spool drawings/i);
  const d = p('support check baaki hai');
  assert.equal(d.note, 'Pending');
  assert.match(d.activity, /support check/i);
  assert.equal(p('kuch nahi').intent, 'nothing');
  assert.equal(p('kal chutti').intent, 'leave');
  assert.equal(p('kal chutti').due, '2026-11-13');
  assert.equal(p('teen isos kar diye').qty?.done, 3);
});

test('skills and whole-line kinds', () => {
  assert.equal(p('nothing today').intent, 'nothing');
  assert.equal(p('remind me to send the GA to Ravi after lunch').intent, 'remind');
  assert.equal(p('where is the GA for P-12 area 4').intent, 'where');
  assert.equal(p("who's in today").intent, 'who');
  assert.equal(p('who knows about P-12 stress').intent, 'who');
  assert.equal(p('when is my next meeting').intent, 'meeting');
  assert.equal(p('how do I share my screen').intent, 'help');
  assert.equal(p('on leave tomorrow').intent, 'leave');
  assert.equal(p('half day').intent, 'leave', 'half day on its own is leave');
  assert.equal(p('wrap up').intent, 'wrap');
  assert.equal(p('morning brief').intent, 'brief');
});

test('annotations point at the words they came from', () => {
  const s = 'got 12 isos from Meera for P-12';
  const r = parseWork(s, ctx);
  const word = (k: string) => r.spans.filter((x) => x.kind === k).map((x) => s.slice(x.from, x.to));
  assert.deepEqual(word('qty'), ['12 isos']);
  assert.deepEqual(word('giver'), ['Meera']);
  assert.deepEqual(word('project'), ['P-12']);
});

test('the parser never throws on odd input', () => {
  for (const s of ['', '   ', '////', '1234567', 'of of of', '%%%', 'from', '@', '<@x>', 'a'.repeat(5000), '18 of 0 sheets', 'Ravi:', '–– ––']) {
    const r = parseWork(s, ctx);
    assert.ok(r.confidence >= 0 && r.confidence <= 1);
  }
});

test('findPerson prefers configured givers and full names', () => {
  const list = [{ id: 'a', name: 'Ravi Shah' }, { id: 'b', name: 'Ravi Kumar', giver: true }];
  assert.equal(findPerson('Ravi', list)?.id, 'b');
  assert.equal(findPerson('ravi shah', list)?.id, 'a');
  assert.equal(findPerson('x', list), null);
});

// ---------------------------------------------------------------- reminders in words
test('reminders in plain words', () => {
  const now = new Date(2026, 10, 12, 10, 0);
  const a = whenFromWords('remind me to send the GA to Ravi after lunch', now)!;
  assert.equal(new Date(a.at).getHours(), 14);
  assert.equal(a.rest, 'send the GA to Ravi');
  assert.equal(new Date(whenFromWords('call the client tomorrow morning', now)!.at).getDate(), 13);
  assert.equal(new Date(whenFromWords('check mail in 20 min', now)!.at).getMinutes(), 20);
  assert.equal(new Date(whenFromWords('plot the set at 5', now)!.at).getHours(), 17);
  const eod = whenFromWords('timesheet end of day', now, '18:00')!;
  assert.equal(new Date(eod.at).getHours() * 60 + new Date(eod.at).getMinutes(), 17 * 60 + 45);
  assert.equal(whenFromWords('just some words', now), null);
});

// ---------------------------------------------------------------- the nudge policy
const T = (h: number, m = 0) => new Date(2026, 10, 12, h, m).getTime();
const base = (over: Partial<NudgeInput> = {}): NudgeInput => ({
  now: T(9), workday: true, exempt: false, onLeave: false, day: { state: 'open', started: false, asks: [], snoozeUntil: null },
  busy: false, online: true, startPromptAt: T(9, 45), wrapAt: T(18), digestAt: T(19), limit: 3, ...over,
});

test('nudges: never on leave, not on a holiday, not for the exempt, not once sent', () => {
  assert.equal(nudgePolicy(base({ now: T(18, 30), onLeave: true })).level, 0);
  assert.equal(nudgePolicy(base({ now: T(18, 30), workday: false })).level, 0);
  assert.equal(nudgePolicy(base({ now: T(18, 30), exempt: true })).level, 0);
  assert.equal(nudgePolicy(base({ now: T(18, 30), day: { state: 'sent', started: true, asks: [], snoozeUntil: null } })).level, 0);
  assert.equal(nudgePolicy(base({ now: T(18, 30), day: { state: 'nothing', started: true, asks: [], snoozeUntil: null } })).level, 0);
});

test('nudges: the start card once, after the start prompt time', () => {
  assert.equal(nudgePolicy(base({ now: T(9, 30) })).level, 0);
  const r = nudgePolicy(base({ now: T(9, 50) }));
  assert.deepEqual([r.kind, r.level, r.ask], ['start', 2, 2]);
  const again = nudgePolicy(base({ now: T(10, 30), day: { state: 'open', started: false, asks: [{ at: T(9, 50), level: 2, kind: 'start' }], snoozeUntil: null } }));
  assert.equal(again.ask, null, 'asked once');
  assert.equal(nudgePolicy(base({ now: T(9, 50), day: { state: 'open', started: true, asks: [], snoozeUntil: null } })).level, 0, 'answered');
});

test('nudges: the wrap-up ladder climbs one step at a time, 20 minutes apart, and stops at the limit', () => {
  const asks: NibDay['asks'] = [];
  const at = (now: number) => nudgePolicy(base({ now, day: { state: 'open', started: true, asks, snoozeUntil: null } }));
  assert.equal(at(T(17, 59)).level, 0);
  let r = at(T(18));
  assert.deepEqual([r.level, r.ask], [1, 1]);
  asks.push({ at: T(18), level: 1, kind: 'wrap' });
  assert.equal(at(T(18, 10)).ask, null, 'waits for the next step');
  r = at(T(18, 25));
  assert.deepEqual([r.level, r.ask], [2, 2]);
  asks.push({ at: T(18, 25), level: 2, kind: 'wrap' });
  r = at(T(18, 40));
  assert.equal(r.ask, null, 'not within 20 minutes');
  r = at(T(18, 45));
  assert.deepEqual([r.level, r.ask], [3, 3]);
  asks.push({ at: T(18, 45), level: 3, kind: 'wrap' });
  assert.equal(at(T(18, 55)).ask, null);
  assert.equal(at(T(19, 30)).ask, null, 'never after the register');
});

test('nudges wait while someone is busy, offline or snoozed, and do not count', () => {
  for (const over of [{ busy: true }, { online: false }, { day: { state: 'open' as const, started: true, asks: [], snoozeUntil: T(18, 40) } }]) {
    const r = nudgePolicy(base({ now: T(18, 5), day: { state: 'open', started: true, asks: [], snoozeUntil: null }, ...over }));
    assert.equal(r.ask, null);
  }
  // once the meeting ends, the first step comes
  assert.equal(nudgePolicy(base({ now: T(18, 50), day: { state: 'open', started: true, asks: [], snoozeUntil: null } })).ask, 1);
});

test('nudges: a limit of one makes the one ask the friendly message once it is late enough', () => {
  const r = nudgePolicy(base({ now: T(18, 50), limit: 1, day: { state: 'open', started: true, asks: [], snoozeUntil: null } }));
  assert.deepEqual([r.level, r.ask], [3, 3]);
  const early = nudgePolicy(base({ now: T(18, 1), limit: 1, day: { state: 'open', started: true, asks: [], snoozeUntil: null } }));
  assert.deepEqual([early.level, early.ask], [1, 1]);
});

test('the wrap-up time follows the person: their own, or their habit within bounds', () => {
  assert.equal(effectiveWrapAt('18:00', '17:30', [], '19:00'), '17:30');
  assert.equal(effectiveWrapAt('18:00', '18:50', [], '19:00'), '18:30', 'never later than 30 minutes before the register');
  assert.equal(effectiveWrapAt('18:00', null, [1100, 1110], '19:00'), '18:00', 'too few sends to learn from');
  assert.equal(effectiveWrapAt('18:00', null, [1110, 1115, 1120, 1125, 1100], '19:00'), '18:25');
  assert.equal(effectiveWrapAt('18:00', null, [900, 910, 920], '19:00'), '17:00', 'not more than an hour early');
});

// ---------------------------------------------------------------- permissions
test('who sees whose sheet', () => {
  const cfg = { managers: ['boss'], openSheets: false };
  const items = [{ giverId: 'meera', id: '1' }, { giverId: 'ravi', id: '2' }, { giverId: null, id: '3' }];
  assert.equal(sheetAccess({ id: 'priya', role: 'member' }, 'priya', cfg), 'all');
  assert.equal(sheetAccess({ id: 'boss', role: 'member' }, 'priya', cfg), 'all');
  assert.equal(sheetAccess({ id: 'meera', role: 'member' }, 'priya', cfg), 'given');
  assert.equal(sheetAccess({ id: 'g', role: 'guest' }, 'priya', { ...cfg, openSheets: true }), 'none');
  assert.equal(sheetAccess({ id: 'anil', role: 'member' }, 'priya', { ...cfg, openSheets: true }), 'all');
  assert.deepEqual(visibleItems({ id: 'meera', role: 'member' }, 'priya', items, cfg).map((x) => x.id), ['1']);
  assert.deepEqual(visibleItems({ id: 'anil', role: 'member' }, 'priya', items, cfg), []);
  assert.deepEqual(visibleItems({ id: 'anil', role: 'admin' }, 'priya', items, cfg), [], 'an administrator is not the management');
});

// ---------------------------------------------------------------- configuration
test('configuration is checked and tidied', () => {
  const known = (id: string) => ['a', 'b', 'c'].includes(id);
  const c = checkNibConfig({ givers: [{ userId: 'a', kind: 'area', scope: ' Area 4 ' }, { userId: 'zzz', kind: 'area' }, { userId: 'a', kind: 'area' }], managers: ['b', 'nobody'], workdays: [1, 2, 9], projects: [{ code: 'p-12', name: 'Refinery' }, { code: 'P-12' }] }, known);
  assert.deepEqual(c.givers, [{ userId: 'a', kind: 'area', scope: 'Area 4' }]);
  assert.deepEqual(c.managers, ['b']);
  assert.deepEqual(c.workdays, [1, 2]);
  assert.deepEqual(c.projects, [{ code: 'P-12', name: 'Refinery' }]);
  assert.throws(() => checkNibConfig({ wrapAt: '19:30', digestAt: '19:00' }, known), /wrap-up time comes before/);
  assert.throws(() => checkNibConfig({ digestAt: '7pm' }, known), /time like/);
  assert.throws(() => checkNibConfig({ workdays: [] }, known), /workday/);
  assert.deepEqual(projectsFromText('P-12 Refinery revamp\nP-14: Tank farm\n\n'), [{ code: 'P-12', name: 'Refinery revamp' }, { code: 'P-14', name: 'Tank farm' }]);
});

// ---------------------------------------------------------------- cards
let seq = 0;
const item = (userId: string, over: Partial<NibItem> = {}): NibItem => ({
  id: `i${++seq}`, userId, date: '2026-11-12', giverId: 'meera', giverName: null, project: 'P-12', activity: 'Routing', qty: { done: 5, total: 10, unit: 'sheets' },
  note: null, status: 'going', due: null, source: 'words', carried: false, messageId: null, coverFor: null, createdAt: 1, updatedAt: 1, ...over,
});
const day = (userId: string, over: Partial<NibDay> = {}): NibDay => ({ userId, date: '2026-11-12', givers: ['meera'], started: true, state: 'sent', sentAt: T(18), changedAt: null, note: null, blockers: null, asks: [], snoozeUntil: null, ...over });

test('totals add up within a unit only', () => {
  const t = unitTotals([item('a'), item('b', { qty: { done: 2, total: 4, unit: 'sheets' } }), item('c', { qty: { done: null, total: 12, unit: 'isos' }, status: 'done' })]);
  assert.deepEqual(t.find((x) => x.unit === 'sheets'), { unit: 'sheets', done: 7, total: 14, count: 2 });
  assert.deepEqual(t.find((x) => x.unit === 'isos'), { unit: 'isos', done: 12, total: 12, count: 1 });
  assert.equal(progressOf([item('a'), item('b', { status: 'done' })]), 0.75);
  assert.equal(qtyText({ done: 18, total: 40, unit: 'sheets' }), '18 / 40 sheets');
  assert.equal(qtyText({ done: 60, total: 100, unit: '%' }), '60%');
  assert.equal(qtyText({ done: null, total: 12, unit: 'isos' }), '12 isos');
});

test('a lead card: people who sent work from them, late marks, and who they wait for', () => {
  const days = [day('a'), day('b', { sentAt: T(19, 30) }), day('c', { state: 'open', sentAt: null }), day('d', { givers: ['ravi'] })];
  const items = [item('a'), item('a', { giverId: 'ravi' }), item('b'), item('c'), item('d', { giverId: 'ravi' })];
  const card = buildLeadCard({ date: '2026-11-12', giverId: 'meera', days, items, seen: new Map([['a', T(18, 10)]]), digestSentAt: T(19) });
  assert.deepEqual(card.rows.map((r) => r.userId), ['a', 'b']);
  assert.equal(card.rows[0].items.length, 1, 'only Meera\'s items');
  assert.equal(card.rows[0].seenAt, T(18, 10));
  assert.equal(card.rows[1].late, true);
  assert.deepEqual(card.waiting, ['c']);
  assert.deepEqual(card.totals[0].units[0], { unit: 'sheets', done: 10, total: 20, count: 2 });
});

/** A 40-person office: four departments, three on leave, four never report, one says nothing today. */
function forty() {
  const ppl: RegisterPerson[] = Array.from({ length: 40 }, (_, i) => ({ id: `u${i}`, name: `Person ${i}`, departmentId: `d${i % 4}`, departmentName: ['Piping', 'Structural', 'E&I', 'Civil'][i % 4] }));
  const days = new Map<string, NibDay>();
  const items: NibItem[] = [];
  const leave = new Map<string, { kind: 'annual' | 'sick'; to: string; half: null }>();
  const started = new Set<string>();
  const asks = new Map<string, number>();
  ppl.forEach((pp, i) => {
    if (i < 3) { leave.set(pp.id, { kind: i === 1 ? 'sick' : 'annual', to: '2026-11-13', half: null }); return; }
    started.add(pp.id);
    if (i >= 36) { days.set(pp.id, day(pp.id, { state: 'open', sentAt: null })); asks.set(pp.id, i - 34); return; }
    if (i === 35) { days.set(pp.id, day(pp.id, { state: 'nothing', sentAt: null })); return; }
    days.set(pp.id, day(pp.id, { sentAt: T(18, i % 50) }));
    items.push(item(pp.id, { project: i % 3 ? 'P-12' : 'P-14', qty: { done: i % 7, total: 10, unit: i % 2 ? 'sheets' : 'isos' } }));
    if (i % 5 === 0) items.push(item(pp.id, { activity: 'Clash check', status: 'blocked', note: 'waiting for vendor data', qty: null }));
  });
  return { ppl, days, items, leave, started, asks };
}

test('the register for 40 people: headline, departments, output, call-outs, leave and missing', () => {
  const o = forty();
  const r = buildRegister({ kind: 'daily', date: '2026-11-12', now: T(19), people: o.ppl, days: o.days, items: o.items, leave: o.leave, started: o.started, asks: o.asks, projects: [{ code: 'P-12', name: 'Refinery revamp' }] });
  assert.deepEqual(r.headline, { roster: 40, in: 37, reported: 33, nothing: 1, missing: 4, away: 0, leave: 3, blocked: 6 });
  assert.equal(r.groups.length, 4);
  assert.equal(r.groups.reduce((n, g) => n + g.cells.length, 0), 40);
  assert.equal(r.groups.find((g) => g.name === 'Piping')!.expected, 9);
  assert.equal(r.leave.length, 3);
  assert.deepEqual(r.missing.map((m) => [m.userId, m.asks]), [['u39', 5], ['u38', 4], ['u37', 3], ['u36', 2]]);
  assert.equal(r.projects[0].project, 'P-12');
  assert.equal(r.projects[0].name, 'Refinery revamp');
  assert.ok(r.units.some((u) => u.unit === 'sheets') && r.units.some((u) => u.unit === 'isos'));
  assert.equal(r.callouts.filter((c) => c.kind === 'blocker').length, 6);
  assert.equal(r.callouts[0].kind, 'blocker', 'blockers first');
  // cells are drawn blocked first, then reported, then the rest
  assert.equal(r.groups[0].cells[0].status, 'blocked');
});

test('the follow-up lists only the late sheets, and who is still missing', () => {
  const o = forty();
  o.days.set('u36', day('u36', { sentAt: T(20, 15) }));
  o.items.push(item('u36', { activity: 'Late routing' }));
  const r = buildRegister({ kind: 'followup', date: '2026-11-12', now: T(21), people: o.ppl, days: o.days, items: o.items, leave: o.leave, started: o.started, asks: o.asks, projects: [], since: T(19) });
  assert.deepEqual(r.late.map((l) => l.userId), ['u36']);
  assert.equal(r.late[0].items[0].activity, 'Late routing');
  assert.deepEqual(r.missing.map((m) => m.userId), ['u39', 'u38', 'u37']);
});

test('the register for 200 people is built in milliseconds', () => {
  const ppl: RegisterPerson[] = Array.from({ length: 200 }, (_, i) => ({ id: `u${i}`, name: `P${i}`, departmentId: `d${i % 9}`, departmentName: `Dept ${i % 9}` }));
  const days = new Map<string, NibDay>();
  const items: NibItem[] = [];
  for (const pp of ppl) {
    days.set(pp.id, day(pp.id));
    for (let k = 0; k < 4; k++) items.push(item(pp.id, { project: `P-${10 + (k % 6)}` }));
  }
  const started = new Set(ppl.map((x) => x.id));
  const t0 = performance.now();
  let r = null;
  for (let n = 0; n < 10; n++) r = buildRegister({ kind: 'daily', date: '2026-11-12', now: T(19), people: ppl, days, items, leave: new Map(), started, asks: new Map(), projects: [] });
  const ms = (performance.now() - t0) / 10;
  console.log(`register for 200 people and 800 items: ${ms.toFixed(2)} ms`);
  assert.ok(ms < 50, `took ${ms} ms`);
  assert.equal(r!.headline.reported, 200);
});

test('the week: people by day and each job by day', () => {
  const o = forty();
  const dates = ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13'];
  const regs = dates.map((d) => {
    const days = new Map([...o.days].map(([k, v]) => [k, { ...v, date: d }]));
    return buildRegister({ kind: 'daily', date: d, now: T(23), people: o.ppl, days, items: o.items.map((x) => ({ ...x, date: d })), leave: o.leave, started: o.started, asks: o.asks, projects: [] });
  });
  const byDate = new Map(dates.map((d) => [d, o.items.map((x) => ({ ...x, date: d }))]));
  const w = buildWeek(dates, regs, byDate, []);
  assert.equal(w.days.length, 5);
  assert.equal(w.people.length, 40);
  assert.equal(w.people[0].cells.length, 5);
  assert.equal(w.projects[0].perDay.length, 5);
  assert.equal(addDays('2026-11-30', 1), '2026-12-01');
});
