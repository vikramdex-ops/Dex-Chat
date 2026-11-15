// The gateway Worker in Cloudflare's local runtime (wrangler dev, as the hub's remote tests run
// it), with a scripted hub on the other side: the guest meeting page and its assets, guest sockets
// relayed to the hub as guest frames and back, wrong passcodes counted per address in the Durable
// Object, connection limits, and guests dropped when the hub goes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto, { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { loadOrCreateCertificate } from '../../hub/src/tls.ts';

let base = '';
let skip: string | false = false;
let stop: () => Promise<void> = async () => {};
const persist = fs.mkdtempSync(path.join(os.tmpdir(), 'dexgw-'));
/** The certificate of the hub that claims the meeting and webinar pages (it reconnects in later tests). */
const homeHubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexgw-home-'));

before(async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const bin = path.resolve(root, '../../node_modules/.bin/wrangler');
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  // a fresh state directory: wrong passcodes and the remembered hub start from nothing
  const child = spawn(bin, ['dev', '--ip', '127.0.0.1', '--port', String(port), '--config', path.join(root, 'wrangler.jsonc'), '--persist-to', persist, '--show-interactive-dev-session=false', '--log-level', 'info'],
    { cwd: root, detached: true, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  stop = async () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ } };
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('wrangler did not start in 90 s')), 90_000);
      const seen = (b: Buffer) => { if (/Ready on/.test(b.toString())) { clearTimeout(t); resolve(); } };
      child.stdout!.on('data', seen);
      child.stderr!.on('data', seen);
      child.on('exit', (code) => { clearTimeout(t); reject(new Error(`wrangler exited (${code})`)); });
    });
    child.stdout!.resume(); child.stderr!.resume();
    base = `127.0.0.1:${port}`;
  } catch (err) {
    await stop();
    skip = `the gateway could not run here: ${(err as Error).message}`;
  }
});
after(async () => { await stop(); fs.rmSync(persist, { recursive: true, force: true }); fs.rmSync(homeHubDir, { recursive: true, force: true }); });

/** A hub as the gateway sees it: signs the challenge with its certificate's key, then talks control frames. */
async function fakeHub(hubId: string, keep?: string) {
  const dir = keep ?? fs.mkdtempSync(path.join(os.tmpdir(), 'dexgw-hub-'));
  const tls = loadOrCreateCertificate(dir, `Test hub ${hubId}`);
  const x = new X509Certificate(tls.cert);
  const ws = new WebSocket(`ws://${base}/hub/${hubId}`);
  const inbox: Array<Record<string, unknown>> = [];
  const waiters: Array<() => void> = [];
  ws.on('message', (raw, binary) => {
    if (binary) return;
    const m = JSON.parse(raw.toString()) as Record<string, unknown>;
    if (m.t === 'challenge') {
      const sig = crypto.sign('sha256', Buffer.from(`dexconnect-gw-hub-v1|${hubId}|${m.n}`), tls.key);
      ws.send(JSON.stringify({ t: 'auth', cert: Buffer.from(x.raw).toString('base64'), spki: x.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), sig: sig.toString('base64') }));
      return;
    }
    inbox.push(m);
    for (const w of waiters.splice(0)) w();
  });
  const next = async (t: string, pred: (m: Record<string, unknown>) => boolean = () => true, ms = 8000) => {
    const end = Date.now() + ms;
    for (;;) {
      const i = inbox.findIndex((m) => m.t === t && pred(m));
      if (i >= 0) return inbox.splice(i, 1)[0];
      if (Date.now() > end) throw new Error(`hub saw no ${t} (has ${inbox.map((m) => m.t).join(', ')})`);
      await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 100); });
    }
  };
  await next('ready');
  return { ws, next, send: (m: unknown) => ws.send(JSON.stringify(m)), close: () => { ws.close(); if (!keep) fs.rmSync(dir, { recursive: true, force: true }); } };
}

