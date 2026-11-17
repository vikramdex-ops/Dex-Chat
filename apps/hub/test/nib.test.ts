import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Message, NibCard, NibMe } from '@dex/core';
import { office, me, nextClientId, nextEvent } from './office.ts';
import { localDate } from '../src/work.ts';

/** Today at a time, in the hub's local time (Nib's clock is moved to these). */
const today = localDate(Date.now());
const at = (h: number, m = 0, date = today) => { const [y, mo, d] = date.split('-').map(Number); return new Date(y, mo - 1, d, h, m).getTime(); };
const tomorrow = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return localDate(d.getTime()); })();

async function setup() {
  const o = await office();
  const meera = await approveAs(o, 'meera');
  const anil = await approveAs(o, 'anil');
  const { hub, owner, priya, ravi } = o;
  // every day is a workday here, so the test does not depend on the day it runs
  await owner.request('admin.nib.set', {
    givers: [{ userId: me(meera), kind: 'discipline', scope: 'Piping' }, { userId: me(ravi), kind: 'area', scope: 'Area 4' }],
    managers: [me(owner)], workdays: [0, 1, 2, 3, 4, 5, 6], projects: [{ code: 'P-12', name: 'Refinery revamp' }, { code: 'P-14', name: 'Tank farm' }],
    startPromptAt: '09:45', wrapAt: '18:00', digestAt: '19:00', followUpAt: '21:00', nudgeLimit: 3,
  });
  const clock = (h: number, m = 0) => { const t = at(h, m); hub.nib.setClock(t); hub.nib.tick(t); return t; };
  return { ...o, meera, anil, clock };
}
async function approveAs(o: Awaited<ReturnType<typeof office>>, name: string) {
  const { c, identity } = await o.join(name);
  await o.owner.request('admin.decide', { deviceId: identity.deviceId, approve: true });
  for (let i = 0; i < 50 && c.state.kind !== 'ready'; i++) await new Promise((r) => setTimeout(r, 40));
  return c;
}
/** Nib's cards in someone's conversation with Nib. */
async function nibCards(c: Awaited<ReturnType<typeof office>>['priya']): Promise<Message[]> {
  const m = await c.request('nib.me');
  if (!m.convId) return [];
  return (await c.request('msg.list', { convId: m.convId })).messages.filter((x) => x.nib);
}

