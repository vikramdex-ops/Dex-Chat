// The Switchboard: one panel for every conversation, shared by Direct and Spaces and narrowed by
// lens chips (People · Spaces · Projects). While a Pane is open it folds to a 56 px strip of tiles.
// Unread = bold name + a teal tick on the left edge; only callouts to you get an (amber) count.
import { isNibConv, useNib } from '../nib/store.ts';
import { NibTile } from '../nib/NibMark.tsx';
import { memo, useCallback, useDeferredValue, useMemo, useRef, useState } from 'react';
import type { Conversation, PublicUser } from '@dex/core';
import { Avatar, Icon, Popover, colorFor, initials, presenceFor, useToast } from '../ui.tsx';
import type { IconName } from '../ui.tsx';
import { plainPreview } from './format.tsx';
import { useChat } from './store.ts';
import { formatTime, useTimeFormat } from '../time.ts';
import { CONV_DRAG, openBeside, openInPane, usePanes } from './panes.ts';
import { CLOSE, LUNCH, endOfToday, hm, nextMonday, todayAt } from './officeTime.ts';
import { LoungeSection } from '../lounges/Lounges.tsx';
import { RefDropRow } from './refs.tsx';
import { useProgressive } from '../progressive.ts';

export type Chip = 'all' | 'people' | 'spaces' | 'projects';
export const CHIPS: Array<{ id: Chip; label: string; icon: IconName }> = [
  { id: 'all', label: 'All', icon: 'rows' },
  { id: 'people', label: 'People', icon: 'direct' },
  { id: 'spaces', label: 'Spaces', icon: 'grid' },
  { id: 'projects', label: 'Projects', icon: 'drawing' },
];

/** A Space named after a job: a job number such as P-12, P-12513 or J4410 in its name or topic. */
export function isProject(c: Conversation): boolean {
  return c.kind === 'space' && /\b[A-Z]{1,3}-?\d{2,6}\b/.test(`${c.name ?? ''} ${c.topic ?? ''}`);
}

const inChip = (c: Conversation, chip: Chip) =>
  chip === 'all' || (chip === 'people' ? c.kind === 'direct' : chip === 'spaces' ? c.kind === 'space' : isProject(c));

export function convTitle(c: Conversation, users: Map<string, PublicUser>, meId: string): string {
  if (c.kind === 'space') return c.name ?? 'Space';
  const others = c.members.filter((m) => m !== meId).map((m) => users.get(m)?.displayName ?? 'Someone');
  if (!others.length) return 'Just you';
  if (others.length <= 3) return others.join(', ');
  return `${others.slice(0, 2).join(', ')} and ${others.length - 2} others`;
}

export function ConvTile({ c, users, meId, size }: { c: Conversation; users: Map<string, PublicUser>; meId: string; online?: Set<string>; size?: 'sm' | 'lg' }) {
  if (c.kind === 'space') {
    return (
      <span className={`avatar space-tile${size ? ` ${size}` : ''}`} style={{ background: colorFor(c.id) }} aria-hidden="true" translate="no">
        {initials(c.name ?? 'S').slice(0, 1)}
      </span>
    );
  }
  const others = c.members.filter((m) => m !== meId);
  if (others.length === 1) {
    const u = users.get(others[0]);
    return <Avatar user={{ id: others[0], displayName: u?.displayName ?? '?' }} presence={presenceFor(others[0])} size={size} />;
  }
  // a small group: a stack of sheets with the head count on the top one
  return (
    <span className={`avatar group-tile${size ? ` ${size}` : ''}`} style={{ background: colorFor(others[0] ?? c.id) }} aria-hidden="true" translate="no">
      {initials(users.get(others[0])?.displayName ?? '?').slice(0, 1)}<small>{c.members.length}</small>
    </span>
  );
}

