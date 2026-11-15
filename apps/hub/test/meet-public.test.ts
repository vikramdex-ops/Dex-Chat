// Dexterity Meet's public face on the hub: meeting names (unique, checked, released with a grace
// period), personal rooms named from the person, what a meeting's page learns before and after
// the passcode (and that it learns nothing else), one answer for unknown, ended, cancelled and
// wrong, the meeting's flood pause, guests refused for cancelled meetings, and the clean link in
// guest links, invitations and calendar feeds. The gateway is out of the picture: requests are
// the "w" frames it would pass (gateway tests in apps/gateway).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SLUG_GRACE_MS } from '@dex/core';
import type { CalEvent, GuestDown, GuestLinkView, MeetPageDetails, MeetPagePublic, MeetPublicView, MeetingInfo } from '@dex/core';
import type { Hub } from '../src/hub.ts';
import { office, me } from './office.ts';

const SITE = 'https://dexterity-meet.pages.dev';
const HOUR = 3600_000;

async function online(owner: Awaited<ReturnType<typeof office>>['owner']) {
  await owner.request('admin.remote.set', { url: 'https://dexconnect-gateway.example.workers.dev', enabled: true, siteUrl: SITE, orgName: 'Dexterity Design Services' });
}
/** What the gateway would get back for a page's request. */
const ask = (hub: Hub, op: string, ref: string, body: Record<string, unknown> = {}, ip = '203.0.113.9') => hub.meetPublic.request(op, ref, ip, body);

/** Every string in a JSON value, for leak checks. */
const strings = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...strings(x)]) : []);

test('meeting names: checked, unique, homograph-safe, and the site keeps its own words', async () => {
  const { owner, priya, ravi, hub } = await office();
  await online(owner);
  const a = await priya.request('meet.create', { title: 'Design review' }) as MeetingInfo;
  const b = await ravi.request('meet.create', { title: 'Another review' }) as MeetingInfo;
  let v = await priya.request('meet.public.set', { id: a.id, slug: '  P12 Design Review ' }) as MeetPublicView;
  assert.equal(v.slug, 'p12-design-review');
  assert.equal(v.url, `${SITE}/p12-design-review`);
  assert.equal(v.idUrl, `${SITE}/${a.id.slice(0, 3)}-${a.id.slice(3, 6)}-${a.id.slice(6)}`);
  // taken by another meeting
  await assert.rejects(ravi.request('meet.public.set', { id: b.id, slug: 'p12-design-review' }), /taken/);
  const check = await ravi.request('meet.slug.check', { slug: 'P12 design review', id: b.id });
  assert.deepEqual(check, { slug: 'p12-design-review', ok: false, problem: 'That name is taken. Try another.' });
  assert.equal((await ravi.request('meet.slug.check', { slug: 'p13-review', id: b.id })).ok, true);
  // the rules
  await assert.rejects(ravi.request('meet.public.set', { id: b.id, slug: 'admin' }), /kept for the site/);
  await assert.rejects(ravi.request('meet.public.set', { id: b.id, slug: 'vikrаm' }), /letters a to z/);
  await assert.rejects(ravi.request('meet.public.set', { id: b.id, slug: '482913207' }), /starts with a letter/);
  await assert.rejects(ravi.request('meet.public.set', { id: b.id, slug: 'ab' }), /at least 3/);
  // only hosts change a meeting's page
  await assert.rejects(ravi.request('meet.public.set', { id: a.id, slug: 'mine-now' }), /host/);
  // renaming releases the old name: it still leads to this meeting only, and only Priya can take it back
  v = await priya.request('meet.public.set', { id: a.id, slug: 'p12-review' });
  assert.equal(hub.meetPublic.resolve('p12-design-review')?.id, a.id);
  assert.equal(hub.meetPublic.resolve('p12-review')?.id, a.id);
  await assert.rejects(ravi.request('meet.public.set', { id: b.id, slug: 'p12-design-review' }), /used until recently/);
  const c = await priya.request('meet.create', { title: 'Third' }) as MeetingInfo;
  assert.equal((await priya.request('meet.public.set', { id: c.id, slug: 'p12-design-review' })).slug, 'p12-design-review', 'the same host reclaims it');
  assert.equal(hub.meetPublic.resolve('p12-design-review')?.id, c.id);
  // after the grace period the name is free for anyone, and stops leading anywhere once released
  await priya.request('meet.public.set', { id: c.id, slug: null });
  const later = Date.now() + SLUG_GRACE_MS + 1000;
  assert.equal(hub.meetPublic.resolve('p12-design-review', later), null);
  assert.equal(hub.meetPublic.availability('p12-design-review', b.id, me(ravi), later), null);
  assert.ok(hub.meetPublic.availability('p12-design-review', b.id, me(ravi), Date.now()));
  const audit = await owner.request('admin.audit', { limit: 50 }) as Array<{ action: string }>;
  assert.ok(audit.some((e) => e.action === 'meeting.nameSet'));
});

