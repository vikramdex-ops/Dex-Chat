// Message formatting: a small, safe Markdown subset rendered straight to React elements
// (never HTML strings). Supports **bold**, *italic*, ~~strike~~, `code`, ``` blocks ```,
// > quotes, lists, links, <@mentions> and engineering line-number references.
import type { ReactNode } from 'react';
import type { PublicUser } from '@dex/core';

/** Piping line numbers such as 6"-P-1001-A1B or 2-CW-2045 (Sleuth integration hooks onto these). */
export const LINE_REF_RE = /\b\d{1,2}(?:"|''|in)?-[A-Z]{1,4}-\d{3,6}(?:-[A-Z0-9]{1,6})?\b/g;

type Inline = { re: RegExp; render: (m: RegExpExecArray, key: string, ctx: Ctx) => ReactNode };
interface Ctx { users: Map<string, PublicUser>; meId: string }

const INLINE: Inline[] = [
  // \* \_ \` \~ \\ show the character itself
  { re: /\\([\\`*_~<>])/y, render: (m) => m[1] },
  { re: /`([^`\n]+)`/y, render: (m, k) => <code key={k} className="md-code">{m[1]}</code> },
  { re: /<@([0-9A-Z]{26}|all)>/y, render: (m, k, ctx) => {
    if (m[1] === 'all') return <span key={k} className="mention all">@everyone</span>;
    const u = ctx.users.get(m[1]);
    return <span key={k} className={`mention${m[1] === ctx.meId ? ' me' : ''}`}>@{u?.displayName ?? 'someone'}</span>;
  } },
  { re: /\*\*([^*\n]+)\*\*/y, render: (m, k, ctx) => <strong key={k}>{inline(m[1], ctx, k)}</strong> },
  { re: /~~([^~\n]+)~~/y, render: (m, k, ctx) => <s key={k}>{inline(m[1], ctx, k)}</s> },
  { re: /(?<![\w*])\*([^*\n]+)\*(?![\w*])/y, render: (m, k, ctx) => <em key={k}>{inline(m[1], ctx, k)}</em> },
  { re: /(?<![\w_])_([^_\n]+)_(?![\w_])/y, render: (m, k, ctx) => <em key={k}>{inline(m[1], ctx, k)}</em> },
  { re: /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"\]]/y, render: (m, k) => <a key={k} href={m[0]} target="_blank" rel="noreferrer noopener">{m[0]}</a> },
  { re: new RegExp(LINE_REF_RE.source, 'y'), render: (m, k) => <span key={k} className="line-ref" title="Line number">{m[0]}</span> },
];

/** Starting characters worth trying an inline rule at (fast path for plain text). */
const TRIGGER = /[`<*~_h0-9\\]/;

function inline(text: string, ctx: Ctx, keyBase = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = '';
  let i = 0;
  let n = 0;
  while (i < text.length) {
    let matched = false;
    if (TRIGGER.test(text[i]) && (i === 0 || !/[A-Za-z0-9]/.test(text[i - 1]) || text[i] === '`' || text[i] === '\\' || text[i] === '<' || text[i] === '*' || text[i] === '~')) {
      for (const rule of INLINE) {
        rule.re.lastIndex = i;
        const m = rule.re.exec(text);
        if (m && m.index === i) {
          if (buf) { out.push(buf); buf = ''; }
          out.push(rule.render(m, `${keyBase}-${n++}`, ctx));
          i += m[0].length;
          matched = true;
          break;
        }
      }
    }
    if (!matched) { buf += text[i]; i++; }
  }
  if (buf) out.push(buf);
  return out;
}

export function renderBody(body: string, users: Map<string, PublicUser>, meId: string): ReactNode {
  const ctx: Ctx = { users, meId };
  const blocks: ReactNode[] = [];
  const parts = body.split(/```/);
  parts.forEach((part, pi) => {
    if (pi % 2 === 1) {
      // fenced code: optional language on the first line
      const nl = part.indexOf('\n');
      const lang = nl > 0 && /^[\w+#.-]{1,20}$/.test(part.slice(0, nl).trim()) ? part.slice(0, nl).trim() : '';
      const code = lang ? part.slice(nl + 1) : part.replace(/^\n/, '');
      blocks.push(<pre key={`c${pi}`} className="md-pre" data-lang={lang || undefined}><code>{code.replace(/\n$/, '')}</code></pre>);
      return;
    }
    const lines = part.split('\n');
    let para: string[] = [];
    let list: { ordered: boolean; items: string[] } | null = null;
    let quote: string[] = [];
    const flushPara = () => {
      if (para.length) {
        const k = `p${pi}-${blocks.length}`;
        blocks.push(<p key={k}>{para.flatMap((l, li) => (li ? [<br key={`${k}b${li}`} />, ...inline(l, ctx, `${k}-${li}`)] : inline(l, ctx, `${k}-${li}`)))}</p>);
        para = [];
      }
    };
    const flushList = () => {
      if (list) {
        const k = `l${pi}-${blocks.length}`;
        const items = list.items.map((it, ii) => <li key={ii}>{inline(it, ctx, `${k}-${ii}`)}</li>);
        blocks.push(list.ordered ? <ol key={k}>{items}</ol> : <ul key={k}>{items}</ul>);
        list = null;
      }
    };
    const flushQuote = () => {
      if (quote.length) {
        const k = `q${pi}-${blocks.length}`;
        blocks.push(<blockquote key={k}>{quote.flatMap((l, li) => (li ? [<br key={`${k}b${li}`} />, ...inline(l, ctx, `${k}-${li}`)] : inline(l, ctx, `${k}-${li}`)))}</blockquote>);
        quote = [];
      }
    };
    for (const raw of lines) {
      const bullet = raw.match(/^\s*[-*•]\s+(.*)$/);
      const numbered = raw.match(/^\s*\d{1,3}[.)]\s+(.*)$/);
      const q = raw.match(/^>\s?(.*)$/);
      const heading = raw.match(/^(#{1,3})\s+(.+)$/);
      const check = raw.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/);
      if (heading) {
        flushPara(); flushList(); flushQuote();
        const k = `h${pi}-${blocks.length}`;
        const level = heading[1].length;
        const content = inline(heading[2], ctx, k);
        blocks.push(level === 1 ? <h3 key={k} className="md-h md-h1">{content}</h3> : level === 2 ? <h4 key={k} className="md-h md-h2">{content}</h4> : <h5 key={k} className="md-h md-h3">{content}</h5>);
      } else if (check) {
        flushPara(); flushQuote();
        if (!list || list.ordered) { flushList(); list = { ordered: false, items: [] }; }
        list.items.push(`${check[1].trim() ? '☑' : '☐'} ${check[2]}`);
      } else if (bullet || numbered) {
        flushPara(); flushQuote();
        const ordered = !!numbered;
        if (!list || list.ordered !== ordered) { flushList(); list = { ordered, items: [] }; }
        list.items.push((bullet ?? numbered)![1]);
      } else if (q) {
        flushPara(); flushList();
        quote.push(q[1]);
      } else if (!raw.trim()) {
        flushPara(); flushList(); flushQuote();
      } else {
        flushList(); flushQuote();
        para.push(raw);
      }
    }
    flushPara(); flushList(); flushQuote();
  });
  return blocks;
}

/** Plain-text preview for lists and notifications: mentions become names, markup is dropped. */
export function plainPreview(body: string, users: Map<string, PublicUser>): string {
  return body
    .replace(/<@all>/g, '@everyone')
    .replace(/<@([0-9A-Z]{26})>/g, (_, id: string) => `@${users.get(id)?.displayName ?? 'someone'}`)
    .replace(/```[\s\S]*?```/g, '[code]')
    // escaped characters stay, markup goes
    .replace(/\\([\\`*_~<>])/g, (_, c: string) => `\u0000${c}`)
    .replace(/(^|[^\u0000])[*_~`>]+/g, '$1')
    .replace(/\u0000/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Is the message only emoji (shown larger)? */
export function isEmojiOnly(body: string): boolean {
  const t = body.trim();
  return t.length > 0 && t.length <= 24 && /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u.test(t) && !/^[0-9#*\s]+$/.test(t);
}
