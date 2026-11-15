// The private calendar feed: what it holds (meetings with UIDs, changes and cancellations, the
// meeting link), the token check, and a reset that stops the old address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import type { CalendarFeedInfo } from '@dex/core';
import type { Hub } from '../src/hub.ts';
import { office, me } from './office.ts';

const HOUR = 3600_000;

function get(hub: Hub, p: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const r = https.request({ host: '127.0.0.1', port: hub.port, path: p, method, rejectUnauthorized: false, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    r.on('error', reject);
    r.end();
  });
}

const tokenOf = (info: CalendarFeedInfo) => {
  const m = /\/cal\/([A-Za-z0-9_-]{43})\.ics$/.exec(info.urls!.path);
  assert.ok(m, info.urls!.path);
  return m[1];
};
const unfold = (s: string) => s.replace(/\r\n /g, '');
const vevent = (ics: string, uid: string) => unfold(ics).split('BEGIN:VEVENT').find((b) => b.includes(`UID:${uid}`)) ?? '';

test('the feed: your meetings with UIDs, the meeting link, repeats, changes and cancellations; not declined or other people\'s', async () => {
  const { hub, owner, priya, ravi } = await office();
  const off = await priya.request('cal.feed.get');
  assert.equal(off.enabled, false);
  assert.equal(off.urls, null);
  const on = await priya.request('cal.feed.set', { enabled: true });
  assert.equal(on.enabled, true);
  assert.match(on.urls!.path, /^\/cal\/[A-Za-z0-9_-]{43}\.ics$/);
  for (const u of on.urls!.office) assert.match(u, /^https:\/\/[\d.]+:\d+\/cal\/[A-Za-z0-9_-]{43}\.ics$/);
  assert.equal(on.urls!.outside, null, 'the gateway is off');
  assert.equal((await priya.request('cal.feed.get')).urls, null, 'the address is shown once: the hub keeps only a hash');
  const stored = hub.store.db.prepare('SELECT token_hash FROM cal_feeds WHERE user_id = ?').get(me(priya)) as { token_hash: string };
  assert.ok(!stored.token_hash.includes(tokenOf(on)));

  const t0 = Date.now() + 24 * HOUR;
  const review = await owner.request('cal.create', { title: 'Pump skid review; rev C', startAt: t0, endAt: t0 + HOUR, attendees: [me(priya)], online: true, description: 'Bring the GA drawing' });
  const weekly = await priya.request('cal.create', { title: 'Piping weekly', startAt: t0 + 2 * HOUR, endAt: t0 + 3 * HOUR, recurrence: 'weekly', until: t0 + 60 * 24 * HOUR, location: 'Bay 2' });
  const allDay = await priya.request('cal.create', { title: 'Site visit', startAt: t0, endAt: t0 + HOUR, allDay: true });
  const declined = await owner.request('cal.create', { title: 'Vendor call', startAt: t0 + 5 * HOUR, endAt: t0 + 6 * HOUR, attendees: [me(priya)] });
  await priya.request('cal.respond', { eventId: declined.id, response: 'no' });
  const maybe = await owner.request('cal.create', { title: 'Lunch and learn', startAt: t0 + 7 * HOUR, endAt: t0 + 8 * HOUR, attendees: [me(priya)] });
  await priya.request('cal.respond', { eventId: maybe.id, response: 'maybe' });
  const private_ = await ravi.request('cal.create', { title: 'Ravi only', startAt: t0, endAt: t0 + HOUR });
  const cancelled = await owner.request('cal.create', { title: 'Old plan', startAt: t0 + 9 * HOUR, endAt: t0 + 10 * HOUR, attendees: [me(priya)] });
  await owner.request('cal.cancel', { eventId: cancelled.id });
  await owner.request('cal.update', { eventId: review.id, startAt: t0 + HOUR, endAt: t0 + 2 * HOUR });

  const res = await get(hub, on.urls!.path);
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/calendar; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-store');
  const ics = res.body;
  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'));
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
  assert.ok(!/[^\r]\n/.test(ics), 'CRLF line ends');
  assert.match(unfold(ics), /\r\nX-WR-CALNAME:Priya · Dexterity Office Hub\r\n/);
  const uid = (id: string) => `${id}@dexconnect-${hub.info.id}`;

  const r = vevent(ics, uid(review.id));
  assert.match(r, /\r\nSUMMARY:Pump skid review\\; rev C\r\n/);
  assert.match(r, /\r\nSEQUENCE:1\r\n/, 'the change bumped the sequence');
  assert.match(r, /\r\nURL:dexconnect:\/\/meet\/\d{3}-\d{3}-\d{3}\r\n/);
  assert.match(r, /Join in Dexterity Connect: dexconnect:\/\/meet\//);
  assert.match(r, /Organised by Vikram/);
  assert.match(r, /\r\nSTATUS:CONFIRMED\r\n/);
  const start = new Date(t0 + HOUR).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  assert.match(r, new RegExp(`\\r\\nDTSTART:${start}\\r\\n`));
  // the same meeting ID every time
  const meetingId = /dexconnect:\/\/meet\/([\d-]+)/.exec(r)![1];
  assert.equal(/dexconnect:\/\/meet\/([\d-]+)/.exec(vevent((await get(hub, on.urls!.path)).body, uid(review.id)))![1], meetingId);

  const w = vevent(ics, uid(weekly.id));
  assert.match(w, /\r\nRRULE:FREQ=WEEKLY;UNTIL=\d{8}T\d{6}Z\r\n/);
  assert.match(w, /\r\nLOCATION:Bay 2\r\n/);
  assert.match(vevent(ics, uid(allDay.id)), /\r\nDTSTART;VALUE=DATE:\d{8}\r\n/);
  assert.match(vevent(ics, uid(maybe.id)), /\r\nSTATUS:TENTATIVE\r\n/);
  const c = vevent(ics, uid(cancelled.id));
  assert.match(c, /\r\nSTATUS:CANCELLED\r\n/, 'a cancellation reaches calendars that already have it');
  assert.match(c, /\r\nSEQUENCE:1\r\n/);
  assert.equal(vevent(ics, uid(declined.id)), '', 'meetings you declined are left out');
  assert.equal(vevent(ics, uid(private_.id)), '', "other people's meetings are not in your feed");
  assert.ok(hub.store.db.prepare('SELECT last_fetched_at FROM cal_feeds WHERE user_id = ?').get(me(priya)));
  assert.ok((await priya.request('cal.feed.get')).lastFetchedAt! > 0, 'Preferences shows that a calendar fetched it');

  // calendars that already have this version get "not modified"
  const tag = String(res.headers.etag);
  assert.equal((await get(hub, on.urls!.path, { 'if-none-match': tag })).status, 304);
  const head = await get(hub, on.urls!.path, {}, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal((await get(hub, on.urls!.path, {}, 'POST')).status, 405);
});

test('the token: unknown and malformed addresses are refused, a reset stops the old address, turning it off stops it too', async () => {
  const { hub, priya, owner } = await office();
  const a = await priya.request('cal.feed.set', { enabled: true });
  assert.equal((await get(hub, a.urls!.path)).status, 200);
  assert.equal((await get(hub, `/cal/${'x'.repeat(43)}.ics`)).status, 404);
  assert.equal((await get(hub, '/cal/short.ics')).status, 404);
  assert.equal((await get(hub, `/cal/${tokenOf(a)}`)).status, 404);
  assert.match((await get(hub, `/cal/${'y'.repeat(43)}.ics`)).body, /does not work any more/);

  const b = await priya.request('cal.feed.reset');
  assert.notEqual(b.urls!.path, a.urls!.path);
  assert.equal((await get(hub, a.urls!.path)).status, 404, 'the old address stopped working');
  assert.equal((await get(hub, b.urls!.path)).status, 200);
  // turning it on again while it is on does not change the address (or show it)
  assert.equal((await priya.request('cal.feed.set', { enabled: true })).urls, null);
  assert.equal((await get(hub, b.urls!.path)).status, 200);
  await priya.request('cal.feed.set', { enabled: false });
  assert.equal((await get(hub, b.urls!.path)).status, 404);
  assert.ok(hub.store.auditTrail(50).some((x) => x.action === 'calfeed.reset'));

  // through the internet gateway: the same check, answered as text for the gateway to pass on
  await owner.request('admin.remote.set', { url: 'https://dexconnect-gateway.example.workers.dev', enabled: true });
  const c = await priya.request('cal.feed.set', { enabled: true });
  assert.equal(c.urls!.outside, `https://dexconnect-gateway.example.workers.dev${c.urls!.path}`);
  assert.equal(c.gateway, 'https://dexconnect-gateway.example.workers.dev');
  const viaGateway = hub.gateway.opts.calendar!(tokenOf(c), '203.0.113.9 (IN)');
  assert.equal(viaGateway.status, 200);
  assert.equal(viaGateway.type, 'text/calendar; charset=utf-8');
  assert.ok(viaGateway.body.length < 250_000);
  assert.equal(hub.gateway.opts.calendar!(tokenOf(a), '203.0.113.9 (IN)').status, 404);
  await owner.request('admin.remote.set', { enabled: false });

  // guessing addresses from one network is cut off
  for (let i = 0; i < 30; i++) hub.feeds.fetch('z'.repeat(43), '198.51.100.7');
  assert.equal(hub.feeds.fetch(tokenOf(c), '198.51.100.7').status, 429);
  assert.equal(hub.feeds.fetch(tokenOf(c), '198.51.100.8').status, 200);
});
