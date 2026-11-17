// Names from the office drawing (docs/SEATING.md, "Names from the drawing"): a fresh hub shows the
// 40 names on their seats; they are put there once and never again; people who join take their
// named seat when it is certainly them, and the rest wait for an office manager to confirm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIdentity } from '@dex/core';
import type { Conversation, DeviceIdentity as Identity, Holders } from '@dex/core';
import { HubClient } from '@dex/core/client';
import { Hub } from '../src/hub.ts';
import { cleanups, me, until } from './office.ts';
import names from '../seed/floor-l01-names.json' with { type: 'json' };

const P = (userId: string) => ({ kind: 'person' as const, userId });
const N = (name: string) => ({ kind: 'named' as const, name });
const named = (h: Holders) => Object.entries(h).filter(([, v]) => v.kind === 'named');

async function startHub(dir: string): Promise<Hub> {
  const hub = new Hub({ dataDir: dir, port: 0, host: '127.0.0.1', discoveryPort: false, updates: false });
  await hub.start();
  return hub;
}

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexseat-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Someone's PC: a Windows user name and the display name it reports. */
async function connect(hub: Hub, username: string, displayName: string, identity: Identity = createIdentity()): Promise<HubClient> {
  const c = new HubClient({ identity, account: { username, domain: 'DEX', displayName, hostname: `${username}-pc` } });
  cleanups.push(() => c.disconnect());
  c.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
  await until(c, (s) => s.kind === 'ready' || s.kind === 'pending');
  return c;
}

/** A hub with its owner, and a way for colleagues to join (their device approved by the owner). */
async function officeOf(ownerName = 'Asha Menon') {
  const dir = tempDir();
  const hub = await startHub(dir);
  cleanups.push(() => hub.stop());
  const owner = await connect(hub, 'asha', ownerName);
  const join = async (username: string, displayName: string) => {
    const identity = createIdentity();
    const c = await connect(hub, username, displayName, identity);
    await owner.request('admin.decide', { deviceId: identity.deviceId, approve: true });
    await until(c, (s) => s.kind === 'ready');
    return c;
  };
  return { hub, dir, owner, join };
}

async function told(c: HubClient, text: RegExp): Promise<number> {
  let n = 0;
  for (let i = 0; i < 30; i++) {
    n = 0;
    for (const conv of (await c.request('conv.list')) as Conversation[]) {
      if (conv.kind !== 'direct') continue;
      n += (await c.request('msg.list', { convId: conv.id })).messages.filter((m) => text.test(m.body)).length;
    }
    if (n) return n;
    await new Promise((r) => setTimeout(r, 100));
  }
  return n;
}

const audits = (hub: Hub, action: string) => hub.store.auditTrail(500).filter((a) => a.action === action);

test('a fresh hub shows the 40 names from the drawing on their seats, as Rev A', async () => {
  const { hub, owner } = await officeOf();
  assert.equal(names.source, 'Seating_Plan_18-Jul-2026');
  assert.equal(names.seats.length, 40);
  const v = await owner.request('seating.get');
  assert.equal(named(v.holders).length, 40);
  assert.deepEqual(v.holders['W-A31'], N('Sharada'));
  assert.deepEqual(v.holders['W-C21'], N('Karthikeyan A S'));
  assert.deepEqual(v.holders['REC-01'], N('Sandhya'));
  // the half-cabins the drawing names by role are still reserved
  assert.deepEqual(v.holders['HC-05'], { kind: 'reserved', label: '3D-Manager' });
  assert.deepEqual(v.revisions.map((r) => r.rev), ['A']);
  assert.match(v.revisions[0].note, /with the 40 names written on it/);
  assert.equal((await owner.request('seating.rev', { rev: 'A' })).holders['W-A31'].kind, 'named');
  // nobody has joined but the owner, so nothing waits to be matched
  assert.deepEqual(v.waiting, []);
  assert.equal(audits(hub, 'seating.claim').length, 0);
});

