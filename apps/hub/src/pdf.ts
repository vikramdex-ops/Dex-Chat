// Reading a PDF's title block on the hub: the document information dictionary, XMP metadata
// and the text drawn on the first pages (plain and Flate-compressed content streams, object
// streams, Form XObjects and fonts with ToUnicode maps). It reads what a drawing's title block
// says ("Drawing title", "Rev", "Revision", "REV. A", "Dwg No.") for Automations. Pure
// JavaScript with node:zlib, bounded in size and work so a hostile file cannot stall the hub.
import zlib from 'node:zlib';

export class PdfError extends Error {}

export interface PdfTitleBlock {
  title: string | null;
  revision: string | null;
  /** Drawing or document number. */
  number: string | null;
  pages: number;
  /** /Title from the document information (or XMP), when it looks like a real title. */
  infoTitle: string | null;
  /** The text found, line by line, top of each page first. */
  lines: string[];
}

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_STREAM = 16 * 1024 * 1024;
const MAX_TEXT_PAGES = 12;
const MAX_LINES = 4000;
const MAX_OBJECTS = 200_000;

// ------------------------------------------------------------------ objects
type Ref = { ref: [number, number] };
type PdfValue = null | boolean | number | string | PdfName | PdfString | PdfValue[] | PdfDict | Ref;
class PdfName { readonly name: string; constructor(name: string) { this.name = name; } }
class PdfString { readonly bytes: Buffer; constructor(bytes: Buffer) { this.bytes = bytes; } }
type PdfDict = { dict: Map<string, PdfValue> };

const isDict = (v: PdfValue | undefined): v is PdfDict => !!v && typeof v === 'object' && 'dict' in v;
const isRef = (v: PdfValue | undefined): v is Ref => !!v && typeof v === 'object' && 'ref' in v;
const nameOf = (v: PdfValue | undefined): string | null => (v instanceof PdfName ? v.name : null);

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

/** A small PDF object and content-stream lexer over a byte buffer. */
class Lexer {
  pos: number;
  readonly buf: Buffer;
  readonly end: number;
  constructor(buf: Buffer, pos = 0, end = buf.length) { this.buf = buf; this.pos = pos; this.end = end; }

  skip(): void {
    while (this.pos < this.end) {
      const c = this.buf[this.pos];
      if (WS.has(c)) { this.pos++; continue; }
      if (c === 0x25) { while (this.pos < this.end && this.buf[this.pos] !== 0x0a && this.buf[this.pos] !== 0x0d) this.pos++; continue; }
      break;
    }
  }

