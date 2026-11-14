// The first page of a PDF as a list of things to draw, for the drawing viewer: paths (lines,
// curves, fills and clips), text, and images (JPEG, or 8-bit grey/RGB/CMYK/indexed pixels).
// Engineering drawings are mostly vector linework and text, which this covers. Shadings,
// patterns and transparency groups are drawn plainly or left out; fonts are shown in a
// similar face rather than the embedded one.
//
// Both functions refer to nothing outside themselves: they are written into the viewer's page.

export type PdfOp =
  | { k: 'save' } | { k: 'restore' }
  | { k: 'path'; d: number[]; fill: string | null; stroke: string | null; lw: number; rule: 'nonzero' | 'evenodd'; fa: number; sa: number; dash: number[]; cap: number; join: number }
  | { k: 'clip'; d: number[]; rule: 'nonzero' | 'evenodd' }
  | { k: 'text'; s: string; m: number[]; fill: string; family: string; weight: string; style: string; fa: number }
  | { k: 'img'; m: number[]; jpeg?: Uint8Array; w?: number; h?: number; rgba?: Uint8ClampedArray };

export interface PdfPage { box: number[]; rotate: number; ops: PdfOp[]; pages: number; warnings: string[] }

/** Read the first page. Path data `d` is [0,x,y] move, [1,x,y] line, [2,x1,y1,x2,y2,x,y] curve, [3] close, in page units. */
export async function pdfFirstPage(bytes: Uint8Array): Promise<PdfPage> {
  type V = unknown;
  type Dict = Record<string, V>;
  const EOF = { eof: 1 };
  const DS = { ds: 1 };
  const DE = { de: 1 };
  const AS = { as: 1 };
  const AE = { ae: 1 };
  const warnings = new Set<string>();
  const isWs = (c: number) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
  const isDelim = (c: number) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
  const latin = (b: Uint8Array): string => { let s = ''; for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode(...b.subarray(i, i + 32768)); return s; };

  const lexer = (buf: Uint8Array, start: number) => {
    let pos = start;
    const skip = () => {
      while (pos < buf.length) {
        const c = buf[pos];
        if (isWs(c)) pos++;
        else if (c === 37) { while (pos < buf.length && buf[pos] !== 10 && buf[pos] !== 13) pos++; } else break;
      }
    };
    const next = (): V => {
      skip();
      if (pos >= buf.length) return EOF;
      const c = buf[pos];
      if (c === 47) {
        pos++;
        let s = '';
        while (pos < buf.length && !isWs(buf[pos]) && !isDelim(buf[pos])) {
          if (buf[pos] === 35 && pos + 2 < buf.length) { s += String.fromCharCode(parseInt(String.fromCharCode(buf[pos + 1], buf[pos + 2]), 16) || 0); pos += 3; } else s += String.fromCharCode(buf[pos++]);
        }
        return { n: s };
      }
      if (c === 40) {
        pos++;
        let depth = 1;
        const out: number[] = [];
        while (pos < buf.length) {
          const ch = buf[pos++];
          if (ch === 92) {
            const e = buf[pos++];
            const map: Record<number, number> = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12, 40: 40, 41: 41, 92: 92 };
            if (e in map) out.push(map[e]);
            else if (e >= 48 && e <= 55) {
              let o = e - 48;
              for (let k = 0; k < 2 && buf[pos] >= 48 && buf[pos] <= 55; k++) o = o * 8 + (buf[pos++] - 48);
              out.push(o & 255);
            } else if (e === 13) { if (buf[pos] === 10) pos++; } else if (e !== 10) out.push(e);
          } else if (ch === 40) { depth++; out.push(ch); } else if (ch === 41) { if (--depth === 0) break; out.push(ch); } else out.push(ch);
        }
        return { s: out };
      }
      if (c === 60) {
        if (buf[pos + 1] === 60) { pos += 2; return DS; }
        pos++;
        let hex = '';
        while (pos < buf.length && buf[pos] !== 62) { const ch = buf[pos++]; if (!isWs(ch)) hex += String.fromCharCode(ch); }
        pos++;
        if (hex.length % 2) hex += '0';
        const out: number[] = [];
        for (let k = 0; k < hex.length; k += 2) out.push(parseInt(hex.slice(k, k + 2), 16) || 0);
        return { s: out };
      }
      if (c === 62) { pos += buf[pos + 1] === 62 ? 2 : 1; return DE; }
      if (c === 91) { pos++; return AS; }
      if (c === 93) { pos++; return AE; }
      if (c === 123 || c === 125 || c === 41) { pos++; return next(); }
      let s = '';
      while (pos < buf.length && !isWs(buf[pos]) && !isDelim(buf[pos])) s += String.fromCharCode(buf[pos++]);
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return Number(s);
      if (/^[+-]?\d*\.?\d*[+-]/.test(s)) return Number(s.replace(/(.)[+-].*$/, '$1')) || 0;
      if (s === 'true') return true;
      if (s === 'false') return false;
      if (s === 'null') return null;
      return { k: s };
    };
    return { next, getPos: () => pos, setPos: (p: number) => { pos = p; } };
  };

  const parser = (lx: ReturnType<typeof lexer>) => {
    const q: V[] = [];
    const tok = (): V => (q.length ? q.shift() : lx.next());
    const peek = (n: number): V => { while (q.length <= n) q.push(lx.next()); return q[n]; };
    const value = (t: V = tok(), depth = 0): V => {
      if (depth > 64) return null;
      if (t === DS) {
        const d: Dict = {};
        for (let i = 0; i < 4000; i++) {
          const k = tok();
          if (k === DE || k === EOF) break;
          if (k && typeof k === 'object' && 'n' in k) d[(k as { n: string }).n] = value(tok(), depth + 1);
        }
        return { d };
      }
      if (t === AS) {
        const a: V[] = [];
        for (let i = 0; i < 200000; i++) {
          const x = peek(0);
          if (x === AE) { tok(); break; }
          if (x === EOF) break;
          a.push(value(tok(), depth + 1));
        }
        return a;
      }
      if (typeof t === 'number' && Number.isInteger(t) && t >= 0) {
        const a = peek(0);
        const b = peek(1);
        if (typeof a === 'number' && Number.isInteger(a) && b && typeof b === 'object' && (b as { k?: string }).k === 'R') { tok(); tok(); return { r: t }; }
      }
      return t;
    };
    return { value, tok, queued: () => q.length };
  };

  const text = latin(bytes);
  const offsets = new Map<number, number>();
  for (const m of text.matchAll(/(\d{1,10})\s+(\d{1,5})\s+obj\b/g)) offsets.set(Number(m[1]), (m.index ?? 0) + m[0].length);
  const cache = new Map<number, V>();
  let objStreams: Map<number, { data: Uint8Array; at: number }> | null = null;

  const isDict = (v: V): v is { d: Dict } => !!v && typeof v === 'object' && 'd' in v;
  const name = (v: V): string | null => (v && typeof v === 'object' && 'n' in v ? (v as { n: string }).n : null);
  const num = (v: V, dflt = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);
  type Stream = { d: Dict; data: Uint8Array };
  const isStream = (v: V): v is Stream => isDict(v) && 'data' in (v as object);

  const objAt = (n: number, depth = 0): V => {
    if (cache.has(n)) return cache.get(n);
    cache.set(n, null);
    let v: V = null;
    const off = offsets.get(n);
    if (off !== undefined) {
      const lx = lexer(bytes, off);
      const p = parser(lx);
      v = p.value();
      const after = p.tok();
      if (isDict(v) && after && typeof after === 'object' && (after as { k?: string }).k === 'stream') {
        let start = lx.getPos();
        if (bytes[start] === 13) start++;
        if (bytes[start] === 10) start++;
        let len = num(resolve(v.d.Length, depth + 1), -1);
        if (len < 0 || start + len > bytes.length || !/endstream/.test(text.slice(start + len, start + len + 40))) {
          const end = text.indexOf('endstream', start);
          len = (end < 0 ? bytes.length : end) - start;
          while (len > 0 && (bytes[start + len - 1] === 10 || bytes[start + len - 1] === 13)) len--;
        }
        v = { d: v.d, data: bytes.subarray(start, start + len) };
      }
    } else {
      if (!objStreams) {
        objStreams = new Map();
        for (const [k, o] of offsets) {
          if (!/\/Type\s*\/ObjStm/.test(text.slice(o, o + 300))) continue;
          const s = objAt(k, depth + 1);
          if (isStream(s)) pendingStreams.push(s);
        }
      }
      const hit = objStreams.get(n);
      if (hit) { const p = parser(lexer(hit.data, hit.at)); v = p.value(); }
    }
    cache.set(n, v);
    return v;
  };
  const pendingStreams: Stream[] = [];
  const resolve = (v: V, depth = 0): V => {
    let cur = v;
    for (let i = 0; i < 16 && cur && typeof cur === 'object' && 'r' in cur; i++) cur = objAt((cur as { r: number }).r, depth + 1);
    return cur;
  };

  const inflate = async (data: Uint8Array, format: 'deflate' | 'deflate-raw'): Promise<Uint8Array> => {
    const ds = new DecompressionStream(format);
    const writer = ds.writable.getWriter();
    writer.write(data as Uint8Array<ArrayBuffer>).catch(() => {});
    writer.close().catch(() => {});
    const reader = ds.readable.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        chunks.push(r.value);
        total += r.value.length;
        if (total > 128 * 1024 * 1024) throw new Error('too large');
      }
    } catch { /* damaged or with trailing bytes: keep what came out */ }
    const out = new Uint8Array(total);
    let p = 0;
    for (const c of chunks) { out.set(c, p); p += c.length; }
    return out;
  };
  const unpredict = (data: Uint8Array, parms: Dict | null): Uint8Array => {
    const pred = num(parms?.Predictor, 1);
    if (pred < 10) return data;
    const colors = num(parms?.Colors, 1);
    const bpc = num(parms?.BitsPerComponent, 8);
    const cols = num(parms?.Columns, 1);
    const row = Math.ceil((colors * bpc * cols) / 8);
    const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
    const rows = Math.floor(data.length / (row + 1));
    const out = new Uint8Array(rows * row);
    for (let r = 0; r < rows; r++) {
      const f = data[r * (row + 1)];
      const src = r * (row + 1) + 1;
      const dst = r * row;
      for (let i = 0; i < row; i++) {
        const left = i >= bpp ? out[dst + i - bpp] : 0;
        const up = r ? out[dst - row + i] : 0;
        const ul = r && i >= bpp ? out[dst - row + i - bpp] : 0;
        let v = data[src + i];
        if (f === 1) v += left;
        else if (f === 2) v += up;
        else if (f === 3) v += (left + up) >> 1;
        else if (f === 4) { const p = left + up - ul; const pa = Math.abs(p - left); const pb = Math.abs(p - up); const pc = Math.abs(p - ul); v += pa <= pb && pa <= pc ? left : pb <= pc ? up : ul; }
        out[dst + i] = v & 255;
      }
    }
    return out;
  };
  /** Undo a stream's filters. A JPEG is returned as it is (`jpeg: true`). */
  const decode = async (s: Stream): Promise<{ data: Uint8Array; jpeg: boolean }> => {
    const f = resolve(s.d.Filter ?? s.d.F);
    const filters = (Array.isArray(f) ? f : f ? [f] : []).map((x) => name(resolve(x)) ?? '');
    const pr = resolve(s.d.DecodeParms ?? s.d.DP);
    const parms = (Array.isArray(pr) ? pr : [pr]).map((x) => { const r = resolve(x); return isDict(r) ? r.d : null; });
    let data = s.data;
    for (let i = 0; i < filters.length; i++) {
      const fl = filters[i];
      if (fl === 'FlateDecode' || fl === 'Fl') {
        let out = await inflate(data, 'deflate');
        if (!out.length) out = await inflate(data, 'deflate-raw');
        data = unpredict(out, parms[i] ?? null);
      } else if (fl === 'ASCIIHexDecode' || fl === 'AHx') {
        const h = latin(data).replace(/[^0-9a-f]/gi, '');
        const out = new Uint8Array(Math.ceil(h.length / 2));
        for (let k = 0; k < out.length; k++) out[k] = parseInt((h.slice(k * 2, k * 2 + 2) + '0').slice(0, 2), 16);
        data = out;
      } else if (fl === 'ASCII85Decode' || fl === 'A85') {
        const t = latin(data).replace(/\s/g, '').replace(/^<~/, '').replace(/~>.*$/, '');
        const out: number[] = [];
        let group: number[] = [];
        for (const ch of t) {
          if (ch === 'z' && !group.length) { out.push(0, 0, 0, 0); continue; }
          group.push(ch.charCodeAt(0) - 33);
          if (group.length === 5) { let v = 0; for (const g of group) v = v * 85 + g; out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); group = []; }
        }
        if (group.length) { const n = group.length; while (group.length < 5) group.push(84); let v = 0; for (const g of group) v = v * 85 + g; out.push(...[(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].slice(0, n - 1)); }
        data = new Uint8Array(out);
      } else if (fl === 'RunLengthDecode' || fl === 'RL') {
        const out: number[] = [];
        for (let k = 0; k < data.length;) {
          const n = data[k++];
          if (n === 128) break;
          if (n < 128) { for (let j = 0; j <= n && k < data.length; j++) out.push(data[k++]); } else { const b = data[k++]; for (let j = 0; j < 257 - n; j++) out.push(b); }
        }
        data = new Uint8Array(out);
      } else if (fl === 'DCTDecode' || fl === 'DCT') return { data, jpeg: true };
      else { warnings.add(`Parts compressed with ${fl} are not shown.`); return { data: new Uint8Array(0), jpeg: false }; }
    }
    return { data, jpeg: false };
  };

  // object streams found above are unpacked here (decoding is asynchronous)
  const unpackObjectStreams = async () => {
    objAt(-1);
    for (const s of pendingStreams.splice(0)) {
      const { data } = await decode(s);
      const n = num(resolve(s.d.N));
      const first = num(resolve(s.d.First));
      const p = parser(lexer(data, 0));
      for (let i = 0; i < n && i < 100000; i++) {
        const o = p.value();
        const at = p.value();
        if (typeof o === 'number' && typeof at === 'number' && !offsets.has(o)) objStreams!.set(o, { data, at: first + at });
      }
    }
    for (const [k, v] of cache) if (v === null && !offsets.has(k)) cache.delete(k);
  };
  await unpackObjectStreams();

  // ------------------------------------------------------------ the first page
  const roots = [...text.matchAll(/\/Root\s+(\d+)\s+\d+\s+R/g)];
  let catalog = roots.length ? resolve({ r: Number(roots[roots.length - 1][1]) }) : null;
  if (!isDict(catalog)) {
    for (const k of [...offsets.keys(), ...[...((objStreams as Map<number, unknown> | null)?.keys() ?? [])]]) { const o = objAt(k); if (isDict(o) && name(o.d.Type) === 'Catalog') { catalog = o; break; } }
  }
  if (!isDict(catalog)) throw new Error('This PDF has no pages that can be read.');
  let node = resolve(catalog.d.Pages);
  const inherited: Dict = {};
  let pages = 0;
  for (let depth = 0; depth < 40 && isDict(node) && name(node.d.Type) !== 'Page' && !node.d.Contents; depth++) {
    if (!depth) pages = num(resolve(node.d.Count), 1);
    for (const k of ['MediaBox', 'CropBox', 'Resources', 'Rotate']) if (node.d[k] !== undefined) inherited[k] = node.d[k];
    const kids = resolve(node.d.Kids);
    node = Array.isArray(kids) ? resolve(kids[0]) : null;
  }
  if (!isDict(node)) throw new Error('This PDF has no pages that can be read.');
  const pg = node.d;
  const boxOf = (v: V) => { const a = resolve(v); return Array.isArray(a) && a.length === 4 ? a.map((x) => num(resolve(x))) : null; };
  const media = boxOf(pg.MediaBox ?? inherited.MediaBox) ?? [0, 0, 612, 792];
  const crop = boxOf(pg.CropBox ?? inherited.CropBox) ?? media;
  const box = [Math.min(crop[0], crop[2]), Math.min(crop[1], crop[3]), Math.max(crop[0], crop[2]), Math.max(crop[1], crop[3])];
  const rotate = num(resolve(pg.Rotate ?? inherited.Rotate), 0);

  // ------------------------------------------------------------ drawing
  const ops: PdfOp[] = [];
  const mul = (a: number[], b: number[]) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
  const rgb = (r: number, g: number, b: number) => `rgb(${Math.round(Math.max(0, Math.min(1, r)) * 255)},${Math.round(Math.max(0, Math.min(1, g)) * 255)},${Math.round(Math.max(0, Math.min(1, b)) * 255)})`;
  const cmyk = (c: number, m: number, y: number, k: number) => rgb(1 - Math.min(1, c + k), 1 - Math.min(1, m + k), 1 - Math.min(1, y + k));
  type CS = { n: number; kind: 'gray' | 'rgb' | 'cmyk' | 'indexed' | 'sep' | 'pattern' | 'lab'; base?: CS; hival?: number; lookup?: number[] };
  const csOf = (v: V, res: Dict | null, depth = 0): CS => {
    const r = resolve(v);
    const nm = name(r);
    if (nm) {
      if (nm === 'DeviceGray' || nm === 'G' || nm === 'CalGray') return { n: 1, kind: 'gray' };
      if (nm === 'DeviceRGB' || nm === 'RGB' || nm === 'CalRGB') return { n: 3, kind: 'rgb' };
      if (nm === 'DeviceCMYK' || nm === 'CMYK') return { n: 4, kind: 'cmyk' };
      if (nm === 'Pattern') return { n: 1, kind: 'pattern' };
      const named = res ? resolve(res.ColorSpace) : null;
      if (isDict(named) && named.d[nm] !== undefined && depth < 4) return csOf(named.d[nm], res, depth + 1);
      return { n: 1, kind: 'gray' };
    }
    if (Array.isArray(r) && r.length) {
      const fam = name(resolve(r[0]));
      if (fam === 'ICCBased') { const s = resolve(r[1]); const n = isDict(s) ? num(resolve(s.d.N), 3) : 3; return { n, kind: n === 1 ? 'gray' : n === 4 ? 'cmyk' : 'rgb' }; }
      if (fam === 'CalRGB' || fam === 'Lab') return { n: 3, kind: fam === 'Lab' ? 'lab' : 'rgb' };
      if (fam === 'CalGray') return { n: 1, kind: 'gray' };
      if (fam === 'Indexed' || fam === 'I') {
        const base = csOf(r[1], res, depth + 1);
        const lk = resolve(r[3]);
        const lookup = lk && typeof lk === 'object' && 's' in lk ? (lk as { s: number[] }).s : isStream(lk) ? Array.from(lk.data) : [];
        return { n: 1, kind: 'indexed', base, hival: num(resolve(r[2])), lookup };
      }
      if (fam === 'Separation' || fam === 'DeviceN') return { n: fam === 'DeviceN' && Array.isArray(resolve(r[1])) ? (resolve(r[1]) as V[]).length : 1, kind: 'sep' };
      if (fam === 'Pattern') return { n: 1, kind: 'pattern' };
    }
    return { n: 1, kind: 'gray' };
  };
  const colorOf = (cs: CS, c: number[]): string => {
    if (cs.kind === 'rgb') return rgb(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0);
    if (cs.kind === 'cmyk') return cmyk(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 1);
    if (cs.kind === 'sep') { const t = Math.max(...c, 0); return rgb(1 - t, 1 - t, 1 - t); }
    if (cs.kind === 'pattern') return 'rgb(128,128,128)';
    if (cs.kind === 'lab') { const l = (c[0] ?? 0) / 100; return rgb(l, l, l); }
    if (cs.kind === 'indexed' && cs.base && cs.lookup) {
      const i = Math.max(0, Math.min(cs.hival ?? 0, Math.round(c[0] ?? 0)));
      const comps = cs.lookup.slice(i * cs.base.n, i * cs.base.n + cs.base.n).map((x) => x / 255);
      return colorOf(cs.base, comps);
    }
    const g = c[0] ?? 0;
    return rgb(g, g, g);
  };

  interface Font { two: boolean; width: (code: number) => number; uni: Map<number, string> | null; family: string; weight: string; style: string; type3: boolean }
  const fonts = new Map<V, Font>();
  const fontOf = async (ref: V): Promise<Font | null> => {
    if (fonts.has(ref)) return fonts.get(ref)!;
    const f = resolve(ref);
    if (!isDict(f)) return null;
    const sub = name(resolve(f.d.Subtype)) ?? '';
    const two = sub === 'Type0';
    const base = name(resolve(f.d.BaseFont)) ?? '';
    const widths = new Map<number, number>();
    let dflt = 500;
    if (two) {
      const desc = resolve(f.d.DescendantFonts);
      const cid = Array.isArray(desc) ? resolve(desc[0]) : null;
      if (isDict(cid)) {
        dflt = num(resolve(cid.d.DW), 1000);
        const w = resolve(cid.d.W);
        if (Array.isArray(w)) {
          for (let i = 0; i < w.length && i < 40000;) {
            const a = num(resolve(w[i]));
            const b = resolve(w[i + 1]);
            if (Array.isArray(b)) { b.forEach((x, j) => widths.set(a + j, num(resolve(x)))); i += 2; } else { const e = num(b); const wv = num(resolve(w[i + 2])); for (let c = a; c <= e && c - a < 65536; c++) widths.set(c, wv); i += 3; }
          }
        }
      }
    } else {
      const firstChar = num(resolve(f.d.FirstChar));
      const w = resolve(f.d.Widths);
      if (Array.isArray(w)) w.forEach((x, i) => widths.set(firstChar + i, num(resolve(x))));
      const fd = resolve(f.d.FontDescriptor);
      if (isDict(fd)) dflt = num(resolve(fd.d.MissingWidth), 500);
    }
    let uni: Map<number, string> | null = null;
    const tu = resolve(f.d.ToUnicode);
    if (isStream(tu)) {
      uni = new Map();
      const cm = latin((await decode(tu)).data);
      const utf16 = (hex: string) => { let s = ''; for (let i = 0; i + 4 <= hex.length; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16)); if (hex.length === 2) s = String.fromCharCode(parseInt(hex, 16)); return s; };
      for (const sec of cm.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const m of sec[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) uni.set(parseInt(m[1], 16), utf16(m[2]));
      for (const sec of cm.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
        for (const m of sec[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
          const lo = parseInt(m[1], 16);
          const hi = Math.min(parseInt(m[2], 16), lo + 65535);
          if (m[3].startsWith('[')) [...m[3].matchAll(/<([0-9a-fA-F]*)>/g)].forEach((x, i) => { if (lo + i <= hi) uni!.set(lo + i, utf16(x[1])); });
          else { const dst = m[3].slice(1, -1); const start = parseInt(dst.slice(-4) || '0', 16); const head = dst.slice(0, -4); for (let c = lo; c <= hi; c++) uni.set(c, utf16(head + (start + c - lo).toString(16).padStart(4, '0'))); }
        }
      }
    }
    // the standard fonts come without widths: estimate them from the shape of each letter
    const mono = /courier|mono|consol/i.test(base);
    const guess = (code: number): number => {
      if (mono) return 600;
      const ch = String.fromCharCode(code);
      if (/[iljI.,:;'!|]/.test(ch)) return 278;
      if (/[ftr()\[\]\-\/ ]/.test(ch)) return ch === ' ' ? 278 : 333;
      if (/[mwMW]/.test(ch)) return ch === 'm' ? 833 : ch === 'w' ? 722 : ch === 'W' ? 944 : 833;
      if (/[A-Z]/.test(ch)) return 667;
      if (/[0-9a-z]/.test(ch)) return 556;
      return dflt;
    };
    const estimate = !two && widths.size === 0;
    const font: Font = {
      two, uni, type3: sub === 'Type3',
      width: (code) => widths.get(code) ?? (estimate ? guess(code) : dflt),
      family: /courier|mono|consol/i.test(base) ? 'monospace' : /times|serif|roman|georgia|garamond|book/i.test(base) && !/sans/i.test(base) ? 'serif' : 'sans-serif',
      weight: /bold|black|heavy|semibold/i.test(base) ? 'bold' : 'normal',
      style: /italic|oblique/i.test(base) ? 'italic' : 'normal',
    };
    fonts.set(ref, font);
    return font;
  };

  const imageOp = async (s: Stream, ctm: number[], fill: string): Promise<PdfOp | null> => {
    const w = num(resolve(s.d.Width ?? s.d.W));
    const h = num(resolve(s.d.Height ?? s.d.H));
    if (w <= 0 || h <= 0 || w * h > 40e6) return null;
    const { data, jpeg } = await decode(s);
    if (jpeg) return { k: 'img', m: ctm, jpeg: data, w, h };
    if (!data.length) return null;
    const mask = resolve(s.d.ImageMask ?? s.d.IM) === true;
    const bpc = mask ? 1 : num(resolve(s.d.BitsPerComponent ?? s.d.BPC), 8);
    const rgba = new Uint8ClampedArray(w * h * 4);
    if (mask) {
      const m = /rgb\((\d+),(\d+),(\d+)\)/.exec(fill) ?? ['', '0', '0', '0'];
      const dec = resolve(s.d.Decode ?? s.d.D);
      const paint = Array.isArray(dec) && num(resolve(dec[0])) === 1 ? 1 : 0;
      const row = Math.ceil(w / 8);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const bit = (data[y * row + (x >> 3)] >> (7 - (x & 7))) & 1;
        const o = (y * w + x) * 4;
        if (bit === paint) { rgba[o] = Number(m[1]); rgba[o + 1] = Number(m[2]); rgba[o + 2] = Number(m[3]); rgba[o + 3] = 255; }
      }
      return { k: 'img', m: ctm, w, h, rgba };
    }
    const cs = csOf(s.d.ColorSpace ?? s.d.CS, null);
    const n = cs.kind === 'indexed' ? 1 : cs.n;
    const row = Math.ceil((w * n * bpc) / 8);
    const sample = (y: number, i: number): number => {
      if (bpc === 8) return data[y * row + i] ?? 0;
      if (bpc === 16) return data[y * row + i * 2] ?? 0;
      const bit = i * bpc;
      const v = ((data[y * row + (bit >> 3)] ?? 0) >> (8 - bpc - (bit & 7))) & ((1 << bpc) - 1);
      return cs.kind === 'indexed' ? v : Math.round((v * 255) / ((1 << bpc) - 1));
    };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (cs.kind === 'indexed' && cs.base && cs.lookup) {
        const idx = Math.min(cs.hival ?? 255, sample(y, x));
        const bn = cs.base.n;
        const c = cs.lookup.slice(idx * bn, idx * bn + bn);
        if (bn === 4) { const k = (c[3] ?? 0) / 255; rgba[o] = 255 * (1 - Math.min(1, (c[0] ?? 0) / 255 + k)); rgba[o + 1] = 255 * (1 - Math.min(1, (c[1] ?? 0) / 255 + k)); rgba[o + 2] = 255 * (1 - Math.min(1, (c[2] ?? 0) / 255 + k)); } else if (bn === 1) { rgba[o] = rgba[o + 1] = rgba[o + 2] = c[0] ?? 0; } else { rgba[o] = c[0] ?? 0; rgba[o + 1] = c[1] ?? 0; rgba[o + 2] = c[2] ?? 0; }
      } else if (n === 1) rgba[o] = rgba[o + 1] = rgba[o + 2] = sample(y, x);
      else if (n === 3) { rgba[o] = sample(y, x * 3); rgba[o + 1] = sample(y, x * 3 + 1); rgba[o + 2] = sample(y, x * 3 + 2); } else if (n === 4) {
        const c = sample(y, x * 4) / 255; const m = sample(y, x * 4 + 1) / 255; const yy = sample(y, x * 4 + 2) / 255; const k = sample(y, x * 4 + 3) / 255;
        rgba[o] = 255 * (1 - Math.min(1, c + k)); rgba[o + 1] = 255 * (1 - Math.min(1, m + k)); rgba[o + 2] = 255 * (1 - Math.min(1, yy + k));
      }
      rgba[o + 3] = 255;
    }
    return { k: 'img', m: ctm, w, h, rgba };
  };

  let budget = 2_000_000;
  const run = async (content: Uint8Array, res: Dict | null, ctm0: number[], depth: number) => {
    interface GS { ctm: number[]; fill: string; stroke: string; fcs: CS; scs: CS; lw: number; cap: number; join: number; dash: number[]; fa: number; sa: number; font: Font | null; fs: number; tc: number; tw: number; th: number; tl: number; rise: number; tr: number }
    let g: GS = { ctm: ctm0, fill: 'rgb(0,0,0)', stroke: 'rgb(0,0,0)', fcs: { n: 1, kind: 'gray' }, scs: { n: 1, kind: 'gray' }, lw: 1, cap: 0, join: 0, dash: [], fa: 1, sa: 1, font: null, fs: 1, tc: 0, tw: 0, th: 1, tl: 0, rise: 0, tr: 0 };
    const stack: GS[] = [];
    let path: number[] = [];
    let cx = 0; let cy = 0; let sx = 0; let sy = 0;
    let clipNext: 'nonzero' | 'evenodd' | null = null;
    let tm = [1, 0, 0, 1, 0, 0];
    let tlm = [1, 0, 0, 1, 0, 0];
    const pt = (x: number, y: number) => [g.ctm[0] * x + g.ctm[2] * y + g.ctm[4], g.ctm[1] * x + g.ctm[3] * y + g.ctm[5]];
    const scale = () => Math.sqrt(Math.abs(g.ctm[0] * g.ctm[3] - g.ctm[1] * g.ctm[2])) || 1;
    const sub = (key: string): Dict | null => { const v = res ? resolve(res[key]) : null; return isDict(v) ? v.d : null; };
    const paint = (fill: 'nonzero' | 'evenodd' | null, stroke: boolean) => {
      if (clipNext && path.length) ops.push({ k: 'clip', d: path, rule: clipNext });
      if ((fill || stroke) && path.length) ops.push({ k: 'path', d: path, fill: fill ? g.fill : null, stroke: stroke ? g.stroke : null, lw: g.lw * scale(), rule: fill ?? 'nonzero', fa: g.fa, sa: g.sa, dash: g.dash.map((x) => x * scale()), cap: g.cap, join: g.join });
      path = [];
      clipNext = null;
    };
    const show = (bytesStr: number[]) => {
      const f = g.font;
      if (!f) return;
      const step = f.two ? 2 : 1;
      for (let i = 0; i + step - 1 < bytesStr.length; i += step) {
        const code = f.two ? (bytesStr[i] << 8) | bytesStr[i + 1] : bytesStr[i];
        const ch = f.uni?.get(code) ?? (f.two ? '' : String.fromCharCode(code));
        if (ch && ch.trim() && g.tr !== 3 && g.tr !== 7 && !f.type3) {
          const m = mul(mul([g.fs * g.th, 0, 0, g.fs, 0, g.rise], tm), g.ctm);
          ops.push({ k: 'text', s: ch, m, fill: g.fill, family: f.family, weight: f.weight, style: f.style, fa: g.fa });
        }
        const tx = ((f.width(code) / 1000) * g.fs + g.tc + (step === 1 && code === 32 ? g.tw : 0)) * g.th;
        tm = mul([1, 0, 0, 1, tx, 0], tm);
      }
    };
    const lx = lexer(content, 0);
    const args: V[] = [];
    const p = parser(lx);
    for (;;) {
      if (--budget < 0) { warnings.add('Only part of this page is shown: it is very detailed.'); return; }
      const t = p.tok();
      if (t === EOF) break;
      if (!(t && typeof t === 'object' && 'k' in t)) { args.push(t === AS || t === DS ? p.value(t) : t); if (args.length > 64) args.shift(); continue; }
      const op = (t as { k: string }).k;
      const a = (i: number) => num(args[i]);
      switch (op) {
        case 'q': stack.push({ ...g, dash: [...g.dash] }); ops.push({ k: 'save' }); break;
        case 'Q': if (stack.length) { g = stack.pop()!; ops.push({ k: 'restore' }); } break;
        case 'cm': g.ctm = mul([a(0), a(1), a(2), a(3), a(4), a(5)], g.ctm); break;
        case 'w': g.lw = a(0); break;
        case 'J': g.cap = a(0); break;
        case 'j': g.join = a(0); break;
        case 'd': g.dash = Array.isArray(args[0]) ? (args[0] as V[]).map((x) => num(x)).filter((x) => x >= 0) : []; if (g.dash.every((x) => x === 0)) g.dash = []; break;
        case 'gs': {
          const e = sub('ExtGState')?.[name(args[0]) ?? ''];
          const d = resolve(e);
          if (isDict(d)) {
            if (d.d.LW !== undefined) g.lw = num(resolve(d.d.LW), g.lw);
            if (d.d.CA !== undefined) g.sa = num(resolve(d.d.CA), 1);
            if (d.d.ca !== undefined) g.fa = num(resolve(d.d.ca), 1);
          }
          break;
        }
        case 'G': g.scs = { n: 1, kind: 'gray' }; g.stroke = colorOf(g.scs, [a(0)]); break;
        case 'g': g.fcs = { n: 1, kind: 'gray' }; g.fill = colorOf(g.fcs, [a(0)]); break;
        case 'RG': g.scs = { n: 3, kind: 'rgb' }; g.stroke = rgb(a(0), a(1), a(2)); break;
        case 'rg': g.fcs = { n: 3, kind: 'rgb' }; g.fill = rgb(a(0), a(1), a(2)); break;
        case 'K': g.scs = { n: 4, kind: 'cmyk' }; g.stroke = cmyk(a(0), a(1), a(2), a(3)); break;
        case 'k': g.fcs = { n: 4, kind: 'cmyk' }; g.fill = cmyk(a(0), a(1), a(2), a(3)); break;
        case 'CS': g.scs = csOf(args[0], res); g.stroke = colorOf(g.scs, g.scs.kind === 'cmyk' ? [0, 0, 0, 1] : [0, 0, 0]); break;
        case 'cs': g.fcs = csOf(args[0], res); g.fill = colorOf(g.fcs, g.fcs.kind === 'cmyk' ? [0, 0, 0, 1] : [0, 0, 0]); break;
        case 'SC': case 'SCN': g.stroke = colorOf(g.scs, args.filter((x): x is number => typeof x === 'number')); break;
        case 'sc': case 'scn': g.fill = colorOf(g.fcs, args.filter((x): x is number => typeof x === 'number')); break;
        case 'm': { const [x, y] = pt(a(0), a(1)); path.push(0, x, y); cx = sx = a(0); cy = sy = a(1); break; }
        case 'l': { const [x, y] = pt(a(0), a(1)); path.push(1, x, y); cx = a(0); cy = a(1); break; }
        case 'c': { const p1 = pt(a(0), a(1)); const p2 = pt(a(2), a(3)); const p3 = pt(a(4), a(5)); path.push(2, ...p1, ...p2, ...p3); cx = a(4); cy = a(5); break; }
        case 'v': { const p1 = pt(cx, cy); const p2 = pt(a(0), a(1)); const p3 = pt(a(2), a(3)); path.push(2, ...p1, ...p2, ...p3); cx = a(2); cy = a(3); break; }
        case 'y': { const p1 = pt(a(0), a(1)); const p3 = pt(a(2), a(3)); path.push(2, ...p1, ...p3, ...p3); cx = a(2); cy = a(3); break; }
        case 'h': path.push(3); cx = sx; cy = sy; break;
        case 're': {
          const [x, y, w, h] = [a(0), a(1), a(2), a(3)];
          path.push(0, ...pt(x, y), 1, ...pt(x + w, y), 1, ...pt(x + w, y + h), 1, ...pt(x, y + h), 3);
          cx = sx = x; cy = sy = y;
          break;
        }
        case 'S': paint(null, true); break;
        case 's': path.push(3); paint(null, true); break;
        case 'f': case 'F': paint('nonzero', false); break;
        case 'f*': paint('evenodd', false); break;
        case 'B': paint('nonzero', true); break;
        case 'B*': paint('evenodd', true); break;
        case 'b': path.push(3); paint('nonzero', true); break;
        case 'b*': path.push(3); paint('evenodd', true); break;
        case 'n': paint(null, false); break;
        case 'W': clipNext = 'nonzero'; break;
        case 'W*': clipNext = 'evenodd'; break;
        case 'BT': tm = [1, 0, 0, 1, 0, 0]; tlm = [1, 0, 0, 1, 0, 0]; break;
        case 'ET': break;
        case 'Tf': { g.fs = a(1); const fr = sub('Font')?.[name(args[0]) ?? '']; g.font = fr !== undefined ? await fontOf(fr) : null; break; }
        case 'Tc': g.tc = a(0); break;
        case 'Tw': g.tw = a(0); break;
        case 'Tz': g.th = a(0) / 100; break;
        case 'TL': g.tl = a(0); break;
        case 'Ts': g.rise = a(0); break;
        case 'Tr': g.tr = a(0); break;
        case 'Td': tlm = mul([1, 0, 0, 1, a(0), a(1)], tlm); tm = tlm; break;
        case 'TD': g.tl = -a(1); tlm = mul([1, 0, 0, 1, a(0), a(1)], tlm); tm = tlm; break;
        case 'Tm': tlm = [a(0), a(1), a(2), a(3), a(4), a(5)]; tm = tlm; break;
        case 'T*': tlm = mul([1, 0, 0, 1, 0, -g.tl], tlm); tm = tlm; break;
        case 'Tj': if (args[0] && typeof args[0] === 'object' && 's' in args[0]) show((args[0] as { s: number[] }).s); break;
        case "'": tlm = mul([1, 0, 0, 1, 0, -g.tl], tlm); tm = tlm; if (args[0] && typeof args[0] === 'object' && 's' in args[0]) show((args[0] as { s: number[] }).s); break;
        case '"': g.tw = a(0); g.tc = a(1); tlm = mul([1, 0, 0, 1, 0, -g.tl], tlm); tm = tlm; if (args[2] && typeof args[2] === 'object' && 's' in args[2]) show((args[2] as { s: number[] }).s); break;
        case 'TJ':
          if (Array.isArray(args[0])) for (const x of args[0] as V[]) {
            if (typeof x === 'number') tm = mul([1, 0, 0, 1, (-x / 1000) * g.fs * g.th, 0], tm);
            else if (x && typeof x === 'object' && 's' in x) show((x as { s: number[] }).s);
          }
          break;
        case 'Do': {
          const xo = resolve(sub('XObject')?.[name(args[0]) ?? '']);
          if (!isStream(xo)) break;
          const st = name(resolve(xo.d.Subtype));
          if (st === 'Image') { const im = await imageOp(xo, g.ctm, g.fill); if (im) ops.push(im); } else if (st === 'Form' && depth < 8) {
            const fm = resolve(xo.d.Matrix);
            const m = Array.isArray(fm) && fm.length === 6 ? fm.map((x) => num(resolve(x))) : [1, 0, 0, 1, 0, 0];
            const fr = resolve(xo.d.Resources);
            ops.push({ k: 'save' });
            const bb = resolve(xo.d.BBox);
            const ctm = mul(m, g.ctm);
            if (Array.isArray(bb) && bb.length === 4) {
              const [x0, y0, x1, y1] = bb.map((x) => num(resolve(x)));
              const t = (x: number, y: number) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
              ops.push({ k: 'clip', d: [0, ...t(x0, y0), 1, ...t(x1, y0), 1, ...t(x1, y1), 1, ...t(x0, y1), 3], rule: 'nonzero' });
            }
            await run((await decode(xo)).data, isDict(fr) ? fr.d : res, ctm, depth + 1);
            ops.push({ k: 'restore' });
          }
          break;
        }
        case 'BI': {
          // inline image: skip its data up to EI
          const start = lx.getPos();
          let i = start;
          for (; i < content.length - 2; i++) if (content[i] === 73 && content[i + 1] === 68 && isWs(content[i + 2])) break;
          let j = i + 3;
          for (; j < content.length - 1; j++) if (isWs(content[j - 1]) && content[j] === 69 && content[j + 1] === 73 && (j + 2 >= content.length || isWs(content[j + 2]))) break;
          lx.setPos(j + 2);
          warnings.add('Small inline images are not shown.');
          break;
        }
        case 'sh': warnings.add('Shaded areas are not shown.'); break;
        default: break;
      }
      args.length = 0;
    }
  };

  const contents = resolve(pg.Contents);
  const parts: Uint8Array[] = [];
  for (const c of Array.isArray(contents) ? contents : [contents]) { const s = resolve(c); if (isStream(s)) { parts.push((await decode(s)).data); parts.push(new Uint8Array([10])); } }
  const all = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of parts) { all.set(x, at); at += x.length; }
  const resV = resolve(pg.Resources ?? inherited.Resources);
  await run(all, isDict(resV) ? resV.d : null, [1, 0, 0, 1, 0, 0], 0);
  return { box, rotate: ((Math.round(rotate / 90) * 90) % 360 + 360) % 360, ops, pages: Math.max(1, pages), warnings: [...warnings] };
}

