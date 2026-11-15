// App frame in the "Drafting Table" design language (docs/DESIGN-LANGUAGE.md):
// title bar with brand, the Lens bar (ending in the GO TO field) and your own tile; content below;
// Preferences and the Control room slide in as sheets from the right. Phones get a bottom lens strip.
import { setAlertPrefs } from './alerts.ts';
import { Pane } from './chat/Pane.tsx';
import { setTimeFormat } from './time.ts';
import { startPolicy } from './policy.ts';
import { startEmoji } from './emoji.tsx';
import { Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Session } from '@dex/core';
import type { AppState, MessageSound } from '../shared/bridge.ts';
import logo from './app-icon.svg';
import { Avatar, Dialog, Icon, ToastHost, menuKeys, presenceFor, setPresenceSource, trapTab, useDialogFocus, useToast } from './ui.tsx';
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
import type { Chip } from './chat/Switchboard.tsx';
import { closePane, focusPane, openInPane, panesNow } from './chat/panes.ts';
import { CLOSE, LUNCH, endOfToday, hm, todayAt } from './chat/officeTime.ts';
import { IncomingCall, RoomChip, RoomStage, RecordingReady } from './rooms/RoomUi.tsx';
import { Desk, ReminderCards } from './views/Desk.tsx';
import { refreshDesk, startDesk, useDesk } from './desk/store.ts';
import { startOrg } from './org/store.ts';
import { startWork } from './work/store.ts';
import { DayArc, DayMenu } from './work/WorkUi.tsx';
import { startCalendar } from './calendar/store.ts';
import { ShareDialog, parseShare } from './views/ShareDialog.tsx';
import { ShortcutsSheet } from './views/Shortcuts.tsx';
import { MdPreview } from './chat/MdPreview.tsx';
import { LinkedFiles, openFileLink } from './chat/linkcards.tsx';
import { requestOpen } from './chat/deeplinks.ts';
import { SearchView, type SearchInit } from './views/Search.tsx';
import type { ShareRequest } from './views/ShareDialog.tsx';
import { CalendarView, MeetingCards } from './calendar/CalendarView.tsx';
import { setSelfUser, startCalls } from './rooms/engine.ts';
import { startMeetLive } from './meet/live.ts';
import { joinAny, openWebinar, startWebinars } from './meet/webinar/store.ts';
import { WebinarSeat } from './meet/webinar/Seat.tsx';
import { openRecording } from './meet/shelf.ts';
import { parseMeetingId } from '@dex/core';
import { AddToolHost } from './bots/AddTool.tsx';
import { AssistHost, HelpMenuItems, helpCommands, openHelp } from './help/AssistHost.tsx';
import { timeOpts } from './time.ts';
import { tr } from './i18n/index.ts';
import { G_KEYS, keyFor, keyHint, keyText, lensFallback, pressed, typingIn, useKeys } from './chat/keys.ts';

// the Control room is used by a few people now and then: load it when opened
const Admin = lazy(() => import('./views/Admin.tsx').then((m) => ({ default: m.Admin })));
// the Meet lens loads when it is first opened
const MeetLens = lazy(() => import('./meet/MeetLens.tsx'));
const AutomationsSheet = lazy(() => import('./flows/FlowsPanel.tsx').then((m) => ({ default: m.AutomationsSheet })));

export type Lens = 'pulse' | 'direct' | 'spaces' | 'desk' | 'calendar' | 'directory' | 'meet';
export type SheetName = 'preferences' | 'control' | 'search' | null;
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
  useEffect(() => {
    if (!state) return;
    const root = document.documentElement;
    root.dataset.density = state.settings.density ?? 'comfortable';
    // desktop zooms the window from the main process; the phone's WebView zooms here
    if (state.platform === 'android') root.style.zoom = String((state.settings.textSize ?? 100) / 100);
    setAlertPrefs(state.settings, state.platform);
    setTimeFormat(state.settings.timeFormat);
  }, [state?.settings, state?.platform]);
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

/** How you show to others. The stored values stay available / busy / dnd / invisible. */
const AVAILABILITY: Array<{ id: Availability; label: string; hint: string }> = [
  { id: 'available', label: 'At my desk', hint: 'Notifications on' },
  { id: 'busy', label: 'Heads-down', hint: 'Focused; notifications still on' },
  { id: 'dnd', label: 'No interruptions', hint: 'No notifications or sounds' },
  { id: 'invisible', label: 'Unlisted', hint: 'You appear offline' },
];

/** How long a status lasts: till lunch, till the office closes, the rest of today, or until changed. */
function statusDurations(now = new Date()): Array<{ label: string; until: number | null }> {
  const out: Array<{ label: string; until: number | null }> = [];
  const lunch = todayAt(LUNCH[0], LUNCH[1], now);
  const close = todayAt(CLOSE[0], CLOSE[1], now);
  if (now.getTime() < lunch - 10 * 60_000) out.push({ label: `Till lunch · ${hm(lunch)}`, until: lunch });
  if (now.getTime() < close - 10 * 60_000) out.push({ label: `Till ${hm(close)}`, until: close });
  out.push({ label: 'Rest of today', until: endOfToday(now) }, { label: 'Until I change it', until: null });
  return out;
}

