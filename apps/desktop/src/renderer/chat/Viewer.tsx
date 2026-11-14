// The image viewer: zoom (wheel, + and -, double-click), pan by dragging, rotate, previous/next,
// and Mark up: draw, box and arrow on a copy of the picture, then send it back to the conversation.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { FileInfo } from '@dex/core';
import { Icon, useToast } from '../ui.tsx';
import { FileActions, formatSize, useFileSrc } from './files.tsx';
import { sendMessage } from './store.ts';

type Tool = 'pen' | 'box' | 'arrow';
type Stroke = { tool: Tool; color: string; points: Array<[number, number]> };
const COLORS = ['#e5383b', '#f59f00', '#2b8a3e', '#1c7680', '#111111', '#ffffff'];

export function Viewer({ file, all, convId, onClose }: { file: FileInfo; all: FileInfo[]; convId?: string; onClose: () => void }) {
  const [i, setI] = useState(Math.max(0, all.findIndex((f) => f.id === file.id)));
  const f = all[i] ?? file;
  const src = useFileSrc(f);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<[number, number]>([0, 0]);
  const [rot, setRot] = useState(0);
  const [markup, setMarkup] = useState(false);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const reset = () => { setZoom(1); setPan([0, 0]); setRot(0); };
  useEffect(reset, [f.id]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (markup) return;
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') setI((x) => Math.min(all.length - 1, x + 1));
      else if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1));
      else if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(8, z * 1.25));
      else if (e.key === '-') setZoom((z) => Math.max(0.25, z / 1.25));
      else if (e.key === '0') reset();
      else if (e.key.toLowerCase() === 'r') setRot((r) => (r + 90) % 360);
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [all.length, onClose, markup]);

  return createPortal(
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={f.name} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <header>
        <span className="lb-title">
          <span className="sb-name" translate="no">{f.name}</span>
          <span className="lb-meta mono">{formatSize(f.size)}{all.length > 1 ? ` · sheet ${i + 1} of ${all.length}` : ''}</span>
        </span>
        <span style={{ flex: 1 }} />
        {!markup && (
          <span className="lb-tools" role="toolbar" aria-label="View">
            <button className="icon-btn" title="Zoom out (-)" onClick={() => setZoom((z) => Math.max(0.25, z / 1.25))}><Icon name="minus" size={17} /></button>
            <button className="lb-zoom" title="Actual fit (0)" onClick={reset}>{Math.round(zoom * 100)}%</button>
            <button className="icon-btn" title="Zoom in (+)" onClick={() => setZoom((z) => Math.min(8, z * 1.25))}><Icon name="plus" size={17} /></button>
            <button className="icon-btn" title="Rotate (R)" onClick={() => setRot((r) => (r + 90) % 360)}><Icon name="rotate" size={17} /></button>
            {convId && window.dex.uploadFile && <button className="btn sm" onClick={() => setMarkup(true)}><Icon name="drawing" size={15} />Mark up</button>}
          </span>
        )}
        <FileActions f={f} />
        <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" size={18} /></button>
      </header>
      {markup && src && convId ? (
        <Markup src={src} name={f.name} convId={convId} onDone={() => { setMarkup(false); onClose(); }} onCancel={() => setMarkup(false)} />
      ) : (
        <div className="lb-stage"
          onWheel={(e) => { const z = Math.max(0.25, Math.min(8, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15))); setZoom(z); if (z <= 1) setPan([0, 0]); }}
          onDoubleClick={() => (zoom === 1 ? setZoom(2) : reset())}
          onPointerDown={(e) => { if (zoom <= 1) return; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, px: pan[0], py: pan[1] }; }}
          onPointerMove={(e) => { const d = drag.current; if (d) setPan([d.px + e.clientX - d.x, d.py + e.clientY - d.y]); }}
          onPointerUp={() => { drag.current = null; }}
          style={{ cursor: zoom > 1 ? (drag.current ? 'grabbing' : 'grab') : 'zoom-in' }}>
          {src ? <img src={src} alt={f.name} draggable={false} style={{ transform: `translate(${pan[0]}px, ${pan[1]}px) scale(${zoom}) rotate(${rot}deg)` }} /> : <span className="spinner" />}
        </div>
      )}
      {!markup && all.length > 1 && i > 0 && <button className="lb-nav prev" onClick={() => setI(i - 1)} aria-label="Previous"><Icon name="back" size={22} /></button>}
      {!markup && all.length > 1 && i < all.length - 1 && <button className="lb-nav next" onClick={() => setI(i + 1)} aria-label="Next"><Icon name="back" size={22} /></button>}
    </div>,
    document.body,
  );
}

