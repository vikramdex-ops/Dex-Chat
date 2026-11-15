// A webinar's stage, for its organiser and panelists, inside the Room sheet: the stage bar (practice
// or LIVE, who is watching, Go live and End, the live stream's health, a preview of what attendees
// see) and the panel's webinar tabs: Questions (answer live or in writing, pin, show on the stage,
// dismiss), Audience (raised hands first, invite someone to speak, bring them back), Polls (launch,
// close, results) and Handouts. The PC composing the stage runs it from here (Broadcaster).
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AudienceMember, Handout, PublicUser, RoomInfo, StreamStatus, WebinarInfo, WebinarPoll, WebinarQuestion } from '@dex/core';
import { Icon, useToast } from '../../ui.tsx';
import { capName, clock, setMinimized } from '../../rooms/engine.ts';
import { chatState } from '../../chat/store.ts';
import { loadStage, openWebinar, sizeText, useWeb, webState } from './store.ts';
import { startCompositor } from './compositor.ts';
import type { Compositor } from './compositor.ts';
import { StageBroadcast } from './broadcast.ts';
import type { BroadcastStatus } from './broadcast.ts';
import './webinar.css';

import type { WebinarTab } from './tabs.ts';

const hms = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

function useTick(on: boolean): void {
  const [, set] = useState(0);
  useEffect(() => { if (!on) return; const t = setInterval(() => set((x) => x + 1), 1000); return () => clearInterval(t); }, [on]);
}

/** The webinar this Room is the stage of: its info (role, stream settings), loaded once. */
function useInfo(meetingId: string): WebinarInfo | null {
  const [info, setInfo] = useState<WebinarInfo | null>(null);
  const version = useWeb((s) => s.stage.get(meetingId)?.live?.state);
  useEffect(() => { void window.dex.request('web.get', { id: meetingId }).then(setInfo).catch(() => {}); }, [meetingId, version]);
  return info;
}

export function streamLine(s: StreamStatus | null): string {
  if (!s || s.state === 'off') return 'Not streaming';
  if (s.state === 'unavailable') return s.message ?? 'ffmpeg is not installed on the hub PC';
  if (s.state === 'starting') return 'Starting: waiting for the first frames';
  if (s.state === 'live') return `${s.bitrate !== null ? `${Math.round(s.bitrate).toLocaleString()} kbit/s` : '—'} · ${s.fps !== null ? `${Math.round(s.fps)} fps` : '—'} · ${s.dropped} dropped · ${hms(s.seconds * 1000)} sent`;
  if (s.state === 'stalled') return s.message ?? 'Stalled';
  if (s.state === 'failed') return s.message ?? 'The stream stopped';
  return 'Stopped';
}

