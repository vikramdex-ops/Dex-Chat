// The holiday circular reader: the real 2026 circular as the hub's PDF reader gives it, the same
// text as OCR gives it (single spaces) and one cell per line, then made-up variants: a 2027
// circular, a duplicate row, a wrong weekday, a missing row, a compensatory working day for a day
// that is not off, a scan with no text. Then the plan against what is registered and applying it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { applyCircular, goodRows, kindOf, planCircular, readCircular, readDate } from '../src/holidays.ts';
import type { CircularRecord, OfficeDay } from '../src/holidays.ts';

const REAL = fs.readFileSync(path.join(import.meta.dirname, 'fixtures/holiday-circular-2026.txt'), 'utf8').split('\n');
const H = 'a'.repeat(64);
const H2 = 'b'.repeat(64);

test('the 2026 circular: reference, period, 46 rows, each with its kind, none in doubt', () => {
  const r = readCircular(REAL);
  assert.equal(r.ref, 'HRD/CIR/2026/011');
  assert.equal(r.refDate, '2026-03-26');
  assert.deepEqual(r.period, { from: '2026-01-01', to: '2026-12-31' });
  assert.equal(r.year, 2026);
  assert.equal(r.textless, false);
  assert.equal(r.rows.length, 46);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.rows.filter((x) => x.problems.length), []);
  assert.deepEqual(r.rows.map((x) => x.sl), Array.from({ length: 46 }, (_, i) => i + 1), 'serials across the three pages, headers and letterheads left out');
  const by = (d: string) => r.rows.find((x) => x.date === d)!;
  assert.deepEqual([by('2026-01-01').name, by('2026-01-01').kind], ['New Year’s Day', 'holiday']);
  // compensatory WORK is a working day, linked to the day off it makes up for
  assert.deepEqual([by('2026-01-10').kind, by('2026-01-10').for], ['compwork', '2026-01-14']);
  assert.deepEqual([by('2026-04-18').kind, by('2026-04-18').for], ['compwork', '2026-04-24'], '"24-Apr-26": a two-digit year');
  assert.deepEqual([by('2026-05-02').kind, by('2026-05-02').for], ['compwork', '2026-04-25']);
  assert.deepEqual([by('2026-11-21').kind, by('2026-11-21').for], ['compwork', '2026-11-06'], '"06-Nov": no year, the circular’s');
  assert.equal(by('2026-01-14').kind, 'compoff');
  assert.deepEqual([by('2026-01-24').name, by('2026-01-24').kind], ['Week-Off', 'weekoff'], 'the text layer’s "Week -Off" read as Week-Off');
  // month spellings and single-digit days
  assert.equal(by('2026-06-06').dateText, '06-June-2026');
  assert.equal(by('2026-09-05').dateText, '05-Sept-2026');
  assert.equal(by('2026-11-06').dateText, '6-Nov-2026');
  assert.equal(by('2026-05-01').name, 'May Day', '"01-May -2026" with the stray space');
  // festivals on a Sunday are still recorded
  assert.deepEqual([by('2026-11-08').name, by('2026-11-08').kind, by('2026-11-08').dayText], ['Diwali', 'holiday', 'Sunday']);
  assert.equal(by('2026-04-05').name, 'Easter Sunday', 'a weekday inside the description stays in it');
  const kinds = goodRows(r).reduce<Record<string, number>>((a, x) => ({ ...a, [x.kind]: (a[x.kind] ?? 0) + 1 }), {});
  assert.deepEqual(kinds, { holiday: 19, compwork: 4, compoff: 4, weekoff: 19 });
});

test('the same circular as OCR reads it (single spaces) and one cell per line', () => {
  const ocr = REAL.map((l) => l.replace(/\s{3,}/g, ' '));
  const cells = REAL.flatMap((l) => l.split(/\s{3,}/));
  for (const [what, lines] of [['ocr', ocr], ['cells', cells]] as const) {
    const r = readCircular(lines);
    assert.equal(r.rows.length, 46, what);
    assert.deepEqual(r.rows.filter((x) => x.problems.length).map((x) => x.sl), [], what);
    assert.equal(r.ref, 'HRD/CIR/2026/011', what);
    assert.equal(r.rows[42].for, '2026-11-06', what);
  }
  // columns out of order in a text layer: the day before the date
  const swapped = readCircular(['Sl. No.   Date   Day   Description', '1   Thursday   01-Jan-2026   New Year’s Day']);
  assert.equal(swapped.rows.length, 0, 'not read as a row it cannot be sure of');
});

