// After a Room recording stops: it is kept on the hub straight away (uploaded in chunks, with its
// chapters), then the recorder chooses who sees it: the meeting's conversation, or anyone in the
// office with the link. It can also be saved on this PC. Too large for the office's limit, or
// with recording on the hub turned off, it stays on this PC until saved.
import { useEffect, useRef, useState } from 'react';
import { Dialog, Icon, useToast } from '../ui.tsx';
import { Glyph } from '../rooms/parts.tsx';
import { clearRecording, keepOnHub, resetUpload, useRecorder, useUpload } from '../rooms/recorder.ts';
import type { Recording } from '../rooms/recorder.ts';
import { usePolicy } from '../policy.ts';
import { confirmAction } from '../confirm.tsx';
import { formatSize } from '../chat/files.tsx';
import { openRecording } from './shelf.ts';
import './m2.css';

function lengthOf(ms: number): string {
  return ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`;
}

/** A progress bar drawn as a ruled scale: forty ticks, filled as the bytes arrive. */
export function RuledProgress({ value, label }: { value: number; label: string }) {
  const lit = Math.round(Math.max(0, Math.min(1, value)) * 40);
  return (
    <div className="ruled-progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
      {Array.from({ length: 40 }, (_, i) => <i key={i} className={`${i < lit ? 'on' : ''}${i % 10 === 9 ? ' major' : ''}`} />)}
    </div>
  );
}

export function RecordingReady() {
  const r = useRecorder();
  if (!r || r.recording || !r.done) return null;
  return <Done rec={r.done} />;
}

function Done({ rec }: { rec: Recording }) {
  const toast = useToast();
  const policy = usePolicy();
  const up = useUpload();
  const started = useRef(false);
  const [busy, setBusy] = useState(false);
  const limit = (policy.recordingMaxMb ?? 2048) * 1024 * 1024;
  const canKeep = policy.allowRecording && rec.blob.size <= limit;
  const stamp = new Date(rec.startedAt).toISOString().slice(0, 16).replace('T', ' ').replace(':', '');
  const name = `${rec.title || 'Room recording'} ${stamp}.webm`;
  const speakers = new Set(rec.chapters.map((c) => c.userId)).size;

  // kept on the hub as soon as it is ready
  useEffect(() => {
    if (started.current || !canKeep) return;
    started.current = true;
    resetUpload();
    void keepOnHub(rec).catch(() => {});
  }, [canKeep, rec]);

  const close = () => { clearRecording(); resetUpload(); };
  const save = () => {
    const url = URL.createObjectURL(rec.blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  const share = async (patch: { conv?: boolean; link?: boolean }) => {
    if (!up.info) return;
    setBusy(true);
    try {
      const info = await window.dex.request('rec.share', { id: up.info.id, ...patch });
      if (patch.link && info.link) { await navigator.clipboard.writeText(info.link); toast('Link copied: anyone in the office can watch it'); }
      else if (patch.conv) toast('Shared with the meeting\'s conversation');
    } catch (e) { toast((e as Error).message, true); }
    setBusy(false);
  };

  return (
    <Dialog title="Room recording ready" onClose={() => {
      // an upload carries on without the dialog: the recording lands on the shelf
      if (up.status === 'uploading') { clearRecording(); toast('It keeps uploading to the hub and will be on your Recordings shelf'); return; }
      if (up.status === 'done') { close(); return; }
      void confirmAction({ title: 'Close without keeping it?', body: 'The recording is not kept anywhere yet. Save it on this PC first if you need it.', confirm: 'Close and discard', cancel: 'Go back', danger: true })
        .then((ok) => { if (ok) close(); });
    }}>
      <dl className="rec-facts">
        <div><dt className="label">Length</dt><dd className="mono">{lengthOf(rec.ms)}</dd></div>
        <div><dt className="label">Size</dt><dd className="mono">{formatSize(rec.blob.size)}</dd></div>
        <div><dt className="label">Chapters</dt><dd className="mono">{!rec.chapters.length ? 'None' : speakers === 1 ? `${rec.chapters.length} · 1 speaker` : `${rec.chapters.length} · ${speakers} speakers`}</dd></div>
      </dl>
      <div className="rec-keep" role="status">
        {!policy.allowRecording && <p>Keeping recordings on the hub is turned off for this office. Save it on this PC.</p>}
        {policy.allowRecording && !canKeep && <p>It is larger than this office keeps on the hub ({formatSize(limit)}). Save it on this PC.</p>}
        {canKeep && up.status === 'uploading' && (
          <>
            <div className="rec-keep-head"><span className="label">Keeping it on the hub</span><span className="mono">{Math.floor((up.sent / Math.max(1, up.total)) * 100)}%</span></div>
            <RuledProgress value={up.sent / Math.max(1, up.total)} label="Upload to the hub" />
          </>
        )}
        {canKeep && up.status === 'done' && <p><Icon name="check" size={15} /> Kept on the hub. Only you can watch it until you share it. It is on your <b>Recordings</b> shelf in Meet.</p>}
        {canKeep && up.status === 'failed' && (
          <p className="field-error">It could not be kept on the hub: {up.error}. <button className="tb-link" onClick={() => void keepOnHub(rec).catch(() => {})}>Try again</button></p>
        )}
      </div>
      <div className="dialog-actions rec-done-actions">
        {up.status !== 'done' && <button className="btn ghost danger" onClick={() => void confirmAction({ title: 'Discard this recording?', body: 'It is not kept on the hub or on this PC, so it cannot be brought back.', confirm: 'Discard', danger: true }).then((ok) => { if (ok) close(); })}>Discard</button>}
        {!/Android/i.test(navigator.userAgent) && <button className="btn" onClick={save}><Icon name="download" size={15} />Save to this PC</button>}
        {up.status === 'done' && up.info && (
          <>
            {rec.convId && <button className="btn" disabled={busy || up.info.sharedWithConv} onClick={() => void share({ conv: true })}><Icon name="chat" size={15} />Share with the conversation</button>}
            <button className="btn" disabled={busy} onClick={() => void share({ link: true })}><Glyph name="copy" size={15} />Copy link for the office</button>
            <button className="btn primary" onClick={() => { const id = up.info!.id; close(); openRecording({ id }); }}>Open on the shelf</button>
          </>
        )}
      </div>
    </Dialog>
  );
}
