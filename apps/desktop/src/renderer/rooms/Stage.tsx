// The Room, drawn like a drawing sheet: people as tiles in zones (A1, B1 …) laid out as a gallery,
// a speaker view or a presentation, a side panel with sheet tabs on its edge (People, Chat, Polls,
// Board, Files) and the title block that holds the meeting's name, ID and controls. Loaded only
// when a Room or a meeting's lobby opens. Each tile follows its own stream and voice, so a change
// to one person re-renders that tile, not the sheet.
import { Suspense, lazy, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { MEETING_REACTIONS, formatMeetingId, isWebGuest, meetingLink } from '@dex/core';
import type { LobbyRule, PublicUser, RoomInfo, RoomParticipant } from '@dex/core';
import { LOBBY_RULES, lobbyLabel } from '../meet/lobby.ts';
import { Avatar, Dialog, Icon, Popover, colorFor, presenceFor, useToast } from '../ui.tsx';
import {
  answerUnmute, callQuality, capName, clock, hold, holdable, leave, onReaction, raiseHand, react, setBackground, setLayout, setMinimized, setPinned, sheetColumns, startCall,
  toggleCamera, toggleMute, toggleScreen, useCall, zoneRef,
} from './engine.ts';
import type { Layout } from './engine.ts';
import { keepVoices, stopVoices, useActiveSpeaker, useSpeaking, watchVoice } from './speech.ts';
import { blurAvailable } from './blur.ts';
import { OFFICE_BACKGROUNDS, backgroundThumb, setCustomBackground } from './backgrounds.ts';
import type { BackgroundId } from './backgrounds.ts';
import { AudioOut, Clock, Glyph, Video } from './parts.tsx';
import { ScreenPicker } from './RoomUi.tsx';
import { confirmAction } from '../confirm.tsx';
import { addConversation, chatState, useChat } from '../chat/store.ts';
import { recordSupported, startRecording, stopRecording, useRecorder } from './recorder.ts';
import { usePolicy } from '../policy.ts';
import { LobbySheet } from '../meet/Lobby.tsx';
import { HostExtras, SoundMenu, useRoomUsers } from '../meet/RoomExtras.tsx';
import { BreakoutBanner } from '../meet/Breakouts.tsx';
import { MeetingAids } from '../meet/Capture.tsx';
import { useNoise } from './noise.ts';
import { RoomPointers } from '../pointers/surfaces.tsx';
import { ControlLayer, ControlMenuItems, ShareControl } from '../meet/Control.tsx';
import { WEBINAR_TAB_LIST, isWebinarTab } from '../meet/webinar/tabs.ts';
import type { WebinarTab } from '../meet/webinar/tabs.ts';
import { LobbyStrip } from '../meet/LobbyBell.tsx';
import { ChatPeek } from '../meet/ChatPeek.tsx';
import { EndForEveryone } from '../meet/EndAll.tsx';
import { setChatOpen, useLive } from '../meet/live.ts';
import '../meet/meet.css';

const MeetPanel = lazy(() => import('../meet/MeetPanel.tsx'));
// a webinar's stage: its bar and its panel tabs (questions, audience, polls, handouts)
const WebinarPanel = lazy(() => import('../meet/webinar/StageTabs.tsx'));
const WebinarBar = lazy(() => import('../meet/webinar/StageTabs.tsx').then((m) => ({ default: m.WebinarBar })));

type Tab = 'people' | 'chat' | 'register' | 'polls' | 'board' | 'files' | WebinarTab;
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'people', label: 'People' }, { id: 'chat', label: 'Chat' }, { id: 'register', label: 'Register' }, { id: 'polls', label: 'Polls' }, { id: 'board', label: 'Board' }, { id: 'files', label: 'Files' },
];
/** More tiles than this and the gallery turns into numbered sheets (only one sheet's tiles are live). */
const GALLERY_PAGE = 25;

interface StageProps { users: Map<string, PublicUser>; title: (convId: string) => string; onOpenConversation: (convId: string) => void; meDevice: string; meId: string }

export default function Stage(props: StageProps) {
  const room = useCall((s) => s.room);
  const lobby = useCall((s) => s.lobby);
  if (!room && lobby) return <LobbySheet users={props.users} meId={props.meId} />;
  if (!room) return null;
  return <RoomSheet {...props} room={room} />;
}

// ------------------------------------------------------------------ tiles
type MenuOpen = (deviceId: string, anchor: HTMLElement) => void;

/** A reaction floating up a tile: a small callout tag on a leader line, gone after two seconds. */
function Reactions({ deviceId }: { deviceId: string }) {
  const [items, setItems] = useState<Array<{ id: number; emoji: string; x: number }>>([]);
  useEffect(() => {
    let seq = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const off = onReaction(deviceId, (emoji) => {
      const id = ++seq;
      setItems((l) => [...l.slice(-5), { id, emoji, x: 14 + ((id * 37) % 64) }]);
      const t = setTimeout(() => { timers.delete(t); setItems((l) => l.filter((i) => i.id !== id)); }, 2400);
      timers.add(t);
    });
    return () => { off(); for (const t of timers) clearTimeout(t); };
  }, [deviceId]);
  if (!items.length) return null;
  return <div className="room-reacts" aria-hidden="true">{items.map((i) => <span key={i.id} style={{ left: `${i.x}%` }}><b>{i.emoji}</b></span>)}</div>;
}

interface TileProps {
  deviceId: string; userId: string; name: string; me: boolean; muted: boolean; camera: boolean; zone: string;
  hand: number; spotlit: boolean; pinned: boolean; onMenu: MenuOpen | null; className?: string;
  /** This seat is on hold: kept, not connected. */
  held?: boolean;
}

