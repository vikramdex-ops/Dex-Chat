// The tools that come with Dexterity Connect: their helpers, and that every page is valid script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { miniAppCsp, miniAppDocument } from '@dex/core/miniapp';
import { BUILTIN_MINIAPPS } from '../src/miniapps/index.ts';
import { evaluate, formatNumber } from '../src/miniapps/calculator.ts';
import { QUANTITIES, convert, sig } from '../src/miniapps/units.ts';
import { cellNumber, numericColumns, sortRows } from '../src/miniapps/table.ts';
import { tally } from '../src/miniapps/punchlist.ts';
import { mergeById } from '../src/miniapps/kit.ts';
import { pdfFirstPage } from '../src/miniapps/pdf.ts';
import { checkManifest } from '../src/miniapps.ts';

test('every built-in tool is one valid page with a manifest the hub accepts', () => {
  assert.equal(BUILTIN_MINIAPPS.length, 5);
  for (const app of BUILTIN_MINIAPPS) {
    // built-in ids are reserved for uploads, so check the rest of the manifest under another id
    assert.doesNotThrow(() => checkManifest({ ...app.manifest, id: app.manifest.id.replace(/^dex-/, 'x-') }), app.manifest.id);
    const doc = miniAppDocument(app.html, miniAppCsp([]));
    const scripts = [...doc.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.equal(scripts.length, 2, `${app.manifest.id}: the API and the tool`);
    for (const s of scripts) assert.doesNotThrow(() => new Function(s), app.manifest.id);
    assert.ok(!/<script src|<link|https?:\/\//.test(app.html.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '')), `${app.manifest.id} loads nothing from elsewhere`);
  }
});

test('calculator: precedence, brackets, functions in degrees, per cent, and clear errors', () => {
  assert.equal(evaluate('12*3'), 36);
  assert.equal(evaluate('2 + 3 × 4'), 14);
  assert.equal(evaluate('(2+3)*4'), 20);
  assert.equal(evaluate('2^3^2'), 512);
  assert.equal(evaluate('-2^2'), -4);
  assert.equal(evaluate('200 × 15%'), 30);
  assert.equal(evaluate('√16 + sqrt(9)'), 7);
  assert.equal(Number(evaluate('sin(30)').toFixed(12)), 0.5);
  assert.equal(Number(evaluate('atan(1)').toFixed(9)), 45);
  assert.equal(evaluate('2π'), 2 * Math.PI);
  assert.equal(evaluate('1,250.5 ÷ 2'), 625.25);
  assert.equal(evaluate('1.5e3 − 500'), 1000);
  assert.throws(() => evaluate('1/0'), /Division by zero/);
  assert.throws(() => evaluate('(1+2'), /Missing \)/);
  assert.throws(() => evaluate('2 +'), /Unfinished/);
  assert.throws(() => evaluate('alert(1)'), /Unknown: alert/);
  assert.throws(() => evaluate('sqrt(-1)'), /negative/);
  assert.equal(formatNumber(0.1 + 0.2), '0.3');
  assert.equal(formatNumber(1 / 3), '0.333333333333');
  assert.equal(formatNumber(1e20), '1e+20');
});

test('unit converter: engineering units both ways, temperature with offsets', () => {
  const close = (a: number, b: number, rel = 1e-9) => assert.ok(Math.abs(a - b) <= Math.abs(b) * rel + 1e-12, `${a} ≈ ${b}`);
  close(convert(QUANTITIES, 'length', 1, 'in', 'mm'), 25.4);
  close(convert(QUANTITIES, 'length', 1, 'mi', 'ft'), 5280);
  close(convert(QUANTITIES, 'pressure', 1, 'bar', 'psi'), 14.503773773, 1e-8);
  close(convert(QUANTITIES, 'pressure', 1, 'atm', 'kPa'), 101.325);
  close(convert(QUANTITIES, 'pressure', 10, 'mH2O', 'bar'), 0.980665);
  close(convert(QUANTITIES, 'flow', 1, 'm3h', 'usgpm'), 4.402867539, 1e-8);
  close(convert(QUANTITIES, 'flow', 1, 'm3s', 'Ls'), 1000);
  close(convert(QUANTITIES, 'temperature', 100, 'C', 'F'), 212);
  close(convert(QUANTITIES, 'temperature', -40, 'F', 'C'), -40);
  close(convert(QUANTITIES, 'temperature', 0, 'C', 'K'), 273.15);
  close(convert(QUANTITIES, 'temperature', 491.67, 'R', 'C'), 0);
  close(convert(QUANTITIES, 'mass', 1, 'lb', 'kg'), 0.45359237);
  close(convert(QUANTITIES, 'area', 1, 'ha', 'm2'), 10000);
  close(convert(QUANTITIES, 'area', 1, 'acre', 'ft2'), 43560, 1e-6);
  close(convert(QUANTITIES, 'volume', 1, 'bbl', 'usgal'), 42);
  close(convert(QUANTITIES, 'density', 1, 'gcm3', 'kgm3'), 1000);
  close(convert(QUANTITIES, 'density', 62.42796, 'lbft3', 'kgm3'), 1000, 1e-6);
  for (const q of QUANTITIES) for (const u of q.units) close(convert(QUANTITIES, q.id, convert(QUANTITIES, q.id, 7.5, u.id, q.units[0].id), q.units[0].id, u.id), 7.5);
  assert.deepEqual(QUANTITIES.map((q) => q.id), ['length', 'pressure', 'flow', 'temperature', 'mass', 'area', 'volume', 'density']);
  assert.throws(() => convert(QUANTITIES, 'length', 1, 'm', 'psi'), /Unknown unit/);
  assert.equal(sig(14.503773773), '14.5038');
  assert.equal(sig(0.0000012), '1.2e-6');
});

test('data sheet, punch list and merging shared lists', () => {
  assert.equal(cellNumber('1,234.5'), 1234.5);
  assert.equal(cellNumber('12%'), 12);
  assert.equal(cellNumber('P-12'), null);
  const rows = [['Pump', '12'], ['Valve', '3'], ['Tank', ''], ['Fan', '120']];
  assert.deepEqual(numericColumns(rows, 2, cellNumber), [false, true]);
  assert.deepEqual(sortRows(rows, 1, 1, true, cellNumber).map((r) => r[0]), ['Valve', 'Pump', 'Fan', 'Tank']);
  assert.deepEqual(sortRows(rows, 1, -1, true, cellNumber).map((r) => r[0]), ['Fan', 'Pump', 'Valve', 'Tank']);
  assert.deepEqual(sortRows([['ISO-10'], ['ISO-9']], 0, 1, false, cellNumber).map((r) => r[0]), ['ISO-9', 'ISO-10']);
  const item = (id: string, disc: string, done: boolean, pri: 'A' | 'B' = 'B') => ({ id, n: 1, text: 't', area: 'Pump house', disc, pri, by: 'P', created: 1, done, doneBy: null, at: 1 });
  const t = tally([item('1', 'Piping', false, 'A'), item('2', 'Piping', true), item('3', 'Civil', false), { ...item('4', 'Civil', false), text: '' }]);
  assert.deepEqual({ open: t.open, closed: t.closed, a: t.a }, { open: 2, closed: 1, a: 1 });
  assert.deepEqual(t.byDisc, [['Civil', 1, 0], ['Piping', 1, 1]]);
  assert.deepEqual(mergeById([{ id: 'a', at: 1, v: 1 }, { id: 'b', at: 2, v: 1 }], [{ id: 'a', at: 3, v: 2 }, { id: 'c', at: 0, v: 1 }]).map((x) => `${x.id}${x.v}`), ['c1', 'b1', 'a2']);
});

/** A small PDF: a line, a filled box, text, and (optionally) the page inside a compressed object stream. */
function makePdf(objectStream: boolean): Uint8Array {
  const content = zlib.deflateSync(Buffer.from('q 0 0 1 RG 2 w 10 10 m 190 90 l S Q 1 0 0 rg 20 20 50 30 re f BT /F1 12 Tf 30 60 Td [(GA)-250(200)] TJ ET'));
  const objs: Array<[number, string | Buffer]> = [
    [1, '<< /Type /Catalog /Pages 2 0 R >>'],
    [2, '<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 200 100] >>'],
    [4, Buffer.concat([Buffer.from(`<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`), content, Buffer.from('\nendstream')])],
  ];
  const page = '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R /Rotate 90 >>';
  const font = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /FirstChar 32 /LastChar 90 /Widths [278 0 0 0 0 0 0 0 0 0 0 0 0 333 0 0 556 556 556 0 0 0 0 0 0 0 0 0 0 0 0 0 0 722 0 0 0 0 0 778] >>';
  if (objectStream) {
    const head = `3 0 5 ${page.length + 1} `;
    const body = `${page}\n${font}`;
    const data = zlib.deflateSync(Buffer.from(head + body));
    objs.push([6, Buffer.concat([Buffer.from(`<< /Type /ObjStm /N 2 /First ${head.length} /Length ${data.length} /Filter /FlateDecode >>\nstream\n`), data, Buffer.from('\nendstream')])]);
  } else objs.push([3, page], [5, font]);
  const parts: Buffer[] = [Buffer.from('%PDF-1.5\n%\xe2\xe3\n')];
  for (const [n, o] of objs) parts.push(Buffer.from(`${n} 0 obj\n`), Buffer.isBuffer(o) ? o : Buffer.from(o), Buffer.from('\nendobj\n'));
  parts.push(Buffer.from('trailer\n<< /Root 1 0 R /Size 7 >>\n%%EOF\n'));
  return new Uint8Array(Buffer.concat(parts));
}

test('drawing viewer: the first page of a PDF becomes lines, fills and text to draw', async () => {
  for (const objectStream of [false, true]) {
    const p = await pdfFirstPage(makePdf(objectStream));
    assert.deepEqual(p.box, [0, 0, 200, 100]);
    assert.equal(p.rotate, 90);
    assert.equal(p.pages, 1);
    const stroke = p.ops.find((o) => o.k === 'path' && o.stroke);
    assert.ok(stroke && stroke.k === 'path');
    assert.deepEqual(stroke.d, [0, 10, 10, 1, 190, 90]);
    assert.equal(stroke.stroke, 'rgb(0,0,255)');
    assert.equal(stroke.lw, 2);
    const fill = p.ops.find((o) => o.k === 'path' && o.fill);
    assert.ok(fill && fill.k === 'path');
    assert.equal(fill.fill, 'rgb(255,0,0)');
    assert.deepEqual(fill.d, [0, 20, 20, 1, 70, 20, 1, 70, 50, 1, 20, 50, 3]);
    const text = p.ops.filter((o) => o.k === 'text');
    assert.equal(text.map((o) => (o.k === 'text' ? o.s : '')).join(''), 'GA200');
    const first = text[0];
    assert.ok(first.k === 'text');
    assert.deepEqual(first.m, [12, 0, 0, 12, 30, 60]);
    assert.equal(first.weight, 'bold');
    // G (778) then A (722) at 12 pt, then a 250/1000 em gap before "200"
    const third = text[2];
    assert.ok(third.k === 'text');
    assert.ok(Math.abs(third.m[4] - (30 + 12 * (0.778 + 0.722) + 12 * 0.25)) < 1e-9, String(third.m[4]));
  }
  await assert.rejects(pdfFirstPage(new TextEncoder().encode('not a pdf')), /no pages/);
});
