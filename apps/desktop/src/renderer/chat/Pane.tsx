// A conversation Pane: a title-block header, the spine timeline, the writing line and the Dock
// composer. Notes, Whiteboards, Files, Pinned and People open as sheets from the tabs on the
// Pane's right edge; a side-track opens the same way, tied to its message by a hairline.
import { Suspense, lazy, memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';
import { STICKER_RE, apRef, uniqueCommands } from '@dex/core';
import type { Conversation, FileInfo, Message, PublicUser, Session } from '@dex/core';
import { AttachmentTray, FilesPanel, Lightbox, MessageFiles, filesSupported, startUploads } from './files.tsx';
import type { Attachment } from './files.tsx';
import { Avatar, Icon, Popover, colorFor, confirmAction, relativeTime, useToast, presenceFor } from '../ui.tsx';
import type { IconName, Presence } from '../ui.tsx';
import { useAutoGrow } from '../autogrow.ts';
import { fitTools, startToolRail } from './toolRail.ts';
import { SPACE_REF_RE, isEmojiOnly, openSpaces, renderBody, spaceName } from './format.tsx';
import {
  addConversation, chatState, discardFailed, loadLatest, loadOlder, markRead, notifyTyping, retrySend, sendMessage,
  setDraft, showConversation, tlKey, useChat,
} from './store.ts';
import type { AnyMessage, PendingMessage } from './store.ts';
import { ConvTile, HushItems, convTitle } from './Switchboard.tsx';
import { callState, hold, holdable, joinRoom, setMinimized, startCall, startShare, useCall } from '../rooms/engine.ts';
import { ScreenPicker } from '../rooms/RoomUi.tsx';
import { FormBuilder, FormCard } from './forms.tsx';
import { BotCard, isBotCard } from '../bots/BotCard.tsx';
import { NoteEditor, NotesList } from './notes.tsx';
import { BoardsList } from './boards.tsx';
import { VoiceRecorder } from './voice.tsx';
import { Viewer } from './Viewer.tsx';
import { EmojiPicker } from './EmojiPicker.tsx';
import { stampsOnHand } from './quick.ts';
import { EmojiGlyph, StickerImg } from '../emoji.tsx';
import { ClipRecorder, clipsSupported, screenClipsSupported } from './clips.tsx';
import type { Board } from '@dex/core';
import { ForwardDialog, ForwardedTag, PollCard, PollDialog, RemindDialog, ScheduleDialog, markUnreadFrom } from './extras.tsx';
import { KEEP_LABEL, describeWhen, deskState, toggleSaved, useDesk } from '../desk/store.ts';
import { policyNow, usePolicy, withinEditWindow } from '../policy.ts';
import { EventDialog } from '../calendar/CalendarView.tsx';
import { BUILT_INS, loadBotCommands, runSlash } from './commands.ts';
import type { CommandInfo } from './commands.ts';
import { Dialog } from '../ui.tsx';
import { formatTime, timeOpts, useTimeFormat } from '../time.ts';
import { KeepMenu, MsgFlags, PIN_FOR, StartSpaceDialog, StickerSheet, namedPeople, openWithQuote, pinEnd, runAction, useActions } from './wire.tsx';
import { useMsgLayout } from './prefs.ts';
import { LinkCards } from './linkcards.tsx';
import { DecisionBuilder, DecisionCard } from './decisions.tsx';
import { ActionDialog, ActionPreview, ApStrip, actionWords, logAction, ownerPool, ownerText, useActionDraft } from '../meet/actions.tsx';
import { MeetCardView } from '../meet/threadcards.tsx';
import { NibOffer } from '../nib/offer.tsx';
import { nibBotId } from '../nib/store.ts';
// Nib's cards (a lead's transmittal, the register…) load with the first one on screen
const NibMessageCard = lazy(() => import('../nib/cards.tsx'));
import { ReactionInsightsPanel } from './insights.tsx';
import { RestyleControl, RestyleSheet, readable } from './restyle.tsx';
import type { RestyleStyle } from '@dex/core/restyle';
import { RefCard, RefChips, ReferenceDialog, payloadFor, refDragProps, shareRef, startHoldDrag, useRefTarget } from './refs.tsx';
import type { RefPayload } from './refs.tsx';
import { keyFor, keyHint, keyText, pressed, useKeys } from './keys.ts';
import './chat.css';
import { LoungeStrip } from '../lounges/Lounges.tsx';
import { isMadeBot } from '../bots/BotMark.tsx';
import { toLocalText, toShareable } from './sharepaths.ts';
import { useBotHead } from '../bots/BotHead.tsx';

/** The kind of a conversation, read from the chat store without subscribing. */
const convKind = (id: string) => chatState().conversations.get(id)?.kind;

const WhiteboardStage = lazy(() => import('./Whiteboard.tsx').then((m) => ({ default: m.WhiteboardStage })));
const ScanDialog = lazy(() => import('../scan/ScanDialog.tsx').then((m) => ({ default: m.ScanDialog })));

const RUN_GAP = 5 * 60 * 1000;
/**
 * Where you were reading in each conversation you scrolled back in (a message and its distance from
 * the top), so coming back to it puts you there again. At the newest messages nothing is kept.
 */
const READING = new Map<string, { id: string; top: number }>();
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
/** A time tick on the spine every ten minutes of activity. */
const TICK = 10 * 60 * 1000;

type SheetKind = 'notes' | 'boards' | 'files' | 'pins' | 'members';
type Side = { kind: 'track'; parentId: string } | { kind: 'pins' } | { kind: 'members' } | { kind: 'files' } | { kind: 'notes'; noteId: string | null | 'new' } | { kind: 'boards' } | null;

const SHEETS: Array<{ kind: SheetKind; label: string; icon: IconName }> = [
  { kind: 'notes', label: 'Notes', icon: 'doc' },
  { kind: 'boards', label: 'Whiteboards', icon: 'drawing' },
  { kind: 'files', label: 'Files', icon: 'paperclip' },
  { kind: 'pins', label: 'Pinned', icon: 'pin' },
  { kind: 'members', label: 'People', icon: 'people' },
];
const openSheet = (kind: SheetKind): Side => (kind === 'notes' ? { kind: 'notes', noteId: null } : { kind });

interface Ctx {
  users: Map<string, PublicUser>; meId: string; isAdmin: boolean; conv: Conversation; online: Set<string>;
  view: (f: FileInfo, all: FileInfo[]) => void;
  /** Multi-select: the chosen message ids (null when not picking). */
  selected: Set<string> | null;
  select: (id: string | null) => void;
  /** Messages drawn as compact cards (Preferences) rather than on the spine. */
  cards: boolean;
  /** The time format (12/24-hour), so kept messages draw their times again when it changes. */
  clock: string;
}

/** The stamps on hand (Preferences), kept live. */
function useStamps(): string[] {
  const [q, setQ] = useState(stampsOnHand);
  useEffect(() => { const on = () => setQ(stampsOnHand()); window.addEventListener('dex-stamps', on); return () => window.removeEventListener('dex-stamps', on); }, []);
  return q;
}

/** Insert text at the cursor (replacing the selection) through the browser's editing, so undo works. */
function insertAtCursor(el: HTMLTextAreaElement, ins: string): void {
  el.focus();
  if (!document.execCommand('insertText', false, ins)) {
    const { selectionStart: a, selectionEnd: b } = el;
    el.setRangeText(ins, a, b, 'end');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

/** The text of a message as a Markdown quote, for the Dock. */
const quoteOf = (m: AnyMessage, users: Map<string, PublicUser>) =>
  `> **${users.get(m.authorId)?.displayName ?? 'Someone'}:** ${(STICKER_RE.test(m.body) ? 'Sticker' : m.body || (m.files.length ? `📎 ${m.files.map((f) => f.name).join(', ')}` : '')).replace(/\n/g, '\n> ')}\n\n`;

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const date = d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  if (d.toDateString() === now.toDateString()) return `Today · ${date}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday · ${date}`;
  return `${d.toLocaleDateString([], { weekday: 'short' })} · ${date}`;
}

const clock = (ts: number) => formatTime(ts);
/** The timeline's spine marks keep two-digit hours (a dimension mark, aligned in the mono column). */
const tickClock = (ts: number) => new Date(ts).toLocaleTimeString([], { ...timeOpts(), hour: '2-digit', minute: '2-digit' });
const fullDate = (ts: number) => new Date(ts).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });

/** How someone else shows in the title block. */
const STATUS_WORD: Record<Presence, string> = { on: 'At desk', off: 'Offline', away: 'Away', room: 'In a Room', dnd: 'No interruptions', busy: 'Heads-down', meeting: 'In a meeting' };

/** "Last on" for someone: now, a time today, or a date. */
function lastOn(u: PublicUser | undefined, online: boolean): string {
  if (online) return 'Now';
  if (!u?.lastSeen) return '—';
  return new Date(u.lastSeen).toDateString() === new Date().toDateString() ? clock(u.lastSeen) : new Date(u.lastSeen).toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** A Pane's hold on the window size: narrow windows show one sheet at a time. */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 720px)');
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

