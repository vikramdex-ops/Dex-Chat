// Seating rules: the seed plan's counts and validity, moves, swaps, flowing a team into a zone,
// reading pasted lists, matching names and reading old free-text seats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMoves, benchSeats, checkMoves, diffHolders, flowMoves, matchName, mergeMoves, nextRevLetter, nextSeatIds, parseSeatList, placeMoves, podSeats,
  rotateSeats, seatFromText, seatLabel, swapMoves, validatePlan,
} from '../src/seating.ts';
import type { FloorPlan, Holders } from '../src/seating.ts';
import seed from '../../../apps/hub/seed/floor-l01.json' with { type: 'json' };

const plan = seed as unknown as FloorPlan;
const P = (userId: string) => ({ kind: 'person' as const, userId });

test('the seed is the office drawing: 153 seats in the counts the drawing gives, and valid', () => {
  assert.deepEqual(validatePlan(plan), []);
  const by = (z: string) => plan.seats.filter((s) => s.zone === z).length;
  assert.equal(by('A'), 53, 'WORKSTATIONS 53 Nos.');
  assert.equal(by('B'), 20, 'WORKSTATIONS 20 Nos.');
  assert.equal(by('P'), 18, 'SENIOR WORKSTATIONS 18 Nos.');
  assert.equal(by('C'), 42, 'WORKSTATIONS 42 Nos.');
  assert.equal(by('H'), 8);
  assert.equal(by('CC'), 9);
  assert.equal(plan.seats.length, 153);
  assert.ok(plan.seats.some((s) => s.id === 'HC-03') && plan.seats.some((s) => s.id === 'HC-10'), 'half-cabins keep the drawing\'s numbers');
  assert.equal(seatLabel(plan, 'W-A14'), 'W-A14 · Left benches');
  assert.equal(plan.columns.length, 12);
});

test('validation: duplicate IDs, overlapping seats, unknown zones', () => {
  const bad = structuredClone(plan);
  bad.seats.push({ ...bad.seats[0] });
  bad.seats.push({ ...bad.seats[1], id: 'W-A99', x: bad.seats[1].x + 0.4 });
  bad.seats.push({ ...bad.seats[2], id: 'X-1', zone: 'nowhere', x: 1, y: 100 });
  const p = validatePlan(bad);
  assert.ok(p.some((x) => /W-A01 appears twice/.test(x)));
  assert.ok(p.some((x) => /W-A02 and W-A99 overlap|W-A99 and W-A02 overlap/.test(x)));
  assert.ok(p.some((x) => /X-1 is in a zone that does not exist/.test(x)));
  assert.ok(validatePlan({ v: 1 }).length > 0);
});

test('moves: placing a person vacates their old seat; dropping on someone swaps', () => {
  const h: Holders = { 'W-A01': P('ann'), 'W-A02': P('bob') };
  assert.deepEqual(applyMoves(h, [{ seatId: 'W-A05', to: P('ann') }]), { 'W-A02': P('bob'), 'W-A05': P('ann') });
  const swap = placeMoves(h, 'ann', 'W-A02');
  assert.deepEqual(applyMoves(h, swap), { 'W-A01': P('bob'), 'W-A02': P('ann') });
  assert.deepEqual(applyMoves(h, swapMoves(h, 'W-A01', 'W-A03')), { 'W-A03': P('ann'), 'W-A02': P('bob') });
  // a person in two seats is refused
  assert.ok(checkMoves(plan, h, [{ seatId: 'W-A07', to: P('bob') }, { seatId: 'W-A08', to: P('bob') }]).some((x) => /bob would hold 2 seats/.test(x)));
  assert.ok(checkMoves(plan, h, [{ seatId: 'Z-9', to: null }]).some((x) => /no seat Z-9/.test(x)));
  const changes = diffHolders(h, applyMoves(h, swap));
  assert.deepEqual(changes.map((c) => [c.userId, c.from, c.to]), [['bob', 'W-A02', 'W-A01'], ['ann', 'W-A01', 'W-A02']].sort((a, b) => String(a[2]).localeCompare(String(b[2]), 'en', { numeric: true })));
  // a later line for the same person replaces the earlier placement
  const merged = mergeMoves([{ seatId: 'W-A10', to: P('cat') }], [{ seatId: 'W-A11', to: P('cat') }]);
  assert.deepEqual(applyMoves({}, merged), { 'W-A11': P('cat') });
});

