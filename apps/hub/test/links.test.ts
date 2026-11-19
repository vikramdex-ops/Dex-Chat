// Link cards: the fetch guard (SSRF), the HTML scanner, internal cards that respect who may
// see what, web cards with their cache and rate limit, and side-tracks about a link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LinkCard } from '@dex/core';
import { guardedFetch, isBlockedAddress, scanHtml, imageSize, FetchBlocked, USER_AGENT, RATE_LIMIT, youtubeId, github } from '../src/links.ts';
import { office, me, send, cleanups, until } from './office.ts';

// ------------------------------------------------------------------ a local web server

interface Site { port: number; hits: string[]; headers: IncomingMessage['headers'][] }

async function site(handler: (req: IncomingMessage, res: ServerResponse, s: Site) => void): Promise<Site> {
  const s: Site = { port: 0, hits: [], headers: [] };
  const server = http.createServer((req, res) => { s.hits.push(req.url ?? ''); s.headers.push(req.headers); handler(req, res, s); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  s.port = (server.address() as AddressInfo).port;
  cleanups.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return s;
}

/** A pretend internet: these names resolve to public addresses, which all lead to the local server. */
const PUBLIC = '93.184.216.34';
const via = (s: Site) => ({
  resolve: async (host: string) => (host.endsWith('.test') ? [PUBLIC] : []),
  connectTo: () => ({ host: '127.0.0.1', port: s.port }),
});

const html = (head: string, body = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

// ------------------------------------------------------------------ addresses

test('private, loopback, link-local and reserved addresses are blocked; public ones are not', () => {
  for (const ip of ['127.0.0.1', '127.255.0.9', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.10', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '255.255.255.255', '::', '::1', '[::1]', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1',
    '64:ff9b::7f00:1', '2002:7f00:1::1', '2001:db8::1', 'ff02::1', 'not-an-ip']) assert.equal(isBlockedAddress(ip), true, ip);
  for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111', '::ffff:93.184.216.34', '2a00:1450:4001::200e']) assert.equal(isBlockedAddress(ip), false, ip);
});

test('decimal, octal, hexadecimal and short IPv4 forms are caught', async () => {
  let asked = 0;
  const resolve = async () => { asked++; return [PUBLIC]; };
  for (const url of ['http://2130706433/', 'http://0177.0.0.1/', 'http://0x7f.0.0.1/', 'http://127.1/', 'http://017700000001/', 'http://0x7f000001/', 'http://10.0.0.1/']) {
    await assert.rejects(guardedFetch(url, { resolve }), (e: unknown) => e instanceof FetchBlocked && e.reason === 'address', url);
  }
  assert.equal(asked, 0, 'addresses written as numbers are never looked up');
});

test('IPv6 loopback and mapped addresses are caught', async () => {
  for (const url of ['http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[0:0:0:0:0:0:0:1]/', 'http://[fe80::1]/', 'http://[::ffff:a9fe:a9fe]/']) {
    await assert.rejects(guardedFetch(url, {}), (e: unknown) => e instanceof FetchBlocked && e.reason === 'address', url);
  }
});

test('a name that resolves to a private address is refused, and the server is never reached', async () => {
  const s = await site((_q, res) => res.end('secret'));
  const opts = { resolve: async () => ['10.0.0.5'], connectTo: () => ({ host: '127.0.0.1', port: s.port }) };
  await assert.rejects(guardedFetch('http://intranet.test/', opts), (e: unknown) => e instanceof FetchBlocked && e.reason === 'address');
  // one private answer among public ones is enough to refuse
  await assert.rejects(guardedFetch('http://mixed.test/', { ...opts, resolve: async () => [PUBLIC, '192.168.0.4'] }), FetchBlocked);
  await assert.rejects(guardedFetch('http://localhost/', {}), FetchBlocked);
  assert.equal(s.hits.length, 0);
});

test('DNS rebinding: the address that was checked is the one connected to; a second lookup is checked again', async () => {
  const s = await site((req, res) => {
    if (req.url === '/hop') { res.writeHead(302, { location: 'http://rebind.test/after' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html('<title>Public</title>'));
  });
  let calls = 0;
  const dialled: string[] = [];
  const resolve = async () => (++calls === 1 ? [PUBLIC] : ['127.0.0.1']);
  const connectTo = (address: string) => { dialled.push(address); return { host: '127.0.0.1', port: s.port }; };
  const ok = await guardedFetch('http://rebind.test/', { resolve, connectTo });
  assert.equal(ok.status, 200);
  assert.deepEqual(dialled, [PUBLIC]);
  assert.equal(calls, 1, 'resolved once per request, never again behind the guard\'s back');
  // a redirect means a new lookup, and that answer is checked too
  calls = 0;
  dialled.length = 0;
  await assert.rejects(guardedFetch('http://rebind.test/hop', { resolve, connectTo }), (e: unknown) => e instanceof FetchBlocked && e.reason === 'address');
  assert.deepEqual(dialled, [PUBLIC]);
});

test('a redirect to a private address is refused before it is followed', async () => {
  const s = await site((req, res) => {
    if (req.url === '/go') { res.writeHead(301, { location: `http://127.0.0.1:${s.port}/admin` }); res.end(); return; }
    if (req.url === '/go6') { res.writeHead(302, { location: 'http://[::1]/admin' }); res.end(); return; }
    if (req.url === '/go-meta') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); res.end(); return; }
    res.end('admin');
  });
  for (const p of ['/go', '/go6', '/go-meta']) await assert.rejects(guardedFetch(`http://site.test${p}`, via(s)), FetchBlocked, p);
  assert.ok(!s.hits.includes('/admin'));
});

test('at most 3 redirects, and only to http or https', async () => {
  const s = await site((req, res) => {
    const n = Number(/\/r(\d+)/.exec(req.url ?? '')?.[1] ?? 0);
    if (req.url === '/ftp') { res.writeHead(302, { location: 'ftp://site.test/x' }); res.end(); return; }
    if (n > 0) { res.writeHead(302, { location: `/r${n - 1}` }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html('<title>Landed</title>'));
  });
  assert.equal((await guardedFetch('http://site.test/r3', via(s))).status, 200);
  await assert.rejects(guardedFetch('http://site.test/r4', via(s)), (e: unknown) => e instanceof FetchBlocked && e.reason === 'redirects');
  await assert.rejects(guardedFetch('http://site.test/ftp', via(s)), (e: unknown) => e instanceof FetchBlocked && e.reason === 'scheme');
  for (const url of ['ftp://site.test/', 'file:///etc/passwd', 'gopher://site.test/', 'javascript:alert(1)']) await assert.rejects(guardedFetch(url, via(s)), FetchBlocked, url);
});

test('a 4 s timeout (shorter here) and a 512 KB cap', async () => {
  const s = await site((req, res) => {
    if (req.url === '/slow') return; // never answers
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<html><head><title>Big page</title></head><body>${'x'.repeat(2 * 1024 * 1024)}</body></html>`);
  });
  const t0 = Date.now();
  await assert.rejects(guardedFetch('http://site.test/slow', { ...via(s), timeoutMs: 300 }), /too long/);
  assert.ok(Date.now() - t0 < 2000);
  const big = await guardedFetch('http://site.test/big', via(s));
  assert.equal(big.truncated, true);
  assert.ok(big.body.length <= 512 * 1024);
  assert.equal(scanHtml(big.body.toString(), big.url).title, 'Big page');
});

test('the fetch says who it is and sends nothing personal', async () => {
  const s = await site((_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html('<title>x</title>')); });
  await guardedFetch('http://site.test/page?a=1', via(s));
  const h = s.headers[0];
  assert.equal(h['user-agent'], USER_AGENT);
  assert.equal(h.host, 'site.test');
  for (const k of ['cookie', 'authorization', 'referer', 'x-forwarded-for']) assert.equal(h[k], undefined, k);
  await assert.rejects(guardedFetch('http://user:pw@site.test/', via(s)), FetchBlocked);
});

test('only the usual web ports for public sites; listed office hosts may use any', async () => {
  const s = await site((_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html('<title>Wiki</title>')); });
  await assert.rejects(guardedFetch('http://site.test:22/', via(s)), (e: unknown) => e instanceof FetchBlocked && e.reason === 'port');
  const lan = { resolve: async () => ['10.0.0.20'], connectTo: () => ({ host: '127.0.0.1', port: s.port }) };
  await assert.rejects(guardedFetch('http://wiki.dex.local:8090/', lan), FetchBlocked);
  const ok = await guardedFetch('http://wiki.dex.local:8090/', { ...lan, allowLanHosts: ['wiki.dex.local'] });
  assert.equal(scanHtml(ok.body.toString(), ok.url).title, 'Wiki');
});

// ------------------------------------------------------------------ the HTML scanner

const BASE = 'https://example.test/a/b.html';

test('scanner: Open Graph tags', () => {
  const m = scanHtml(html('<meta property="og:title" content="Pump P-101 datasheet"><meta property="og:description" content="Rev C, issued for construction"><meta property="og:site_name" content="Vendor portal"><meta property="og:image" content="/img/p101.png"><title>ignored</title>'), BASE);
  assert.equal(m.title, 'Pump P-101 datasheet');
  assert.equal(m.description, 'Rev C, issued for construction');
  assert.equal(m.siteName, 'Vendor portal');
  assert.equal(m.image, 'https://example.test/img/p101.png');
});

test('scanner: twitter tags when there is no og', () => {
  const m = scanHtml(html('<meta name="twitter:title" content="TW title"><meta name="twitter:description" content="TW desc"><meta name="twitter:image" content="https://cdn.test/x.jpg"><meta name="twitter:card" content="summary">'), BASE);
  assert.deepEqual([m.title, m.description, m.image, m.twitterCard], ['TW title', 'TW desc', 'https://cdn.test/x.jpg', 'summary']);
});

test('scanner: <title> and <meta name=description> with entities', () => {
  const m = scanHtml(html('<title>Piping &amp; Instrumentation &#8211; Rev&nbsp;B &#x20B9;</title><meta name="description" content="Lines &lt;6&quot; only">'), BASE);
  assert.equal(m.title, 'Piping & Instrumentation – Rev B ₹');
  assert.equal(m.description, 'Lines <6" only');
});

test('scanner: unquoted, single-quoted and upper-case markup', () => {
  const m = scanHtml("<HTML><HEAD><META PROPERTY=og:title CONTENT='Site visit report'><Meta Name=DESCRIPTION content=Short></HEAD></HTML>", BASE);
  assert.equal(m.title, 'Site visit report');
  assert.equal(m.description, 'Short');
});

test('scanner: tags inside scripts, styles and comments are ignored', () => {
  const m = scanHtml(html('<!-- <meta property="og:title" content="from a comment"> --><script>var s = \'<meta property="og:title" content="from a script">\';</script><style>/* <title>css</title> */</style><title>Real</title>'), BASE);
  assert.equal(m.title, 'Real');
});

test('scanner: <base href> and relative pictures and icons', () => {
  const m = scanHtml(html('<base href="https://cdn.test/assets/"><meta property="og:image" content="hero.jpg"><link rel="shortcut icon" href="fav.png">'), BASE);
  assert.equal(m.image, 'https://cdn.test/assets/hero.jpg');
  assert.equal(m.favicon, 'https://cdn.test/assets/fav.png');
  assert.equal(scanHtml(html('<title>x</title>'), BASE).favicon, 'https://example.test/favicon.ico');
});

test('scanner: javascript: and data: pictures are dropped', () => {
  assert.equal(scanHtml(html('<meta property="og:image" content="javascript:alert(1)">'), BASE).image, undefined);
  assert.equal(scanHtml(html('<meta property="og:image" content="data:image/png;base64,AAAA">'), BASE).image, undefined);
});

test('scanner: an unclosed <title> and broken quotes do not run away', () => {
  const m = scanHtml('<html><head><title>Clash report for GA-2001\n<meta name="description" content="unterminated><body>text', BASE);
  assert.ok(m.title?.startsWith('Clash report for GA-2001'));
  assert.ok((m.title ?? '').length <= 300);
});

test('scanner: a ">" or "<" inside a quoted value', () => {
  const m = scanHtml(html('<meta property="og:title" content="Flow > 40 m3/h < 60"><meta name="description" content="ok">'), BASE);
  assert.equal(m.title, 'Flow > 40 m3/h < 60');
  assert.equal(m.description, 'ok');
});

test('scanner: whitespace is collapsed and long titles cut', () => {
  const m = scanHtml(html(`<title>\n   Line   list\n\tRev 2   </title><meta property="og:description" content="${'d'.repeat(900)}">`), BASE);
  assert.equal(m.title, 'Line list Rev 2');
  assert.equal(m.description?.length, 500);
});

test('scanner: the first of repeated tags wins', () => {
  assert.equal(scanHtml(html('<meta property="og:title" content="First"><meta property="og:title" content="Second">'), BASE).title, 'First');
});

test('scanner: meta tags in the body of a page without a head', () => {
  assert.equal(scanHtml('<body><meta property="og:title" content="Headless"><p>hi</p></body>', BASE).title, 'Headless');
});

test('scanner: an <svg> title is not the page title', () => {
  assert.equal(scanHtml(html('<svg><title>icon</title></svg><title>Real page</title>'), BASE).title, 'Real page');
});

test('scanner: canonical address and type', () => {
  const m = scanHtml(html('<link rel="canonical" href="/canonical"><meta property="og:type" content="article">'), BASE);
  assert.equal(m.canonical, 'https://example.test/canonical');
  assert.equal(m.type, 'article');
});

test('scanner: Hindi titles come through unchanged', () => {
  assert.equal(scanHtml(html('<meta charset="utf-8"><title>पाइपिंग ड्राइंग सूची</title>'), BASE).title, 'पाइपिंग ड्राइंग सूची');
});

test('scanner: garbage is quick and harmless', () => {
  const t0 = Date.now();
  scanHtml('<'.repeat(200_000) + '<meta ' + '"'.repeat(50_000) + '<title>' + 'x'.repeat(10_000), BASE);
  scanHtml('<meta a=' + 'b '.repeat(100_000) + '>', BASE);
  assert.ok(Date.now() - t0 < 1500);
  assert.deepEqual(scanHtml('', BASE), { favicon: 'https://example.test/favicon.ico' });
});

test('image sizes from the first bytes: PNG, GIF, JPEG and WebP', () => {
  const png = Buffer.alloc(24); png.writeUInt32BE(0x89504e47, 0); png.write('\r\n\x1a\n', 4, 'latin1'); png.writeUInt32BE(13, 8); png.write('IHDR', 12, 'latin1'); png.writeUInt32BE(1920, 16); png.writeUInt32BE(1080, 20);
  assert.deepEqual(imageSize(png), { width: 1920, height: 1080 });
  const gif = Buffer.alloc(10); gif.write('GIF89a', 0, 'latin1'); gif.writeUInt16LE(320, 6); gif.writeUInt16LE(200, 8);
  assert.deepEqual(imageSize(gif), { width: 320, height: 200 });
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0x00, 0x00, 0x00]);
  assert.deepEqual(imageSize(jpg), { width: 800, height: 600 });
  const webp = Buffer.alloc(30); webp.write('RIFF', 0, 'latin1'); webp.write('WEBP', 8, 'latin1'); webp.write('VP8X', 12, 'latin1'); webp.writeUIntLE(639, 24, 3); webp.writeUIntLE(479, 27, 3);
  assert.deepEqual(imageSize(webp), { width: 640, height: 480 });
  assert.equal(imageSize(Buffer.from('not an image')), null);
});

test('YouTube and GitHub links are recognised', () => {
  assert.equal(youtubeId(new URL('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10')), 'dQw4w9WgXcQ');
  assert.equal(youtubeId(new URL('https://youtu.be/dQw4w9WgXcQ')), 'dQw4w9WgXcQ');
  assert.equal(youtubeId(new URL('https://youtube.com/shorts/dQw4w9WgXcQ')), 'dQw4w9WgXcQ');
  assert.equal(youtubeId(new URL('https://youtube.com/watch?v=short')), null);
  assert.deepEqual(github(new URL('https://github.com/acme/plant-model')), { kind: 'repo', repo: 'acme/plant-model' });
  assert.deepEqual(github(new URL('https://github.com/acme/plant-model/issues/42')), { kind: 'issue', repo: 'acme/plant-model', number: 42 });
  assert.deepEqual(github(new URL('https://github.com/acme/plant-model/pull/7')), { kind: 'pull', repo: 'acme/plant-model', number: 7 });
  assert.equal(github(new URL('https://github.com/settings/profile')), null);
});

// ------------------------------------------------------------------ internal cards

test('message links: members see the card, others get "restricted" with nothing in it', async () => {
  const { owner, priya, ravi } = await office();
  const sp = await owner.request('conv.create', { kind: 'space', name: 'Bids P-12513', private: true, members: [me(priya)] });
  const m = await send(owner, sp.id, `Quote for <@${me(priya)}>: ₹ 5,00,000 for the **pipe rack**`);
  const url = `dexconnect://message/${sp.id}/${m.id}`;
  const card = await priya.request('links.preview', { url });
  assert.equal(card.kind, 'message');
  assert.equal(card.title, 'Vikram');
  assert.equal(card.subtitle, 'Bids P-12513');
  assert.equal(card.preview?.excerpt, 'Quote for @Priya: ₹ 5,00,000 for the pipe rack');
  assert.deepEqual(card.actions.map((a) => a.kind), ['open', 'reply']);
  assert.equal(card.meta.find((x) => x.key === 'author')?.ref, me(owner));
  const hidden = await ravi.request('links.preview', { url });
  assert.deepEqual({ ...hidden, fetchedAt: 0 }, { url, kind: 'restricted', title: null, subtitle: null, meta: [], preview: null, actions: [], fetchedAt: 0 });
  // a message that does not exist looks the same as one you cannot see
  const missing = await priya.request('links.preview', { url: `dexconnect://message/${sp.id}/01ZZZZZZZZZZZZZZZZZZZZZZZZ` });
  assert.equal(missing.kind, 'restricted');
  // the conversation in the link must be the message's own
  const other = await owner.request('conv.create', { kind: 'space', name: 'Other', members: [me(priya)] });
  assert.equal((await priya.request('links.preview', { url: `dexconnect://message/${other.id}/${m.id}` })).kind, 'restricted');
});

test('conversation links: open Spaces can be joined, private and Direct ones stay hidden', async () => {
  const { owner, priya, ravi } = await office();
  const open = await owner.request('conv.create', { kind: 'space', name: 'Site visits', topic: 'Visits to the refinery', members: [me(priya)] });
  const priv = await owner.request('conv.create', { kind: 'space', name: 'Salaries', private: true, members: [me(priya)] });
  const dm = await owner.request('conv.create', { kind: 'direct', members: [me(priya)] });
  const card = await ravi.request('links.preview', { url: `dexconnect://conversation/${open.id}` });
  assert.equal(card.kind, 'conversation');
  assert.equal(card.title, 'Site visits');
  assert.equal(card.subtitle, 'Visits to the refinery');
  assert.ok(card.actions.some((a) => a.kind === 'join'));
  assert.equal(card.meta.find((x) => x.key === 'members')?.ref, 2);
  for (const id of [priv.id, dm.id]) {
    const c = await ravi.request('links.preview', { url: `dexconnect://conversation/${id}` });
    assert.equal(c.kind, 'restricted');
    assert.equal(c.title, null);
  }
  const mine = await priya.request('links.preview', { url: `dexconnect://conversation/${dm.id}` });
  assert.equal(mine.title, 'Vikram');
  assert.ok(!mine.actions.some((a) => a.kind === 'join'));
});

test('person, file, meeting and Desk task links follow their own permissions', async () => {
  const { hub, owner, priya, ravi } = await office();
  const person = await ravi.request('links.preview', { url: `dexconnect://people/${me(priya)}` });
  assert.equal(person.kind, 'person');
  assert.equal(person.title, 'Priya');
  // a file posted in a private Space
  const sp = await owner.request('conv.create', { kind: 'space', name: 'Drawings', private: true, members: [me(priya)] });
  const pdf = Buffer.from('%PDF-1.4 test');
  const info = await new Promise<{ id: string }>((resolve, reject) => {
    const r = https.request({ host: '127.0.0.1', port: hub.port, path: '/files?name=ISO-1001%20Rev%20B.pdf&type=application%2Fpdf', method: 'POST', rejectUnauthorized: false, headers: { authorization: `Bearer ${owner.session!.fileToken}`, 'content-length': String(pdf.length) } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(JSON.parse(b)));
    });
    r.on('error', reject); r.end(pdf);
  });
  await owner.request('msg.send', { convId: sp.id, body: 'Rev B', files: [info.id], clientId: 'f1' });
  const file = await priya.request('links.preview', { url: `dexconnect://file/${info.id}` });
  assert.equal(file.kind, 'file');
  assert.equal(file.title, 'ISO-1001 Rev B.pdf');
  assert.equal(file.subtitle, 'PDF document');
  assert.equal(file.meta.find((x) => x.key === 'size')?.ref, pdf.length);
  assert.equal((await ravi.request('links.preview', { url: `dexconnect://file/${info.id}` })).kind, 'restricted');
  // a meeting
  const start = Date.now() + 3600_000;
  const ev = await owner.request('cal.create', { title: 'Model review 60%', startAt: start, endAt: start + 3600_000, attendees: [me(priya)], location: 'Room 2' });
  const evCard = await priya.request('links.preview', { url: `dexconnect://calendar/event/${ev.id}` });
  assert.equal(evCard.kind, 'event');
  assert.equal(evCard.title, 'Model review 60%');
  assert.equal(evCard.meta.find((x) => x.key === 'status')?.value, 'Not answered');
  assert.equal((await ravi.request('links.preview', { url: `dexconnect://event/${ev.id}` })).kind, 'restricted');
  // a Desk task
  const task = await priya.request('remind.create', { text: 'Chase the MTO for unit 300', dueAt: Date.now() + 86400_000 });
  const t = await priya.request('links.preview', { url: `dexconnect://desk/task/${task.id}` });
  assert.equal(t.kind, 'task');
  assert.equal(t.title, 'Chase the MTO for unit 300');
  assert.equal(t.meta.find((x) => x.key === 'status')?.value, 'Open');
  assert.equal((await ravi.request('links.preview', { url: `dexconnect://desk/task/${task.id}` })).kind, 'restricted');
  // junk ids
  assert.equal((await priya.request('links.preview', { url: 'dexconnect://file/../../etc/passwd' })).kind, 'restricted');
});

test('tool links: Sleuth, Dexterity Sheets, Project Opener and Datum', async () => {
  const { priya } = await office();
  const sleuth = await priya.request('links.preview', { url: `sleuth://search?q=${encodeURIComponent('6"-P-1001-A1B')}` });
  assert.equal(sleuth.kind, 'search');
  assert.equal(sleuth.title, 'Find “6"-P-1001-A1B” in the drawings');
  assert.equal(sleuth.actions[0].kind, 'open-in-tool');
  assert.equal(sleuth.actions[0].tool, 'sleuth');
  const sheet = await priya.request('links.preview', { url: 'dexterity://open/PC-SERVER:47810/line-list-100-3f2a?at=Line%20List!B4' });
  assert.equal(sheet.kind, 'workbook');
  assert.equal(sheet.title, 'Line list 100');
  assert.equal(sheet.subtitle, 'Dexterity Sheets · PC-SERVER:47810');
  assert.equal(sheet.meta.find((x) => x.key === 'sheet')?.value, 'Line List');
  assert.equal(sheet.meta.find((x) => x.key === 'location')?.value, 'B4');
  const proj = await priya.request('links.preview', { url: 'projectopener://open/P12513%20As-built%20isometrics/' });
  assert.equal(proj.kind, 'project');
  assert.equal(proj.title, 'P12513 As-built isometrics');
  assert.equal((await priya.request('links.preview', { url: 'datum://c/Flan1' })).kind, 'component');
  assert.equal((await priya.request('links.preview', { url: 'datum://m/cog/lift?x=1' })).title, 'cog / lift');
});

test('paths on the office share: a card with the path, its type and Open folder (nothing is read)', async () => {
  const { priya } = await office();
  const file = await priya.request('links.preview', { url: '\\\\fileserver\\Projects\\P-12513\\Isometrics\\ISO-0042 Rev B.dwg' });
  assert.equal(file.kind, 'path');
  assert.equal(file.title, 'ISO-0042 Rev B.dwg');
  assert.equal(file.meta.find((x) => x.key === 'type')?.value, 'AutoCAD drawing');
  assert.equal(file.meta.find((x) => x.key === 'site')?.value, 'fileserver');
  const open = file.actions.find((a) => a.kind === 'open-in-tool')!;
  assert.equal(open.label, 'Open folder');
  assert.equal(open.target, '\\\\fileserver\\Projects\\P-12513\\Isometrics');
  assert.equal(file.actions.find((a) => a.kind === 'copy-path')?.target, '\\\\fileserver\\Projects\\P-12513\\Isometrics\\ISO-0042 Rev B.dwg');
  const folder = await priya.request('links.preview', { url: 'file://fileserver/Projects/P-12513/MTO/' });
  assert.equal(folder.kind, 'folder');
  assert.equal(folder.title, 'MTO');
  assert.equal(folder.meta.find((x) => x.key === 'path')?.value, '\\\\fileserver\\Projects\\P-12513\\MTO\\');
  const local = await priya.request('links.preview', { url: 'D:\\Jobs\\P-12513\\calc.xlsx' });
  assert.equal(local.meta.find((x) => x.key === 'type')?.value, 'Excel workbook');
});

test('drive maps: a device publishes only network roots; members read each writer\'s map; guests neither publish nor read', async () => {
  const { owner, priya, ravi } = await office();
  // priya's PC: X: and J: are network drives, S: a subst onto X:, C: is local
  const r = await priya.request('links.drives.set', { drives: [
    { letter: 'x', root: '\\\\nas01\\Project\\' }, { letter: 'J:', root: '//nas01/Project/Jobs' }, { letter: 'S:', root: 'X:\\Sub' },
    { letter: 'T:', root: 'C:\\Temp' }, { letter: 'Q:', root: 'not a path' }, { letter: 'bad', root: '\\\\nas01\\x' },
  ] });
  assert.equal(r.count, 3);
  const maps = await ravi.request('links.drives.of', { userIds: [me(priya), me(ravi), 'nobody'] });
  assert.equal(maps[me(priya)].known, true);
  assert.deepEqual(maps[me(priya)].drives, [
    { letter: 'J:', root: '\\\\nas01\\Project\\Jobs' }, { letter: 'S:', root: '\\\\nas01\\Project\\Sub' }, { letter: 'X:', root: '\\\\nas01\\Project' },
  ], 'local and subst-onto-local drives never reach the hub');
  assert.deepEqual(maps[me(ravi)], { known: false, drives: [] }, 'a person who never published is unknown');
  assert.deepEqual(maps.nobody, { known: false, drives: [] });
  // an empty map is still known: "this PC has no network drives"
  await ravi.request('links.drives.set', { drives: [] });
  assert.deepEqual((await priya.request('links.drives.of', { userIds: [me(ravi)] }))[me(ravi)], { known: true, drives: [] });
  // guests: no publishing, no reading
  await owner.request('admin.setRole', { userId: me(ravi), role: 'guest' });
  await assert.rejects(ravi.request('links.drives.of', { userIds: [me(priya)] }), /only shown to members/);
  await assert.rejects(ravi.request('links.drives.set', { drives: [] }), /Only members/);
  assert.deepEqual((await priya.request('links.drives.of', { userIds: [me(ravi)] }))[me(ravi)], { known: false, drives: [] }, 'a guest\'s old map is not given out');
  await assert.rejects(priya.request('links.drives.set', { drives: Array.from({ length: 27 }, (_, i) => ({ letter: 'X:', root: `\\\\s\\${i}` })) }), /up to 26/);
});

test('drive maps: two devices of one person agree, or the letter is left out', async () => {
  const { priya, join, owner } = await office();
  await priya.request('links.drives.set', { drives: [{ letter: 'X:', root: '\\\\nas01\\Project' }, { letter: 'W:', root: '\\\\nas02\\Submissions' }] });
  // priya's laptop maps W: elsewhere
  const { c: laptop, identity } = await join('priya');
  await owner.request('admin.decide', { deviceId: identity.deviceId, approve: true });
  await until(laptop, (s) => s.kind === 'ready');
  assert.equal(me(laptop), me(priya));
  await laptop.request('links.drives.set', { drives: [{ letter: 'x:', root: '\\\\NAS01\\project' }, { letter: 'W:', root: '\\\\nas03\\Archive' }] });
  const maps = await owner.request('links.drives.of', { userIds: [me(priya)] });
  assert.deepEqual(maps[me(priya)].drives, [{ letter: 'X:', root: '\\\\nas01\\Project' }]);
});

// ------------------------------------------------------------------ web cards

test('web pages: fetched once, cached, and limited to 30 a minute per person', async () => {
  const { hub, priya, ravi } = await office();
  const s = await site((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html(`<meta property="og:title" content="Page ${req.url}"><meta property="og:description" content="About ${req.url}"><meta property="og:image" content="/pic.png">`));
  });
  hub.links.fetchOptions = via(s);
  const card = await priya.request('links.preview', { url: 'http://vendor.test/datasheet#section-2' });
  assert.equal(card.kind, 'web');
  assert.equal(card.status, 'ok');
  assert.equal(card.title, 'Page /datasheet');
  assert.equal(card.preview?.excerpt, 'About /datasheet');
  assert.equal(card.preview?.imageUrl, 'http://vendor.test/pic.png');
  assert.equal(card.cached, undefined);
  // the same page (any #fragment) comes from the cache, for anyone
  const again = await ravi.request('links.preview', { url: 'http://vendor.test/datasheet' });
  assert.equal(again.cached, true);
  assert.equal(again.title, 'Page /datasheet');
  assert.equal(s.hits.length, 1);
  // the cache lasts a day
  hub.store.db.prepare('UPDATE link_cache SET fetched_at = fetched_at - ?').run(25 * 3600_000);
  assert.equal((await ravi.request('links.preview', { url: 'http://vendor.test/datasheet' })).cached, undefined);
  assert.equal(s.hits.length, 2);
  // 30 fresh previews a minute; cached ones do not count
  for (let i = 1; i < RATE_LIMIT; i++) await priya.request('links.preview', { url: `http://vendor.test/p${i}` });
  await assert.rejects(priya.request('links.preview', { url: 'http://vendor.test/one-too-many' }), /Too many link previews/);
  assert.equal((await priya.request('links.preview', { url: 'http://vendor.test/p1' })).cached, true);
  // someone else has their own allowance
  assert.equal((await ravi.request('links.preview', { url: 'http://vendor.test/for-ravi' })).status, 'ok');
});

test('web pages: PDFs, images, YouTube and GitHub get their own cards', async () => {
  const { hub, priya } = await office();
  const png = Buffer.alloc(64); png.writeUInt32BE(0x89504e47, 0); png.write('\r\n\x1a\n', 4, 'latin1'); png.write('IHDR', 12, 'latin1'); png.writeUInt32BE(640, 16); png.writeUInt32BE(480, 20);
  const s = await site((req, res) => {
    if (req.url?.endsWith('.pdf')) { res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': '2097152' }); res.end(Buffer.alloc(2_097_152)); return; }
    if (req.url?.endsWith('.png')) { res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(png.length) }); res.end(png); return; }
    if (req.url?.startsWith('/watch')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html('<meta property="og:title" content="Pipe stress basics"><meta property="og:site_name" content="YouTube">')); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html('<meta property="og:title" content="Nozzle loads exceed limits · Issue #42 · acme/plant-model"><meta property="og:description" content="See the report">'));
  });
  hub.links.fetchOptions = { resolve: async () => [PUBLIC], connectTo: () => ({ host: '127.0.0.1', port: s.port }) };
  const pdf = await priya.request('links.preview', { url: 'http://vendor.test/docs/Pump%20P-101.pdf' });
  assert.equal(pdf.kind, 'pdf');
  assert.equal(pdf.title, 'Pump P-101.pdf');
  assert.equal(pdf.meta.find((x) => x.key === 'size')?.value, '2.0 MB');
  const img = await priya.request('links.preview', { url: 'http://vendor.test/site.png' });
  assert.equal(img.kind, 'image');
  assert.equal(img.meta.find((x) => x.key === 'dimensions')?.value, '640 × 480');
  assert.equal(img.preview?.imageUrl, 'http://vendor.test/site.png');
  const yt = await priya.request('links.preview', { url: 'http://www.youtube.com/watch?v=dQw4w9WgXcQ' });
  assert.equal(yt.kind, 'video');
  assert.equal(yt.title, 'Pipe stress basics');
  assert.equal(yt.preview?.imageUrl, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
  const gh = await priya.request('links.preview', { url: 'http://github.com/acme/plant-model/issues/42' });
  assert.equal(gh.kind, 'issue');
  assert.equal(gh.title, 'Nozzle loads exceed limits');
  assert.equal(gh.subtitle, 'acme/plant-model #42');
});

test('web pages: blocked addresses give a card that says so; settings turn previews off (and are off for guests)', async () => {
  const { hub, owner, priya, ravi } = await office();
  const s = await site((_q, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html('<title>Inside</title>')); });
  hub.links.fetchOptions = { resolve: async (h) => (h === 'wiki.dex' ? ['10.0.0.7'] : [PUBLIC]), connectTo: () => ({ host: '127.0.0.1', port: s.port }) };
  const blocked = await priya.request('links.preview', { url: 'http://wiki.dex/page' });
  assert.equal(blocked.kind, 'unavailable');
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.title, null);
  assert.equal((await priya.request('links.preview', { url: 'http://127.0.0.1:8080/' })).status, 'blocked');
  assert.equal(s.hits.length, 0);
  // an administrator lists the office wiki
  await assert.rejects(priya.request('admin.links.set', { allowLanHosts: ['wiki.dex'] }), /Only administrators/);
  await assert.rejects(owner.request('admin.links.set', { allowLanHosts: ['not a host!'] }), /not a host name/);
  const set = await owner.request('admin.links.set', { allowLanHosts: ['Wiki.Dex'] });
  assert.deepEqual(set.allowLanHosts, ['wiki.dex']);
  assert.equal((await priya.request('links.preview', { url: 'http://wiki.dex/page' })).title, 'Inside');
  // guests get no web previews unless the office allows it
  await owner.request('admin.setRole', { userId: me(ravi), role: 'guest' });
  const forGuest = await ravi.request('links.preview', { url: 'http://vendor.test/x' });
  assert.equal(forGuest.status, 'disabled');
  assert.equal(forGuest.title, null);
  // off for everyone
  const off = await owner.request('admin.links.set', { externalPreviews: false });
  assert.equal(off.externalPreviews, false);
  const hits = s.hits.length;
  const card = await priya.request('links.preview', { url: 'http://vendor.test/new' });
  assert.equal(card.status, 'disabled');
  assert.equal(s.hits.length, hits);
  // internal cards are unaffected
  assert.equal((await priya.request('links.preview', { url: `dexconnect://people/${me(owner)}` })).kind, 'person');
  assert.deepEqual(await owner.request('admin.links.get'), { externalPreviews: false, guestExternalPreviews: false, allowLanHosts: ['wiki.dex'] });
});

test('posting a message with a link never waits: the preview is fetched afterwards', async () => {
  const { hub, owner, priya } = await office();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const s = await site(async (_q, res) => { await gate; res.writeHead(200, { 'content-type': 'text/html' }); res.end(html('<title>Spec sheet</title>')); });
  hub.links.fetchOptions = via(s);
  const sp = await owner.request('conv.create', { kind: 'space', name: 'Vendors', members: [me(priya)] });
  const t0 = Date.now();
  const sent = await send(owner, sp.id, 'Datasheet: http://vendor.test/spec-sheet.');
  assert.ok(sent.id);
  assert.ok(Date.now() - t0 < 1000, 'the post did not wait for the page');
  for (let i = 0; i < 50 && !s.hits.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(s.hits, ['/spec-sheet']);
  release();
  for (let i = 0; i < 50; i++) { if (hub.store.db.prepare('SELECT 1 FROM link_cache').get()) break; await new Promise((r) => setTimeout(r, 20)); }
  const card: LinkCard = await priya.request('links.preview', { url: 'http://vendor.test/spec-sheet' });
  assert.equal(card.cached, true);
  assert.equal(card.title, 'Spec sheet');
  assert.equal(s.hits.length, 1);
});

// ------------------------------------------------------------------ side-tracks about a link

test('links.discuss: finds the message with the link, or starts one; the side-track is the usual one', async () => {
  const { owner, priya, ravi } = await office();
  const sp = await owner.request('conv.create', { kind: 'space', name: 'Vendor data', members: [me(priya)] });
  const m = await send(owner, sp.id, 'New GA from the vendor: https://vendor.test/ga-2001 (Rev C)');
  const t = await priya.request('links.discuss', { url: 'https://vendor.test/ga-2001#top', convId: sp.id });
  assert.equal(t.rootMessageId, m.id);
  assert.equal(t.created, false);
  assert.equal(t.url, 'https://vendor.test/ga-2001');
  // reply in the side-track as usual, and the same thread comes back
  await priya.request('msg.send', { convId: sp.id, body: 'Nozzle N3 moved 50 mm', parentId: t.rootMessageId, clientId: 'd1' });
  const again = await owner.request('links.discuss', { url: 'https://vendor.test/ga-2001', convId: sp.id });
  assert.equal(again.rootMessageId, m.id);
  assert.equal(again.root.replyCount, 1);
  // a link nobody has posted yet: a message with it starts the side-track (once)
  const fresh = await priya.request('links.discuss', { url: 'https://vendor.test/mto-300', convId: sp.id });
  assert.equal(fresh.created, true);
  assert.equal(fresh.root.body, 'https://vendor.test/mto-300');
  assert.equal(fresh.root.authorId, me(priya));
  const same = await priya.request('links.discuss', { url: 'https://vendor.test/mto-300', convId: sp.id });
  assert.equal(same.rootMessageId, fresh.rootMessageId);
  assert.equal(same.created, false);
  // members only
  await assert.rejects(ravi.request('links.discuss', { url: 'https://vendor.test/ga-2001', convId: sp.id }), /Conversation not found/);
  // if the anchoring message is deleted, the next discussion starts afresh
  await priya.request('msg.delete', { messageId: fresh.rootMessageId });
  const after = await priya.request('links.discuss', { url: 'https://vendor.test/mto-300', convId: sp.id });
  assert.notEqual(after.rootMessageId, fresh.rootMessageId);
});

test('links.discuss in a Direct conversation anchors to the message the person chose', async () => {
  const { owner, priya } = await office();
  const dm = await owner.request('conv.create', { kind: 'direct', members: [me(priya)] });
  await assert.rejects(owner.request('links.discuss', { url: 'https://vendor.test/x', convId: dm.id }), /start the side-track from the message/);
  const m = await send(owner, dm.id, 'see https://vendor.test/x');
  const t = await priya.request('links.discuss', { url: 'https://vendor.test/x', convId: dm.id, messageId: m.id });
  assert.equal(t.rootMessageId, m.id);
  assert.equal((await owner.request('links.discuss', { url: 'https://vendor.test/x', convId: dm.id })).rootMessageId, m.id);
  await assert.rejects(priya.request('links.discuss', { url: 'https://vendor.test/y', convId: dm.id, messageId: 'nope' }), /cannot start a side-track/);
});
