// The PDF viewer: pages one under another on a drafting-table ground, drawn only near the view;
// fit width, fit page and 25-800% zoom (wheel with Ctrl, trackpad and touch pinch, all anchored on
// the pointer), panning by dragging, rotation, a strip of page thumbnails, go to page, search with
// highlights, selecting and copying text, Download and Open in the default app. Big drawing
// sheets are drawn at screen resolution in tiles (engine.ts, tiles.ts). Protected PDFs ask for
// their password; a PDF that cannot be read says so and still offers Download.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon, Popover, useToast } from '../ui.tsx';
import { PdfEngine } from './engine.ts';
import type { PageInfo } from './engine.ts';
import { describeFailure, loadPdfjs, openPdf } from './pdfjs.ts';
import type { PdfFailure, PdfSource } from './pdfjs.ts';
import {
  PDF_TO_CSS, ZOOM_MAX, anchorAt, clampZoom, currentPage, fitPageZoom, fitWidthZoom, layoutPages, minZoomFor, pagesInView,
  paperName, rotatedSize, scrollForAnchor, sizeInMm, stepZoom, visibleInPage,
} from './tiles.ts';
import type { Anchor, Rect, Size } from './tiles.ts';
import { copyText, findMatches, matchBoxes } from './textsearch.ts';
import type { Box } from './textsearch.ts';
import './pdf.css';

export interface PdfViewerProps {
  name: string;
  size?: number;
  /** The file's bytes, however the app has them (downloaded, or decrypted on this device). */
  load: () => Promise<PdfSource>;
  /** Download and Open in the default app, given the bytes when the viewer has them. */
  onDownload?: (bytes: PdfSource | null) => Promise<void>;
  onOpenExternal?: (bytes: PdfSource | null) => Promise<void>;
  onClose: () => void;
}

type Status = { kind: 'loading' } | { kind: 'password'; wrong: boolean } | { kind: 'failed'; failure: PdfFailure | { kind: 'locked' } } | { kind: 'ready' };
type Fit = 'width' | 'page' | null;
type Hit = { page: number; start: number; end: number; boxes: Box[] };

const MAX_HITS = 5000;
const SETTLE_MS = 160;
const phoneWidth = () => typeof window !== 'undefined' && window.innerWidth <= 640;

/** Small drawings for the toolbar that the app's icon set does not have. */
const GLYPHS: Record<string, string> = {
  pages: 'M4 4h6v7H4zM14 4h6v7h-6zM4 15h6v5H4zM14 15h6v5h-6z',
  hand: 'M8 12V6.5a1.5 1.5 0 0 1 3 0V11m0-5.5V5a1.5 1.5 0 0 1 3 0v6m0-4.5a1.5 1.5 0 0 1 3 0V13c0 4-2.5 7-6.5 7S5 17.5 4 15l-1.6-3a1.4 1.4 0 0 1 2.4-1.5L8 13',
  text: 'M9 4h6M12 4v16M9 20h6',
  fitw: 'M3 12h18M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3M3 5v14M21 5v14',
  fitp: 'M7 3H3v4M17 3h4v4M7 21H3v-4M17 21h4v-4M8 8h8v8H8z',
  up: 'M6 15l6-6 6 6',
  down: 'M6 9l6 6 6-6',
};
function Glyph({ name, size = 17 }: { name: keyof typeof GLYPHS; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={GLYPHS[name]} /></svg>;
}

/** Rotate a point given as fractions of the unrotated page into the page as it is shown. */
function turn(fx: number, fy: number, rot: number): [number, number] {
  switch (((rot % 360) + 360) % 360) {
    case 90: return [1 - fy, fx];
    case 180: return [1 - fx, 1 - fy];
    case 270: return [fy, 1 - fx];
    default: return [fx, fy];
  }
}
const RAW_TRANSFORM: Record<number, string> = { 0: 'none', 90: 'rotate(90deg) translateY(-100%)', 180: 'rotate(180deg) translate(-100%, -100%)', 270: 'rotate(270deg) translateX(-100%)' };

async function writeClipboard(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); return; } catch { /* fall back below */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}

