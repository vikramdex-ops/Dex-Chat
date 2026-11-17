// Scan paper documents with the camera: each page is found, straightened and cleaned up, and the
// pages become one PDF to send. Everything happens on this device.
import { useEffect, useRef, useState } from 'react';
import { Dialog, Icon, useToast } from '../ui.tsx';
import { cleanUp, findSheet, pagesToPdf, warp } from './geometry.ts';
import type { Pt, Quad } from './geometry.ts';
import './scan.css';

const PAGE_W = 1240; // A4 at 150 dpi
const PAGE_H = 1754;

interface Page { id: string; image: ImageData; preview: string }

export function ScanDialog({ onDone, onClose }: { onDone: (file: File) => void; onClose: () => void }) {
  const toast = useToast();
  const video = useRef<HTMLVideoElement>(null);
  const [shot, setShot] = useState<{ img: ImageData; url: string; quad: Quad } | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [mode, setMode] = useState<'document' | 'colour'>('document');
  const [busy, setBusy] = useState(false);
  const [camError, setCamError] = useState<string | null>(null);
  const [name, setName] = useState(() => `Scan ${new Date().toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' })}`);

  useEffect(() => {
    let stream: MediaStream | null = null;
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then((s) => { stream = s; if (video.current) { video.current.srcObject = s; void video.current.play(); } })
      .catch(() => setCamError('The camera could not be opened. Allow camera access for Dexterity Connect.'));
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, []);

  const capture = () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    const x = c.getContext('2d', { willReadFrequently: true })!;
    x.drawImage(v, 0, 0);
    const img = x.getImageData(0, 0, c.width, c.height);
    // find the sheet on a small copy (fast), then scale the corners up
    const small = document.createElement('canvas');
    const k = Math.min(1, 320 / c.width);
    small.width = Math.round(c.width * k); small.height = Math.round(c.height * k);
    const sx = small.getContext('2d', { willReadFrequently: true })!;
    sx.drawImage(c, 0, 0, small.width, small.height);
    const q = findSheet(sx.getImageData(0, 0, small.width, small.height)).map((p) => ({ x: p.x / k, y: p.y / k })) as Quad;
    setShot({ img, url: c.toDataURL('image/jpeg', 0.85), quad: q });
  };

  const keep = () => {
    if (!shot) return;
    const [tl, tr, br, bl] = shot.quad;
    const wide = Math.hypot(tr.x - tl.x, tr.y - tl.y) + Math.hypot(br.x - bl.x, br.y - bl.y) > Math.hypot(bl.x - tl.x, bl.y - tl.y) + Math.hypot(br.x - tr.x, br.y - tr.y);
    let page = warp(shot.img, shot.quad, wide ? PAGE_H : PAGE_W, wide ? PAGE_W : PAGE_H);
    if (mode === 'document') page = cleanUp(page);
    const c = document.createElement('canvas');
    c.width = page.width; c.height = page.height;
    c.getContext('2d')!.putImageData(page, 0, 0);
    setPages([...pages, { id: `${Date.now()}`, image: page, preview: c.toDataURL('image/jpeg', 0.6) }]);
    setShot(null);
  };

  const finish = async () => {
    setBusy(true);
    try {
      const out: Array<{ jpeg: Uint8Array; width: number; height: number }> = [];
      for (const p of pages) {
        const c = document.createElement('canvas');
        c.width = p.image.width; c.height = p.image.height;
        c.getContext('2d')!.putImageData(p.image, 0, 0);
        const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', mode === 'document' ? 0.8 : 0.85));
        if (!blob) throw new Error('A page could not be saved.');
        out.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), width: c.width, height: c.height });
      }
      const pdf = pagesToPdf(out);
      onDone(new File([pdf as Uint8Array<ArrayBuffer>], `${name.trim().replace(/[\\/:*?"<>|]+/g, '-') || 'Scan'}.pdf`, { type: 'application/pdf' }));
    } catch (e) { toast((e as Error).message, true); setBusy(false); }
  };

  return (
    <Dialog title="Scan a document" onClose={onClose}>
      {!shot ? (
        <div className="scan-live">
          {camError ? <div className="error-box">{camError}</div> : <video ref={video} playsInline muted />}
          <div className="scan-live-frame" aria-hidden="true" />
          <button className="scan-shutter" onClick={capture} disabled={!!camError} aria-label="Take the page"><span /></button>
        </div>
      ) : (
        <CornerEditor shot={shot} onChange={(quad) => setShot({ ...shot, quad })} />
      )}
      <div className="scan-bar">
        <div className="scan-mode" role="radiogroup" aria-label="Look">
          <button role="radio" aria-checked={mode === 'document'} className={mode === 'document' ? 'on' : ''} onClick={() => setMode('document')}>Clean black and white</button>
          <button role="radio" aria-checked={mode === 'colour'} className={mode === 'colour' ? 'on' : ''} onClick={() => setMode('colour')}>As photographed</button>
        </div>
        {shot ? (
          <div className="row-actions">
            <button className="btn ghost" onClick={() => setShot(null)}>Retake</button>
            <button className="btn primary" onClick={keep}><Icon name="check" size={15} />Keep page {pages.length + 1}</button>
          </div>
        ) : <span className="faint">{pages.length === 1 ? '1 page. Take the next, or finish.' : pages.length ? `${pages.length} pages. Take the next, or finish.` : 'Lay the page on a darker surface and take it.'}</span>}
      </div>
      {pages.length > 0 && (
        <div className="scan-pages">
          {pages.map((p, i) => (
            <div key={p.id} className="scan-page">
              <img src={p.preview} alt={`Page ${i + 1}`} />
              <span className="mono">{String(i + 1).padStart(2, '0')}</span>
              <button className="icon-btn" title={`Remove page ${i + 1}`} onClick={() => setPages(pages.filter((x) => x.id !== p.id))}><Icon name="x" size={13} /></button>
            </div>
          ))}
        </div>
      )}
      <div className="dialog-actions">
        <input className="input" style={{ flex: 1 }} value={name} onChange={(e) => setName(e.target.value)} aria-label="File name" maxLength={80} />
        <button className="btn primary" disabled={!pages.length || busy} onClick={() => void finish()}>{busy ? <span className="spinner" /> : <Icon name="paperclip" size={15} />}Attach PDF</button>
      </div>
    </Dialog>
  );
}

