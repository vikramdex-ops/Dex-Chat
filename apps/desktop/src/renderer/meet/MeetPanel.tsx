// The meeting panel's tabs beside the Room: the meeting conversation's Chat, its Polls, its
// whiteboards (Board) and its Files, without leaving the Room. Everything is the conversation's
// own data from the chat store and hub, so what is said here is in the conversation afterwards.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Board, FileInfo, Message, PublicUser } from '@dex/core';
import { Avatar, Icon } from '../ui.tsx';
import { loadLatest, markRead, sendMessage, useChat } from '../chat/store.ts';
import type { AnyMessage } from '../chat/store.ts';
import { renderBody } from '../chat/format.tsx';
import { PollCard, PollDialog } from '../chat/extras.tsx';
import { BoardsList } from '../chat/boards.tsx';
import { WhiteboardStage } from '../chat/Whiteboard.tsx';
import { FilesPanel, Lightbox } from '../chat/files.tsx';
import { capName, clock } from '../rooms/engine.ts';

type Tab = 'chat' | 'polls' | 'board' | 'files';

export default function MeetPanel({ tab, convId, users, meId }: { tab: Tab; convId: string; users: Map<string, PublicUser>; meId: string }) {
  const conv = useChat((s) => s.conversations.get(convId));
  const loaded = useChat((s) => s.timelines.get(convId)?.loaded ?? false);
  useEffect(() => { if (conv && !loaded) void loadLatest(convId); }, [convId, !!conv, loaded]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!conv) {
    return (
      <div className="meet-visitor">
        <Icon name="lock" size={20} />
        <p>You were let into this meeting from outside its conversation, so its chat, polls, board and files stay with its members.</p>
      </div>
    );
  }
  if (tab === 'chat') return <ChatTab convId={convId} users={users} meId={meId} />;
  if (tab === 'polls') return <PollsTab convId={convId} users={users} meId={meId} />;
  if (tab === 'board') return <BoardTab convId={convId} />;
  return <FilesTab convId={convId} />;
}

const visible = (m: AnyMessage) => !m.parentId && !m.deleted;

function ChatTab({ convId, users, meId }: { convId: string; users: Map<string, PublicUser>; meId: string }) {
  const messages = useChat((s) => s.timelines.get(convId)?.messages);
  const [text, setText] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const shown = (messages ?? []).filter(visible).slice(-120);
  const last = shown[shown.length - 1]?.id;
  // stay at the newest message; reading it here counts as read
  useLayoutEffect(() => { const el = list.current; if (el) el.scrollTop = el.scrollHeight; }, [last]);
  useEffect(() => { if (last) markRead(convId); }, [last, convId]);
  const send = () => {
    const body = text.trim();
    if (!body) return;
    setText('');
    void sendMessage(convId, body);
  };
  return (
    <div className="meet-chat">
      <div ref={list} className="meet-chat-list" aria-live="polite">
        {messages === undefined && <div className="tl-more"><span className="spinner" /></div>}
        {messages !== undefined && !shown.length && <p className="meet-empty">Nothing said yet. What you write here stays in the conversation after the meeting.</p>}
        {shown.map((m, i) => {
          const prev = shown[i - 1];
          const run = prev && prev.authorId === m.authorId && m.createdAt - prev.createdAt < 5 * 60_000 && !m.system && !prev.system;
          return <ChatLine key={m.id} m={m} run={!!run} users={users} meId={meId} />;
        })}
      </div>
      <form className="meet-compose" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <textarea className="input" rows={1} value={text} placeholder="Write to everyone in the meeting" aria-label="Message to the meeting"
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <button className="icon-btn" disabled={!text.trim()} aria-label="Send" title="Send (Enter)"><Icon name="send" size={16} /></button>
      </form>
    </div>
  );
}

function ChatLine({ m, run, users, meId }: { m: AnyMessage; run: boolean; users: Map<string, PublicUser>; meId: string }) {
  const u = users.get(m.authorId);
  const pending = 'pending' in m;
  if (m.system) {
    const who = u?.displayName ?? 'Someone';
    const them = m.system.users.map((id) => users.get(id)?.displayName ?? 'someone').join(', ');
    const what = m.system.kind === 'joined' ? `${who} joined` : m.system.kind === 'left' ? `${who} left` : m.system.kind === 'added' ? `${who} added ${them}`
      : m.system.kind === 'removed' ? `${who} removed ${them}` : m.system.kind === 'renamed' ? `${who} renamed it ${m.system.name ?? ''}` : `${who} is away`;
    return <div className="meet-chat-sys mono">{what.toUpperCase()} · {clock(m.createdAt)}</div>;
  }
  return (
    <div className={`meet-chat-line${run ? ' run' : ''}${m.authorId === meId ? ' mine' : ''}${pending ? ' pending' : ''}`}>
      {!run && (
        <div className="meet-chat-head">
          <Avatar user={{ id: m.authorId, displayName: u?.displayName ?? 'Someone' }} size="sm" />
          <span className="mono">{m.authorId === meId ? 'YOU' : capName(u?.displayName ?? 'Someone')}</span>
          <span className="mono faint">{clock(m.createdAt)}</span>
        </div>
      )}
      <div className="meet-chat-body selectable">
        {m.poll ? <span className="faint"><Icon name="poll" size={13} /> Poll: {m.poll.question}</span> : renderBody(m.body, users, meId)}
        {m.files.length > 0 && <span className="faint"><Icon name="paperclip" size={13} /> {m.files.map((f) => f.name).join(', ')}</span>}
        {'failed' in m && m.failed && <span className="field-error">{m.failed}</span>}
      </div>
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
