// Zoho Calendar sync against a mock Zoho (zoho-mock.ts): the office's client, a person connecting
// (with their account in another data centre), meetings copied, changed, cancelled, declined and
// repeated without duplicates (also across a hub restart), time zones, Zoho events read back as
// busy time, edits made in Zoho put back, expired and revoked tokens, and retries. No real Zoho.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HubClient } from '@dex/core/client';
import { parseZohoTime, zohoDay, zohoRrule, zohoUtc } from '@dex/core/zoho';
import type { ZohoDc, ZohoStatus } from '@dex/core/zoho';
import { Hub } from '../src/hub.ts';
import { office, me, cleanups } from './office.ts';
import { ZohoMock } from './zoho-mock.ts';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const PORT = 47917;

async function zohoOffice(dcs: string[] = ['in', 'com']) {
  const mock = await new ZohoMock().start(dcs);
  cleanups.push(() => mock.stop());
  const zoho = { dcs: mock.dcs() as Partial<Record<ZohoDc, { label: string; accounts: string; calendar: string }>>, callbackPort: PORT, retryDelayMs: 5, kickMs: 60_000 };
  const o = await office({ zoho });
  return { ...o, mock, zoho };
}

/** What the desktop app does: open the sign-in page, catch the loopback redirect, hand it to the hub. */
async function connect(c: HubClient, mock: ZohoMock, email: string): Promise<ZohoStatus> {
  mock.signIn = email;
  const { authUrl, state } = await c.request('zoho.connect.start');
  const res = await fetch(authUrl, { redirect: 'manual' });
  const back = new URL(res.headers.get('location')!);
  assert.equal(`${back.origin}${back.pathname}`, `http://127.0.0.1:${PORT}/zoho/callback`);
  assert.equal(back.searchParams.get('state'), state);
  const q = (k: string) => back.searchParams.get(k) ?? undefined;
  return c.request('zoho.connect.finish', { state: q('state')!, code: q('code'), error: q('error'), location: q('location'), accountsServer: q('accounts-server') });
}

async function setUp(owner: HubClient, mock: ZohoMock, dc: ZohoDc = 'in') {
  return owner.request('admin.zoho.set', { dc, clientId: mock.clientId, clientSecret: mock.clientSecret });
}

const lastDm = (hub: Hub, userId: string) => (hub.store.db.prepare(`SELECT m.body FROM messages m JOIN conv_members cm ON cm.conv_id = m.conv_id
  WHERE cm.user_id = ? AND m.author_id = ? ORDER BY m.id DESC LIMIT 1`).get(userId, hub.system.id) as { body: string } | undefined)?.body ?? '';