test('dates as circulars write them', () => {
  assert.equal(readDate('05-Sept-2026'), '2026-09-05');
  assert.equal(readDate('5 September 2026'), '2026-09-05');
  assert.equal(readDate('06-June-2026'), '2026-06-06');
  assert.equal(readDate('24-Apr-26'), '2026-04-24');
  assert.equal(readDate('06-Nov', 2027), '2027-11-06');
  assert.equal(readDate('06-Nov'), null, 'no year to go by');
  assert.equal(readDate('01/01/2027'), '2027-01-01', 'day first, as in India');
  assert.equal(readDate('O1-Jan-2O27'), '2027-01-01', 'OCR’s O for 0');
  assert.equal(readDate('31-Feb-2026'), null);
  assert.equal(readDate('12-Smarch-2026'), null);
  assert.equal(kindOf('Compensatory Work For 24-Apr-26'), 'compwork');
  assert.equal(kindOf('Comp. off'), 'compoff');
  assert.equal(kindOf('WEEK - OFF'), 'weekoff');
  assert.equal(kindOf('Weekly Off'), 'weekoff');
  assert.equal(kindOf('Pongal'), 'holiday');
  assert.equal(kindOf('—'), null);
});

/** A made-up circular in the same format. */
const circular = (year: number, rows: string[], period = true) => [
  'DEXTERITY DESIGN SERVICES PRIVATE LIMITED',
  `Ref: HRD/CIR/${year - 1}/044   15-Dec-${year - 1}`,
  'COMMUNICATION CIRCULAR',
  ...(period ? [`Following are the list of Official Holidays for the period of January-${year} to December-${year}.`] : []),
  'Sl. No.   Date   Day   Description',
  ...rows,
  '1. The above list of Holiday plan is common for all Associates.',
];

test('a 2027 circular, issued in December 2026, is read for 2027', () => {
  const r = readCircular(circular(2027, [
    '1   01-Jan-2027   Friday   New Year’s Day',
    '2   09-Jan-2027   Saturday   Week-Off',
    '3   14-Jan-2027   Thursday   Pongal',
    '4   16-Jan-2027   Saturday   Compensatory Work For 15-Jan-27',
    '5   15-Jan-2027   Friday   Compensatory Off',
  ]));
  assert.equal(r.year, 2027);
  assert.equal(r.ref, 'HRD/CIR/2026/044');
  assert.equal(r.refDate, '2026-12-15');
  assert.deepEqual(r.rows.map((x) => [x.date, x.kind, x.problems.length]), [
    ['2027-01-01', 'holiday', 0], ['2027-01-09', 'weekoff', 0], ['2027-01-14', 'holiday', 0], ['2027-01-16', 'compwork', 0], ['2027-01-15', 'compoff', 0],
  ]);
  assert.equal(r.rows[3].for, '2027-01-15');
});

test('rows in doubt are exceptions: a duplicate date, a wrong weekday, a date out of the period, unreadable, a compensatory day for nothing', () => {
  const r = readCircular(circular(2027, [
    '1   01-Jan-2027   Friday   New Year’s Day',
    '2   01-Jan-2027   Friday   New Year’s Day',
    '3   26-Jan-2027   Monday   Republic Day',
    '4   14-Jan-2026   Wednesday   Pongal',
    '5   31-Feb-2027   Saturday   Week-Off',
    '7   20-Feb-2027   Saturday   Compensatory work for 12-Feb',
    '8   06-Mar-2027   Saturday   ',
    '8   13-Mar-2027   Saturday   Holi',
    '9   27-Mar-2027   Saturday   Week-Off',
    '10   27-Mar-2027   Saturday   Ugadi',
  ]));
  const p = (sl: number) => r.rows.filter((x) => x.sl === sl).map((x) => x.problems.map((q) => q.code));
  assert.deepEqual(p(1), [[]], 'the first of two identical rows stands');
  assert.deepEqual(p(2), [['dupDate']]);
  assert.deepEqual(r.rows[2].problems, [{ code: 'weekday', actual: 2 }], '26 Jan 2027 is a Tuesday');
  assert.deepEqual(p(4), [['year']]);
  assert.deepEqual(p(5), [['date']]);
  assert.deepEqual(r.rows.find((x) => x.sl === 7)!.problems, [{ code: 'forMissing', for: '2027-02-12' }]);
  assert.deepEqual(p(8), [['unknown'], []]);
  assert.deepEqual([...p(9), ...p(10)], [['dupDate'], ['dupDate']], 'two different days on one date: both in doubt');
  assert.deepEqual(r.warnings, [{ code: 'serialGap', after: 5, next: 7 }, { code: 'serialDup', sl: 8 }]);
  assert.deepEqual(goodRows(r).map((x) => x.sl), [1, 8]);
});

