// Pulse: what needs you right now, then the state of the office at a glance.
import { useEffect, useMemo, useState } from 'react';
import type { Session, Widget } from '@dex/core';
import type { AppState } from '../../shared/bridge.ts';
import type { Section } from '../App.tsx';
import { OfflineBanner } from '../App.tsx';
import { Avatar, Icon, useToast } from '../ui.tsx';
import { useChat } from '../chat/store.ts';
import { ConvTile, convTitle, shortTime } from '../chat/Switchboard.tsx';
import { plainPreview } from '../chat/format.tsx';
import { describeWhen, useDesk } from '../desk/store.ts';
import { DayLogCard } from '../work/WorkUi.tsx';
import { NextMeeting } from '../calendar/CalendarView.tsx';

function greeting(d = new Date()): string {
  const h = d.getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

export function Home({ state, session, pendingCount, go, open, onPerson }: {
  state: AppState; session: Session; pendingCount: number; go: (s: Section) => void; open: (id: string, kind: 'direct' | 'space') => void; onPerson: (id: string) => void;
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

  // reminders that are due, or due later today
  const reminders = useDesk((s) => s.reminders);
  const dueToday = useMemo(() => {
    const end = new Date(); end.setHours(23, 59, 59, 999);
    return [...reminders.values()].filter((r) => r.userId === session.me.id && !r.done && r.dueAt <= end.getTime()).sort((a, b) => a.dueAt - b.dueAt).slice(0, 5);
  }, [reminders, session.me.id]);

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
        <div className="label" style={{ marginBottom: 10 }}>Needs you{needsYou.length + dueToday.length ? ` · ${needsYou.length + dueToday.length}` : ''}</div>
        {dueToday.length > 0 && (
          <div className="list" style={{ marginBottom: needsYou.length ? 10 : 0 }}>
            {dueToday.map((r) => (
              <button key={r.id} className="list-row pulse-row" onClick={() => go('desk')}>
                <span className="pal-icon pulse-alarm"><Icon name="alarm" size={16} /></span>
                <span className="sb-main">
                  <span className="sb-title"><span className="sb-name">{r.text}</span></span>
                  <span className="sb-preview">{r.message ? plainPreview(r.message.body, users) : r.createdBy !== session.me.id ? `From ${users.get(r.createdBy)?.displayName ?? 'a colleague'}` : 'Reminder'}</span>
                </span>
                <span className="sb-meta"><span className={`chip${r.dueAt <= Date.now() ? ' warn' : ''}`}>{describeWhen(r.dueAt)}</span></span>
              </button>
            ))}
          </div>
        )}
        {needsYou.length === 0 && dueToday.length === 0 ? (
          <div className="empty pulse-empty"><Icon name="check" size={28} /><span>You're all caught up.</span></div>
        ) : needsYou.length === 0 ? null : (
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
        <DayLogCard users={session.users} meId={session.me.id} onPerson={onPerson} />
        <NextMeeting meId={session.me.id} onOpen={() => go('calendar')} />
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

        <Widgets live={live} />

        <div className="card">
          <div className="eyebrow">Office hub</div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <span className="pal-icon" style={{ width: 36, height: 36 }}><Icon name={state.via === 'remote' ? 'globe' : 'server'} /></span>
            <div style={{ minWidth: 0 }}>
              <h3>{session.hub.name}</h3>
              <div className="faint mono">{state.via === 'remote' ? 'Through the internet gateway' : `${state.hub?.host}:${state.hub?.port}`}</div>
            </div>
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span className={`chip ${live ? 'ok' : 'warn'}`}><Icon name={live ? 'lock' : 'wifi'} size={13} />{live ? (state.via === 'remote' ? 'Encrypted to the hub' : 'Encrypted connection') : 'Reconnecting'}</span>
            <span className="chip">{state.via === 'remote' ? 'Outside the office' : 'Works without internet'}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Cards that integrations keep up to date (build status, plotter queue...), from the Bot API. */
function Widgets({ live }: { live: boolean }) {
  const [list, setList] = useState<Widget[]>([]);
  useEffect(() => { if (live) void window.dex.request('widgets.list').then(setList).catch(() => {}); }, [live]);
  useEffect(() => window.dex.onHubEvent((name, data) => { if (name === 'widgets.updated') setList(data as Widget[]); }), []);
  return (
    <>
      {list.map((w) => (
        <div key={`${w.botId}-${w.key}`} className="card widget-card">
          <div className="eyebrow"><span>{w.title}</span><span className="widget-from mono">{w.botName.toUpperCase()}</span></div>
          <ul className="widget-lines">{w.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
          <div className="widget-foot">
            <span className="faint mono">UPDATED {new Date(w.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
            {w.url && <a href={w.url} target="_blank" rel="noreferrer noopener">Open</a>}
          </div>
        </div>
      ))}
    </>
  );
}
