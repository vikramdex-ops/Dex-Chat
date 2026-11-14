import { useEffect, useMemo, useState } from 'react';
import type { Session } from '@dex/core';
import type { AppState } from '../../shared/bridge.ts';
import { OfflineBanner } from '../App.tsx';
import { Avatar, Icon, ROLE_LABEL, Segmented, presenceFor } from '../ui.tsx';

type Filter = 'all' | 'online' | 'admins';

export function People({ state, session, query, setQuery, focusUser, onMessage }: {
  state: AppState; session: Session; query: string; setQuery: (q: string) => void; focusUser: string | null; onMessage: (userId: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const online = useMemo(() => new Set(session.online), [session.online]);

  const people = useMemo(() => {
    const q = query.trim().toLowerCase();
    return session.users
      .filter((u) => filter === 'all' || (filter === 'online' ? online.has(u.id) : u.role === 'owner' || u.role === 'admin'))
      .filter((u) => !q || [u.displayName, u.account, u.title ?? '', u.statusText ?? ''].some((f) => f.toLowerCase().includes(q)))
      .sort((a, b) => Number(online.has(b.id)) - Number(online.has(a.id)) || a.displayName.localeCompare(b.displayName));
  }, [session.users, online, filter, query]);

  useEffect(() => {
    if (focusUser) document.getElementById(`person-${focusUser}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focusUser]);

  return (
    <div className="view">
      <OfflineBanner state={state} />
      <div className="view-head">
        <div>
          <h1>Directory</h1>
          <p className="label">{session.users.length} people · {online.size} online</p>
        </div>
      </div>
      <div className="toolbar">
        <input className="input" placeholder="Filter by name, account, title…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter people" />
        <Segmented<Filter> label="Show" value={filter} onChange={setFilter} options={[
          { value: 'all', label: 'Everyone' },
          { value: 'online', label: 'Online' },
          { value: 'admins', label: 'Admins' },
        ]} />
      </div>
      {people.length === 0 ? (
        <div className="empty"><Icon name="people" size={36} /><span>No one matches “{query}”.</span></div>
      ) : (
        <div className="grid cols-people">
          {people.map((u) => (
            <div key={u.id} id={`person-${u.id}`} className={`card person${focusUser === u.id ? ' flash' : ''}`}>
              <Avatar user={u} presence={presenceFor(u.id)} size="lg" />
              <div className="who">
                <div className="name">
                  <span className="line">{u.displayName}</span>
                  {u.id === session.me.id && <span className="chip accent">You</span>}
                  {(u.role === 'owner' || u.role === 'admin') && <span className="chip">{ROLE_LABEL[u.role]}</span>}
                </div>
                <div className="line muted">{u.title || (online.has(u.id) ? 'Online' : 'Offline')}</div>
                <div className="line faint mono selectable">{u.account}</div>
                {u.statusText && <div className="status">{u.statusText}</div>}
                {u.id !== session.me.id && (
                  <button className="btn person-msg" onClick={() => onMessage(u.id)} disabled={state.phase !== 'ready'}>
                    <Icon name="chat" size={15} />Message
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