test('a circular without its period line goes by the year most rows are in', () => {
  const r = readCircular(circular(2027, ['1   01-Jan-2027   Friday   New Year’s Day', '2   14-Jan-2027   Thursday   Pongal', '3   25-Dec-2026   Friday   Christmas'], false));
  assert.equal(r.year, 2027);
  assert.deepEqual(r.warnings, [{ code: 'noPeriod' }]);
  assert.deepEqual(r.rows[2].problems, [{ code: 'year', year: 2026 }]);
});

test('a scan with no text, and a PDF that is not a circular', () => {
  const scan = readCircular(['', '   ', '\f']);
  assert.equal(scan.textless, true);
  assert.equal(scan.rows.length, 0);
  const other = readCircular(['GA-101 Piping general arrangement', 'Rev B   12-Mar-2026']);
  assert.equal(other.textless, false);
  assert.equal(other.rows.length, 0);
});

test('the plan: new, unchanged and updated days, removed ones only from a circular of that year, the same file twice', () => {
  const read = readCircular(REAL);
  const empty = planCircular(read, [], H, []);
  assert.equal(empty.added, 46);
  assert.deepEqual(empty.counts, { holiday: 19, weekoff: 19, compoff: 4, compwork: 4 });
  const src = { ref: read.ref, refDate: read.refDate, file: 'holidays-2026.pdf', hash: H };
  const list = applyCircular([{ date: '2025-12-25', name: 'Christmas', kind: 'holiday' }], read, empty, src);
  assert.equal(list.length, 47, 'last year’s day is kept');
  assert.deepEqual(list.find((d) => d.date === '2026-11-21'), { date: '2026-11-21', name: 'Compensatory Work for 06-Nov', kind: 'compwork', for: '2026-11-06', source: { ...src, sl: 43 } });
  const rec: CircularRecord = { hash: H, ref: read.ref, refDate: read.refDate, year: 2026, file: 'holidays-2026.pdf', at: 1, by: null, counts: empty.counts };
  const again = planCircular(read, list, H, [rec]);
  assert.equal(again.already, rec);
  assert.deepEqual([again.added, again.updated, again.unchanged, again.removed.length], [0, 0, 46, 0]);
  // a revised circular: Diwali moves to the Monday, Christmas renamed, a week-off dropped, a day added
  const revised = REAL
    .map((l) => l.replace('8-Nov-2026   Sunday   Diwali', '9-Nov-2026   Monday   Diwali'))
    .map((l) => l.replace('Christmas', 'Christmas Day'))
    .filter((l) => !l.startsWith('46   26-Dec-2026'))
    .flatMap((l) => (l.startsWith('45   ') ? [l, '46   31-Dec-2026   Thursday   Year-end shutdown'] : [l]));
  const r2 = readCircular(revised);
  assert.deepEqual(r2.rows.filter((x) => x.problems.length), []);
  const typedIn: OfficeDay = { date: '2026-12-24', name: 'Office day out', kind: 'holiday' };
  const p2 = planCircular(r2, [...list, typedIn], H2, [rec]);
  assert.equal(p2.already, null);
  assert.deepEqual(p2.rows.filter((x) => x.change === 'new').map((x) => x.date), ['2026-11-09', '2026-12-31']);
  assert.deepEqual(p2.rows.filter((x) => x.change === 'updated').map((x) => [x.date, x.name, x.was?.name]), [['2026-12-25', 'Christmas Day', 'Christmas']]);
  assert.deepEqual(p2.removed.map((d) => d.date), ['2026-11-08', '2026-12-26'], 'typed-in days and other years are never removed');
  const after = applyCircular([...list, typedIn], r2, p2, { ...src, hash: H2 });
  assert.ok(after.some((d) => d.date === '2026-12-24'));
  assert.ok(after.some((d) => d.date === '2025-12-25'));
  assert.ok(!after.some((d) => d.date === '2026-11-08'));
  assert.equal(after.find((d) => d.date === '2026-12-25')!.source!.hash, H2);
});
