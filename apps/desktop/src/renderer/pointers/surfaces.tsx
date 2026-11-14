// Where live pointers appear: over a screen shared in a Room (messages over the Room's data
// channel), over a picture people look at together and over a whiteboard (messages through the
// hub, which knows who is looking), and on the presenter's own screen (a click-through window).
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { readPointerBatch } from '@dex/core/pointers';
import { containBox } from '@dex/core/assist';
import type { Box, PointerMsg } from '@dex/core/pointers';
import type { FileInfo, PointSession, PublicUser } from '@dex/core';
import { onRoomData, selfDevice, sendRoomData, sharedSource } from '../rooms/engine.ts';
import { Avatar, Icon, colorFor, useToast } from '../ui.tsx';
import { useFileSrc } from '../chat/files.tsx';
import { usePeople } from '../people.ts';
import { PointerLayer } from './layer.tsx';
import type { PointerTransport } from './layer.tsx';
import './pointers.css';

/** Pointers in a Room travel with the shared screen they belong to (a new share starts clean). */
function roomTransport(presenterDevice: string): PointerTransport {
  return {
    send: (b) => sendRoomData({ ...b, s: presenterDevice }),
    subscribe: (f) => onRoomData((dev, user, data) => {
      if ((data as { s?: unknown } | null)?.s !== presenterDevice) return;
      const m = readPointerBatch(data);
      if (m.length) f(dev, user, m);
    }),
  };
}

/** Pointers for a file or whiteboard go through the hub to everyone looking at it. */
function hubTransport(surface: string): PointerTransport {
  return {
    send: (b) => { void window.dex.request('point.send', { surface, data: b }).catch(() => {}); },
    subscribe: (f) => window.dex.onHubEvent((name, raw) => {
      if (name !== 'point.data') return;
      const d = raw as { surface: string; fromDevice: string; fromUser: string; data: unknown };
      if (d.surface !== surface) return;
      const m = readPointerBatch(d.data);
      if (m.length) f(d.fromDevice, d.fromUser, m);
    }),
  };
}

/** The picture inside a video or image drawn with object-fit: contain. */
function mediaBox(el: HTMLVideoElement | HTMLImageElement | null | undefined): Box | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const w = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth;
  const h = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
  return containBox({ x: r.left, y: r.top, width: r.width, height: r.height }, w, h);
}

const nameFrom = (users: Map<string, PublicUser>) => (id: string) => users.get(id)?.displayName ?? 'Someone';

/**
 * Over a screen shared in a Room (Stage.tsx puts it in the shared sheet). The person sharing
 * presents: they may clear marks and turn pointers off, and see everyone's pointers on their own
 * screen too.
 */
export function RoomPointers({ presenterDevice, users, meId }: { presenterDevice: string; users: Map<string, PublicUser>; meId: string }) {
  const me = selfDevice();
  const transport = useMemo(() => roomTransport(presenterDevice), [presenterDevice]);
  const presenting = presenterDevice === me;
  const nameOf = useMemo(() => nameFrom(users), [users]);
  useEffect(() => {
    if (!presenting || !window.dex.assist) return;
    window.dex.assist.pointers({ on: true, sourceId: sharedSource() });
    return () => window.dex.assist?.pointers({ on: false });
  }, [presenting]);
  return (
    <PointerLayer transport={transport} self={{ deviceId: me, userId: meId }} presenterDevice={presenterDevice}
      box={(el) => mediaBox(el.parentElement?.querySelector('video'))} nameOf={nameOf} colorOf={colorFor}
      mirror={presenting && window.dex.assist ? (from, m) => {
        if (from.deviceId === me && m.k === 'cur') return; // the presenter's real pointer is already there
        window.dex.assist!.pointer({ from: from.deviceId, userId: from.userId, name: nameOf(from.userId), color: colorFor(from.userId || from.deviceId), presenter: from.deviceId === presenterDevice, m });
      } : undefined} />
  );
}

/** Join a file's or whiteboard's pointer session on the hub while it is open. */
function usePointSession(surface: string, invite?: { convId: string; name: string }): PointSession | null {
  const [session, setSession] = useState<PointSession | null>(null);
  const toast = useToast();
  useEffect(() => {
    let alive = true;
    void window.dex.request('point.join', { surface, ...(invite ? { convId: invite.convId, invite: true, name: invite.name } : {}) })
      .then((s) => { if (alive) setSession(s); }).catch((e: Error) => toast(e.message, true));
    const off = window.dex.onHubEvent((name, d) => { if (name === 'point.session' && (d as PointSession).surface === surface) setSession(d as PointSession); });
    return () => { alive = false; off(); void window.dex.request('point.leave', { surface }).catch(() => {}); };
  }, [surface]); // eslint-disable-line react-hooks/exhaustive-deps
  return session;
}

