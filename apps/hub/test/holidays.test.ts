// Holiday circulars on a real hub (docs/HOLIDAYS.md): an administrator drops the year's PDF into
// the conversation with Nib, Nib's card says what it read, registering it applies the days with
// their source and audits it, the same file again changes nothing, a revised circular shows its
// differences, next year's leaves this year's alone, a member cannot register, a scan takes the
// text the desktop read. Then every clock skips a registered Saturday off and works on a
// compensatory working day: Nib, scheduled jobs and hot-desk booking. And a fresh hub registers
// the built-in 2026 circular once, never again after an administrator's edits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import type { BotFlowDefinition, FileInfo, NibCard } from '@dex/core';
import type { HubClient } from '@dex/core/client';
import type { HolidayReadView } from '@dex/core/holidays';
import { BOT_TEMPLATES } from '@dex/core/botmaker';
import { officeTime } from '@dex/core/botjobs';
import { Hub } from '../src/hub.ts';
import { office, me, cleanups, until } from './office.ts';
import { buildPdf, at } from './pdfs.ts';
import { HubClient as Client } from '@dex/core/client';
import { createIdentity } from '@dex/core';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async <T>(fn: () => Promise<T | undefined | null | false>, ms = 5000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await sleep(25); }
};
const REAL = fs.readFileSync(path.join(import.meta.dirname, '../../../packages/core/test/fixtures/holiday-circular-2026.txt'), 'utf8').split('\n');

/** The circular's text drawn as a PDF: three columns of cells a page, 26 lines a page. */
function circularPdf(lines: string[]): Buffer {
  const pages: string[] = [];
  for (let i = 0; i < lines.length; i += 26) {
    const ops: string[] = [];
    lines.slice(i, i + 26).forEach((l, j) => {
      const cells = l.replace(/’/g, "'").split(/\s{3,}/).filter(Boolean);
      const xs = cells.length === 4 ? [50, 120, 250, 400] : [50, 400];
      cells.forEach((c, k) => ops.push(at(xs[Math.min(k, xs.length - 1)], 560 - j * 20, c, 10)));
    });
    pages.push(ops.join('\n'));
  }
  return buildPdf({ pages: pages.map((content) => ({ content, compress: true })) });
}
const scanPdf = () => buildPdf({ pages: [{ content: '0.5 g 40 40 500 500 re f 0 0 m 300 300 l S' }] });

function upload(hub: Hub, c: HubClient, name: string, data: Buffer): Promise<FileInfo> {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port: hub.port, method: 'POST', path: `/files?name=${encodeURIComponent(name)}&type=application%2Fpdf`, rejectUnauthorized: false, headers: { authorization: `Bearer ${c.session!.fileToken}`, 'content-length': data.length } }, (res) => {
      const parts: Buffer[] = []; res.on('data', (d: Buffer) => parts.push(d)); res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString())); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.end(data);
  });
}
/** Drop a PDF into the conversation with Nib and wait for Nib's card about it. */
async function drop(hub: Hub, c: HubClient, name: string, data: Buffer): Promise<{ view: HolidayReadView; ref: string }> {
  const nibId = hub.nib.id;
  const convId = hub.nib.convFor(me(c))!;
  const before = new Set((await c.request('msg.list', { convId, limit: 200 })).messages.map((m) => m.id));
  const f = await upload(hub, c, name, data);
  await c.request('msg.send', { convId, body: '', clientId: `hp-${Date.now()}-${Math.random()}`, files: [f.id] });
  const m = await waitFor(async () => (await c.request('msg.list', { convId, limit: 200 })).messages.find((x) => !before.has(x.id) && x.authorId === nibId && x.nib?.kind === 'holidays'));
  const card = await c.request('nib.card', { kind: 'holidays', ref: m.nib!.ref }) as Extract<NibCard, { kind: 'holidays' }>;
  return { view: card.view, ref: m.nib!.ref };
}