  /** The next token as a value, or an operator/keyword as a bare string prefixed with '#op:'. */
  next(depth = 0): PdfValue | { op: string } | undefined {
    this.skip();
    if (this.pos >= this.end) return undefined;
    if (depth > 64) throw new PdfError('nesting');
    const c = this.buf[this.pos];
    if (c === 0x2f) { // /Name
      let s = '';
      this.pos++;
      while (this.pos < this.end && !WS.has(this.buf[this.pos]) && !DELIM.has(this.buf[this.pos])) {
        if (this.buf[this.pos] === 0x23 && this.pos + 2 < this.end) { s += String.fromCharCode(parseInt(this.buf.toString('latin1', this.pos + 1, this.pos + 3), 16) || 0); this.pos += 3; continue; }
        s += String.fromCharCode(this.buf[this.pos++]);
      }
      return new PdfName(s);
    }
    if (c === 0x28) return this.literal();
    if (c === 0x3c) {
      if (this.buf[this.pos + 1] === 0x3c) { this.pos += 2; return this.dict(depth); }
      return this.hex();
    }
    if (c === 0x5b) {
      this.pos++;
      const arr: PdfValue[] = [];
      for (let n = 0; n < 100_000; n++) {
        this.skip();
        if (this.pos >= this.end) break;
        if (this.buf[this.pos] === 0x5d) { this.pos++; break; }
        const v = this.next(depth + 1);
        if (v === undefined) break;
        if (typeof v === 'object' && v !== null && 'op' in v) {
          if (v.op === 'R' && arr.length >= 2 && typeof arr[arr.length - 1] === 'number' && typeof arr[arr.length - 2] === 'number') {
            const gen = arr.pop() as number;
            const num = arr.pop() as number;
            arr.push({ ref: [num, gen] });
          }
          continue;
        }
        arr.push(v);
      }
      return arr;
    }
    if (c === 0x5d || c === 0x3e || c === 0x7b || c === 0x7d || c === 0x29) { this.pos++; return { op: String.fromCharCode(c) }; }
    // number or keyword
    const start = this.pos;
    while (this.pos < this.end && !WS.has(this.buf[this.pos]) && !DELIM.has(this.buf[this.pos])) this.pos++;
    const tok = this.buf.toString('latin1', start, this.pos);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) return Number(tok);
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    return { op: tok };
  }

  private dict(depth: number): PdfDict {
    const map = new Map<string, PdfValue>();
    const items: PdfValue[] = [];
    for (let n = 0; n < 100_000; n++) {
      this.skip();
      if (this.pos >= this.end) break;
      if (this.buf[this.pos] === 0x3e && this.buf[this.pos + 1] === 0x3e) { this.pos += 2; break; }
      const v = this.next(depth + 1);
      if (v === undefined) break;
      if (typeof v === 'object' && v !== null && 'op' in v) {
        if (v.op === 'R' && items.length >= 2 && typeof items[items.length - 1] === 'number' && typeof items[items.length - 2] === 'number') {
          const gen = items.pop() as number;
          const num = items.pop() as number;
          items.push({ ref: [num, gen] });
        }
        continue;
      }
      items.push(v);
    }
    for (let i = 0; i + 1 < items.length; i += 2) {
      const k = nameOf(items[i]);
      if (k !== null) map.set(k, items[i + 1]);
    }
    return { dict: map };
  }

  private literal(): PdfString {
    this.pos++;
    const out: number[] = [];
    let depth = 1;
    while (this.pos < this.end && out.length < 1_000_000) {
      const c = this.buf[this.pos++];
      if (c === 0x5c) {
        const n = this.buf[this.pos++];
        const map: Record<number, number> = { 0x6e: 0x0a, 0x72: 0x0d, 0x74: 0x09, 0x62: 0x08, 0x66: 0x0c, 0x28: 0x28, 0x29: 0x29, 0x5c: 0x5c };
        if (n in map) out.push(map[n]);
        else if (n >= 0x30 && n <= 0x37) {
          let oct = n - 0x30;
          for (let k = 0; k < 2 && this.buf[this.pos] >= 0x30 && this.buf[this.pos] <= 0x37; k++) oct = oct * 8 + (this.buf[this.pos++] - 0x30);
          out.push(oct & 0xff);
        } else if (n === 0x0d) { if (this.buf[this.pos] === 0x0a) this.pos++; } else if (n !== 0x0a && n !== undefined) out.push(n);
        continue;
      }
      if (c === 0x28) depth++;
      if (c === 0x29 && --depth === 0) break;
      out.push(c);
    }
    return new PdfString(Buffer.from(out));
  }

  private hex(): PdfString {
    this.pos++;
    let s = '';
    while (this.pos < this.end && this.buf[this.pos] !== 0x3e && s.length < 2_000_000) {
      const ch = String.fromCharCode(this.buf[this.pos++]);
      if (/[0-9a-f]/i.test(ch)) s += ch;
    }
    this.pos++;
    if (s.length % 2) s += '0';
    return new PdfString(Buffer.from(s, 'hex'));
  }
}

/** Text of a document-information string: UTF-16 with a byte-order mark, else PDFDocEncoding (≈ Latin-1). */
function decodeInfoString(b: Buffer): string {
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    const swapped = Buffer.from(b.subarray(2));
    if (swapped.length % 2) return '';
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.subarray(3).toString('utf8');
  return b.toString('latin1');
}

class PdfDoc {
  private readonly offsets = new Map<number, number>();
  private readonly fromStreams = new Map<number, PdfValue>();
  private readonly cache = new Map<number, { value: PdfValue; stream: Buffer | null }>();
  readonly text: string;
  readonly buf: Buffer;

  constructor(buf: Buffer) {
    this.buf = buf;
    this.text = buf.toString('latin1');
    const re = /(?:^|[\r\n])[ \t]*(\d{1,10})\s+(\d{1,5})\s+obj\b/g;
    let m: RegExpExecArray | null;
    let n = 0;
    while ((m = re.exec(this.text)) && n++ < MAX_OBJECTS) this.offsets.set(Number(m[1]), m.index + m[0].length);
    // objects kept inside compressed object streams (PDF 1.5 and later)
    for (const [num, off] of [...this.offsets]) {
      if (!this.text.slice(off, off + 400).includes('ObjStm')) continue;
      const o = this.object(num);
      if (!o || !isDict(o.value) || nameOf(o.value.dict.get('Type')) !== 'ObjStm' || !o.stream) continue;
      const data = this.decode(o.value, o.stream);
      if (!data) continue;
      const count = Math.min(Number(o.value.dict.get('N')) || 0, 50_000);
      const first = Number(o.value.dict.get('First')) || 0;
      const head = new Lexer(data, 0, Math.min(first, data.length));
      const pairs: Array<[number, number]> = [];
      for (let i = 0; i < count; i++) {
        const a = head.next();
        const b = head.next();
        if (typeof a !== 'number' || typeof b !== 'number') break;
        pairs.push([a, b]);
      }
      for (const [objNum, off] of pairs) {
        if (this.offsets.has(objNum) || this.fromStreams.has(objNum)) continue;
        try {
          const v = new Lexer(data, first + off).next();
          if (v !== undefined && !(typeof v === 'object' && v !== null && 'op' in v)) this.fromStreams.set(objNum, v);
        } catch { /* skip a broken entry */ }
      }
    }
  }

