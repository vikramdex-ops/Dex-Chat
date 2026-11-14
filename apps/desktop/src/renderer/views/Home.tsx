// Pulse: what needs you right now, then the state of the office at a glance.
import { useMemo, useState } from 'react';
import type { Session } from '@dex/core';
import type { AppState } from '../../shared/bridge.ts';
import type { Section } from '../App.tsx';
import { OfflineBanner } from '../App.tsx';
import { Avatar, Icon, useToast } from '../ui.tsx';
import { useChat } from '../chat/store.ts';
import { ConvTile, convTitle, shortTime } from '../chat/Switchboard.tsx';
import { plainPreview } from '../chat/format.tsx';

function greeting(d = new Date()): string {
  const h = d.getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export function Home({ state, session, pendingCount, go, open }: {
  state: AppState; session: Session; pendingCount: number; go: (s: Section) => void; open: (id: string, kind: 'direct' | 'space') => void;
}) {
  const toast = useToast();
  const online = new Set(session.online);
  const people = session.users.filter((u) => u.role !== 'bot');
  const onlineUsers = people.filter((u) => online.has(u.id));
  const users = useMemo(() => new Map(session.users.map((u) => [u.id, u] as const)), [session.users]);
  const firstName = session.me.displayName.split(/\s+/)[0];
  const isAdmin = session.me.role === 'owner' || session.me.role === 'admin';
  const [status, setStatus] = useState(session.me.statusText ?? '');
  const live = state.phase === 'ready';
  const conversations = useChat((s) => s.conversations);

  const needsYou = useMemo(() => [...conversations.values()]
    .filter((c) => c.joined && (c.mentions > 0 || (c.unread > 0 && !c.muted)))
    .sort((a, b) => (b.mentions - a.mentions) || ((b.lastMessage?.createdAt ?? 0) - (a.lastMessage?.createdAt ?? 0)))
    .slice(0, 8), [conversations]);

  const saveStatus = async (value: string | null) => {
    try {
      await window.dex.request('me.update', { statusText: value });
      toast(value ? 'Status updated' : 'Status cleared');
    } catch (e) { toast((e as Error).message, true); }
  };

  return (
    <div className="view">
      <OfflineBanner state={state} />
      <div className="view-head">
        <div>
          <h1>{greeting()}, {firstName}</h1>
          <p className="label">Pulse · {onlineUsers.length} of {people.length} online · {session.hub.name}</p>
        </div>
      </div>

      <section className="pulse-section">
        <div className="label" style={{ marginBottom: 10 }}>Needs you{needsYou.length ? ` · ${needsYou.length}` : ''}</div>
        {needsYou.length === 0 ? (
          <div className="empty pulse-empty"><Icon name="check" size={28} /><span>You're all caught up.</span></div>
        ) : (
          <div className="list">
            {needsYou.map((c) => {
              const last = c.lastMessage;
              const who = last ? users.get(last.authorId)?.displayName.split(' ')[0] : '';
              return (
                <button key={c.id} className="list-row pulse-row" onClick={() => open(c.id, c.kind)}>
                  <ConvTile c={c} users={users} meId={session.me.id} online={online} />
                  <span className="sb-main">
                    <span className="sb-title"><span className="sb-name">{convTitle(c, users, session.me.id)}</span></span>
                    <span className="sb-preview">{last ? `${who}: ${plainPreview(last.body, users)}` : ''}</span>
                  </span>
                  <span className="sb-meta">
                    <span className="sb-time">{last ? shortTime(last.createdAt) : ''}</span>
                    {c.mentions > 0 ? <span className="badge">@ {c.mentions}</span> : <span className="chip accent">{c.unread} new</span>}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      <div className="grid cols-3">
        <div className="card interactive" onClick={() => go('directory')} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && go('directory')}>
          <div className="eyebrow">Online now</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <span className="stat">{onlineUsers.length}</span>
            <span className="stack">
              {onlineUsers.slice(0, 6).map((u) => <Avatar key={u.id} user={u} presence="on" size="sm" />)}
            </span>
          </div>
          <p className="faint" style={{ marginTop: 10, fontSize: 13 }}>Open the Directory</p>
        </div>

        <div className="card">
          <div className="eyebrow">Your status</div>
          <form style={{ display: 'flex', gap: 8 }} onSubmit={(e) => { e.preventDefault(); void saveStatus(status.trim() || null); }}>
            <input className="input" style={{ flex: 1, minWidth: 0 }} placeholder="What are you working on?" maxLength={120}
              value={status} onChange={(e) => setStatus(e.target.value)} disabled={!live} aria-label="Status message" />
            <button className="btn primary" disabled={!live || status.trim() === (session.me.statusText ?? '')}>Set</button>
          </form>
          <p className="faint" style={{ marginTop: 10, fontSize: 13 }}>Colleagues see this next to your name.</p>
        </div>

        {isAdmin && (
          <div className="card interactive" onClick={() => go('admin')} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && go('admin')}>
            <div className="eyebrow">Waiting for approval</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span className="stat" style={{ color: pendingCount ? 'var(--amber-ink)' : undefined }}>{pendingCount}</span>
              {pendingCount > 0 && <span className="chip warn">Action needed</span>}
            </div>
            <p className="faint" style={{ marginTop: 10, fontSize: 13 }}>{pendingCount ? 'Review new devices in the Control room' : 'No one is waiting'}</p>
          </div>
        )}

        <div className="card">
          <div className="eyebrow">Office hub</div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <span className="pal-icon" style={{ width: 36, height: 36 }}><Icon name="server" /></span>
            <div style={{ minWidth: 0 }}>
              <h3>{session.hub.name}</h3>
              <div className="faint mono">{state.hub?.host}:{state.hub?.port}</div>
            </div>
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span className={`chip ${live ? 'ok' : 'warn'}`}><Icon name={live ? 'lock' : 'wifi'} size={13} />{live ? 'Encrypted connection' : 'Reconnecting'}</span>
            <span className="chip">Works without internet</span>
          </div>
        </div>
      </div>
    </div>
  );
}