test('a day: start, capture, wrap-up; the lead gets one live card; the management one register', async () => {
  const { hub, owner, priya, ravi, meera, anil, clock } = await setup();
  clock(9, 10);
  const m0 = await priya.request('nib.me');
  assert.equal(m0.workday, true);
  assert.equal(m0.givers.length, 2);
  assert.ok(m0.convId, 'everyone has a conversation with Nib');
  // the start card: Meera gave work, with a first item
  let m: NibMe = await priya.request('nib.start', { givers: [me(meera)], items: [{ giverId: me(meera), project: 'P-12', activity: 'Isometrics area 4', qty: { done: 0, total: 12, unit: 'isos' } }] });
  assert.equal(m.day.started, true);
  assert.deepEqual(m.day.givers, [me(meera)]);
  assert.equal(m.items.length, 1);
  // more work arrives: written to Nib in plain words, in the conversation with Nib
  await priya.request('msg.send', { convId: m.convId!, body: 'Ravi: check MTO for P-14, half day', clientId: nextClientId() });
  for (let i = 0; i < 40 && (await priya.request('nib.me')).items.length < 2; i++) await new Promise((r) => setTimeout(r, 25));
  m = await priya.request('nib.me');
  const mto = m.items.find((x) => x.project === 'P-14')!;
  assert.equal(mto.giverId, me(ravi));
  assert.equal(mto.activity, 'Check MTO');
  const reply = (await nibCards(priya)).find((x) => x.nib?.kind === 'reply')!;
  const rc = await priya.request('nib.card', { kind: 'reply', ref: reply.nib!.ref }) as Extract<NibCard, { kind: 'reply' }>;
  assert.equal(rc.itemId, mto.id);
  // progress, then the wrap-up
  const iso = m.items.find((x) => x.project === 'P-12')!;
  clock(17, 50);
  m = await priya.request('nib.wrap', { note: 'Area 4 routing nearly done', items: [{ id: iso.id, done: 9 }, { id: mto.id, status: 'done' }] });
  assert.equal(m.day.state, 'sent');
  // each lead: one card with only their work
  const meeraCard = (await nibCards(meera)).filter((x) => x.nib?.kind === 'lead');
  assert.equal(meeraCard.length, 1);
  const lead = await meera.request('nib.card', { kind: 'lead', ref: today }) as Extract<NibCard, { kind: 'lead' }>;
  assert.deepEqual(lead.lead.rows.map((r) => r.userId), [me(priya)]);
  assert.equal(lead.lead.rows[0].items.length, 1);
  assert.deepEqual(lead.lead.rows[0].items[0].qty, { done: 9, total: 12, unit: 'isos' });
  assert.equal(lead.lead.rows[0].note, 'Area 4 routing nearly done');
  // Anil names Meera too: Meera's card waits for him, and fills in place when he sends
  await anil.request('nib.start', { givers: [me(meera)] });
  assert.deepEqual((await meera.request('nib.card', { kind: 'lead', ref: today }) as Extract<NibCard, { kind: 'lead' }>).lead.waiting, [me(anil)]);
  // seen: Priya sees that Meera saw it
  await meera.request('nib.ack', { date: today, userId: me(priya) });
  assert.ok((await priya.request('nib.me')).seen[me(meera)]);
  // nobody reported for Ravi or Meera themselves; the register goes once, at 19:00, to the management
  clock(18, 59);
  assert.equal((await nibCards(owner)).filter((x) => x.nib?.kind === 'register').length, 0);
  clock(19, 0);
  clock(19, 5);
  const regs = (await nibCards(owner)).filter((x) => x.nib?.kind === 'register');
  assert.equal(regs.length, 1, 'one register a day');
  const reg = await owner.request('nib.card', { kind: 'register', ref: today }) as Extract<NibCard, { register: unknown }>;
  assert.equal(reg.register.headline.reported, 1);
  assert.ok(reg.register.missing.some((x) => x.userId === me(anil)));
  await assert.rejects(priya.request('nib.card', { kind: 'register', ref: today }), /not for you/);
  // Anil reports late: Meera's card marks it LATE in place, and one follow-up goes at 21:00
  clock(20, 10);
  const items = (await anil.request('nib.item.save', { giverId: me(meera), project: 'P-12', activity: 'Spool drawings', qty: { done: 4, total: 10, unit: 'drawings' } })).items;
  assert.equal(items.length, 1);
  await anil.request('nib.wrap', {});
  const late = await meera.request('nib.card', { kind: 'lead', ref: today }) as Extract<NibCard, { kind: 'lead' }>;
  assert.equal(late.lead.rows.find((r) => r.userId === me(anil))!.late, true);
  assert.equal((await nibCards(meera)).filter((x) => x.nib?.kind === 'lead').length, 1, 'still one card');
  clock(20, 59);
  assert.equal((await nibCards(owner)).filter((x) => x.nib?.kind === 'followup').length, 0);
  clock(21, 0);
  clock(21, 30);
  const follow = (await nibCards(owner)).filter((x) => x.nib?.kind === 'followup');
  assert.equal(follow.length, 1, 'exactly one follow-up');
  const fu = await owner.request('nib.card', { kind: 'followup', ref: today }) as Extract<NibCard, { register: unknown }>;
  assert.deepEqual(fu.register.late.map((x) => x.userId), [me(anil)]);
  hub.nib.setClock(null);
});

