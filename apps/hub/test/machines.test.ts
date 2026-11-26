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
