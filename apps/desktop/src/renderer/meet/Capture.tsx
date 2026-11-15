// On the Room's stage: the capture strip (A, or Ctrl+Shift+A, logs an action point without leaving
// the stage), the agenda item running, and "joined late? catch up", a small card with what was
// said and logged before you came in.
import { useEffect, useMemo, useRef, useState } from 'react';
import { apRef } from '@dex/core';
import type { ActionSource, PublicUser, RoomInfo } from '@dex/core';
import { Icon, useToast } from '../ui.tsx';
import { useChat } from '../chat/store.ts';
import { ActionPreview, logAction, ownerPool, ownerText, useActionDraft, useRegister } from './actions.tsx';
import { useRoomChat } from './live.ts';
import { useAgenda } from './Register.tsx';
import { formatTime } from '../time.ts';

/** Words in, an action point out: the strip, the register's last row, a chat line. */
export function CaptureForm({ room, convId, users, meId, source, autoFocus, onLogged, onClose, next }: {
  room: RoomInfo | null; convId: string; users: Map<string, PublicUser>; meId: string; source: ActionSource; autoFocus?: boolean;
  onLogged?: () => void; onClose?: () => void; next?: number;
}) {
  const toast = useToast();
  const conv = useChat((s) => s.conversations.get(convId));
  const pool = useMemo(() => ownerPool(conv, users, room), [conv, users, room]);
  const [words, setWords] = useState('');
  const [draft, pick, reset] = useActionDraft(words, pool, meId);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const go = async () => {
    if (!draft.task.trim() || busy) return;
    setBusy(true);
    try {
      const a = await logAction(convId, { ...draft, source });
      toast(`${apRef(a.n)} logged · ${ownerText(a, users, meId)}`);
      setWords(''); reset(); onLogged?.();
      input.current?.focus();
    } catch (e) { toast((e as Error).message, true); }
    setBusy(false);
  };
  return (
    <form className="ap-capture-form" onSubmit={(e) => { e.preventDefault(); void go(); }}>
      <div className="ap-capture-row">
        <span className="ap-ref mono" aria-hidden="true">{next ? apRef(next) : 'AP'}</span>
        <input ref={input} className="input" value={words} autoFocus={autoFocus} maxLength={400}
          placeholder="Ravi to send the revised GA by Friday" aria-label="Action point: who, what, by when"
          onChange={(e) => setWords(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape' && onClose) { e.preventDefault(); e.stopPropagation(); onClose(); } }} />
        <button className="btn primary sm" disabled={!draft.task.trim() || busy}><Icon name="action" size={14} />Log</button>
      </div>
      {words.trim() && <ActionPreview draft={draft} pool={pool} meId={meId} next={next} onPick={pick} busy={busy} />}
    </form>
  );
}

const typingIn = (el: Element | null) => !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el as HTMLElement).isContentEditable);

/** The aids drawn on a meeting's stage. */
export function MeetingAids({ room, meId, meDevice, users, onTab }: { room: RoomInfo; meId: string; meDevice: string; users: Map<string, PublicUser>; onTab: (t: 'chat' | 'register') => void }) {
  const [strip, setStrip] = useState(false);
  const reg = useRegister(room.convId, room.occurrenceId);
  // A (not while typing) or Ctrl+Shift+A opens the strip; Escape closes it
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector('.room-stage.folded')) return;
      const plainA = e.key.toLowerCase() === 'a' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !typingIn(document.activeElement);
      const chord = e.key.toLowerCase() === 'a' && (e.ctrlKey || e.metaKey) && e.shiftKey;
      if ((plainA || chord) && !document.querySelector('.scrim, .board-stage, .lightbox, .recap-scrim')) { e.preventDefault(); setStrip(true); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  return (
    <>
      {/* the strip takes the top of the stage while it is open */}
      {!strip && <NowOnAgenda room={room} />}
      <CatchUp room={room} meId={meId} meDevice={meDevice} actions={reg.actions?.filter((a) => !a.carried).length ?? 0} onTab={onTab} hidden={strip} />
      {strip ? (
        <div className="ap-capture" role="dialog" aria-label="Log an action point">
          <span className="cap mono">ACTION POINT</span>
          <CaptureForm room={room} convId={room.convId} users={users} meId={meId} source="strip" autoFocus next={reg.next} onClose={() => setStrip(false)} />
          <span className="mono faint ap-capture-hint">ENTER LOGS · ESC CLOSES</span>
          <button className="icon-btn" aria-label="Close the strip" title="Close (Esc)" onClick={() => setStrip(false)}><Icon name="x" size={14} /></button>
        </div>
      ) : (
        <button className="ap-capture-open" onClick={() => setStrip(true)} title="Log an action point (A or Ctrl+Shift+A)" aria-keyshortcuts="A Control+Shift+A">
          <Icon name="action" size={14} /><span>Action point</span><span className="kbd">A</span>
        </button>
      )}
    </>
  );
}

