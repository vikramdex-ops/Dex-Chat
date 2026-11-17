// The office drawing (Directory ▸ Org chart): the general arrangement of reporting lines, the
// floor plan from seats, routes between two people and the keyboard's way along the lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Department, PublicUser } from '@dex/core';
import { PLATE_H, PLATE_W, chainUp, gridRef, layoutGA, managerMap, marksFor, neighbour, routeBetween, routeLines } from '../src/renderer/orgscape/layout.ts';
import { layoutFloor, nearestSpot, parseSeat } from '../src/renderer/orgscape/floor.ts';

let n = 0;
function person(id: string, managerId: string | null, departmentId: string | null, extra: Partial<PublicUser['profile']> = {}): PublicUser {
  return {
    id, account: `dex\\${id}`, displayName: id[0].toUpperCase() + id.slice(1), role: 'member', title: null, statusText: null, availability: 'available', createdAt: n++,
    profile: { departmentId, managerId, phone: null, extension: null, location: null, email: null, employeeId: null, joinedOn: null, birthday: null, fields: {}, ...extra },
    availabilityUntil: null, ooo: null,
  } as PublicUser;
}
const depts = new Map<string, Department>([
  ['m', { id: 'm', name: 'Management', parentId: null, headId: null, createdAt: 0 }],
  ['p', { id: 'p', name: 'Piping', parentId: null, headId: null, createdAt: 0 }],
  ['s', { id: 's', name: 'Structural', parentId: null, headId: null, createdAt: 0 }],
]);
const office = [
  person('vikram', null, 'm'), person('meera', 'vikram', 'm'),
  person('priya', 'meera', 'p'), person('ravi', 'priya', 'p'), person('rahul', 'ravi', 'p'), person('deepa', 'priya', 'p'),
  person('anand', 'meera', 's'), person('sneha', 'anand', 's'),
  person('loner', null, 's'), person('nobody', null, null),
];

/** A seeded office of n people, several levels deep. */
function big(count: number): PublicUser[] {
  const out = [person('top', null, 'm')];
  let s = 11;
  const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let i = 1; i < count; i++) out.push(person(`p${i}`, out[Math.floor(r() * Math.min(i, 40 + i / 3))].id, ['m', 'p', 's'][i % 3]));
  return out;
}

const overlap = (a: { x: number; y: number }, b: { x: number; y: number }) => a.x < b.x + PLATE_W && b.x < a.x + PLATE_W && a.y < b.y + PLATE_H && b.y < a.y + PLATE_H;

test('every person gets a plate, none overlap, and every reporting line ends on its plate', () => {
  for (const people of [office, big(500)]) {
    const ga = layoutGA(people, depts);
    assert.equal(ga.plates.size, people.length);
    const list = [...ga.plates.values()];
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) assert.ok(!overlap(list[i], list[j]), `${list[i].id} and ${list[j].id} overlap`);
    for (const p of list) {
      assert.ok(p.x >= 0 && p.y >= 0 && p.x + PLATE_W <= ga.w && p.y + PLATE_H <= ga.h, `${p.id} on the sheet`);
      const e = ga.edges.get(p.id);
      if (!p.managerId) { assert.equal(e, undefined); continue; }
      assert.ok(e, `a line into ${p.id}`);
      const m = ga.plates.get(p.managerId)!;
      const [first, last] = [e[0], e[e.length - 1]];
      assert.equal(first[1], m.y + PLATE_H, 'leaves under the manager');
      assert.ok(first[0] > m.x && first[0] < m.x + PLATE_W);
      assert.equal(last[1], p.y, 'arrives on top of the plate');
      // orthogonal runs only
      for (let k = 1; k < e.length; k++) assert.ok(e[k][0] === e[k - 1][0] || e[k][1] === e[k - 1][1]);
    }
    // no line runs through anyone else's plate
    for (const [id, e] of ga.edges) {
      const mine = new Set([id, ga.plates.get(id)!.managerId]);
      for (let k = 1; k < e.length; k++) {
        const [x0, x1] = [Math.min(e[k - 1][0], e[k][0]), Math.max(e[k - 1][0], e[k][0])];
        const [y0, y1] = [Math.min(e[k - 1][1], e[k][1]), Math.max(e[k - 1][1], e[k][1])];
        for (const q of list) {
          if (mine.has(q.id)) continue;
          assert.ok(!(x0 < q.x + PLATE_W && x1 > q.x && y0 < q.y + PLATE_H && y1 > q.y), `the line into ${id} crosses ${q.id}`);
        }
      }
    }
  }
});

test('departments become areas; people with no line manager are grouped', () => {
  const ga = layoutGA(office, depts);
  const names = ga.areas.map((a) => a.name);
  assert.ok(names.includes('Management') && names.includes('Piping') && names.includes('Structural'));
  const piping = ga.areas.find((a) => a.name === 'Piping')!;
  assert.deepEqual([...piping.members].sort(), ['deepa', 'priya', 'rahul', 'ravi']);
  assert.equal(ga.plates.get('rahul')!.area, ga.areas.indexOf(piping));
  // the management area holds everyone below it too
  assert.equal(ga.areas.find((a) => a.name === 'Management')!.members.length, 8);
  assert.ok(ga.hasLines);
  assert.equal(ga.plates.get('loner')!.managerId, null);
  assert.match(ga.plates.get('rahul')!.ref, /^[A-Z]+\d+$/);
  assert.equal(gridRef(0, 0), 'A1');
});