  object(num: number): { value: PdfValue; stream: Buffer | null } | null {
    const hit = this.cache.get(num);
    if (hit) return hit;
    const fromStream = this.fromStreams.get(num);
    if (fromStream !== undefined) return { value: fromStream, stream: null };
    const off = this.offsets.get(num);
    if (off === undefined) return null;
    this.cache.set(num, { value: null, stream: null }); // guards against a /Length that refers to itself
    let value: PdfValue = null;
    let stream: Buffer | null = null;
    try {
      const lx = new Lexer(this.buf, off);
      const v = lx.next();
      if (v !== undefined && !(typeof v === 'object' && v !== null && 'op' in v)) value = v;
      // "1 0 R" as the whole object
      if (typeof value === 'number') {
        const save = lx.pos;
        const g = lx.next();
        const r = lx.next();
        if (typeof g === 'number' && r && typeof r === 'object' && 'op' in r && r.op === 'R') value = { ref: [value, g] };
        else lx.pos = save;
      }
      if (isDict(value)) {
        lx.skip();
        if (this.text.startsWith('stream', lx.pos)) {
          let start = lx.pos + 6;
          if (this.buf[start] === 0x0d) start++;
          if (this.buf[start] === 0x0a) start++;
          let len = this.resolve(value.dict.get('Length'));
          if (typeof len !== 'number' || len < 0 || start + len > this.buf.length || !this.text.startsWith('endstream', this.skipWs(start + len))) {
            const e = this.text.indexOf('endstream', start);
            len = (e < 0 ? this.buf.length : e) - start;
            while (len > 0 && (this.buf[start + len - 1] === 0x0a || this.buf[start + len - 1] === 0x0d)) len--;
          }
          stream = this.buf.subarray(start, start + Math.max(0, len as number));
        }
      }
    } catch { value = null; }
    const out = { value, stream };
    this.cache.set(num, out);
    return out;
  }

  private skipWs(p: number): number { while (p < this.buf.length && WS.has(this.buf[p])) p++; return p; }

  resolve(v: PdfValue | undefined, hops = 0): PdfValue | undefined {
    let cur = v;
    for (let i = hops; i < 16 && isRef(cur); i++) cur = this.object(cur.ref[0])?.value ?? undefined;
    return isRef(cur) ? undefined : cur;
  }

  /** A stream's bytes after its filters (Flate, ASCIIHex, ASCII85), or null when it cannot be read. */
  decode(d: PdfDict, raw: Buffer): Buffer | null {
    const f = this.resolve(d.dict.get('Filter'));
    const filters = (Array.isArray(f) ? f : f ? [f] : []).map((x) => nameOf(this.resolve(x)));
    let data = raw;
    for (const name of filters) {
      try {
        if (name === 'FlateDecode' || name === 'Fl') {
          try { data = zlib.inflateSync(data, { maxOutputLength: MAX_STREAM }); } catch { data = zlib.inflateRawSync(data.subarray(2), { maxOutputLength: MAX_STREAM }); }
        } else if (name === 'ASCIIHexDecode' || name === 'AHx') {
          const hex = data.toString('latin1').replace(/>.*$/s, '').replace(/[^0-9a-f]/gi, '');
          data = Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex');
        } else if (name === 'ASCII85Decode' || name === 'A85') {
          data = ascii85(data);
        } else return null;
      } catch { return null; }
      if (data.length > MAX_STREAM) return null;
    }
    return data;
  }

  streamOf(v: PdfValue | undefined): Buffer | null {
    if (!isRef(v)) return null;
    const o = this.object(v.ref[0]);
    if (!o?.stream || !isDict(o.value)) return null;
    return this.decode(o.value, o.stream);
  }

