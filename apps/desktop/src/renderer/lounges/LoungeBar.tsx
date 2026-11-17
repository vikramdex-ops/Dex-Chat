// The lounge bar: while you are in a lounge, a small floating bar instead of the Room sheet. It
// holds the lounge's name and time, who is in it (a ring while they speak), your microphone,
// sharing a screen, the people list and Leave. A screen someone shares opens in a small viewer
// with live pointers. Loaded only when you join a lounge.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PublicUser } from '@dex/core';
import { Avatar, Icon, Popover, useToast } from '../ui.tsx';
import { clearError, toggleMute, toggleScreen, useCall } from '../rooms/engine.ts';
import { AudioOut, Clock, Glyph, Video } from '../rooms/parts.tsx';
import { keepVoices, stopVoices, useSpeaking, watchVoice } from '../rooms/speech.ts';
import { ScreenPicker } from '../rooms/RoomUi.tsx';
import { RoomPointers } from '../pointers/surfaces.tsx';
import { leaveLounge } from './store.ts';
import { LoungeGlyph } from './Lounges.tsx';
import './lounges.css';

function Voices({ meDevice, roomId }: { meDevice: string; roomId: string }) {
  const peers = useCall((s) => s.peers);
  const local = useCall((s) => s.local);
  const muted = useCall((s) => s.muted);
  useEffect(() => {
    const keep = new Set<string>([`self:${meDevice}`]);
    watchVoice(`self:${meDevice}`, local);
    for (const p of peers.values()) { keep.add(p.deviceId); watchVoice(p.deviceId, p.streams[0] ?? null); }
    keepVoices(keep);
  }, [peers, local, meDevice]);
  useEffect(() => () => stopVoices(), []);
  // tell the Space when I speak (the lounge's live pip), a moment after it changes
  const speaking = useSpeaking(`self:${meDevice}`) && !muted;
  const sent = useRef(false);
  useEffect(() => {
    const t = setTimeout(() => {
      if (sent.current === speaking) return;
      sent.current = speaking;
      void window.dex.request('room.speaking', { roomId, speaking }).catch(() => {});
    }, speaking ? 150 : 600);
    return () => clearTimeout(t);
  }, [speaking, roomId]);
  return <div hidden>{[...peers.values()].flatMap((p) => p.streams.filter((s) => s.getAudioTracks().length).map((s) => <AudioOut key={`${p.deviceId}:${s.id}`} stream={s} />))}</div>;
}

function Person({ deviceId, userId, name, me, muted }: { deviceId: string; userId: string; name: string; me: boolean; muted: boolean }) {
  const speaking = useSpeaking(me ? `self:${deviceId}` : deviceId) && !muted;
  return (
    <span className={`lg-tile${speaking ? ' speaking' : ''}${muted ? ' muted' : ''}`} title={`${me ? 'You' : name}${muted ? ' · mic off' : speaking ? ' · speaking' : ''}`}>
      <Avatar user={{ id: userId, displayName: name }} size="sm" />
    </span>
  );
}