const Tile = memo(function Tile({ deviceId, userId, name, me, muted, camera, zone, hand, spotlit, pinned, onMenu, className, held }: TileProps) {
  const stream = useCall((s) => (me ? s.local : s.peers.get(deviceId)?.streams[0] ?? null));
  // a camera turned on mid-call adds a track to the same stream: follow the track count too
  const tracks = useCall((s) => (me ? s.local : s.peers.get(deviceId)?.streams[0])?.getVideoTracks().length ?? 0);
  const speaking = useSpeaking(me ? `self:${deviceId}` : deviceId) && !muted;
  const hasVideo = camera && tracks > 0 && !!stream && !held;
  const menuBtn = useRef<HTMLButtonElement>(null);
  return (
    <div className={`room-tile${speaking && !held ? ' speaking' : ''}${hasVideo ? ' has-video' : ''}${hand ? ' hand-up' : ''}${held ? ' on-hold' : ''}${className ? ` ${className}` : ''}`} style={{ ['--tint' as string]: colorFor(userId) }}
      data-device={deviceId} aria-label={`${zone} · ${me ? 'You' : name}${held ? ' · on hold' : ''}${muted ? ' · mic off' : ''}${speaking ? ' · speaking' : ''}${hand ? ` · hand raised (${hand})` : ''}`}>
      <div className="room-face">
        {hasVideo ? <Video stream={stream!} muted mirror={me} /> : <Avatar user={{ id: userId, displayName: name }} size="lg" />}
        {held && <span className="room-hold-stamp" aria-hidden="true">ON HOLD</span>}
      </div>
      <span className="room-cap"><b>{zone}</b><span>{me ? 'YOU' : capName(name)}</span>{muted && <Icon name="mic-off" size={12} />}</span>
      {(hand > 0 || spotlit || pinned) && (
        <span className="room-tags">
          {hand > 0 && <span className="room-hand" title={hand === 1 ? 'Hand raised, first in line' : `Hand raised, number ${hand} in line`}><Glyph name="hand" size={13} />{hand}</span>}
          {spotlit && <span className="room-flag" title="Spotlit by the host for everyone"><Glyph name="spotlight" size={12} />SPOTLIGHT</span>}
          {pinned && <span className="room-flag" title="Pinned for you"><Icon name="pin" size={11} />PINNED</span>}
        </span>
      )}
      {onMenu && (
        <button ref={menuBtn} className="room-tile-menu" aria-label={`Options for ${me ? 'your tile' : name}`} title="Pin, spotlight and more" onClick={() => menuBtn.current && onMenu(deviceId, menuBtn.current)}>
          <Glyph name="more" size={16} />
        </button>
      )}
      <Reactions deviceId={deviceId} />
    </div>
  );
});

/** Everyone's voices (and a shared screen's sound), kept playing while the Room is folded away; voices are followed for "who is speaking". */
function RoomAudio({ meDevice }: { meDevice: string }) {
  const peers = useCall((s) => s.peers);
  const local = useCall((s) => s.local);
  useEffect(() => {
    const keep = new Set<string>([`self:${meDevice}`]);
    watchVoice(`self:${meDevice}`, local);
    for (const p of peers.values()) { keep.add(p.deviceId); watchVoice(p.deviceId, p.streams[0] ?? null); }
    keepVoices(keep);
  }, [peers, local, meDevice]);
  useEffect(() => () => stopVoices(), []);
  return (
    <div hidden>
      {[...peers.values()].flatMap((p) => p.streams.filter((s) => s.getAudioTracks().length).map((s) => <AudioOut key={`${p.deviceId}:${s.id}`} stream={s} />))}
    </div>
  );
}

/** The size of an element, kept current as the window changes; `key` changes when the element is replaced. */
function useSize(ref: RefObject<HTMLElement | null>, key: unknown): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, key]);
  return size;
}

/** The column count that gives n tiles (16:10) the most room in a w x h field, and the tile width. */
function fitTiles(n: number, w: number, h: number): { cols: number; tileW: number } {
  const GAP_X = 18, GAP_Y = 22, RATIO = 1.6;
  let best = { cols: sheetColumns(n, false), tileW: 0 };
  if (w <= 0 || h <= 0) return best;
  for (let cols = 1; cols <= Math.min(n, 5); cols++) {
    const rows = Math.ceil(n / cols);
    const tileW = Math.floor(Math.min((w - GAP_X * (cols - 1)) / cols, ((h - GAP_Y * (rows - 1)) / rows) * RATIO));
    if (tileW > best.tileW) best = { cols, tileW };
  }
  return best;
}

function Pager({ page, pages, setPage, what }: { page: number; pages: number; setPage: (n: number) => void; what: string }) {
  if (pages <= 1) return null;
  return (
    <div className="room-pager" role="group" aria-label={what}>
      <button aria-label="Previous sheet" disabled={page === 0} onClick={() => setPage(page - 1)}><Icon name="back" size={14} /></button>
      <span className="mono">SHEET {page + 1} OF {pages}</span>
      <button aria-label="Next sheet" className="flip" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}><Icon name="back" size={14} /></button>
    </div>
  );
}

type Quality = Awaited<ReturnType<typeof callQuality>>;
const QUALITY_WORD: Record<Quality['label'], string> = { good: 'Good', fair: 'Fair', poor: 'Poor', unknown: '' };

/** The link's health, measured every three seconds by itself (the sheet does not re-render for it). */
function LinkQuality({ roomId, alone }: { roomId: string; alone: boolean }) {
  const [quality, setQuality] = useState<Quality | null>(null);
  useEffect(() => {
    setQuality(null);
    const t = setInterval(() => { void callQuality().then(setQuality); }, 3000);
    return () => clearInterval(t);
  }, [roomId]);
  if (!quality || quality.label === 'unknown' || alone) return <span className="mono faint">{alone ? '—' : 'Measuring'}</span>;
  return (
    <span className={`q-${quality.label}`} title={`Round trip ${quality.rttMs ?? '?'} ms · loss ${quality.loss === null ? '?' : `${(quality.loss * 100).toFixed(1)}%`}${quality.relayed ? ' · through a relay' : ''}`}>
      <span className="q-bars"><i /><i /><i /></span>{QUALITY_WORD[quality.label]}{quality.rttMs !== null && <span className="mono faint">{quality.rttMs} ms</span>}
    </span>
  );
}

// ------------------------------------------------------------------ the sheet
interface Seat { deviceId: string; userId: string; me: boolean; p: RoomParticipant | undefined }

