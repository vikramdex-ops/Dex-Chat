/** @jsxImportSource react */
// Message formatting: a small, safe Markdown subset rendered straight to React elements
// (never HTML strings). Supports **bold**, *italic*, ~~strike~~, `code`, ``` blocks ```,
// > quotes, lists, links, <@mentions>, #tags, <#Space> references and engineering
// line-number references. What people wrote is never translated (the plain React runtime above).
import { EmojiImg, customEmoji } from '../emoji.tsx';
import { highlight } from './highlight.tsx';
import { plainSnippet } from '../localsearch/tokenize.ts';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { HASHTAG_RE, STICKER_RE } from '@dex/core';
import type { Conversation, Message, PublicUser } from '@dex/core';
import { Icon, Popover } from '../ui.tsx';
import { addConversation, chatState, useChat } from './store.ts';

/** Piping line numbers such as 6"-P-1001-A1B or 2-CW-2045 (Sleuth integration hooks onto these). */
export const LINE_REF_RE = /\b\d{1,2}(?:"|''|in)?-[A-Z]{1,4}-\d{3,6}(?:-[A-Z0-9]{1,6})?\b/g;

/** Drawing numbers as Sleuth reads them from title blocks: ISO-1001-01, GA-204, PID-12. */
export const DRAWING_RE = /\b(?:ISO|PID|GA|DWG|DOC|STR|LAY)-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/g;

const TOOL_NAME: Record<string, string> = { projectopener: 'Project Opener', dexterity: 'Dexterity Sheets', sleuth: 'Sleuth', datum: 'Datum', dexconnect: 'Dexterity Connect' };

/** Messages fetched for link previews, shared across the conversation (null = not visible). */
const linked = new Map<string, Promise<Message | null>>();

/**
 * A link to a message is that message's card, in the text: who wrote it and how it starts, with
 * Reply (its side-track). It keeps one height while it loads, so the timeline does not move; a
 * message the reader cannot see becomes a quiet note with the plain link.
 */
function MessageLink({ url, ctx }: { url: string; ctx: Ctx }) {
  const [, , , convId = '', id = ''] = url.split('/');
  const [m, setM] = useState<Message | null | undefined>(undefined);
  useEffect(() => {
    let p = linked.get(id);
    if (!p) { p = window.dex.request('msg.get', { messageId: id }).catch(() => null); linked.set(id, p); }
    let live = true;
    void p.then((v) => { if (live) setM(v); });
    return () => { live = false; };
  }, [id]);
  if (m === null) return <span className="msg-link-none"><span className="mlc-quiet">You don't have access to this message</span><ToolLink url={url} /></span>;
  const who = m ? ctx.users.get(m.authorId)?.displayName ?? 'Someone' : '…';
  const text = m ? (m.body || (m.files.length ? `📎 ${m.files[0].name}` : '')).replace(/<@([0-9A-Z]{26}|all)>/g, (_x, u: string) => `@${u === 'all' ? 'everyone' : ctx.users.get(u)?.displayName ?? 'someone'}`) : '';
  const reply = () => window.dispatchEvent(new CustomEvent('dex-open-message', { detail: { convId: m?.convId ?? convId, messageId: m?.parentId ?? id, parentId: m?.parentId ?? id } }));
  return (
    <span className={`msg-link-card${m ? '' : ' loading'}`}>
      <button className="mlc-open" title="Open the message" aria-label={`Open the message from ${who}: ${text.slice(0, 120)}`} onClick={() => void window.dex.openLink?.(url).catch(() => {})}>
        <span className="mlc-who">{who}{m ? <span className="faint"> · {new Date(m.createdAt).toLocaleDateString([], { day: 'numeric', month: 'short' })}{m.replyCount === 1 ? ' · 1 reply' : m.replyCount ? ` · ${m.replyCount} replies` : ''}</span> : null}</span>
        <span className="mlc-text">{text.length > 160 ? `${text.slice(0, 157)}…` : text || ' '}</span>
      </button>
      {m && <button className="mlc-reply" title="Reply in its side-track" aria-label="Reply in a side-track" onClick={reply}>↳ Reply</button>}
    </span>
  );
}

function ToolLink({ url }: { url: string }) {
  const scheme = url.split(':')[0];
  let label = url.replace(/^[a-z]+:\/\//, '');
  try { label = decodeURIComponent(label); } catch { /* keep as is */ }
  if (/^dexconnect:\/\/message\//.test(url)) label = 'Open the message';
  else if (/^dexconnect:\/\/conversation\//.test(url)) label = 'Open the conversation';
  else if (/^dexconnect:\/\/meet\//.test(url)) label = `Meeting ${label.replace(/^meet\//, '')}`;
  return (
    <button className="tool-link" title={url} onClick={() => void window.dex.openLink?.(url).catch((e: Error) => window.dispatchEvent(new CustomEvent('dex-toast', { detail: e.message })))}>
      <span className="tool-name">{TOOL_NAME[scheme] ?? scheme}</span>{label.length > 60 ? `${label.slice(0, 57)}…` : label}
    </button>
  );
}

function TagRef({ tag, kind }: { tag: string; kind: 'line' | 'drawing' }) {
  const canFind = toolsInstalled.sleuth;
  return canFind
    ? <button className="line-ref find" title={`Find ${tag} in Sleuth`} onClick={() => void window.dex.openLink?.(`sleuth://search?q=${encodeURIComponent(tag)}`).catch(() => {})}>{tag}</button>
    : <span className="line-ref" title={kind === 'line' ? 'Line number' : 'Drawing number'}>{tag}</span>;
}

/** Filled once at start (desktop): which office tools are on this PC. */
export const toolsInstalled: Record<string, boolean> = {};
void window.dex?.installedTools?.().then((t) => Object.assign(toolsInstalled, t)).catch(() => {});

// ------------------------------------------------------------------ #tags and Space references
/** A Space reference in a message body: <#CONVERSATIONID>. */
export const SPACE_REF_RE = /<#([0-9A-Z]{26})>/g;

/** Open Spaces anyone can join (fetched when needed, kept for two minutes). */
let browse: Promise<Conversation[]> | null = null;
let browseAt = 0;
let browsed: Conversation[] = [];
export function openSpaces(): Promise<Conversation[]> {
  if (!browse || Date.now() - browseAt > 120_000) {
    browseAt = Date.now();
    browse = window.dex.request('conv.browse').then((l) => { browsed = l; return l; }).catch(() => { browse = null; return browsed; });
  }
  return browse;
}
/** A Space's name, if this device knows it. */
export function spaceName(id: string): string | null {
  return chatState().conversations.get(id)?.name ?? browsed.find((c) => c.id === id)?.name ?? null;
}

/** #tag: opens Search for it. */
function TagChip({ text, tag }: { text: string; tag: string }) {
  return (
    <button className="tag-chip" translate="no" title={`Find #${tag}`}
      onClick={() => window.dispatchEvent(new CustomEvent('dex-search', { detail: { q: `#${tag.toLowerCase()}` } }))}>{text}</button>
  );
}

/** <#Space>: opens the Space, or offers to join an open one you are not in. */
function SpaceRef({ id }: { id: string }) {
  const mine = useChat((s) => s.conversations.get(id));
  const [open, setOpen] = useState<Conversation | null | undefined>(undefined);
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const joined = !!mine?.joined;
  useEffect(() => {
    if (joined) return;
    let live = true;
    void openSpaces().then((l) => { if (live) setOpen(l.find((c) => c.id === id) ?? null); });
    return () => { live = false; };
  }, [id, joined]);
  const c = joined ? mine : open ?? mine;
  if (!c) return <span className="space-ref none" title="A private Space you are not in"><Icon name="lock" size={11} />{open === undefined ? <span>…</span> : <span>a private Space</span>}</span>;
  const join = async () => {
    setBusy(true);
    try {
      const conv = await window.dex.request('conv.join', { convId: id });
      addConversation(conv);
      setAsk(false);
      window.dispatchEvent(new CustomEvent('dex-open', { detail: id }));
    } catch (e) { window.dispatchEvent(new CustomEvent('dex-toast', { detail: (e as Error).message })); setBusy(false); }
  };
  return (
    <>
      <button ref={btn} className={`space-ref${joined ? '' : ' outside'}`} title={joined ? `Open ${c.name}` : `${c.name}: an open Space you are not in`}
        onClick={() => (joined ? window.dispatchEvent(new CustomEvent('dex-open', { detail: id })) : setAsk(!ask))}>
        <Icon name="grid" size={11} /><span translate="no">{c.name ?? 'Space'}</span>
      </button>
      {ask && !joined && (
        <Popover anchor={btn.current} onClose={() => setAsk(false)} className="menu space-join" align="start">
          <div className="menu-label label">Open Space</div>
          <div className="space-join-body">
            <b translate="no">{c.name}</b>
            {c.topic && <span className="faint" translate="no">{c.topic}</span>}
            <span className="mono faint">{c.members.length === 1 ? '1 person' : `${c.members.length} people`}</span>
          </div>
          <button role="menuitem" disabled={busy} onClick={() => void join()}><Icon name="plus" size={16} />Join the Space</button>
        </Popover>
      )}
    </>
  );
}

type Inline = { re: RegExp; render: (m: RegExpExecArray, key: string, ctx: Ctx) => ReactNode };
interface Ctx { users: Map<string, PublicUser>; meId: string }

const INLINE: Inline[] = [
  // \* \_ \` \~ \\ show the character itself
  { re: /\\([\\`*_~<>])/y, render: (m) => m[1] },
  { re: /`([^`\n]+)`/y, render: (m, k) => <code key={k} className="md-code">{m[1]}</code> },
  { re: /<#([0-9A-Z]{26})>/y, render: (m, k) => <SpaceRef key={k} id={m[1]} /> },
  { re: new RegExp(HASHTAG_RE.source, 'yu'), render: (m, k) => <TagChip key={k} text={m[0]} tag={m[1]} /> },
  { re: /<@([0-9A-Z]{26}|all)>/y, render: (m, k, ctx) => {
    if (m[1] === 'all') return <span key={k} className="mention all">@everyone</span>;
    const u = ctx.users.get(m[1]);
    return <span key={k} className={`mention${m[1] === ctx.meId ? ' me' : ''}`}>@{u?.displayName ?? 'someone'}</span>;
  } },
  // [text](address): https, or a link to a message or an office tool
  { re: /\[([^\]\n]{1,200})\]\(((?:https?|dexconnect|projectopener|dexterity|sleuth|datum):\/\/[^\s)]{1,2000})\)/y, render: (m, k, ctx) => /^https?:/.test(m[2])
    ? <a key={k} href={m[2]} target="_blank" rel="noreferrer noopener" title={m[2]}>{inline(m[1], ctx, k)}</a>
    : <button key={k} className="md-link" title={m[2]} onClick={() => void window.dex.openLink?.(m[2]).catch(() => {})}>{inline(m[1], ctx, k)}</button> },
  { re: /\+\+(?=\S)([^+\n]*[^+\s])\+\+/y, render: (m, k, ctx) => <u key={k}>{inline(m[1], ctx, k)}</u> },
  { re: /\*\*([^*\n]+)\*\*/y, render: (m, k, ctx) => <strong key={k}>{inline(m[1], ctx, k)}</strong> },
  { re: /~~([^~\n]+)~~/y, render: (m, k, ctx) => <s key={k}>{inline(m[1], ctx, k)}</s> },
  { re: /(?<![\w*])\*([^*\n]+)\*(?![\w*])/y, render: (m, k, ctx) => <em key={k}>{inline(m[1], ctx, k)}</em> },
  { re: /(?<![\w_])_([^_\n]+)_(?![\w_])/y, render: (m, k, ctx) => <em key={k}>{inline(m[1], ctx, k)}</em> },
  { re: /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"\]]/y, render: (m, k) => <a key={k} href={m[0]} target="_blank" rel="noreferrer noopener">{m[0]}</a> },
  // links for the other office tools become chips that open the tool
  { re: /(?:projectopener|dexterity|sleuth|datum|dexconnect):\/\/[^\s<>()]+[^\s<>().,;:!?'"\]]/y, render: (m, k, ctx) => (/^dexconnect:\/\/message\/[\w-]+\/[\w-]+$/.test(m[0]) ? <MessageLink key={k} url={m[0]} ctx={ctx} /> : <ToolLink key={k} url={m[0]} />) },
  // office emoji, written :name:
  { re: /:([a-z0-9][a-z0-9_-]{1,31}):/y, render: (m, k) => (customEmoji().has(m[1]) ? <EmojiImg key={k} name={m[1]} /> : m[0]) },
  { re: new RegExp(LINE_REF_RE.source, 'y'), render: (m, k) => <TagRef key={k} tag={m[0]} kind="line" /> },
  { re: new RegExp(DRAWING_RE.source, 'y'), render: (m, k) => <TagRef key={k} tag={m[0]} kind="drawing" /> },
];

/** Starting characters worth trying an inline rule at (fast path for plain text). */
const TRIGGER = /[`<*~_+h0-9\\pdsDIGLPS:[#]/;

function inline(text: string, ctx: Ctx, keyBase = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = '';
  let i = 0;
  let n = 0;
  while (i < text.length) {
    let matched = false;
    if (TRIGGER.test(text[i]) && (i === 0 || !/[A-Za-z0-9]/.test(text[i - 1]) || text[i] === '`' || text[i] === '\\' || text[i] === '<' || text[i] === '*' || text[i] === '~' || text[i] === '+' || text[i] === '[')) {
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
      const body = code.replace(/\n$/, '');
      blocks.push(<pre key={`c${pi}`} className="md-pre" data-lang={lang || undefined}><code>{lang ? highlight(body, lang) : body}</code></pre>);
      return;
    }
    const lines = part.split('\n');
    let para: string[] = [];
    let list: { ordered: boolean; items: Array<{ text: string; depth: number; ordered: boolean }> } | null = null;
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
        // indentation (two spaces or a tab per level) nests items under the one above
        const build = (from: number, depth: number, ordered: boolean, key: string): [ReactNode, number] => {
          const items: ReactNode[] = [];
          let j = from;
          while (j < list!.items.length && list!.items[j].depth >= depth) {
            const it = list!.items[j];
            if (it.depth > depth) { const [sub, next] = build(j, it.depth, it.ordered, `${key}-${j}`); items.push(<li key={`n${j}`} className="md-nest">{sub}</li>); j = next; continue; }
            let sub: ReactNode = null;
            let next = j + 1;
            if (next < list!.items.length && list!.items[next].depth > depth) [sub, next] = build(next, list!.items[next].depth, list!.items[next].ordered, `${key}-${next}`);
            items.push(<li key={j}>{inline(it.text, ctx, `${key}-${j}`)}{sub}</li>);
            j = next;
          }
          return [ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>, j];
        };
        blocks.push(build(0, list.items[0].depth, list.items[0].ordered, k)[0]);
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
      const heading = raw.match(/^(#{1,6})\s+(.+)$/);
      const rule = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(raw);
      const depthOf = (m: RegExpMatchArray | null) => (m ? Math.min(4, Math.floor(m[0].match(/^\s*/)![0].replace(/\t/g, '  ').length / 2)) : 0);
      const check = raw.match(/^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/);
      if (heading) {
        flushPara(); flushList(); flushQuote();
        const k = `h${pi}-${blocks.length}`;
        const level = heading[1].length;
        const content = inline(heading[2], ctx, k);
        blocks.push(level === 1 ? <h3 key={k} className="md-h md-h1">{content}</h3> : level === 2 ? <h4 key={k} className="md-h md-h2">{content}</h4> : level === 3 ? <h5 key={k} className="md-h md-h3">{content}</h5> : <h6 key={k} className="md-h md-h4">{content}</h6>);
      } else if (rule) {
        flushPara(); flushList(); flushQuote();
        blocks.push(<hr key={`r${pi}-${blocks.length}`} className="md-hr" />);
      } else if (check) {
        flushPara(); flushQuote();
        if (!list) list = { ordered: false, items: [] };
        list.items.push({ text: `${check[1].trim() ? '☑' : '☐'} ${check[2]}`, depth: depthOf(check), ordered: false });
      } else if (bullet || numbered) {
        flushPara(); flushQuote();
        const ordered = !!numbered;
        const depth = depthOf(bullet ?? numbered);
        if (list && depth === 0 && list.items.some((x) => x.depth === 0) && list.items.filter((x) => x.depth === 0).at(-1)!.ordered !== ordered) flushList();
        if (!list) list = { ordered, items: [] };
        list.items.push({ text: (bullet ?? numbered)![1], depth, ordered });
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
  if (STICKER_RE.test(body)) return 'Sticker';
  const text = body
    .replace(/<@all>/g, '@everyone')
    .replace(SPACE_REF_RE, (_, id: string) => `#${spaceName(id) ?? 'a Space'}`)
    .replace(/<@([0-9A-Z]{26})>/g, (_, id: string) => `@${users.get(id)?.displayName ?? 'someone'}`)
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, '$1')
    .replace(/dexconnect:\/\/message\/[\w-]+\/[\w-]+/g, '🔗 a message');
  // formatting marks go; a lone * in "4 * 5", P12_GA_rev and C++ stay (the same rules as search snippets)
  return plainSnippet(text);
}

/** Is the message only emoji (shown larger)? */
export function isEmojiOnly(body: string): boolean {
  const t = body.trim();
  return t.length > 0 && t.length <= 24 && /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u.test(t) && !/^[0-9#*\s]+$/.test(t);
}