function presenterOf(s: PointSession | null): string | null {
  if (!s) return null;
  return s.viewers.find((v) => v.userId === s.presenter)?.deviceId ?? null;
}

/** Over a whiteboard: positions are on the board itself, so they stay put as each person pans and zooms. */
export function BoardPointers({ boardId, view, canvas }: { boardId: string; view: RefObject<{ x: number; y: number; z: number }>; canvas: RefObject<HTMLCanvasElement | null> }) {
  const surface = `board:${boardId}`;
  const session = usePointSession(surface);
  const transport = useMemo(() => hubTransport(surface), [surface]);
  const { users: byId, meId } = usePeople();
  const presenter = presenterOf(session);
  // the board has no edges: a fixed square of 40,000 board units around its origin is the surface
  const EXTENT = 20_000;
  return (
    <div className="pt-board">
      <PointerLayer transport={transport} self={{ deviceId: selfDevice(), userId: meId }} presenterDevice={presenter} enabled={session?.enabled ?? true}
        onEnabled={(on) => void window.dex.request('point.set', { surface, enabled: on }).catch(() => {})}
        toolsAt="bottom"
        box={() => {
          const c = canvas.current;
          const v = view.current;
          if (!c || !v) return null;
          const r = c.getBoundingClientRect();
          return { x: r.left + v.x - EXTENT * v.z, y: r.top + v.y - EXTENT * v.z, width: 2 * EXTENT * v.z, height: 2 * EXTENT * v.z };
        }}
        nameOf={nameFrom(byId)} colorOf={colorFor} />
      {session && session.viewers.length > 1 && <Lookers session={session} users={byId} meId={meId} />}
    </div>
  );
}

function Lookers({ session, users, meId }: { session: PointSession; users: Map<string, PublicUser>; meId: string }) {
  const people = [...new Set(session.viewers.map((v) => v.userId))];
  return (
    <div className="pt-lookers" aria-label={`${people.length} looking`}>
      <span className="mono">LOOKING · {people.length}</span>
      {people.map((u) => <Avatar key={u} user={{ id: u, displayName: users.get(u)?.displayName ?? 'Someone' }} size="sm" />)}
      {session.presenter && <span className="mono pt-presenter">{session.presenter === meId ? 'YOU PRESENT' : `${(users.get(session.presenter)?.displayName ?? '').split(' ')[0].toUpperCase()} PRESENTS`}</span>}
    </div>
  );
}

const isPicture = (f: Pick<FileInfo, 'mime' | 'name'>) => f.mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.name);

/** The image viewer's "Look together" button (chat/Viewer.tsx). */
export function LookTogetherButton({ file, convId }: { file: FileInfo; convId: string }) {
  if (!isPicture(file)) return null;
  return (
    <button className="btn sm" title="Look at this with the conversation: everyone sees each other's pointers"
      onClick={() => window.dispatchEvent(new CustomEvent('dex-look', { detail: { file, convId, invite: true } }))}>
      <Icon name="eye" size={15} />Look together
    </button>
  );
}

