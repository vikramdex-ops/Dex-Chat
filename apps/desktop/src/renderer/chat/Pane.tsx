// A conversation pane: header, the spine timeline, typing line and the Dock composer, with an
// optional side panel (side-track, pins or members) on the right.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { Conversation, FileInfo, PublicUser, Session } from '@dex/core';
import { AttachmentTray, FilesPanel, Lightbox, MessageFiles, filesSupported, startUploads } from './files.tsx';
import type { Attachment } from './files.tsx';
import { Avatar, Icon, Popover, colorFor, useToast, presenceFor } from '../ui.tsx';
import { isEmojiOnly, renderBody } from './format.tsx';
import {
  chatState, discardFailed, loadLatest, loadOlder, markRead, notifyTyping, retrySend, sendMessage,
  setActiveConversation, setDraft, tlKey, useChat,
} from './store.ts';
import type { AnyMessage, PendingMessage } from './store.ts';
import { ConvTile, convTitle } from './Switchboard.tsx';
import { CallButtons } from '../rooms/RoomUi.tsx';
import { ForwardDialog, ForwardedTag, PollCard, PollDialog, RemindDialog, ScheduleDialog, markUnreadFrom } from './extras.tsx';
import { describeWhen, toggleSaved, useDesk } from '../desk/store.ts';
import { EventDialog } from '../calendar/CalendarView.tsx';

const QUICK = ['👍', '✅', '👀', '🙏', '🎉', '😂'];
const EMOJI = ['👍', '👎', '✅', '❌', '👀', '🙏', '🎉', '😂', '😊', '😅', '🤔', '😮', '😢', '🔥', '💯', '👏', '🙌', '💪', '🚀', '⚠️', '📌', '📎', '📐', '🛠️', '☕', '🍕', '⏰', '📅', '❤️', '⭐'];
const RUN_GAP = 5 * 60 * 1000;

type Side = { kind: 'track'; parentId: string } | { kind: 'pins' } | { kind: 'members' } | { kind: 'files' } | null;

