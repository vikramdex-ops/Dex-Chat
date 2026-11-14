// App frame in the "Drafting Table" design language (docs/DESIGN-LANGUAGE.md):
// title bar with brand, lens bar, command button and your own tile; content below;
// Preferences and the Control room slide in as sheets from the right.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '@dex/core';
import type { AppState } from '../shared/bridge.ts';
import logo from './app-icon.svg';
import { Avatar, Icon, ToastHost, presenceFor, setPresenceSource, useToast } from './ui.tsx';
import type { Availability } from '@dex/core';
import type { IconName } from './ui.tsx';
import { RequiredUpdate, UpdatePill, WhatsNew } from './UpdateUi.tsx';
import { CommandPalette } from './CommandPalette.tsx';
import { Onboarding } from './views/Onboarding.tsx';
import { Home } from './views/Home.tsx';
import { People } from './views/People.tsx';
import { Admin } from './views/Admin.tsx';
import { SettingsView } from './views/Settings.tsx';
import { ChatView } from './chat/ChatView.tsx';
import { addConversation, loadDrafts, refreshConversations, startChat, useChat } from './chat/store.ts';
import { convTitle } from './chat/Switchboard.tsx';

export type Lens = 'pulse' | 'direct' | 'spaces' | 'directory';
export type SheetName = 'preferences' | 'control' | null;
/** Kept for older call sites: a section is a lens or a sheet. */
export type Section = Lens | 'admin' | 'settings' | 'home' | 'people';

function useAppState(): AppState | null {
  const [state, setState] = useState<AppState | null>(null);
  useEffect(() => {
    let alive = true;
    void window.dex.getState().then((s) => { if (alive) setState(s); });
    const off = window.dex.onState(setState);
    return () => { alive = false; off(); };
  }, []);
  return state;
}

