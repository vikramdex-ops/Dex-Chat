import { useState } from 'react';
import type { Session } from '@dex/core';
import type { AppState } from '../../shared/bridge.ts';
import type { Section } from '../App.tsx';
import { OfflineBanner } from '../App.tsx';
import { Avatar, Icon, useToast } from '../ui.tsx';

function greeting(d = new Date()): string {
  const h = d.getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export function Home({ state, session, pendingCount, go }: { state: AppState; session: Session; pendingCount: number; go: (s: Section) => void }) {
  const toast = useToast();
  const online = new Set(session.online);
  const onlineUsers = session.users.filter((u) => online.has(u.id));
  const firstName = session.me.displayName.split(/\s+/)[0];
  const isAdmin = session.me.role === 'owner' || session.me.role === 'admin';
  const [status, setStatus] = useState(session.me.statusText ?? '');
  const live = state.phase === 'ready';

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
          <p className="muted">{onlineUsers.length} of {session.users.length} {session.users.length === 1 ? 'person' : 'people'} online on {session.hub.name}</p>
        </div>
      </div>

      <div className="grid cols-3">
        <div className="card interactive" onClick={() => go('people')} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && go('people')}>
          <div className="eyebrow">Online now</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <span className="stat">{onlineUsers.length}</span>
            <span className="stack">
              {onlineUsers.slice(0, 6).map((u) => <Avatar key={u.id} user={u} size="sm" />)}
            </span>
          </div>
          <p className="faint" style={{ marginTop: 10, fontSize: 13 }}>See everyone in the office directory</p>
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
            <p className="faint" style={{ marginTop: 10, fontSize: 13 }}>{pendingCount ? 'Review new devices in Admin' : 'No one is waiting'}</p>
          </div>
        )}

        <div className="card">
          <div className="eyebrow">Office hub</div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <span className="hub-option" style={{ padding: 0, border: 0, background: 'none', width: 'auto' }}>
              <span className="ico"><Icon name="server" /></span>
            </span>
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
