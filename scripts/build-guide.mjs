// Prints the user guide, docs/guide/guide.html, to docs/Dexterity-Connect-User-Guide.pdf.
//
//   npm run guide                      (or: node scripts/build-guide.mjs [--out file.pdf])
//
// Chromium comes from playwright-core: the browsers in PLAYWRIGHT_BROWSERS_PATH, or the one
// `npx playwright-core install chromium` downloads. Without either, set GUIDE_CHANNEL=chrome or
// GUIDE_CHANNEL=msedge to print with the Chrome or Edge installed on the PC.
//
// Pass 1 prints the guide and reads each page's text with PDF.js to find the page every numbered
// heading (2, 5.3 …) starts on. Pass 2 writes those numbers into the Contents and prints again; if
// that moved a heading, a third pass settles it. The running header, the footer and "Page X of N"
// are @page margin boxes in guide.css (so the cover has none), and Chromium writes the PDF outline
// from the headings. The PDF's time stamp is set to the guide's date, so the same source gives
// the same PDF, byte for byte.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUIDE = path.join(ROOT, 'docs', 'guide');
const SRC = path.join(GUIDE, 'guide.html');
const args = process.argv.slice(2);
const OUT = path.resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(ROOT, 'docs', 'Dexterity-Connect-User-Guide.pdf'));
const TOC_CELL = /<span class="toc-page" data-sec="([\d.]+)">[^<]*<\/span>/g;

const source = fs.readFileSync(SRC, 'utf8');
const meta = JSON.parse(source.match(/<script id="meta" type="application\/json">([\s\S]*?)<\/script>/)[1]);

const browser = await chromium.launch(process.env.GUIDE_CHANNEL ? { channel: process.env.GUIDE_CHANNEL } : {});
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dex-guide-'));
try {
  const page = await browser.newPage();

  /** Print this version of the guide (written beside the original, so its relative links work). */
  async function print(html, file) {
    const draft = path.join(GUIDE, '_print.html');
    fs.writeFileSync(draft, html);
    try {
      await page.goto(pathToFileURL(draft).href, { waitUntil: 'load' });
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; }))));
      });
      await page.pdf({ path: file, format: 'A4', printBackground: true, preferCSSPageSize: true, outline: true, tagged: true });
    } finally { fs.rmSync(draft, { force: true }); }
  }

  /** Where each numbered heading landed: "5" or "5.3" → 1-based page. */
  async function headingPages(file) {
    const task = getDocument({ data: new Uint8Array(fs.readFileSync(file)), verbosity: 0, isEvalSupported: false, useSystemFonts: false });
    const doc = await task.promise;
    const found = {};
    for (let n = 1; n <= doc.numPages; n++) {
      const pg = await doc.getPage(n);
      const { items } = await pg.getTextContent();
      // join the pieces of each line (same baseline), keeping the largest font size seen on it
      const lines = new Map();
      for (const it of items) {
        if (!('str' in it) || !it.str.trim()) continue;
        const y = Math.round(it.transform[5]);
        const size = Math.hypot(it.transform[2], it.transform[3]);
        const l = lines.get(y) ?? { x: it.transform[4], text: '', size: 0 };
        l.text += it.str; l.size = Math.max(l.size, size); l.x = Math.min(l.x, it.transform[4]);
        lines.set(y, l);
      }
      for (const l of lines.values()) {
        const m = l.text.trim().match(/^(\d{1,2}(?:\.\d{1,2})?)\s+\S/);
        // section headings are set at 19 pt and sub-sections at 13 pt; body text is 10 pt
        if (m && l.size >= 12.5) found[m[1]] ??= n;
      }
      pg.cleanup();
    }
    const pages = doc.numPages;
    await task.destroy();
    return { found, pages };
  }

  /** "15-Nov-2026" → "20261115000000" (a PDF date's digits). */
function dateStamp(text) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(text ?? '');
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  if (!m || !months.includes(m[2].toLowerCase())) throw new Error(`The guide's meta "date" should look like 15-Nov-2026, not ${text}`);
  return `${m[3]}${String(months.indexOf(m[2].toLowerCase()) + 1).padStart(2, '0')}${m[1].padStart(2, '0')}000000`;
}

const fill = (pages) => source.replace(TOC_CELL, (_, k) => `<span class="toc-page" data-sec="${k}">${pages[k] ?? ''}</span>`);

  const pass1 = path.join(tmp, 'pass1.pdf');
  await print(source, pass1);
  let { found } = await headingPages(pass1);
  const pass2 = path.join(tmp, 'pass2.pdf');
  await print(fill(found), pass2);
  let second = await headingPages(pass2);
  if (JSON.stringify(second.found) !== JSON.stringify(found)) {
    // filling the numbers moved a heading: one more pass settles it
    found = second.found;
    await print(fill(found), pass2);
    second = await headingPages(pass2);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  // the one thing that changes from print to print is the time stamp: use the guide's own date
  // (same length, so the PDF's byte offsets stay right)
  const stamp = dateStamp(meta.date);
  const pdf = fs.readFileSync(pass2, 'latin1').replace(/\/(CreationDate|ModDate) \(D:\d{14}/g, (_, k) => `/${k} (D:${stamp}`);
  fs.writeFileSync(OUT, pdf, 'latin1');

  const wanted = [...source.matchAll(TOC_CELL)].map((m) => m[1]);
  const missing = wanted.filter((k) => !(k in second.found));
  const kb = Math.round(fs.statSync(OUT).size / 1024);
  console.log(`${path.relative(ROOT, OUT)}: ${second.pages} pages, ${kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`} (${meta.title}, ${meta.doc_no} rev ${meta.rev})`);
  if (missing.length) { console.log(`Contents entries with no page found: ${missing.join(', ')}`); process.exitCode = 1; }
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
