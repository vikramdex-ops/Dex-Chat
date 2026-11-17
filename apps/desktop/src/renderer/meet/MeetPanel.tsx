// The meeting panel's tabs beside the Room: the meeting conversation's Chat, its Polls, its
// whiteboards (Board) and its Files, without leaving the Room. Everything is the conversation's
// own data from the chat store and hub, so what is said here is in the conversation afterwards.
// When the Room has people who cannot read the conversation (guests from a browser, people let in
// from outside), the Chat tab also has the meeting chat: everyone in the Room reads it, it is shared
// by the breakout rooms, and it is saved in the meeting's thread as it is said. Either chat logs an
// action point from a line starting /action, AP: or →; the Register tab is the meeting's register.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Board, FileInfo, Message, PublicUser, RoomChatLine, RoomInfo } from '@dex/core';
import { Avatar, Icon } from '../ui.tsx';
import { chatState, loadLatest, markRead, sendMessage, useChat } from '../chat/store.ts';
import type { AnyMessage } from '../chat/store.ts';
import { renderBody } from '../chat/format.tsx';
import { PollCard, PollDialog } from '../chat/extras.tsx';
import { BoardsList } from '../chat/boards.tsx';
import { WhiteboardStage } from '../chat/Whiteboard.tsx';
import { FilesPanel, Lightbox } from '../chat/files.tsx';
import { capName, clock } from '../rooms/engine.ts';
import { sendRoomChat, setChatOpen, useRoomChat } from './live.ts';
import { ActionDialog, ActionPreview, actionWords, logAction, ownerPool, ownerText, useActionDraft } from './actions.tsx';
import Register from './Register.tsx';
import { apRef } from '@dex/core';
import { useToast } from '../ui.tsx';

type Tab = 'chat' | 'register' | 'polls' | 'board' | 'files';

export default function MeetPanel({ tab, convId, users, meId, room }: { tab: Tab; convId: string; users: Map<string, PublicUser>; meId: string; room?: RoomInfo }) {
  const conv = useChat((s) => s.conversations.get(convId));
  const loaded = useChat((s) => s.timelines.get(convId)?.loaded ?? false);
  const roomLines = useRoomChat(room?.id ?? null);
  useEffect(() => { if (conv && !loaded) void loadLatest(convId); }, [convId, !!conv, loaded]); // eslint-disable-line react-hooks/exhaustive-deps
  // people in the Room who cannot read the conversation: the meeting chat is where they talk
  const mixed = !!room && (!!room.visitors?.length || room.participants.some((p) => !!conv && !conv.members.includes(p.userId)));
  if (tab === 'chat' && room && (!conv || mixed || roomLines.length > 0)) {
    return <ChatSwitch room={room} conv={!!conv} convId={convId} users={users} meId={meId} lines={roomLines} />;
  }
  if (!conv) {
    return (
      <div className="meet-visitor">
        <Icon name="lock" size={20} />
        <p>You were let into this meeting from outside its conversation, so its chat, polls, board and files stay with its members.</p>
      </div>
    );
  }
  if (tab === 'chat') return <ChatTab convId={convId} users={users} meId={meId} room={room} />;
  if (tab === 'register' && room) return <Register room={room} users={users} meId={meId} />;
  if (tab === 'polls') return <PollsTab convId={convId} users={users} meId={meId} />;
  if (tab === 'board') return <BoardTab convId={convId} />;
  return <FilesTab convId={convId} />;
}

const visible = (m: AnyMessage) => !m.parentId && !m.deleted;

