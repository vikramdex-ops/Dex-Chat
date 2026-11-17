// Tracked requests: checking a "track", each template's whole life in the bot maker's test run
// (the maker plays every part), queues with limited places, reminders and the register.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BotFlowError, validateFlow } from '../src/botflow-engine.ts';
import { BOT_TEMPLATES, testAct, testAnswer, testStart, testTick, testWithdraw } from '../src/botmaker.ts';
import type { TestRun } from '../src/botmaker.ts';
import { mainWay, nudgeDue, queueOf, registerView, seatKey, seatLimit, stageOf, trackAct, trackOpen, trackView } from '../src/botflow-track.ts';
import type { TrackPeople } from '../src/botflow-track.ts';
import type { BotFlowDefinition, BotItem } from '../src/bots.ts';

const ME = { id: 'u1', name: 'Priya Raman', account: 'DEX\\priya' };
const people = [{ id: 'u2', name: 'Vikram Shah' }, { id: 'u3', name: 'Ravi Kumar' }];
const NOW = new Date(2026, 10, 16, 10, 0).getTime(); // a Monday, 10:00
const H = 3600_000;
const ctx = { now: NOW, person: (v: string) => people.find((p) => p.id === v || p.name === v) ?? null, file: (v: string) => ({ id: v, name: `${v}.pdf` }) };
const day = (n: number) => { const d = new Date(NOW + n * 86400_000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const tpl = (id: string): BotFlowDefinition => validateFlow(BOT_TEMPLATES.find((t) => t.id === id)!.definition);
const answer = (def: BotFlowDefinition, given: Array<[string, string]>, lead: string | null = 'u2'): TestRun => {
  let t = testStart(def, ME, {}, lead);
  for (const [id, v] of given) t = testAnswer(t, id, v, ctx);
  assert.equal(t.status, 'done');
  return t;
};
const doneCard = (t: TestRun) => t.cards.find((c) => c.card?.kind === 'done')!.card!;

test('a track is checked like the steps: who acts, where each button goes, and that something finishes it', () => {
  const base = { name: 'x-y', title: 'X', steps: [{ id: 'who', prompt: 'Who?', input: { kind: 'person' } }, { id: 'when', prompt: 'When?', input: { kind: 'date' } }], finish: [] };
  const stage = { id: 'a', label: 'A', who: 'who', prompt: 'Do it', actions: [{ id: 'ok', label: 'OK', to: 'end' }] };
  const ok = validateFlow({ ...base, track: { ref: 'xy', stages: [stage] } });
  assert.equal(ok.track?.ref, 'XY');
  assert.throws(() => validateFlow({ ...base, track: { ref: 'TOOLONG', stages: [stage] } }), /one to four letters/);
  assert.throws(() => validateFlow({ ...base, track: { ref: 'X', stages: [{ ...stage, who: 'when' }] } }), /"who" is "requester", "lead"/);
  assert.throws(() => validateFlow({ ...base, track: { ref: 'X', stages: [{ ...stage, who: 'role:dc' }] } }), /role "dc", which is not in "roles"/);
  assert.throws(() => validateFlow({ ...base, track: { ref: 'X', stages: [{ ...stage, actions: [{ id: 'ok', label: 'OK', to: 'b' }] }] } }), /goes to "b", which is not a stage/);
  assert.throws(() => validateFlow({ ...base, track: { ref: 'X', stages: [{ ...stage, actions: [{ id: 'ok', label: 'OK', to: 'a' }] }] } }), /no button finishes it/);
  assert.throws(() => validateFlow({ ...base, track: { ref: 'X', stages: [{ ...stage, actions: [{ id: 'ok', label: 'OK', to: 'end', needsChecks: true }] }] } }), /no checklist/);
  assert.throws(() => validateFlow({ ...base, track: { ref: 'X', stages: [{ ...stage, due: 'who' }] } }), /asks for a date/);
  assert.throws(() => validateFlow({ ...base, track: { ref: 'X', stages: [stage], remind: { afterHours: 4, times: 1, escalate: 'boss' } } }), /passed up to/);
  assert.throws(() => validateFlow({ ...base, track: { ref: 'X', stages: [stage], register: { at: '9am' } } }), /like 09:15/);
  assert.throws(() => validateFlow({ ...base, track: { ref: 'X', stages: [stage], register: { to: 'role:nobody' } } }), /register goes to/);
  // what can be tidied is tidied
  const tidy = validateFlow({ ...base, track: { ref: 'X', stages: [stage], remind: { afterHours: 0, times: 9 }, register: { days: [9, 1, 1, 5], columns: ['who', 'nope'] } } });
  assert.deepEqual(tidy.track?.remind, { afterHours: 1, times: 5, escalate: 'lead' });
  assert.deepEqual(tidy.track?.register, { days: [1, 5], columns: ['who'] });
});

test('every tracked template is a working bot whose main way reads well', () => {
  const tracked = BOT_TEMPLATES.filter((t) => t.definition.track);
  assert.ok(tracked.length >= 6, `${tracked.length} tracked templates`);
  for (const t of tracked) {
    const def = validateFlow(t.definition);
    assert.ok(mainWay(def).length >= 1, t.id);
    assert.ok(def.track!.register?.to, `${t.id} posts its register somewhere`);
    for (const s of def.track!.stages) for (const a of s.actions) if (a.note) assert.ok(a.ask, `${t.id}/${s.id}/${a.id}: a note box has a label`);
  }
  assert.deepEqual(mainWay(tpl('drawing-issue')), ['check', 'approve', 'issue', 'receipt']);
  // the leave note is not tracked here (another bot looks after it)
  assert.equal(BOT_TEMPLATES.find((t) => t.id === 'leave-note')?.definition.track, undefined);
});

test('drawing check: checker returns it, the drafter corrects, back-check, lead approves, document control issues and records receipt', () => {
  const def = tpl('drawing-issue');
  let t = answer(def, [['job', 'P-12513'], ['drawings', 'ISO-1001-01\nISO-1001-02'], ['rev', 'C'], ['purpose', 'IFC'], ['checker', 'u3'], ['print', ''], ['due', day(3)], ['ok', 'yes']]);
  let v = doneCard(t).track!;
  assert.equal(v.ref, 'DC-0001');
  assert.equal(v.title, 'P-12513 · rev C IFC');
  assert.equal(v.stage?.who, 'u3', 'the checker chosen at the step');
  assert.equal(v.actingAs, 'Checker');
  assert.deepEqual(v.stage?.checklist.length, 4);
  // the clean pass needs the checklist; comments need words
  assert.throws(() => testAct(t, 'pass'), /Tick every line/);
  assert.throws(() => testAct(t, 'comments'), /Write the comments first/);
  t = testAct(t, 'comments', 'Tag 101-P-02 is missing on ISO-1001-02.', NOW + H);
  v = doneCard(t).track!;
  assert.equal(v.stage?.id, 'correct');
  assert.equal(v.stage?.who, 'u1', 'back with the person who asked');
  assert.match(v.stage?.prompt ?? '', /Tag 101-P-02 is missing/);
  assert.equal(v.stages.find((s) => s.id === 'check')?.state, 'returned');
  t = testAct(t, 'done', 'Tag added.', NOW + 2 * H);
  v = doneCard(t).track!;
  assert.equal(v.stage?.id, 'check');
  assert.equal(v.stage?.round, 2, 'round two of the check is the back-check');
  assert.equal(v.stages.find((s) => s.id === 'check')?.round, 2);
  for (let i = 0; i < 4; i++) t = testTick(t, i, true);
  t = testAct(t, 'pass', '', NOW + 3 * H);
  v = doneCard(t).track!;
  assert.equal(v.stage?.id, 'approve');
  assert.equal(v.stage?.who, 'u2', 'their lead');
  t = testAct(t, 'ok', '', NOW + 4 * H);
  assert.throws(() => testAct(t, 'issued'), /transmittal number/);
  t = testAct(t, 'issued', 'DDS-TR-0412', NOW + 5 * H);
  v = doneCard(t).track!;
  assert.match(v.stage?.prompt ?? '', /Transmittal DDS-TR-0412/);
  t = testAct(t, 'ack', 'Received by K. Menon', NOW + 30 * H);
  v = doneCard(t).track!;
  assert.equal(v.status, 'done');
  assert.equal(v.stamp, 'ISSUED');
  assert.ok(v.stages.every((s) => s.state === 'done'));
  assert.deepEqual(t.item!.history.map((e) => e.action), ['start', 'comments', 'done', 'pass', 'ok', 'issued', 'ack']);
});

test('plot request: approve, the plot room queue with its place, ready to collect, collected; or turned down', () => {
  const def = tpl('plot-request');
  const given: Array<[string, string]> = [['job', 'P-12513'], ['drawings', 'GA-200 rev B'], ['size', 'A1'], ['sets', '2'], ['due', day(2)], ['lead', 'u2'], ['ok', 'yes']];
  let t = answer(def, given);
  assert.equal(doneCard(t).prompt, 'Sent to Vikram Shah. The plot room starts once it is approved.');
  t = testAct(t, 'ok');
  assert.equal(doneCard(t).track?.stage?.label, 'Plot queue');
  assert.equal(doneCard(t).track?.actingAs, 'Plot room', 'a role nobody holds yet is the maker');
  t = testAct(t, 'start');
  t = testAct(t, 'ready', 'Tray 3, by the plotter.');
  assert.match(doneCard(t).track?.stage?.prompt ?? '', /ready to collect\. Tray 3/);
  t = testAct(t, 'got');
  assert.equal(doneCard(t).track?.stamp, 'COLLECTED');
  // turned down: stopped, with the reason
  let u = answer(def, given);
  assert.throws(() => testAct(u, 'no'), /Write the reason first/);
  u = testAct(u, 'no', 'Use the A3 check set.');
  assert.equal(u.item?.status, 'stopped');
  assert.equal(doneCard(u).track?.stamp, 'TURNED DOWN');
  // withdrawn by the person who asked
  const w = testWithdraw(answer(def, given));
  assert.equal(w.item?.status, 'withdrawn');
});

test('site visit: approval, gate pass, the safety checklist before going, the report after', () => {
  const def = tpl('site-visit');
  let t = answer(def, [['site', 'Refinery'], ['day', day(2)], ['job', 'P-12513'], ['people', '2'], ['purpose', 'Pipe rack walk-down'], ['contact', 'Mr Rao, 98400 12345'], ['ok', 'yes']]);
  t = testAct(t, 'ok');
  t = testAct(t, 'done', 'Car at 07:30 from the office; passes 41 and 42.');
  const v = doneCard(t).track!;
  assert.equal(v.stage?.id, 'prepare');
  assert.match(v.stage?.prompt ?? '', /Car at 07:30/);
  assert.ok(v.stage!.due! > NOW, 'due on the day of the visit');
  assert.throws(() => testAct(t, 'go'), /Tick every line/);
  for (let i = 0; i < v.stage!.checklist.length; i++) t = testTick(t, i, true);
  t = testAct(t, 'go');
  assert.throws(() => testAct(t, 'send'), /visit report/);
  t = testAct(t, 'send', 'Rack at grid C-4 clashes with the cable tray; action Ravi.');
  t = testAct(t, 'more', 'Add the photos, please.');
  assert.equal(doneCard(t).track?.stage?.id, 'report');
  t = testAct(t, 'send', 'Photos attached in the Space.');
  t = testAct(t, 'ok');
  assert.equal(doneCard(t).track?.stamp, 'REPORTED');
});

test('technical query: review, with the client, the answer back to the person who asked, closed', () => {
  const def = tpl('rfi-log');
  let t = answer(def, [['job', 'P-12513'], ['discipline', 'piping'], ['ref', 'GA-200 rev B'], ['question', 'Which nozzle orientation for P-101?'], ['proposal', 'As the vendor drawing.'], ['markup', ''], ['due', day(5)], ['ok', 'yes']]);
  assert.equal(doneCard(t).track?.title, 'P-12513 · Piping · GA-200 rev B');
  t = testAct(t, 'send');
  t = testAct(t, 'reply', 'Use the vendor drawing, rev 2.');
  const v = doneCard(t).track!;
  assert.equal(v.stage?.id, 'close');
  assert.match(v.stage?.prompt ?? '', /Use the vendor drawing, rev 2/);
  t = testAct(t, 'again', 'Rev 2 shows two nozzles; which one?');
  assert.equal(doneCard(t).track?.stage?.id, 'review');
  t = testAct(t, 'answer', 'N2, the upper one.');
  t = testAct(t, 'close');
  assert.equal(doneCard(t).track?.stamp, 'CLOSED');
});

// ---------------------------------------------------------------- the rules underneath, without the test run
const seatDef = tpl('licence-seat');
const lateDef = tpl('late-work');
const peopleOf = (lead: string): TrackPeople => ({ resolve: (who, item) => (who === 'requester' ? { id: item.requesterId } : who === 'lead' ? { id: lead } : { id: 'admin' }) });
const open = (def: BotFlowDefinition, n: number, requesterId: string, vars: Record<string, string>, now = NOW): BotItem =>
  trackOpen(def, { id: `i${n}`, num: n, requesterId, vars: Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, { value: v, label: v }])), lines: [], now, people: peopleOf('u2') });

