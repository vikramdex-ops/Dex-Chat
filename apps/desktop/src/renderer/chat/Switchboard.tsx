// The Switchboard: one list of conversations for the current lens, newest activity first.
// Unread = bold name + a teal tick on the left edge; only mentions get an (amber) count.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Conversation, PublicUser } from '@dex/core';
import { Avatar, Icon, Popover, colorFor, initials, presenceFor, useToast } from '../ui.tsx';
import { plainPreview } from './format.tsx';
import { useChat } from './store.ts';

export function convTitle(c: Conversation, users: Map<string, PublicUser>, meId: string): string {
  if (c.kind === 'space') return c.name ?? 'Space';
  const others = c.members.filter((m) => m !== meId).map((m) => users.get(m)?.displayName ?? 'Someone');
  if (!others.length) return 'Just you';
  if (others.length <= 3) return others.join(', ');
  return `${others.slice(0, 2).join(', ')} and ${others.length - 2} others`;
}

export function ConvTile({ c, users, meId, online, size }: { c: Conversation; users: Map<string, PublicUser>; meId: string; online: Set<string>; size?: 'sm' | 'lg' }) {
  if (c.kind === 'space') {
    return (
      <span className={`avatar space-tile${size ? ` ${size}` : ''}`} style={{ background: colorFor(c.id) }} aria-hidden="true">
        {initials(c.name ?? 'S').slice(0, 1)}
      </span>
    );
  }
  const others = c.members.filter((m) => m !== meId);
  if (others.length === 1) {
    const u = users.get(others[0]);
    return <Avatar user={{ id: others[0], displayName: u?.displayName ?? '?' }} presence={presenceFor(others[0])} size={size} />;
  }
  return (
    <span className={`group-tile${size ? ` ${size}` : ''}`} aria-hidden="true">
      {others.slice(0, 2).map((id) => <Avatar key={id} user={{ id, displayName: users.get(id)?.displayName ?? '?' }} size="sm" />)}
    </span>
  );
}

