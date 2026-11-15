// Link cards under a message: one sheet-detail card for each of the first three links (links to
// messages are drawn as quote cards in the text instead, see format.tsx), worked out by
// the hub for the person looking (links.preview). Cards are asked for only when the message comes
// into view, kept per link for the session, and every card (loading, ready, no access, failed) is
// drawn in the same reserved box, so the timeline never jumps when one arrives. Also: the router
// for file links, and the Control room's settings for web previews.
import { memo, useEffect, useRef, useState } from 'react';
import type { FileInfo, LinkAction, LinkCard, LinkCardKind, LinkSettings, Message } from '@dex/core';
import { Icon, Toggle, useToast } from '../ui.tsx';
import type { IconName } from '../ui.tsx';
import { FileImg, isImage } from './files.tsx';
import { Viewer } from './Viewer.tsx';
import { addConversation, chatState } from './store.ts';
import { startCall } from '../rooms/engine.ts';
import { onOpenRequest, openUrl, requestOpen } from './deeplinks.ts';
import './messages.css';

/** Cards shown under one message. */
export const MAX_CARDS = 3;

// ------------------------------------------------------------------ finding links in a message
const LINK_RE = /(?:https?|dexconnect|projectopener|dexterity|sleuth|datum|file):\/\/[^\s<>()"'`]+[^\s<>().,;:!?'"\]`*_~]|\\\\[\w.$-]+(?:\\[^\s\\<>"|?*`]+)+\\?|(?<![\w/\\])[A-Za-z]:\\(?:[^\s\\<>"|?*`]+\\?)*/g;

/** The links in a message body worth a card: code and quoted examples are left out. */
export function linksIn(body: string, encrypted = false): string[] {
  if (!body) return [];
  const text = body.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ').replace(/^>.*$/gm, ' ');
  const out: string[] = [];
  for (const m of text.matchAll(LINK_RE)) {
    const url = m[0].replace(/\\+$/, (s) => (s.length === m[0].length ? s : '\\'));
    // our share links are requests, not things to preview
    if (/^dexconnect:\/\/share\b/i.test(url)) continue;
    // a link to a message is already that message's card in the text (format.tsx)
    if (/^dexconnect:\/\/message\/[\w-]+\/[\w-]+$/i.test(url)) continue;
    // an encrypted message's links stay on this device: only links into the office (already on the hub) get cards
    if (encrypted && !/^dexconnect:\/\//i.test(url)) continue;
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

// ------------------------------------------------------------------ the renderer's own cache
const cards = new Map<string, { card: LinkCard; at: number }>();
const inflight = new Map<string, Promise<LinkCard>>();
const INTERNAL_TTL = 5 * 60_000;

/** A card for a link, from this session's cache or the hub. */
export function loadCard(url: string): Promise<LinkCard> {
  const hit = cards.get(url);
  // web cards live a day on the hub; cards about the office (status, who is in a meeting) change sooner
  if (hit && (/^https?:/i.test(url) || Date.now() - hit.at < INTERNAL_TTL)) return Promise.resolve(hit.card);
  let p = inflight.get(url);
  if (!p) {
    p = window.dex.request('links.preview', { url }).then((card) => {
      cards.set(url, { card, at: Date.now() });
      if (cards.size > 800) cards.delete(cards.keys().next().value!);
      return card;
    }).finally(() => inflight.delete(url));
    inflight.set(url, p);
  }
  return p;
}
const cachedCard = (url: string): LinkCard | null => {
  const hit = cards.get(url);
  return hit && (/^https?:/i.test(url) || Date.now() - hit.at < INTERNAL_TTL) ? hit.card : null;
};

/** One observer for every card slot: a card is asked for when its message is near the screen. */
const seen = new Map<Element, () => void>();
let observer: IntersectionObserver | null = null;
function watch(el: Element, onSeen: () => void): () => void {
  if (typeof IntersectionObserver === 'undefined') { onSeen(); return () => {}; }
  observer ??= new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const fn = seen.get(e.target);
      seen.delete(e.target);
      observer?.unobserve(e.target);
      fn?.();
    }
  }, { rootMargin: '240px 0px' });
  seen.set(el, onSeen);
  observer.observe(el);
  return () => { seen.delete(el); observer?.unobserve(el); };
}

// ------------------------------------------------------------------ how cards look
const KIND: Record<LinkCardKind, { icon: IconName; label: string }> = {
  message: { icon: 'chat', label: 'Message' }, conversation: { icon: 'grid', label: 'Conversation' }, person: { icon: 'user', label: 'Person' },
  file: { icon: 'paperclip', label: 'File' }, event: { icon: 'calendar', label: 'Meeting' }, meeting: { icon: 'video', label: 'Meeting ID' },
  task: { icon: 'alarm', label: 'Desk task' }, search: { icon: 'search', label: 'Sleuth' }, workbook: { icon: 'sheet', label: 'Workbook' },
  project: { icon: 'drawing', label: 'Project' }, component: { icon: 'drawing', label: 'Datum' }, calculator: { icon: 'sheet', label: 'Calculator' },
  tool: { icon: 'open', label: 'Tool' }, folder: { icon: 'drawer', label: 'Folder' }, path: { icon: 'doc', label: 'Office share' },
  web: { icon: 'globe', label: 'Web page' }, video: { icon: 'play', label: 'Video' }, repo: { icon: 'branch', label: 'Repository' },
  issue: { icon: 'warning', label: 'Issue' }, pull: { icon: 'branch', label: 'Pull request' }, pdf: { icon: 'doc', label: 'PDF' },
  image: { icon: 'eye', label: 'Image' }, restricted: { icon: 'lock', label: 'No access' }, unavailable: { icon: 'warning', label: 'Link' },
};

const ACTION_ICON: Record<LinkAction['kind'], IconName> = { open: 'open', reply: 'reply', join: 'phone', 'copy-path': 'copy', 'open-in-tool': 'open' };

/** Where the link goes, for the card's foot: a host, a path, or the scheme's tool. */
function shortUrl(url: string): string {
  if (/^https?:/i.test(url)) { try { const u = new URL(url); return `${u.host}${u.pathname === '/' ? '' : u.pathname}`; } catch { return url; } }
  return url.replace(/^dexconnect:\/\//i, '');
}

// ------------------------------------------------------------------ actions
async function runAction(a: LinkAction, card: LinkCard, toast: (t: string, err?: boolean) => void): Promise<void> {
  switch (a.kind) {
    case 'copy-path':
      await navigator.clipboard.writeText(a.target);
      toast(card.kind === 'meeting' ? 'Meeting link copied' : /^\\\\|^[a-z]:\\/i.test(a.target) ? 'Path copied: paste it into Explorer' : 'Link copied');
      return;
    case 'open-in-tool':
      if (a.tool === 'folder') {
        if (!window.dex.openFolder) throw new Error('Folders on the office share open on a PC.');
        await window.dex.openFolder(a.target);
        return;
      }
      await openUrl(a.target);
      return;
    case 'reply': {
      const convId = card.ref?.convId;
      const messageId = card.ref?.messageId;
      if (!convId || !messageId) { await openUrl(a.target); return; }
      window.dispatchEvent(new CustomEvent('dex-open-message', { detail: { convId, messageId, parentId: messageId } }));
      return;
    }
    case 'join': {
      if (/^dexconnect:\/\/meet\//i.test(a.target)) { await openUrl(a.target); return; }
      const convId = card.ref?.convId ?? /^dexconnect:\/\/conversation\/([\w-]+)/i.exec(a.target)?.[1];
      if (!convId) { await openUrl(a.target); return; }
      if (card.kind === 'conversation' && !chatState().conversations.get(convId)?.joined) {
        addConversation(await window.dex.request('conv.join', { convId }));
        toast('Joined');
      }
      window.dispatchEvent(new CustomEvent('dex-open', { detail: convId }));
      // a meeting held as a call: into its Room (joins the one already running)
      if (card.kind === 'event') await startCall(convId, false);
      return;
    }
    default:
      await openUrl(a.target);
  }
}

// ------------------------------------------------------------------ one card
function CardBody({ card, url, discuss, onRemove }: { card: LinkCard; url: string; discuss: (() => void) | null; onRemove: (() => void) | null }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const k = KIND[card.kind];
  if (card.kind === 'restricted') {
    return (
      <div className="lcard restricted" role="group" aria-label="Link card: no access">
        <span className="lcard-tile quiet" aria-hidden="true"><Icon name="lock" size={18} /></span>
        <div className="lcard-main">
          <div className="lcard-quiet">You don't have access to this</div>
          <div className="lcard-foot mono faint" translate="no">{shortUrl(url)}</div>
        </div>
        {onRemove && <RemoveButton onRemove={onRemove} />}
      </div>
    );
  }
  const go = (a: LinkAction) => {
    setBusy(a.label);
    void runAction(a, card, toast).catch((e: Error) => toast(e.message, true)).finally(() => setBusy(null));
  };
  const metas = card.meta.filter((x) => x.key !== 'path' && x.key !== 'tool');
  const metaSpan = (list: typeof metas) => list.map((x, i) => <span key={x.key + x.label} className="lcard-meta">{i ? ' · ' : ''}<span className="faint">{x.label}</span> <span translate="no">{x.value}</span></span>);
  const thumb = card.preview?.fileId ? { id: card.preview.fileId, name: card.title ?? 'Image' } : null;
  const problem = card.status && card.status !== 'ok' ? card.reason ?? null : null;
  const excerpt = card.preview?.excerpt ?? problem;
  const title = card.title ?? (card.kind === 'unavailable' ? 'No preview' : card.subtitle ?? shortUrl(url));
  return (
    <div className={`lcard k-${card.kind}${card.kind === 'message' ? ' msg-link-card' : ''}`} role="group" aria-label={`Link card: ${k.label}`}>
      <span className={`lcard-tile${thumb ? ' thumb' : ''}`} aria-hidden="true">
        {thumb ? <FileImg f={thumb} lazy /> : <Icon name={k.icon} size={20} />}
        <span className="lcard-kind">{k.label}</span>
      </span>
      <div className="lcard-main">
        <div className="lcard-title" translate="no" title={title}>{title}</div>
        <div className="lcard-sub">
          {card.subtitle && card.title ? <><span translate="no">{card.subtitle}</span>{metas.length ? ' · ' : ''}{metaSpan(metas.slice(0, 1))}</> : metaSpan(metas.slice(0, 2))}
        </div>
        {excerpt
          ? <div className={`lcard-excerpt${problem && !card.preview?.excerpt ? ' faint' : ''}`} translate={problem && !card.preview?.excerpt ? undefined : 'no'}>{excerpt}</div>
          : <div className="lcard-sub second">{metas.length > (card.subtitle && card.title ? 1 : 2) ? metaSpan(metas.slice(card.subtitle && card.title ? 1 : 2, 5)) : <span className="faint mono" translate="no">{shortUrl(url)}</span>}</div>}
        <div className="lcard-actions">
          {card.actions.slice(0, 3).map((a) => (
            <button key={a.kind + a.label} className={`lbtn${a.kind === 'join' ? ' live' : ''}`} disabled={!!busy} onClick={() => go(a)} title={a.kind === 'copy-path' ? a.target : undefined}>
              {busy === a.label ? <span className="spinner" /> : <Icon name={ACTION_ICON[a.kind]} size={13} />}{a.label}
            </button>
          ))}
          {discuss && <button className="lbtn discuss" onClick={discuss} title="Talk about this link in its own side-track"><Icon name="branch" size={13} />Discuss</button>}
        </div>
      </div>
      {onRemove && <RemoveButton onRemove={onRemove} />}
    </div>
  );
}

function RemoveButton({ onRemove }: { onRemove: () => void }) {
  return <button className="lcard-x" title="Remove this card from your message" aria-label="Remove this card from your message" onClick={onRemove}><Icon name="x" size={12} /></button>;
}

function Placeholder({ url, failed }: { url: string; failed?: boolean }) {
  return (
    <div className={`lcard loading${failed ? ' failed' : ''}`} aria-busy={!failed} aria-label={failed ? 'No preview for this link' : 'Loading the link card'}>
      <span className="lcard-tile quiet" aria-hidden="true">{failed ? <Icon name="warning" size={18} /> : null}</span>
      <div className="lcard-main">
        {failed ? <div className="lcard-quiet">No preview for this link</div> : <><span className="lcard-bar w60" /><span className="lcard-bar w40" /><span className="lcard-bar w80" /></>}
        <div className="lcard-foot mono faint" translate="no">{shortUrl(url)}</div>
      </div>
    </div>
  );
}

/** A card slot: the reserved box, filled when the message is on screen. */
const CardSlot = memo(function CardSlot({ url, discuss, onRemove }: { url: string; discuss: ((url: string) => void) | null; onRemove: ((url: string) => void) | null }) {
  const [card, setCard] = useState<LinkCard | null>(() => cachedCard(url));
  const [failed, setFailed] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (card) return;
    let live = true;
    const el = box.current;
    if (!el) return;
    const stop = watch(el, () => { void loadCard(url).then((c) => { if (live) setCard(c); }).catch(() => { if (live) setFailed(true); }); });
    return () => { live = false; stop(); };
  }, [url, card]);
  return (
    <div ref={box} className="lcard-slot" data-url={url}>
      {card ? <CardBody card={card} url={url} discuss={discuss && card.kind !== 'restricted' ? () => discuss(url) : null} onRemove={onRemove ? () => onRemove(url) : null} /> : <Placeholder url={url} failed={failed} />}
    </div>
  );
});

/** The cards under a message. */
export function LinkCards({ m, meId, inTrack }: { m: Message; meId: string; inTrack?: boolean }) {
  const toast = useToast();
  const hidden = m.hiddenPreviews ?? [];
  const urls = linksIn(m.body, !!m.e2e).filter((u) => !hidden.includes(u)).slice(0, MAX_CARDS);
  if (!urls.length || m.deleted || m.ref || m.decision) return null;
  const mine = m.authorId === meId;
  // a side-track about a link starts from the conversation's own timeline, not from inside a side-track
  const discuss = inTrack || m.parentId ? null : (url: string) => {
    void window.dex.request('links.discuss', { url, convId: m.convId, messageId: m.id })
      .then((t) => window.dispatchEvent(new CustomEvent('dex-jump', { detail: { convId: t.convId, messageId: t.rootMessageId, parentId: t.rootMessageId } })))
      .catch((e: Error) => toast(e.message, true));
  };
  const remove = mine ? (url: string) => {
    void window.dex.request('links.hide', { messageId: m.id, url, hidden: true }).then(() => toast('Card removed for everyone')).catch((e: Error) => toast(e.message, true));
  } : null;
  return (
    <div className="lcards" aria-label="Link cards">
      {urls.map((u) => <CardSlot key={u} url={u} discuss={discuss} onRemove={remove} />)}
    </div>
  );
}

// ------------------------------------------------------------------ dexconnect://file/<id>
/** Opens files asked for by link: pictures in the viewer, anything else with the PC's own program. */
export function LinkedFiles() {
  const toast = useToast();
  const [file, setFile] = useState<FileInfo | null>(null);
  useEffect(() => onOpenRequest('file', ({ file: f }) => {
    if (isImage(f)) { setFile(f); return; }
    if (window.dex.openFile) void window.dex.openFile(f.id, f.name).catch((e: Error) => toast(e.message, true));
    else setFile(f);
  }), [toast]);
  if (!file) return null;
  return <Viewer file={file} all={[file]} onClose={() => setFile(null)} />;
}

/** dexconnect://file/<id>: find what the file is (only if this person may open it), then open it. */
export async function openFileLink(url: string): Promise<void> {
  const card = await window.dex.request('links.preview', { url });
  const id = card.ref?.fileId;
  if (card.kind !== 'file' || !id) throw new Error('That file is in a conversation you are not part of.');
  const meta = (k: string) => card.meta.find((x) => x.key === k)?.ref;
  const name = card.title ?? 'File';
  const ext = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  const mime = card.preview?.fileId ? `image/${ext === 'jpg' ? 'jpeg' : ext || 'png'}` : card.subtitle && /\//.test(card.subtitle) ? card.subtitle : 'application/octet-stream';
  requestOpen({ kind: 'file', file: { id, name, mime, size: Number(meta('size') ?? 0), uploaderId: String(meta('author') ?? ''), createdAt: Number(meta('updated') ?? 0) } });
}

// ------------------------------------------------------------------ Control room → Policies
/** Web previews for the office: on or off, for guests, and intranet hosts the hub may fetch. */
export function LinkPreviewSettings() {
  const toast = useToast();
  const [s, setS] = useState<LinkSettings | null>(null);
  const [hosts, setHosts] = useState('');
  useEffect(() => {
    void window.dex.request('admin.links.get').then((v) => { setS(v); setHosts(v.allowLanHosts.join('\n')); }).catch(() => setS(null));
  }, []);
  const save = (patch: Partial<LinkSettings>, ok: string) => {
    void window.dex.request('admin.links.set', patch).then((v) => { setS(v); setHosts(v.allowLanHosts.join('\n')); toast(ok); }).catch((e: Error) => toast(e.message, true));
  };
  if (!s) return null;
  const list = hosts.split(/[\s,]+/).map((h) => h.trim()).filter(Boolean);
  const changed = list.join('\n') !== s.allowLanHosts.join('\n');
  return (
    <section className="card link-policy" aria-label="Link cards">
      <div className="eyebrow">Link cards</div>
      <div className="setting" style={{ marginTop: 6 }}>
        <div className="txt"><div>Preview web pages</div><div className="faint">The hub fetches the title and description of web links; the apps never do. Off: cards show only the site.</div></div>
        <Toggle label="Preview web pages" checked={s.externalPreviews} onChange={(v) => save({ externalPreviews: v }, v ? 'Web pages are previewed' : 'Web previews are off')} />
      </div>
      <div className="setting">
        <div className="txt"><div>Preview web pages for guests too</div><div className="faint">Off by default: nothing about outside pages is fetched for guests.</div></div>
        <Toggle label="Preview web pages for guests too" checked={s.guestExternalPreviews} onChange={(v) => save({ guestExternalPreviews: v }, v ? 'Guests get web previews' : 'No web previews for guests')} />
      </div>
      <div className="field" style={{ marginTop: 10 }}>
        <label htmlFor="lan-hosts">Office hosts the hub may preview</label>
        <textarea id="lan-hosts" className="input mono" rows={3} placeholder={'wiki.dexterity.local\nintranet'} value={hosts} onChange={(e) => setHosts(e.target.value)} />
        <span className="faint" style={{ fontSize: 12 }}>One host name per line, up to 50. Pages on the office network are refused unless their host is listed here.</span>
      </div>
      <div className="row-actions" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
        <button className="btn primary sm" disabled={!changed} onClick={() => save({ allowLanHosts: list }, 'Office hosts saved')}>Save hosts</button>
      </div>
    </section>
  );
}