// ------------------------------------------------------------------ pane
export function Pane({ convId, users, meId, isAdmin, online, live, onBack, session, direct = false, reachable = [], focused = true, onFocus, onClose, sheetNo }: {
  convId: string; users: Map<string, PublicUser>; meId: string; isAdmin: boolean; online: Set<string>; live: boolean; onBack?: () => void; session?: Session;
  /** Hub off: messages go straight to the other PCs (text only). */
  direct?: boolean; reachable?: string[];
  /** Side by side: whether this Pane has focus, how to give it focus, and how to close it. */
  focused?: boolean; onFocus?: () => void; onClose?: () => void;
  /** "Sheet 2 of 3" when Panes lie side by side. */
  sheetNo?: { n: number; of: number };
}) {
  const conv = useChat((s) => s.conversations.get(convId));
  const [side, setSide] = useState<Side>(null);
  const [viewer, setViewer] = useState<{ file: FileInfo; all: FileInfo[] } | null>(null);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [datePick, setDatePick] = useState(false);
  const [fwdMany, setFwdMany] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const narrow = useNarrow();
  const layout = useMsgLayout();
  useEffect(() => { setSelected(null); }, [convId]);
  // which message shows its tool column: the one under the pointer, kept while the pointer travels to it
  useEffect(() => startToolRail(), []);
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setSelected(null); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [selected]);
  const [dragging, setDragging] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [headMenu, setHeadMenu] = useState(false);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [e2e, setE2e] = useState<{ encrypted: boolean; code: string | null; missing: string[]; required?: boolean } | null>(null);
  const [verify, setVerify] = useState(false);
  const missingNames = (ids: string[]) => ids.map((id) => (id === meId ? 'You' : users.get(id)?.displayName ?? 'Someone')).join(', ');
  useEffect(() => {
    setE2e(null);
    if (!window.dex.e2eStatus || convKind(convId) !== 'direct') return;
    const load = () => void window.dex.e2eStatus!(convId).then(setE2e).catch(() => setE2e(null));
    load();
    return window.dex.onHubEvent((name) => { if (name === 'e2e.keysChanged' || name === 'policy.updated') load(); });
  }, [convId, live]);
  useEffect(() => {
    const onSide = (e: Event) => {
      const d = (e as CustomEvent).detail as { convId: string; side: 'notes-new' | 'boards' };
      if (d.convId !== convId) return;
      setSide(d.side === 'boards' ? { kind: 'boards' } : { kind: 'notes', noteId: 'new' });
    };
    window.addEventListener('dex-side', onSide);
    return () => window.removeEventListener('dex-side', onSide);
  }, [convId]);
  const toast = useToast();

  useEffect(() => { setSide(null); }, [convId]);
  // Esc closes the side-track or side sheet of the Pane you are in, once nothing is open above it
  useEffect(() => {
    if (!side || !focused) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('.scrim, .sheet-scrim, .popover, .lightbox, .board-stage, .reminder-card:focus-within')) return;
      setSide(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [side, focused]);
  useEffect(() => {
    const onPlan = (e: Event) => { if ((e as CustomEvent).detail === convId) setPlanning(true); };
    window.addEventListener('dex-plan', onPlan);
    return () => window.removeEventListener('dex-plan', onPlan);
  }, [convId]);

  // jump to a message (from search): open its side-track, or scroll to it and flash it
  useEffect(() => {
    const onJump = async (e: Event) => {
      const d = (e as CustomEvent).detail as { convId: string; messageId: string; parentId: string | null };
      if (d.convId !== convId) return;
      if (d.parentId) { setSide({ kind: 'track', parentId: d.parentId }); return; }
      // far back (jump to a date, an old link) means loading older pages until it is there
      for (let i = 0; i < 80; i++) {
        window.dispatchEvent(new CustomEvent('dex-reveal', { detail: { convId, messageId: d.messageId } }));
        const el = wrap.current?.querySelector(`.timeline [data-mid="${d.messageId}"]`);
        if (el) {
          el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          el.classList.add('flash');
          setTimeout(() => el.classList.remove('flash'), 1800);
          return;
        }
        const tl = chatState().timelines.get(convId);
        if (tl && !tl.hasMore && tl.loaded) return;
        if (tl?.loaded) await loadOlder(convId); else await loadLatest(convId);
        await new Promise((r) => setTimeout(r, 60));
      }
    };
    window.addEventListener('dex-jump', onJump);
    return () => window.removeEventListener('dex-jump', onJump);
  }, [convId]);
  useEffect(() => {
    const hide = showConversation(convId);
    const tl = chatState().timelines.get(convId);
    if (!tl?.loaded) void loadLatest(convId);
    return hide;
  }, [convId]);

  const refDrop = useRefTarget({ kind: 'conv', convId });
  // one context for everything drawn in the Pane, kept while nothing in it changes, so the
  // timeline's runs and messages are not drawn again whenever the Pane is
  const view = useCallback((file: FileInfo, all: FileInfo[]) => setViewer({ file, all }), []);
  const select = useCallback((id: string | null) => setSelected((cur) => {
    if (id === null) return null;
    const next = new Set(cur ?? []);
    if (next.has(id)) next.delete(id); else if (next.size < 50) next.add(id);
    return next;
  }), []);
  const clockFormat = useTimeFormat();
  const ctx = useMemo<Ctx | null>(() => (conv ? { users, meId, isAdmin, conv, online, view, selected, cards: layout === 'cards', select, clock: clockFormat } : null),
    [users, meId, isAdmin, conv, online, view, selected, layout, select, clockFormat]);
  const onTrack = useCallback((parentId: string) => setSide({ kind: 'track', parentId }), []);
  // a bot is not a person: its own header (who made it, what it is for, its requests or hours)
  const botPeer = conv?.kind === 'direct' ? conv.members.filter((m) => m !== meId) : [];
  const botHead = useBotHead(botPeer.length === 1 ? users.get(botPeer[0]) : undefined, convId, conv ? convTitle(conv, users, meId) : '', users, conv?.lastMessage?.id ?? null);
  if (!conv || !ctx) return <div className="pane-wrap"><div className="pane empty"><div className="empty"><Icon name="direct" size={36} /><span>This conversation is no longer available.</span>{onClose && <button className="btn" onClick={onClose}>Close this Pane</button>}</div></div></div>;
  const picked = (): AnyMessage[] => (chatState().timelines.get(convId)?.messages ?? []).filter((m) => selected?.has(m.id) && !('pending' in m));
  const canAttach = filesSupported() && live && !direct;
  const onDrop = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    // a dropped folder is not uploaded: its path goes into the Dock (stored as UNC when it is on a mapped drive)
    const entries = [...e.dataTransfer.items].filter((it) => it.kind === 'file').map((it) => it.webkitGetAsEntry?.() ?? null);
    const folders: string[] = [];
    const files = [...e.dataTransfer.files].filter((f, i) => {
      if (!entries[i]?.isDirectory) return true;
      const p = window.dex.pathForFile?.(f);
      if (p) folders.push(/\s/.test(p) ? `"${p}"` : p);
      return false;
    });
    if (folders.length) window.dispatchEvent(new CustomEvent('dex-insert', { detail: { key: tlKey(convId), text: folders.join(' ') } }));
    if (files.length && canAttach) window.dispatchEvent(new CustomEvent('dex-attach', { detail: { key: tlKey(convId), files } }));
  };
  const title = convTitle(conv, users, meId);
  const others = conv.members.filter((m) => m !== meId);
  const one = conv.kind === 'direct' && others.length === 1 ? users.get(others[0]) : undefined;
  const subtitle = conv.kind === 'space'
    ? (conv.topic ?? (conv.private ? 'Private Space' : 'Open Space'))
    : one
      ? (() => {
        const status = one.statusText ? `${one.statusEmoji ? `${one.statusEmoji} ` : ''}${one.statusText}` : null;
        return [status, one.title].filter(Boolean).join(' · ') || one.account;
      })()
      : `${others.length + 1} people`;
  // the title block on the right: two ruled rows of mono facts
  const facts: Array<[string, string]> = botHead ? botHead.facts : conv.kind === 'space'
    ? [['People', String(conv.members.length)], ['Opened', fullDate(conv.createdAt)]]
    : one
      ? [['Status', STATUS_WORD[presenceFor(others[0])]], ['Last on', lastOn(one, online.has(others[0]))]]
      : [['People', String(conv.members.length)], ['On now', String(others.filter((id) => online.has(id)).length)]];
  // a long Space name is cut short so the hint never runs out of the Dock
  const placeholder = botHead ? botHead.placeholder : conv.kind === 'space' ? `Write in ${title.length > 28 ? `${title.slice(0, 26).trimEnd()}…` : title}` : one ? `Write to ${title.split(' ')[0]}` : title.length <= 28 ? `Write to ${title}` : 'Write to the group';
  const toggleSheet = (kind: SheetKind) => setSide(side?.kind === kind ? null : openSheet(kind));
  const canPlan = live && !!session && session.me.role !== 'guest';

  return (
    <div ref={wrap} className={`pane-wrap${side ? ' with-side' : ''}${focused ? ' focused' : ''}`} onMouseDownCapture={onFocus} onFocusCapture={onFocus}>
      <section className="pane" aria-label={title}
        onDragOver={(e) => { if (canAttach && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
        onDrop={onDrop}>
        {dragging && <div className="drop-zone" onDragLeave={() => setDragging(false)}><Icon name="paperclip" size={28} /><span>Drop to share in {title}</span></div>}
        <header className="pane-head">
          {onBack && <button className="icon-btn only-narrow" onClick={onBack} aria-label="Back to the Switchboard"><Icon name="back" size={18} /></button>}
          <ConvTile c={conv} users={users} meId={meId} />
          <div className="pane-title">
            <h2 translate="no" title={title}><span className="pane-name">{title}</span>{conv.private && conv.kind === 'space' && <Icon name="lock" size={14} />}</h2>
            <p className="faint">
              {botHead?.subtitle}
              {!botHead && e2e && conv.kind === 'direct' && (
                <button className={`e2e-chip${e2e.encrypted ? '' : ' off'}`} onClick={() => setVerify(true)} title={e2e.encrypted ? 'Messages here are end-to-end encrypted' : 'Not end-to-end encrypted yet'}>
                  <Icon name={e2e.encrypted ? 'lock' : 'unlock'} size={11} />{e2e.encrypted ? 'Encrypted' : 'Not encrypted'}
                </button>
              )}
              {sheetNo && sheetNo.of > 1 && <span className="sheet-no mono">Sheet {sheetNo.n}/{sheetNo.of}</span>}
              {conv.muted && <span className="sheet-no mono hushed">Hushed</span>}
              {!botHead && <span className="pane-sub" translate={conv.kind === 'space' && !conv.topic ? undefined : 'no'}>{subtitle}</span>}
            </p>
          </div>
          {botHead?.details}
          <dl className="title-block" aria-label="About this conversation">
            {facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
          </dl>
          {conv.kind === 'space' && <LoungeStrip convId={convId} live={live} />}
          {conv.members.length > 1 && !botHead && <RoomButton convId={convId} live={live} />}
          <button ref={moreBtn} className="icon-btn head-more" title="More for this conversation" aria-label="More for this conversation" aria-haspopup="menu" aria-expanded={headMenu} onClick={() => setHeadMenu(!headMenu)}><Icon name="more" size={18} /></button>
          {onClose && <button className="icon-btn pane-x" title="Close this Pane" aria-label="Close this Pane" onClick={onClose}><Icon name="x" size={16} /></button>}
          {headMenu && (
            <Popover anchor={moreBtn.current} onClose={() => setHeadMenu(false)} className="menu head-menu">
              {canPlan && <button role="menuitem" onClick={() => { setHeadMenu(false); setPlanning(true); }}><Icon name="calendar" size={16} />Plan a meeting</button>}
              {live && session?.me.role !== 'guest' && <button role="menuitem" onClick={() => { setHeadMenu(false); window.dispatchEvent(new CustomEvent('dex-add-tool', { detail: conv.id })); }}><Icon name="grid" size={16} />Add a tool…</button>}
              <button role="menuitem" onClick={() => { setHeadMenu(false); window.dispatchEvent(new CustomEvent('dex-search', { detail: conv.id })); }}><Icon name="search" size={16} />Search this conversation</button>
              <button role="menuitem" onClick={() => { setHeadMenu(false); setDatePick(true); }}><Icon name="history" size={16} />Jump to a date…</button>
              <button role="menuitem" onClick={() => { setHeadMenu(false); window.dispatchEvent(new CustomEvent('dex-automations', { detail: conv.id })); }}><Icon name="repeat" size={16} />Automations…</button>
              {window.dex.popOut && !location.hash.startsWith('#popout=') && <button role="menuitem" className="wide-only" onClick={() => { setHeadMenu(false); void window.dex.popOut!(conv.id, title); }}><Icon name="open" size={16} />Open in a new window</button>}
              {narrow && <>
                <div className="menu-label label">Sheets</div>
                {SHEETS.map((s) => <button key={s.kind} role="menuitem" onClick={() => { setHeadMenu(false); setSide(openSheet(s.kind)); }}><Icon name={s.icon} size={16} />{s.label}</button>)}
              </>}
              <HushItems c={conv} onDone={() => setHeadMenu(false)} />
            </Popover>
          )}
          {datePick && (
            <Popover anchor={moreBtn.current} onClose={() => setDatePick(false)} className="menu jump-date">
              <div className="menu-label label">Jump to a date</div>
              <form onSubmit={(e) => {
                e.preventDefault();
                const v = (e.currentTarget.elements.namedItem('d') as HTMLInputElement).value;
                if (!v) return;
                setDatePick(false);
                void window.dex.request('msg.at', { convId: conv.id, at: new Date(`${v}T00:00:00`).getTime() }).then((r) => {
                  if (r.messageId) window.dispatchEvent(new CustomEvent('dex-jump', { detail: { convId: conv.id, messageId: r.messageId, parentId: null } }));
                }).catch(() => {});
              }}>
                <input name="d" type="date" className="input" autoFocus max={new Date().toISOString().slice(0, 10)} aria-label="Date" />
                <button className="btn primary sm">Go</button>
              </form>
            </Popover>
          )}
        </header>
        {direct && (
          <div className="direct-banner" role="status">
            <Icon name="wifi" size={15} />
            <span>The office hub is off. Messages go straight to {others.every((o) => reachable.includes(o)) ? (others.length === 1 ? title.split(' ')[0] : 'everyone here') : 'colleagues whose PCs are on'} over the office network, encrypted, and are added to the history when the hub is back.</span>
          </div>
        )}
        {conv.archived && (
          <div className="direct-banner archived-banner" role="status">
            <Icon name="archive" size={15} /><span>This Space is archived: you can read it, but not post.</span>
            {(isAdmin || conv.createdBy === meId || conv.moderators.includes(meId)) && <button className="btn sm" onClick={() => void window.dex.request('conv.archive', { convId, archived: false }).then(() => toast('Space restored')).catch((e: Error) => toast(e.message, true))}>Restore</button>}
          </div>
        )}
        {conv.kind === 'direct' && others.map((id) => users.get(id)).filter((u) => u?.ooo).map((u) => (
          <div key={u!.id} className="direct-banner ooo-banner" role="status">
            <Icon name="calendar" size={15} />
            <span><b>{u!.displayName.split(' ')[0]}</b> is away from the office until {new Date(u!.ooo!.until).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}.{u!.ooo!.message ? ` “${u!.ooo!.message}”` : ''}{u!.ooo!.delegateId ? ` For anything urgent, contact ${users.get(u!.ooo!.delegateId)?.displayName ?? 'a colleague'}.` : ''}</span>
          </div>
        ))}
        <div className={`ref-zone${refDrop.valid ? ' ref-valid' : ''}${refDrop.over ? ' ref-over' : ''}`} {...refDrop.props}>
          <Timeline ctx={ctx} onTrack={onTrack} activeTrack={side?.kind === 'track' ? side.parentId : null} />
          {refDrop.valid && <span className="ref-drop-label" aria-hidden={!refDrop.over}>{refDrop.over ? 'Drop to reference here' : `Reference in ${title}`}</span>}
        </div>
        {selected && (
          <div className="select-bar" role="toolbar" aria-label="Picked messages">
            <b className="mono">{selected.size} picked</b>
            <button className="btn sm" disabled={!selected.size} onClick={() => setFwdMany(true)}><Icon name="forward" size={14} />Forward</button>
            <button className="btn sm" disabled={!selected.size} onClick={() => { void navigator.clipboard.writeText(picked().map((m) => `${users.get(m.authorId)?.displayName ?? ''} (${new Date(m.createdAt).toLocaleString()}):\n${m.body}`).join('\n\n')); toast('Copied'); }}><Icon name="copy" size={14} />Copy</button>
            <button className="btn sm" disabled={!selected.size} onClick={() => void Promise.all(picked().filter((m) => !deskState().saved.has(m.id)).map((m) => toggleSaved(m as never).catch(() => null))).then(() => toast('Kept on your Desk'))}><Icon name="drawer" size={14} />Keep</button>
            {picked().length > 0 && picked().every((m) => m.authorId === meId || (isAdmin && conv.kind === 'space')) && (
              <button className="btn sm danger" onClick={() => void confirmAction({ title: `Delete ${selected.size} messages for everyone?`, confirm: 'Delete', danger: true }).then((ok) => { if (ok) void Promise.all(picked().map((m) => window.dex.request('msg.delete', { messageId: m.id }).catch(() => null))).then(() => { toast('Deleted'); setSelected(null); }); })}><Icon name="trash" size={14} />Delete</button>
            )}
            <span style={{ flex: 1 }} />
            <button className="btn ghost sm" onClick={() => setSelected(null)}>Done</button>
          </div>
        )}
        {fwdMany && picked().length > 0 && <ForwardDialog message={picked()[0] as never} more={picked().slice(1) as never} users={users} meId={meId} online={online} onClose={() => { setFwdMany(false); setSelected(null); }} />}
        <WritingLine k={tlKey(convId)} users={users} />
        {/* before sending: say plainly when a Direct conversation is not end-to-end encrypted, and why */}
        {!botHead && e2e && conv.kind === 'direct' && !e2e.encrypted && e2e.missing.length > 0 && !e2e.required && (
          <div className="e2e-notice" role="status"><Icon name="unlock" size={13} /><span>{e2e.missing.length === 1 ? `Not end-to-end encrypted: ${missingNames(e2e.missing)} is on an older version of Dexterity Connect.` : `Not end-to-end encrypted: ${missingNames(e2e.missing)} are on an older version of Dexterity Connect.`}</span><button className="link" onClick={() => setVerify(true)}>Why</button></div>
        )}
        {conv.archived ? null : !botHead && e2e && conv.kind === 'direct' && e2e.required && !e2e.encrypted && e2e.missing.length > 0 ? (
          <div className="dock-locked faint e2e-required" role="status"><Icon name="lock" size={14} />{e2e.missing.length === 1
            ? `Your office requires Direct messages to be end-to-end encrypted. You can write here once ${missingNames(e2e.missing)} updates Dexterity Connect.`
            : `Your office requires Direct messages to be end-to-end encrypted. You can write here once ${missingNames(e2e.missing)} update Dexterity Connect.`}</div>
        ) : conv.postPolicy === 'moderators' && !(isAdmin || conv.createdBy === meId || conv.moderators.includes(meId)) ? (
          <div className="dock-locked faint"><Icon name="lock" size={14} />Only moderators post here. You can answer a message in its side-track.</div>
        ) : <Dock convId={convId} parentId={null} ctx={ctx} live={live} direct={direct} placeholder={placeholder} />}
      </section>
      {side?.kind === 'track' && <SideTrack ctx={ctx} parentId={side.parentId} live={live} onClose={() => setSide(null)} />}
      {side?.kind === 'track' && !narrow && <TrackLeader wrap={wrap} parentId={side.parentId} />}
      {side?.kind === 'pins' && <PinsPanel ctx={ctx} onClose={() => setSide(null)} onJump={(id) => setSide({ kind: 'track', parentId: id })} />}
      {side?.kind === 'members' && <MembersPanel ctx={ctx} onClose={() => setSide(null)} />}
      {side?.kind === 'notes' && (
        <aside className="side-panel" aria-label="Notes">
          <header className="side-head"><span className="label">Notes</span><button className="icon-btn" onClick={() => setSide(null)} aria-label="Close"><Icon name="x" size={16} /></button></header>
          <div className="side-body notes-side">
            {side.noteId === null
              ? <NotesList convId={convId} users={users} onOpen={(id) => setSide({ kind: 'notes', noteId: id })} onNew={() => setSide({ kind: 'notes', noteId: 'new' })} />
              : <NoteEditor key={side.noteId} id={side.noteId === 'new' ? null : side.noteId} convId={convId} users={users} meId={meId} onClose={() => setSide({ kind: 'notes', noteId: null })} />}
          </div>
        </aside>
      )}
      {side?.kind === 'boards' && (
        <aside className="side-panel" aria-label="Whiteboards">
          <header className="side-head"><span className="label">Whiteboards</span><button className="icon-btn" onClick={() => setSide(null)} aria-label="Close"><Icon name="x" size={16} /></button></header>
          <div className="side-body"><BoardsList convId={convId} onOpen={setBoard} /></div>
        </aside>
      )}
      {side?.kind === 'files' && <FilesPanel convId={convId} onView={ctx.view} onClose={() => setSide(null)} />}
      <nav className="pane-tabs" aria-label="Sheets">
        {side?.kind === 'track' && (
          <button className="pane-tab on track" title="Side-track" aria-pressed="true" onClick={() => setSide(null)}><span>Side-track</span></button>
        )}
        {SHEETS.map((s) => (
          <button key={s.kind} className={`pane-tab${side?.kind === s.kind ? ' on' : ''}`} title={s.label} aria-pressed={side?.kind === s.kind} onClick={() => toggleSheet(s.kind)}>
            <span>{s.label}{s.kind === 'members' ? <b> · {conv.members.length}</b> : null}</span>
          </button>
        ))}
      </nav>
      {board && <Suspense fallback={null}><WhiteboardStage board={board} convId={convId} onClose={() => setBoard(null)} /></Suspense>}
      {viewer && <Viewer file={viewer.file} all={viewer.all} convId={convId} onClose={() => setViewer(null)} />}
      {verify && e2e && (
        <Dialog title={e2e.encrypted ? 'End-to-end encrypted' : 'Not encrypted yet'} onClose={() => setVerify(false)} narrow>
          {e2e.encrypted ? (
            <>
              <p className="muted" style={{ margin: 0 }}>Messages, files, photos and voice notes you send here are locked on your device and can only be opened on the devices of the people in this conversation. The office hub stores and passes them on but cannot read them.</p>
              <div className="label">Safety code</div>
              <div className="code big safety selectable">{e2e.code?.split(' ').map((g, i) => <span key={i}>{g}</span>)}</div>
              <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>To be sure nobody is listening in, compare this code with {others.length === 1 ? users.get(others[0])?.displayName.split(' ')[0] : 'the others'} in person. It is the same on both screens. It changes when anyone here adds or replaces a device.</p>
            </>
          ) : (
            <p className="muted" style={{ margin: 0 }}>{e2e.missing.length
              ? e2e.required
                ? e2e.missing.length === 1
                  ? `${missingNames(e2e.missing)} is on an older version of Dexterity Connect, which cannot encrypt messages. Your office requires Direct messages to be end-to-end encrypted, so nothing can be sent here until they update. Opening the updated app once is enough.`
                  : `${missingNames(e2e.missing)} are on an older version of Dexterity Connect, which cannot encrypt messages. Your office requires Direct messages to be end-to-end encrypted, so nothing can be sent here until everyone updates. Opening the updated app once is enough.`
                : e2e.missing.length === 1
                  ? `${missingNames(e2e.missing)} is on an older version of Dexterity Connect. Messages here stay readable to them and are protected on the office network, but the office hub can read them. Each one shows an open lock. They will be end-to-end encrypted once they update.`
                  : `${missingNames(e2e.missing)} are on an older version of Dexterity Connect. Messages here stay readable to them and are protected on the office network, but the office hub can read them. Each one shows an open lock. They will be end-to-end encrypted once everyone updates.`
              : 'Conversations that include an integration are not end-to-end encrypted.'}</p>
          )}
        </Dialog>
      )}
      {planning && session && <EventDialog session={session} conv={conv} onClose={() => setPlanning(false)} />}
    </div>
  );
}

/**
 * One amber-outlined Room button: voice by default, video from its menu; Join or Back while a Room runs.
 * Beside it, Show screen: a screen shown in the conversation with no voice or camera (people Watch).
 * In another call already, joining puts that call on hold first.
 */
function RoomButton({ convId, live }: { convId: string; live: boolean }) {
  const toast = useToast();
  const active = useCall((s) => s.active.get(convId));
  const inCall = useCall((s) => s.room);
  const held = useCall((s) => s.held);
  const [menu, setMenu] = useState(false);
  const [picking, setPicking] = useState(false);
  const caret = useRef<HTMLButtonElement>(null);
  const canShare = !!window.dex.listScreens;
  // another call is live: hold it (when it can be) before coming in here
  const busy = !!inCall && !(holdable(inCall) && !held);
  const busyNote = inCall ? (busy ? 'You are in another call: leave it first' : 'Your call goes on hold first') : '';
  const holdFirst = async () => { const r = callState().room; if (r && r.convId !== convId) await hold(); };
  const share = (id: string, sound: boolean) => { setPicking(false); void holdFirst().then(() => startShare(convId, id, sound)).catch((e: Error) => toast(e.message, true)); };
  const picker = picking && <ScreenPicker onPick={share} onClose={() => setPicking(false)} />;
  if (inCall?.convId === convId && !inCall.purpose) return <button className="room-open live" onClick={() => setMinimized(false)}><Icon name={inCall.share ? 'screenshare' : 'phone'} size={14} />{inCall.share ? 'Back to the screen' : 'Back to the Room'}</button>;
  if (active && active.participants.length) {
    const watch = !!active.share;
    return (
      <button className={`room-open live${watch ? ' share' : ''}`} disabled={!live || busy} title={busyNote || (watch ? 'Watch the screen: no microphone or camera needed' : undefined)}
        onClick={() => void holdFirst().then(() => joinRoom(active.id, false, { watch })).catch((e: Error) => toast(e.message, true))}>
        <Icon name={watch ? 'screenshare' : 'phone'} size={14} />{watch ? 'Watch the screen' : 'Join the Room'} <span className="mono">· {active.participants.length}</span>
      </button>
    );
  }
  const open = (video: boolean) => { setMenu(false); void holdFirst().then(() => startCall(convId, video)).catch((e: Error) => toast(e.message, true)); };
  return (
    <span className="room-split">
      <button className="room-open" disabled={!live || busy} onClick={() => open(false)} title={busyNote || 'Open a Room with voice'}>Open a Room</button>
      <button ref={caret} className="room-open caret" disabled={!live || busy} aria-label="More ways to open a Room" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><Icon name="chevron" size={13} /></button>
      {canShare && (
        <button className="room-open share-only" disabled={!live || busy} onClick={() => setPicking(true)}
          title={busyNote || 'Show your screen here: no voice or camera. Everyone in the conversation can watch, point at it and talk later if they want.'} aria-label="Show my screen">
          <Icon name="screenshare" size={14} /><span className="share-only-label">Show screen</span>
        </button>
      )}
      {menu && (
        <Popover anchor={caret.current} onClose={() => setMenu(false)} className="menu room-menu">
          <div className="menu-label label">Open a Room</div>
          <button role="menuitem" onClick={() => open(false)}><Icon name="mic" size={16} />With voice</button>
          <button role="menuitem" onClick={() => open(true)}><Icon name="video" size={16} />With video</button>
          {canShare && <button role="menuitem" onClick={() => { setMenu(false); setPicking(true); }}><Icon name="screenshare" size={16} />Screen only<span className="menu-note mono">NO MIC · NO CAMERA</span></button>}
        </Popover>
      )}
      {picker}
    </span>
  );
}

/**
 * The side-track's hairline: from the parent message's point on the spine, along the top edge of
 * the message, to the edge of the side-track sheet. Redrawn as the timeline scrolls or resizes.
 */
function TrackLeader({ wrap, parentId }: { wrap: RefObject<HTMLDivElement | null>; parentId: string }) {
  const [d, setD] = useState<{ path: string; x: number; y: number; ex: number; ey: number; off: boolean } | null>(null);
  useEffect(() => {
    const root = wrap.current;
    if (!root) return;
    let frame = 0;
    const draw = () => {
      frame = 0;
      const tl = root.querySelector<HTMLElement>('.timeline');
      const panel = root.querySelector<HTMLElement>('.side-track');
      const msg = tl?.querySelector<HTMLElement>(`[data-mid="${parentId}"]`);
      if (!tl || !panel) { setD(null); return; }
      const w = root.getBoundingClientRect();
      const t = tl.getBoundingClientRect();
      const p = panel.getBoundingClientRect();
      const head = panel.querySelector<HTMLElement>('.track-parent')?.getBoundingClientRect();
      const ex = (head ? head.left : p.left + 16) - w.left;
      const ey = (head ? head.top + 18 : p.top + 60) - w.top;
      const mx = p.left - w.left - 10;
      // from the message's branch tag (the side-track's mark on the spine), else from the message's top edge
      const tag = msg?.querySelector<HTMLElement>(':scope > .branch-tag')?.getBoundingClientRect();
      const m = msg?.getBoundingClientRect();
      let x = tag ? tag.right - w.left : m ? m.left - w.left : t.left - w.left + 52;
      let y = tag ? tag.top + tag.height / 2 - w.top : m ? m.top - w.top : t.top - w.top;
      const min = t.top - w.top + 2;
      const max = t.bottom - w.top - 2;
      const off = !msg || y < min || y > max;
      if (off) { y = Math.max(min, Math.min(max, y)); x = t.left - w.left + 52; }
      setD({ path: `M${x} ${y}H${mx}V${ey}H${ex}`, x, y, ex, ey, off });
    };
    const soon = () => { if (!frame) frame = requestAnimationFrame(draw); };
    soon();
    root.addEventListener('scroll', soon, true);
    // the sheet slides in: measure again once it has settled
    root.addEventListener('animationend', soon, true);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(soon);
    ro?.observe(root);
    // messages arriving move the parent without resizing anything: watch the timeline's content too
    const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(soon);
    const tl = root.querySelector('.timeline');
    if (tl) mo?.observe(tl, { childList: true, subtree: true });
    return () => { root.removeEventListener('scroll', soon, true); root.removeEventListener('animationend', soon, true); ro?.disconnect(); mo?.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [wrap, parentId]);
  if (!d) return null;
  return (
    <svg className={`track-leader${d.off ? ' off' : ''}`} aria-hidden="true">
      <path d={d.path} />
      <circle cx={d.x} cy={d.y} r={2.5} />
      <rect x={d.ex - 3} y={d.ey - 3} width={6} height={6} />
    </svg>
  );
}

// ------------------------------------------------------------------ timeline
function Timeline({ ctx, onTrack, activeTrack }: { ctx: Ctx; onTrack: (id: string) => void; activeTrack: string | null }) {
  const convId = ctx.conv.id;
  const tl = useChat((s) => s.timelines.get(convId));
  const scroller = useRef<HTMLDivElement>(null);
  // back where you were reading, if you had scrolled back here before
  const restore = useRef(READING.get(convId) ?? null);
  const stick = useRef(!restore.current);
  const prevHeight = useRef(0);
  const prevFirst = useRef<string | null>(null);
  const prevLast = useRef<string | null>(null);
  const messages = tl?.messages ?? [];
  // the line above what arrived since you last read here (kept while the Pane is open; gone once you write)
  const [readTo, setReadTo] = useState<string | undefined>(() => (ctx.conv.unread > 0 ? ctx.conv.lastReadId ?? '' : undefined));
  // scrolled away from the newest messages, and how many arrived since
  const [away, setAway] = useState(!!restore.current);
  const [fresh, setFresh] = useState(0);
  const topGap = useRef<HTMLDivElement>(null);
  const bottomGap = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const heightOf = (b: { kind: string; key: string }) => heights.current.get(b.key) ?? GUESS[b.kind] ?? 60;
  const range = useRef({ start: 0, end: 0, n: 0 });
  const pinTop = useRef(false);
  const startKey = useRef<string | null>(null);
  const shiftFrame = useRef(0);
  const [, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => () => cancelAnimationFrame(shiftFrame.current), []);

  // keep the view pinned to the bottom unless the reader scrolled up; keep position when older pages load
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const first = messages[0]?.id ?? null;
    const last = messages.at(-1);
    const sentNow = !!last && last.id !== prevLast.current && prevLast.current !== null && last.authorId === ctx.meId && 'pending' in last;
    if (restore.current && tl?.loaded) {
      // coming back: the message you were reading sits where it was
      const { id, top } = restore.current;
      const place = () => {
        const at = el.querySelector<HTMLElement>(`[data-mid="${CSS.escape(id)}"]`);
        if (at) el.scrollTop += at.getBoundingClientRect().top - el.getBoundingClientRect().top - top;
        return !!at;
      };
      if (place()) {
        // runs above it are drawn as they come into view and change height: hold it in place while they settle
        let n = 0;
        const again = () => { if (!stick.current && place() && ++n < 12) requestAnimationFrame(again); };
        requestAnimationFrame(again);
      } else { stick.current = true; setAway(false); el.scrollTop = el.scrollHeight; }
      restore.current = null;
    } else if (sentNow) {
      // what you just wrote is always in view
      stick.current = true; setAway(false); setFresh(0); setReadTo(undefined);
      el.scrollTop = el.scrollHeight;
      if (range.current.end < range.current.n) bump(); // drawn far back: the window moves to the newest first
    } else if (prevFirst.current && first !== prevFirst.current && !stick.current) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    } else if (last && prevLast.current && last.id !== prevLast.current && last.authorId !== ctx.meId) {
      setFresh((n) => n + 1);
    }
    prevFirst.current = first;
    prevLast.current = last?.id ?? null;
    prevHeight.current = el.scrollHeight;
  }, [messages]); // eslint-disable-line react-hooks/exhaustive-deps

  // where you are reading, for when you come back (nothing kept at the newest messages); measured once a frame
  const noting = useRef(0);
  const noteReading = () => {
    if (noting.current) return;
    noting.current = requestAnimationFrame(() => {
      noting.current = 0;
      const el = scroller.current;
      if (!el || restore.current) return;
      if (stick.current) { READING.delete(convId); return; }
      const box = el.getBoundingClientRect();
      const top = [...el.querySelectorAll<HTMLElement>('[data-mid]')].find((m) => m.getBoundingClientRect().bottom > box.top + 8);
      if (top?.dataset.mid) READING.set(convId, { id: top.dataset.mid, top: top.getBoundingClientRect().top - box.top });
    });
  };
  useEffect(() => () => cancelAnimationFrame(noting.current), []);
  // on the way down to the newest message (a smooth scroll that the scroll handler leaves alone)
  const goingDown = useRef(false);
  const toLatest = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = true; setAway(false); setFresh(0);
    // drawn far back (a window of older messages): put the window at the newest, then go there at once
    if (range.current.end < range.current.n) { pinTop.current = false; flushSync(bump); el.scrollTop = el.scrollHeight; markRead(convId); return; }
    goingDown.current = true;
    // runs drawn on the way change the height: land on the real bottom when the scroll ends
    const land = () => { if (!goingDown.current) return; goingDown.current = false; el.scrollTop = el.scrollHeight; stick.current = true; markRead(convId); };
    el.addEventListener('scrollend', land, { once: true });
    setTimeout(land, 900);
    el.scrollTo({ top: el.scrollHeight, behavior: reducedMotion() ? 'auto' : 'smooth' });
    markRead(convId);
  };
  // arrow keys move between messages; Home and End go to the first and the newest loaded
  const onKeys = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key) || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target as HTMLElement;
    if (t !== e.currentTarget && !t.matches('.msg[data-mid]')) return; // a field or button inside a message keeps its keys
    const all = [...e.currentTarget.querySelectorAll<HTMLElement>('.spine .msg[data-mid]')];
    if (!all.length) return;
    e.preventDefault();
    const at = all.indexOf(t);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : at < 0 ? all.length - 1 : Math.max(0, Math.min(all.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
    // its tools stay out while the keyboard is in the message (a class, not :focus: Tab into the tools must find them there)
    for (const m of e.currentTarget.querySelectorAll('.msg.kbd-on')) m.classList.remove('kbd-on');
    all[next].classList.add('kbd-on');
    all[next].focus({ preventScroll: true });
    all[next].scrollIntoView({ block: 'nearest' });
  };
  // another conversation in the same Pane starts at its newest message (on first open the reading
  // place restored above decides, so this leaves it alone)
  const shownConv = useRef(convId);
  useEffect(() => { if (shownConv.current === convId) return; shownConv.current = convId; stick.current = true; pinTop.current = false; }, [convId]);
  // switching between spine and cards changes every height: stay with the newest message while
  // the runs settle (they are laid out as they come into view)
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !stick.current) return;
    el.scrollTop = el.scrollHeight;
    let n = 0;
    let frame = 0;
    const again = () => { if (stick.current) el.scrollTop = el.scrollHeight; if (++n < 4) frame = requestAnimationFrame(again); };
    frame = requestAnimationFrame(again);
    return () => cancelAnimationFrame(frame);
  }, [ctx.cards]);

  // stay pinned to the newest message when the window or the Dock changes size
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { if (stick.current) el.scrollTop = el.scrollHeight; });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // read state follows what is visible at the bottom while the window has focus
  useEffect(() => {
    const tryRead = () => { if (stick.current && document.hasFocus()) markRead(convId); };
    tryRead();
    window.addEventListener('focus', tryRead);
    return () => window.removeEventListener('focus', tryRead);
  }, [convId, messages.length]);

  const onScroll = () => {
    const el = scroller.current!;
    if (goingDown.current) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    stick.current = gap < 60;
    if (stick.current) { markRead(convId); pinTop.current = false; if (fresh) setFresh(0); }
    // the way back to the newest messages shows once they are a screen away
    const far = gap > Math.max(240, el.clientHeight * 0.6);
    if (far !== away) setAway(far);
    noteReading();
    // older pages load once the reader reaches the top of what is loaded (not of what is drawn)
    if (el.scrollTop < 200 && tl?.hasMore && !tl.loading && range.current.start === 0) { measure(); prevHeight.current = el.scrollHeight; pinTop.current = true; void loadOlder(convId); }
    if (!shiftFrame.current) shiftFrame.current = requestAnimationFrame(() => { shiftFrame.current = 0; slide(); });
  };
  // runs: consecutive messages by one person within 5 minutes; a title-block label at each new day;
  // a time tick on the spine whenever ten minutes have gone by. A run whose messages did not change
  // keeps its list from last time, so it is not drawn again when an older page arrives.
  const lastRuns = useRef(new Map<string, AnyMessage[]>());
  const blocks = useMemo(() => {
    type Block = { kind: 'day'; label: string; key: string } | { kind: 'tick'; label: string; key: string } | { kind: 'new'; key: string } | { kind: 'notice'; m: AnyMessage; key: string } | { kind: 'run'; author: string; mine: boolean; msgs: AnyMessage[]; key: string };
    const out: Block[] = [];
    let lastDay = '';
    let lastTick = 0;
    // the first message that arrived since you last read here (not your own)
    const firstNew = readTo === undefined ? null : messages.find((m) => !('pending' in m) && m.id > readTo && m.authorId !== ctx.meId && !('system' in m && m.system))?.id ?? null;
    for (const m of messages) {
      if (m.id === firstNew) out.push({ kind: 'new', key: 'new-line' });
      const day = new Date(m.createdAt).toDateString();
      if (day !== lastDay) { out.push({ kind: 'day', label: dayLabel(m.createdAt), key: `d${day}` }); lastDay = day; lastTick = m.createdAt; }
      if ('system' in m && m.system) { out.push({ kind: 'notice', m, key: `n${m.id}` }); continue; }
      const prev = out[out.length - 1];
      if (prev?.kind === 'run' && prev.author === m.authorId && m.createdAt - prev.msgs[prev.msgs.length - 1].createdAt < RUN_GAP && m.id !== firstNew) { prev.msgs.push(m); continue; }
      if (m.createdAt - lastTick >= TICK) {
        const at = Math.floor(m.createdAt / TICK) * TICK;
        // a dimension mark, not a timestamp: no AM/PM
        out.push({ kind: 'tick', label: tickClock(at).replace(/\s?[ap]\.?\s?m\.?$/i, ''), key: `t${at}-${m.id}` });
        lastTick = m.createdAt;
      }
      out.push({ kind: 'run', author: m.authorId, mine: m.authorId === ctx.meId, msgs: [m], key: `r${m.id}` });
    }
    const runs = new Map<string, AnyMessage[]>();
    for (const b of out) {
      if (b.kind !== 'run') continue;
      const was = lastRuns.current.get(b.key);
      if (was && was.length === b.msgs.length && was.every((x, i) => x === b.msgs[i])) b.msgs = was;
      runs.set(b.key, b.msgs);
    }
    lastRuns.current = runs;
    return out;
  }, [messages, ctx.meId, ctx.clock, readTo]);

  // ---------------------------------------------------------------- drawing a window of it
  // A long history (scrolled back through thousands of messages) is drawn a window at a time:
  // WINDOW blocks around where the reader is, and above and below them gaps as tall as the
  // blocks they stand for (measured when they were drawn), so the scrollbar and the reading
  // position stay where they were. The window slides as the reader nears either gap.
  const n = blocks.length;
  const last = Math.max(0, n - WINDOW);
  let start: number;
  // at the newest message: the window ends there; older pages asked for at the top are drawn at
  // the top; otherwise the window stays on the block it starts with, whatever arrives below
  if (stick.current) start = last;
  else if (pinTop.current) start = 0;
  else {
    let at = startKey.current ? blocks.findIndex((b) => b.key === startKey.current) : -1;
    // coming back to where you were reading: the window is drawn around that message
    if (at < 0 && restore.current) { const id = restore.current.id; const r = blocks.findIndex((b) => b.kind === 'run' && b.msgs.some((m) => m.id === id)); if (r >= 0) at = Math.max(0, r - WINDOW / 2); }
    start = at >= 0 ? at : last;
  }
  start = Math.max(0, Math.min(start, last));
  const end = Math.min(n, start + WINDOW);
  startKey.current = blocks[start]?.key ?? null;
  range.current = { start, end, n };
  let above = 0;
  let below = 0;
  for (let i = 0; i < start; i++) above += heightOf(blocks[i]);
  for (let i = end; i < n; i++) below += heightOf(blocks[i]);

  /** Remember how tall each drawn block is (the gaps are built from these). */
  function measure(): void {
    const top = topGap.current;
    if (!top) return;
    let el = top.nextElementSibling as HTMLElement | null;
    for (let i = range.current.start; i < range.current.end && el && el !== bottomGap.current; i++) {
      const next = el.nextElementSibling as HTMLElement | null;
      if (next) heights.current.set(blocks[i].key, next.getBoundingClientRect().top - el.getBoundingClientRect().top);
      el = next;
    }
  }
  /** Slide the window when the reader nears one of its gaps (or lands inside one, dragging the scrollbar). */
  function slide(): void {
    const el = scroller.current;
    const top = topGap.current;
    const bottom = bottomGap.current;
    if (!el || !top || !bottom) return;
    const { start: s0, end: e0, n: total } = range.current;
    if (total <= WINDOW) return;
    const box = el.getBoundingClientRect();
    const h = el.clientHeight;
    const topEdge = top.getBoundingClientRect().bottom - box.top; // where the drawn blocks begin, in the view
    const bottomEdge = bottom.getBoundingClientRect().top - box.top; // where they end
    let next = s0;
    if (topEdge > h || bottomEdge < 0) {
      // the view is inside a gap: draw the window around the block at its middle
      const target = el.scrollTop + h / 2 - (top.getBoundingClientRect().top - box.top + el.scrollTop);
      let y = 0;
      let i = 0;
      for (; i < total - 1; i++) { y += heightOf(blocks[i]); if (y > target) break; }
      next = i - WINDOW / 2;
    } else if (e0 < total && bottomEdge < 2 * h) next = s0 + STEP;
    else if (s0 > 0 && topEdge > -h) next = s0 - STEP;
    else return;
    next = Math.max(0, Math.min(next, total - WINDOW));
    if (next === s0) return;
    measure();
    pinTop.current = false;
    startKey.current = blocks[next].key;
    bump();
  }
  // a message far back (a search result, a link, a date) is drawn before the Pane scrolls to it
  useEffect(() => {
    const onReveal = (e: Event) => {
      const d = (e as CustomEvent).detail as { convId: string; messageId: string };
      if (d.convId !== convId) return;
      const i = blocks.findIndex((b) => (b.kind === 'run' ? b.msgs.some((m) => m.id === d.messageId) : b.kind === 'notice' && b.m.id === d.messageId));
      if (i < 0 || (i >= range.current.start && i < range.current.end)) return;
      measure();
      stick.current = false;
      pinTop.current = false;
      startKey.current = blocks[Math.max(0, Math.min(i - WINDOW / 2, n - WINDOW))].key;
      flushSync(bump);
    };
    window.addEventListener('dex-reveal', onReveal);
    return () => window.removeEventListener('dex-reveal', onReveal);
  });
  // after the window moves, older pages keep their place against the new height
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (stick.current) el.scrollTop = el.scrollHeight; // moved to the newest: stay at the bottom
    prevHeight.current = el.scrollHeight;
  }, [start, end]);

  return (
    <>
    <div className={`timeline${ctx.cards ? ' layout-cards' : ''}`} ref={scroller} onScroll={onScroll} onKeyDown={onKeys} data-loaded={messages.length}
      onBlur={(e) => { const m = (e.target as HTMLElement).closest('.msg.kbd-on'); if (m && !m.contains(e.relatedTarget as Node | null)) m.classList.remove('kbd-on'); }}
      tabIndex={0} role="log" aria-label="Messages" aria-live="off">
      <div className="spine">
        {tl?.hasMore && <div className="tl-more">{tl.loading ? <span className="spinner" /> : null}</div>}
        {tl?.loaded && !tl.hasMore && <Beginning ctx={ctx} />}
        {!tl?.loaded && <div className="tl-more"><span className="spinner" /></div>}
        <div ref={topGap} className="tl-gap" style={{ height: above, flex: 'none' }} aria-hidden="true" />
        {blocks.slice(start, end).map((b) => b.kind === 'day'
          ? <div key={b.key} className="day-mark"><span className="label">{b.label}</span></div>
          : b.kind === 'tick' ? <div key={b.key} className="spine-tick" aria-hidden="true"><span className="mono">{b.label}</span></div>
          : b.kind === 'new' ? <div key={b.key} className="new-line" role="separator" aria-label="New since you last read"><span className="label">New</span></div>
          : b.kind === 'notice' ? <Notice key={b.key} m={b.m as Message} users={ctx.users} meId={ctx.meId} />
          : <Run key={b.key} ctx={ctx} author={b.author} mine={b.mine} msgs={b.msgs} onTrack={onTrack} activeTrack={activeTrack} size={heights.current.get(b.key)} />)}
        <div ref={bottomGap} className="tl-gap" style={{ height: below, flex: 'none' }} aria-hidden="true" />
      </div>
    </div>
    {away && (
      <button className={`to-latest${fresh ? ' fresh' : ''}`} onClick={toLatest} title="Go to the newest message">
        {fresh ? `${fresh} new` : 'Newest'}<Icon name="chevron" size={14} />
      </button>
    )}
    </>
  );
}