function RoomSheet({ users: officeUsers, title, onOpenConversation, meDevice, meId, room }: StageProps & { room: RoomInfo }) {
  const toast = useToast();
  // browser guests have no office account: their names come with the Room
  const users = useRoomUsers(officeUsers, room);
  const noiseOn = useNoise().on;
  const screen = useCall((s) => s.screen);
  const muted = useCall((s) => s.muted);
  const camera = useCall((s) => s.camera);
  const minimized = useCall((s) => s.minimized);
  const layoutPick = useCall((s) => s.layout);
  const pinned = useCall((s) => s.pinned);
  const unmuteAsk = useCall((s) => s.unmuteAsk);
  const heldByOthers = useCall((s) => s.heldByOthers);
  const otherHeld = useCall((s) => !!s.held);
  const policy = usePolicy();
  const recState = useRecorder();
  const myRec = !!recState?.recording;
  const [tab, setTab] = useState<Tab>('people');
  const [picker, setPicker] = useState(false);
  const [adding, setAdding] = useState(false);
  const [pop, setPop] = useState<null | { kind: 'react' | 'background' | 'layout' | 'person' | 'sound'; anchor: HTMLElement; deviceId?: string }>(null);
  const [consent, setConsent] = useState(false);
  const [page, setPage] = useState(0);
  const [who, setWho] = useState('');
  const addBtn = useRef<HTMLButtonElement>(null);
  const fieldRef = useRef<HTMLElement>(null);
  const field = useSize(fieldRef, room.id);
  const [canBlur, setCanBlur] = useState(false);
  useEffect(() => { void blurAvailable().then(setCanBlur); }, []);
  // Escape folds the Room into the title bar (unless a picker or dialog is open over it)
  useEffect(() => {
    if (minimized || picker || adding || pop || consent) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.scrim, .board-stage, .lightbox')) setMinimized(true); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [minimized, picker, adding, pop, consent]);
  // the host sees people knocking whatever tab is open: the lobby strip across the sheet (meet/LobbyBell.tsx),
  // and hears about newcomers in a toast (announced to screen readers)
  const waiting = room.lobby ?? [];
  const knocked = useRef<Set<string> | null>(null);
  useEffect(() => {
    // people already waiting when the sheet opened are on the strip; tell the host about newcomers
    const seen = knocked.current;
    knocked.current = new Set(waiting.map((l) => l.deviceId));
    if (!seen) return;
    const fresh = waiting.filter((l) => !seen.has(l.deviceId));
    if (fresh.length === 1) toast(`${users.get(fresh[0].userId)?.displayName ?? 'Someone'} is waiting in the lobby`);
    else if (fresh.length > 1) toast(`${fresh.length} people are waiting in the lobby`);
  }, [waiting, users, toast]);
  // unread on the Chat tab: the chat it shows. With guests or people from outside (or once anyone used it)
  // that is the meeting chat, whose lines are also saved in the meeting's thread, so they are counted once
  const liveUnread = useLive((s) => s.unread);
  const roomLines = useLive((s) => s.chat.get(room.parentId ?? room.id)?.length ?? 0);
  const chatConv = useChat((s) => s.conversations.get(room.convId));
  const roomChatShown = !chatConv || !!room.visitors?.length || roomLines > 0 || room.participants.some((p) => !chatConv.members.includes(p.userId));
  const chatUnread = roomChatShown ? liveUnread : chatConv?.unread ?? 0;
  useEffect(() => {
    // folded away, the chat is not being read; open again on the Chat tab, it is
    if (minimized) setChatOpen(false);
  }, [minimized]);
  // a meeting chat notification was clicked: back to the Room, on its Chat tab
  useEffect(() => {
    const on = () => { setMinimized(false); setTab('chat'); };
    window.addEventListener('dex-meet-chat', on);
    return () => window.removeEventListener('dex-meet-chat', on);
  }, []);
  const activeSpeaker = useActiveSpeaker();

  const isHost = room.hostId === meId || (room.coHosts ?? []).includes(meId);
  const isMainHost = room.hostId === meId;
  const recorders = [...new Set(room.participants.filter((p) => p.recording).map((p) => p.userId))];
  const conv = chatState().conversations.get(room.convId);
  const convMembers = conv?.members ?? [];
  const convKind = conv?.kind ?? 'space';
  const firstName = (id: string) => users.get(id)?.displayName.split(' ')[0] ?? 'Someone';
  const nameOf = (id: string) => users.get(id)?.displayName ?? 'Someone';
  const others = room.participants.filter((p) => p.deviceId !== meDevice);
  const mine = room.participants.find((p) => p.deviceId === meDevice);
  const seats: Seat[] = [{ deviceId: meDevice, userId: meId, me: true, p: mine }, ...others.map((p) => ({ deviceId: p.deviceId, userId: p.userId, me: false, p }))];
  const hands = room.hands ?? [];
  const handOrder = new Map(hands.map((h, i) => [h.deviceId, i + 1] as const));
  const myHand = handOrder.has(meDevice);
  const spotlight = room.spotlight ?? null;

  // the shared sheet: someone else's screen, or yours
  const shared = others.find((p) => p.screen);
  const sharedStream = useCall((s) => (shared ? s.peers.get(shared.deviceId)?.streams.find((x, i) => i > 0 && x.getVideoTracks().length) ?? null : null));
  const shareStream = sharedStream ?? screen;
  // a spotlight is for everyone: it takes the stage even in the gallery
  const layout: Layout = layoutPick === 'presentation' && !shareStream ? 'speaker' : layoutPick === 'gallery' && spotlight ? 'speaker' : layoutPick;

  // who is large in the speaker and presentation layouts: pinned for you, spotlit by the host, or speaking
  const mainId = layout === 'gallery' ? null
    : (pinned && seats.some((s) => s.deviceId === pinned) ? pinned
      : spotlight && seats.some((s) => s.deviceId === spotlight) ? spotlight
        : activeSpeaker && seats.some((s) => s.deviceId === activeSpeaker) ? activeSpeaker
          : others[0]?.deviceId ?? meDevice);
  const mainSeat = layout === 'speaker' ? seats.find((s) => s.deviceId === mainId) ?? null : null;
  const listed = layout === 'speaker' ? seats.filter((s) => s !== mainSeat) : layout === 'presentation' && spotlight ? [...seats.filter((s) => s.deviceId === spotlight), ...seats.filter((s) => s.deviceId !== spotlight)] : seats;
  const stripMode = layout !== 'gallery';
  const perPage = stripMode ? Math.max(2, Math.min(8, Math.floor((field.w - 56 + 16) / (176 + 16)) || 4)) : GALLERY_PAGE;
  const pages = Math.max(1, Math.ceil(listed.length / perPage));
  const at = Math.min(page, pages - 1);
  useEffect(() => { if (page !== at) setPage(at); }, [page, at]);
  const shown = listed.slice(at * perPage, at * perPage + perPage);
  const alone = others.length === 0;
  // tiles fill the drawing area: the field's content box, less its padding and the pager
  const fit = stripMode ? { cols: shown.length, tileW: 0 } : fitTiles(shown.length + (alone ? 1 : 0), field.w - 56, field.h - 64 - (pages > 1 ? 40 : 0));
  const cols = fit.cols;
  // zones: the main tile is A0 on the sheet; the rest are numbered in reading order
  const zones = new Map<string, string>();
  if (mainSeat) zones.set(mainSeat.deviceId, 'A0');
  listed.forEach((s, i) => zones.set(s.deviceId, stripMode ? `${String.fromCharCode(66 + Math.floor(i / 9))}${(i % 9) + 1}` : zoneRef(i, cols)));

  const openMenu = useCallback<MenuOpen>((deviceId, anchor) => setPop({ kind: 'person', anchor, deviceId }), []);
  const tileFor = (s: Seat, className?: string) => (
    <Tile key={s.deviceId} deviceId={s.deviceId} userId={s.userId} name={nameOf(s.userId)} me={s.me} zone={zones.get(s.deviceId) ?? '··'}
      muted={s.me ? muted : !!s.p?.muted} camera={s.me ? camera : !!s.p?.camera} hand={handOrder.get(s.deviceId) ?? 0}
      spotlit={spotlight === s.deviceId} pinned={pinned === s.deviceId} onMenu={openMenu} className={className} held={!s.me && !!s.p?.held} />
  );

  const run = (p: Promise<unknown>) => void p.catch((e: Error) => toast(e.message, true));
  const host: HostOp = (op, params) => window.dex.request(op as never, { roomId: room.id, ...params } as never);
  const addToCall = async (userId: string) => {
    try {
      if (convMembers.includes(userId)) { await window.dex.request('room.invite', { roomId: room.id, userIds: [userId] }); toast(`Ringing ${firstName(userId)}`); return; }
      // a Direct Room grows into a group Direct and a new Room there
      const rest = convMembers.filter((u) => u !== meId);
      const c = await window.dex.request('conv.create', { kind: 'direct', members: [...rest, userId] });
      addConversation(c);
      leave();
      await startCall(c.id, room.video);
      toast('The Room moved to a group Direct with everyone in it');
    } catch (e) { toast((e as Error).message, true); }
  };
  const float = async () => {
    const v = [...document.querySelectorAll<HTMLVideoElement>('.room-share video, .room-field video')].find((x) => x.videoWidth && !x.style.transform.includes('scaleX(-1)'))
      ?? document.querySelector<HTMLVideoElement>('.room-field video');
    if (!v) { toast('Nothing to float yet: no one has a camera or a screen on.', true); return; }
    try { await v.requestPictureInPicture(); setMinimized(true); } catch (e) { toast((e as Error).message, true); }
  };
  const cameraClick = () => {
    if (!camera && policy.cameraConsent) setConsent(true);
    else void toggleCamera();
  };
  const ringable = adding ? [...users.values()].filter((u) => u.role !== 'bot' && u.id !== meId && !room.participants.some((p) => p.userId === u.id) && !room.ringing.includes(u.id)
    && (convMembers.includes(u.id) || convKind === 'direct') && u.displayName.toLowerCase().includes(who.trim().toLowerCase())) : [];
  // arrow keys move between the panel's tabs (and open the one reached), as in any tab list
  const tabKeys = (e: React.KeyboardEvent<HTMLElement>) => {
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    const list = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    const next = list[(at + step + list.length) % list.length];
    next.focus();
    next.click();
  };
  const copyLink = () => { if (room.meetingId) void navigator.clipboard.writeText(meetingLink(room.meetingId)).then(() => toast('Meeting link copied')); };

  // a breakout room is named for itself; its meeting's name is on the banner
  const name = room.breakoutName ?? (room.title || title(room.convId));
  const kind = room.share ? 'SCREEN' : room.parentId ? 'BREAKOUT' : room.meetingKind === 'webinar' ? 'WEBINAR STAGE' : room.meetingKind === 'instant' ? 'INSTANT' : room.meetingKind === 'personal' ? 'PERSONAL' : room.meetingKind === 'event' ? 'SCHEDULED'
    : convKind === 'space' ? 'SPACE' : convMembers.length > 2 ? 'GROUP' : 'DIRECT';
  const canFloat = typeof document !== 'undefined' && 'pictureInPictureEnabled' in document;
  const canRecord = recordSupported() && (policy.allowRecording || myRec);
  const background = useCall((s) => s.background);
  const bgLabel = background === 'none' ? 'Background' : background === 'blur' ? 'Blur on' : background === 'custom' ? 'Your picture' : OFFICE_BACKGROUNDS.find((b) => b.id === background)?.label ?? 'Background';
  const layoutLabel = layout === 'gallery' ? 'Gallery' : layout === 'speaker' ? 'Speaker' : 'Presentation';

  return createPortal(
    <div className={`room-stage${minimized ? ' folded' : ''}`} role="dialog" aria-label={`Room: ${name}`} aria-hidden={minimized || undefined}>
      <div className={`room-sheet${recorders.length ? ' recording' : ''}`}>
        {recorders.length > 0 && (
          <span className="rec-chip" role="status">
            <span className="rec-dot" /><b>REC</b>
            {recorders.includes(meId) ? 'You are recording' : `${nameOf(recorders[0])} is recording`}<span className="rec-note"> · everyone here is told</span>
          </span>
        )}
        <section ref={fieldRef} className={`room-field layout-${layout}${shareStream && layout === 'presentation' ? ' sharing' : ''}`} aria-label="People in the Room">
          <BreakoutBanner room={room} />
          {isHost && <LobbyStrip room={room} nameOf={nameOf} isGuest={isWebGuest} run={run} />}
          {tab !== 'chat' && <ChatPeek onOpen={() => setTab('chat')} />}
          {room.occurrenceId && <MeetingAids room={room} meId={meId} meDevice={meDevice} users={users} onTab={(t) => setTab(t)} />}
          {room.meetingKind === 'webinar' && <Suspense fallback={null}><WebinarBar room={room} meId={meId} meDevice={meDevice} users={users} /></Suspense>}
          {heldByOthers && (
            <div className="room-held-by-others" role="status">
              <Icon name="hold" size={16} />
              <span>{others.length === 1 ? `${nameOf(others[0].userId)} put the call on hold.` : 'Everyone else put the call on hold.'} You can wait here, or leave: the call is still open.</span>
            </div>
          )}
          {unmuteAsk && muted && (
            <div className="room-ask" role="alertdialog" aria-label="Asked to unmute">
              <Icon name="mic" size={16} />
              <span><b>{nameOf(unmuteAsk.by)}</b> asks you to turn your mic on</span>
              <button className="rb-btn solid" onClick={() => answerUnmute(true)}>Turn mic on</button>
              <button className="rb-btn plain" onClick={() => answerUnmute(false)}>Stay muted</button>
            </div>
          )}
          {layout === 'presentation' && shareStream && (
            <figure className="room-share">
              <Video stream={shareStream} muted fit="contain" />
              {/* the person given control uses the picture with their own pointer and keys instead of live pointers */}
              {!(sharedStream && shared && room.control?.controllerDevice === meDevice) && <RoomPointers presenterDevice={sharedStream && shared ? shared.deviceId : meDevice} users={users} meId={meId} />}
              {sharedStream && shared && <ShareControl room={room} presenter={shared} meDevice={meDevice} nameOf={nameOf} />}
              <figcaption className="room-cap"><b>SHEET</b><span>{screen && !sharedStream ? 'YOUR SCREEN · SHARED' : `${capName(nameOf(shared!.userId))} · SCREEN`}</span></figcaption>
            </figure>
          )}
          {screen && !(layout === 'presentation' && !sharedStream) && <div className="pt-hidden"><RoomPointers presenterDevice={meDevice} users={users} meId={meId} /></div>}
          {mainSeat && <div className="room-main">{tileFor(mainSeat, 'main')}</div>}
          <div className={stripMode ? 'room-strip room-grid' : 'room-grid'} style={stripMode ? undefined : { ['--cols' as string]: cols, ['--tile-w' as string]: fit.tileW ? `${fit.tileW}px` : undefined }}>
            {shown.map((s) => tileFor(s))}
            {alone && !stripMode && (
              <div className="room-tile open-seat">
                <div className="room-face">
                  <span className="open-seat-text">{room.ringing.length ? `Ringing ${room.ringing.map(firstName).join(', ')}` : room.meetingId ? `Share ${formatMeetingId(room.meetingId)} to bring people in` : 'Waiting for someone to come in'}</span>
                  <span className="open-seat-line" aria-hidden="true" />
                </div>
                <span className="room-cap"><b>{zoneRef(1, cols)}</b><span>OPEN SEAT</span></span>
              </div>
            )}
          </div>
          <Pager page={at} pages={pages} setPage={setPage} what={stripMode ? 'More people' : 'Sheets of tiles'} />
        </section>

        <aside className="room-side">
          <div className="room-panel">
            <nav className="room-tabs" role="tablist" aria-label="Meeting panel" aria-orientation="vertical" onKeyDown={tabKeys}>
              {(room.meetingKind === 'webinar' ? WEBINAR_TAB_LIST : TABS.filter((t) => t.id !== 'register' || !!room.occurrenceId)).map((t) => (
                <button key={t.id} role="tab" id={`room-tab-${t.id}`} aria-selected={tab === t.id} tabIndex={tab === t.id ? 0 : -1} aria-controls="room-panel-body" onClick={() => setTab(t.id)}>
                  <span>{t.label}{t.id === 'people' ? ` · ${room.participants.length}` : ''}</span>
                  {t.id === 'people' && isHost && waiting.length > 0 && <i className="room-tab-badge" aria-label={`${waiting.length} waiting`}>{waiting.length}</i>}
                  {t.id === 'people' && hands.length > 0 && !(isHost && waiting.length) && <i className="room-tab-badge hand" aria-label={`${hands.length} hands raised`}>{hands.length}</i>}
                  {t.id === 'chat' && tab !== 'chat' && chatUnread > 0 && <i className="room-tab-badge chat" aria-label={chatUnread === 1 ? '1 unread message' : `${chatUnread} unread messages`}>{chatUnread > 99 ? '99+' : chatUnread}</i>}
                </button>
              ))}
            </nav>
            <div className="room-panel-body" id="room-panel-body" role="tabpanel" aria-labelledby={`room-tab-${tab}`}>
              {tab === 'people'
                ? <PeoplePanel room={room} seats={seats} zones={zones} users={users} meId={meId} muted={muted} camera={camera} isHost={isHost} isMainHost={isMainHost}
                    handOrder={handOrder} onMenu={openMenu} run={run} host={host} meDevice={meDevice} />
                : isWebinarTab(tab) ? <Suspense fallback={<div className="tl-more"><span className="spinner" /></div>}><WebinarPanel tab={tab} room={room} meId={meId} users={users} /></Suspense>
                  : <Suspense fallback={<div className="tl-more"><span className="spinner" /></div>}><MeetPanel tab={tab} convId={room.convId} users={users} meId={meId} room={room} /></Suspense>}
            </div>
          </div>

          <div className="room-block">
            <div className="tb-name">
              <span className="label">{room.parentId ? `Breakout · ${room.title ?? 'meeting'}` : room.meetingKind && room.meetingKind !== 'conversation' ? 'Meeting' : 'Room'}</span>
              <h2 title={name}>{name}</h2>
              <span className="tb-kind mono">{kind}</span>
              {room.meetingId && (
                <button className="tb-id mono" onClick={copyLink} title={`Copy the meeting link (${meetingLink(room.meetingId)})`}>
                  ID {formatMeetingId(room.meetingId)}<Glyph name="copy" size={13} />
                </button>
              )}
              {room.locked && <span className="tb-lock mono" title="No one new can come in"><Icon name="lock" size={11} />LOCKED</span>}
            </div>
            <div className="tb-facts">
              <div><span className="label">Time</span><Clock since={room.startedAt} className="mono tb-big" /></div>
              <div><span className="label">Opened</span><span className="mono">{clock(room.startedAt)}</span></div>
              <div><span className="label">Connection</span><LinkQuality roomId={room.id} alone={others.length === 0} /></div>
            </div>
            <div className="tb-controls">
              <button className={muted ? 'off' : 'on'} aria-pressed={!muted} onClick={toggleMute} title={muted ? 'Turn your mic on' : 'Turn your mic off'}>
                <Icon name={muted ? 'mic-off' : 'mic'} size={18} /><span>{muted ? 'Mic off' : 'Mic on'}</span>
              </button>
              <button className={camera ? 'on' : 'off'} aria-pressed={camera} onClick={cameraClick} title={camera ? 'Turn your camera off' : policy.cameraConsent ? 'Turn your camera on (you are asked first)' : 'Turn your camera on'}>
                <Icon name={camera ? 'video' : 'video-off'} size={18} /><span>{camera ? 'Camera on' : 'Camera off'}</span>
              </button>

              {window.dex.listScreens && (
                <button className={screen ? 'on' : ''} aria-pressed={!!screen} onClick={() => (screen ? void toggleScreen() : setPicker(true))} title={screen ? 'Stop sharing your screen' : 'Share a screen or window with the Room'}>
                  <Icon name="screen" size={18} /><span>{screen ? 'Stop sharing' : 'Share sheet'}</span>
                </button>
              )}
              <button className={myHand ? 'hand' : ''} aria-pressed={myHand} onClick={() => run(raiseHand(!myHand))} title={myHand ? 'Lower your hand' : 'Raise your hand: you join the line to speak'}>
                <Glyph name="hand" /><span>{myHand ? `Hand up · ${handOrder.get(meDevice)}` : 'Raise hand'}</span>
              </button>
              <button aria-expanded={pop?.kind === 'react'} onClick={(e) => setPop({ kind: 'react', anchor: e.currentTarget })} title="Send a reaction to everyone">
                <Glyph name="react" /><span>React</span>
              </button>
              {canBlur && (
                <button className={background !== 'none' ? 'on' : ''} aria-expanded={pop?.kind === 'background'} onClick={(e) => setPop({ kind: 'background', anchor: e.currentTarget })} title="What is behind you on camera (done on this PC)">
                  <Glyph name="backdrop" /><span>{bgLabel}</span>
                </button>
              )}
              <button aria-expanded={pop?.kind === 'layout'} onClick={(e) => setPop({ kind: 'layout', anchor: e.currentTarget })} title="Gallery, speaker or presentation">
                <Glyph name={layout} /><span>{layoutLabel}</span>
              </button>
              {canRecord && (
                <button className={myRec ? 'rec' : ''} aria-pressed={myRec} title={myRec ? 'Stop recording' : 'Record the Room (everyone is told)'}
                  onClick={() => (myRec ? stopRecording() : void startRecording(nameOf, meId).catch((e: Error) => toast(e.message, true)))}>
                  {myRec ? <span className="rec-dot" /> : <Icon name="record" size={18} />}<span>{myRec ? 'Stop recording' : 'Record'}</span>
                </button>
              )}
              <button ref={addBtn} aria-expanded={adding} title="Ring someone into the Room" onClick={() => setAdding(!adding)}>
                <Glyph name="ring" /><span>Ring someone</span>
              </button>
              {holdable(room) && (
                <button className="held-btn" disabled={otherHeld} onClick={() => run(hold())}
                  title={otherHeld ? 'Another call is on hold: resume or end it first' : 'Put the call on hold: your seat is kept, your mic, camera and screen stop, and you hear nothing until you resume'}>
                  <Icon name="hold" size={18} /><span>Hold</span>
                </button>
              )}
              {/* the sound menu: a small tab on the mic's cell (kept last, so the grid's cells stay as they are) */}
              <button className={`tb-sound${noiseOn ? ' on' : ''}`} aria-expanded={pop?.kind === 'sound'} aria-label={noiseOn ? 'Sound: noise suppression strong' : 'Sound: noise suppression off'}
                title="Sound: strong noise suppression for your mic" onClick={(e) => setPop({ kind: 'sound', anchor: e.currentTarget })}>
                <span className="mono">{noiseOn ? 'NS' : 'NS·OFF'}</span>
              </button>
            </div>
            <div className="tb-foot">
              <button className="tb-link" onClick={() => { onOpenConversation(room.convId); setMinimized(true); }} title="Open the conversation (the Room stays in the title bar)">
                <Icon name="chat" size={15} />Conversation
              </button>
              <button className="tb-link square" onClick={() => setMinimized(true)} title="Fold the Room into the title bar (Esc)" aria-label="Fold">
                <Glyph name="fold" size={16} />
              </button>
              {canFloat && <button className="tb-link square" title="Float the video in a small window on top of everything" aria-label="Float" onClick={() => void float()}><Glyph name="float" size={16} /></button>}
              {/* leaving and ending, together at the end of the title block (they wrap onto their own line when narrow) */}
              <span className="tb-exit">
                <EndForEveryone room={room} meId={meId} className="room-end-all" />
                <button className="room-leave" onClick={leave} title={isHost && others.length ? 'Leave the Room: it carries on for everyone else' : 'Leave the Room'}>Leave Room<Glyph name="door" size={16} /></button>
              </span>
            </div>
          </div>
        </aside>
      </div>
      <RoomAudio meDevice={meDevice} />
      <ControlLayer room={room} users={users} meDevice={meDevice} nameOf={nameOf} />
      {picker && <ScreenPicker onPick={(id, sound) => { setPicker(false); void toggleScreen(id, sound).then(() => setLayout('presentation')); }} onClose={() => setPicker(false)} />}
      {adding && (
        <Popover anchor={addBtn.current} onClose={() => setAdding(false)} className="menu add-people" align="start">
          <div className="menu-label label">Ring into the Room</div>
          <input className="input" autoFocus placeholder="Find someone" aria-label="Find someone to ring in" value={who} onChange={(e) => setWho(e.target.value)} />
          {ringable.slice(0, 8).map((u) => (
            <button key={u.id} role="menuitem" onClick={() => { setAdding(false); void addToCall(u.id); }}><Avatar user={u} presence={presenceFor(u.id)} size="sm" />{u.displayName}</button>
          ))}
          {!ringable.length && <p className="room-menu-empty faint">{who.trim() ? 'No one by that name can be rung in here.' : 'Everyone who can be rung in is already here or being rung.'}</p>}
        </Popover>
      )}
      {pop?.kind === 'react' && (
        <Popover anchor={pop.anchor} onClose={() => setPop(null)} className="menu room-react-menu" align="start">
          <div className="menu-label label">React · everyone sees it</div>
          <div className="room-react-row">
            {MEETING_REACTIONS.map((e) => <button key={e} role="menuitem" aria-label={`React ${e}`} onClick={() => run(react(e))}>{e}</button>)}
          </div>
        </Popover>
      )}
      {pop?.kind === 'background' && <BackgroundMenu anchor={pop.anchor} onClose={() => setPop(null)} />}
      {pop?.kind === 'sound' && <SoundMenu anchor={pop.anchor} onClose={() => setPop(null)} />}
      {pop?.kind === 'layout' && (
        <Popover anchor={pop.anchor} onClose={() => setPop(null)} className="menu room-layout-menu" align="start">
          <div className="menu-label label">Layout · on this PC</div>
          {(['gallery', 'speaker', 'presentation'] as const).map((l) => (
            <button key={l} role="menuitemradio" aria-checked={layout === l} disabled={l === 'presentation' && !shareStream} onClick={() => { setLayout(l); setPop(null); }}
              title={l === 'presentation' && !shareStream ? 'When someone shares a sheet' : undefined}>
              <Glyph name={l} size={16} />{l === 'gallery' ? 'Gallery' : l === 'speaker' ? 'Speaker' : 'Presentation'}
              <span className="room-layout-note">{l === 'gallery' ? 'Everyone the same size' : l === 'speaker' ? 'Who speaks, large' : l === 'presentation' && !shareStream ? 'When someone shares a sheet' : 'The shared sheet, large'}</span>
            </button>
          ))}
          {pinned && <button role="menuitem" onClick={() => { setPinned(null); setPop(null); }}><Icon name="pin" size={16} />Unpin {pinned === meDevice ? 'yourself' : nameOf(seats.find((s) => s.deviceId === pinned)?.userId ?? '')}</button>}
        </Popover>
      )}
      {pop?.kind === 'person' && pop.deviceId && (
        <PersonMenu anchor={pop.anchor} onClose={() => setPop(null)} room={room} deviceId={pop.deviceId} meDevice={meDevice} meId={meId} isHost={isHost} isMainHost={isMainHost}
          pinned={pinned} nameOf={nameOf} handUp={handOrder.has(pop.deviceId)} run={run} host={host} />
      )}
      {consent && (
        <Dialog title="Turn your camera on?" narrow onClose={() => setConsent(false)}>
          <p style={{ margin: 0 }}>Everyone in {room.title ? <b>{room.title}</b> : 'this Room'} will see you. Your office starts meetings with cameras off and asks first.</p>
          <div className="dialog-actions">
            <span />
            <button className="btn ghost" onClick={() => setConsent(false)}>Keep it off</button>
            <button className="btn primary" autoFocus onClick={() => { setConsent(false); void toggleCamera(); }}><Icon name="video" size={15} />Turn camera on</button>
          </div>
        </Dialog>
      )}
    </div>,
    document.body,
  );
}

type HostOp = (op: 'room.admit' | 'room.lock' | 'room.cohost' | 'room.mute' | 'room.askUnmute' | 'room.remove' | 'room.spotlight' | 'room.end' | 'room.hand' | 'meet.noteTaker', params: Record<string, unknown>) => Promise<unknown>;

/** What you can do to a person in the Room: pin for yourself; hosts spotlight, mute, ask, lower a hand, make co-host, remove. */
function PersonMenu({ anchor, onClose, room, deviceId, meDevice, meId, isHost, isMainHost, pinned, nameOf, handUp, run, host }: {
  anchor: HTMLElement; onClose: () => void; room: RoomInfo; deviceId: string; meDevice: string; meId: string; isHost: boolean; isMainHost: boolean;
  pinned: string | null; nameOf: (id: string) => string; handUp: boolean; run: (p: Promise<unknown>) => void; host: HostOp;
}) {
  const p = room.participants.find((x) => x.deviceId === deviceId);
  if (!p) return null;
  const me = deviceId === meDevice;
  const first = me ? 'yourself' : nameOf(p.userId).split(' ')[0];
  const isCo = (room.coHosts ?? []).includes(p.userId);
  const act = (f: () => Promise<unknown> | void) => { onClose(); const r = f(); if (r) run(r); };
  return (
    <Popover anchor={anchor} onClose={onClose} className="menu room-person-menu">
      <div className="menu-label label">{me ? 'You' : nameOf(p.userId)}{p.userId === room.hostId ? ' · host' : isCo ? ' · co-host' : ''}</div>
      <button role="menuitem" onClick={() => act(() => setPinned(pinned === deviceId ? null : deviceId))}><Icon name="pin" size={16} />{pinned === deviceId ? 'Unpin' : `Pin ${first} for me`}</button>
      {/* only the person sharing their screen gives control of it */}
      <ControlMenuItems room={room} deviceId={deviceId} meDevice={meDevice} nameOf={nameOf} onDone={onClose} />
      {isHost && (
        <>
          <button role="menuitem" onClick={() => act(() => host('room.spotlight', { deviceId: room.spotlight === deviceId ? null : deviceId }))}>
            <Glyph name="spotlight" size={16} />{room.spotlight === deviceId ? 'Remove the spotlight' : `Spotlight ${first} for everyone`}
          </button>
          {handUp && <button role="menuitem" onClick={() => act(() => host('room.hand', { up: false, deviceId }))}><Glyph name="hand" size={16} />Lower {me ? 'your' : `${first}'s`} hand</button>}
          {!me && !p.muted && <button role="menuitem" onClick={() => act(() => host('room.mute', { deviceId }))}><Icon name="mic-off" size={16} />Mute {first}</button>}
          {!me && p.muted && <button role="menuitem" onClick={() => act(() => host('room.askUnmute', { deviceId }))}><Icon name="mic" size={16} />Ask {first} to unmute</button>}
          {isMainHost && !me && p.userId !== meId && (
            <button role="menuitem" onClick={() => act(() => host('room.cohost', { userId: p.userId, on: !isCo }))}><Glyph name="people" size={16} />{isCo ? 'Take back co-host' : 'Make co-host'}</button>
          )}
          {room.occurrenceId && !isWebGuest(p.userId) && (
            <button role="menuitem" onClick={() => act(() => host('meet.noteTaker', { userId: room.noteTakerId === p.userId ? null : p.userId }))}>
              <Icon name="action" size={16} />{room.noteTakerId === p.userId ? (me ? 'Stop taking the notes' : `${first} stops taking the notes`) : me ? 'I take the notes' : `${first} takes the notes`}
            </button>
          )}
          {!me && p.userId !== room.hostId && (isMainHost || !isCo) && (
            <button role="menuitem" className="danger" onClick={() => act(() => void confirmAction({ title: `Take ${nameOf(p.userId)} out of the meeting?`, body: 'They wait in the lobby, and a host can let them back in.', confirm: 'Remove from the meeting', danger: true })
              .then((ok) => { if (ok) run(host('room.remove', { deviceId })); }))}>
              <Icon name="x" size={16} />Remove from the meeting
            </button>
          )}
        </>
      )}
    </Popover>
  );
}

/** The camera's background: as it is, blurred, an office background drawn in code, or your own picture. */
function BackgroundMenu({ anchor, onClose }: { anchor: HTMLElement; onClose: () => void }) {
  const toast = useToast();
  const current = useCall((s) => s.background);
  const file = useRef<HTMLInputElement>(null);
  const thumbs = useMemo(() => new Map(OFFICE_BACKGROUNDS.map((b) => [b.id, backgroundThumb(b.id)] as const)), []);
  const pick = (id: BackgroundId) => void setBackground(id).catch((e: Error) => toast(e.message, true));
  return (
    <Popover anchor={anchor} onClose={onClose} className="menu room-bg-menu" align="start">
      <div className="menu-label label">Behind you · done on this PC</div>
      <div className="room-bg-grid" role="radiogroup" aria-label="Background">
        <button role="radio" aria-checked={current === 'none'} className="bg-none" onClick={() => pick('none')}><span className="bg-swatch"><Icon name="x" size={16} /></span>As it is</button>
        <button role="radio" aria-checked={current === 'blur'} className="bg-blur" onClick={() => pick('blur')}><span className="bg-swatch"><Glyph name="blur" /></span>Blur</button>
        {OFFICE_BACKGROUNDS.map((b) => (
          <button key={b.id} role="radio" aria-checked={current === b.id} onClick={() => pick(b.id)}><span className="bg-swatch"><img src={thumbs.get(b.id)} alt="" /></span>{b.label}</button>
        ))}
        <button role="radio" aria-checked={current === 'custom'} onClick={() => file.current?.click()}><span className="bg-swatch"><Icon name="plus" size={16} /></span>Your picture</button>
      </div>
      <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (f) void setCustomBackground(f).then(() => setBackground('custom')).catch((err: Error) => toast(err.message, true));
      }} />
    </Popover>
  );
}

