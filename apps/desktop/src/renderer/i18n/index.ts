// Languages: the interface is written in English; other languages translate its text as it is drawn.
// The JSX runtime beside this file passes every literal string shown in an element (and its title,
// placeholder, label and alt) through tr(). Text people wrote is never translated: the files that
// draw messages and names opt out, and anything inside an element marked translate="no" is skipped.
import hi from './hi.json' with { type: 'json' };
import ta from './ta.json' with { type: 'json' };

export const LANGUAGES: Array<{ code: string; name: string; native: string }> = [
  { code: 'en', name: 'English', native: 'English' },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी' },
  { code: 'ta', name: 'Tamil', native: 'தமிழ்' },
];
const DICTS: Record<string, Record<string, string>> = { hi, ta };
const KEY = 'dex.language';

function initial(): string {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && (saved === 'en' || DICTS[saved])) return saved;
  } catch { /* private mode */ }
  return 'en';
}

let lang = initial();
let exact: Record<string, string> = DICTS[lang] ?? {};
let patterns: Array<{ re: RegExp; out: string }> = compile(exact);

/** Keys with {0}, {1}… become patterns: "{0} people" matches "12 people". */
function compile(d: Record<string, string>): Array<{ re: RegExp; out: string }> {
  return Object.entries(d).filter(([k]) => /\{\d\}/.test(k)).map(([k, out]) => ({
    re: new RegExp(`^${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{(\d)\\\}/g, '(?<p$1>.+?)')}$`, 's'),
    out,
  }));
}

export const language = () => lang;
export const translating = () => lang !== 'en';

/** Change the language (then every screen is drawn again: see Preferences → Language). */
export function setLanguage(code: string): void {
  try { localStorage.setItem(KEY, code); } catch { /* private mode */ }
  lang = code;
  exact = DICTS[code] ?? {};
  patterns = compile(exact);
  cache.clear();
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
