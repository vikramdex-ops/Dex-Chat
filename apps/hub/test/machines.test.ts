// Elevated control through the IT Support service (docs/HELP-DESK.md, "Elevated control"): a fake
// service in Node with its own P-256 key, over the hub's real websocket. Machines join without
// approval, only IT staff with the policy on connect, input goes through the gate, pictures reach
// the technician, the PC restarting pauses the session, and everything is in the audit log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { authPayload } from '@dex/core';
import { machineIdFor } from '@dex/core/machine';
import type { ElevatedSession, MachineFrame, MachineInfo } from '@dex/core/machine';
import { office, nextEvent, me } from './office.ts';

type Msg = { t: string; [k: string]: unknown };

/** A pretend IT Support service: connects, proves its key, and records what the hub sends it. */
async function service(hub: { port: number; fingerprint: string }, key: crypto.KeyObject, pub: string, hostname = 'DDS-PC-07') {
  const ws = new WebSocket(`wss://127.0.0.1:${hub.port}/ws`, { rejectUnauthorized: false });
  const got: Msg[] = [];
  const waiters: Array<{ t: string; f: (m: Msg) => void }> = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString()) as Msg;
    got.push(m);
    const i = waiters.findIndex((w) => w.t === m.t);
    if (i >= 0) waiters.splice(i, 1)[0].f(m);
  });
  const next = (t: string, ms = 4000) => {
    const have = got.find((m) => m.t === t);
    if (have) { got.splice(got.indexOf(have), 1); return Promise.resolve(have); }
    return new Promise<Msg>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${t}`)), ms);
      waiters.push({ t, f: (m) => { clearTimeout(timer); got.splice(got.indexOf(m), 1); resolve(m); } });
    });
  };
  const hello = await next('hello');
  const id = machineIdFor(pub);
  const sig = crypto.sign('sha256', authPayload(hello.nonce as string, hub.fingerprint, id), { key, dsaEncoding: 'ieee-p1363' }).toString('base64');
  ws.send(JSON.stringify({ t: 'machine', id, publicKey: pub, hostname, version: '1.0.0', sig, consoleUser: 'DEX\\Priya', locked: false }));
  const send = (m: unknown) => ws.send(JSON.stringify(m));
  const close = () => new Promise<void>((r) => { ws.once('close', () => r()); ws.close(); });
  return { id, ws, next, send, close };
}

function machineKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { key: privateKey, pub: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
}

test('a machine proves its key and joins without approval; a wrong signature or an Ed25519 key is refused', async () => {
  const { hub, owner } = await office();
  const k = machineKey();
  const m = await service(hub, k.key, k.pub);
  assert.equal((await m.next('m.ok')).id, m.id);
  await m.close();
  // someone else's key under this id
  const other = machineKey();
  const ws = new WebSocket(`wss://127.0.0.1:${hub.port}/ws`, { rejectUnauthorized: false });
  const first = await new Promise<Msg>((r) => ws.once('message', (raw) => r(JSON.parse(raw.toString()))));
  const sig = crypto.sign('sha256', authPayload(first.nonce as string, hub.fingerprint, m.id), { key: other.key, dsaEncoding: 'ieee-p1363' }).toString('base64');
  ws.send(JSON.stringify({ t: 'machine', id: m.id, publicKey: k.pub, hostname: 'X', version: '1', sig }));
  const rej = await new Promise<Msg>((r) => ws.once('message', (raw) => r(JSON.parse(raw.toString()))));
  assert.equal(rej.t, 'rejected');
  const audit = await owner.request('admin.audit', { limit: 10 });
  assert.ok(audit.some((a) => a.action === 'machine.added'));
});