test('an administrator drops the circular into Nib’s conversation, checks the card and registers it; the same PDF again changes nothing', async () => {
  const { hub, owner, priya } = await office();
  const pdf = circularPdf(REAL);
  const { view } = await drop(hub, owner, 'holidays-2026.pdf', pdf);
  assert.equal(view.state, 'open');
  assert.equal(view.read!.ref, 'HRD/CIR/2026/011');
  assert.equal(view.read!.refDate, '2026-03-26');
  assert.equal(view.read!.year, 2026);
  assert.equal(view.read!.rows.length, 46);
  assert.deepEqual(view.plan!.exceptions, []);
  assert.deepEqual(view.plan!.counts, { holiday: 19, weekoff: 19, compoff: 4, compwork: 4 });
  assert.equal(view.plan!.added, 46);
  assert.equal(view.canRegister, true);
  assert.match(view.hash, /^[0-9a-f]{64}$/);

  // a member can drop it too, but only sees that an administrator registers holidays
  const theirs = await drop(hub, priya, 'holidays-2026.pdf', pdf);
  assert.equal(theirs.view.state, 'denied');
  assert.equal(theirs.view.read, null);
  await assert.rejects(priya.request('nib.holidays.register', { id: view.id }), /Only administrators/);
  await assert.rejects(priya.request('nib.card', { kind: 'holidays', ref: view.id }), /not for you/);

  const done = await owner.request('nib.holidays.register', { id: view.id });
  assert.equal(done.state, 'registered');
  assert.deepEqual(done.done!.counts, { holiday: 19, weekoff: 19, compoff: 4, compwork: 4 });
  // Nib's summary card
  const convId = hub.nib.convFor(me(owner))!;
  const summary = await waitFor(async () => (await owner.request('msg.list', { convId, limit: 200 })).messages.find((m) => m.nib?.kind === 'holidaysDone'));
  assert.match(summary.body, /Registered 46 days from Ref HRD\/CIR\/2026\/011: 19 holidays, 19 Saturdays off, 4 compensatory days off, 4 compensatory working days/);
  // the calendar: off days and compensatory working days apart, each with where it came from
  const cal = await priya.request('botjob.calendar');
  assert.equal(cal.days!.length, 46);
  assert.equal(cal.holidays.length, 42, 'compensatory WORK days are not holidays');
  assert.ok(!cal.holidays.some((h) => h.date === '2026-11-21'));
  assert.deepEqual(cal.extraWorkdays!.map((d) => d.date), ['2026-01-10', '2026-04-18', '2026-05-02', '2026-11-21']);
  const diwali = cal.days!.find((d) => d.date === '2026-11-08')!;
  assert.deepEqual(diwali, { date: '2026-11-08', name: 'Diwali', kind: 'holiday', source: { ref: 'HRD/CIR/2026/011', refDate: '2026-03-26', file: 'holidays-2026.pdf', hash: view.hash, sl: 42 } });
  assert.deepEqual(cal.days!.find((d) => d.date === '2026-11-21')!.for, '2026-11-06');
  assert.equal(cal.circulars![0].ref, 'HRD/CIR/2026/011');
  assert.equal(cal.circulars![0].by, me(owner));
  // the audit log: the reference and the file's hash
  const audit = hub.store.db.prepare(`SELECT actor, detail FROM audit WHERE action = 'holidays.circular'`).all() as Array<{ actor: string; detail: string }>;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor, me(owner));
  const detail = JSON.parse(audit[0].detail);
  assert.deepEqual([detail.ref, detail.refDate, detail.hash, detail.file, detail.year, detail.added], ['HRD/CIR/2026/011', '2026-03-26', view.hash, 'holidays-2026.pdf', 2026, 46]);

  // registering twice is still once
  assert.equal((await owner.request('nib.holidays.register', { id: view.id })).state, 'registered');
  // the same PDF again: already registered, nothing to do
  const again = await drop(hub, owner, 'holidays-2026 (1).pdf', pdf);
  assert.equal(again.view.state, 'already');
  assert.equal(again.view.plan!.already!.ref, 'HRD/CIR/2026/011');
  assert.equal(again.view.canRegister, false);
  await assert.rejects(owner.request('nib.holidays.register', { id: again.view.id }), /registered already/);
  assert.equal((await priya.request('botjob.calendar')).days!.length, 46, 'nothing doubled');

  // an administrator renames a day: it is theirs now (no source); untouched days keep theirs
  const edited = cal.days!.map((d) => (d.date === '2026-12-25' ? { ...d, name: 'Christmas Day' } : d));
  const saved = (await owner.request('admin.botjob.holidays', { holidays: edited })).holidays;
  assert.equal(saved.find((d) => d.date === '2026-12-25')!.source, undefined);
  assert.equal(saved.find((d) => d.date === '2026-11-08')!.source!.hash, view.hash);

  // a revised circular for 2026: Diwali on the Monday, a Saturday off dropped, a day added
  const revised = REAL
    .map((l) => l.replace('Ref: HRD/CIR/2026/011', 'Ref: HRD/CIR/2026/019').replace('8-Nov-2026   Sunday   Diwali', '9-Nov-2026   Monday   Diwali'))
    .filter((l) => !l.startsWith('46   26-Dec-2026'))
    .flatMap((l) => (l.startsWith('45   ') ? [l, '46   31-Dec-2026   Thursday   Year-end shutdown'] : [l]));
  const rev = await drop(hub, owner, 'holidays-2026-rev1.pdf', circularPdf(revised));
  assert.equal(rev.view.state, 'open');
  assert.deepEqual(rev.view.plan!.rows.filter((r) => r.change === 'new').map((r) => r.date), ['2026-11-09', '2026-12-31']);
  assert.deepEqual(rev.view.plan!.rows.filter((r) => r.change === 'updated').map((r) => [r.date, r.name, r.was!.name]), [['2026-12-25', 'Christmas', 'Christmas Day']]);
  assert.deepEqual(rev.view.plan!.removed.map((d) => d.date), ['2026-11-08', '2026-12-26']);
  await owner.request('nib.holidays.register', { id: rev.view.id });
  const after = (await priya.request('botjob.calendar')).days!;
  assert.equal(after.length, 46);
  assert.ok(after.some((d) => d.date === '2026-11-09' && d.source?.ref === 'HRD/CIR/2026/019'));
  assert.ok(!after.some((d) => d.date === '2026-11-08'));

  // next year's circular leaves this year's days alone
  const y27 = ['Ref: HRD/CIR/2026/044   15-Dec-2026', 'Following are the list of Official Holidays for the period of January-2027 to December-2027.',
    'Sl. No.   Date   Day   Description', '1   01-Jan-2027   Friday   New Year’s Day', '2   09-Jan-2027   Saturday   Week-Off', '3   15-Jan-2027   Friday   Pongal'];
  const next = await drop(hub, owner, 'holidays-2027.pdf', circularPdf(y27));
  assert.deepEqual([next.view.plan!.added, next.view.plan!.removed.length], [3, 0]);
  await owner.request('nib.holidays.register', { id: next.view.id });
  const both = (await priya.request('botjob.calendar')).days!;
  assert.equal(both.length, 49);
  assert.equal((await priya.request('botjob.calendar')).circulars!.length, 3);
});

