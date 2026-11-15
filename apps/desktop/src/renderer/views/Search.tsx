// Search: words plus a ruled strip of filters (by whom, in which conversation, when, Direct or
// Spaces, with files). Opened from the palette, Ctrl+Shift+F or a conversation's header (already
// scoped to it).
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Conversation, FileInfo, Message, NoticeHit, PublicUser } from '@dex/core';
import { Avatar, Icon, Popover } from '../ui.tsx';
import { SheetTabs } from './People.tsx';
import { convTitle } from '../chat/Switchboard.tsx';
import { plainPreview } from '../chat/format.tsx';
import { formatSize } from '../chat/files.tsx';
import { searchLocal } from '../localsearch/service.ts';
import { plainSnippet } from '../localsearch/tokenize.ts';
import { formatTime } from '../time.ts';
import { translating } from '../i18n/index.ts';
import { openNotice } from '../notices/store.ts';
import { refText, titleOf } from '../notices/parts.tsx';

export interface SearchInit { q?: string; convId?: string | null }
type When = 'any' | 'today' | 'week' | 'month' | 'year';
type Hit = { message: Message; snippet: string; local?: boolean };
type FileHit = FileInfo & { messageId: string; convId: string; textMatch?: string };

const WHEN: Array<{ value: When; label: string }> = [
  { value: 'any', label: 'Any time' }, { value: 'today', label: 'Today' }, { value: 'week', label: 'Last 7 days' },
  { value: 'month', label: 'Last 30 days' }, { value: 'year', label: 'Last 12 months' },
];
function since(w: When): number | undefined {
  const d = new Date();
  if (w === 'today') { d.setHours(0, 0, 0, 0); return d.getTime(); }
  if (w === 'week') return Date.now() - 7 * 86400_000;
  if (w === 'month') return Date.now() - 30 * 86400_000;
  if (w === 'year') return Date.now() - 365 * 86400_000;
  return undefined;
}
/** Matched words highlighted. A message's snippet shows as plain text, its formatting marks gone. */
function Snippet({ text, message = false }: { text: string; message?: boolean }) {
  const parts = (message ? plainSnippet(text) : text.replace(/<@[0-9A-Z]{26}>/g, '@…')).split(/\[\[|\]\]/);
  // what people wrote is shown as written, never translated
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i} translate="no">{p}</mark> : <span key={i} translate="no">{p}</span>))}</>;
}
const when = (t: number) => {
  const d = new Date(t);
  return d.toDateString() === new Date().toDateString() ? formatTime(d) : d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
};

