// Who is waiting (docs/MEETINGS.md): the title bar's indicator, reachable from every lens and sheet,
// listing everyone waiting in the lobbies of meetings you may let people into (with Admit and
// Decline) and your meetings running without you (with Join); the corner cards that drop in when
// someone knocks; and the lobby strip across the top of a Room you host, so a host in the meeting
// sees the lobby whatever tab the panel shows. Small and always loaded.
import { useEffect, useRef, useState } from 'react';
import { formatMeetingId } from '@dex/core';
import type { KnockView, RoomInfo } from '@dex/core';
import { Avatar, Icon, Popover, useToast } from '../ui.tsx';
import { joinMeeting, useCall } from '../rooms/engine.ts';
import { answerAll, answerKnock, knockName, laterKnock, openKnocks, useKnocks, waitedText } from './knocks.ts';
import './knocks.css';

/** Re-draw every 30 seconds (waiting times). */
function useTick(ms = 30_000): number {
  const [n, setN] = useState(0);
  useEffect(() => { const t = setInterval(() => setN((x) => x + 1), ms); return () => clearInterval(t); }, [ms]);
  return n;
}

const where = (k: Pick<KnockView, 'kind' | 'title'>) => (k.kind === 'personal' ? 'Your personal room' : k.title);

function Who({ k }: { k: KnockView }) {
  return (
    <span className="knock-who">
      <b translate="no">{k.name}</b>
      {k.guest && <span className="knock-tag" title="Typed by the guest in their browser: nobody has checked it">GUEST · NAME NOT VERIFIED</span>}
    </span>
  );
}

function useAnswer() {
  const toast = useToast();
  return (k: KnockView, allow: boolean) => void answerKnock(k.id, allow)
    .then(() => toast(allow ? (k.live ? `${k.name} is coming in` : `${k.name} is let in: the room opens for them and waits for you`) : `${k.name} was turned away`))
    .catch((e: Error) => toast(e.message, true));
}

/** The title bar's indicator: amber with people waiting; a quieter mark when only your meetings run without you. */
export function LobbyBell() {
  const board = useKnocks((s) => s.board);
  const open = useKnocks((s) => s.open);
  const said = useKnocks((s) => s.said);
  const btn = useRef<HTMLButtonElement>(null);
  useTick();
  const n = board.knocks.length;
  const r = board.rooms.length;
  if (!n && !r) return <span className="knock-sr" role="status" aria-live="polite">{said}</span>;
  const label = n ? (n === 1 ? '1 waiting to join' : `${n} waiting to join`) : r === 1 ? 'Your meeting is running without you' : `${r} of your meetings are running without you`;
  return (
    <>
      <button ref={btn} className={`lobby-bell${n ? ' waiting' : ' quiet'}`} aria-haspopup="dialog" aria-expanded={open} aria-label={label} title={label} onClick={() => openKnocks(!open)}>
        <Icon name={n ? 'bell' : 'video'} size={15} />
        <span className="lobby-bell-text mono">{n ? (n === 1 ? '1 WAITING' : `${n} WAITING`) : 'IN YOUR ROOM'}</span>
      </button>
      <span className="knock-sr" role="status" aria-live="polite">{said}</span>
      {open && btn.current && <Popover anchor={btn.current} onClose={() => openKnocks(false)} className="menu lobby-pop" align="end"><LobbyList /></Popover>}
    </>
  );
}

