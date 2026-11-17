// Communication style rewriter: five deterministic, rule-based rewrites of a message
// (concise, formal, diplomatic, explanatory, technical). No model and no network.
//
// Meaning comes first. Before any rule runs, the text is tokenised and everything that must
// never change is replaced by an opaque placeholder: code spans, links and paths, @mentions and
// e-mail addresses, quoted text, drawing, line and tag numbers, dates, times, amounts, numbers
// with their units, and any names the caller lists. Rules only ever see the words around them.
//
// Every edit is recorded as a change (from, to, rule, where) so the interface can show a diff
// and let the person accept or undo each one (see applyChoices).

export type RestyleStyle = 'concise' | 'formal' | 'diplomatic' | 'explanatory' | 'technical';
export const RESTYLE_STYLES: readonly RestyleStyle[] = ['concise', 'formal', 'diplomatic', 'explanatory', 'technical'];

export interface RestyleChange {
  /** Position in `changes`, used by applyChoices. */
  id: number;
  /** The original text this change replaced ('' for an insertion). */
  from: string;
  /** What it became ('' for a removal). */
  to: string;
  /** Rule ids, joined with '+' when several rules edited the same words (e.g. 'formal.casual+formal.capital'). */
  rule: string;
  /** Where `to` starts in the restyled text. */
  at: number;
  /** Where `from` starts in the original text. */
  sourceAt: number;
}

export interface RestyleResult {
  text: string;
  changes: RestyleChange[];
}

export interface RestyleOptions {
  /** Names to keep exactly as written (people, clients, sites, vendors), besides @mentions. */
  names?: string[];
  /** More glossary entries for explanatory and technical: abbreviation -> full term. */
  glossary?: Record<string, string>;
  /** Diplomatic: add a greeting and thanks when they are missing (default true). */
  courtesy?: boolean;
}

/** Texts longer than this are returned unchanged (messages are at most 8,000 characters). */
export const RESTYLE_MAX_CHARS = 200_000;
/** Between a number and its unit in the technical style (U+202F, a thin space that does not break). */
export const THIN_SPACE = '\u202F';

// ------------------------------------------------------------------ protected tokens

const K_PLAIN = '\uE000';
const K_END = '\uE001';
const K_NUM = '\uE002';
const K_LINK = '\uE003';
const K_PERSON = '\uE004';
const PH = '[\\uE000\\uE002-\\uE004][\\uE100-\\uE8FF]{2}\\uE001';
const PH_NUM = '\\uE002[\\uE100-\\uE8FF]{2}\\uE001';
const PH_PERSON = '\\uE004[\\uE100-\\uE8FF]{2}\\uE001';
const PH_LINK = '\\uE003[\\uE100-\\uE8FF]{2}\\uE001';
const PH_RE = new RegExp(PH, 'g');
const MAX_TOKENS = 2048 * 2048;

const enc = (i: number) => String.fromCharCode(0xE100 + (i >> 11), 0xE100 + (i & 2047));
const dec = (ph: string) => ((ph.charCodeAt(1) - 0xE100) << 11) + (ph.charCodeAt(2) - 0xE100);

/** Word characters (placeholders count as words so rules never cut next to one). */
const W = '\\p{L}\\p{M}\\p{N}_\\uE000-\\uE8FF';
const B = `(?<![${W}'’])(?<!\\p{L}-)`;
const A = `(?![${W}]|['’]\\p{L}|-\\p{L})`;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const MONTH = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)';
const NUM = '(?:\\d{1,3}(?:,\\d{2,3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)';
const NB = '(?<![\\p{L}\\p{M}\\p{N}_])';
const NA = '(?![\\p{L}\\p{M}\\p{N}_])';
const UNIT_WORDS = [
  'mm', 'cm', 'km', 'm', 'mtrs?', 'meters?', 'metres?', 'millimet(?:er|re)s?', 'in', 'inch(?:es)?', 'ft', 'feet', 'foot',
  'kgs?', 'kilograms?', 'gms?', 'grams?', 'g', 't', 'tons?', 'tonnes?', 'MT', 'kN', 'N', 'kNm', 'Nm',
  'Pa', 'kPa(?:\\s?\\(?[ga]\\)?)?', 'MPa', 'bar(?:\\s?\\(?[ga]\\)?)?', 'psi[ga]?', '°\\s?[CF]', '℃', 'deg(?:rees?)?\\.?\\s?[CF]',
  'kW', 'MW', 'W', 'kVA', 'kV', 'V', 'A', 'Hz', 'rpm', 'm3/hr?', 'm³/hr?', 'm3', 'm³', 'm2', 'm²', 'sq\\.?\\s?m', 'sqm', 'sq\\.?\\s?ft', 'sqft',
  'L', 'l', 'ltrs?', 'lit(?:er|re)s?', 'ml', 'mL', 'hrs?', 'hours?', 'h', 'mins?', 'minutes?', 'secs?', 'seconds?', 's',
  'days?', 'weeks?', 'months?', 'years?', 'yrs?', 'nos\\.?', 'Nos\\.?', 'no\\.', 'pcs', 'sets?', 'NB', 'DN', 'NPS', 'lakhs?', 'lacs?', 'crores?', 'k',
  '%', '"', '”', "''", "'",
];
const UNIT_ALT = `(?:${UNIT_WORDS.join('|')})`;
/** Chat shorthand that contains digits but is still words (b4, gr8): left free for the rules. */
const SLANG_DIGITS = '(?:b4|gr8|l8r|ne1|w8|2day|2moro|2morrow|2mrw|2nite|4get|f9|s9)';

interface Pass { kind: string; re: RegExp }

/**
 * The protection passes, in priority order. Each pass masks what it finds; later passes never see
 * inside a placeholder, and a token can hold earlier placeholders (a quote with a size in it).
 */
function protectionPasses(technical: boolean, names: string[]): Pass[] {
  const p: Array<{ kind: string; re: string }> = [
    { kind: 'free', re: `${NB}${SLANG_DIGITS}${NA}` },
    { kind: K_LINK, re: '```[\\s\\S]*?```' },
    { kind: K_LINK, re: '`[^`\\n]+`' },
    { kind: K_LINK, re: '\\[[^\\]\\n]{0,300}\\]\\([^)\\s]{1,2000}\\)' },
    { kind: K_PERSON, re: '<@(?:[0-9A-Z]{26}|all)>' },
    { kind: K_LINK, re: '<(?:https?|mailto|file|dexconnect|dexterity|sleuth|projectopener|datum):[^>\\s]{1,2000}>' },
    { kind: K_LINK, re: '(?:https?|ftp|file|dexconnect|dexterity|sleuth|projectopener|datum|mailto):(?:\\/\\/)?[^\\s<>"`]*[^\\s<>"`.,;:!?)\\]}\'’]' },
    { kind: K_LINK, re: `${NB}www\\.[^\\s<>"\`]*[^\\s<>"\`.,;:!?)\\]}'’]` },
    { kind: K_LINK, re: '\\\\\\\\[\\w.$-]+(?:\\\\[^\\s\\\\<>"|?*]+)+\\\\?' },
    { kind: K_LINK, re: `${NB}[A-Za-z]:\\\\(?:[^\\s\\\\<>"|?*]+\\\\?)*` },
    { kind: K_PERSON, re: '(?<![\\w.+-])[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+' },
    { kind: K_PERSON, re: '(?<![\\p{L}\\p{N}_.])@[\\p{L}\\p{N}](?:[\\p{L}\\p{M}\\p{N}._-]*[\\p{L}\\p{M}\\p{N}])?' },
  ];
  const clean = [...new Set(names.map((n) => (typeof n === 'string' ? n.trim() : '')).filter((n) => n.length > 1 && n.length <= 80))]
    .sort((a, b) => b.length - a.length).slice(0, 500);
  if (clean.length) p.push({ kind: K_PERSON, re: `${NB}(?:${clean.map(escapeRe).join('|')})${NA}` });
  p.push(
    { kind: K_PLAIN, re: '(?<![^\\n])>[^\\n]*' },
    // line numbers: 6"-P-1001-A1A, 150-CW-2001
    { kind: K_PLAIN, re: `${NB}\\d+(?:\\.\\d+)?(?:"|”|''|in)?-[A-Z]{1,5}-\\d{2,}(?:-[A-Z0-9]+)*${NA}` },
    // sizes in inches and feet (before quotes, so 6" and 8" are not a quotation)
    { kind: technical ? K_NUM : K_PLAIN, re: `${NB}${NUM}(?:\\/\\d+)?(?:"|”|''|'(?![\\p{L}]))` },
    { kind: K_PLAIN, re: '"[^"\\n]{1,500}"' },
    { kind: K_PLAIN, re: '“[^”\\n]{1,500}”' },
    { kind: K_PLAIN, re: '‘[^’\\n]{1,500}’' },
    { kind: K_PLAIN, re: `${NB}'[^'\\n]{1,300}'${NA}` },
    // drawing, document and tag numbers: P-12513, ISO-0042 Rev B, PSV-101A, T-0412
    { kind: K_PLAIN, re: `${NB}(?=[A-Z0-9/_.-]*\\d)[A-Z][A-Z0-9]{0,11}(?:[-/_.][A-Z0-9]+)+(?:\\s?Rev\\.?\\s?[A-Z0-9]{1,3})?${NA}` },
    { kind: K_PLAIN, re: `${NB}Rev\\.?\\s?[A-Z0-9]{1,3}${NA}` },
    // dates
    { kind: K_PLAIN, re: `${NB}\\d{4}-\\d{2}-\\d{2}(?:[T ]\\d{2}:\\d{2}(?::\\d{2})?)?${NA}` },
    { kind: K_PLAIN, re: `${NB}\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}${NA}` },
    { kind: K_PLAIN, re: `${NB}\\d{1,2}(?:st|nd|rd|th)?\\s(?:of\\s)?${MONTH}\\.?(?:,?\\s\\d{4})?${NA}` },
    { kind: K_PLAIN, re: `${NB}${MONTH}\\.?\\s\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s\\d{4})?${NA}` },
    { kind: K_PLAIN, re: `${NB}${MONTH}\\s\\d{4}${NA}` },
    // times: 10:30, 5.30 pm, 4pm, 1700 hrs
    { kind: K_PLAIN, re: `${NB}\\d{1,2}:\\d{2}(?::\\d{2})?(?:\\s?[AaPp](?:\\.[Mm]\\.|[Mm])|\\s?hrs|\\s?h)?(?![\\p{L}\\p{N}])` },
    { kind: K_PLAIN, re: `${NB}\\d{1,2}(?:\\.\\d{2})?\\s?[AaPp](?:\\.[Mm]\\.|[Mm])(?![\\p{L}\\p{N}])` },
    { kind: K_PLAIN, re: `${NB}\\d{4}\\s?hrs?${NA}` },
    // amounts: ₹ 5,00,000, Rs. 500/-, 12 lakh
    { kind: K_PLAIN, re: `(?:₹|${NB}Rs\\.?|${NB}INR|${NB}USD|US\\$|\\$|€|£)\\s?${NUM}(?:\\/-)?(?:\\s?(?:lakhs?|lacs?|crores?|cr|k|mn|million|bn|billion)${NA})?` },
    { kind: K_PLAIN, re: `${NB}${NUM}\\s?(?:lakhs?|lacs?|crores?)${NA}` },
    // ranges and phone numbers: 40-120, 98450-12345
    { kind: K_NUM, re: `${NB}${NUM}(?:[-–]${NUM})+(?![\\p{L}\\p{N}_-])` },
    // sizes: 600x400, 2 x 150
    { kind: K_NUM, re: `${NB}${NUM}(?:\\s?[x×]\\s?${NUM})+(?![\\p{N}])` },
    { kind: K_NUM, re: `${NB}\\d+\\/\\d+(?![\\p{N}/])` },
  );
  if (technical) p.push({ kind: K_NUM, re: `${NB}[-+±]?${NUM}(?:st|nd|rd|th)?(?![\\p{N}])` });
  else p.push({ kind: K_PLAIN, re: `${NB}[-+±]?${NUM}(?:st|nd|rd|th)?(?:\\s?${UNIT_ALT}(?![\\p{L}\\p{N}]))?(?![\\p{N}])` });
  p.push(
    // codes with digits: N3, EL101, 3B
    { kind: K_PLAIN, re: `${NB}[A-Z]{1,6}\\d+[A-Za-z0-9]*${NA}` },
    { kind: K_PLAIN, re: `${NB}\\d+[A-Za-z]{1,4}${NA}` },
  );
  return p.map((x) => ({ kind: x.kind, re: new RegExp(x.re, 'gu') }));
}