test('rows in doubt are listed and not registered; a scan is read from the text the desktop sends', async () => {
  const { hub, owner } = await office();
  const doubt = REAL.map((l) => l.replace('26-Jan-2026   Monday', '26-Jan-2026   Tuesday')).filter((l) => !l.startsWith('3   14-Jan-2026'));
  const { view } = await drop(hub, owner, 'holidays-2026-draft.pdf', circularPdf(doubt));
  assert.deepEqual(view.plan!.exceptions.map((r) => [r.sl, r.problems.map((p) => p.code)]), [[2, ['forMissing']], [8, ['weekday']]]);
  assert.deepEqual(view.read!.warnings, [{ code: 'serialGap', after: 2, next: 4 }]);
  assert.equal(view.plan!.rows.length, 43);
  await owner.request('nib.holidays.register', { id: view.id });
  const cal = await owner.request('botjob.calendar');
  assert.ok(!cal.days!.some((d) => d.date === '2026-01-26' || d.date === '2026-01-10'), 'exceptions are not registered');

  // a scan: no text layer
  const scan = await drop(hub, owner, 'scan.pdf', scanPdf());
  assert.equal(scan.view.state, 'textless');
  assert.equal(scan.view.canRegister, false);
  // the desktop's OCR text (single spaces, as OCR gives it)
  const ocr = await owner.request('nib.holidays.read', { id: scan.view.id, text: REAL.map((l) => l.replace(/\s{3,}/g, ' ')).join('\n') });
  assert.equal(ocr.ocr, true);
  assert.equal(ocr.read!.rows.length, 46);
  assert.equal(ocr.state, 'open');
  await assert.rejects(owner.request('nib.holidays.read', { id: scan.view.id, text: 'again' }), /has text already/);
  // not a PDF at all
  const junk = await drop(hub, owner, 'notes.pdf', Buffer.from('just some words, not a PDF'));
  assert.equal(junk.view.state, 'unreadable');
  // Office holidays: reading a circular picked there gives the same card in the conversation with Nib
  const f = await upload(hub, owner, 'holidays-2026.pdf', circularPdf(REAL));
  const picked = await owner.request('nib.holidays.read', { fileId: f.id });
  assert.equal(picked.read!.rows.length, 46);
  const convId = hub.nib.convFor(me(owner))!;
  assert.ok((await owner.request('msg.list', { convId, limit: 200 })).messages.some((m) => m.nib?.kind === 'holidays' && m.nib.ref === picked.id));
});

