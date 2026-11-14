// Room surfaces: the call stage, the minimised mini-Room, the incoming-call card, the screen
// picker and the call buttons in a conversation header.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PublicUser } from '@dex/core';
import { Avatar, Dialog, Icon, Popover, colorFor, presenceFor, useToast } from '../ui.tsx';
import {
  answer, callQuality, decline, joinRoom, leave, levelMeter, setMinimized, startCall, toggleCamera, toggleMute, toggleScreen, useCall,
} from './engine.ts';
import { addConversation, chatState, sendMessage } from '../chat/store.ts';
import { clearRecording, recordSupported, startRecording, stopRecording, useRecorder } from './recorder.ts';
import { policyNow, usePolicy } from '../policy.ts';

function useDuration(since: number | undefined): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  if (!since) return '0:00';
  const s = Math.max(0, Math.floor((now - since) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s % 60).padStart(2, '0')}`;
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

function useSpeaking(stream: MediaStream | null | undefined, enabled = true): boolean {
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => {
    if (!stream || !enabled) return;
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

function Tile({ user, stream, camera, muted, me, label }: { user: PublicUser | undefined; stream: MediaStream | null; camera: boolean; muted: boolean; me?: boolean; label?: string }) {
  const speaking = useSpeaking(stream, !muted);
  const name = me ? 'You' : user?.displayName ?? 'Someone';
  const hasVideo = camera && !!stream?.getVideoTracks().length;
  return (
    <div className={`room-tile${speaking ? ' speaking' : ''}`} style={{ ['--tint' as string]: colorFor(user?.id ?? 'x') }}>
      {hasVideo ? <Video stream={stream!} muted mirror={me} /> : (
        <div className="room-avatar"><Avatar user={{ id: user?.id ?? 'x', displayName: user?.displayName ?? '?' }} size="lg" /></div>
      )}
      {!me && stream && !hasVideo && <AudioOut stream={stream} />}
      {!me && stream && hasVideo && <AudioOut stream={new MediaStream(stream.getAudioTracks())} />}
      <div className="room-name">{muted && <Icon name="mic-off" size={13} />}<span>{label ?? name}</span></div>
    </div>
  );
}

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
  const [quality, setQuality] = useState<Awaited<ReturnType<typeof callQuality>> | null>(null);
  useEffect(() => {
    if (!room) return;
    const t = setInterval(() => { void callQuality().then(setQuality); }, 3000);
    return () => clearInterval(t);
  }, [room?.id]); // eslint-disable-line react-hooks/exhaustive-deps
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
  const addToCall = async (userId: string) => {
    try {
      if (convMembers.includes(userId)) { await window.dex.request('room.invite', { roomId: room.id, userIds: [userId] }); toast('Ringing'); return; }
      // a Direct call grows into a group conversation and a new call there
      const others = convMembers.filter((u) => u !== meId);
      const c = await window.dex.request('conv.create', { kind: 'direct', members: [...others, userId] });
      addConversation(c);
      leave();
      await startCall(c.id, room.video);
      toast('Moved to a group call');
    } catch (e) { toast((e as Error).message, true); }
  };
  const popOut = async () => {
    const v = [...document.querySelectorAll<HTMLVideoElement>('.room-share video, .room-grid video')].find((x) => x.videoWidth && !x.style.transform.includes('scaleX(-1)'))
      ?? document.querySelector<HTMLVideoElement>('.room-grid video');
    if (!v) { toast('No one has video on yet.', true); return; }
    try { setMinimized(true); await v.requestPictureInPicture(); } catch (e) { toast((e as Error).message, true); }
  };
  const others = room.participants.filter((p) => p.deviceId !== meDevice);
  const shared = others.find((p) => p.screen);
  const sharedStream = shared ? peers.get(shared.deviceId)?.streams.find((s, i) => i > 0 && s.getVideoTracks().length) ?? null : null;
  const name = title(room.convId);

  if (minimized) {
    return createPortal(
      <div className="mini-room" role="region" aria-label="Call">
        <div className="mini-pulse" />
        <div className="sb-main"><span className="sb-name">{name}</span><span className="sb-preview">{duration} · {room.participants.length} in the Room</span></div>
        <button className={`round sm${muted ? ' off' : ''}`} onClick={toggleMute} title={muted ? 'Unmute' : 'Mute'}><Icon name={muted ? 'mic-off' : 'mic'} size={16} /></button>
        <button className="round sm" onClick={() => setMinimized(false)} title="Back to the Room"><Icon name="expand" size={16} /></button>
        <button className="round sm leave" onClick={leave} title="Leave"><Icon name="phone-off" size={16} /></button>
      </div>,
      document.body,
    );
  }

  const count = others.length + 1;
  return createPortal(
    <div className="room-stage" role="dialog" aria-label={`Room: ${name}`}>
      <header className="room-head">
        <span className="room-live" /><span className="label">Room</span>
        <h2>{name}</h2>
        <span className="mono faint">{duration}</span>
        {quality && quality.label !== 'unknown' && others.length > 0 && (
          <span className={`chip q-${quality.label}`} title={`Round trip ${quality.rttMs ?? '?'} ms · loss ${quality.loss === null ? '?' : `${(quality.loss * 100).toFixed(1)}%`}${quality.relayed ? ' · through a relay' : ''}`}>
            <span className="q-bars"><i /><i /><i /></span>{quality.label === 'good' ? 'Good connection' : quality.label === 'fair' ? 'Fair connection' : 'Poor connection'}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {recorders.length > 0 && <span className="chip rec-chip" role="status"><span className="rec-dot" />{recorders.includes(meId) ? 'You are recording' : `${users.get(recorders[0])?.displayName ?? 'Someone'} is recording`}</span>}
        {room.ringing.length > 0 && <span className="chip warn">Ringing {room.ringing.map((u) => users.get(u)?.displayName.split(' ')[0]).join(', ')}</span>}
        <button className="icon-btn" onClick={() => { onOpenConversation(room.convId); setMinimized(true); }} title="Open the conversation"><Icon name="chat" size={18} /></button>
        <button className="icon-btn" onClick={() => setMinimized(true)} title="Minimise (keep talking)"><Icon name="minimize" size={18} /></button>
      </header>
      <div className={`room-body${shared || screen ? ' sharing' : ''}`}>
        {(sharedStream || screen) && (
          <div className="room-share">
            <Video stream={(sharedStream ?? screen)!} muted fit="contain" />
            <span className="room-name"><Icon name="screen" size={13} />{screen && !sharedStream ? 'You are sharing your screen' : `${users.get(shared!.userId)?.displayName ?? 'Someone'} is sharing`}</span>
          </div>
        )}
        <div className={`room-grid n${Math.min(count, 9)}`}>
          <Tile user={users.get(meId)} stream={local} camera={camera} muted={muted} me />
          {others.map((p) => (
            <Tile key={p.deviceId} user={users.get(p.userId)} stream={peers.get(p.deviceId)?.streams[0] ?? null} camera={p.camera} muted={p.muted} />
          ))}
          {others.length === 0 && (
            <div className="room-tile waiting"><span className="spinner" /><span>{room.ringing.length ? 'Calling…' : 'Waiting for others to join'}</span></div>
          )}
        </div>
      </div>
      <footer className="room-dock">
        <button className={`round${muted ? ' off' : ''}`} onClick={toggleMute} title={muted ? 'Unmute' : 'Mute'}><Icon name={muted ? 'mic-off' : 'mic'} size={20} /><span>{muted ? 'Unmute' : 'Mute'}</span></button>
        <button className={`round${camera ? '' : ' off'}`} onClick={() => void toggleCamera()} title={camera ? 'Stop camera' : 'Start camera'}><Icon name={camera ? 'video' : 'video-off'} size={20} /><span>Camera</span></button>
        {window.dex.listScreens && (
          <button className={`round${screen ? ' active' : ''}`} onClick={() => (screen ? void toggleScreen() : setPicker(true))} title={screen ? 'Stop sharing' : 'Share your screen'}><Icon name="screen" size={20} /><span>{screen ? 'Stop' : 'Share'}</span></button>
        )}
        {recordSupported() && (policy.allowRecording || myRec) && (
          <button className={`round${myRec ? ' active rec' : ''}`} title={myRec ? 'Stop recording' : 'Record the call (everyone is told)'}
            onClick={() => (myRec ? stopRecording() : void startRecording((id) => users.get(id)?.displayName ?? 'Someone', meId).catch((e: Error) => toast(e.message, true)))}>
            <Icon name="record" size={20} /><span>{myRec ? 'Stop' : 'Record'}</span>
          </button>
        )}
        <button ref={addBtn} className="round" title="Add people to the call" onClick={() => setAdding(!adding)}><Icon name="people" size={20} /><span>Add</span></button>
        {typeof document !== 'undefined' && 'pictureInPictureEnabled' in document && (
          <button className="round" title="Keep the video on top in a small window" onClick={() => void popOut()}><Icon name="expand" size={20} /><span>Pop out</span></button>
        )}
        <button className="round leave" onClick={leave} title="Leave the Room"><Icon name="phone-off" size={20} /><span>Leave</span></button>
      </footer>
      {picker && <ScreenPicker onPick={(id, sound) => { setPicker(false); void toggleScreen(id, sound); }} onClose={() => setPicker(false)} />}
      {adding && (
        <Popover anchor={addBtn.current} onClose={() => setAdding(false)} className="menu add-people" align="start">
          <div className="menu-label">Ring into the call</div>
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
        <div className="screen-grid">
          {sources?.map((s) => (
            <button key={s.id} className="screen-option" onClick={() => onPick(s.id, canSound && sound)}>
              <img src={s.thumbnail} alt="" /><span>{s.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function IncomingCall({ users, title }: { users: Map<string, PublicUser>; title: (convId: string) => string }) {
  const incoming = useCall((s) => s.incoming);
  const toast = useToast();
  if (!incoming) return null;
  const from = users.get(incoming.from);
  const group = incoming.room.ringing.length + incoming.room.participants.length > 2;
  const go = (video: boolean) => void answer(video).catch((e: Error) => toast(e.message, true));
  return createPortal(
    <div className="incoming" role="alertdialog" aria-label="Incoming call">
      <div className="incoming-tile"><Avatar user={{ id: incoming.from, displayName: from?.displayName ?? '?' }} presence="room" size="lg" /></div>
      <div className="sb-main">
        <span className="label">{incoming.room.video ? 'Video call' : 'Voice call'}</span>
        <strong>{from?.displayName ?? 'Someone'}</strong>
        <span className="sb-preview">{group ? `in ${title(incoming.room.convId)}` : 'is calling you'}</span>
      </div>
      <div className="incoming-actions">
        <button className="round sm leave" onClick={decline} title="Decline"><Icon name="phone-off" size={18} /></button>
        <button className="round sm accept" onClick={() => go(false)} title="Answer with sound only"><Icon name="phone" size={18} /></button>
        <button className="round sm accept" onClick={() => go(true)} title="Answer with video"><Icon name="video" size={18} /></button>
      </div>
    </div>,
    document.body,
  );
}

/** Call buttons for a conversation header; "Join" when a Room is already running there. */
export function CallButtons({ convId, live }: { convId: string; live: boolean }) {
  const toast = useToast();
  const active = useCall((s) => s.active.get(convId));
  const inCall = useCall((s) => s.room);
  if (inCall?.convId === convId) return <button className="btn update-btn" onClick={() => setMinimized(false)}><Icon name="phone" size={15} />Back to the Room</button>;
  if (active && active.participants.length) {
    return (
      <button className="btn update-btn" disabled={!live || !!inCall} onClick={() => void joinRoom(active.id, false).catch((e: Error) => toast(e.message, true))}>
        <Icon name="phone" size={15} />Join the Room · {active.participants.length}
      </button>
    );
  }
  const call = (video: boolean) => void startCall(convId, video).catch((e: Error) => toast(e.message, true));
  return (
    <>
      <button className="icon-btn" disabled={!live || !!inCall} onClick={() => call(false)} title="Voice call"><Icon name="phone" size={17} /></button>
      <button className="icon-btn" disabled={!live || !!inCall} onClick={() => call(true)} title="Video call"><Icon name="video" size={17} /></button>
    </>
  );
}

/** After a call recording stops: save it on this PC or share it in the conversation. */
export function RecordingReady() {
  const r = useRecorder();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!r || r.recording || !r.done) return null;
  const { blob, ms, convId } = r.done;
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '');
  const name = `Call recording ${stamp}.webm`;
  const mins = Math.max(1, Math.round(ms / 60_000));
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
      await sendMessage(convId, `Recording of the call (${mins} min)`, null, [info]);
      toast('Shared in the conversation');
      clearRecording();
    } catch (e) { toast((e as Error).message, true); setBusy(false); }
  };
  return (
    <Dialog title="Call recording ready" onClose={() => { if (confirm('Discard this recording? It has not been saved.')) clearRecording(); }}>
      <p className="muted" style={{ margin: 0 }}>{mins} min · {(blob.size / 1024 / 1024).toFixed(1)} MB. It is only on this PC until you save or share it.</p>
      <div className="dialog-actions">
        <button className="btn ghost danger" onClick={() => { if (confirm('Discard this recording?')) clearRecording(); }}>Discard</button>
        {!/Android/i.test(navigator.userAgent) && <button className="btn" onClick={save}><Icon name="download" size={15} />Save to this PC</button>}
        {window.dex.uploadFile && convId && blob.size <= limit && <button className="btn primary" disabled={busy} onClick={() => void share()}>{busy ? <span className="spinner" /> : <Icon name="send" size={15} />}Share in the conversation</button>}
      </div>
    </Dialog>
  );
}