export function shortTime(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return formatTime(d);
  const days = Math.floor((today.setHours(0, 0, 0, 0) - new Date(ts).setHours(0, 0, 0, 0)) / 86400000);
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** Hush choices: till lunch, till the office closes, until Monday, until unhushed. */
export function hushChoices(now = new Date()): Array<{ label: string; until: number | null; note: string }> {
  const out: Array<{ label: string; until: number | null; note: string }> = [];
  const lunch = todayAt(LUNCH[0], LUNCH[1], now);
  const close = todayAt(CLOSE[0], CLOSE[1], now);
  if (now.getTime() < lunch - 10 * 60_000) out.push({ label: 'Till lunch', until: lunch, note: hm(lunch) });
  out.push(now.getTime() < close - 10 * 60_000 ? { label: 'Till end of day', until: close, note: hm(close) } : { label: 'Till end of day', until: endOfToday(now), note: 'midnight' });
  out.push({ label: 'Until Monday', until: nextMonday(now), note: new Date(nextMonday(now)).toLocaleDateString([], { day: 'numeric', month: 'short' }) });
  out.push({ label: 'Until I turn it back on', until: null, note: '' });
  return out;
}

export function hushToast(until: number | null): string {
  if (until === null) return 'Hushed. Callouts to you still come through.';
  const d = new Date(until);
  return d.toDateString() === new Date().toDateString() ? `Hushed till ${hm(until)}` : `Hushed until ${d.toLocaleDateString([], { weekday: 'long' })}`;
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

type Sort = 'recent' | 'unread' | 'name';

export function Switchboard({ chip, setChip, users, meId, folded, setFolded, onNew, onBrowse }: {
  chip: Chip;
  setChip: (c: Chip) => void;
  users: Map<string, PublicUser>;
  meId: string;
  /** Folded to the 56 px tile strip. */
  folded: boolean;
  /** Folding by hand (null while nothing is open: the full list shows anyway). */
  setFolded: ((v: boolean) => void) | null;
  onNew?: () => void;
  onBrowse?: () => void;
}) {
  const conversations = useChat((s) => s.conversations);
  const ready = useChat((s) => s.ready);
  // Nib's conversation has its own row above the lists
  const nibId = useNib((s) => s.me?.botId ?? null);
  const panes = usePanes();
  const focusId = panes.ids[panes.focus] ?? null;
  const [filter, setFilter] = useState('');
  // the list follows the filter a moment behind the typing, so keys never wait for it
  const query = useDeferredValue(filter);
  const clock = useTimeFormat();
  const [showArchived, setShowArchived] = useState(false);
  // how the list is ordered and narrowed (kept per device)
  const [sort, setSort] = useState<Sort>(() => { try { return (localStorage.getItem('dex-sb-sort') as Sort | null) ?? 'recent'; } catch { return 'recent'; } });
  const [only, setOnly] = useState<'all' | 'unread'>('all');
  const [sortMenu, setSortMenu] = useState(false);
  const sortBtn = useRef<HTMLButtonElement>(null);
  const chooseSort = (v: Sort) => { setSort(v); setSortMenu(false); try { localStorage.setItem('dex-sb-sort', v); } catch { /* storage off */ } };
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  // the row's arrow opens its menu and closes it again (a second click on the same arrow)
  const toggleMenu = useCallback((m: { id: string; anchor: HTMLElement }) => setMenu((was) => (was?.id === m.id && was.anchor === m.anchor ? null : m)), []);

  const all = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...conversations.values()]
      .filter((c) => c.joined && inChip(c, chip) && !isNibConv(c.members))
      .filter((c) => !q || convTitle(c, users, meId).toLowerCase().includes(q) || (c.topic ?? '').toLowerCase().includes(q))
      .filter((c) => only === 'all' || c.unread > 0 || c.mentions > 0 || c.id === focusId)
      .sort((a, b) => {
        if (a.everyone !== b.everyone) return a.everyone ? -1 : 1; // the Office space stays on top
        if (sort === 'name') return convTitle(a, users, meId).localeCompare(convTitle(b, users, meId));
        if (sort === 'unread') { const d = Number(b.mentions > 0) - Number(a.mentions > 0) || Number(b.unread > 0) - Number(a.unread > 0); if (d) return d; }
        return (b.lastMessage?.createdAt ?? b.createdAt) - (a.lastMessage?.createdAt ?? a.createdAt);
      });
  }, [conversations, chip, query, users, meId, sort, only, focusId, nibId]);
  const archived = all.filter((c) => c.archived);
  const live = all.filter((c) => !c.archived);
  // kept on top first, then each person's own drawers, then projects, Spaces and people
  const groups = useMemo(() => {
    const top = live.filter((c) => c.pinnedAt).sort((a, b) => (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0));
    const drawers = new Map<string, Conversation[]>();
    for (const c of live) if (!c.pinnedAt && c.section) drawers.set(c.section, [...(drawers.get(c.section) ?? []), c]);
    const rest = live.filter((c) => !c.pinnedAt && !c.section);
    const out: Array<{ title: string; items: Conversation[]; drawer?: boolean }> = [];
    if (top.length) out.push({ title: 'Kept on top', items: top });
    for (const [title, items] of [...drawers].sort((a, b) => a[0].localeCompare(b[0]))) out.push({ title, items, drawer: true });
    if (chip === 'all') {
      const projects = rest.filter(isProject);
      const spaces = rest.filter((c) => c.kind === 'space' && !isProject(c));
      const people = rest.filter((c) => c.kind === 'direct');
      if (projects.length) out.push({ title: 'Projects', items: projects });
      if (spaces.length) out.push({ title: 'Spaces', items: spaces });
      if (people.length) out.push({ title: 'People', items: people });
    } else if (rest.length) out.push({ title: CHIPS.find((x) => x.id === chip)!.label, items: rest });
    return out;
  }, [live, chip]);
  const myDrawers = useMemo(() => [...new Set([...conversations.values()].map((c) => c.section).filter((x): x is string => !!x))].sort(), [conversations]);
  const chipAttention = useMemo(() => {
    const out: Record<Chip, boolean> = { all: false, people: false, spaces: false, projects: false };
    for (const c of conversations.values()) {
      if (!c.joined || c.muted && !c.mentions) continue;
      const needs = c.mentions > 0 || (c.kind === 'direct' && c.unread > 0);
      if (!needs) continue;
      for (const k of ['people', 'spaces', 'projects'] as Chip[]) if (inChip(c, k)) out[k] = true;
    }
    return out;
  }, [conversations]);

  const row = (c: Conversation) => {
    const at = panes.ids.indexOf(c.id);
    const state = c.id === focusId ? ' active' : at >= 0 ? ' open' : '';
    // a person's beacon ring is part of the row (the row is kept while nothing about it changes)
    const one = c.kind === 'direct' ? c.members.filter((m) => m !== meId) : [];
    return <SbRow key={c.id} c={c} users={users} meId={meId} state={state} folded={folded} onMenu={toggleMenu} menuOpen={menu?.id === c.id} presence={one.length === 1 ? presenceFor(one[0]) : ''} clock={clock} />;
  };

  const label = CHIPS.find((x) => x.id === chip)!.label;
  return (
    <aside className={`switchboard${folded ? ' folded' : ''}`} aria-label="Switchboard">
      {!folded && <div className="sb-resize" role="separator" aria-orientation="vertical" aria-label="Resize the Switchboard" title="Drag to resize" onPointerDown={startResize} />}
      <div className="sb-head">
        {setFolded && (
          <button className="icon-btn sb-fold" title={folded ? 'Open the Switchboard' : 'Fold the Switchboard to tiles'} aria-expanded={!folded} onClick={() => setFolded(!folded)}>
            <Icon name="back" size={16} />
          </button>
        )}
        {!folded && <span className="label">Switchboard <span className="mono">· {live.length}</span></span>}
        <span className="sb-head-tools">
          {!folded && onBrowse && <button className="icon-btn" title="Find Spaces to join" onClick={onBrowse}><Icon name="search" size={16} /></button>}
          {onNew && <button className="icon-btn accent" title={chip === 'people' ? 'New Direct conversation' : chip === 'all' ? 'New conversation or Space' : 'New Space'} onClick={onNew}><Icon name="plus" size={16} /></button>}
        </span>
      </div>
      {!folded && (
        <>
          <div className="sb-lenses" role="group" aria-label="Show">
            {CHIPS.map((x) => (
              <button key={x.id} aria-pressed={chip === x.id} onClick={() => setChip(x.id)}>
                {x.label}{chipAttention[x.id] && chip !== x.id && <i className="sb-lens-dot" aria-label="needs you" />}
              </button>
            ))}
          </div>
          <div className="sb-filter">
            <input className="input" placeholder={`Filter ${label === 'All' ? 'everything' : label.toLowerCase()}`} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter conversations" />
            <button className={`icon-btn sb-only${only === 'unread' ? ' on' : ''}`} title={only === 'unread' ? 'Show all' : 'Show unread only'} aria-pressed={only === 'unread'} onClick={() => setOnly(only === 'unread' ? 'all' : 'unread')}><Icon name="unread" size={15} /></button>
            <button ref={sortBtn} className="icon-btn" title="Sort" aria-haspopup="menu" onClick={() => setSortMenu(!sortMenu)}><Icon name="rows" size={15} /></button>
            {sortMenu && (
              <Popover anchor={sortBtn.current} onClose={() => setSortMenu(false)} className="menu">
                <div className="menu-label label">Sort by</div>
                {([['recent', 'Latest message'], ['unread', 'Unread first'], ['name', 'Name']] as const).map(([v, l]) => (
                  <button key={v} role="menuitemradio" aria-checked={sort === v} onClick={() => chooseSort(v)}>{sort === v ? <Icon name="check" size={15} /> : <span style={{ width: 15 }} />}{l}</button>
                ))}
              </Popover>
            )}
          </div>
        </>
      )}
      <div className="sb-list" role="list">
        {!ready && <div className="sb-empty"><span className="spinner" /></div>}
        {ready && live.length === 0 && !folded && (
          <div className="sb-empty">
            <span>{filter ? 'Nothing matches.' : only === 'unread' ? 'Nothing unread.' : chip === 'spaces' ? 'No Spaces yet.' : chip === 'projects' ? 'No project Spaces yet. Name a Space after its job number, such as P-12513.' : chip === 'people' ? 'No Direct conversations yet.' : 'Nothing here yet.'}</span>
            {filter && <button className="btn" onClick={() => setFilter('')}>Clear the filter</button>}
            {!filter && only === 'unread' && <button className="btn" onClick={() => setOnly('all')}>Show all</button>}
            {!filter && only !== 'unread' && onNew && chip !== 'projects' && <button className="btn" onClick={onNew}><Icon name="plus" size={15} />{chip === 'spaces' ? 'Create a Space' : 'Write to someone'}</button>}
          </div>
        )}
        {(chip === 'all' || chip === 'people') && !query.trim() && <NibRow folded={!!folded} focusId={focusId} />}
        {groups.map((g) => (
          <div key={`${g.drawer ? 'd:' : ''}${g.title}`} className={`sb-group${g.drawer ? ' sb-drawer' : ''}`}>
            {g.drawer
              ? <div className="sb-group-title label" title="Your drawer: a group of your own. Only you see it. Change it from a conversation's arrow."><Icon name="drawer" size={11} /><span translate="no">{g.title}</span><span className="sb-drawer-tag mono">DRAWER</span></div>
              : <div className="sb-group-title label">{g.title}</div>}
            <Rows items={g.items} row={row} />
          </div>
        ))}
        <LoungeSection folded={!!folded} />
        {archived.length > 0 && !folded && (
          <div className="sb-group">
            <button className="sb-group-title label link" onClick={() => setShowArchived(!showArchived)}>{showArchived ? 'Hide archived' : 'Show archived'} · {archived.length}</button>
            {showArchived && archived.map(row)}
          </div>
        )}
      </div>
      {menu && conversations.get(menu.id) && <ConvMenu c={conversations.get(menu.id)!} anchor={menu.anchor} drawers={myDrawers} onClose={() => setMenu(null)} />}
    </aside>
  );
}