test('software seats: places per software, the waiting line and who holds them now', () => {
  const use = stageOf(seatDef, 'use')!;
  const a = open(seatDef, 1, 'u1', { software: 'CAESAR II', job: 'P-1' });
  assert.equal(seatKey(use, a), 'CAESAR II');
  assert.equal(seatLimit(use, 'CAESAR II', a), 1);
  assert.equal(seatLimit(use, 'Something else'), 1, 'software not listed: one place');
  assert.equal(seatLimit(use, 'E3D'), 4);
  const b = { ...open(seatDef, 2, 'u3', { software: 'CAESAR II', job: 'P-2' }, NOW + H), waiting: true };
  const c = { ...open(seatDef, 3, 'u2', { software: 'CAESAR II', job: 'P-3' }, NOW + 2 * H), waiting: true };
  const q = queueOf(seatDef, c, [a, b, c])!;
  assert.deepEqual([q.position, q.of, q.key], [2, 2, 'CAESAR II']);
  assert.deepEqual(q.holders.map((h) => h.userId), ['u1']);
  // waiting: no buttons, and no reminders (no one to remind)
  assert.deepEqual(trackView(seatDef, c, 'u2', { now: NOW }).actions, []);
  assert.equal(nudgeDue(seatDef, c, NOW + 48 * H), null);
  const reg = registerView(seatDef, [a, b, c], [], { mode: 'all', viewerId: 'u1', now: NOW + 3 * H });
  const caesar = reg.seats.find((s) => s.key === 'CAESAR II')!;
  assert.deepEqual([caesar.seats, caesar.used.length, caesar.waiting.map((w) => w.ref)], [1, 1, ['LIC-0002', 'LIC-0003']]);
  assert.equal(reg.counts.waiting, 2);
  assert.ok(reg.seats.some((s) => s.key === 'E3D' && s.used.length === 0), 'every software listed, in use or not');
});