test('elevated control: IT staff only, policy on, input through the gate, pictures to the technician, the audit trail', async () => {
  const { hub, owner, priya, ravi } = await office();
  const k = machineKey();
  const m = await service(hub, k.key, k.pub);
  await m.next('m.ok');
  await assert.rejects(ravi.request('machine.list'), /IT desk/);
  await owner.request('admin.help.staff', { userId: me(ravi), on: true });
  const list = await ravi.request('machine.list');
  assert.equal(list.length, 1);
  assert.equal(list[0].hostname, 'DDS-PC-07');
  assert.equal(list[0].online, true);
  assert.equal(list[0].consoleUser, 'DEX\\Priya');
  await assert.rejects(ravi.request('machine.connect', { machineId: m.id }), /Elevated control is off/);
  await owner.request('admin.policy.set', { assistElevated: true });
  await assert.rejects(priya.request('machine.connect', { machineId: m.id }), /IT desk/);

  const s = await ravi.request('machine.connect', { machineId: m.id });
  const start = await m.next('m.start');
  assert.equal(start.s, s.id);
  assert.match(String(start.tech), /Ravi/);
  await assert.rejects(ravi.request('machine.connect', { machineId: m.id }), /already connected/);

  // a picture reaches the technician
  const pic = nextEvent<MachineFrame>(ravi, 'machine.frame');
  m.send({ t: 'm.frame', s: s.id, w: 1920, h: 1080, seq: 1, d: Buffer.from('jpeg bytes').toString('base64') });
  const fr = await pic;
  assert.equal(fr.w, 1920);
  assert.equal(Buffer.from(fr.d, 'base64').toString(), 'jpeg bytes');
  await ravi.request('machine.ack', { s: s.id, seq: 1 });
  assert.equal((await m.next('m.ack')).seq, 1);

  // keys as virtual-key codes; Ctrl+Alt+Del typed is never passed on, the button sends the real one
  await ravi.request('machine.input', { s: s.id, msg: { k: 'in', e: [{ t: 'key', code: 'KeyA', down: true }, { t: 'key', code: 'KeyA', down: false }, { t: 'move', x: 0.5, y: 0.25 }] } });
  const inp = await m.next('m.input');
  assert.deepEqual(inp.e, [{ t: 'key', vk: 0x41, ext: false, down: true }, { t: 'key', vk: 0x41, ext: false, down: false }, { t: 'move', x: 0.5, y: 0.25 }]);
  await ravi.request('machine.input', { s: s.id, msg: { k: 'in', e: [{ t: 'key', code: 'ControlLeft', down: true }, { t: 'key', code: 'AltLeft', down: true }, { t: 'key', code: 'Delete', down: true }] } });
  const chord = await m.next('m.input');
  assert.equal((chord.e as unknown[]).length, 2, 'Delete with Ctrl+Alt held is dropped');
  await ravi.request('machine.sas', { s: s.id });
  assert.equal((await m.next('m.sas')).s, s.id);
  // the ticket is for the person signed in to the PC
  const tickets = await ravi.request('help.queue', { status: 'all' });
  const t = tickets.find((x) => x.id === s.ticketId)!;
  assert.equal(t.requesterId, me(priya));
  assert.equal(t.techId, me(ravi));

  // the person at the PC stops it from the service's banner
  const ended = nextEvent<ElevatedSession>(ravi, 'machine.session', (x) => !!x.endedAt);
  m.send({ t: 'm.ended', s: s.id, why: 'Priya pressed Stop on the PC.' });
  assert.equal((await ended).why, 'Priya pressed Stop on the PC.');
  await assert.rejects(ravi.request('machine.input', { s: s.id, msg: { k: 'in', e: [] } }), /ended/);
  const { timeline } = await priya.request('help.get', { id: s.ticketId });
  assert.ok(timeline.some((e) => e.kind === 'session.started' && e.detail?.elevated === true));
  assert.equal(timeline.at(-1)!.text, 'Priya pressed Stop on the PC.');
  const audit = (await owner.request('admin.audit', { limit: 30 })).map((a) => a.action);
  for (const a of ['help.elevated.started', 'help.elevated.sas', 'help.elevated.ended']) assert.ok(audit.includes(a), a);
  await m.close();
});

test('the PC restarting: with reconnect on, the session waits and goes on when the service is back; removed PCs cannot return', async () => {
  const { hub, owner, ravi } = await office();
  await owner.request('admin.help.staff', { userId: me(ravi), on: true });
  await owner.request('admin.policy.set', { assistElevated: true, assistReconnect: true });
  const k = machineKey();
  const m = await service(hub, k.key, k.pub);
  await m.next('m.ok');
  const s = await ravi.request('machine.connect', { machineId: m.id });
  await m.next('m.start');
  const paused = nextEvent<ElevatedSession>(ravi, 'machine.session', (x) => x.pausedAt !== null);
  await m.close();
  assert.equal((await paused).endedAt, null);
  const back = await service(hub, k.key, k.pub);
  await back.next('m.ok');
  assert.equal((await back.next('m.start')).s, s.id, 'the same session goes on');
  const list: MachineInfo[] = await ravi.request('machine.list');
  assert.equal(list[0].session?.pausedAt, null);

  await assert.rejects(ravi.request('admin.machine.remove', { machineId: m.id }), /administrators/);
  await owner.request('admin.machine.remove', { machineId: m.id });
  assert.equal((await back.next('rejected')).t, 'rejected');
  const again = await service(hub, k.key, k.pub);
  assert.match(String((await again.next('rejected')).reason), /removed/);
  assert.deepEqual(await ravi.request('machine.list'), []);
});