// ------------------------------------------------------------------ the stage bar
export function WebinarBar({ room, meId, meDevice, users }: { room: RoomInfo; meId: string; meDevice: string; users: Map<string, PublicUser> }) {
  const toast = useToast();
  const id = room.meetingId!;
  useEffect(() => { void loadStage(id).catch(() => {}); }, [id]);
  const stage = useWeb((s) => s.stage.get(id));
  const info = useInfo(id);
  const live = stage?.live ?? null;
  const state = live?.state ?? info?.state ?? 'practice';
  const organizer = room.hostId === meId || (room.coHosts ?? []).includes(meId);
  const broadcaster = live?.broadcaster ?? null;
  const mine = broadcaster === meDevice;
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  useTick(state === 'live');
  const nameOf = (uid: string) => users.get(uid)?.displayName ?? 'Someone';
  const composer = room.participants.find((p) => p.deviceId === broadcaster);
  const run = async (state: 'live' | 'ended') => {
    setBusy(true);
    try { await window.dex.request('web.state', { id, state }); toast(state === 'live' ? 'The webinar is live' : 'The webinar has ended'); } catch (e) { toast((e as Error).message, true); }
    setBusy(false);
  };
  const stream = stage?.stream ?? null;
  const streaming = !!stream && ['starting', 'live', 'stalled'].includes(stream.state);
  return (
    <>
      <div className={`wb-bar${state === 'live' ? ' live' : ''}`} role="region" aria-label="Webinar stage">
        <span className="wb-cell wb-state">
          <span className="label">Webinar</span>
          {state === 'live'
            ? <b className="wb-live mono"><i aria-hidden="true" />LIVE · {hms(Date.now() - (live?.wentLiveAt ?? Date.now()))}</b>
            : <b className="mono wb-practice">{state === 'ended' ? 'ENDED' : 'PRACTICE'}</b>}
        </span>
        <span className="wb-cell"><span className="label">Watching</span><b className="mono">{live?.audience ?? 0}{live?.hands ? ` · ${live.hands} ✋` : ''}</b></span>
        <Reacts r={stage?.reactions ?? null} />
        <span className="wb-cell wb-composer"><span className="label">Stage</span>
          <button className="wb-link mono" onClick={() => setPreview(!preview)} aria-pressed={preview} title={mine ? 'What attendees see, composed on this PC' : 'Which PC composes what attendees see'}>
            {mine ? 'ON THIS PC' : composer ? `${capName(nameOf(composer.userId))}'S PC` : 'NO ONE'}
          </button>
        </span>
        {organizer && info?.stream.url && (
          <span className={`wb-cell wb-stream${streaming ? ' on' : ''}${stream?.state === 'failed' || stream?.state === 'unavailable' ? ' bad' : ''}`} title={streamLine(stream)}>
            <span className="label">Live stream</span><b className="mono">{stream?.state === 'live' ? `${Math.round(stream.bitrate ?? 0)} KBIT/S · ${stream.dropped} DROP` : (stream?.state ?? 'off').toUpperCase()}</b>
          </span>
        )}
        <span className="wb-actions">
          {organizer && state !== 'live' && state !== 'ended' && <button className="btn sm primary wb-go" disabled={busy} onClick={() => void run('live')}><Icon name="play" size={14} />Go live</button>}
          {organizer && state === 'live' && <button className="btn sm danger" disabled={busy} onClick={() => setConfirmEnd(true)}>End webinar</button>}
          <button className="btn sm ghost" onClick={() => { setMinimized(true); openWebinar(id); }} title="The webinar's sheet: registrants, live stream, follow-up, report">Sheet…</button>
        </span>
      </div>
      {mine && <Broadcaster room={room} meId={meId} meDevice={meDevice} nameOf={nameOf} preview={preview} onClosePreview={() => setPreview(false)} />}
      {!mine && preview && (
        <div className="wb-preview" role="status">
          <div className="wb-preview-head"><span className="label">Stage</span><button className="icon-btn" aria-label="Close" onClick={() => setPreview(false)}><Icon name="x" size={14} /></button></div>
          <p className="wb-preview-note">{composer ? `${nameOf(composer.userId)}'s PC composes the stage: attendees see everyone here as tiles, a shared screen large, and any question shown on the stage.` : 'No PC on the stage can compose it yet.'}</p>
        </div>
      )}
      {confirmEnd && createPortal(
        <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) setConfirmEnd(false); }}>
          <div className="dialog narrow" role="dialog" aria-label="End the webinar">
            <h2>End the webinar for everyone?</h2>
            <p style={{ margin: 0 }}>Attendees see that it has ended, the live stream stops, and the stage closes. You can send the follow-up afterwards from the webinar's sheet.</p>
            <div className="dialog-actions"><span /><button className="btn ghost" onClick={() => setConfirmEnd(false)}>Keep it running</button>
              <button className="btn primary" autoFocus onClick={() => { setConfirmEnd(false); void run('ended'); }}>End webinar</button></div>
          </div>
        </div>, document.body)}
    </>
  );
}

/** The audience's reactions, for a moment, in the bar. */
function Reacts({ r }: { r: { seq: number; r: Record<string, number> } | null }) {
  const [shown, setShown] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    if (!r) return;
    setShown(r.r);
    const t = setTimeout(() => setShown(null), 3000);
    return () => clearTimeout(t);
  }, [r]);
  if (!shown) return null;
  return <span className="wb-cell wb-reacts" aria-label="Reactions from the audience">{Object.entries(shown).map(([e, n]) => <span key={e}>{e}<b className="mono">{n}</b></span>)}</span>;
}