/** The photo with the sheet's four corners, which can be dragged into place. */
function CornerEditor({ shot, onChange }: { shot: { img: ImageData; url: string; quad: Quad }; onChange: (q: Quad) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const W = shot.img.width, H = shot.img.height;
  const move = (e: React.PointerEvent) => {
    if (drag === null || !box.current) return;
    const r = box.current.getBoundingClientRect();
    const p: Pt = { x: Math.max(0, Math.min(W, ((e.clientX - r.left) / r.width) * W)), y: Math.max(0, Math.min(H, ((e.clientY - r.top) / r.height) * H)) };
    const q = [...shot.quad] as Quad;
    q[drag] = p;
    onChange(q);
  };
  const pts = shot.quad.map((p) => `${(p.x / W) * 100},${(p.y / H) * 100}`).join(' ');
  return (
    <div className="scan-edit" ref={box} style={{ aspectRatio: `${W} / ${H}` }} onPointerMove={move} onPointerUp={() => setDrag(null)} onPointerLeave={() => setDrag(null)}>
      <img src={shot.url} alt="The photographed page" draggable={false} />
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polygon points={pts} /></svg>
      {shot.quad.map((p, i) => (
        <button key={i} className="scan-corner" style={{ left: `${(p.x / W) * 100}%`, top: `${(p.y / H) * 100}%` }}
          aria-label={['Top left corner', 'Top right corner', 'Bottom right corner', 'Bottom left corner'][i]}
          onPointerDown={(e) => { e.currentTarget.setPointerCapture?.(e.pointerId); setDrag(i); }} />
      ))}
    </div>
  );
}
