// The office's days off, read from the holiday circular management issues each year (a letterhead,
// "Ref: HRD/CIR/2026/011   26-Mar-2026", "Official Holidays for the period of January-2026 to
// December-2026", then a table Sl. No. | Date | Day | Description over a few pages and notes at the
// end). Nib reads the PDF's text (or the text the desktop read from a scan), these pure functions
// turn it into rows with a kind and a check each, compare them with what is registered, and work
// out the new list. No year's list is written in code: next year's circular goes through the same
// reader. See docs/HOLIDAYS.md.

/**
 * What a day in the office's calendar is:
 * - `holiday`: a named holiday (Pongal, Diwali), also when it falls on a Sunday;
 * - `weekoff`: one of the office's alternating Saturdays off;
 * - `compoff`: a compensatory day off;
 * - `compwork`: a compensatory WORKING day (a Saturday worked to make up for a day off). Never a holiday.
 */
export type OfficeDayKind = 'holiday' | 'weekoff' | 'compoff' | 'compwork';
export const OFFICE_DAY_KINDS: OfficeDayKind[] = ['holiday', 'weekoff', 'compoff', 'compwork'];
/** Days nobody works: everything but a compensatory working day. */
export const isOffKind = (k: OfficeDayKind): boolean => k !== 'compwork';

/** Where a registered day came from (shown in Office holidays). */
export interface OfficeDaySource {
  /** The circular's reference ("HRD/CIR/2026/011") and its date. */
  ref: string | null;
  refDate: string | null;
  /** The PDF's file name and SHA-256 (hex). */
  file: string;
  hash: string;
  /** The row's serial number in the circular. */
  sl: number | null;
}

export interface OfficeDay {
  date: string;
  name: string;
  kind: OfficeDayKind;
  /** A compensatory working day: the day off it makes up for. */
  for?: string | null;
  /** Read from a circular; absent when an administrator typed it in. */
  source?: OfficeDaySource | null;
}

/** A circular registered on the hub (one per file; the same file twice changes nothing). */
export interface CircularRecord {
  hash: string;
  ref: string | null;
  refDate: string | null;
  year: number;
  file: string;
  /** When it was registered, and by whom (null: built into the hub). */
  at: number;
  by: string | null;
  counts: Record<OfficeDayKind, number>;
}

/** Why a row is not registered as it stands. */
export type CircularProblem =
  /** The date could not be read. */
  | { code: 'date' }
  /** The day written beside the date is not that date's weekday (0 = Sunday). */
  | { code: 'weekday'; actual: number }
  /** The date is outside the circular's period. */
  | { code: 'year'; year: number }
  /** Another row has the same date. */
  | { code: 'dupDate'; sl: number | null }
  /** "Compensatory work for X": X is not a day off in this circular (or could not be read). */
  | { code: 'forMissing'; for: string | null }
  /** No description, or nothing that says what kind of day it is. */
  | { code: 'unknown' };

/** Problems with the document as a whole (the rows are still read). */
export type CircularWarning =
  /** Serial numbers jump: a row may be missing. */
  | { code: 'serialGap'; after: number; next: number }
  | { code: 'serialDup'; sl: number }
  /** No "for the period of …" line: the year is the one most rows are in. */
  | { code: 'noPeriod' };

export interface CircularRow {
  sl: number | null;
  /** As written: "06-June-2026", "6-Nov-2026". */
  dateText: string;
  date: string | null;
  /** As written ("Thursday"), or null when the row has none. */
  dayText: string | null;
  name: string;
  kind: OfficeDayKind | null;
  for: string | null;
  problems: CircularProblem[];
}

export interface CircularRead {
  /** The year the circular is for (from its period, else the year most rows are in). */
  year: number | null;
  period: { from: string; to: string } | null;
  ref: string | null;
  refDate: string | null;
  rows: CircularRow[];
  warnings: CircularWarning[];
  /** No text at all (a scan): the desktop can read the pages, or Nib asks for a text PDF. */
  textless: boolean;
}