const MIN = 60_000;
test('a registered Saturday off is skipped by Nib, scheduled jobs and hot-desk booking; a compensatory working day is worked', async () => {
  const { hub, owner, priya, ravi } = await office();
  const { view } = await drop(hub, owner, 'holidays-2026.pdf', circularPdf(REAL));
  await owner.request('nib.holidays.register', { id: view.id });
  // the office works Monday to Friday: 21 Nov 2026 (a Saturday) is worked to make up for 6 Nov
  const cfg = await owner.request('admin.nib.get');
  await owner.request('admin.nib.set', { ...cfg, workdays: [1, 2, 3, 4, 5] });
  const local = (d: string, h: number, m = 0) => { const [y, mo, dd] = d.split('-').map(Number); return new Date(y, mo - 1, dd, h, m).getTime(); };

  // Nib: no register on the Saturday off or on Diwali's compensatory day off; one on the compensatory working day
  hub.nib.tick(local('2026-11-06', 19, 30));
  hub.nib.tick(local('2026-11-07', 19, 30));
  hub.nib.tick(local('2026-11-21', 19, 30));
  hub.nib.tick(local('2026-11-28', 19, 30));
  const regs = (hub.store.db.prepare(`SELECT ref FROM nib_snapshots WHERE kind = 'register' ORDER BY ref`).all() as Array<{ ref: string }>).map((r) => r.ref);
  assert.deepEqual(regs, ['2026-11-21']);
  hub.nib.setClock(local('2026-11-21', 11));
  assert.equal((await priya.request('nib.me')).workday, true, 'Nib’s day: the compensatory working day is a workday');
  hub.nib.setClock(local('2026-12-05', 11));
  assert.equal((await priya.request('nib.me')).workday, false);
  hub.nib.setClock(null);

  // scheduled jobs: "every working day at 10:00"
  await owner.request('botflow.make', { definition: JSON.parse(JSON.stringify(BOT_TEMPLATES.find((t) => t.id === 'licence-seat')!.definition)) as BotFlowDefinition, scope: 'office' });
  const def: BotFlowDefinition = {
    name: 'seat-report', title: 'Seat report', steps: [{ id: 'q', prompt: 'Anything?', input: { kind: 'text' } }], finish: [],
    jobs: [{ id: 'daily', title: 'Daily seats', when: 'every working day at 10:00', do: { do: 'check', ask: { skill: 'licence-seat.seats', with: { key: 'CAESAR II' } }, if: { var: 'result.free', gt: 0 }, tell: 'owner', text: 'CAESAR II: {{result}}.' } }],
  };
  await priya.request('botflow.make', { definition: def, scope: 'private' });
  const sheetFrom = (date: string) => priya.request('botjob.sheet', { scope: 'mine', from: officeTime(date, 0), to: officeTime(date, 0) + 9 * 86400_000 });
  hub.botflows.now = () => officeTime('2026-11-20', 11 * 60);
  const lane = (await sheetFrom('2026-11-20')).lanes[0];
  const dates = (ts: number[]) => ts.map((t) => new Date(t + 330 * MIN).toISOString().slice(0, 10));
  assert.deepEqual(dates(lane.next).slice(0, 3), ['2026-11-21', '2026-11-23', '2026-11-24'], 'the compensatory working Saturday runs, Sunday does not');
  hub.botflows.now = () => officeTime('2026-12-03', 11 * 60);
  assert.deepEqual(dates((await sheetFrom('2026-12-03')).lanes[0].next).slice(0, 2), ['2026-12-04', '2026-12-07'], 'the Saturday off is passed over');
  hub.botflows.now = () => Date.now();

  // hot desks: booking days from Friday 20 Nov, and from Friday 4 Dec with the office back on Monday to Saturday
  const d = await owner.request('seating.draft', { moves: [{ seatId: 'W-C42', to: { kind: 'hot' } }] });
  await owner.request('seating.apply', { id: d.id });
  hub.seating.setClock(local('2026-11-20', 10));
  assert.deepEqual((await ravi.request('seating.get')).bookDays.slice(0, 3), ['2026-11-20', '2026-11-21', '2026-11-23']);
  await ravi.request('seating.book', { seatId: 'W-C42', day: '2026-11-21' });
  await owner.request('admin.nib.set', { ...cfg, workdays: [1, 2, 3, 4, 5, 6] });
  hub.seating.setClock(local('2026-12-04', 10));
  const days = (await ravi.request('seating.get')).bookDays;
  assert.ok(!days.includes('2026-12-05'), 'the Saturday off is not offered');
  assert.ok(days.includes('2026-12-12'), 'a Saturday the circular does not give off is a working Saturday');
  await assert.rejects(ravi.request('seating.book', { seatId: 'W-C42', day: '2026-12-05' }), /not a working day/);
});

