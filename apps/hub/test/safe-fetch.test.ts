import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { FetchBlocked, classifyAddress, safeFetch } from '../src/safe-fetch.ts';

async function server(handler: http.RequestListener): Promise<{ url: string; hits: () => number; close: () => void }> {
  let hits = 0;
  const s = http.createServer((req, res) => { hits++; handler(req, res); });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, hits: () => hits, close: () => { s.closeAllConnections(); s.close(); } };
}

test('addresses are sorted into public, office network and never', () => {
  const cases: Array<[string, string]> = [
    ['8.8.8.8', 'public'], ['203.0.113.5', 'public'], ['2606:4700::1111', 'public'],
    ['10.1.2.3', 'private'], ['172.16.0.1', 'private'], ['172.31.255.255', 'private'], ['192.168.1.20', 'private'], ['127.0.0.1', 'private'],
    ['100.64.0.1', 'private'], ['::1', 'private'], ['fd12:3456::1', 'private'], ['::ffff:192.168.1.1', 'private'], ['::ffff:c0a8:101', 'private'],
    ['169.254.169.254', 'blocked'], ['0.0.0.0', 'blocked'], ['224.0.0.1', 'blocked'], ['255.255.255.255', 'blocked'], ['fe80::1', 'blocked'],
    ['::', 'blocked'], ['::ffff:169.254.169.254', 'blocked'], ['64:ff9b::a9fe:a9fe', 'blocked'], ['not an address', 'blocked'],
    ['172.15.0.1', 'public'], ['172.32.0.1', 'public'],
  ];
  for (const [a, want] of cases) assert.equal(classifyAddress(a), want, a);
});

test('only http and https, no credentials in the address', async () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com', 'javascript:alert(1)', 'not a url']) {
    await assert.rejects(safeFetch(url, { allowLan: true }), FetchBlocked, url);
  }
  await assert.rejects(safeFetch('http://user:pass@127.0.0.1/', { allowLan: true }), /user name or password/);
});

test('the office network is refused unless allowed, by address or by a name that resolves to it', async () => {
  const s = await server((_req, res) => { res.writeHead(200); res.end('ok'); });
  try {
    await assert.rejects(safeFetch(`${s.url}/hook`, { allowLan: false, body: '{}' }), /office network/);
    await assert.rejects(safeFetch('http://localhost/hook', { allowLan: false }), /office network/);
    const port = new URL(s.url).port;
    await assert.rejects(safeFetch(`http://hooks.example:${port}/`, { allowLan: false, resolve: async () => ['10.0.0.7'] }), /office network/);
    // a name with one public and one private address is refused as a whole
    await assert.rejects(safeFetch(`http://mixed.example:${port}/`, { allowLan: false, resolve: async () => ['203.0.113.9', '192.168.0.4'] }), /office network/);
    assert.equal(s.hits(), 0, 'nothing reached the server');
    const ok = await safeFetch(`${s.url}/hook`, { allowLan: true, body: '{"a":1}' });
    assert.deepEqual([ok.status, ok.text], [200, 'ok']);
    // the connection goes to the checked address, whatever the name resolves to later
    const pinned = await safeFetch(`http://anything.example:${port}/`, { allowLan: true, resolve: async () => ['127.0.0.1'] });
    assert.equal(pinned.status, 200);
    assert.equal(s.hits(), 2);
  } finally { s.close(); }
});

test('redirects are followed only to addresses that pass the same checks', async () => {
  const target = await server((_req, res) => { res.writeHead(200); res.end('final'); });
  const s = await server((req, res) => {
    const to = req.url === '/meta' ? 'http://169.254.169.254/latest/meta-data/' : req.url === '/file' ? 'file:///etc/passwd' : req.url === '/loop' ? '/loop' : `${target.url}/x`;
    res.writeHead(302, { location: to });
    res.end();
  });
  try {
    await assert.rejects(safeFetch(`${s.url}/meta`, { allowLan: true }), /cannot be called/);
    await assert.rejects(safeFetch(`${s.url}/file`, { allowLan: true }), /Only http/);
    await assert.rejects(safeFetch(`${s.url}/loop`, { allowLan: true }), /redirected too many times/);
    const ok = await safeFetch(`${s.url}/go`, { allowLan: true });
    assert.equal(ok.text, 'final');
    assert.equal(ok.url, `${target.url}/x`);
  } finally { s.close(); target.close(); }
});

test('a time limit, a cap on what is sent and a cap on what is read', async () => {
  const slow = await server(() => { /* never answers */ });
  const big = await server((_req, res) => { res.writeHead(200); res.end('x'.repeat(1024 * 1024)); });
  try {
    const t0 = Date.now();
    await assert.rejects(safeFetch(slow.url, { allowLan: true, timeoutMs: 300 }), /did not answer in time/);
    assert.ok(Date.now() - t0 < 3000);
    await assert.rejects(safeFetch(big.url, { allowLan: true, body: 'y'.repeat(20_000), maxBody: 16 * 1024 }), /larger than 16 KB/);
    const r = await safeFetch(big.url, { allowLan: true, maxReply: 64 * 1024 });
    assert.equal(r.truncated, true);
    assert.equal(r.text.length, 64 * 1024);
  } finally { slow.close(); big.close(); }
});