interface Masked { text: string; tokens: string[] }

const passCache = new Map<string, Pass[]>();
function mask(text: string, technical: boolean, names: string[]): Masked | null {
  const key = `${technical ? 1 : 0}|${names.join('\u0001')}`;
  let passes = passCache.get(key);
  if (!passes) {
    passes = protectionPasses(technical, names);
    if (passCache.size > 50) passCache.clear();
    passCache.set(key, passes);
  }
  const tokens: string[] = [];
  const free: string[] = [];
  let over = false;
  // characters of our own placeholder range in the input are kept as they are
  let out = text.replace(/[-]+/g, (m) => {
    tokens.push(m);
    return K_PLAIN + enc(tokens.length - 1) + K_END;
  });
  for (const { kind, re } of passes) {
    re.lastIndex = 0;
    out = out.replace(re, (m) => {
      if (kind === 'free') { free.push(m); return `${enc(free.length - 1)}${K_END}`; }
      if (tokens.length >= MAX_TOKENS) { over = true; return m; }
      tokens.push(m);
      return kind + enc(tokens.length - 1) + K_END;
    });
  }
  if (over) return null;
  // chat shorthand with digits (b4, 2day) goes back to plain words for the rules
  if (free.length) out = out.replace(/([-]{2})/g, (_, c: string) => free[dec(`x${c}`)] ?? '');
  return { text: out, tokens };
}

/** Placeholders back to their text (a token can hold earlier placeholders). */
function unmask(s: string, tokens: string[], depth = 0): string {
  if (depth > 40) return s;
  return s.replace(PH_RE, (ph) => {
    const t = tokens[dec(ph)];
    return t === undefined ? ph : t.includes(K_END) ? unmask(t, tokens, depth + 1) : t;
  });
}

// ------------------------------------------------------------------ the document and its edits

interface Seg { text: string; src: string | null; rules: string[] }
interface Edit { start: number; end: number; to: string }

/** The text being rewritten, as segments that are either original or changed (with what they replaced). */
class Doc {
  private segs: Seg[];
  private cached: string | null = null;

  constructor(text: string) { this.segs = [{ text, src: null, rules: [] }]; }

  get text(): string {
    if (this.cached === null) this.cached = this.segs.map((s) => s.text).join('');
    return this.cached;
  }

  /** Run a global regex over the current text; `fn` returns the replacement or null to leave it. */
  replace(rule: string, re: RegExp, fn: (m: RegExpExecArray, full: string) => string | null): void {
    const full = this.text;
    const edits: Edit[] = [];
    re.lastIndex = 0;
    for (let m = re.exec(full); m; m = re.global || re.sticky ? re.exec(full) : null) {
      if (m[0] === '') re.lastIndex++;
      const to = fn(m, full);
      if (to !== null && to !== m[0]) edits.push({ start: m.index, end: m.index + m[0].length, to });
    }
    this.edit(rule, edits);
  }

  /** Apply edits given in the current text's coordinates (sorted or not; overlapping ones are dropped). */
  edit(rule: string, raw: Edit[]): void {
    if (!raw.length) return;
    const sorted = raw.length > 1 ? [...raw].sort((a, b) => a.start - b.start || a.end - b.end) : raw;
    const edits: Edit[] = [];
    let last = -1;
    for (const e of sorted) {
      if (e.start < last) continue;
      edits.push(e);
      last = e.end;
    }
    const segs = this.segs;
    const out: Seg[] = [];
    let i = 0;
    let cur: Seg | undefined = segs[0];
    let cs = 0;
    const next = () => { if (cur) cs += cur.text.length; i++; cur = segs[i]; };
    for (let ei = 0; ei < edits.length;) {
      const e0 = edits[ei++];
      // untouched segments before the edit go through as they are
      while (cur && cs + cur.text.length <= e0.start) { out.push(cur); next(); }
      let cS = e0.start;
      let cE = e0.end;
      const cl: Edit[] = [e0];
      let old = '';
      let src = '';
      const rules: string[] = [];
      if (cur && cs < cS) {
        if (cur.src === null) {
          out.push({ text: cur.text.slice(0, cS - cs), src: null, rules: [] });
          cur = { text: cur.text.slice(cS - cs), src: null, rules: [] };
          cs = cS;
        } else cS = cs; // an earlier change that this edit falls inside: they become one change
      }
      for (;;) {
        let grew = false;
        while (cur) {
          const end = cs + cur.text.length;
          const inside = cur.src !== null
            ? (cS === cE ? cs < cS && cS < end : cs < cE && end > cS)
            : cS !== cE && cs < cE;
          if (!inside) break;
          if (cur.src === null && end > cE) {
            const part = cur.text.slice(0, cE - cs);
            old += part;
            src += part;
            cur = { text: cur.text.slice(cE - cs), src: null, rules: [] };
            cs = cE;
            continue;
          }
          old += cur.text;
          src += cur.src ?? cur.text;
          for (const r of cur.rules) if (!rules.includes(r)) rules.push(r);
          if (end > cE) { cE = end; grew = true; }
          next();
        }
        while (ei < edits.length) {
          const e = edits[ei];
          const inside = e.start === e.end ? e.start > cS && e.start < cE : e.start < cE;
          if (!inside) break;
          cl.push(e);
          ei++;
          if (e.end > cE) { cE = e.end; grew = true; }
        }
        if (!grew) break;
      }
      let txt = '';
      let at = cS;
      for (const e of cl) { txt += old.slice(at - cS, e.start - cS) + e.to; at = e.end; }
      txt += old.slice(at - cS);
      if (!rules.includes(rule)) rules.push(rule);
      out.push(txt === src ? { text: txt, src: null, rules: [] } : { text: txt, src, rules });
    }
    while (cur) { out.push(cur); next(); }
    // tidy: merge neighbouring unchanged text, drop empty unchanged segments
    const tidy: Seg[] = [];
    for (const seg of out) {
      if (seg.src === null && !seg.text) continue;
      const prev = tidy[tidy.length - 1];
      if (seg.src === null && prev && prev.src === null) tidy[tidy.length - 1] = { text: prev.text + seg.text, src: null, rules: [] };
      else tidy.push(seg);
    }
    this.segs = tidy.length ? tidy : [{ text: '', src: null, rules: [] }];
    this.cached = null;
  }

  result(tokens: string[]): RestyleResult {
    let text = '';
    let sourceAt = 0;
    const changes: RestyleChange[] = [];
    for (const s of this.segs) {
      const t = unmask(s.text, tokens);
      if (s.src !== null) {
        const f = unmask(s.src, tokens);
        changes.push({ id: changes.length, from: f, to: t, rule: s.rules.join('+'), at: text.length, sourceAt });
        sourceAt += f.length;
      } else sourceAt += t.length;
      text += t;
    }
    return { text, changes };
  }
}

/**
 * Rebuild the text keeping only the changes the person accepted: each change whose id is in
 * `rejected` goes back to its original wording.
 */
export function applyChoices(result: RestyleResult, rejected: Iterable<number>): string {
  const no = new Set(rejected);
  let out = '';
  let pos = 0;
  for (const c of [...result.changes].sort((a, b) => a.at - b.at)) {
    out += result.text.slice(pos, c.at) + (no.has(c.id) ? c.from : c.to);
    pos = c.at + c.to.length;
  }
  return out + result.text.slice(pos);
}

// ------------------------------------------------------------------ helpers

/** Abbreviations whose full stop does not end a sentence. */
const DOT_ABBREV = new Set(['e.g', 'i.e', 'etc', 'approx', 'no', 'nos', 'vs', 'viz', 'cf', 'incl', 'dept', 'mr', 'mrs', 'ms', 'dr', 'er', 'sh', 'smt', 'st', 'fig', 'ref', 'rev', 'cl', 'sec', 'dwg', 'doc', 'qty', 'pl', 'abt', 'kpa', 'deg', 'sq']);

function atSentenceStart(full: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && (full[j] === ' ' || full[j] === '\t')) j--;
  if (j < 0 || full[j] === '\n') return true;
  const c = full[j];
  if (c === '!' || c === '?' || c === '…') return true;
  if (c === '.') {
    let k = j - 1;
    while (k >= 0 && j - k <= 12 && (full[k] === '.' || /\p{L}/u.test(full[k]))) k--;
    return !(k < j - 1 && DOT_ABBREV.has(full.slice(k + 1, j).toLowerCase()));
  }
  if ((c === '-' || c === '*' || c === '•') && (j === 0 || full[j - 1] === '\n') && j < i - 1) return true;
  return false;
}

const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Give a replacement the capitalisation of what it replaces. */
function caseLike(src: string, rep: string, atStart: boolean): string {
  if (!rep) return rep;
  const first = src.charAt(0);
  const upper = src.toUpperCase();
  const allCaps = src.length > 1 && src === upper && src !== src.toLowerCase() && upper.replace(/[^A-Z]/g, '').length > 1;
  if (allCaps) return atStart ? upperFirst(rep) : rep;
  if (first !== first.toLowerCase()) return upperFirst(rep);
  return rep;
}

const keyOf = (s: string) => { const k = s.toLowerCase(); return /[’\s]/.test(k) ? k.replace(/[’]/g, "'").replace(/\s+/g, ' ') : k; };

interface Dict { re: RegExp; map: Map<string, string> }