test('Zoho times: a 10:00 India meeting is 04:30Z; offsets, days and repeat rules', () => {
  const t = Date.UTC(2026, 10, 18, 4, 30);
  assert.equal(zohoUtc(t), '20261118T043000Z');
  assert.equal(parseZohoTime('20261118T100000+0530', 'UTC'), t);
  assert.equal(parseZohoTime('20261118T100000+05:30', 'UTC'), t);
  assert.equal(parseZohoTime('20261118T043000Z', 'Asia/Kolkata'), t);
  assert.equal(parseZohoTime('20261118T100000', 'Asia/Kolkata'), t, 'no offset: the event\'s own zone');
  assert.equal(parseZohoTime('20261118', 'Asia/Kolkata'), Date.UTC(2026, 10, 17, 18, 30), 'an all-day date is midnight in India');
  assert.equal(parseZohoTime('nonsense', 'UTC'), null);
  assert.equal(zohoDay(Date.UTC(2026, 10, 17, 20, 0), 'Asia/Kolkata'), '20261118', 'late evening UTC is the next day in Chennai');
  assert.equal(zohoRrule('weekly', t, null, 'Asia/Kolkata'), 'FREQ=WEEKLY;INTERVAL=1');
  assert.equal(zohoRrule('weekdays', t, Date.UTC(2026, 11, 31), 'Asia/Kolkata'), 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR;UNTIL=20261231T000000Z');
  assert.equal(zohoRrule('monthly', t, null, 'Asia/Kolkata'), 'FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=18');
  assert.equal(zohoRrule('monthly', Date.UTC(2026, 9, 31, 4, 30), null, 'Asia/Kolkata'), null, 'the 31st: written one by one');
  assert.equal(zohoRrule('weekdays', Date.UTC(2026, 10, 21, 4, 30), null, 'Asia/Kolkata'), null, 'starting on a Saturday: written one by one');
});

test('the office\'s Zoho client: administrators only, the secret never comes back, everyone told once', async () => {
  const { hub, owner, priya, mock } = await zohoOffice();
  await assert.rejects(priya.request('admin.zoho.get'), /administrators/);
  const before = await priya.request('zoho.status');
  assert.equal(before.available, false);
  assert.equal(before.state, 'off');
  await assert.rejects(priya.request('zoho.connect.start'), /not set up Zoho Calendar/);
  const view = await setUp(owner, mock);
  assert.equal(view.configured, true);
  assert.equal(view.hasSecret, true);
  assert.equal(view.redirectUri, `http://127.0.0.1:${PORT}/zoho/callback`);
  assert.ok(!JSON.stringify(view).includes(mock.clientSecret), 'the secret is not sent back');
  const stored = hub.store.db.prepare(`SELECT value FROM meta WHERE key = 'zoho_client_secret'`).get() as { value: string };
  assert.ok(!stored.value.includes(mock.clientSecret), 'the secret is sealed in the database');
  assert.match(lastDm(hub, me(priya)), /Connect Zoho Calendar/);
  const count = () => (hub.store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE author_id = ?').get(hub.system.id) as { n: number }).n;
  const n = count();
  await owner.request('admin.zoho.set', { enabled: false });
  assert.equal((await priya.request('zoho.status')).state, 'off');
  await owner.request('admin.zoho.set', { enabled: true });
  assert.equal(count(), n, 'the invitation is sent once');
  assert.equal((await priya.request('zoho.status')).state, 'not-connected');
  // an empty secret keeps the saved one
  assert.equal((await owner.request('admin.zoho.set', { clientSecret: '' })).hasSecret, true);
});

test('connecting: the data centre comes from Zoho\'s redirect, the state is checked, the email and calendars are read', async () => {
  const { owner, priya, ravi, mock } = await zohoOffice(['com', 'in']);
  await setUp(owner, mock, 'com'); // the client is set up in the US data centre; Priya's account is in India
  mock.addUser('priya@dexterity.example', 'in');
  mock.addUser('ravi@dexterity.example', 'in');
  const st = await connect(priya, mock, 'priya@dexterity.example');
  assert.equal(st.state, 'connected');
  assert.equal(st.email, 'priya@dexterity.example');
  assert.equal(st.calendarName, 'My Calendar');
  assert.equal(st.calendars.length, 2);
  assert.ok(mock.log.some((l) => l.dc === 'in' && l.path === '/oauth/v2/token'), 'the code was exchanged in India, where the account lives');
  assert.ok(!mock.log.some((l) => l.dc === 'com' && l.path === '/oauth/v2/token'));

  // a state that was not started, or by someone else, is refused
  const { state } = await ravi.request('zoho.connect.start');
  await assert.rejects(priya.request('zoho.connect.finish', { state, code: 'x' }), /expired or was not started here/);
  // an accounts server that is not one of Zoho's is refused (the client secret is never sent there)
  const s2 = await ravi.request('zoho.connect.start');
  await assert.rejects(ravi.request('zoho.connect.finish', { state: s2.state, code: 'x', accountsServer: 'https://evil.example' }), /not one of Zoho's/);
  // saying no in Zoho
  mock.deny = true;
  await assert.rejects(connect(ravi, mock, 'ravi@dexterity.example'), /not given access/);
  mock.deny = false;
  // only the location (no accounts-server) also finds the data centre
  mock.omitAccountsServer = true;
  assert.equal((await connect(ravi, mock, 'ravi@dexterity.example')).state, 'connected');
});

test('meetings go to Zoho: create, change, repeat, decline, take off, cancel; no duplicates; 10:00 IST is 04:30Z', async () => {
  const { hub, owner, priya, ravi, mock } = await zohoOffice();
  await setUp(owner, mock);
  mock.addUser('priya@x.example');
  await connect(priya, mock, 'priya@x.example');
  const pid = me(priya);
  const day = Math.floor(Date.now() / DAY) * DAY + 3 * DAY;
  const at10 = day + 4.5 * HOUR; // 10:00 in Chennai
  const review = await owner.request('cal.create', { title: 'Pump skid review', startAt: at10, endAt: at10 + HOUR, attendees: [pid, me(ravi)], online: true, timeZone: 'Asia/Kolkata', description: 'Bring the GA drawing' });
  const mine = await priya.request('cal.create', { title: 'Piping weekly', startAt: at10 + 2 * HOUR, endAt: at10 + 3 * HOUR, recurrence: 'weekly', until: at10 + 60 * DAY, location: 'Bay 2', timeZone: 'Asia/Kolkata' });
  await hub.zoho.runNow(pid);
  let evs = mock.eventsOf('priya@x.example');
  assert.deepEqual(evs.map((e) => e.title), ['Piping weekly'], 'an invitation not yet answered is not copied');
  const weekly = evs[0];
  assert.match(weekly.rrule ?? '', /^FREQ=WEEKLY;INTERVAL=1;UNTIL=/);
  assert.equal(weekly.location, 'Bay 2');

  await priya.request('cal.respond', { eventId: review.id, response: 'yes' });
  await hub.zoho.runNow(pid);
  evs = mock.eventsOf('priya@x.example');
  const copy = evs.find((e) => e.title === 'Pump skid review')!;
  assert.ok(copy, 'going: copied');
  assert.equal(copy.dateandtime.start, zohoUtc(at10));
  assert.ok(copy.dateandtime.start.endsWith('T043000Z'), copy.dateandtime.start);
  assert.equal(copy.dateandtime.timezone, 'Asia/Kolkata');
  assert.match(copy.description ?? '', /Bring the GA drawing/);
  assert.match(copy.description ?? '', /dexconnect:\/\/meet\//, 'the app link is there');
  assert.doesNotMatch(copy.description ?? '', /[Pp]asscode:/, 'never the passcode');

  // running again changes nothing (no duplicates, no needless writes)
  const writes = () => mock.log.filter((l) => l.method !== 'GET').length;
  const w0 = writes();
  await hub.zoho.runNow(pid);
  await hub.zoho.runNow(pid);
  assert.equal(writes(), w0);
  assert.equal(mock.eventsOf('priya@x.example').length, 2);

  // the organiser moves it: the same Zoho event changes (the time needs an answer again, so Priya says yes)
  await owner.request('cal.update', { eventId: review.id, startAt: at10 + DAY, endAt: at10 + DAY + HOUR });
  await priya.request('cal.respond', { eventId: review.id, response: 'yes' });
  await hub.zoho.runNow(pid);
  const moved = mock.events.get(copy.uid)!;
  assert.equal(moved.dateandtime.start, zohoUtc(at10 + DAY));
  assert.equal(mock.eventsOf('priya@x.example').length, 2);

  // declining removes it; saying yes again makes it again
  await priya.request('cal.respond', { eventId: review.id, response: 'no' });
  await hub.zoho.runNow(pid);
  assert.equal(mock.events.has(copy.uid), false);
  await priya.request('cal.respond', { eventId: review.id, response: 'yes' });
  await hub.zoho.runNow(pid);
  assert.equal(mock.eventsOf('priya@x.example').filter((e) => e.title === 'Pump skid review').length, 1);
  // taken off the meeting
  await owner.request('cal.update', { eventId: review.id, attendees: [me(ravi)] });
  await hub.zoho.runNow(pid);
  assert.equal(mock.eventsOf('priya@x.example').filter((e) => e.title === 'Pump skid review').length, 0);
  // cancelling her own series
  await priya.request('cal.cancel', { eventId: mine.id });
  await hub.zoho.runNow(pid);
  assert.equal(mock.eventsOf('priya@x.example').length, 0);
  const st = await priya.request('zoho.status');
  assert.ok(st.lastSyncAt && st.pushed >= 3 && !st.lastError);
});

test('a repeat Zoho cannot express is written one time at a time; all-day meetings are dates', async () => {
  const { hub, owner, priya, mock } = await zohoOffice();
  await setUp(owner, mock);
  mock.addUser('priya@x.example');
  await connect(priya, mock, 'priya@x.example');
  const now = new Date();
  // the 31st of a month that has one, at 10:00 on the hub's clock
  let y = now.getFullYear(); let m = now.getMonth() + 1;
  while (new Date(y, m + 1, 0).getDate() < 31) { m++; if (m > 11) { m = 0; y++; } }
  const start = new Date(y, m, 31, 10, 0).getTime();
  await priya.request('cal.create', { title: 'Month-end close', startAt: start, endAt: start + HOUR, recurrence: 'monthly' });
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2).getTime();
  await priya.request('cal.create', { title: 'Site visit', startAt: dayStart, endAt: dayStart + HOUR, allDay: true });
  await hub.zoho.runNow(pid(priya));
  const close = mock.eventsOf('priya@x.example').filter((e) => e.title === 'Month-end close');
  assert.ok(close.length >= 2, `one event per time (${close.length})`);
  assert.ok(close.every((e) => !e.rrule));
  const visit = mock.eventsOf('priya@x.example').find((e) => e.title === 'Site visit')!;
  assert.equal(visit.isallday, true);
  assert.match(visit.dateandtime.start, /^\d{8}$/);
  assert.match(visit.dateandtime.end, /^\d{8}$/);
});
const pid = (c: HubClient) => me(c);

test('Zoho events show here as busy time: Calendar (read-only), free/busy, in a meeting', async () => {
  const { hub, owner, priya, ravi, mock } = await zohoOffice();
  await setUp(owner, mock);
  mock.addUser('priya@x.example');
  await connect(priya, mock, 'priya@x.example');
  const now = Date.now();
  const t = Math.floor(now / HOUR) * HOUR + 26 * HOUR;
  mock.addZohoEvent('priya@x.example', { title: 'Client call (Zoho)', start: zohoUtc(t), end: zohoUtc(t + HOUR) });
  mock.addZohoEvent('priya@x.example', { title: 'Free slot note', start: zohoUtc(t + 2 * HOUR), end: zohoUtc(t + 3 * HOUR), transparency: 1 });
  mock.addZohoEvent('priya@x.example', { title: 'Dentist', start: zohoUtc(now - 10 * 60_000), end: zohoUtc(now + 20 * 60_000), timezone: 'Asia/Kolkata' });
  await hub.zoho.runNow(pid(priya));
  const list = await priya.request('cal.list', { from: now - HOUR, to: now + 3 * DAY, external: true });
  const ext = list.filter((o) => o.event.external);
  assert.deepEqual(ext.map((o) => o.event.title).sort(), ['Client call (Zoho)', 'Dentist']);
  assert.equal(ext.find((o) => o.event.title === 'Client call (Zoho)')!.startAt, t);
  assert.equal((await priya.request('cal.list', { from: now - HOUR, to: now + 3 * DAY })).filter((o) => o.event.external).length, 0, 'only when asked');
  // a colleague planning a meeting sees the block, without its title
  const busy = await ravi.request('cal.busy', { userIds: [pid(priya)], from: now, to: now + 2 * DAY });
  assert.ok(busy.some((b) => b.id === pid(priya) && b.startAt === t && b.endAt === t + HOUR));
  assert.ok(!JSON.stringify(busy).includes('Client call'));
  // Ravi cannot see Priya's Zoho events in his own Calendar
  assert.equal((await ravi.request('cal.list', { from: now - HOUR, to: now + 3 * DAY, external: true })).filter((o) => o.event.external).length, 0);
  assert.ok(hub.zoho.busyNow().has(pid(priya)), 'the dentist appointment counts as in a meeting');
  // Dexterity's own copies are not read back as outside events
  await priya.request('cal.create', { title: 'Own meeting', startAt: t + 5 * HOUR, endAt: t + 6 * HOUR });
  await hub.zoho.runNow(pid(priya));
  await priya.request('zoho.syncNow');
  const again = await priya.request('cal.list', { from: now - HOUR, to: now + 3 * DAY, external: true });
  assert.equal(again.filter((o) => o.event.title === 'Own meeting').length, 1);
  assert.equal((await priya.request('zoho.status')).imported, 2);
  // the administrator sees who is connected and errors, never event contents
  const admin = await owner.request('admin.zoho.get');
  assert.equal(admin.people.length, 1);
  assert.equal(admin.people[0].email, 'priya@x.example');
  assert.ok(!/Client call|Dentist|Own meeting/.test(JSON.stringify(admin)));
});

test('changed or deleted in Zoho: Dexterity\'s version is put back, and the person is told once', async () => {
  const { hub, owner, priya, mock } = await zohoOffice();
  await setUp(owner, mock);
  mock.addUser('priya@x.example');
  await connect(priya, mock, 'priya@x.example');
  const t = Date.now() + 2 * DAY;
  const ev = await priya.request('cal.create', { title: 'Design review', startAt: t, endAt: t + HOUR });
  await hub.zoho.runNow(pid(priya));
  const copy = mock.eventsOf('priya@x.example')[0];
  // edited in Zoho, seen on the next read: put back
  mock.editInZoho(copy.uid, { title: 'Design review (moved by me in Zoho)' });
  await priya.request('zoho.syncNow');
  assert.equal(mock.events.get(copy.uid)!.title, 'Design review');
  assert.match(lastDm(hub, pid(priya)), /was changed or removed in Zoho Calendar/);
  // edited in Zoho and in Dexterity before a read: the stale etag is refused, Dexterity still wins
  mock.editInZoho(copy.uid, { title: 'Zoho title' });
  await priya.request('cal.update', { eventId: ev.id, title: 'Design review, rev B' });
  await hub.zoho.runNow(pid(priya));
  assert.equal(mock.events.get(copy.uid)!.title, 'Design review, rev B');
  assert.ok(mock.log.some((l) => l.method === 'PUT' && l.status === 400), 'one stale-etag refusal');
  // deleted in Zoho: made again
  mock.deleteInZoho(copy.uid);
  await priya.request('zoho.syncNow');
  const now = mock.eventsOf('priya@x.example');
  assert.equal(now.length, 1);
  assert.equal(now[0].title, 'Design review, rev B');
  assert.ok((await priya.request('zoho.status')).restored >= 2);
});

test('tokens: an expired access token is refreshed; a revoked one asks to reconnect, once, and reconnecting duplicates nothing', async () => {
  const { hub, owner, priya, mock } = await zohoOffice();
  await setUp(owner, mock);
  mock.addUser('priya@x.example');
  await connect(priya, mock, 'priya@x.example');
  const t = Date.now() + DAY;
  await priya.request('cal.create', { title: 'Weekly sync', startAt: t, endAt: t + HOUR });
  await hub.zoho.runNow(pid(priya));
  assert.equal(mock.refreshes, 0, 'the first token is kept while it lasts');
  mock.expireAccess();
  await priya.request('cal.create', { title: 'Second', startAt: t + 2 * HOUR, endAt: t + 3 * HOUR });
  await hub.zoho.runNow(pid(priya));
  assert.equal(mock.refreshes, 1);
  assert.equal(mock.eventsOf('priya@x.example').length, 2);

  mock.revokeAll('priya@x.example');
  mock.expireAccess();
  await priya.request('cal.create', { title: 'Third', startAt: t + 4 * HOUR, endAt: t + 5 * HOUR });
  await hub.zoho.runNow(pid(priya));
  const st = await priya.request('zoho.status');
  assert.equal(st.state, 'reconnect');
  assert.match(st.lastError ?? '', /Reconnect/);
  assert.match(lastDm(hub, pid(priya)), /Reconnect Zoho Calendar/);
  const told = (hub.store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE author_id = ? AND body LIKE ?').get(hub.system.id, '%stopped syncing%') as { n: number }).n;
  await hub.zoho.runNow(pid(priya));
  hub.zoho.tick();
  assert.equal((hub.store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE author_id = ? AND body LIKE ?').get(hub.system.id, '%stopped syncing%') as { n: number }).n, told, 'told once');
  assert.equal((await owner.request('admin.zoho.get')).people[0].state, 'reconnect');

  const again = await connect(priya, mock, 'priya@x.example');
  assert.equal(again.state, 'connected');
  await hub.zoho.runNow(pid(priya));
  const titles = mock.eventsOf('priya@x.example').map((e) => e.title).sort();
  assert.deepEqual(titles, ['Second', 'Third', 'Weekly sync'], 'reconnecting copies what was missed, nothing twice');
});

test('a busy Zoho is retried with growing waits; the error is shown and cleared', async () => {
  const { hub, owner, priya, mock } = await zohoOffice();
  await setUp(owner, mock);
  mock.addUser('priya@x.example');
  await connect(priya, mock, 'priya@x.example');
  const t = Date.now() + DAY;
  await priya.request('cal.create', { title: 'Retry me', startAt: t, endAt: t + HOUR });
  mock.failNext(503, 429);
  await hub.zoho.runNow(pid(priya));
  assert.equal(mock.eventsOf('priya@x.example').length, 1, 'two busy answers, then through');
  assert.equal((await priya.request('zoho.status')).lastError, null);
  await priya.request('cal.create', { title: 'Down for a while', startAt: t + 2 * HOUR, endAt: t + 3 * HOUR });
  mock.failNext(503, 503, 503); // the first try and both retries
  await hub.zoho.runNow(pid(priya));
  const st = await priya.request('zoho.status');
  assert.match(st.lastError ?? '', /busy or could not be reached/);
  const row = hub.store.db.prepare('SELECT fails, next_try_at FROM zoho_accounts').get() as { fails: number; next_try_at: number };
  assert.equal(row.fails, 1);
  assert.ok(row.next_try_at > Date.now() + 30_000, 'waits before trying again');
  await hub.zoho.runNow(pid(priya));
  assert.equal(mock.eventsOf('priya@x.example').length, 2);
  assert.equal((await priya.request('zoho.status')).lastError, null);
});

test('the map survives a hub restart: nothing is copied twice; changing calendar moves the copies; disconnecting removes and revokes', async () => {
  const { hub, owner, priya, mock, dir, zoho } = await zohoOffice();
  await setUp(owner, mock);
  mock.addUser('priya@x.example');
  await connect(priya, mock, 'priya@x.example');
  const t = Date.now() + DAY;
  await priya.request('cal.create', { title: 'Before restart', startAt: t, endAt: t + HOUR });
  await hub.zoho.runNow(pid(priya));
  const userId = pid(priya);
  priya.disconnect();
  await hub.stop();
  hub.stop = async () => {};
  const hub2 = new Hub({ dataDir: dir, port: 0, host: '127.0.0.1', discoveryPort: false, updates: false, zoho });
  await hub2.start();
  cleanups.push(() => hub2.stop());
  hub2.store.db.prepare('UPDATE zoho_accounts SET due = 1, last_pull_at = NULL').run();
  await hub2.zoho.runNow(userId);
  assert.equal(mock.eventsOf('priya@x.example').length, 1, 'not made again after the restart');
  const status = hub2.zoho.status(userId);
  const work = status.calendars.find((c) => c.name === 'Work')!;
  const u = hub2.store.userById(userId)!;
  await hub2.zoho.handle('zoho.calendar.set', u, { calendarUid: work.uid });
  await hub2.zoho.runNow(userId);
  assert.equal(mock.eventsOf('priya@x.example', `cal-priya@x.example==`).length, 0);
  assert.equal(mock.eventsOf('priya@x.example', work.uid).length, 1);
  await hub2.zoho.handle('zoho.disconnect', u, {});
  assert.equal(mock.eventsOf('priya@x.example').length, 0, 'future copies removed');
  assert.equal(mock.revokes, 1);
  assert.equal(hub2.zoho.status(userId).state, 'not-connected');
});
