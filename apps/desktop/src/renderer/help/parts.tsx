// Pieces the help desk's screens share: the status stamp, a ticket's timeline drawn on a spine,
// its files (with progress while saving), and short words for categories and times.
import { useEffect, useState } from 'react';
import { HELP_CATEGORIES, ticketRef } from '@dex/core';
import type { HelpEntry, HelpFile, HelpTicket, PublicUser } from '@dex/core';
import { Icon, relativeTime, useToast } from '../ui.tsx';
import { formatSize } from '../chat/files.tsx';
import { clock } from '../rooms/engine.ts';

export const categoryLabel = (c: HelpTicket['category']) => HELP_CATEGORIES.find((x) => x.id === c)?.label ?? 'Something else';
export { ticketRef };

const STATUS: Record<HelpTicket['status'], string> = { open: 'IN THE QUEUE', taken: 'WITH IT', closed: 'CLOSED' };

/** A ticket's state as a stamp in its title block. */
export function StatusStamp({ t }: { t: HelpTicket }) {
  const live = !!t.session;
  return <span className={`hd-stamp ${live ? 'live' : t.status}`}>{live ? 'IN SESSION' : STATUS[t.status]}</span>;
}

export const platformLabel = (p: string | null) => (p === 'win32' ? 'Windows' : p === 'darwin' ? 'macOS' : p === 'linux' ? 'Linux' : p === 'android' ? 'Android' : p === 'ios-web' ? 'iPhone (web app)' : p ?? '—');

export function durationText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** One line of the timeline in plain words. */
export function entryText(e: HelpEntry, name: (id: string | null) => string): string {
  const who = name(e.actor);
  const d = e.detail ?? {};
  const kind = d.kind === 'control' ? 'use of the mouse and keyboard' : d.scope === 'window' ? 'one window' : 'the screen';
  switch (e.kind) {
    case 'opened': return `${who} asked for help`;
    case 'taken': return d.from ? `${who} took it over` : `${who} took it`;
    case 'released': return `${who} handed it back to the queue`;
    case 'note': return `${who} wrote`;
    case 'file': return `${who} attached ${e.text ?? 'a file'}`;
    case 'diagnostics': return `${who} sent diagnostics`;
    case 'session.started': return `${who} started a support session`;
    case 'session.joined': return `${who} joined the session`;
    case 'session.ended': return `The session ended${typeof d.durationMs === 'number' ? ` after ${durationText(d.durationMs)}` : ''}`;
    case 'consent.granted': return `${who} allowed ${kind}`;
    case 'consent.revoked': return `${e.actor ? `${who} stopped` : 'Stopped'} ${kind}${typeof d.durationMs === 'number' ? ` (${durationText(d.durationMs)})` : ''}`;
    case 'asked': return d.kind === 'control' ? `${who} asked for the mouse and keyboard` : d.kind === 'diagnostics' ? `${who} asked for diagnostics` : `${who} asked for a look at the screen`;
    case 'closed': return `${who} closed it`;
    case 'reopened': return `${who} reopened it`;
    case 'rated': return `${who} rated the help ${typeof d.rating === 'number' ? `${d.rating} of 5` : ''}`;
  }
}

/** The ticket's timeline on a spine: a tick per entry, consent grants in amber. */
export function Timeline({ entries, users }: { entries: HelpEntry[]; users: Map<string, PublicUser> }) {
  const name = (id: string | null) => (id ? users.get(id)?.displayName ?? 'Someone' : 'The hub');
  return (
    <ol className="hd-timeline" aria-label="Timeline">
      {entries.map((e) => (
        <li key={e.id} className={`hd-entry k-${e.kind.replace('.', '-')}`}>
          <span className="hd-entry-at mono" title={new Date(e.at).toLocaleString()}>{clock(e.at)}</span>
          <span className="hd-entry-tick" aria-hidden="true" />
          <span className="hd-entry-body">
            <span>{entryText(e, name)}</span>
            {e.text && e.kind !== 'file' && <q className="hd-entry-text" translate="no">{e.text}</q>}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Save a file from the ticket to Downloads, with progress. */
export function useSave(): { save: (f: HelpFile) => void; progress: Map<string, number> } {
  const toast = useToast();
  const [progress, setProgress] = useState(new Map<string, number>());
  useEffect(() => window.dex.onUploadProgress?.((id, got, total) => {
    if (!id.startsWith('save:')) return;
    setProgress((m) => new Map(m).set(id.slice(5), total ? got / total : 0));
  }), []);
  const save = (f: HelpFile) => {
    if (!window.dex.saveFile) { toast('Open the ticket on your PC to save files.', true); return; }
    setProgress((m) => new Map(m).set(f.fileId, 0));
    void window.dex.saveFile(f.fileId, f.name).then(() => toast(`Saved ${f.name} to Downloads`)).catch((e: Error) => toast(e.message, true))
      .finally(() => setProgress((m) => { const n = new Map(m); n.delete(f.fileId); return n; }));
  };
  return { save, progress };
}

export function Files({ files, users, meId }: { files: HelpFile[]; users: Map<string, PublicUser>; meId: string }) {
  const { save, progress } = useSave();
  if (!files.length) return null;
  return (
    <ul className="hd-files" aria-label="Files">
      {files.map((f) => {
        const p = progress.get(f.fileId);
        return (
          <li key={f.fileId} className="hd-file">
            <span className={`hd-file-kind mono ${f.kind}`}>{f.kind === 'screenshot' ? 'PICTURE' : f.kind === 'diagnostics' ? 'DIAG' : 'FILE'}</span>
            <span className="hd-file-main">
              <span className="hd-file-name" translate="no">{f.name}</span>
              <span className="mono faint">{formatSize(f.size)} · {f.by === meId ? 'YOU' : (users.get(f.by)?.displayName ?? '').toUpperCase()} · {relativeTime(f.at).toUpperCase()}</span>
              {p !== undefined && <span className="hd-progress" role="progressbar" aria-valuenow={Math.round(p * 100)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.round(p * 100)}%` }} /></span>}
            </span>
            <button className="icon-btn" title="Save to Downloads" aria-label={`Save ${f.name}`} disabled={p !== undefined} onClick={() => save(f)}><Icon name="download" size={15} /></button>
          </li>
        );
      })}
    </ul>
  );
}

/** A ticket's reference and how long ago, for lists. */
export const ticketMeta = (t: HelpTicket) => `${ticketRef(t.number)} · ${relativeTime(t.createdAt).toUpperCase()}`;