// ---------------------------------------------------------------- dates
const pad = (n: number) => String(n).padStart(2, '0');
const MONTHS: Array<[RegExp, number]> = [
  [/^jan(uary)?$/, 1], [/^feb(ruary|r)?$/, 2], [/^mar(ch)?$/, 3], [/^apr(il)?$/, 4], [/^may$/, 5], [/^june?$/, 6],
  [/^july?$/, 7], [/^aug(ust)?$/, 8], [/^sep(t|tember)?$/, 9], [/^oct(ober)?$/, 10], [/^nov(ember)?$/, 11], [/^dec(ember)?$/, 12],
];
const DAYS: Array<[RegExp, number]> = [
  [/^sun(day)?$/, 0], [/^mon(day)?$/, 1], [/^tue(s|sday)?$/, 2], [/^wed(s|nesday)?$/, 3], [/^thu(r|rs|rsday)?$/, 4], [/^fri(day)?$/, 5], [/^sat(urday)?$/, 6],
];
export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const monthOf = (s: string): number | null => { const w = s.toLowerCase().replace(/\.$/, ''); for (const [re, n] of MONTHS) if (re.test(w)) return n; return null; };
/** A weekday word ("Thursday", "Thu", "SAT.") as 0–6, or null. */
export const weekdayIn = (s: string): number | null => { const w = s.toLowerCase().replace(/[.,;:]+$/, ''); for (const [re, n] of DAYS) if (re.test(w)) return n; return null; };
export const weekdayOfDate = (date: string): number => { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
const valid = (y: number, m: number, d: number): string | null => {
  if (!(y >= 1990 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
};
/** Digits as OCR sometimes reads them (O for 0, l or I for 1). */
const digits = (s: string) => s.replace(/[Oo]/g, '0').replace(/[lI|]/g, '1');
const year4 = (s: string): number => { const n = Number(digits(s)); return s.length <= 2 ? 2000 + n : n; };

// a date as the circulars write it: 01-Jan-2026, 06-June-2026, 05-Sept-2026, 6-Nov-2026, 24-Apr-26,
// 06-Nov (no year), 1 May 2026, 01/01/2026; the text layer sometimes adds a space ("01-May -2026")
const SEP = String.raw`\s*[-./]\s*|\s+`;
const DATE_CORE = String.raw`([0-9OolI]{1,2})(?:${SEP})(\p{L}{3,9}\.?|[0-9OolI]{1,2})(?:(?:${SEP})([0-9OolI]{4}|[0-9OolI]{2}))?`;
const DATE_TOKEN = new RegExp(String.raw`(?<![\p{L}\d])${DATE_CORE}(?![\p{L}\d])`, 'u');
const DATE_TOKEN_G = new RegExp(DATE_TOKEN.source, 'gu');
const DATE_START = new RegExp(String.raw`^${DATE_CORE}(?=\s|$)`, 'u');
/** A month written as a word or a number ("Sept", "06", "O6" from OCR). */
const monthPart = (s: string): number | null => (/^[0-9OolI]{1,2}$/.test(s) && /\d/.test(s) ? Number(digits(s)) : monthOf(s));
/** A cell that starts with a date (its month a real month), and how long that date is. */
const dateAtStart = (s: string): string | null => { const m = DATE_START.exec(s); if (!m || !monthPart(m[2])) return null; const mo = monthPart(m[2])!; return mo >= 1 && mo <= 12 ? m[0] : null; };

/** Read one written date. `year` fills in a date written without one ("06-Nov"). */
export function readDate(text: string, year: number | null = null): string | null {
  const m = DATE_TOKEN.exec(text.trim());
  if (!m) return null;
  const d = Number(digits(m[1]));
  const mon = monthPart(m[2]);
  if (!mon) return null;
  const y = m[3] ? year4(m[3]) : year;
  return y === null ? null : valid(y, mon, d);
}

// ---------------------------------------------------------------- the kind of day
const norm = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/\s*-\s*/g, '-').replace(/\s+/g, ' ').trim();
/** What a row's description says the day is (null: nothing readable). */
export function kindOf(description: string): OfficeDayKind | null {
  const t = norm(description);
  if (!/\p{L}{2,}/u.test(t)) return null;
  if (/\bcomp(?:ensatory|\.)?[- ]?work(?:ing)?\b/.test(t)) return 'compwork';
  if (/\bcomp(?:ensatory|\.)?[- ]?off\b/.test(t)) return 'compoff';
  if (/\bweek(?:ly)?[- ]?off\b/.test(t) || /\bweekend off\b/.test(t)) return 'weekoff';
  return 'holiday';
}
/** The name to keep: the description with the text layer's stray spaces taken out ("Week -Off"). */
const cleanName = (s: string) => s.replace(/\s*-\s*(?=\p{L})/gu, (x) => (/\s/.test(x[0]) && /\s/.test(x[x.length - 1]) ? ' - ' : '-')).replace(/\s+/g, ' ').trim().slice(0, 80);

// ---------------------------------------------------------------- reading the text
type Cell = { t: 'sl'; n: number } | { t: 'date'; text: string } | { t: 'day'; text: string } | { t: 'text'; text: string } | { t: 'eol' };
const SL = /^(\d{1,3})(?=\s|$)(?!\.\s*\p{L})/u;
const HEADER = /\bsl\.?\s*no\b|^s\.?\s*no\b/i;

/** One cell of a line into what it starts with: a serial, a date, a weekday, then the rest. */
function cellsOf(raw: string, out: Cell[]): void {
  let s = raw.trim();
  if (!s) return;
  const sl = SL.exec(s);
  if (sl && (dateAtStart(s.slice(sl[0].length).trim()) || s.length === sl[0].length)) {
    out.push({ t: 'sl', n: Number(sl[1]) });
    s = s.slice(sl[0].length).trim();
  }
  const dm = dateAtStart(s);
  if (dm) { out.push({ t: 'date', text: dm.trim() }); s = s.slice(dm.length).trim(); }
  const first = /^(\p{L}+\.?),?(?=\s|$)/u.exec(s);
  const prev = out.findLast((c) => c.t !== 'eol');
  if (first && weekdayIn(first[1]) !== null && (dm || prev?.t === 'date')) { out.push({ t: 'day', text: first[1].replace(/\.$/, '') }); s = s.slice(first[0].length).trim(); }
  if (s) out.push({ t: 'text', text: s });
}

/** The circular's text, line by line (the hub's PDF reader, pdftotext, or OCR from the desktop). */
export function readCircular(lines: string[]): CircularRead {
  const all = lines.slice(0, 6000).map((l) => l.replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').replace(/\s+$/, ''));
  const joined = all.join('\n');
  const textless = !/\p{L}{3,}/u.test(joined);
  // the reference and its date: "Ref: HRD/CIR/2026/011   26-Mar-2026"
  let ref: string | null = null; let refDate: string | null = null;
  for (const l of all) {
    const m = /\bref(?:erence)?\.?\s*(?:no\.?)?\s*[:.\-]\s*([A-Z0-9][A-Z0-9/\-_.]{2,40}[A-Z0-9])/i.exec(l);
    if (m) {
      ref = m[1];
      const rest = l.slice((m.index ?? 0) + m[0].length);
      const dm = DATE_TOKEN_G.exec(rest); DATE_TOKEN_G.lastIndex = 0;
      refDate = dm ? readDate(dm[0]) : null;
      break;
    }
  }
  if (ref && !refDate) {
    // the date on its own line near the top, right of the reference
    for (const l of all.slice(0, 30)) { const t = l.trim(); if (dateAtStart(t) && t.length < 20) { refDate = readDate(t); if (refDate) break; } }
  }
  // the period: "for the period of January-2026 to December-2026", "for the year 2027"
  let period: CircularRead['period'] = null;
  const flat = all.join(' ').replace(/\s+/g, ' ');
  const pm = /period\s+(?:of\s+|from\s+)?(\p{L}{3,9})\s*[-.,/ ]\s*(\d{4})\s*(?:to|till|until|-|–)\s*(\p{L}{3,9})\s*[-.,/ ]\s*(\d{4})/iu.exec(flat);
  if (pm && monthOf(pm[1]) && monthOf(pm[3])) {
    const fy = Number(pm[2]); const fm = monthOf(pm[1])!; const ty = Number(pm[4]); const tm = monthOf(pm[3])!;
    const last = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
    period = { from: `${fy}-${pad(fm)}-01`, to: `${ty}-${pad(tm)}-${pad(last)}` };
  } else {
    const ym = /\b(?:for the|calendar|holidays? (?:list )?(?:for|of))\s+year\s*[-:]?\s*(\d{4})\b|\byear\s*[-:]?\s*(\d{4})\b/i.exec(flat);
    const y = ym ? Number(ym[1] ?? ym[2]) : null;
    if (y && y > 1990 && y < 2200) period = { from: `${y}-01-01`, to: `${y}-12-31` };
  }

  // the table: everything after the first header, read cell by cell
  const head = all.findIndex((l) => HEADER.test(l));
  const body = head >= 0 ? all.slice(head + 1) : all;
  const cells: Cell[] = [];
  for (const l of body) {
    if (HEADER.test(l)) { cells.push({ t: 'eol' }); continue; }
    for (const c of l.split(/\s{3,}|\t+/)) cellsOf(c, cells);
    cells.push({ t: 'eol' });
  }
  type Raw = { sl: number | null; dateText: string; dayText: string | null; desc: string[] };
  const raws: Raw[] = [];
  let cur: Raw | null = null;
  // a row is complete once it has a description and its line has ended
  let complete = false;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const next = cells[i + 1];
    if (c.t === 'eol') { if (cur && cur.desc.length) complete = true; continue; }
    const startsRow = (c.t === 'sl' && (next?.t === 'date' || (next?.t === 'eol' && cells[i + 2]?.t === 'date'))) || (c.t === 'date' && (!cur || complete || cur.dayText !== null));
    if (startsRow) {
      cur = { sl: null, dateText: '', dayText: null, desc: [] };
      raws.push(cur);
      complete = false;
      if (c.t === 'sl') { cur.sl = c.n; continue; }
    }
    if (!cur || complete) continue;
    if (c.t === 'date' && !cur.dateText) { cur.dateText = c.text; continue; }
    if (c.t === 'day' && cur.dayText === null && !cur.desc.length) { cur.dayText = c.text; continue; }
    if (!cur.dateText) continue;
    cur.desc.push(c.t === 'sl' ? String(c.n) : c.text);
  }

  // a date alone is not a row (a revision date on a drawing): it needs its serial or its weekday
  for (let i = raws.length - 1; i >= 0; i--) if (raws[i].sl === null && raws[i].dayText === null) raws.splice(i, 1);
  // the year: the period's, else the one most rows are in
  const counts = new Map<number, number>();
  for (const r of raws) { const d = readDate(r.dateText); if (d) counts.set(Number(d.slice(0, 4)), (counts.get(Number(d.slice(0, 4))) ?? 0) + 1); }
  const common = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const year = period ? Number(period.from.slice(0, 4)) : common;

  const rows: CircularRow[] = raws.map((r) => {
    const date = readDate(r.dateText);
    const name = cleanName(r.desc.join(' '));
    const kind = name ? kindOf(name) : null;
    const problems: CircularProblem[] = [];
    if (!date) problems.push({ code: 'date' });
    if (date && r.dayText !== null) { const wd = weekdayIn(r.dayText); const actual = weekdayOfDate(date); if (wd !== actual) problems.push({ code: 'weekday', actual }); }
    if (date && (period ? date < period.from || date > period.to : year !== null && Number(date.slice(0, 4)) !== year)) problems.push({ code: 'year', year: Number(date.slice(0, 4)) });
    if (!kind) problems.push({ code: 'unknown' });
    let forDate: string | null = null;
    if (kind === 'compwork') {
      const after = /\bfor\b(.*)$/i.exec(name)?.[1] ?? '';
      DATE_TOKEN_G.lastIndex = 0;
      const dm = DATE_TOKEN_G.exec(after); DATE_TOKEN_G.lastIndex = 0;
      forDate = dm ? readDate(dm[0], date ? Number(date.slice(0, 4)) : year) : null;
    }
    return { sl: r.sl, dateText: r.dateText, date, dayText: r.dayText, name, kind, for: forDate, problems };
  });

  // dates twice: the same day written twice is one row too many; two different days on one date are both in doubt
  const byDate = new Map<string, CircularRow[]>();
  for (const r of rows) if (r.date) (byDate.get(r.date) ?? byDate.set(r.date, []).get(r.date)!).push(r);
  for (const same of byDate.values()) {
    if (same.length < 2) continue;
    const alike = same.every((r) => r.kind === same[0].kind && norm(r.name) === norm(same[0].name));
    same.forEach((r, i) => { if (!alike || i > 0) r.problems.push({ code: 'dupDate', sl: (i > 0 ? same[0] : same[1]).sl }); });
  }
  // a compensatory working day makes up for a day off in this circular
  for (const r of rows) {
    if (r.kind !== 'compwork') continue;
    const target = r.for ? rows.find((x) => x.date === r.for && x.kind !== null && isOffKind(x.kind)) : undefined;
    if (!target) r.problems.push({ code: 'forMissing', for: r.for });
  }
  const warnings: CircularWarning[] = [];
  if (!period && rows.length) warnings.push({ code: 'noPeriod' });
  let prev: number | null = null;
  const seen = new Set<number>();
  for (const r of rows) {
    if (r.sl === null) continue;
    if (seen.has(r.sl)) warnings.push({ code: 'serialDup', sl: r.sl });
    else if (prev !== null && r.sl !== prev + 1 && r.sl > prev) warnings.push({ code: 'serialGap', after: prev, next: r.sl });
    seen.add(r.sl);
    prev = Math.max(prev ?? r.sl, r.sl);
  }
  return { year, period, ref, refDate, rows, warnings, textless };
}

/** Rows that can be registered as they stand. */
export const goodRows = (read: CircularRead): Array<CircularRow & { date: string; kind: OfficeDayKind }> =>
  read.rows.filter((r): r is CircularRow & { date: string; kind: OfficeDayKind } => !r.problems.length && !!r.date && !!r.kind);

// ---------------------------------------------------------------- against what is registered
export type DayChange = 'new' | 'unchanged' | 'updated';
export interface CircularPlan {
  /** Each row that will be registered, and what it does to the calendar. */
  rows: Array<{ sl: number | null; date: string; name: string; kind: OfficeDayKind; for: string | null; change: DayChange; was: { name: string; kind: OfficeDayKind } | null }>;
  /** Days an earlier circular for the same year registered that this one no longer has. */
  removed: OfficeDay[];
  /** Rows not registered (each with its problems). */
  exceptions: CircularRow[];
  counts: Record<OfficeDayKind, number>;
  added: number;
  updated: number;
  unchanged: number;
  /** This very file was registered already. */
  already: CircularRecord | null;
}

const zero = (): Record<OfficeDayKind, number> => ({ holiday: 0, weekoff: 0, compoff: 0, compwork: 0 });
const same = (a: OfficeDay, b: { name: string; kind: OfficeDayKind; for: string | null }) => a.name === b.name && a.kind === b.kind && (a.for ?? null) === (b.for ?? null);

/** What registering this read would change in the office's calendar. */
export function planCircular(read: CircularRead, existing: OfficeDay[], hash: string, registered: CircularRecord[]): CircularPlan {
  const good = goodRows(read);
  const have = new Map(existing.map((d) => [d.date, d] as const));
  const counts = zero();
  const rows = good.map((r) => {
    counts[r.kind]++;
    const was = have.get(r.date);
    const change: DayChange = !was ? 'new' : same(was, { name: r.name, kind: r.kind, for: r.for }) ? 'unchanged' : 'updated';
    return { sl: r.sl, date: r.date, name: r.name, kind: r.kind, for: r.for, change, was: was && change === 'updated' ? { name: was.name, kind: was.kind } : null };
  });
  const listed = new Set(read.rows.map((r) => r.date).filter((d): d is string => !!d));
  const year = read.year;
  // only days a circular put in, of the same year, that this circular does not mention at all
  const removed = year === null ? [] : existing.filter((d) => d.source && d.date.startsWith(`${year}-`) && !listed.has(d.date) && (!read.period || (d.date >= read.period.from && d.date <= read.period.to)));
  return {
    rows, removed, exceptions: read.rows.filter((r) => r.problems.length > 0), counts,
    added: rows.filter((r) => r.change === 'new').length, updated: rows.filter((r) => r.change === 'updated').length, unchanged: rows.filter((r) => r.change === 'unchanged').length,
    already: registered.find((c) => c.hash === hash) ?? null,
  };
}

/** The office's list after registering a read (other years and typed-in days are kept). */
export function applyCircular(existing: OfficeDay[], read: CircularRead, plan: CircularPlan, source: Omit<OfficeDaySource, 'sl'>): OfficeDay[] {
  const gone = new Set(plan.removed.map((d) => d.date));
  const map = new Map(existing.filter((d) => !gone.has(d.date)).map((d) => [d.date, d] as const));
  for (const r of plan.rows) map.set(r.date, { date: r.date, name: r.name, kind: r.kind, ...(r.for ? { for: r.for } : {}), source: { ...source, sl: r.sl } });
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** A day as stored (older hubs kept { date, name } only: those are holidays typed in). */
export function officeDayIn(v: unknown): OfficeDay | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const date = typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : '';
  const name = typeof r.name === 'string' ? r.name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80) : '';
  if (!date || !name) return null;
  const kind = OFFICE_DAY_KINDS.includes(r.kind as OfficeDayKind) ? r.kind as OfficeDayKind : 'holiday';
  const forDate = kind === 'compwork' && typeof r.for === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.for) ? r.for : null;
  const s = r.source && typeof r.source === 'object' ? r.source as Record<string, unknown> : null;
  const str = (x: unknown, max: number) => (typeof x === 'string' && x ? x.slice(0, max) : null);
  const source: OfficeDaySource | null = s && typeof s.hash === 'string' && /^[0-9a-f]{64}$/.test(s.hash)
    ? { ref: str(s.ref, 60), refDate: str(s.refDate, 10), file: str(s.file, 200) ?? '', hash: s.hash, sl: typeof s.sl === 'number' && Number.isInteger(s.sl) ? s.sl : null }
    : null;
  return { date, name, kind, ...(forDate ? { for: forDate } : {}), ...(source ? { source } : {}) };
}