/** Draw on a copy of the picture and send it to the conversation. */
function Markup({ src, name, convId, onDone, onCancel }: { src: string; name: string; convId: string; onDone: () => void; onCancel: () => void }) {
  const toast = useToast();
  const canvas = useRef<HTMLCanvasElement>(null);
  const img = useRef<HTMLImageElement | null>(null);
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState(COLORS[0]);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const cur = useRef<Stroke | null>(null);

  useEffect(() => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => { img.current = im; const c = canvas.current!; c.width = im.naturalWidth; c.height = im.naturalHeight; draw([]); };
    im.src = src;
  }, [src]); // eslint-disable-line react-hooks/exhaustive-deps

  const draw = (list: Stroke[]) => {
    const c = canvas.current; const im = img.current;
    if (!c || !im) return;
    const x = c.getContext('2d')!;
    x.drawImage(im, 0, 0);
    const w = Math.max(3, Math.round(c.width / 300));
    for (const s of list) {
      x.strokeStyle = s.color; x.fillStyle = s.color; x.lineWidth = w; x.lineCap = 'round'; x.lineJoin = 'round';
      const [a, b] = [s.points[0], s.points[s.points.length - 1]];
      if (s.tool === 'pen') { x.beginPath(); s.points.forEach(([px, py], j) => (j ? x.lineTo(px, py) : x.moveTo(px, py))); x.stroke(); }
      else if (s.tool === 'box') x.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
      else {
        x.beginPath(); x.moveTo(a[0], a[1]); x.lineTo(b[0], b[1]); x.stroke();
        const ang = Math.atan2(b[1] - a[1], b[0] - a[0]); const h = w * 5;
        x.beginPath(); x.moveTo(b[0], b[1]);
        x.lineTo(b[0] - h * Math.cos(ang - 0.45), b[1] - h * Math.sin(ang - 0.45));
        x.lineTo(b[0] - h * Math.cos(ang + 0.45), b[1] - h * Math.sin(ang + 0.45));
        x.closePath(); x.fill();
      }
    }
  };
  const at = (e: React.PointerEvent): [number, number] => {
    const c = canvas.current!; const r = c.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * c.width, ((e.clientY - r.top) / r.height) * c.height];
  };
  const send = async () => {
    const c = canvas.current;
    if (!c) return;
    setBusy(true);
    try {
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
      if (!blob) throw new Error('Could not make the picture.');
      const base = name.replace(/\.[^.]+$/, '');
      const info = await window.dex.uploadFile!(`markup-${Date.now().toString(36)}`, { data: await blob.arrayBuffer(), name: `${base} (marked up).png`, mime: 'image/png' });
      await sendMessage(convId, note.trim(), null, [info]);
      toast('Sent');
      onDone();
    } catch (e) { toast((e as Error).message, true); setBusy(false); }
  };
  return (
    <div className="markup">
      <div className="markup-bar" role="toolbar" aria-label="Mark up">
        {(['pen', 'box', 'arrow'] as Tool[]).map((t) => (
          <button key={t} className={`btn sm${tool === t ? ' primary' : ''}`} aria-pressed={tool === t} onClick={() => setTool(t)}>{t === 'pen' ? 'Pen' : t === 'box' ? 'Box' : 'Arrow'}</button>
        ))}
        <span className="markup-colors">{COLORS.map((c) => <button key={c} className={`swatch${c === color ? ' on' : ''}`} style={{ background: c }} aria-label={`Colour ${c}`} onClick={() => setColor(c)} />)}</span>
        <button className="btn ghost sm" disabled={!strokes.length} onClick={() => { const next = strokes.slice(0, -1); setStrokes(next); draw(next); }}>Undo</button>
        <span style={{ flex: 1 }} />
        <input className="input" placeholder="Add a note (optional)" value={note} onChange={(e) => setNote(e.target.value)} style={{ maxWidth: 260 }} />
        <button className="btn ghost sm" onClick={onCancel}>Cancel</button>
        <button className="btn primary sm" disabled={busy || !strokes.length} onClick={() => void send()}>{busy ? <span className="spinner" /> : <Icon name="send" size={14} />}Send</button>
      </div>
      <div className="markup-stage">
        <canvas ref={canvas} aria-label="Picture to mark up"
          onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); cur.current = { tool, color, points: [at(e)] }; }}
          onPointerMove={(e) => { const s = cur.current; if (!s) return; if (s.tool === 'pen') s.points.push(at(e)); else s.points[1] = at(e); draw([...strokes, s]); }}
          onPointerUp={() => { const s = cur.current; cur.current = null; if (s && s.points.length > 1) { const next = [...strokes, s]; setStrokes(next); draw(next); } }} />
      </div>
    </div>
  );
}