/** One regex for a word/phrase list (longest first), with flexible spaces, hyphens and apostrophes. */
function dict(entries: ReadonlyArray<readonly [string, string]>, opts: { caseSensitive?: boolean; after?: string; before?: string } = {}): Dict {
  const map = new Map<string, string>();
  for (const [k, v] of entries) map.set(opts.caseSensitive ? k.replace(/[’]/g, "'").replace(/\s+/g, ' ') : keyOf(k), v);
  const alts = [...map.keys()].sort((a, b) => b.length - a.length).map((k) => escapeRe(k).replace(/ /g, '[ \\t]+').replace(/'/g, "['’]"));
  const re = new RegExp(`${opts.before ?? ''}${B}(?:${alts.join('|')})${A}${opts.after ?? ''}`, opts.caseSensitive ? 'gu' : 'giu');
  return { re, map };
}

const lookup = (d: Dict, m: string, caseSensitive = false) => d.map.get(caseSensitive ? m.replace(/[’]/g, "'").replace(/[ \t]+/g, ' ') : keyOf(m));

/** Replace every dictionary hit with its entry, matching capitalisation. */
function applyDict(doc: Doc, rule: string, d: Dict, caseSensitive = false): void {
  const full = doc.text;
  const edits: Edit[] = [];
  d.re.lastIndex = 0;
  for (let m = d.re.exec(full); m; m = d.re.exec(full)) {
    const rep = lookup(d, m[0], caseSensitive);
    if (rep === undefined) continue;
    const start = atSentenceStart(full, m.index);
    let end = m.index + m[0].length;
    let to = caseLike(m[0], rep, start);
    if (!rep) {
      // a phrase that goes away takes its space with it; a sentence then starts with the next word
      const gap = /^[ \t]*/.exec(full.slice(end))?.[0] ?? '';
      end += gap.length;
      const next = full[end] ?? '';
      if (start && /\p{Ll}/u.test(next) && m[0].charAt(0) !== m[0].charAt(0).toLowerCase()) { to = next.toUpperCase(); end++; }
    }
    if (to !== full.slice(m.index, end)) edits.push({ start: m.index, end, to });
  }
  doc.edit(rule, edits);
}

/** Sentences of the (masked) text: [start, end) without surrounding spaces; end includes the terminal marks. */
function sentences(text: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const re = /[^\n]+/g;
  for (let line = re.exec(text); line; line = re.exec(text)) {
    const base = line.index;
    const s = line[0];
    let start = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c !== '.' && c !== '!' && c !== '?') continue;
      let j = i;
      while (j + 1 < s.length && /[.!?]/.test(s[j + 1])) j++;
      const next = s[j + 1];
      if (next !== undefined && next !== ' ' && next !== '\t') { i = j; continue; }
      if (c === '.' && j === i && !atSentenceStart(s, j + 2)) { i = j; continue; }
      push(base, s, start, j + 1);
      start = j + 1;
      i = j;
    }
    push(base, s, start, s.length);
  }
  return out;
  function push(base: number, s: string, a: number, b: number) {
    while (a < b && (s[a] === ' ' || s[a] === '\t')) a++;
    while (b > a && (s[b - 1] === ' ' || s[b - 1] === '\t')) b--;
    if (b > a) out.push({ start: base + a, end: base + b });
  }
}

const wordCount = (s: string) => (s.match(new RegExp(`[${W}]+`, 'gu')) ?? []).length;

// ------------------------------------------------------------------ word lists

/** Wordy phrases and their short forms (concise). */
const WORDY: ReadonlyArray<readonly [string, string]> = [
  ['at this point in time', 'now'], ['at the present time', 'now'], ['at the present moment', 'now'], ['at this moment in time', 'now'],
  ['in order to', 'to'], ['in order for', 'for'], ['so as to', 'to'],
  ['due to the fact that', 'because'], ['owing to the fact that', 'because'], ['in view of the fact that', 'because'],
  ['for the reason that', 'because'], ['on account of the fact that', 'because'], ['the reason why is that', 'because'], ['the reason is because', 'because'],
  ['in spite of the fact that', 'although'], ['despite the fact that', 'although'], ['regardless of the fact that', 'although'],
  ['in the event that', 'if'], ['in the event of', 'if there is'], ['in case of', 'for'],
  ['on a daily basis', 'daily'], ['on a weekly basis', 'weekly'], ['on a monthly basis', 'monthly'], ['on a regular basis', 'regularly'],
  ['in the near future', 'soon'], ['at a later date', 'later'], ['at an early date', 'soon'], ['until such time as', 'until'],
  ['a large number of', 'many'], ['a great number of', 'many'], ['a significant number of', 'many'], ['a small number of', 'a few'],
  ['the majority of', 'most'], ['a majority of', 'most'],
  ['with regard to', 'about'], ['with regards to', 'about'], ['in regard to', 'about'], ['in regards to', 'about'],
  ['with reference to', 'about'], ['with respect to', 'about'], ['in relation to', 'about'], ['in connection with', 'about'],
  ['for the purpose of', 'for'], ['in the process of', ''], ['has the ability to', 'can'], ['have the ability to', 'can'],
  ['is able to', 'can'], ['are able to', 'can'], ['make a decision', 'decide'], ['take into consideration', 'consider'],
  ['give consideration to', 'consider'], ['prior to', 'before'], ['subsequent to', 'after'], ['each and every', 'every'],
  ['first and foremost', 'first'], ['basic fundamentals', 'fundamentals'], ['end result', 'result'], ['past history', 'history'],
  ['future plans', 'plans'], ['return back', 'return'], ['repeat again', 'repeat'], ['join together', 'join'], ['combine together', 'combine'],
  ['free of cost', 'free'], ['free of charge', 'free'], ['in close proximity to', 'near'], ['in the vicinity of', 'near'],
  ['with the exception of', 'except'], ['in the absence of', 'without'], ['is in need of', 'needs'], ['are in need of', 'need'],
  ['make changes to', 'change'], ['carry out a review of', 'review'], ['perform a review of', 'review'], ['conduct a review of', 'review'],
  ['conduct an inspection of', 'inspect'], ['provide assistance to', 'help'], ['provide assistance', 'help'],
  ['at all times', 'always'], ['in a timely manner', 'promptly'], ['in the amount of', 'for'], ['a total of', ''],
  ['as of now', 'now'], ['as of today', 'today'], ['till date', 'so far'], ['up until', 'until'], ['as per', 'per'],
  ['make an attempt to', 'try to'], ['make an effort to', 'try to'], ['is indicative of', 'shows'], ['in excess of', 'over'],
  ['a sufficient number of', 'enough'], ['along the lines of', 'like'], ['in light of the fact that', 'because'],
  ['for all intents and purposes', ''], ['at the end of the day', ''],
];

/** Fillers and hedges dropped by concise (with their comma). */
const FILLERS: ReadonlyArray<string> = [
  'basically', 'actually', 'literally', 'simply', 'totally', 'honestly', 'kind of', 'sort of', 'kinda', 'sorta',
  'I think that', 'I think', 'I feel that', 'I feel like', 'I believe that', 'I guess', 'I suppose', 'it seems that', 'it seems like',
  'please note that', 'kindly note that', 'please be informed that', 'please be advised that', 'this is to inform you that',
  'I would like to inform you that', 'I wanted to let you know that', 'I want to let you know that', 'I am writing to let you know that',
  'I am writing to inform you that', 'it is to be noted that', 'it should be noted that', 'it is important to note that',
  'needless to say', 'to be honest', 'as a matter of fact', "for what it's worth", 'you know', 'I mean', 'anyway', 'anyways',
];

/** Contractions expanded by formal. */
const CONTRACTIONS: ReadonlyArray<readonly [string, string]> = [
  ["don't", 'do not'], ["doesn't", 'does not'], ["didn't", 'did not'], ["can't", 'cannot'], ["couldn't", 'could not'],
  ["won't", 'will not'], ["wouldn't", 'would not'], ["shouldn't", 'should not'], ["isn't", 'is not'], ["aren't", 'are not'],
  ["wasn't", 'was not'], ["weren't", 'were not'], ["hasn't", 'has not'], ["haven't", 'have not'], ["hadn't", 'had not'],
  ["mustn't", 'must not'], ["needn't", 'need not'], ["shan't", 'shall not'], ["mightn't", 'might not'], ["ain't", 'is not'],
  ["I'm", 'I am'], ["I've", 'I have'], ["I'll", 'I will'], ["I'd", 'I would'], ["you're", 'you are'], ["you've", 'you have'],
  ["you'll", 'you will'], ["you'd", 'you would'], ["we're", 'we are'], ["we've", 'we have'], ["we'll", 'we will'], ["we'd", 'we would'],
  ["they're", 'they are'], ["they've", 'they have'], ["they'll", 'they will'], ["they'd", 'they would'], ["he's", 'he is'],
  ["she's", 'she is'], ["he'll", 'he will'], ["she'll", 'she will'], ["he'd", 'he would'], ["she'd", 'she would'],
  ["it's", 'it is'], ["it'll", 'it will'], ["that's", 'that is'], ["that'll", 'that will'], ["there's", 'there is'],
  ["there're", 'there are'], ["here's", 'here is'], ["what's", 'what is'], ["who's", 'who is'], ["where's", 'where is'],
  ["when's", 'when is'], ["how's", 'how is'], ["let's", 'let us'], ["y'all", 'all of you'], ["could've", 'could have'],
  ["should've", 'should have'], ["would've", 'would have'], ["might've", 'might have'], ["must've", 'must have'],
  ["it's been", 'it has been'], ["that's been", 'that has been'], ["there's been", 'there has been'], ["he's been", 'he has been'],
  ["she's been", 'she has been'], ["who's been", 'who has been'], ["what's been", 'what has been'],
  ["I'd been", 'I had been'], ["we'd been", 'we had been'], ["they'd been", 'they had been'], ["you'd been", 'you had been'],
];