test('personal rooms are named from the person, and they can change it', async () => {
  const { owner, priya, hub, join } = await office();
  await online(owner);
  const room = await priya.request('meet.personal') as MeetingInfo;
  let v = await priya.request('meet.public.get', { id: room.id }) as MeetPublicView;
  assert.equal(v.slug, 'priya');
  assert.equal(v.url, `${SITE}/priya`);
  v = await priya.request('meet.personal.slug', { slug: 'priya-raman' });
  assert.equal(v.slug, 'priya-raman');
  assert.equal(hub.meetPublic.resolve('priya-raman')?.id, room.id);
  // a second Priya gets her full name (the first one's old name is still in its grace period)
  const { c: other, identity } = await join('priya2');
  await owner.request('admin.decide', { deviceId: identity.deviceId, approve: true });
  await new Promise((r) => setTimeout(r, 300));
  const r2 = await other.request('meet.personal') as MeetingInfo;
  const v2 = await other.request('meet.public.get', { id: r2.id }) as MeetPublicView;
  assert.ok(v2.slug && v2.slug !== 'priya' && v2.slug !== 'priya-raman', String(v2.slug));
});

test('before the passcode: only the date, the time and the office; the title and first name only when allowed', async () => {
  const { owner, priya, ravi, hub } = await office();
  await online(owner);
  await owner.request('admin.users.setProfile', { userId: me(priya), email: 'priya@dexteritydesign.co.in' }).catch(() => {});
  // an instant meeting: the title is hidden by default
  const inst = await priya.request('meet.create', { title: 'Leak at client X', invite: [me(ravi)] }) as MeetingInfo;
  await priya.request('meet.guestLink', { id: inst.id, enabled: true });
  await priya.request('meet.join', { id: inst.id });
  const i = ask(hub, 'page.info', inst.id);
  assert.equal(i.status, 200);
  const pub = i.body as MeetPagePublic;
  assert.equal(pub.found, true);
  assert.equal(pub.title, null);
  assert.equal(pub.host, null);
  assert.equal(pub.org, 'Dexterity Design Services');
  assert.equal(pub.state, 'live');
  assert.equal(typeof pub.liveSince, 'number');
  const text = JSON.stringify(i.body);
  for (const leak of ['Leak at client X', 'Priya', 'Ravi', 'priya@', me(priya), me(ravi), hub.info.id, 'workers.dev', '203.0.113', hub.fingerprint.slice(0, 11), 'passcode']) assert.ok(!text.includes(leak), `no ${leak} before the passcode`);
  assert.deepEqual(Object.keys(pub).sort(), ['endAt', 'found', 'host', 'id', 'kind', 'liveSince', 'opensAt', 'org', 'ref', 'repeats', 'startAt', 'state', 'title', 'zone']);
  // a Calendar meeting: shown by default (first name only), unless the host turns it off
  const t0 = Date.now() + 3 * HOUR;
  const ev = await priya.request('cal.create', { title: 'P-12 design review', startAt: t0, endAt: t0 + HOUR, online: true, attendees: [me(ravi)] }) as CalEvent;
  const m = await priya.request('meet.event', { eventId: ev.id }) as MeetingInfo;
  let v = await priya.request('meet.public.set', { id: m.id, slug: 'p12-design-review', enabled: true }) as MeetPublicView;
  assert.equal(v.showTitle, true);
  const s = ask(hub, 'page.info', 'p12-design-review').body as MeetPagePublic;
  assert.equal(s.title, 'P-12 design review');
  assert.equal(s.host, 'Priya');
  assert.equal(s.kind, 'scheduled');
  assert.equal(s.state, 'upcoming');
  assert.equal(s.startAt, t0);
  assert.equal(s.opensAt, t0 - 10 * 60_000);
  assert.ok(!JSON.stringify(s).includes('Ravi'), 'no attendees');
  v = await priya.request('meet.public.set', { id: m.id, showTitle: false });
  assert.equal(v.showTitle, false);
  const hidden = ask(hub, 'page.info', 'p12-design-review').body as MeetPagePublic;
  assert.equal(hidden.title, null);
  assert.equal(hidden.host, null);
  assert.ok(!JSON.stringify(hidden).includes('P-12') && !JSON.stringify(hidden).includes('Priya'));
  assert.equal(hidden.startAt, t0, 'the time is always shown');
});