/** On the PC composing the stage: the compositor, and the stage sent to the relay, viewers and the live stream. */
function Broadcaster({ room, meId, meDevice, nameOf, preview, onClosePreview }: { room: RoomInfo; meId: string; meDevice: string; nameOf: (id: string) => string; preview: boolean; onClosePreview: () => void }) {
  const id = room.meetingId!;
  const [status, setStatus] = useState<BroadcastStatus>({ direct: 0, relay: false, streaming: false, error: null });
  const comp = useRef<Compositor | null>(null);
  const holder = useRef<HTMLDivElement>(null);
  const names = useRef(nameOf);
  names.current = nameOf;
  const title = room.title ?? 'Webinar';
  useEffect(() => {
    const scene = () => {
      const s = useWebSnapshot(id);
      return { title, meetingId: id, live: s?.live?.state === 'live', wentLiveAt: s?.live?.wentLiveAt ?? null, question: s?.live?.onStage ?? null };
    };
    const c = startCompositor(scene, (u) => names.current(u), meId, meDevice);
    comp.current = c;
    const b = new StageBroadcast(id, c, setStatus);
    return () => { b.close(); c.stop(); comp.current = null; };
  }, [id, meId, meDevice, title]);
  useEffect(() => {
    const el = holder.current;
    const c = comp.current;
    if (!preview || !el || !c) return;
    c.canvas.className = 'wb-canvas';
    el.append(c.canvas);
    return () => { c.canvas.remove(); };
  }, [preview]);
  if (!preview) return status.error ? <div className="wb-problem" role="alert">{status.error}</div> : null;
  return (
    <div className="wb-preview" role="status" aria-label="What attendees see">
      <div className="wb-preview-head">
        <span className="label">Stage · what attendees see</span>
        <span className="mono faint">{status.relay ? 'RELAY · ' : ''}{status.direct} DIRECT{status.streaming ? ' · STREAM' : ''}</span>
        <button className="icon-btn" aria-label="Close" onClick={onClosePreview}><Icon name="x" size={14} /></button>
      </div>
      <div ref={holder} className="wb-canvas-box" />
      {status.error && <p className="field-error">{status.error}</p>}
    </div>
  );
}

const useWebSnapshot = (id: string) => webState().stage.get(id);

// ------------------------------------------------------------------ the panel's webinar tabs
export default function WebinarPanel({ tab, room, meId, users }: { tab: WebinarTab; room: RoomInfo; meId: string; users: Map<string, PublicUser> }) {
  const id = room.meetingId!;
  const organizer = room.hostId === meId || (room.coHosts ?? []).includes(meId);
  if (tab === 'questions') return <QuestionsTab id={id} organizer={organizer} />;
  if (tab === 'audience') return <AudienceTab id={id} organizer={organizer} room={room} meId={meId} users={users} />;
  if (tab === 'wpolls') return <PollsTab id={id} organizer={organizer} />;
  return <HandoutsTab id={id} organizer={organizer} />;
}

type QFilter = 'open' | 'answered' | 'dismissed';
const sortQ = (a: WebinarQuestion, b: WebinarQuestion) => Number(b.pinned) - Number(a.pinned) || b.votes - a.votes || a.at - b.at;

