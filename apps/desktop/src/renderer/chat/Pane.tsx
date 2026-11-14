// A conversation pane: header, the spine timeline, typing line and the Dock composer, with an
// optional side panel (side-track, pins or members) on the right.
import { Suspense, lazy, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Conversation, FileInfo, PublicUser, Session } from '@dex/core';
import { AttachmentTray, FilesPanel, Lightbox, MessageFiles, filesSupported, startUploads } from './files.tsx';
import type { Attachment } from './files.tsx';
import { Avatar, Icon, Popover, colorFor, useToast, presenceFor } from '../ui.tsx';
import { isEmojiOnly, renderBody } from './format.tsx';
import {
  addConversation, chatState, discardFailed, loadLatest, loadOlder, markRead, notifyTyping, retrySend, sendMessage,
  setActiveConversation, setDraft, tlKey, useChat,
} from './store.ts';
import type { AnyMessage, PendingMessage } from './store.ts';
import { ConvTile, convTitle } from './Switchboard.tsx';
import { CallButtons } from '../rooms/RoomUi.tsx';
import { FormBuilder, FormCard } from './forms.tsx';
import { NoteEditor, NotesList } from './notes.tsx';
import { BoardsList } from './boards.tsx';
import { VoiceRecorder } from './voice.tsx';
import { EmojiPicker } from './EmojiPicker.tsx';
import { EmojiGlyph, EmojiImg, useCustomEmoji } from '../emoji.tsx';
import { ClipRecorder, clipsSupported, screenClipsSupported } from './clips.tsx';
import type { Board } from '@dex/core';
import { ForwardDialog, ForwardedTag, PollCard, PollDialog, RemindDialog, ScheduleDialog, markUnreadFrom } from './extras.tsx';
import { describeWhen, deskState, toggleSaved, useDesk } from '../desk/store.ts';
import { policyNow, usePolicy, withinEditWindow } from '../policy.ts';
import { EventDialog } from '../calendar/CalendarView.tsx';
import { BUILT_INS, loadBotCommands, runSlash } from './commands.ts';
import type { CommandInfo } from './commands.ts';
import { Dialog } from '../ui.tsx';

/** The kind of a conversation, read from the chat store without subscribing. */
const convKind = (id: string) => chatState().conversations.get(id)?.kind;

const WhiteboardStage = lazy(() => import('./Whiteboard.tsx').then((m) => ({ default: m.WhiteboardStage })));

const QUICK = ['👍', '✅', '👀', '🙏', '🎉', '😂'];
const EMOJI = ['👍', '👎', '✅', '❌', '👀', '🙏', '🎉', '😂', '😊', '😅', '🤔', '😮', '😢', '🔥', '💯', '👏', '🙌', '💪', '🚀', '⚠️', '📌', '📎', '📐', '🛠️', '☕', '🍕', '⏰', '📅', '❤️', '⭐'];
const RUN_GAP = 5 * 60 * 1000;

type Side = { kind: 'track'; parentId: string } | { kind: 'pins' } | { kind: 'members' } | { kind: 'files' } | { kind: 'notes'; noteId: string | null | 'new' } | { kind: 'boards' } | null;

