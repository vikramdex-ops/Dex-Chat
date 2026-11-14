/** @jsxImportSource react */
// A small syntax highlighter for code blocks: comments, strings, numbers and keywords for the
// languages an engineering office pastes most (JS/TS, Python, SQL, C#/Java/C, PowerShell/shell,
// JSON, XML). Kept tiny and offline; unknown languages are shown plain.
import type { ReactNode } from 'react';

type Lang = { comment: RegExp; keywords: Set<string> };
const words = (s: string) => new Set(s.split(/\s+/));
const C_LIKE = /\/\/[^\n]*|\/\*[\s\S]*?\*\//y;
const LANGS: Record<string, Lang> = {
  js: { comment: C_LIKE, keywords: words('const let var function return if else for while do switch case break continue new class extends import export from default async await try catch finally throw typeof instanceof in of this null undefined true false interface type enum implements public private protected readonly static void yield') },
  py: { comment: /#[^\n]*/y, keywords: words('def return if elif else for while in not and or is import from as class try except finally raise with lambda pass break continue None True False self yield global nonlocal async await print') },
  sql: { comment: /--[^\n]*|\/\*[\s\S]*?\*\//y, keywords: words('select from where and or not insert into values update set delete create table index view join left right inner outer on group by order having limit as distinct null is in like between case when then else end union all exists primary key foreign references drop alter add count sum avg min max') },
  c: { comment: C_LIKE, keywords: words('int long short float double char bool void unsigned signed const static struct class public private protected return if else for while do switch case break continue new delete namespace using include define true false null nullptr string var foreach in try catch finally throw') },
  sh: { comment: /#[^\n]*/y, keywords: words('if then else elif fi for in do done while case esac function return export echo set local cd ls cp mv rm mkdir param foreach where select get set new write host true false') },
  json: { comment: /(?!)/y, keywords: words('true false null') },
};
const ALIAS: Record<string, string> = {
  javascript: 'js', ts: 'js', typescript: 'js', tsx: 'js', jsx: 'js', python: 'py', mysql: 'sql', postgres: 'sql', tsql: 'sql',
  cs: 'c', csharp: 'c', 'c#': 'c', java: 'c', cpp: 'c', 'c++': 'c', go: 'c', rust: 'c', kotlin: 'c', swift: 'c',
  bash: 'sh', shell: 'sh', ps: 'sh', ps1: 'sh', powershell: 'sh', bat: 'sh', cmd: 'sh', yaml: 'sh', yml: 'sh', ini: 'sh', toml: 'sh',
};

const STRING = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/y;
const NUMBER = /\b(?:0x[0-9a-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b/iy;
const WORD = /[A-Za-z_$][\w$]*/y;
const TAG = /<\/?[A-Za-z][\w:.-]*|\/?>|[\w:.-]+(?==)/y;

export function highlight(code: string, langRaw: string): ReactNode {
  const name = langRaw.toLowerCase();
  if (name === 'xml' || name === 'html' || name === 'svg') return xml(code);
  const lang = LANGS[ALIAS[name] ?? name];
  if (!lang || code.length > 40_000) return code;
  const out: ReactNode[] = [];
  let i = 0;
  let plain = '';
  const flush = () => { if (plain) { out.push(plain); plain = ''; } };
  const tryRe = (re: RegExp) => { re.lastIndex = i; const m = re.exec(code); return m && m.index === i ? m[0] : null; };
  while (i < code.length) {
    let t: string | null;
    if ((t = tryRe(lang.comment))) { flush(); out.push(<span key={i} className="hl-c">{t}</span>); i += t.length; continue; }
    if ((t = tryRe(STRING))) { flush(); out.push(<span key={i} className="hl-s">{t}</span>); i += t.length; continue; }
    if (/[0-9]/.test(code[i]) && (i === 0 || !/\w/.test(code[i - 1])) && (t = tryRe(NUMBER))) { flush(); out.push(<span key={i} className="hl-n">{t}</span>); i += t.length; continue; }
    if (/[A-Za-z_$]/.test(code[i]) && (i === 0 || !/[\w$]/.test(code[i - 1])) && (t = tryRe(WORD))) {
      if (lang.keywords.has(name === 'sql' ? t.toLowerCase() : t)) { flush(); out.push(<span key={i} className="hl-k">{t}</span>); } else plain += t;
      i += t.length;
      continue;
    }
    plain += code[i++];
  }
  flush();
  return out;
}

function xml(code: string): ReactNode {
  const out: ReactNode[] = [];
  let i = 0;
  let plain = '';
  const flush = () => { if (plain) { out.push(plain); plain = ''; } };
  while (i < code.length) {
    if (code.startsWith('<!--', i)) { const e = code.indexOf('-->', i); const t = code.slice(i, e < 0 ? code.length : e + 3); flush(); out.push(<span key={i} className="hl-c">{t}</span>); i += t.length; continue; }
    STRING.lastIndex = i;
    const s = STRING.exec(code);
    if (s && s.index === i) { flush(); out.push(<span key={i} className="hl-s">{s[0]}</span>); i += s[0].length; continue; }
    TAG.lastIndex = i;
    const t = TAG.exec(code);
    if (t && t.index === i && t[0]) { flush(); out.push(<span key={i} className={t[0].startsWith('<') || t[0].endsWith('>') ? 'hl-k' : 'hl-n'}>{t[0]}</span>); i += t[0].length; continue; }
    plain += code[i++];
  }
  flush();
  return out;
}
