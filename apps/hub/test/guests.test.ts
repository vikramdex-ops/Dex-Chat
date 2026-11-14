import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIdentity } from '@dex/core';
import { HubClient } from '@dex/core/client';
import type { ClientState } from '@dex/core/client';
import { office, until, me, send } from './office.ts';

test('guests join with an invite, see only their Spaces and people, and expire', async () => {
  const { hub, owner, priya, ravi } = await office();
  const project = await owner.request('conv.create', { kind: 'space', name: 'Client P-12', members: [me(priya)] });
  await owner.request('conv.create', { kind: 'space', name: 'Internal only', members: [me(ravi)] });
  const officeSpace = (await owner.request('conv.list')).find((c) => c.everyone)!;
  await assert.rejects(priya.request('admin.guests.invite', { spaceIds: [project.id], accessDays: 30, validDays: 7, uses: 1 }), /administrators/);
  await assert.rejects(owner.request('admin.guests.invite', { spaceIds: [officeSpace.id], accessDays: 30, validDays: 7, uses: 1 }), /other than Office/);
  const inv = await owner.request('admin.guests.invite', { spaceIds: [project.id], accessDays: 30, validDays: 7, uses: 1, note: 'Client engineer' });
  assert.match(inv.code, /^DEX-[A-Z2-9]{5}-[A-Z2-9]{5}$/);

  const joinAsGuest = (code: string, username: string) => {
    const g = new HubClient({ identity: createIdentity(), account: { username, domain: 'CLIENTCO', displayName: 'Ana Client', hostname: 'ANA-LAPTOP' } });
    g.setInvite(code);
    g.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
    return g;
  };
  const guest = joinAsGuest(inv.code.toLowerCase(), 'ana');
  await until(guest, (s) => s.kind === 'ready');
  const s = guest.session!;
  assert.equal(s.me.role, 'guest');
  // sees herself, Vikram and Priya (the Space's members), not Ravi
  assert.deepEqual(s.users.map((u) => u.displayName).sort(), ['Ana Client', 'Priya', 'Vikram']);
  const convs = await guest.request('conv.list');
  assert.deepEqual(convs.map((c) => c.name), ['Client P-12'], 'only the invited Space, not Office');
  assert.deepEqual(await guest.request('conv.browse'), []);
  await send(guest, project.id, 'Hello from the client side');
  await assert.rejects(guest.request('conv.create', { kind: 'space', name: 'Mine' }), /cannot create Spaces/);
  await assert.rejects(guest.request('conv.create', { kind: 'direct', members: [me(ravi)] }), /from their Spaces/);
  const dm = await guest.request('conv.create', { kind: 'direct', members: [me(priya)] });
  assert.equal(dm.kind, 'direct');
  await assert.rejects(guest.request('work.checkIn', { mode: 'office' }), /members of the office/);

  // a used-up code is refused with a reason
  const second = joinAsGuest(inv.code, 'bob');
  await until(second, (st) => st.kind === 'rejected');
  assert.match((second.state as Extract<ClientState, { kind: 'rejected' }>).reason, /already been used/);
  second.disconnect();

  // time runs out: the guest is disconnected and the device revoked
  hub.guests.tick(Date.now() + 31 * 86400_000);
  await until(guest, (st) => st.kind === 'rejected');
  assert.ok((await owner.request('admin.devices')).some((d) => d.account.endsWith('ana') && d.status === 'revoked'));
  guest.disconnect();
});