test('a day sheet changed by any path reaches every app the person has open', async () => {
  const { hub, priya, meera, join, owner, clock } = await setup();
  clock(10, 0);
  // Priya's second device (a laptop); her PC keeps its tray open
  const { c: laptop, identity } = await join('priya');
  await owner.request('admin.decide', { deviceId: identity.deviceId, approve: true });
  for (let i = 0; i < 50 && laptop.state.kind !== 'ready'; i++) await new Promise((r) => setTimeout(r, 40));
  // saved through the API from the laptop: the PC hears of it
  let heard = nextEvent<NibMe>(priya, 'nib.me', (m) => m.items.some((x) => x.activity === 'Spool drawings'));
  await laptop.request('nib.item.save', { giverId: me(meera), project: 'P-12', activity: 'Spool drawings', qty: { done: 2, total: 6, unit: 'drawings' } });
  const m = await heard;
  const id = m.items.find((x) => x.activity === 'Spool drawings')!.id;
  // and the laptop itself, for a change made on the hub's side (a flow, a cover taken)
  heard = nextEvent<NibMe>(laptop, 'nib.me', (x) => x.items.find((i) => i.id === id)?.qty?.done === 5);
  hub.nib.handle('nib.item.save', hub.store.userById(me(priya))!, { id, qty: { done: 5, total: 6, unit: 'drawings' } });
  await heard;
  // taken off, and the day sent
  heard = nextEvent<NibMe>(priya, 'nib.me', (x) => !x.items.some((i) => i.id === id));
  await laptop.request('nib.item.delete', { id });
  await heard;
  heard = nextEvent<NibMe>(priya, 'nib.me', (x) => x.day.state === 'nothing');
  await laptop.request('nib.day', { nothing: true });
  await heard;
  // reading changes nothing, so nobody is told
  let extra = false;
  const on = (n: string) => { if (n === 'nib.me') extra = true; };
  priya.on('event', on);
  await laptop.request('nib.me');
  await laptop.request('nib.card', { kind: 'ask', ref: today });
  await new Promise((r) => setTimeout(r, 150));
  priya.off('event', on);
  assert.equal(extra, false);
});

test('nudges: counted, stepped, quiet while busy, and the management sees how many', async () => {
  const { hub, owner, ravi, anil, clock } = await setup();
  await ravi.request('nib.me');
  await anil.request('nib.me');
  // Ravi is on Do not disturb all evening: Nib waits and does not count
  await ravi.request('me.update', { availability: 'dnd' });
  clock(9, 50);
  let a = await anil.request('nib.me');
  assert.deepEqual([a.nudge?.kind, a.nudge?.level], ['start', 2], 'the gentle start card');
  await anil.request('nib.start', { givers: [] });
  clock(18, 0);
  clock(18, 26);
  clock(18, 50);
  a = await anil.request('nib.me');
  assert.equal(a.day.asks.filter((x) => x.kind === 'wrap').length, 3);
  assert.equal(a.nudge?.level, 3);
  // the third ask is the one friendly message
  assert.equal((await nibCards(anil)).filter((x) => x.nib?.kind === 'ask').length, 1);
  clock(18, 55);
  assert.equal((await anil.request('nib.me')).day.asks.filter((x) => x.kind === 'wrap').length, 3, 'no more than the limit');
  const r = await ravi.request('nib.me');
  assert.equal(r.day.asks.filter((x) => x.kind === 'wrap').length, 0, 'not while on Do not disturb');
  clock(19, 1);
  const reg = await owner.request('nib.card', { kind: 'register', ref: today }) as Extract<NibCard, { register: unknown }>;
  const miss = new Map(reg.register.missing.map((x) => [x.userId, x]));
  assert.equal(miss.get(me(anil))?.asks, 4, 'the start card and three wrap-up asks');
  assert.equal(miss.get(me(ravi))?.busy, 'dnd');
  hub.nib.setClock(null);
});