/** Casual words and office shorthand, and their formal wording (case-insensitive). */
const CASUAL: ReadonlyArray<readonly [string, string]> = [
  ['pls', 'please'], ['plz', 'please'], ['plss', 'please'], ['plzz', 'please'], ['pls find attached', 'please find attached'],
  ['asap', 'as soon as possible'], ['gonna', 'going to'], ['wanna', 'want to'], ['gotta', 'have to'], ['gotcha', 'understood'],
  ['kinda', 'somewhat'], ['sorta', 'somewhat'], ['dunno', 'do not know'], ['lemme', 'let me'], ['gimme', 'give me'],
  ['yeah', 'yes'], ['yep', 'yes'], ['yup', 'yes'], ['yea', 'yes'], ['ya sure', 'yes, certainly'], ['nope', 'no'], ['nah', 'no'],
  ['thx', 'thank you'], ['thnx', 'thank you'], ['thnks', 'thank you'], ['thanx', 'thank you'], ['tnx', 'thank you'], ['tks', 'thank you'],
  ['thanku', 'thank you'], ['thank u', 'thank you'], ['thanks a ton', 'thank you very much'], ['thanks a lot', 'thank you very much'],
  ['tysm', 'thank you very much'], ['fyi', 'for your information'], ['btw', 'by the way'], ['imo', 'in my opinion'],
  ['imho', 'in my opinion'], ['afaik', 'as far as I know'], ['tbh', 'to be honest'], ['idk', 'I do not know'], ['iirc', 'if I remember correctly'],
  ['brb', 'I will be right back'], ['nvm', 'never mind'], ['ttyl', 'I will talk to you later'], ['omw', 'on my way'],
  ['w/', 'with'], ['w/o', 'without'], ['b4', 'before'], ['2day', 'today'], ['2moro', 'tomorrow'], ['2morrow', 'tomorrow'], ['2mrw', 'tomorrow'],
  ['tmrw', 'tomorrow'], ['tmr', 'tomorrow'], ['tmw', 'tomorrow'], ['tomo', 'tomorrow'], ['tomm', 'tomorrow'], ['2nite', 'tonight'], ['tonite', 'tonight'],
  ['yday', 'yesterday'], ['cuz', 'because'], ['coz', 'because'], ['bcoz', 'because'], ['bcos', 'because'], ['bcz', 'because'],
  ['abt', 'about'], ['approx', 'approximately'], ['wrt', 'with regard to'], ['w.r.t', 'with regard to'], ['pfa', 'please find attached'], ['pfb', 'please find below'], ['ppl', 'people'], ['msg', 'message'], ['msgs', 'messages'], ['pic', 'picture'], ['pics', 'pictures'], ['info', 'information'], ['convo', 'conversation'],
  ['sry', 'sorry'], ['sorry for the trouble', 'I apologise for the inconvenience'], ['no worries', 'no problem'], ['cool', 'fine'],
  ['awesome', 'excellent'], ['okie', 'okay'], ['okk', 'okay'], ['okey', 'okay'],
  ['hey', 'hello'], ['hiya', 'hello'], ['hii', 'hello'], ['hiii', 'hello'], ['gud', 'good'], ['gr8', 'great'], ['l8r', 'later'],
  ['rgds', 'regards'], ['regds', 'regards'], ['brgds', 'best regards'],
  ['tho', 'though'], ['thru', 'through'], ['wud', 'would'], ['cud', 'could'], ['shud', 'should'], ['wid', 'with'],
  ['dat', 'that'], ['wat', 'what'], ['wht', 'what'], ['whn', 'when'], ['hv', 'have'], ['hav', 'have'], ['ne1', 'anyone'],
  ['abv', 'above'], ['reqd', 'required'], ['chk', 'check'], ['dwg', 'drawing'], ['dwgs', 'drawings'], ['doc', 'document'], ['docs', 'documents'],
  ['govt', 'government'], ['dept', 'department'], ['mgmt', 'management'], ['mgr', 'manager'], ['yrs', 'years'],
  ['wk', 'week'], ['wks', 'weeks'], ['mins', 'minutes'], ['hrs', 'hours'], ['w8', 'wait'], ['ack', 'acknowledged'],
  // Indian-English office shorthand
  ['kindly do the needful', 'please take the necessary action'], ['do the needful', 'take the necessary action'],
  ['please do the needful', 'please take the necessary action'], ['pls do the needful', 'please take the necessary action'],
  ['revert back', 'reply'], ['please revert back', 'please reply'], ['pls revert back', 'please reply'], ['kindly revert back', 'please reply'], ['pls revert', 'please reply'], ['please revert', 'please reply'], ['kindly revert', 'please reply'],
  ['revert asap', 'reply as soon as possible'], ['revert at the earliest', 'reply at the earliest'],
  ['kindly', 'please'], ['prepone', 'bring forward'], ['preponed', 'brought forward'], ['preponing', 'bringing forward'],
  ['updation', 'update'], ['discuss about', 'discuss'], ['out of station', 'travelling'], ['today itself', 'today'],
  ['now itself', 'right now'], ['as on date', 'as of today'], ['till date', 'to date'], ['kindly intimate', 'please inform'],
  ['please intimate', 'please inform'], ['intimate me', 'inform me'], ['intimate us', 'inform us'], ['do one thing', 'here is a suggestion'], ['what is your good name', 'may I have your name'], ['good name', 'name'],
  ['mail me', 'email me'], ['mail it', 'email it'], ['mailed', 'emailed'], ['drop a mail', 'send an email'], ['drop me a mail', 'send me an email'],
  ['hope u r fine', 'I hope you are well'], ['hope you are fine', 'I hope you are well'], ['cousin brother', 'cousin'], ['cousin sister', 'cousin'],
  ['on leave tmrw', 'on leave tomorrow'], ['pls find', 'please find'], ['pls note', 'please note'], ['kindly note', 'please note'],
  ['pls check', 'please check'], ['pls confirm', 'please confirm'], ['pls share', 'please share'], ['pls send', 'please send'],
  ['&', 'and'], ['vs', 'versus'], ['etc etc', 'and so on'],
];

/**
 * Short casual words matched only in lower case or with a capital first letter: in capitals they
 * are something else (TQ is a technical query, U a U-bend, N north, K kelvin, PL a part list).
 */
const CASUAL_EXACT: ReadonlyArray<readonly [string, string]> = ([
  ['tq', 'thank you'], ['tqvm', 'thank you very much'], ['ty', 'thank you'], ['np', 'no problem'], ['u', 'you'], ['ur', 'your'],
  ['r u', 'are you'], ['u r', 'you are'], ['r', 'are'], ['n', 'and'], ['k', 'okay'], ['kk', 'okay'], ['ok', 'okay'], ['gm', 'good morning'],
  ['gn', 'good night'], ['tc', 'take care'], ['bt', 'but'], ['pl', 'please'], ['plz', 'please'],
] as Array<[string, string]>).flatMap(([k, v]) => (k.length === 1 || k.includes(' ') ? [[k, v]]
  : [[k, v], [k.charAt(0).toUpperCase() + k.slice(1), v.charAt(0).toUpperCase() + v.slice(1)]]) as Array<[string, string]>);

/** Office and engineering abbreviations: [abbreviation, full term, plural of the full term]. */
export const GLOSSARY: ReadonlyArray<readonly [string, string, string?]> = [
  ['MTO', 'material take-off'], ['RFI', 'request for information', 'requests for information'], ['ISO', 'isometric drawing'],
  ['GA', 'general arrangement drawing'], ['P&ID', 'piping and instrumentation diagram'], ['PFD', 'process flow diagram'],
  ['UFD', 'utility flow diagram'], ['BFD', 'block flow diagram'], ['BOQ', 'bill of quantities', 'bills of quantities'],
  ['BOM', 'bill of materials', 'bills of materials'], ['IFC', 'issued for construction'], ['IFR', 'issued for review'],
  ['IFA', 'issued for approval'], ['IFI', 'issued for information'], ['IFB', 'issued for bid'], ['IFD', 'issued for design'],
  ['AFC', 'approved for construction'], ['GFC', 'good for construction'], ['TQ', 'technical query', 'technical queries'],
  ['NCR', 'non-conformance report'], ['MOM', 'minutes of meeting'], ['ETA', 'estimated time of arrival'],
  ['WIP', 'work in progress'], ['QC', 'quality control'], ['QA', 'quality assurance'], ['DCS', 'distributed control system'],
  ['PSV', 'pressure safety valve'], ['PRV', 'pressure relief valve'], ['TSV', 'thermal safety valve'], ['NRV', 'non-return valve'],
  ['MOV', 'motor-operated valve'], ['SDV', 'shutdown valve'], ['ESDV', 'emergency shutdown valve'], ['BDV', 'blowdown valve'],
  ['PCV', 'pressure control valve'], ['FCV', 'flow control valve'], ['LCV', 'level control valve'], ['TCV', 'temperature control valve'],
  ['HAZOP', 'hazard and operability study', 'hazard and operability studies'], ['HAZID', 'hazard identification study', 'hazard identification studies'],
  ['SIL', 'safety integrity level'], ['NDT', 'non-destructive testing'], ['RT', 'radiographic testing'], ['UT', 'ultrasonic testing'],
  ['DPT', 'dye penetrant testing'], ['MPT', 'magnetic particle testing'], ['PWHT', 'post-weld heat treatment'],
  ['WPS', 'welding procedure specification'], ['PQR', 'procedure qualification record'], ['WQT', 'welder qualification test'],
  ['ITP', 'inspection and test plan'], ['MR', 'material requisition'], ['PR', 'purchase requisition'], ['PO', 'purchase order'],
  ['WO', 'work order'], ['TBE', 'technical bid evaluation'], ['CBE', 'commercial bid evaluation'], ['RFQ', 'request for quotation', 'requests for quotation'],
  ['LOI', 'letter of intent', 'letters of intent'], ['LOA', 'letter of award', 'letters of award'], ['VDR', 'vendor document register'],
  ['VDB', 'vendor data book'], ['MDR', 'master document register'], ['DBM', 'design basis memorandum', 'design basis memoranda'],
  ['DBR', 'design basis report'], ['FEED', 'front-end engineering design'], ['EPC', 'engineering, procurement and construction'],
  ['EPCM', 'engineering, procurement and construction management'], ['PMC', 'project management consultant'],
  ['LSTK', 'lump-sum turnkey'], ['PMS', 'piping material specification'], ['SLD', 'single-line diagram'], ['MCC', 'motor control centre'],
  ['PLC', 'programmable logic controller'], ['HVAC', 'heating, ventilation and air conditioning'], ['FAT', 'factory acceptance test'],
  ['SAT', 'site acceptance test'], ['KOM', 'kick-off meeting'], ['SOW', 'scope of work', 'scopes of work'], ['NOC', 'no-objection certificate'],
  ['HSE', 'health, safety and environment'], ['PPE', 'personal protective equipment'], ['JSA', 'job safety analysis', 'job safety analyses'],
  ['PTW', 'permit to work', 'permits to work'], ['TPI', 'third-party inspection'], ['IRN', 'inspection release note'],
  ['MRN', 'material receipt note'], ['GRN', 'goods receipt note'], ['DPR', 'daily progress report'], ['MPR', 'monthly progress report'],
  ['WFH', 'work from home'], ['OOO', 'out of office'], ['TBD', 'to be decided'], ['TBC', 'to be confirmed'], ['TBA', 'to be announced'],
  ['KT', 'knowledge transfer'], ['CAD', 'computer-aided design'], ['BIM', 'building information modelling'], ['LOD', 'level of development'],
  ['RCC', 'reinforced cement concrete'], ['PCC', 'plain cement concrete'], ['PEB', 'pre-engineered building'], ['BBS', 'bar bending schedule'],
  ['ASME', 'American Society of Mechanical Engineers'], ['API', 'American Petroleum Institute'], ['ASTM', 'American Society for Testing and Materials'],
  ['BIS', 'Bureau of Indian Standards'], ['IBR', 'Indian Boiler Regulations'], ['PESO', 'Petroleum and Explosives Safety Organisation'],
  ['OISD', 'Oil Industry Safety Directorate'], ['MOC', 'management of change'], ['CAPA', 'corrective and preventive action'],
  ['RCA', 'root cause analysis', 'root cause analyses'], ['KPI', 'key performance indicator'], ['SOP', 'standard operating procedure'],
  ['NPS', 'nominal pipe size'], ['DN', 'nominal diameter'], ['NB', 'nominal bore'], ['OD', 'outside diameter'], ['WT', 'wall thickness'],
  ['SCH', 'pipe schedule'], ['ERW', 'electric resistance welded'], ['SMLS', 'seamless'], ['RF', 'raised face'], ['RTJ', 'ring-type joint'],
  ['FF', 'flat face'], ['BW', 'butt weld'], ['SW', 'socket weld'], ['CS', 'carbon steel'], ['SS', 'stainless steel'],
  ['LTCS', 'low-temperature carbon steel'], ['GRE', 'glass-reinforced epoxy'], ['HDPE', 'high-density polyethylene'],
  ['FRP', 'fibre-reinforced plastic'], ['TOS', 'top of steel'], ['BOP', 'bottom of pipe'], ['COP', 'centre of pipe'], ['FGL', 'finished ground level'],
  ['HPP', 'high point of paving'], ['TOC', 'top of concrete'], ['EL', 'elevation'], ['CL', 'centre line'], ['NNF', 'normally no flow'],
  ['LO', 'locked open'], ['LC', 'locked closed'], ['NC', 'normally closed'], ['NO', 'normally open'], ['FO', 'fail open'],
  ['FC', 'fail closed'], ['DP', 'differential pressure'], ['NPSH', 'net positive suction head'], ['MAWP', 'maximum allowable working pressure'],
  ['MDMT', 'minimum design metal temperature'], ['CA', 'corrosion allowance'], ['PT', 'pressure transmitter'], ['TT', 'temperature transmitter'],
  ['FT', 'flow transmitter'], ['LT', 'level transmitter'], ['PG', 'pressure gauge'], ['TG', 'temperature gauge'], ['LG', 'level gauge'],
  ['IO', 'input/output'], ['ESD', 'emergency shutdown'], ['F&G', 'fire and gas'], ['UPS', 'uninterruptible power supply'],
  ['VFD', 'variable-frequency drive'], ['CCTV', 'closed-circuit television'], ['SPIR', 'spare parts interchangeability record'],
  ['BD', 'business development'], ['HR', 'human resources'], ['AMC', 'annual maintenance contract'], ['FY', 'financial year'],
  ['EOI', 'expression of interest', 'expressions of interest'], ['CV', 'curriculum vitae', 'curricula vitae'],
];

