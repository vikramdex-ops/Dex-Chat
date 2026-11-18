// Room surfaces that are always loaded: the Room chip for the title bar, the amber banner when
// someone opens a Room with you, the screen picker and the recording dialog. The Room sheet itself
// (tiles, panel, host controls) and the lobby load only when a Room or meeting starts (Stage.tsx).
import { Suspense, lazy, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PublicUser } from '@dex/core';
import { Avatar, Icon, useToast } from '../ui.tsx';
import { answer, clearNotice, clock, decline, setMinimized, toggleMute, useCall } from './engine.ts';
import { Glyph, useDuration } from './parts.tsx';
import { askEndForEveryone, mayEnd } from '../meet/EndAll.tsx';
import { useLive } from '../meet/live.ts';
import './rooms.css';

const Stage = lazy(() => import('./Stage.tsx'));
// a lounge shows as a small bar, a help-desk session as its own sheet (both load when used)
const LoungeBar = lazy(() => import('../lounges/LoungeBar.tsx'));
const SupportStage = lazy(() => import('../help/Support.tsx'));

/**
 * The Room sheet, loaded the first time a Room or a meeting's lobby opens and kept while it runs
 * (folded into the title bar or open). Notices from the meeting (a host muted you, it ended) show
 * as toasts even when the sheet is not loaded.
 */
export function RoomStage(props: {
  users: Map<string, PublicUser>; title: (convId: string) => string; onOpenConversation: (convId: string) => void; meDevice: string; meId: string;
}) {
  const open = useCall((s) => !!s.room || !!s.lobby);
  const purpose = useCall((s) => s.room?.purpose?.kind ?? null);
  const notice = useCall((s) => s.notice);
  const toast = useToast();
  useEffect(() => { if (notice) { toast(notice.text); clearNotice(); } }, [notice, toast]);
  if (!open) return null;
  if (purpose === 'lounge') return <Suspense fallback={null}><LoungeBar users={props.users} meId={props.meId} meDevice={props.meDevice} /></Suspense>;
  if (purpose === 'support') return <Suspense fallback={null}><SupportStage users={props.users} meId={props.meId} meDevice={props.meDevice} /></Suspense>;
  return <Suspense fallback={null}><Stage {...props} /></Suspense>;
}

/**
 * The Room while it is folded away: an amber "ROOM · 12:04" chip for the title bar with a mic
 * switch. Clicking it unfolds the Room. Nothing shows when there is no Room or it is open.
 */
export function RoomChip({ meId }: { meId?: string }) {
  const room = useCall((s) => s.room);
  const minimized = useCall((s) => s.minimized);
  const muted = useCall((s) => s.muted);
  const unread = useLive((s) => s.unread);
  const toast = useToast();
  const duration = useDuration(room?.startedAt);
  if (!room || !minimized || room.purpose) return null;
  const canEnd = !!meId && mayEnd(room, meId);
  const n = room.participants.length;
  const recording = room.participants.some((p) => p.recording);
  const waiting = room.lobby?.length ?? 0;
  return (
    <div className={`room-chip${muted ? ' muted' : ''}`} role="group" aria-label="Room in progress">
      <button className="room-chip-main" onClick={() => setMinimized(false)} title={n === 1 ? 'Back to the Room · 1 person in it' : `Back to the Room · ${n} people in it`}>
        <span className="room-chip-pip" aria-hidden="true" />
        <span className="room-chip-text">ROOM · {duration}</span>
        {waiting > 0 && <span className="room-chip-wait" title={`${waiting} waiting in the lobby`}>{waiting} WAITING</span>}
        {recording && <span className="rec-dot" title="This Room is being recorded" />}
        {unread > 0 && <span className="room-chip-chat" title={unread === 1 ? '1 unread line in the meeting chat' : `${unread} unread lines in the meeting chat`}><Icon name="chat" size={12} />{unread > 99 ? '99+' : unread}</span>}
      </button>
      <button className="room-chip-mic" onClick={toggleMute} aria-pressed={!muted} aria-label={muted ? 'Turn your mic on' : 'Turn your mic off'} title={muted ? 'Mic off · turn it on' : 'Mic on · turn it off'}>
        <Icon name={muted ? 'mic-off' : 'mic'} size={15} />
      </button>
      {/* the host can end it from any lens, as from the Room's own title block (asked first) */}
      {canEnd && (
        <button className="room-chip-end" onClick={() => askEndForEveryone(room, toast)} aria-label="End for everyone" title="End the meeting for everyone (you are asked first)">
          <span className="mono">END</span>
        </button>
      )}
    </div>
  );
}