  dictOf(v: PdfValue | undefined): PdfDict | null {
    const r = this.resolve(v);
    return isDict(r) ? r : null;
  }

  /** The last trailer (or cross-reference stream) entry with this key. */
  trailerRef(key: string): number | null {
    const re = new RegExp(`/${key}\\s+(\\d+)\\s+(\\d+)\\s+R`, 'g');
    let last: number | null = null;
    let m: RegExpExecArray | null;
    while ((m = re.exec(this.text))) last = Number(m[1]);
    return last;
  }
}

function ascii85(data: Buffer): Buffer {
  const s = data.toString('latin1').replace(/\s/g, '').replace(/^<~/, '').replace(/~>.*$/s, '');
  const out: number[] = [];
  let group: number[] = [];
  for (const ch of s) {
    if (ch === 'z' && group.length === 0) { out.push(0, 0, 0, 0); continue; }
    const c = ch.charCodeAt(0) - 33;
    if (c < 0 || c > 84) continue;
    group.push(c);
    if (group.length === 5) {
      let n = 0;
      for (const g of group) n = n * 85 + g;
      out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
      group = [];
    }
  }
  if (group.length) {
    const pad = 5 - group.length;
    while (group.length < 5) group.push(84);
    let n = 0;
    for (const g of group) n = n * 85 + g;
    const bytes = [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
    out.push(...bytes.slice(0, 4 - pad));
  }
  return Buffer.from(out);
}

// ------------------------------------------------------------------ fonts and text
interface Font { bytes: 1 | 2; map: Map<number, string> | null }

function parseCMap(data: Buffer): { bytes: 1 | 2; map: Map<number, string> } {
  const s = data.toString('latin1');
  const map = new Map<number, string>();
  const utf16 = (hex: string) => {
    const b = Buffer.from(hex.length % 4 ? hex.padStart(Math.ceil(hex.length / 4) * 4, '0') : hex, 'hex');
    b.swap16();
    return b.toString('utf16le');
  };
  let bytes: 1 | 2 = 1;
  const space = /begincodespacerange\s*<([0-9a-f]+)>/i.exec(s);
  if (space && space[1].length >= 4) bytes = 2;
  for (const block of s.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]*)>/gi)) {
      if (map.size > 70_000) break;
      if (m[1].length >= 4) bytes = 2;
      map.set(parseInt(m[1], 16), utf16(m[2]));
    }
  }
  for (const block of s.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*(<([0-9a-f]*)>|\[([^\]]*)\])/gi)) {
      const lo = parseInt(m[1], 16);
      const hi = Math.min(parseInt(m[2], 16), lo + 65_535);
      if (m[1].length >= 4) bytes = 2;
      if (m[4] !== undefined) {
        const base = Buffer.from(m[4].length % 4 ? m[4].padStart(Math.ceil(m[4].length / 4) * 4, '0') : m[4], 'hex');
        for (let c = lo; c <= hi && map.size < 70_000; c++) {
          const b = Buffer.from(base);
          const last = b.length - 2;
          if (last >= 0) b.writeUInt16BE((b.readUInt16BE(last) + (c - lo)) & 0xffff, last);
          b.swap16();
          map.set(c, b.toString('utf16le'));
        }
      } else if (m[5] !== undefined) {
        const items = [...m[5].matchAll(/<([0-9a-f]*)>/gi)].map((x) => utf16(x[1]));
        items.forEach((t, i) => { if (lo + i <= hi) map.set(lo + i, t); });
      }
    }
  }
  return { bytes, map };
}

const WIN_ANSI_EXTRA: Record<number, string> = { 0x80: '€', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x99: '™' };

function showText(font: Font | undefined, b: Buffer): string {
  if (font?.map) {
    let out = '';
    for (let i = 0; i + font.bytes - 1 < b.length; i += font.bytes) {
      const code = font.bytes === 2 ? b.readUInt16BE(i) : b[i];
      out += font.map.get(code) ?? (font.bytes === 1 ? String.fromCharCode(code) : '');
    }
    return out;
  }
  if (font?.bytes === 2) return ''; // a two-byte font without a map: the glyph codes say nothing
  let out = '';
  for (const c of b) out += WIN_ANSI_EXTRA[c] ?? String.fromCharCode(c);
  return out;
}

type Mat = [number, number, number, number, number, number];
const mul = (a: Mat, b: Mat): Mat => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];
const ID: Mat = [1, 0, 0, 1, 0, 0];

interface Fragment { x: number; y: number; size: number; text: string; seq: number }