test('reminders: polite and limited — after the wait, up to the limit, then passed up once', () => {
  const item = open(lateDef, 1, 'u1', { day: day(0), until: '21:00', job: 'P-1', why: 'x', cab: 'yes' });
  // late work: after 2 hours, twice, never passed up
  assert.equal(nudgeDue(lateDef, item, NOW + H), null);
  assert.equal(nudgeDue(lateDef, item, NOW + 2 * H), 'nudge');
  assert.equal(nudgeDue(lateDef, { ...item, nudges: 1 }, NOW + 3 * H), null);
  assert.equal(nudgeDue(lateDef, { ...item, nudges: 1 }, NOW + 4 * H), 'nudge');
  assert.equal(nudgeDue(lateDef, { ...item, nudges: 2 }, NOW + 100 * H), null, 'escalate is "none"');
  // the drawing check: a day, twice, then their lead, once
  const dc = tpl('drawing-issue');
  const d = trackOpen(dc, { id: 'd', num: 1, requesterId: 'u1', vars: { checker: { value: 'u3', label: 'Ravi' }, due: { value: day(10), label: 'x' } }, lines: [], now: NOW, people: { resolve: (w, i) => (w === 'checker' ? { id: 'u3' } : { id: i.requesterId }) } });
  assert.equal(d.actorId, 'u3');
  assert.equal(nudgeDue(dc, { ...d, nudges: 2 }, NOW + 71 * H), null);
  assert.equal(nudgeDue(dc, { ...d, nudges: 2 }, NOW + 72 * H), 'escalate');
  assert.equal(nudgeDue(dc, { ...d, nudges: 2, escalated: true }, NOW + 500 * H), null);
  // overdue: the first reminder comes at once
  assert.equal(nudgeDue(dc, { ...d, due: NOW + H }, NOW + 2 * H), 'nudge');
});

