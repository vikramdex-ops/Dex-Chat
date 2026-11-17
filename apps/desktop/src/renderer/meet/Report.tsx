// A meeting's report, opened from Recent meetings on the Meet lens: who came, when and for how
// long (rejoins summed), shown as an attendance schedule with a bar along the meeting's time for
// each person; hands, reactions, the polls asked and their results, the recordings; and a CSV of
// it all for Excel or Dexterity Sheets. A webinar's report adds its own part: registrants marked
// attended or no-show, the audience, questions, poll answers, handout downloads and the survey.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatMeetingId } from '@dex/core';
import type { MeetingReport, RecordingInfo, WebinarReport } from '@dex/core';
import { reportCsv } from '@dex/core/meet-csv';
import { Icon, colorFor, useToast } from '../ui.tsx';
import { hm } from '../calendar/store.ts';
import { saveText } from './GuestLink.tsx';
import { hms } from './Recordings.tsx';

const mins = (ms: number) => { const m = Math.round(ms / 60_000); return m < 1 ? '< 1 min' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`; };

export function MeetingReportSheet({ roomId, onClose, onWatch }: { roomId: string; onClose: () => void; onWatch: (r: RecordingInfo) => void }) {
  const toast = useToast();
  const [r, setR] = useState<MeetingReport | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => { void window.dex.request('meet.report', { roomId }).then(setR).catch((e: Error) => setProblem(e.message)); }, [roomId]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const exportCsv = () => {
    if (!r) return;
    const day = new Date(r.startedAt).toISOString().slice(0, 10);
    saveText(`Meeting report ${(r.title || 'meeting').replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 60)} ${day}.csv`, reportCsv(r), 'text/csv;charset=utf-8');
    toast('Report saved as CSV');
  };
  const end = r ? (r.endedAt ?? Date.now()) : 0;
  const span = r ? Math.max(1, end - r.startedAt) : 1;
  const reactionTotal = r ? Object.values(r.reactions).reduce((a, b) => a + b, 0) : 0;
  return createPortal(
    <div className="rec-viewer report-viewer" role="dialog" aria-label="Meeting report">
      <div className="rep-sheet">
        {!r && !problem && <div className="tl-more"><span className="spinner" /></div>}
        {problem && <div className="rep-problem"><p>{problem}</p><button className="btn" onClick={onClose}>Close</button></div>}
        {r && (
          <>
            <section className="rep-body">
              <div className="tb-head"><span className="label">Attendance · rejoins summed</span><span className="mono">{r.people.length === 1 ? '1 PERSON' : `${r.people.length} PEOPLE`} · PEAK {r.peak}</span></div>
              <table className="rep-table">
                <thead><tr><th>Name</th><th>First in</th><th>Last out</th><th className="num">Time</th><th className="num">Visits</th><th className="num">Hands</th><th className="num">Reactions</th><th className="rep-axis"><span>{hm(r.startedAt)}</span><span>{hm(end)}</span></th></tr></thead>
                <tbody>
                  {r.people.map((p) => (
                    <tr key={p.userId}>
                      <td><b>{p.name}</b>{p.guest && <span className="role-tag">GUEST</span>}{p.userId === r.hostId && <span className="role-tag">HOST</span>}</td>
                      <td className="mono">{hm(p.firstJoin)}</td>
                      <td className="mono">{hm(p.lastLeave)}</td>
                      <td className="mono num">{mins(p.totalMs)}</td>
                      <td className="mono num">{p.joins}</td>
                      <td className="mono num">{p.hands || '·'}</td>
                      <td className="mono num">{p.reactions || '·'}</td>
                      <td className="rep-bar-cell" aria-label={`In the meeting for ${mins(p.totalMs)}`}>
                        <span className="rep-bar" style={{ left: `${((p.firstJoin - r.startedAt) / span) * 100}%`, width: `${Math.max(1, ((p.lastLeave - p.firstJoin) / span) * 100)}%`, ['--tint' as string]: colorFor(p.userId) }} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="rep-grid">
                <section>
                  <div className="tb-head"><span className="label">Hands and reactions</span><span className="mono">{r.hands} · {reactionTotal}</span></div>
                  <p className="rep-line"><b className="mono">{r.hands}</b> {r.hands === 1 ? 'hand raised' : 'hands raised'}</p>
                  <div className="rep-reacts">{Object.entries(r.reactions).sort((a, b) => b[1] - a[1]).map(([e, n]) => <span key={e} className="rep-react"><b>{e}</b><span className="mono">{n}</span></span>)}{!reactionTotal && <span className="faint">No reactions.</span>}</div>
                </section>
                <section>
                  <div className="tb-head"><span className="label">Polls</span><span className="mono">{r.polls.length}</span></div>
                  {!r.polls.length && <p className="faint">No polls were asked during the meeting.</p>}
                  {r.polls.map((p, i) => {
                    const most = Math.max(1, ...p.options.map((o) => o.votes));
                    return (
                      <div key={i} className="rep-poll">
                        <p><b>{p.question}</b> <span className="faint mono">{p.voters} VOTED</span></p>
                        {p.options.map((o) => <div key={o.text} className="rep-opt"><span>{o.text}</span><span className="rec-bar"><i style={{ width: `${(o.votes / most) * 100}%` }} /></span><span className="mono">{o.votes}</span></div>)}
                      </div>
                    );
                  })}
                </section>
                <section>
                  <div className="tb-head"><span className="label">Recordings</span><span className="mono">{r.recordings.length}</span></div>
                  {!r.recordings.length && <p className="faint">No recordings you can watch.</p>}
                  {r.recordings.map((x) => <p key={x.id} className="rep-line"><button className="tb-link" onClick={() => onWatch(x)}><Icon name="play" size={13} />{x.title}</button><span className="faint"> <span className="mono">{hms(x.durationMs)}</span> · <span translate="no">{x.recordedByName}</span></span></p>)}
                  {r.breakouts > 0 && <p className="rep-line faint">{r.breakouts === 1 ? '1 breakout room was used.' : `${r.breakouts} breakout rooms were used.`}</p>}
                </section>
              </div>
              {r.webinar && <WebinarPart w={r.webinar} />}
            </section>
            <footer className="rec-block">
              <div className="tb-name"><span className="label">Meeting report</span><h2 title={r.title}>{r.title || 'Meeting'}</h2></div>
              <dl className="rec-cells">
                <div><dt className="label">Date</dt><dd className="mono">{new Date(r.startedAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }).toUpperCase()}</dd></div>
                <div><dt className="label">Time</dt><dd className="mono">{hm(r.startedAt)} – {r.endedAt ? hm(r.endedAt) : 'NOW'}</dd></div>
                <div><dt className="label">Length</dt><dd className="mono">{mins(r.durationMs)}</dd></div>
                <div><dt className="label">ID</dt><dd className="mono">{r.meetingId ? formatMeetingId(r.meetingId) : '—'}</dd></div>
              </dl>
              <div className="rec-actions">
                <button className="btn sm" onClick={exportCsv}><Icon name="download" size={14} />Export CSV</button>
                <button className="btn sm primary" onClick={onClose}>Close</button>
              </div>
            </footer>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** The webinar's part of a meeting's report. */
function WebinarPart({ w }: { w: WebinarReport }) {
  const approved = w.registrants.filter((x) => x.status === 'approved');
  const came = approved.filter((x) => x.attended);
  const downloads = w.handouts.reduce((a, h) => a + h.downloads.length, 0);
  return (
    <section className="rep-webinar">
      <div className="tb-head"><span className="label">Webinar · registrants and audience</span><span className="mono">{came.length} OF {approved.length} ATTENDED · PEAK {w.peakAudience}</span></div>
      <table className="rep-table">
        <thead><tr><th>Registrant</th><th>Email</th><th>Status</th><th>Attended</th><th className="num">Minutes</th></tr></thead>
        <tbody>
          {w.registrants.map((x) => (
            <tr key={x.id}><td><b>{x.name}</b></td><td className="mono">{x.email}</td><td className="mono">{x.status.toUpperCase()}</td>
              <td className="mono">{x.attended === null ? '—' : x.attended ? 'ATTENDED' : 'NO-SHOW'}</td><td className="mono num">{x.minutes || '·'}</td></tr>
          ))}
          {!w.registrants.length && <tr><td colSpan={5} className="faint">No one registered from outside the office.</td></tr>}
        </tbody>
      </table>
      <p className="rep-line"><b className="mono">{w.attendees.length}</b> watched ({w.attendees.filter((a) => a.office).length} from the office) · <b className="mono">{w.questions.length}</b> questions · <b className="mono">{w.polls.reduce((a, p) => a + p.voters, 0)}</b> poll answers · <b className="mono">{downloads}</b> handout downloads · <b className="mono">{w.survey.answers.length}</b> survey answers</p>
    </section>
  );
}
