// Dexterity Connect for iPhone, the parts that run without a browser: codes from the link's
// #fragment, joining only through the gateway (and saying so when the office has none), which
// device this is, what a push shows and where its tap leads, and how the meeting site serves the
// app (its headers and its routes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pairCode, setupCode } from '@dex/core/remote';
import { NO_GATEWAY, codeFromHash, deviceName, deviceOf, openFromHash, webTarget } from '../src/pair.ts';
import { noticeFor, openUrl } from '../src/notice.ts';
import { appHeaders } from '../../meet-site/src/app-headers.ts';
import site from '../../meet-site/src/worker.ts';

const FP = Array.from({ length: 32 }, (_, i) => (i * 7 % 256).toString(16).padStart(2, '0').toUpperCase()).join(':');
const code = (url: string | null, lan = ['192.168.1.20:47900']) => pairCode({ hubId: 'hub1234567', fp: FP, name: 'Dexterity Office', lan, url, token: 'tok_0123456789abcdefABCD', kind: 'phone' });

test('the code from the link: taken from the #fragment (plain or encoded), and nothing else', () => {
  const c = code('https://dexconnect-gateway.example.workers.dev');
  assert.equal(codeFromHash(`#${c}`), c);
  assert.equal(codeFromHash(`#${encodeURIComponent(`Here: ${c}`)}`), c);
  const s = setupCode({ url: 'https://gw.example.workers.dev', hubId: 'hub1234567', fp: FP });
  assert.equal(codeFromHash(`#${s}`), s);
  assert.equal(codeFromHash('#open=dexconnect%3A%2F%2Fconversation%2F01J'), null);
  assert.equal(codeFromHash(''), null);
  assert.equal(codeFromHash('#%E0%A4%A'), null, 'a broken encoding is no code');
});

test('a notification\'s link in the #fragment: only the app\'s own links', () => {
  assert.equal(openFromHash(`#open=${encodeURIComponent('dexconnect://conversation/01JABCDEF')}`), 'dexconnect://conversation/01JABCDEF');
  assert.equal(openFromHash(`#open=${encodeURIComponent('https://evil.example/')}`), null);
  assert.equal(openFromHash(`#open=${encodeURIComponent('dexconnect://x"><script>')}`), null);
  assert.equal(openFromHash('#DXP1-abc'), null);
});

test('joining from an iPhone: always through the gateway, never the office addresses; no gateway in the code is a clear refusal', () => {
  const ok = webTarget(code('https://dexconnect-gateway.example.workers.dev/'));
  assert.equal(ok.kind, 'pair');
  assert.equal(ok.pairToken, 'tok_0123456789abcdefABCD');
  assert.deepEqual(ok.target, { host: '', port: 0, hubId: 'hub1234567', name: 'Dexterity Office', fp: FP, remote: { url: 'https://dexconnect-gateway.example.workers.dev', hubId: 'hub1234567' } });
  assert.equal((ok.target as { alts?: unknown }).alts, undefined, 'office addresses are left out: a browser cannot use them');
  assert.throws(() => webTarget(code(null)), (e: Error) => e.message === NO_GATEWAY);
  assert.match(NO_GATEWAY, /outside/);
  const setup = webTarget(setupCode({ url: 'https://gw.example.workers.dev', hubId: 'hub1234567', fp: FP, name: 'Office' }));
  assert.equal(setup.kind, 'setup');
  assert.equal(setup.pairToken, null);
  assert.equal(setup.target.host, '');
  assert.throws(() => webTarget('DXP1-short'), /not complete/);
  assert.throws(() => webTarget('hello'), /not complete/);
});

