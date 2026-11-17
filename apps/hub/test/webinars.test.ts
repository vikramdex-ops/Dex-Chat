// Webinars (M3): planning one, registration from the gateway's page (approval, the honeypot, the
// cap, personal links), invitations as text and .ics, the practice session and going live,
// attendees who watch and can never publish, the stage's routes (the relay on the office network,
// straight from the broadcaster for browsers), Q&A with votes, polls, handouts, raised hands,
// invited speakers from the app and from a browser, the follow-up and its survey, and the report.
// The gateway is replaced by a recorder of the frames the hub would send it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AudienceMember, MeetingReport, Registrant, StageRoute, WebinarDown, WebinarInfo, WebinarLive, WebinarMail, WebinarPoll, WebinarPublic, WebinarQuestion, WebinarUpdate } from '@dex/core';
import { reportCsv } from '@dex/core/meet-csv';
import type { HubClient } from '@dex/core/client';
import type { Hub } from '../src/hub.ts';
import { office, me, nextEvent } from './office.ts';

const GW = 'https://dexconnect-gateway.example.workers.dev';
const dev = (c: HubClient) => c.session!.deviceId;

/** A fake gateway: frames to each guest, and how their connection was closed. */
function fakeGateway(hub: Hub) {
  const frames = new Map<number, Array<WebinarDown | { t: string; [k: string]: unknown }>>();
  const closed = new Map<number, { code: number; reason: string }>();
  hub.gateway.sendGuest = (gid: number, f: unknown) => { (frames.get(gid) ?? frames.set(gid, []).get(gid)!).push(f as WebinarDown); };
  // the hub keeps trying to reach the example gateway; for these tests its guests stay connected
  hub.meetGuests.dropAll = () => {};
  hub.gateway.closeGuest = (gid: number, code: number, reason: string) => { closed.set(gid, { code, reason }); };
  let next = 500;
  const open = (meetingId: string, kind: 'w' | undefined, ip = '203.0.113.9') => {
    const gid = next++;
    hub.meetGuests.open(gid, ip, meetingId, kind);
    const send = (f: unknown) => hub.meetGuests.frame(gid, JSON.stringify(f));
    const wait = async (pred: (f: { t: string; [k: string]: unknown }) => boolean, what: string, ms = 4000): Promise<{ t: string; [k: string]: unknown }> => {
      const end = Date.now() + ms;
      for (;;) {
        const list = (frames.get(gid) ?? []) as Array<{ t: string; [k: string]: unknown }>;
        const hit = list.find(pred);
        if (hit) { frames.set(gid, list.filter((f) => f !== hit) as WebinarDown[]); return hit; }
        if (Date.now() > end) throw new Error(`no ${what} (have ${list.map((f) => (f.t === 'w' ? `w:${f.name}` : f.t)).join(', ')})`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    const event = async <T>(name: string, pred: (d: T) => boolean = () => true) => (await wait((f) => f.t === 'w' && f.name === name && pred(f.data as T), name)).data as T;
    const isClosed = async (ms = 4000) => {
      const end = Date.now() + ms;
      while (!closed.has(gid)) { if (Date.now() > end) throw new Error('not closed'); await new Promise((r) => setTimeout(r, 20)); }
      return closed.get(gid)!;
    };
    return { gid, send, wait, event, isClosed };
  };
  return { open };
}

const web = (hub: Hub, op: string, id: string, body: Record<string, unknown> = {}, ip = '203.0.113.9') => hub.webinars.webRequest(op, id, ip, body);

async function plan(priya: HubClient, ravi: HubClient, extra: Record<string, unknown> = {}) {
  return priya.request('web.create', {
    title: 'Pump skid design review', description: 'How we size the skid, and your questions.', startsAt: Date.now() + 3600_000, durationMin: 60,
    panelists: [me(ravi)], fields: [{ label: 'Company', kind: 'text', required: true }, { label: 'Your role', kind: 'choice', options: ['Engineer', 'Manager', 'Other'], required: false }],
    ...extra,
  } as never) as Promise<WebinarInfo>;
}

test('planning a webinar: roles, the panelists\' backstage Space, who sees it listed', async () => {
  const { owner, priya, ravi } = await office();
  await assert.rejects(priya.request('web.create', { title: '', startsAt: Date.now() + 1000, durationMin: 60 } as never), /title/);
  await assert.rejects(priya.request('web.create', { title: 'X', startsAt: Date.now() + 1000, durationMin: 5 } as never), /15 minutes/);
  await assert.rejects(priya.request('web.create', { title: 'X', startsAt: Date.now() + 1000, durationMin: 60, fields: [{ label: 'Pick', kind: 'choice', options: ['one'] }] } as never), /two choices/);
  const w = await plan(priya, ravi);
  assert.equal(w.role, 'organizer');
  assert.deepEqual(w.panelists, [me(ravi)]);
  assert.equal(w.state, 'scheduled');
  assert.deepEqual(w.fields.map((f) => [f.id, f.kind, f.required]), [['q1', 'text', true], ['q2', 'choice', false]]);
  assert.equal(w.registerUrl, null, 'no gateway yet');
  assert.match(w.problem!, /gateway/);
  // the panelist sees it; an office colleague does not, until it is listed
  assert.equal((await ravi.request('web.get', { id: w.meetingId })).role, 'panelist');
  await assert.rejects(owner.request('web.get', { id: w.meetingId }), /organiser and panelists/);
  assert.equal((await owner.request('web.list')).length, 0);
  await priya.request('web.update', { id: w.meetingId, settings: { listed: true } });
  const cards = await owner.request('web.list');
  assert.equal(cards[0].role, 'attendee');
  assert.equal(cards[0].title, 'Pump skid design review');
  // the backstage Space holds the organiser and panelists only
  const conv = (await priya.request('conv.list') as Array<{ id: string; members: string[] }>).find((c) => c.id === w.convId)!;
  assert.deepEqual(conv.members.sort(), [me(priya), me(ravi)].sort());
  // only the organiser changes it
  await assert.rejects(ravi.request('web.update', { id: w.meetingId, title: 'Mine now' }), /Only the organiser/);
});

test('registration from the gateway: auto and manual approval, honeypot, cap, duplicates, personal links and invitations', async () => {
  const { hub, owner, priya, ravi } = await office();
  await owner.request('admin.remote.set', { url: GW, enabled: true });
  const w = await plan(priya, ravi, { settings: { cap: 2 } });
  assert.equal((await priya.request('web.get', { id: w.meetingId })).registerUrl, `${GW}/w/${w.meetingId}`);
  const info = web(hub, 'info', w.meetingId);
  assert.equal(info.status, 200);
  const pub = info.body as WebinarPublic;
  assert.equal(pub.title, 'Pump skid design review');
  assert.equal(pub.organizer, 'Priya');
  assert.equal(pub.open, true);
  assert.ok(!JSON.stringify(pub).includes(me(priya)), 'no office ids on the public page');
  assert.equal(web(hub, 'info', '123456789').status, 404);

  // validation
  assert.match((web(hub, 'register', w.meetingId, { name: 'Dana', email: 'not-an-email', answers: { q1: 'Acme' } }).body as { error: string }).error, /email/);
  assert.match((web(hub, 'register', w.meetingId, { name: 'Dana', email: 'dana@acme.example', answers: {} }).body as { error: string }).error, /Company/);
  assert.match((web(hub, 'register', w.meetingId, { name: 'Dana', email: 'dana@acme.example', answers: { q1: 'Acme', q2: 'Wizard' } }).body as { error: string }).error, /Choose one/);
  // a bot filling the hidden field is told nothing useful and nothing is kept
  const bot = web(hub, 'register', w.meetingId, { name: 'Bot', email: 'bot@spam.example', answers: { q1: 'x' }, website: 'http://spam.example' });
  assert.equal(bot.status, 200);
  assert.equal((await priya.request('web.registrants', { id: w.meetingId })).length, 0);

  // auto approval: a personal link at once
  const newReg = nextEvent<{ registrant: Registrant }>(priya, 'web.registered');
  const ok = web(hub, 'register', w.meetingId, { name: 'Dana Wright', email: 'Dana@Acme.example', answers: { q1: 'Acme Pumps', q2: 'Engineer' } });
  assert.equal(ok.status, 200);
  const dana = ok.body as { status: string; token: string };
  assert.equal(dana.status, 'approved');
  assert.match(dana.token, /^[A-Za-z0-9_-]{22}$/);
  assert.equal((await newReg).registrant.name, 'Dana Wright');
  const dup = web(hub, 'register', w.meetingId, { name: 'Dana again', email: 'dana@acme.example', answers: { q1: 'Acme' } });
  assert.equal(dup.status, 409);
  assert.ok(!JSON.stringify(dup.body).includes(dana.token), 'a duplicate never learns the link');

  // manual approval
  await priya.request('web.update', { id: w.meetingId, settings: { approval: 'manual' } });
  const kim = web(hub, 'register', w.meetingId, { name: 'Kim Lee', email: 'kim@river.example', answers: { q1: 'River Co' } }).body as { status: string; token: string };
  assert.equal(kim.status, 'pending');
  // the cap (2) is reached
  const full = web(hub, 'register', w.meetingId, { name: 'Late Comer', email: 'late@x.example', answers: { q1: 'X' } });
  assert.equal(full.status, 403);
  assert.match((full.body as { error: string }).error, /full/);
  assert.equal((web(hub, 'info', w.meetingId).body as WebinarPublic).open, false);

  let regs = await priya.request('web.registrants', { id: w.meetingId });
  assert.deepEqual(regs.map((r) => [r.name, r.status]), [['Dana Wright', 'approved'], ['Kim Lee', 'pending']]);
  assert.equal(regs[0].email, 'dana@acme.example');
  assert.equal(regs[0].joinUrl, `${GW}/w/${w.meetingId}/watch#${dana.token}`);
  assert.deepEqual(regs[0].answers, { q1: 'Acme Pumps', q2: 'Engineer' });
  await assert.rejects(ravi.request('web.registrants', { id: w.meetingId }), /Only the organiser/);
  regs = await priya.request('web.decide', { id: w.meetingId, registrantIds: [regs[1].id], approve: true });
  assert.equal(regs[1].status, 'approved');

  // invitations: text and an .ics with each person's own link (no mail server: the organiser sends them)
  const mails = await priya.request('web.mail', { id: w.meetingId, kind: 'invite', when: 'Tuesday 18 November, 3:00 to 4:00 PM' }) as WebinarMail[];
  assert.equal(mails.length, 2);
  assert.match(mails[0].text, /Dear Dana/);
  assert.ok(mails[0].text.includes(`${GW}/w/${w.meetingId}/watch#${dana.token}`));
  assert.ok(mails[1].text.includes(`#${kim.token}`) && !mails[1].text.includes(dana.token));
  assert.match(mails[0].ics!, /BEGIN:VCALENDAR\r\n/);
  assert.match(mails[0].ics!, /UID:webinar-\d{9}@dexconnect/);
  assert.match(mails[0].ics!.replace(/\r\n /g, ''), new RegExp(`URL:${GW.replace(/\./g, '\\.')}/w/${w.meetingId}/watch#`));
  const reminder = await priya.request('web.mail', { id: w.meetingId, kind: 'reminder', registrantIds: [regs[0].id], when: 'Tuesday 18 November, 3:00 PM' });
  assert.equal(reminder.length, 1);
  assert.match(reminder[0].subject, /^Reminder/);
  assert.match(reminder[0].ics!, /SEQUENCE:1/);
  const audit = await owner.request('admin.audit', { limit: 50 }) as Array<{ action: string }>;
  for (const a of ['webinar.created', 'webinar.registered', 'webinar.registrantsApproved']) assert.ok(audit.some((x) => x.action === a), a);
});

test('practice, go live, attendees who only watch, the stage\'s routes, Q&A, polls, hands and handouts', async () => {
  const { hub, owner, priya, ravi } = await office();
  await owner.request('admin.remote.set', { url: GW, enabled: true });
  const gw = fakeGateway(hub);
  const w = await plan(priya, ravi, { settings: { listed: true } });
  const id = w.meetingId;
  const dana = (web(hub, 'register', id, { name: 'Dana Wright', email: 'dana@acme.example', answers: { q1: 'Acme' } }).body as { token: string }).token;

  // an attendee waits before the webinar starts: the "starting soon" sheet
  const early = await owner.request('web.watch', { id });
  assert.equal(early.live.state, 'scheduled');
  assert.equal(early.route, 'none');
  // attendees never enter the stage's Room, and never publish
  await assert.rejects(owner.request('meet.join', { id }), /watch this webinar as an attendee/);
  await assert.rejects(owner.request('room.start', { convId: w.convId!, video: true }), /not found/);

  // the practice session: the organiser and the panelist on the stage
  const practice = nextEvent<WebinarUpdate>(owner, 'web.update', (u) => u.live?.state === 'practice');
  const room = (await priya.request('meet.join', { id })).room!;
  assert.equal(room.mode, 'mesh');
  assert.equal(room.meetingKind, 'webinar');
  await practice;
  assert.ok((await ravi.request('meet.join', { id })).room);
  assert.equal(hub.webinars.snapshot(id).broadcaster, dev(priya), 'the organiser\'s PC composes the stage');
  await assert.rejects(ravi.request('web.state', { id, state: 'live' }), /Only the organiser/);

  // a browser attendee with a bad link is closed with the code the gateway counts
  const bad = gw.open(id, 'w');
  bad.send({ t: 'watch', token: 'A'.repeat(22) });
  assert.equal((await bad.isClosed()).code, 4403);
  // with their personal link: in, still waiting for go-live
  const g = gw.open(id, 'w', '198.51.100.30');
  g.send({ t: 'ask', text: 'too early' });
  assert.match(String((await g.wait((f) => f.t === 'error', 'error')).message), /link first/);
  g.send({ t: 'watch', token: dana });
  const watching = await g.wait((f) => f.t === 'webinar', 'webinar') as Extract<WebinarDown, { t: 'webinar' }>;
  assert.equal(watching.self.name, 'Dana Wright');
  assert.equal(watching.live.state, 'practice');
  assert.equal(watching.route, 'none');
  assert.ok(!JSON.stringify(watching).includes(me(priya)), 'no office ids for a browser attendee');

  // go live: the office attendee gets the relay, the browser the broadcaster directly
  const routed = nextEvent<{ route: StageRoute }>(owner, 'web.route');
  const viewers = nextEvent<{ viewers: Array<{ deviceId: string; name: string }>; relay: boolean; live: boolean }>(priya, 'web.viewers', (v) => v.live);
  const live = await priya.request('web.state', { id, state: 'live' });
  assert.equal(live.state, 'live');
  assert.equal((await routed).route, 'relay');
  const v = await viewers;
  assert.equal(v.relay, true);
  assert.deepEqual(v.viewers.map((x) => x.name), ['Dana Wright']);
  assert.equal((await g.event<{ route: StageRoute }>('web.route')).route, 'direct');
  // the stage's relay room: the broadcaster sends to it, an attendee only takes from it
  const stage = hub.webinars.stageRoom(dev(owner), id)!;
  assert.equal(stage.id, `stage:${room.id}`);
  await assert.rejects(owner.request('relay.produce', { stage: id, transportId: 'x', kind: 'video', rtpParameters: {}, source: 'camera' } as never), /Only the PC composing the stage/);
  assert.equal(hub.webinars.stageRoom(dev(ravi), id), null, 'a panelist is on the stage, not in its relay room');
  // signalling between the broadcaster and a direct viewer, both ways, and nobody else
  const guestDev = v.viewers[0].deviceId;
  await priya.request('web.signal', { id, toDevice: guestDev, data: { description: { type: 'offer', sdp: 'v=0' } } });
  assert.equal((await g.event<{ fromDevice: string }>('web.signal')).fromDevice, dev(priya));
  const back = nextEvent<{ fromDevice: string }>(priya, 'web.signal');
  g.send({ t: 'signal', to: dev(priya), data: { description: { type: 'answer', sdp: 'v=0' } } });
  assert.equal((await back).fromDevice, guestDev);
  await assert.rejects(ravi.request('web.signal', { id, toDevice: guestDev, data: {} }), /Not connected/);

  // Q&A: attendees ask (anonymously when allowed), everyone votes, sorted by votes
  const q1 = await owner.request('web.ask', { id, text: 'What flow rate is the skid sized for?' });
  assert.equal(q1.author, 'Vikram');
  g.send({ t: 'ask', text: 'Can the skid be split for transport?', anonymous: true });
  const qs = nextEvent<WebinarUpdate>(priya, 'web.update', (u) => (u.questions ?? []).some((q) => q.anonymous));
  const anon = (await qs).questions!.find((q) => q.anonymous)!;
  assert.equal(anon.author, '', 'nobody sees an anonymous asker');
  g.send({ t: 'vote', questionId: anon.id, up: true });
  await owner.request('web.vote', { id, questionId: anon.id, up: true });
  await new Promise((r) => setTimeout(r, 100));
  let list = await priya.request('web.questions', { id });
  assert.deepEqual(list.map((q) => [q.text.slice(0, 12), q.votes]), [['Can the skid', 2], ['What flow ra', 0]]);
  assert.equal(list[0].voted, false);
  assert.equal((await owner.request('web.questions', { id }))[0].voted, true);
  // panelists answer live or in writing; the organiser pins, shows on the stage, dismisses
  const live1 = await ravi.request('web.answer', { id, questionId: anon.id, live: true });
  assert.equal(live1.status, 'live');
  const written = await ravi.request('web.answer', { id, questionId: q1.id, text: '120 m³/h at 6 bar.' });
  assert.equal(written.answer!.text, '120 m³/h at 6 bar.');
  assert.equal(written.answer!.by, 'Ravi');
  await assert.rejects(owner.request('web.answer', { id, questionId: q1.id, text: 'me' }), /organiser and panelists/);
  await assert.rejects(ravi.request('web.moderate', { id, questionId: q1.id, action: 'pin' }), /Only the organiser/);
  await priya.request('web.moderate', { id, questionId: q1.id, action: 'pin' });
  const staged = nextEvent<WebinarUpdate>(owner, 'web.update', (u) => !!u.live?.onStage);
  await priya.request('web.moderate', { id, questionId: q1.id, action: 'stage' });
  assert.equal((await staged).live!.onStage!.id, q1.id);
  list = await owner.request('web.questions', { id });
  assert.equal(list[0].id, q1.id, 'pinned first');
  const gone = nextEvent<WebinarUpdate>(owner, 'web.update', (u) => (u.removed ?? []).includes(anon.id));
  await priya.request('web.moderate', { id, questionId: anon.id, action: 'dismiss' });
  await gone;
  assert.equal((await owner.request('web.questions', { id })).length, 1, 'attendees do not see dismissed questions');
  assert.equal((await priya.request('web.questions', { id })).length, 2, 'the organiser still does');
  // the organiser can turn anonymous questions off
  await priya.request('web.update', { id, settings: { anonymousQuestions: false } });
  await assert.rejects(owner.request('web.ask', { id, text: 'secret?', anonymous: true }), /asks for names/);

  // a poll with results shown only when the organiser closes it
  const poll = await priya.request('web.poll.launch', { id, question: 'Which skid size do you use most?', options: ['Small', 'Medium', 'Large'] }) as WebinarPoll;
  await assert.rejects(owner.request('web.poll.launch', { id, question: 'x', options: ['a', 'b'] }), /Only the organiser/);
  const mine = await owner.request('web.poll.vote', { id, pollId: poll.id, choices: [1] });
  assert.deepEqual(mine.mine, [1]);
  assert.equal(mine.results, null, 'attendees do not see results while hidden');
  await assert.rejects(owner.request('web.poll.vote', { id, pollId: poll.id, choices: [0, 1] }), /one answer/);
  g.send({ t: 'pollVote', pollId: poll.id, choices: [2] });
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual((await priya.request('web.polls', { id }))[0].results, [0, 1, 1]);
  const shown = nextEvent<WebinarUpdate>(owner, 'web.update', (u) => !!u.live?.poll && !u.live.poll.open);
  await priya.request('web.poll.close', { id, pollId: poll.id, showResults: true });
  assert.deepEqual((await shown).live!.poll!.results, [0, 1, 1]);

  // raised hands queue for the organiser; reactions reach the stage
  await owner.request('web.hand', { id, up: true });
  g.send({ t: 'hand', up: true });
  await new Promise((r) => setTimeout(r, 50));
  const aud = await priya.request('web.audience', { id }) as AudienceMember[];
  assert.deepEqual(aud.map((a) => [a.name, a.hand, a.route, a.web]), [['Vikram', 1, 'relay', false], ['Dana Wright', 2, 'direct', true]]);
  const reacted = nextEvent<WebinarUpdate>(priya, 'web.update', (u) => !!u.reactions);
  await owner.request('web.react', { id, emoji: '👏' });
  g.send({ t: 'react', emoji: '👏' });
  const r = (await reacted).reactions!;
  assert.ok(r['👏'] >= 1);

  // a handout: the organiser attaches a file; attendees download it in the app and in the browser
  const file = hub.files.storeBuffer(me(priya), 'skid-datasheet.pdf', 'application/pdf', Buffer.from('%PDF-1.4 skid datasheet '.repeat(20_000)));
  const handouts = await priya.request('web.handout.add', { id, fileId: file.id });
  assert.equal(handouts[0].name, 'skid-datasheet.pdf');
  await assert.rejects(owner.request('web.handout.add', { id, fileId: file.id }), /Only the organiser/);
  assert.equal(hub.files.canRead(me(owner), file.id), false, 'not before asking for it');
  const opened = await owner.request('web.handout.open', { id, handoutId: handouts[0].id });
  assert.equal(opened.fileId, file.id);
  assert.equal(hub.files.canRead(me(owner), file.id), true);
  g.send({ t: 'handout', id: handouts[0].id });
  const head = await g.wait((f) => f.t === 'file', 'file') as Extract<WebinarDown, { t: 'file' }>;
  const parts: Buffer[] = [];
  for (let i = 0; i < head.chunks; i++) parts.push(Buffer.from(String((await g.wait((f) => f.t === 'fileChunk' && f.i === i, `chunk ${i}`)).data), 'base64'));
  assert.equal(Buffer.concat(parts).length, file.size);
  assert.ok(head.chunks > 1, 'large handouts arrive in pieces');

  // a panelist cannot watch their own webinar
  await assert.rejects(ravi.request('web.watch', { id }), /on this webinar's stage/);

  // the organiser leaves the stage: the panelist's PC takes over composing it
  const takeover = nextEvent<{ viewers: Array<{ name: string }>; live: boolean }>(ravi, 'web.viewers', (x) => x.live);
  await priya.request('room.leave', { roomId: room.id });
  assert.deepEqual((await takeover).viewers.map((x) => x.name), ['Dana Wright']);
  assert.equal(hub.webinars.snapshot(id).broadcaster, dev(ravi));
  // the last one leaves: the webinar ends, and its viewers are told
  const ended = nextEvent<{ meetingId: string }>(owner, 'web.ended');
  await ravi.request('room.leave', { roomId: room.id });
  await ended;
  assert.equal((await g.event<{ meetingId: string }>('web.ended')).meetingId, id);
  assert.equal((await priya.request('web.get', { id })).state, 'ended');
});

test('invited to speak: from the app (consent, then on the stage) and from a browser (a one-time pass, no lobby), then back to the audience', async () => {
  const { hub, owner, priya, ravi } = await office();
  await owner.request('admin.remote.set', { url: GW, enabled: true });
  const gw = fakeGateway(hub);
  const w = await plan(priya, ravi);
  const id = w.meetingId;
  const token = (web(hub, 'register', id, { name: 'Dana Wright', email: 'dana@acme.example', answers: { q1: 'Acme' } }).body as { token: string }).token;
  const room = (await priya.request('meet.join', { id })).room!;
  await priya.request('web.state', { id, state: 'live' });
  await owner.request('web.watch', { id });
  const g = gw.open(id, 'w');
  g.send({ t: 'watch', token });
  await g.wait((f) => f.t === 'webinar', 'webinar');

  // an office attendee: invited, they accept, and only then come onto the stage
  await assert.rejects(owner.request('web.promoteAnswer', { id, accept: true }), /not invited/);
  const aud = await priya.request('web.audience', { id });
  const invite = nextEvent<{ by: string }>(owner, 'web.promote');
  await priya.request('web.promote', { id, deviceId: aud.find((a) => a.name === 'Vikram')!.deviceId });
  assert.equal((await invite).by, 'Priya');
  assert.equal((await priya.request('web.audience', { id })).find((a) => a.name === 'Vikram')!.invited, true);
  const yes = await owner.request('web.promoteAnswer', { id, accept: true });
  assert.equal(yes.meetingId, id);
  const onStage = await owner.request('meet.join', { id });
  assert.ok(onStage.room!.participants.some((p) => p.userId === me(owner)), 'on the stage without waiting');
  assert.equal((await priya.request('web.audience', { id })).some((a) => a.name === 'Vikram'), false, 'no longer in the audience');
  // the organiser brings them back: they are told, and are off the stage
  const demoted = nextEvent<{ meetingId: string }>(owner, 'web.demoted');
  await priya.request('web.demote', { id, userId: me(owner) });
  await demoted;
  assert.equal((await priya.request('room.list')).find((r) => r.id === room.id)!.participants.some((p) => p.userId === me(owner)), false);
  await assert.rejects(owner.request('meet.join', { id }), /attendee/, 'and cannot come back on their own');
  await assert.rejects(priya.request('web.demote', { id, userId: me(ravi) }), /invited from the audience/, 'panelists are not demoted');

  // a browser attendee: invited, accepts, and gets a one-time pass for the meeting page
  const gDev = (await priya.request('web.audience', { id })).find((a) => a.web)!.deviceId;
  await priya.request('web.promote', { id, deviceId: gDev });
  await g.event('web.promote');
  g.send({ t: 'speak', accept: true });
  const speak = await g.wait((f) => f.t === 'speak', 'speak') as Extract<WebinarDown, { t: 'speak' }>;
  const m = speak.url.match(/^\/(\d{3}-\d{3}-\d{3})#([A-Za-z0-9]{10})$/)!;
  assert.equal(m[1].replace(/-/g, ''), id);
  assert.equal((await g.isClosed()).code, 4000);
  // the meeting page joins with the pass: straight onto the stage, named as registered
  const knock = nextEvent<{ participants: Array<{ userId: string }> }>(priya, 'room.updated', (r) => r.participants.some((p) => p.userId.startsWith('guest:')));
  const s = gw.open(id, undefined);
  s.send({ t: 'join', name: 'Someone else', passcode: m[2] });
  const admitted = await s.wait((f) => f.t === 'admitted', 'admitted') as unknown as { self: { name: string } };
  assert.equal(admitted.self.name, 'Dana Wright');
  await knock;
  // the pass works once
  const again = gw.open(id, undefined);
  again.send({ t: 'join', name: 'Mallory', passcode: m[2] });
  assert.equal((await again.isClosed()).code, 4403);
  // back to the audience: the meeting page returns to the watch page
  const guestUser = (await priya.request('room.list')).find((r) => r.id === room.id)!.participants.find((p) => p.userId.startsWith('guest:'))!.userId;
  await priya.request('web.demote', { id, userId: guestUser });
  const to = await s.wait((f) => f.t === 'demoted', 'demoted');
  assert.equal(to.to, `/w/${id}/watch`);
  assert.equal((await s.isClosed()).code, 4000);
  const audit = await owner.request('admin.audit', { limit: 80 }) as Array<{ action: string }>;
  for (const a of ['webinar.live', 'webinar.invitedToSpeak', 'webinar.speaking', 'webinar.backToAudience', 'webinar.attendeeJoined']) assert.ok(audit.some((x) => x.action === a), a);
});

test('after the webinar: attended or no-show, the follow-up in the app and as email text, the survey, the report and its CSV', async () => {
  const { hub, owner, priya, ravi } = await office();
  await owner.request('admin.remote.set', { url: GW, enabled: true });
  const gw = fakeGateway(hub);
  const w = await plan(priya, ravi);
  const id = w.meetingId;
  const dana = (web(hub, 'register', id, { name: 'Dana Wright', email: 'dana@acme.example', answers: { q1: 'Acme' } }).body as { token: string }).token;
  const kim = (web(hub, 'register', id, { name: 'Kim Lee', email: 'kim@river.example', answers: { q1: 'River' } }).body as { token: string }).token;
  await assert.rejects(priya.request('web.followup', { id, note: 'x', when: '' }), /after the webinar has been live/);
  const room = (await priya.request('meet.join', { id })).room!;
  await priya.request('web.state', { id, state: 'live' });
  await owner.request('web.watch', { id });
  const g = gw.open(id, 'w');
  g.send({ t: 'watch', token: dana });
  await g.wait((f) => f.t === 'webinar', 'webinar');
  await owner.request('web.ask', { id, text: 'Will the slides be shared?' });
  const poll = await priya.request('web.poll.launch', { id, question: 'Useful?', options: ['Yes', 'No'] });
  await owner.request('web.poll.vote', { id, pollId: poll.id, choices: [0] });
  g.send({ t: 'pollVote', pollId: poll.id, choices: [1] });
  const file = hub.files.storeBuffer(me(priya), 'slides.pdf', 'application/pdf', Buffer.from('%PDF slides'));
  const [h] = await priya.request('web.handout.add', { id, fileId: file.id });
  await owner.request('web.handout.open', { id, handoutId: h.id });
  await new Promise((r) => setTimeout(r, 1100));
  // ending it from the stage ends the stage's Room too
  const ended = await priya.request('web.state', { id, state: 'ended' });
  assert.equal(ended.state, 'ended');
  assert.ok((await priya.request('web.polls', { id })).every((p) => !p.open), 'an open poll closes with the webinar');
  assert.equal((await priya.request('room.list')).some((r) => r.id === room.id), false);

  // attended or no-show
  const regs = await priya.request('web.registrants', { id });
  assert.deepEqual(regs.map((r) => [r.name, r.attended]), [['Dana Wright', true], ['Kim Lee', false]]);
  assert.ok(regs[0].minutes >= 1);

  // the follow-up: a message in the app for colleagues who watched, email text for people outside
  const fu = await priya.request('web.followup', {
    id, note: 'The datasheet is in the handouts.', outsideLink: 'https://videos.example.com/skid-review', when: 'Tuesday 18 November',
    survey: [{ label: 'How useful was it?', kind: 'choice', options: ['Very', 'Somewhat', 'Not really'], required: true }, { label: 'What should we cover next?', kind: 'text', required: false }],
  });
  assert.equal(fu.sentInApp, 1);
  const bot = hub.store.db.prepare(`SELECT m.body FROM messages m JOIN conv_members c ON c.conv_id = m.conv_id WHERE c.user_id = ? AND m.author_id = ? ORDER BY m.created_at DESC LIMIT 1`).get(me(owner), hub.system.id) as { body: string };
  assert.match(bot.body, /Thank you for attending Pump skid design review/);
  assert.ok(bot.body.includes(`dexconnect://webinar/${id}/survey`));
  assert.deepEqual(fu.mails.map((x) => x.name), ['Dana Wright', 'Kim Lee']);
  assert.match(fu.mails[0].text, /Thank you for attending/);
  assert.match(fu.mails[1].text, /We missed you/);
  assert.ok(fu.mails[0].text.includes('https://videos.example.com/skid-review'));
  assert.ok(fu.mails[0].text.includes(`${GW}/w/${id}/survey#${dana}`));
  assert.ok(fu.mails[1].text.includes(`#${kim}`));

  // the survey: in the app for a colleague, on the gateway's page for Dana
  const sv = await owner.request('web.survey', { id });
  assert.equal(sv.fields.length, 2);
  await assert.rejects(owner.request('web.survey.answer', { id, answers: {} }), /How useful/);
  await owner.request('web.survey.answer', { id, answers: { q1: 'Very', q2: 'Pipe supports' } });
  await assert.rejects(owner.request('web.survey.answer', { id, answers: { q1: 'Very' } }), /already/);
  assert.equal(web(hub, 'surveyInfo', id, { token: 'B'.repeat(22) }).status, 403);
  assert.equal((web(hub, 'surveyInfo', id, { token: dana }).body as { name: string }).name, 'Dana Wright');
  assert.equal(web(hub, 'survey', id, { token: dana, answers: { q1: 'Somewhat' } }).status, 200);
  assert.equal(web(hub, 'survey', id, { token: dana, answers: { q1: 'Somewhat' } }).status, 409);

  // the report: registrants, attendees, questions, polls with each answer, handout downloads, the survey
  const rep = await priya.request('web.report', { id });
  assert.equal(rep.registrants.length, 2);
  assert.deepEqual(rep.attendees.map((a) => [a.name, a.office]).sort(), [['Dana Wright', false], ['Vikram', true]]);
  assert.equal(rep.questions[0].text, 'Will the slides be shared?');
  assert.deepEqual(rep.polls[0].options.map((o) => o.votes), [1, 1]);
  assert.deepEqual(rep.polls[0].answers.map((a) => `${a.name}:${a.choices.join('')}`).sort(), ['Dana Wright:No', 'Vikram:Yes']);
  assert.deepEqual(rep.handouts[0].downloads.map((d) => d.name), ['Vikram']);
  assert.deepEqual(rep.survey.answers.map((a) => a.name).sort(), ['Dana Wright', 'Vikram']);
  // administrators may read it too
  assert.equal((await owner.request('web.report', { id })).registrants.length, 2);
  // the meeting's report carries the webinar part, and its CSV has the sections
  const mr = await priya.request('meet.report', { roomId: room.id }) as MeetingReport;
  assert.equal(mr.webinar?.registrants.length, 2);
  const csv = reportCsv(mr);
  for (const s of ['Registrant,Email,Status', 'Dana Wright,dana@acme.example,approved', 'no-show', 'Question,Asked by,Votes', 'Poll,Useful?', 'Handout,Downloads', 'Survey,Answered (UTC)']) assert.ok(csv.includes(s), s);
});

test('live streaming: the stream address and key are kept on the hub, only the organiser starts it, ffmpeg is found or the reason given', async () => {
  const { owner, priya, ravi } = await office();
  const w = await plan(priya, ravi);
  const id = w.meetingId;
  await assert.rejects(priya.request('web.stream.set', { id, url: 'http://example.com/live' }), /rtmp:\/\//);
  const set = await priya.request('web.stream.set', { id, url: 'rtmp://a.rtmp.example.com/live2', key: 'abcd-efgh-ijkl-mnop', watchUrl: 'https://www.example.com/watch?v=1' });
  assert.equal(set.stream.url, 'rtmp://a.rtmp.example.com/live2');
  assert.equal(set.stream.keyHint, '••••mnop');
  assert.ok(!JSON.stringify(set).includes('abcd-efgh'), 'the key never leaves the hub');
  await assert.rejects(ravi.request('web.stream.start', { id }), /Only the organiser/);
  await assert.rejects(priya.request('web.stream.start', { id }), /Open the stage first/);
  // only administrators choose where ffmpeg is
  await assert.rejects(priya.request('web.ffmpeg', { path: '/usr/bin/ffmpeg' }), /administrators/);
  const missing = await owner.request('web.ffmpeg', { path: '/nonexistent/ffmpeg' });
  assert.equal(missing.configured, '/nonexistent/ffmpeg');
  const found = await owner.request('web.ffmpeg');
  assert.equal(typeof found.found, 'boolean');
  // a chunk from anyone but the broadcaster is refused
  await assert.rejects(ravi.request('web.stream.chunk', { id, seq: 0, data: 'AAAA' }), /composing the stage/);
  // attendees see the watch page in the live view
  await priya.request('web.update', { id, settings: { listed: true } });
  const watch = await owner.request('web.watch', { id }) as { live: WebinarLive };
  assert.equal(watch.live.watchUrl, 'https://www.example.com/watch?v=1');
  const q: WebinarQuestion[] = await owner.request('web.questions', { id });
  assert.equal(q.length, 0);
});
