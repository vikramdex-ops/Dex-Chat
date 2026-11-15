// Recordings kept on the hub: the shelf on the Meet lens (a register of recordings: title, date,
// length, who recorded it, size) and the viewer, which plays a recording beside its chapters (who
// spoke when, as a schedule and as a strip under the video). The recorder and administrators
// share it with the meeting's conversation or by a link for anyone in the office, and delete it.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { parseRecordingLink } from '@dex/core';
import type { RecordingInfo } from '@dex/core';
import { Icon, Toggle, colorFor, useToast } from '../ui.tsx';
import { confirmAction } from '../confirm.tsx';
import { Glyph } from '../rooms/parts.tsx';
import { capName } from '../rooms/engine.ts';
import { formatSize, useFileSrc } from '../chat/files.tsx';
import { useLive } from './live.ts';

const pad = (n: number) => String(n).padStart(2, '0');
export function hms(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  return h ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}
const dateOf = (t: number) => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }).toUpperCase();

/** The shelf: every recording this person may watch, newest first. */
export function RecordingShelf({ onOpen }: { onOpen: (r: RecordingInfo) => void }) {
  const version = useLive((s) => s.recordings);
  const [list, setList] = useState<RecordingInfo[] | null>(null);
  const [link, setLink] = useState('');
  const toast = useToast();
  useEffect(() => { void window.dex.request('rec.list', { limit: 50 }).then(setList).catch(() => setList([])); }, [version]);
  const token = parseRecordingLink(link);
  return (
    <section className="meet-block meet-recordings" aria-label="Recordings">
      <div className="meet-block-head"><span className="label">Recordings</span><span className="mono">{list ? `${list.length} ON THE HUB` : 'SHELF'}</span></div>
      {list === null && <div className="tl-more"><span className="spinner" /></div>}
      {list?.length === 0 && <p className="meet-empty">Recordings you make in a Room are kept here, with chapters for who spoke when. So are the ones people share with you.</p>}
      {list && list.length > 0 && (
        <table className="rec-shelf">
          <thead><tr><th>Recording</th><th>Date</th><th className="num">Length</th><th>By</th><th className="num">Size</th><th /></tr></thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id} className={r.status === 'uploading' ? 'uploading' : undefined}>
                <td className="rec-title"><b title={r.title}>{r.title}</b>
                  <span className="faint">{r.status === 'uploading' ? `Uploading · ${Math.floor((r.received / Math.max(1, r.size)) * 100)}%` : (
                  <span>{r.chapters.length === 0 ? 'No chapters' : r.chapters.length === 1 ? '1 chapter' : `${r.chapters.length} chapters`}{r.sharedWithConv ? ' · shared with the conversation' : ''}{r.linkOn ? ' · link on' : ''}</span>
                )}</span></td>
                <td className="mono">{dateOf(r.startedAt)}</td>
                <td className="mono num">{hms(r.durationMs)}</td>
                <td>{capName(r.recordedByName)}</td>
                <td className="mono num">{formatSize(r.size)}</td>
                <td className="act"><button className="btn sm" disabled={r.status !== 'ready'} onClick={() => onOpen(r)}><Icon name="play" size={13} />Watch</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form className="meet-block-foot rec-open-link" onSubmit={(e) => { e.preventDefault(); if (!token) return; void window.dex.request('rec.get', { token }).then((r) => { setLink(''); onOpen(r); }).catch((err: Error) => toast(err.message, true)); }}>
        <input className="input mono" placeholder="dexconnect://recording/…" aria-label="A recording link someone shared" value={link} onChange={(e) => setLink(e.target.value)} />
        <button className="btn sm" disabled={!token}>Open link</button>
      </form>
    </section>
  );
}

/** Chapters as spans: each runs until the next starts (the last until the end). */
function spans(r: RecordingInfo): Array<{ at: number; end: number; userId: string; name: string }> {
  return r.chapters.map((c, i) => ({ ...c, end: r.chapters[i + 1]?.at ?? r.durationMs }));
}

/** The viewer: the video, its chapters, and (for the recorder) sharing. */
export function RecordingPlayer({ rec: initial, onClose }: { rec: RecordingInfo; onClose: () => void }) {
  const toast = useToast();
  const [rec, setRec] = useState(initial);
  const [time, setTime] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const src = useFileSrc({ id: rec.fileId ?? '', name: `${rec.title}.webm` });
  const parts = useMemo(() => spans(rec), [rec]);
  const current = parts.findIndex((c) => time * 1000 >= c.at && time * 1000 < c.end);
  const people = useMemo(() => {
    const m = new Map<string, { name: string; ms: number }>();
    for (const c of parts) { const x = m.get(c.userId) ?? { name: c.name, ms: 0 }; x.ms += c.end - c.at; m.set(c.userId, x); }
    return [...m.entries()].sort((a, b) => b[1].ms - a[1].ms);
  }, [parts]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const seek = (ms: number) => { const v = video.current; if (v) { v.currentTime = ms / 1000; void v.play().catch(() => {}); } };
  const share = (patch: { conv?: boolean; link?: boolean }) => void window.dex.request('rec.share', { id: rec.id, ...patch }).then((r) => {
    setRec(r);
    if (patch.link && r.link) void navigator.clipboard.writeText(r.link).then(() => toast('Link copied: anyone in the office can watch it'));
  }).catch((e: Error) => toast(e.message, true));
  const remove = async () => {
    if (!(await confirmAction({ title: `Delete "${rec.title}"?`, body: 'It is removed from the hub, and nobody can watch it after this, even with a link.', confirm: 'Delete recording', danger: true }))) return;
    void window.dex.request('rec.delete', { id: rec.id }).then(() => { toast('Recording deleted'); onClose(); }).catch((e: Error) => toast(e.message, true));
  };
  const total = Math.max(1, rec.durationMs);
  return createPortal(
    <div className="rec-viewer" role="dialog" aria-label={`Recording: ${rec.title}`}>
      <div className="rec-sheet">
        <section className="rec-stage">
          {src ? <video ref={video} src={src.startsWith('dexfile:') ? `${src}?as=video` : src} controls preload="metadata" onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)} />
            : <div className="tl-more"><span className="spinner" /></div>}
          <div className="rec-strip" role="group" aria-label="Who spoke when">
            {parts.map((c, i) => (
              <button key={i} className={i === current ? 'on' : undefined} style={{ left: `${(c.at / total) * 100}%`, width: `${Math.max(0.4, ((c.end - c.at) / total) * 100)}%`, ['--tint' as string]: colorFor(c.userId) }}
                title={`${hms(c.at)} · ${c.name}`} aria-label={`${c.name} from ${hms(c.at)}`} onClick={() => seek(c.at)} />
            ))}
            <i className="rec-head" style={{ left: `${Math.min(100, ((time * 1000) / total) * 100)}%` }} />
          </div>
          <div className="rec-scale mono" aria-hidden="true">{[0, 0.25, 0.5, 0.75, 1].map((f) => <span key={f} style={{ left: `${f * 100}%` }}>{hms(rec.durationMs * f)}</span>)}</div>
        </section>
        <aside className="rec-side">
          <div className="tb-head"><span className="label">Chapters · who spoke when</span><span className="mono">{parts.length}</span></div>
          {!parts.length && <p className="meet-empty">Nobody spoke long enough to make a chapter.</p>}
          <ol className="rec-chapters">
            {parts.map((c, i) => (
              <li key={i} className={i === current ? 'on' : undefined}>
                <button onClick={() => seek(c.at)}>
                  <span className="mono rec-at">{hms(c.at)}</span>
                  <span className="rec-swatch" style={{ background: colorFor(c.userId) }} />
                  <span className="rec-who">{c.name}</span>
                  <span className="mono faint">{hms(c.end - c.at)}</span>
                </button>
              </li>
            ))}
          </ol>
          {people.length > 0 && (
            <div className="rec-totals">
              <div className="tb-head"><span className="label">Talking time</span></div>
              {people.map(([id, p]) => (
                <div key={id} className="rec-total"><span>{p.name}</span><span className="rec-bar"><i style={{ width: `${(p.ms / total) * 100}%`, background: colorFor(id) }} /></span><span className="mono">{hms(p.ms)}</span></div>
              ))}
            </div>
          )}
          {rec.canManage && (
            <div className="rec-share">
              <div className="tb-head"><span className="label">Who can watch</span><span className="mono">{rec.sharedWithConv || rec.linkOn ? 'SHARED' : 'ONLY YOU'}</span></div>
              {rec.convId && (
                <div className="guest-row"><div className="txt"><div>The meeting's conversation</div><div className="faint">Its members see it on their shelf.</div></div>
                  <Toggle label="Share with the meeting's conversation" checked={rec.sharedWithConv} onChange={(on) => share({ conv: on })} /></div>
              )}
              <div className="guest-row"><div className="txt"><div>Anyone in the office with the link</div><div className="faint">Not guests. Turning it off stops the link.</div></div>
                <Toggle label="Anyone in the office with the link" checked={rec.linkOn} onChange={(on) => share({ link: on })} /></div>
              {rec.linkOn && rec.link && <button className="tb-link" onClick={() => void navigator.clipboard.writeText(rec.link!).then(() => toast('Link copied'))}><Glyph name="copy" size={13} />Copy link</button>}
            </div>
          )}
        </aside>
        <footer className="rec-block">
          <div className="tb-name"><span className="label">Recording</span><h2 title={rec.title}>{rec.title}</h2></div>
          <dl className="rec-cells">
            <div><dt className="label">Date</dt><dd className="mono">{dateOf(rec.startedAt)}</dd></div>
            <div><dt className="label">Length</dt><dd className="mono">{hms(rec.durationMs)}</dd></div>
            <div><dt className="label">Recorded by</dt><dd>{rec.recordedByName}</dd></div>
            <div><dt className="label">Size</dt><dd className="mono">{formatSize(rec.size)}</dd></div>
            <div><dt className="label">Kept until</dt><dd className="mono">{rec.expiresAt ? dateOf(rec.expiresAt) : 'KEPT'}</dd></div>
          </dl>
          <div className="rec-actions">
            {window.dex.saveFile && rec.fileId && <button className="btn sm" onClick={() => void window.dex.saveFile!(rec.fileId!, `${rec.title}.webm`).then(() => toast('Saved to Downloads')).catch((e: Error) => toast(e.message, true))}><Icon name="download" size={14} />Download</button>}
            {rec.canManage && <button className="btn sm ghost danger" onClick={remove}><Icon name="trash" size={14} />Delete</button>}
            <button className="btn sm primary" onClick={onClose}>Close</button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
