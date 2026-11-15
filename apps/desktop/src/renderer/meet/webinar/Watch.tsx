// Watching a webinar in the app, as an attendee: a sheet over the window with the stage (the
// picture the organiser's PC composes: through the office relay, or straight from that PC when
// this one is outside the office), the "starting soon" countdown before it goes live, and a
// panel with the questions (ask, anonymously if allowed, and vote), the poll and the handouts.
// Attendees are never seen or heard; the organiser may invite them to speak, and they choose.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MEETING_REACTIONS, formatMeetingId } from '@dex/core';
import type { Handout, WebinarPoll, WebinarQuestion } from '@dex/core';
import { Icon, useToast } from '../../ui.tsx';
import { capName, clock } from '../../rooms/engine.ts';
import { Glyph } from '../../rooms/parts.tsx';
import { answerInvite, patchWatching, sizeText, stopWatching, useWeb } from './store.ts';
import type { Watching } from './store.ts';
import { StageViewer } from './viewer-media.ts';
import './webinar.css';

const pad = (n: number) => String(n).padStart(2, '0');
const hms = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`; };

export default function Watch() {
  const w = useWeb((s) => s.watching);
  if (!w) return null;
  return <WatchSheet w={w} />;
}

function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!on) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [on]);
  return now;
}

function WatchSheet({ w }: { w: Watching }) {
  const toast = useToast();
  const live = w.live;
  const isLive = live.state === 'live' && !w.ended;
  const now = useNow(true);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [tab, setTab] = useState<'questions' | 'poll' | 'handouts'>('questions');
  const viewer = useRef<StageViewer | null>(null);
  useEffect(() => {
    const v = new StageViewer(w.meetingId, setStream);
    viewer.current = v;
    return () => { v.close(); viewer.current = null; };
  }, [w.meetingId]);
  useEffect(() => { void viewer.current?.setRoute(isLive ? w.route : 'none', live.roomId); }, [w.route, isLive, live.roomId]);
  // a poll opening asks for attention on its tab
  const pollOpen = !!live.poll?.open;
  useEffect(() => { if (pollOpen) toast('The organiser opened a poll'); }, [pollOpen, live.poll?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = (p: Promise<unknown>) => void p.catch((e: Error) => toast(e.message, true));
  const leave = () => { stopWatching(); };
  const hand = () => { const up = !w.hand; patchWatching({ hand: up }); run(window.dex.request('web.hand', { id: w.meetingId, up })); };
  return createPortal(
    <>
    <div className={`wb-watch${w.folded ? ' folded' : ''}`} role="dialog" aria-label={`Webinar: ${live.title}`} aria-hidden={w.folded || undefined}>
      <div className="wb-sheet">
        <section className="wb-stage-col">
          <div className="wb-stage-frame">
            <Stage w={w} stream={stream} now={now} />
            <Floats w={w} />
          </div>
          <div className="wb-tools" role="toolbar" aria-label="Webinar">
            <button className={w.hand ? 'hand' : ''} aria-pressed={w.hand} onClick={hand} title={w.hand ? 'Lower your hand' : 'Raise your hand: the organiser sees it'}><Glyph name="hand" /><span>{w.hand ? 'Hand up' : 'Raise hand'}</span></button>
            <div className="wb-react" role="group" aria-label="React">
              {MEETING_REACTIONS.map((e) => <button key={e} aria-label={`React ${e}`} onClick={() => run(window.dex.request('web.react', { id: w.meetingId, emoji: e }))}>{e}</button>)}
            </div>
            <span className="wb-tools-fill" />
            <button onClick={() => patchWatching({ folded: true })} title="Fold the webinar away and use the rest of the app (it keeps playing)"><Glyph name="fold" size={16} /><span>Fold</span></button>
            <button className="wb-leave" onClick={leave} title="Stop watching">Leave<Glyph name="door" size={16} /></button>
          </div>
        </section>
        <aside className="wb-side">
          <nav className="wb-side-tabs" role="tablist" aria-label="Webinar panel">
            <button role="tab" aria-selected={tab === 'questions'} onClick={() => setTab('questions')}>Questions<span className="mono">{w.questions.size}</span></button>
            <button role="tab" aria-selected={tab === 'poll'} className={pollOpen && tab !== 'poll' ? 'attn' : ''} onClick={() => setTab('poll')}>Poll<span className="mono">{pollOpen ? 'OPEN' : live.poll ? '1' : '—'}</span></button>
            <button role="tab" aria-selected={tab === 'handouts'} onClick={() => setTab('handouts')}>Handouts<span className="mono">{live.handouts.length}</span></button>
          </nav>
          <div className="wb-side-body" role="tabpanel">
            {tab === 'questions' && <Questions w={w} />}
            {tab === 'poll' && <Poll w={w} poll={live.poll} />}
            {tab === 'handouts' && <Handouts w={w} list={live.handouts} />}
          </div>
        </aside>
        <footer className="wb-block">
          <div className="tb-name"><span className="label">Webinar · you are watching</span><h2 title={live.title}>{live.title}</h2></div>
          <dl className="wb-cells">
            <div><dt className="label">State</dt><dd>{isLive ? <b className="wb-live mono"><i aria-hidden="true" />LIVE · {hms(now - (live.wentLiveAt ?? now))}</b> : <b className="mono">{w.ended || live.state === 'ended' ? 'ENDED' : 'STARTING SOON'}</b>}</dd></div>
            <div><dt className="label">Organiser</dt><dd>{live.host}</dd></div>
            <div><dt className="label">Watching</dt><dd className="mono">{live.audience}</dd></div>
            <div><dt className="label">ID</dt><dd className="mono">{formatMeetingId(live.meetingId)}</dd></div>
          </dl>
        </footer>
      </div>
      {w.invite && (
        <div className="wb-invite" role="alertdialog" aria-label="Invited to speak">
          <span className="label">Invitation to speak</span>
          <h2>{w.invite} invites you onto the stage</h2>
          <p>Everyone watching will see and hear you. You go back to the audience when the organiser says.</p>
          <div className="dialog-actions">
            <span />
            <button className="btn ghost" onClick={() => run(answerInvite(false, false))}>Not now</button>
            <button className="btn" onClick={() => run(answerInvite(true, false))}><Icon name="mic" size={15} />Speak with my mic</button>
            <button className="btn primary" onClick={() => run(answerInvite(true, true))}><Icon name="video" size={15} />Speak with video</button>
          </div>
        </div>
      )}
    </div>
    {w.folded && (
      <button className="wb-chip" onClick={() => patchWatching({ folded: false })} title="Back to the webinar">
        <span className={`wb-chip-pip${isLive ? ' live' : ''}`} aria-hidden="true" />
        <span className="mono">{isLive ? `WEBINAR · LIVE ${hms(now - (live.wentLiveAt ?? now))}` : w.ended || live.state === 'ended' ? 'WEBINAR · ENDED' : 'WEBINAR · STARTING SOON'}</span>
        <span className="wb-chip-title">{live.title}</span>
      </button>
    )}
    </>,
    document.body,
  );
}

function Stage({ w, stream, now }: { w: Watching; stream: MediaStream | null; now: number }) {
  const live = w.live;
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => { const v = video.current; if (v && v.srcObject !== stream) { v.srcObject = stream; void v.play().catch(() => {}); } }, [stream]);
  if (w.ended || live.state === 'ended') {
    return <div className="wb-soon"><span className="label">End of sheet</span><p className="wb-soon-line">The webinar has ended. Thank you for watching.</p><button className="btn" onClick={stopWatching}>Close</button></div>;
  }
  if (live.state !== 'live') {
    const left = Math.max(0, Math.floor((live.startsAt - now) / 1000));
    const cells: Array<[string, string]> = [['DAYS', pad(Math.floor(left / 86400))], ['HRS', pad(Math.floor(left / 3600) % 24)], ['MIN', pad(Math.floor(left / 60) % 60)], ['SEC', pad(left % 60)]];
    return (
      <div className="wb-soon">
        <span className="label">Starting soon</span>
        <div className="wb-count" role="timer" aria-label={left ? `Starts in ${Math.ceil(left / 60)} minutes` : 'Starting any moment'}>
          {cells.map(([l, v]) => <div key={l}><b className="mono">{v}</b><span className="mono">{l}</span></div>)}
        </div>
        <p className="wb-soon-line">{left ? `${live.title} starts at ${clock(live.startsAt)}.` : 'The organiser starts it any moment now.'}</p>
        <p className="wb-soon-note">{live.state === 'practice' ? `${live.host} and the panelists are on the stage, getting ready. You see and hear them once they go live.` : `With ${[live.host, ...live.panelists].join(', ')}. You can ask questions already.`}</p>
      </div>
    );
  }
  if (w.route === 'full') {
    return (
      <div className="wb-soon">
        <span className="label">The stage</span>
        <p className="wb-soon-line">This webinar sends to as many viewers outside the office as it can.</p>
        <p className="wb-soon-note">From the office network it has room for everyone. You can still ask, vote and answer the poll.</p>
        {live.watchUrl && <a className="btn primary" href={live.watchUrl} target="_blank" rel="noreferrer">Watch the live stream instead</a>}
      </div>
    );
  }
  return (
    <figure className="wb-stage">
      <video ref={video} autoPlay playsInline aria-label="The stage" />
      {!stream && <div className="wb-connecting"><span className="spinner" /><span>Connecting to the stage…</span></div>}
      <figcaption className="room-cap"><b>STAGE</b><span className="wb-cap-live">LIVE · {w.route === 'relay' ? 'OFFICE RELAY' : 'DIRECT'}</span></figcaption>
    </figure>
  );
}

/** Reactions from everyone, floating up the stage's edge for a moment. */
function Floats({ w }: { w: Watching }) {
  const [items, setItems] = useState<Array<{ id: number; emoji: string; x: number; d: number }>>([]);
  const seq = useRef(0);
  useEffect(() => {
    if (!w.reactions) return;
    const add = Object.entries(w.reactions.r).flatMap(([emoji, n]) => Array.from({ length: Math.min(n, 4) }, (_, i) => ({ id: ++seq.current, emoji, x: 6 + Math.random() * 30, d: i * 140 })));
    setItems((cur) => [...cur.slice(-24), ...add]);
    const t = setTimeout(() => setItems((cur) => cur.filter((x) => !add.includes(x))), 2600);
    return () => clearTimeout(t);
  }, [w.reactions]);
  return <div className="wb-floats" aria-hidden="true">{items.map((i) => <span key={i.id} style={{ left: `${i.x}%`, animationDelay: `${i.d}ms` }}>{i.emoji}</span>)}</div>;
}

function Questions({ w }: { w: Watching }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [anon, setAnon] = useState(false);
  const list = useMemo(() => [...w.questions.values()].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.votes - a.votes || a.at - b.at), [w.questions]);
  const ask = () => {
    const t = text.trim();
    if (!t) return;
    void window.dex.request('web.ask', { id: w.meetingId, text: t, anonymous: anon }).then((q) => {
      setText('');
      patchWatching({ questions: new Map(w.questions).set(q.id, { ...q, own: true }) });
      toast('Your question is with the panelists');
    }).catch((e: Error) => toast(e.message, true));
  };
  const vote = (q: WebinarQuestion) => {
    const up = !q.voted;
    patchWatching({ questions: new Map(w.questions).set(q.id, { ...q, voted: up, votes: q.votes + (up ? 1 : -1) }) });
    void window.dex.request('web.vote', { id: w.meetingId, questionId: q.id, up }).catch((e: Error) => toast(e.message, true));
  };
  return (
    <div className="wb-qa">
      <form className="wb-ask" onSubmit={(e) => { e.preventDefault(); ask(); }}>
        <textarea className="input" rows={2} maxLength={500} value={text} placeholder="Ask the panelists" aria-label="Your question"
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } }} />
        <div className="wb-row-actions">
          {w.live.anonymousQuestions ? <label className="check-line"><input type="checkbox" checked={anon} onChange={(e) => setAnon(e.target.checked)} />Without my name</label> : <span className="faint">Asked with your name</span>}
          <button className="btn sm primary" disabled={!text.trim()}>Ask</button>
        </div>
      </form>
      {!list.length && <p className="meet-empty">No questions yet. Ask the first; everyone can vote for the ones they want answered.</p>}
      <ol className="wb-qlist">
        {list.map((q) => (
          <li key={q.id} className={`wb-q${q.pinned ? ' pinned' : ''}${q.onStage ? ' staged' : ''}${q.own ? ' own' : ''}`}>
            <button className={`wb-vote${q.voted ? ' on' : ''}`} aria-pressed={!!q.voted} aria-label={`${q.voted ? 'Take back your vote' : 'Vote'}: ${q.text}`} onClick={() => vote(q)}>▲<b className="mono">{q.votes}</b></button>
            <div className="wb-q-body">
              <p className="wb-q-text selectable">{q.text}</p>
              <p className="wb-q-meta mono">{[q.own ? 'YOU' : q.anonymous ? 'ANONYMOUS' : capName(q.author || '?'), clock(q.at), q.pinned ? 'PINNED' : '', q.onStage ? 'ON STAGE' : ''].filter(Boolean).join(' · ')}</p>
              {q.status === 'live' && <p className="wb-q-tag mono">ANSWERED LIVE</p>}
              {q.status === 'answered' && q.answer && <p className="wb-q-answer"><b className="mono">{capName(q.answer.by)} · </b>{q.answer.text}</p>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Poll({ w, poll }: { w: Watching; poll: WebinarPoll | null }) {
  const toast = useToast();
  const mine = poll ? w.myVotes.get(poll.id) ?? [] : [];
  const [chosen, setChosen] = useState<number[]>(mine);
  useEffect(() => { setChosen(poll ? w.myVotes.get(poll.id) ?? [] : []); }, [poll?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!poll) return <p className="meet-empty">No poll right now. When the organiser asks one, it shows here.</p>;
  const total = poll.results ? poll.results.reduce((a, b) => a + b, 0) : 0;
  const send = () => void window.dex.request('web.poll.vote', { id: w.meetingId, pollId: poll.id, choices: chosen }).then(() => {
    patchWatching({ myVotes: new Map(w.myVotes).set(poll.id, chosen) });
    toast('Your answer is in');
  }).catch((e: Error) => toast(e.message, true));
  return (
    <form className="wb-vpoll" onSubmit={(e) => { e.preventDefault(); send(); }}>
      <span className="label">{poll.open ? 'Poll · open' : 'Poll · closed'}</span>
      <h3>{poll.question}</h3>
      {poll.options.map((o, i) => {
        const share = poll.results && total ? Math.round((poll.results[i] / total) * 100) : null;
        return (
          <label key={i} className="wb-opt">
            <input type={poll.multi ? 'checkbox' : 'radio'} name="wb-opt" disabled={!poll.open} checked={chosen.includes(i)}
              onChange={(e) => setChosen(poll.multi ? (e.target.checked ? [...chosen, i] : chosen.filter((x) => x !== i)) : [i])} />
            <span>{o}</span>
            {share !== null && <i className="wb-opt-bar" style={{ width: `${share}%` }} />}
            {share !== null && <b className="mono">{share}%</b>}
          </label>
        );
      })}
      <div className="wb-row-actions">
        <span className="faint">{poll.results ? `${poll.voters} answered` : mine.length ? 'Your answer is in. Change it while the poll is open.' : poll.multi ? 'Choose any that apply.' : 'Choose one.'}</span>
        {poll.open && <button className="btn sm primary" disabled={!chosen.length}>{mine.length ? 'Change answer' : 'Answer'}</button>}
      </div>
    </form>
  );
}

function Handouts({ w, list }: { w: Watching; list: Handout[] }) {
  const toast = useToast();
  if (!list.length) return <p className="meet-empty">No handouts yet. Files the organiser shares for the webinar show here.</p>;
  const get = (h: Handout) => void window.dex.request('web.handout.open', { id: w.meetingId, handoutId: h.id }).then(async (r) => {
    if (window.dex.saveFile) { const where = await window.dex.saveFile(r.fileId, r.name); toast(where ? `Saved ${r.name}` : `${r.name} is downloading`); }
    else if (window.dex.openFile) await window.dex.openFile(r.fileId, r.name);
  }).catch((e: Error) => toast(e.message, true));
  return (
    <ul className="wb-hlist">
      {list.map((h) => (
        <li key={h.id}>
          <Icon name="doc" size={16} /><span className="wb-hname"><b>{h.name}</b><span className="mono faint">{sizeText(h.size)}</span></span>
          <button className="btn sm" onClick={() => get(h)}><Icon name="download" size={14} />Download</button>
        </li>
      ))}
    </ul>
  );
}
