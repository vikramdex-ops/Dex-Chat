// A support session, loaded when one starts. The technician gets a sheet with the requester's
// shared screen, what they have allowed, and the ticket; with control allowed they can use the
// requester's mouse and keyboard on the picture. The requester gets a dock at the side of their
// screen saying who is with them and what they share, with a Stop for each, and an amber banner
// across the top while control is on.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ticketRef } from '@dex/core';
import type { HelpEntry, HelpTicket, PublicUser, SupportSession } from '@dex/core';
import { Avatar, Icon, useToast } from '../ui.tsx';
import { clearError, sendRoomData, setMinimized, toggleMute, useCall } from '../rooms/engine.ts';
import { AudioOut, Clock, Video } from '../rooms/parts.tsx';
import { RoomPointers } from '../pointers/surfaces.tsx';
import { Files, StatusStamp, Timeline, categoryLabel, platformLabel } from './parts.tsx';
import { ControlConsent, DiagnosticsSheet, ScreenConsent } from './Consent.tsx';
import { ControlBanner, ControlSurface } from './control.tsx';
import { clearAsk, endSession, screenEnded, sendFile, stopControl, stopScreen, useHelp } from './store.ts';
import './help.css';

interface Props { users: Map<string, PublicUser>; meId: string; meDevice: string }

function SessionAudio() {
  const peers = useCall((s) => s.peers);
  return <div hidden>{[...peers.values()].flatMap((p) => p.streams.filter((s) => s.getAudioTracks().length).map((s) => <AudioOut key={`${p.deviceId}:${s.id}`} stream={s} />))}</div>;
}

/** The ticket of the session, kept fresh. */
function useTicket(ticketId: string): { ticket: HelpTicket | null; timeline: HelpEntry[] } {
  const fromStore = useHelp((s) => s.queue.find((t) => t.id === ticketId) ?? s.mine.find((t) => t.id === ticketId) ?? null);
  const [data, setData] = useState<{ ticket: HelpTicket; timeline: HelpEntry[] } | null>(null);
  useEffect(() => {
    let alive = true;
    void window.dex.request('help.get', { id: ticketId }).then((d) => { if (alive) setData(d); }).catch(() => {});
    const off = window.dex.onHubEvent((name, d) => {
      if (name === 'help.entry' && (d as HelpEntry).ticketId === ticketId) setData((cur) => (cur && !cur.timeline.some((e) => e.id === (d as HelpEntry).id) ? { ...cur, timeline: [...cur.timeline, d as HelpEntry] } : cur));
      if (name === 'help.updated' && (d as HelpTicket).id === ticketId) setData((cur) => (cur ? { ...cur, ticket: d as HelpTicket } : cur));
    });
    return () => { alive = false; off(); };
  }, [ticketId]);
  const ticket = fromStore && (!data || fromStore.updatedAt >= data.ticket.updatedAt) ? fromStore : data?.ticket ?? null;
  return { ticket, timeline: data?.timeline ?? [] };
}

function useFileSend(ticketId: string): { pick: () => void; progress: { name: string; p: number } | null; input: React.ReactNode } {
  const toast = useToast();
  const [progress, setProgress] = useState<{ name: string; p: number } | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  const go = async (f: File | undefined) => {
    if (!f) return;
    setProgress({ name: f.name, p: 0 });
    try { await sendFile(ticketId, f, (sent, total) => setProgress({ name: f.name, p: total ? sent / total : 0 })); toast(`Sent ${f.name}`); } catch (e) { toast((e as Error).message, true); } finally { setProgress(null); if (ref.current) ref.current.value = ''; }
  };
  return {
    pick: () => ref.current?.click(),
    progress,
    input: <input ref={ref} type="file" hidden onChange={(e) => void go(e.target.files?.[0])} />,
  };
}