function useTheme(state: AppState | null): void {
  useEffect(() => {
    if (!state) return;
    const root = document.documentElement;
    root.dataset.platform = state.platform;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      root.dataset.theme = state.settings.theme === 'system' ? (media.matches ? 'dark' : 'light') : state.settings.theme;
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [state?.settings.theme, state?.platform]);
}

export function App() {
  const state = useAppState();
  useTheme(state);
  // Keep the last good session so the app stays usable (read-only) while the hub reconnects.
  const lastSession = useRef<Session | null>(null);
  if (state?.session) lastSession.current = state.session;
  const everReady = !!lastSession.current;

  if (!state) return null;
  const showShell = state.phase === 'ready' || (everReady && (state.phase === 'offline' || state.phase === 'connecting'));
  return (
    <ToastHost>
      {showShell && lastSession.current
        ? <Shell state={state} session={state.session ?? lastSession.current} />
        : <Onboarding state={state} />}
    </ToastHost>
  );
}

const AVAILABILITY: Array<{ id: Availability; label: string; hint: string }> = [
  { id: 'available', label: 'Available', hint: 'Notifications on' },
  { id: 'busy', label: 'Busy', hint: 'Shown as busy; notifications on' },
  { id: 'dnd', label: 'Do not disturb', hint: 'No notifications or sounds' },
  { id: 'invisible', label: 'Invisible', hint: 'Appear offline' },
];

const LENSES: Array<{ id: Lens; label: string; icon: IconName }> = [
  { id: 'pulse', label: 'Pulse', icon: 'pulse' },
  { id: 'direct', label: 'Direct', icon: 'chat' },
  { id: 'spaces', label: 'Spaces', icon: 'grid' },
  { id: 'directory', label: 'Directory', icon: 'people' },
];

/** Badges on lenses: amber count of mentions, teal dot for unread. */
function useLensBadges(): Record<Lens, { mentions: number; unread: boolean }> {
  const conversations = useChat((s) => s.conversations);
  const out: Record<Lens, { mentions: number; unread: boolean }> = {
    pulse: { mentions: 0, unread: false }, direct: { mentions: 0, unread: false }, spaces: { mentions: 0, unread: false }, directory: { mentions: 0, unread: false },
  };
  for (const c of conversations.values()) {
    const k: Lens = c.kind === 'space' ? 'spaces' : 'direct';
    // in Direct conversations every message is meant for you
    out[k].mentions += c.kind === 'direct' && !c.muted ? c.unread : c.mentions;
    if (c.unread && !c.muted) out[k].unread = true;
  }
  return out;
}

function LensBar({ lens, setLens }: { lens: Lens; setLens: (l: Lens) => void }) {
  const badges = useLensBadges();
  const refs = useRef(new Map<Lens, HTMLButtonElement>());
  const [bar, setBar] = useState({ left: 0, width: 0 });
  useLayoutEffect(() => {
    const el = refs.current.get(lens);
    if (el) setBar({ left: el.offsetLeft + 10, width: el.offsetWidth - 20 });
  }, [lens]);
  return (
    <nav className="lens-bar" aria-label="Sections">
      {LENSES.map((l, i) => (
        <button key={l.id} ref={(el) => { if (el) refs.current.set(l.id, el); }} className="lens"
          aria-current={lens === l.id ? 'page' : undefined} title={`${l.label} (Ctrl+${i + 1})`} onClick={() => setLens(l.id)}>
          <Icon name={l.icon} size={17} />{l.label}
          {badges[l.id].mentions > 0 ? <span className="badge">{badges[l.id].mentions}</span> : badges[l.id].unread ? <span className="sb-dot" /> : null}
        </button>
      ))}
      <span className="lens-ink" style={{ transform: `translateX(${bar.left}px)`, width: bar.width }} />
    </nav>
  );
}

function Shell({ state, session }: { state: AppState; session: Session }) {
  const [lens, setLens] = useState<Lens>('pulse');
  const [sheet, setSheet] = useState<SheetName>(null);
  const [palette, setPalette] = useState(false);
  const [menu, setMenu] = useState(false);
  const [query, setQuery] = useState('');
  const [focusUser, setFocusUser] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [openDirect, setOpenDirect] = useState<string | null>(null);
  const [openSpace, setOpenSpace] = useState<string | null>(null);
  const conversations = useChat((s) => s.conversations);
  const usersRef = useRef(session.users);
  usersRef.current = session.users;

  // messaging: load on sign-in, reload after reconnecting
  useEffect(() => { loadDrafts(); }, []);
  useEffect(() => {
    if (state.phase !== 'ready') return;
    void startChat(session.me.id, () => usersRef.current).then(() => refreshConversations());
  }, [state.phase, session.me.id]);

  const openConversation = (id: string, kind: 'direct' | 'space') => {
    if (kind === 'space') { setOpenSpace(id); setLens('spaces'); } else { setOpenDirect(id); setLens('direct'); }
    setSheet(null);
  };
  const messagePerson = async (userId: string) => {
    if (userId === session.me.id) return;
    try {
      const c = await window.dex.request('conv.create', { kind: 'direct', members: [userId] });
      addConversation(c);
      openConversation(c.id, 'direct');
    } catch { /* offline */ }
  };
  const isAdmin = session.me.role === 'owner' || session.me.role === 'admin';
  const live = state.phase === 'ready';
  const online = new Set(session.online);
  setPresenceSource(live ? session.online : [], session.away ?? [], session.users);
  const toast = useToast();
  const setAvailability = (availability: Availability) => {
    setMenu(false);
    void window.dex.request('me.update', { availability }).then(() => toast(`You're now shown as ${AVAILABILITY.find((a) => a.id === availability)!.label.toLowerCase()}`)).catch((e: Error) => toast(e.message, true));
  };

  // admins see a live count of devices waiting for approval
  useEffect(() => {
    if (!isAdmin || !live) return;
    const refresh = () => window.dex.request('admin.devices')
      .then((d) => setPendingCount(d.filter((x) => x.status === 'pending').length))
      .catch(() => {});
    void refresh();
    return window.dex.onHubEvent((name) => { if (name === 'admin.pending' || name === 'device.updated') void refresh(); });
  }, [isAdmin, live]);

  // keyboard: Ctrl+K command palette, Ctrl+1..n lenses, Ctrl+, preferences, Esc closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setMenu(false); if (!palette) setSheet(null); }
      if (!e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'k') { e.preventDefault(); setPalette(true); }
      else if (k === ',') { e.preventDefault(); setSheet('preferences'); }
      else {
        const n = Number(e.key);
        if (n >= 1 && n <= LENSES.length) { e.preventDefault(); setLens(LENSES[n - 1].id); setSheet(null); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [palette]);

  // dexconnect://people/<id>, dexconnect://admin, dexconnect://settings
  useEffect(() => window.dex.onDeepLink((url) => {
    const m = url.match(/^dexconnect:\/\/([a-z]+)\/?([\w-]*)/i);
    if (!m) return;
    const target = m[1].toLowerCase();
    if (target === 'people' || target === 'directory') { setLens('directory'); if (m[2]) setFocusUser(m[2]); }
    else if (target === 'admin' && isAdmin) setSheet('control');
    else if (target === 'settings') setSheet('preferences');
    else if (target === 'conversation' && m[2]) { const c = conversations.get(m[2]); if (c) openConversation(c.id, c.kind); }
    else setLens('pulse');
  }), [isAdmin, conversations]);

  const go = (s: Section) => {
    if (s === 'admin') setSheet('control');
    else if (s === 'settings') setSheet('preferences');
    else setLens(s === 'people' || s === 'directory' ? 'directory' : 'pulse');
  };

  const conn = state.phase === 'ready'
    ? { warn: false, text: session.hub.name }
    : state.phase === 'offline'
      ? { warn: true, text: `Reconnecting${state.retryInMs ? ` in ${Math.ceil(state.retryInMs / 1000)}s` : '…'}` }
      : { warn: true, text: 'Connecting…' };

  const users = useMemo(() => new Map(session.users.map((u) => [u.id, u] as const)), [session.users]);
  const commands = useMemo(() => [
    ...[...conversations.values()].filter((c) => c.joined).map((c) => ({
      id: `conv-${c.id}`, label: convTitle(c, users, session.me.id), icon: (c.kind === 'space' ? 'grid' : 'chat') as IconName,
      hint: c.kind === 'space' ? 'Space' : 'Direct', run: () => openConversation(c.id, c.kind),
    })),
    { id: 'new-space', label: 'Create a Space', icon: 'plus' as IconName, run: () => setLens('spaces') },
    { id: 'go-pulse', label: 'Go to Pulse', icon: 'pulse' as IconName, run: () => setLens('pulse') },
    { id: 'go-directory', label: 'Go to Directory', icon: 'people' as IconName, run: () => setLens('directory') },
    { id: 'prefs', label: 'Open Preferences', icon: 'settings' as IconName, run: () => setSheet('preferences') },
    ...(isAdmin ? [{ id: 'control', label: 'Open Control room', icon: 'shield' as IconName, run: () => setSheet('control') }] : []),
    { id: 'updates', label: 'Check for updates', icon: 'refresh' as IconName, run: () => void window.dex.checkForUpdates() },
  ], [isAdmin, conversations, users, session.me.id]);

  return (
    <div className="frame">
      <header className="titlebar">
        <div className="brand"><img src={logo} alt="" /><span>Dexterity Connect</span></div>
        <div className="titlebar-mid">
          <LensBar lens={lens} setLens={(l) => { setLens(l); setSheet(null); }} />
          <button className="cmd-btn" onClick={() => setPalette(true)} aria-label="Search and commands">
            <Icon name="search" size={15} /><span>Search or jump to</span><span className="kbd">Ctrl K</span>
          </button>
        </div>
        <div className="titlebar-right">
          <UpdatePill state={state} />
          <span className={`conn${conn.warn ? ' warn' : ''}`} title={state.hub ? `${state.hub.host}:${state.hub.port}` : ''}>
            <span className="pip" /><span className="conn-text">{conn.text}</span>
          </span>
          <div className="me-wrap">
            <button className="me-btn" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)} title="You">
              <Avatar user={session.me} presence={live ? (session.me.availability === 'invisible' ? 'off' : presenceFor(session.me.id)) : 'off'} size="sm" />
              {isAdmin && pendingCount > 0 && <span className="badge me-badge">{pendingCount}</span>}
            </button>
            {menu && (
              <div className="menu" role="menu" onMouseLeave={() => setMenu(false)}>
                <div className="menu-head">
                  <Avatar user={session.me} presence={live ? (session.me.availability === 'invisible' ? 'off' : presenceFor(session.me.id)) : 'off'} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{session.me.displayName}</div>
                    <div className="faint" style={{ fontSize: 12 }}>{session.me.statusText ?? session.me.title ?? session.me.account}</div>
                  </div>
                </div>
                <div className="menu-label label">Show me as</div>
                {AVAILABILITY.map((a) => (
                  <button key={a.id} role="menuitemradio" aria-checked={session.me.availability === a.id} className="avail" disabled={!live} onClick={() => setAvailability(a.id)}>
                    <span className={`avail-ring ${a.id}`} />
                    <span className="sb-main"><span>{a.label}</span><span className="sb-preview">{a.hint}</span></span>
                    {session.me.availability === a.id && <Icon name="check" size={15} />}
                  </button>
                ))}
                <div className="menu-sep" />
                <button role="menuitem" onClick={() => { setSheet('preferences'); setMenu(false); }}><Icon name="settings" size={16} />Preferences<span className="kbd">Ctrl ,</span></button>
                {isAdmin && (
                  <button role="menuitem" onClick={() => { setSheet('control'); setMenu(false); }}>
                    <Icon name="shield" size={16} />Control room{pendingCount > 0 && <span className="badge">{pendingCount}</span>}
                  </button>
                )}
                <button role="menuitem" onClick={() => { void window.dex.checkForUpdates(); setSheet('preferences'); setMenu(false); }}><Icon name="refresh" size={16} />Check for updates</button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className={`stage${lens === 'direct' || lens === 'spaces' ? ' flush' : ''}`}>
        {state.update.justUpdated && <div className="view" style={{ paddingBottom: 0 }}><WhatsNew state={state} /></div>}
        {lens === 'pulse' && <Home state={state} session={session} pendingCount={pendingCount} go={go} open={openConversation} />}
        {lens === 'direct' && <ChatView kind="direct" state={state} session={session} openId={openDirect} setOpenId={setOpenDirect} />}
        {lens === 'spaces' && <ChatView kind="space" state={state} session={session} openId={openSpace} setOpenId={setOpenSpace} />}
        {lens === 'directory' && <People state={state} session={session} query={query} setQuery={setQuery} focusUser={focusUser} onMessage={(id) => void messagePerson(id)} />}
      </main>

      <nav className="lens-dock" aria-label="Sections">
        {LENSES.map((l) => (
          <button key={l.id} className="lens" aria-current={lens === l.id ? 'page' : undefined} onClick={() => { setLens(l.id); setSheet(null); }}>
            <Icon name={l.icon} size={20} />{l.label}
          </button>
        ))}
        <button className="lens" aria-current={sheet === 'preferences' ? 'page' : undefined} onClick={() => setSheet('preferences')}>
          <Icon name="settings" size={20} />Preferences
        </button>
      </nav>

      {sheet && (
        <div className="sheet-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) setSheet(null); }}>
          <aside className={`sheet${sheet === 'control' ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={sheet === 'control' ? 'Control room' : 'Preferences'}>
            <button className="sheet-close" onClick={() => setSheet(null)} aria-label="Close" title="Close (Esc)"><Icon name="x" size={18} /></button>
            <div className="sheet-body">
              {sheet === 'preferences' && <SettingsView state={state} session={session} />}
              {sheet === 'control' && isAdmin && <Admin state={state} session={session} />}
            </div>
          </aside>
        </div>
      )}

      {palette && (
        <CommandPalette
          users={session.users}
          online={online}
          commands={commands}
          onClose={() => setPalette(false)}
          onPerson={(id) => { if (id === session.me.id) { setLens('directory'); setFocusUser(id); } else void messagePerson(id); }}
          convName={(id) => { const c = conversations.get(id); return c ? convTitle(c, users, session.me.id) : ''; }}
          onMessage={(m) => {
            const c = conversations.get(m.convId);
            if (!c) return;
            openConversation(c.id, c.kind);
            setTimeout(() => window.dispatchEvent(new CustomEvent('dex-jump', { detail: { convId: m.convId, messageId: m.id, parentId: m.parentId } })), 120);
          }}
        />
      )}
      <RequiredUpdate state={state} />
    </div>
  );
}

export function OfflineBanner({ state }: { state: AppState }) {
  if (state.phase === 'ready') return null;
  return (
    <div className="offline-banner" role="status">
      <Icon name="wifi" />
      <span>The office hub is unreachable. You can keep reading; changes will be possible again once it reconnects.</span>
    </div>
  );
}