export function SearchView({ init, users, meId, conversations, onOpen }: {
  init: SearchInit; users: PublicUser[]; meId: string; conversations: Map<string, Conversation>;
  onOpen: (convId: string, messageId: string, parentId: string | null) => void;
}) {
  const byId = useMemo(() => new Map(users.map((u) => [u.id, u] as const)), [users]);
  const [q, setQ] = useState(init.q ?? '');
  const [from, setFrom] = useState<string | null>(null);
  const [convId, setConvId] = useState<string | null>(init.convId ?? null);
  const [period, setPeriod] = useState<When>('any');
  const [kind, setKind] = useState<'all' | 'direct' | 'space'>('all');
  const [hasFile, setHasFile] = useState(false);
  const [tab, setTab] = useState<'text' | 'files' | 'notices'>('text');
  const [notices, setNotices] = useState<NoticeHit[]>([]);
  const [hits, setHits] = useState<Hit[]>([]);
  const [files, setFiles] = useState<FileHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);
  const [menu, setMenu] = useState<null | 'from' | 'in' | 'when'>(null);
  const [pick, setPick] = useState('');
  const anchors = { from: useRef<HTMLButtonElement>(null), in: useRef<HTMLButtonElement>(null), when: useRef<HTMLButtonElement>(null) };
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);

  const filters = { from: from ?? undefined, convId: convId ?? undefined, after: since(period), kind: kind === 'all' ? undefined : kind, hasFile: hasFile || undefined };
  const ready = q.trim().length >= 2 || !!(from || convId || hasFile || period !== 'any');
  const key = JSON.stringify([q.trim(), filters]);
  useEffect(() => {
    if (!ready) { setHits([]); setFiles([]); setNotices([]); setMore(false); return; }
    setBusy(true);
    const t = setTimeout(() => {
      const hub = window.dex.request('search', { q: q.trim(), limit: 30, ...filters }).catch(() => null);
      void Promise.all([hub, onDevice()])
        .then(([r, mine]) => { setHits(merge(r?.messages ?? [], mine)); setFiles(r?.files ?? []); setNotices(r?.notices ?? []); setMore((r?.messages.length ?? 0) === 30 || mine.length === 30); })
        .finally(() => setBusy(false));
    }, 120); // a pause in the typing (the hub answers in a few milliseconds)
    return () => clearTimeout(t);
  }, [key]);
  /**
   * End-to-end encrypted Direct text never reaches the hub's index: it is searched in this device's
   * own encrypted index (localsearch/) and merged in, marked "from this device".
   */
  const onDevice = (olderThan?: string): Promise<Hit[]> => {
    if (!q.trim() || kind === 'space' || hasFile || (convId && conversations.get(convId)?.kind !== 'direct')) return Promise.resolve([]);
    return searchLocal(q.trim(), { convs: new Set(conversations.keys()), convId: convId ?? undefined, from: from ?? undefined, after: since(period), olderThan }, 30).catch(() => []);
  };
  const merge = (fromHub: Hit[], local: Hit[], have: Hit[] = []): Hit[] => {
    const seen = new Set([...have, ...fromHub].map((h) => h.message.id));
    return [...fromHub, ...local.filter((h) => !seen.has(h.message.id))].sort((a, b) => (a.message.id < b.message.id ? 1 : -1));
  };
  const loadMore = () => {
    const last = hits[hits.length - 1];
    if (!last) return;
    setBusy(true);
    const hub = window.dex.request('search', { q: q.trim(), limit: 30, olderThan: last.message.id, ...filters }).catch(() => null);
    void Promise.all([hub, onDevice(last.message.id)])
      .then(([r, mine]) => { setHits((h) => [...h, ...merge(r?.messages ?? [], mine, h)]); setMore((r?.messages.length ?? 0) === 30 || mine.length === 30); })
      .finally(() => setBusy(false));
  };

  const convs = [...conversations.values()].filter((c) => c.joined);
  const pickPeople = users.filter((u) => u.role !== 'bot' && u.displayName.toLowerCase().includes(pick.toLowerCase())).slice(0, 8);
  const pickConvs = convs.filter((c) => convTitle(c, byId, meId).toLowerCase().includes(pick.toLowerCase())).slice(0, 8);
  const chosenConv = convId ? conversations.get(convId) : null;
  const closeMenu = () => { setMenu(null); setPick(''); };

  return (
    <div className="search-view">
      <div className="search-box">
        <Icon name="search" size={18} />
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search messages and files" aria-label="Search messages and files" maxLength={200} />
        {busy && <span className="spinner" />}
      </div>
      <div className="search-rule" role="group" aria-label="Filters">
        <div className={`sr-cell${from ? ' on' : ''}`}>
          <button ref={anchors.from} className="sr-pick" onClick={() => setMenu('from')} aria-haspopup="menu">
            <span className="sr-k">By</span><span className="sr-v">{from ? byId.get(from)?.displayName ?? 'someone' : 'anyone'}</span>
          </button>
          {from && <button className="sr-x" aria-label="Clear person" onClick={() => setFrom(null)}><Icon name="x" size={12} /></button>}
        </div>
        <div className={`sr-cell${convId ? ' on' : ''}`}>
          <button ref={anchors.in} className="sr-pick" onClick={() => setMenu('in')} aria-haspopup="menu">
            <span className="sr-k">In</span><span className="sr-v">{chosenConv ? convTitle(chosenConv, byId, meId) : 'every conversation'}</span>
          </button>
          {convId && <button className="sr-x" aria-label="Clear conversation" onClick={() => setConvId(null)}><Icon name="x" size={12} /></button>}
        </div>
        <div className={`sr-cell${period !== 'any' ? ' on' : ''}`}>
          <button ref={anchors.when} className="sr-pick" onClick={() => setMenu('when')} aria-haspopup="menu">
            <span className="sr-k">When</span><span className="sr-v">{translating() ? WHEN.find((w) => w.value === period)!.label : WHEN.find((w) => w.value === period)!.label.toLowerCase()}</span>
          </button>
        </div>
        {!convId && (
          <div className={`sr-cell sr-where${kind !== 'all' ? ' on' : ''}`} role="group" aria-label="Where">
            <span className="sr-k">Where</span>
            <span className="sr-opts">
              {([['all', 'Both'], ['direct', 'Direct'], ['space', 'Spaces']] as const).map(([v, l]) => (
                <button key={v} className="sr-opt" aria-pressed={kind === v} onClick={() => setKind(v)}>{l}</button>
              ))}
            </span>
          </div>
        )}
        <div className={`sr-cell sr-files${hasFile ? ' on' : ''}`}>
          <button className="sr-pick" aria-pressed={hasFile} onClick={() => setHasFile(!hasFile)}>
            <span className="sr-k">Files</span><span className="sr-v">{hasFile ? 'attached only' : 'with or without'}</span>
          </button>
        </div>
      </div>
      {menu === 'from' && (
        <Popover anchor={anchors.from.current} onClose={closeMenu} className="menu pick-menu" align="start">
          <input className="input" autoFocus placeholder="Person" value={pick} onChange={(e) => setPick(e.target.value)} />
          {pickPeople.map((u) => (
            <button key={u.id} role="menuitem" onClick={() => { setFrom(u.id); closeMenu(); }}><Avatar user={u} size="sm" />{u.id === meId ? `${u.displayName} (you)` : u.displayName}</button>
          ))}
        </Popover>
      )}
      {menu === 'in' && (
        <Popover anchor={anchors.in.current} onClose={closeMenu} className="menu pick-menu" align="start">
          <input className="input" autoFocus placeholder="Conversation" value={pick} onChange={(e) => setPick(e.target.value)} />
          {pickConvs.map((c) => (
            <button key={c.id} role="menuitem" onClick={() => { setConvId(c.id); closeMenu(); }}><Icon name={c.kind === 'space' ? 'grid' : 'chat'} size={15} />{convTitle(c, byId, meId)}</button>
          ))}
        </Popover>
      )}
      {menu === 'when' && (
        <Popover anchor={anchors.when.current} onClose={closeMenu} className="menu" align="start">
          {WHEN.map((w) => <button key={w.value} role="menuitemradio" aria-checked={period === w.value} onClick={() => { setPeriod(w.value); closeMenu(); }}>{w.label}</button>)}
        </Popover>
      )}

      <SheetTabs<'text' | 'files' | 'notices'> label="Results" value={tab} onChange={setTab} tabs={[
        { value: 'text', label: 'Text', count: ready && hits.length ? `${hits.length}${more ? '+' : ''}` : undefined },
        { value: 'files', label: 'Files', count: ready ? files.length : undefined },
        ...(convId ? [] : [{ value: 'notices' as const, label: 'Notices', count: ready ? notices.length : undefined }]),
      ]} />

      {!ready ? (
        <div className="empty"><Icon name="search" size={28} /><p>Type at least two letters, or set one of the filters above: by whom, in which conversation, when, or files attached.</p>
          <p className="faint" style={{ fontSize: 12.5 }}>End-to-end encrypted Direct messages are searched on this device, in an encrypted index of what it has received and sent: the hub cannot read them.</p></div>
      ) : tab === 'notices' ? (
        <div className="search-results" role="list">
          {!busy && notices.length === 0 && <div className="empty"><p>No notices on the notice board match.</p></div>}
          {notices.map((h) => (
            <button key={h.notice.id} role="listitem" className="search-hit" onClick={() => openNotice(h.notice.id)}>
              <span className="file-ico"><Icon name="notice" size={18} /></span>
              <span className="sb-main">
                <span className="search-meta"><b translate="no" className="sm-where">{titleOf(h.notice)}</b><span className="mono faint" translate="no">{refText(h.notice)}</span></span>
                <span className="search-snippet">{h.where === 'pdf' && <span className="faint">In the PDF: </span>}<Snippet text={h.snippet} /></span>
              </span>
            </button>
          ))}
        </div>
      ) : tab === 'text' ? (
        <div className="search-results" role="list">
          {!busy && hits.length === 0 && <div className="empty"><p>Nothing written matches.</p>{(from || convId || hasFile || period !== 'any' || kind !== 'all') && <button className="btn" onClick={() => { setFrom(null); setConvId(null); setHasFile(false); setPeriod('any'); setKind('all'); }}>Clear the filters</button>}</div>}
          {hits.map((h) => {
            const c = conversations.get(h.message.convId);
            const a = byId.get(h.message.authorId);
            return (
              <button key={h.message.id} role="listitem" className="search-hit" onClick={() => onOpen(h.message.convId, h.message.id, h.message.parentId)}>
                <Avatar user={a ?? { id: h.message.authorId, displayName: '?' }} size="sm" />
                <span className="sb-main">
                  <span className="search-meta"><b translate={a ? 'no' : undefined}>{a?.displayName ?? 'Someone'}</b>{c && <span className="faint sm-where" title={convTitle(c, byId, meId)}> in <span translate="no">{convTitle(c, byId, meId)}</span></span>}{h.message.parentId && <span className="faint"> · side-track</span>}{h.local && <span className="search-local" title="Found in this device's encrypted index: the hub cannot read end-to-end encrypted messages">from this device</span>}<span className="mono faint">{when(h.message.createdAt)}</span></span>
                  <span className="search-snippet" translate={h.snippet ? undefined : 'no'}>{h.snippet ? <Snippet text={h.snippet} message /> : plainPreview(h.message.body, byId).slice(0, 220) || (h.message.files.length ? `📎 ${h.message.files.map((f) => f.name).join(', ')}` : '')}</span>
                </span>
              </button>
            );
          })}
          {more && <div className="tl-more"><button className="btn sm" disabled={busy} onClick={loadMore}>Show older results</button></div>}
        </div>
      ) : (
        <div className="search-results" role="list">
          {!busy && files.length === 0 && <div className="empty"><p>No files match.</p></div>}
          {files.map((f) => {
            const c = conversations.get(f.convId);
            return (
              <button key={`${f.id}-${f.messageId}`} role="listitem" className="search-hit" onClick={() => onOpen(f.convId, f.messageId, null)}>
                <span className="file-ico"><Icon name="paperclip" size={18} /></span>
                <span className="sb-main">
                  <span className="search-meta"><b translate="no" className="sm-where" title={f.name}>{f.name}</b><span className="mono faint">{when(f.createdAt)}</span></span>
                  <span className="search-snippet faint">{formatSize(f.size)} · {byId.get(f.uploaderId)?.displayName ?? 'Someone'}{c ? ` · ${convTitle(c, byId, meId)}` : ''}</span>
                  {f.textMatch && <span className="search-snippet"><span className="faint">Text in the image: </span><Snippet text={f.textMatch.replace(/\n/g, ' · ')} /></span>}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
