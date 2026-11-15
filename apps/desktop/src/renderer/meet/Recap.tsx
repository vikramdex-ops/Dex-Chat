// The recap sheet: one occurrence of a meeting gathered afterwards, drawn as a drawing's title
// block and register: attendance, the recording with chapters, action points, decisions, files,
// polls, notes and boards, the agenda, and the chat (collapsed, searchable, paged). Copy recap and
// Send by email (an .eml draft with only the parts chosen). Loaded only when opened. For a thread
// that is an end-to-end encrypted Direct conversation the hub cannot read the members' messages:
// the chat part is read and decrypted here, from the thread itself.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { RECAP_PARTS_ALL, RECAP_PARTS_GUESTS, occurrenceNo, recapEmail, recapText } from '@dex/core';
import type { MeetRecap, Message, PublicUser, RecapLine, RecapParts, RecordingInfo } from '@dex/core';
import { Avatar, Icon, useToast } from '../ui.tsx';
import { ApStrip } from './actions.tsx';
import { minutesText } from './threadcards.tsx';
import { emailDraft } from './GuestLink.tsx';
import { RecordingPlayer, hms } from './Recordings.tsx';
import './recap.css';

const two = (n: number) => String(n).padStart(2, '0');
const hm = (t: number) => { const d = new Date(t); return `${two(d.getHours())}:${two(d.getMinutes())}`; };
const dateLong = (t: number) => new Date(t).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const mins = (ms: number) => minutesText(Math.max(0, Math.round(ms / 60_000)));
const size = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

const PART_LABELS: Array<[keyof RecapParts, string]> = [
  ['attendance', 'Attendance'], ['actions', 'Action points'], ['decisions', 'Decisions'], ['files', 'Files'], ['polls', 'Polls'], ['recording', 'Recording'], ['chat', 'Chat'],
];

