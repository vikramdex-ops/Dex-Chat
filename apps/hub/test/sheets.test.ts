// Dexterity Sheets for Nib against a mock Sheets server (HTTP read API and the UDP discovery
// answer): the administrator's settings (token sealed, never sent back), the test button, finding
// the server, Nib's answers about the asking person only, "who's in <book>", the opt-in morning
// list and workbook link cards that keep ?at=<Sheet>!<Cell>. No real Sheets server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { HubClient } from '@dex/core/client';
import type { Message } from '@dex/core';
import { cleanups, me, office, send } from './office.ts';
import { localDate } from '../src/work.ts';

const TOKEN = 'sheets-test-token-7f3a9c';
const LINK = 'dexterity://open/PC-SERVER:47810/line-list-100-3f2a?at=Line%20List!B4';

/** A Sheets server: the read API with a bearer token, and the answer to DEXSHEETS?1. */
async function mockSheets() {
  const asked: string[] = [];
  const server = http.createServer((req, res) => {
    asked.push(req.url ?? '');
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: 'token' });
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname === '/api/v1/health') return json(200, { name: 'PC-SERVER', version: '0.9.0' });
    if (u.pathname === '/api/v1/books') return json(200, [
      { id: 'line-list-100-3f2a', name: 'Line list 100', sharer: 'DEX\\vikram', online: ['DEX\\Priya', 'dex\\ravi', 'DEX\\visitor'] },
      { id: 'mto-12', name: 'MTO P-12', sharer: 'DEX\\ravi', online: [] },
    ]);
    const m = /^\/api\/v1\/people\/([^/]+)\/(assigned|mentions)$/.exec(u.pathname);
    if (m) {
      const who = decodeURIComponent(m[1]).toLowerCase();
      if (who !== 'dex\\priya') return json(200, []);
      if (m[2] === 'assigned') return json(200, [
        { book: 'Line list 100', sheet: 'Line List', cell: 'B4', title: 'Check the rating', status: 'Open', due: '2099-01-02', link: LINK },
        { book: 'MTO P-12', sheet: 'Pipes', cell: 'C9', title: 'Closed already', status: 'Done', due: null, link: 'dexterity://open/PC-SERVER:47810/mto-12?at=Pipes!C9' },
      ]);
      assert.ok(u.searchParams.get('since'), 'mentions are asked since a moment');
      return json(200, [{ book: 'MTO P-12', sheet: 'Pipes', cell: 'C9', from: 'Ravi', text: 'please check the 6" line', at: new Date().toISOString(), link: 'dexterity://open/PC-SERVER:47810/mto-12?at=Pipes!C9' }]);
    }
    json(404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const udp = dgram.createSocket('udp4');
  udp.on('message', (buf, from) => { if (buf.toString() === 'DEXSHEETS?1') udp.send(JSON.stringify({ name: 'PC-SERVER', address: '0.0.0.0:47810', version: '0.9.0' }), from.port, from.address); });
  await new Promise<void>((r) => udp.bind(0, '127.0.0.1', r));
  cleanups.push(() => new Promise<void>((r) => { udp.close(); server.close(() => r()); }));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, udpPort: (udp.address() as AddressInfo).port, asked };
}

/** Nib's next plain line (not a card) in someone's conversation with Nib. */
async function nibSays(c: HubClient, convId: string, pred: (body: string) => boolean, ms = 5000): Promise<Message> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const hit = (await c.request('msg.list', { convId })).messages.find((x) => !x.nib && x.authorId !== me(c) && pred(x.body ?? ''));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('Nib did not answer');
}

test('Sheets settings: an administrator connects, tests and finds the server; the token never leaves the hub', async () => {
  const sheets = await mockSheets();
  const { owner, priya, dir } = await office();
  assert.equal((await owner.request('admin.sheets.get')).configured, false);
  await assert.rejects(priya.request('admin.sheets.get'), /administrators/);
  await assert.rejects(owner.request('admin.sheets.set', { url: 'ftp://nope' }), /name or address/);
  // testing what is typed, before saving
  const wrong = await owner.request('admin.sheets.test', { url: sheets.url, token: 'wrong' });
  assert.equal(wrong.ok, false);
  assert.match(wrong.error ?? '', /refused the token/);
  const v = await owner.request('admin.sheets.set', { url: sheets.url, token: TOKEN });
  assert.deepEqual({ url: v.url, hasToken: v.hasToken, configured: v.configured }, { url: sheets.url, hasToken: true, configured: true });
  assert.ok(!JSON.stringify(v).includes(TOKEN), 'the token is never sent back');
  const ok = await owner.request('admin.sheets.test', {});
  assert.deepEqual({ ok: ok.ok, name: ok.name, version: ok.version }, { ok: true, name: 'PC-SERVER', version: '0.9.0' });
  assert.equal((await owner.request('admin.sheets.get')).lastTest?.ok, true);
  // sealed: not in the database or the hub's log files as written
  for (const f of fs.readdirSync(dir, { recursive: true }) as string[]) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isFile()) assert.ok(!fs.readFileSync(p).includes(TOKEN), `${f} does not carry the token`);
  }
  // an empty token keeps the saved one; null removes it
  assert.equal((await owner.request('admin.sheets.set', { url: sheets.url, token: '' })).hasToken, true);
  assert.equal((await owner.request('admin.sheets.set', { token: null })).configured, false);
});

test('finding the Sheets server on the network', async () => {
  const sheets = await mockSheets();
  const { owner } = await office({ sheetsDiscoveryPort: sheets.udpPort });
  const found = await owner.request('admin.sheets.discover');
  assert.equal(found.length, 1);
  assert.deepEqual(found[0], { name: 'PC-SERVER', address: '127.0.0.1:47810', version: '0.9.0', url: 'http://127.0.0.1:47812' });
});