test('the office’s times, 18:00 to 18:30: three asks fit, the register says so, one follow-up at 19:00', async () => {
  const { hub, owner, priya, ravi, anil, meera, clock } = await setup();
  await owner.request('admin.nib.set', { startPromptAt: '09:45', wrapAt: '18:00', digestAt: '18:30', followUpAt: '19:00', nudgeLimit: 3 });
  clock(9, 10);
  for (const c of [priya, ravi, anil, meera]) await c.request('nib.start', { givers: [] });
  // Meera would like to be asked at 18:20: that leaves no room for three asks, so 18:00 it is
  const own = await meera.request('nib.day', { wrapAt: '18:20' });
  assert.deepEqual([own.ownWrapAt, own.wrapAt], ['18:20', '18:00']);
  // Ravi is on Do not disturb until 18:16
  await ravi.request('me.update', { availability: 'dnd' });
  const asked = new Map<string, string[]>();
  for (let m = 0; m <= 30; m++) {
    if (m === 16) await ravi.request('me.update', { availability: 'available' });
    clock(18, m);
    for (const [name, c] of [['anil', anil], ['ravi', ravi], ['priya', priya]] as const) {
      const d = await c.request('nib.me');
      asked.set(name, d.day.asks.filter((a) => a.kind === 'wrap').map((a) => `${new Date(a.at).getMinutes()}:${a.level}`));
    }
    // Priya snoozes the card for 30 minutes: Nib comes back at the last ask before the register
    if (m === 11) {
      const p = await priya.request('nib.day', { snoozeMinutes: 30 });
      assert.equal(p.day.snoozeUntil, at(18, 22), 'a snooze never skips the register');
    }
  }
  assert.deepEqual(asked.get('anil'), ['0:1', '11:2', '22:3'], 'the drop, the card, the message');
  assert.deepEqual(asked.get('priya'), ['0:1', '11:2', '22:3'], 'the snooze moved the message to its time and did not count');
  // Ravi was busy through the drop: the first ask when he is free (18:16), then the message 11 minutes later
  assert.deepEqual(asked.get('ravi'), ['16:1', '27:3']);
  assert.equal((await nibCards(anil)).filter((x) => x.nib?.kind === 'ask').length, 1, 'one message');
  const reg = await owner.request('nib.card', { kind: 'register', ref: today }) as Extract<NibCard, { register: unknown }>;
  const miss = new Map(reg.register.missing.map((x) => [x.userId, x]));
  assert.equal(miss.get(me(anil))?.asks, 3, 'asked 3×');
  assert.equal(miss.get(me(priya))?.asks, 3);
  assert.equal(miss.get(me(ravi))?.asks, 2);
  assert.equal(miss.get(me(ravi))?.busy, 'dnd');
  // a late sheet, and exactly one follow-up at 19:00
  clock(18, 40);
  await anil.request('nib.item.save', { activity: 'Spool drawings', project: 'P-12' });
  await anil.request('nib.wrap', {});
  clock(18, 59);
  assert.equal((await nibCards(owner)).filter((x) => x.nib?.kind === 'followup').length, 0);
  clock(19, 0);
  clock(19, 30);
  assert.equal((await nibCards(owner)).filter((x) => x.nib?.kind === 'followup').length, 1);
  hub.nib.setClock(null);
});

test('a window too short for the asks: the setup check says how many fit', async () => {
  const { hub, owner } = await setup();
  const nibRows = async () => (await owner.request('admin.setup.report')).checks.filter((x) => x.id.startsWith('nib.'));
  await owner.request('admin.nib.set', { wrapAt: '18:00', digestAt: '18:30', nudgeLimit: 3 });
  assert.equal((await nibRows()).some((x) => x.id === 'nib.asks'), false, 'three fit between 18:00 and 18:30');
  await owner.request('admin.nib.set', { wrapAt: '18:15', digestAt: '18:30', nudgeLimit: 3 });
  const row = (await nibRows()).find((x) => x.id === 'nib.asks')!;
  assert.equal(row.state, 'info');
  assert.equal(row.detail, 'Between the wrap-up and the register there is room for 2 asks, at 18:15, 18:25; the office set 3 a day.');
  // nobody is pulled earlier than the office's own time
  assert.equal((await owner.request('nib.me')).wrapAt, '18:15');
  hub.nib.setClock(null);
});

test('who sees whose day sheet', async () => {
  const { hub, owner, priya, ravi, meera, clock } = await setup();
  clock(10, 0);
  await priya.request('nib.item.save', { giverId: me(meera), activity: 'GA check', project: 'P-12' });
  await priya.request('nib.item.save', { giverId: me(ravi), activity: 'Supports', project: 'P-14' });
  assert.equal((await priya.request('nib.sheet', { userId: me(priya), date: today })).items.length, 2);
  const m = await meera.request('nib.sheet', { userId: me(priya), date: today });
  assert.equal(m.access, 'given');
  assert.deepEqual(m.items.map((x) => x.activity), ['GA check']);
  assert.equal((await owner.request('nib.sheet', { userId: me(priya), date: today })).items.length, 2, 'the management sees all');
  await assert.rejects(meera.request('nib.sheet', { userId: me(ravi), date: today }), /private/);
  await assert.rejects(meera.request('nib.card', { kind: 'lead', ref: 'not-a-date' }), /not for you/);
  await assert.rejects(priya.request('admin.nib.set', { managers: [] }), /administrators/);
  hub.nib.setClock(null);
});

