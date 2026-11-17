// The test PDFs made in code, read by PDF.js itself: the A0 drawing sheet's words are found and
// boxed where they are drawn, the document has its pages, the protected file needs its password
// and the broken one is refused as not a PDF.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { a0Sheet, a4Document, brokenPdf, lockedPdf } from './pdf-fixtures.ts';
import { findMatches, matchBoxes, pageText } from '../src/renderer/pdf/textsearch.ts';
import type { TextRun } from '../src/renderer/pdf/textsearch.ts';
import { paperName } from '../src/renderer/pdf/tiles.ts';

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const open = (data: Uint8Array, password?: string) => pdfjs.getDocument({ data, password, verbosity: 0 }).promise;
const runs = async (page: { getTextContent(): Promise<{ items: unknown[] }> }) =>
  (await page.getTextContent()).items.filter((x) => typeof (x as { str?: unknown }).str === 'string') as TextRun[];

test('the A0 sheet: an A0 page whose tags are found and boxed where they are drawn', async () => {
  const doc = await open(a0Sheet());
  const page = await doc.getPage(1);
  assert.equal(paperName({ w: page.view[2], h: page.view[3] }), 'A0');
  const text = pageText(await runs(page));
  assert.equal(findMatches(text, 'v-2201', 0).length, 4);
  assert.equal(findMatches(text, 'pipe rack pr-03', 0).length, 1);
  assert.equal(findMatches(text, 'CHECKED', 0).length, 1);
  // "PIPE RACK PR-03" is drawn at x = 1500, baseline y = 1200, 28 pt
  const [box] = matchBoxes(text, findMatches(text, 'PIPE RACK', 0)[0], page.view);
  assert.ok(Math.abs(box.left * page.view[2] - 1500) < 1, `left ${box.left * page.view[2]}`);
  const bottom = (1 - (box.top + box.height)) * page.view[3];
  assert.ok(Math.abs(bottom - (1200 - 0.2 * 28)) < 1, `bottom ${bottom}`);
  // the vertical label gets a tall box
  const [v] = matchBoxes(text, findMatches(text, 'GRID LINE A', 0)[0], page.view);
  assert.ok(v.height * page.view[3] > v.width * page.view[2] * 3);
  await doc.loadingTask.destroy();
});

test('the A4 document has its pages; protected and broken PDFs are told apart', async () => {
  const doc = await open(a4Document(12));
  assert.equal(doc.numPages, 12);
  let hits = 0;
  for (let i = 1; i <= 12; i++) hits += findMatches(pageText(await runs(await doc.getPage(i))), 'flange schedule', i - 1).length;
  assert.equal(hits, 4);
  await doc.loadingTask.destroy();

  await assert.rejects(open(lockedPdf('site42')), (e: Error) => e.name === 'PasswordException');
  const locked = await open(lockedPdf('site42'), 'site42');
  assert.equal(findMatches(pageText(await runs(await locked.getPage(1))), 'confidential', 0).length, 1);
  await locked.loadingTask.destroy();
  await assert.rejects(open(lockedPdf('site42'), 'wrong'), (e: Error) => e.name === 'PasswordException');
  await assert.rejects(open(brokenPdf()), (e: Error) => e.name === 'InvalidPDFException');
});