export default function LoungeBar({ users, meId, meDevice }: { users: Map<string, PublicUser>; meId: string; meDevice: string }) {
  const room = useCall((s) => s.room);
  const muted = useCall((s) => s.muted);
  const screen = useCall((s) => s.screen);
  const error = useCall((s) => s.error);
  const toast = useToast();
  const [picker, setPicker] = useState(false);
  const [people, setPeople] = useState(false);
  const [view, setView] = useState(true);
  const peopleBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (error) { toast(error, true); clearError(); } }, [error, toast]);
  const sharer = room?.participants.find((p) => p.screen && p.deviceId !== meDevice) ?? null;
  // lounges are audio only: a picture from someone is their shared screen (it may be their only stream)
  const shared = useCall((s) => (sharer ? s.peers.get(sharer.deviceId)?.streams.filter((x) => x.getVideoTracks().length).at(-1) ?? null : null));
  useEffect(() => { if (sharer) setView(true); }, [sharer?.deviceId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!room || room.purpose?.kind !== 'lounge') return null;
  const name = room.purpose.name;
  const nameOf = (id: string) => users.get(id)?.displayName ?? 'Someone';
  const me = room.participants.find((p) => p.deviceId === meDevice);
  const others = room.participants.filter((p) => p.deviceId !== meDevice);
  return createPortal(
    <>
      <Voices meDevice={meDevice} roomId={room.id} />
      {screen && <div className="pt-hidden"><RoomPointers presenterDevice={meDevice} users={users} meId={meId} /></div>}
      {sharer && shared && view && (
        <figure className="lg-screen" aria-label={`${nameOf(sharer.userId)}'s screen`}>
          <Video stream={shared} muted fit="contain" />
          <RoomPointers presenterDevice={sharer.deviceId} users={users} meId={meId} />
          <figcaption className="mono">{nameOf(sharer.userId).toUpperCase()} · SCREEN<button className="icon-btn" aria-label="Hide the screen" title="Hide (the lounge goes on)" onClick={() => setView(false)}><Icon name="minimize" size={14} /></button></figcaption>
        </figure>
      )}
      <div className="lg-bar" role="region" aria-label={`Lounge: ${name}`}>
        <span className="lg-bar-pip" aria-hidden="true" />
        <span className="lg-bar-title">
          <span className="label">Lounge</span>
          <strong translate="no">{name}</strong>
        </span>
        <Clock since={room.startedAt} className="mono lg-bar-time" />
        <span className="lg-people">
          <Person deviceId={meDevice} userId={meId} name={nameOf(meId)} me muted={muted || !me} />
          {others.slice(0, 5).map((p) => <Person key={p.deviceId} deviceId={p.deviceId} userId={p.userId} name={nameOf(p.userId)} me={false} muted={p.muted} />)}
          {others.length > 5 && <span className="lg-more mono">+{others.length - 5}</span>}
        </span>
        <span className="lg-bar-tools">
          <button className={`lg-btn${muted ? ' off' : ''}`} aria-pressed={!muted} onClick={toggleMute} title={muted ? 'Turn your mic on' : 'Turn your mic off'}>
            <Icon name={muted ? 'mic-off' : 'mic'} size={16} /><span>{muted ? 'Mic off' : 'Mic on'}</span>
          </button>
          {window.dex.listScreens && (
            <button className={`lg-btn${screen ? ' on' : ''}`} aria-pressed={!!screen} onClick={() => (screen ? void toggleScreen() : setPicker(true))} title={screen ? 'Stop sharing your screen' : 'Share a screen or window with the lounge'}>
              <Icon name="screen" size={16} /><span>{screen ? 'Stop sharing' : 'Share'}</span>
            </button>
          )}
          {sharer && !view && <button className="lg-btn" onClick={() => setView(true)} title={`Show ${nameOf(sharer.userId)}'s screen`}><Icon name="eye" size={16} /><span>Screen</span></button>}
          <button ref={peopleBtn} className="lg-btn" aria-expanded={people} onClick={() => setPeople(!people)} title="Who is here" aria-label={`Who is here · ${room.participants.length}`}><Icon name="people" size={16} /><span className="mono">{room.participants.length}</span></button>
          <button className="lg-btn leave" onClick={leaveLounge} title="Leave the lounge"><Glyph name="door" size={16} /><span>Leave</span></button>
        </span>
      </div>
      {people && (
        <Popover anchor={peopleBtn.current} onClose={() => setPeople(false)} className="menu lg-pop" align="end">
          <div className="menu-label label"><LoungeGlyph size={12} /> {name} · {room.participants.length} here</div>
          {room.participants.map((p) => (
            <div key={p.deviceId} className="lg-pop-row">
              <Avatar user={{ id: p.userId, displayName: nameOf(p.userId) }} size="sm" />
              <span className="lg-main"><span className="lg-name">{p.deviceId === meDevice ? 'You' : nameOf(p.userId)}</span></span>
              {p.screen && <span className="mono lg-sub">SHARING</span>}
              <Icon name={(p.deviceId === meDevice ? muted : p.muted) ? 'mic-off' : 'mic'} size={14} />
            </div>
          ))}
        </Popover>
      )}
      {picker && <ScreenPicker onClose={() => setPicker(false)} onPick={(id, sound) => { setPicker(false); void toggleScreen(id, sound); }} />}
    </>,
    document.body,
  );
}
