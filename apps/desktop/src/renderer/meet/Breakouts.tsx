// Breakout rooms in the Room sheet. Setting up: the host picks how many rooms, deals people out at
// random or drags them between the room columns (or picks a room from each person's menu), sets a
// timer, and opens them. While they run: the host sees each room with who is in it, visits one,
// sends a note to every room, and calls everyone back; everyone sees which room they are in, the
// time left, and the 60-second countdown before they go back to the main Room.
import { useEffect, useMemo, useState } from 'react';
import type { DragEvent } from 'react';
import { BREAKOUT_MAX_ROOMS } from '@dex/core';
import type { PublicUser, RoomInfo } from '@dex/core';
import { Dialog, Icon, useToast } from '../ui.tsx';

const TIMERS: Array<[number | null, string]> = [[null, 'No timer'], [5, '5 minutes'], [10, '10 minutes'], [15, '15 minutes'], [20, '20 minutes'], [30, '30 minutes'], [45, '45 minutes'], [60, '1 hour']];
const left = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/** A clock that re-renders its own text once a second. */
function Countdown({ until, className }: { until: number; className?: string }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  return <span className={className}>{left(until - Date.now())}</span>;
}

/** Shuffle (Fisher–Yates) with the browser's crypto randomness. */
function shuffle<T>(list: T[]): T[] {
  const a = [...list];
  const r = new Uint32Array(a.length);
  crypto.getRandomValues(r);
  for (let i = a.length - 1; i > 0; i--) { const j = r[i] % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** Setting up: rooms as columns of people; drag a person to another column. */
export function BreakoutSetup({ room, users, meDevice, onClose }: { room: RoomInfo; users: Map<string, PublicUser>; meDevice: string; onClose: () => void }) {
  const toast = useToast();
  const hostIds = new Set([room.hostId, ...(room.coHosts ?? [])]);
  // hosts stay in the main Room unless the host puts them somewhere
  const people = useMemo(() => room.participants.filter((p) => p.deviceId !== meDevice), [room.participants, meDevice]);
  const [count, setCount] = useState(Math.min(BREAKOUT_MAX_ROOMS, Math.max(2, Math.round(people.length / 3))));
  const [names, setNames] = useState<string[]>(() => Array.from({ length: BREAKOUT_MAX_ROOMS }, (_, i) => `Room ${i + 1}`));
  const [where, setWhere] = useState<Map<string, number>>(() => new Map());
  const [minutes, setMinutes] = useState<number | null>(15);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState<number | null>(null);
  const nameOf = (userId: string) => users.get(userId)?.displayName ?? 'Someone';
  const deal = () => {
    const order = shuffle(people.filter((p) => !hostIds.has(p.userId)));
    const next = new Map<string, number>();
    order.forEach((p, i) => next.set(p.deviceId, i % count));
    setWhere(next);
  };
  const put = (deviceId: string, to: number) => setWhere((w) => { const n = new Map(w); if (to < 0) n.delete(deviceId); else n.set(deviceId, to); return n; });
  const drop = (to: number) => (e: DragEvent) => { e.preventDefault(); setOver(null); const dev = e.dataTransfer.getData('text/x-dex-device'); if (dev) put(dev, to); };
  const open = async () => {
    setBusy(true);
    try {
      const rooms = Array.from({ length: count }, (_, i) => ({ name: names[i].trim() || `Room ${i + 1}`, devices: people.filter((p) => where.get(p.deviceId) === i).map((p) => p.deviceId) }));
      await window.dex.request('room.breakout.open', { roomId: room.id, rooms, minutes });
      onClose();
    } catch (e) { toast((e as Error).message, true); setBusy(false); }
  };
  const columns = [-1, ...Array.from({ length: count }, (_, i) => i)];
  const placed = [...where.values()].filter((i) => i < count).length;
  return (
    <Dialog title="Breakout rooms" onClose={onClose}>
      <div className="bo-setup">
        <div className="bo-options">
          <label className="room-setting"><span className="label">Rooms</span>
            <select className="input" value={count} onChange={(e) => { const n = Number(e.target.value); setCount(n); setWhere((w) => new Map([...w].filter(([, i]) => i < n))); }}>
              {Array.from({ length: BREAKOUT_MAX_ROOMS - 1 }, (_, i) => i + 2).map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label className="room-setting"><span className="label">Timer</span>
            <select className="input" value={minutes ?? ''} onChange={(e) => setMinutes(e.target.value ? Number(e.target.value) : null)}>
              {TIMERS.map(([v, l]) => <option key={String(v)} value={v ?? ''}>{l}</option>)}
            </select>
          </label>
          <button className="btn" onClick={deal} disabled={!people.length}><Icon name="refresh" size={15} />Deal out at random</button>
        </div>
        <p className="faint bo-hint">Drag people between the columns, or choose a room from each name. Hosts stay in the main Room unless you place them. When the timer ends, everyone gets a 60-second countdown and comes back.</p>
        <div className="bo-columns" style={{ ['--cols' as string]: Math.min(columns.length, 4) }}>
          {columns.map((i) => {
            const here = people.filter((p) => (where.get(p.deviceId) ?? -1) === i);
            return (
              <section key={i} className={`bo-col${over === i ? ' over' : ''}${i < 0 ? ' main' : ''}`} aria-label={i < 0 ? 'Main Room' : names[i]}
                onDragOver={(e) => { e.preventDefault(); setOver(i); }} onDragLeave={() => setOver(null)} onDrop={drop(i)}>
                <div className="bo-col-head">
                  <span className="mono">{i < 0 ? 'MAIN' : `B${i + 1}`}</span>
                  {i < 0 ? <span className="bo-col-name">Main Room</span>
                    : <input className="bo-col-name input" maxLength={40} aria-label={`Name of breakout room ${i + 1}`} value={names[i]} onChange={(e) => setNames((n) => n.map((x, k) => (k === i ? e.target.value : x)))} />}
                  <span className="mono faint">{here.length}</span>
                </div>
                <ul>
                  {here.map((p) => (
                    <li key={p.deviceId} draggable onDragStart={(e) => { e.dataTransfer.setData('text/x-dex-device', p.deviceId); e.dataTransfer.effectAllowed = 'move'; }} data-device={p.deviceId}>
                      <span className="bo-grip" aria-hidden="true">⠿</span>
                      <span className="bo-who">{nameOf(p.userId)}{hostIds.has(p.userId) && <span className="role-tag">HOST</span>}{room.visitors?.some((v) => v.userId === p.userId) && <span className="role-tag">GUEST</span>}</span>
                      <select className="bo-move" aria-label={`Room for ${nameOf(p.userId)}`} value={i} onChange={(e) => put(p.deviceId, Number(e.target.value))}>
                        <option value={-1}>Main</option>
                        {Array.from({ length: count }, (_, k) => <option key={k} value={k}>B{k + 1}</option>)}
                      </select>
                    </li>
                  ))}
                  {!here.length && <li className="bo-empty faint">{i < 0 ? 'Everyone is placed' : 'Drop people here'}</li>}
                </ul>
              </section>
            );
          })}
        </div>
      </div>
      <div className="dialog-actions">
        <span className="faint">{placed} of {people.length} placed · you stay in the main Room</span>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !placed} onClick={() => void open()}>{busy ? <span className="spinner" /> : <Icon name="grid" size={15} />}Open {count} rooms</button>
      </div>
    </Dialog>
  );
}

/** While breakouts run: what the host sees in the People tab. */
export function BreakoutHostBox({ room }: { room: RoomInfo }) {
  const toast = useToast();
  const b = room.breakouts!;
  const [note, setNote] = useState('');
  const run = (p: Promise<unknown>) => void p.catch((e: Error) => toast(e.message, true));
  const here = room.parentId ? b.rooms.find((r) => r.roomId === room.id)?.index ?? null : null;
  return (
    <section className="bo-host" aria-label="Breakout rooms">
      <div className="tb-head"><span className="label">Breakout rooms</span><span className="mono">{b.rooms.length} OPEN{b.endsAt && !b.returningAt ? ' · ' : ''}{b.endsAt && !b.returningAt && <Countdown until={b.endsAt} />}</span></div>
      <ul className="bo-list">
        {b.rooms.map((r) => (
          <li key={r.index} className={here === r.index ? 'here' : undefined}>
            <span className="mono">B{r.index + 1}</span>
            <span className="bo-who"><b>{r.name}</b><small className="faint">{r.devices.length ? `${r.devices.length} in it` : 'Empty'}</small></span>
            {here === r.index ? <span className="mono faint">YOU ARE HERE</span>
              : <button className="btn sm ghost" onClick={() => run(window.dex.request('room.breakout.visit', { roomId: room.id, to: r.index }))}>Visit</button>}
          </li>
        ))}
        {room.parentId && <li><span className="mono">MAIN</span><span className="bo-who"><b>Main Room</b></span><button className="btn sm ghost" onClick={() => run(window.dex.request('room.breakout.visit', { roomId: room.id, to: 'main' }))}>Back</button></li>}
      </ul>
      <form className="bo-note" onSubmit={(e) => { e.preventDefault(); if (!note.trim()) return; run(window.dex.request('room.breakout.note', { roomId: room.id, text: note.trim() }).then(() => { setNote(''); toast('Note sent to every room'); })); }}>
        <input className="input" maxLength={500} placeholder="A note to every room" aria-label="A note to every room" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="btn sm" disabled={!note.trim()}>Send</button>
      </form>
      {b.returningAt
        ? <p className="bo-returning"><span className="mono">EVERYONE BACK IN </span><Countdown until={b.returningAt} className="mono" /> <button className="tb-link" onClick={() => run(window.dex.request('room.breakout.close', { roomId: room.id, now: true }))}>Now</button></p>
        : <button className="btn sm primary bo-callback" onClick={() => run(window.dex.request('room.breakout.close', { roomId: room.id }))}>Call everyone back</button>}
    </section>
  );
}

/** Over the field, for everyone: the breakout you are in, the time left, a host's note, the countdown home. */
export function BreakoutBanner({ room }: { room: RoomInfo }) {
  const b = room.breakouts;
  if (!b) return null;
  if (b.returningAt) {
    return (
      <div className="bo-banner amber" role="status">
        <span className="mono">BACK TO THE MAIN ROOM IN</span><Countdown until={b.returningAt} className="mono bo-big" />
        <span>The host called everyone back.</span>
      </div>
    );
  }
  if (!room.parentId) return null;
  return (
    <div className="bo-banner" role="status">
      <span className="mono">{(room.breakoutName ?? 'Breakout').toUpperCase()}</span>
      {b.endsAt && <><span className="faint">·</span><Countdown until={b.endsAt} className="mono" /><span className="faint">left</span></>}
      {b.note && <span className="bo-note-text">Note: {b.note.text}</span>}
    </div>
  );
}