interface Ctx {
  users: Map<string, PublicUser>; meId: string; isAdmin: boolean; conv: Conversation; online: Set<string>;
  view: (f: FileInfo, all: FileInfo[]) => void;
  /** Multi-select: the chosen message ids (null when not selecting). */
  selected: Set<string> | null;
  select: (id: string | null) => void;
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
  `> **${users.get(m.authorId)?.displayName ?? 'Someone'}:** ${(m.body || (m.files.length ? `📎 ${m.files.map((f) => f.name).join(', ')}` : '')).replace(/\n/g, '\n> ')}\n\n`;

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// ------------------------------------------------------------------ pane
export function Pane({ convId, users, meId, isAdmin, online, live, onBack, session, direct = false, reachable = [] }: {
  convId: string; users: Map<string, PublicUser>; meId: string; isAdmin: boolean; online: Set<string>; live: boolean; onBack?: () => void; session?: Session;
  /** Hub off: messages go straight to the other PCs (text only). */
  direct?: boolean; reachable?: string[];
}) {
  const conv = useChat((s) => s.conversations.get(convId));
  const [side, setSide] = useState<Side>(null);
  const [viewer, setViewer] = useState<{ file: FileInfo; all: FileInfo[] } | null>(null);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [fwdMany, setFwdMany] = useState(false);
  useEffect(() => { setSelected(null); }, [convId]);
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
  const [e2e, setE2e] = useState<{ encrypted: boolean; code: string | null; missing: string[] } | null>(null);
  const [verify, setVerify] = useState(false);
  useEffect(() => {
    setE2e(null);
    if (!window.dex.e2eStatus || convKind(convId) !== 'direct') return;
    const load = () => void window.dex.e2eStatus!(convId).then(setE2e).catch(() => setE2e(null));
    load();
    return window.dex.onHubEvent((name) => { if (name === 'e2e.keysChanged') load(); });
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
      for (let i = 0; i < 8; i++) {
        const el = document.querySelector(`[data-mid="${d.messageId}"]`);
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
    setActiveConversation(convId);
    const tl = chatState().timelines.get(convId);
    if (!tl?.loaded) void loadLatest(convId);
    return () => setActiveConversation(null);
  }, [convId]);

  if (!conv) return <div className="pane empty"><div className="empty"><Icon name="chat" size={36} /><span>This conversation is no longer available.</span></div></div>;
  const ctx: Ctx = {
    users, meId, isAdmin, conv, online, view: (file, all) => setViewer({ file, all }), selected,
    select: (id) => setSelected((cur) => {
      if (id === null) return null;
      const next = new Set(cur ?? []);
      if (next.has(id)) next.delete(id); else if (next.size < 50) next.add(id);
      return next;
    }),
  };
  const picked = (): AnyMessage[] => (chatState().timelines.get(convId)?.messages ?? []).filter((m) => selected?.has(m.id) && !('pending' in m));
  const canAttach = filesSupported() && live && !direct;
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = [...e.dataTransfer.files];
    if (files.length && canAttach) window.dispatchEvent(new CustomEvent('dex-attach', { detail: { key: tlKey(convId), files } }));
  };
  const title = convTitle(conv, users, meId);
  const others = conv.members.filter((m) => m !== meId);
  const subtitle = conv.kind === 'space'
    ? (conv.topic ?? `${conv.members.length} ${conv.members.length === 1 ? 'member' : 'members'}`)
    : others.length === 1
      ? (users.get(others[0])?.statusText ?? users.get(others[0])?.title ?? (online.has(others[0]) ? 'Available' : 'Offline'))
      : `${conv.members.length} people`;

  return (
    <div className={`pane-wrap${side ? ' with-side' : ''}`}>
      <section className="pane" aria-label={title}
        onDragOver={(e) => { if (canAttach && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
        onDragLeave={(e) => { if (e.currentTarget === e.target) setDragging(false); }}
        onDrop={onDrop}>
        {dragging && <div className="drop-zone" onDragLeave={() => setDragging(false)}><Icon name="paperclip" size={28} /><span>Drop to share in {title}</span></div>}
        <header className="pane-head">
          {onBack && <button className="icon-btn only-narrow" onClick={onBack} aria-label="Back to the list"><Icon name="back" size={18} /></button>}
          <ConvTile c={conv} users={users} meId={meId} online={online} />
          <div className="pane-title">
            <h2>{title}{conv.private && conv.kind === 'space' && <Icon name="lock" size={14} />}</h2>
            <p className="faint">
              {e2e && conv.kind === 'direct' && (
                <button className={`e2e-chip${e2e.encrypted ? '' : ' off'}`} onClick={() => setVerify(true)} title={e2e.encrypted ? 'Messages here are end-to-end encrypted' : 'Not end-to-end encrypted yet'}>
                  <Icon name="lock" size={11} />{e2e.encrypted ? 'Encrypted' : 'Not encrypted'}
                </button>
              )}
              {subtitle}
            </p>
          </div>
          <div className="row-actions">
            {conv.members.length > 1 && <CallButtons convId={convId} live={live} />}
            <span className="head-sep" />
            <span className="head-tools">
            {live && session && session.me.role !== 'guest' && <button className="icon-btn" title="Plan a meeting with these people" onClick={() => setPlanning(true)}><Icon name="calendar" size={17} /></button>}
            <button className={`icon-btn${side?.kind === 'notes' ? ' on' : ''}`} title="Notes" onClick={() => setSide(side?.kind === 'notes' ? null : { kind: 'notes', noteId: null })}><Icon name="doc" size={17} /></button>
            <button className={`icon-btn${side?.kind === 'boards' ? ' on' : ''}`} title="Whiteboards" onClick={() => setSide(side?.kind === 'boards' ? null : { kind: 'boards' })}><Icon name="drawing" size={17} /></button>
            <button className="icon-btn" title="Search this conversation" onClick={() => window.dispatchEvent(new CustomEvent('dex-search', { detail: conv.id }))}><Icon name="search" size={17} /></button>
            <button className={`icon-btn${side?.kind === 'files' ? ' on' : ''}`} title="Files" onClick={() => setSide(side?.kind === 'files' ? null : { kind: 'files' })}><Icon name="paperclip" size={17} /></button>
            <button className={`icon-btn${side?.kind === 'pins' ? ' on' : ''}`} title="Pinned" onClick={() => setSide(side?.kind === 'pins' ? null : { kind: 'pins' })}><Icon name="pin" size={17} /></button>
            <button className={`icon-btn${side?.kind === 'members' ? ' on' : ''}`} title="People" onClick={() => setSide(side?.kind === 'members' ? null : { kind: 'members' })}><Icon name="people" size={17} /></button>
            <button className={`icon-btn${conv.muted ? ' on' : ''}`} title={conv.muted ? 'Unmute' : 'Mute'}
              onClick={() => void window.dex.request('conv.mute', { convId, muted: !conv.muted }).then(() => toast(conv.muted ? 'Notifications on' : 'Muted. You will still hear about mentions.')).catch((e: Error) => toast(e.message, true))}>
              <Icon name={conv.muted ? 'mute' : 'bell'} size={17} />
            </button>
            </span>
            <button ref={moreBtn} className="icon-btn head-more" title="More" aria-haspopup="menu" aria-expanded={headMenu} onClick={() => setHeadMenu(!headMenu)}><Icon name="more" size={18} /></button>
            {headMenu && (
              <Popover anchor={moreBtn.current} onClose={() => setHeadMenu(false)} className="menu head-menu">
                {live && session && session.me.role !== 'guest' && <button role="menuitem" onClick={() => { setHeadMenu(false); setPlanning(true); }}><Icon name="calendar" size={16} />Plan a meeting</button>}
                <button role="menuitem" onClick={() => { setHeadMenu(false); setSide({ kind: 'notes', noteId: null }); }}><Icon name="doc" size={16} />Notes</button>
                <button role="menuitem" onClick={() => { setHeadMenu(false); setSide({ kind: 'boards' }); }}><Icon name="drawing" size={16} />Whiteboards</button>
                <button role="menuitem" onClick={() => { setHeadMenu(false); setSide({ kind: 'files' }); }}><Icon name="paperclip" size={16} />Files</button>
                <button role="menuitem" onClick={() => { setHeadMenu(false); setSide({ kind: 'pins' }); }}><Icon name="pin" size={16} />Pinned</button>
                <button role="menuitem" onClick={() => { setHeadMenu(false); setSide({ kind: 'members' }); }}><Icon name="people" size={16} />People</button>
                <button role="menuitem" onClick={() => { setHeadMenu(false); void window.dex.request('conv.mute', { convId, muted: !conv.muted }).then(() => toast(conv.muted ? 'Notifications on' : 'Muted. You will still hear about mentions.')).catch((e: Error) => toast(e.message, true)); }}><Icon name={conv.muted ? 'bell' : 'mute'} size={16} />{conv.muted ? 'Unmute' : 'Mute'}</button>
              </Popover>
            )}
          </div>
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
            <span><b>{u!.displayName.split(' ')[0]}</b> is out of office until {new Date(u!.ooo!.until).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}.{u!.ooo!.message ? ` “${u!.ooo!.message}”` : ''}{u!.ooo!.delegateId ? ` For anything urgent, contact ${users.get(u!.ooo!.delegateId)?.displayName ?? 'a colleague'}.` : ''}</span>
          </div>
        ))}
        <Timeline ctx={ctx} onTrack={(parentId) => setSide({ kind: 'track', parentId })} activeTrack={side?.kind === 'track' ? side.parentId : null} />
        {selected && (
          <div className="select-bar" role="toolbar" aria-label="Selected messages">
            <b>{selected.size} selected</b>
            <button className="btn sm" disabled={!selected.size} onClick={() => setFwdMany(true)}><Icon name="forward" size={14} />Forward</button>
            <button className="btn sm" disabled={!selected.size} onClick={() => { void navigator.clipboard.writeText(picked().map((m) => `${users.get(m.authorId)?.displayName ?? ''} (${new Date(m.createdAt).toLocaleString()}):\n${m.body}`).join('\n\n')); toast('Copied'); }}><Icon name="copy" size={14} />Copy</button>
            <button className="btn sm" disabled={!selected.size} onClick={() => void Promise.all(picked().filter((m) => !deskState().saved.has(m.id)).map((m) => toggleSaved(m as never).catch(() => null))).then(() => toast('Saved to your Desk'))}><Icon name="star" size={14} />Save</button>
            {picked().length > 0 && picked().every((m) => m.authorId === meId || (isAdmin && conv.kind === 'space')) && (
              <button className="btn sm danger" onClick={() => { if (confirm(`Delete ${selected.size} messages for everyone?`)) void Promise.all(picked().map((m) => window.dex.request('msg.delete', { messageId: m.id }).catch(() => null))).then(() => { toast('Deleted'); setSelected(null); }); }}><Icon name="trash" size={14} />Delete</button>
            )}
            <span style={{ flex: 1 }} />
            <button className="btn ghost sm" onClick={() => setSelected(null)}>Done</button>
          </div>
        )}
        {fwdMany && picked().length > 0 && <ForwardDialog message={picked()[0] as never} more={picked().slice(1) as never} users={users} meId={meId} online={online} onClose={() => { setFwdMany(false); setSelected(null); }} />}
        <TypingLine k={tlKey(convId)} users={users} />
        {conv.archived ? null : conv.postPolicy === 'moderators' && !(isAdmin || conv.createdBy === meId || conv.moderators.includes(meId)) ? (
          <div className="dock-locked faint"><Icon name="lock" size={14} />Only moderators post here. You can reply to a message in its side-track.</div>
        ) : <Dock convId={convId} parentId={null} ctx={ctx} live={live} direct={direct} placeholder={`Message ${conv.kind === 'space' ? title : others.length === 1 ? title.split(' ')[0] : 'the group'}`} />}
      </section>
      {side?.kind === 'track' && <SideTrack ctx={ctx} parentId={side.parentId} live={live} onClose={() => setSide(null)} />}
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
      {board && <Suspense fallback={null}><WhiteboardStage board={board} convId={convId} onClose={() => setBoard(null)} /></Suspense>}
      {side?.kind === 'files' && <FilesPanel convId={convId} onView={ctx.view} onClose={() => setSide(null)} />}
      {viewer && <Lightbox file={viewer.file} all={viewer.all} onClose={() => setViewer(null)} />}
      {verify && e2e && (
        <Dialog title={e2e.encrypted ? 'End-to-end encrypted' : 'Not encrypted yet'} onClose={() => setVerify(false)} narrow>
          {e2e.encrypted ? (
            <>
              <p className="muted" style={{ margin: 0 }}>Messages you write here are locked on your device and can only be read on the devices of the people in this conversation. The office hub stores and passes them on but cannot read them. Files are protected in transit and on the hub, but are not end-to-end encrypted.</p>
              <div className="label">Safety code</div>
              <div className="code big safety selectable">{e2e.code?.split(' ').map((g, i) => <span key={i}>{g}</span>)}</div>
              <p className="faint" style={{ margin: 0, fontSize: 12.5 }}>To be sure nobody is listening in, compare this code with {others.length === 1 ? users.get(others[0])?.displayName.split(' ')[0] : 'the others'} in person. It is the same on both screens. It changes when anyone here adds or replaces a device.</p>
            </>
          ) : (
            <p className="muted" style={{ margin: 0 }}>{e2e.missing.length
              ? `${e2e.missing.map((id) => users.get(id)?.displayName ?? 'Someone').join(', ')} ${e2e.missing.length === 1 ? 'is' : 'are'} on an older version of Dexterity Connect. Messages here stay readable to them and are protected on the office network, and will be end-to-end encrypted once they update.`
              : 'Conversations that include an integration are not end-to-end encrypted.'}</p>
          )}
        </Dialog>
      )}
      {planning && session && <EventDialog session={session} conv={conv} onClose={() => setPlanning(false)} />}
    </div>
  );
}

// ------------------------------------------------------------------ timeline
function Timeline({ ctx, onTrack, activeTrack }: { ctx: Ctx; onTrack: (id: string) => void; activeTrack: string | null }) {
  const convId = ctx.conv.id;
  const tl = useChat((s) => s.timelines.get(convId));
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const prevHeight = useRef(0);
  const prevFirst = useRef<string | null>(null);
  const messages = tl?.messages ?? [];

  // keep the view pinned to the bottom unless the reader scrolled up; keep position when older pages load
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const first = messages[0]?.id ?? null;
    if (prevFirst.current && first !== prevFirst.current && !stick.current) {
      el.scrollTop += el.scrollHeight - prevHeight.current;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevFirst.current = first;
    prevHeight.current = el.scrollHeight;
  }, [messages]);