/** Blocks drawn at once in a timeline, and how far the window slides at a time. */
const WINDOW = 360;
const STEP = 60;
/** A block's height before it was ever drawn: what the browser assumes for a run (chat.css). */
const GUESS: Record<string, number> = { day: 44, tick: 20, notice: 30, run: 72 };

/** The head of the conversation: a title block, "SHEET 1 · started 12 Mar 2025 by Vikram". */
function Beginning({ ctx }: { ctx: Ctx }) {
  const c = ctx.conv;
  const by = c.createdBy === ctx.meId ? 'you' : ctx.users.get(c.createdBy)?.displayName ?? 'a former member';
  return (
    <div className="tl-start">
      <ConvTile c={c} users={ctx.users} meId={ctx.meId} size="lg" />
      <div className="tl-start-text">
        <h3 translate="no">{convTitle(c, ctx.users, ctx.meId)}</h3>
        <div className="tl-start-line mono">Sheet 1 · started {fullDate(c.createdAt)} by {by}</div>
        {c.topic && <p className="muted" translate="no">{c.topic}</p>}
        <p className="faint" style={{ fontSize: 12.5 }}>{c.kind === 'space' ? (c.private ? 'A private Space: only people who were added can see it.' : 'An open Space: anyone in the office can find and join it.') : 'Only the people here can see these messages.'}</p>
      </div>
    </div>
  );
}