class PageText {
  readonly frags: Fragment[] = [];
  private seq = 0;
  private work = 0;
  private readonly doc: PdfDoc;
  constructor(doc: PdfDoc) { this.doc = doc; }

  fonts(resources: PdfDict | null): Map<string, Font> {
    const out = new Map<string, Font>();
    const fontDict = this.doc.dictOf(resources?.dict.get('Font'));
    if (!fontDict) return out;
    for (const [name, ref] of fontDict.dict) {
      const f = this.doc.dictOf(ref);
      if (!f) continue;
      const two = nameOf(this.doc.resolve(f.dict.get('Subtype'))) === 'Type0';
      const cm = this.doc.streamOf(f.dict.get('ToUnicode'));
      if (cm) {
        const parsed = parseCMap(cm);
        out.set(name, { bytes: two ? 2 : parsed.bytes, map: parsed.map });
      } else out.set(name, { bytes: two ? 2 : 1, map: null });
    }
    return out;
  }

  run(content: Buffer, resources: PdfDict | null, ctm0: Mat, depth: number): void {
    if (depth > 4) return;
    const fonts = this.fonts(resources);
    const lx = new Lexer(content);
    const ops: PdfValue[] = [];
    let ctm = ctm0;
    const stack: Mat[] = [];
    let tm: Mat = ID;
    let lm: Mat = ID;
    let font: Font | undefined;
    let size = 12;
    let leading = 0;
    let penX = 0;
    const emit = (s: string) => {
      if (!s) return;
      const m = mul(tm, ctm);
      const scale = Math.hypot(m[2], m[3]) || 1;
      const fs = Math.abs(size) * scale || 1;
      this.frags.push({ x: m[4] + penX * (Math.hypot(m[0], m[1]) || 1), y: m[5], size: fs, text: s, seq: this.seq++ });
      penX += s.length * Math.abs(size) * 0.5;
    };
    const nextLine = (tx: number, ty: number) => { lm = mul([1, 0, 0, 1, tx, ty], lm); tm = lm; penX = 0; };
    for (;;) {
      if (++this.work > 2_000_000) return;
      let tok: ReturnType<Lexer['next']>;
      try { tok = lx.next(); } catch { return; }
      if (tok === undefined) break;
      if (!(tok && typeof tok === 'object' && 'op' in tok)) { if (ops.length < 64) ops.push(tok); continue; }
      const op = tok.op;
      const num = (i: number) => (typeof ops[i] === 'number' ? ops[i] as number : 0);
      switch (op) {
        case 'q': if (stack.length < 64) stack.push(ctm); break;
        case 'Q': ctm = stack.pop() ?? ctm0; break;
        case 'cm': if (ops.length >= 6) ctm = mul([num(ops.length - 6), num(ops.length - 5), num(ops.length - 4), num(ops.length - 3), num(ops.length - 2), num(ops.length - 1)], ctm); break;
        case 'BT': tm = ID; lm = ID; penX = 0; break;
        case 'Tf': {
          const n = nameOf(ops[ops.length - 2]);
          if (n) font = fonts.get(n);
          size = num(ops.length - 1) || size;
          break;
        }
        case 'TL': leading = num(ops.length - 1); break;
        case 'Td': nextLine(num(ops.length - 2), num(ops.length - 1)); break;
        case 'TD': leading = -num(ops.length - 1); nextLine(num(ops.length - 2), num(ops.length - 1)); break;
        case 'Tm': if (ops.length >= 6) { lm = [num(ops.length - 6), num(ops.length - 5), num(ops.length - 4), num(ops.length - 3), num(ops.length - 2), num(ops.length - 1)]; tm = lm; penX = 0; } break;
        case 'T*': nextLine(0, -leading); break;
        case 'Tj': { const s = ops[ops.length - 1]; if (s instanceof PdfString) emit(showText(font, s.bytes)); break; }
        case "'": { nextLine(0, -leading); const s = ops[ops.length - 1]; if (s instanceof PdfString) emit(showText(font, s.bytes)); break; }
        case '"': { nextLine(0, -leading); const s = ops[ops.length - 1]; if (s instanceof PdfString) emit(showText(font, s.bytes)); break; }
        case 'TJ': {
          const arr = ops[ops.length - 1];
          if (!Array.isArray(arr)) break;
          let s = '';
          for (const part of arr) {
            if (part instanceof PdfString) s += showText(font, part.bytes);
            else if (typeof part === 'number' && part < -180 && s && !s.endsWith(' ')) s += ' ';
          }
          emit(s);
          break;
        }
        case 'Do': {
          const n = nameOf(ops[ops.length - 1]);
          const xo = n ? this.doc.dictOf(this.doc.dictOf(resources?.dict.get('XObject'))?.dict.get(n)) : null;
          const ref = n ? this.doc.dictOf(resources?.dict.get('XObject'))?.dict.get(n) : undefined;
          if (xo && nameOf(this.doc.resolve(xo.dict.get('Subtype'))) === 'Form') {
            const data = this.doc.streamOf(ref);
            const mtx = this.doc.resolve(xo.dict.get('Matrix'));
            const m: Mat = Array.isArray(mtx) && mtx.length === 6 && mtx.every((x) => typeof x === 'number') ? mtx as Mat : ID;
            if (data) this.run(data, this.doc.dictOf(xo.dict.get('Resources')) ?? resources, mul(m, ctm), depth + 1);
          }
          break;
        }
        default: break;
      }
      ops.length = 0;
    }
  }