  useEffect(() => { stick.current = true; }, [convId]);

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
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (stick.current) markRead(convId);
    if (el.scrollTop < 200 && tl?.hasMore && !tl.loading) { prevHeight.current = el.scrollHeight; void loadOlder(convId); }
  };

  // runs: consecutive messages by one person within 5 minutes; day labels between days
  const blocks = useMemo(() => {
    const out: Array<{ kind: 'day'; label: string; key: string } | { kind: 'run'; author: string; mine: boolean; msgs: AnyMessage[]; key: string }> = [];
    let lastDay = '';
    for (const m of messages) {
      const day = new Date(m.createdAt).toDateString();
      if (day !== lastDay) { out.push({ kind: 'day', label: dayLabel(m.createdAt), key: `d${day}` }); lastDay = day; }
      const prev = out[out.length - 1];
      if (prev?.kind === 'run' && prev.author === m.authorId && m.createdAt - prev.msgs[prev.msgs.length - 1].createdAt < RUN_GAP) prev.msgs.push(m);
      else out.push({ kind: 'run', author: m.authorId, mine: m.authorId === ctx.meId, msgs: [m], key: `r${m.id}` });
    }
    return out;
  }, [messages, ctx.meId]);

  // "Seen by" under the newest of my messages
  const seen = useMemo(() => {
    const mine = [...messages].reverse().find((m) => m.authorId === ctx.meId && !('pending' in m));
    if (!mine) return null;
    const readers = Object.entries(ctx.conv.reads).filter(([u, r]) => u !== ctx.meId && r && r >= mine.id).map(([u]) => u);
    return { id: mine.id, readers };
  }, [messages, ctx.conv.reads, ctx.meId]);

  return (
    <div className="timeline" ref={scroller} onScroll={onScroll}>
      <div className="spine">
        {tl?.hasMore && <div className="tl-more">{tl.loading ? <span className="spinner" /> : null}</div>}
        {tl?.loaded && !tl.hasMore && <Beginning ctx={ctx} />}
        {!tl?.loaded && <div className="tl-more"><span className="spinner" /></div>}
        {blocks.map((b) => b.kind === 'day'
          ? <div key={b.key} className="day-mark"><span className="label">{b.label}</span></div>
          : <Run key={b.key} ctx={ctx} author={b.author} mine={b.mine} msgs={b.msgs} onTrack={onTrack} activeTrack={activeTrack} seen={seen} />)}
      </div>
    </div>
  );
}

