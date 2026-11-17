// Makes the built-in holiday list from the office's holiday circular PDF, with the same reader the
// hub uses when an administrator gives Nib next year's circular (no list is written by hand):
//   node apps/hub/scripts/holiday-seed.ts holidays-2026.pdf apps/hub/seed/holidays-2026.json
// It refuses a circular with rows in doubt: the seed is registered without anyone checking it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readCircular } from '@dex/core/holidays';
import { readPdf } from '../src/pdf.ts';

const [src, out] = process.argv.slice(2);
if (!src || !out) { console.error('usage: holiday-seed.ts <circular.pdf> <out.json>'); process.exit(2); }
const buf = fs.readFileSync(src);
const pdf = readPdf(buf, path.basename(src));
const read = readCircular(pdf.lines);
const doubt = read.rows.filter((r) => r.problems.length);
if (!read.rows.length || doubt.length || read.warnings.length) {
  console.error('The circular has rows in doubt:', JSON.stringify({ warnings: read.warnings, doubt }, null, 1));
  process.exit(1);
}
const seed = { source: { file: path.basename(src), hash: crypto.createHash('sha256').update(buf).digest('hex'), ref: read.ref, refDate: read.refDate, pages: pdf.pages }, read };
fs.writeFileSync(out, `${JSON.stringify(seed, null, 1)}\n`);
console.log(`${read.rows.length} days of ${read.year} from Ref ${read.ref} (${read.refDate}) written to ${out}`);
