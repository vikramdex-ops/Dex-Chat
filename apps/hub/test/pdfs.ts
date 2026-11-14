// Builds small PDFs in code for the tests: plain or Flate-compressed pages, a document information
// dictionary, objects packed into an object stream, a title block drawn in a Form XObject, and a
// two-byte font with a ToUnicode map (as CAD and office tools export them).
import zlib from 'node:zlib';

export interface PdfPage {
  /** The page's content stream (PDF operators). */
  content: string;
  compress?: boolean;
  /** A Form XObject named /TB drawn by the content with "/TB Do". */
  form?: string;
}

export interface PdfSpec {
  pages: PdfPage[];
  info?: Record<string, string>;
  /** Write the information dictionary's strings as UTF-16 with a byte-order mark. */
  utf16Info?: boolean;
  /** Put the catalog, page tree and information into a compressed object stream. */
  objectStream?: boolean;
  /** Use a Type0 font with two-byte codes and a ToUnicode map for /F2. */
  cidFont?: boolean;
  encrypt?: boolean;
}

const lit = (s: string) => `(${s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')})`;
const utf16 = (s: string) => {
  const b = Buffer.from(s, 'utf16le');
  b.swap16();
  return `<FEFF${b.toString('hex').toUpperCase()}>`;
};

/** Text drawn at a position: "BT /F1 9 Tf 1 0 0 1 x y Tm (text) Tj ET". */
export const at = (x: number, y: number, text: string, size = 9, font = 'F1') => `BT /${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm ${lit(text)} Tj ET`;

/** Text in a two-byte font: each character's code is its UTF-16 unit + 0x100, mapped back by ToUnicode. */
export const atCid = (x: number, y: number, text: string, size = 9) => {
  const hex = [...text].map((c) => (c.charCodeAt(0) + 0x100).toString(16).padStart(4, '0')).join('');
  return `BT /F2 ${size} Tf ${x} ${y} Td <${hex}> Tj ET`;
};

export function buildPdf(spec: PdfSpec): Buffer {
  const objs: Array<{ num: number; body: string | Buffer; inStream?: boolean }> = [];
  let next = 1;
  const add = (body: string | Buffer, inStream = false) => { const num = next++; objs.push({ num, body, inStream }); return num; };
  const stream = (dict: string, data: string, compress: boolean) => {
    const raw = Buffer.from(data, 'latin1');
    const bytes = compress ? zlib.deflateSync(raw) : raw;
    return Buffer.concat([Buffer.from(`<< ${dict} /Length ${bytes.length}${compress ? ' /Filter /FlateDecode' : ''} >>\nstream\n`, 'latin1'), bytes, Buffer.from('\nendstream', 'latin1')]);
  };
  const os = !!spec.objectStream;
  const font1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>', os);
  let font2 = 0;
  if (spec.cidFont) {
    const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Test def
1 begincodespacerange <0000> <FFFF> endcodespacerange
1 beginbfrange <0120> <017E> <0020> endbfrange
endcmap CMapName currentdict /CMap defineresource pop end end`;
    const toUni = add(stream('', cmap, true));
    font2 = add(`<< /Type /Font /Subtype /Type0 /BaseFont /Test /Encoding /Identity-H /ToUnicode ${toUni} 0 R /DescendantFonts [] >>`, os);
  }
  const fonts = `/Font << /F1 ${font1} 0 R${font2 ? ` /F2 ${font2} 0 R` : ''} >>`;
  const pagesNum = next + spec.pages.length * 3 + 1;
  const pageNums: number[] = [];
  for (const p of spec.pages) {
    let xo = '';
    if (p.form) {
      const f = add(stream(`/Type /XObject /Subtype /Form /BBox [0 0 842 595] /Resources << ${fonts} >>`, p.form, !!p.compress));
      xo = ` /XObject << /TB ${f} 0 R >>`;
    }
    const c = add(stream('', p.content, !!p.compress));
    pageNums.push(add(`<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 842 595] /Contents ${c} 0 R /Resources << ${fonts}${xo} >> >>`, os));
  }
  while (next < pagesNum) add('null');
  add(`<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageNums.length} >>`, os);
  const catalog = add(`<< /Type /Catalog /Pages ${pagesNum} 0 R >>`, os);
  let infoNum = 0;
  if (spec.info) {
    infoNum = add(`<< ${Object.entries(spec.info).map(([k, v]) => `/${k} ${spec.utf16Info ? utf16(v) : lit(v)}`).join(' ')} >>`, os);
  }
  // pack the marked objects into one object stream
  const packed = objs.filter((o) => o.inStream);
  if (packed.length) {
    let head = '';
    let bodies = '';
    for (const o of packed) { head += `${o.num} ${bodies.length} `; bodies += `${o.body as string}\n`; }
    const data = head + bodies;
    add(stream(`/Type /ObjStm /N ${packed.length} /First ${head.length}`, data, true));
  }
  let out = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1');
  const offsets = new Map<number, number>();
  for (const o of objs) {
    if (o.inStream) continue;
    offsets.set(o.num, out.length);
    out = Buffer.concat([out, Buffer.from(`${o.num} 0 obj\n`, 'latin1'), typeof o.body === 'string' ? Buffer.from(o.body, 'latin1') : o.body, Buffer.from('\nendobj\n', 'latin1')]);
  }
  const xref = out.length;
  let table = `xref\n0 ${next}\n0000000000 65535 f \n`;
  for (let i = 1; i < next; i++) table += `${String(offsets.get(i) ?? 0).padStart(10, '0')} 00000 ${offsets.has(i) ? 'n' : 'f'} \n`;
  const trailer = `trailer\n<< /Size ${next} /Root ${catalog} 0 R${infoNum ? ` /Info ${infoNum} 0 R` : ''}${spec.encrypt ? ' /Encrypt << /Filter /Standard /V 1 >>' : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.concat([out, Buffer.from(table + trailer, 'latin1')]);
}

/** A drawing sheet with a title block in the bottom right corner. */
export function drawingSheet(opts: { title: string[]; rev: string; number: string; revTable?: string[][] }): string {
  const lines = [
    at(40, 560, 'GENERAL NOTES', 10),
    at(40, 545, '1. ALL DIMENSIONS ARE IN MILLIMETRES UNLESS NOTED.', 8),
    at(40, 532, '2. REFER TO REVISION SCHEDULE FOR CHANGES.', 8),
    at(560, 150, 'CLIENT', 7), at(560, 140, 'Jamnagar Refinery Expansion', 9),
    at(560, 120, 'DRAWING TITLE', 7),
    ...opts.title.map((t, i) => at(560, 108 - i * 12, t, 11)),
    at(560, 60, 'DWG NO.', 7), at(700, 60, 'REV', 7),
    at(560, 48, opts.number, 11), at(700, 48, opts.rev, 11),
  ];
  if (opts.revTable) {
    lines.push(at(560, 300, 'REV', 7), at(600, 300, 'DESCRIPTION', 7), at(760, 300, 'DATE', 7));
    opts.revTable.forEach((r, i) => lines.push(at(560, 288 - i * 12, r[0], 8), at(600, 288 - i * 12, r[1], 8), at(760, 288 - i * 12, r[2], 8)));
  }
  return lines.join('\n');
}