export default function RecapSheet({ occurrenceId, users, meId, onClose, jump }: { occurrenceId: string; users: Map<string, PublicUser>; meId: string; onClose: () => void; jump: (convId: string, messageId?: string) => void }) {
  const toast = useToast();
  const [r, setR] = useState<MeetRecap | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [mailing, setMailing] = useState(false);
  const [playing, setPlaying] = useState<RecordingInfo | null>(null);
  const box = useRef<HTMLElement>(null);
  const load = () => void window.dex.request('meet.recap', { occurrenceId }).then(setR).catch((e: Error) => setProblem(e.message));
  useEffect(load, [occurrenceId]); // eslint-disable-line react-hooks/exhaustive-deps
  // action points ticked elsewhere change here too
  useEffect(() => window.dex.onHubEvent((name, data) => {
    if (name === 'ap.updated') setR((x) => (x && x.actions.some((a) => a.id === (data as { id: string }).id) ? { ...x, actions: x.actions.map((a) => (a.id === (data as { id: string }).id ? { ...(data as typeof a), carried: a.carried } : a)).filter((a) => a.status !== 'dropped') } : x));
  }), []);
  useEffect(() => {
    box.current?.focus();
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !playing && !document.querySelector('.scrim')) onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose, playing]);
  const nameOf = (id: string) => (id === meId ? 'You' : users.get(id)?.displayName ?? r?.attendance.find((p) => p.userId === id)?.name ?? 'Someone');

  const o = r?.occurrence;
  const copy = () => { if (r) void navigator.clipboard.writeText(recapText(r, RECAP_PARTS_ALL, (id) => users.get(id)?.displayName ?? 'Someone')).then(() => toast('Recap copied')); };
  const done = r ? r.actions.filter((a) => a.status === 'done').length : 0;

  return createPortal(
    <div className="recap-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section ref={box} tabIndex={-1} className="recap-sheet" role="dialog" aria-modal="true" aria-label={o ? `Recap: ${o.title}` : 'Meeting recap'}>
        {!r && !problem && <div className="tl-more"><span className="spinner" /></div>}
        {problem && <div className="recap-empty"><p>{problem}</p><button className="btn" onClick={onClose}>Close</button></div>}
        {r && o && (
          <>
            <header className="recap-tb">
              <div className="tb-cell tb-title">
                <span className="cap mono">MEETING RECAP</span>
                <h2 translate="no">{o.title}</h2>
                {o.state === 'live' && <span className="tag live mono">IN PROGRESS</span>}
              </div>
              <div className="tb-cell"><span className="cap mono">DATE</span><span>{dateLong(o.startedAt)}</span></div>
              <div className="tb-cell"><span className="cap mono">TIME</span><span className="mono">{hm(o.startedAt)}–{o.endedAt ? hm(o.endedAt) : '··:··'}</span></div>
              <div className="tb-cell"><span className="cap mono">DURATION</span><span>{mins((o.endedAt ?? Date.now()) - o.startedAt)}</span></div>
              <div className="tb-cell"><span className="cap mono">ORGANISER</span><span translate="no">{nameOf(o.hostId)}</span></div>
              <div className="tb-cell"><span className="cap mono">NOTE-TAKER</span><span translate="no">{o.noteTakerId ? nameOf(o.noteTakerId) : '—'}</span></div>
              <div className="tb-cell tb-no"><span className="cap mono">DRG NO</span><span className="mono">{occurrenceNo(o)}</span></div>
              <div className="tb-actions">
                <button className="btn sm" onClick={copy}><Icon name="copy" size={14} />Copy recap</button>
                {r.viewer.organiser || r.viewer.member ? <button className="btn sm" aria-expanded={mailing} onClick={() => setMailing(!mailing)}><Icon name="send" size={14} />Send by email</button> : null}
                {r.viewer.member && <button className="btn sm" onClick={() => jump(o.convId)}><Icon name="chat" size={14} />Open the thread</button>}
                <button className="icon-btn" onClick={onClose} aria-label="Close the recap" title="Close (Esc)"><Icon name="x" size={16} /></button>
              </div>
            </header>
            {mailing && <MailPanel r={r} users={users} onDone={() => setMailing(false)} />}
            <div className="recap-body">
              {!r.viewer.member && <p className="recap-note"><Icon name="lock" size={13} />You attended this meeting from outside its conversation, so this recap shows what you could see in it.</p>}

              <Section no="01" title="Attendance" meta={`${r.attendance.length} attended${r.absent.length ? ` · ${r.absent.length} invited, not there` : ''}`}>
                <table className="recap-table">
                  <thead><tr><th>Name</th><th>In the meeting</th><th className="mono">IN</th><th className="mono">OUT</th></tr></thead>
                  <tbody>
                    {r.attendance.map((p) => (
                      <tr key={p.userId}>
                        <td><span className="rt-who"><Avatar user={{ id: p.userId, displayName: p.name }} size="sm" /><span translate="no">{p.userId === meId ? 'You' : p.name}</span>{p.guest && <span className="tag mono">GUEST</span>}</span></td>
                        <td>{mins(p.totalMs)}{p.joins > 1 && <span className="faint"> · {p.joins} times</span>}</td>
                        <td className="mono">{hm(p.firstJoin)}</td><td className="mono">{hm(p.lastLeave)}</td>
                      </tr>
                    ))}
                    {r.absent.map((u) => <tr key={u} className="absent"><td><span className="rt-who"><Avatar user={{ id: u, displayName: nameOf(u) }} size="sm" /><span translate="no">{nameOf(u)}</span><span className="tag mono">ABSENT</span></span></td><td className="faint">Invited, not there</td><td /><td /></tr>)}
                  </tbody>
                </table>
              </Section>

              <Section no="02" title="Recording" meta={r.recordings.length ? `${r.recordings.length}` : ''}>
                {!r.recordings.length && <p className="faint">Not recorded, or not shared with you.</p>}
                {r.recordings.map((rec) => (
                  <div key={rec.id} className="recap-rec">
                    <button className="btn sm" disabled={rec.status !== 'ready'} onClick={() => setPlaying(rec)}><Icon name="play" size={14} />{rec.status === 'ready' ? 'Watch' : 'Still uploading'}</button>
                    <span translate="no">{rec.title}</span><span className="mono faint">{hms(rec.durationMs)}</span>
                    {rec.chapters.length > 0 && (
                      <ol className="recap-chapters">
                        {rec.chapters.map((c, i) => <li key={i}><span className="mono">{hms(c.at)}</span><span translate="no">{c.name}</span></li>)}
                      </ol>
                    )}
                  </div>
                ))}
              </Section>

              <Section no="03" title="Action points" meta={r.actions.length ? `${done} of ${r.actions.length} done` : ''}>
                {r.actions.length > 0 && <Progress done={done} total={r.actions.length} />}
                {!r.actions.length && <p className="faint">No action points were logged.</p>}
                <div className="recap-aps">
                  {r.actions.map((a) => (
                    <div key={a.id} className="recap-ap">
                      <div className="recap-ap-text" translate="no">{a.text || <span className="faint"><Icon name="lock" size={12} /> End-to-end encrypted: open it in the thread</span>}</div>
                      <ApStrip ap={a} users={users} meId={meId} compact />
                      {r.viewer.member && <button className="link sm" onClick={() => jump(a.convId, a.messageId)}>In the thread</button>}
                    </div>
                  ))}
                </div>
              </Section>

              <Section no="04" title="Decisions" meta={r.decisions.length ? `${r.decisions.length}` : ''}>
                {!r.decisions.length && <p className="faint">No decisions were taken here.</p>}
                {r.decisions.map((d) => (
                  <div key={d.messageId} className="recap-decision">
                    <Icon name="decision" size={15} /><b translate="no">{d.question}</b>
                    <span className="faint">{d.outcomes.length ? d.outcomes.map((x) => `${x.label} (${x.count})`).join(' · ') : 'Nobody has answered yet'}</span>
                    <button className="link sm" onClick={() => jump(o.convId, d.messageId)}>Open</button>
                  </div>
                ))}
              </Section>

              <Section no="05" title="Files" meta={r.files.length ? `${r.files.length + r.filesMore}` : ''}>
                {!r.files.length && <p className="faint">No files were shared while it ran.</p>}
                <ul className="recap-files">
                  {r.files.map((f) => (
                    <li key={`${f.messageId}-${f.file.id}`}>
                      <Icon name="paperclip" size={14} /><span className="rf-name" translate="no">{f.file.name}</span>
                      <span className="mono faint">{size(f.file.size)}</span><span className="faint" translate="no">{f.authorName}</span><span className="mono faint">{hm(f.at)}</span>
                      {r.viewer.member && <button className="link sm" onClick={() => jump(o.convId, f.messageId)}>Its message</button>}
                    </li>
                  ))}
                </ul>
                {r.filesMore > 0 && <p className="faint">And {r.filesMore} more in the thread.</p>}
              </Section>

              {r.viewer.member && (
                <Section no="06" title="Polls" meta={r.polls.length ? `${r.polls.length}` : ''}>
                  {!r.polls.length && <p className="faint">No polls.</p>}
                  {r.polls.map((p) => {
                    const top = Math.max(1, ...p.options.map((x) => x.votes));
                    return (
                      <div key={p.messageId} className="recap-poll">
                        <b translate="no">{p.question}</b><span className="mono faint">{p.voters} voted</span>
                        {p.options.map((x, i) => <div key={i} className="rp-row"><span translate="no">{x.text}</span><span className="rp-bar"><i style={{ width: `${(x.votes / top) * 100}%` }} /></span><span className="mono">{x.votes}</span></div>)}
                      </div>
                    );
                  })}
                </Section>
              )}

              {r.viewer.member && (
                <Section no="07" title="Notes and boards" meta={r.notes.length ? `${r.notes.length}` : ''}>
                  {!r.notes.length && <p className="faint">No notes or whiteboards changed during it.</p>}
                  <ul className="recap-files">
                    {r.notes.map((n) => <li key={n.id}><Icon name={n.kind === 'note' ? 'doc' : 'drawing'} size={14} /><span className="rf-name" translate="no">{n.title}</span><span className="mono faint">{n.kind === 'note' ? 'NOTE' : 'BOARD'} · {hm(n.updatedAt)}</span><button className="link sm" onClick={() => jump(o.convId)}>Open</button></li>)}
                  </ul>
                </Section>
              )}

              {r.agenda.length > 0 && (
                <Section no="08" title="Agenda" meta={`${r.agenda.filter((a) => a.doneAt).length} of ${r.agenda.length} covered`}>
                  <ol className="recap-agenda">
                    {r.agenda.map((a) => <li key={a.id} className={a.doneAt ? 'done' : ''}><span className="mono">{two(a.n)}</span><span translate="no">{a.text}</span>{a.minutes && <span className="mono faint">{a.minutes} MIN</span>}<span className="mono">{a.doneAt ? 'COVERED' : 'NOT REACHED'}</span></li>)}
                  </ol>
                </Section>
              )}

              <Section no="09" title="Chat" meta={`${r.chat.total} messages`}>
                <RecapChat r={r} users={users} meId={meId} jump={jump} />
              </Section>
            </div>
          </>
        )}
      </section>
      {playing && <RecordingPlayer rec={playing} onClose={() => setPlaying(null)} />}
    </div>,
    document.body,
  );
}