function SendProgress({ progress }: { progress: { name: string; p: number } | null }) {
  if (!progress) return null;
  return (
    <div className="sup-sending">
      <span className="mono">SENDING · {Math.round(progress.p * 100)}%</span><span className="hd-file-name" translate="no">{progress.name}</span>
      <span className="hd-progress" role="progressbar" aria-valuenow={Math.round(progress.p * 100)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.round(progress.p * 100)}%` }} /></span>
    </div>
  );
}

export default function SupportStage(props: Props) {
  const room = useCall((s) => s.room);
  const session = useHelp((s) => s.session);
  const error = useCall((s) => s.error);
  const toast = useToast();
  useEffect(() => { if (error) { toast(error, true); clearError(); } }, [error, toast]);
  if (!room || room.purpose?.kind !== 'support') return null;
  const ticketId = room.purpose.ticketId;
  if (!session || session.ticketId !== ticketId) return createPortal(<div className="sup-wait"><span className="spinner" /><SessionAudio /></div>, document.body);
  return session.techId === props.meId ? <TechStage {...props} session={session} /> : <RequesterDock {...props} session={session} />;
}

// ------------------------------------------------------------------ the technician
function TechStage({ users, meId, session }: Props & { session: SupportSession }) {
  const toast = useToast();
  const room = useCall((s) => s.room)!;
  const muted = useCall((s) => s.muted);
  const minimized = useCall((s) => s.minimized);
  const { ticket, timeline } = useTicket(session.ticketId);
  const requester = room.participants.find((p) => p.userId === session.requesterId) ?? null;
  // support sessions are audio only: any picture from the requester is their shared screen (it may be their only stream)
  const screen = useCall((s) => (requester ? s.peers.get(requester.deviceId)?.streams.filter((x) => x.getVideoTracks().length).at(-1) ?? null : null));
  const [controlling, setControlling] = useState(false);
  const files = useFileSend(session.ticketId);
  const name = users.get(session.requesterId)?.displayName ?? 'Someone';
  const first = name.split(' ')[0];
  useEffect(() => { if (!session.consent.control) setControlling(false); }, [session.consent.control]);
  const ask = (kind: 'screen' | 'control' | 'diagnostics') => void window.dex.request('help.ask', { id: session.ticketId, kind })
    .then(() => toast(kind === 'screen' ? `Asked ${first} to share their screen` : kind === 'control' ? `Asked ${first} for the mouse and keyboard` : `Asked ${first} for diagnostics`))
    .catch((e: Error) => toast(e.message, true));
  if (minimized) {
    return createPortal(
      <>
        <SessionAudio />
        <button className="sup-chip" onClick={() => setMinimized(false)} title="Back to the support session">
          <span className="room-chip-pip" aria-hidden="true" /><span className="mono">SUPPORT · {ticket ? ticketRef(ticket.number) : ''} · </span><Clock since={session.startedAt} className="mono" />
        </button>
      </>,
      document.body,
    );
  }
  return createPortal(
    <div className="sup-stage" role="dialog" aria-label={`Support session with ${name}`}>
      <SessionAudio />
      <section className={`sup-field${controlling ? ' controlling' : ''}`} aria-label={`${name}'s screen`}>
        {screen ? (
          <figure className="sup-screen">
            <Video stream={screen} muted fit="contain" />
            {controlling && requester
              ? <ControlSurface label={`Using ${first}'s mouse and keyboard`} tag={`YOU ARE USING ${first.toUpperCase()}'S MOUSE AND KEYBOARD`} action="Let go" onAction={() => setControlling(false)} send={sendRoomData} />
              : requester && <RoomPointers presenterDevice={requester.deviceId} users={users} meId={meId} />}
            <figcaption className="room-cap"><b>SHEET</b><span>{name.toUpperCase()} · {session.consent.scope === 'window' ? 'ONE WINDOW' : 'WHOLE SCREEN'}</span></figcaption>
          </figure>
        ) : (
          <div className="sup-empty">
            <span className="label">Their screen</span>
            <p>{session.consent.screen ? 'The picture is on its way…' : requester ? `${first} has not shared a screen. They choose what you see.` : `Waiting for ${first} to join the session.`}</p>
            {requester && !session.consent.screen && <button className="btn primary" onClick={() => ask('screen')}><Icon name="screen" size={15} />Ask to see their screen</button>}
          </div>
        )}
      </section>
      <aside className="sup-side">
        <div className="sup-block">
          <span className="label">Support session</span>
          <h2 translate="no">{ticket?.summary ?? ''}</h2>
          <dl className="hd-facts">
            <div><dt>Ref</dt><dd className="mono">{ticket ? ticketRef(ticket.number) : '—'}</dd></div>
            <div><dt>With</dt><dd><Avatar user={{ id: session.requesterId, displayName: name }} size="sm" /> {name}</dd></div>
            <div><dt>About</dt><dd>{ticket ? categoryLabel(ticket.category) : '—'}</dd></div>
            <div><dt>PC</dt><dd className="mono">{platformLabel(ticket?.platform ?? null).toUpperCase()}</dd></div>
            <div><dt>Time</dt><dd><Clock since={session.startedAt} className="mono" /></dd></div>
          </dl>
        </div>
        <div className="sup-consent">
          <div className={`sup-perm${session.consent.screen ? ' on' : ''}`}>
            <span className="label">Screen</span>
            <span>{session.consent.screen ? (session.consent.scope === 'window' ? 'One window shared' : 'Whole screen shared') : requester ? 'Not shared' : 'Not in the session yet'}</span>
            {!session.consent.screen && requester && <button className="btn sm" onClick={() => ask('screen')}>Ask</button>}
          </div>
          <div className={`sup-perm${session.consent.control ? ' on' : ''}`}>
            <span className="label">Control</span>
            <span>{session.consent.control ? `Allowed by ${first}` : session.controlAvailable ? 'Not allowed' : requester ? 'Not available on their PC' : '—'}</span>
            {session.consent.control
              ? <button className={`btn sm${controlling ? ' amber' : ' primary'}`} onClick={() => setControlling(!controlling)}>{controlling ? 'Let go' : 'Use their mouse and keyboard'}</button>
              : session.controlAvailable && session.consent.screen && session.consent.scope === 'screen' && <button className="btn sm" onClick={() => ask('control')}>Ask</button>}
          </div>
        </div>
        <div className="sup-tools">
          <button className={muted ? 'off' : 'on'} aria-pressed={!muted} onClick={toggleMute} title={muted ? 'Turn your mic on' : 'Turn your mic off'}><Icon name={muted ? 'mic-off' : 'mic'} size={17} /><span>{muted ? 'Mic off' : 'Mic on'}</span></button>
          <button onClick={() => ask('diagnostics')} disabled={!requester} title={`Ask ${first} to send this PC's diagnostics (they see everything first)`}><Icon name="pulse" size={17} /><span>Diagnostics</span></button>
          <button onClick={files.pick} title={`Send ${first} a file`}><Icon name="paperclip" size={17} /><span>Send a file</span></button>
          <button onClick={() => setMinimized(true)} title="Fold the session (it goes on)"><Icon name="minimize" size={17} /><span>Fold</span></button>
          <button className="end" onClick={() => void endSession()} title="End the session for both of you"><Icon name="phone-off" size={17} /><span>End session</span></button>
        </div>
        {files.input}
        <SendProgress progress={files.progress} />
        <div className="sup-scroll">
          {ticket && ticket.files.length > 0 && <><div className="label hd-sec">Files · {ticket.files.length}</div><Files files={ticket.files} users={users} meId={meId} /></>}
          <div className="label hd-sec">Timeline</div>
          <Timeline entries={timeline} users={users} />
        </div>
      </aside>
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------ the requester
function RequesterDock({ users, meId, meDevice, session }: Props & { session: SupportSession }) {
  const toast = useToast();
  const muted = useCall((s) => s.muted);
  const screen = useCall((s) => s.screen);
  const minimized = useCall((s) => s.minimized);
  const ask = useHelp((s) => (s.ask?.ticketId === session.ticketId ? s.ask : null));
  const control = useHelp((s) => s.control);
  const { ticket } = useTicket(session.ticketId);
  const [sheet, setSheet] = useState<'screen' | 'control' | 'diagnostics' | null>(null);
  const files = useFileSend(session.ticketId);
  const tech = users.get(session.techId)?.displayName ?? 'IT';
  const techFirst = tech.split(' ')[0];
  const techHere = useCall((s) => !!s.room?.participants.some((p) => p.userId === session.techId));
  // the picture stopped on its own (they closed the window they shared, or the screen went away)
  const wasSharing = useRef(false);
  useEffect(() => {
    if (wasSharing.current && !screen && session.consent.screen) void screenEnded();
    wasSharing.current = !!screen;
  }, [screen, session.consent.screen]);
  // what the technician asks for opens the dock
  useEffect(() => { if (ask) setMinimized(false); }, [ask]);
  const answerAsk = () => { if (!ask) return; setSheet(ask.kind); clearAsk(); };
  const run = (p: Promise<unknown>) => void p.catch((e: Error) => toast(e.message, true));
  const c = session.consent;
  return createPortal(
    <>
      <SessionAudio />
      {/* the technician's pointers on this screen (the click-through window), while it is shared */}
      {screen && <div className="pt-hidden"><RoomPointers presenterDevice={meDevice} users={users} meId={meId} /></div>}
      {c.control && <ControlBanner who={tech} onStop={() => run(stopControl())} />}
      {minimized ? (
        <button className={`sup-chip for-requester${c.screen ? ' sharing' : ''}`} onClick={() => setMinimized(false)} title="Open the support session">
          <span className="room-chip-pip" aria-hidden="true" /><span className="mono">IT · {techFirst.toUpperCase()}{c.screen ? ' · SHARING' : ''} · </span><Clock since={session.startedAt} className="mono" />
        </button>
      ) : (
        <aside className="sup-dock" role="dialog" aria-label={`Support session with ${tech}`}>
          <header className="sup-dock-head">
            <span className="label">IT is with you</span>
            <button className="icon-btn" onClick={() => setMinimized(true)} title="Fold to a small chip (the session goes on)" aria-label="Fold"><Icon name="minimize" size={15} /></button>
          </header>
          <div className="sup-who">
            <Avatar user={{ id: session.techId, displayName: tech }} presence={techHere ? 'room' : 'off'} />
            <div>
              <strong>{tech}</strong>
              <span className="mono faint">{techHere ? 'IT DESK · IN THE SESSION' : 'IT DESK · CONNECTING'} · <Clock since={session.startedAt} /></span>
            </div>
          </div>
          {ticket && <div className="sup-ticket"><span className="mono">{ticketRef(ticket.number)}</span><span translate="no">{ticket.summary}</span><StatusStamp t={ticket} /></div>}
          {ask && (
            <div className="sup-ask" role="alertdialog" aria-label="IT asks">
              <span>{techFirst} asks {ask.kind === 'screen' ? 'to see your screen' : ask.kind === 'control' ? 'to use your mouse and keyboard' : 'for this PC\'s diagnostics'}</span>
              <span className="sup-ask-actions">
                <button className="btn primary sm" onClick={answerAsk}>{ask.kind === 'diagnostics' ? 'See what is sent' : 'Choose'}</button>
                <button className="btn ghost sm" onClick={clearAsk}>No</button>
              </span>
            </div>
          )}
          <div className="sup-consent">
            <div className={`sup-perm${c.screen ? ' on' : ''}`}>
              <span className="label">Your screen</span>
              <span>{c.screen ? (c.scope === 'window' ? `${techFirst} sees one window` : `${techFirst} sees your screen`) : 'Not shared'}</span>
              {c.screen ? <button className="btn sm danger" onClick={() => run(stopScreen())}>Stop sharing</button>
                : <button className="btn sm primary" disabled={!window.dex.listScreens} onClick={() => setSheet('screen')}>Share…</button>}
            </div>
            <div className={`sup-perm${c.control ? ' on' : ''}`}>
              <span className="label">Mouse and keyboard</span>
              <span>{c.control ? `${techFirst} is in control` : control.available ? 'Only you' : 'Only you (no remote control on this PC)'}</span>
              {c.control ? <button className="btn sm danger" onClick={() => run(stopControl())}>Stop control</button>
                : control.available && <button className="btn sm" disabled={!c.screen || c.scope !== 'screen'} title={c.screen && c.scope === 'screen' ? '' : 'Share your whole screen first'} onClick={() => setSheet('control')}>Allow…</button>}
            </div>
            {!control.available && control.reason && <p className="faint sup-reason">{control.reason}</p>}
          </div>
          <div className="sup-tools">
            <button className={muted ? 'off' : 'on'} aria-pressed={!muted} onClick={toggleMute}><Icon name={muted ? 'mic-off' : 'mic'} size={17} /><span>{muted ? 'Mic off' : 'Mic on'}</span></button>
            <button onClick={() => setSheet('diagnostics')} disabled={!window.dex.assist} title="See and send this PC's diagnostics"><Icon name="pulse" size={17} /><span>Diagnostics</span></button>
            <button onClick={files.pick} title={`Send ${techFirst} a file`}><Icon name="paperclip" size={17} /><span>Send a file</span></button>
            <button className="end" onClick={() => run(endSession())}><Icon name="phone-off" size={17} /><span>End</span></button>
          </div>
          {files.input}
          <SendProgress progress={files.progress} />
          {ticket && ticket.files.length > 0 && <div className="sup-scroll"><div className="label hd-sec">Files · {ticket.files.length}</div><Files files={ticket.files} users={users} meId={meId} /></div>}
        </aside>
      )}
      {sheet === 'screen' && <ScreenConsent tech={tech} onClose={() => setSheet(null)} />}
      {sheet === 'control' && <ControlConsent tech={tech} onClose={() => setSheet(null)} />}
      {sheet === 'diagnostics' && ticket && <DiagnosticsSheet ticket={ticket} onClose={() => setSheet(null)} />}
    </>,
    document.body,
  );
}