/** Nib's conversation, above the lists: always there, never in a drawer. */
function NibRow({ folded, focusId }: { folded: boolean; focusId: string | null | undefined }) {
  const me = useNib((s) => s.me);
  const c = useChat((s) => (me?.convId ? s.conversations.get(me.convId) : undefined));
  if (!me?.convId || !c) return null;
  const items = me.items.length;
  const line = me.exempt || !me.workday || !me.enabled ? 'Reminders, leave, who’s in'
    : me.day.state === 'sent' ? 'Day sheet sent' : me.day.state === 'nothing' ? 'Nothing today'
      : items === 1 ? 'Day sheet · 1 item' : `Day sheet · ${items} items`;
  const ink = me.nudge && me.nudge.level >= 2 ? 'needs' : me.nudge?.level || me.welcome ? 'quiet' : 'none';
  return (
    <div className="sb-group sb-nib-group">
      <button className={`sb-nib${c.id === focusId ? ' active' : ''}${c.unread ? ' unread' : ''}`} onClick={() => openInPane(c.id)} aria-current={c.id === focusId ? 'true' : undefined} title={folded ? 'Nib' : undefined}>
        <NibTile size={folded ? 32 : 30} ink={ink} />
        {!folded && <span className="sb-main"><span className="sb-title"><span className="sb-name" translate="no">Nib</span><span className="chip">ALWAYS HERE</span></span><span className="sb-preview">{line}</span></span>}
        {c.unread > 0 && !folded && <span className="sb-nib-new mono">{c.unread}</span>}
      </button>
    </div>
  );
}

