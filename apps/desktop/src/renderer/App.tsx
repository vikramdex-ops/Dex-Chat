// App frame in the "Drafting Table" design language (docs/DESIGN-LANGUAGE.md):
// title bar with brand, lens bar, command button and your own tile; content below;
// Preferences and the Control room slide in as sheets from the right.
import { Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '@dex/core';
import type { AppState } from '../shared/bridge.ts';
import logo from './app-icon.svg';
import { Avatar, Dialog, Icon, ToastHost, presenceFor, setPresenceSource, useToast } from './ui.tsx';
import type { Availability } from '@dex/core';
import type { IconName } from './ui.tsx';
import { RequiredUpdate, UpdatePill, WhatsNew } from './UpdateUi.tsx';
import { CommandPalette } from './CommandPalette.tsx';
import { Onboarding } from './views/Onboarding.tsx';
import { Home } from './views/Home.tsx';
import { People } from './views/People.tsx';
import { SettingsView } from './views/Settings.tsx';
import { ChatView } from './chat/ChatView.tsx';
import { addConversation, chatState, loadDrafts, refreshConversations, startChat, useChat } from './chat/store.ts';
import { convTitle } from './chat/Switchboard.tsx';
import { IncomingCall, RoomStage } from './rooms/RoomUi.tsx';
import { Desk, ReminderCards } from './views/Desk.tsx';
import { refreshDesk, startDesk, useDesk } from './desk/store.ts';
import { startOrg } from './org/store.ts';
import { startWork } from './work/store.ts';
import { WorkClock } from './work/WorkUi.tsx';
import { startCalendar } from './calendar/store.ts';
import { ShareDialog, parseShare } from './views/ShareDialog.tsx';
import type { ShareRequest } from './views/ShareDialog.tsx';
import { CalendarView, MeetingCards } from './calendar/CalendarView.tsx';
import { setSelfUser, startCalls } from './rooms/engine.ts';

// the Control room is used by a few people now and then: load it when opened
const Admin = lazy(() => import('./views/Admin.tsx').then((m) => ({ default: m.Admin })));

export type Lens = 'pulse' | 'direct' | 'spaces' | 'desk' | 'calendar' | 'directory';
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
  { id: 'desk', label: 'Desk', icon: 'desk' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar' },
  { id: 'directory', label: 'Directory', icon: 'people' },
];

/** Badges on lenses: amber count of mentions, teal dot for unread. */
function useLensBadges(): Record<Lens, { mentions: number; unread: boolean }> {
  const conversations = useChat((s) => s.conversations);
  const due = useDesk((s) => s.ringing.length);
  const out: Record<Lens, { mentions: number; unread: boolean }> = {
    pulse: { mentions: 0, unread: false }, direct: { mentions: 0, unread: false }, spaces: { mentions: 0, unread: false },
    desk: { mentions: due, unread: false }, calendar: { mentions: 0, unread: false }, directory: { mentions: 0, unread: false },
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
  const [share, setShare] = useState<ShareRequest | null>(null);
  const conversations = useChat((s) => s.conversations);
  const usersRef = useRef(session.users);
  usersRef.current = session.users;

  // messaging: load on sign-in, reload after reconnecting
  useEffect(() => { loadDrafts(); }, []);
  useEffect(() => {
    if (state.phase !== 'ready') return;
    void startChat(session.me.id, () => usersRef.current).then(() => refreshConversations());
    void startDesk(session.me.id, () => usersRef.current).then(() => refreshDesk());
    void startOrg();
    void startWork();
    void startCalendar(session.me.id, () => usersRef.current);
    setSelfUser(session.me.id);
    startCalls(session.deviceId, (t, b) => window.dex.notify(t, b), (id) => usersRef.current.find((u) => u.id === id)?.displayName ?? 'Someone');
  }, [state.phase, session.me.id, session.deviceId]);

  const openConversation = (id: string, kind: 'direct' | 'space') => {
    if (kind === 'space') { setOpenSpace(id); setLens('spaces'); } else { setOpenDirect(id); setLens('direct'); }
    setSheet(null);
  };
  /** Open a conversation and scroll to (or open the side-track of) a message. */
  const jump = (convId: string, messageId?: string, parentId?: string | null) => {
    const c = conversations.get(convId);
    if (!c) return;
    openConversation(c.id, c.kind);
    if (messageId) setTimeout(() => window.dispatchEvent(new CustomEvent('dex-jump', { detail: { convId, messageId, parentId: parentId ?? null } })), 120);
  };
  // other parts of the app open a conversation by id (Reply privately, links)
  useEffect(() => {
    const onOpen = (e: Event) => { const c = chatState().conversations.get(String((e as CustomEvent).detail)); if (c) openConversation(c.id, c.kind); };
    window.addEventListener('dex-open', onOpen);
    return () => window.removeEventListener('dex-open', onOpen);
  }, []);
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
  setPresenceSource(live ? session.online : [], session.away ?? [], session.users, session.inRoom ?? []);
  const toast = useToast();
  const setAvailability = (availability: Availability, until: number | null = null) => {
    void window.dex.request('me.update', { availability, until }).then(() => toast(`You're now shown as ${AVAILABILITY.find((a) => a.id === availability)!.label.toLowerCase()}${until ? ` until ${new Date(until).toLocaleTimeString([], { weekday: until - Date.now() > 20 * 3600_000 ? 'short' : undefined, hour: 'numeric', minute: '2-digit' })}` : ''}`)).catch((e: Error) => toast(e.message, true));
  };
  const [ooo, setOoo] = useState(false);

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
    const shareReq = parseShare(url);
    if (shareReq) { setShare(shareReq); return; }
    const m = url.match(/^dexconnect:\/\/([a-z]+)\/?([\w-]*)\/?([\w-]*)/i);
    if (!m) return;
    const target = m[1].toLowerCase();
    if (target === 'message' && m[2]) {
      if (conversations.has(m[2])) jump(m[2], m[3] || undefined);
      else window.dispatchEvent(new CustomEvent('dex-toast', { detail: 'That message is in a conversation you are not part of' }));
      return;
    }
    if (target === 'people' || target === 'directory') { setLens('directory'); if (m[2]) setFocusUser(m[2]); }
    else if (target === 'admin' && isAdmin) setSheet('control');
    else if (target === 'settings') setSheet('preferences');
    else if (target === 'conversation' && m[2]) { const c = conversations.get(m[2]); if (c) openConversation(c.id, c.kind); }
    else if (target === 'desk') { setLens('desk'); setSheet(null); }
    else if (target === 'calendar') { setLens('calendar'); setSheet(null); }
    else setLens('pulse');
  }), [isAdmin, conversations]);

  const go = (s: Section) => {
    if (s === 'admin') setSheet('control');
    else if (s === 'settings') setSheet('preferences');
    else setLens(s === 'people' || s === 'directory' ? 'directory' : s === 'desk' || s === 'calendar' ? s : 'pulse');
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
    { id: 'go-desk', label: 'Go to Desk: reminders, saved, scheduled', icon: 'desk' as IconName, run: () => setLens('desk') },
    { id: 'go-calendar', label: 'Go to Calendar', icon: 'calendar' as IconName, run: () => setLens('calendar') },
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
          <WorkClock meId={session.me.id} live={live} role={session.me.role} />
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
                  <button key={a.id} role="menuitemradio" aria-checked={session.me.availability === a.id} className="avail" disabled={!live} onClick={() => { setMenu(a.id !== 'available'); setAvailability(a.id); }}>
                    <span className={`avail-ring ${a.id}`} />
                    <span className="sb-main"><span>{a.label}</span><span className="sb-preview">{session.me.availability === a.id && session.me.availabilityUntil ? `Until ${new Date(session.me.availabilityUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : a.hint}</span></span>
                    {session.me.availability === a.id && <Icon name="check" size={15} />}
                  </button>
                ))}
                {session.me.availability !== 'available' && (
                  <div className="avail-for">
                    <span className="faint">For</span>
                    {([[3600_000, '1 hour'], [2 * 3600_000, '2 hours'], [(() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d.getTime() - Date.now(); })(), 'Until tomorrow'], [0, 'Until I change it']] as Array<[number, string]>).map(([ms, label]) => (
                      <button key={label} className="when-chip" onClick={() => { setMenu(false); setAvailability(session.me.availability, ms ? Date.now() + ms : null); }}>{label}</button>
                    ))}
                  </div>
                )}
                <button role="menuitem" disabled={!live} onClick={() => { setMenu(false); setOoo(true); }}><Icon name="calendar" size={16} />{session.me.ooo ? `Out of office until ${new Date(session.me.ooo.until).toLocaleDateString([], { day: 'numeric', month: 'short' })}` : 'Out of office…'}</button>
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
        {lens === 'pulse' && <Home state={state} session={session} pendingCount={pendingCount} go={go} open={openConversation} onPerson={(id) => { setLens('directory'); setFocusUser(id); }} />}
        {lens === 'direct' && <ChatView kind="direct" state={state} session={session} openId={openDirect} setOpenId={setOpenDirect} />}
        {lens === 'spaces' && <ChatView kind="space" state={state} session={session} openId={openSpace} setOpenId={setOpenSpace} />}
        {lens === 'desk' && <Desk session={session} jump={jump} />}
        {lens === 'calendar' && <CalendarView session={session} openConv={(id) => jump(id)} />}
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
              {sheet === 'control' && isAdmin && <Suspense fallback={<div className="tl-more"><span className="spinner" /></div>}><Admin state={state} session={session} /></Suspense>}
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
          onMessage={(m) => jump(m.convId, m.id, m.parentId)}
        />
      )}
      <RoomStage users={users} meDevice={session.deviceId} meId={session.me.id}
        title={(id) => { const c = conversations.get(id); return c ? convTitle(c, users, session.me.id) : 'Room'; }}
        onOpenConversation={(id) => { const c = conversations.get(id); if (c) openConversation(c.id, c.kind); }} />
      <IncomingCall users={users} title={(id) => { const c = conversations.get(id); return c ? convTitle(c, users, session.me.id) : ''; }} />
      {ooo && <OutOfOffice session={session} onClose={() => setOoo(false)} />}
      <ReminderCards users={users} meId={session.me.id} jump={jump} />
      <MeetingCards users={users} meId={session.me.id} />
      {share && <ShareDialog req={share} session={session} onDone={(convId) => { setShare(null); if (convId) { const c = conversations.get(convId); if (c) openConversation(c.id, c.kind); } }} />}
      <RequiredUpdate state={state} />
    </div>
  );
}

function OutOfOffice({ session, onClose }: { session: Session; onClose: () => void }) {
  const toast = useToast();
  const cur = session.me.ooo;
  const [until, setUntil] = useState(() => new Date(cur?.until ?? Date.now() + 7 * 86400_000).toISOString().slice(0, 10));
  const [message, setMessage] = useState(cur?.message ?? '');
  const [delegate, setDelegate] = useState(cur?.delegateId ?? '');
  const save = (off = false) => void window.dex.request('me.update', { ooo: off ? null : { until: new Date(`${until}T23:59:00`).getTime(), message: message || null, delegateId: delegate || null } })
    .then(() => { toast(off ? 'Welcome back' : 'Out of office is on'); onClose(); }).catch((e: Error) => toast(e.message, true));
  return (
    <Dialog title="Out of office" onClose={onClose} narrow>
      <p className="muted" style={{ margin: 0 }}>Colleagues see this on your profile and when they message you directly.</p>
      <div className="field"><label htmlFor="ooo-until">Back on</label><input id="ooo-until" className="input" type="date" min={new Date().toISOString().slice(0, 10)} value={until} onChange={(e) => setUntil(e.target.value)} /></div>
      <div className="field"><label htmlFor="ooo-msg">Note</label><input id="ooo-msg" className="input" maxLength={300} placeholder="At the Jamnagar site, checking messages in the evening" value={message} onChange={(e) => setMessage(e.target.value)} /></div>
      <div className="field"><label htmlFor="ooo-del">For anything urgent, contact</label>
        <select id="ooo-del" className="input" value={delegate} onChange={(e) => setDelegate(e.target.value)}>
          <option value="">No one</option>
          {session.users.filter((u) => u.role !== 'bot' && u.id !== session.me.id).map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
        </select></div>
      <div className="dialog-actions">
        <span />
        {cur && <button className="btn ghost" onClick={() => save(true)}>I'm back</button>}
        <button className="btn primary" onClick={() => save()}>{cur ? 'Update' : 'Turn on'}</button>
      </div>
    </Dialog>
  );
}

export function OfflineBanner({ state }: { state: AppState }) {
  if (state.phase === 'ready') return null;
  return (
    <div className="offline-banner" role="status">
      <Icon name="wifi" />
      <span>{state.p2p?.active
        ? `The office hub is unreachable. Direct messages still reach colleagues on this network${state.p2p.queued ? ` (${state.p2p.queued} waiting to be added to the history)` : ''}; everything else works again once it reconnects.`
        : 'The office hub is unreachable. You can keep reading; changes will be possible again once it reconnects.'}</span>
    </div>
  );
}
