// The floor plan on the hub: the seed and its versions, who may see and change it, move plans
// (apply, undo, swaps, a department into a zone, effective dates), the directory's seat field,
// importing a pasted list, layout validation, hot desks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity } from '@dex/core';
import type { Conversation, FloorPlan, SeatingView } from '@dex/core';
import { HubClient } from '@dex/core/client';
import { office, until, me } from './office.ts';

const DAY = 86_400_000;
const ymd = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const P = (userId: string) => ({ kind: 'person' as const, userId });

async function told(c: HubClient, text: RegExp): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    for (const conv of (await c.request('conv.list')) as Conversation[]) {
      if (conv.kind !== 'direct') continue;
      const msgs = (await c.request('msg.list', { convId: conv.id })).messages;
      if (msgs.some((m) => text.test(m.body))) return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

test('the seed plan: Rev A, 153 seats, the half-cabins the drawing names reserved; everyone sees it, guests never', async () => {
  const { hub, owner, priya } = await office();
  const v: SeatingView = await priya.request('seating.get');
  assert.equal(v.version, 1);
  assert.equal(v.plan.seats.length, 153);
  assert.equal(v.revisions.length, 1);
  assert.equal(v.revisions[0].rev, 'A');
  assert.deepEqual(v.holders['HC-05'], { kind: 'reserved', label: '3D-Manager' });
  assert.equal(v.canEdit, false);
  assert.deepEqual(v.plans, []);
  const space = await owner.request('conv.create', { kind: 'space', name: 'Client', members: [] });
  const inv = await owner.request('admin.guests.invite', { spaceIds: [space.id], accessDays: 30, validDays: 7, uses: 1 });
  {
    const guest = new HubClient({ identity: createIdentity(), account: { username: 'ana', domain: 'CLIENTCO', displayName: 'Ana Client', hostname: 'ANA-LAPTOP' } });
    guest.setInvite(inv.code);
    guest.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
    await until(guest, (s) => s.kind === 'ready');
    await assert.rejects(guest.request('seating.get'), /people in the office/);
    guest.disconnect();
  }
});

test('permissions: members view only; an administrator names office managers, who can then edit', async () => {
  const { owner, priya, ravi } = await office();
  await assert.rejects(priya.request('seating.draft', { moves: [{ seatId: 'W-A01', to: P(me(ravi)) }] }), /administrators and office managers/);
  await assert.rejects(priya.request('admin.seating.managers', { userIds: [me(priya)] }), /administrators/);
  assert.deepEqual((await owner.request('admin.seating.managers', { userIds: [me(priya)] })).managers, [me(priya)]);
  assert.equal((await priya.request('seating.get')).canEdit, true);
  const draft = await priya.request('seating.draft', { moves: [{ seatId: 'W-A01', to: P(me(ravi)) }] });
  assert.equal(draft.status, 'draft');
  // drafts are only for editors to see
  assert.equal((await ravi.request('seating.get')).plans.length, 0);
  assert.equal((await owner.request('seating.get')).plans.length, 1);
  await owner.request('admin.seating.managers', { userIds: [] });
  await assert.rejects(priya.request('seating.discard', { id: draft.id }), /office managers/);
});

test('a move plan applies today: a revision, the seat field follows and is read-only, people are told once; undo puts it back', async () => {
  const { owner, priya, ravi } = await office();
  const today = ymd(Date.now());
  const plan = await owner.request('seating.draft', { title: 'Piping to the left benches', effective: today, moves: [{ seatId: 'W-A14', to: P(me(priya)) }, { seatId: 'W-A15', to: P(me(ravi)) }] });
  assert.deepEqual(plan.changes.map((c: { userId: string; to: string }) => c.to).sort(), ['W-A14', 'W-A15']);
  const applied = await owner.request('seating.apply', { id: plan.id });
  assert.equal(applied.status, 'applied');
  assert.equal(applied.rev, 'B');
  const v = await priya.request('seating.get');
  assert.deepEqual(v.holders['W-A14'], P(me(priya)));
  assert.equal(v.revisions[0].rev, 'B');
  assert.equal(v.notice?.seatId, 'W-A14');
  assert.equal(v.notice?.label, 'W-A14 · Left benches');
  const priyaNow = (await owner.request('directory.list')).users.find((u: { id: string }) => u.id === me(priya));
  assert.equal(priyaNow.profile.seatId, 'W-A14');
  assert.equal(priyaNow.profile.location, 'W-A14 · Left benches');
  assert.ok(await told(priya, /From today your seat is W-A14 · Left benches.*dexconnect:\/\/floor\/W-A14/), 'Priya is told, with a link that walks her there');
  // the free-text field is now derived
  await assert.rejects(priya.request('me.profile', { location: 'Bay 2' }), /floor plan/);
  await priya.request('me.profile', { location: 'W-A14 · Left benches', phone: '1234' });
  await assert.rejects(owner.request('admin.org.setProfile', { userId: me(priya), location: 'Cabin 1' }), /floor plan/);
  await priya.request('seating.seen', { planId: plan.id });
  assert.equal((await priya.request('seating.get')).notice, null);

  // a swap, then undo it
  const swap = await owner.request('seating.draft', { title: 'Swap', moves: [{ seatId: 'W-A14', to: P(me(ravi)) }, { seatId: 'W-A15', to: P(me(priya)) }] });
  await owner.request('seating.apply', { id: swap.id });
  let h = (await owner.request('seating.get')).holders;
  assert.deepEqual([h['W-A14'], h['W-A15']], [P(me(ravi)), P(me(priya))]);
  // the earlier plan cannot be undone while a later one stands
  await assert.rejects(owner.request('seating.undo', { id: plan.id }), /later plan/);
  const undone = await owner.request('seating.undo', { id: swap.id });
  assert.equal(undone.status, 'undone');
  const after = await owner.request('seating.get');
  h = after.holders;
  assert.deepEqual([h['W-A14'], h['W-A15']], [P(me(priya)), P(me(ravi))]);
  assert.equal(after.revisions[0].kind, 'undo');
  assert.match(after.revisions[0].note, /Undo of Rev C/);
  // compare: Rev B against Rev C
  const b = await owner.request('seating.rev', { rev: 'B' }), c = await owner.request('seating.rev', { rev: 'C' });
  assert.deepEqual(b.holders['W-A14'], P(me(priya)));
  assert.deepEqual(c.holders['W-A14'], P(me(ravi)));
  assert.equal(c.rev.changes.length, 2);
});

test('effective dates: a plan for next Monday waits, is listed for everyone, and takes effect on the day', async () => {
  const { hub, owner, priya } = await office();
  const monday = ymd(Date.now() + 5 * DAY);
  const plan = await owner.request('seating.draft', { title: 'Move', moves: [{ seatId: 'POD1-3', to: P(me(priya)) }] });
  const pub = await owner.request('seating.apply', { id: plan.id, effective: monday });
  assert.equal(pub.status, 'scheduled');
  let v = await priya.request('seating.get');
  assert.equal(v.holders['POD1-3'], undefined, 'not yet');
  assert.equal(v.plans.length, 1, 'published plans are shown to everyone');
  assert.equal(v.notice?.effective, monday);
  assert.ok(await told(priya, /From \w+day \d+ \w+ your seat is POD1-3 · Senior pods/));
  hub.seating.setClock(Date.parse(`${monday}T09:00:00`));
  hub.seating.tick();
  v = await priya.request('seating.get');
  assert.deepEqual(v.holders['POD1-3'], P(me(priya)));
  assert.equal(v.plans.length, 0);
  assert.equal(v.revisions[0].rev, 'B');
  hub.seating.setClock(null);
  // a scheduled plan can be taken back to draft
  const p2 = await owner.request('seating.draft', { moves: [{ seatId: 'POD1-4', to: P(me(priya)) }] });
  await owner.request('seating.apply', { id: p2.id, effective: ymd(Date.now() + 3 * DAY) });
  assert.equal((await owner.request('seating.undo', { id: p2.id })).status, 'draft');
});

test('a department into a zone: the preview, then one plan; people who do not fit are listed', async () => {
  const { owner, priya, ravi } = await office();
  const dep = await owner.request('admin.org.saveDepartment', { name: 'Piping' });
  for (const c of [priya, ravi]) await owner.request('admin.org.setProfile', { userId: me(c), departmentId: dep.id });
  // someone already sits on the first left-bench seat
  const first = await owner.request('seating.draft', { moves: [{ seatId: 'W-A01', to: P(me(owner)) }] });
  await owner.request('seating.apply', { id: first.id });
  const flow = await owner.request('seating.flow', { departmentId: dep.id, zoneId: 'A' });
  assert.deepEqual(flow.unplaced, []);
  assert.deepEqual(flow.changes.map((c: { to: string }) => c.to).sort(), ['W-A02', 'W-A03']);
  const draft = await owner.request('seating.draft', { title: 'Piping to the left benches', moves: flow.moves });
  await owner.request('seating.apply', { id: draft.id });
  const h = (await owner.request('seating.get')).holders;
  assert.deepEqual(h['W-A01'], P(me(owner)));
  assert.equal(new Set([JSON.stringify(h['W-A02']), JSON.stringify(h['W-A03'])]).size, 2);
  const tight = await owner.request('seating.flow', { userIds: [me(priya), me(ravi), me(owner)], seatIds: ['MD-01', 'MD-02'] });
  assert.equal(tight.unplaced.length, 1);
  await assert.rejects(owner.request('seating.flow', { departmentId: dep.id }), /Choose a zone/);
});

test('import: a pasted list is matched to the directory, uncertain names suggested; old free-text seats that name one', async () => {
  const { owner, priya, ravi } = await office();
  await owner.request('admin.org.setProfile', { userId: me(ravi), location: 'Desk W-B 07' });
  await owner.request('admin.org.setProfile', { userId: me(owner), location: 'Bay 2, Desk 4' });
  const { rows } = await owner.request('seating.importMatch', { text: 'seat_id,name_on_drawing\nW-A31, Priya\nW-A33, Ravi\nW-A35, Sharali\nW-A33, Priya\nQQ-1, Ravi\n' });
  assert.equal(rows.length, 5);
  assert.equal(rows[0].userId, me(priya), 'a Windows user name is a sure match');
  assert.equal(rows[1].userId, me(ravi));
  assert.match(rows[2].problem, /No one in the directory/);
  assert.match(rows[3].problem, /earlier line/);
  assert.match(rows[4].problem, /No seat/);
  await assert.rejects(priya.request('seating.importMatch', { text: 'W-A01, Ravi' }), /office managers/);
  const fromProfiles = await owner.request('seating.importProfiles');
  assert.deepEqual(fromProfiles.moves, [{ seatId: 'W-B07', to: P(me(ravi)) }]);
  assert.ok(fromProfiles.skipped.some((s: { location: string }) => s.location === 'Bay 2, Desk 4'));
});

test('layout: validation, no removing a held seat, versions; a stale save is refused', async () => {
  const { owner, priya } = await office();
  const v: SeatingView = await owner.request('seating.get');
  const plan: FloorPlan = structuredClone(v.plan);
  // duplicate IDs and overlaps are refused
  const dup = structuredClone(plan); dup.seats.push({ ...dup.seats[0] });
  await assert.rejects(owner.request('seating.layout', { plan: dup, baseVersion: 1 }), /W-A01 appears twice/);
  const over = structuredClone(plan); over.seats.push({ ...over.seats[0], id: 'W-A99', x: over.seats[0].x + 0.3 });
  await assert.rejects(owner.request('seating.layout', { plan: over, baseVersion: 1 }), /overlap/);
  // a bench of 4 added below the left benches, and a room renamed
  const next = structuredClone(plan);
  next.seats.push(
    { id: 'W-A54', x: 30.5, y: 72.0, facing: 180, type: 'bench', zone: 'A', group: 'A7' }, { id: 'W-A55', x: 34.5, y: 72.0, facing: 180, type: 'bench', zone: 'A', group: 'A7' },
  );
  next.rooms.find((r) => r.id === 'room-a')!.name = 'Training room';
  const saved = await owner.request('seating.layout', { plan: next, baseVersion: 1, note: 'A bench below the half-cabins; Room A is the training room' });
  assert.equal(saved.version, 2);
  assert.equal(saved.rev, 'B');
  await assert.rejects(owner.request('seating.layout', { plan: next, baseVersion: 1 }), /meanwhile/);
  await assert.rejects(priya.request('seating.layout', { plan: next, baseVersion: 2 }), /office managers/);
  // a held seat cannot go
  const d = await owner.request('seating.draft', { moves: [{ seatId: 'W-A55', to: P(me(priya)) }] });
  await owner.request('seating.apply', { id: d.id });
  const without = structuredClone(next); without.seats = without.seats.filter((s) => s.id !== 'W-A55');
  await assert.rejects(owner.request('seating.layout', { plan: without, baseVersion: 2 }), /W-A55 is still held/);
  // comparing reads the layout the revision was drawn on
  assert.equal((await owner.request('seating.rev', { rev: 'A' })).plan.seats.length, 153);
  assert.equal((await owner.request('seating.rev', { rev: 'B' })).plan.seats.length, 155);
});

test('hot desks: bookable by the day, one person per seat; a leaver frees their seat', async () => {
  const { hub, owner, priya, ravi } = await office();
  const d = await owner.request('seating.draft', { moves: [{ seatId: 'W-C42', to: { kind: 'hot' } }, { seatId: 'W-C41', to: P(me(ravi)) }] });
  await owner.request('seating.apply', { id: d.id });
  const today = ymd(Date.now());
  await priya.request('seating.book', { seatId: 'W-C42', day: today });
  await assert.rejects(ravi.request('seating.book', { seatId: 'W-C42', day: today }), /Priya has booked it/);
  await assert.rejects(ravi.request('seating.book', { seatId: 'W-C41', day: today }), /not a hot desk/);
  await assert.rejects(ravi.request('seating.book', { seatId: 'W-C42', day: ymd(Date.now() + 30 * DAY) }), /two weeks/);
  assert.deepEqual((await ravi.request('seating.get')).bookings, [{ seatId: 'W-C42', day: today, userId: me(priya) }]);
  await priya.request('seating.book', { seatId: null, day: today });
  assert.deepEqual((await ravi.request('seating.get')).bookings, []);
  hub.seating.personLeft(me(ravi));
  assert.equal((await owner.request('seating.get')).holders['W-C41'], undefined);
  const raviNow = (await owner.request('directory.list')).users.find((u: { id: string }) => u.id === me(ravi));
  assert.equal(raviNow.profile.seatId, undefined);
  assert.equal(raviNow.profile.location, null);
});
