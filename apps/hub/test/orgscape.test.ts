// The org chart's Spaces overlay: who works together, without leaking what someone cannot see.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity } from '@dex/core';
import { HubClient } from '@dex/core/client';
import { office, until, me } from './office.ts';

test('people.spaces: open Spaces and your own private ones, with colleagues as members', async () => {
  const { hub, owner, priya, ravi } = await office();
  const open = await owner.request('conv.create', { kind: 'space', name: 'P-12 Piping', members: [me(priya)] });
  const mine = await owner.request('conv.create', { kind: 'space', name: 'Bid team', private: true, members: [me(priya)] });
  const hidden = await owner.request('conv.create', { kind: 'space', name: 'Salaries', private: true, members: [me(ravi)] });
  const old = await owner.request('conv.create', { kind: 'space', name: 'Old job', members: [me(priya), me(ravi)] });
  await owner.request('conv.archive', { convId: old.id, archived: true });
  // a guest in the open Space is not shown as a member
  const inv = await owner.request('admin.guests.invite', { spaceIds: [open.id], accessDays: 30, validDays: 7, uses: 1 });
  const guest = new HubClient({ identity: createIdentity(), account: { username: 'ana', domain: 'CLIENTCO', displayName: 'Ana Client', hostname: 'ANA-LAPTOP' } });
  guest.setInvite(inv.code);
  guest.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
  await until(guest, (s) => s.kind === 'ready');

  const forPriya = (await priya.request('people.spaces')).spaces;
  const names = forPriya.map((s) => s.name);
  assert.ok(names.includes('P-12 Piping') && names.includes('Bid team'));
  assert.ok(!names.includes('Salaries'), 'a private Space she is not in stays hidden');
  assert.ok(!forPriya.some((s) => s.id === hidden.id));
  assert.ok(!forPriya.some((s) => s.name === 'Office' || s.name === 'Old job'), 'no Office-wide or archived Spaces');
  const p12 = forPriya.find((s) => s.id === open.id)!;
  assert.deepEqual(p12.memberIds.sort(), [me(owner), me(priya)].sort(), 'the guest is left out');
  assert.equal(p12.mine, true);
  assert.equal(forPriya.find((s) => s.id === mine.id)!.mine, true);

  // Ravi sees the open Space (not his) and his own private one, not Priya's private one
  const forRavi = (await ravi.request('people.spaces')).spaces;
  assert.equal(forRavi.find((s) => s.id === open.id)!.mine, false);
  assert.ok(forRavi.some((s) => s.id === hidden.id));
  assert.ok(!forRavi.some((s) => s.id === mine.id));
  // guests get nothing
  assert.deepEqual((await guest.request('people.spaces')).spaces, []);
  guest.disconnect();
});
