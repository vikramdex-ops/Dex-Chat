// Words for the on-device search index. Words are found by Unicode word boundaries
// (Intl.Segmenter), so Hindi and Tamil keep their vowel signs and viramas inside the word, and
// numbers like 4.2 or 101 stay whole. Words are folded the same way for indexing and searching:
// compatibility forms joined (NFKC), lower case, and invisible joiners and soft hyphens removed.

type WordSegmenter = { segment(text: string): Iterable<{ segment: string; isWordLike?: boolean }> };

const MAX_WORD = 48;
const MAX_WORDS = 2000;

let shared: WordSegmenter | null | undefined;
function segmenter(): WordSegmenter | null {
  if (shared === undefined) {
    try { shared = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null; } catch { shared = null; }
  }
  return shared;
}

/** Fold a word: NFKC, lower case, no zero-width joiners or soft hyphens. */
export function fold(word: string): string {
  return word.normalize('NFKC').toLowerCase().replace(/[­​-‍⁠﻿]/g, '');
}

/** Letters (with their combining marks) and digits, as one word; used where Intl.Segmenter is missing. */
const WORD = /[\p{L}\p{M}\p{N}]+(?:[.,'’][\p{L}\p{M}\p{N}]+)*/gu;
const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;

/** Message markup that is not words: mentions of people by id, link targets. */
const strip = (text: string) => text.replace(/<@[0-9A-Z]{26}>|<@all>/g, ' ').replace(/\]\((?:https?|dexconnect):[^)\s]*\)/g, '] ');

/** The words of a text, folded, in order (repeats kept). */
export function tokenize(text: string, seg: WordSegmenter | null = segmenter()): string[] {
  const src = strip(text.normalize('NFC'));
  const out: string[] = [];
  const push = (w: string) => {
    const f = fold(w);
    if (f && f.length <= MAX_WORD && HAS_WORD_CHAR.test(f)) out.push(f);
  };
  if (seg) {
    for (const s of seg.segment(src)) {
      if (s.isWordLike === false) continue;
      if (s.isWordLike === undefined && !HAS_WORD_CHAR.test(s.segment)) continue;
      push(s.segment);
      if (out.length >= MAX_WORDS) break;
    }
  } else {
    for (const m of src.matchAll(WORD)) {
      push(m[0]);
      if (out.length >= MAX_WORDS) break;
    }
  }
  return out;
}

/** The distinct words of a text. */
export const terms = (text: string, seg?: WordSegmenter | null): string[] => [...new Set(tokenize(text, seg))];

/** Where each word is in a text (for marking the words a search matched). */
export function wordSpans(text: string, seg: WordSegmenter | null = segmenter()): Array<{ start: number; end: number; word: string }> {
  const out: Array<{ start: number; end: number; word: string }> = [];
  if (seg) {
    let at = 0;
    for (const s of seg.segment(text)) {
      const start = (s as { index?: number }).index ?? at;
      at = start + s.segment.length;
      if (s.isWordLike === false || !HAS_WORD_CHAR.test(s.segment)) continue;
      out.push({ start, end: at, word: fold(s.segment) });
      if (out.length >= MAX_WORDS) break;
    }
  } else {
    for (const m of text.matchAll(WORD)) {
      out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, word: fold(m[0]) });
      if (out.length >= MAX_WORDS) break;
    }
  }
  return out;
}

/**
 * A line of the text around the first matched word, matched words between [[ and ]] (the Search
 * view draws those as highlights). Mentions are shown as "@…", as the Search view does.
 */
export function snippet(text: string, query: string[], width = 180, seg?: WordSegmenter | null): string {
  const flat = text.replace(/<@[0-9A-Z]{26}>/g, '@…').replace(/\s+/g, ' ').trim();
  const spans = wordSpans(flat, seg).filter((s) => query.some((q) => s.word.startsWith(q)));
  if (!spans.length) return flat.slice(0, width);
  let from = Math.max(0, Math.min(spans[0].start - 40, flat.length - width));
  // start at a word, not in the middle of one
  if (from > 0) { const sp = flat.indexOf(' ', from); if (sp >= 0 && sp < spans[0].start) from = sp + 1; }
  const to = Math.min(flat.length, from + width);
  let out = from > 0 ? '…' : '';
  let at = from;
  for (const s of spans) {
    if (s.start < from || s.end > to) continue;
    out += flat.slice(at, s.start).replace(/\[\[|\]\]/g, '') + '[[' + flat.slice(s.start, s.end) + ']]';
    at = s.end;
  }
  out += flat.slice(at, to).replace(/\[\[|\]\]/g, '');
  return to < flat.length ? `${out}…` : out;
}

/** Escaped marks (\*) stand in as these private-use characters while the real marks are removed. */
const ESCAPED: Record<string, string> = { '\\': '', '`': '', '*': '', '_': '', '~': '', '<': '', '>': '' };
const UNESCAPE = new Map(Object.entries(ESCAPED).map(([c, p]) => [p, c] as const));

/**
 * A search snippet as plain text, the way the Switchboard previews a message: the words stay and
 * the formatting marks go (**bold**, _italic_, ~~struck~~, `code`, ++underlined++, [text](link),
 * headings, quotes and list bullets). The [[ ]] around matched words stay for the highlighting.
 * Snippets are cut from longer messages, so a mark can lose its partner ("…on **Area 4"): marks
 * are removed one by one, not in pairs. A mark standing alone between spaces ("4 * 5") is not
 * formatting and stays, as do underscores inside a word (P12_GA_rev). Escaped marks (\*) show the
 * character. Mentions read "@…" and Space references "#…".
 */
export function plainSnippet(text: string): string {
  return text
    .replace(/\[\[/g, '\u0001').replace(/\]\]/g, '\u0002')
    .replace(/\\([\\`*_~<>])/g, (_, c: string) => ESCAPED[c])
    .replace(/<@all>/g, '@everyone')
    .replace(/<@[0-9A-Z]{26}>/g, '@…')
    .replace(/<#[0-9A-Z]{26}>/g, '#…')
    .replace(/\[([^\]\n]+)\]\([^)\s]*\)?/g, '$1')
    // block marks at the start of a line: headings, quotes, bullets and to-do boxes
    .replace(/(^|\n)[ \t]*(?:#{1,6}[ \t]+|>+[ \t]?|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?)/g, '$1')
    .replace(/\+\+(?=\S)([^+\n]*[^+\s])\+\+/g, '$1')
    .replace(/(\s|^)?([*~`]+)(\s|$)?/g, (m, a: string | undefined, _run: string, b: string | undefined) => (a !== undefined && b !== undefined ? m : (a ?? '') + (b ?? '')))
    // underscores are italics only at a word's edge
    .replace(/(^|[^\p{L}\p{M}\p{N}_])_+(?=[^\s_])|(?<=[^\s_])_+(?=$|[^\p{L}\p{M}\p{N}_])/gu, '$1')
    .replace(/[-]/g, (c) => UNESCAPE.get(c) ?? c)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\u0001/g, '[[').replace(/\u0002/g, ']]');
}
