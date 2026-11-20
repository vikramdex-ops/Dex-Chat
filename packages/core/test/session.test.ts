import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HubSession } from '../src/session.ts';
import type { HubTarget, OpenSocket } from '../src/session.ts';

const account = { domain: 'OFFICE', username: 'tester', displayName: 'Tester', hostname: 'PHONE' } as never;

/** A socket that never opens (an address this device cannot reach): it closes at once. */
function recorder(tried: string[]): OpenSocket {
  return (t, h) => {
    tried.push(`${t.host}:${t.port}`);
    queueMicrotask(() => h.onClose('unreachable'));
    return { send() {}, close() {} };
  };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test('a phone tries every office address of the hub, then the gateway', async () => {
  const lan: string[] = [];
  const remote: string[] = [];
  const s = new HubSession({ deviceId: 'd', publicKey: 'k', sign: () => '', account, open: recorder(lan), openRemote: recorder(remote), maxBackoffMs: 60_000 });
  const target: HubTarget = { host: '172.24.192.1', port: 47900, hubId: 'hub', fp: 'AA', alts: ['10.1.0.71:47900', '192.168.1.20:47900'], remote: { url: 'https://gw.example', hubId: 'hub' } };
  s.connect(target);
  await tick();
  assert.deepEqual(lan, ['172.24.192.1:47900', '10.1.0.71:47900', '192.168.1.20:47900'], 'each office address once, in order');
  assert.equal(remote.length, 1, 'then the gateway');
  s.disconnect();
});

test('without a gateway, every office address is tried in each round before waiting', async () => {
  const lan: string[] = [];
  const s = new HubSession({ deviceId: 'd', publicKey: 'k', sign: () => '', account, open: recorder(lan), maxBackoffMs: 60_000 });
  s.connect({ host: '172.24.192.1', port: 47900, alts: ['10.1.0.71:47900'] });
  await tick();
  assert.deepEqual(lan, ['172.24.192.1:47900', '10.1.0.71:47900']);
  assert.equal(s.state.kind, 'offline');
  s.disconnect();
});

/** One log for both ways in, to see the order they are tried in. */
function both(log: string[], answers: { lan?: boolean; remote?: boolean } = {}): { open: OpenSocket; openRemote: OpenSocket } {
  const make = (way: 'lan' | 'remote'): OpenSocket => (t, h) => {
    log.push(way);
    queueMicrotask(() => (answers[way] ? h.onOpen('AA') : h.onClose('unreachable')));
    return { send() {}, close() {} };
  };
  return { open: make('lan'), openRemote: make('remote') };
}
const outside: HubTarget = { host: '172.24.192.1', port: 47900, hubId: 'hub', fp: 'AA', remote: { url: 'https://gw.example', hubId: 'hub' } };

test('on mobile data the gateway is tried first, then the office network straight away', async () => {
  const log: string[] = [];
  let cellular = true;
  const s = new HubSession({ deviceId: 'd', publicKey: 'k', sign: () => '', account, ...both(log), preferRemote: () => cellular, maxBackoffMs: 60_000 });
  s.connect(outside);
  await tick();
  assert.deepEqual(log, ['remote', 'lan'], 'the gateway first; when it does not answer, the office network, without waiting');
  assert.equal(s.state.kind, 'offline');
  // waiting to retry: coming back to the app tries now, in the same order
  log.length = 0;
  assert.equal(s.retryNow(), true);
  await tick();
  assert.deepEqual(log, ['remote', 'lan']);
  // on Wi-Fi, the office network first again (and the gateway after it)
  cellular = false;
  log.length = 0;
  s.connect(outside);
  await tick();
  assert.deepEqual(log, ['lan', 'remote']);
  assert.equal(s.retryNow(), true);
  s.disconnect();
  assert.equal(s.retryNow(), false, 'nothing to retry when not waiting');
});

test('the gateway answering first means one connection attempt, not a slow office-network timeout', async () => {
  const log: string[] = [];
  const s = new HubSession({ deviceId: 'd', publicKey: 'k', sign: () => '', account, ...both(log, { remote: true, lan: true }), preferRemote: () => true, maxBackoffMs: 60_000 });
  s.connect(outside);
  await tick();
  assert.deepEqual(log, ['remote']);
  assert.equal(s.state.kind, 'connecting', 'signing in through the gateway');
  // the office network answered a probe: it is used, whatever the preference
  log.length = 0;
  s.connect(outside, { via: 'lan' });
  await tick();
  assert.deepEqual(log, ['lan']);
  s.disconnect();
});