// ------------------------------------------------------------------ the People tab

function PeoplePanel({ room, seats, zones, users, meId, muted, camera, isHost, isMainHost, handOrder, onMenu, run, host, meDevice }: {
  room: RoomInfo; seats: Seat[]; zones: Map<string, string>; users: Map<string, PublicUser>; meId: string; muted: boolean; camera: boolean;
  isHost: boolean; isMainHost: boolean; handOrder: Map<string, number>; onMenu: MenuOpen; run: (p: Promise<unknown>) => void; host: HostOp; meDevice: string;
}) {
  const nameOf = (id: string) => users.get(id)?.displayName ?? 'Someone';
  const waiting = room.lobby ?? [];
  const hands = room.hands ?? [];
  const conv = useChat((s) => s.conversations.get(room.convId));
  const meeting = room.meetingId;
  const setRule = (lobby: LobbyRule) => run(window.dex.request('meet.settings', { id: meeting!, lobby }));
  const setEarly = (joinBeforeHost: boolean) => run(window.dex.request('meet.settings', { id: meeting!, joinBeforeHost }));
  // hands first (in the order they went up), then everyone else as they came in
  const ordered = [...seats].sort((a, b) => (handOrder.get(a.deviceId) ?? 999) - (handOrder.get(b.deviceId) ?? 999));
  return (
    <div className="room-people">
      {isHost && waiting.length > 0 && (
        <section className="room-lobby" aria-label="Lobby">
          <div className="tb-head"><span className="label">Lobby · waiting</span><span className="mono">{waiting.length}</span></div>
          <ul>
            {waiting.map((l) => (
              <li key={l.deviceId}>
                <Avatar user={{ id: l.userId, displayName: nameOf(l.userId) }} size="sm" />
                <span className="who"><b>{nameOf(l.userId)}</b><small>{users.get(l.userId)?.role === 'guest' ? 'Guest' : conv && !conv.members.includes(l.userId) ? 'From outside' : 'Member'} · waiting since {clock(l.at)}</small></span>
                <button className="btn sm ghost" onClick={() => run(host('room.admit', { deviceIds: [l.deviceId], allow: false }))}>Deny</button>
                <button className="btn sm primary" onClick={() => run(host('room.admit', { deviceIds: [l.deviceId], allow: true }))}>Admit</button>
              </li>
            ))}
          </ul>
          {waiting.length > 1 && (
            <div className="room-lobby-all">
              <button className="tb-link" onClick={() => run(host('room.admit', { all: true, allow: false }))}>Deny all</button>
              <button className="btn sm" onClick={() => run(host('room.admit', { all: true, allow: true }))}>Admit all {waiting.length}</button>
            </div>
          )}
        </section>
      )}
      <div className="room-schedule">
        <div className="tb-head"><span className="label">In the Room</span><span className="mono">{room.participants.length}{room.ringing.length ? ` + ${room.ringing.length} ringing` : ''}{hands.length ? (hands.length === 1 ? ' · 1 hand' : ` · ${hands.length} hands`) : ''}</span></div>
        <table>
          <tbody>
            {ordered.map((s) => {
              const p = s.p;
              const isMuted = s.me ? muted : !!p?.muted;
              const cam = s.me ? camera : !!p?.camera;
              const hand = handOrder.get(s.deviceId);
              const role = s.userId === room.hostId ? 'HOST' : (room.coHosts ?? []).includes(s.userId) ? 'CO-HOST' : '';
              const notes = room.noteTakerId === s.userId;
              return (
                <tr key={s.deviceId} className={hand ? 'hand-up' : undefined}>
                  <td className="mono ref">{zones.get(s.deviceId) ?? '··'}</td>
                  <td className="who">{nameOf(s.userId)}{s.me && <span className="faint"> (you)</span>}{role && <span className="role-tag">{role}</span>}{notes && <span className="role-tag">NOTE-TAKER</span>}{p?.recording && <span className="rec-tag">REC</span>}</td>
                  <td className="hand-cell" title={hand === 1 ? 'Hand raised · first in line' : hand ? `Hand raised · number ${hand} in line` : undefined}>{hand ? <span className="room-hand"><Glyph name="hand" size={12} />{hand}</span> : null}</td>
                  <td className={isMuted ? 'off' : ''} title={isMuted ? 'Mic off' : 'Mic on'}><Icon name={isMuted ? 'mic-off' : 'mic'} size={14} /></td>
                  <td className={cam ? '' : 'off'} title={cam ? 'Camera on' : 'Camera off'}><Icon name={cam ? 'video' : 'video-off'} size={14} /></td>
                  <td className="act"><button className="row-menu" aria-label={`Options for ${s.me ? 'you' : nameOf(s.userId)}`} onClick={(e) => onMenu(s.deviceId, e.currentTarget)}><Glyph name="more" size={15} /></button></td>
                </tr>
              );
            })}
            {room.ringing.map((u) => (
              <tr key={`ring-${u}`} className="ringing">
                <td className="mono ref">··</td>
                <td className="who">{nameOf(u)}</td>
                <td colSpan={4} className="mono ring-tag">RINGING</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {isHost && (
        <section className="room-hostbox" aria-label="Host controls">
          <div className="tb-head"><span className="label">Host controls</span><span className="mono">{isMainHost ? 'HOST' : 'CO-HOST'}</span></div>
          <div className="room-host-actions">
            <button onClick={() => run(host('room.mute', { all: true }))} disabled={room.participants.length < 2} title={room.participants.length < 2 ? 'No one else is in the Room yet' : 'Turn everyone\'s mic off (they can turn it on again)'}><Icon name="mic-off" size={15} />Mute all</button>
            <button onClick={() => run(host('room.hand', { up: false, all: true }))} disabled={!hands.length} title={hands.length ? undefined : 'No hands are up'}><Glyph name="hand" size={15} />Lower all hands</button>
            <button aria-pressed={!!room.locked} className={room.locked ? 'on' : ''} onClick={() => run(host('room.lock', { locked: !room.locked }))}><Icon name="lock" size={15} />{room.locked ? 'Unlock' : 'Lock meeting'}</button>
            {room.spotlight && <button onClick={() => run(host('room.spotlight', { deviceId: null }))}><Glyph name="spotlight" size={15} />End spotlight</button>}
          </div>
          <HostExtras room={room} users={users} meDevice={meDevice} />
          {meeting && room.settings && (
            <details className="room-host-settings">
              <summary className="label">Meeting settings · {lobbyLabel(room.settings.lobby)}</summary>
              <label className="room-setting"><span className="label">Who waits in the lobby</span>
                <select className="input" value={room.settings.lobby} onChange={(e) => setRule(e.target.value as LobbyRule)}>{LOBBY_RULES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}</select>
              </label>
              {room.meetingKind !== 'conversation' && (
                <label className="room-setting check"><input type="checkbox" checked={room.settings.joinBeforeHost} onChange={(e) => setEarly(e.target.checked)} />People can come in before the host</label>
              )}
            </details>
          )}
        </section>
      )}
      {!isHost && room.hostId && room.hostId !== meId && (
        <p className="room-hostnote faint">{nameOf(room.hostId)} runs this meeting{(room.coHosts ?? []).length ? ` with ${(room.coHosts ?? []).map((c) => nameOf(c).split(' ')[0]).join(', ')}` : ''}.</p>
      )}
    </div>
  );
}