interface RunProps {
  ctx: Ctx; author: string; mine: boolean; msgs: AnyMessage[]; onTrack: (id: string) => void; activeTrack: string | null;
  /** Its height when it was last drawn: the browser keeps that much room for it until it is laid out again. */
  size?: number;
}
const Run = memo(function Run({ ctx, author, mine, msgs, onTrack, activeTrack, size }: RunProps) {
  const u = ctx.users.get(author);
  // a browser guest in a meeting has no account: their name comes with the line
  const guestName = !u ? msgs.find((m) => m.meetLine)?.meetLine?.name ?? null : null;
  // only the height it had when it was first drawn here (a later measurement is not a change)
  const [room] = useState(size);
  return (
    <div className={`run${mine ? ' mine' : ''}${u?.role === 'bot' ? ' bot' : ''}`} style={room ? { containIntrinsicSize: `auto ${Math.round(room)}px` } : undefined}>
      <div className="run-tile"><Avatar user={{ id: author, displayName: u?.displayName ?? guestName ?? '?' }} presence={guestName ? undefined : presenceFor(author)} /></div>
      <div className="run-body">
        <div className="run-head">
          <span className="run-name" style={mine ? undefined : { color: colorFor(author) }} translate={mine || !u ? undefined : 'no'} title={mine ? undefined : u?.displayName}>{mine ? 'You' : u?.displayName ?? guestName ?? 'Former member'}</span>
          {guestName && <span className="tag mono guest-tag">GUEST</span>}
          {u?.role === 'bot' && <><span className="tag bot-tag" title="A bot, not a person: what it says is automatic"><Icon name="bot" size={11} />BOT</span><span className="bot-kind">{author === nibBotId() ? 'Office companion' : isMadeBot(author) ? 'Made by a colleague' : 'Office service'}</span></>}
          <span className="run-time">{clock(msgs[0].createdAt)}</span>
        </div>
        {msgs.map((m) => <MessageItem key={m.clientId ?? m.id} ctx={ctx} m={m} onTrack={onTrack} activeTrack={activeTrack} />)}
      </div>
    </div>
  );
}, (a, b) => a.ctx === b.ctx && a.author === b.author && a.mine === b.mine && a.msgs === b.msgs && a.onTrack === b.onTrack && a.activeTrack === b.activeTrack);

// ------------------------------------------------------------------ one message
/** The tool column hangs down from a message; near the bottom of the timeline it hangs up instead. */
const toolsFit = (e: React.SyntheticEvent<HTMLDivElement>): void => fitTools(e.currentTarget);

interface ItemProps { ctx: Ctx; m: AnyMessage; onTrack?: (id: string) => void; activeTrack?: string | null; inTrack?: boolean }

/** The amber notch on my own messages: hollow when sent, half when some have seen it, solid when all have. */
function seenOf(ctx: Ctx, m: AnyMessage, inTrack: boolean | undefined): { state: string; tag: string } | null {
  if (m.authorId !== ctx.meId || 'pending' in m || inTrack) return null;
  if (ctx.users.get(ctx.meId)?.readReceipts === false) return { state: 'plain', tag: '' };
  const others = ctx.conv.members.filter((u) => u !== ctx.meId && ctx.users.get(u)?.role !== 'bot');
  const read = others.filter((u) => (ctx.conv.reads[u] ?? '') >= m.id).length;
  const state = !others.length || read === 0 ? 'sent' : read === others.length ? 'all' : 'some';
  const tag = others.length === 1 ? (read ? 'Seen' : 'Sent') : `Seen ${read}/${others.length}`;
  return { state, tag };
}

type Delivery = 'sending' | 'failed' | 'sent' | 'delivered' | 'seen-some' | 'seen';
/**
 * How far one of my messages has gone, for the transmittal mark at its end: sending, sent (the hub
 * has it), delivered (on the others' devices), seen. Delivered says nothing about reading, so it shows
 * even with read receipts off; seen needs them on both sides. In a group, delivered and seen mean
 * everyone; part of the way shows as counts in the mark's words.
 */
function deliveryOf(ctx: Ctx, m: AnyMessage, inTrack: boolean | undefined): { state: Delivery; label: string } | null {
  if (m.authorId !== ctx.meId || inTrack) return null;
  if ('pending' in m) return (m as PendingMessage).failed ? { state: 'failed', label: 'Not sent' } : { state: 'sending', label: 'Sending' };
  const others = ctx.conv.members.filter((u) => u !== ctx.meId && ctx.users.get(u)?.role !== 'bot');
  if (!others.length) return { state: 'sent', label: 'Sent' };
  const receipts = ctx.users.get(ctx.meId)?.readReceipts !== false;
  const read = receipts ? others.filter((u) => (ctx.conv.reads[u] ?? '') >= m.id).length : 0;
  const got = others.filter((u) => (ctx.conv.reads[u] ?? '') >= m.id || (ctx.conv.delivered?.[u] ?? '') >= m.id).length;
  const state: Delivery = read && read === others.length ? 'seen' : read ? 'seen-some' : got === others.length ? 'delivered' : 'sent';
  if (others.length === 1) return { state, label: state === 'seen' ? 'Seen' : state === 'delivered' ? 'Delivered' : 'Sent' };
  const n = others.length;
  return { state, label: read ? `Seen by ${read} of ${n}` : got ? `Delivered to ${got} of ${n}` : 'Sent' };
}

/**
 * The transmittal mark: a dimension line with architectural ticks, the drawing office's own way of
 * saying how far a sheet has gone. One tick: sent. Two ticks: delivered. Inked in teal with its end
 * dot: seen (the first tick alone for part of a group). A dashed line while sending; a revision
 * triangle when it did not go.
 */
function DeliveryMark({ d }: { d: { state: Delivery; label: string } }) {
  return (
    <span className={`dlv dlv-${d.state}`} role="img" aria-label={d.label} title={d.label}>
      <svg width="20" height="11" viewBox="0 0 20 11" aria-hidden="true">
        {d.state === 'failed' ? (
          <><path className="dlv-tri" d="M10 1.2 15.6 10H4.4z" /><path className="dlv-bang" d="M10 4.4v2.6M10 8.4v.1" /></>
        ) : (
          <>
            <path className="dlv-line" d="M1 7.5h18" />
            <path className="dlv-ext" d="M1 4.5v6" />
            {d.state !== 'sending' && <path className="dlv-t1" d="M4.2 10.2 9.6 4.8" />}
            {(d.state === 'delivered' || d.state === 'seen' || d.state === 'seen-some') && <path className="dlv-t2" d="M9.6 10.2 15 4.8" />}
            {d.state === 'seen' && <circle className="dlv-end" cx="17.6" cy="7.5" r="1.5" />}
          </>
        )}
      </svg>
    </span>
  );
}

/**
 * A message is drawn again only when something it shows changed: itself, the people, the layout,
 * picking, its side-track being open, or (for my own) who has read it. Presence, new messages and
 * read receipts elsewhere leave the thousands already on screen alone.
 */
function sameMessage(a: ItemProps, b: ItemProps): boolean {
  if (a.m !== b.m || a.inTrack !== b.inTrack || a.onTrack !== b.onTrack) return false;
  if ((a.activeTrack === a.m.id) !== (b.activeTrack === b.m.id)) return false;
  const x = a.ctx;
  const y = b.ctx;
  if (x === y) return true;
  if (x.users !== y.users || x.meId !== y.meId || x.isAdmin !== y.isAdmin || x.cards !== y.cards || x.clock !== y.clock || x.view !== y.view || x.select !== y.select) return false;
  if (!x.selected !== !y.selected || (x.selected && y.selected && x.selected.has(a.m.id) !== y.selected.has(b.m.id))) return false;
  const c = x.conv;
  const d = y.conv;
  if (c === d) return true;
  if (c.id !== d.id || c.kind !== d.kind || c.createdBy !== d.createdBy || c.moderators.join() !== d.moderators.join()) return false;
  if (b.m.authorId !== y.meId) return true;
  const s1 = seenOf(x, a.m, a.inTrack);
  const s2 = seenOf(y, b.m, b.inTrack);
  const d1 = deliveryOf(x, a.m, a.inTrack);
  const d2 = deliveryOf(y, b.m, b.inTrack);
  return s1?.state === s2?.state && s1?.tag === s2?.tag && d1?.state === d2?.state && d1?.label === d2?.label;
}

const MessageItem = memo(MessageItemView, sameMessage);

