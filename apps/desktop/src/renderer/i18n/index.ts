// Languages: the interface is written in English; other languages translate its text as it is drawn.
// The JSX runtime beside this file passes every literal string shown in an element (and its title,
// placeholder, label and alt) through tr(). Text people wrote is never translated: the files that
// draw messages and names opt out, and anything inside an element marked translate="no" is skipped.

export const LANGUAGES: Array<{ code: string; name: string; native: string }> = [
  { code: 'en', name: 'English', native: 'English' },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी' },
  { code: 'ta', name: 'Tamil', native: 'தமிழ்' },
];
// each language's words (about half a megabyte each) load only for the people who chose it, before
// the first screen is drawn (loadLanguage), rather than for everyone at every start
type Dict = Record<string, string>;
const LOADERS: Record<string, () => Promise<Dict>> = {
  hi: () => import('./hi.json').then((m) => m.default as Dict),
  ta: () => import('./ta.json').then((m) => m.default as Dict),
};
const DICTS: Record<string, Dict> = {};
const KEY = 'dex.language';

function initial(): string {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && (saved === 'en' || LOADERS[saved])) return saved;
  } catch { /* private mode */ }
  return 'en';
}

let lang = initial();
let exact: Record<string, string> = {};
let patterns: Array<{ re: RegExp; out: string }> = compile(exact);

/** Keys with {0}, {1}… become patterns: "{0} people" matches "12 people". */
function compile(d: Record<string, string>): Array<{ re: RegExp; out: string }> {
  return Object.entries(d).filter(([k]) => /\{\d\}/.test(k)).map(([k, out]) => ({
    re: new RegExp(`^${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{(\d)\\\}/g, '(?<p$1>.+?)')}$`, 's'),
    out,
  }));
}

/**
 * Dates and times follow the language too: the app asks for "the person's locale" (no locale, or
 * []), which would otherwise be the PC's (English). Digits stay the usual 0-9 in both languages.
 */
const LOCALE: Record<string, string> = { hi: 'hi-IN', ta: 'ta-IN' };
/**
 * Each of these calls builds a date formatter for its locale and options, which costs about a
 * hundred times the formatting (a timeline of messages, the Switchboard's times and the Calendar
 * make thousands). The formatters are kept and reused instead, built from the options exactly as
 * the methods do (ECMA-402 ToDateTimeOptions), so the text is the same.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();
const DATE_PARTS = ['weekday', 'year', 'month', 'day'] as const;
const TIME_PARTS = ['dayPeriod', 'hour', 'minute', 'second', 'fractionalSecondDigits'] as const;
const KINDS = { toLocaleDateString: ['date', 'date'], toLocaleTimeString: ['time', 'time'], toLocaleString: ['any', 'all'] } as const;
function formatter(name: keyof typeof KINDS, locales: string | string[] | undefined, opts: Intl.DateTimeFormatOptions | undefined): Intl.DateTimeFormat | null {
  if (opts !== undefined && (opts === null || typeof opts !== 'object')) return null;
  const key = `${name}|${JSON.stringify(locales ?? null)}|${opts ? JSON.stringify(opts) : ''}`;
  let f = formatters.get(key);
  if (f) return f;
  const [required, defaults] = KINDS[name];
  const o: Record<string, unknown> = { ...opts };
  if ((required === 'date' && o.timeStyle !== undefined) || (required === 'time' && o.dateStyle !== undefined)) return null; // the method throws
  let need = o.dateStyle === undefined && o.timeStyle === undefined;
  if (required !== 'time' && DATE_PARTS.some((k) => o[k] !== undefined)) need = false;
  if (required !== 'date' && TIME_PARTS.some((k) => o[k] !== undefined)) need = false;
  if (need && defaults !== 'time') { o.year = 'numeric'; o.month = 'numeric'; o.day = 'numeric'; }
  if (need && defaults !== 'date') { o.hour = 'numeric'; o.minute = 'numeric'; o.second = 'numeric'; }
  try { f = new Intl.DateTimeFormat(locales, o as Intl.DateTimeFormatOptions); } catch { return null; }
  if (formatters.size > 200) formatters.clear();
  formatters.set(key, f);
  return f;
}
for (const name of ['toLocaleDateString', 'toLocaleTimeString', 'toLocaleString'] as const) {
  const orig = Date.prototype[name] as (this: Date, locales?: string | string[], opts?: Intl.DateTimeFormatOptions) => string;
  Object.defineProperty(Date.prototype, name, {
    configurable: true, writable: true,
    value(this: Date, locales?: string | string[], opts?: Intl.DateTimeFormatOptions) {
      const mine = LOCALE[lang];
      const unset = locales === undefined || (Array.isArray(locales) && locales.length === 0);
      const loc = mine && unset ? mine : locales;
      // an invalid date reads "Invalid Date", and unusual arguments behave as the method does
      const f = Number.isNaN(this.getTime()) ? null : formatter(name, loc, opts);
      return f ? f.format(this) : orig.call(this, loc, opts);
    },
  });
}

export const language = () => lang;
export const translating = () => lang !== 'en';

/** Load the chosen language's words (once). Call before the first screen is drawn. */
export async function loadLanguage(code = lang): Promise<void> {
  const load = LOADERS[code];
  if (!load || DICTS[code]) { if (code === lang) use(code); return; }
  try { DICTS[code] = await load(); } catch { return; /* the words stay English */ }
  if (code === lang) use(code);
}
function use(code: string): void {
  exact = DICTS[code] ?? {};
  patterns = compile(exact);
  cache.clear();
}

/** Change the language (then every screen is drawn again: see Preferences → Language). */
export async function setLanguage(code: string): Promise<void> {
  try { localStorage.setItem(KEY, code); } catch { /* private mode */ }
  await loadLanguage(code);
  lang = code;
  use(code);
  document.documentElement.lang = code;
}

const cache = new Map<string, string>();

/** The text in the chosen language (unchanged when there is no translation). */
export function tr(s: string): string {
  if (lang === 'en' || !s) return s;
  const hit = cache.get(s);
  if (hit !== undefined) return hit;
  const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
  const core = m[2];
  let out = core;
  if (exact[core]) out = exact[core];
  else if (/[A-Za-z]/.test(core)) {
    for (const p of patterns) {
      const g = core.match(p.re);
      if (g) { out = p.out.replace(/\{(\d)\}/g, (_x, n: string) => tr(g.groups?.[`p${n}`] ?? '')); break; }
    }
  }
  const res = m[1] + out + m[3];
  if (cache.size > 5000) cache.clear();
  cache.set(s, res);
  return res;
}

if (typeof document !== 'undefined') document.documentElement.lang = lang;