test('a fresh hub registers the built-in 2026 circular once, and never again after an administrator’s edits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dexhol-'));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  // the same PC each time (a new one would wait for approval)
  const identity = createIdentity();
  const start = async () => {
    const hub = new Hub({ dataDir: dir, port: 0, host: '127.0.0.1', discoveryPort: false, updates: false });
    await hub.start();
    const c = new Client({ identity, account: { username: 'vikram', domain: 'DEX', displayName: 'Vikram', hostname: 'vikram-pc' } });
    c.connect({ host: '127.0.0.1', port: hub.port, fp: hub.fingerprint });
    await until(c, (s) => s.kind === 'ready');
    return { hub, c };
  };
  let { hub, c } = await start();
  const cal = await c.request('botjob.calendar');
  assert.equal(cal.days!.length, 46);
  assert.deepEqual(cal.circulars!.map((x) => [x.ref, x.refDate, x.year, x.by, x.file]), [['HRD/CIR/2026/011', '2026-03-26', 2026, null, 'holidays-2026.pdf']]);
  const nov21 = cal.days!.find((d) => d.date === '2026-11-21')!;
  assert.deepEqual([nov21.kind, nov21.for, nov21.source!.ref, nov21.source!.sl], ['compwork', '2026-11-06', 'HRD/CIR/2026/011', 43]);
  // an administrator removes a day and adds their own
  const edited = [...cal.days!.filter((d) => d.date !== '2026-12-26'), { date: '2026-12-24', name: 'Office day out', kind: 'holiday' as const }];
  await c.request('admin.botjob.holidays', { holidays: edited });
  c.disconnect(); await hub.stop();
  ({ hub, c } = await start());
  const again = (await c.request('botjob.calendar')).days!;
  assert.equal(again.length, 46);
  assert.ok(!again.some((d) => d.date === '2026-12-26'), 'not put back');
  assert.ok(again.some((d) => d.date === '2026-12-24'));
  c.disconnect(); await hub.stop();
});