test('flowing a team into a zone: free seats in order; people already there stay; the rest are listed', () => {
  const h: Holders = { 'W-A01': P('x'), 'W-B01': P('p1'), 'W-B02': P('p2'), 'W-A03': P('p3'), 'HC-05': { kind: 'reserved', label: '3D-Manager' } };
  const { moves, unplaced } = flowMoves(plan, h, ['p1', 'p2', 'p3'], { zoneId: 'A' });
  const after = applyMoves(h, moves);
  assert.deepEqual(unplaced, []);
  assert.deepEqual(after['W-A02'], P('p1'));
  assert.deepEqual(after['W-A04'], P('p2'));
  assert.deepEqual(after['W-A03'], P('p3'), 'p3 already sits in the zone');
  assert.equal(after['W-B01'], undefined);
  assert.deepEqual(after['W-A01'], P('x'), 'nobody else is moved');
  // more people than seats
  const tiny = flowMoves(plan, {}, ['a', 'b', 'c'], { seatIds: ['MD-01', 'MD-02'] });
  assert.deepEqual(tiny.unplaced, ['c']);
  // from a seat on
  const from = flowMoves(plan, {}, ['a', 'b'], { zoneId: 'A', fromSeat: 'W-A20' });
  assert.deepEqual(from.moves.map((m) => m.seatId), ['W-A20', 'W-A21']);
});

test('pasted lists and names: seat IDs in any spelling, names matched with suggestions', () => {
  const rows = parseSeatList('seat_id,name_on_drawing\nW-A14, Priya Raman\nwb03 → Logesh M\n"POD1-2"\tTamil\nZZ-1, Nobody\nW-C01 - \n', plan);
  assert.deepEqual(rows.map((r) => [r.seatId, r.name, r.problem]), [
    ['W-A14', 'Priya Raman', null], ['W-B03', 'Logesh M', null], ['POD1-2', 'Tamil', null], ['ZZ-1', 'Nobody', 'No seat with that ID on the plan.'], ['W-C01', '', 'No name on this line.'],
  ]);
  const people = [
    { id: '1', displayName: 'Priya Raman', account: 'DEX\\priya' }, { id: '2', displayName: 'Logesh Murugan' }, { id: '3', displayName: 'Logesh Dhanapal' },
    { id: '4', displayName: 'Tamilselvan K' }, { id: '5', displayName: 'Anand Pillai' }, { id: '6', displayName: 'Anand Pandey' },
  ];
  assert.deepEqual(matchName('Priya Raman', people), { userId: '1', sure: true, suggestions: [{ userId: '1', score: 1 }] });
  assert.equal(matchName('priya', people).userId, '1', 'the Windows user name is exact');
  const lm = matchName('Logesh M', people);
  assert.equal(lm.userId, '2', 'an initial picks the one Logesh');
  const an = matchName('Anand', people);
  assert.equal(an.sure, false, 'two Anands: ask');
  assert.deepEqual(an.suggestions.map((s) => s.userId).sort(), ['5', '6']);
  assert.equal(matchName('Anandh Pillai', people).suggestions[0].userId, '5', 'a typo still suggests');
  assert.equal(matchName('Tamil', people).sure, false, 'one word is never certain');
  assert.equal(matchName('Tamil', people).suggestions[0].userId, '4');
  assert.deepEqual(matchName('Zed', people).suggestions, []);
});

test('old free-text seats that name a seat plainly', () => {
  assert.equal(seatFromText('W-A14', plan), 'W-A14');
  assert.equal(seatFromText('Desk WA 14, Left benches', plan), 'W-A14');
  assert.equal(seatFromText('pod1-3', plan), 'POD1-3');
  assert.equal(seatFromText("MD's cabin 01", plan), 'MD-01');
  assert.equal(seatFromText('Reception', plan), 'REC-01');
  assert.equal(seatFromText('Bay 2, Desk 4', plan), null);
  assert.equal(seatFromText('Site - Dahej', plan), null);
});

test('layout editing: a bench of 4 takes the next IDs, pods face in, rotation turns seats', () => {
  assert.deepEqual(nextSeatIds(plan, 'W-A', 2), ['W-A54', 'W-A55']);
  const bench = benchSeats(plan, { zone: 'A', code: 'W-A', x: 5, y: 74, n: 4 });
  assert.deepEqual(bench.map((s) => [s.id, s.facing]), [['W-A54', 180], ['W-A55', 180], ['W-A56', 0], ['W-A57', 0]]);
  const next = { ...plan, seats: [...plan.seats, ...benchSeats(plan, { zone: 'C', code: 'W-C', x: 49, y: 104, n: 4 })] };
  assert.ok(validatePlan(next).some((x) => /overlap/.test(x)) || validatePlan(next).length === 0);
  const pod = podSeats(plan, { zone: 'P', code: 'POD3-', x: 10, y: 10 });
  assert.equal(pod.length, 6);
  assert.deepEqual(pod.map((s) => s.facing), [180, 240, 300, 0, 60, 120]);
  const turned = rotateSeats(bench, 90);
  assert.deepEqual(turned.map((s) => s.facing), [270, 270, 90, 90]);
  assert.equal(nextRevLetter(null), 'A');
  assert.equal(nextRevLetter('Z'), 'AA');
  assert.equal(nextRevLetter('C'), 'D');
});