function MessageItemView({ ctx, m, onTrack, activeTrack, inTrack }: ItemProps) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [stamp, setStamp] = useState<'chips' | 'picker' | null>(null);
  const [more, setMore] = useState(false);
  const [pinFor, setPinFor] = useState(false);
  const [keep, setKeep] = useState(false);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const stampBtn = useRef<HTMLButtonElement>(null);
  const keepBtn = useRef<HTMLButtonElement>(null);
  const [dialog, setDialog] = useState<'remind' | 'forward' | 'readers' | 'report' | 'remove' | 'fork' | 'insights' | 'restyle' | 'reference' | 'action' | null>(null);
  const kept = useDesk((s) => s.saved.get(m.id));
  const saved = !!kept;
  const pending = 'pending' in m;
  const failed = pending ? (m as PendingMessage).failed : undefined;
  const mine = m.authorId === ctx.meId;
  const receiptsOn = ctx.users.get(ctx.meId)?.readReceipts !== false;
  const stamps = useStamps();
  const policy = usePolicy();
  const actions = useActions(ctx.conv, more);
  const inWindow = withinEditWindow(m.createdAt, policy);
  const sticker = STICKER_RE.exec(m.body)?.[1] ?? null;
  const moderator = ctx.conv.kind === 'space' && (ctx.isAdmin || ctx.conv.moderators?.includes(ctx.meId) || ctx.conv.createdBy === ctx.meId);
  const canEdit = mine && inWindow && !!m.body && !m.poll && !m.form && !m.decision && !m.ref && !sticker;
  // what dragging this message (or Reference in…) points at
  const refPayload = pending ? null : payloadFor(m as Message, ctx.users);
  const canDelete = (mine && inWindow) || moderator;
  const mentioned = m.mentions.includes(ctx.meId) || (m.mentions.includes('all') && !mine);
  const guest = ctx.users.get(ctx.meId)?.role === 'guest';
  const named = namedPeople(m as Message, ctx.meId, ctx.users);
  const author = ctx.users.get(m.authorId);
  // a group Direct with the people named, unless that is just the author (Take to Direct does that)
  const canTakeNamed = !pending && m.e2e !== 'locked' && named.length > 0 && !(named.length === 1 && named[0] === m.authorId && ctx.conv.kind === 'space');
  // a Space starts from a whole message (not a side-track reply), never from end-to-end encrypted text
  const canFork = !guest && !inTrack && !m.parentId && !m.poll && !m.form && !m.e2e && !m.deleted;

  // Ctrl+Up in the Dock edits your last message
  useEffect(() => {
    const onEdit = (e: Event) => { if ((e as CustomEvent).detail === m.id) setEditing(true); };
    window.addEventListener('dex-edit', onEdit);
    return () => window.removeEventListener('dex-edit', onEdit);
  }, [m.id]);

  const act = (p: Promise<unknown>, ok?: string) => p.then(() => ok && toast(ok)).catch((e: Error) => toast(e.message, true));
  const react = (emoji: string) => {
    const on = !(m.reactions[emoji] ?? []).includes(ctx.meId);
    setStamp(null);
    void act(window.dex.request('msg.react', { messageId: m.id, emoji, on }));
  };
  const close = (then?: () => void) => { setMore(false); setPinFor(false); then?.(); };
  const pin = (until: number | null) => close(() => void act(window.dex.request('msg.pin', { messageId: m.id, pinned: true, until }), until ? `Pinned for everyone here · ${pinEnd(until)}` : 'Pinned for everyone here'));
  const keepClick = () => {
    if (saved) { setKeep(!keep); return; }
    // one press keeps it; the flyout then offers what to file it as
    void toggleSaved(m as Message).then(() => setKeep(true)).catch((e: Error) => toast(e.message, true));
  };

  if (m.deleted) return (
    <div className="msg deleted"><span className="faint">{m.removed
      ? `Removed by ${m.removed.by === ctx.meId ? 'you' : ctx.users.get(m.removed.by)?.displayName ?? 'a moderator'}${m.removed.reason ? `: ${m.removed.reason}` : ''}`
      : 'Message deleted'}</span></div>
  );

  // the amber notch on my own messages: hollow when sent, half when some have seen it, solid when all have
  const seen = seenOf(ctx, m, inTrack);
  const delivery = deliveryOf(ctx, m, inTrack);

  return (
    <div data-mid={m.id} tabIndex={-1} onClickCapture={(e) => { if (ctx.selected && !pending && !inTrack) { e.preventDefault(); e.stopPropagation(); ctx.select(m.id); } }}
      onPointerDown={refPayload && !ctx.selected && !editing ? (e) => startHoldDrag(e, refPayload, ctx.users) : undefined}
      onFocus={inTrack ? undefined : toolsFit}
      className={`${ctx.selected && !inTrack ? `selectable-msg${ctx.selected.has(m.id) ? ' chosen' : ''} ` : ''}msg${sticker ? ' sticker-msg' : ''}${pending ? ' pending' : ''}${failed ? ' failed' : ''}${mentioned ? ' mentioned' : ''}${activeTrack === m.id ? ' tracked' : ''}${m.pinned ? ' pinned' : ''}${saved ? ' kept' : ''}`}>
      {ctx.cards && !inTrack && <span className="card-time mono" aria-hidden="true">{clock(m.createdAt)}</span>}
      {seen && <span className={`notch ${seen.state}`} aria-hidden="true" />}
      {delivery && <DeliveryMark d={delivery} />}
      {delivery && <span className="seen-tag mono" aria-hidden="true">{delivery.label}</span>}
      {m.forwardedFrom && <ForwardedTag m={m} users={ctx.users} meId={ctx.meId} />}
      {m.inReplyTo && !inTrack && (
        <button className="in-reply" onClick={() => onTrack?.(m.inReplyTo!.messageId)} title="Open the side-track">
          <Icon name="branch" size={13} />Replied in a side-track to {m.inReplyTo.authorId === ctx.meId ? 'you' : ctx.users.get(m.inReplyTo.authorId)?.displayName ?? 'someone'}
        </button>
      )}
      {m.e2e === 'locked' ? (
        <div className="msg-text locked"><Icon name="lock" size={13} />This message was sent before this device was set up. It appears once one of your other devices is online.</div>
      ) : m.meetCard ? <MeetCardView m={m as Message} />
        : m.nib ? <Suspense fallback={<div className="nib-card loading"><span className="spinner" /></div>}><NibMessageCard m={m as Message} meId={ctx.meId} users={ctx.users} /></Suspense>
        : isBotCard(m) ? <BotCard m={m} conv={ctx.conv} meId={ctx.meId} users={ctx.users} />
        : m.form ? <FormCard m={m} meId={ctx.meId} users={ctx.users} /> : m.poll ? <PollCard m={m} meId={ctx.meId} users={ctx.users} />
        : m.decision ? <DecisionCard m={m as Message} meId={ctx.meId} users={ctx.users} />
        : m.ref ? <RefCard m={m as Message} users={ctx.users} meId={ctx.meId} onView={ctx.view} /> : sticker ? (
        <div className="sticker-body"><StickerImg id={sticker} size={ctx.cards ? 112 : 132} /></div>
      ) : editing ? (
        <EditBox m={m} ctx={ctx} onDone={() => setEditing(false)} />
      ) : (
        m.body ? (
          <div className={`msg-text selectable${isEmojiOnly(m.body) ? ' big' : ''}`}>
            {m.plain && <PlainMark m={m as Message} users={ctx.users} />}
            {renderBody(m.body, ctx.users, ctx.meId, m.authorId)}
            {m.editedAt && <span className="edited"> (edited)</span>}
            {m.via === 'direct' && <span className="via-direct" title="Passed straight between PCs while the hub was off">sent directly</span>}
            {m.e2e === 'unverified' && <span className="unverified" title="Encrypted, but this device could not confirm which device sent it"><Icon name="warning" size={12} /></span>}
          </div>
        ) : m.plain ? <div className="msg-text"><PlainMark m={m as Message} users={ctx.users} /></div> : null
      )}
      {m.meetLine && !m.meetCard && <span className="meet-line-tag mono" title="Said in the meeting chat, which guests from outside read">MEETING CHAT{m.meetLine.breakout ? ` · ${m.meetLine.breakout.toUpperCase()}` : ''}</span>}
      <MessageFiles files={m.files ?? []} onView={ctx.view} draggableAs={pending ? undefined : (f) => refDragProps({ kind: 'file', convId: m.convId, fileId: f.id, name: f.name }, ctx.users)} />
      {m.actionPoint && !pending && <ApStrip ap={m.actionPoint} users={ctx.users} meId={ctx.meId} />}
      {!pending && !editing && <LinkCards m={m as Message} meId={ctx.meId} inTrack={inTrack} />}
      {!pending && <MsgFlags m={m as Message} />}
      {!pending && !editing && <NibOffer m={m as Message} conv={ctx.conv} meId={ctx.meId} users={ctx.users} />}

      {Object.keys(m.reactions).length > 0 && (
        <div className="reactions">
          {Object.entries(m.reactions).map(([emoji, who]) => (
            <button key={emoji} className={`reaction${who.includes(ctx.meId) ? ' mine' : ''}`} onClick={() => react(emoji)}
              title={who.map((id) => (id === ctx.meId ? 'You' : ctx.users.get(id)?.displayName ?? 'Someone')).join(', ')}>
              <span><EmojiGlyph emoji={emoji} size={16} /></span><span className="n">{who.length}</span>
            </button>
          ))}
          {!pending && (
            <button className="reaction-count" title="Reaction insights" aria-label={`Reaction insights: ${Object.values(m.reactions).reduce((n, w) => n + w.length, 0)} stamps`} onClick={() => setDialog('insights')}>
              <Icon name="insight" size={13} /><span className="mono">{Object.values(m.reactions).reduce((n, w) => n + w.length, 0)}</span>
            </button>
          )}
        </div>
      )}

      {!inTrack && m.replyCount > 0 && onTrack && (
        <button className="branch-tag" onClick={() => onTrack(m.id)} aria-label={m.replyCount === 1 ? 'Open the side-track: 1 reply' : `Open the side-track: ${m.replyCount} replies`}>
          <span className="mono">↳ Side-track · {m.replyCount}{m.lastReplyAt ? ` · ${clock(m.lastReplyAt)}` : ''}</span>
        </button>
      )}

      {failed && (
        <div className="send-failed">
          <Icon name="warning" size={14} /><span>{failed}</span>
          <button className="link" onClick={() => retrySend(m as PendingMessage)}>Retry</button>
          <button className="link" onClick={() => discardFailed(m as PendingMessage)}>Discard</button>
        </div>
      )}

      {!pending && !editing && (
        <div className={`spine-tools${stamp || more || keep ? ' open' : ''}`} role="toolbar" aria-label="Tools for this message" aria-orientation="vertical">
          {refPayload && <button className="grip" {...refDragProps(refPayload, ctx.users)} title="Drag to reference in another conversation (or click: Reference in…)" aria-label="Drag to reference" onClick={() => setDialog('reference')}><Icon name="grip" size={13} /></button>}
          {!inTrack && onTrack && <button onClick={() => onTrack(m.id)} title="Side-track" aria-label="Side-track"><Icon name="branch" size={15} /></button>}
          <button ref={stampBtn} className={stamp ? 'on' : undefined} onClick={() => setStamp(stamp ? null : 'chips')} title="Stamp" aria-label="Stamp" aria-haspopup="dialog" aria-expanded={!!stamp}><Icon name="stamp" size={15} /></button>
          <button ref={keepBtn} className={saved ? 'on kept' : undefined} onClick={keepClick}
            title={saved ? `On my Desk · ${KEEP_LABEL[kept?.kind ?? 'keep']}` : 'Keep on my Desk'} aria-label={saved ? `On my Desk · ${KEEP_LABEL[kept?.kind ?? 'keep']}` : 'Keep on my Desk'}
            aria-haspopup="menu" aria-expanded={keep} aria-pressed={saved}><Icon name="drawer" size={15} /></button>
          <button onClick={() => setDialog('remind')} title="Remind me" aria-label="Remind me"><Icon name="alarm" size={15} /></button>
          <button ref={moreBtn} onClick={() => { setMore(!more); setPinFor(false); }} title="More" aria-label="More" aria-haspopup="menu" aria-expanded={more}><Icon name="more" size={15} /></button>
          {stamp && (
            <Popover anchor={stampBtn.current} onClose={() => setStamp(null)} className={stamp === 'picker' ? 'emoji-pop-wrap' : 'menu stamp-fly'} align="right">
              {stamp === 'picker' ? <EmojiPicker onPick={(e) => react(e)} onClose={() => setStamp(null)} /> : (
                <>
                  <div className="menu-label label">Stamps</div>
                  <div className="stamp-row">
                    {stamps.map((e) => (
                      <button key={e} className={`stamp${(m.reactions[e] ?? []).includes(ctx.meId) ? ' on' : ''}`} title={`Stamp ${e}`} aria-label={`Stamp ${e}`} onClick={() => react(e)}>
                        <EmojiGlyph emoji={e} size={18} />
                      </button>
                    ))}
                    <button className="stamp any" title="More stamps" aria-label="More stamps" onClick={() => setStamp('picker')}><Icon name="plus" size={15} /></button>
                  </div>
                </>
              )}
            </Popover>
          )}
          {keep && saved && (
            <Popover anchor={keepBtn.current} onClose={() => setKeep(false)} className="menu keep-menu" align="right">
              <KeepMenu m={m as Message} onClose={() => setKeep(false)} />
            </Popover>
          )}
          {more && (
            <Popover anchor={moreBtn.current} onClose={() => close()} className="menu msg-menu" align="right">
              <div className="menu-label label">Send on</div>
              <button role="menuitem" onClick={() => close(() => setDialog('forward'))}><Icon name="forward" size={16} />Forward</button>
              {refPayload && <button role="menuitem" onClick={() => close(() => setDialog('reference'))}><Icon name="reference" size={16} />Reference in…</button>}
              {m.body && <button role="menuitem" onClick={() => close(() => window.dispatchEvent(new CustomEvent('dex-quote', { detail: { key: tlKey(m.convId, inTrack ? m.parentId : null), text: quoteOf(m, ctx.users) } })))}><Icon name="reply" size={16} />Quote</button>}
              {ctx.conv.kind === 'space' && !mine && author?.role !== 'bot' && (
                <button role="menuitem" onClick={() => close(() => {
                  void window.dex.request('conv.create', { kind: 'direct', members: [m.authorId] }).then((c) => {
                    addConversation(c);
                    openWithQuote(c.id, quoteOf(m, ctx.users));
                  }).catch((e: Error) => toast(e.message, true));
                })}><Icon name="direct" size={16} />Take to Direct</button>
              )}
              {canTakeNamed && (
                <button role="menuitem" onClick={() => close(() => {
                  void window.dex.request('conv.create', { kind: 'direct', members: named }).then((c) => {
                    addConversation(c);
                    openWithQuote(c.id, quoteOf(m, ctx.users));
                  }).catch((e: Error) => toast(e.message, true));
                })}><Icon name="people" size={16} />Take to Direct with the people named<span className="menu-note mono">{named.length + 1}</span></button>
              )}
              {canFork && <button role="menuitem" onClick={() => close(() => setDialog('fork'))}><Icon name="grid" size={16} />Start a Space from this</button>}
              <div className="menu-label label">Keep</div>
              {m.pinned ? (
                <button role="menuitem" onClick={() => close(() => void act(window.dex.request('msg.pin', { messageId: m.id, pinned: false }), 'Unpinned for everyone'))}>
                  <Icon name="pin" size={16} />Unpin for everyone{m.pinnedUntil ? <span className="menu-note mono">{pinEnd(m.pinnedUntil)}</span> : null}
                </button>
              ) : (
                <>
                  <button role="menuitem" aria-expanded={pinFor} onClick={() => setPinFor(!pinFor)}><Icon name="pin" size={16} />Pin for everyone<Icon name="chevron" size={13} className={`menu-caret${pinFor ? ' open' : ''}`} /></button>
                  {pinFor && (
                    <div className="pin-for" role="group" aria-label="How long to pin it">
                      {PIN_FOR.map((o) => <button key={o.id} role="menuitem" autoFocus={o.id === 'day'} onClick={() => pin(o.until())}>{o.label}</button>)}
                    </div>
                  )}
                </>
              )}
              {!guest && !inTrack && !m.parentId && !m.actionPoint && !m.meetCard && !m.poll && !m.form && !m.decision && m.e2e !== 'locked' && (
                <button role="menuitem" onClick={() => close(() => setDialog('action'))}><Icon name="action" size={16} />Make an action point</button>
              )}
              <button role="menuitem" onClick={() => close(() => { void navigator.clipboard.writeText(`dexconnect://message/${m.convId}/${m.id}`); toast('Reference copied: paste it anywhere in Dexterity Connect'); })}><Icon name="open" size={16} />Copy reference</button>
              {m.body && !sticker && <button role="menuitem" onClick={() => close(() => { void navigator.clipboard.writeText(m.body); toast('Copied'); })}><Icon name="copy" size={16} />Copy text</button>}
              {!inTrack && !m.parentId && <>
                <div className="menu-label label">Later</div>
                <button role="menuitem" onClick={() => close(() => void act(markUnreadFrom(m), 'Left unread from here'))}><Icon name="unread" size={16} />Come back to this</button>
              </>}
              {actions.length > 0 && m.e2e !== 'locked' && <>
                <div className="menu-label label">Integrations</div>
                {actions.map((a) => (
                  <button key={a.id} role="menuitem" title={`${a.label} · ${a.botName}`} onClick={() => close(() => void runAction(a, m as Message, ctx.conv, toast))}>
                    <Icon name="send" size={16} /><span className="menu-text">{a.label}</span><span className="menu-note" translate="no">{a.botName}</span>
                  </button>
                ))}
              </>}
              <div className="menu-label label">This message</div>
              {canEdit && <button role="menuitem" onClick={() => close(() => setEditing(true))}><Icon name="edit" size={16} />Edit<span className="kbd">{keyHint(keyFor('editLast'))}</span></button>}
              {mine && receiptsOn && ctx.conv.members.length > 1 && <button role="menuitem" onClick={() => close(() => setDialog('readers'))}><Icon name="eye" size={16} />Who has seen it</button>}
              <button role="menuitem" onClick={() => close(() => setDialog('insights'))}><Icon name="insight" size={16} />Reaction insights</button>
              {!mine && !!m.body && !sticker && !m.ref && !m.poll && !m.form && !m.decision && m.e2e !== 'locked' && <button role="menuitem" onClick={() => close(() => setDialog('restyle'))}><Icon name="restyle" size={16} />Restyle a copy</button>}
              {!inTrack && <button role="menuitem" onClick={() => close(() => ctx.select(m.id))}><Icon name="check" size={16} />Pick several</button>}
              {!mine && author?.role !== 'bot' && <button role="menuitem" onClick={() => close(() => setDialog('report'))}><Icon name="warning" size={16} />Report to administrators…</button>}
              {canDelete && <><div className="menu-sep" /><button role="menuitem" className="danger" onClick={() => close(() => {
                if (!mine) { setDialog('remove'); return; }
                void confirmAction({ title: 'Delete this message for everyone?', confirm: 'Delete', danger: true }).then((ok) => { if (ok) void act(window.dex.request('msg.delete', { messageId: m.id })); });
              })}><Icon name="trash" size={16} />{mine ? 'Delete' : 'Remove…'}</button></>}
            </Popover>
          )}
        </div>
      )}
      {saved && <span className="kept-corner" title={`Kept on your Desk · ${KEEP_LABEL[kept?.kind ?? 'keep']}`} />}
      {m.pinned && <span className="pin-flag" title={m.pinnedUntil ? `Pinned for everyone · ${pinEnd(m.pinnedUntil)}` : 'Pinned for everyone'}><Icon name="pin" size={12} /></span>}
      {dialog === 'remind' && <RemindDialog message={m} users={ctx.users} meId={ctx.meId} onClose={() => setDialog(null)} />}
      {dialog === 'readers' && <ReadersDialog m={m as Message} ctx={ctx} onClose={() => setDialog(null)} />}
      {(dialog === 'report' || dialog === 'remove') && <ReasonDialog kind={dialog} m={m as Message} ctx={ctx} onClose={() => setDialog(null)} />}
      {dialog === 'forward' && <ForwardDialog message={m} users={ctx.users} meId={ctx.meId} online={ctx.online} onClose={() => setDialog(null)} />}
      {dialog === 'fork' && <StartSpaceDialog m={m as Message} users={ctx.users} onClose={() => setDialog(null)} />}
      {dialog === 'insights' && <ReactionInsightsPanel messageId={m.id} onClose={() => setDialog(null)} />}
      {dialog === 'restyle' && <RestyleSheet mode="copy" text={readable(m.body, ctx.users)} style="concise" users={ctx.users} onClose={() => setDialog(null)} />}
      {dialog === 'reference' && refPayload && <ReferenceDialog payload={refPayload} users={ctx.users} meId={ctx.meId} onClose={() => setDialog(null)} />}
      {dialog === 'action' && <ActionDialog m={m as Message} conv={ctx.conv} users={ctx.users} meId={ctx.meId} onClose={() => setDialog(null)} />}
    </div>
  );
}