export const kindCounts = (days: Array<{ kind: OfficeDayKind }>): Record<OfficeDayKind, number> => { const c = zero(); for (const d of days) c[d.kind]++; return c; };

// ---------------------------------------------------------------- what Nib shows
/**
 * A circular Nib was given, as its card shows it:
 * - `denied`: sent by someone who is not an administrator (nothing was read);
 * - `unreadable`: not a PDF the hub can open (encrypted, damaged): `error` says why;
 * - `textless`: a scan with no text (the desktop can read it, or a text PDF is needed);
 * - `notCircular`: text, but no table of dates;
 * - `open`: read, waiting for an administrator to register it;
 * - `already`: this very file is registered (nothing would change);
 * - `registered`: registered from this card.
 */
export type HolidayReadState = 'denied' | 'unreadable' | 'textless' | 'notCircular' | 'open' | 'already' | 'registered';
export interface HolidayReadView {
  id: string;
  state: HolidayReadState;
  userId: string;
  /** The PDF (the desktop reads a scan's pages from it). */
  fileId: string | null;
  file: string;
  hash: string;
  /** The text came from the desktop's OCR of a scan. */
  ocr: boolean;
  /** Why an unreadable PDF could not be read (the hub's words). */
  error: string | null;
  read: CircularRead | null;
  plan: CircularPlan | null;
  canRegister: boolean;
  /** Once registered: when, by whom, and what changed. */
  done: { at: number; by: string | null; added: number; updated: number; removed: number; counts: Record<OfficeDayKind, number>; exceptions: number } | null;
}

export interface HolidayOps {
  /** Read a holiday circular (a PDF already uploaded), or the text the desktop read from a scan for an earlier read. */
  'nib.holidays.read': { req: { fileId?: string; id?: string; text?: string }; res: HolidayReadView };
  /** Register what a read found (administrators): the same file twice changes nothing. */
  'nib.holidays.register': { req: { id: string }; res: HolidayReadView };
}