function Beginning({ ctx }: { ctx: Ctx }) {
  const c = ctx.conv;
  return (
    <div className="tl-start">
      <ConvTile c={c} users={ctx.users} meId={ctx.meId} online={ctx.online} size="lg" />
      <h3>{c.kind === 'space' ? `Welcome to ${c.name}` : `This is the start of your conversation with ${convTitle(c, ctx.users, ctx.meId)}`}</h3>
      {c.topic && <p className="muted">{c.topic}</p>}
      <p className="faint" style={{ fontSize: 13 }}>{c.kind === 'space' ? (c.private ? 'A private Space: only people who were added can see it.' : 'An open Space: anyone in the office can find and join it.') : 'Only the people here can see these messages.'}</p>
    </div>
  );
}

const Run = memo(function Run({ ctx, author, mine, msgs, onTrack, activeTrack, seen }: {
  ctx: Ctx; author: string; mine: boolean; msgs: AnyMessage[]; onTrack: (id: string) => void; activeTrack: string | null;
  seen: { id: string; readers: string[] } | null;
}) {
  const u = ctx.users.get(author);
  return (
    <div className={`run${mine ? ' mine' : ''}`}>
      <div className="run-tile"><Avatar user={{ id: author, displayName: u?.displayName ?? '?' }} presence={presenceFor(author)} /></div>
      <div className="run-body">
        <div className="run-head">
          <span className="run-name" style={mine ? undefined : { color: colorFor(author) }}>{mine ? 'You' : u?.displayName ?? 'Former member'}</span>
          {u?.role === 'bot' && <span className="chip accent bot-chip">Integration</span>}
          <span className="run-time">{clock(msgs[0].createdAt)}</span>
        </div>
        {msgs.map((m) => (
          <MessageItem key={m.clientId ?? m.id} ctx={ctx} m={m} onTrack={onTrack} activeTrack={activeTrack}
            seenBy={seen && seen.id === m.id ? seen.readers : null} />
        ))}
      </div>
    </div>
  );
});

