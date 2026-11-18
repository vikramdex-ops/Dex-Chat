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