/** A group's rows: a screenful at once, the rest over the next frames (see progressive.ts). */
function Rows({ items, row }: { items: Conversation[]; row: (c: Conversation) => React.ReactNode }) {
  return <>{useProgressive(items, 30).map(row)}</>;
}

/**
 * One conversation in the list, drawn again only when it changes (its conversation, the people,
 * whether it is open), not for every change elsewhere in a list of hundreds.
 */
const SbRow = memo(function SbRow({ c, users, meId, state, folded, onMenu, menuOpen }: {
  c: Conversation; users: Map<string, PublicUser>; meId: string; state: string; folded: boolean;
  onMenu: (m: { id: string; anchor: HTMLElement }) => void;
  /** Its menu is open: the arrow stays shown and points up. */
  menuOpen: boolean;
  /** The other person's presence in a one-to-one (drawn by the tile; here so a change redraws the row). */
  presence: string;
  /** The time format (the row's time is drawn again when it changes). */
  clock: string;
}) {
    const title = convTitle(c, users, meId);
    const last = c.lastMessage;
    const who = last ? (last.authorId === meId ? 'You' : users.get(last.authorId)?.displayName.split(' ')[0] ?? '') : '';
    const preview = last ? `${c.kind === 'space' || c.members.length > 2 || last.authorId === meId ? `${who}: ` : ''}${last.body ? plainPreview(last.body, users) : 'Message deleted'}` : (c.topic ?? 'No messages yet');
    return (
      <RefDropRow convId={c.id} className={`sb-row-wrap${menuOpen ? ' menu-open' : ''}`}>
        <button className={`sb-row${state}${c.unread ? ' unread' : ''}${c.muted ? ' muted' : ''}${c.archived ? ' archived' : ''}`}
          draggable onDragStart={(e) => { e.dataTransfer.setData(CONV_DRAG, c.id); e.dataTransfer.effectAllowed = 'copy'; }}
          onClick={(e) => { if (e.ctrlKey || e.metaKey) openBeside(c.id); else openInPane(c.id); }}
          aria-current={state === ' active' ? 'true' : undefined}
          title={folded ? `${title}${c.mentions ? ` · ${c.mentions} for you` : c.unread ? ' · unread' : ''}\nCtrl+click or drag to lay it beside` : 'Ctrl+click or drag to lay it beside'}
          onContextMenu={(e) => { e.preventDefault(); onMenu({ id: c.id, anchor: e.currentTarget }); }}>
          <ConvTile c={c} users={users} meId={meId} />
          <span className="sb-main">
            <span className="sb-title">
              <span className="sb-name" translate="no">{title}</span>
              {c.private && c.kind === 'space' && <Icon name="lock" size={12} />}
              {c.muted && <Icon name="mute" size={12} />}
            </span>
            <span className="sb-preview">{last && <span className="sb-time">{shortTime(last.createdAt)}</span>}<span translate={last?.body || (!last && c.topic) ? 'no' : undefined}>{preview}</span></span>
          </span>
          {c.mentions > 0 ? <span className="badge" aria-label={`${c.mentions} for you`}>{c.mentions}</span> : c.pinnedAt && !folded ? <Icon name="pin" size={11} className="sb-pin" /> : null}
        </button>
        {!folded && (
          <button className="sb-more" aria-label={`Options for ${title}: lay it beside, keep on top, drawer, hush`} title="Lay it beside, keep on top, put in a drawer, hush"
            aria-haspopup="menu" aria-expanded={menuOpen} onClick={(e) => onMenu({ id: c.id, anchor: e.currentTarget })}><Icon name="chevron" size={14} /></button>
        )}
      </RefDropRow>
    );
  });