test('a colleague joins as "Sharada Venkat": seated at W-A31 at once, told once, audited; the directory follows', async () => {
  const { hub, owner, join } = await officeOf();
  const sharada = await join('sharada.v', 'Sharada Venkat');
  const v = await owner.request('seating.get');
  assert.deepEqual(v.holders['W-A31'], P(me(sharada)));
  assert.equal(named(v.holders).length, 39);
  assert.match(v.revisions[0].note, /W-A31 taken by Sharada Venkat \("Sharada" on the drawing\)/);
  assert.equal(v.revisions[0].by, null);
  const mine = await sharada.request('seating.get');
  assert.equal(mine.notice?.seatId, 'W-A31');
  assert.equal(mine.notice?.label, 'W-A31 · Left benches');
  assert.equal(await told(sharada, /Your seat is on the office floor plan: W-A31 · Left benches\. Walk there: dexconnect:\/\/floor\/W-A31/), 1);
  const dir = (await owner.request('directory.list')).users.find((u) => u.id === me(sharada))!;
  assert.equal(dir.profile.seatId, 'W-A31');
  assert.equal(dir.profile.location, 'W-A31 · Left benches');
  const a = audits(hub, 'seating.claim');
  assert.equal(a.length, 1);
  assert.equal(a[0].actor, null);
  assert.equal(a[0].target, 'W-A31');
  assert.deepEqual(a[0].detail, { userId: me(sharada), name: 'Sharada', auto: true });
  // a restart does not tell her again
  hub.seating.claimNamed();
  assert.equal(await told(sharada, /Your seat is on the office floor plan/), 1);
});

test('claim rules: exact, initials, the longest name wins, and only when nobody else fits', async () => {
  const { hub, owner, join } = await officeOf();
  // exact, whatever the case
  const madhu = await join('madhu', 'MADHU');
  // an initial: "Logesh M" is Logesh Murugan, "Logesh D" is not
  const logesh = await join('logesh.m', 'Logesh Murugan');
  // "Karthikeyan A S" beats "Karthikeyan A" for Karthikeyan A Senthil
  const senthil = await join('karthik.s', 'Karthikeyan A Senthil');
  let h = (await owner.request('seating.get')).holders;
  assert.deepEqual(h['W-A33'], P(me(madhu)));
  assert.deepEqual(h['POD1-5'], P(me(logesh)));
  assert.deepEqual(h['POD2-2'], N('Logesh D'));
  assert.deepEqual(h['W-C21'], P(me(senthil)));
  assert.deepEqual(h['W-C09'], N('Karthikeyan A'));
  // "Karthikeyan A S" is taken: plain "Karthikeyan A" must not grab a Karthikeyan A S… either
  const suresh = await join('karthik.su', 'Karthikeyan A Suresh');
  let v = await owner.request('seating.get');
  assert.deepEqual(v.holders['W-C09'], N('Karthikeyan A'));
  assert.deepEqual(v.waiting.find((w) => w.seatId === 'W-C09')?.suggestions.map((s) => s.userId), [me(suresh)]);
  // a second Karthikeyan A… fits too: still waiting, now with both
  const arun = await join('karthik.a', 'Karthikeyan Arun');
  v = await owner.request('seating.get');
  assert.deepEqual(v.holders['W-C09'], N('Karthikeyan A'));
  assert.deepEqual(new Set(v.waiting.find((w) => w.seatId === 'W-C09')?.suggestions.map((s) => s.userId)), new Set([me(suresh), me(arun)]));
  // a first name alone does not fit a longer name on the drawing ("Anand" is not "Anand Pandey"), nor a word that only starts it
  const anand = await join('anand', 'Anand');
  const sam = await join('samuel', 'Samuel Raj');
  h = (await owner.request('seating.get')).holders;
  assert.deepEqual(h['W-B06'], N('Anand Pandey'));
  assert.deepEqual(h['W-A52'], N('Sam'));
  assert.ok(!Object.values(h).some((x) => x.kind === 'person' && (x.userId === me(anand) || x.userId === me(sam))));
  const w = (await owner.request('seating.get')).waiting;
  assert.ok(w.find((x) => x.seatId === 'W-B06')?.suggestions.some((s) => s.userId === me(anand)), 'Anand is suggested for "Anand Pandey"');
  // every automatic claim is in the audit log
  assert.deepEqual(audits(hub, 'seating.claim').map((a) => a.target).sort(), ['POD1-5', 'W-A33', 'W-C21']);
  assert.ok(audits(hub, 'seating.claim').every((a) => (a.detail as { auto: boolean }).auto));
});