function EditBox({ m, ctx, onDone }: { m: AnyMessage; ctx: Ctx; onDone: () => void }) {
  const toast = useToast();
  const [text, setText] = useState(() => toEditable(m.body, ctx.users));
  // Space references in the message keep pointing at their Spaces while it is edited
  const refs = useMemo(() => [...m.body.matchAll(SPACE_REF_RE)].map((x) => ({ id: x[1], name: spaceName(x[1]) ?? '' })).filter((x) => x.name), [m.body]);
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(ref, text);
  useEffect(() => { const el = ref.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, []);
  const save = async () => {
    const body = toWire(text, ctx.users, ctx.conv, refs);
    if (!body.trim()) return;
    if (body === m.body) { onDone(); return; }
    try { await window.dex.request('msg.edit', { messageId: m.id, body }); onDone(); } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <div className="edit-box">
      <textarea ref={ref} className="input" value={text} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void save(); } if (e.key === 'Escape') { e.preventDefault(); onDone(); } }} />
      <div className="edit-hint faint">Enter to save · Esc to cancel</div>
    </div>
  );
}

// ------------------------------------------------------------------ writing
/** "Priya is writing", with a pen stroke drawing along the spine. */
function WritingLine({ k, users }: { k: string; users: Map<string, PublicUser> }) {
  const typing = useChat((s) => s.typing.get(k));
  const names = typing ? [...typing.keys()].map((id) => users.get(id)?.displayName.split(' ')[0] ?? 'Someone') : [];
  return (
    <div className="writing-line" aria-live="polite">
      {names.length > 0 && <><span className="pen" aria-hidden="true"><i /></span>{names.length === 1 ? `${names[0]} is writing` : names.length === 2 ? `${names[0]} and ${names[1]} are writing` : 'Several people are writing'}</>}
    </div>
  );
}

// ------------------------------------------------------------------ the Dock (composer)
/** Lines the Dock grows to before it scrolls: about 260 px, or two fifths of the window on a short screen (a phone keeps its timeline in view). */
const dockLines = () => Math.max(4, Math.min(12, Math.floor((window.innerHeight * 0.4) / 20)));

/** Stored bodies use <@id> and <#space>; while typing people see @Name and #Space name. */
function toEditable(body: string, users: Map<string, PublicUser>): string {
  // share paths with this PC's drive letters, as the writer typed them (toWire stores them as UNC again)
  return toLocalText(body).replace(/<@all>/g, '@everyone').replace(/<@([0-9A-Z]{26})>/g, (_, id: string) => `@${users.get(id)?.displayName ?? 'someone'}`)
    .replace(SPACE_REF_RE, (x, id: string) => { const n = spaceName(id); return n ? `#${n}` : x; });
}

function toWire(text: string, users: Map<string, PublicUser>, conv: Conversation, spaces: Array<{ id: string; name: string }> = []): string {
  let out = text;
  // Spaces chosen from the # list (longest names first, so "Site team (Jamnagar)" wins over "Site team")
  for (const sp of [...spaces].sort((a, b) => b.name.length - a.name.length)) out = out.split(`#${sp.name}`).join(`<#${sp.id}>`);
  const members = conv.members.map((id) => users.get(id)).filter(Boolean) as PublicUser[];
  // longest names first so "Priya Raman" wins over "Priya"
  for (const u of members.sort((a, b) => b.displayName.length - a.displayName.length)) {
    out = out.split(`@${u.displayName}`).join(`<@${u.id}>`);
  }
  if (conv.kind === 'space') out = out.replace(/@everyone\b/g, '<@all>');
  // this PC's mapped drive letters become the share's UNC path, the same for every reader
  return toShareable(out).trim();
}

const FORMATS: Array<[string, React.ReactNode, string]> = [
  ['**bold**', <b key="b">bold</b>, 'Ctrl+B'], ['*italic*', <i key="i">italic</i>, 'Ctrl+I'], ['++underline++', <u key="u">underline</u>, 'Ctrl+U'],
  ['~~strike~~', <s key="s">strike</s>, 'Ctrl+5'], ['`code`', <code key="c" className="md-code">code</code>, ''], ['[text](url)', <span key="l" className="md-link">text</span>, 'Ctrl+K'],
  ['# Heading', <b key="h">Heading</b>, ''], ['> quote', <span key="q" style={{ borderLeft: '3px solid var(--stroke-strong)', paddingLeft: 6 }}>quote</span>, ''],
  ['- item  1. item', <span key="li">• item</span>, ''], ['  - nested', <span key="n" style={{ paddingLeft: 12 }}>◦ nested</span>, ''], ['- [ ] task', <span key="t">☐ task</span>, ''],
  ['```js … ```', <code key="cb" className="md-code">code block</code>, ''], ['---', <span key="r" style={{ display: 'inline-block', width: 60, borderTop: '1px solid var(--stroke-strong)' }} />, ''],
];