/** Glossary abbreviations that are ordinary English words when written in capitals by someone shouting. */
const GLOSSARY_SKIP_SHOUT = new Set(['NO', 'LO', 'IO', 'CA', 'DP', 'FF', 'FO', 'FC', 'LC', 'NC', 'CL', 'EL', 'CS', 'SS', 'RF', 'BD', 'CV', 'TT', 'PG', 'LG', 'TG']);

/** Relative times spelled out by explanatory. */
const RELATIVE_TIMES: ReadonlyArray<readonly [string, string]> = [
  ['EOD', 'end of day'], ['COB', 'close of business'], ['EOW', 'end of week'], ['EOM', 'end of month'], ['EOY', 'end of year'],
  ['EOB', 'end of business day'], ['ASAP', 'as soon as possible'], ['tmrw', 'tomorrow'], ['tmr', 'tomorrow'], ['tmw', 'tomorrow'],
  ['tomo', 'tomorrow'], ['tomm', 'tomorrow'], ['2moro', 'tomorrow'], ['2morrow', 'tomorrow'], ['2mrw', 'tomorrow'], ['yday', 'yesterday'],
  ['ystd', 'yesterday'], ['2day', 'today'], ['2nite', 'tonight'], ['tonite', 'tonight'], ['wknd', 'weekend'], ['nxt wk', 'next week'],
  ['next wk', 'next week'], ['this wk', 'this week'], ['b4', 'before'], ['l8r', 'later'],
];

/** Informal words and the precise term (technical). */
const PRECISE: ReadonlyArray<readonly [string, string]> = [
  ['temp', 'temperature'], ['temps', 'temperatures'], ['dia', 'diameter'], ['dwg', 'drawing'], ['dwgs', 'drawings'],
  ['spec', 'specification'], ['specs', 'specifications'], ['qty', 'quantity'], ['qtys', 'quantities'], ['elev', 'elevation'],
  ['pipe line', 'pipeline'], ['pipe lines', 'pipelines'], ['isos', 'isometrics'], ['calc', 'calculation'], ['calcs', 'calculations'],
  ['reqd', 'required'], ['info', 'information'], ['equip', 'equipment'], ['vol', 'volume'],
];

/** Verbs that start a request ("Send the file"). */
const REQUEST_VERBS = [
  'send', 'share', 'check', 'update', 'revise', 'fix', 'review', 'call', 'reply', 'submit', 'issue', 'prepare', 'attach', 'confirm',
  'complete', 'finish', 'mark', 'add', 'remove', 'change', 'correct', 'upload', 'forward', 'inform', 'tell', 'let', 'give', 'provide',
  'arrange', 'schedule', 'book', 'coordinate', 'follow', 'ensure', 'make', 'do', 'get', 'look', 'take', 'find', 'stop', 'start', 'move',
  'close', 'open', 'approve', 'sign', 'print', 'plot', 'scan', 'email', 'mail', 'ping', 'raise', 'resolve', 'clarify', 'explain',
  'include', 'highlight', 'release', 'return', 'delete', 'rename', 'merge', 'model', 'route', 'reroute', 'recheck', 'verify', 'validate',
  'finalise', 'finalize', 'circulate', 'compile', 'incorporate', 'attend', 'visit', 'meet', 'join', 'come', 'bring', 'keep', 'put',
  'use', 'run', 'write', 'draft', 'note', 'list', 'count', 'collect', 'organise', 'organize', 'set', 'fill', 'mention', 'tag', 'cc',
  'notify', 'remind', 'save', 'copy', 'paste', 'export', 'import', 'reissue', 'resend', 'recheck', 'see', 'read', 'go',
];

/** Participles for "it looks like … hasn't yet been <participle>". */
const PARTICIPLE: Record<string, string> = {
  send: 'sent', share: 'shared', update: 'updated', upload: 'uploaded', issue: 'issued', submit: 'submitted', check: 'checked',
  review: 'reviewed', attach: 'attached', revise: 'revised', fix: 'fixed', mark: 'marked', add: 'added', include: 'included',
  close: 'closed', complete: 'completed', finish: 'finished', approve: 'approved', sign: 'signed', return: 'returned',
  forward: 'forwarded', confirm: 'confirmed', release: 'released', prepare: 'prepared', correct: 'corrected', change: 'changed',
  incorporate: 'incorporated', circulate: 'circulated', raise: 'raised', resolve: 'resolved', clarify: 'clarified', plot: 'plotted',
  print: 'printed', scan: 'scanned', file: 'filed', model: 'modelled', route: 'routed', verify: 'verified', finalise: 'finalised',
  finalize: 'finalized', do: 'done', make: 'made', give: 'given', write: 'written', take: 'taken', run: 'run', read: 'read',
  save: 'saved', export: 'exported', compile: 'compiled', draft: 'drafted', book: 'booked', schedule: 'scheduled', arrange: 'arranged',
  delete: 'deleted', rename: 'renamed', merge: 'merged', reissue: 'reissued', resend: 'resent', provide: 'provided', fill: 'filled',
  collect: 'collected', validate: 'validated', highlight: 'highlighted', remove: 'removed', mail: 'mailed', email: 'emailed', pay: 'paid',
};

const GREETING_RE = /^\s*(?:hi+|hello|hey|dear|good\s+(?:morning|afternoon|evening|day)|greetings|namaste|namaskar|respected|hai)(?![\p{L}])/iu;
const THANKS_RE = /(?<![\p{L}])(?:thanks|thank\s+you|thx|thanku|regards|cheers|appreciate|grateful|dhanyavaa?d|shukriya|tq|ty)(?![\p{L}])/iu;

// ------------------------------------------------------------------ concise

const GREETING_PADDING = [
  '(?:I[ \\t]+)?(?:hope|trust)[ \\t]+(?:you[ \\t]+are|you[\'’]re|u[ \\t]+r|ur|you|all[ \\t]+is|everything[ \\t]+is|everyone[ \\t]+is|this[ \\t]+(?:message|mail|email|note)[ \\t]+finds[ \\t]+you)[ \\t]+(?:doing[ \\t]+)?(?:well|good|fine|great|ok|okay)(?:[ \\t]+and[ \\t]+(?:safe|healthy))?(?:[ \\t]+today)?[ \\t]*[.!,]*',
  '(?:I[ \\t]+)?hope[ \\t]+you[ \\t]+(?:had|are[ \\t]+having|have)[ \\t]+(?:a[ \\t]+)?(?:good|great|nice|wonderful|lovely)[ \\t]+(?:day|week|weekend|morning)[ \\t]*[.!,]*',
  'greetings[ \\t]+(?:of|for)[ \\t]+the[ \\t]+day[ \\t]*[.!,]*',
  'how[ \\t]+are[ \\t]+you(?:[ \\t]+doing)?(?:[ \\t]+today)?[ \\t]*\\?+',
].map((x) => `${B}(?:${x})`).join('|');

const LOWERABLE = new Set(['please', 'could', 'can', 'would', 'the', 'this', 'that', 'we', 'our', 'it', 'there', 'kindly', 'as', 'here', 'attached', 'find', 'let']);