function guest(meetingId: string) {
  const ws = new WebSocket(`ws://${base}/m/${meetingId}/ws`);
  const got: string[] = [];
  ws.on('message', (d) => got.push(d.toString()));
  const closed = new Promise<{ code: number; reason: string }>((r) => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
  const opened = new Promise<void>((r, j) => { ws.on('open', () => r()); ws.on('error', j); });
  return { ws, got, closed, opened };
}

test('the guest page: served for a meeting ID, strict headers, its own script and styles', async (t) => {
  if (skip) { t.skip(skip); return; }
  const page = await fetch(`http://${base}/m/482913207`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type')!, /text\/html/);
  const csp = page.headers.get('content-security-policy')!;
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.match(page.headers.get('permissions-policy')!, /camera=\(self\)/);
  const html = await page.text();
  assert.match(html, /data-meeting="482913207"/);
  assert.match(html, /<title>Meeting 482-913-207/);
  assert.match(html, /src="\/guest\/app\.js"/);
  const js = await fetch(`http://${base}/guest/app.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type')!, /javascript/);
  const code = await js.text();
  assert.ok(code.length > 5000 && /RTCPeerConnection/.test(code));
  const css = await fetch(`http://${base}/guest/app.css`);
  assert.match(css.headers.get('content-type')!, /text\/css/);
  // not a meeting ID: nothing
  assert.equal((await fetch(`http://${base}/m/012345678`)).status, 404);
  assert.equal((await fetch(`http://${base}/m/48291320`)).status, 404);
  assert.equal((await fetch(`http://${base}/m/482913207/other`)).status, 404);
  assert.equal((await fetch(`http://${base}/m/482913207`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`http://${base}/m/482913207/ws`)).status, 426);
});

test('webinar pages: registration, watch and survey pages; requests answered by the hub; the honeypot, form limits and registrations per address', async (t) => {
  if (skip) { t.skip(skip); return; }
  for (const [p, mode] of [['/w/482913207', 'register'], ['/w/482913207/watch', 'watch'], ['/w/482913207/survey', 'survey']]) {
    const page = await fetch(`http://${base}${p}`);
    assert.equal(page.status, 200, p);
    const csp = page.headers.get('content-security-policy')!;
    assert.match(csp, /connect-src 'self'/);
    assert.doesNotMatch(csp, /unsafe-inline/);
    assert.match(page.headers.get('permissions-policy')!, /camera=\(\)/, 'a watch page never asks for the camera');
    const html = await page.text();
    assert.match(html, new RegExp(`data-webinar="482913207" data-mode="${mode}"`));
    assert.match(html, /src="\/webinar\/app\.js"/);
  }
  const js = await (await fetch(`http://${base}/webinar/app.js`)).text();
  assert.ok(js.length > 5000 && /RTCPeerConnection/.test(js) && /register/.test(js));
  assert.match((await fetch(`http://${base}/webinar/app.css`)).headers.get('content-type')!, /text\/css/);
  assert.equal((await fetch(`http://${base}/w/012345678`)).status, 404);
  assert.equal((await fetch(`http://${base}/w/482913207/other`)).status, 404);
  assert.equal((await fetch(`http://${base}/w/482913207/ws`)).status, 426);
  // no office connected yet: a plain answer, not a hang
  const none = await fetch(`http://${base}/w/482913207/info`);
  assert.equal(none.status, 503);
  assert.match((await none.json() as { error: string }).error, /not connected/);

  const hub = await fakeHub('a1b2c3d4e5f60718', homeHubDir);
  // the details: asked of the hub over its connection, answered with its status and body
  const info = fetch(`http://${base}/w/482913207/info`);
  const ask = await hub.next('w', (m) => m.op === 'info');
  assert.equal(ask.m, '482913207');
  assert.equal(typeof ask.ip, 'string');
  hub.send({ t: 'w-res', r: ask.r, s: 200, d: JSON.stringify({ title: 'Pump skid design review', open: true }) });
  const got = await info;
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('x-frame-options'), 'DENY');
  assert.deepEqual(await got.json(), { title: 'Pump skid design review', open: true });

  const post = (sub: string, body: unknown, type = 'application/json') => fetch(`http://${base}/w/482913207/${sub}`, { method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  // the honeypot: thanked, and never passed on
  const bot = await post('register', { name: 'Bot', email: 'bot@spam.example', website: 'http://spam.example' });
  assert.equal(bot.status, 200);
  assert.deepEqual(await bot.json(), { status: 'pending', name: '' });
  await assert.rejects(hub.next('w', (m) => m.op === 'register', 800), /no w/);
  // forms the gateway does not pass on
  assert.equal((await post('register', 'name=x', 'application/x-www-form-urlencoded')).status, 415);
  assert.equal((await post('register', { name: 'x'.repeat(20_000) })).status, 413);
  assert.equal((await post('register', '[1,2]')).status, 400);
  assert.equal((await fetch(`http://${base}/w/482913207/register`)).status, 405, 'registering is a POST');
  // a registration: passed on with its answers, the hub's answer passed back
  const reg = post('register', { name: 'Dana Wright', email: 'dana@acme.example', answers: { q1: 'Acme' }, website: '' });
  const r1 = await hub.next('w', (m) => m.op === 'register');
  assert.deepEqual(r1.b, { name: 'Dana Wright', email: 'dana@acme.example', answers: { q1: 'Acme' }, website: '' });
  hub.send({ t: 'w-res', r: r1.r, s: 200, d: JSON.stringify({ status: 'approved', token: 'T'.repeat(22), name: 'Dana Wright' }) });
  assert.equal((await (await reg).json() as { status: string }).status, 'approved');
  // the hub's refusals come through as they are
  const dup = post('register', { name: 'Dana Wright', email: 'dana@acme.example' });
  const r2 = await hub.next('w', (m) => m.op === 'register');
  hub.send({ t: 'w-res', r: r2.r, s: 409, d: JSON.stringify({ error: 'This email address is registered already.' }) });
  assert.equal((await dup).status, 409);
  // five registrations an hour from one address: the sixth is refused here
  for (let i = 0; i < 3; i++) {
    const p = post('register', { name: `Person ${i}`, email: `p${i}@x.example` });
    const r = await hub.next('w', (m) => m.op === 'register');
    hub.send({ t: 'w-res', r: r.r, s: 200, d: JSON.stringify({ status: 'pending', name: `Person ${i}` }) });
    assert.equal((await p).status, 200);
  }
  const sixth = await post('register', { name: 'One too many', email: 'more@x.example' });
  assert.equal(sixth.status, 429);
  assert.match((await sixth.json() as { error: string }).error, /Too many registrations/);
  // the survey's requests
  const sv = post('survey-info', { token: 'T'.repeat(22) });
  const s1 = await hub.next('w', (m) => m.op === 'surveyInfo');
  hub.send({ t: 'w-res', r: s1.r, s: 200, d: JSON.stringify({ title: 'Pump skid design review', fields: [] }) });
  assert.equal((await sv).status, 200);
  const ans = post('answers', { token: 'T'.repeat(22), answers: { q1: 'Very' } });
  const s2 = await hub.next('w', (m) => m.op === 'survey');
  hub.send({ t: 'w-res', r: s2.r, s: 200, d: '{"ok":true}' });
  assert.equal((await ans).status, 200);
  // the watch page's socket: a guest socket, marked as a webinar's
  const ws = new WebSocket(`ws://${base}/w/482913207/ws`);
  await new Promise<void>((r, j) => { ws.on('open', () => r()); ws.on('error', j); });
  const open = await hub.next('g-open');
  assert.equal(open.m, '482913207');
  assert.equal(open.k, 'w');
  ws.send(JSON.stringify({ t: 'watch', token: 'T'.repeat(22) }));
  const up = await hub.next('g', (m) => m.g === open.g);
  assert.deepEqual(JSON.parse(String(up.d)), { t: 'watch', token: 'T'.repeat(22) });
  ws.close();
  await hub.next('g-closed', (m) => m.g === open.g);
  hub.close();
});

test('calendar feeds: /cal/<token>.ics asked of the hub as a cal frame, answered as text/calendar; bad paths and other methods refused', async (t) => {
  if (skip) { t.skip(skip); return; }
  const token = 'A'.repeat(20) + '_' + 'b'.repeat(22);
  assert.equal((await fetch(`http://${base}/cal/short.ics`)).status, 404);
  assert.equal((await fetch(`http://${base}/cal/${token}`)).status, 404, 'only .ics');
  assert.equal((await fetch(`http://${base}/cal/${token}.ics`, { method: 'POST', body: 'x' })).status, 405);
  const hub = await fakeHub('a1b2c3d4e5f60718', homeHubDir);
  const feed = fetch(`http://${base}/cal/${token}.ics`);
  const ask = await hub.next('cal');
  assert.equal(ask.k, token);
  assert.equal(typeof ask.ip, 'string');
  hub.send({ t: 'w-res', r: ask.r, s: 200, d: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', ct: 'text/calendar; charset=utf-8' });
  const got = await feed;
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'text/calendar; charset=utf-8');
  assert.equal(got.headers.get('cache-control'), 'no-store');
  assert.equal(await got.text(), 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n');
  // the hub's refusal passes through; a type the gateway does not expect becomes plain text
  const gone = fetch(`http://${base}/cal/${token}.ics`);
  const a2 = await hub.next('cal');
  hub.send({ t: 'w-res', r: a2.r, s: 404, d: 'This calendar address does not work any more.', ct: 'text/html' });
  const g2 = await gone;
  assert.equal(g2.status, 404);
  assert.equal(g2.headers.get('content-type'), 'text/plain; charset=utf-8');
  hub.close();
});

test('guest frames: relayed to the hub and back; passcodes refused by the hub count per address; the hub leaving drops guests', async (t) => {
  if (skip) { t.skip(skip); return; }
  // before any hub has connected, meeting sockets have nowhere to go
  const early = guest('482913207');
  assert.equal((await early.closed).code, 4404);

  const hub = await fakeHub('a1b2c3d4e5f60718', homeHubDir);
  const g = guest('482913207');
  await g.opened;
  const open = await hub.next('g-open');
  assert.equal(open.m, '482913207');
  assert.equal(typeof open.g, 'number');
  assert.ok(typeof open.ip === 'string');
  // guest -> hub: the frame as it was sent, tagged with the guest
  g.ws.send(JSON.stringify({ t: 'join', name: 'Dana', passcode: 'Hx7kP2qR' }));
  const up = await hub.next('g', (m) => m.g === open.g);
  assert.deepEqual(JSON.parse(String(up.d)), { t: 'join', name: 'Dana', passcode: 'Hx7kP2qR' });
  // hub -> guest
  hub.send({ t: 'g', g: open.g, d: JSON.stringify({ t: 'lobby', meetingId: '482-913-207', title: 'Review', host: 'Priya' }) });
  for (let i = 0; i < 50 && !g.got.length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(JSON.parse(g.got[0]), { t: 'lobby', meetingId: '482-913-207', title: 'Review', host: 'Priya' });
  // the guest leaves: the hub is told
  g.ws.close();
  await hub.next('g-closed', (m) => m.g === open.g);
  // a binary frame is not a guest frame
  const bin = guest('482913207');
  await bin.opened;
  await hub.next('g-open');
  bin.ws.send(Buffer.from([1, 2, 3]));
  assert.equal((await bin.closed).code, 1003);

  // a guest waiting in a lobby while the rest happens
  const stay = guest('482913207');
  await stay.opened;
  await hub.next('g-open');

  // five wrong passcodes from one address: the sixth try is refused at the gateway, never reaching the hub
  for (let i = 0; i < 5; i++) {
    const w = guest('482913207');
    await w.opened;
    const o = await hub.next('g-open');
    hub.send({ t: 'g-close', g: o.g, code: 4403, reason: 'The passcode is wrong' });
    const c = await w.closed;
    assert.equal(c.code, 4403);
    assert.equal(c.reason, 'The passcode is wrong');
  }
  const blocked = guest('482913207');
  const c = await blocked.closed;
  assert.equal(c.code, 4429);
  assert.match(c.reason, /wrong passcodes/);
  await assert.rejects(hub.next('g-open', () => true, 1500), /no g-open/);

  // the hub goes: guests are dropped with it
  hub.close();
  assert.equal((await stay.closed).code, 4404);
});

test('connections are limited per address; a second hub cannot take over the meeting pages', async (t) => {
  if (skip) { t.skip(skip); return; }
  // the first hub claimed /m/ in the previous test; this one (another certificate) cannot
  const other = await fakeHub('ffeeddccbbaa9988');
  const g = guest('555666777');
  // refused by the address limit from the previous test, or routed to the first (now gone) hub: never to this one
  const res = await g.closed;
  assert.ok([4404, 4429].includes(res.code), String(res.code));
  await assert.rejects(other.next('g-open', () => true, 1500), /no g-open/);
  other.close();
  // the device route has its own limit of 40 connections a minute per address
  let refused = 0;
  for (let i = 0; i < 45; i++) {
    const ws = new WebSocket(`ws://${base}/c/a1b2c3d4e5f60718`);
    const code = await new Promise<number>((r) => { ws.on('close', (cd) => r(cd)); ws.on('error', () => r(0)); });
    if (code === 4429) refused++;
  }
  assert.ok(refused >= 4, `refused ${refused}`);
});