export default function PdfViewer({ name, size, load, onDownload, onOpenExternal, onClose }: PdfViewerProps) {
  const toast = useToast();
  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [engine, setEngine] = useState<PdfEngine | null>(null);
  const [sizes, setSizes] = useState<Size[]>([]);
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState<Fit>(null);
  const [rotation, setRotation] = useState(0);
  const [tool, setTool] = useState<'hand' | 'text'>('hand');
  const [strip, setStrip] = useState(() => !phoneWidth());
  const [view, setView] = useState<Rect>({ x: 0, y: 0, w: 0, h: 0 });
  const [settled, setSettled] = useState(1);
  const [find, setFind] = useState<{ open: boolean; q: string; hits: Hit[]; active: number; busy: string | null }>({ open: false, q: '', hits: [], active: -1, busy: null });
  const [pageInput, setPageInput] = useState<string | null>(null);
  const [zoomMenu, setZoomMenu] = useState(false);
  const [busy, setBusy] = useState<'download' | 'open' | 'copy' | null>(null);
  const [attempt, setAttempt] = useState(0);
  const stage = useRef<HTMLDivElement>(null);
  const zoomBtn = useRef<HTMLButtonElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const bytes = useRef<PdfSource | null>(null);
  const answer = useRef<((pw: string | null) => void) | null>(null);
  const pendingAnchor = useRef<Anchor | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  // ---------------------------------------------------------------- open the file
  useEffect(() => {
    let alive = true;
    let eng: PdfEngine | null = null;
    let gaveUp = false;
    setStatus({ kind: 'loading' });
    (async () => {
      try {
        bytes.current ??= await load();
        const lib = await loadPdfjs();
        const { doc } = await openPdf(bytes.current, (wrong) => new Promise<string | null>((resolve) => {
          if (!alive) { resolve(null); return; }
          answer.current = (pw) => { answer.current = null; if (pw === null) gaveUp = true; resolve(pw); };
          setStatus({ kind: 'password', wrong });
        }));
        if (!alive) { void doc.loadingTask.destroy(); return; }
        eng = new PdfEngine(lib, doc);
        const first = await eng.loadInfo(0);
        if (!alive) { eng.destroy(); return; }
        const all = () => Array.from({ length: eng!.count }, (_, i) => eng!.info(i)?.size ?? first.size);
        setSizes(all());
        setEngine(eng);
        // drawings (landscape, or bigger than A3) open whole; documents open to the width
        const big = first.size.w > first.size.h || first.size.w * first.size.h > 842 * 1191 * 1.05;
        setFit(phoneWidth() ? 'width' : big ? 'page' : 'width');
        setStatus({ kind: 'ready' });
        void eng.loadAllInfo(() => { if (alive) setSizes(all()); });
      } catch (e) {
        if (alive) setStatus({ kind: 'failed', failure: gaveUp ? { kind: 'locked' } : describeFailure(e) });
      }
    })();
    return () => { alive = false; answer.current?.(null); eng?.destroy(); setEngine(null); };
  }, [attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- the view
  const viewW = view.w || 800;
  const layout = useMemo(() => layoutPages(sizes, zoom, rotation, viewW), [sizes, zoom, rotation, viewW]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const cur = currentPage(layout, view);
  const curSize = sizes[cur] ?? sizes[0];
  const minZoom = curSize ? minZoomFor(fitPageZoom(curSize, rotation, view.w || 800, view.h || 600)) : 0.25;

  const measure = useCallback(() => {
    const el = stage.current;
    if (!el) return;
    setView((v) => (v.x === el.scrollLeft && v.y === el.scrollTop && v.w === el.clientWidth && v.h === el.clientHeight ? v : { x: el.scrollLeft, y: el.scrollTop, w: el.clientWidth, h: el.clientHeight }));
  }, []);
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; measure(); }); };
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    measure();
    return () => { el.removeEventListener('scroll', onScroll); ro.disconnect(); cancelAnimationFrame(raf); };
  }, [measure, status.kind]);

  /** Zoom to z, keeping the point (vx, vy) of the view still (the middle by default). */
  const zoomTo = useCallback((z: number, at?: { vx: number; vy: number }, keepFit = false) => {
    const el = stage.current;
    if (!keepFit) setFit(null);
    const next = clampZoom(z, minZoom);
    if (!el || Math.abs(next - zoomRef.current) < 1e-4) return;
    pendingAnchor.current = anchorAt(layoutRef.current, { left: el.scrollLeft, top: el.scrollTop }, at?.vx ?? el.clientWidth / 2, at?.vy ?? el.clientHeight / 2);
    zoomRef.current = next;
    setZoom(next);
  }, [minZoom]);

  // after a zoom, scroll so the anchored point is where it was
  useLayoutEffect(() => {
    const el = stage.current;
    const a = pendingAnchor.current;
    if (!el || !a) return;
    pendingAnchor.current = null;
    const s = scrollForAnchor(layout, a, { w: el.clientWidth, h: el.clientHeight });
    el.scrollLeft = s.left;
    el.scrollTop = s.top;
    measure();
  }, [layout, measure]);

  // fit width / fit page follow the window, the rotation and the page in view
  useEffect(() => {
    if (!fit || !curSize || !view.w) return;
    const z = fit === 'width' ? fitWidthZoom(curSize, rotation, view.w) : fitPageZoom(curSize, rotation, view.w, view.h);
    zoomTo(z, undefined, true);
  }, [fit, view.w, view.h, rotation, curSize?.w, curSize?.h]); // eslint-disable-line react-hooks/exhaustive-deps

  // the drawing resolution follows the zoom once it stops changing
  useEffect(() => { const t = setTimeout(() => setSettled(zoom), SETTLE_MS); return () => clearTimeout(t); }, [zoom]);

  const mounted = useMemo(() => (status.kind === 'ready' ? pagesInView(layout, view, Math.max(400, view.h)) : []), [layout, view, status.kind]);

  // tell the engine what is in view (while zooming, the old drawings stretch until it settles)
  useEffect(() => {
    if (!engine || settled !== zoom) return;
    const t = setTimeout(() => {
      const visible = new Map<number, Rect>();
      for (const i of mounted) {
        const b = layout.boxes[i];
        const r = visibleInPage(b, view, 256);
        if (r) visible.set(i, { x: r.x / b.w, y: r.y / b.h, w: r.w / b.w, h: r.h / b.h });
      }
      engine.update({ scale: settled * PDF_TO_CSS, dpr: window.devicePixelRatio || 1, rotation, visible });
    }, 40);
    return () => clearTimeout(t);
  }, [engine, settled, zoom, rotation, mounted, layout, view]);

  // ---------------------------------------------------------------- gestures
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const at = (x: number, y: number) => { const r = el.getBoundingClientRect(); return { vx: x - r.left, vy: y - r.top }; };
    // Ctrl + wheel, and trackpad pinch (which arrives as Ctrl + wheel): smooth, proportional zoom
    const wheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      zoomTo(zoomRef.current * Math.exp(-Math.max(-200, Math.min(200, dy)) * 0.0022), at(e.clientX, e.clientY));
    };
    // two fingers on a touch screen
    let pinch: { d: number; z: number } | null = null;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const tstart = (e: TouchEvent) => { if (e.touches.length === 2) { pinch = { d: dist(e.touches) || 1, z: zoomRef.current }; e.preventDefault(); } };
    const tmove = (e: TouchEvent) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const mid = at((e.touches[0].clientX + e.touches[1].clientX) / 2, (e.touches[0].clientY + e.touches[1].clientY) / 2);
      zoomTo(pinch.z * (dist(e.touches) / pinch.d), mid);
    };
    const tend = (e: TouchEvent) => { if (e.touches.length < 2) pinch = null; };
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('touchstart', tstart, { passive: false });
    el.addEventListener('touchmove', tmove, { passive: false });
    el.addEventListener('touchend', tend);
    el.addEventListener('touchcancel', tend);
    return () => {
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('touchstart', tstart);
      el.removeEventListener('touchmove', tmove);
      el.removeEventListener('touchend', tend);
      el.removeEventListener('touchcancel', tend);
    };
  }, [zoomTo, status.kind]);

  // dragging pans: with the hand, with the middle button, or holding Space
  const drag = useRef<{ x: number; y: number; left: number; top: number; id: number } | null>(null);
  const space = useRef(false);
  const [dragging, setDragging] = useState(false);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse') return; // touch scrolls natively
    const pan = e.button === 1 || (e.button === 0 && (tool === 'hand' || space.current));
    if (!pan || !stage.current) return;
    e.preventDefault();
    stage.current.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, left: stage.current.scrollLeft, top: stage.current.scrollTop, id: e.pointerId };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const el = stage.current;
    if (!d || !el || d.id !== e.pointerId) return;
    el.scrollLeft = d.left - (e.clientX - d.x);
    el.scrollTop = d.top - (e.clientY - d.y);
  };
  const endDrag = () => { drag.current = null; setDragging(false); };

  // ---------------------------------------------------------------- pages
  const goTo = useCallback((i: number) => {
    const el = stage.current;
    const b = layoutRef.current.boxes[Math.max(0, Math.min(layoutRef.current.boxes.length - 1, i))];
    if (!el || !b) return;
    el.scrollTop = b.y - 12;
    el.scrollLeft = Math.max(0, b.x + b.w / 2 - el.clientWidth / 2);
    measure();
  }, [measure]);
  const rotate = (dir: 1 | -1) => setRotation((r) => (r + dir * 90 + 360) % 360);

  // ---------------------------------------------------------------- search
  const findGen = useRef(0);
  const runFind = useCallback(async (q: string) => {
    const gen = ++findGen.current;
    if (!engine || q.trim().length < 1) { setFind((f) => ({ ...f, hits: [], active: -1, busy: null })); return; }
    const hits: Hit[] = [];
    for (let i = 0; i < engine.count && hits.length < MAX_HITS; i++) {
      if (gen !== findGen.current) return;
      if (engine.count > 3) setFind((f) => ({ ...f, busy: `Searching page ${i + 1} of ${engine.count}` }));
      try {
        const [text, info] = await Promise.all([engine.text(i), engine.loadInfo(i)]);
        for (const m of findMatches(text, q, i, MAX_HITS - hits.length)) hits.push({ ...m, boxes: matchBoxes(text, m, info.view) });
      } catch { /* a page without text */ }
      if (gen !== findGen.current) return;
      // show the first results while the rest of a long document is searched
      if (i === 0 || i % 10 === 9) setFind((f) => ({ ...f, hits: [...hits], active: f.active < 0 && hits.length ? 0 : f.active }));
    }
    if (gen !== findGen.current) return;
    setFind((f) => ({ ...f, hits, active: hits.length ? Math.min(Math.max(0, f.active), hits.length - 1) : -1, busy: null }));
  }, [engine]);
  useEffect(() => {
    if (!find.open) return;
    const t = setTimeout(() => void runFind(find.q), 220);
    return () => clearTimeout(t);
  }, [find.q, find.open, runFind]);

  // bring the chosen match into view
  const hit = find.active >= 0 ? find.hits[find.active] : undefined;
  useEffect(() => {
    const el = stage.current;
    if (!hit || !el || !engine) return;
    const b = layoutRef.current.boxes[hit.page];
    const info = engine.info(hit.page);
    const box = hit.boxes[0];
    if (!b || !box) return;
    const [fx, fy] = turn(box.left + box.width / 2, box.top + box.height / 2, (info?.rotate ?? 0) + rotation);
    const x = b.x + fx * b.w;
    const y = b.y + fy * b.h;
    if (x < el.scrollLeft + 40 || x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = x - el.clientWidth / 2;
    if (y < el.scrollTop + 60 || y > el.scrollTop + el.clientHeight - 60) el.scrollTop = y - el.clientHeight / 2;
    measure();
  }, [hit, engine, rotation, layout, measure]);
  const hitsByPage = useMemo(() => {
    const m = new Map<number, Array<{ boxes: Box[]; on: boolean }>>();
    find.hits.forEach((h, k) => { if (!m.has(h.page)) m.set(h.page, []); m.get(h.page)!.push({ boxes: h.boxes, on: k === find.active }); });
    return m;
  }, [find.hits, find.active]);
  const stepHit = (dir: 1 | -1) => setFind((f) => (f.hits.length ? { ...f, active: (f.active + dir + f.hits.length) % f.hits.length } : f));
  const openFind = () => { setFind((f) => ({ ...f, open: true })); setTimeout(() => { findInput.current?.focus(); findInput.current?.select(); }, 0); };

  // ---------------------------------------------------------------- actions
  const act = async (what: 'download' | 'open') => {
    const fn = what === 'download' ? onDownload : onOpenExternal;
    if (!fn) return;
    setBusy(what);
    try { await fn(bytes.current); if (what === 'download') toast(`Saved ${name} to Downloads`); } catch (e) { toast((e as Error).message, true); } finally { setBusy(null); }
  };
  const copy = async () => {
    if (!engine) return;
    setBusy('copy');
    try {
      const sel = window.getSelection();
      const chosen = sel && stage.current?.contains(sel.anchorNode) ? sel.toString().trim() : '';
      const text = chosen || copyText(await engine.text(cur));
      if (!text) { toast(`Page ${cur + 1} has no text to copy. It may be a scan.`, true); return; }
      await writeClipboard(text);
      toast(chosen ? 'Copied the selected text' : `Copied the text of page ${cur + 1}`);
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(null); }
  };

  // ---------------------------------------------------------------- keyboard
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest?.('input, textarea');
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); openFind(); return; }
      if (e.key === 'Escape') {
        if (zoomMenu) return;
        if (find.open) { setFind((f) => ({ ...f, open: false, hits: [], active: -1 })); return; }
        onClose();
        return;
      }
      if (typing) return;
      if (e.key === ' ' && tool === 'text') { e.preventDefault(); space.current = true; return; }
      if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomTo(stepZoom(zoomRef.current, 1, minZoom)); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === '-') { e.preventDefault(); zoomTo(stepZoom(zoomRef.current, -1, minZoom)); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === '0') { e.preventDefault(); setFit('page'); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === '+' || k === '=') zoomTo(stepZoom(zoomRef.current, 1, minZoom));
      else if (k === '-') zoomTo(stepZoom(zoomRef.current, -1, minZoom));
      else if (k === '1') zoomTo(1);
      else if (k === 'w') setFit('width');
      else if (k === 'f') setFit('page');
      else if (k === 'r') rotate(e.shiftKey ? -1 : 1);
      else if (k === 'h') setTool('hand');
      else if (k === 't') setTool('text');
      else if (k === 's') setStrip((x) => !x);
      else if (k === 'g') setPageInput(String(cur + 1));
      else if (e.key === 'Home' && !e.shiftKey) { e.preventDefault(); goTo(0); }
      else if (e.key === 'End' && !e.shiftKey) { e.preventDefault(); goTo(layoutRef.current.boxes.length - 1); }
      else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && layoutRef.current.width <= (stage.current?.clientWidth ?? 0) + 1) {
        e.preventDefault();
        goTo(cur + (e.key === 'ArrowRight' ? 1 : -1));
      } else if (k === 'n' || (e.key === 'Enter' && find.open)) stepHit(e.shiftKey ? -1 : 1);
    };
    const up = (e: KeyboardEvent) => { if (e.key === ' ') space.current = false; };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  });

  // ---------------------------------------------------------------- drawing
  const count = sizes.length;
  const pct = Math.round(zoom * 100);
  const paper = curSize ? paperName(curSize) : null;
  // separate pieces, so "12 pages" is translated and the sheet size is not
  const meta = ['PDF', ...(status.kind === 'ready' ? [count === 1 ? '1 page' : `${count} pages`] : []),
    ...(status.kind === 'ready' && curSize ? [`${paper ? `${paper} · ` : ''}${sizeInMm(rotatedSize(curSize, 0))}`] : []), ...(size ? [formatBytes(size)] : [])];
  const ready = status.kind === 'ready' && !!engine;

  return createPortal(
    <div className={`lightbox pdfv tool-${tool}${dragging ? ' dragging' : ''}`} role="dialog" aria-modal="true" aria-label={name}>
      <header className="pdfv-head">
        <span className="pdfv-title">
          <span className="sb-name" translate="no" title={name}>{name}</span>
          <span className="pdfv-meta mono">{meta.map((m, k) => <span key={k}>{k ? ' · ' : ''}<span translate={k === 1 && status.kind === 'ready' ? undefined : 'no'}>{m}</span></span>)}</span>
        </span>
        <span className="pdfv-tools" role="toolbar" aria-label="PDF">
          {ready && (
            <>
              <span className="pdfv-group">
                <button className={`icon-btn${strip ? ' on' : ''}`} aria-pressed={strip} title="Page strip (S)" aria-label="Page strip" onClick={() => setStrip(!strip)}><Glyph name="pages" /></button>
                <button className="icon-btn" title="Previous page" aria-label="Previous page" disabled={cur <= 0} onClick={() => goTo(cur - 1)}><Glyph name="up" /></button>
                <span className="pdfv-pageno">
                  <input className="mono" aria-label="Go to page" inputMode="numeric" value={pageInput ?? String(cur + 1)}
                    onFocus={(e) => { setPageInput(String(cur + 1)); e.currentTarget.select(); }}
                    onChange={(e) => setPageInput(e.target.value.replace(/[^0-9]/g, '').slice(0, 5))}
                    onKeyDown={(e) => { if (e.key === 'Enter') { const n = Number(pageInput); if (n >= 1 && n <= count) goTo(n - 1); setPageInput(null); (e.target as HTMLInputElement).blur(); } }}
                    onBlur={() => setPageInput(null)} />
                  <span className="mono faint">/ {count}</span>
                </span>
                <button className="icon-btn" title="Next page" aria-label="Next page" disabled={cur >= count - 1} onClick={() => goTo(cur + 1)}><Glyph name="down" /></button>
              </span>
              <span className="pdfv-group">
                <button className="icon-btn" title="Zoom out (-)" aria-label="Zoom out" disabled={zoom <= minZoom + 1e-4} onClick={() => zoomTo(stepZoom(zoom, -1, minZoom))}><Icon name="minus" size={17} /></button>
                <button ref={zoomBtn} className="pdfv-zoom mono" aria-haspopup="menu" aria-label={`Zoom ${pct}%`} title="Zoom" onClick={() => setZoomMenu(true)}>{fit === 'width' ? 'Width' : fit === 'page' ? 'Page' : `${pct}%`}</button>
                <button className="icon-btn" title="Zoom in (+)" aria-label="Zoom in" disabled={zoom >= ZOOM_MAX - 1e-4} onClick={() => zoomTo(stepZoom(zoom, 1, minZoom))}><Icon name="plus" size={17} /></button>
                <button className={`icon-btn${fit === 'width' ? ' on' : ''}`} aria-pressed={fit === 'width'} title="Fit width (W)" aria-label="Fit width" onClick={() => setFit('width')}><Glyph name="fitw" /></button>
                <button className={`icon-btn${fit === 'page' ? ' on' : ''}`} aria-pressed={fit === 'page'} title="Fit page (F)" aria-label="Fit page" onClick={() => setFit('page')}><Glyph name="fitp" /></button>
              </span>
              <span className="pdfv-group">
                <button className="icon-btn" title="Rotate (R)" aria-label="Rotate" onClick={() => rotate(1)}><Icon name="rotate" size={17} /></button>
                <button className={`icon-btn${tool === 'hand' ? ' on' : ''}`} aria-pressed={tool === 'hand'} title="Pan by dragging (H)" aria-label="Pan" onClick={() => setTool('hand')}><Glyph name="hand" /></button>
                <button className={`icon-btn${tool === 'text' ? ' on' : ''}`} aria-pressed={tool === 'text'} title="Select text (T)" aria-label="Select text" onClick={() => setTool('text')}><Glyph name="text" /></button>
                <button className={`icon-btn${find.open ? ' on' : ''}`} aria-pressed={find.open} title="Find in this PDF (Ctrl+F)" aria-label="Find in this PDF" onClick={() => (find.open ? setFind((f) => ({ ...f, open: false, hits: [], active: -1 })) : openFind())}><Icon name="search" size={17} /></button>
                <button className="icon-btn" title="Copy text (selected, or the whole page)" aria-label="Copy text" disabled={busy === 'copy'} onClick={() => void copy()}><Icon name="copy" size={17} /></button>
              </span>
            </>
          )}
          <span className="pdfv-group">
            {onDownload && <button className="icon-btn" title="Download" aria-label="Download" disabled={!!busy} onClick={() => void act('download')}>{busy === 'download' ? <span className="spinner" /> : <Icon name="download" size={17} />}</button>}
            {onOpenExternal && <button className="btn sm pdfv-ext" title="Open in the default app" disabled={!!busy} onClick={() => void act('open')}>{busy === 'open' ? <span className="spinner" /> : <Icon name="open" size={14} />}<span>Open in the default app</span></button>}
          </span>
        </span>
        <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" size={18} /></button>
      </header>

      <div className="pdfv-body">
        {ready && strip && <PageStrip engine={engine!} count={count} current={cur} rotation={rotation} onPick={(i) => { goTo(i); if (phoneWidth()) setStrip(false); }} />}
        <div ref={stage} className="pdfv-stage" tabIndex={0} aria-label="Pages"
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}
          onDoubleClick={(e) => { if (tool === 'hand' && stage.current) { const r = stage.current.getBoundingClientRect(); zoomTo(zoom < 1.5 ? Math.max(2, zoom * 2) : zoom / 2, { vx: e.clientX - r.left, vy: e.clientY - r.top }); } }}>
          {ready ? (
            <div className="pdfv-sheet" style={{ width: layout.width, height: layout.height }}>
              {mounted.map((i) => (
                <PageView key={i} i={i} box={layout.boxes[i]} engine={engine!} info={engine!.info(i)} zoom={zoom} rotation={rotation} hits={hitsByPage.get(i)} />
              ))}
            </div>
          ) : null}
          {status.kind === 'loading' && <div className="pdfv-wait"><span className="spinner" /><span>Opening the PDF…</span></div>}
        </div>
        {find.open && ready && (
          <div className="pdfv-find" role="search">
            <Icon name="search" size={15} />
            <input ref={findInput} className="input" aria-label="Find in this PDF" placeholder="Find in this PDF" value={find.q} maxLength={200}
              onChange={(e) => setFind((f) => ({ ...f, q: e.target.value, active: -1 }))}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); stepHit(e.shiftKey ? -1 : 1); } }} />
            <span className="pdfv-count mono" aria-live="polite">{find.busy ?? (find.q.trim() ? (find.hits.length ? `${find.active + 1} of ${find.hits.length}${find.hits.length >= MAX_HITS ? '+' : ''}` : 'No matches') : '')}</span>
            <button className="icon-btn" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={!find.hits.length} onClick={() => stepHit(-1)}><Glyph name="up" size={15} /></button>
            <button className="icon-btn" aria-label="Next match" title="Next match (Enter)" disabled={!find.hits.length} onClick={() => stepHit(1)}><Glyph name="down" size={15} /></button>
            <button className="icon-btn" aria-label="Close find" onClick={() => setFind((f) => ({ ...f, open: false, hits: [], active: -1 }))}><Icon name="x" size={14} /></button>
          </div>
        )}
        {status.kind === 'password' && (
          <PasswordCard name={name} wrong={status.wrong} onSubmit={(pw) => { setStatus({ kind: 'loading' }); answer.current?.(pw); }} onCancel={() => answer.current?.(null)} />
        )}
        {status.kind === 'failed' && (
          <ProblemCard
            title={status.failure.kind === 'locked' ? 'This PDF is protected with a password' : status.failure.kind === 'missing' ? 'This file is not available' : 'This PDF can’t be shown'}
            text={status.failure.kind === 'broken' || status.failure.kind === 'missing' ? status.failure.message : 'It opens once its password is given. Ask the person who sent it.'}
            actions={<>
              {status.failure.kind === 'locked' && <button className="btn primary" onClick={() => setAttempt((n) => n + 1)}>Enter the password</button>}
              {status.failure.kind !== 'missing' && onDownload && <button className="btn" disabled={!!busy} onClick={() => void act('download')}><Icon name="download" size={14} />Download</button>}
              {status.failure.kind !== 'missing' && onOpenExternal && <button className="btn ghost" disabled={!!busy} onClick={() => void act('open')}><Icon name="open" size={14} />Open in the default app</button>}
            </>} />
        )}
      </div>
      {zoomMenu && (
        <Popover anchor={zoomBtn.current} onClose={() => setZoomMenu(false)} className="menu pdfv-zoom-menu" align="start">
          <button role="menuitemradio" aria-checked={fit === 'width'} onClick={() => { setFit('width'); setZoomMenu(false); }}>Fit width<span className="kbd">W</span></button>
          <button role="menuitemradio" aria-checked={fit === 'page'} onClick={() => { setFit('page'); setZoomMenu(false); }}>Fit page<span className="kbd">F</span></button>
          {[0.25, 0.5, 1, 2, 4, 8].map((z) => (
            <button key={z} role="menuitemradio" aria-checked={!fit && Math.abs(zoom - z) < 0.005} onClick={() => { zoomTo(z); setZoomMenu(false); }}>
              {z === 1 ? '100% (actual size)' : `${z * 100}%`}{z === 1 && <span className="kbd">1</span>}
            </button>
          ))}
        </Popover>
      )}
    </div>,
    document.body,
  );
}

const formatBytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`);

function PageView({ i, box, engine, info, zoom, rotation, hits }: {
  i: number; box: Rect; engine: PdfEngine; info: PageInfo | null; zoom: number; rotation: number;
  hits?: Array<{ boxes: Box[]; on: boolean }>;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!layer.current || !text.current) return;
    engine.attach(i, layer.current, text.current);
    return () => engine.detach(i);
  }, [engine, i]);
  // the page's own, unrotated box holds the text layer and the highlights; it is turned to match
  const total = (((info?.rotate ?? 0) + rotation) % 360 + 360) % 360;
  const css = zoom * PDF_TO_CSS;
  const unit = info?.userUnit ?? 1;
  const rawW = info ? (info.view[2] - info.view[0]) * unit * css : box.w;
  const rawH = info ? (info.view[3] - info.view[1]) * unit * css : box.h;
  const rawStyle = { width: rawW, height: rawH, transform: RAW_TRANSFORM[total] ?? 'none', '--total-scale-factor': css * unit } as CSSProperties;
  return (
    <div className="pdfv-page" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} data-page={i + 1} aria-label={`Page ${i + 1}`}>
      <div ref={layer} className="pdfv-layer" />
      <div className="pdfv-raw" style={rawStyle}>
        <div ref={text} className="textLayer" />
        {hits?.map((h, k) => h.boxes.map((b, j) => (
          <span key={`${k}-${j}`} className={`pdfv-hit${h.on ? ' on' : ''}`} style={{ left: `${b.left * 100}%`, top: `${b.top * 100}%`, width: `${b.width * 100}%`, height: `${b.height * 100}%` }} />
        )))}
      </div>
    </div>
  );
}

/** Thumbnails of every page; each is drawn when it scrolls into the strip. */
function PageStrip({ engine, count, current, rotation, onPick }: { engine: PdfEngine; count: number; current: number; rotation: number; onPick: (i: number) => void }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-thumb="${current}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [current]);
  return (
    <nav ref={ref} className="pdfv-strip" aria-label="Pages">
      {Array.from({ length: count }, (_, i) => <Thumb key={i} i={i} engine={engine} on={i === current} rotation={rotation} onPick={onPick} root={ref} />)}
    </nav>
  );
}

function Thumb({ i, engine, on, rotation, onPick, root }: { i: number; engine: PdfEngine; on: boolean; rotation: number; onPick: (i: number) => void; root: React.RefObject<HTMLElement | null> }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) { setSeen(true); io.disconnect(); } }, { root: root.current, rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [root]);
  useEffect(() => {
    if (!seen) return;
    let alive = true;
    void engine.thumbnail(i, 104, window.devicePixelRatio || 1, rotation).then((u) => { if (alive) setSrc(u); }).catch(() => {});
    return () => { alive = false; };
  }, [seen, engine, i, rotation]);
  const info = engine.info(i);
  const s = info ? rotatedSize(info.size, rotation) : { w: 3, h: 4 };
  return (
    <button ref={ref} className={`pdfv-thumb${on ? ' on' : ''}`} data-thumb={i} aria-current={on ? 'page' : undefined} aria-label={`Page ${i + 1}`} onClick={() => onPick(i)}>
      <span className="pdfv-thumb-img" style={{ aspectRatio: `${s.w} / ${s.h}` }}>{src && <img src={src} alt="" draggable={false} />}</span>
      <span className="mono">{i + 1}</span>
    </button>
  );
}

function PasswordCard({ name, wrong, onSubmit, onCancel }: { name: string; wrong: boolean; onSubmit: (pw: string) => void; onCancel: () => void }) {
  const [pw, setPw] = useState('');
  return (
    <div className="pdfv-card-wrap">
      <form className="pdfv-card" onSubmit={(e) => { e.preventDefault(); if (pw) onSubmit(pw); }}>
        <span className="file-ico"><Icon name="lock" size={18} /></span>
        <h3>This PDF needs a password</h3>
        <p className="faint"><span translate="no">{name}</span> is protected. Type its password to open it here; it is not saved.</p>
        <input className="input" type="password" autoFocus aria-label="Password" placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} />
        {wrong && <p className="pdfv-bad" role="alert">That password did not open it. Check the letters and try again.</p>}
        <span className="pdfv-card-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!pw}>Open</button>
        </span>
      </form>
    </div>
  );
}

function ProblemCard({ title, text, actions }: { title: string; text: string; actions: ReactNode }) {
  return (
    <div className="pdfv-card-wrap">
      <div className="pdfv-card" role="alert">
        <span className="file-ico bad"><Icon name="warning" size={18} /></span>
        <h3>{title}</h3>
        <p className="faint">{text}</p>
        <span className="pdfv-card-actions">{actions}</span>
      </div>
    </div>
  );
}