function concise(doc: Doc): void {
  // keep the short greeting, drop the padding after it ("Hi Priya, hope you are well. Please…" -> "Hi Priya, please…")
  doc.replace('concise.greeting', new RegExp(`(?<=,)([ \\t]*)(?:${GREETING_PADDING})[ \\t]*([\\p{Lu}][\\p{L}]*)`, 'giu'), (m) => {
    const word = m[2];
    return LOWERABLE.has(word.toLowerCase()) ? `${m[1] ? ' ' : ''}${word.toLowerCase()}` : null;
  });
  doc.replace('concise.greeting', new RegExp(`([ \\t]*)(?:${GREETING_PADDING})([ \\t]*)`, 'giu'), (m, full) => {
    const after = full.slice(m.index + m[0].length);
    if (!after || after.startsWith('\n')) return '';
    return m[1] && m.index > 0 && full[m.index - 1] !== '\n' ? ' ' : '';
  });
  applyDict(doc, 'concise.phrase', dict(WORDY));
  // a phrase that went away can leave two spaces
  doc.replace('concise.phrase', /(?<=\S) {2,}(?=\S)/g, () => ' ');
  const fillers = FILLERS.map((f) => escapeRe(f).replace(/ /g, '[ \\t]+').replace(/'/g, "['’]")).sort((a, b) => b.length - a.length);
  const fillerRe = new RegExp(
    `(?<pre>,?[ \\t]*)${B}(?<f>${fillers.join('|')}|just(?![ \\t]+(?:now|in[ \\t]+time|before|after|as|like|enough|then|a[ \\t]+(?:minute|moment|second|few|little)|the|one|once)\\b)|(?<!not[ \\t]+)really)${A}(?![ \\t]+(?:so|not|of)\\b)(?<comma>[ \\t]*,)?(?<post>[ \\t]*)`,
    'giu');
  // twice: a filler can hide another ("Please note that I think …")
  for (let round = 0; round < 3; round++) {
    const full = doc.text;
    const edits: Edit[] = [];
    let lastEnd = -1;
    let lastBegan = false;
    fillerRe.lastIndex = 0;
    for (let m = fillerRe.exec(full); m; m = fillerRe.exec(full)) {
      const g = m.groups ?? {};
      const pre = g.pre ?? '';
      const f = g.f ?? '';
      const post = g.post ?? '';
      const end = m.index + m[0].length;
      const next = full[end] ?? '';
      const begin: boolean = (lastBegan && m.index === lastEnd) || atSentenceStart(full, m.index + pre.length);
      if (begin) {
        // a filler alone ("Actually!") is left as written
        if (!post || !/[\p{L}\p{N}\uE000-\uE8FF]/u.test(next)) continue;
        const capital = f.charAt(0) !== f.charAt(0).toLowerCase() && /\p{Ll}/u.test(next) && !/\p{Lu}/u.test(full[end + 1] ?? '');
        edits.push(capital ? { start: m.index, end: end + 1, to: pre + next.toUpperCase() } : { start: m.index, end, to: pre });
      } else {
        // "We just need" -> "We need"; "fine, basically, but" -> "fine, but"; "fine basically." -> "fine."
        edits.push({ start: m.index, end, to: post ? pre : '' });
      }
      lastEnd = end;
      lastBegan = begin;
    }
    if (!edits.length) break;
    doc.edit('concise.filler', edits);
  }
  const repeat = /(?<![\p{L}\p{M}\p{N}_\uE000-\uE8FF'’])(the|a|an|to|of|is|in|on|at|for|and|or|but|it|that|this|we|i|you|be|will|can|please|with|as|are|was|by|from|have|has|not|very|so|just|our|your|my|me|us)(?:[ \t]+\1)+(?![\p{L}\p{M}\p{N}_\uE000-\uE8FF])/giu;
  doc.replace('concise.repeat', repeat, (m) => m[1]);
}

// ------------------------------------------------------------------ formal

const EMOJI = '(?:(?![©®™])\\p{Extended_Pictographic}(?:\\uFE0F|\\p{EMod})?(?:\\u200D\\p{Extended_Pictographic}(?:\\uFE0F|\\p{EMod})?)*|[\\u{1F1E6}-\\u{1F1FF}]{2})';
const EMOTICON = `(?<![^\\s])(?:[:;=8][-'^]?[)(DPpOo3/\\\\|\\]\\[]+|x[Dd]|<3|\\^_*\\^)(?=[\\s.,!?]|$)`;
const LAUGH = `${B}(?:lol+|lmao+|rofl+|ha(?:ha)+h?|he(?:he)+|hihi+)${A}`;

function formal(doc: Doc): void {
  applyDict(doc, 'formal.contraction', dict(CONTRACTIONS));
  applyDict(doc, 'formal.casual', dict(CASUAL_EXACT, { caseSensitive: true }), true);
  applyDict(doc, 'formal.casual', dict(CASUAL));
  // filler: emoji, emoticons and laughter (a line of only that goes altogether)
  const filler = `(?:${EMOJI}|${EMOTICON}|${LAUGH})`;
  const run = `[ \\t]*${filler}(?:[ \\t]*${filler})*[ \\t]*`;
  doc.replace('formal.emoji', new RegExp(`(?<![^\\n])${run}\\n|\\n${run}$`, 'gu'), () => '');
  doc.replace('formal.emoji', new RegExp(`([ \\t]*)${filler}(?:[ \\t]*${filler})*([ \\t]*)`, 'gu'), (m, full) => {
    const before = m.index > 0 ? full[m.index - 1] : '\n';
    const afterIdx = m.index + m[0].length;
    const after = afterIdx < full.length ? full[afterIdx] : '\n';
    if (before === '\n' || after === '\n' || /[.,!?;:)]/.test(after)) return '';
    return m[1] || m[2] ? ' ' : '';
  });
  doc.replace('formal.exclaim', /[!?]{2,}|!+1+/g, (m) => (m[0].includes('?') ? '?' : '!'));
  doc.replace('formal.exclaim', /\.{4,}/g, () => '...');
  // lone "i" and sentence capitals
  doc.replace('formal.capital', new RegExp(`${B}i${A}`, 'gu'), () => 'I');
  capitaliseSentences(doc, 'formal.capital');
  // "Hello please send" -> "Hello, please send"
  doc.replace('formal.punctuation', new RegExp(`^([ \\t]*(?:hi+|hello|hey|dear|good[ \\t]+(?:morning|afternoon|evening)|greetings|namaste)(?:[ \\t]+(?:${PH_PERSON}|\\p{Lu}\\p{Ll}+|all|everyone|team|sir|madam))?)(?=[ \\t]+(?:please|could|can|would|kindly|i|we|the|this|find|attached|hope|thank|just)(?![\\p{L}]))`, 'iu'), (m) => `${m[1]},`);
  endPunctuation(doc);
}

function capitaliseSentences(doc: Doc, rule: string): void {
  const full = doc.text;
  const edits: Edit[] = [];
  for (const s of sentences(full)) {
    let i = s.start;
    // a bullet's text is left as written
    if (/^[-*•]\s/.test(full.slice(i, i + 2))) continue;
    while (i < s.end && /["“‘'(\[]/.test(full[i])) i++;
    const c = full[i];
    if (!c || !/\p{Ll}/u.test(c)) continue;
    if (!atSentenceStart(full, s.start)) continue;
    // "iPhone", "eBay": a lowercase letter followed by a capital is a name
    if (/\p{Lu}/u.test(full[i + 1] ?? '')) continue;
    edits.push({ start: i, end: i + 1, to: c.toUpperCase() });
  }
  doc.edit(rule, edits);
}

const SIGN_OFF_RE = /^(?:regards|warm regards|best regards|kind regards|thanks and regards|thanks & regards|thanks|thank you|best|cheers|sincerely|yours sincerely|yours faithfully|yours truly|with regards|rgds)$/i;

function endPunctuation(doc: Doc): void {
  const full = doc.text;
  const lines: Array<{ start: number; end: number; text: string }> = [];
  for (let start = 0; start <= full.length;) {
    const nl = full.indexOf('\n', start);
    const end = nl < 0 ? full.length : nl;
    lines.push({ start, end, text: full.slice(start, end) });
    if (nl < 0) break;
    start = nl + 1;
  }
  const edits: Edit[] = [];
  const contentAfter = (k: number) => lines.slice(k + 1).some((l) => l.text.trim());
  lines.forEach((l, k) => {
    const t = l.text.replace(/[ \t]+$/, '');
    const trimmed = t.trim();
    if (!trimmed || /^(?:[-*•>]|\d+[.)])\s/.test(trimmed) || /^#{1,6}\s/.test(trimmed)) return;
    const endAt = l.start + t.length;
    const last = t.charAt(t.length - 1);
    if (/[.!?:;,…)\]"'”’।॥]/u.test(last)) return;
    if (new RegExp(`${PH_LINK}$`, 'u').test(t)) return;
    // Hindi and other scripts keep their own punctuation
    if (/[^\p{Script=Latin}\p{N}\p{P}\p{S}\s\uE000-\uE8FF]/u.test(last)) return;
    const words = wordCount(trimmed);
    if (GREETING_RE.test(trimmed) && words <= 4 && !trimmed.slice(0, -1).includes(',')) { if (contentAfter(k)) edits.push({ start: endAt, end: endAt, to: ',' }); return; }
    if (SIGN_OFF_RE.test(trimmed)) { if (contentAfter(k)) edits.push({ start: endAt, end: endAt, to: ',' }); else if (/thank/i.test(trimmed)) edits.push({ start: endAt, end: endAt, to: '.' }); return; }
    if (words < 2) return;
    // a name under a sign-off
    if (k > 0 && SIGN_OFF_RE.test(lines[k - 1].text.trim().replace(/[,.]$/, '')) && words <= 3) return;
    edits.push({ start: endAt, end: endAt, to: '.' });
  });
  doc.edit('formal.punctuation', edits);
}

// ------------------------------------------------------------------ diplomatic

const HARSH: ReadonlyArray<readonly [string, string]> = [
  ['you are wrong', 'I see this differently'], ["you're wrong", 'I see this differently'], ['this is wrong', "this doesn't look quite right"],
  ['that is wrong', "that doesn't look quite right"], ["that's wrong", "that doesn't look quite right"], ["this's wrong", "this doesn't look quite right"],
  ['it is wrong', "it doesn't look quite right"], ["it's wrong", "it doesn't look quite right"], ['is wrong', "doesn't look quite right"],
  ['are wrong', "don't look quite right"], ['is incorrect', "doesn't look quite right"], ['are incorrect', "don't look quite right"],
  ['this is unacceptable', 'this is a concern'], ['that is unacceptable', 'that is a concern'], ['is unacceptable', 'is a concern'],
  ['your mistake', 'the error'], ['your fault', 'the issue'], ['you made a mistake', 'there seems to be an error'],
  ['you made mistakes', 'there seem to be some errors'], ['you messed up', 'something went wrong'], ['you screwed up', 'something went wrong'],
  ['as I already said', 'as mentioned'], ['as I said before', 'as mentioned earlier'], ['as I told you', 'as mentioned'],
  ['I already told you', 'as mentioned earlier'], ['I told you', 'as mentioned'], ['how many times do I have to', 'just a reminder to'],
  ['obviously', 'of course'], ['what is the status', 'could you share the status'], ["what's the status", 'could you share the status'],
  ['why is this not done', 'is anything holding this up'], ['why is it not done', 'is anything holding it up'],
];

const SUBJECTS = `(?:you|he|she|they|we|your\\s+team|the\\s+team|${PH_PERSON})`;

function diplomatic(doc: Doc, opts: RestyleOptions): void {
  applyDict(doc, 'diplomatic.harsh', dict(HARSH));
  // blame: "you didn't send the MTO" -> "it looks like the MTO hasn't yet been sent"
  const verbs = Object.keys(PARTICIPLE).sort((a, b) => b.length - a.length).join('|');
  const people = /^(?:me|us|him|her|them|anyone|everyone|anybody|somebody|someone|to|back|on|in|at|for|with|about|out|up|you)\b/i;
  const blameVerbs = [...new Set([...Object.keys(PARTICIPLE), 'reply', 'respond', 'answer', 'call', 'tell', 'inform', 'attend', 'join', 'come', 'follow'])].sort((a, b) => b.length - a.length).join('|');
  const blame = new RegExp(`${B}(you)[ \\t]+(?:didn['’]t|did[ \\t]+not|haven['’]t|have[ \\t]+not|forgot[ \\t]+to|failed[ \\t]+to)[ \\t]+(${blameVerbs})${A}([^.!?;\\n]*)`, 'giu');
  doc.replace('diplomatic.blame', blame, (m, full) => {
    const verb = m[2].toLowerCase();
    const ws = /[ \t]*$/.exec(m[3])?.[0] ?? '';
    let rest = m[3].slice(0, m[3].length - ws.length);
    // the object runs to the end of the clause; a time ("today", "by 5 pm") stays after it
    const cut = /[ \t]*(?:,|[ \t](?:but|and then|because|so|as|which)\b)/i.exec(rest);
    const after = cut ? rest.slice(cut.index) : '';
    rest = cut ? rest.slice(0, cut.index) : rest;
    const timeAt = /[ \t]+(?:yet|so far|today|tonight|tomorrow|on time|by|before|until|till|this|last|in time|again)\b/i.exec(rest);
    let obj = (timeAt ? rest.slice(0, timeAt.index) : rest).trim();
    const when = (timeAt ? rest.slice(timeAt.index) : '').replace(/^[ \t]+yet\b/i, '');
    const lead = atSentenceStart(full, m.index) ? 'It looks like' : 'it looks like';
    const pp = PARTICIPLE[verb];
    if (!pp || !obj || people.test(obj) || wordCount(obj) > 8) {
      return `${lead} you haven't had a chance to ${verb}${rest.replace(/[ \t]+yet\b/i, '')} yet${after}${ws}`;
    }
    const head = obj.split(/[ \t]+/).pop() ?? '';
    const plural = /^(?:these|those)\b/i.test(obj) || (/[^s]s$/i.test(head) && !/(?:us|is|ss)$/i.test(head) && !head.includes('\uE001'));
    if (/^(?:it|this|that)$/i.test(obj)) obj = obj.toLowerCase();
    return `${lead} ${obj} ${plural ? "haven't" : "hasn't"} yet been ${pp}${when}${after}${ws}`;
  });
  // absolutes about people
  doc.replace('diplomatic.absolute', new RegExp(`(${B}${SUBJECTS}(?:['’]re|['’]s|[ \\t]+are|[ \\t]+is|[ \\t]+were|[ \\t]+was)?[ \\t]+)(always|never)${A}`, 'giu'), (m) => {
    const w = m[2];
    const to = w.toLowerCase() === 'always' ? 'often' : 'rarely';
    return m[1] + (w.charAt(0) === 'A' || w.charAt(0) === 'N' ? upperFirst(to) : to);
  });
  softenRequests(doc);
  if (opts.courtesy !== false) courtesy(doc);
}

const VERB_RE = new RegExp(`^(${REQUEST_VERBS.join('|')})(?![\\p{L}\\p{N}'’-])`, 'iu');
const NOT_REQUEST_AFTER = /^[ \t]+(?:is|are|was|were|has|have|had|will|would|can|could|should|may|might|must|does|did|looks?|seems?|valve|valves|list|lists|sheet|sheets|plan|plans|point|points|up|attached|below|above|enclosed|in|of)\b/i;

function softenRequests(doc: Doc): void {
  const full = doc.text;
  const edits: Edit[] = [];
  for (const s of sentences(full)) {
    const sent = full.slice(s.start, s.end);
    if (/[?]$/.test(sent)) continue;
    const terminal = /[.!]*$/.exec(sent)?.[0] ?? '';
    const body = sent.slice(0, sent.length - terminal.length);
    const lead = new RegExp(`^((?:${PH_PERSON}[ \\t]*,?[ \\t]*)?)((?:please|pls|plz|kindly)[ \\t]+)?`, 'iu').exec(body);
    const who = lead?.[1] ?? '';
    const please = lead?.[2] ?? '';
    const restStart = (lead?.[0] ?? '').length;
    const rest = body.slice(restStart);
    // "You need to …", "You must …", "You should …"
    const need = /^you[ \t]+(need[ \t]+to|have[ \t]+to|must|should|ought[ \t]+to)[ \t]+(?=\p{L})/iu.exec(rest);
    const addr = who ? `${who.replace(/[ \t,]+$/, '')}, ` : '';
    const cap = (w: string) => (addr ? w : upperFirst(w));
    if (need) {
      const kind = need[1].toLowerCase().replace(/[ \t]+/g, ' ');
      const after = rest.slice(need[0].length);
      if (wordCount(after) < 1) continue;
      const to = kind === 'need to' ? `${addr}${cap('could')} you ${please ? 'please ' : ''}${after}?`
        : kind === 'should' || kind === 'ought to' ? `${addr}${cap('it')} would help if you could ${after}.`
          : `${addr}${cap('please')} make sure to ${after}.`;
      edits.push({ start: s.start, end: s.end, to });
      continue;
    }
    // "Don't change the GA" -> "Please don't change the GA"
    if (!please && /^(?:don['’]t|do[ \t]+not)[ \t]+\p{L}/iu.test(rest) && wordCount(rest) >= 3) {
      edits.push({ start: s.start + restStart, end: s.start + restStart + 1, to: `${who ? 'please' : 'Please'} ${rest.charAt(0).toLowerCase()}` });
      continue;
    }
    const v = VERB_RE.exec(rest);
    if (!v) continue;
    const after = rest.slice(v[0].length);
    if (!/^[ \t]+\S/.test(after) || NOT_REQUEST_AFTER.test(after)) continue;
    const verb = v[1].toLowerCase();
    if (verb === 'let' && !/^[ \t]+(?:me|us|him|her|them|the|everyone|all)\b/i.test(after)) continue;
    if ((verb === 'find' || verb === 'see' || verb === 'note' || verb === 'list' || verb === 'set') && /^[ \t]+(?:attached|below|above|enclosed|the attached)\b/i.test(after)) continue;
    if (wordCount(after) < 1) continue;
    const to = `${addr}${cap('could')} you ${please ? 'please ' : ''}${verb}${after}?`;
    edits.push({ start: s.start, end: s.end, to });
  }
  doc.edit('diplomatic.request', edits);
}

function courtesy(doc: Doc): void {
  const full = doc.text;
  const visible = full.replace(PH_RE, ' x ');
  if (wordCount(visible) < 3) return;
  const edits: Edit[] = [];
  if (!GREETING_RE.test(full)) {
    const lead = /^[ \t\n]*/.exec(full)?.[0] ?? '';
    const rest = full.slice(lead.length);
    if (new RegExp(`^${PH_PERSON}`, 'u').test(rest)) edits.push({ start: lead.length, end: lead.length, to: 'Hi ' });
    else edits.push({ start: lead.length, end: lead.length, to: 'Hi,\n' });
  }
  if (!THANKS_RE.test(full)) {
    const body = full.replace(/\s+$/, '');
    const lines = body.split('\n');
    const lastLine = lines[lines.length - 1].trim();
    // a signature under the message: thank before it
    const prev = (lines[lines.length - 2] ?? '').trim();
    const signature = lines.length >= 2 && /^(?:[-–—~][ \t]*)?\p{Lu}[\p{L}.]*(?:[ \t]+\p{Lu}[\p{L}.]*){0,2}$/u.test(lastLine) && (!prev || /[.!?,]$/.test(prev));
    if (signature) {
      const at = body.length - lines[lines.length - 1].length;
      edits.push({ start: at, end: at, to: 'Thank you.\n' });
    } else edits.push({ start: body.length, end: body.length, to: `${/[.!?…।]$/.test(body) || new RegExp(`${PH}$`, 'u').test(body) ? '' : '.'}\nThank you.` });
  }
  doc.edit('diplomatic.courtesy', edits);
}

// ------------------------------------------------------------------ explanatory

interface GlossaryEntry { abbr: string; full: string; plural: string }

function glossary(opts: RestyleOptions): GlossaryEntry[] {
  const out = new Map<string, GlossaryEntry>();
  for (const [abbr, full, plural] of GLOSSARY) out.set(abbr, { abbr, full, plural: plural ?? `${full}s` });
  for (const [abbr, full] of Object.entries(opts.glossary ?? {})) {
    if (typeof full !== 'string' || !/^[A-Z][A-Z0-9&/-]{0,9}$/.test(abbr) || !full.trim() || full.length > 120) continue;
    out.set(abbr, { abbr, full: full.trim(), plural: `${full.trim()}s` });
  }
  return [...out.values()];
}

const CAUSE_CUE = /\b(?:because|since|due to|owing to|as a result|the reason|so that)\b/i;
const ACTION_CUE = new RegExp(`(?:^|\\b)(?:please|pls|plz|kindly|need(?:s)?[ \\t]+to|have[ \\t]+to|has[ \\t]+to|must|should|let['’]s|let[ \\t]+us|can[ \\t]+you|could[ \\t]+you|will[ \\t]+you|would[ \\t]+you|request[ \\t]+you|next[ \\t]+step|to[ \\t]+do|action)\\b`, 'i');

type Section = 'what' | 'why' | 'next';

function categorise(clause: string): Section {
  if (/^(?:because|since|due to|owing to|as a result of|the reason)\b/i.test(clause)) return 'why';
  if (ACTION_CUE.test(clause) || VERB_RE.test(clause)) return 'next';
  return 'what';
}

function explanatory(doc: Doc, opts: RestyleOptions): void {
  structure(doc);
  const times = dict(RELATIVE_TIMES);
  doc.replace('explanatory.time', times.re, (m, full) => {
    const rep = lookup(times, m[0]);
    if (rep === undefined) return null;
    // already spelled out after it, as in "EOD (end of day)"
    if (/^[ \t]*\(/.test(full.slice(m.index + m[0].length))) return null;
    return caseLike(m[0], rep, atSentenceStart(full, m.index));
  });
  const entries = glossary(opts);
  const byAbbr = new Map(entries.map((e) => [e.abbr, e] as const));
  const alts = entries.map((e) => escapeRe(e.abbr)).sort((a, b) => b.length - a.length);
  const re = new RegExp(`(?<![${W}'’&/-])(${alts.join('|')})(s)?(?![${W}&]|['’]\\p{L}|-\\p{L})`, 'gu');
  const full = doc.text;
  const lower = full.toLowerCase();
  const shouting = (() => { const letters = full.replace(PH_RE, '').replace(/[^\p{L}]/gu, ''); return letters.length > 12 && letters === letters.toUpperCase(); })();
  const seen = new Set<string>();
  doc.replace('explanatory.glossary', re, (m, text) => {
    const e = byAbbr.get(m[1]);
    if (!e || seen.has(e.abbr)) return null;
    seen.add(e.abbr);
    if (shouting && GLOSSARY_SKIP_SHOUT.has(e.abbr)) return null;
    const after = text.slice(m.index + m[0].length);
    if (/^[ \t]*\(/.test(after) || new RegExp(`^[ \\t]*${PH}`, 'u').test(after)) return null;
    if (/\([ \t]*$/.test(text.slice(0, m.index))) return null;
    if (lower.includes(e.full.toLowerCase())) return null;
    return `${m[0]} (${m[2] ? e.plural : e.full})`;
  });
}

/** What / Why / Next for a message with cause or action cues. */
function structure(doc: Doc): void {
  const full = doc.text;
  if (/(?:^|\n)[ \t]*(?:What|Why|Next)[ \t]*:/.test(full)) return;
  const lines = full.split('\n');
  let first = 0;
  let last = lines.length - 1;
  while (first <= last && !lines[first].trim()) first++;
  while (last >= first && !lines[last].trim()) last--;
  if (first > last) return;
  if (GREETING_RE.test(lines[first]) && wordCount(lines[first]) <= 4 && first < last) first++;
  while (last > first && (SIGN_OFF_RE.test(lines[last].trim().replace(/[,.!]$/, '')) || (wordCount(lines[last]) <= 3 && SIGN_OFF_RE.test((lines[last - 1] ?? '').trim().replace(/[,.!]$/, ''))))) last--;
  // one paragraph of prose only
  const body = lines.slice(first, last + 1);
  if (body.length !== 1 || /^\s*(?:[-*•>]|\d+[.)])\s/.test(body[0])) return;
  const text = body[0];
  if (!CAUSE_CUE.test(text) && !ACTION_CUE.test(text) && !/,[ \t]+so[ \t]/i.test(text)) return;
  const offset = lines.slice(0, first).reduce((n, l) => n + l.length + 1, 0);
  const clauses: Array<{ text: string; section: Section }> = [];
  for (const s of sentences(text)) {
    let sent = text.slice(s.start, s.end).replace(/[.!]+$/, '');
    const q = /\?$/.test(sent);
    // "Since X, Y" / "Because X, Y"
    const lead = /^(because|since|as)[ \t]+([^,]+),[ \t]*(.+)$/i.exec(sent);
    if (lead) {
      clauses.push({ text: lead[2], section: 'why' });
      clauses.push({ text: lead[3], section: categorise(lead[3]) });
      continue;
    }
    const so = /^(.+?),?[ \t]+so[ \t]+(?!that\b|far\b|much\b|many\b)(.+)$/i.exec(sent);
    if (so && wordCount(so[1]) >= 2 && wordCount(so[2]) >= 2) {
      const then = categorise(so[2]);
      if (then === 'next') { clauses.push({ text: so[1], section: 'what' }, { text: so[2], section: 'next' }); }
      else { clauses.push({ text: so[1], section: 'why' }, { text: so[2], section: 'what' }); }
      continue;
    }
    const because = /^(.+?)[ \t]+(because(?:[ \t]+of)?|due[ \t]+to|owing[ \t]+to|as[ \t]+a[ \t]+result[ \t]+of)[ \t]+(.+)$/i.exec(sent);
    if (because && wordCount(because[1]) >= 2) {
      const reason = /^because$/i.test(because[2]) ? because[3] : `${because[2].replace(/[ \t]+/g, ' ')} ${because[3]}`;
      clauses.push({ text: because[1], section: categorise(because[1]) }, { text: reason, section: 'why' });
      continue;
    }
    if (q) sent += '?';
    clauses.push({ text: sent, section: categorise(sent) });
  }
  const sections = new Set(clauses.map((c) => c.section));
  if (clauses.length < 2 || sections.size < 2 || (!sections.has('why') && !sections.has('next'))) return;
  const tidy = (c: string) => {
    let t = c.trim().replace(/^(?:and|but|so)[ \t]+/i, '').replace(/[,;:]+$/, '');
    if (/^\p{Ll}/u.test(t) && !/^\p{Ll}\p{Lu}/u.test(t)) t = upperFirst(t);
    return /[.!?…]$/.test(t) || new RegExp(`${PH_LINK}$`, 'u').test(t) ? t : `${t}.`;
  };
  const out: string[] = [];
  for (const [section, label] of [['what', 'What'], ['why', 'Why'], ['next', 'Next']] as const) {
    const parts = clauses.filter((c) => c.section === section).map((c) => tidy(c.text));
    if (parts.length) out.push(`${label}: ${parts.join(' ')}`);
  }
  doc.edit('explanatory.structure', [{ start: offset, end: offset + text.length, to: out.join('\n') }]);
}

// ------------------------------------------------------------------ technical

const UNIT_CANON: ReadonlyArray<readonly [string, string]> = [
  ['mm', 'mm'], ['mms', 'mm'], ['millimeter', 'mm'], ['millimeters', 'mm'], ['millimetre', 'mm'], ['millimetres', 'mm'],
  ['cm', 'cm'], ['cms', 'cm'], ['km', 'km'], ['kms', 'km'], ['m', 'm'], ['mtr', 'm'], ['mtrs', 'm'], ['meter', 'm'], ['meters', 'm'], ['metre', 'm'], ['metres', 'm'],
  ['in.', 'in.'], ['inch', 'in'], ['inches', 'in'], ['ft', 'ft'], ['feet', 'ft'], ['foot', 'ft'],
  ['kg', 'kg'], ['kgs', 'kg'], ['kilogram', 'kg'], ['kilograms', 'kg'], ['gm', 'g'], ['gms', 'g'], ['gram', 'g'], ['grams', 'g'], ['g', 'g'],
  ['t', 't'], ['ton', 't'], ['tons', 't'], ['tonne', 't'], ['tonnes', 't'], ['mt', 't'],
  ['kn', 'kN'], ['knm', 'kN·m'], ['nm', 'N·m'], ['pa', 'Pa'], ['kpa', 'kPa'], ['mpa', 'MPa'], ['bar', 'bar'], ['psi', 'psi'],
  ['kpag', 'kPa(g)'], ['kpa g', 'kPa(g)'], ['kpa(g)', 'kPa(g)'], ['kpa (g)', 'kPa(g)'], ['kpaa', 'kPa(a)'], ['kpa a', 'kPa(a)'], ['kpa(a)', 'kPa(a)'], ['kpa (a)', 'kPa(a)'],
  ['barg', 'bar(g)'], ['bar g', 'bar(g)'], ['bar(g)', 'bar(g)'], ['bar (g)', 'bar(g)'], ['bara', 'bar(a)'], ['bar a', 'bar(a)'], ['bar(a)', 'bar(a)'], ['bar (a)', 'bar(a)'],
  ['psig', 'psi(g)'], ['psia', 'psi(a)'],
  ['°c', '°C'], ['° c', '°C'], ['℃', '°C'], ['degc', '°C'], ['deg c', '°C'], ['deg. c', '°C'], ['degree c', '°C'], ['degrees c', '°C'],
  ['°f', '°F'], ['degf', '°F'], ['deg f', '°F'], ['degrees f', '°F'],
  ['kw', 'kW'], ['kva', 'kVA'], ['kv', 'kV'], ['hz', 'Hz'], ['rpm', 'rpm'],
  ['m3/h', 'm³/h'], ['m3/hr', 'm³/h'], ['m³/hr', 'm³/h'], ['m³/h', 'm³/h'], ['cum/hr', 'm³/h'], ['cum/h', 'm³/h'], ['m3', 'm³'], ['m³', 'm³'], ['cum', 'm³'],
  ['m2', 'm²'], ['m²', 'm²'], ['sqm', 'm²'], ['sq m', 'm²'], ['sq.m', 'm²'], ['sq. m', 'm²'],
  ['l', 'L'], ['ltr', 'L'], ['ltrs', 'L'], ['litre', 'L'], ['litres', 'L'], ['liter', 'L'], ['liters', 'L'], ['ml', 'mL'],
  ['hr', 'h'], ['hrs', 'h'], ['hour', 'h'], ['hours', 'h'], ['h', 'h'], ['min', 'min'], ['mins', 'min'], ['minute', 'min'], ['minutes', 'min'],
  ['sec', 's'], ['secs', 's'], ['second', 's'], ['seconds', 's'],
];

function technical(doc: Doc, opts: RestyleOptions): void {
  applyDict(doc, 'technical.term', dict(PRECISE));
  doc.replace('technical.approx', new RegExp(`(?:${B}(?:approx\\.?|approximately|abt\\.?|about|around|roughly|circa|ca\\.)|~)[ \\t]*(?=${PH_NUM})`, 'giu'), () => '≈ ');
  // units: a thin space and the SI symbol
  const canon = new Map(UNIT_CANON.map(([k, v]) => [k, v] as const));
  const alts = [...canon.keys()].sort((a, b) => b.length - a.length).map((k) => escapeRe(k).replace(/ /g, '[ \\t]?'));
  const unitRe = new RegExp(`(${PH_NUM})([ \\t\\u00A0\\u2009\\u202F]*)(${alts.join('|')})(?![\\p{L}\\p{N}³²(]|\\.\\p{L})`, 'giu');
  doc.replace('technical.unit', unitRe, (m) => {
    const key = m[3].toLowerCase().replace(/[ \t]+/g, ' ');
    const unit = canon.get(key) ?? canon.get(key.replace(/ /g, ''));
    if (!unit) return null;
    // "m" and "t" written in capitals are something else (M for million, T for a tag)
    if ((m[3] === 'M' || m[3] === 'T' || m[3] === 'G' || m[3] === 'H') && m[2] !== '') return null;
    return `${m[1]}${THIN_SPACE}${unit}`;
  });
  abbreviate(doc, opts);
  bulletLists(doc);
}

/** First full use keeps the term with its abbreviation; later uses become the abbreviation. */
function abbreviate(doc: Doc, opts: RestyleOptions): void {
  const entries = glossary(opts).filter((e) => /\s/.test(e.full));
  const byFull = new Map<string, { e: GlossaryEntry; plural: boolean }>();
  for (const e of entries) {
    byFull.set(e.full.toLowerCase(), { e, plural: false });
    byFull.set(e.plural.toLowerCase(), { e, plural: true });
  }
  const alts = [...byFull.keys()].sort((a, b) => b.length - a.length).map((k) => escapeRe(k).replace(/[ -]/g, '[ \\t-]?'));
  const re = new RegExp(`${B}(?:${alts.join('|')})${A}`, 'giu');
  const full = doc.text;
  const norm = (s: string) => s.toLowerCase().replace(/[ \t-]+/g, (x) => (x.includes('-') ? '-' : ' '));
  const find = (s: string) => byFull.get(norm(s)) ?? [...byFull.entries()].find(([k]) => k.replace(/[ -]/g, '') === s.toLowerCase().replace(/[ \t-]/g, ''))?.[1];
  const used = new Set<string>();
  // abbreviations already in use before any full term
  const firstFull = new Map<string, number>();
  re.lastIndex = 0;
  for (let m = re.exec(full); m; m = re.exec(full)) { const hit = find(m[0]); if (hit && !firstFull.has(hit.e.abbr)) firstFull.set(hit.e.abbr, m.index); }
  for (const [abbr, at] of firstFull) {
    const abbrRe = new RegExp(`(?<![${W}])${escapeRe(abbr)}s?(?![${W}])`, 'u');
    const before = abbrRe.exec(full.slice(0, at));
    if (before) used.add(abbr);
  }
  doc.replace('technical.abbreviation', re, (m, text) => {
    const hit = find(m[0]);
    if (!hit) return null;
    const { e, plural } = hit;
    const abbr = plural ? `${e.abbr}s` : e.abbr;
    if (!used.has(e.abbr)) {
      used.add(e.abbr);
      if (new RegExp(`^[ \\t]*\\(${escapeRe(e.abbr)}s?\\)`, 'u').test(text.slice(m.index + m[0].length))) return null;
      return `${m[0]} (${abbr})`;
    }
    // "the full term (ABBR)" written twice stays as written the second time only if explained there
    return abbr;
  });
}

/** "Need 40 elbows, 12 tees, 6 reducers and 3 flanges." -> a bullet list. */
function bulletLists(doc: Doc): void {
  const full = doc.text;
  const edits: Edit[] = [];
  for (const s of sentences(full)) {
    const sent = full.slice(s.start, s.end);
    if (/^\s*[-*•]\s/.test(sent) || sent.includes('\n')) continue;
    const terminal = /[.!]?$/.exec(sent)?.[0] ?? '';
    const body = sent.slice(0, sent.length - terminal.length);
    let head: string;
    let list: string;
    const colon = body.indexOf(':');
    const numAt = body.search(new RegExp(`(?:≈ )?${PH_NUM}`, 'u'));
    if (colon > 0 && !new RegExp(`${PH}`, 'u').test(body.slice(colon - 1, colon + 1))) {
      head = body.slice(0, colon).trimEnd();
      list = body.slice(colon + 1).trim();
    } else if (numAt >= 0) {
      head = body.slice(0, numAt).trimEnd();
      list = body.slice(numAt);
    } else continue;
    const items = list.split(/[ \t]*(?:,|;)[ \t]*(?:and[ \t]+|&[ \t]+)?|[ \t]+(?:and|&)[ \t]+/i).map((x) => x.trim()).filter(Boolean);
    if (items.length < 3 || items.some((x) => wordCount(x) > 6)) continue;
    if (colon <= 0 && !items.every((x) => new RegExp(`^(?:≈ )?${PH_NUM}[ \\t]*\\p{L}`, 'u').test(x))) continue;
    const intro = head ? `${head.replace(/[ \t]*[-–—]$/, '')}:` : '';
    // what follows on the same line starts on a line of its own
    const gap = /^[ \t]*/.exec(full.slice(s.end))?.[0] ?? '';
    const more = s.end + gap.length < full.length && full[s.end + gap.length] !== '\n';
    edits.push({ start: s.start, end: s.end + (more ? gap.length : 0), to: `${intro}${intro ? '\n' : ''}${items.map((x) => `- ${x}`).join('\n')}${more ? '\n' : ''}` });
  }
  doc.edit('technical.list', edits);
}

// ------------------------------------------------------------------ entry point

const STYLES: Record<RestyleStyle, (doc: Doc, opts: RestyleOptions) => void> = {
  concise: (doc) => concise(doc),
  formal: (doc) => formal(doc),
  diplomatic,
  explanatory,
  technical,
};

/**
 * Rewrite `text` in a communication style. Deterministic and offline: the same text and style
 * always give the same result, and numbers, units, dates, times, names, @mentions, drawing, line
 * and tag numbers, code, links and quoted text come out byte-for-byte as they went in (the
 * technical style alone normalises the unit written after a number, never the number).
 */
export function restyle(text: string, style: RestyleStyle, opts: RestyleOptions = {}): RestyleResult {
  if (typeof text !== 'string' || !text || !STYLES[style]) return { text: typeof text === 'string' ? text : '', changes: [] };
  if (text.length > RESTYLE_MAX_CHARS) return { text, changes: [] };
  const masked = mask(text, style === 'technical', Array.isArray(opts.names) ? opts.names : []);
  if (!masked) return { text, changes: [] };
  const doc = new Doc(masked.text);
  STYLES[style](doc, opts);
  // every protected token comes out exactly once, or nothing is changed
  const want = (masked.text.match(PH_RE) ?? []).sort().join('');
  const got = (doc.text.match(PH_RE) ?? []).sort().join('');
  if (want !== got) return { text, changes: [] };
  const result = doc.result(masked.tokens);
  return result.changes.length ? result : { text, changes: [] };
}