  /** Fragments grouped into lines, top to bottom, left to right. */
  lines(): string[] {
    const frags = this.frags.filter((f) => f.text.trim());
    if (!frags.length) return [];
    frags.sort((a, b) => b.y - a.y || a.x - b.x || a.seq - b.seq);
    const rows: Fragment[][] = [];
    for (const f of frags) {
      const row = rows[rows.length - 1];
      if (row && Math.abs(row[0].y - f.y) <= Math.max(1.5, Math.min(row[0].size, f.size) * 0.35)) row.push(f);
      else rows.push([f]);
    }
    const out: string[] = [];
    for (const row of rows) {
      row.sort((a, b) => a.x - b.x || a.seq - b.seq);
      // separate cells far apart on the same line with a wide gap, so labels and values stay apart
      let line = '';
      let end = -Infinity;
      for (const f of row) {
        const gap = f.x - end;
        if (line && gap > f.size * 2.5) line += '   ';
        else if (line && gap > f.size * 0.2 && !line.endsWith(' ') && !f.text.startsWith(' ')) line += ' ';
        line += f.text;
        end = f.x + f.text.length * f.size * 0.5;
      }
      const clean = line.replace(/[\u0000-\u001f]/g, ' ').replace(/[ \t]+$/g, '').replace(/^\s+/, '');
      if (clean) out.push(clean);
    }
    return out;
  }
}

// ------------------------------------------------------------------ title block
const JUNK_TITLE = /^(untitled|title|document\d*|drawing\d*|layout\s*\d*|model|sheet\s*\d*|microsoft\s+(word|excel|powerpoint)\b.*|.*\.(dwg|dxf|docx?|xlsx?|pptx?|rvt|pdf|tmp))$/i;
const TITLE_LABEL = String.raw`(?:drawing|dwg\.?|sheet|document|doc\.?)?\s*title`;
const REV_LABEL = String.raw`rev(?:ision)?\.?(?:\s*(?:no\.?|number|#))?`;
const NUM_LABEL = String.raw`(?:drawing|dwg\.?|document|doc\.?)\s*(?:no\.?|number|#)`;
const LABELS = new RegExp(`(?<![\\p{L}])(${NUM_LABEL}|${TITLE_LABEL}|${REV_LABEL})(?![\\p{L}])\\s*[:.\\-–]?\\s*`, 'giu');
const REV_CODE = /^(?:[A-Z]{1,2}\d{0,2}|\d{1,3}|[A-Z]\d?\.\d{1,2}|[PC]\d{1,3})$/i;
const TABLE_HEAD = /^(desc(ription)?|date|by|chk|checked|appd|approved|details?|issue|status|remarks?|change)\b/i;
const DATE_ISH = /\b(\d{1,4}[./-]\d{1,2}[./-]\d{1,4}|\d{1,2}\s+[a-z]{3,9}\s+\d{2,4}|[a-z]{3,9}\s+\d{1,2},?\s+\d{4})\b/i;

type Kind = 'title' | 'rev' | 'num';
const kindOf = (label: string): Kind => {
  const l = label.toLowerCase().replace(/\s+/g, ' ');
  if (/title/.test(l)) return 'title';
  if (/^rev/.test(l)) return 'rev';
  return 'num';
};

interface Found { value: string; score: number }