function QuestionsTab({ id, organizer }: { id: string; organizer: boolean }) {
  const toast = useToast();
  const questions = useWeb((s) => s.stage.get(id)?.questions);
  const [filter, setFilter] = useState<QFilter>('open');
  const [writing, setWriting] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const all = useMemo(() => [...(questions?.values() ?? [])].sort(sortQ), [questions]);
  const shown = all.filter((q) => (filter === 'open' ? q.status === 'open' : filter === 'answered' ? q.status === 'answered' || q.status === 'live' : q.status === 'dismissed'));
  const count = (f: QFilter) => all.filter((q) => (f === 'open' ? q.status === 'open' : f === 'answered' ? q.status === 'answered' || q.status === 'live' : q.status === 'dismissed')).length;
  const act = (p: Promise<unknown>) => void p.catch((e: Error) => toast(e.message, true));
  const moderate = (q: WebinarQuestion, action: 'dismiss' | 'reopen' | 'pin' | 'unpin' | 'stage' | 'unstage') => act(window.dex.request('web.moderate', { id, questionId: q.id, action }));
  return (
    <div className="wb-tab wb-questions">
      <div className="wb-filter" role="tablist" aria-label="Which questions">
        {(['open', 'answered', ...(organizer ? ['dismissed'] as const : [])] as QFilter[]).map((f) => (
          <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}>{f === 'open' ? 'Open' : f === 'answered' ? 'Answered' : 'Dismissed'}<span className="mono">{count(f)}</span></button>
        ))}
      </div>
      {!shown.length && <p className="meet-empty">{filter === 'open' ? 'No open questions. Attendees ask from their sheet; the most voted come first.' : filter === 'answered' ? 'Questions answered live or in writing show here.' : 'Nothing dismissed.'}</p>}
      <ol className="wb-qlist">
        {shown.map((q) => (
          <li key={q.id} className={`wb-q${q.pinned ? ' pinned' : ''}${q.onStage ? ' staged' : ''}`}>
            <span className="wb-votes mono" aria-label={`${q.votes} votes`}>▲<b>{q.votes}</b></span>
            <div className="wb-q-body">
              <p className="wb-q-text selectable">{q.text}</p>
              <p className="wb-q-meta mono">{[q.anonymous ? 'ANONYMOUS' : capName(q.author || '?'), clock(q.at), q.pinned ? 'PINNED' : '', q.onStage ? 'ON STAGE' : '', q.status === 'live' ? 'ANSWERED LIVE' : ''].filter(Boolean).join(' · ')}</p>
              {q.status === 'answered' && q.answer && <p className="wb-q-answer"><b className="mono">{capName(q.answer.by)} · </b>{q.answer.text}</p>}
              {writing === q.id && (
                <form className="wb-answer" onSubmit={(e) => { e.preventDefault(); if (!answer.trim()) return; act(window.dex.request('web.answer', { id, questionId: q.id, text: answer.trim() }).then(() => { setWriting(null); setAnswer(''); })); }}>
                  <textarea className="input" autoFocus rows={2} maxLength={2000} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Write the answer everyone sees" aria-label="Written answer" />
                  <div className="wb-row-actions"><button type="button" className="btn sm ghost" onClick={() => setWriting(null)}>Cancel</button><button className="btn sm primary" disabled={!answer.trim()}>Answer</button></div>
                </form>
              )}
              {writing !== q.id && q.status !== 'dismissed' && (
                <div className="wb-row-actions">
                  {q.status !== 'live' && <button className="btn sm" onClick={() => act(window.dex.request('web.answer', { id, questionId: q.id, live: true }))} title="You answered it out loud on the stage">Answered live</button>}
                  <button className="btn sm ghost" onClick={() => { setWriting(q.id); setAnswer(q.answer?.text ?? ''); }}>{q.answer?.text ? 'Edit answer' : 'Answer in writing'}</button>
                  {organizer && <button className="btn sm ghost" onClick={() => moderate(q, q.onStage ? 'unstage' : 'stage')}>{q.onStage ? 'Take off the stage' : 'Show on stage'}</button>}
                  {organizer && <button className="btn sm ghost" onClick={() => moderate(q, q.pinned ? 'unpin' : 'pin')}><Icon name="pin" size={13} />{q.pinned ? 'Unpin' : 'Pin'}</button>}
                  {organizer && <button className="btn sm ghost danger" onClick={() => moderate(q, 'dismiss')}>Dismiss</button>}
                </div>
              )}
              {q.status === 'dismissed' && organizer && <div className="wb-row-actions"><button className="btn sm ghost" onClick={() => moderate(q, 'reopen')}>Reopen</button></div>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

const ROUTE_LABEL: Record<AudienceMember['route'], string> = { relay: 'RELAY', direct: 'DIRECT', full: 'NO SEAT', none: 'WAITING' };

function AudienceTab({ id, organizer, room, meId, users }: { id: string; organizer: boolean; room: RoomInfo; meId: string; users: Map<string, PublicUser> }) {
  const toast = useToast();
  const bump = useWeb((s) => s.stage.get(id)?.audience ?? 0);
  const [list, setList] = useState<AudienceMember[] | null>(null);
  const [q, setQ] = useState('');
  // reload as the audience changes, at most once a second
  const last = useRef(0);
  useEffect(() => {
    const wait = Math.max(0, 1000 - (Date.now() - last.current));
    const t = setTimeout(() => { last.current = Date.now(); void window.dex.request('web.audience', { id }).then(setList).catch(() => setList([])); }, wait);
    return () => clearTimeout(t);
  }, [id, bump]);
  const conv = room.convId ? chatState().conversations.get(room.convId) : undefined;
  const backstage = new Set(conv?.members ?? []);
  const speakers = room.participants.filter((p) => p.userId !== room.hostId && !(room.coHosts ?? []).includes(p.userId) && !backstage.has(p.userId) && p.userId !== meId);
  const visitorName = (uid: string) => room.visitors?.find((v) => v.userId === uid)?.name;
  const act = (p: Promise<unknown>, done: string) => void p.then(() => toast(done)).catch((e: Error) => toast(e.message, true));
  const shown = (list ?? []).filter((a) => !q || a.name.toLowerCase().includes(q.toLowerCase()));
  const hands = (list ?? []).filter((a) => a.hand).length;
  return (
    <div className="wb-tab wb-audience">
      {speakers.length > 0 && (
        <section className="wb-speakers">
          <div className="tb-head"><span className="label">Invited to speak</span><span className="mono">{speakers.length}</span></div>
          <ul className="wb-alist">{speakers.map((p) => (
            <li key={p.deviceId}><span className="wb-aname"><b>{visitorName(p.userId) ?? users.get(p.userId)?.displayName ?? 'Speaker'}</b></span><span className="role-tag">ON STAGE</span>
              {organizer && <button className="btn sm ghost" onClick={() => act(window.dex.request('web.demote', { id, userId: p.userId }), 'Back in the audience')}>Back to audience</button>}</li>
          ))}</ul>
        </section>
      )}
      <div className="wb-audience-head">
        <span className="label">{list?.length ?? 0} watching · {hands === 1 ? '1 hand' : `${hands} hands`}</span>
        {organizer && hands > 0 && <button className="btn sm ghost" onClick={() => act(window.dex.request('web.hand', { id, up: false, all: true } as never), 'Hands lowered')}>Lower all hands</button>}
      </div>
      {(list?.length ?? 0) > 8 && <input className="input wb-find" placeholder="Find someone watching" aria-label="Find someone watching" value={q} onChange={(e) => setQ(e.target.value)} />}
      {list === null && <div className="tl-more"><span className="spinner" /></div>}
      {list?.length === 0 && <p className="meet-empty">No one is watching yet. Attendees appear here as they open the webinar: from the office (through the relay), or with their personal link.</p>}
      <ul className="wb-alist">
        {shown.map((a) => (
          <li key={a.deviceId} className={a.hand ? 'hand' : ''}>
            {a.hand ? <span className="wb-hand mono" aria-label={`Hand ${a.hand}`}>✋ {a.hand}</span> : <span className="wb-hand" aria-hidden="true" />}
            <span className="wb-aname"><b>{a.name}</b><span className={`mono wb-route ${a.route}`}>{a.web ? 'BROWSER' : 'APP'} · {ROUTE_LABEL[a.route]}</span></span>
            {organizer && (a.invited
              ? <span className="mono faint wb-invited">INVITED</span>
              : <button className="btn sm ghost" onClick={() => act(window.dex.request('web.promote', { id, deviceId: a.deviceId }), `${a.name} is asked to speak`)} title="Ask them onto the stage: they say yes or no">Invite to speak</button>)}
            {organizer && a.hand > 0 && <button className="icon-btn" aria-label={`Lower ${a.name}'s hand`} title="Lower the hand" onClick={() => act(window.dex.request('web.hand', { id, up: false, deviceId: a.deviceId }), 'Hand lowered')}><Icon name="x" size={13} /></button>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PollsTab({ id, organizer }: { id: string; organizer: boolean }) {
  const toast = useToast();
  const liveAt = useWeb((s) => s.stage.get(id)?.live);
  const [polls, setPolls] = useState<WebinarPoll[] | null>(null);
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState('');
  const [multi, setMulti] = useState(false);
  const [show, setShow] = useState(false);
  const [making, setMaking] = useState(false);
  // answers move the results: the hub says so with each update (results hidden from attendees too)
  const bump = useWeb((s) => s.stage.get(id)?.audience ?? 0);
  useEffect(() => { void window.dex.request('web.polls', { id }).then(setPolls).catch(() => setPolls([])); }, [id, liveAt, bump]);
  const opts = options.split('\n').map((o) => o.trim()).filter(Boolean);
  const launch = () => void window.dex.request('web.poll.launch', { id, question: question.trim(), options: opts, multi, showResults: show })
    .then((p) => { setPolls([p, ...(polls ?? []).map((x) => ({ ...x, open: false }))]); setQuestion(''); setOptions(''); setMaking(false); toast('Poll launched: attendees see it now'); })
    .catch((e: Error) => toast(e.message, true));
  return (
    <div className="wb-tab wb-polls">
      {organizer && !making && <button className="btn" onClick={() => setMaking(true)}><Icon name="poll" size={15} />New poll for the audience</button>}
      {organizer && making && (
        <form className="wb-pollform" onSubmit={(e) => { e.preventDefault(); launch(); }}>
          <label className="field-label" htmlFor="wb-pq">Question</label>
          <input id="wb-pq" className="input" maxLength={300} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Which skid size do you use most?" />
          <label className="field-label" htmlFor="wb-po">Answers, one a line</label>
          <textarea id="wb-po" className="input" rows={4} value={options} onChange={(e) => setOptions(e.target.value)} placeholder={'Small\nMedium\nLarge'} />
          <label className="check-line"><input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} />People may choose more than one</label>
          <label className="check-line"><input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />Attendees see the results as they come in</label>
          <div className="wb-row-actions"><button type="button" className="btn sm ghost" onClick={() => setMaking(false)}>Cancel</button><button className="btn sm primary" disabled={!question.trim() || opts.length < 2}>Launch poll</button></div>
        </form>
      )}
      {polls?.length === 0 && !making && <p className="meet-empty">{organizer ? 'Ask the audience a question: they answer from their sheet, and you choose whether they see the results.' : 'Polls the organiser launches show here with their results.'}</p>}
      {polls?.map((p) => {
        const total = Math.max(1, ...(p.results ?? [0]));
        return (
          <div key={p.id} className={`wb-poll${p.open ? ' open' : ''}`}>
            <div className="tb-head"><span className="label">{p.open ? 'Open now' : 'Closed'} · {clock(p.at)}</span><span className="mono">{p.voters} ANSWERED</span></div>
            <p className="wb-poll-q">{p.question}</p>
            {p.options.map((o, i) => <div key={i} className="rep-opt"><span>{o}</span><span className="rec-bar"><i style={{ width: `${((p.results?.[i] ?? 0) / total) * 100}%` }} /></span><span className="mono">{p.results?.[i] ?? 0}</span></div>)}
            <p className="faint wb-poll-note">{p.showResults ? 'Attendees see the results.' : 'Attendees do not see the results.'}</p>
            {organizer && p.open && (
              <div className="wb-row-actions">
                <button className="btn sm ghost" onClick={() => void window.dex.request('web.poll.close', { id, pollId: p.id, showResults: p.showResults }).then((x) => setPolls((polls ?? []).map((y) => (y.id === x.id ? x : y)))).catch((e: Error) => toast(e.message, true))}>Close</button>
                {!p.showResults && <button className="btn sm" onClick={() => void window.dex.request('web.poll.close', { id, pollId: p.id, showResults: true }).then((x) => setPolls((polls ?? []).map((y) => (y.id === x.id ? x : y)))).catch((e: Error) => toast(e.message, true))}>Close and show results</button>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function HandoutsTab({ id, organizer }: { id: string; organizer: boolean }) {
  const toast = useToast();
  const live = useWeb((s) => s.stage.get(id)?.live);
  const [list, setList] = useState<Handout[]>([]);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => { if (live) setList(live.handouts); }, [live]);
  const add = async (f: File) => {
    if (!window.dex.uploadFile) { toast('Files can be attached from the desktop app.', true); return; }
    setBusy(true);
    try {
      const info = await window.dex.uploadFile(`handout-${Date.now().toString(36)}`, { data: await f.arrayBuffer(), name: f.name, mime: f.type || undefined });
      setList(await window.dex.request('web.handout.add', { id, fileId: info.id }));
      toast(`${f.name} is a handout now`);
    } catch (e) { toast((e as Error).message, true); }
    setBusy(false);
  };
  return (
    <div className="wb-tab wb-handouts">
      {organizer && (
        <>
          <button className="btn" disabled={busy} onClick={() => file.current?.click()}>{busy ? <span className="spinner" /> : <Icon name="paperclip" size={15} />}Attach a handout</button>
          <input ref={file} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void add(f); }} />
        </>
      )}
      {!list.length && <p className="meet-empty">{organizer ? 'Files attendees can download during the webinar: slides, a datasheet, a checklist. Up to 12, 50 MB each.' : 'No handouts yet.'}</p>}
      <ul className="wb-hlist">
        {list.map((h) => (
          <li key={h.id}>
            <Icon name="doc" size={16} /><span className="wb-hname"><b>{h.name}</b><span className="mono faint">{sizeText(h.size)} · ADDED {clock(h.at)}</span></span>
            {organizer && <button className="icon-btn" aria-label={`Take ${h.name} away`} title="Take it away" onClick={() => void window.dex.request('web.handout.remove', { id, handoutId: h.id }).then(setList).catch((e: Error) => toast(e.message, true))}><Icon name="trash" size={14} /></button>}
          </li>
        ))}
      </ul>
    </div>
  );
}