function Dock({ convId, parentId, ctx, live, placeholder, direct = false }: { convId: string; parentId: string | null; ctx: Ctx; live: boolean; placeholder: string; direct?: boolean }) {
  const key = tlKey(convId, parentId);
  const [text, setText] = useState(() => chatState().drafts.get(key) ?? '');
  const [mention, setMention] = useState<{ q: string; start: number } | null>(null);
  const [mIndex, setMIndex] = useState(0);
  /** Typing #: tags people use and Spaces you can see. */
  const [hash, setHash] = useState<{ q: string; start: number } | null>(null);
  const [hIndex, setHIndex] = useState(0);
  const [hashTags, setHashTags] = useState<Array<{ tag: string; count: number }>>([]);
  const [openList, setOpenList] = useState<Conversation[]>([]);
  /** Spaces chosen from the # list in this draft, sent as references. */
  const picked = useRef<Array<{ id: string; name: string }>>([]);
  const [stickers, setStickers] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [emoji, setEmoji] = useState(false);
  /** In a side-track: echo the reply in the conversation too. */
  const [alsoToConv, setAlsoToConv] = useState(false);
  const [mdHelp, setMdHelp] = useState(false);
  const mdBtn = useRef<HTMLButtonElement>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dockDialog, setDockDialog] = useState<'poll' | 'schedule' | 'remind' | 'help' | 'form' | 'decision' | null>(null);
  const [restyling, setRestyling] = useState<RestyleStyle | null>(null);
  /** References dropped on the Dock, sent after the text. */
  const [refs, setRefs] = useState<RefPayload[]>([]);
  const dockDrop = useRefTarget({ kind: 'dock', convId, key });
  const [addMenu, setAddMenu] = useState(false);
  const [sendMenu, setSendMenu] = useState(false);
  const sendMore = useRef<HTMLButtonElement>(null);
  const [clipMode, setClipMode] = useState<'camera' | 'screen' | null>(null);
  const [recording, setRecording] = useState(false);
  const addBtn = useRef<HTMLButtonElement>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [botCmds, setBotCmds] = useState<CommandInfo[]>([]);
  const slashQuery = /^\/([\w-]*)$/.exec(text)?.[1]?.toLowerCase() ?? null;
  const slashList = slashQuery === null ? [] : uniqueCommands(BUILT_INS, botCmds).filter((c) => c.command.startsWith(slashQuery)).slice(0, 8);
  useEffect(() => { if (slashQuery !== null) void loadBotCommands().then(setBotCmds); }, [slashQuery !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  const scheduledAll = useDesk((s) => s.scheduled);
  const scheduledHere = useMemo(() => [...scheduledAll.values()].filter((x) => x.convId === convId && (x.parentId ?? null) === parentId).sort((a, b) => a.sendAt - b.sendAt), [scheduledAll, convId, parentId]);
  const toast = useToast();
  const ref = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const canAttach = filesSupported() && live && !direct;

  const addFiles = (all: File[]) => {
    if (!all.length || !canAttach) return;
    const limit = policyNow().maxUploadMb;
    const files = all.filter((f) => f.size <= limit * 1024 * 1024);
    if (files.length < all.length) {
      const max = limit >= 1024 ? `${limit / 1024} GB` : `${limit} MB`;
      toast(all.length - files.length === 1 ? `A file is larger than the office limit of ${max}.` : `${all.length - files.length} files are larger than the office limit of ${max}.`, true);
    }
    if (!files.length) return;
    const room = 20 - attachments.length;
    const fresh = startUploads(files.slice(0, room), (k, patch) =>
      setAttachments((list) => (patch === null ? list.filter((a) => a.key !== k) : list.map((a) => (a.key === k ? { ...a, ...patch } : a)))), convId);
    setAttachments((list) => [...list, ...fresh]);
    ref.current?.focus();
  };
  useEffect(() => {
    const onQuote = (e: Event) => {
      const d = (e as CustomEvent).detail as { key: string; text: string; taken?: boolean };
      if (d.key !== key) return;
      d.taken = true;
      setText((t) => { const v = `${d.text}${t}`; setDraft(key, v); return v; });
      requestAnimationFrame(() => { const el = ref.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
    };
    window.addEventListener('dex-quote', onQuote);
    return () => window.removeEventListener('dex-quote', onQuote);
  }, [key]);
  useEffect(() => {
    // a folder dropped on the Pane: its path at the end of the draft
    const onInsert = (e: Event) => {
      const d = (e as CustomEvent).detail as { key: string; text: string };
      if (d.key !== key) return;
      setText((t) => { const v = t && !/\s$/.test(t) ? `${t} ${d.text}` : `${t}${d.text}`; setDraft(key, v); return v; });
      requestAnimationFrame(() => { const el = ref.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
    };
    window.addEventListener('dex-insert', onInsert);
    return () => window.removeEventListener('dex-insert', onInsert);
  }, [key]);
  useEffect(() => {
    const onAttach = (e: Event) => { const d = (e as CustomEvent).detail as { key: string; files: File[] }; if (d.key === key) addFiles(d.files); };
    window.addEventListener('dex-attach', onAttach);
    return () => window.removeEventListener('dex-attach', onAttach);
  });
  useEffect(() => () => { for (const a of attachments) if (a.preview) URL.revokeObjectURL(a.preview); }, [key]);
  useEffect(() => {
    setRefs([]);
    const onRef = (e: Event) => {
      const d = (e as CustomEvent).detail as { key: string; payload: RefPayload };
      if (d.key !== key) return;
      setRefs((list) => (list.some((x) => JSON.stringify(x) === JSON.stringify(d.payload)) || list.length >= 5 ? list : [...list, d.payload]));
      ref.current?.focus();
    };
    window.addEventListener('dex-ref-attach', onRef);
    return () => window.removeEventListener('dex-ref-attach', onRef);
  }, [key]);
  const uploading = attachments.some((a) => !a.info && !a.error);
  const ready = attachments.filter((a) => a.info);

  useEffect(() => { setText(chatState().drafts.get(key) ?? ''); setMention(null); setHash(null); picked.current = []; ref.current?.focus(); }, [key]);
  // # suggestions: tags from the hub (as you type), and Spaces you are in or could join
  const hashOn = hash !== null;
  useEffect(() => { if (hashOn) void openSpaces().then(setOpenList); }, [hashOn]);
  const hashQ = hash?.q ?? null;
  useEffect(() => {
    if (hashQ === null) return;
    let live = true;
    const t = setTimeout(() => {
      void window.dex.request('tags.top', hashQ ? { prefix: hashQ } : {}).then((r) => { if (live) setHashTags(r); }).catch(() => { if (live) setHashTags([]); });
    }, 120);
    return () => { live = false; clearTimeout(t); };
  }, [hashQ]);
  const hashList = useMemo(() => {
    if (!hash) return [];
    const q = hash.q.toLowerCase();
    const mineSpaces = [...chatState().conversations.values()].filter((c) => c.kind === 'space' && c.joined && !c.archived);
    const seen = new Set(mineSpaces.map((c) => c.id));
    const spaces = [...mineSpaces, ...openList.filter((c) => !seen.has(c.id))]
      .filter((c) => (c.name ?? '').toLowerCase().includes(q))
      .sort((a, b) => Number(!(a.name ?? '').toLowerCase().startsWith(q)) - Number(!(b.name ?? '').toLowerCase().startsWith(q)) || (a.name ?? '').localeCompare(b.name ?? ''))
      .slice(0, 5).map((c) => ({ kind: 'space' as const, id: `s-${c.id}`, conv: c, joined: seen.has(c.id) }));
    const tags = hashTags.filter((t) => t.tag.startsWith(q)).slice(0, 6).map((t) => ({ kind: 'tag' as const, id: `t-${t.tag}`, tag: t.tag, count: t.count }));
    return [...tags, ...spaces];
  }, [hash, hashTags, openList]);
  // grows line by line (then scrolls; the shared helper marks a grown box .grown), and changes shape
  // once it holds more than one line. The shape follows the text, not the width: once several lines
  // it stays so until the text is cleared or clearly shorter, so a Dock that widens as it changes
  // shape on a phone never flips back and forth.
  useAutoGrow(ref, text, dockLines());
  const [multi, setMulti] = useState(false);
  const multiAt = useRef(0);
  useLayoutEffect(() => {
    const grown = !!ref.current?.classList.contains('grown') || text.includes('\n');
    if (!multi && grown) { multiAt.current = text.length; setMulti(true); }
    else if (multi && (!text || (!grown && text.length < multiAt.current * 0.85))) setMulti(false);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Where the caret goes once a chosen suggestion is in the text (before the next key press lands). */
  const caretTo = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && caretTo.current !== null) { el.focus(); el.setSelectionRange(caretTo.current, caretTo.current); caretTo.current = null; }
  }, [text]);

  const candidates = useMemo(() => {
    if (!mention) return [];
    const q = mention.q.toLowerCase();
    const people = ctx.conv.members.filter((id) => id !== ctx.meId).map((id) => ctx.users.get(id)).filter(Boolean) as PublicUser[];
    const list: Array<{ id: string; label: string; user?: PublicUser }> = people
      .filter((u) => u.displayName.toLowerCase().includes(q) || u.account.toLowerCase().includes(q))
      .slice(0, 6).map((u) => ({ id: u.id, label: u.displayName, user: u }));
    if (ctx.conv.kind === 'space' && 'everyone'.startsWith(q)) list.push({ id: 'all', label: 'everyone' });
    return list;
  }, [mention, ctx]);

  const update = (v: string, caret: number) => {
    setText(v);
    setDraft(key, v);
    if (v.trim()) notifyTyping(convId, parentId);
    const before = v.slice(0, caret);
    const m = before.match(/(?:^|\s)@([\w.\- ]{0,24})$/);
    if (m && !m[1].includes('  ')) { setMention({ q: m[1], start: caret - m[1].length - 1 }); setMIndex(0); } else setMention(null);
    const h = m ? null : before.match(/(?:^|\s)#([\p{L}\p{N}_-]{0,48})$/u);
    if (h) { setHash((cur) => (cur?.q === h[1] ? cur : { q: h[1], start: caret - h[1].length - 1 })); setHIndex(0); } else setHash(null);
  };

  const pickHash = (c: (typeof hashList)[number]) => {
    const el = ref.current!;
    const caret = el.selectionStart;
    const ins = c.kind === 'tag' ? `#${c.tag}` : `#${c.conv.name ?? ''}`;
    if (c.kind === 'space' && c.conv.name) picked.current = [...picked.current.filter((x) => x.id !== c.conv.id), { id: c.conv.id, name: c.conv.name }];
    const v = `${text.slice(0, hash!.start)}${ins} ${text.slice(caret)}`;
    setText(v);
    setDraft(key, v);
    setHash(null);
    caretTo.current = hash!.start + ins.length + 1;
  };
  /** The draft as sent: @names and chosen #Spaces become references. */
  const wire = () => toWire(text, ctx.users, ctx.conv, picked.current);

  const pick = (c: { label: string }) => {
    const el = ref.current!;
    const caret = el.selectionStart;
    const v = `${text.slice(0, mention!.start)}@${c.label} ${text.slice(caret)}`;
    setText(v);
    setDraft(key, v);
    setMention(null);
    caretTo.current = mention!.start + c.label.length + 2;
  };

  // edits go through the browser's own editing, so Ctrl+Z undoes them like typing
  const wrap = (mark: string, end = mark) => {
    const el = ref.current!;
    const { selectionStart: a, selectionEnd: b } = el;
    insertAtCursor(el, `${mark}${el.value.slice(a, b)}${end}`);
    el.setSelectionRange(a + mark.length, b + mark.length);
  };
  const link = () => {
    const el = ref.current!;
    const { selectionStart: a, selectionEnd: b } = el;
    const sel = el.value.slice(a, b);
    const isUrl = /^https?:\/\/\S+$/.test(sel);
    insertAtCursor(el, isUrl ? `[link text](${sel})` : `[${sel || 'link text'}](https://)`);
    if (isUrl) el.setSelectionRange(a + 1, a + 10);
    else el.setSelectionRange(a + (sel || 'link text').length + 3, a + (sel || 'link text').length + 11);
  };

  const clear = () => { setText(''); setDraft(key, ''); setMention(null); setHash(null); picked.current = []; };
  // a line starting /action, AP: or → is an action point: read as it is typed, logged on Enter
  const apWords = !parentId && !direct && ctx.users.get(ctx.meId)?.role !== 'guest' ? actionWords(text) : null;
  const apPool = useMemo(() => ownerPool(ctx.conv, ctx.users), [ctx.conv, ctx.users]);
  const [apDraft, apPick, apReset] = useActionDraft(apWords ?? '', apPool, ctx.meId);
  const sendRefs = async (list: RefPayload[]) => {
    for (const p of list) if (!(await shareRef(convId, p, parentId))) return;
  };
  const send = () => {
    if (apWords !== null && live && !ready.length) {
      const typed = text;
      clear();
      void logAction(convId, { ...apDraft, source: 'chat' }).then((a) => { toast(`${apRef(a.n)} logged · ${ownerText(a, ctx.users, ctx.meId)}`); apReset(); })
        .catch((e: Error) => { toast(e.message, true); setText(typed); setDraft(key, typed); });
      return;
    }
    const body = wire();
    if (refs.length && live && !uploading && !direct && !text.startsWith('/')) {
      const list = refs;
      setRefs([]);
      if (body || ready.length) {
        void sendMessage(convId, body, parentId, ready.map((a) => a.info!), { alsoToConv });
        for (const a of attachments) if (a.preview) URL.revokeObjectURL(a.preview);
        setAttachments([]);
        clear();
      }
      void sendRefs(list);
      return;
    }
    if ((!body && !ready.length) || !live || uploading) return;
    if (text.startsWith('/') && !ready.length) {
      // clear the Dock now, not when the command finishes: a command that waits on the hub (/got, a bot's
      // command) must not wipe what the person has typed since. /schedule keeps the text for its dialog.
      if (!/^\/schedule\b/i.test(text)) clear();
      void runSlash(body, {
        convId, parentId, meId: ctx.meId, displayName: ctx.users.get(ctx.meId)?.displayName ?? 'Someone', toast,
        send: (b) => void sendMessage(convId, b, parentId),
        open: (d) => { if (d === 'meet') window.dispatchEvent(new CustomEvent('dex-plan', { detail: convId })); else setDockDialog(d); },
      }).then((handled) => {
        // not a command (//text, or an unknown word starting with /): it goes as a message
        if (!handled) void sendMessage(convId, body.replace(/^\/\//, '/'), parentId, [], { alsoToConv });
      });
      return;
    }
    void sendMessage(convId, body, parentId, ready.map((a) => a.info!), { alsoToConv });
    for (const a of attachments) if (a.preview) URL.revokeObjectURL(a.preview);
    setAttachments([]);
    clear();
  };
  const canLater = (!!text.trim() || ready.length > 0) && live && !direct && !uploading;

  const schedule = async (at: number) => {
    const body = wire();
    try {
      await window.dex.request('sched.create', { convId, body, parentId: parentId ?? undefined, files: ready.map((a) => a.info!.id), sendAt: at });
      toast(`Goes out ${describeWhen(at)}`);
      for (const a of attachments) if (a.preview) URL.revokeObjectURL(a.preview);
      setAttachments([]);
      clear();
      setDockDialog(null);
    } catch (e) { toast((e as Error).message, true); }
  };

  const onKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (slashList.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex((i) => (i + 1) % slashList.length); return; }
      if (e.key === 'ArrowUp' && !e.ctrlKey) { e.preventDefault(); setSlashIndex((i) => (i - 1 + slashList.length) % slashList.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.ctrlKey && slashList[slashIndex] && slashList[slashIndex].command !== slashQuery)) {
        e.preventDefault();
        const v = `/${slashList[Math.min(slashIndex, slashList.length - 1)].command} `;
        setText(v); setDraft(key, v); setSlashIndex(0);
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); clear(); return; }
    }
    if (hash && hashList.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setHIndex((i) => (i + 1) % hashList.length); return; }
      if (e.key === 'ArrowUp' && !e.ctrlKey) { e.preventDefault(); setHIndex((i) => (i - 1 + hashList.length) % hashList.length); return; }
      if ((e.key === 'Enter' && !e.ctrlKey && !e.shiftKey) || e.key === 'Tab') { e.preventDefault(); pickHash(hashList[Math.min(hIndex, hashList.length - 1)]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setHash(null); return; }
    }
    if (mention && candidates.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMIndex((i) => (i + 1) % candidates.length); return; }
      if (e.key === 'ArrowUp' && !e.ctrlKey) { e.preventDefault(); setMIndex((i) => (i - 1 + candidates.length) % candidates.length); return; }
      if ((e.key === 'Enter' && !e.ctrlKey) || e.key === 'Tab') { e.preventDefault(); pick(candidates[mIndex]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setMention(null); return; }
    }
    const k = e.key.toLowerCase();
    // the Dock's own shortcuts win over the app's (Ctrl+5 strikes through here, it does not change lens)
    const own = () => { e.preventDefault(); e.stopPropagation(); };
    if (pressed(e.nativeEvent, keyFor('sendLater'))) { own(); if (canLater) setDockDialog('schedule'); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); return; }
    if (pressed(e.nativeEvent, keyFor('editLast'))) {
      const tl = chatState().timelines.get(key);
      const last = [...(tl?.messages ?? [])].reverse().find((m) => m.authorId === ctx.meId && !m.deleted && !('pending' in m) && !!m.body && !m.poll && !m.form && withinEditWindow(m.createdAt));
      if (last) { own(); window.dispatchEvent(new CustomEvent('dex-edit', { detail: last.id })); }
      return;
    }
    if (!e.ctrlKey || e.shiftKey || e.altKey) return;
    if (k === 'b' || k === 'i' || k === 'u') { own(); wrap(k === 'b' ? '**' : k === 'i' ? '*' : '++'); }
    else if (e.key === '5') { own(); wrap('~~'); }
    else if (k === 'k') { own(); link(); }
    else if (e.key === '.') { own(); setEmoji(true); }
  };

  const insertEmoji = (e: string) => {
    const el = ref.current!;
    const pos = el.selectionStart;
    const ins = e.startsWith(':') ? `${pos && !/\s$/.test(text.slice(0, pos)) ? ' ' : ''}${e} ` : e;
    setEmoji(false);
    el.focus();
    el.setSelectionRange(pos, el.selectionEnd);
    insertAtCursor(el, ins);
  };
  const guest = ctx.users.get(ctx.meId)?.role === 'guest';
  const sideEvent = (side: 'notes-new' | 'boards') => window.dispatchEvent(new CustomEvent('dex-side', { detail: { convId, side } }));
  const canScan = canAttach && !!navigator.mediaDevices?.getUserMedia;
  useKeys();

  return (
    <div className="dock-wrap" {...dockDrop.props}>
      {slashList.length > 0 && (
        <ul className="mention-pop slash-pop" role="listbox" aria-label="Commands">
          <li className="slash-head label" role="presentation">Commands</li>
          {slashList.map((c, i) => (
            <li key={c.command} role="option" aria-selected={i === Math.min(slashIndex, slashList.length - 1)} onMouseEnter={() => setSlashIndex(i)}
              onMouseDown={(e) => { e.preventDefault(); const v = `/${c.command} `; setText(v); setDraft(key, v); ref.current?.focus(); }}>
              <span className="slash-name mono">/{c.command}</span>
              <span className="slash-desc">{c.description}</span>
              {c.bot ? <span className="chip accent">Integration</span> : c.hint ? <span className="faint mono slash-hint">{c.hint}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {hash && hashList.length > 0 && !mention && (
        <ul className="mention-pop hash-pop" role="listbox" aria-label="Tags and Spaces">
          {hashList.map((c, i) => (
            <li key={c.id} role="option" aria-selected={i === Math.min(hIndex, hashList.length - 1)} onMouseDown={(e) => { e.preventDefault(); pickHash(c); }} onMouseEnter={() => setHIndex(i)}>
              {c.kind === 'tag' ? <>
                <span className="hash-mark mono" aria-hidden="true">#</span>
                <span className="hash-name" translate="no">{c.tag}</span>
                <span className="faint mono hash-meta">{c.count === 1 ? '1 message' : `${c.count} messages`}</span>
              </> : <>
                <ConvTile c={c.conv} users={ctx.users} meId={ctx.meId} />
                <span className="hash-name" translate="no">{c.conv.name}</span>
                <span className="faint mono hash-meta">{c.joined ? 'Space' : 'Open Space · not in it'}</span>
              </>}
            </li>
          ))}
        </ul>
      )}
      {mention && candidates.length > 0 && (
        <ul className="mention-pop" role="listbox">
          {candidates.map((c, i) => (
            <li key={c.id} role="option" aria-selected={i === mIndex} onMouseDown={(e) => { e.preventDefault(); pick(c); }} onMouseEnter={() => setMIndex(i)}>
              {c.user ? <Avatar user={c.user} presence={presenceFor(c.id)} size="sm" /> : <span className="pal-icon"><Icon name="people" size={14} /></span>}
              <span>{c.label}</span>
              {c.user && <span className="faint mono" style={{ marginLeft: 'auto', fontSize: 11 }}>{c.user.account}</span>}
            </li>
          ))}
        </ul>
      )}
      {apWords !== null && <ActionPreview draft={apDraft} pool={apPool} meId={ctx.meId} onPick={apPick} />}
      <AttachmentTray items={attachments} onRemove={(k) => setAttachments((l) => l.filter((a) => a.key !== k))} />
      <RefChips items={refs} users={ctx.users} onRemove={(i) => setRefs((l) => l.filter((_, j) => j !== i))} />
      {dockDrop.valid && <span className={`ref-drop-label dock-label${dockDrop.over ? ' on' : ''}`}>{dockDrop.over ? 'Drop to reference here' : 'Drop on the Dock to add it to your message'}</span>}
      <div className={`dock${multi ? ' multi' : ''}${text.trim() || (ready.length && !uploading) || refs.length ? ' has-text' : ''}${recording ? ' recording' : ''}${dockDrop.valid ? ' ref-valid' : ''}${dockDrop.over ? ' ref-over' : ''}`}>
        <div className="dock-tools">
          {canAttach && (
            <>
              <button className="icon-btn" title="Attach files (or drop them here)" aria-label="Attach" onClick={() => picker.current?.click()}><Icon name="paperclip" size={18} /></button>
              <input ref={picker} type="file" multiple hidden onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
            </>
          )}
          {live && !direct && <VoiceRecorder convId={convId} parentId={parentId} onActive={setRecording} />}
          {!recording && <button ref={addBtn} className="icon-btn" title="Insert" aria-label="Insert" disabled={!live} onClick={() => setAddMenu(!addMenu)} aria-haspopup="menu" aria-expanded={addMenu}><Icon name="plus" size={18} /></button>}
          {addMenu && (
            <Popover anchor={addBtn.current} onClose={() => setAddMenu(false)} className="menu add-menu" align="start">
              <div className="menu-label label">Insert</div>
              <button role="menuitem" onClick={() => { setAddMenu(false); setEmoji(true); }}><Icon name="smile" size={16} />Emoji<span className="kbd">Ctrl .</span></button>
              {!direct && <>
                {clipsSupported() && <button role="menuitem" onClick={() => { setAddMenu(false); setClipMode('camera'); }}><Icon name="video" size={16} />Video message</button>}
                {screenClipsSupported() && <button role="menuitem" onClick={() => { setAddMenu(false); setClipMode('screen'); }}><Icon name="screen" size={16} />Screen recording</button>}
                <button role="menuitem" onClick={() => { setAddMenu(false); setDockDialog('poll'); }}><Icon name="poll" size={16} />Poll</button>
                {!guest && <button role="menuitem" onClick={() => { setAddMenu(false); setDockDialog('form'); }}><Icon name="list" size={16} />Form</button>}
                {!guest && <button role="menuitem" onClick={() => { setAddMenu(false); setDockDialog('decision'); }}><Icon name="decision" size={16} />Decision</button>}
                <button role="menuitem" onClick={() => { setAddMenu(false); sideEvent('notes-new'); }}><Icon name="doc" size={16} />Note</button>
                <button role="menuitem" onClick={() => { setAddMenu(false); sideEvent('boards'); }}><Icon name="drawing" size={16} />Whiteboard</button>
                {!guest && <button role="menuitem" onClick={() => { setAddMenu(false); window.dispatchEvent(new CustomEvent('dex-plan', { detail: convId })); }}><Icon name="calendar" size={16} />Meeting</button>}
                <button role="menuitem" onClick={() => { setAddMenu(false); setStickers(true); }}><Icon name="stamp" size={16} />Stickers</button>
                {canScan && <button role="menuitem" onClick={() => { setAddMenu(false); setScanning(true); }}><Icon name="doc" size={16} />Scan a document</button>}
              </>}
            </Popover>
          )}
          {!recording && <RestyleControl text={text} disabled={!live} onPick={setRestyling} />}
          {emoji && (
            <Popover anchor={addBtn.current ?? ref.current} onClose={() => setEmoji(false)} className="emoji-pop-wrap" align="start">
              <EmojiPicker onClose={() => { setEmoji(false); ref.current?.focus(); }} onPick={insertEmoji} />
            </Popover>
          )}
          {stickers && (
            <Popover anchor={addBtn.current ?? ref.current} onClose={() => setStickers(false)} className="sticker-pop" align="start">
              <StickerSheet onClose={() => { setStickers(false); ref.current?.focus(); }}
                onPick={(st) => { setStickers(false); void sendMessage(convId, `[[sticker:${st.id}]]`, parentId, [], { alsoToConv }); ref.current?.focus(); }} />
            </Popover>
          )}
        </div>
        {clipMode && <ClipRecorder mode={clipMode} convId={convId} parentId={parentId} onClose={() => setClipMode(null)} />}
        {scanning && <Suspense fallback={null}><ScanDialog onClose={() => setScanning(false)} onDone={(file) => { setScanning(false); addFiles([file]); }} /></Suspense>}
        <textarea
          ref={ref}
          hidden={recording}
          rows={1}
          value={text}
          placeholder={live ? placeholder : 'Waiting for the office hub…'}
          maxLength={8000}
          onChange={(e) => update(e.target.value, e.target.selectionStart)}
          onKeyDown={onKey}
          onPaste={(e) => { const files = [...e.clipboardData.files]; if (files.length && canAttach) { e.preventDefault(); addFiles(files); } }}
          aria-label={placeholder}
        />
        {!recording && (
          <span className="send-split">
            <button className="send" onClick={send} disabled={(!text.trim() && !ready.length && !refs.length) || !live || uploading} title={uploading ? 'Waiting for uploads to finish' : 'Send (Enter)'} aria-label="Send">
              <Icon name="dimsend" size={19} />
            </button>
            <button ref={sendMore} className="send-more" onClick={() => setSendMenu(!sendMenu)} disabled={!canLater} aria-label="More ways to send" title="Send later" aria-haspopup="menu" aria-expanded={sendMenu}>
              <Icon name="chevron" size={13} />
            </button>
          </span>
        )}
        {sendMenu && (
          <Popover anchor={sendMore.current} onClose={() => setSendMenu(false)} className="menu send-menu">
            <button role="menuitem" onClick={() => { setSendMenu(false); setDockDialog('schedule'); }}><Icon name="schedule" size={16} />Send later…<span className="kbd">{keyHint(keyFor('sendLater'))}</span></button>
          </Popover>
        )}
      </div>
      {dockDialog === 'form' && <FormBuilder conv={ctx.conv} onClose={() => setDockDialog(null)} />}
      {dockDialog === 'decision' && <DecisionBuilder conv={ctx.conv} parentId={parentId} onClose={() => setDockDialog(null)} />}
      {restyling && <RestyleSheet mode="draft" text={text} style={restyling} users={ctx.users} onClose={() => { setRestyling(null); ref.current?.focus(); }}
        onUse={(v) => { setText(v); setDraft(key, v); requestAnimationFrame(() => { const el = ref.current; if (el) { el.focus(); el.setSelectionRange(v.length, v.length); } }); }} />}
      {dockDialog === 'poll' && <PollDialog conv={ctx.conv} parentId={parentId} onClose={() => setDockDialog(null)} />}
      {dockDialog === 'remind' && <RemindDialog users={ctx.users} meId={ctx.meId} onClose={() => setDockDialog(null)} />}
      {dockDialog === 'help' && (
        <Dialog title="Slash commands" onClose={() => setDockDialog(null)}>
          <div className="slash-help">
            {uniqueCommands(BUILT_INS, botCmds).map((c) => (
              <div key={c.command}><span className="mono">/{c.command}</span>{c.hint && <span className="faint mono"> {c.hint}</span>}<span className="muted">{c.description}</span></div>
            ))}
          </div>
          <p className="faint" style={{ fontSize: 12.5, margin: 0 }}>Start a message with // to send a line that begins with a slash.</p>
        </Dialog>
      )}
      {dockDialog === 'schedule' && <ScheduleDialog preview={wire()} users={ctx.users} meId={ctx.meId} onPick={schedule} onClose={() => setDockDialog(null)} />}
      {parentId && (
        <label className="also-conv">
          <input type="checkbox" checked={alsoToConv} onChange={(e) => setAlsoToConv(e.target.checked)} />
          {ctx.conv.kind === 'space' ? 'Echo in the Space' : 'Echo in the conversation'}
        </label>
      )}
      <div className="dock-hint faint">
        {scheduledHere.length > 0 && <span className="sched-note"><Icon name="schedule" size={13} />{scheduledHere.length === 1 ? `1 waiting to go out · ${describeWhen(scheduledHere[0].sendAt)}` : `${scheduledHere.length} waiting to go out`} · see Desk</span>}
        <span>{parentId ? <><b>Enter</b> send · </> : <><b>Enter</b> send · <b>/</b> commands · <b>#</b> tags · <b>Shift+Enter</b> new line{keyFor('editLast') ? <> · <b>{keyText(keyFor('editLast'))}</b> edit last</> : null} · </>}<button ref={mdBtn} className="link" onClick={() => setMdHelp(!mdHelp)}>Formatting</button></span>
        {mdHelp && (
          <Popover anchor={mdBtn.current} onClose={() => setMdHelp(false)} className="menu md-help" align="end">
            <div className="menu-label label">Formatting</div>
            {FORMATS.map(([src, out, k]) => (
              <div key={src} className="md-help-row"><code>{src}</code><span>{out}</span>{k ? <span className="kbd">{k}</span> : <span />}</div>
            ))}
          </Popover>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ sheets
function SideTrack({ ctx, parentId, live, onClose }: { ctx: Ctx; parentId: string; live: boolean; onClose: () => void }) {
  const convId = ctx.conv.id;
  const parent = useChat((s) => s.timelines.get(convId)?.messages.find((m) => m.id === parentId));
  const tl = useChat((s) => s.timelines.get(tlKey(convId, parentId)));
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { void loadLatest(convId, parentId); }, [convId, parentId]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [tl?.messages.length]);
  const author = parent ? ctx.users.get(parent.authorId) : undefined;
  const n = tl?.messages.length ?? 0;
  return (
    <aside className="side-panel side-track" aria-label="Side-track">
      <header className="side-head">
        <span className="label">Side-track <span className="mono">{n === 1 ? '· 1 reply' : `· ${n} replies`}</span></span>
        <button className="icon-btn" onClick={onClose} aria-label="Close side-track"><Icon name="x" size={16} /></button>
      </header>
      <div className="side-body">
        {parent ? (
          <div className="track-parent">
            <div className="run-head">
              <Avatar user={{ id: parent.authorId, displayName: author?.displayName ?? '?' }} size="sm" />
              <span className="run-name" translate={parent.authorId === ctx.meId ? undefined : 'no'} title={parent.authorId === ctx.meId ? undefined : author?.displayName}>{parent.authorId === ctx.meId ? 'You' : author?.displayName}</span>
              <span className="run-time">{clock(parent.createdAt)}</span>
            </div>
            <div className="msg-text selectable">{parent.deleted ? <span className="faint">Message deleted</span> : renderBody(parent.body, ctx.users, ctx.meId)}</div>
          </div>
        ) : <div className="tl-more"><span className="spinner" /></div>}
        <div className="track-replies">
          {(tl?.messages ?? []).map((m) => {
            const u = ctx.users.get(m.authorId);
            return (
              <div key={m.clientId ?? m.id} className={`track-reply${m.authorId === ctx.meId ? ' mine' : ''}`}>
                <div className="run-head">
                  <Avatar user={{ id: m.authorId, displayName: u?.displayName ?? '?' }} size="sm" />
                  <span className="run-name" translate={m.authorId === ctx.meId ? undefined : 'no'} title={m.authorId === ctx.meId ? undefined : u?.displayName}>{m.authorId === ctx.meId ? 'You' : u?.displayName}</span>
                  <span className="run-time">{clock(m.createdAt)}</span>
                </div>
                <MessageItem ctx={ctx} m={m} inTrack />
              </div>
            );
          })}
          <div ref={end} />
        </div>
      </div>
      <WritingLine k={tlKey(convId, parentId)} users={ctx.users} />
      <Dock convId={convId} parentId={parentId} ctx={ctx} live={live} placeholder="Write a reply" />
    </aside>
  );
}

function PinsPanel({ ctx, onClose, onJump }: { ctx: Ctx; onClose: () => void; onJump: (id: string) => void }) {
  const [pins, setPins] = useState<AnyMessage[] | null>(null);
  const version = useChat((s) => s.version);
  useEffect(() => { void window.dex.request('msg.pins', { convId: ctx.conv.id }).then(setPins).catch(() => setPins([])); }, [ctx.conv.id, version]);
  return (
    <aside className="side-panel" aria-label="Pinned messages">
      <header className="side-head"><span className="label">Pinned <span className="mono">· {pins?.length ?? 0}</span></span><button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button></header>
      <div className="side-body">
        {pins === null && <div className="tl-more"><span className="spinner" /></div>}
        {pins?.length === 0 && <div className="empty"><Icon name="pin" size={28} /><span>Pin what everyone here needs to find again.</span></div>}
        {pins?.map((m) => (
          <button key={m.id} className="pin-card" onClick={() => onJump(m.id)}>
            <div className="run-head"><span className="run-name" translate="no" title={ctx.users.get(m.authorId)?.displayName}>{ctx.users.get(m.authorId)?.displayName}</span><span className="run-time">{dayLabel(m.createdAt)} · {clock(m.createdAt)}{m.pinnedUntil ? ` · ${pinEnd(m.pinnedUntil)}` : ''}</span></div>
            <div className="msg-text">{renderBody(m.body, ctx.users, ctx.meId)}</div>
          </button>
        ))}
      </div>
    </aside>
  );
}

function MembersPanel({ ctx, onClose }: { ctx: Ctx; onClose: () => void }) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const c = ctx.conv;
  const members = c.members.map((id) => ctx.users.get(id)).filter(Boolean) as PublicUser[];
  const candidates = [...ctx.users.values()].filter((u) => !c.members.includes(u.id) && u.role !== 'bot');
  const canModerate = ctx.isAdmin || c.createdBy === ctx.meId || c.moderators.includes(ctx.meId);
  const [spaceName, setSpaceName] = useState<string | null>(null);
  return (
    <aside className="side-panel" aria-label="People">
      <header className="side-head"><span className="label">People · {members.length}</span><button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button></header>
      <div className="side-body">
        {c.kind === 'space' && !c.everyone && (
          adding ? (
            <PeoplePicker users={candidates} online={ctx.online} onDone={(ids) => {
              setAdding(false);
              if (ids.length) void window.dex.request('conv.addMembers', { convId: c.id, userIds: ids }).then(() => toast('Added')).catch((e: Error) => toast(e.message, true));
            }} />
          ) : <button className="btn" style={{ marginBottom: 12 }} onClick={() => setAdding(true)}><Icon name="plus" size={15} />Add people</button>
        )}
        {members.sort((a, b) => Number(ctx.online.has(b.id)) - Number(ctx.online.has(a.id))).map((u) => (
          <div key={u.id} className="member-row">
            <Avatar user={u} presence={presenceFor(u.id)} size="sm" />
            <span className="sb-main"><span className="sb-name" translate="no">{u.id === ctx.meId ? `${u.displayName} (you)` : u.displayName}</span><span className="sb-preview">{u.statusText ? `${u.statusEmoji ? `${u.statusEmoji} ` : ''}${u.statusText}` : ctx.online.has(u.id) ? u.title ?? u.account : u.lastSeen ? `Last on ${relativeTime(u.lastSeen)}` : u.title ?? u.account}</span></span>
            {canModerate && c.kind === 'space' && !c.everyone && u.id !== ctx.meId && (
              <button className="icon-btn" title={`Remove ${u.displayName} from this Space`} onClick={() => void confirmAction({ title: `Remove ${u.displayName} from ${c.name}?`, confirm: 'Remove', danger: true }).then((ok) => { if (ok) void window.dex.request('conv.removeMember', { convId: c.id, userId: u.id }).then(() => toast('Removed')).catch((e: Error) => toast(e.message, true)); })}><Icon name="x" size={14} /></button>
            )}
          </div>
        ))}
        {c.kind === 'space' && (ctx.isAdmin || c.createdBy === ctx.meId || c.moderators.includes(ctx.meId)) && <SpaceSettings c={c} users={members} />}
        {c.kind === 'direct' && c.members.length > 2 && ctx.users.get(ctx.meId)?.role !== 'guest' && (
          spaceName === null
            ? <button className="btn" style={{ marginTop: 16 }} onClick={() => setSpaceName('')}><Icon name="grid" size={15} />Make it a Space</button>
            : (
              <form className="to-space" onSubmit={(e) => {
                e.preventDefault();
                if (!spaceName.trim()) return;
                void window.dex.request('conv.toSpace', { convId: c.id, name: spaceName.trim() }).then((nc) => { setSpaceName(null); window.dispatchEvent(new CustomEvent('dex-open', { detail: nc.id })); toast('It is a Space now'); }).catch((err: Error) => toast(err.message, true));
              }}>
                <label className="label" htmlFor="to-space">Name the Space</label>
                <input id="to-space" className="input" autoFocus maxLength={60} value={spaceName} onChange={(e) => setSpaceName(e.target.value)} placeholder="e.g. Project Falcon" />
                <span className="faint" style={{ fontSize: 12 }}>Everyone here stays in it, with the history. New messages are no longer end-to-end encrypted.</span>
                <div className="row-actions"><button type="button" className="btn ghost sm" onClick={() => setSpaceName(null)}>Cancel</button><button className="btn primary sm" disabled={!spaceName.trim()}>Make it a Space</button></div>
              </form>
            )
        )}
        {c.kind === 'space' && !c.everyone && (
          <button className="btn ghost danger" style={{ marginTop: 16 }} onClick={() => void confirmAction({ title: `Leave ${c.name}?`, confirm: 'Leave', danger: true }).then((ok) => { if (ok) void window.dex.request('conv.leave', { convId: c.id }).catch((e: Error) => toast(e.message, true)); })}>Leave this Space</button>
        )}
      </div>
    </aside>
  );
}

function SpaceSettings({ c, users }: { c: Conversation; users: PublicUser[] }) {
  const toast = useToast();
  const act = (p: Promise<unknown>, ok: string) => void p.then(() => toast(ok)).catch((e: Error) => toast(e.message, true));
  return (
    <div className="space-settings">
      <div className="label">Space settings</div>
      <label className="check-line"><input type="checkbox" checked={c.postPolicy === 'moderators'} onChange={(e) => act(window.dex.request('conv.settings', { convId: c.id, postPolicy: e.target.checked ? 'moderators' : 'everyone' }), e.target.checked ? 'Only moderators post now' : 'Everyone can post')} />Announcements: only moderators start messages</label>
      <div className="faint" style={{ fontSize: 12 }}>Moderators can post when announcements are on, pin and remove messages, and change the Space.</div>
      <div className="mod-list">
        {users.filter((u) => u.role !== 'bot').map((u) => (
          <label key={u.id} className="check-line">
            <input type="checkbox" checked={c.moderators.includes(u.id) || u.id === c.createdBy} disabled={u.id === c.createdBy}
              onChange={(e) => act(window.dex.request('conv.settings', { convId: c.id, moderators: e.target.checked ? [...c.moderators, u.id] : c.moderators.filter((x) => x !== u.id) }), 'Moderators updated')} />
            {u.displayName}{u.id === c.createdBy ? ' (created it)' : ''}
          </label>
        ))}
      </div>
      {!c.everyone && <button className="btn" onClick={() => void confirmAction({ title: `Archive ${c.name}? It becomes read-only for everyone until it is restored.`, confirm: 'Archive this Space' }).then((ok) => { if (ok) void act(window.dex.request('conv.archive', { convId: c.id, archived: true }), 'Space archived'); })}><Icon name="archive" size={15} />Archive this Space</button>}
    </div>
  );
}

export function PeoplePicker({ users, online, onDone, initial = [], cta = 'Add' }: { users: PublicUser[]; online: Set<string>; onDone: (ids: string[]) => void; initial?: string[]; cta?: string }) {
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string[]>(initial);
  const shown = users.filter((u) => !q || u.displayName.toLowerCase().includes(q.toLowerCase()) || u.account.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  return (
    <div className="people-picker">
      <input className="input" autoFocus placeholder="Search people" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search people" />
      <div className="picker-list">
        {shown.length === 0 && <div className="faint" style={{ padding: 12 }}>No one to add.</div>}
        {shown.map((u) => (
          <label key={u.id} className={`picker-row${picked.includes(u.id) ? ' on' : ''}`}>
            <input type="checkbox" checked={picked.includes(u.id)} onChange={() => setPicked(picked.includes(u.id) ? picked.filter((x) => x !== u.id) : [...picked, u.id])} />
            <Avatar user={u} presence={presenceFor(u.id)} size="sm" />
            <span className="sb-main"><span className="sb-name">{u.displayName}</span><span className="sb-preview">{u.title ?? u.account}</span></span>
          </label>
        ))}
      </div>
      <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
        <button className="btn ghost" onClick={() => onDone([])}>Cancel</button>
        <button className="btn primary" disabled={!picked.length} onClick={() => onDone(picked)}>{cta}{picked.length ? ` (${picked.length})` : ''}</button>
      </div>
    </div>
  );
}


/** "Priya added Ravi", "Asha left", "Vikram renamed the Space to …". */
function Notice({ m, users, meId }: { m: Message; users: Map<string, PublicUser>; meId: string }) {
  const name = (id: string) => (id === meId ? 'you' : users.get(id)?.displayName ?? 'someone');
  const actor = m.authorId === meId ? 'You' : users.get(m.authorId)?.displayName ?? 'Someone';
  const list = (ids: string[]) => ids.map(name).join(', ');
  const s = m.system!;
  if (s.kind === 'away') {
    const who = users.get(s.users[0])?.displayName ?? 'They';
    const deputy = s.users[1] ? users.get(s.users[1])?.displayName : null;
    return (
      <div className="notice-line away" data-mid={m.id}>
        <span><b>{who}</b> is away from the office{s.until ? ` until ${new Date(s.until).toLocaleDateString([], { day: 'numeric', month: 'short' })}` : ''}{s.name ? `: “${s.name}”` : ''}{s.users[1] === meId ? '. You are standing in meanwhile.' : deputy ? `. Ask ${deputy} meanwhile.` : '.'}</span>
        <span className="mono faint">{clock(m.createdAt)}</span>
      </div>
    );
  }
  const text = s.kind === 'joined' ? `${actor} joined` : s.kind === 'left' ? `${actor} left`
    : s.kind === 'added' ? `${actor} added ${list(s.users)}` : s.kind === 'removed' ? `${actor} removed ${list(s.users)}`
      : `${actor} renamed the Space to “${s.name ?? ''}”`;
  return <div className="notice-line" data-mid={m.id}><span>{text}</span><span className="mono faint">{clock(m.createdAt)}</span></div>;
}

/** Who has seen one of my messages, and who has not yet. */
function ReadersDialog({ m, ctx, onClose }: { m: Message; ctx: Ctx; onClose: () => void }) {
  const others = ctx.conv.members.filter((u) => u !== ctx.meId && ctx.users.get(u)?.role !== 'bot');
  const read = others.filter((u) => (ctx.conv.reads[u] ?? '') >= m.id);
  const hidden = others.filter((u) => !(u in ctx.conv.reads));
  const unread = others.filter((u) => !read.includes(u) && !hidden.includes(u));
  const row = (id: string) => { const u = ctx.users.get(id); return <div key={id} className="member-row"><Avatar user={{ id, displayName: u?.displayName ?? '?' }} presence={presenceFor(id)} size="sm" /><span className="sb-main"><span className="sb-name">{u?.displayName ?? 'Someone'}</span></span></div>; };
  return (
    <Dialog title="Who has seen it" onClose={onClose}>
      <div className="readers">
        <div className="label">Seen · {read.length}</div>{read.map(row)}
        {unread.length > 0 && <><div className="label">Not yet · {unread.length}</div>{unread.map(row)}</>}
        {hidden.length > 0 && <p className="faint" style={{ fontSize: 12 }}>{hidden.length === 1 ? 'One person does not show when they have seen messages.' : `${hidden.length} people do not show when they have seen messages.`}</p>}
      </div>
    </Dialog>
  );
}

/** Report a message to the administrators, or (moderators) remove someone else's with a reason. */
function ReasonDialog({ kind, m, ctx, onClose }: { kind: 'report' | 'remove'; m: Message; ctx: Ctx; onClose: () => void }) {
  const toast = useToast();
  const options = kind === 'report'
    ? ['Offensive or inappropriate', 'Harassment', 'Confidential information shared wrongly', 'Spam or off topic']
    : ['Off topic here', 'Shared in the wrong place', 'Against the office policy', 'Duplicate'];
  const [reason, setReason] = useState(options[0]);
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState(false);
  const text = reason === 'Other' ? other.trim() : reason;
  const go = async () => {
    setBusy(true);
    try {
      if (kind === 'report') {
        // an encrypted Direct message's text only exists on devices: the reporter quotes it
        await window.dex.request('msg.report', { messageId: m.id, reason: text, ...(ctx.conv.kind === 'direct' ? { quote: m.body } : {}) });
        toast('Reported. An administrator will look at it.');
      } else {
        await window.dex.request('msg.delete', { messageId: m.id, reason: text });
        toast('Removed');
      }
      onClose();
    } catch (e) { toast((e as Error).message, true); setBusy(false); }
  };
  return (
    <Dialog title={kind === 'report' ? 'Report to administrators' : 'Remove this message'} onClose={onClose}>
      <p className="muted" style={{ margin: 0 }}>{kind === 'report'
        ? `Only administrators see the report and who made it.${ctx.conv.kind === 'direct' ? ' The message text goes with it, since the hub cannot read Direct messages.' : ''}`
        : 'Everyone in the Space sees that it was removed, by you, and why.'}</p>
      <div className="reason-list" role="radiogroup">
        {[...options, 'Other'].map((o) => <label key={o} className="check-line"><input type="radio" name="reason" checked={reason === o} onChange={() => setReason(o)} />{o}</label>)}
        {reason === 'Other' && <input className="input" autoFocus maxLength={200} placeholder="Say why" value={other} onChange={(e) => setOther(e.target.value)} />}
      </div>
      <div className="dialog-actions">
        <span />
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className={`btn ${kind === 'remove' ? 'danger' : 'primary'}`} disabled={busy || !text} onClick={() => void go()}>{kind === 'report' ? 'Report' : 'Remove'}</button>
      </div>
    </Dialog>
  );
}

/** A Direct message that went out without end-to-end encryption: a small open lock, and why. */
function PlainMark({ m, users }: { m: Message; users: Map<string, PublicUser> }) {
  const p = m.plain!;
  const who = p.users.map((id) => users.get(id)?.displayName ?? 'someone').join(', ');
  const why = p.reason === 'meeting'
    ? 'Not end-to-end encrypted: said in the meeting chat, which guests from outside read. Your own Direct messages stay encrypted.'
    : p.reason === 'no-key'
    ? `Not end-to-end encrypted: ${who} had no encryption key yet (an older version of Dexterity Connect). The office hub can read this message.`
    : 'Not end-to-end encrypted: sent from an older version of Dexterity Connect. The office hub can read this message.';
  return <span className="plain-mark" role="img" aria-label={why} title={why}><Icon name="unlock" size={12} /></span>;
}