/** A picture several people look at, with everyone's pointers (opened by the button or an invitation). */
export function CoView({ file, convId, invite, users, meId, onClose }: { file: FileInfo; convId: string; invite: boolean; users: Map<string, PublicUser>; meId: string; onClose: () => void }) {
  const surface = `file:${file.id}`;
  const session = usePointSession(surface, invite ? { convId, name: file.name } : undefined);
  const transport = useMemo(() => hubTransport(surface), [surface]);
  const src = useFileSrc(file);
  const img = useRef<HTMLImageElement>(null);
  const presenter = presenterOf(session);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as HTMLElement)?.closest?.('input')) onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return createPortal(
    <div className="coview" role="dialog" aria-modal="true" aria-label={`Looking together at ${file.name}`}>
      <header className="coview-bar">
        <span className="label">Looking together</span>
        <span className="coview-name" translate="no">{file.name}</span>
        <span style={{ flex: 1 }} />
        {session && <Lookers session={session} users={users} meId={meId} />}
        <button className="icon-btn" onClick={onClose} aria-label="Stop looking" title="Stop looking (Esc)"><Icon name="x" size={18} /></button>
      </header>
      <div className="coview-stage">
        {src ? <img ref={img} src={src} alt={file.name} draggable={false} /> : <span className="spinner" />}
        {src && (
          <PointerLayer transport={transport} self={{ deviceId: selfDevice(), userId: meId }} presenterDevice={presenter} enabled={session?.enabled ?? true}
            onEnabled={(on) => void window.dex.request('point.set', { surface, enabled: on }).catch(() => {})}
            box={() => mediaBox(img.current)} nameOf={nameFrom(users)} colorOf={colorFor} />
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Invitations to look at a file together, and the shared view itself. Mounted once in the app.
 */
export function LookHost({ users, meId }: { users: Map<string, PublicUser>; meId: string }) {
  const [open, setOpen] = useState<{ file: FileInfo; convId: string; invite: boolean } | null>(null);
  const [asked, setAsked] = useState<{ surface: string; convId: string; name: string; by: string } | null>(null);
  const toast = useToast();
  useEffect(() => {
    const onLook = (e: Event) => { const d = (e as CustomEvent).detail as { file: FileInfo; convId: string; invite: boolean }; setAsked(null); setOpen(d); };
    window.addEventListener('dex-look', onLook);
    const off = window.dex.onHubEvent((name, d) => { if (name === 'point.invite') setAsked(d as typeof asked); });
    return () => { window.removeEventListener('dex-look', onLook); off(); };
  }, []);
  // an invitation fades after a minute
  useEffect(() => { if (!asked) return; const t = setTimeout(() => setAsked(null), 60_000); return () => clearTimeout(t); }, [asked]);
  const accept = async () => {
    if (!asked) return;
    const id = asked.surface.replace(/^file:/, '');
    try {
      const list = await window.dex.request('file.list', { convId: asked.convId, limit: 200 });
      const f = list.find((x) => x.id === id);
      if (!f) throw new Error('That file is no longer in the conversation.');
      setOpen({ file: f, convId: asked.convId, invite: false });
      setAsked(null);
    } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <>
      {asked && !open && createPortal(
        <div className="look-card" role="alertdialog" aria-label="Look together">
          <Avatar user={{ id: asked.by, displayName: users.get(asked.by)?.displayName ?? 'Someone' }} />
          <div className="look-card-text">
            <strong>{users.get(asked.by)?.displayName ?? 'Someone'} asks you to look at a picture together</strong>
            <span className="mono" translate="no">{asked.name}</span>
          </div>
          <button className="btn primary sm" onClick={() => void accept()}><Icon name="eye" size={14} />Look</button>
          <button className="btn ghost sm" onClick={() => setAsked(null)}>Not now</button>
        </div>,
        document.body,
      )}
      {open && <CoView file={open.file} convId={open.convId} invite={open.invite} users={users} meId={meId} onClose={() => setOpen(null)} />}
    </>
  );
}

/** The presenter's own screen: everyone's pointers in a click-through window (#overlay=pointers). */
export function PointerOverlay() {
  const names = useRef(new Map<string, { name: string; color: string }>());
  const [presenter, setPresenter] = useState<string | null>(null);
  const listeners = useRef(new Set<(dev: string, user: string, m: PointerMsg[]) => void>());
  const transport = useMemo<PointerTransport>(() => ({ send: () => {}, subscribe: (f) => { listeners.current.add(f); return () => listeners.current.delete(f); } }), []);
  useEffect(() => window.dex.overlay?.onState((raw) => {
    const d = raw as { from: string; userId: string; name: string; color: string; presenter: boolean; m: unknown };
    const key = d.userId || d.from;
    names.current.set(key, { name: d.name, color: d.color });
    if (d.presenter) setPresenter(d.from);
    const m = readPointerBatch({ k: 'pt', m: [d.m] });
    for (const f of listeners.current) f(d.from, key, m);
  }), []);
  useEffect(() => { document.documentElement.classList.add('pt-overlay-doc'); }, []);
  return (
    <div className="pt-overlay">
      <PointerLayer transport={transport} self={{ deviceId: 'overlay', userId: 'overlay' }} presenterDevice={presenter} tools={false}
        box={() => ({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight })}
        nameOf={(u) => names.current.get(u)?.name ?? 'Someone'} colorOf={(u) => names.current.get(u)?.color ?? '#2a8c98'} />
    </div>
  );
}