test('the leave note: away, calendar, leads, cover, reminders; no nudges; one grouped line', async () => {
  const { hub, owner, priya, ravi, meera, anil, clock } = await setup();
  clock(9, 0);
  await ravi.request('nib.item.save', { giverId: me(meera), activity: 'Routing area 4', project: 'P-12', qty: { done: 3, total: 10, unit: 'sheets' } });
  const due = at(15, 0);
  const rem = await ravi.request('remind.create', { text: 'Send GA to Priya', dueAt: due });
  const plan = await ravi.request('nib.leave.plan', { from: today, to: tomorrow });
  assert.ok(plan.leads.includes(me(meera)));
  assert.deepEqual(plan.reminders.map((x) => x.id), [rem.id]);
  const r = await ravi.request('nib.leave', { kind: 'annual', from: today, to: tomorrow, coverId: me(anil), leadIds: [me(meera), me(owner)], handover: 'Area 4 routing: sheets 4–10 left', note: 'At my sister’s wedding', reminders: 'move' });
  assert.ok(r.done.includes('away') && r.done.includes('calendar') && r.done.includes('cover'));
  assert.ok(r.done.includes('reminders:1'));
  const u = (await priya.request('directory.list')).users.find((x) => x.id === me(ravi))!;
  assert.ok(u.ooo && u.ooo.delegateId === me(anil));
  assert.match(u.statusText ?? '', /^On leave · back /);
  const moved = (await ravi.request('remind.list')).find((x) => x.id === rem.id)!;
  assert.ok(moved.dueAt > at(23, 0), 'moved to the day back');
  // Meera is told; Vikram (the management) is not, he sees it in the register
  assert.equal((await nibCards(meera)).filter((x) => x.nib?.kind === 'leave').length, 1);
  assert.equal((await nibCards(owner)).filter((x) => x.nib?.kind === 'leave').length, 0);
  // the cover gets the handover with Ravi's open items, and can take one
  const cover = await anil.request('nib.card', { kind: 'cover', ref: r.leave.id }) as Extract<NibCard, { kind: 'cover' }>;
  assert.equal(cover.items[0].activity, 'Routing area 4');
  assert.equal(cover.leave.handover, 'Area 4 routing: sheets 4–10 left');
  await anil.request('nib.cover.take', { leaveId: r.leave.id, itemId: cover.items[0].id });
  assert.equal((await anil.request('nib.me')).items[0].coverFor, me(ravi));
  await assert.rejects(priya.request('nib.card', { kind: 'cover', ref: r.leave.id }), /not for you/);
  // writing to Ravi answers with the away notice naming the cover
  const dm = await priya.request('conv.create', { kind: 'direct', members: [me(ravi)] });
  await priya.request('msg.send', { convId: dm.id, body: 'Is the GA ready?', clientId: nextClientId() });
  const notice = (await priya.request('msg.list', { convId: dm.id })).messages.find((x) => x.system?.kind === 'away');
  assert.ok(notice && notice.system!.users.includes(me(anil)));
  // no nudges on leave; one grouped line
  clock(18, 30);
  clock(18, 55);
  assert.equal((await ravi.request('nib.me')).nudge, null);
  clock(19, 0);
  const reg = await owner.request('nib.card', { kind: 'register', ref: today }) as Extract<NibCard, { register: unknown }>;
  assert.deepEqual(reg.register.leave.map((x) => x.userId), [me(ravi)]);
  // back the day after: the welcome back, once
  const back = (() => { const d = new Date(); d.setDate(d.getDate() + 2); return d; })();
  back.setHours(9, 30, 0, 0);
  hub.nib.setClock(back.getTime());
  hub.nib.tick(back.getTime());
  const w = await ravi.request('nib.me');
  assert.equal(w.welcome?.leave.id, r.leave.id);
  assert.equal(w.welcome?.coverItems.length, 1);
  assert.equal((await ravi.request('nib.welcome.seen')).welcome, null);
  hub.nib.setClock(null);
});

test('the bot maker’s Leave note template marks people away through Nib', async () => {
  const { BOT_TEMPLATES } = await import('@dex/core/botmaker');
  const t = BOT_TEMPLATES.find((x) => x.id === 'leave-note')!;
  assert.ok(t.definition.finish.some((a) => a.do === 'away'));
  const { validateFlow } = await import('@dex/core/botflows');
  assert.doesNotThrow(() => validateFlow(t.definition));
  assert.throws(() => validateFlow({ ...t.definition, finish: [{ do: 'away', from: 'note' }] }), /date/);
});