function ConvMenu({ c, anchor, drawers, onClose }: { c: Conversation; anchor: HTMLElement; drawers: string[]; onClose: () => void }) {
  const toast = useToast();
  const [naming, setNaming] = useState<string | null>(null);
  const run = (p: Promise<unknown>, ok?: string) => { onClose(); void p.then(() => ok && toast(ok)).catch((e: Error) => toast(e.message, true)); };
  const organise = (patch: { pinned?: boolean; section?: string | null }, ok: string) => run(window.dex.request('conv.organise', { convId: c.id, ...patch }), ok);
  return (
    <Popover anchor={anchor} onClose={onClose} className="menu conv-menu">
      <button role="menuitem" onClick={() => { onClose(); openBeside(c.id); }}><Icon name="beside" size={16} />Lay it beside<span className="kbd">Ctrl click</span></button>
      <button role="menuitem" onClick={() => organise({ pinned: !c.pinnedAt }, c.pinnedAt ? 'Taken off the top' : 'Kept on top')}><Icon name="pin" size={16} />{c.pinnedAt ? 'Take off the top' : 'Keep on top'}</button>
      {/* a drawer is a group of your own in the Switchboard (Clients, Bids, P-12 site): only you see it */}
      <div className="menu-label label conv-menu-drawer">Drawer<span className="menu-label-note">your own group in this list</span></div>
      {drawers.filter((x) => x !== c.section).map((x) => <button key={x} role="menuitem" onClick={() => organise({ section: x }, `Put in your drawer ${x}`)}><Icon name="drawer" size={16} />{x}</button>)}
      {naming === null
        ? <button role="menuitem" onClick={() => setNaming('')}><Icon name="plus" size={16} />New drawer…</button>
        : (
          <form className="menu-input drawer-new" onSubmit={(e) => { e.preventDefault(); if (naming.trim()) organise({ section: naming.trim() }, `Put in your drawer ${naming.trim()}`); }}>
            <div className="drawer-new-row">
              <Icon name="drawer" size={16} />
              <input className="input" autoFocus maxLength={40} placeholder="Name it: Clients, Bids…" aria-label="New drawer's name" aria-describedby="drawer-new-help" value={naming} onChange={(e) => setNaming(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setNaming(null); } }} />
              <button className="icon-btn drawer-add" disabled={!naming.trim()} aria-label="Add the drawer" title="Add (Enter)"><Icon name="check" size={16} /></button>
            </div>
            <p id="drawer-new-help" className="drawer-new-help">A drawer gathers conversations under a heading of your own in the Switchboard. Only you see it; nobody is told.</p>
          </form>
        )}
      {c.section && <button role="menuitem" onClick={() => organise({ section: null }, `Taken out of ${c.section}`)}><Icon name="x" size={16} />Take out of {c.section}</button>}
      <HushItems c={c} onDone={onClose} />
    </Popover>
  );
}

/** The Hush part of a menu: quiet a conversation for a while, or bring it back. */
export function HushItems({ c, onDone }: { c: Conversation; onDone: () => void }) {
  const toast = useToast();
  const mute = (muted: boolean, until: number | null, ok: string) => {
    onDone();
    void window.dex.request('conv.mute', { convId: c.id, muted, until: muted ? until : null }).then(() => toast(ok)).catch((e: Error) => toast(e.message, true));
  };
  return (
    <>
      <div className="menu-label label">Hush</div>
      {c.muted
        ? <button role="menuitem" onClick={() => mute(false, null, 'Unhushed')}><Icon name="bell" size={16} />Unhush{c.mutedUntil ? <span className="menu-note mono">till {hm(c.mutedUntil)}</span> : null}</button>
        : hushChoices().map((h) => (
          <button key={h.label} role="menuitem" onClick={() => mute(true, h.until, hushToast(h.until))}><Icon name="mute" size={16} />{h.label}{h.note && <span className="menu-note mono">{h.note}</span>}</button>
        ))}
    </>
  );
}