const LENSES: Array<{ id: Lens; label: string; icon: IconName }> = [
  { id: 'pulse', label: 'Pulse', icon: 'pulse' },
  { id: 'direct', label: 'Direct', icon: 'direct' },
  { id: 'spaces', label: 'Spaces', icon: 'grid' },
  { id: 'desk', label: 'Desk', icon: 'desk' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar' },
  { id: 'directory', label: 'Directory', icon: 'card' },
  { id: 'meet', label: 'Meet', icon: 'video' },
];

/** The phone's lens strip: at most five, with Direct and Spaces sharing one Switchboard. */
const PHONE_LENSES: Array<{ id: Lens; label: string; icon: IconName }> = [
  { id: 'pulse', label: 'Pulse', icon: 'pulse' },
  { id: 'direct', label: 'Switchboard', icon: 'direct' },
  { id: 'desk', label: 'Desk', icon: 'desk' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar' },
  { id: 'directory', label: 'Directory', icon: 'card' },
];
const isTalk = (l: Lens) => l === 'direct' || l === 'spaces';

/** Badges on lenses: amber count of mentions, teal dot for unread. */
function useLensBadges(): Record<Lens, { mentions: number; unread: boolean }> {
  const conversations = useChat((s) => s.conversations);
  const due = useDesk((s) => s.ringing.length);
  const out: Record<Lens, { mentions: number; unread: boolean }> = {
    pulse: { mentions: 0, unread: false }, direct: { mentions: 0, unread: false }, spaces: { mentions: 0, unread: false },
    desk: { mentions: due, unread: false }, calendar: { mentions: 0, unread: false }, directory: { mentions: 0, unread: false }, meet: { mentions: 0, unread: false },
  };
  for (const c of conversations.values()) {
    const k: Lens = c.kind === 'space' ? 'spaces' : 'direct';
    // in Direct conversations every message is meant for you
    out[k].mentions += c.kind === 'direct' && !c.muted ? c.unread : c.mentions;
    if (c.unread && !c.muted) out[k].unread = true;
  }
  return out;
}

/** The teal underline that slides to the current lens. */
function useInk(current: string): { refs: React.RefObject<Map<string, HTMLButtonElement>>; ink: { left: number; width: number } } {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const [ink, setInk] = useState({ left: 0, width: 0 });
  useLayoutEffect(() => {
    const place = () => { const el = refs.current.get(current); if (el) setInk({ left: el.offsetLeft + 10, width: el.offsetWidth - 20 }); };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [current]);
  return { refs, ink };
}

function LensBar({ lens, setLens, onGoTo }: { lens: Lens; setLens: (l: Lens) => void; onGoTo: () => void }) {
  const badges = useLensBadges();
  useKeys();
  const { refs, ink } = useInk(lens);
  return (
    <nav className="lens-bar" aria-label="Sections">
      {LENSES.map((l, i) => (
        <button key={l.id} ref={(el) => { if (el) refs.current.set(l.id, el); }} className="lens"
          aria-current={lens === l.id ? 'page' : undefined} title={keyFor(`lens:${l.id}`, lensFallback(i)) ? `${l.label} (${keyText(keyFor(`lens:${l.id}`, lensFallback(i)))})` : l.label} onClick={() => setLens(l.id)}>
          <Icon name={l.icon} size={17} /><span className="lens-label">{l.label}</span>
          {badges[l.id].mentions > 0 ? <span className="badge">{badges[l.id].mentions}</span> : badges[l.id].unread ? <span className="lens-tick" aria-label="unread" /> : null}
        </button>
      ))}
      <span className="lens-ink" style={{ transform: `translateX(${ink.left}px)`, width: ink.width }} />
      <button className="goto" onClick={onGoTo} aria-label={`Go to a person, conversation or command${keyFor('goto') ? ` (${keyText(keyFor('goto'))})` : ''}`} title="Go to a person, conversation or command">
        <span className="goto-label">Go to</span><span className="goto-caret" aria-hidden="true">▸</span>{keyFor('goto') && <span className="goto-hint">{keyHint(keyFor('goto'))}</span>}
      </button>
    </nav>
  );
}

/** Phones: a bottom strip of at most five lenses with the same sliding teal underline. */
function LensStrip({ lens, setLens, onTalkAgain }: { lens: Lens; setLens: (l: Lens) => void; onTalkAgain: () => void }) {
  const badges = useLensBadges();
  const cur = isTalk(lens) ? 'direct' : lens;
  const { refs, ink } = useInk(cur);
  return (
    <nav className="lens-dock" aria-label="Sections">
      {PHONE_LENSES.map((l) => {
        const b = l.id === 'direct' ? { mentions: badges.direct.mentions + badges.spaces.mentions, unread: badges.direct.unread || badges.spaces.unread } : badges[l.id];
        return (
          <button key={l.id} ref={(el) => { if (el) refs.current.set(l.id, el); }} className="lens" aria-current={cur === l.id ? 'page' : undefined}
            onClick={() => { if (l.id === 'direct' && isTalk(lens)) onTalkAgain(); else setLens(l.id); }}>
            <span className="lens-ico"><Icon name={l.icon} size={20} />{b.mentions > 0 ? <span className="badge">{b.mentions}</span> : b.unread ? <span className="lens-tick" /> : null}</span>
            {l.label}
          </button>
        );
      })}
      <span className="lens-ink" style={{ transform: `translateX(${ink.left}px)`, width: ink.width }} />
    </nav>
  );
}

/**
 * Choosing the Direct or Spaces lens on a PC shows a conversation of that kind: the Pane that
 * already has one gets focus, otherwise the latest one opens in the focused Pane.
 */
function showKind(kind: 'direct' | 'space'): void {
  if (!window.matchMedia('(min-width: 721px)').matches) return;
  const p = panesNow();
  const convs = chatState().conversations;
  if (p.ids.length && convs.get(p.ids[p.focus])?.kind === kind) return;
  const at = p.ids.findIndex((id) => convs.get(id)?.kind === kind);
  if (at >= 0) { focusPane(at); return; }
  const latest = [...convs.values()].filter((c) => c.joined && c.kind === kind && !c.archived)
    .sort((a, b) => (b.lastMessage?.createdAt ?? b.createdAt) - (a.lastMessage?.createdAt ?? a.createdAt))[0];
  if (latest) openInPane(latest.id);
}

function Shell({ state, session }: { state: AppState; session: Session }) {
  const [lens, setLensRaw] = useState<Lens>('pulse');
  // the Switchboard's lens chip follows the Direct and Spaces lenses, and they follow it
  const [chip, setChipRaw] = useState<Chip>('all');
  const setLens = (l: Lens) => {
    setLensRaw(l);
    if (l === 'direct') { setChipRaw('people'); showKind('direct'); }
    else if (l === 'spaces') { setChipRaw((c) => (c === 'projects' ? c : 'spaces')); showKind('space'); }
  };
  const setChip = (c: Chip) => {
    setChipRaw(c);
    if (c === 'people') setLensRaw('direct');
    else if (c === 'spaces' || c === 'projects') setLensRaw('spaces');
  };
  const [sheet, setSheet] = useState<SheetName>(null);
  const [palette, setPalette] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [searchInit, setSearchInit] = useState<SearchInit>({});
  const openSearch = (init: SearchInit) => { setSearchInit(init); setSheet('search'); setPalette(false); };
  const [menu, setMenu] = useState(false);
  const meBtn = useRef<HTMLButtonElement>(null);
  const meMenu = useRef<HTMLDivElement>(null);
  // your own menu: the first item takes the keyboard; a click outside closes it and focus returns to your tile
  useEffect(() => {
    if (!menu) return;
    meMenu.current?.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
    const down = (e: MouseEvent) => { if (!meMenu.current?.contains(e.target as Node) && !meBtn.current?.contains(e.target as Node)) setMenu(false); };
    window.addEventListener('mousedown', down);
    const menuEl = meMenu.current;
    return () => { window.removeEventListener('mousedown', down); if (!document.activeElement || document.activeElement === document.body || menuEl?.contains(document.activeElement)) meBtn.current?.focus({ preventScroll: true }); };
  }, [menu]);
  const [query, setQuery] = useState('');
  const [focusUser, setFocusUser] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
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
    startPolicy();
    startEmoji();
    void startWork(session.me.id);
    void startCalendar(session.me.id, () => usersRef.current);
    setSelfUser(session.me.id);
    startCalls(session.deviceId, (t, b) => window.dex.notify(tr(t), tr(b)), (id) => usersRef.current.find((u) => u.id === id)?.displayName ?? 'Someone');
    startMeetLive((id) => usersRef.current.find((u) => u.id === id)?.displayName ?? 'Someone');
    startWebinars();
  }, [state.phase, session.me.id, session.deviceId]);

  const openConversation = (id: string, kind: 'direct' | 'space') => {
    openInPane(id);
    // stay on the Switchboard's current chip when it already shows this conversation
    if (!isTalk(lens) || (chip !== 'all' && (kind === 'space') !== (chip !== 'people'))) setLens(kind === 'space' ? 'spaces' : 'direct');
    setSheet(null);
  };
  /** Open a conversation and scroll to (or open the side-track of) a message. */
  const jump = (convId: string, messageId?: string, parentId?: string | null) => {
    const c = conversations.get(convId);
    if (!c) return;
    openConversation(c.id, c.kind);
    if (messageId) setTimeout(() => window.dispatchEvent(new CustomEvent('dex-jump', { detail: { convId, messageId, parentId: parentId ?? null } })), 120);
  };
  // a recording kept on the hub (or another meeting surface) asks for the Meet lens
  useEffect(() => {
    const on = (e: Event) => { if ((e as CustomEvent).detail === 'meet') { setLens('meet'); setSheet(null); } };
    window.addEventListener('dex-open-lens', on);
    return () => window.removeEventListener('dex-open-lens', on);
  });
  // the Control room's Reports opens the reported message
  useEffect(() => {
    const on = (e: Event) => { const d = (e as CustomEvent).detail as { convId: string; messageId: string; parentId?: string | null }; if (chatState().conversations.has(d.convId)) jump(d.convId, d.messageId, d.parentId); else window.dispatchEvent(new CustomEvent('dex-toast', { detail: 'You are not in that conversation' })); };
    window.addEventListener('dex-open-message', on);
    return () => window.removeEventListener('dex-open-message', on);
  });
  // the conversation header's search button
  useEffect(() => {
    // a conversation id (its header's search), or a query (a #tag clicked in a message)
    const onSearch = (e: Event) => { const d = (e as CustomEvent).detail as string | SearchInit; openSearch(typeof d === 'string' ? { convId: d } : d); };
    window.addEventListener('dex-search', onSearch);
    return () => window.removeEventListener('dex-search', onSearch);
  }, []);
  // other parts of the app open a conversation by id (Take to Direct, links)
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
  setPresenceSource(live ? session.online : [], session.away ?? [], session.users, session.inRoom ?? [], session.inMeeting ?? []);
  const toast = useToast();
  const setAvailability = (availability: Availability, until: number | null = null) => {
    void window.dex.request('me.update', { availability, until }).then(() => toast(`Shown as ${AVAILABILITY.find((a) => a.id === availability)!.label}${until ? ` till ${new Date(until).toLocaleTimeString([], { ...timeOpts(), weekday: until - Date.now() > 20 * 3600_000 ? 'short' : undefined, hour: 'numeric', minute: '2-digit' })}` : ''}`)).catch((e: Error) => toast(e.message, true));
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

  const soundRef = useRef(state.settings.sound);
  useEffect(() => { soundRef.current = state.settings.sound; }, [state.settings.sound]);
  // keyboard: the keys people chose (Shortcuts sheet) for Go to, Search, Preferences, sounds and the
  // lenses; G then a letter outside text fields; Ctrl+/ shortcuts; text size; Esc closes
  const gAt = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return; // the Dock and dialogs keep their own keys
      if (e.key === 'Escape') { setMenu(false); if (!palette) setSheet(null); }
      if (e.altKey && !e.ctrlKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const rows = [...document.querySelectorAll<HTMLButtonElement>('.sb-row')].filter((r) => r.offsetParent);
        if (!rows.length) return;
        e.preventDefault();
        const at = rows.findIndex((r) => r.classList.contains('active'));
        const next = rows[at < 0 ? 0 : (at + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length];
        next.click(); next.scrollIntoView({ block: 'nearest' });
        return;
      }
      // G then a letter: only where nobody is typing and no dialog is open
      if (!e.ctrlKey && !e.altKey && !e.metaKey && !typingIn(e.target) && !palette && !document.querySelector('.scrim')) {
        const letter = e.key.toUpperCase();
        if (gAt.current && Date.now() - gAt.current < 1500) {
          gAt.current = 0;
          const to = G_KEYS.find((g) => g.letter === letter)?.lens;
          const l = to ? LENSES.find((x) => x.id === to) : undefined;
          if (l) { e.preventDefault(); setLens(l.id); setSheet(null); }
          return;
        }
        if (letter === 'G' && !e.shiftKey) { gAt.current = Date.now(); return; }
      }
      if (pressed(e, keyFor('goto'))) { e.preventDefault(); setPalette(true); return; }
      if (pressed(e, keyFor('search'))) { e.preventDefault(); openSearch({}); return; }
      if (pressed(e, keyFor('prefs'))) { e.preventDefault(); setSheet('preferences'); return; }
      if (pressed(e, keyFor('mute'))) {
        // quiet or bring back notification sounds (read the latest, a quick second press must undo the first)
        e.preventDefault();
        const cur = soundRef.current;
        let back: MessageSound = 'chime';
        try { back = (localStorage.getItem('dex-sound-before-mute') as MessageSound | null) ?? 'chime'; } catch { /* storage off */ }
        if (cur !== 'none') { try { localStorage.setItem('dex-sound-before-mute', cur); } catch { /* storage off */ } }
        soundRef.current = cur === 'none' ? back : 'none';
        void window.dex.setSettings({ sound: soundRef.current });
        toast(cur === 'none' ? 'Sounds back on' : `Sounds quiet · ${keyText(keyFor('mute'))} brings them back`);
        return;
      }
      const lensAt = LENSES.findIndex((l, i) => pressed(e, keyFor(`lens:${l.id}`, lensFallback(i))));
      if (lensAt >= 0) { e.preventDefault(); setLens(LENSES[lensAt].id); setSheet(null); return; }
      if (!e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === '=' || k === '+' || k === '-' || k === '0') {
        e.preventDefault();
        const sizes = [90, 100, 110, 125] as const;
        const i = sizes.indexOf(state.settings.textSize ?? 100);
        const next = k === '0' ? 100 : sizes[Math.max(0, Math.min(sizes.length - 1, (i < 0 ? 1 : i) + (k === '-' ? -1 : 1)))];
        void window.dex.setSettings({ textSize: next });
      }
      else if (k === '/') { e.preventDefault(); setShortcuts(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [palette, state.settings.sound, lens, chip]); // eslint-disable-line react-hooks/exhaustive-deps

  // dexconnect://people/<id>, dexconnect://admin, dexconnect://settings
  // one of my devices was added with a pairing code: tell me, in case it was not me
  useEffect(() => window.dex.onHubEvent((name, data) => {
    if (name !== 'me.devicePaired') return;
    const host = (data as { hostname?: string }).hostname ?? 'A new device';
    window.dex.notify(tr('A device was added to your account'), tr(`${host} is now signed in as you. Not you? Remove it in Preferences → Your devices.`), 'dexconnect://settings');
  }), []);

  // links from other apps and notifications (through the main process), and the app's own (phones)
  useEffect(() => {
    const route = (url: string) => {
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
      else if (target === 'file' && m[2]) void openFileLink(url).catch((e: Error) => window.dispatchEvent(new CustomEvent('dex-toast', { detail: e.message })));
      else if (target === 'desk') { setLens('desk'); setSheet(null); if ((m[2] === 'task' || m[2] === 'reminder') && m[3]) requestOpen({ kind: 'task', id: m[3] }); }
      else if (target === 'calendar') { setLens('calendar'); setSheet(null); if (m[2] === 'event' && m[3]) requestOpen({ kind: 'event', id: m[3] }); }
      else if (target === 'recording' && m[2]) { setLens('meet'); setSheet(null); openRecording({ token: m[2] }); }
      else if (target === 'help') { setSheet(null); openHelp(m[2] === 'desk' ? { view: 'desk' } : { view: 'me' }); }
      else if (target === 'meet') {
        setLens('meet'); setSheet(null);
        const id = parseMeetingId(m[2] ?? '');
        if (id) void joinAny(id, false).catch((e: Error) => window.dispatchEvent(new CustomEvent('dex-toast', { detail: e.message })));
      }
      else if (target === 'webinar' && /^\d{9}$/.test(m[2] ?? '')) {
        setLens('meet'); setSheet(null);
        if (m[3] === 'survey') openWebinar(m[2], 'survey');
        else void joinAny(m[2], false).catch((e: Error) => window.dispatchEvent(new CustomEvent('dex-toast', { detail: e.message })));
      }
      else setLens('pulse');
    };
    const onLocal = (e: Event) => route(String((e as CustomEvent).detail));
    window.addEventListener('dex-deeplink', onLocal);
    const off = window.dex.onDeepLink(route);
    return () => { off(); window.removeEventListener('dex-deeplink', onLocal); };
  }, [isAdmin, conversations]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = (s: Section) => {
    if (s === 'admin') setSheet('control');
    else if (s === 'settings') setSheet('preferences');
    else setLens(s === 'people' || s === 'directory' ? 'directory' : s === 'desk' || s === 'calendar' || s === 'meet' ? s : 'pulse');
  };

  const conn = state.phase === 'ready'
    ? { warn: false, text: state.via === 'remote' ? `${session.hub.name} · via the internet` : session.hub.name }
    : state.phase === 'offline'
      ? { warn: true, text: `Reconnecting${state.retryInMs ? ` in ${Math.ceil(state.retryInMs / 1000)}s` : '…'}` }
      : { warn: true, text: 'Connecting…' };

  const users = useMemo(() => new Map(session.users.map((u) => [u.id, u] as const)), [session.users]);
  const commands = useMemo(() => [
    ...[...conversations.values()].filter((c) => c.joined).map((c) => ({
      id: `conv-${c.id}`, label: convTitle(c, users, session.me.id), icon: (c.kind === 'space' ? 'grid' : 'direct') as IconName,
      hint: c.kind === 'space' ? 'Space' : 'Direct', run: () => openConversation(c.id, c.kind),
    })),
    { id: 'new-space', label: 'Create a Space', icon: 'plus' as IconName, run: () => setLens('spaces') },
    { id: 'search', label: 'Search messages and files', icon: 'search' as IconName, hint: keyText(keyFor('search')) || 'Search', run: () => openSearch({}) },
    { id: 'shortcuts', label: 'Keyboard shortcuts', icon: 'info' as IconName, hint: 'Ctrl+/', run: () => setShortcuts(true) },
    { id: 'go-pulse', label: 'Go to Pulse', icon: 'pulse' as IconName, run: () => setLens('pulse') },
    { id: 'go-desk', label: 'Go to Desk: reminders, kept messages, sends waiting', icon: 'desk' as IconName, run: () => setLens('desk') },
    { id: 'go-calendar', label: 'Go to Calendar', icon: 'calendar' as IconName, run: () => setLens('calendar') },
    { id: 'go-directory', label: 'Go to Directory', icon: 'card' as IconName, run: () => setLens('directory') },
    { id: 'go-meet', label: 'Go to Meet: start or join a meeting', icon: 'video' as IconName, run: () => setLens('meet') },
    ...helpCommands(),
    { id: 'prefs', label: 'Open Preferences', icon: 'settings' as IconName, run: () => setSheet('preferences') },
    ...(isAdmin ? [{ id: 'control', label: 'Open Control room', icon: 'shield' as IconName, run: () => setSheet('control') }] : []),
    { id: 'updates', label: 'Check for updates', icon: 'refresh' as IconName, run: () => void window.dex.checkForUpdates() },
  ], [isAdmin, conversations, users, session.me.id, lens, chip]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="frame">
      <header className="titlebar">
        <div className="brand"><img src={logo} alt="" /><span>Dexterity Connect</span></div>
        <div className="titlebar-mid">
          <LensBar lens={lens} setLens={(l) => { setLens(l); setSheet(null); }} onGoTo={() => setPalette(true)} />
          <RoomChip />
          <button className="goto goto-phone" onClick={() => setPalette(true)} aria-label="Go to a person, conversation or command"><span className="goto-label">Go to</span><span className="goto-caret" aria-hidden="true">▸</span></button>
        </div>
        <div className="titlebar-right">
          <UpdatePill state={state} />
          <span className={`conn${conn.warn ? ' warn' : ''}${state.via === 'remote' && !conn.warn ? ' remote' : ''}`} role="status" aria-label={conn.text}
            title={state.via === 'remote' ? 'Outside the office: connected through the internet gateway, encrypted to the hub' : state.hub ? `${state.hub.host}:${state.hub.port}` : ''}>
            {state.via === 'remote' && !conn.warn ? <Icon name="globe" size={14} /> : <span className="pip" />}<span className="conn-text">{conn.text}</span>
          </span>
          <div className="me-wrap">
            <button ref={meBtn} className="me-btn" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)} title="You: status, Preferences" aria-label={`${session.me.displayName}: status and Preferences`}>
              <Avatar user={session.me} presence={live ? (session.me.availability === 'invisible' ? 'off' : presenceFor(session.me.id)) : 'off'} size="sm" />
              {session.me.role !== 'guest' && session.me.role !== 'bot' && <DayArc size={28} />}
              {isAdmin && pendingCount > 0 && <span className="badge me-badge">{pendingCount}</span>}
            </button>
            {menu && (
              <div ref={meMenu} className="menu" role="menu" aria-label="You" onKeyDown={menuKeys}>
                <div className="menu-head">
                  <Avatar user={session.me} presence={live ? (session.me.availability === 'invisible' ? 'off' : presenceFor(session.me.id)) : 'off'} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{session.me.displayName}</div>
                    <div className="faint" style={{ fontSize: 12 }}>{session.me.statusText ?? session.me.title ?? session.me.account}</div>
                  </div>
                </div>
                {session.me.role !== 'guest' && session.me.role !== 'bot' && live && <><div className="menu-sep" /><DayMenu onClose={() => setMenu(false)} /><div className="menu-sep" /></>}
                <div className="menu-label label">Show me as</div>
                {AVAILABILITY.map((a) => (
                  <button key={a.id} role="menuitemradio" aria-checked={session.me.availability === a.id} className="avail" disabled={!live} onClick={() => { setMenu(a.id !== 'available'); setAvailability(a.id); }}>
                    <span className={`avail-ring ${a.id}`} />
                    <span className="sb-main"><span>{a.label}</span><span className="sb-preview">{session.me.availability === a.id && session.me.availabilityUntil ? `Till ${new Date(session.me.availabilityUntil).toLocaleTimeString([], { ...timeOpts(), hour: 'numeric', minute: '2-digit' })}` : a.hint}</span></span>
                  </button>
                ))}
                {session.me.availability !== 'available' && (
                  <div className="avail-for" role="group" aria-label="How long">
                    {statusDurations().map((d) => (
                      <button key={d.label} className="when-chip" onClick={() => { setMenu(false); setAvailability(session.me.availability, d.until); }}>{d.label}</button>
                    ))}
                  </div>
                )}
                <button role="menuitem" disabled={!live} onClick={() => { setMenu(false); setOoo(true); }}><Icon name="calendar" size={16} />{session.me.ooo ? `Away from the office until ${new Date(session.me.ooo.until).toLocaleDateString([], { day: 'numeric', month: 'short' })}` : 'Away from the office…'}</button>
                <div className="menu-sep" />
                {session.me.role !== 'guest' && session.me.role !== 'bot' && <HelpMenuItems onDone={() => { setMenu(false); setSheet(null); }} />}
                <button role="menuitem" onClick={() => { setSheet('preferences'); setMenu(false); }}><Icon name="settings" size={16} />Preferences{keyFor('prefs') && <span className="kbd">{keyHint(keyFor('prefs'))}</span>}</button>
                <button role="menuitem" onClick={() => { setShortcuts(true); setMenu(false); }}><Icon name="info" size={16} />Keyboard shortcuts<span className="kbd">Ctrl /</span></button>
                {isAdmin && (
                  <button role="menuitem" onClick={() => { setSheet('control'); setMenu(false); }}>
                    <Icon name="shield" size={16} />Control room{pendingCount > 0 && <span className="badge">{pendingCount}</span>}
                  </button>
                )}
                <button role="menuitem" onClick={() => { void window.dex.checkForUpdates(); setSheet('preferences'); setMenu(false); }}><Icon name="refresh" size={16} />Check for updates</button>
                {window.dex.addOffice && (
                  <>
                    <div className="menu-sep" />
                    <div className="menu-label label">Offices</div>
                    <button role="menuitemradio" aria-checked className="office-now"><Icon name="server" size={16} />{session.hub.name}<span className="kbd">Here</span></button>
                    {(state.offices ?? []).map((o) => (
                      <button key={o.id} role="menuitemradio" aria-checked={false} onClick={() => { setMenu(false); void window.dex.switchOffice!(o.id).then(() => location.reload()); }}><Icon name="server" size={16} />{o.name}</button>
                    ))}
                    <button role="menuitem" onClick={() => { setMenu(false); void window.dex.addOffice!(); }}><Icon name="plus" size={16} />Join another office…</button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      <main className={`stage${isTalk(lens) ? ' flush' : ''}`}>
        {state.update.justUpdated && <div className="view" style={{ paddingBottom: 0 }}><WhatsNew state={state} /></div>}
        {lens === 'pulse' && <Home state={state} session={session} pendingCount={pendingCount} go={go} open={openConversation} onPerson={(id) => { setLens('directory'); setFocusUser(id); }} />}
        {isTalk(lens) && <ChatView chip={chip} setChip={setChip} state={state} session={session} />}
        {lens === 'desk' && <Desk session={session} jump={jump} />}
        {lens === 'calendar' && <CalendarView session={session} openConv={(id) => jump(id)} />}
        {lens === 'meet' && <Suspense fallback={<div className="tl-more"><span className="spinner" /></div>}><MeetLens session={session} openConv={(id) => jump(id)} /></Suspense>}
        {lens === 'directory' && <People state={state} session={session} query={query} setQuery={setQuery} focusUser={focusUser} onMessage={(id) => void messagePerson(id)} />}
      </main>

      <LensStrip lens={lens} setLens={(l) => { if (l === 'direct') setLensRaw(chip === 'spaces' || chip === 'projects' ? 'spaces' : 'direct'); else setLens(l); setSheet(null); }}
        onTalkAgain={() => { setSheet(null); if (panesNow().ids.length) closePane(panesNow().focus); }} />

      {sheet && (
        <div className="sheet-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) setSheet(null); }}>
          <SheetFrame wide={sheet === 'control'} label={sheet === 'control' ? 'Control room' : sheet === 'search' ? 'Search' : 'Preferences'}>
            <button className="sheet-close" onClick={() => setSheet(null)} aria-label="Close" title="Close (Esc)"><Icon name="x" size={18} /></button>
            <div className="sheet-body">
              {sheet === 'preferences' && <SettingsView state={state} session={session} />}
              {sheet === 'search' && (
                <div className="view">
                  <div className="view-head"><div><h1>Search</h1></div></div>
                  <SearchView key={JSON.stringify(searchInit)} init={searchInit} users={session.users} meId={session.me.id} conversations={conversations}
                    onOpen={(convId, messageId, parentId) => jump(convId, messageId, parentId)} />
                </div>
              )}
              {sheet === 'control' && isAdmin && <Suspense fallback={<div className="tl-more"><span className="spinner" /></div>}><Admin state={state} session={session} /></Suspense>}
            </div>
          </SheetFrame>
        </div>
      )}

      <AutomationsHost session={session} />
      {shortcuts && <ShortcutsSheet lenses={LENSES} onClose={() => setShortcuts(false)} />}
      {palette && (
        <CommandPalette
          users={session.users}
          online={online}
          commands={commands}
          onClose={() => setPalette(false)}
          onPerson={(id) => { if (id === session.me.id) { setLens('directory'); setFocusUser(id); } else void messagePerson(id); }}
          convName={(id) => { const c = conversations.get(id); return c ? convTitle(c, users, session.me.id) : ''; }}
          onMessage={(m) => jump(m.convId, m.id, m.parentId)}
          onSearch={(q) => openSearch({ q })}
        />
      )}
      <RecordingReady />
      <MdPreview users={users} meId={session.me.id} />
      <AddToolHost />
      <LinkedFiles />
      <RoomStage users={users} meDevice={session.deviceId} meId={session.me.id}
        title={(id) => { const c = conversations.get(id); return c ? convTitle(c, users, session.me.id) : 'Room'; }}
        onOpenConversation={(id) => { const c = conversations.get(id); if (c) openConversation(c.id, c.kind); }} />
      <AssistHost session={session} users={users} live={live} />
      <WebinarSeat />
      <IncomingCall users={users} title={(id) => { const c = conversations.get(id); return c ? convTitle(c, users, session.me.id) : ''; }} />
      {ooo && <OutOfOffice session={session} onClose={() => setOoo(false)} />}
      <ReminderCards users={users} meId={session.me.id} jump={jump} />
      <MeetingCards users={users} meId={session.me.id} />
      {share && <ShareDialog req={share} session={session} onDone={(convId) => { setShare(null); if (convId) { const c = conversations.get(convId); if (c) openConversation(c.id, c.kind); } }} />}
      <RequiredUpdate state={state} />
    </div>
  );
}

/** A control sheet from the right: it takes the keyboard while open and gives it back when it closes. */
function SheetFrame({ wide, label, children }: { wide: boolean; label: string; children: React.ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useDialogFocus(ref, false);
  return <aside ref={ref} tabIndex={-1} onKeyDown={trapTab} className={`sheet${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={label}>{children}</aside>;
}

function OutOfOffice({ session, onClose }: { session: Session; onClose: () => void }) {
  const toast = useToast();
  const cur = session.me.ooo;
  const [until, setUntil] = useState(() => new Date(cur?.until ?? Date.now() + 7 * 86400_000).toISOString().slice(0, 10));
  const [message, setMessage] = useState(cur?.message ?? '');
  const [delegate, setDelegate] = useState(cur?.delegateId ?? '');
  const save = (off = false) => void window.dex.request('me.update', { ooo: off ? null : { until: new Date(`${until}T23:59:00`).getTime(), message: message || null, delegateId: delegate || null } })
    .then(() => { toast(off ? 'Welcome back' : 'Away from the office is on'); onClose(); }).catch((e: Error) => toast(e.message, true));
  return (
    <Dialog title="Away from the office" onClose={onClose} narrow>
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

/** A conversation in a window of its own (desktop: "Open in a new window"). */
export function PopoutApp({ convId }: { convId: string }) {
  const state = useAppState();
  useTheme(state);
  const lastSession = useRef<Session | null>(null);
  if (state?.session) lastSession.current = state.session;
  const session = state?.session ?? lastSession.current;
  const usersRef = useRef(session?.users ?? []);
  if (session) usersRef.current = session.users;
  const ready = state?.phase === 'ready';
  useEffect(() => {
    if (!ready || !session) return;
    void startChat(session.me.id, () => usersRef.current).then(() => refreshConversations());
    void startDesk(session.me.id, () => usersRef.current);
    startPolicy();
    startEmoji();
  }, [ready, session?.me.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!state || !session) return;
    setPresenceSource(ready ? session.online : [], session.away ?? [], session.users, session.inRoom ?? [], session.inMeeting ?? []);
    setTimeFormat(state.settings.timeFormat);
  });
  const conv = useChat((s) => s.conversations.get(convId));
  useEffect(() => { if (conv && session) document.title = `${convTitle(conv, new Map(session.users.map((u) => [u.id, u] as const)), session.me.id)} · Dexterity Connect`; }, [conv, session]);
  if (!state || !session) return <div className="popout-wait"><span className="spinner" /></div>;
  const users = new Map(session.users.map((u) => [u.id, u] as const));
  return (
    <ToastHost>
      <div className="popout">
        <Pane convId={convId} users={users} meId={session.me.id} isAdmin={session.me.role === 'owner' || session.me.role === 'admin'} online={new Set(session.online)}
          live={ready} onBack={() => void window.dex.showMain?.(convId)} session={session} />
        <AddToolHost />
      </div>
      <AutomationsHost session={session} />
    </ToastHost>
  );
}

/** A conversation's header menu opens its Automations (in the main window and in pop-outs). */
function AutomationsHost({ session }: { session: Session }) {
  const [convId, setConvId] = useState<string | null>(null);
  useEffect(() => {
    const on = (e: Event) => setConvId(String((e as CustomEvent).detail));
    window.addEventListener('dex-automations', on);
    return () => window.removeEventListener('dex-automations', on);
  }, []);
  return convId ? <Suspense fallback={null}><AutomationsSheet convId={convId} session={session} onClose={() => setConvId(null)} /></Suspense> : null;
}
