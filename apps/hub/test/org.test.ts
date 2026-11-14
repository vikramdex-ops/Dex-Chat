import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { OrgInfo, PublicUser } from '@dex/core';
import { office, nextEvent, me } from './office.ts';

test('departments, reporting lines and profiles; only admins edit them', async () => {
  const { owner, priya, ravi } = await office();
  await assert.rejects(priya.request('admin.org.saveDepartment', { name: 'Piping' }), /administrators/);
  const updated = nextEvent<OrgInfo>(priya, 'org.updated');
  const piping = await owner.request('admin.org.saveDepartment', { name: 'Piping' });
  assert.equal((await updated).departments[0].name, 'Piping');
  const stress = await owner.request('admin.org.saveDepartment', { name: 'Stress', parentId: piping.id });
  assert.equal(stress.parentId, piping.id);
  await assert.rejects(owner.request('admin.org.saveDepartment', { name: 'piping' }), /already exists/);
  await assert.rejects(owner.request('admin.org.saveDepartment', { id: piping.id, name: 'Piping', parentId: stress.id }), /own sub-departments/);

  const seen = nextEvent<PublicUser>(ravi, 'user.updated', (u) => u.id === me(priya));
  const p = await owner.request('admin.org.setProfile', {
    userId: me(priya), title: 'Senior Piping Designer', departmentId: piping.id, managerId: me(owner),
    phone: '+91 98450 00000', extension: '214', email: 'priya@example.com', joinedOn: '2021-04-12', birthday: '7-9',
  });
  assert.equal(p.title, 'Senior Piping Designer');
  assert.deepEqual({ ...p.profile, fields: undefined }, {
    departmentId: piping.id, managerId: me(owner), phone: '+91 98450 00000', extension: '214', location: null,
    email: 'priya@example.com', employeeId: null, joinedOn: '2021-04-12', birthday: '07-09', fields: undefined,
  });
  assert.equal((await seen).profile.departmentId, piping.id, 'everyone sees the change live');
  await owner.request('admin.org.setProfile', { userId: me(ravi), managerId: me(priya) });
  // no loops in the reporting line
  await assert.rejects(owner.request('admin.org.setProfile', { userId: me(owner), managerId: me(ravi) }), /already reports/);
  await assert.rejects(owner.request('admin.org.setProfile', { userId: me(ravi), joinedOn: '12/04/2021' }), /2024-06-30/);
  await assert.rejects(owner.request('admin.org.setProfile', { userId: me(ravi), email: 'nope' }), /email/);

  // people keep their own contact details current, but cannot move departments
  const self = await ravi.request('me.profile', { phone: '080 4000 1234', location: 'Bay 3, Desk 12' });
  assert.equal(self.profile.location, 'Bay 3, Desk 12');
  assert.equal(self.profile.managerId, me(priya));

  // custom fields
  const fields = await owner.request('admin.org.saveFields', { fields: [{ label: 'Blood group' }, { label: 'Software' }] });
  await assert.rejects(owner.request('admin.org.saveFields', { fields: [{ label: 'A' }, { label: 'a' }] }), /twice/);
  const withFields = await owner.request('admin.org.setProfile', { userId: me(ravi), fields: { [fields[0].id]: 'O+', bogus: 'x' } });
  assert.deepEqual(withFields.profile.fields, { [fields[0].id]: 'O+' });

  // deleting a department moves its people out and its children up
  await owner.request('admin.org.deleteDepartment', { id: piping.id });
  const info = await priya.request('org.get');
  assert.equal(info.departments.find((x) => x.id === stress.id)?.parentId, null);
  const dir = await priya.request('directory.list');
  assert.equal(dir.users.find((u) => u.id === me(priya))?.profile.departmentId, null);
});

test('CSV import: dry run, departments created, managers in any order, people who join later', async () => {
  const { owner, priya, join } = await office();
  const rows = [
    { account: 'ravi', title: 'Draughtsman', department: 'Civil', manager: 'anita' },
    { account: 'DEX\\anita', displayName: 'Anita Rao', title: 'Civil Lead', department: 'Civil', extension: '301' },
    { account: 'priya', department: 'Piping', joinedOn: '2020-01-01', fields: { Software: 'AutoCAD Plant 3D' } },
    { account: '', title: 'nobody' },
    { account: 'kiran', joinedOn: 'last year' },
    { account: 'priya', manager: 'priya' },
  ];
  await owner.request('admin.org.saveFields', { fields: [{ label: 'Software' }] });
  const dry = await owner.request('admin.org.import', { rows, dryRun: true });
  assert.equal(dry.departmentsCreated, 2);
  assert.equal((await owner.request('org.get')).departments.length, 0, 'a dry run changes nothing');
  const res = await owner.request('admin.org.import', { rows });
  assert.deepEqual({ updated: res.updated, waiting: res.waiting, departmentsCreated: res.departmentsCreated }, { updated: 3, waiting: 1, departmentsCreated: 2 });
  assert.deepEqual(res.problems.map((p) => p.row), [5, 6, 7]);
  const dir = await priya.request('directory.list');
  const ravi = dir.users.find((u) => u.account.endsWith('ravi'))!;
  assert.equal(ravi.title, 'Draughtsman');
  assert.equal(ravi.profile.managerId, null, 'Anita has not joined yet');
  const p = dir.users.find((u) => u.id === me(priya))!;
  const fields = (await owner.request('org.get')).fields;
  assert.equal(p.profile.fields[fields[0].id], 'AutoCAD Plant 3D');
  // Anita installs the app: her imported name and title apply, and Ravi now reports to her
  const raviNow = nextEvent<PublicUser>(priya, 'user.updated', (u) => u.id === ravi.id && u.profile.managerId !== null);
  const { identity } = await join('anita');
  await owner.request('admin.decide', { deviceId: identity.deviceId, approve: true });
  const anita = (await priya.request('directory.list')).users.find((u) => u.account.endsWith('anita'))!;
  assert.equal(anita.displayName, 'Anita Rao');
  assert.equal(anita.title, 'Civil Lead');
  assert.equal(anita.profile.extension, '301');
  assert.equal((await raviNow).profile.managerId, anita.id);
});