/** Draw a page on a canvas at `scale` pixels per point (white sheet, then everything in order). */
export async function drawPdfPage(canvas: HTMLCanvasElement, page: PdfPage, scale: number): Promise<void> {
  const [x0, y0, x1, y1] = page.box;
  const w = x1 - x0;
  const h = y1 - y0;
  const s = scale;
  const rot = page.rotate;
  canvas.width = Math.max(1, Math.ceil((rot % 180 ? h : w) * s));
  canvas.height = Math.max(1, Math.ceil((rot % 180 ? w : h) * s));
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const base = rot === 90 ? [0, s, s, 0, -y0 * s, -x0 * s] : rot === 180 ? [-s, 0, 0, s, x1 * s, -y0 * s] : rot === 270 ? [0, -s, -s, 0, y1 * s, x1 * s] : [s, 0, 0, -s, -x0 * s, y1 * s];
  const mul = (a: number[], b: number[]) => [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3], a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
  const setT = (m: number[]) => ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  const trace = (d: number[]) => {
    ctx.beginPath();
    for (let i = 0; i < d.length;) {
      const c = d[i];
      if (c === 0) { ctx.moveTo(d[i + 1], d[i + 2]); i += 3; } else if (c === 1) { ctx.lineTo(d[i + 1], d[i + 2]); i += 3; } else if (c === 2) { ctx.bezierCurveTo(d[i + 1], d[i + 2], d[i + 3], d[i + 4], d[i + 5], d[i + 6]); i += 7; } else { ctx.closePath(); i += 1; }
    }
  };
  const caps: CanvasLineCap[] = ['butt', 'round', 'square'];
  const joins: CanvasLineJoin[] = ['miter', 'round', 'bevel'];
  for (const op of page.ops) {
    if (op.k === 'save') ctx.save();
    else if (op.k === 'restore') ctx.restore();
    else if (op.k === 'clip') { setT(base); trace(op.d); ctx.clip(op.rule); } else if (op.k === 'path') {
      setT(base);
      trace(op.d);
      if (op.fill) { ctx.globalAlpha = op.fa; ctx.fillStyle = op.fill; ctx.fill(op.rule); }
      if (op.stroke) {
        ctx.globalAlpha = op.sa;
        ctx.strokeStyle = op.stroke;
        ctx.lineWidth = Math.max(op.lw, 0.6 / s);
        ctx.lineCap = caps[op.cap] ?? 'butt';
        ctx.lineJoin = joins[op.join] ?? 'miter';
        ctx.setLineDash(op.dash);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.globalAlpha = 1;
    } else if (op.k === 'text') {
      setT(mul([0.01, 0, 0, -0.01, 0, 0], mul(op.m, base)));
      ctx.globalAlpha = op.fa;
      ctx.fillStyle = op.fill;
      ctx.font = `${op.style} ${op.weight} 100px ${op.family}`;
      ctx.fillText(op.s, 0, 0);
      ctx.globalAlpha = 1;
    } else if (op.k === 'img' && op.w && op.h) {
      let bmp: ImageBitmap | null = null;
      try {
        if (op.jpeg) bmp = await createImageBitmap(new Blob([op.jpeg as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }));
        else if (op.rgba) bmp = await createImageBitmap(new ImageData(op.rgba as Uint8ClampedArray<ArrayBuffer>, op.w, op.h));
      } catch { bmp = null; }
      if (!bmp) continue;
      setT(mul([1 / bmp.width, 0, 0, -1 / bmp.height, 0, 1], mul(op.m, base)));
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