/** The agenda item running now, with its time box, on the stage's corner. */
function NowOnAgenda({ room }: { room: RoomInfo }) {
  const agenda = useAgenda(room.convId);
  const now = agenda?.items.find((i) => !i.doneAt);
  if (!agenda || !now) return null;
  const n = agenda.items.indexOf(now) + 1;
  return (
    <div className="agenda-now" role="status" aria-label={`On the agenda now: ${now.text}`}>
      <span className="mono">AGENDA {String(n).padStart(2, '0')}/{String(agenda.items.length).padStart(2, '0')}</span>
      <b translate="no">{now.text}</b>
      {now.minutes && <span className="mono faint">{now.minutes} MIN</span>}
    </div>
  );
}

/** Joined more than three minutes after it started: what you missed, once. */
function CatchUp({ room, meId, meDevice, actions, onTab, hidden }: { room: RoomInfo; meId: string; meDevice: string; actions: number; onTab: (t: 'chat' | 'register') => void; hidden: boolean }) {
  const [gone, setGone] = useState(false);
  const mine = room.participants.find((p) => p.deviceId === meDevice);
  const joined = useRef(mine?.joinedAt ?? Date.now()).current;
  const lines = useRoomChat(room.id);
  const msgs = useChat((s) => s.timelines.get(room.convId)?.messages);
  const late = joined - room.startedAt > 3 * 60_000 && room.startedBy !== meId;
  // counted on the hub: the thread may not be loaded yet, and only its latest page ever is
  const [counted, setCounted] = useState<number | null>(null);
  useEffect(() => {
    if (!late) return;
    let live = true;
    window.dex.request('room.missed', { roomId: room.id, before: joined }).then((r) => { if (live) setCounted(r.messages); }).catch(() => { /* fall back to what is loaded */ });
    return () => { live = false; };
  }, [late, room.id, joined]);
  if (!late || gone || hidden) return null;
  const loaded = new Set([...lines.filter((l) => l.at < joined).map((l) => l.messageId ?? l.id), ...(msgs ?? []).filter((m) => m.createdAt >= room.startedAt && m.createdAt < joined && !m.meetCard && !m.parentId).map((m) => m.id)]).size;
  const said = Math.max(counted ?? 0, loaded);
  if (!said && !actions) return null;
  const since = formatTime(room.startedAt);
  return (
    <div className="catch-up" role="status">
      <span className="cap mono">WHAT YOU MISSED</span>
      <span>{`Since ${since}`}</span>
      <span className="mono">{said === 1 ? '1 message' : `${said} messages`}</span>
      <span className="mono">{actions === 1 ? '1 action point' : `${actions} action points`}</span>
      <button className="btn sm" onClick={() => { onTab('chat'); setGone(true); }}>Read the chat</button>
      {actions > 0 && <button className="btn sm ghost" onClick={() => { onTab('register'); setGone(true); }}>See the register</button>}
      <button className="icon-btn" aria-label="Dismiss" onClick={() => setGone(true)}><Icon name="x" size={14} /></button>
    </div>
  );
}
