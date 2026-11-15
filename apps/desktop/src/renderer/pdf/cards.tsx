// PDFs and Office files in conversations. A PDF shows as a file card with its first page, and
// opens in the PDF viewer (loaded the first time one is opened). Word, Excel and PowerPoint files
// show as a card that says what they are, their size, Download and "Open in the default app":
// they are not drawn in the app.
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FileInfo } from '@dex/core';
import { Icon, useToast } from '../ui.tsx';
import { chipThumbnail } from './thumbs.ts';
import { fileBlob, fileCommands } from './source.ts';
import './cards.css';

const PdfViewer = lazy(() => import('./PdfViewer.tsx'));

const ext = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';
export const isPdf = (f: Pick<FileInfo, 'name' | 'mime'>) => f.mime === 'application/pdf' || ext(f.name) === 'pdf';

const OFFICE: Record<string, { kind: 'doc' | 'sheet' | 'slides'; label: string }> = {
  docx: { kind: 'doc', label: 'Word document' }, doc: { kind: 'doc', label: 'Word document' }, docm: { kind: 'doc', label: 'Word document' },
  rtf: { kind: 'doc', label: 'Rich text document' }, odt: { kind: 'doc', label: 'OpenDocument text' },
  xlsx: { kind: 'sheet', label: 'Excel workbook' }, xls: { kind: 'sheet', label: 'Excel workbook' }, xlsm: { kind: 'sheet', label: 'Excel workbook' }, xlsb: { kind: 'sheet', label: 'Excel workbook' },
  ods: { kind: 'sheet', label: 'OpenDocument spreadsheet' },
  pptx: { kind: 'slides', label: 'PowerPoint presentation' }, ppt: { kind: 'slides', label: 'PowerPoint presentation' }, pptm: { kind: 'slides', label: 'PowerPoint presentation' },
  odp: { kind: 'slides', label: 'OpenDocument presentation' },
};
export const officeType = (f: Pick<FileInfo, 'name'>) => OFFICE[ext(f.name)] ?? null;
export const isOffice = (f: Pick<FileInfo, 'name'>) => !!officeType(f);

export function sizeText(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}

function useRun() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (what: string, fn: () => Promise<void>, done?: string) => {
    setBusy(what);
    try { await fn(); if (done) toast(done); } catch (e) { toast((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true); } finally { setBusy(null); }
  };
  return { busy, run };
}

/** The first page, drawn once the card is on screen. */
function ChipThumb({ f }: { f: FileInfo }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    let alive = true;
    const io = new IntersectionObserver((e) => {
      if (!e.some((x) => x.isIntersecting)) return;
      io.disconnect();
      void chipThumbnail(f).then((u) => { if (alive) setSrc(u); });
    }, { rootMargin: '120px' });
    io.observe(el);
    return () => { alive = false; io.disconnect(); };
  }, [f.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <span ref={ref} className="pdf-chip-tile">
      {src ? <img src={src} alt="" draggable={false} /> : <span className="file-ico" data-kind="doc"><Icon name="doc" size={18} /><span>PDF</span></span>}
    </span>
  );
}

export function PdfChip({ f, onOpen, dragProps }: { f: FileInfo; onOpen: () => void; dragProps?: Record<string, unknown> }) {
  const cmd = fileCommands(f);
  const { busy, run } = useRun();
  return (
    <div className="file-card pdf-chip" {...dragProps}>
      <button className="pdf-chip-thumb" onClick={onOpen} aria-label={`View ${f.name}`} title="View"><ChipThumb f={f} /></button>
      <button className="pdf-chip-open" onClick={onOpen} title={f.name}>
        <span className="sb-name" translate="no">{f.name}</span>
        <span className="mono">PDF · {sizeText(f.size)}</span>
      </button>
      <span className="file-actions">
        <button className="btn" onClick={onOpen}><Icon name="eye" size={14} />View</button>
        {cmd.canDownload && <button className="btn ghost" disabled={!!busy} title="Save to Downloads" aria-label="Download" onClick={() => void run('save', () => cmd.download(), `Saved ${f.name} to Downloads`)}>{busy === 'save' ? <span className="spinner" /> : <Icon name="download" size={14} />}</button>}
      </span>
    </div>
  );
}

export function OfficeCard({ f, dragProps }: { f: FileInfo; dragProps?: Record<string, unknown> }) {
  const t = officeType(f);
  const cmd = fileCommands(f);
  const { busy, run } = useRun();
  if (!t) return null;
  return (
    <div className="file-card office-card" {...dragProps}>
      <span className="office-ico" data-kind={t.kind} aria-hidden="true">{ext(f.name).toUpperCase()}</span>
      <span className="sb-main">
        <span className="sb-name" title={f.name} translate="no">{f.name}</span>
        <span className="mono">{t.label} · {sizeText(f.size)}</span>
      </span>
      <span className="office-card-actions">
        {cmd.canOpen && <button className="btn" disabled={!!busy} onClick={() => void run('open', () => cmd.openExternal())}>{busy === 'open' ? <span className="spinner" /> : <Icon name="open" size={14} />}Open in the default app</button>}
        {cmd.canDownload && <button className="btn ghost" disabled={!!busy} onClick={() => void run('save', () => cmd.download(), `Saved ${f.name} to Downloads`)}>{busy === 'save' ? <span className="spinner" /> : <Icon name="download" size={14} />}Download</button>}
      </span>
    </div>
  );
}

/** The PDF viewer for a file in a conversation. */
export function PdfFileViewer({ file, onClose }: { file: FileInfo; onClose: () => void }) {
  const cmd = fileCommands(file);
  return (
    <Suspense fallback={createPortal(<div className="lightbox pdfv" role="dialog" aria-modal="true" aria-label={file.name}><div className="pdfv-wait"><span className="spinner" /></div></div>, document.body)}>
      <PdfViewer name={file.name} size={file.size} load={() => fileBlob(file)}
        onDownload={cmd.canDownload ? (b) => cmd.download(b) : undefined}
        onOpenExternal={cmd.canOpen ? (b) => cmd.openExternal(b) : undefined}
        onClose={onClose} />
    </Suspense>
  );
}

/** An Office file opened from the Files panel: what it is, and how to open it. */
export function OfficeFileViewer({ file, onClose }: { file: FileInfo; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return createPortal(
    <div className="lightbox office-view" role="dialog" aria-modal="true" aria-label={file.name} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <header><span style={{ flex: 1 }} /><button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" size={18} /></button></header>
      <div className="office-view-card">
        <OfficeCard f={file} />
        <p>Office files open in their own program on this device. Dexterity Connect does not draw them, so you see exactly what that program shows.</p>
      </div>
    </div>,
    document.body,
  );
}
