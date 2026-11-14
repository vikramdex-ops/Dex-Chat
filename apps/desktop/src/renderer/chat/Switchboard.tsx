// The Switchboard: one list of conversations for the current lens, newest activity first.
// Unread = bold name + a teal tick on the left edge; only mentions get an (amber) count.
import { useMemo, useState } from 'react';
import type { Conversation, PublicUser } from '@dex/core';
import { Avatar, Icon, colorFor, initials, presenceFor } from '../ui.tsx';
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

export function Switchboard({ kind, users, meId, online, activeId, onOpen, onNew, onBrowse }: {
  kind: 'direct' | 'space';
  users: Map<string, PublicUser>;
  meId: string;
  online: Set<string>;
  activeId: string | null;
  onOpen: (id: string) => void;
  onNew: () => void;
  onBrowse?: () => void;
}) {
  const conversations = useChat((s) => s.conversations);
  const ready = useChat((s) => s.ready);
  const [filter, setFilter] = useState('');

  const list = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return [...conversations.values()]
      .filter((c) => c.kind === kind && c.joined)
      .filter((c) => !q || convTitle(c, users, meId).toLowerCase().includes(q) || (c.topic ?? '').toLowerCase().includes(q))
      .sort((a, b) => {
        if (a.everyone !== b.everyone) return a.everyone ? -1 : 1; // the Office space stays on top
        return (b.lastMessage?.createdAt ?? b.createdAt) - (a.lastMessage?.createdAt ?? a.createdAt);
      });
  }, [conversations, kind, filter, users, meId]);

  return (
    <aside className="switchboard" aria-label={kind === 'space' ? 'Spaces' : 'Direct conversations'}>
      <div className="sb-head">
        <span className="label">{kind === 'space' ? 'Spaces' : 'Direct'} · {list.length}</span>
        <div className="row-actions">
          {onBrowse && <button className="icon-btn" title="Find Spaces to join" onClick={onBrowse}><Icon name="search" size={16} /></button>}
          <button className="icon-btn accent" title={kind === 'space' ? 'New Space' : 'New Direct conversation'} onClick={onNew}><Icon name="plus" size={16} /></button>
        </div>
      </div>
      <div className="sb-filter">
        <input className="input" placeholder={kind === 'space' ? 'Filter Spaces' : 'Filter people'} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter conversations" />
      </div>
      <div className="sb-list" role="list">
        {!ready && <div className="sb-empty"><span className="spinner" /></div>}
        {ready && list.length === 0 && (
          <div className="sb-empty">
            <span>{filter ? 'Nothing matches.' : kind === 'space' ? 'No Spaces yet.' : 'No Direct conversations yet.'}</span>
            {!filter && <button className="btn" onClick={onNew}><Icon name="plus" size={15} />{kind === 'space' ? 'Create a Space' : 'Message someone'}</button>}
          </div>
        )}
        {list.map((c) => {
          const title = convTitle(c, users, meId);
          const last = c.lastMessage;
          const who = last ? (last.authorId === meId ? 'You' : users.get(last.authorId)?.displayName.split(' ')[0] ?? '') : '';
          const preview = last ? `${c.kind === 'space' || c.members.length > 2 || last.authorId === meId ? `${who}: ` : ''}${last.body ? plainPreview(last.body, users) : 'Message deleted'}` : (c.topic ?? 'No messages yet');
          return (
            <button key={c.id} role="listitem" className={`sb-row${c.id === activeId ? ' active' : ''}${c.unread ? ' unread' : ''}${c.muted ? ' muted' : ''}`}
              onClick={() => onOpen(c.id)} aria-current={c.id === activeId ? 'true' : undefined}>
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
                {c.mentions > 0 ? <span className="badge">{c.mentions}</span> : c.unread > 0 && !c.muted ? <span className="sb-dot" aria-label={`${c.unread} unread`} /> : null}
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