test('which device: iPhone, iPad (which reports itself as a Mac with touch), or another browser', () => {
  assert.equal(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'), 'iphone');
  assert.equal(deviceOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', 5), 'ipad');
  assert.equal(deviceOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', 0), 'other');
  assert.equal(deviceOf('Mozilla/5.0 (Linux; Android 14; Pixel 8)'), 'other');
  assert.equal(deviceName('iphone'), 'iPhone (web app)');
  // the Your devices list shows a phone for it
  assert.match(deviceName('iphone'), /phone/i);
});

test('a push as a notification: the hub\'s words, its conversation link and badge; anything unreadable still shows something plain', () => {
  const n = noticeFor({ title: 'Site visit · Vikram', body: '2 new messages · Photos please', link: 'dexconnect://conversation/01JX', tag: '01JX', badge: 3, silent: false }, '/app/');
  assert.equal(n.title, 'Site visit · Vikram');
  assert.equal(n.options.body, '2 new messages · Photos please');
  assert.deepEqual(n.options.data, { link: 'dexconnect://conversation/01JX' });
  assert.equal(n.options.tag, '01JX');
  assert.equal(n.options.icon, '/app/icon-192.png');
  assert.equal(n.badge, 3);
  const bad = noticeFor({ title: '', body: 42, link: 'javascript:alert(1)', tag: '../x', badge: -1 }, '/app/');
  assert.equal(bad.title, 'Dexterity Connect');
  assert.equal(bad.options.body, 'New message');
  assert.equal(bad.options.data.link, null);
  assert.equal(bad.options.tag, 'dexconnect');
  assert.equal(bad.badge, null);
  assert.equal(noticeFor(null, '/app/').title, 'Dexterity Connect');
  assert.equal(openUrl('/app/', 'dexconnect://conversation/01JX'), '/app/#open=dexconnect%3A%2F%2Fconversation%2F01JX');
  assert.equal(openUrl('/app/', null), '/app/');
});

test('the app\'s headers on the meeting site: a strict CSP for the page, caching by kind, the service worker\'s scope', () => {
  const page = appHeaders('/app/', 'https://dexterity-meet.pages.dev');
  assert.match(page['content-security-policy'], /script-src 'self' 'wasm-unsafe-eval';/);
  assert.match(page['content-security-policy'], /connect-src 'self' blob: data: wss:;/);
  assert.match(page['content-security-policy'], /frame-ancestors 'none'/);
  assert.doesNotMatch(page['content-security-policy'], /ws:\/\//, 'no plain sockets on the real site');
  assert.match(page['permissions-policy'], /camera=\(self\)/);
  assert.equal(page['cache-control'], 'no-cache');
  assert.ok(page['strict-transport-security']);
  assert.equal(appHeaders('/app/assets/App-abc123.js', 'https://x.pages.dev')['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(appHeaders('/app/sw.js', 'https://x.pages.dev')['cache-control'], 'no-cache');
  assert.equal(appHeaders('/app/sw.js', 'https://x.pages.dev')['service-worker-allowed'], '/app/');
  assert.equal(appHeaders('/app/manifest.webmanifest', 'https://x.pages.dev')['content-type'], 'application/manifest+json; charset=utf-8');
  assert.equal(appHeaders('/app/splash/light-1170x2532.png', 'https://x.pages.dev')['cache-control'], 'public, max-age=86400');
  assert.match(appHeaders('/app/', 'http://127.0.0.1:8788')['content-security-policy'], /ws:\/\/127\.0\.0\.1:\*/);
});

test('the meeting site\'s front door: /app/ from its own files with the app\'s headers; everything else still goes to the gateway', async () => {
  const seen: string[] = [];
  const env = {
    ASSETS: { fetch: async (r: Request) => { seen.push(new URL(r.url).pathname); return new URL(r.url).pathname === '/app/missing.js' ? new Response('', { status: 404 }) : new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }); } },
    GATEWAY: { fetch: async (r: Request) => new Response(`gateway ${new URL(r.url).pathname}`) },
  } as never;
  const go = (p: string, init?: RequestInit) => site.fetch(new Request(`https://dexterity-meet.pages.dev${p}`, init), env);
  const page = await go('/app/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy')!, /default-src 'self'/);
  assert.equal(seen.pop(), '/app/');
  assert.equal((await go('/app/index.html')).status, 200);
  assert.equal(seen.pop(), '/app/', 'the page is always /app/');
  const r = await go('/app');
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), 'https://dexterity-meet.pages.dev/app/');
  assert.equal((await go('/app/missing.js')).status, 404);
  assert.equal((await go('/app/', { method: 'POST' })).status, 405);
  assert.equal(await (await go('/482-913-207')).text(), 'gateway /482-913-207');
  assert.equal(await (await go('/c/hub1234567')).text(), 'gateway /c/hub1234567', 'the device socket passes to the gateway');
});