/** The indicator's list: who waits (by meeting), and your meetings running without you. */
function LobbyList() {
  const board = useKnocks((s) => s.board);
  const answer = useAnswer();
  const toast = useToast();
  const groups = new Map<string, KnockView[]>();
  for (const k of board.knocks) (groups.get(k.meetingId) ?? groups.set(k.meetingId, []).get(k.meetingId)!).push(k);
  const join = (meetingId: string) => { openKnocks(false); void joinMeeting(meetingId, false).catch((e: Error) => toast(e.message, true)); };
  return (
    <div className="lobby-list" role="dialog" aria-label="Who is waiting">
      {[...groups].map(([meetingId, list]) => (
        <section key={meetingId} className="lobby-group" aria-label={`Waiting for ${where(list[0])}`}>
          <div className="tb-head">
            <span className="label">Lobby · <span translate="no">{where(list[0])}</span></span>
            <span className="mono">{formatMeetingId(meetingId)}</span>
          </div>
          {!list[0].hostIn && <p className="lobby-note faint">{list[0].live ? 'No host is in the room. Admit lets them in; they wait there for you.' : 'The room is not open. Admit opens it for them; they wait there for you.'}</p>}
          <ul>
            {list.map((k) => (
              <li key={k.id} className="lobby-row">
                <Avatar user={{ id: k.userId || k.id, displayName: k.name }} size="sm" />
                <span className="lobby-row-main"><Who k={k} /><small className="mono faint">WAITING {waitedText(k.at).toUpperCase()}</small></span>
                <span className="lobby-row-acts">
                  <button className="btn sm ghost" onClick={() => answer(k, false)} aria-label={`Decline ${k.name}`}>Decline</button>
                  <button className="btn sm primary" onClick={() => answer(k, true)} aria-label={`Admit ${k.name}`}>Admit</button>
                </span>
              </li>
            ))}
          </ul>
          {list.length > 1 && (
            <div className="lobby-all">
              <button className="btn sm" onClick={() => void answerAll(meetingId, true).catch((e: Error) => toast(e.message, true))}>Admit all {list.length}</button>
            </div>
          )}
        </section>
      ))}
      {board.rooms.length > 0 && (
        <section className="lobby-group" aria-label="Your meetings running without you">
          <div className="tb-head"><span className="label">Running without you</span></div>
          <ul>
            {board.rooms.map((r) => (
              <li key={r.meetingId} className="lobby-row">
                <span className="lobby-row-main">
                  <b translate="no">{r.kind === 'personal' ? 'Your personal room' : r.title}</b>
                  <small className="faint"><span translate="no">{r.people.map((p) => p.name).join(', ')}</span>{r.people.some((p) => p.guest) ? ' · guests included' : ''}</small>
                </span>
                <span className="lobby-row-acts"><button className="btn sm primary" onClick={() => join(r.meetingId)}><Icon name="video" size={14} />Join</button></span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * Cards that drop in at the corner when someone knocks (up to two; the indicator holds the rest).
 * Not shown for a meeting whose Room you are looking at: its lobby strip shows them there.
 */
export function KnockCards() {
  const knocks = useKnocks((s) => s.board.knocks);
  const later = useKnocks((s) => s.later);
  const room = useCall((s) => s.room);
  const minimized = useCall((s) => s.minimized);
  const answer = useAnswer();
  useTick();
  const shown = knocks.filter((k) => !later.has(k.id) && !(room?.meetingId === k.meetingId && !minimized)).slice(-2);
  if (!shown.length) return null;
  return (
    <div className="reminder-cards knock-cards" role="region" aria-label="Waiting to join">
      {shown.map((k) => (
        <div key={k.id} className="reminder-card knock-card" role="alert">
          <div className="reminder-top">
            <span className="reminder-icon"><Icon name="bell" size={18} /></span>
            <div className="desk-main">
              <span className="label">Waiting in the lobby · {waitedText(k.at)}</span>
              <div className="desk-text"><Who k={k} /></div>
              <span className="faint knock-where"><span translate="no">{where(k)}</span>{k.hostIn ? '' : k.live ? ' · no host in the room yet' : ' · the room is not open yet'}</span>
            </div>
            <button className="icon-btn" aria-label="Later: keep it in the indicator" title="Later: keep it in the indicator" onClick={() => laterKnock(k.id)}><Icon name="x" size={15} /></button>
          </div>
          <div className="reminder-actions">
            <button className="btn sm ghost" onClick={() => answer(k, false)}>Decline</button>
            <button className="btn primary sm" onClick={() => answer(k, true)}><Icon name="check" size={14} />Admit</button>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The lobby across the top of a Room you host: everyone waiting, with Admit, Decline and Admit
 * all, whichever panel tab is open. Announced to screen readers as people arrive.
 */
export function LobbyStrip({ room, nameOf, isGuest, run }: { room: RoomInfo; nameOf: (userId: string) => string; isGuest: (userId: string) => boolean; run: (p: Promise<unknown>) => void }) {
  const waiting = room.lobby ?? [];
  const [said, setSaid] = useState('');
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const before = seen.current;
    seen.current = new Set(waiting.map((l) => l.deviceId));
    if (!before) { if (waiting.length) setSaid(waiting.length === 1 ? `${nameOf(waiting[0].userId)} is waiting in the lobby` : `${waiting.length} people are waiting in the lobby`); return; }
    const fresh = waiting.filter((l) => !before.has(l.deviceId));
    if (fresh.length === 1) setSaid(`${nameOf(fresh[0].userId)} is waiting in the lobby`);
    else if (fresh.length > 1) setSaid(`${fresh.length} people are waiting in the lobby`);
  }, [waiting, nameOf]);
  const admit = (deviceIds: string[] | 'all', allow: boolean) => run(window.dex.request('room.admit', { roomId: room.id, ...(deviceIds === 'all' ? { all: true } : { deviceIds }), allow }));
  return (
    <>
      <span className="knock-sr" role="status" aria-live="assertive">{said}</span>
      {waiting.length > 0 && (
        <section className="lobby-strip" aria-label={waiting.length === 1 ? 'Lobby: 1 waiting' : `Lobby: ${waiting.length} waiting`}>
          <span className="lobby-strip-cap mono"><Icon name="bell" size={13} />LOBBY · {waiting.length}</span>
          <ul>
            {waiting.slice(0, 4).map((l) => (
              <li key={l.deviceId}>
                <span className="knock-who"><b translate="no">{nameOf(l.userId)}</b>{isGuest(l.userId) && <span className="knock-tag">GUEST · NOT VERIFIED</span>}</span>
                <button className="rb-btn plain" onClick={() => admit([l.deviceId], false)} aria-label={`Decline ${nameOf(l.userId)}`}>Decline</button>
                <button className="rb-btn solid" onClick={() => admit([l.deviceId], true)} aria-label={`Admit ${nameOf(l.userId)}`}>Admit</button>
              </li>
            ))}
            {waiting.length > 4 && <li className="faint">{`and ${waiting.length - 4} more in the People tab`}</li>}
          </ul>
          {waiting.length > 1 && <button className="rb-btn solid lobby-strip-all" onClick={() => admit('all', true)}>Admit all {waiting.length}</button>}
        </section>
      )}
    </>
  );
}