test('two people with the same first name wait to be matched; an office manager confirms one in one click', async () => {
  const { hub, owner, join } = await officeOf();
  const a = await join('pa', 'Someone A');
  const b = await join('pb', 'Someone B');
  // an import renames both at once: both are Pavithra, so W-A45 is nobody's for certain
  const r = await owner.request('admin.org.import', { rows: [{ account: 'DEX\\pa', displayName: 'Pavithra Ramesh' }, { account: 'DEX\\pb', displayName: 'Pavithra Suresh' }] });
  assert.equal(r.updated, 2);
  let v = await owner.request('seating.get');
  assert.deepEqual(v.holders['W-A45'], N('Pavithra'));
  const wait = v.waiting.find((x) => x.seatId === 'W-A45')!;
  assert.equal(wait.name, 'Pavithra');
  assert.deepEqual(new Set(wait.suggestions.map((s) => s.userId)), new Set([me(a), me(b)]));
  // members do not see the waiting list, and cannot confirm
  assert.deepEqual((await a.request('seating.get')).waiting, []);
  await assert.rejects(a.request('seating.claim', { seatId: 'W-A45', userId: me(a) }), /office managers/);
  await owner.request('seating.claim', { seatId: 'W-A45', userId: me(b) });
  v = await owner.request('seating.get');
  assert.deepEqual(v.holders['W-A45'], P(me(b)));
  assert.equal(v.waiting.some((x) => x.seatId === 'W-A45'), false);
  assert.equal(v.revisions[0].by, me(owner));
  assert.equal((await b.request('seating.get')).notice?.seatId, 'W-A45');
  // no double claim: the seat is taken, and a seated person cannot take a second named seat
  await assert.rejects(owner.request('seating.claim', { seatId: 'W-A45', userId: me(a) }), /no name from the drawing/);
  await assert.rejects(owner.request('seating.claim', { seatId: 'W-A33', userId: me(b) }), /already has seat W-A45/);
  const confirm = audits(hub, 'seating.claim');
  assert.equal(confirm.length, 1);
  assert.equal(confirm[0].actor, me(owner));
  assert.deepEqual(confirm[0].detail, { userId: me(b), name: 'Pavithra', auto: false });
  // a seated person renamed to another drawing name keeps their seat
  await b.request('me.update', { displayName: 'Mukesh' });
  assert.deepEqual((await owner.request('seating.get')).holders['W-A40'], N('Mukesh'));
  // a rename can make it certain: the other Pavithra becomes Praveen, who is on W-A36
  await a.request('me.update', { displayName: 'Praveen Kumar' });
  assert.deepEqual((await owner.request('seating.get')).holders['W-A36'], P(me(a)));
});

test('restarts never put the names back: a cleared or changed seat stays as it was changed', async () => {
  const dir = tempDir();
  let hub = await startHub(dir);
  const ownerId = createIdentity();
  let owner = await connect(hub, 'asha', 'Asha Menon', ownerId);
  const ownerUid = me(owner);
  const d = await owner.request('seating.draft', { moves: [{ seatId: 'W-A31', to: null }, { seatId: 'W-A33', to: { kind: 'hot' } }, { seatId: 'W-A35', to: P(ownerUid) }] });
  await owner.request('seating.apply', { id: d.id });
  const before = await owner.request('seating.get');
  assert.equal(named(before.holders).length, 37);
  owner.disconnect();
  await hub.stop();
  for (let i = 0; i < 2; i++) {
    hub = await startHub(dir);
    const h = hub.seating.holders();
    assert.equal(h['W-A31'], undefined, 'a cleared seat stays clear');
    assert.deepEqual(h['W-A33'], { kind: 'hot' });
    assert.deepEqual(h['W-A35'], P(ownerUid));
    assert.equal(named(h).length, 37);
    const revs = hub.store.db.prepare('SELECT rev FROM seat_revs ORDER BY n').all() as Array<{ rev: string }>;
    assert.deepEqual(revs.map((r) => r.rev), ['A', 'B'], 'no revision is added on a restart');
    await hub.stop();
  }
  hub = await startHub(dir);
  cleanups.push(() => hub.stop());
  owner = await connect(hub, 'asha', 'Asha Menon', ownerId);
  assert.equal(named((await owner.request('seating.get')).holders).length, 37);
});