/** Read the title, revision and number from the text lines (and fall back to the metadata and the file name). */
export function titleBlock(lines: string[], infoTitle: string | null, info: Record<string, string>, fileName = ''): { title: string | null; revision: string | null; number: string | null } {
  const best: Record<Kind, Found | null> = { title: null, rev: null, num: null };
  const offer = (k: Kind, value: string, score: number) => {
    const v = value.replace(/\s{2,}/g, ' ').replace(/^[\s:.\-–]+|[\s:;,]+$/g, '').trim();
    if (!v) return;
    if (k === 'rev' && !REV_CODE.test(v)) return;
    if (k === 'title' && (v.length < 3 || v.length > 160 || TABLE_HEAD.test(v) || REV_CODE.test(v) && v.length < 4)) return;
    if (k === 'num' && (v.length < 2 || v.length > 60 || !/\d/.test(v))) return;
    if (!best[k] || best[k]!.score < score) best[k] = { value: k === 'rev' ? v.toUpperCase() : v, score };
  };
  const labelAt = (line: string) => { LABELS.lastIndex = 0; return LABELS.exec(line); };
  const capped = lines.slice(0, MAX_LINES);
  for (let i = 0; i < capped.length; i++) {
    const line = capped[i];
    // cells on a line are separated by wide gaps: "DRAWING TITLE: GA PLAN   REV: B"
    const cells = line.split(/\s{3,}/);
    for (let c = 0; c < cells.length; c++) {
      const cell = cells[c];
      LABELS.lastIndex = 0;
      const marks = [...cell.matchAll(LABELS)].filter((m) => m.index === 0 || /\s$/.test(cell.slice(0, m.index)));
      if (!marks.length || marks[0].index !== 0) continue;
      for (let j = 0; j < marks.length; j++) {
        const m = marks[j];
        const kind = kindOf(m[1]);
        const from = (m.index ?? 0) + m[0].length;
        const to = j + 1 < marks.length ? marks[j + 1].index ?? cell.length : cell.length;
        const inline = cell.slice(from, to).trim();
        const explicit = /[:.\-–]\s*$/.test(m[0]) || /[:]/.test(m[0]);
        if (inline) {
          // a revision table's header row: "REV  DESCRIPTION  DATE"
          if (kind === 'rev' && TABLE_HEAD.test(inline)) { revisionTable(capped, i, offer); continue; }
          offer(kind, kind === 'rev' ? inline.split(/\s+/)[0] : inline, explicit ? 4 : 3);
          continue;
        }
        // the value is in the next cell on the same line, or on the line below
        const nextCell = cells[c + 1]?.trim();
        if (nextCell && !labelAt(nextCell)) {
          if (kind === 'rev' && TABLE_HEAD.test(nextCell)) { revisionTable(capped, i, offer); continue; }
          offer(kind, kind === 'rev' ? nextCell.split(/\s+/)[0] : nextCell, 3);
          continue;
        }
        if (kind === 'title') {
          const parts: string[] = [];
          for (let k = i + 1; k < capped.length && parts.length < 3; k++) {
            const l = capped[k].split(/\s{3,}/)[0].trim();
            if (!l || labelAt(l) || REV_CODE.test(l) || DATE_ISH.test(l)) break;
            parts.push(l);
          }
          if (parts.length) offer('title', parts.join(' '), 2);
        } else {
          const below = capped[i + 1]?.split(/\s{3,}/)[Math.min(c, (capped[i + 1]?.split(/\s{3,}/).length ?? 1) - 1)]?.trim();
          if (below && !labelAt(below)) offer(kind, kind === 'rev' ? below.split(/\s+/)[0] : below, 2);
        }
      }
    }
  }
  // the document information: /Title, and custom keys some CAD tools write
  if (infoTitle) offer('title', infoTitle, 1);
  for (const [k, v] of Object.entries(info)) {
    if (/^rev(ision)?$/i.test(k)) offer('rev', v, 1);
    if (/^(drawing|dwg|document|doc)[\s_-]*(no|number)$/i.test(k)) offer('num', v, 1);
  }
  // "GA-101_RevB.pdf", "GA-101 Rev 3.pdf"
  const base = fileName.replace(/\.[a-z0-9]{1,10}$/i, '');
  const fr = /(?:^|[_\-\s.])rev(?:ision)?[_\-\s.]?([A-Z]{1,2}\d{0,2}|\d{1,3})(?=$|[_\-\s.])/i.exec(base);
  if (fr) offer('rev', fr[1], 0.5);
  return { title: best.title?.value ?? null, revision: best.rev?.value ?? null, number: best.num?.value ?? null };
}

/** Rows of a revision table under (or above) its header: the latest is the last row below, or the top row above. */
function revisionTable(lines: string[], header: number, offer: (k: Kind, v: string, s: number) => void): void {
  const row = (l: string | undefined) => {
    const first = l?.trim().split(/\s+/)[0] ?? '';
    return REV_CODE.test(first) && (l ?? '').trim().length > first.length ? first : null;
  };
  let latest: string | null = null;
  for (let k = header + 1; k < lines.length && k <= header + 20; k++) { const r = row(lines[k]); if (!r) break; latest = r; }
  if (!latest) for (let k = header - 1; k >= 0 && k >= header - 20; k--) { const r = row(lines[k]); if (!r) break; latest = r; }
  if (latest) offer('rev', latest, 1.5);
}

