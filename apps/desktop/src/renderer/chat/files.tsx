// Attachments: the upload tray in the Dock, how files appear in messages, the image viewer
// and the Files panel.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FileInfo } from '@dex/core';
import { Icon, useToast } from '../ui.tsx';
import type { IconName } from '../ui.tsx';

export const filesSupported = () => typeof window.dex.uploadFile === 'function';
export const fileSrc = (id: string) => `dexfile://f/${id}`;
export const isImage = (f: Pick<FileInfo, 'mime'>) => /^image\/(png|jpeg|gif|webp|bmp)$/.test(f.mime);

export function formatSize(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} B`;
}

function kind(f: Pick<FileInfo, 'name' | 'mime'>): { icon: IconName; label: string } {
  const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'pdf') return { icon: 'doc', label: 'PDF' };
  if (['xlsx', 'xls', 'csv', 'ods'].includes(ext)) return { icon: 'sheet', label: ext.toUpperCase() };
  if (['dwg', 'dxf', 'dgn', 'i01'].includes(ext)) return { icon: 'drawing', label: ext.toUpperCase() };
  if (['zip', '7z', 'rar'].includes(ext)) return { icon: 'archive', label: ext.toUpperCase() };
  if (['docx', 'doc', 'txt', 'md', 'rtf'].includes(ext)) return { icon: 'doc', label: ext.toUpperCase() };
  if (f.mime.startsWith('video/') || f.mime.startsWith('audio/')) return { icon: 'play', label: ext.toUpperCase() || 'MEDIA' };
  return { icon: 'paperclip', label: ext ? ext.toUpperCase() : 'FILE' };
}

export function FileActions({ f }: { f: FileInfo }) {
  const toast = useToast();
  const [busy, setBusy] = useState<'open' | 'save' | null>(null);
  if (!window.dex.openFile) return <span className="faint" style={{ fontSize: 12 }}>Open on your PC</span>;
  const run = async (what: 'open' | 'save') => {
    setBusy(what);
    try {
      if (what === 'open') await window.dex.openFile!(f.id, f.name);
      else { await window.dex.saveFile!(f.id, f.name); toast(`Saved ${f.name} to Downloads`); }
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(null); }
  };
  return (
    <span className="file-actions">
      <button className="btn" disabled={!!busy} onClick={() => void run('open')}>{busy === 'open' ? <span className="spinner" /> : <Icon name="open" size={14} />}Open</button>
      <button className="btn ghost" disabled={!!busy} onClick={() => void run('save')} title="Save to Downloads">{busy === 'save' ? <span className="spinner" /> : <Icon name="download" size={14} />}</button>
    </span>
  );
}

export function MessageFiles({ files, onView }: { files: FileInfo[]; onView: (f: FileInfo, all: FileInfo[]) => void }) {
  if (!files.length) return null;
  const images = files.filter(isImage);
  const others = files.filter((f) => !isImage(f));
  const showImages = filesSupported();
  return (
    <div className="msg-files">
      {showImages && images.length > 0 && (
        <div className={`img-grid n${Math.min(images.length, 4)}`}>
          {images.slice(0, 4).map((f, i) => (
            <button key={f.id} className="img-tile" onClick={() => onView(f, images)} title={f.name}>
              <img src={fileSrc(f.id)} alt={f.name} loading="lazy" />
              {i === 3 && images.length > 4 && <span className="more">+{images.length - 4}</span>}
            </button>
          ))}
        </div>
      )}
      {[...(showImages ? [] : images), ...others].map((f) => {
        const k = kind(f);
        return (
          <div key={f.id} className="file-card">
            <span className="file-ico" data-kind={k.icon}><Icon name={k.icon} size={18} /><span>{k.label}</span></span>
            <span className="sb-main"><span className="sb-name" title={f.name}>{f.name}</span><span className="sb-preview">{formatSize(f.size)}</span></span>
            <FileActions f={f} />
          </div>
        );
      })}
    </div>
  );
}

export function Lightbox({ file, all, onClose }: { file: FileInfo; all: FileInfo[]; onClose: () => void }) {
  const [i, setI] = useState(Math.max(0, all.findIndex((f) => f.id === file.id)));
  const f = all[i] ?? file;
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') setI((x) => Math.min(all.length - 1, x + 1));
      if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1));
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [all.length, onClose]);
  return createPortal(
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={f.name} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <header>
        <span className="sb-name">{f.name}</span><span className="faint">{formatSize(f.size)}{all.length > 1 ? ` · ${i + 1} of ${all.length}` : ''}</span>
        <span style={{ flex: 1 }} />
        <FileActions f={f} />
        <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" size={18} /></button>
      </header>
      <img src={fileSrc(f.id)} alt={f.name} />
      {all.length > 1 && i > 0 && <button className="lb-nav prev" onClick={() => setI(i - 1)} aria-label="Previous"><Icon name="back" size={22} /></button>}
      {all.length > 1 && i < all.length - 1 && <button className="lb-nav next" onClick={() => setI(i + 1)} aria-label="Next"><Icon name="back" size={22} /></button>}
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------ the upload tray
export interface Attachment {
  key: string;
  name: string;
  size: number;
  mime: string;
  preview?: string;
  sent: number;
  info?: FileInfo;
  error?: string;
}

let progressWired = false;
const progressListeners = new Map<string, (sent: number, total: number) => void>();
function wireProgress(): void {
  if (progressWired || !window.dex.onUploadProgress) return;
  progressWired = true;
  window.dex.onUploadProgress((id, sent, total) => progressListeners.get(id)?.(sent, total));
}

/** Start uploading files; `update` receives every change. */
export function startUploads(files: File[], update: (key: string, patch: Partial<Attachment> | null) => void): Attachment[] {
  wireProgress();
  const out: Attachment[] = [];
  for (const file of files) {
    const key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const mime = file.type || 'application/octet-stream';
    const a: Attachment = { key, name: file.name || 'pasted image.png', size: file.size, mime, sent: 0, preview: mime.startsWith('image/') ? URL.createObjectURL(file) : undefined };
    out.push(a);
    progressListeners.set(key, (sent) => update(key, { sent }));
    void (async () => {
      try {
        const path = window.dex.pathForFile?.(file) || '';
        const src = path ? { path, name: a.name, mime } : { data: await file.arrayBuffer(), name: a.name, mime };
        if (!path && file.size > 100 * 1024 * 1024) throw new Error('Large files must be attached from disk, not pasted.');
        const info = await window.dex.uploadFile!(key, src);
        update(key, { info, sent: file.size });
      } catch (e) {
        update(key, { error: (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') });
      } finally {
        progressListeners.delete(key);
      }
    })();
  }
  return out;
}

export function AttachmentTray({ items, onRemove }: { items: Attachment[]; onRemove: (key: string) => void }) {
  if (!items.length) return null;
  return (
    <div className="attach-tray">
      {items.map((a) => {
        const pct = a.size ? Math.round((a.sent / a.size) * 100) : 100;
        return (
          <div key={a.key} className={`attach-chip${a.error ? ' failed' : a.info ? ' done' : ''}`} title={a.error ?? a.name}>
            {a.preview ? <img src={a.preview} alt="" /> : <span className="file-ico small"><Icon name={kind(a).icon} size={14} /></span>}
            <span className="sb-main">
              <span className="sb-name">{a.name}</span>
              <span className="sb-preview">{a.error ? a.error : a.info ? formatSize(a.size) : `${pct}% of ${formatSize(a.size)}`}</span>
            </span>
            {!a.info && !a.error && <span className="chip-bar"><span style={{ width: `${pct}%` }} /></span>}
            <button className="icon-btn" onClick={() => onRemove(a.key)} aria-label={`Remove ${a.name}`}><Icon name="x" size={14} /></button>
          </div>
        );
      })}
    </div>
  );
}

export function FilesPanel({ convId, onView, onClose }: { convId: string; onView: (f: FileInfo, all: FileInfo[]) => void; onClose: () => void }) {
  const [list, setList] = useState<Array<FileInfo & { messageId: string }> | null>(null);
  useEffect(() => { void window.dex.request('file.list', { convId }).then(setList).catch(() => setList([])); }, [convId]);
  const images = (list ?? []).filter(isImage);
  return (
    <aside className="side-panel" aria-label="Files">
      <header className="side-head"><span className="label">Files · {list?.length ?? 0}</span><button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button></header>
      <div className="side-body">
        {list === null && <div className="tl-more"><span className="spinner" /></div>}
        {list?.length === 0 && <div className="empty"><Icon name="paperclip" size={28} /><span>Files shared here will be listed in this panel.</span></div>}
        {filesSupported() && images.length > 0 && (
          <div className="files-images">{images.map((f) => <button key={f.id} className="img-tile" onClick={() => onView(f, images)}><img src={fileSrc(f.id)} alt={f.name} loading="lazy" /></button>)}</div>
        )}
        {(list ?? []).filter((f) => !isImage(f) || !filesSupported()).map((f) => (
          <div key={`${f.messageId}-${f.id}`} className="file-card compact">
            <span className="file-ico"><Icon name={kind(f).icon} size={16} /></span>
            <span className="sb-main"><span className="sb-name" title={f.name}>{f.name}</span><span className="sb-preview">{formatSize(f.size)} · {new Date(f.createdAt).toLocaleDateString()}</span></span>
            <FileActions f={f} />
          </div>
        ))}
      </div>
    </aside>
  );
}
