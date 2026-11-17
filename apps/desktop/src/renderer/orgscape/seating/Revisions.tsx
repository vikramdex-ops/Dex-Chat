// The plan's revisions, like a drawing's: each change that took effect (Rev A, B…) with its date and
// change list; any two compared (the seats that changed are clouded on the plan); and the current
// plan printed for the notice wall as a PDF or PNG. The underlay dialog (a new drawing to trace) is
// here too: both are small and only opened on request.
import { useRef, useState } from 'react';
import type { PublicUser, SeatRevision, SeatingView } from '@dex/core';
import { tr } from '../../i18n/index.ts';
import { Icon, useToast } from '../../ui.tsx';
import { reloadSeating } from './store.ts';
import './seating.css';

const when = (t: number) => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });

export function Revisions({ view, users, compare, onCompare, onExport, onClose }: {
  view: SeatingView; users: Map<string, PublicUser>; compare: { a: string; b: string } | null;
  onCompare: (c: { a: string; b: string } | null) => void; onExport: (format: 'pdf' | 'png') => Promise<void>; onClose: () => void;
}) {
  const toast = useToast();
  const revs = view.revisions;
  const [a, setA] = useState(compare?.a ?? revs[1]?.rev ?? revs[0]?.rev ?? 'A');
  const [b, setB] = useState(compare?.b ?? revs[0]?.rev ?? 'A');
  const [open, setOpen] = useState<string | null>(revs[0]?.rev ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const kind: Record<SeatRevision['kind'], string> = { seed: 'Drawing', layout: 'Layout', moves: 'Moves', undo: 'Undo' };
  const exp = async (f: 'pdf' | 'png') => { setBusy(f); try { await onExport(f); } catch (e) { toast((e as Error).message, true); } finally { setBusy(null); } };
  return (
    <aside className="seat-panel seat-revs" aria-label="Revisions" onPointerDown={(e) => e.stopPropagation()}>
      <div className="seat-head">
        <span className="label">Revisions</span>
        <button type="button" className="icon-btn" aria-label="Close the revisions" onClick={onClose}><Icon name="x" size={15} /></button>
      </div>
      <div className="seat-body">
        <section className="seat-form seat-compare" aria-label="Compare two revisions">
          <label className="label" htmlFor="rev-a">Compare</label>
          <select id="rev-a" className="input mono" value={a} onChange={(e) => setA(e.target.value)}>{revs.map((r) => <option key={r.rev} value={r.rev}>{tr(`Rev ${r.rev}`)}</option>)}</select>
          <label className="label" htmlFor="rev-b">with</label>
          <select id="rev-b" className="input mono" value={b} onChange={(e) => setB(e.target.value)}>{revs.map((r) => <option key={r.rev} value={r.rev}>{tr(`Rev ${r.rev}`)}</option>)}</select>
          <button type="button" className="btn sm primary" disabled={a === b} onClick={() => onCompare({ a, b })}><Icon name="eye" size={14} />Compare</button>
          {compare && <button type="button" className="btn sm ghost" onClick={() => onCompare(null)}>Stop comparing</button>}
        </section>
        <ol className="seat-revlist" aria-label="Revisions">
          {revs.map((r) => (
            <li key={r.rev} className={open === r.rev ? 'open' : ''}>
              <button type="button" className="seat-rev" aria-expanded={open === r.rev} onClick={() => setOpen(open === r.rev ? null : r.rev)}>
                <span className="seat-tri mono" aria-hidden="true">{r.rev}</span>
                <span className="seat-who"><b translate="no">{r.note}</b><span className="faint">{tr(kind[r.kind])} · {when(r.at)}{r.by ? <> · <span translate="no">{users.get(r.by)?.displayName ?? ''}</span></> : null}</span></span>
                <span className="mono faint">{r.changes.length}</span>
              </button>
              {open === r.rev && r.changes.length > 0 && (
                <ul className="seat-changes">
                  {r.changes.slice(0, 60).map((c, i) => (
                    <li key={i}><span className="seat-who" translate="no">{c.userId ? users.get(c.userId)?.displayName ?? '' : c.label}</span><span className="mono seat-ft">{c.from ?? tr('No seat')} → {c.to ?? tr('No seat')}</span></li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
        <section aria-label="For the notice wall">
          <h4 className="label">For the notice wall</h4>
          <p className="faint seat-hint">The current plan on an A3 sheet with its title block, names on the seats.</p>
          <div className="seat-row">
            <button type="button" className="btn sm" disabled={!!busy} onClick={() => void exp('pdf')}><Icon name="download" size={14} />PDF</button>
            <button type="button" className="btn sm" disabled={!!busy} onClick={() => void exp('png')}><Icon name="download" size={14} />PNG</button>
          </div>
        </section>
      </div>
    </aside>
  );
}

/** Put a new drawing (a PDF's first page, or an image) under the plan to trace it. */
export function UnderlayDialog({ view, onClose }: { view: SeatingView; onClose: () => void }) {
  const toast = useToast();
  const u = view.underlay;
  const [img, setImg] = useState<string | null>(null);
  const [w, setW] = useState(u?.w ?? view.plan.width);
  const [x, setX] = useState(u?.x ?? 0);
  const [y, setY] = useState(u?.y ?? 0);
  const [opacity, setOpacity] = useState(u?.opacity ?? 0.35);
  const [ratio, setRatio] = useState(u ? u.h / u.w : view.plan.height / view.plan.width);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const read = async (f: File) => {
    setBusy(true);
    try {
      const canvas = document.createElement('canvas');
      if (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')) {
        const { openPdf } = await import('../../pdf/pdfjs.ts');
        const { doc, task } = await openPdf(f, async () => null);
        const page = await doc.getPage(1);
        const vp0 = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: Math.min(4, 2200 / Math.max(vp0.width, vp0.height)) });
        canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
        await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport: vp }).promise;
        void task.destroy();
      } else {
        const bmp = await createImageBitmap(f);
        const k = Math.min(1, 2200 / Math.max(bmp.width, bmp.height));
        canvas.width = Math.round(bmp.width * k); canvas.height = Math.round(bmp.height * k);
        canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      }
      // small enough for the hub: smaller and plainer until it fits
      let data = '';
      for (const [scale, q] of [[1, 0.7], [0.8, 0.6], [0.6, 0.55], [0.45, 0.5]] as const) {
        const c2 = document.createElement('canvas');
        c2.width = Math.round(canvas.width * scale); c2.height = Math.round(canvas.height * scale);
        const g = c2.getContext('2d')!; g.fillStyle = '#fff'; g.fillRect(0, 0, c2.width, c2.height); g.drawImage(canvas, 0, 0, c2.width, c2.height);
        data = c2.toDataURL('image/jpeg', q);
        if (data.length < 850_000) break;
      }
      if (data.length >= 850_000) throw new Error(tr('That drawing is too big. Use a smaller image (under 650 KB).'));
      setImg(data);
      setRatio(canvas.height / canvas.width);
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true);
    try {
      await window.dex.request('seating.underlay', { ...(img ? { image: img } : {}), x, y, w, h: w * ratio, opacity });
      await reloadSeating();
      toast(tr('Underlay saved'));
      onClose();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  return (
    <div className="seat-dialog" role="dialog" aria-label="Underlay" onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="seat-head"><span className="label">Underlay</span><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" size={15} /></button></div>
      <p className="faint seat-hint">A drawing under the plan, faint, to trace when the office changes. Only people who arrange seats see it.</p>
      <div className="seat-row">
        <button type="button" className="btn sm" disabled={busy} onClick={() => file.current?.click()}><Icon name="open" size={14} />Choose a PDF or image</button>
        <input ref={file} type="file" accept="application/pdf,image/png,image/jpeg,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void read(f); e.target.value = ''; }} />
        {img && <span className="chip accent">Ready</span>}
      </div>
      <div className="seat-fields">
        <label>Width (ft)<input className="input mono" type="number" step={0.5} value={w} onChange={(e) => setW(Math.max(1, Number(e.target.value) || 1))} /></label>
        <label>Left (ft)<input className="input mono" type="number" step={0.25} value={x} onChange={(e) => setX(Number(e.target.value) || 0)} /></label>
        <label>Top (ft)<input className="input mono" type="number" step={0.25} value={y} onChange={(e) => setY(Number(e.target.value) || 0)} /></label>
        <label>Strength<input type="range" min={0.05} max={1} step={0.05} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} /></label>
      </div>
      <div className="seat-row seat-actions">
        <button type="button" className="btn primary" disabled={busy || (!img && !u)} onClick={() => void save()}>Save</button>
        {u && <button type="button" className="btn ghost" disabled={busy} onClick={() => void window.dex.request('seating.underlay', { image: null }).then(reloadSeating).then(onClose).catch((e: Error) => toast(e.message, true))}>Remove the underlay</button>}
      </div>
    </div>
  );
}
