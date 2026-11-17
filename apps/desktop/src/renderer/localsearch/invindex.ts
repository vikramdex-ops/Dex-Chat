// A compact inverted index of message text, with no DOM or storage: each word maps to the
// messages that contain it, as ascending message numbers stored as varint gaps (one or two bytes
// per entry). Searching matches every word of the query as a prefix of indexed words ("val sch"
// finds "valve schedule"), so the sorted list of words is kept for binary search. A removed or
// edited message leaves its old entries behind until the index is compacted. The whole index
// serialises to bytes (see serialize) for storing encrypted on the device.
import { terms } from './tokenize.ts';

export interface DocMeta {
  id: string; convId: string; authorId: string; parentId: string | null; createdAt: number;
  /** Which version of the message was indexed (its edit time; 0 if never edited). */
  rev?: number;
}
export interface Filters {
  /** Only these conversations (the ones this person can open now). */
  convs?: ReadonlySet<string>;
  convId?: string;
  from?: string;
  after?: number;
  before?: number;
  /** Only results older than this message id (ids sort by time). */
  olderThan?: string;
}
export interface Hit { meta: DocMeta; words: string[] }

const MAX_EXPANSION = 4000;
const MAGIC = 0x31495844; // "DXI1"

class Postings {
  bytes = new Uint8Array(8);
  len = 0;
  last = -1;
  count = 0;
  push(n: number): void {
    let gap = n - this.last;
    this.last = n;
    this.count++;
    if (this.len + 6 > this.bytes.length) { const b = new Uint8Array(Math.max(16, this.bytes.length * 2)); b.set(this.bytes.subarray(0, this.len)); this.bytes = b; }
    while (gap >= 0x80) { this.bytes[this.len++] = (gap & 0x7f) | 0x80; gap >>>= 7; }
    this.bytes[this.len++] = gap;
  }
  *each(): Generator<number> {
    let n = -1;
    for (let i = 0; i < this.len;) {
      let gap = 0;
      let shift = 0;
      let b: number;
      do { b = this.bytes[i++]; gap |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80 && i < this.len);
      n += gap;
      yield n;
    }
  }
}

class Writer {
  private buf = new Uint8Array(1024);
  private at = 0;
  private enc = new TextEncoder();
  private room(n: number) { if (this.at + n > this.buf.length) { const b = new Uint8Array(Math.max(this.buf.length * 2, this.at + n)); b.set(this.buf.subarray(0, this.at)); this.buf = b; } }
  uint(n: number): void {
    this.room(8);
    let v = Math.max(0, Math.floor(n));
    while (v >= 0x80) { this.buf[this.at++] = (v % 0x80) | 0x80; v = Math.floor(v / 0x80); }
    this.buf[this.at++] = v;
  }
  str(s: string): void { const b = this.enc.encode(s); this.uint(b.length); this.raw(b); }
  raw(b: Uint8Array): void { this.room(b.length); this.buf.set(b, this.at); this.at += b.length; }
  done(): Uint8Array { return this.buf.slice(0, this.at); }
}

class Reader {
  private at = 0;
  private dec = new TextDecoder();
  private readonly buf: Uint8Array;
  constructor(buf: Uint8Array) { this.buf = buf; }
  uint(): number {
    let v = 0;
    let mul = 1;
    for (let i = 0; i < 9; i++) {
      if (this.at >= this.buf.length) throw new Error('The search index is cut short.');
      const b = this.buf[this.at++];
      v += (b & 0x7f) * mul;
      if (!(b & 0x80)) return v;
      mul *= 0x80;
    }
    throw new Error('The search index is damaged.');
  }
  raw(n: number): Uint8Array {
    if (n < 0 || this.at + n > this.buf.length) throw new Error('The search index is cut short.');
    const out = this.buf.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
  str(): string { return this.dec.decode(this.raw(this.uint())); }
}

export class LocalIndex {
  private ids: string[] = [];
  private conv: number[] = [];
  private author: number[] = [];
  private parent: number[] = [];
  private created: number[] = [];
  private revs: number[] = [];
  private readonly byId = new Map<string, number>();
  private strings: string[] = [];
  private readonly stringAt = new Map<string, number>();
  private postings = new Map<string, Postings>();
  private sorted: string[] | null = null;
  private dead = 0;