test('one answer for unknown, ended, cancelled and switched-off meetings, and for wrong passcodes', async () => {
  const { owner, priya, hub } = await office();
  await online(owner);
  const t0 = Date.now() + 2 * HOUR;
  const mk = async (title: string, start = t0) => {
    const ev = await priya.request('cal.create', { title, startAt: start, endAt: start + HOUR, online: true }) as CalEvent;
    const m = await priya.request('meet.event', { eventId: ev.id }) as MeetingInfo;
    const v = await priya.request('meet.public.set', { id: m.id, enabled: true }) as MeetPublicView;
    return { ev, m, v };
  };
  const live = await mk('Kept');
  const ended = await mk('Was yesterday', Date.now() - 26 * HOUR);
  const cancelled = await mk('Called off');
  await priya.request('cal.cancel', { eventId: cancelled.ev.id });
  const off = await mk('Link off');
  await priya.request('meet.public.set', { id: off.m.id, enabled: false });
  const none = [ask(hub, 'page.info', 'no-such-meeting'), ask(hub, 'page.info', '999999999'), ask(hub, 'page.info', ended.m.id), ask(hub, 'page.info', cancelled.m.id), ask(hub, 'page.info', off.m.id), ask(hub, 'page.info', '../../etc')];
  for (const n of none) assert.deepEqual(n, { status: 404, body: { found: false } });
  assert.equal(ask(hub, 'page.info', live.m.id).status, 200);
  // wrong passcode, unknown name, link off: the same words
  const wrong = [
    ask(hub, 'page.check', live.m.id, { passcode: 'Wrong123' }),
    ask(hub, 'page.check', 'no-such-meeting', { passcode: live.v.passcode }),
    ask(hub, 'page.check', off.m.id, { passcode: off.v.passcode }),
    ask(hub, 'page.check', live.m.id, {}),
  ];
  for (const w of wrong) assert.deepEqual(w, wrong[0]);
  assert.equal(wrong[0].status, 403);
  // the right passcode: now the guest learns it was cancelled or has ended
  const c = ask(hub, 'page.check', cancelled.m.id, { passcode: cancelled.v.passcode });
  assert.equal(c.status, 200);
  assert.equal((c.body as MeetPageDetails).state, 'cancelled');
  assert.equal((ask(hub, 'page.check', ended.m.id, { passcode: ended.v.passcode }).body as MeetPageDetails).state, 'ended');
  const ok = ask(hub, 'page.check', live.m.id, { passcode: live.v.passcode }).body as MeetPageDetails;
  assert.equal(ok.title, 'Kept');
  assert.equal(ok.host, 'Priya');
  assert.equal(ok.state, 'upcoming');
  for (const leak of [me(priya), hub.info.id, 'priya@']) assert.ok(!JSON.stringify(ok).includes(leak));
});

test('a flood of wrong passcodes pauses that meeting\'s checks for a minute, and is audited', async () => {
  const { owner, priya, hub } = await office();
  await online(owner);
  const m = await priya.request('meet.create', { title: 'Busy' }) as MeetingInfo;
  const v = await priya.request('meet.public.set', { id: m.id, enabled: true }) as MeetPublicView;
  for (let i = 0; i < 50; i++) ask(hub, 'page.check', m.id, { passcode: `Bad${String(i).padStart(4, '0')}` }, `198.51.100.${i}`);
  const paused = ask(hub, 'page.check', m.id, { passcode: v.passcode });
  assert.equal(paused.status, 429);
  const audit = await owner.request('admin.audit', { limit: 50 }) as Array<{ action: string; target: string }>;
  assert.ok(audit.some((e) => e.action === 'meeting.passcodeFlood' && e.target === m.id));
});