/** The Chat tab with two sheets: the meeting chat (everyone here) and the conversation (members). */
function ChatSwitch({ room, conv, convId, users, meId, lines }: { room: RoomInfo; conv: boolean; convId: string; users: Map<string, PublicUser>; meId: string; lines: RoomChatLine[] }) {
  const [which, setWhich] = useState<'room' | 'conv'>('room');
  const showing = conv ? which : 'room';
  return (
    <div className="meet-chat-switch">
      {conv && (
        <div className="meet-chat-tabs" role="tablist" aria-label="Which chat">
          <button role="tab" aria-selected={showing === 'room'} onClick={() => setWhich('room')}>Everyone here<span className="mono">{lines.length}</span></button>
          <button role="tab" aria-selected={showing === 'conv'} onClick={() => setWhich('conv')}>Members only</button>
        </div>
      )}
      {showing === 'room' ? <RoomChatTab room={room} meId={meId} lines={lines} users={users} convId={convId} /> : <ChatTab convId={convId} users={users} meId={meId} room={room} />}
    </div>
  );
}

/** The meeting chat: lines from everyone in the Room, guests included; saved in the meeting's thread as said. */
function RoomChatTab({ room, meId, lines, users, convId }: { room: RoomInfo; meId: string; lines: RoomChatLine[]; users: Map<string, PublicUser>; convId: string }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [promote, setPromote] = useState<Message | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const conv = useChat((s) => s.conversations.get(convId));
  const pool = useMemo(() => ownerPool(conv, users, room), [conv, users, room]);
  const words = actionWords(text);
  const [draft, pick, reset] = useActionDraft(words ?? '', pool, meId);
  const last = lines[lines.length - 1]?.id;
  useLayoutEffect(() => { const el = list.current; if (el) el.scrollTop = el.scrollHeight; }, [last]);
  useEffect(() => { setChatOpen(true); return () => setChatOpen(false); }, []);
  const send = () => {
    const body = text.trim();
    if (!body) return;
    setProblem(null);
    if (words !== null && conv) {
      setText('');
      void logAction(convId, { ...draft, source: 'chat' }, { roomId: room.id, ownerLabel: draft.ownerId || draft.ownerName ? ownerText(draft, users, '') : '' })
        .then((a) => { toast(`${apRef(a.n)} logged`); reset(); }).catch((e: Error) => { setProblem(e.message); setText(body); });
      return;
    }
    setText('');
    void sendRoomChat(room.id, body).catch((e: Error) => { setProblem(e.message); setText(body); });
  };
  const promoteLine = (l: RoomChatLine) => {
    const m = l.messageId ? chatState().timelines.get(convId)?.messages.find((x) => x.id === l.messageId) : undefined;
    if (m && 'pending' in m === false) setPromote(m as Message);
    else if (l.messageId) setPromote({ id: l.messageId, convId, authorId: l.userId, body: l.text, files: [], e2e: undefined } as unknown as Message);
  };
  return (
    <div className="meet-chat room-chat">
      <div ref={list} className="meet-chat-list" aria-live="polite">
        {!lines.length && <p className="meet-empty">Everyone in the Room reads this chat, guests from outside too. It is kept in the meeting's thread.</p>}
        {lines.map((l, i) => {
          const prev = lines[i - 1];
          const run = prev && prev.userId === l.userId && prev.name === l.name && l.at - prev.at < 5 * 60_000;
          const mine = l.userId === meId;
          return (
            <div key={l.id} className={`meet-chat-line${run ? ' run' : ''}${mine ? ' mine' : ''}`}>
              {!run && (
                <div className="meet-chat-head">
                  <Avatar user={{ id: l.userId, displayName: l.name }} size="sm" />
                  <span className="mono" translate={mine ? undefined : 'no'}>{mine ? 'YOU' : capName(l.name)}</span>
                  {l.guest && <span className="role-tag">GUEST</span>}
                  {l.breakout && <span className="mono faint">{l.breakout.toUpperCase()}</span>}
                  <span className="mono faint">{clock(l.at)}</span>
                </div>
              )}
              {l.text && <div className="meet-chat-body selectable" translate="no">{l.text}</div>}
              {l.file && <div className="meet-chat-file"><Icon name="paperclip" size={13} /><span translate="no">{l.file.name}</span></div>}
              {l.messageId && conv && <button className="meet-line-ap" onClick={() => promoteLine(l)} aria-label="Make an action point" title="Make an action point"><Icon name="action" size={13} /></button>}
            </div>
          );
        })}
      </div>
      {problem && <p className="field-error" style={{ margin: '0 12px' }}>{problem}</p>}
      {words !== null && conv && <ActionPreview draft={draft} pool={pool} meId={meId} onPick={pick} />}
      <form className="meet-compose" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <textarea className="input" rows={1} value={text} maxLength={2000} placeholder="Write to everyone here, guests too" aria-label="Message to everyone in the Room"
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <button className="icon-btn" disabled={!text.trim()} aria-label="Send to everyone here" title="Send (Enter)"><Icon name="send" size={16} /></button>
      </form>
      {promote && <ActionDialog m={promote} conv={conv} users={users} meId={meId} room={room} onClose={() => setPromote(null)} />}
    </div>
  );
}

function ChatTab({ convId, users, meId, room }: { convId: string; users: Map<string, PublicUser>; meId: string; room?: RoomInfo }) {
  const toast = useToast();
  const messages = useChat((s) => s.timelines.get(convId)?.messages);
  const conv = useChat((s) => s.conversations.get(convId));
  const [text, setText] = useState('');
  const [promote, setPromote] = useState<Message | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const pool = useMemo(() => ownerPool(conv, users, room), [conv, users, room]);
  const words = actionWords(text);
  const [draft, pick, reset] = useActionDraft(words ?? '', pool, meId);
  const shown = (messages ?? []).filter(visible).slice(-120);
  const last = shown[shown.length - 1]?.id;
  // stay at the newest message; reading it here counts as read
  useLayoutEffect(() => { const el = list.current; if (el) el.scrollTop = el.scrollHeight; }, [last]);
  useEffect(() => { if (last) markRead(convId); }, [last, convId]);
  const send = () => {
    const body = text.trim();
    if (!body) return;
    setText('');
    if (words !== null) {
      void logAction(convId, { ...draft, source: 'chat' }).then((a) => { toast(`${apRef(a.n)} logged · ${ownerText(a, users, meId)}`); reset(); }).catch((e: Error) => { toast(e.message, true); setText(body); });
      return;
    }
    void sendMessage(convId, body);
  };
  return (
    <div className="meet-chat">
      <div ref={list} className="meet-chat-list" aria-live="polite">
        {messages === undefined && <div className="tl-more"><span className="spinner" /></div>}
        {messages !== undefined && !shown.length && <p className="meet-empty">Nothing said yet. What you write here stays in the conversation after the meeting.</p>}
        {shown.map((m, i) => {
          const prev = shown[i - 1];
          const run = prev && prev.authorId === m.authorId && m.createdAt - prev.createdAt < 5 * 60_000 && !m.system && !prev.system && !m.meetCard && !prev.meetCard;
          return <ChatLine key={m.id} m={m} run={!!run} users={users} meId={meId} onPromote={conv && !('pending' in m) && !m.meetCard && !m.actionPoint ? () => setPromote(m as Message) : undefined} />;
        })}
      </div>
      {words !== null && <ActionPreview draft={draft} pool={pool} meId={meId} onPick={pick} />}
      <form className="meet-compose" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <textarea className="input" rows={1} value={text} placeholder="Write to everyone in the meeting" aria-label="Message to the meeting"
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <button className="icon-btn" disabled={!text.trim()} aria-label="Send" title="Send (Enter)"><Icon name="send" size={16} /></button>
      </form>
      {promote && <ActionDialog m={promote} conv={conv} users={users} meId={meId} room={room} onClose={() => setPromote(null)} />}
    </div>
  );
}

function ChatLine({ m, run, users, meId, onPromote }: { m: AnyMessage; run: boolean; users: Map<string, PublicUser>; meId: string; onPromote?: () => void }) {
  const u = users.get(m.authorId);
  const pending = 'pending' in m;
  if (m.system) {
    const who = u?.displayName ?? 'Someone';
    const them = m.system.users.map((id) => users.get(id)?.displayName ?? 'someone').join(', ');
    const what = m.system.kind === 'joined' ? `${who} joined` : m.system.kind === 'left' ? `${who} left` : m.system.kind === 'added' ? `${who} added ${them}`
      : m.system.kind === 'removed' ? `${who} removed ${them}` : m.system.kind === 'renamed' ? `${who} renamed it ${m.system.name ?? ''}` : `${who} is away`;
    return <div className="meet-chat-sys mono">{what.toUpperCase()} · {clock(m.createdAt)}</div>;
  }
  if (m.meetCard) return <div className="meet-chat-sys mono">{m.meetCard.kind === 'started' ? 'MEETING STARTED' : m.meetCard.kind === 'recap' ? 'RECAP POSTED' : 'CANCELLED'} · {clock(m.createdAt)}</div>;
  const name = u?.displayName ?? m.meetLine?.name ?? 'Someone';
  return (
    <div className={`meet-chat-line${run ? ' run' : ''}${m.authorId === meId ? ' mine' : ''}${pending ? ' pending' : ''}`}>
      {!run && (
        <div className="meet-chat-head">
          <Avatar user={{ id: m.authorId, displayName: name }} size="sm" />
          <span className="mono" translate={m.authorId === meId ? undefined : 'no'}>{m.authorId === meId ? 'YOU' : capName(name)}</span>
          {m.meetLine?.guest && <span className="role-tag">GUEST</span>}
          <span className="mono faint">{clock(m.createdAt)}</span>
        </div>
      )}
      <div className="meet-chat-body selectable">
        {m.poll ? <span className="faint"><Icon name="poll" size={13} /> Poll: {m.poll.question}</span> : renderBody(m.body, users, meId)}
        {m.files.length > 0 && <span className="faint"><Icon name="paperclip" size={13} /> {m.files.map((f) => f.name).join(', ')}</span>}
        {'failed' in m && m.failed && <span className="field-error">{m.failed}</span>}
      </div>
      {m.actionPoint && <span className="meet-chat-ap mono">{apRef(m.actionPoint.n)} · {ownerText(m.actionPoint, users, meId).toUpperCase()}{m.actionPoint.status === 'done' ? ' · DONE' : ''}</span>}
      {onPromote && <button className="meet-line-ap" onClick={onPromote} aria-label="Make an action point" title="Make an action point"><Icon name="action" size={13} /></button>}
    </div>
  );
}

function PollsTab({ convId, users, meId }: { convId: string; users: Map<string, PublicUser>; meId: string }) {
  const conv = useChat((s) => s.conversations.get(convId));
  const messages = useChat((s) => s.timelines.get(convId)?.messages);
  const [creating, setCreating] = useState(false);
  const polls = (messages ?? []).filter((m): m is Message => !!m.poll && !m.deleted && !('pending' in m)).reverse();
  return (
    <div className="meet-polls">
      <button className="btn" onClick={() => setCreating(true)}><Icon name="poll" size={15} />New poll</button>
      {messages !== undefined && !polls.length && <p className="meet-empty">Ask the meeting a question: everyone votes from here or from the conversation.</p>}
      {polls.map((m) => <PollCard key={m.id} m={m} meId={meId} users={users} />)}
      {creating && conv && <PollDialog conv={conv} parentId={null} onClose={() => setCreating(false)} />}
    </div>
  );
}

function BoardTab({ convId }: { convId: string }) {
  const [board, setBoard] = useState<Board | null>(null);
  return (
    <div className="meet-boards">
      <BoardsList convId={convId} onOpen={setBoard} />
      {board && createPortal(<WhiteboardStage board={board} convId={convId} onClose={() => setBoard(null)} />, document.body)}
    </div>
  );
}

function FilesTab({ convId }: { convId: string }) {
  const [view, setView] = useState<{ file: FileInfo; all: FileInfo[] } | null>(null);
  return (
    <div className="meet-files">
      <FilesPanel convId={convId} onView={(file, all) => setView({ file, all })} onClose={() => {}} />
      {view && createPortal(<Lightbox file={view.file} all={view.all} onClose={() => setView(null)} />, document.body)}
    </div>
  );
}