// ------------------------------------------------------------------ entry point
/** Read a PDF's title block. Throws PdfError when the file is not a PDF or cannot be read. */
export function readPdf(buf: Buffer, fileName = ''): PdfTitleBlock {
  if (buf.length > MAX_BYTES) throw new PdfError('The PDF is too large to read (over 64 MB).');
  if (!buf.subarray(0, 1024).toString('latin1').includes('%PDF-')) throw new PdfError('That file is not a PDF.');
  const doc = new PdfDoc(buf);
  if (/\/Encrypt\s*(<<|\d+\s+\d+\s+R)/.test(doc.text)) throw new PdfError('The PDF is encrypted, so its text cannot be read.');

  // the document information dictionary
  const info: Record<string, string> = {};
  const infoNum = doc.trailerRef('Info');
  const infoDict = infoNum !== null ? doc.dictOf({ ref: [infoNum, 0] }) : null;
  if (infoDict) {
    for (const [k, v] of infoDict.dict) {
      const r = doc.resolve(v);
      if (r instanceof PdfString) info[k] = decodeInfoString(r.bytes).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300);
    }
  }
  let infoTitle: string | null = info.Title && !JUNK_TITLE.test(info.Title) ? info.Title : null;
  if (!infoTitle) {
    const xmp = /<dc:title>\s*<rdf:Alt>\s*<rdf:li[^>]*>([^<]{1,300})<\/rdf:li>/.exec(doc.text);
    const t = xmp ? Buffer.from(xmp[1], 'latin1').toString('utf8').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() : '';
    if (t && !JUNK_TITLE.test(t)) infoTitle = t;
  }

  // the page tree, with inherited resources
  const pages: Array<{ dict: PdfDict; resources: PdfDict | null }> = [];
  const rootNum = doc.trailerRef('Root');
  const root = rootNum !== null ? doc.dictOf({ ref: [rootNum, 0] }) : null;
  let total = 0;
  const seen = new Set<PdfDict>();
  const walk = (node: PdfDict | null, inherited: PdfDict | null, depth: number) => {
    if (!node || depth > 32 || seen.has(node) || seen.size > 20_000) return;
    seen.add(node);
    const res = doc.dictOf(node.dict.get('Resources')) ?? inherited;
    const type = nameOf(doc.resolve(node.dict.get('Type')));
    if (type === 'Page' || (!type && node.dict.has('Contents'))) {
      total++;
      if (pages.length < MAX_TEXT_PAGES) pages.push({ dict: node, resources: res });
      return;
    }
    const kids = doc.resolve(node.dict.get('Kids'));
    if (Array.isArray(kids)) for (const k of kids) walk(doc.dictOf(k), res, depth + 1);
  };
  walk(root ? doc.dictOf(root.dict.get('Pages')) : null, null, 0);
  if (!pages.length) {
    // no usable page tree: fall back to every page object in the file
    for (const m of doc.text.matchAll(/(\d{1,10})\s+\d{1,5}\s+obj\s*<<(?:(?!endobj).){0,400}?\/Type\s*\/Page(?![s\w])/gs)) {
      const d = doc.dictOf({ ref: [Number(m[1]), 0] });
      if (d) { total++; if (pages.length < MAX_TEXT_PAGES) pages.push({ dict: d, resources: doc.dictOf(d.dict.get('Resources')) }); }
    }
  }

  const lines: string[] = [];
  for (const p of pages) {
    const pt = new PageText(doc);
    const contents = p.dict.dict.get('Contents');
    const parts = Array.isArray(doc.resolve(contents)) ? doc.resolve(contents) as PdfValue[] : [contents];
    const chunks: Buffer[] = [];
    for (const c of parts.slice(0, 200)) { const s = doc.streamOf(c as PdfValue); if (s) chunks.push(s); }
    pt.run(Buffer.concat(chunks.flatMap((c) => [c, Buffer.from('\n')])), p.resources, ID, 0);
    lines.push(...pt.lines());
    if (lines.length > MAX_LINES) break;
  }
  const tb = titleBlock(lines, infoTitle, info, fileName);
  return { ...tb, pages: total, infoTitle, lines: lines.slice(0, MAX_LINES) };
}