test('the register: counts, the oldest, each stage, overdue first, and what closed this week', () => {
  const dc = tpl('drawing-issue');
  const mk = (n: number, at: number, due: number | null) => ({ ...trackOpen(dc, { id: `d${n}`, num: n, requesterId: 'u1', vars: { checker: { value: 'u3', label: 'Ravi' } }, lines: [], now: at, people: { resolve: () => ({ id: 'u3' }) } }), due });
  const items = [mk(1, NOW - 12 * 86400_000, null), mk(2, NOW - 2 * 86400_000, NOW - H), mk(3, NOW - 86400_000, null)];
  const done = { ...mk(4, NOW - 5 * 86400_000, null), status: 'done' as const, stamp: 'ISSUED', closedAt: NOW - 86400_000 };
  const reg = registerView(dc, items, [done], { mode: 'all', viewerId: 'u9', now: NOW });
  assert.deepEqual(reg.counts, { open: 3, overdue: 1, waiting: 0, closedWeek: 1 });
  assert.equal(reg.oldestDays, 12);
  assert.equal(reg.byStage.find((s) => s.id === 'check')?.open, 3);
  assert.equal(reg.rows[0].ref, 'DC-0002', 'overdue first');
  assert.equal(reg.rows[0].role, 'watcher');
  assert.equal(reg.closed[0].stamp, 'ISSUED');
  assert.equal(registerView(dc, items, [], { mode: 'all', viewerId: 'u9', now: NOW, limit: 2 }).more, 1);
  // only the person acting may act, and it says so
  assert.throws(() => trackAct(dc, items[0], 'pass', 'u1', NOW, { resolve: () => ({ id: 'u3' }) }), (e: Error) => e instanceof BotFlowError && /not waiting for you/.test(e.message));
});