interface Ctx {
  users: Map<string, PublicUser>; meId: string; isAdmin: boolean; conv: Conversation; online: Set<string>;
  view: (f: FileInfo, all: FileInfo[]) => void;
}

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
export function Pane({ convId, users, meId, isAdmin, online, live, onBack, session }: {
  convId: string; users: Map<string, PublicUser>; meId: string; isAdmin: boolean; online: Set<string>; live: boolean; onBack?: () => void; session?: Session;
}) {
  const conv = useChat((s) => s.conversations.get(convId));
  const [side, setSide] = useState<Side>(null);
  const [viewer, setViewer] = useState<{ file: FileInfo; all: FileInfo[] } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [planning, setPlanning] = useState(false);
  const toast = useToast();

  useEffect(() => { setSide(null); }, [convId]);

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
  const ctx: Ctx = { users, meId, isAdmin, conv, online, view: (file, all) => setViewer({ file, all }) };
  const canAttach = filesSupported() && live;
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
            <p className="faint">{subtitle}</p>
          </div>
          <div className="row-actions">
            {conv.members.length > 1 && <CallButtons convId={convId} live={live} />}
            <span className="head-sep" />
            {live && session && session.me.role !== 'guest' && <button className="icon-btn" title="Plan a meeting with these people" onClick={() => setPlanning(true)}><Icon name="calendar" size={17} /></button>}
            <button className={`icon-btn${side?.kind === 'files' ? ' on' : ''}`} title="Files" onClick={() => setSide(side?.kind === 'files' ? null : { kind: 'files' })}><Icon name="paperclip" size={17} /></button>
            <button className={`icon-btn${side?.kind === 'pins' ? ' on' : ''}`} title="Pinned" onClick={() => setSide(side?.kind === 'pins' ? null : { kind: 'pins' })}><Icon name="pin" size={17} /></button>
            <button className={`icon-btn${side?.kind === 'members' ? ' on' : ''}`} title="People" onClick={() => setSide(side?.kind === 'members' ? null : { kind: 'members' })}><Icon name="people" size={17} /></button>
            <button className={`icon-btn${conv.muted ? ' on' : ''}`} title={conv.muted ? 'Unmute' : 'Mute'}
              onClick={() => void window.dex.request('conv.mute', { convId, muted: !conv.muted }).then(() => toast(conv.muted ? 'Notifications on' : 'Muted. You will still hear about mentions.')).catch((e: Error) => toast(e.message, true))}>
              <Icon name={conv.muted ? 'mute' : 'bell'} size={17} />
            </button>
          </div>
        </header>
        <Timeline ctx={ctx} onTrack={(parentId) => setSide({ kind: 'track', parentId })} activeTrack={side?.kind === 'track' ? side.parentId : null} />
        <TypingLine k={tlKey(convId)} users={users} />
        <Dock convId={convId} parentId={null} ctx={ctx} live={live} placeholder={`Message ${conv.kind === 'space' ? title : others.length === 1 ? title.split(' ')[0] : 'the group'}`} />
      </section>
      {side?.kind === 'track' && <SideTrack ctx={ctx} parentId={side.parentId} live={live} onClose={() => setSide(null)} />}
      {side?.kind === 'pins' && <PinsPanel ctx={ctx} onClose={() => setSide(null)} onJump={(id) => setSide({ kind: 'track', parentId: id })} />}
      {side?.kind === 'members' && <MembersPanel ctx={ctx} onClose={() => setSide(null)} />}
      {side?.kind === 'files' && <FilesPanel convId={convId} onView={ctx.view} onClose={() => setSide(null)} />}
      {viewer && <Lightbox file={viewer.file} all={viewer.all} onClose={() => setViewer(null)} />}
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
  const canDelete = mine || (ctx.isAdmin && ctx.conv.kind === 'space');
  const mentioned = m.mentions.includes(ctx.meId) || (m.mentions.includes('all') && !mine);

  // ArrowUp in an empty Dock edits your last message
  useEffect(() => {
    const onEdit = (e: Event) => { if ((e as CustomEvent).detail === m.id) setEditing(true); };
    window.addEventListener('dex-edit', onEdit);
    return () => window.removeEventListener('dex-edit', onEdit);
  }, [m.id]);

  const act = (p: Promise<unknown>, ok?: string) => p.then(() => ok && toast(ok)).catch((e: Error) => toast(e.message, true));
  const react = (emoji: string) => {
    const on = !(m.reactions[emoji] ?? []).includes(ctx.meId);
    setPicker(false);
    void act(window.dex.request('msg.react', { messageId: m.id, emoji, on }));
  };

  if (m.deleted) return <div className="msg deleted"><span className="faint">Message deleted</span></div>;

  return (
    <div data-mid={m.id} className={`msg${pending ? ' pending' : ''}${failed ? ' failed' : ''}${mentioned ? ' mentioned' : ''}${activeTrack === m.id ? ' tracked' : ''}${m.pinned ? ' pinned' : ''}`}>
      {m.forwardedFrom && <ForwardedTag m={m} users={ctx.users} meId={ctx.meId} />}
      {m.poll ? <PollCard m={m} meId={ctx.meId} users={ctx.users} /> : editing ? (
        <EditBox m={m} ctx={ctx} onDone={() => setEditing(false)} />
      ) : (
        m.body ? (
          <div className={`msg-text selectable${isEmojiOnly(m.body) ? ' big' : ''}`}>
            {renderBody(m.body, ctx.users, ctx.meId)}
            {m.editedAt && <span className="edited"> (edited)</span>}
          </div>
        ) : null
      )}
      <MessageFiles files={m.files ?? []} onView={ctx.view} />

      {Object.keys(m.reactions).length > 0 && (
        <div className="reactions">
          {Object.entries(m.reactions).map(([emoji, who]) => (
            <button key={emoji} className={`reaction${who.includes(ctx.meId) ? ' mine' : ''}`} onClick={() => react(emoji)}
              title={who.map((id) => (id === ctx.meId ? 'You' : ctx.users.get(id)?.displayName ?? 'Someone')).join(', ')}>
              <span>{emoji}</span><span className="n">{who.length}</span>
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
          {mine && m.body && !m.poll && <button onClick={() => setEditing(true)} title="Edit"><Icon name="edit" size={16} /></button>}
          <button ref={moreBtn} onClick={() => setMore(!more)} title="More" aria-haspopup="menu" aria-expanded={more}><Icon name="more" size={16} /></button>
          {more && (
            <Popover anchor={moreBtn.current} onClose={() => setMore(false)} className="menu msg-menu">
              <button role="menuitem" onClick={() => { setMore(false); setDialog('forward'); }}><Icon name="forward" size={16} />Forward</button>
              <button role="menuitem" onClick={() => { setMore(false); void act(window.dex.request('msg.pin', { messageId: m.id, pinned: !m.pinned }), m.pinned ? 'Unpinned' : 'Pinned for everyone here'); }}><Icon name="pin" size={16} />{m.pinned ? 'Unpin' : 'Pin'}</button>
              {!inTrack && !m.parentId && <button role="menuitem" onClick={() => { setMore(false); void act(markUnreadFrom(m), 'Marked as unread from here'); }}><Icon name="unread" size={16} />Mark unread from here</button>}
              {m.body && <button role="menuitem" onClick={() => { setMore(false); void navigator.clipboard.writeText(m.body); toast('Copied'); }}><Icon name="copy" size={16} />Copy text</button>}
              {canDelete && <><div className="menu-sep" /><button role="menuitem" className="danger" onClick={() => { setMore(false); if (confirm('Delete this message for everyone?')) void act(window.dex.request('msg.delete', { messageId: m.id })); }}><Icon name="trash" size={16} />Delete</button></>}
            </Popover>
          )}
          {picker && (
            <Popover anchor={pickBtn.current} onClose={() => setPicker(false)} className="emoji-pop">
              {EMOJI.map((e) => <button key={e} onClick={() => react(e)}>{e}</button>)}
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

function Dock({ convId, parentId, ctx, live, placeholder }: { convId: string; parentId: string | null; ctx: Ctx; live: boolean; placeholder: string }) {
  const key = tlKey(convId, parentId);
  const [text, setText] = useState(() => chatState().drafts.get(key) ?? '');
  const [mention, setMention] = useState<{ q: string; start: number } | null>(null);
  const [mIndex, setMIndex] = useState(0);
  const [emoji, setEmoji] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dockDialog, setDockDialog] = useState<'poll' | 'schedule' | null>(null);
  const scheduledAll = useDesk((s) => s.scheduled);
  const scheduledHere = useMemo(() => [...scheduledAll.values()].filter((x) => x.convId === convId && (x.parentId ?? null) === parentId).sort((a, b) => a.sendAt - b.sendAt), [scheduledAll, convId, parentId]);
  const toast = useToast();
  const ref = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const canAttach = filesSupported() && live;

  const addFiles = (files: File[]) => {
    if (!files.length || !canAttach) return;
    const room = 20 - attachments.length;
    const fresh = startUploads(files.slice(0, room), (k, patch) =>
      setAttachments((list) => (patch === null ? list.filter((a) => a.key !== k) : list.map((a) => (a.key === k ? { ...a, ...patch } : a)))));
    setAttachments((list) => [...list, ...fresh]);
    ref.current?.focus();
  };
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

  const wrap = (mark: string) => {
    const el = ref.current!;
    const { selectionStart: a, selectionEnd: b } = el;
    const v = `${text.slice(0, a)}${mark}${text.slice(a, b)}${mark}${text.slice(b)}`;
    setText(v);
    setDraft(key, v);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(a + mark.length, b + mark.length); });
  };

  const send = () => {
    const body = toWire(text, ctx.users, ctx.conv);
    if ((!body && !ready.length) || !live || uploading) return;
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
    if (mention && candidates.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMIndex((i) => (i + 1) % candidates.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMIndex((i) => (i - 1 + candidates.length) % candidates.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(candidates[mIndex]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setMention(null); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); return; }
    if (e.key === 'ArrowUp' && !text) {
      const tl = chatState().timelines.get(key);
      const last = [...(tl?.messages ?? [])].reverse().find((m) => m.authorId === ctx.meId && !m.deleted && !('pending' in m));
      if (last) { e.preventDefault(); window.dispatchEvent(new CustomEvent('dex-edit', { detail: last.id })); }
    }
    if (e.ctrlKey && !e.shiftKey && (e.key === 'b' || e.key === 'i')) { e.preventDefault(); wrap(e.key === 'b' ? '**' : '*'); }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'x') { e.preventDefault(); wrap('~~'); }
  };

  return (
    <div className="dock-wrap">
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
          <button className="icon-btn" title="Emoji" onClick={() => setEmoji(!emoji)}><Icon name="smile" size={18} /></button>
          <button className="icon-btn" title="Poll" disabled={!live} onClick={() => setDockDialog('poll')}><Icon name="poll" size={18} /></button>
          <button className="icon-btn" title="Mention someone (@)" onClick={() => { const el = ref.current!; const pos = el.selectionStart; const v = `${text.slice(0, pos)}${pos && !/\s$/.test(text.slice(0, pos)) ? ' ' : ''}@${text.slice(pos)}`; update(v, v.length - text.slice(pos).length); el.focus(); }}><Icon name="at" size={18} /></button>
          {emoji && (
            <div className="emoji-pop dock-emoji" onMouseLeave={() => setEmoji(false)}>
              {EMOJI.map((e) => <button key={e} onClick={() => { const el = ref.current!; const pos = el.selectionStart; const v = text.slice(0, pos) + e + text.slice(pos); setText(v); setDraft(key, v); setEmoji(false); el.focus(); }}>{e}</button>)}
            </div>
          )}
        </div>
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={live ? placeholder : 'Waiting for the office hub…'}
          maxLength={8000}
          onChange={(e) => update(e.target.value, e.target.selectionStart)}
          onKeyDown={onKey}
          onPaste={(e) => { const files = [...e.clipboardData.files]; if (files.length && canAttach) { e.preventDefault(); addFiles(files); } }}
          aria-label={placeholder}
        />
        <button className="icon-btn dock-later" onClick={() => setDockDialog('schedule')} disabled={(!text.trim() && !ready.length) || !live || uploading}
          title="Send later" aria-label="Schedule message"><Icon name="schedule" size={17} /></button>
        <button className="send" onClick={send} disabled={(!text.trim() && !ready.length) || !live || uploading} title={uploading ? 'Waiting for uploads to finish' : 'Send (Enter)'} aria-label="Send">
          <Icon name="send" size={18} />
        </button>
      </div>
      {dockDialog === 'poll' && <PollDialog conv={ctx.conv} parentId={parentId} onClose={() => setDockDialog(null)} />}
      {dockDialog === 'schedule' && <ScheduleDialog preview={toWire(text, ctx.users, ctx.conv)} users={ctx.users} meId={ctx.meId} onPick={schedule} onClose={() => setDockDialog(null)} />}
      <div className="dock-hint faint">
        {scheduledHere.length > 0 && <span className="sched-note"><Icon name="schedule" size={13} />{scheduledHere.length === 1 ? `1 message scheduled · ${describeWhen(scheduledHere[0].sendAt)}` : `${scheduledHere.length} messages scheduled`} · see Desk</span>}
        <span><b>Enter</b> send · <b>Shift+Enter</b> new line · <b>↑</b> edit last · <b>**bold**</b> <i>*italic*</i> <code>`code`</code></span>
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
        {c.kind === 'space' && !c.everyone && (
          <button className="btn ghost danger" style={{ marginTop: 16 }} onClick={() => { if (confirm(`Leave ${c.name}?`)) void window.dex.request('conv.leave', { convId: c.id }).catch((e: Error) => toast(e.message, true)); }}>Leave this Space</button>
        )}
      </div>
    </aside>
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