// ------------------------------------------------------------------ one message
function MessageItem({ ctx, m, onTrack, activeTrack, seenBy, inTrack }: {
  ctx: Ctx; m: AnyMessage; onTrack?: (id: string) => void; activeTrack?: string | null; seenBy: string[] | null; inTrack?: boolean;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [picker, setPicker] = useState(false);
  const [more, setMore] = useState(false);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const pickBtn = useRef<HTMLButtonElement>(null);
  const [dialog, setDialog] = useState<'remind' | 'forward' | null>(null);
  const saved = useDesk((s) => s.saved.has(m.id));
  const pending = 'pending' in m;
  const failed = pending ? (m as PendingMessage).failed : undefined;
  const mine = m.authorId === ctx.meId;
  const policy = usePolicy();
  const inWindow = withinEditWindow(m.createdAt, policy);
  const moderator = ctx.conv.kind === 'space' && (ctx.isAdmin || ctx.conv.moderators?.includes(ctx.meId) || ctx.conv.createdBy === ctx.meId);
  const canEdit = mine && inWindow;
  const canDelete = (mine && inWindow) || moderator;
  const mentioned = m.mentions.includes(ctx.meId) || (m.mentions.includes('all') && !mine);

  // ArrowUp in an empty Dock edits your last message
  useEffect(() => {
    const onEdit = (e: Event) => { if ((e as CustomEvent).detail === m.id) setEditing(true); };
    window.addEventListener('dex-edit', onEdit);
    return () => window.removeEventListener('dex-edit', onEdit);
  }, [m.id]);

  const act = (p: Promise<unknown>, ok?: string) => p.then(() => ok && toast(ok)).catch((e: Error) => toast(e.message, true));
  const custom = useCustomEmoji();
  const react = (emoji: string) => {
    const on = !(m.reactions[emoji] ?? []).includes(ctx.meId);
    setPicker(false);
    void act(window.dex.request('msg.react', { messageId: m.id, emoji, on }));
  };

  if (m.deleted) return <div className="msg deleted"><span className="faint">Message deleted</span></div>;

  return (
    <div data-mid={m.id} onClickCapture={(e) => { if (ctx.selected && !pending && !inTrack) { e.preventDefault(); e.stopPropagation(); ctx.select(m.id); } }}
      className={`${ctx.selected && !inTrack ? `selectable-msg${ctx.selected.has(m.id) ? ' chosen' : ''} ` : ''}msg${pending ? ' pending' : ''}${failed ? ' failed' : ''}${mentioned ? ' mentioned' : ''}${activeTrack === m.id ? ' tracked' : ''}${m.pinned ? ' pinned' : ''}`}>
      {m.forwardedFrom && <ForwardedTag m={m} users={ctx.users} meId={ctx.meId} />}
      {m.e2e === 'locked' ? (
        <div className="msg-text locked"><Icon name="lock" size={13} />This message was sent before this device was set up. It appears once one of your other devices is online.</div>
      ) : m.form ? <FormCard m={m} meId={ctx.meId} users={ctx.users} /> : m.poll ? <PollCard m={m} meId={ctx.meId} users={ctx.users} /> : editing ? (
        <EditBox m={m} ctx={ctx} onDone={() => setEditing(false)} />
      ) : (
        m.body ? (
          <div className={`msg-text selectable${isEmojiOnly(m.body) ? ' big' : ''}`}>
            {renderBody(m.body, ctx.users, ctx.meId)}
            {m.editedAt && <span className="edited"> (edited)</span>}
            {m.via === 'direct' && <span className="via-direct" title="Passed straight between PCs while the hub was off">sent directly</span>}
            {m.e2e === 'unverified' && <span className="unverified" title="Encrypted, but this device could not confirm which device sent it"><Icon name="warning" size={12} /></span>}
          </div>
        ) : null
      )}
      <MessageFiles files={m.files ?? []} onView={ctx.view} />

      {Object.keys(m.reactions).length > 0 && (
        <div className="reactions">
          {Object.entries(m.reactions).map(([emoji, who]) => (
            <button key={emoji} className={`reaction${who.includes(ctx.meId) ? ' mine' : ''}`} onClick={() => react(emoji)}
              title={who.map((id) => (id === ctx.meId ? 'You' : ctx.users.get(id)?.displayName ?? 'Someone')).join(', ')}>
              <span><EmojiGlyph emoji={emoji} size={16} /></span><span className="n">{who.length}</span>
            </button>
          ))}
        </div>
      )}

      {!inTrack && m.replyCount > 0 && onTrack && (
        <button className="track-link" onClick={() => onTrack(m.id)}>
          <Icon name="reply" size={14} />{m.replyCount} {m.replyCount === 1 ? 'reply' : 'replies'}
          {m.lastReplyAt && <span className="faint"> · last {clock(m.lastReplyAt)}</span>}
        </button>
      )}

      {failed && (
        <div className="send-failed">
          <Icon name="warning" size={14} /><span>{failed}</span>
          <button className="link" onClick={() => retrySend(m as PendingMessage)}>Retry</button>
          <button className="link" onClick={() => discardFailed(m as PendingMessage)}>Discard</button>
        </div>
      )}
      {seenBy && seenBy.length > 0 && (
        <div className="seen" title={seenBy.map((id) => ctx.users.get(id)?.displayName).join(', ')}>
          <Icon name="check" size={12} />Seen{ctx.conv.members.length > 2 ? ` by ${seenBy.length}` : ''}
        </div>
      )}

      {!pending && !editing && (
        <div className="msg-tools" role="toolbar" aria-label="Message actions">
          {QUICK.slice(0, 3).map((e) => <button key={e} onClick={() => react(e)} title={`React ${e}`}>{e}</button>)}
          <button ref={pickBtn} onClick={() => setPicker(!picker)} title="More reactions"><Icon name="smile" size={16} /></button>
          {!inTrack && onTrack && <button onClick={() => onTrack(m.id)} title="Reply in a side-track"><Icon name="reply" size={16} /></button>}
          <button className={saved ? 'on' : undefined} onClick={() => void toggleSaved(m).then((on) => toast(on ? 'Saved to your Desk' : 'Removed from your Desk')).catch((e: Error) => toast(e.message, true))} title={saved ? 'Remove from saved' : 'Save for later'} aria-pressed={saved}><Icon name="star" size={16} /></button>
          <button onClick={() => setDialog('remind')} title="Remind me about this"><Icon name="alarm" size={16} /></button>
          {canEdit && m.body && !m.poll && !m.form && <button onClick={() => setEditing(true)} title="Edit"><Icon name="edit" size={16} /></button>}
          <button ref={moreBtn} onClick={() => setMore(!more)} title="More" aria-haspopup="menu" aria-expanded={more}><Icon name="more" size={16} /></button>
          {more && (
            <Popover anchor={moreBtn.current} onClose={() => setMore(false)} className="menu msg-menu">
              <button role="menuitem" onClick={() => { setMore(false); setDialog('forward'); }}><Icon name="forward" size={16} />Forward</button>
              {m.body && <button role="menuitem" onClick={() => { setMore(false); window.dispatchEvent(new CustomEvent('dex-quote', { detail: { key: tlKey(m.convId, inTrack ? m.parentId : null), text: quoteOf(m, ctx.users) } })); }}><Icon name="reply" size={16} />Quote</button>}
              {ctx.conv.kind === 'space' && !mine && ctx.users.get(m.authorId)?.role !== 'bot' && (
                <button role="menuitem" onClick={() => {
                  setMore(false);
                  void window.dex.request('conv.create', { kind: 'direct', members: [m.authorId] }).then((c) => {
                    addConversation(c);
                    window.dispatchEvent(new CustomEvent('dex-open', { detail: c.id }));
                    setTimeout(() => window.dispatchEvent(new CustomEvent('dex-quote', { detail: { key: tlKey(c.id), text: quoteOf(m, ctx.users) } })), 250);
                  }).catch((e: Error) => toast(e.message, true));
                }}><Icon name="chat" size={16} />Reply privately</button>
              )}
              <button role="menuitem" onClick={() => { setMore(false); void navigator.clipboard.writeText(`dexconnect://message/${m.convId}/${m.id}`); toast('Link copied: paste it anywhere in Dexterity Connect'); }}><Icon name="open" size={16} />Copy link</button>
              {!inTrack && <button role="menuitem" onClick={() => { setMore(false); ctx.select(m.id); }}><Icon name="check" size={16} />Select</button>}
              <button role="menuitem" onClick={() => { setMore(false); void act(window.dex.request('msg.pin', { messageId: m.id, pinned: !m.pinned }), m.pinned ? 'Unpinned' : 'Pinned for everyone here'); }}><Icon name="pin" size={16} />{m.pinned ? 'Unpin' : 'Pin'}</button>
              {!inTrack && !m.parentId && <button role="menuitem" onClick={() => { setMore(false); void act(markUnreadFrom(m), 'Marked as unread from here'); }}><Icon name="unread" size={16} />Mark unread from here</button>}
              {m.body && <button role="menuitem" onClick={() => { setMore(false); void navigator.clipboard.writeText(m.body); toast('Copied'); }}><Icon name="copy" size={16} />Copy text</button>}
              {canDelete && <><div className="menu-sep" /><button role="menuitem" className="danger" onClick={() => { setMore(false); if (confirm('Delete this message for everyone?')) void act(window.dex.request('msg.delete', { messageId: m.id })); }}><Icon name="trash" size={16} />Delete</button></>}
            </Popover>
          )}
          {picker && (
            <Popover anchor={pickBtn.current} onClose={() => setPicker(false)} className="emoji-pop-wrap">
              <EmojiPicker onPick={(e) => react(e)} onClose={() => setPicker(false)} />
            </Popover>
          )}
        </div>
      )}
      {(m.pinned || saved) && (
        <span className="pin-flag" title={[m.pinned && 'Pinned', saved && 'Saved'].filter(Boolean).join(' · ')}>
          {m.pinned && <Icon name="pin" size={12} />}{saved && <Icon name="star" size={12} />}
        </span>
      )}
      {dialog === 'remind' && <RemindDialog message={m} users={ctx.users} meId={ctx.meId} onClose={() => setDialog(null)} />}
      {dialog === 'forward' && <ForwardDialog message={m} users={ctx.users} meId={ctx.meId} online={ctx.online} onClose={() => setDialog(null)} />}
    </div>
  );
}

function EditBox({ m, ctx, onDone }: { m: AnyMessage; ctx: Ctx; onDone: () => void }) {
  const toast = useToast();
  const [text, setText] = useState(() => toEditable(m.body, ctx.users));
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { const el = ref.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); autoGrow(el); } }, []);
  const save = async () => {
    const body = toWire(text, ctx.users, ctx.conv);
    if (!body.trim()) return;
    if (body === m.body) { onDone(); return; }
    try { await window.dex.request('msg.edit', { messageId: m.id, body }); onDone(); } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <div className="edit-box">
      <textarea ref={ref} className="input" value={text} onChange={(e) => { setText(e.target.value); autoGrow(e.target); }}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void save(); } if (e.key === 'Escape') { e.preventDefault(); onDone(); } }} />
      <div className="edit-hint faint">Enter to save · Esc to cancel</div>
    </div>
  );
}

// ------------------------------------------------------------------ typing
function TypingLine({ k, users }: { k: string; users: Map<string, PublicUser> }) {
  const typing = useChat((s) => s.typing.get(k));
  const names = typing ? [...typing.keys()].map((id) => users.get(id)?.displayName.split(' ')[0] ?? 'Someone') : [];
  return (
    <div className="typing-line" aria-live="polite">
      {names.length > 0 && <><span className="dots"><i /><i /><i /></span>{names.length === 1 ? `${names[0]} is typing` : names.length === 2 ? `${names[0]} and ${names[1]} are typing` : 'Several people are typing'}</>}
    </div>
  );
}