test('repeating meetings show the next time; guests of a cancelled meeting are told after the passcode', async () => {
  const { owner, priya, hub } = await office();
  await online(owner);
  const t0 = Date.now() - 30 * 60_000;
  const ev = await priya.request('cal.create', { title: 'Piping weekly', startAt: t0, endAt: t0 + HOUR, online: true, recurrence: 'weekly' }) as CalEvent;
  const m = await priya.request('meet.event', { eventId: ev.id }) as MeetingInfo;
  const v = await priya.request('meet.public.set', { id: m.id, enabled: true, followUp: 'Minutes by Friday.' }) as MeetPublicView;
  const d = ask(hub, 'page.check', m.id, { passcode: v.passcode }).body as MeetPageDetails;
  assert.equal(d.state, 'open');
  assert.equal(d.startAt, t0);
  assert.equal(d.repeats, true);
  assert.equal(d.next?.startAt, t0 + 7 * 24 * HOUR);
  assert.equal(d.followUp, 'Minutes by Friday.');
  assert.equal((ask(hub, 'page.info', m.id).body as MeetPagePublic).found, true);
  assert.ok(!('followUp' in (ask(hub, 'page.info', m.id).body as object)), 'the follow-up only after the passcode');
  // a reschedule moves the page's time
  await priya.request('cal.update', { eventId: ev.id, startAt: t0 + 5 * HOUR, endAt: t0 + 6 * HOUR });
  assert.equal((ask(hub, 'page.info', m.id).body as MeetPagePublic).startAt, t0 + 5 * HOUR);
  // cancelled: the guest socket says so once the passcode is right
  await priya.request('cal.cancel', { eventId: ev.id });
  const frames: GuestDown[] = [];
  const closed: Array<{ code: number; reason: string }> = [];
  hub.gateway.sendGuest = (_g: number, f: unknown) => { frames.push(f as GuestDown); };
  hub.gateway.closeGuest = (_g: number, code: number, reason: string) => { closed.push({ code, reason }); };
  hub.meetGuests.dropAll = () => {};
  hub.meetGuests.open(7, '203.0.113.5', m.id);
  hub.meetGuests.frame(7, JSON.stringify({ t: 'join', name: 'Dana', passcode: v.passcode }));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(frames.find((f) => f.t === 'denied'), { t: 'denied', reason: 'This meeting was cancelled.' });
  assert.equal(closed[0].code, 4409);
});

test('the clean link everywhere: guest links, the page view, and calendar feeds without the passcode', async () => {
  const { owner, priya, hub } = await office();
  // the address is checked
  await assert.rejects(owner.request('admin.remote.set', { siteUrl: 'http://dexterity-meet.pages.dev' }), /https/);
  await assert.rejects(owner.request('admin.remote.set', { siteUrl: 'https://dexterity-meet.pages.dev/x' }), /no path/);
  await online(owner);
  const rv = await owner.request('admin.remote.get');
  assert.equal(rv.config.siteUrl, SITE);
  assert.equal(rv.config.orgName, 'Dexterity Design Services');
  const t0 = Date.now() + 4 * HOUR;
  const ev = await priya.request('cal.create', { title: 'Client call', startAt: t0, endAt: t0 + HOUR, online: true }) as CalEvent;
  const m = await priya.request('meet.event', { eventId: ev.id }) as MeetingInfo;
  await priya.request('meet.public.set', { id: m.id, slug: 'client-call', enabled: true });
  const g = await priya.request('meet.guestLink', { id: m.id }) as GuestLinkView;
  assert.equal(g.url, `${SITE}/client-call#${g.passcode}`);
  const feed = await priya.request('cal.feed.set', { enabled: true });
  const ics = hub.feeds.fetch(new URL(feed.urls!.office[0]).pathname.slice(5, -4), '127.0.0.1').body.replace(/\r\n /g, '');
  assert.match(ics, /\r\nURL:https:\/\/dexterity-meet\.pages\.dev\/client-call\r\n/);
  assert.match(ics, /\r\nLOCATION:https:\/\/dexterity-meet\.pages\.dev\/client-call\r\n/);
  assert.match(ics, /Meeting page: https:\/\/dexterity-meet\.pages\.dev\/client-call/);
  assert.ok(!ics.includes(g.passcode!), 'no passcode in a feed');
  // without a meeting site, the gateway's own address serves the pages
  await owner.request('admin.remote.set', { siteUrl: null });
  assert.equal((await priya.request('meet.public.get', { id: m.id })).url, 'https://dexconnect-gateway.example.workers.dev/client-call');
});