export function ScreenPicker({ onPick, onClose, offerSound = true }: { onPick: (id: string, sound: boolean) => void; onClose: () => void; offerSound?: boolean }) {
  const [sources, setSources] = useState<Array<{ id: string; name: string; thumbnail: string }> | null>(null);
  const [sound, setSound] = useState(false);
  const canSound = offerSound && document.documentElement.dataset.platform === 'win32';
  useEffect(() => { void window.dex.listScreens?.().then(setSources).catch(() => setSources([])); }, []);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog wide screen-picker" role="dialog" aria-label="Share your screen">
        <div style={{ display: 'flex', width: '100%', alignItems: 'center' }}><h2 style={{ flex: 1 }}>Share your screen</h2><button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button></div>
        {canSound && <label className="check-line"><input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} />Share the computer's sound too (a video, a presentation)</label>}
        {sources === null && <div className="tl-more"><span className="spinner" /></div>}
        {sources?.length === 0 && <p className="muted" style={{ margin: 0 }}>No screens or windows can be shared from this PC.</p>}
        <div className="screen-grid">
          {sources?.map((s, i) => (
            <button key={s.id} className="screen-option" onClick={() => onPick(s.id, canSound && sound)}>
              <img src={s.thumbnail} alt="" /><span><b className="mono">{String(i + 1).padStart(2, '0')}</b>{s.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Someone is opening a Room with you: an amber banner that drops from the title bar. */
export function IncomingCall({ users, title }: { users: Map<string, PublicUser>; title: (convId: string) => string }) {
  const incoming = useCall((s) => s.incoming);
  const toast = useToast();
  if (!incoming) return null;
  const from = users.get(incoming.from);
  const who = from?.displayName ?? 'Someone';
  const { room } = incoming;
  const group = room.ringing.length + room.participants.length > 2;
  const where = title(room.convId);
  const headline = group ? `${who} is opening a Room in ${where || 'a group'}` : `${who} is opening a Room with you`;
  const meta = [room.video ? 'Video Room' : 'Voice Room', group ? `${room.participants.length} in it` : 'Direct', `opened ${clock(room.startedAt)}`];
  const go = (video: boolean) => void answer(video).catch((e: Error) => toast(e.message, true));
  return createPortal(
    <div className="room-banner" role="alertdialog" aria-label={headline}>
      <Avatar user={{ id: incoming.from, displayName: who }} />
      <div className="room-banner-text">
        <strong>{headline}</strong>
        <span className="mono">{meta.join(' · ').toUpperCase()}</span>
      </div>
      <div className="room-banner-actions">
        <button className={`rb-btn${room.video ? '' : ' solid'}`} onClick={() => go(false)}><Icon name="phone" size={15} />Join with voice</button>
        <button className={`rb-btn${room.video ? ' solid' : ''}`} onClick={() => go(true)}><Icon name="video" size={15} />Join with video</button>
        <button className="rb-btn plain" onClick={decline}>Not now</button>
      </div>
    </div>,
    document.body,
  );
}

/** After a Room recording stops: kept on the hub, shared, or saved on this PC (meet/RecordingDone.tsx). */
export { RecordingReady } from '../meet/RecordingDone.tsx';