  /** Messages in the index. */
  get size(): number { return this.byId.size; }
  /** Entries left behind by removed or edited messages. */
  get stale(): number { return this.dead; }
  /** Distinct words. */
  get words(): number { return this.postings.size; }

  has(id: string): boolean { return this.byId.has(id); }
  /** The version indexed for a message, or null when it is not in the index. */
  revOf(id: string): number | null { const n = this.byId.get(id); return n === undefined ? null : this.revs[n]; }

  private str(s: string): number {
    let i = this.stringAt.get(s);
    if (i === undefined) { i = this.strings.length; this.strings.push(s); this.stringAt.set(s, i); }
    return i;
  }

  /** Add a message (an edit replaces what was indexed for it). */
  add(doc: DocMeta, text: string): void {
    if (this.byId.has(doc.id)) this.remove(doc.id);
    const words = terms(text);
    if (!words.length) return;
    const n = this.ids.length;
    this.ids.push(doc.id);
    this.conv.push(this.str(doc.convId));
    this.author.push(this.str(doc.authorId));
    this.parent.push(doc.parentId ? this.str(doc.parentId) : -1);
    this.created.push(doc.createdAt);
    this.revs.push(doc.rev ?? 0);
    this.byId.set(doc.id, n);
    for (const w of words) {
      let p = this.postings.get(w);
      if (!p) { p = new Postings(); this.postings.set(w, p); this.sorted = null; }
      p.push(n);
    }
  }

  remove(id: string): boolean {
    const n = this.byId.get(id);
    if (n === undefined) return false;
    this.byId.delete(id);
    this.ids[n] = '';
    this.dead++;
    return true;
  }

  meta(n: number): DocMeta {
    const p = this.parent[n];
    return { id: this.ids[n], convId: this.strings[this.conv[n]], authorId: this.strings[this.author[n]], parentId: p >= 0 ? this.strings[p] : null, createdAt: this.created[n], rev: this.revs[n] };
  }

  /** Words of the index that start with `prefix`. */
  expand(prefix: string): string[] {
    this.sorted ??= [...this.postings.keys()].sort();
    const s = this.sorted;
    let lo = 0;
    let hi = s.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (s[mid] < prefix) lo = mid + 1; else hi = mid; }
    const out: string[] = [];
    for (let i = lo; i < s.length && s[i].startsWith(prefix) && out.length < MAX_EXPANSION; i++) out.push(s[i]);
    return out;
  }

  /** Messages with every word of the query (each as a prefix), newest first. */
  search(query: string, filters: Filters = {}, limit = 30): Hit[] {
    const words = terms(query);
    if (!words.length || !this.byId.size) return [];
    const total = this.ids.length;
    let hits: Uint8Array | null = null;
    // the rarest word first keeps the candidate set small
    const expanded = words.map((w) => ({ w, list: this.expand(w) })).sort((a, b) => a.list.length - b.list.length);
    for (const { list } of expanded) {
      if (!list.length) return [];
      const here = new Uint8Array(total);
      for (const t of list) for (const n of this.postings.get(t)!.each()) if (!hits || hits[n]) here[n] = 1;
      hits = here;
    }
    const out: number[] = [];
    for (let n = 0; n < total; n++) {
      if (!hits![n] || !this.ids[n]) continue;
      const id = this.ids[n];
      const c = this.strings[this.conv[n]];
      if (filters.convs && !filters.convs.has(c)) continue;
      if (filters.convId && c !== filters.convId) continue;
      if (filters.from && this.strings[this.author[n]] !== filters.from) continue;
      if (filters.after !== undefined && this.created[n] < filters.after) continue;
      if (filters.before !== undefined && this.created[n] >= filters.before) continue;
      if (filters.olderThan && !(id < filters.olderThan)) continue;
      out.push(n);
    }
    out.sort((a, b) => (this.ids[b] < this.ids[a] ? -1 : this.ids[b] > this.ids[a] ? 1 : 0));
    return out.slice(0, Math.max(0, limit)).map((n) => ({ meta: this.meta(n), words }));
  }