function Section({ no, title, meta, children }: { no: string; title: string; meta?: string; children: React.ReactNode }) {
  return (
    <section className="recap-sec" aria-labelledby={`recap-${no}`}>
      <h3 id={`recap-${no}`} className="recap-label"><span className="mono">{no}</span>{title.toUpperCase()}{meta && <span className="mono faint">{meta}</span>}</h3>
      {children}
    </section>
  );
}

/** Progress as a dimension line: ticks at both ends, the done part in teal. */
function Progress({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="recap-dim" role="img" aria-label={`${done} of ${total} action points done`}>
      <span className="dim-line"><i style={{ width: `${pct}%` }} /></span>
      <span className="mono">{pct}%</span>
    </div>
  );
}

/** The chat said while it ran: collapsed until opened, searchable, a page at a time. */
function RecapChat({ r, users, meId, jump }: { r: MeetRecap; users: Map<string, PublicUser>; meId: string; jump: (convId: string, messageId?: string) => void }) {
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<RecapLine[]>(r.chat.lines);
  const [next, setNext] = useState(r.chat.next);
  const [q, setQ] = useState('');
  const [sealedLines, setSealed] = useState<RecapLine[] | null>(null);
  const o = r.occurrence;
  // a search asks the hub again (the whole chat, not just the page shown)
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      if (!q.trim()) { setLines(r.chat.lines); setNext(r.chat.next); return; }
      void window.dex.request('meet.recapChat', { occurrenceId: o.id, after: '', q }).then((p) => { setLines(p.lines); setNext(p.next); }).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [q, open]); // eslint-disable-line react-hooks/exhaustive-deps
  // an encrypted Direct thread: read (and decrypt) the members' messages of that time here
  useEffect(() => {
    if (!open || !r.chat.sealed || !r.viewer.member || sealedLines) return;
    void (async () => {
      const got: Message[] = [];
      let before: string | undefined;
      for (let i = 0; i < 10; i++) {
        const page = await window.dex.request('msg.list', { convId: o.convId, before, limit: 100 });
        got.push(...page.messages.filter((m) => m.createdAt >= r.chat.from && m.createdAt <= r.chat.to && !m.deleted && !m.meetCard && !m.meetLine));
        if (!page.hasMore || !page.messages.length || page.messages[0].createdAt < r.chat.from) break;
        before = page.messages[0].id;
      }
      setSealed(got.map((m) => ({ messageId: m.id, authorId: m.authorId, name: users.get(m.authorId)?.displayName ?? 'Someone', guest: false, text: m.e2e === 'locked' ? '' : m.body, at: m.createdAt, everyone: false, breakout: null, files: m.files.map((f) => f.name) })));
    })().catch(() => setSealed([]));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const all = useMemo(() => {
    const base = sealedLines ? [...lines.filter((l) => l.everyone), ...sealedLines] : lines;
    const shown = q.trim() && sealedLines ? base.filter((l) => `${l.name} ${l.text}`.toLowerCase().includes(q.trim().toLowerCase())) : base;
    return [...new Map(shown.map((l) => [l.messageId, l])).values()].sort((a, b) => a.at - b.at);
  }, [lines, sealedLines, q]);
  const more = () => { if (next) void window.dex.request('meet.recapChat', { occurrenceId: o.id, after: next, q }).then((p) => { setLines((l) => [...l, ...p.lines]); setNext(p.next); }); };
  return (
    <details className="recap-chat" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>{open ? 'Hide the chat' : `Show the chat (${r.chat.total})`}</summary>
      <input className="input sm" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the chat" aria-label="Search the meeting's chat" />
      {r.chat.sealed && <p className="faint small"><Icon name="lock" size={12} /> End-to-end encrypted: this PC reads the messages itself. The meeting chat with guests was never encrypted.</p>}
      <ol className="recap-lines" aria-live="polite">
        {all.map((l) => (
          <li key={l.messageId}>
            <span className="mono faint">{hm(l.at)}</span>
            <span className="rl-who" translate="no">{l.authorId === meId ? 'You' : l.name}</span>
            {l.guest && <span className="tag mono">GUEST</span>}
            {l.breakout && <span className="mono faint">{l.breakout.toUpperCase()}</span>}
            <span className="rl-text selectable" translate="no">{l.text}{l.files.length > 0 && <span className="faint"> <Icon name="paperclip" size={12} /> {l.files.join(', ')}</span>}</span>
            {r.viewer.member && <button className="link sm" aria-label="Open in the thread" title="Open in the thread" onClick={() => jump(o.convId, l.messageId)}><Icon name="open" size={12} /></button>}
          </li>
        ))}
        {!all.length && <li className="faint">{q ? 'Nothing matches.' : 'Nothing was said in the chat.'}</li>}
      </ol>
      {next && <button className="btn sm" onClick={more}>Show more</button>}
    </details>
  );
}

/** Send by email: the organiser picks what goes out (for guests, for example, only action points and files). */
function MailPanel({ r, users, onDone }: { r: MeetRecap; users: Map<string, PublicUser>; onDone: () => void }) {
  const toast = useToast();
  const [parts, setParts] = useState<RecapParts>(RECAP_PARTS_ALL);
  const [to, setTo] = useState('');
  const send = () => {
    const m = recapEmail(r, parts, (id) => users.get(id)?.displayName ?? r.attendance.find((p) => p.userId === id)?.name ?? 'Someone');
    const list = to.split(/[,;\s]+/).map((x) => x.trim()).filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)).map((email) => ({ email }));
    void emailDraft({ ...m, to: list, file: `Recap ${r.occurrence.title}`.replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80) }, toast).then(onDone);
  };
  return (
    <div className="recap-mail" role="group" aria-label="Send the recap by email">
      <div className="seg" role="group" aria-label="Who it is for">
        <button type="button" aria-pressed={JSON.stringify(parts) === JSON.stringify(RECAP_PARTS_ALL)} onClick={() => setParts(RECAP_PARTS_ALL)}>For colleagues</button>
        <button type="button" aria-pressed={JSON.stringify(parts) === JSON.stringify(RECAP_PARTS_GUESTS)} onClick={() => setParts(RECAP_PARTS_GUESTS)}>For guests</button>
      </div>
      <div className="recap-parts">
        {PART_LABELS.map(([k, label]) => (
          <label key={k} className="check"><input type="checkbox" checked={parts[k]} onChange={(e) => setParts({ ...parts, [k]: e.target.checked })} />{label}</label>
        ))}
      </div>
      <label className="field"><span className="label">To (email addresses, optional)</span><input className="input" value={to} onChange={(e) => setTo(e.target.value)} placeholder="rao@client.example, site@client.example" /></label>
      <div className="row-actions"><button className="btn ghost sm" onClick={onDone}>Cancel</button><button className="btn primary sm" onClick={send}><Icon name="send" size={14} />Open the email draft</button></div>
    </div>
  );
}

