import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { PdfError, readPdf, titleBlock } from '../src/pdf.ts';
import { at, atCid, buildPdf, drawingSheet } from './pdfs.ts';

const sheet = drawingSheet({ title: ['GENERAL ARRANGEMENT', 'PUMP HOUSE P-12'], rev: 'C', number: 'DDS-JR-GA-101' });

test('a title block drawn in a plain content stream', () => {
  const r = readPdf(buildPdf({ pages: [{ content: sheet }] }), 'GA-101.pdf');
  assert.equal(r.title, 'GENERAL ARRANGEMENT PUMP HOUSE P-12');
  assert.equal(r.revision, 'C');
  assert.equal(r.number, 'DDS-JR-GA-101');
  assert.equal(r.pages, 1);
  assert.ok(r.lines.includes('Jamnagar Refinery Expansion'));
});

test('Flate-compressed pages, objects packed in an object stream, and the information dictionary', () => {
  const r = readPdf(buildPdf({ pages: [{ content: at(40, 500, 'Notes only') }, { content: sheet, compress: true }], info: { Title: 'Pump house layout', Revision: 'D' }, objectStream: true }));
  assert.equal(r.pages, 2);
  assert.equal(r.infoTitle, 'Pump house layout');
  // the title block outranks the metadata
  assert.equal(r.title, 'GENERAL ARRANGEMENT PUMP HOUSE P-12');
  assert.equal(r.revision, 'C');
});

test('a title block inside a Form XObject', () => {
  const r = readPdf(buildPdf({ pages: [{ content: 'q 1 0 0 1 0 0 cm /TB Do Q', form: sheet, compress: true }] }));
  assert.equal(r.title, 'GENERAL ARRANGEMENT PUMP HOUSE P-12');
  assert.equal(r.number, 'DDS-JR-GA-101');
});

test('labels and values on one line: "Drawing title:", "Rev. B2", "Revision: 3", "REV. A"', () => {
  const cid = readPdf(buildPdf({ pages: [{ content: [atCid(50, 500, 'Drawing title: Pipe rack section'), atCid(50, 480, 'Rev. B2')].join('\n') }], cidFont: true }));
  assert.equal(cid.title, 'Pipe rack section');
  assert.equal(cid.revision, 'B2');
  const inline = readPdf(buildPdf({ pages: [{ content: [at(50, 500, 'TITLE: CABLE TRAY ROUTING'), at(50, 480, 'Revision: 3'), at(50, 460, 'Dwg No: E-204')].join('\n') }] }));
  assert.deepEqual([inline.title, inline.revision, inline.number], ['CABLE TRAY ROUTING', '3', 'E-204']);
  const cells = readPdf(buildPdf({ pages: [{ content: [at(50, 500, 'SHEET TITLE'), at(300, 500, 'FOUNDATION PLAN'), at(500, 500, 'REV. A')].join('\n') }] }));
  assert.equal(cells.title, 'FOUNDATION PLAN');
  assert.equal(cells.revision, 'A');
});

test('a revision schedule gives the latest revision; notes that mention revisions are ignored', () => {
  const content = drawingSheet({ title: ['PLOT PLAN'], rev: '', number: 'X-1', revTable: [['A', 'ISSUED FOR REVIEW', '2024-01-10'], ['B', 'ISSUED FOR CONSTRUCTION', '2024-03-02']] });
  const r = readPdf(buildPdf({ pages: [{ content }] }));
  assert.equal(r.title, 'PLOT PLAN');
  assert.equal(r.revision, 'B');
});

test('UTF-16 metadata and junk titles: tool names and file names are not titles', () => {
  const utf = readPdf(buildPdf({ pages: [{ content: at(50, 500, 'Hello') }], info: { Title: 'Site report — März' }, utf16Info: true }));
  assert.equal(utf.title, 'Site report — März');
  for (const junk of ['GA-101.dwg', 'Microsoft Word - Document1', 'Layout1', 'Untitled']) {
    const r = readPdf(buildPdf({ pages: [{ content: at(50, 500, 'Hello') }], info: { Title: junk } }));
    assert.equal(r.title, null, junk);
  }
});

test('the revision falls back to the file name', () => {
  const r = readPdf(buildPdf({ pages: [{ content: at(50, 500, 'Hello') }] }), 'GA-101_RevD.pdf');
  assert.equal(r.revision, 'D');
  assert.equal(readPdf(buildPdf({ pages: [{ content: at(50, 500, 'Hello') }] }), 'GA-101 Rev 3.pdf').revision, '3');
  assert.equal(readPdf(buildPdf({ pages: [{ content: at(50, 500, 'Hello') }] }), 'Review notes.pdf').revision, null);
});

test('words that only look like labels do not count', () => {
  const t = titleBlock(['Reviewed by: Priya', 'REVISION HISTORY', 'Project title: Jamnagar', 'Revisions are listed below'], null, {});
  assert.deepEqual(t, { title: null, revision: null, number: null });
});

test('files that are not PDFs, encrypted PDFs and broken PDFs are refused without crashing', () => {
  assert.throws(() => readPdf(Buffer.from('PK\u0003\u0004 a zip file')), PdfError);
  assert.throws(() => readPdf(buildPdf({ pages: [{ content: sheet }], encrypt: true })), /encrypted/);
  const good = buildPdf({ pages: [{ content: sheet, compress: true }], objectStream: true });
  for (const cut of [20, 200, Math.floor(good.length / 2), good.length - 30]) {
    const r = readPdf(good.subarray(0, cut));
    assert.equal(typeof r.pages, 'number');
  }
  // a stream that inflates to far more than it says is cut off, not read whole
  const bomb = zlib.deflateSync(Buffer.alloc(40 * 1024 * 1024, 0x20));
  const pdf = Buffer.concat([Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length ${bomb.length} /Filter /FlateDecode >>\nstream\n`), bomb, Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n')]);
  const r = readPdf(pdf);
  assert.equal(r.pages, 1);
  assert.deepEqual(r.lines, []);
  // deep nesting and self-referencing objects
  const deep = Buffer.from(`%PDF-1.4\n1 0 obj\n${'['.repeat(5000)}\nendobj\n2 0 obj\n<< /Length 2 0 R >>\nstream\nabc\nendstream\nendobj\ntrailer << /Root 1 0 R /Info 2 0 R >>\n`);
  assert.doesNotThrow(() => readPdf(deep));
});
