// App frame: title bar, navigation rail, and the view for the current section.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '@dex/core';
import type { AppState } from '../shared/bridge.ts';
import logo from '../../build/icon.png';
import { Icon, ToastHost } from './ui.tsx';
import type { IconName } from './ui.tsx';
import { Onboarding } from './views/Onboarding.tsx';
import { Home } from './views/Home.tsx';
import { People } from './views/People.tsx';
import { Admin } from './views/Admin.tsx';
import { SettingsView } from './views/Settings.tsx';

export type Section = 'home' | 'people' | 'admin' | 'settings';

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
      const t = state.settings.theme === 'system' ? (media.matches ? 'dark' : 'light') : state.settings.theme;
      root.dataset.theme = t;
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

function Shell({ state, session }: { state: AppState; session: Session }) {
  const [section, setSection] = useState<Section>('home');
  const [query, setQuery] = useState('');
  const [focusUser, setFocusUser] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const isAdmin = session.me.role === 'owner' || session.me.role === 'admin';
  const live = state.phase === 'ready';

  // admins see a live count of devices waiting for approval
  useEffect(() => {
    if (!isAdmin || !live) return;
    const refresh = () => window.dex.request('admin.devices')
      .then((d) => setPendingCount(d.filter((x) => x.status === 'pending').length))
      .catch(() => {});
    void refresh();
    return window.dex.onHubEvent((name) => { if (name === 'admin.pending' || name === 'device.updated') void refresh(); });
  }, [isAdmin, live]);

  // keyboard: Ctrl+K search, Ctrl+1..4 sections
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() === 'k') { e.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); }
      const order: Section[] = ['home', 'people', ...(isAdmin ? ['admin' as const] : []), 'settings'];
      const n = Number(e.key);
      if (n >= 1 && n <= order.length) { e.preventDefault(); setSection(order[n - 1]); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isAdmin]);

  // dexconnect://people/<id>, dexconnect://admin, dexconnect://settings
  useEffect(() => window.dex.onDeepLink((url) => {
    const m = url.match(/^dexconnect:\/\/([a-z]+)\/?([\w-]*)/i);
    if (!m) return;
    const target = m[1].toLowerCase();
    if (target === 'people') { setSection('people'); if (m[2]) setFocusUser(m[2]); }
    else if (target === 'admin' && isAdmin) setSection('admin');
    else if (target === 'settings') setSection('settings');
    else setSection('home');
  }), [isAdmin]);

  const nav = useMemo(() => {
    const items: Array<{ id: Section; label: string; icon: IconName; badge?: number }> = [
      { id: 'home', label: 'Home', icon: 'home' },
      { id: 'people', label: 'People', icon: 'people' },
    ];
    if (isAdmin) items.push({ id: 'admin', label: 'Admin', icon: 'shield', badge: pendingCount });
    return items;
  }, [isAdmin, pendingCount]);

  const conn = state.phase === 'ready'
    ? { warn: false, text: session.hub.name }
    : state.phase === 'offline'
      ? { warn: true, text: `Reconnecting${state.retryInMs ? ` in ${Math.ceil(state.retryInMs / 1000)}s` : '…'}` }
      : { warn: true, text: 'Connecting…' };

  return (
    <div className="frame">
      <header className="titlebar">
        <div className="brand"><img src={logo} alt="" />Dexterity Connect</div>
        <label className="search">
          <Icon name="search" size={16} />
          <input
            ref={searchRef}
            placeholder="Search people"
            value={query}
            onChange={(e) => { setQuery(e.target.value); if (section !== 'people') setSection('people'); }}
            onKeyDown={(e) => { if (e.key === 'Escape') { setQuery(''); (e.target as HTMLInputElement).blur(); } }}
            aria-label="Search people"
          />
          <span className="kbd">Ctrl K</span>
        </label>
        <span className={`conn${conn.warn ? ' warn' : ''}`} title={state.hub ? `${state.hub.host}:${state.hub.port}` : ''}>
          <span className="pip" />{conn.text}
        </span>
      </header>
      <div className="body">
        <nav className="rail" aria-label="Sections">
          {nav.map((n) => (
            <button key={n.id} className="rail-item" aria-current={section === n.id ? 'page' : undefined} onClick={() => setSection(n.id)}>
              <Icon name={n.icon} size={22} />
              {n.label}
              {!!n.badge && <span className="badge">{n.badge}</span>}
            </button>
          ))}
          <span className="spacer" />
          <button className="rail-item" aria-current={section === 'settings' ? 'page' : undefined} onClick={() => setSection('settings')}>
            <Icon name="settings" size={22} />
            Settings
          </button>
        </nav>
        <main className="layer">
          {section === 'home' && <Home state={state} session={session} pendingCount={pendingCount} go={setSection} />}
          {section === 'people' && <People state={state} session={session} query={query} setQuery={setQuery} focusUser={focusUser} />}
          {section === 'admin' && isAdmin && <Admin state={state} session={session} />}
          {section === 'settings' && <SettingsView state={state} session={session} />}
        </main>
      </div>
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