test('review fixes: leaving the IT desk or the policy turned off ends a live session; a fast reconnect starts it again', async () => {
  const { hub, owner, ravi } = await office();
  await owner.request('admin.help.staff', { userId: me(ravi), on: true });
  await owner.request('admin.policy.set', { assistElevated: true });
  const k = machineKey();
  const m = await service(hub, k.key, k.pub);
  await m.next('m.ok');

  // removed from the IT desk: the session ends at once, the PC is told, input is refused
  const s1 = await ravi.request('machine.connect', { machineId: m.id });
  await m.next('m.start');
  const ended1 = nextEvent<ElevatedSession>(ravi, 'machine.session', (x) => x.id === s1.id && !!x.endedAt);
  await owner.request('admin.help.staff', { userId: me(ravi), on: false });
  assert.equal((await ended1).why, 'The technician is no longer on the IT desk.');
  assert.equal((await m.next('m.stop')).s, s1.id);
  await assert.rejects(ravi.request('machine.sas', { s: s1.id }), /ended|IT desk/);

  // the policy turned off: the session ends at once, even if the technician only watches
  await owner.request('admin.help.staff', { userId: me(ravi), on: true });
  const s2 = await ravi.request('machine.connect', { machineId: m.id });
  await m.next('m.start');
  const ended2 = nextEvent<ElevatedSession>(ravi, 'machine.session', (x) => x.id === s2.id && !!x.endedAt);
  await owner.request('admin.policy.set', { assistElevated: false });
  assert.equal((await ended2).why, 'An administrator turned elevated control off.');

  // the PC comes back before the hub noticed its old link went away: the session starts again on the new link
  await owner.request('admin.policy.set', { assistElevated: true });
  const s3 = await ravi.request('machine.connect', { machineId: m.id });
  await m.next('m.start');
  const again = await service(hub, k.key, k.pub);
  await again.next('m.ok');
  assert.equal((await again.next('m.start')).s, s3.id);
  await again.close();
});

test('review fixes: a flood of new machines is refused', async () => {
  const { hub } = await office();
  let refused = 0;
  for (let i = 0; i < 32; i++) {
    const k = machineKey();
    const m = await service(hub, k.key, k.pub, `PC-${i}`);
    const r = await Promise.race([m.next('m.ok').then(() => 'ok'), m.next('rejected').then((x) => String(x.reason))]);
    if (r !== 'ok') { refused++; assert.match(r, /Too many new PCs/); }
    m.ws.close();
  }
  assert.equal(refused, 2, 'thirty new PCs an hour are taken in, the rest refused');
});

test('review fixes, second round: no elevated control through the internet gateway; two PCs with one name are flagged', async () => {
  const { hub, owner, ravi } = await office();
  await owner.request('admin.help.staff', { userId: me(ravi), on: true });
  await owner.request('admin.policy.set', { assistElevated: true });
  const a = machineKey();
  const m1 = await service(hub, a.key, a.pub, 'DDS-PC-07');
  await m1.next('m.ok');
  const b = machineKey();
  const m2 = await service(hub, b.key, b.pub, 'dds-pc-07');
  await m2.next('m.ok');
  const list: MachineInfo[] = await ravi.request('machine.list');
  assert.equal(list.length, 2);
  assert.ok(list.every((x) => x.sameName), 'both are flagged: one may be pretending');
  // from outside the office network (the gateway): refused, whatever the policy says
  const tech = hub.store.userById(me(ravi))!;
  assert.throws(() => hub.machines.handle('machine.connect', tech, ravi.session!.deviceId, { machineId: m1.id }, true), /office network/);
  await m1.close(); await m2.close();
});