test('a loop of line managers is broken, not followed for ever', () => {
  const loop = [person('a', 'c', null), person('b', 'a', null), person('c', 'b', null), person('d', 'd', null)];
  const parent = managerMap(loop);
  assert.equal([...parent.values()].filter((v) => v === null).length, 2);
  const ga = layoutGA(loop, depts);
  assert.equal(ga.plates.size, 4);
  assert.ok(chainUp('a', ga).length <= 3);
});

test('a route joins two people through the nearest manager they share', () => {
  const ga = layoutGA(office, depts);
  assert.deepEqual(routeBetween('rahul', 'sneha', ga), ['rahul', 'ravi', 'priya', 'meera', 'anand', 'sneha']);
  assert.deepEqual(routeBetween('priya', 'rahul', ga), ['priya', 'ravi', 'rahul']);
  assert.equal(routeBetween('rahul', 'loner', ga), null);
  const lines = routeLines(routeBetween('rahul', 'sneha', ga)!, ga);
  assert.equal(lines.length, 5);
  // each step continues where the last one ended (up the lines, then down)
  assert.deepEqual(lines[0][0], ga.edges.get('rahul')![3]);
});

test('arrow keys walk the lines', () => {
  const ga = layoutGA(office, depts);
  assert.equal(neighbour('ravi', 'up', ga), 'priya');
  assert.equal(neighbour('ravi', 'down', ga), 'rahul');
  const peers = ga.plates.get('priya')!.reports;
  assert.equal(peers.length, 2);
  const right = neighbour('ravi', 'right', ga) ?? neighbour('ravi', 'left', ga);
  assert.equal(right, 'deepa');
  assert.equal(neighbour('vikram', 'up', ga), null);
});

test('lays out 500 people quickly', () => {
  const people = big(500);
  const t = performance.now();
  for (let i = 0; i < 5; i++) layoutGA(people, depts);
  const ms = (performance.now() - t) / 5;
  assert.ok(ms < 60, `${ms.toFixed(1)} ms`);
});

test('seats are read as people type them', () => {
  assert.deepEqual(parseSeat('Bay 2, Desk 4'), { kind: 'bay', bay: '2', desk: 4 });
  assert.deepEqual(parseSeat('bay 3 desk 12'), { kind: 'bay', bay: '3', desk: 12 });
  assert.deepEqual(parseSeat('Bay B'), { kind: 'bay', bay: 'B', desk: null });
  assert.deepEqual(parseSeat('Cabin 1'), { kind: 'cabin', name: '1' });
  assert.deepEqual(parseSeat('Front office'), { kind: 'place', name: 'Front office' });
  assert.equal(parseSeat(''), null);
  assert.equal(parseSeat(null), null);
});

test('the floor plan seats people at their desks; people working elsewhere stand in the off-site key', () => {
  const people = [
    person('a', null, null, { location: 'Bay 2, Desk 1' }), person('b', null, null, { location: 'Bay 2, Desk 4' }), person('c', null, null, { location: 'Bay 2' }),
    person('d', null, null, { location: 'Cabin 1' }), person('e', null, null, { location: 'Front office' }), person('f', null, null, { location: 'Site — Dahej' }),
    person('g', null, null), person('h', null, null, { location: 'Bay 1, Desk 1' }),
  ];
  const floor = layoutFloor(people, (id) => (id === 'h' ? 'home' : id === 'a' ? 'office' : null));
  assert.equal(floor.spots.size, people.length);
  assert.equal(floor.spots.get('a')!.desk, 'D1');
  assert.equal(floor.spots.get('b')!.desk, 'D4');
  assert.equal(floor.spots.get('c')!.desk, 'D2', 'the first free desk');
  assert.equal(floor.spots.get('d')!.where, 'cabin');
  assert.equal(floor.spots.get('e')!.where, 'place');
  assert.equal(floor.spots.get('f')!.where, 'away');
  assert.equal(floor.spots.get('g')!.where, 'unseated');
  assert.equal(floor.spots.get('h')!.where, 'away');
  assert.deepEqual(floor.away.find((x) => x.mode === 'home')!.people, ['h']);
  // h's desk stays drawn, empty for today
  assert.ok(floor.desks.some((d) => d.occupant === 'h'));
  assert.deepEqual(floor.rooms.map((r) => r.key), ['bay:1', 'bay:2', 'cabin:1', 'place:front office']);
  assert.equal(nearestSpot('a', 'right', floor) !== null, true);
});

test('new joiners, birthdays and work anniversaries', () => {
  const now = new Date(2026, 10, 15, 10);
  assert.equal(marksFor(person('x', null, null, { joinedOn: '2026-11-01' }), now).isNew, true);
  assert.equal(marksFor(person('x', null, null, { joinedOn: '2026-09-01' }), now).isNew, false);
  assert.equal(marksFor(person('x', null, null, { birthday: '11-15' }), now).birthday, true);
  assert.equal(marksFor(person('x', null, null, { joinedOn: '2021-11-15' }), now).years, 5);
  assert.equal(marksFor(person('x', null, null, { joinedOn: 'nonsense' }), now).years, 0);
});