export function shortTime(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const days = Math.floor((today.setHours(0, 0, 0, 0) - new Date(ts).setHours(0, 0, 0, 0)) / 86400000);
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** The conversation list's width: dragged by its edge, kept on this device. */
const SB_KEY = 'dex-sb-width';
function applyWidth(w: number): number {
  const v = Math.max(220, Math.min(480, Math.round(w)));
  document.documentElement.style.setProperty('--sb-w', `${v}px`);
  return v;
}
try { const w = Number(localStorage.getItem(SB_KEY)); if (w) applyWidth(w); } catch { /* storage off */ }
function startResize(e: React.PointerEvent<HTMLDivElement>): void {
  const aside = (e.currentTarget.parentElement as HTMLElement);
  const left = aside.getBoundingClientRect().left;
  const el = e.currentTarget;
  el.setPointerCapture(e.pointerId);
  document.body.classList.add('resizing');
  let w = aside.offsetWidth;
  const move = (ev: PointerEvent) => { w = applyWidth(ev.clientX - left); };
  const up = () => {
    el.removeEventListener('pointermove', move);
    document.body.classList.remove('resizing');
    try { localStorage.setItem(SB_KEY, String(w)); } catch { /* storage off */ }
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up, { once: true });
}

export function Switchboard({ kind, users, meId, online, activeId, onOpen, onNew, onBrowse }: {
  kind: 'direct' | 'space';
  users: Map<string, PublicUser>;
  meId: string;
  online: Set<string>;
  activeId: string | null;
  onOpen: (id: string) => void;
  onNew?: () => void;
  onBrowse?: () => void;
}) {
  const conversations = useChat((s) => s.conversations);
  const ready = useChat((s) => s.ready);
  const [filter, setFilter] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  // how the list is ordered and narrowed (kept per device)
  const [sort, setSort] = useState<'recent' | 'unread' | 'name'>(() => { try { return (localStorage.getItem('dex-sb-sort') as 'recent' | 'unread' | 'name' | null) ?? 'recent'; } catch { return 'recent'; } });
  const [only, setOnly] = useState<'all' | 'unread'>('all');
  const [sortMenu, setSortMenu] = useState(false);
  const sortBtn = useRef<HTMLButtonElement>(null);
  const chooseSort = (v: 'recent' | 'unread' | 'name') => { setSort(v); setSortMenu(false); try { localStorage.setItem('dex-sb-sort', v); } catch { /* storage off */ } };
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null);

  const all = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return [...conversations.values()]
      .filter((c) => c.kind === kind && c.joined)
      .filter((c) => !q || convTitle(c, users, meId).toLowerCase().includes(q) || (c.topic ?? '').toLowerCase().includes(q))
      .filter((c) => only === 'all' || c.unread > 0 || c.mentions > 0 || c.id === activeId)
      .sort((a, b) => {
        if (a.everyone !== b.everyone) return a.everyone ? -1 : 1; // the Office space stays on top
        if (sort === 'name') return convTitle(a, users, meId).localeCompare(convTitle(b, users, meId));
        if (sort === 'unread') { const d = Number(b.mentions > 0) - Number(a.mentions > 0) || Number(b.unread > 0) - Number(a.unread > 0); if (d) return d; }
        return (b.lastMessage?.createdAt ?? b.createdAt) - (a.lastMessage?.createdAt ?? a.createdAt);
      });
  }, [conversations, kind, filter, users, meId, sort, only, activeId]);
  const archived = all.filter((c) => c.archived);
  const live = all.filter((c) => !c.archived);
  // pinned first, then each person's own sections, then the rest
  const groups = useMemo(() => {
    const pinned = live.filter((c) => c.pinnedAt).sort((a, b) => (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0));
    const sections = new Map<string, Conversation[]>();
    for (const c of live) if (!c.pinnedAt && c.section) sections.set(c.section, [...(sections.get(c.section) ?? []), c]);
    const rest = live.filter((c) => !c.pinnedAt && !c.section);
    const out: Array<{ title: string | null; items: Conversation[] }> = [];
    if (pinned.length) out.push({ title: 'Pinned', items: pinned });
    for (const [title, items] of [...sections].sort((a, b) => a[0].localeCompare(b[0]))) out.push({ title, items });
    if (rest.length) out.push({ title: out.length ? (kind === 'space' ? 'Spaces' : 'Conversations') : null, items: rest });
    return out;
  }, [live, kind]);
  const mySections = useMemo(() => [...new Set([...conversations.values()].map((c) => c.section).filter((x): x is string => !!x))].sort(), [conversations]);

  const row = (c: Conversation) => {
    const title = convTitle(c, users, meId);
    const last = c.lastMessage;
    const who = last ? (last.authorId === meId ? 'You' : users.get(last.authorId)?.displayName.split(' ')[0] ?? '') : '';
    const preview = last ? `${c.kind === 'space' || c.members.length > 2 || last.authorId === meId ? `${who}: ` : ''}${last.body ? plainPreview(last.body, users) : 'Message deleted'}` : (c.topic ?? 'No messages yet');
    return (
      <div key={c.id} className="sb-row-wrap">
        <button role="listitem" className={`sb-row${c.id === activeId ? ' active' : ''}${c.unread ? ' unread' : ''}${c.muted ? ' muted' : ''}${c.archived ? ' archived' : ''}`}
          onClick={() => onOpen(c.id)} aria-current={c.id === activeId ? 'true' : undefined}
          onContextMenu={(e) => { e.preventDefault(); setMenu({ id: c.id, anchor: e.currentTarget }); }}>
          <ConvTile c={c} users={users} meId={meId} online={online} />
          <span className="sb-main">
            <span className="sb-title">
              <span className="sb-name">{title}</span>
              {c.private && c.kind === 'space' && <Icon name="lock" size={12} />}
              {c.muted && <Icon name="mute" size={12} />}
            </span>
            <span className="sb-preview">{preview}</span>
          </span>
          <span className="sb-meta">
            <span className="sb-time">{last ? shortTime(last.createdAt) : ''}</span>
            {c.mentions > 0 ? <span className="badge">{c.mentions}</span> : c.unread > 0 && !c.muted ? <span className="sb-dot" aria-label={`${c.unread} unread`} /> : c.pinnedAt ? <Icon name="pin" size={11} className="sb-pin" /> : null}
          </span>
        </button>
        <button className="icon-btn sb-more" aria-label={`Options for ${title}`} onClick={(e) => setMenu({ id: c.id, anchor: e.currentTarget })}><Icon name="more" size={15} /></button>
      </div>
    );
  };

  return (
    <aside className="switchboard" aria-label={kind === 'space' ? 'Spaces' : 'Direct conversations'}>
      <div className="sb-resize" role="separator" aria-orientation="vertical" aria-label="Resize the list" title="Drag to resize" onPointerDown={startResize} />
      <div className="sb-head">
        <span className="label">{kind === 'space' ? 'Spaces' : 'Direct'} · {live.length}</span>
        <div className="row-actions">
          {onBrowse && <button className="icon-btn" title="Find Spaces to join" onClick={onBrowse}><Icon name="search" size={16} /></button>}
          {onNew && <button className="icon-btn accent" title={kind === 'space' ? 'New Space' : 'New Direct conversation'} onClick={onNew}><Icon name="plus" size={16} /></button>}
        </div>
      </div>
      <div className="sb-filter">
        <input className="input" placeholder={kind === 'space' ? 'Filter Spaces' : 'Filter people'} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter conversations" />
        <button className={`icon-btn sb-only${only === 'unread' ? ' on' : ''}`} title={only === 'unread' ? 'Show all' : 'Show unread only'} aria-pressed={only === 'unread'} onClick={() => setOnly(only === 'unread' ? 'all' : 'unread')}><Icon name="bell" size={15} /></button>
        <button ref={sortBtn} className="icon-btn" title="Sort" aria-haspopup="menu" onClick={() => setSortMenu(!sortMenu)}><Icon name="rows" size={15} /></button>
        {sortMenu && (
          <Popover anchor={sortBtn.current} onClose={() => setSortMenu(false)} className="menu">
            <div className="menu-label">Sort by</div>
            {([['recent', 'Latest message'], ['unread', 'Unread first'], ['name', 'Name']] as const).map(([v, l]) => (
              <button key={v} role="menuitemradio" aria-checked={sort === v} onClick={() => chooseSort(v)}>{sort === v ? <Icon name="check" size={15} /> : <span style={{ width: 15 }} />}{l}</button>
            ))}
          </Popover>
        )}
      </div>
      <div className="sb-list" role="list">
        {!ready && <div className="sb-empty"><span className="spinner" /></div>}
        {ready && live.length === 0 && (
          <div className="sb-empty">
            <span>{filter ? 'Nothing matches.' : only === 'unread' ? 'Nothing unread.' : kind === 'space' ? 'No Spaces yet.' : 'No Direct conversations yet.'}</span>
            {!filter && onNew && <button className="btn" onClick={onNew}><Icon name="plus" size={15} />{kind === 'space' ? 'Create a Space' : 'Message someone'}</button>}
          </div>
        )}
        {groups.map((g) => (
          <div key={g.title ?? 'all'} className="sb-group">
            {g.title && <div className="sb-group-title label">{g.title}</div>}
            {g.items.map(row)}
          </div>
        ))}
        {archived.length > 0 && (
          <div className="sb-group">
            <button className="sb-group-title label link" onClick={() => setShowArchived(!showArchived)}>{showArchived ? 'Hide' : 'Show'} archived · {archived.length}</button>
            {showArchived && archived.map(row)}
          </div>
        )}
      </div>
      {menu && conversations.get(menu.id) && <ConvMenu c={conversations.get(menu.id)!} anchor={menu.anchor} sections={mySections} onClose={() => setMenu(null)} />}
    </aside>
  );
}

