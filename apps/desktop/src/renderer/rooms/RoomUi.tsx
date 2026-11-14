// Room surfaces, drawn like a drawing sheet: the Room stage (tiles in zones, a schedule of who is
// in the Room, a title block with the controls), the Room chip for the title bar, the amber
// banner when someone opens a Room with you, the screen picker and the "Open a Room" button.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { PublicUser } from '@dex/core';
import { Avatar, Dialog, Icon, Popover, colorFor, presenceFor, useToast } from '../ui.tsx';
import {
  answer, callQuality, capName, clock, decline, joinRoom, leave, levelMeter, setMinimized, sheetColumns, startCall, toggleCamera, toggleMute,
  toggleScreen, useCall, zoneRef,
} from './engine.ts';
import { addConversation, chatState, sendMessage } from '../chat/store.ts';
import { clearRecording, recordSupported, startRecording, stopRecording, useRecorder } from './recorder.ts';
import { policyNow, usePolicy } from '../policy.ts';
import './rooms.css';

function useDuration(since: number | undefined): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  if (!since) return '0:00';
  const s = Math.max(0, Math.floor((now - since) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s % 60).padStart(2, '0')}`;
}

/** Glyphs only the Room uses, drawn on the same 24 px grid and stroke as the shared icon set. */
const GLYPHS = {
  float: 'M3.5 5h17v14h-17zM12 12h6.5v5H12z',
  ring: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-6 9c.5-3.4 2.9-5.5 6-5.5 1.5 0 2.8.5 3.8 1.4M18 13.5v7M14.5 17h7',
  chevron: 'm7 10 5 5 5-5',
  door: 'M5 20.5h14M7 20.5V3.5h8.5v17M12.5 12h.01M15.5 6.5l3-1.5v15.5',
  fold: 'M4 4.5h16M12 20V9M7.5 13.5 12 9l4.5 4.5',
} as const;
function Glyph({ name, size = 18 }: { name: keyof typeof GLYPHS; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={GLYPHS[name]} />
    </svg>
  );
}

function Video({ stream, muted, mirror, fit = 'cover' }: { stream: MediaStream; muted?: boolean; mirror?: boolean; fit?: 'cover' | 'contain' }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => { if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream; }, [stream]);
  return <video ref={ref} autoPlay playsInline muted={muted} style={{ transform: mirror ? 'scaleX(-1)' : undefined, objectFit: fit }} />;
}

function AudioOut({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => { if (ref.current && ref.current.srcObject !== stream) ref.current.srcObject = stream; }, [stream]);
  return <audio ref={ref} autoPlay />;
}

/** Everyone's voices (and a shared screen's sound), kept playing while the Room is folded away. */
function RoomAudio() {
  const peers = useCall((s) => s.peers);
  return (
    <div hidden>
      {[...peers.values()].flatMap((p) => p.streams.filter((s) => s.getAudioTracks().length).map((s) => <AudioOut key={`${p.deviceId}:${s.id}`} stream={s} />))}
    </div>
  );
}

function useSpeaking(stream: MediaStream | null | undefined, enabled = true): boolean {
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => {
    if (!stream || !enabled) { setSpeaking(false); return; }
    const meter = levelMeter(stream);
    if (!meter) return;
    let quietFor = 0;
    const t = setInterval(() => {
      const loud = meter.read() > 0.06;
      quietFor = loud ? 0 : quietFor + 1;
      setSpeaking(loud || quietFor < 3);
    }, 120);
    return () => { clearInterval(t); meter.stop(); };
  }, [stream, enabled]);
  return speaking;
}

function Tile({ user, stream, camera, muted, me, zone }: { user: PublicUser | undefined; stream: MediaStream | null; camera: boolean; muted: boolean; me?: boolean; zone: string }) {
  const speaking = useSpeaking(stream, !muted);
  const name = user?.displayName ?? 'Someone';
  const hasVideo = camera && !!stream?.getVideoTracks().length;
  return (
    <div className={`room-tile${speaking ? ' speaking' : ''}${hasVideo ? ' has-video' : ''}`} style={{ ['--tint' as string]: colorFor(user?.id ?? 'x') }}
      aria-label={`${zone} · ${me ? 'You' : name}${muted ? ' · mic off' : ''}${speaking ? ' · speaking' : ''}`}>
      <div className="room-face">
        {hasVideo ? <Video stream={stream!} muted mirror={me} /> : <Avatar user={{ id: user?.id ?? 'x', displayName: name }} size="lg" />}
      </div>
      <span className="room-cap"><b>{zone}</b><span>{me ? 'YOU' : capName(name)}</span>{muted && <Icon name="mic-off" size={12} />}</span>
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
  for (let cols = 1; cols <= Math.min(n, 4); cols++) {
    const rows = Math.ceil(n / cols);
    const tileW = Math.floor(Math.min((w - GAP_X * (cols - 1)) / cols, ((h - GAP_Y * (rows - 1)) / rows) * RATIO));
    if (tileW > best.tileW) best = { cols, tileW };
  }
  return best;
}

type Quality = Awaited<ReturnType<typeof callQuality>>;
const QUALITY_WORD: Record<Quality['label'], string> = { good: 'Good', fair: 'Fair', poor: 'Poor', unknown: '' };

export function RoomStage({ users, title, onOpenConversation, meDevice, meId }: {
  users: Map<string, PublicUser>; title: (convId: string) => string; onOpenConversation: (convId: string) => void; meDevice: string; meId: string;
}) {
  const room = useCall((s) => s.room);
  const local = useCall((s) => s.local);
  const screen = useCall((s) => s.screen);
  const peers = useCall((s) => s.peers);
  const muted = useCall((s) => s.muted);
  const camera = useCall((s) => s.camera);
  const minimized = useCall((s) => s.minimized);
  const [picker, setPicker] = useState(false);
  const [adding, setAdding] = useState(false);
  const [who, setWho] = useState('');
  const addBtn = useRef<HTMLButtonElement>(null);
  const fieldRef = useRef<HTMLElement>(null);
  const field = useSize(fieldRef, room?.id);
  const [quality, setQuality] = useState<Quality | null>(null);
  useEffect(() => {
    if (!room) { setQuality(null); return; }
    const t = setInterval(() => { void callQuality().then(setQuality); }, 3000);
    return () => clearInterval(t);
  }, [room?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Escape folds the Room into the title bar (unless a picker or dialog is open over it)
  useEffect(() => {
    if (!room || minimized || picker || adding) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.scrim')) setMinimized(true); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [room, minimized, picker, adding]);
  const duration = useDuration(room?.startedAt);
  const policy = usePolicy();
  const recState = useRecorder();
  const myRec = !!recState?.recording;
  const toast = useToast();
  if (!room) return null;
  const recorders = [...new Set(room.participants.filter((p) => p.recording).map((p) => p.userId))];
  const conv = chatState().conversations.get(room.convId);
  const convMembers = conv?.members ?? [];
  const convKind = conv?.kind ?? 'space';
  const firstName = (id: string) => users.get(id)?.displayName.split(' ')[0] ?? 'Someone';
  const addToCall = async (userId: string) => {
    try {
      if (convMembers.includes(userId)) { await window.dex.request('room.invite', { roomId: room.id, userIds: [userId] }); toast(`Ringing ${firstName(userId)}`); return; }
      // a Direct Room grows into a group Direct and a new Room there
      const others = convMembers.filter((u) => u !== meId);
      const c = await window.dex.request('conv.create', { kind: 'direct', members: [...others, userId] });
      addConversation(c);
      leave();
      await startCall(c.id, room.video);
      toast('The Room moved to a group Direct with everyone in it');
    } catch (e) { toast((e as Error).message, true); }
  };
  const float = async () => {
    const v = [...document.querySelectorAll<HTMLVideoElement>('.room-share video, .room-grid video')].find((x) => x.videoWidth && !x.style.transform.includes('scaleX(-1)'))
      ?? document.querySelector<HTMLVideoElement>('.room-grid video');
    if (!v) { toast('Nothing to float yet: no one has a camera or a screen on.', true); return; }
    try { await v.requestPictureInPicture(); setMinimized(true); } catch (e) { toast((e as Error).message, true); }
  };
  const others = room.participants.filter((p) => p.deviceId !== meDevice);
  const shared = others.find((p) => p.screen);
  const sharedStream = shared ? peers.get(shared.deviceId)?.streams.find((s, i) => i > 0 && s.getVideoTracks().length) ?? null : null;
  const sharing = !!(sharedStream || screen);
  const name = title(room.convId);
  const kind = convKind === 'space' ? 'SPACE' : convMembers.length > 2 ? 'GROUP' : 'DIRECT';
  const count = others.length + 1 + (others.length === 0 ? 1 : 0);
  // tiles fill the drawing area: the field's content box, less its padding
  const fit = sharing ? { cols: 1, tileW: 0 } : fitTiles(count, field.w - 56, field.h - 64);
  const cols = fit.cols;
  const seats = [{ userId: meId, deviceId: meDevice, me: true }, ...others.map((p) => ({ userId: p.userId, deviceId: p.deviceId, me: false }))];
  const mine = room.participants.find((p) => p.deviceId === meDevice);
  const showQuality = !!quality && quality.label !== 'unknown' && others.length > 0;
  const canFloat = typeof document !== 'undefined' && 'pictureInPictureEnabled' in document;
  const canRecord = recordSupported() && (policy.allowRecording || myRec);

  return createPortal(
    <div className={`room-stage${minimized ? ' folded' : ''}`} role="dialog" aria-label={`Room: ${name}`} aria-hidden={minimized || undefined}>
      <div className={`room-sheet${recorders.length ? ' recording' : ''}`}>
        {recorders.length > 0 && (
          <span className="rec-chip" role="status">
            <span className="rec-dot" /><b>REC</b>
            {recorders.includes(meId) ? 'You are recording' : `${users.get(recorders[0])?.displayName ?? 'Someone'} is recording`}<span className="rec-note"> · everyone here is told</span>
          </span>
        )}
        <section ref={fieldRef} className={`room-field${sharing ? ' sharing' : ''}`} aria-label="People in the Room">
          {sharing && (
            <figure className="room-share">
              <Video stream={(sharedStream ?? screen)!} muted fit="contain" />
              <figcaption className="room-cap"><b>SHEET</b><span>{screen && !sharedStream ? 'YOUR SCREEN · SHARED' : `${capName(users.get(shared!.userId)?.displayName ?? 'Someone')} · SCREEN`}</span></figcaption>
            </figure>
          )}
          <div className="room-grid" style={{ ['--cols' as string]: cols, ['--tile-w' as string]: fit.tileW ? `${fit.tileW}px` : undefined }}>
            <Tile user={users.get(meId)} stream={local} camera={camera} muted={muted} me zone={zoneRef(0, cols)} />
            {others.map((p, i) => (
              <Tile key={p.deviceId} user={users.get(p.userId)} stream={peers.get(p.deviceId)?.streams[0] ?? null} camera={p.camera} muted={p.muted} zone={zoneRef(i + 1, cols)} />
            ))}
            {others.length === 0 && (
              <div className="room-tile open-seat">
                <div className="room-face">
                  <span className="open-seat-text">{room.ringing.length ? `Ringing ${room.ringing.map(firstName).join(', ')}` : 'Waiting for someone to come in'}</span>
                  <span className="open-seat-line" aria-hidden="true" />
                </div>
                <span className="room-cap"><b>{zoneRef(1, cols)}</b><span>OPEN SEAT</span></span>
              </div>
            )}
          </div>
        </section>

        <aside className="room-side">
          <div className="room-schedule">
            <div className="tb-head"><span className="label">In the Room</span><span className="mono">{room.participants.length}{room.ringing.length ? ` + ${room.ringing.length} ringing` : ''}</span></div>
            <table>
              <tbody>
                {seats.map((s, i) => {
                  const p = s.me ? mine : room.participants.find((x) => x.deviceId === s.deviceId);
                  const isMuted = s.me ? muted : !!p?.muted;
                  const cam = s.me ? camera : !!p?.camera;
                  return (
                    <tr key={s.deviceId}>
                      <td className="mono ref">{zoneRef(i, cols)}</td>
                      <td className="who">{users.get(s.userId)?.displayName ?? 'Someone'}{s.me && <span className="faint"> (you)</span>}{p?.recording && <span className="rec-tag">REC</span>}</td>
                      <td className={isMuted ? 'off' : ''} title={isMuted ? 'Mic off' : 'Mic on'}><Icon name={isMuted ? 'mic-off' : 'mic'} size={14} /></td>
                      <td className={cam ? '' : 'off'} title={cam ? 'Camera on' : 'Camera off'}><Icon name={cam ? 'video' : 'video-off'} size={14} /></td>
                    </tr>
                  );
                })}
                {room.ringing.map((u) => (
                  <tr key={`ring-${u}`} className="ringing">
                    <td className="mono ref">··</td>
                    <td className="who">{users.get(u)?.displayName ?? 'Someone'}</td>
                    <td colSpan={2} className="mono ring-tag">RINGING</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="room-block">
            <div className="tb-name">
              <span className="label">Room</span>
              <h2>{name}</h2>
              <span className="tb-kind mono">{kind}</span>
            </div>
            <div className="tb-facts">
              <div><span className="label">Time</span><span className="mono tb-big">{duration}</span></div>
              <div><span className="label">Opened</span><span className="mono">{clock(room.startedAt)}</span></div>
              <div>
                <span className="label">Link</span>
                {showQuality ? (
                  <span className={`q-${quality!.label}`} title={`Round trip ${quality!.rttMs ?? '?'} ms · loss ${quality!.loss === null ? '?' : `${(quality!.loss * 100).toFixed(1)}%`}${quality!.relayed ? ' · through a relay' : ''}`}>
                    <span className="q-bars"><i /><i /><i /></span>{QUALITY_WORD[quality!.label]}{quality!.rttMs !== null && <span className="mono faint">{quality!.rttMs} ms</span>}
                  </span>
                ) : <span className="mono faint">{others.length ? 'Measuring' : '—'}</span>}
              </div>
            </div>
            <div className="tb-controls">
              <button className={muted ? 'off' : 'on'} aria-pressed={!muted} onClick={toggleMute} title={muted ? 'Turn your mic on' : 'Turn your mic off'}>
                <Icon name={muted ? 'mic-off' : 'mic'} size={18} /><span>{muted ? 'Mic off' : 'Mic on'}</span>
              </button>
              <button className={camera ? 'on' : 'off'} aria-pressed={camera} onClick={() => void toggleCamera()} title={camera ? 'Turn your camera off' : 'Turn your camera on'}>
                <Icon name={camera ? 'video' : 'video-off'} size={18} /><span>{camera ? 'Camera on' : 'Camera off'}</span>
              </button>
              {window.dex.listScreens && (
                <button className={screen ? 'on' : ''} aria-pressed={!!screen} onClick={() => (screen ? void toggleScreen() : setPicker(true))} title={screen ? 'Stop sharing your screen' : 'Share a screen or window with the Room'}>
                  <Icon name="screen" size={18} /><span>{screen ? 'Stop sharing' : 'Share sheet'}</span>
                </button>
              )}
              {canRecord && (
                <button className={myRec ? 'rec' : ''} aria-pressed={myRec} title={myRec ? 'Stop recording' : 'Record the Room (everyone is told)'}
                  onClick={() => (myRec ? stopRecording() : void startRecording((id) => users.get(id)?.displayName ?? 'Someone', meId).catch((e: Error) => toast(e.message, true)))}>
                  {myRec ? <span className="rec-dot" /> : <Icon name="record" size={18} />}<span>{myRec ? 'Stop recording' : 'Record'}</span>
                </button>
              )}
              <button ref={addBtn} aria-expanded={adding} title="Ring someone into the Room" onClick={() => setAdding(!adding)}>
                <Glyph name="ring" /><span>Ring someone</span>
              </button>
              {canFloat && (
                <button title="Float the video in a small window on top of everything" onClick={() => void float()}>
                  <Glyph name="float" /><span>Float</span>
                </button>
              )}
            </div>
            <div className="tb-foot">
              <button className="tb-link" onClick={() => { onOpenConversation(room.convId); setMinimized(true); }} title="Open the conversation (the Room stays in the title bar)">
                <Icon name="chat" size={15} />Conversation
              </button>
              <button className="tb-link" onClick={() => setMinimized(true)} title="Fold the Room into the title bar (Esc)">
                <Glyph name="fold" size={15} />Fold
              </button>
              <button className="room-leave" onClick={leave} title="Leave the Room">Leave Room<Glyph name="door" size={16} /></button>
            </div>
          </div>
        </aside>
      </div>
      <RoomAudio />
      {picker && <ScreenPicker onPick={(id, sound) => { setPicker(false); void toggleScreen(id, sound); }} onClose={() => setPicker(false)} />}
      {adding && (
        <Popover anchor={addBtn.current} onClose={() => setAdding(false)} className="menu add-people" align="start">
          <div className="menu-label label">Ring into the Room</div>
          <input className="input" autoFocus placeholder="Find someone" value={who} onChange={(e) => setWho(e.target.value)} />
          {[...users.values()].filter((u) => u.role !== 'bot' && u.id !== meId && !room.participants.some((p) => p.userId === u.id) && !room.ringing.includes(u.id)
            && (convMembers.includes(u.id) || convKind === 'direct') && u.displayName.toLowerCase().includes(who.toLowerCase())).slice(0, 8).map((u) => (
            <button key={u.id} role="menuitem" onClick={() => { setAdding(false); void addToCall(u.id); }}><Avatar user={u} presence={presenceFor(u.id)} size="sm" />{u.displayName}</button>
          ))}
        </Popover>
      )}
    </div>,
    document.body,
  );
}

/**
 * The Room while it is folded away: an amber "ROOM · 12:04" chip for the title bar with a mic
 * switch. Clicking it unfolds the Room. Nothing shows when there is no Room or it is open.
 */
export function RoomChip() {
  const room = useCall((s) => s.room);
  const minimized = useCall((s) => s.minimized);
  const muted = useCall((s) => s.muted);
  const duration = useDuration(room?.startedAt);
  if (!room || !minimized) return null;
  const n = room.participants.length;
  const recording = room.participants.some((p) => p.recording);
  return (
    <div className={`room-chip${muted ? ' muted' : ''}`} role="group" aria-label="Room in progress">
      <button className="room-chip-main" onClick={() => setMinimized(false)} title={`Back to the Room · ${n} ${n === 1 ? 'person' : 'people'} in it`}>
        <span className="room-chip-pip" aria-hidden="true" />
        <span className="room-chip-text">ROOM · {duration}</span>
        {recording && <span className="rec-dot" title="This Room is being recorded" />}
      </button>
      <button className="room-chip-mic" onClick={toggleMute} aria-pressed={!muted} aria-label={muted ? 'Turn your mic on' : 'Turn your mic off'} title={muted ? 'Mic off · turn it on' : 'Mic on · turn it off'}>
        <Icon name={muted ? 'mic-off' : 'mic'} size={15} />
      </button>
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

/** "Open a Room" for a conversation header (voice; video from the menu); "Join" when one is running there. */
export function CallButtons({ convId, live }: { convId: string; live: boolean }) {
  const toast = useToast();
  const active = useCall((s) => s.active.get(convId));
  const inCall = useCall((s) => s.room);
  const [menu, setMenu] = useState(false);
  const chev = useRef<HTMLButtonElement>(null);
  if (inCall?.convId === convId) return <button className="room-open join" onClick={() => setMinimized(false)}><span className="room-chip-pip" aria-hidden="true" />Back to the Room</button>;
  if (active && active.participants.length) {
    return (
      <button className="room-open join" disabled={!live || !!inCall} onClick={() => void joinRoom(active.id, false).catch((e: Error) => toast(e.message, true))}>
        <span className="room-chip-pip" aria-hidden="true" />Join the Room · {active.participants.length}
      </button>
    );
  }
  const open = (video: boolean) => { setMenu(false); void startCall(convId, video).catch((e: Error) => toast(e.message, true)); };
  const off = !live || !!inCall;
  return (
    <span className="room-open split">
      <button disabled={off} onClick={() => open(false)} title="Open a Room with voice">Open a Room</button>
      <button ref={chev} disabled={off} className="room-open-more" aria-haspopup="menu" aria-expanded={menu} aria-label="More ways to open a Room" onClick={() => setMenu(!menu)}>
        <Glyph name="chevron" size={14} />
      </button>
      {menu && (
        <Popover anchor={chev.current} onClose={() => setMenu(false)} className="menu room-open-menu">
          <button role="menuitem" onClick={() => open(false)}><Icon name="phone" size={16} />With voice<span className="kbd">Default</span></button>
          <button role="menuitem" onClick={() => open(true)}><Icon name="video" size={16} />With video</button>
        </Popover>
      )}
    </span>
  );
}

/** After a Room recording stops: save it on this PC or share it in the conversation. */
export function RecordingReady() {
  const r = useRecorder();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!r || r.recording || !r.done) return null;
  const { blob, ms, convId } = r.done;
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '');
  const name = `Room recording ${stamp}.webm`;
  const length = ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`;
  const limit = policyNow().maxUploadMb * 1024 * 1024;
  const save = () => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  const share = async () => {
    setBusy(true);
    try {
      const info = await window.dex.uploadFile!(`rec-${Date.now().toString(36)}`, { data: await blob.arrayBuffer(), name, mime: 'video/webm' });
      await sendMessage(convId, `Room recording · ${length}`, null, [info]);
      toast('Shared in the conversation');
      clearRecording();
    } catch (e) { toast((e as Error).message, true); setBusy(false); }
  };
  return (
    <Dialog title="Room recording ready" onClose={() => { if (confirm('Discard this recording? It has not been saved.')) clearRecording(); }}>
      <dl className="rec-facts">
        <div><dt className="label">Length</dt><dd className="mono">{length}</dd></div>
        <div><dt className="label">Size</dt><dd className="mono">{(blob.size / 1024 / 1024).toFixed(1)} MB</dd></div>
        <div><dt className="label">Kept</dt><dd>Only on this PC until you save or share it</dd></div>
      </dl>
      <div className="dialog-actions">
        <button className="btn ghost danger" onClick={() => { if (confirm('Discard this recording?')) clearRecording(); }}>Discard</button>
        {!/Android/i.test(navigator.userAgent) && <button className="btn" onClick={save}><Icon name="download" size={15} />Save to this PC</button>}
        {window.dex.uploadFile && convId && blob.size <= limit && <button className="btn primary" disabled={busy} onClick={() => void share()}>{busy ? <span className="spinner" /> : <Icon name="send" size={15} />}Share in the conversation</button>}
      </div>
    </Dialog>
  );
}