  /** Drop entries left behind by removed messages (renumbers what is left). */
  compact(): void {
    if (!this.dead) return;
    const map = new Int32Array(this.ids.length).fill(-1);
    const next = new LocalIndex();
    for (let n = 0; n < this.ids.length; n++) {
      if (!this.ids[n]) continue;
      const m = next.ids.length;
      map[n] = m;
      const meta = this.meta(n);
      next.ids.push(meta.id);
      next.conv.push(next.str(meta.convId));
      next.author.push(next.str(meta.authorId));
      next.parent.push(meta.parentId ? next.str(meta.parentId) : -1);
      next.created.push(meta.createdAt);
      next.revs.push(meta.rev ?? 0);
      next.byId.set(meta.id, m);
    }
    for (const [w, p] of this.postings) {
      const q = new Postings();
      for (const n of p.each()) if (map[n] >= 0) q.push(map[n]);
      if (q.count) next.postings.set(w, q);
    }
    this.ids = next.ids;
    this.conv = next.conv;
    this.author = next.author;
    this.parent = next.parent;
    this.created = next.created;
    this.revs = next.revs;
    this.strings = next.strings;
    this.postings = next.postings;
    this.sorted = null;
    this.dead = 0;
    this.byId.clear();
    for (const [k, v] of next.byId) this.byId.set(k, v);
    this.stringAt.clear();
    for (const [k, v] of next.stringAt) this.stringAt.set(k, v);
  }

  /** The index as bytes (compacted first). */
  serialize(): Uint8Array {
    this.compact();
    const w = new Writer();
    w.uint(MAGIC);
    w.uint(this.strings.length);
    for (const s of this.strings) w.str(s);
    w.uint(this.ids.length);
    for (let n = 0; n < this.ids.length; n++) {
      w.str(this.ids[n]);
      w.uint(this.conv[n]);
      w.uint(this.author[n]);
      w.uint(this.parent[n] + 1);
      w.uint(this.created[n]);
      w.uint(this.revs[n]);
    }
    w.uint(this.postings.size);
    for (const [t, p] of this.postings) {
      w.str(t);
      w.uint(p.count);
      w.uint(p.last);
      w.uint(p.len);
      w.raw(p.bytes.subarray(0, p.len));
    }
    return w.done();
  }

  static deserialize(bytes: Uint8Array): LocalIndex {
    const r = new Reader(bytes);
    if (r.uint() !== MAGIC) throw new Error('Not a search index.');
    const ix = new LocalIndex();
    const ns = r.uint();
    for (let i = 0; i < ns; i++) ix.str(r.str());
    const nd = r.uint();
    for (let n = 0; n < nd; n++) {
      const id = r.str();
      const conv = r.uint();
      const author = r.uint();
      const parent = r.uint() - 1;
      const created = r.uint();
      const rev = r.uint();
      if (conv >= ns || author >= ns || parent >= ns) throw new Error('The search index is damaged.');
      ix.ids.push(id);
      ix.conv.push(conv);
      ix.author.push(author);
      ix.parent.push(parent);
      ix.created.push(created);
      ix.revs.push(rev);
      if (id) ix.byId.set(id, n); else ix.dead++;
    }
    const nt = r.uint();
    for (let i = 0; i < nt; i++) {
      const t = r.str();
      const p = new Postings();
      p.count = r.uint();
      p.last = r.uint();
      p.len = r.uint();
      p.bytes = r.raw(p.len).slice();
      if (p.last >= nd) throw new Error('The search index is damaged.');
      ix.postings.set(t, p);
    }
    return ix;
  }
}
