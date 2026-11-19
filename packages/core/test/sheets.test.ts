// Dexterity Sheets for Nib and the share link: questions told apart from day-sheet words, workbook
// links kept whole (?at= included), answers that link to the cell, and dexconnect://share from Sheets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignedAnswer, bookName, matchBook, mentionsAnswer, parseWorkbookLink, safeWorkbookLink, sheetsAsk, sheetsBaseUrl, splitAt, whoAnswer } from '../src/sheets.ts';
import { parseShare } from '../src/share.ts';
import { parseWork } from '../src/nib.ts';

test('Sheets questions, and day-sheet words that are not', () => {
  assert.deepEqual(sheetsAsk('what’s assigned to me in Sheets?'), { kind: 'assigned' });
  assert.deepEqual(sheetsAsk("What's assigned to me in Dexterity Sheets"), { kind: 'assigned' });
  assert.deepEqual(sheetsAsk('any mentions for me?'), { kind: 'mentions' });
  assert.deepEqual(sheetsAsk('do I have any mentions in Sheets'), { kind: 'mentions' });
  assert.deepEqual(sheetsAsk('who’s in the line list workbook?'), { kind: 'who', book: 'line list', named: true });
  assert.deepEqual(sheetsAsk('who is in Line List 100?'), { kind: 'who', book: 'Line List 100', named: false });
  assert.deepEqual(sheetsAsk('Sheets digest on'), { kind: 'digest', on: true });
  assert.deepEqual(sheetsAsk('stop the sheets digest'), { kind: 'digest', on: false });
  // work notes and the office's own "who" stay Nib's day sheet and presence
  for (const s of ['got 12 sheets assigned from Meera for P-12', 'Meera mentioned the GA needs rework', 'who is in today', 'who’s in the office', 'who is on leave', 'send my day sheet', 'finished 18 of 40 sheets'])
    assert.equal(sheetsAsk(s), null, s);
  assert.equal(parseWork('what’s assigned to me in Sheets?', { people: [], today: '2026-11-19' }).intent, 'sheets');
  assert.equal(parseWork('got 12 sheets assigned from Meera', { people: [], today: '2026-11-19' }).intent, 'got');
  assert.equal(parseWork('who is in Line List 100?', { people: [], today: '2026-11-19' }).intent, 'who', 'unnamed: the hub decides by the books');
});

test('the Sheets server address', () => {
  assert.equal(sheetsBaseUrl('PC-SERVER'), 'http://pc-server:47812');
  assert.equal(sheetsBaseUrl('10.0.0.5:47812'), 'http://10.0.0.5:47812');
  assert.equal(sheetsBaseUrl('http://pc-server:9000/'), 'http://pc-server:9000');
  assert.equal(sheetsBaseUrl('ftp://x'), null);
  assert.equal(sheetsBaseUrl('http://user:pw@x'), null);
  assert.equal(sheetsBaseUrl(''), null);
});

test('workbook links keep their cell', () => {
  assert.deepEqual(splitAt("'Line List'!B4"), { sheet: 'Line List', cell: 'B4' });
  assert.deepEqual(splitAt('B4'), { sheet: null, cell: 'B4' });
  const wb = parseWorkbookLink('dexterity://open/PC-SERVER:47810/line-list-100-3f2a?at=Line%20List!B4');
  assert.deepEqual(wb, { server: 'PC-SERVER:47810', book: 'line-list-100-3f2a', at: 'Line List!B4', sheet: 'Line List', cell: 'B4' });
  assert.equal(bookName('line-list-100-3f2a'), 'Line list 100');
  // spaces and quotes would end the link in text: encoded, the link still opens at the cell
  const safe = safeWorkbookLink("dexterity://open/PC-SERVER:47810/ll?at='Line List'!B4")!;
  assert.equal(safe, 'dexterity://open/PC-SERVER:47810/ll?at=%27Line%20List%27!B4');
  assert.equal(parseWorkbookLink(safe)?.sheet, 'Line List');
  assert.equal(safeWorkbookLink('https://evil.example/'), null);
  assert.equal(safeWorkbookLink('dexterity://other/x'), null);
});

test('Nib’s answers link to the cell', () => {
  const link = 'dexterity://open/PC-SERVER:47810/line-list-100-3f2a?at=Line%20List!B4';
  const a = assignedAnswer([
    { book: 'Line list 100', sheet: 'Line List', cell: 'B4', title: 'Check rating', status: 'Open', due: '2026-11-18', link },
    { book: 'MTO', sheet: 'Pipes', cell: 'C9', title: 'Done thing', status: 'Done', due: null, link },
  ], '2026-11-19', { digestOn: false });
  assert.match(a, /^One open item is assigned to you in Dexterity Sheets:/);
  assert.ok(a.includes(`[Line list 100 · Line List!B4](${link}) — Check rating · Open · overdue since 18 Nov`));
  assert.ok(!a.includes('Done thing'));
  assert.match(a, /Sheets digest on/);
  assert.equal(assignedAnswer([], '2026-11-19'), 'Nothing is assigned to you in Dexterity Sheets.');
  // a link that is not a workbook link is never written as a link
  assert.ok(assignedAnswer([{ book: 'B', sheet: 'S', cell: 'A1', title: 't', status: '', due: null, link: 'https://x.example' }], '2026-11-19').includes('**B · S!A1**'));
  const m = mentionsAnswer([{ book: 'MTO', sheet: 'Pipes', cell: 'C9', from: 'Meera', text: 'check [this]', at: '2026-11-19T05:00:00Z', link }], 'in the last 7 days');
  assert.ok(m.includes('— Meera: “check this”'));
  assert.equal(whoAnswer({ name: 'MTO' }, null, ['Priya', 'Ravi']), 'Priya and Ravi have **MTO** open in Dexterity Sheets.');
  assert.equal(matchBook([{ id: 'line-list-100-3f2a', name: 'Line list 100' }, { id: 'mto', name: 'MTO' }], 'line list')?.id, 'line-list-100-3f2a');
});

test('Share to Dexterity Connect from Dexterity Sheets', () => {
  const link = 'dexterity://open/PC-SERVER:47810/line-list-100-3f2a?at=Line%20List!B4';
  const url = `dexconnect://share?from=Dexterity%20Sheets&title=${encodeURIComponent('Line list 100')}&link=${encodeURIComponent(link)}`;
  const r = parseShare(url)!;
  assert.equal(r.from, 'Dexterity Sheets');
  assert.equal(r.text, `[Line list 100](${link})`);
  // a link sent without its own encoding still keeps the whole cell address
  const loose = parseShare(`dexconnect://share?from=Dexterity%20Sheets&title=Book&link=dexterity://open/S/b?at=Line%20List!B4`)!;
  assert.equal(loose.text, '[Book](dexterity://open/S/b?at=Line%20List!B4)');
  assert.equal(parseShare('dexconnect://share?text=hi&link=%5C%5Cnas%5Cjob&title=Folder')!.text, 'hi\nFolder: \\\\nas\\job');
  assert.equal(parseShare('https://x/share'), null);
});