// ------------------------------------------------------------------ the Dock (composer)
const autoGrow = (el: HTMLTextAreaElement) => { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 260)}px`; };

/** Stored bodies use <@id>; while typing people see @Name. */
function toEditable(body: string, users: Map<string, PublicUser>): string {
  return body.replace(/<@all>/g, '@everyone').replace(/<@([0-9A-Z]{26})>/g, (_, id: string) => `@${users.get(id)?.displayName ?? 'someone'}`);
}

function toWire(text: string, users: Map<string, PublicUser>, conv: Conversation): string {
  let out = text;
  const members = conv.members.map((id) => users.get(id)).filter(Boolean) as PublicUser[];
  // longest names first so "Priya Raman" wins over "Priya"
  for (const u of members.sort((a, b) => b.displayName.length - a.displayName.length)) {
    out = out.split(`@${u.displayName}`).join(`<@${u.id}>`);
  }
  if (conv.kind === 'space') out = out.replace(/@everyone\b/g, '<@all>');
  return out.trim();
}

function Dock({ convId, parentId, ctx, live, placeholder, direct = false }: { convId: string; parentId: string | null; ctx: Ctx; live: boolean; placeholder: string; direct?: boolean }) {
  const key = tlKey(convId, parentId);
  const [text, setText] = useState(() => chatState().drafts.get(key) ?? '');
  const [mention, setMention] = useState<{ q: string; start: number } | null>(null);
  const [mIndex, setMIndex] = useState(0);
  const [emoji, setEmoji] = useState(false);
  const emojiBtn = useRef<HTMLButtonElement>(null);
  const [mdHelp, setMdHelp] = useState(false);
  const mdBtn = useRef<HTMLButtonElement>(null);
  const custom = useCustomEmoji();
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dockDialog, setDockDialog] = useState<'poll' | 'schedule' | 'remind' | 'help' | 'form' | null>(null);
  const [addMenu, setAddMenu] = useState(false);
  const [clipMode, setClipMode] = useState<'camera' | 'screen' | null>(null);
  const [recording, setRecording] = useState(false);
  const addBtn = useRef<HTMLButtonElement>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [botCmds, setBotCmds] = useState<CommandInfo[]>([]);
  const slashQuery = /^\/([\w-]*)$/.exec(text)?.[1]?.toLowerCase() ?? null;
  const slashList = slashQuery === null ? [] : [...BUILT_INS, ...botCmds].filter((c) => c.command.startsWith(slashQuery)).slice(0, 8);
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
    if (files.length < all.length) toast(`${all.length - files.length === 1 ? 'A file is' : `${all.length - files.length} files are`} larger than the office limit of ${limit >= 1024 ? `${limit / 1024} GB` : `${limit} MB`}.`, true);
    if (!files.length) return;
    const room = 20 - attachments.length;
    const fresh = startUploads(files.slice(0, room), (k, patch) =>
      setAttachments((list) => (patch === null ? list.filter((a) => a.key !== k) : list.map((a) => (a.key === k ? { ...a, ...patch } : a)))));
    setAttachments((list) => [...list, ...fresh]);
    ref.current?.focus();
  };
  useEffect(() => {
    const onQuote = (e: Event) => {
      const d = (e as CustomEvent).detail as { key: string; text: string };
      if (d.key !== key) return;
      setText((t) => { const v = `${d.text}${t}`; setDraft(key, v); return v; });
      requestAnimationFrame(() => { const el = ref.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
    };
    window.addEventListener('dex-quote', onQuote);
    return () => window.removeEventListener('dex-quote', onQuote);
  }, [key]);
  useEffect(() => {
    const onAttach = (e: Event) => { const d = (e as CustomEvent).detail as { key: string; files: File[] }; if (d.key === key) addFiles(d.files); };
    window.addEventListener('dex-attach', onAttach);
    return () => window.removeEventListener('dex-attach', onAttach);
  });
  useEffect(() => () => { for (const a of attachments) if (a.preview) URL.revokeObjectURL(a.preview); }, [key]);
  const uploading = attachments.some((a) => !a.info && !a.error);
  const ready = attachments.filter((a) => a.info);

  useEffect(() => { setText(chatState().drafts.get(key) ?? ''); setMention(null); ref.current?.focus(); }, [key]);
  useEffect(() => { if (ref.current) autoGrow(ref.current); }, [text]);

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
  };

  const pick = (c: { label: string }) => {
    const el = ref.current!;
    const caret = el.selectionStart;
    const v = `${text.slice(0, mention!.start)}@${c.label} ${text.slice(caret)}`;
    setText(v);
    setDraft(key, v);
    setMention(null);
    requestAnimationFrame(() => { el.focus(); const pos = mention!.start + c.label.length + 2; el.setSelectionRange(pos, pos); });
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

  const clear = () => { setText(''); setDraft(key, ''); setMention(null); };
  const send = () => {
    const body = toWire(text, ctx.users, ctx.conv);
    if ((!body && !ready.length) || !live || uploading) return;
    if (text.startsWith('/') && !ready.length) {
      const typed = text;
      void runSlash(body, {
        convId, parentId, meId: ctx.meId, displayName: ctx.users.get(ctx.meId)?.displayName ?? 'Someone', toast,
        send: (b) => void sendMessage(convId, b, parentId),
        open: (d) => { if (d === 'meet') window.dispatchEvent(new CustomEvent('dex-plan', { detail: convId })); else setDockDialog(d); },
      }).then((handled) => {
        if (!handled) { void sendMessage(convId, body.replace(/^\/\//, '/'), parentId); clear(); return; }
        // keep the text if a dialog needs it (for example /schedule), otherwise clear it
        if (!/^\/schedule\b/i.test(typed)) clear();
      });
      return;
    }
    void sendMessage(convId, body, parentId, ready.map((a) => a.info!));
    for (const a of attachments) if (a.preview) URL.revokeObjectURL(a.preview);
    setAttachments([]);
    setText('');
    setDraft(key, '');
    setMention(null);
  };

  const schedule = async (at: number) => {
    const body = toWire(text, ctx.users, ctx.conv);
    try {
      await window.dex.request('sched.create', { convId, body, parentId: parentId ?? undefined, files: ready.map((a) => a.info!.id), sendAt: at });
      toast(`Scheduled for ${describeWhen(at)}`);
      for (const a of attachments) if (a.preview) URL.revokeObjectURL(a.preview);
      setAttachments([]);
      setText('');
      setDraft(key, '');
      setDockDialog(null);
    } catch (e) { toast((e as Error).message, true); }
  };

  const onKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (slashList.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex((i) => (i + 1) % slashList.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex((i) => (i - 1 + slashList.length) % slashList.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && slashList[slashIndex] && slashList[slashIndex].command !== slashQuery)) {
        e.preventDefault();
        const v = `/${slashList[Math.min(slashIndex, slashList.length - 1)].command} `;
        setText(v); setDraft(key, v); setSlashIndex(0);
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); clear(); return; }
    }
    if (mention && candidates.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMIndex((i) => (i + 1) % candidates.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMIndex((i) => (i - 1 + candidates.length) % candidates.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(candidates[mIndex]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setMention(null); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); return; }
    if (e.key === 'ArrowUp' && !text) {
      const tl = chatState().timelines.get(key);
      const last = [...(tl?.messages ?? [])].reverse().find((m) => m.authorId === ctx.meId && !m.deleted && !('pending' in m) && withinEditWindow(m.createdAt));
      if (last) { e.preventDefault(); window.dispatchEvent(new CustomEvent('dex-edit', { detail: last.id })); }
    }
    if (e.ctrlKey && !e.shiftKey && (e.key === 'b' || e.key === 'i' || e.key === 'u')) { e.preventDefault(); wrap(e.key === 'b' ? '**' : e.key === 'i' ? '*' : '__'); }
    if (e.ctrlKey && !e.shiftKey && e.key === 'l') { e.preventDefault(); link(); }
    if (e.ctrlKey && !e.shiftKey && e.key === 'e') { e.preventDefault(); setEmoji(true); }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); if ((text.trim() || ready.length) && live && !direct && !uploading) setDockDialog('schedule'); }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'x') { e.preventDefault(); wrap('~~'); }
  };

  return (
    <div className="dock-wrap">
      {slashList.length > 0 && (
        <ul className="mention-pop slash-pop" role="listbox" aria-label="Commands">
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
      <AttachmentTray items={attachments} onRemove={(k) => setAttachments((l) => l.filter((a) => a.key !== k))} />
      <div className={`dock${text.trim() || (ready.length && !uploading) ? ' has-text' : ''}`}>
        <div className="dock-tools">
          {canAttach && (
            <>
              <button className="icon-btn" title="Attach files (or drop them here)" onClick={() => picker.current?.click()}><Icon name="paperclip" size={18} /></button>
              <input ref={picker} type="file" multiple hidden onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
            </>
          )}
          <button ref={emojiBtn} className="icon-btn wide-only" title="Emoji (Ctrl+E)" onClick={() => setEmoji(!emoji)}><Icon name="smile" size={18} /></button>
          <button ref={addBtn} className="icon-btn" title="Add a video, poll, form, note or whiteboard" disabled={!live || direct} onClick={() => setAddMenu(!addMenu)} aria-haspopup="menu" aria-expanded={addMenu}><Icon name="plus" size={18} /></button>
          {addMenu && (
            <Popover anchor={addBtn.current} onClose={() => setAddMenu(false)} className="menu add-menu" align="start">
              {clipsSupported() && <button role="menuitem" onClick={() => { setAddMenu(false); setClipMode('camera'); }}><Icon name="video" size={16} />Video message</button>}
              {screenClipsSupported() && <button role="menuitem" onClick={() => { setAddMenu(false); setClipMode('screen'); }}><Icon name="screen" size={16} />Screen recording</button>}
              <button role="menuitem" onClick={() => { setAddMenu(false); setDockDialog('poll'); }}><Icon name="poll" size={16} />Poll</button>
              {ctx.users.get(ctx.meId)?.role !== 'guest' && <button role="menuitem" onClick={() => { setAddMenu(false); setDockDialog('form'); }}><Icon name="list" size={16} />Form</button>}
              <button role="menuitem" onClick={() => { setAddMenu(false); window.dispatchEvent(new CustomEvent('dex-side', { detail: { convId, side: 'notes-new' } })); }}><Icon name="doc" size={16} />Note</button>
              <button role="menuitem" onClick={() => { setAddMenu(false); window.dispatchEvent(new CustomEvent('dex-side', { detail: { convId, side: 'boards' } })); }}><Icon name="drawing" size={16} />Whiteboard</button>
              {ctx.users.get(ctx.meId)?.role !== 'guest' && <button role="menuitem" onClick={() => { setAddMenu(false); window.dispatchEvent(new CustomEvent('dex-plan', { detail: convId })); }}><Icon name="calendar" size={16} />Meeting</button>}
            </Popover>
          )}
          <button className="icon-btn wide-only" title="Mention someone (@)" onClick={() => { const el = ref.current!; const pos = el.selectionStart; const v = `${text.slice(0, pos)}${pos && !/\s$/.test(text.slice(0, pos)) ? ' ' : ''}@${text.slice(pos)}`; update(v, v.length - text.slice(pos).length); el.focus(); }}><Icon name="at" size={18} /></button>
          {emoji && (
            <Popover anchor={emojiBtn.current} onClose={() => setEmoji(false)} className="emoji-pop-wrap" align="start">
              <EmojiPicker onClose={() => { setEmoji(false); ref.current?.focus(); }} onPick={(e) => {
                const el = ref.current!;
                const pos = el.selectionStart;
                const ins = e.startsWith(':') ? `${pos && !/\s$/.test(text.slice(0, pos)) ? ' ' : ''}${e} ` : e;
                setEmoji(false);
                el.focus();
                el.setSelectionRange(pos, el.selectionEnd);
                insertAtCursor(el, ins);
              }} />
            </Popover>
          )}
        </div>
        {live && !direct && <VoiceRecorder convId={convId} parentId={parentId} onActive={setRecording} />}
        {clipMode && <ClipRecorder mode={clipMode} convId={convId} parentId={parentId} onClose={() => setClipMode(null)} />}
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
        {!recording && <><button className="icon-btn dock-later" onClick={() => setDockDialog('schedule')} disabled={(!text.trim() && !ready.length) || !live || direct || uploading}
          title="Send later" aria-label="Schedule message"><Icon name="schedule" size={17} /></button>
        <button className="send" onClick={send} disabled={(!text.trim() && !ready.length) || !live || uploading} title={uploading ? 'Waiting for uploads to finish' : 'Send (Enter)'} aria-label="Send">
          <Icon name="send" size={18} />
        </button></>}
      </div>
      {dockDialog === 'form' && <FormBuilder conv={ctx.conv} onClose={() => setDockDialog(null)} />}
      {dockDialog === 'poll' && <PollDialog conv={ctx.conv} parentId={parentId} onClose={() => setDockDialog(null)} />}
      {dockDialog === 'remind' && <RemindDialog users={ctx.users} meId={ctx.meId} onClose={() => setDockDialog(null)} />}
      {dockDialog === 'help' && (
        <Dialog title="Slash commands" onClose={() => setDockDialog(null)}>
          <div className="slash-help">
            {[...BUILT_INS, ...botCmds].map((c) => (
              <div key={c.command}><span className="mono">/{c.command}</span>{c.hint && <span className="faint mono"> {c.hint}</span>}<span className="muted">{c.description}</span></div>
            ))}
          </div>
          <p className="faint" style={{ fontSize: 12.5, margin: 0 }}>Start a message with // to send a line that begins with a slash.</p>
        </Dialog>
      )}
      {dockDialog === 'schedule' && <ScheduleDialog preview={toWire(text, ctx.users, ctx.conv)} users={ctx.users} meId={ctx.meId} onPick={schedule} onClose={() => setDockDialog(null)} />}
      <div className="dock-hint faint">
        {scheduledHere.length > 0 && <span className="sched-note"><Icon name="schedule" size={13} />{scheduledHere.length === 1 ? `1 message scheduled · ${describeWhen(scheduledHere[0].sendAt)}` : `${scheduledHere.length} messages scheduled`} · see Desk</span>}
        <span><b>Enter</b> send · <b>/</b> commands · <b>Shift+Enter</b> new line · <b>↑</b> edit last · <button ref={mdBtn} className="link" onClick={() => setMdHelp(!mdHelp)}>Formatting</button></span>
        {mdHelp && (
          <Popover anchor={mdBtn.current} onClose={() => setMdHelp(false)} className="menu md-help" align="end">
            <div className="menu-label">Formatting</div>
            {[
              ['**bold**', <b key="b">bold</b>, 'Ctrl+B'], ['*italic*', <i key="i">italic</i>, 'Ctrl+I'], ['__underline__', <u key="u">underline</u>, 'Ctrl+U'],
              ['~~strike~~', <s key="s">strike</s>, 'Ctrl+Shift+X'], ['`code`', <code key="c" className="md-code">code</code>, ''], ['[text](url)', <span key="l" className="md-link">text</span>, 'Ctrl+L'],
              ['# Heading', <b key="h">Heading</b>, ''], ['> quote', <span key="q" style={{ borderLeft: '3px solid var(--stroke-strong)', paddingLeft: 6 }}>quote</span>, ''],
              ['- item  1. item', <span key="li">• item</span>, ''], ['  - nested', <span key="n" style={{ paddingLeft: 12 }}>◦ nested</span>, ''], ['- [ ] task', <span key="t">☐ task</span>, ''],
              ['```js … ```', <code key="cb" className="md-code">code block</code>, ''], ['---', <span key="r" style={{ display: 'inline-block', width: 60, borderTop: '1px solid var(--stroke-strong)' }} />, ''],
            ].map(([src, out, key]) => (
              <div key={String(src)} className="md-help-row"><code>{src}</code><span>{out}</span>{key ? <span className="kbd">{key}</span> : <span />}</div>
            ))}
          </Popover>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ side panels
function SideTrack({ ctx, parentId, live, onClose }: { ctx: Ctx; parentId: string; live: boolean; onClose: () => void }) {
  const convId = ctx.conv.id;
  const parent = useChat((s) => s.timelines.get(convId)?.messages.find((m) => m.id === parentId));
  const tl = useChat((s) => s.timelines.get(tlKey(convId, parentId)));
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { void loadLatest(convId, parentId); }, [convId, parentId]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [tl?.messages.length]);
  const author = parent ? ctx.users.get(parent.authorId) : undefined;
  return (
    <aside className="side-panel side-track" aria-label="Side-track">
      <header className="side-head">
        <span className="label">Side-track</span>
        <button className="icon-btn" onClick={onClose} aria-label="Close side-track"><Icon name="x" size={16} /></button>
      </header>
      <div className="side-body">
        {parent ? (
          <div className="track-parent">
            <div className="run-head">
              <Avatar user={{ id: parent.authorId, displayName: author?.displayName ?? '?' }} size="sm" />
              <span className="run-name">{parent.authorId === ctx.meId ? 'You' : author?.displayName}</span>
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
                  <span className="run-name">{m.authorId === ctx.meId ? 'You' : u?.displayName}</span>
                  <span className="run-time">{clock(m.createdAt)}</span>
                </div>
                <MessageItem ctx={ctx} m={m} seenBy={null} inTrack />
              </div>
            );
          })}
          <div ref={end} />
        </div>
      </div>
      <TypingLine k={tlKey(convId, parentId)} users={ctx.users} />
      <Dock convId={convId} parentId={parentId} ctx={ctx} live={live} placeholder="Reply in this side-track" />
    </aside>
  );
}

function PinsPanel({ ctx, onClose, onJump }: { ctx: Ctx; onClose: () => void; onJump: (id: string) => void }) {
  const [pins, setPins] = useState<AnyMessage[] | null>(null);
  const version = useChat((s) => s.version);
  useEffect(() => { void window.dex.request('msg.pins', { convId: ctx.conv.id }).then(setPins).catch(() => setPins([])); }, [ctx.conv.id, version]);
  return (
    <aside className="side-panel" aria-label="Pinned messages">
      <header className="side-head"><span className="label">Pinned · {pins?.length ?? 0}</span><button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button></header>
      <div className="side-body">
        {pins === null && <div className="tl-more"><span className="spinner" /></div>}
        {pins?.length === 0 && <div className="empty"><Icon name="pin" size={28} /><span>Pin important messages so they are easy to find.</span></div>}
        {pins?.map((m) => (
          <button key={m.id} className="pin-card" onClick={() => onJump(m.id)}>
            <div className="run-head"><span className="run-name">{ctx.users.get(m.authorId)?.displayName}</span><span className="run-time">{dayLabel(m.createdAt)} {clock(m.createdAt)}</span></div>
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
            <span className="sb-main"><span className="sb-name">{u.id === ctx.meId ? `${u.displayName} (you)` : u.displayName}</span><span className="sb-preview">{u.statusText ?? u.title ?? u.account}</span></span>
          </div>
        ))}
        {c.kind === 'space' && (ctx.isAdmin || c.createdBy === ctx.meId || c.moderators.includes(ctx.meId)) && <SpaceSettings c={c} users={members} />}
        {c.kind === 'space' && !c.everyone && (
          <button className="btn ghost danger" style={{ marginTop: 16 }} onClick={() => { if (confirm(`Leave ${c.name}?`)) void window.dex.request('conv.leave', { convId: c.id }).catch((e: Error) => toast(e.message, true)); }}>Leave this Space</button>
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
      {!c.everyone && <button className="btn" onClick={() => { if (confirm(`Archive ${c.name}? It becomes read-only for everyone until it is restored.`)) act(window.dex.request('conv.archive', { convId: c.id, archived: true }), 'Space archived'); }}><Icon name="archive" size={15} />Archive this Space</button>}
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