test('Nib answers Sheets questions about the asking person only, with links that open at the cell', async () => {
  const sheets = await mockSheets();
  const { owner, priya, ravi } = await office();
  const pc = (await priya.request('nib.me')).convId!;
  // not connected yet: Nib says so, and writes nothing on the day sheet
  await send(priya, pc, 'what’s assigned to me in Sheets?');
  await nibSays(priya, pc, (b) => /not connected to the hub yet/.test(b));
  assert.equal((await priya.request('nib.me')).items.length, 0);

  await owner.request('admin.sheets.set', { url: sheets.url, token: TOKEN });
  await send(priya, pc, 'what’s assigned to me in Sheets?');
  const a = await nibSays(priya, pc, (b) => b.startsWith('One open item'));
  assert.ok(a.body!.includes(`[Line list 100 · Line List!B4](${LINK})`), a.body);
  assert.ok(!a.body!.includes('Closed already'));
  assert.ok(sheets.asked.some((u) => u === `/api/v1/people/${encodeURIComponent('dex\\priya')}/assigned`), 'asked for Priya’s own account');
  assert.ok(!sheets.asked.some((u) => /ravi/i.test(u)), 'nobody else’s');
  assert.equal((await priya.request('nib.me')).items.length, 0, 'a Sheets question is not day-sheet work');

  await send(priya, pc, 'any mentions for me?');
  const m = await nibSays(priya, pc, (b) => b.startsWith('One mention'));
  assert.match(m.body!, /Ravi: “please check the 6" line”/);

  // "who's in <book>": names the office knows, accounts it does not
  await send(priya, pc, 'who is in line list 100?');
  const w = await nibSays(priya, pc, (b) => b.includes('open in Dexterity Sheets'));
  assert.equal(w.body, 'Priya, Ravi and DEX\\visitor have **Line list 100** open in Dexterity Sheets.');
  // the office's own "who" is not a workbook: Nib's usual answer
  await send(priya, pc, 'who is in Piping team?');
  const nibId = (await priya.request('nib.me')).botId;
  for (let i = 0; i < 100; i++) {
    const cards = (await priya.request('msg.list', { convId: pc })).messages.filter((x) => x.authorId === nibId && x.nib?.kind === 'reply');
    if (cards.length) break;
    await new Promise((r) => setTimeout(r, 40));
  }
  assert.ok((await priya.request('msg.list', { convId: pc })).messages.some((x) => x.nib?.kind === 'reply'), 'a normal reply card');

  // the Nib box in the app asks the same way and gets the message to open
  const r = await ravi.request('nib.sheets.ask', { text: 'what is assigned to me in sheets?' });
  assert.equal(r.text, 'Nothing is assigned to you in Dexterity Sheets.');
  assert.ok(r.convId && r.messageId);
});

test('the morning list: off by default, on when asked, once a workday, only with open items', async () => {
  const sheets = await mockSheets();
  const { hub, owner, priya, ravi } = await office();
  await owner.request('admin.sheets.set', { url: sheets.url, token: TOKEN });
  await owner.request('admin.nib.set', { workdays: [0, 1, 2, 3, 4, 5, 6], startPromptAt: '09:45' });
  const today = localDate(Date.now());
  const [y, mo, d] = today.split('-').map(Number);
  const t = new Date(y, mo - 1, d, 9, 50).getTime();
  const pc = (await priya.request('nib.me')).convId!;
  const rc = (await ravi.request('nib.me')).convId!;
  hub.nib.setClock(t);
  hub.nib.tick(t);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!sheets.asked.some((u) => u.endsWith('/assigned')), 'nobody asked: nothing sent');

  await send(priya, pc, 'Sheets digest on');
  await nibSays(priya, pc, (b) => b.startsWith('Done. Each workday at 09:45'));
  await send(ravi, rc, 'send me my sheets items every morning');
  await nibSays(ravi, rc, (b) => b.startsWith('Done. Each workday'));
  assert.equal((await owner.request('admin.sheets.get')).digestPeople, 2);

  hub.nib.tick(t + 60_000);
  const list = await nibSays(priya, pc, (b) => b.startsWith('Good morning.'));
  assert.ok(list.body!.includes(LINK));
  assert.match(list.body!, /Sheets digest off/);
  hub.nib.tick(t + 120_000);
  await new Promise((r) => setTimeout(r, 300));
  const mornings = (await priya.request('msg.list', { convId: pc })).messages.filter((x) => x.body?.startsWith('Good morning.'));
  assert.equal(mornings.length, 1, 'once a day');
  // Ravi has nothing open: no morning message
  assert.ok(!(await ravi.request('msg.list', { convId: rc })).messages.some((x) => x.body?.startsWith('Good morning.')));
  hub.nib.setClock(null);
});

test('workbook link cards show the sheet and cell and open the whole link', async () => {
  const { priya } = await office();
  const card = await priya.request('links.preview', { url: LINK });
  assert.equal(card.kind, 'workbook');
  assert.equal(card.title, 'Line list 100');
  assert.equal(card.meta.find((x) => x.key === 'sheet')?.value, 'Line List');
  assert.equal(card.meta.find((x) => x.key === 'location')?.value, 'B4');
  const open = card.actions.find((x) => x.kind === 'open-in-tool')!;
  assert.equal(open.target, LINK, '?at= passes through to Dexterity Sheets');
  assert.equal(open.label, 'Open at B4');
});