test('a hub that was running before the names: they fill only the empty seats, once; nobody is displaced', async () => {
  const dir = tempDir();
  let hub = await startHub(dir);
  const ownerId = createIdentity();
  const owner = await connect(hub, 'asha', 'Asha Menon', ownerId);
  const join = async (username: string, displayName: string) => {
    const identity = createIdentity();
    const c = await connect(hub, username, displayName, identity);
    await owner.request('admin.decide', { deviceId: identity.deviceId, approve: true });
    await until(c, (s) => s.kind === 'ready');
    return c;
  };
  // as before the names came: no names on the plan, no flag
  const db = hub.store.db;
  db.prepare(`DELETE FROM seat_holders WHERE holder LIKE '%"named"%'`).run();
  db.prepare(`DELETE FROM meta WHERE key = 'seating.drawingNames'`).run();
  // people already seated by hand; one is the drawing's Mukesh on another seat; one has no seat yet
  const priya = await join('priya', 'Priya Raman');
  const mukesh = await join('mukesh', 'Mukesh Kumar');
  const doss = await join('doss', 'Doss Kumar');
  const d = await owner.request('seating.draft', { moves: [{ seatId: 'W-A31', to: P(me(priya)) }, { seatId: 'W-C30', to: P(me(mukesh)) }, { seatId: 'W-A33', to: { kind: 'hot' } }] });
  await owner.request('seating.apply', { id: d.id });
  owner.disconnect();
  await hub.stop();

  hub = await startHub(dir);
  let h = hub.seating.holders();
  assert.deepEqual(h['W-A31'], P(me(priya)), 'Priya keeps the seat the drawing gave Sharada');
  assert.deepEqual(h['W-A33'], { kind: 'hot' });
  assert.equal(h['W-A40'], undefined, 'Mukesh is already seated, so his name is not put on W-A40');
  assert.deepEqual(h['W-A50'], P(me(doss)), 'Doss, already here with no seat, takes his named seat');
  // 40 names, less Sharada's and Madhu's seats (held), Mukesh (seated elsewhere) and Doss (claimed)
  assert.equal(named(h).length, 36);
  const revs = hub.store.db.prepare('SELECT rev, kind, note FROM seat_revs ORDER BY n').all() as Array<{ rev: string; kind: string; note: string }>;
  assert.deepEqual(revs.slice(-2).map((r) => r.kind), ['seed', 'moves']);
  assert.match(revs[revs.length - 2].note, /Names from the drawing Seating_Plan_18-Jul-2026 put on 37 empty seats/);
  const n = audits(hub, 'seating.names');
  assert.equal(n.length, 1);
  assert.deepEqual(n[0].detail, { source: 'Seating_Plan_18-Jul-2026', seats: 37, skipped: 3 });
  assert.deepEqual(audits(hub, 'seating.claim').map((a) => a.target), ['W-A50']);
  const count = revs.length;
  await hub.stop();
  // and again: nothing more
  hub = await startHub(dir);
  cleanups.push(() => hub.stop());
  h = hub.seating.holders();
  assert.equal(named(h).length, 36);
  assert.equal((hub.store.db.prepare('SELECT COUNT(*) AS n FROM seat_revs').get() as { n: number }).n, count);
  assert.equal(audits(hub, 'seating.names').length, 1);
});