function ConvMenu({ c, anchor, sections, onClose }: { c: Conversation; anchor: HTMLElement; sections: string[]; onClose: () => void }) {
  const toast = useToast();
  const [naming, setNaming] = useState<string | null>(null);
  const run = (p: Promise<unknown>, ok?: string) => { onClose(); void p.then(() => ok && toast(ok)).catch((e: Error) => toast(e.message, true)); };
  const organise = (patch: { pinned?: boolean; section?: string | null }, ok: string) => run(window.dex.request('conv.organise', { convId: c.id, ...patch }), ok);
  const mute = (ms: number | null, label: string) => run(window.dex.request('conv.mute', { convId: c.id, muted: true, until: ms === null ? null : Date.now() + ms }), label);
  const tomorrow = () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.getTime() - Date.now(); };
  return (
    <Popover anchor={anchor} onClose={onClose} className="menu conv-menu">
      <button role="menuitem" onClick={() => organise({ pinned: !c.pinnedAt }, c.pinnedAt ? 'Unpinned' : 'Pinned to the top')}><Icon name="pin" size={16} />{c.pinnedAt ? 'Unpin' : 'Pin to the top'}</button>
      <div className="menu-label label">Section</div>
      {sections.filter((x) => x !== c.section).map((x) => <button key={x} role="menuitem" onClick={() => organise({ section: x }, `Moved to ${x}`)}><Icon name="list" size={16} />{x}</button>)}
      {naming === null
        ? <button role="menuitem" onClick={() => setNaming('')}><Icon name="plus" size={16} />New section…</button>
        : (
          <form className="menu-input" onSubmit={(e) => { e.preventDefault(); if (naming.trim()) organise({ section: naming.trim() }, `Moved to ${naming.trim()}`); }}>
            <input className="input" autoFocus maxLength={40} placeholder="Projects, Clients…" aria-label="Section name" value={naming} onChange={(e) => setNaming(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setNaming(null); } }} />
            <button className="btn primary sm" disabled={!naming.trim()}>Add</button>
          </form>
        )}
      {c.section && <button role="menuitem" onClick={() => organise({ section: null }, 'Removed from the section')}><Icon name="x" size={16} />Remove from {c.section}</button>}
      <div className="menu-sep" />
      {c.muted
        ? <button role="menuitem" onClick={() => run(window.dex.request('conv.mute', { convId: c.id, muted: false }), 'Notifications on')}><Icon name="bell" size={16} />Unmute{c.mutedUntil ? ` (muted until ${new Date(c.mutedUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})` : ''}</button>
        : <>
            <div className="menu-label label">Mute</div>
            <button role="menuitem" onClick={() => mute(3600_000, 'Muted for an hour')}><Icon name="mute" size={16} />For 1 hour</button>
            <button role="menuitem" onClick={() => mute(8 * 3600_000, 'Muted for 8 hours')}><Icon name="mute" size={16} />For 8 hours</button>
            <button role="menuitem" onClick={() => mute(tomorrow(), 'Muted until tomorrow morning')}><Icon name="mute" size={16} />Until tomorrow</button>
            <button role="menuitem" onClick={() => mute(null, 'Muted. You will still hear about mentions.')}><Icon name="mute" size={16} />Until I unmute</button>
          </>}
    </Popover>
  );
}