test('third review: plain computer names only; removed and clashing names are flagged; a copied key is refused; a technician off the office network loses the session', async () => {
  const { hub, owner, ravi } = await office();
  await owner.request('admin.help.staff', { userId: me(ravi), on: true });
  await owner.request('admin.policy.set', { assistElevated: true });
  // a name with an invisible character is refused outright
  const z = machineKey();
  const fake = await service(hub, z.key, z.pub, 'ACCOUNTS-PC\u200b');
  assert.match(String((await fake.next('rejected')).reason), /plain Windows computer name/);
  // a removed PC's name still counts: a newcomer with it is flagged
  const a = machineKey();
  const m1 = await service(hub, a.key, a.pub, 'FINANCE-01');
  await m1.next('m.ok');
  await owner.request('admin.machine.remove', { machineId: m1.id });
  const b = machineKey();
  const m2 = await service(hub, b.key, b.pub, 'finance-01');
  await m2.next('m.ok');
  const list: MachineInfo[] = await ravi.request('machine.list');
  assert.equal(list.length, 1);
  assert.equal(list[0].sameName, false, 'no other PC in the office has the name');
  assert.equal(list[0].nameReused, true, 'a removed PC had that name (shown quietly)');
  // the same key from a second PC with another name (a copied disk image): refused while the first is online
  const twin = await service(hub, b.key, b.pub, 'FINANCE-02');
  assert.match(String((await twin.next('rejected')).reason), /key belongs to finance-01/);
  // the technician's app leaves the office network: the session ends at the next picture
  const s = await ravi.request('machine.connect', { machineId: m2.id });
  await m2.next('m.start');
  const ended = nextEvent<ElevatedSession>(ravi, 'machine.session', (x) => x.id === s.id && !!x.endedAt);
  const conns = (hub as unknown as { conns: Set<{ deviceId: string | null; remote: boolean }> }).conns;
  for (const c of conns) if (c.deviceId === ravi.session!.deviceId) c.remote = true;
  m2.send({ t: 'm.frame', s: s.id, w: 10, h: 10, seq: 1, d: Buffer.from('x').toString('base64') });
  assert.equal((await ended).why, 'The technician left the office network.');
  // after a reload the technician's window finds its sessions (none now)
  assert.deepEqual(await ravi.request('machine.mine'), []);
  await m2.close();
});

test('fourth review: underscore names; a key never renames its PC; reload restarts pictures; privacy screen on the PC', async () => {
  const { hub, owner, ravi } = await office();
  await owner.request('admin.help.staff', { userId: me(ravi), on: true });
  await owner.request('admin.policy.set', { assistElevated: true });
  const k = machineKey();
  const m = await service(hub, k.key, k.pub, 'CAD_WS01');
  await m.next('m.ok');
  await m.close();
  // the same key later from a PC with another name, while the first is offline: refused, the name stays
  const again = await service(hub, k.key, k.pub, 'CAD_WS02');
  assert.match(String((await again.next('rejected')).reason), /belongs to CAD_WS01/);
  const back = await service(hub, k.key, k.pub, 'CAD_WS01');
  await back.next('m.ok');
  assert.equal(((await ravi.request('machine.list')) as MachineInfo[])[0].hostname, 'CAD_WS01');

  // the privacy screen needs its policy; the PC is told, and a PC that cannot keep it out of IT's picture turns it off
  await assert.rejects(ravi.request('machine.connect', { machineId: back.id, privacy: true }), /privacy screen is off/);
  await owner.request('admin.policy.set', { assistPrivacy: true });
  const s = await ravi.request('machine.connect', { machineId: back.id, privacy: true });
  const start = await back.next('m.start');
  assert.equal(start.privacy, true);
  assert.equal(start.since, s.startedAt);
  const off = nextEvent<ElevatedSession>(ravi, 'machine.session', (x) => x.id === s.id && !x.privacy);
  back.send({ t: 'm.privacy', s: s.id, ok: false });
  await off;
  const on = await ravi.request('machine.privacy', { s: s.id, on: true });
  assert.equal(on.privacy, true);
  assert.equal((await back.next('m.privacy')).on, false, 'first the PC hears it went off');
  assert.equal((await back.next('m.privacy')).on, true);

  // the technician's window reloads: the PC is asked to start again (its two pictures in flight are forgotten)
  const mine = await ravi.request('machine.mine');
  assert.equal(mine[0].id, s.id);
  assert.equal((await back.next('m.start')).s, s.id);
  const audit = (await owner.request('admin.audit', { limit: 30 })).map((a) => a.action);
  assert.ok(audit.includes('machine.cloned') && audit.includes('help.privacy'));
  await back.close();
});
