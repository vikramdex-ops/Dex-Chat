// PDFs made in code for the viewer's tests: a big A0 drawing sheet in vector lines with text
// (grid, pipe runs, tags, a title block), a multi-page A4 document, a password-protected PDF
// (the standard 40-bit security handler) and a file that only pretends to be a PDF.
// Fonts are the standard Helvetica, not embedded, as CAD programs often write them.
import { createHash } from 'node:crypto';

export interface FixturePage { w: number; h: number; ops: string }

const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
/** Text drawn at (x, y) in points, size pt, optionally turned a quarter turn (a vertical label). */
export const text = (x: number, y: number, size: number, s: string, vertical = false) =>
  vertical ? `BT /F1 ${size} Tf 0 1 -1 0 ${x} ${y} Tm (${esc(s)}) Tj ET\n` : `BT /F1 ${size} Tf ${x} ${y} Td (${esc(s)}) Tj ET\n`;

function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = Uint8Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; [s[i], s[j]] = [s[j], s[i]]; }
  const out = new Uint8Array(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 255; j = (j + s[i]) & 255; [s[i], s[j]] = [s[j], s[i]];
    out[n] = data[n] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}
const md5 = (...parts: Uint8Array[]) => { const h = createHash('md5'); for (const p of parts) h.update(p); return new Uint8Array(h.digest()); };
const PAD = Uint8Array.from([0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a]);
const padded = (pw: string) => { const b = latin1(pw).slice(0, 32); const out = new Uint8Array(32); out.set(b); out.set(PAD.subarray(0, 32 - b.length), b.length); return out; };
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/** A PDF of these pages; with `password`, encrypted so that it opens only with it. */
export function makePdf(pages: FixturePage[], opts: { password?: string; title?: string } = {}): Uint8Array {
  const objs: Array<string | { dict: string; stream: Uint8Array }> = [];
  const add = (o: (typeof objs)[number]) => { objs.push(o); return objs.length; };
  const catalog = add('');
  const pagesId = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  for (const p of pages) {
    const content = add({ dict: '', stream: latin1(p.ops) });
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${p.w} ${p.h}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  const info = add(`<< /Title (${esc(opts.title ?? 'Dexterity test sheet')}) /Producer (Dexterity Connect tests) >>`);

  const id = md5(latin1(`${opts.title ?? ''}${pages.length}${pages[0]?.w}`));
  let key: Uint8Array | null = null;
  let encrypt = 0;
  if (opts.password !== undefined) {
    // standard security handler, revision 2 (RC4, 40-bit); owner password = user password
    const P = -44; // print and copy allowed
    const o = rc4(md5(padded(opts.password)).subarray(0, 5), padded(opts.password));
    const p4 = new Uint8Array(4);
    new DataView(p4.buffer).setInt32(0, P, true);
    key = md5(padded(opts.password), o, p4, id).subarray(0, 5);
    const u = rc4(key, PAD);
    encrypt = add(`<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${hex(o)}> /U <${hex(u)}> /P ${P} >>`);
  }
  const objKey = (n: number) => { const k = new Uint8Array(key!.length + 5); k.set(key!); k.set([n & 255, (n >> 8) & 255, (n >> 16) & 255, 0, 0], key!.length); return md5(k).subarray(0, Math.min(16, key!.length + 5)); };

  const chunks: Uint8Array[] = [latin1('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')];
  let at = chunks[0].length;
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    const n = i + 1;
    offsets.push(at);
    let body: Uint8Array;
    if (typeof o === 'string') {
      // the Info title is a string: encrypted too when the file is
      let s = o;
      if (key && n === info) s = `<< /Title <${hex(rc4(objKey(n), latin1(opts.title ?? 'Dexterity test sheet')))}> >>`;
      body = latin1(`${n} 0 obj\n${s}\nendobj\n`);
    } else {
      const data = key && n !== encrypt ? rc4(objKey(n), o.stream) : o.stream;
      const head = latin1(`${n} 0 obj\n<< /Length ${data.length} >>\nstream\n`);
      const tail = latin1('\nendstream\nendobj\n');
      body = new Uint8Array(head.length + data.length + tail.length);
      body.set(head); body.set(data, head.length); body.set(tail, head.length + data.length);
    }
    chunks.push(body);
    at += body.length;
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  const trailer = `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R${encrypt ? ` /Encrypt ${encrypt} 0 R` : ''} /ID [<${hex(id)}> <${hex(id)}>] >>\nstartxref\n${at}\n%%EOF\n`;
  chunks.push(latin1(xref + trailer));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

export const A0 = { w: 2384, h: 3370 };
export const A4 = { w: 595, h: 842 };

/**
 * An A0 sheet (landscape, 3370 × 2384 pt) of a piping plan: a grid every 200 pt with bubbles,
 * a few thousand pipe and steel lines, valve tags, a vertical label and a title block.
 * Words to find: "V-2201" appears 4 times, "PIPE RACK PR-03" once, "CHECKED" once.
 */
export function a0Sheet(): Uint8Array {
  const W = A0.h;
  const H = A0.w;
  let ops = '0.5 w 0 0 0 RG\n';
  ops += `20 20 ${W - 40} ${H - 40} re S\n2 w 40 40 ${W - 80} ${H - 80} re S\n0.25 w\n`;
  // structural grid with bubbles
  for (let x = 200, n = 1; x < W - 100; x += 200, n++) {
    ops += `${x} 80 m ${x} ${H - 80} l S\n${x - 14} ${H - 74} 28 28 re S\n`;
    ops += text(x - 4, H - 66, 12, String(n));
  }
  for (let y = 200, n = 0; y < H - 100; y += 200, n++) {
    ops += `80 ${y} m ${W - 80} ${y} l S\n`;
    ops += text(50, y - 4, 12, String.fromCharCode(65 + n));
  }
  // a dense field of pipe runs and steel (vector work that takes a while to draw)
  let seed = 7;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  ops += '0.6 w 0.1 0.3 0.6 RG\n';
  for (let i = 0; i < 3000; i++) {
    const x = 120 + rnd() * (W - 400);
    const y = 120 + rnd() * (H - 600);
    const len = 40 + rnd() * 260;
    ops += rnd() > 0.5 ? `${x.toFixed(1)} ${y.toFixed(1)} m ${(x + len).toFixed(1)} ${y.toFixed(1)} l S\n` : `${x.toFixed(1)} ${y.toFixed(1)} m ${x.toFixed(1)} ${(y + len).toFixed(1)} l S\n`;
  }
  ops += '0 0 0 RG\n';
  // tags
  const tags: Array<[number, number, string]> = [[420, 610, 'V-2201'], [1210, 1530, 'V-2201'], [2650, 880, 'V-2201'], [3010, 1700, 'V-2201'], [900, 1100, 'P-101A'], [1600, 400, 'E-305'], [2200, 1900, 'LINE 6"-P-2201-A1A']];
  for (const [x, y, t] of tags) ops += `${x - 6} ${y - 6} 70 22 re S\n` + text(x, y, 11, t);
  for (let i = 0; i < 120; i++) ops += text(150 + (i % 15) * 200, 240 + Math.floor(i / 15) * 200, 7, `EL +${(100 + i * 0.25).toFixed(2)}`);
  ops += text(1500, 1200, 28, 'PIPE RACK PR-03');
  ops += text(120, 900, 14, 'GRID LINE A TO F', true);
  // title block, bottom right
  const tx = W - 900;
  ops += `1.5 w ${tx} 40 860 300 re S\n0.5 w ${tx} 140 m ${W - 40} 140 l S\n${tx} 240 m ${W - 40} 240 l S\n${tx + 430} 40 m ${tx + 430} 240 l S\n`;
  ops += text(tx + 20, 280, 26, 'DEXTERITY DESIGN SERVICES');
  ops += text(tx + 20, 190, 16, 'PIPING GENERAL ARRANGEMENT - AREA 3');
  ops += text(tx + 20, 90, 12, 'DRAWN  RK   CHECKED  VS   SCALE 1:50');
  ops += text(tx + 450, 90, 14, 'DWG P12-GA-0301  REV C');
  return makePdf([{ w: W, h: H, ops }], { title: 'P12-GA-0301' });
}

/** A document of `n` A4 pages; page k says "Page k of n" and every third page mentions the "flange schedule". */
export function a4Document(n = 12): Uint8Array {
  const pages: FixturePage[] = [];
  for (let k = 1; k <= n; k++) {
    let ops = text(72, 770, 20, `Inspection report, page ${k}`);
    ops += text(72, 740, 11, `Page ${k} of ${n}`);
    for (let l = 0; l < 30; l++) ops += text(72, 700 - l * 20, 10, `Line ${l + 1}: weld ${k}-${l + 1} accepted, hydro test passed at 15 bar.`);
    if (k % 3 === 0) ops += text(72, 80, 12, 'See the flange schedule for bolt torques.');
    ops += `0.5 w 60 60 ${A4.w - 120} ${A4.h - 120} re S\n`;
    pages.push({ w: A4.w, h: A4.h, ops });
  }
  return makePdf(pages, { title: 'Inspection report' });
}

/** One A4 page that opens only with `password`. */
export function lockedPdf(password = 'site42'): Uint8Array {
  return makePdf([{ w: A4.w, h: A4.h, ops: text(72, 760, 18, 'Tender figures - confidential') }], { password, title: 'Tender' });
}

/** Bytes that start like a PDF and are not one. */
export function brokenPdf(): Uint8Array {
  const junk = new Uint8Array(4096);
  let s = 3;
  for (let i = 0; i < junk.length; i++) junk[i] = (s = (s * 1103515245 + 12345) & 0x7fffffff) & 255;
  const head = latin1('%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R');
  const out = new Uint8Array(head.length + junk.length);
  out.set(head); out.set(junk, head.length);
  return out;
}
