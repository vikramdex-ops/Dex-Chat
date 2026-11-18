// Live pointers drawn over a shared surface (a shared screen in a Room, a picture several people
// look at, a whiteboard, or the presenter's own screen): each person's pointer with their name,
// highlights that fade after four seconds unless kept, numbered markers with a note, and ink that
// fades. Positions travel relative to the surface (0..1), at most 30 times a second.
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { CURSOR_IDLE_MS, HIGHLIGHT_MS, INK_MS, MAX_NOTE, PointerBoard, PointerThrottle, fade, fromSurface, markId, readPointerBatch, toSurface } from '@dex/core/pointers';
import type { Box, PointerMsg } from '@dex/core/pointers';
import { capName } from '../rooms/engine.ts';
import { Icon } from '../ui.tsx';
import './pointers.css';

/** How pointer messages travel for one surface. */
export interface PointerTransport {
  send(batch: { k: 'pt'; m: PointerMsg[] }): void;
  /** Messages from the others: their device, their person, the messages. */
  subscribe(f: (fromDevice: string, fromUser: string, m: PointerMsg[]) => void): () => void;
}

export type Tool = 'point' | 'rect' | 'ellipse' | 'pin' | 'ink';
const TOOLS: Array<{ id: Tool; label: string; key: string }> = [
  { id: 'point', label: 'Point', key: 'P' },
  { id: 'rect', label: 'Highlight an area', key: 'H' },
  { id: 'ellipse', label: 'Circle an area', key: 'O' },
  { id: 'pin', label: 'Drop a numbered marker', key: 'M' },
  { id: 'ink', label: 'Draw (fades)', key: 'D' },
];

export interface PointerLayerProps {
  transport: PointerTransport;
  /** This device (its own marks are drawn from what it sends). */
  self: { deviceId: string; userId: string };
  /** The device that presents: only its "clear" and "pointers off" count. */
  presenterDevice: string | null;
  /** Pointers are on for everyone (kept by the hub for files and whiteboards); left out, the presenter's own messages decide. */
  enabled?: boolean;
  /** The presenter turns pointers on or off (shown only to the presenter). */
  onEnabled?: (on: boolean) => void;
  /** Where the surface is drawn on screen now (client pixels), given this layer's element; null while it is not shown. */
  box: (layer: HTMLElement) => Box | null;
  /** The surface is turned by this many degrees clockwise (the picture viewer turns pictures). */
  rot?: number;
  nameOf: (userId: string) => string;
  colorOf: (userId: string) => string;
  /** Every message applied here, mine and others' (the presenter's own-screen window shows them too). */
  mirror?: (from: { deviceId: string; userId: string }, m: PointerMsg) => void;
  /** Draw my own cursor (off on the presenter's own screen, where the real one is). */
  showOwnCursor?: boolean;
  /** Show the tools (the presenter's own-screen window shows none). */
  tools?: boolean;
  /** Where the tool strip sits. */
  toolsAt?: 'bottom' | 'top';
}

/** The marks on this surface, kept outside React so 30 updates a second redraw only the layer. */
function useBoard(): [PointerBoard, () => void] {
  const board = useMemo(() => new PointerBoard(), []);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  return [board, bump];
}

export function PointerLayer(props: PointerLayerProps) {
  const { transport, self, presenterDevice, box: boxOf, rot = 0, nameOf, colorOf, mirror, showOwnCursor = false, tools = true } = props;
  const [board, bump] = useBoard();
  const enabled = props.enabled ?? board.enabled;
  const box = (): Box | null => (layer.current ? boxOf(layer.current) : null);
  const users = useRef(new Map<string, string>([[self.deviceId, self.userId]]));
  const layer = useRef<HTMLDivElement>(null);
  const [tool, setTool] = useState<Tool>('point');
  const [keep, setKeep] = useState(false);
  const [note, setNote] = useState<{ x: number; y: number; sx: number; sy: number } | null>(null);
  const [noteText, setNoteText] = useState('');
  const drag = useRef<{ start: { x: number; y: number }; id: string; inkFrom: number; pts: number[] } | null>(null);
  const [draft, setDraft] = useState<PointerMsg | null>(null);
  const isPresenter = presenterDevice === self.deviceId;
  const throttle = useMemo(() => new PointerThrottle((b) => transport.send(b)), [transport]);
  useEffect(() => () => throttle.stop(), [throttle]);

  const apply = (from: string, m: PointerMsg) => {
    const changed = board.apply(from, m, Date.now(), from === presenterDevice);
    if (changed) { mirror?.({ deviceId: from, userId: users.current.get(from) ?? '' }, m); bump(); }
  };
  const applyRef = useRef(apply);
  applyRef.current = apply;
  // the presenter's on/off follows the session (and their own "mode" messages)
  useEffect(() => {
    if (props.enabled === undefined || board.enabled === props.enabled) return;
    board.enabled = props.enabled;
    if (!props.enabled) board.cursors.clear();
    bump();
  }, [props.enabled, board]);
  // pointers off: the presenter repeats it now and then, so people who come in late know
  useEffect(() => {
    if (enabled || !isPresenter) return;
    const t = setInterval(() => throttle.push({ k: 'mode', on: false }), 5000);
    return () => clearInterval(t);
  }, [enabled, isPresenter, throttle]);

  useEffect(() => transport.subscribe((dev, user, list) => {
    users.current.set(dev, user);
    for (const m of list) applyRef.current(dev, m);
  }), [transport]);

  // fading: prune while anything is shown
  useEffect(() => {
    const t = setInterval(() => {
      const fading = board.inks.size > 0 || [...board.highlights.values()].some((h) => !h.pinned);
      if (board.prune(Date.now()) || fading) bump();
    }, 200);
    return () => clearInterval(t);
  }, [board]);

  // follow the surface on screen (it moves and zooms): redraw when it moved while marks are shown
  const [, frame] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    let raf = 0;
    let last = '';
    const tick = () => {
      if (board.cursors.size || board.markers.size || board.highlights.size || board.inks.size) {
        const b = box();
        const l = layer.current?.getBoundingClientRect();
        const key = b && l ? `${Math.round(b.x - l.left)},${Math.round(b.y - l.top)},${Math.round(b.width)},${Math.round(b.height)}` : '';
        if (key !== last) { last = key; frame(); }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [board]);

  const send = (m: PointerMsg) => {
    // pointers off: nobody but the presenter sends anything (the presenter turns them back on)
    if (!enabled && !isPresenter) return;
    throttle.push(m);
    apply(self.deviceId, m);
  };

  // my pointer: shared while it is over the surface (on its parent, so the page under it still works).
  // Set up once: what changes between renders is read through a ref.
  const live = useRef({ enabled, rot, send, box });
  live.current = { enabled, rot, send, box };
  useEffect(() => {
    const host = layer.current?.parentElement;
    if (!host) return;
    let inside = false;
    const move = (e: PointerEvent) => {
      const l = live.current;
      if (!l.enabled) return;
      const b = l.box();
      const p = b ? toSurface(e.clientX, e.clientY, b, l.rot) : null;
      if (p) { inside = true; l.send({ k: 'cur', x: p.x, y: p.y }); } else if (inside) { inside = false; l.send({ k: 'cur', x: -1, y: -1 }); }
    };
    const leave = () => { if (inside) { inside = false; live.current.send({ k: 'cur', x: -1, y: -1 }); } };
    host.addEventListener('pointermove', move, { passive: true });
    host.addEventListener('pointerleave', leave);
    return () => { host.removeEventListener('pointermove', move); host.removeEventListener('pointerleave', leave); leave(); };
  }, []);

  // keys for the tools while the surface is shown
  useEffect(() => {
    if (!tools) return;
    const k = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement)?.closest?.('input, textarea, [contenteditable="true"]')) return;
      if (e.key === 'Escape' && tool !== 'point') { setTool('point'); setNote(null); e.stopPropagation(); return; }
      const t = TOOLS.find((x) => x.key === e.key.toUpperCase());
      if (t && !e.shiftKey) { setTool(t.id); e.preventDefault(); }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [tools, tool]);

  const at = (e: React.PointerEvent) => { const b = box(); return b ? toSurface(e.clientX, e.clientY, b, rot) : null; };
  const down = (e: React.PointerEvent) => {
    if (tool === 'point' || e.button !== 0) return;
    const p = at(e);
    if (!p) return;
    e.preventDefault();
    e.stopPropagation();
    if (tool === 'pin') {
      const r = layer.current!.getBoundingClientRect();
      setNote({ x: p.x, y: p.y, sx: e.clientX - r.left, sy: e.clientY - r.top });
      setNoteText('');
      return;
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const id = markId();
    drag.current = { start: p, id, inkFrom: 0, pts: [p.x, p.y] };
    if (tool === 'ink') { send({ k: 'ink', id, pts: [p.x, p.y], end: false }); drag.current.inkFrom = 2; }
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = at(e);
    if (!p) return;
    if (tool === 'ink') {
      const last = d.pts.slice(-2);
      if (Math.hypot(p.x - last[0], p.y - last[1]) < 0.002) return;
      d.pts.push(p.x, p.y);
      if (throttle.inkRoom(d.id) > 0) send({ k: 'ink', id: d.id, pts: [p.x, p.y], end: false });
    } else {
      setDraft({ k: 'hl', id: d.id, shape: tool === 'ellipse' ? 'ellipse' : 'rect', x: Math.min(d.start.x, p.x), y: Math.min(d.start.y, p.y), w: Math.abs(p.x - d.start.x), h: Math.abs(p.y - d.start.y), pinned: keep });
    }
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (tool === 'ink') send({ k: 'ink', id: d.id, pts: [], end: true });
    else if (draft && draft.k === 'hl' && (draft.w > 0.004 || draft.h > 0.004)) send({ ...draft, pinned: keep });
    setDraft(null);
  };
  const placePin = () => {
    if (!note) return;
    send({ k: 'pin', id: markId(), n: board.nextMarker(), x: note.x, y: note.y, note: noteText.trim().slice(0, MAX_NOTE) });
    setNote(null);
    setNoteText('');
  };

  // ------------------------------------------------------------ drawing
  const b = box();
  const lr = layer.current?.getBoundingClientRect();
  const now = Date.now();
  const toLocal = (x: number, y: number) => { const p = fromSurface(x, y, b!, rot); return { x: p.x - (lr?.left ?? 0), y: p.y - (lr?.top ?? 0) }; };
  const scale = b ? Math.min(b.width, b.height) : 1;
  const nameFor = (dev: string) => nameOf(users.current.get(dev) ?? '');
  const colorFor = (dev: string) => colorOf(users.current.get(dev) ?? dev);
  const highlight = (h: { id: string; shape: 'rect' | 'ellipse'; x: number; y: number; w: number; h: number; pinned: boolean }, from: string, opacity: number, key: string) => {
    const a = toLocal(h.x, h.y);
    const c = toLocal(h.x + h.w, h.y + h.h);
    const x = Math.min(a.x, c.x), y = Math.min(a.y, c.y), w = Math.abs(c.x - a.x), hh = Math.abs(c.y - a.y);
    const col = colorFor(from);
    return h.shape === 'ellipse'
      ? <ellipse key={key} cx={x + w / 2} cy={y + hh / 2} rx={w / 2} ry={hh / 2} className={`pt-hl${h.pinned ? ' kept' : ''}`} style={{ stroke: col, fill: col, opacity }} />
      : <rect key={key} x={x} y={y} width={w} height={hh} rx={3} className={`pt-hl${h.pinned ? ' kept' : ''}`} style={{ stroke: col, fill: col, opacity }} />;
  };

  return (
    <div ref={layer} className={`pt-layer${tool !== 'point' ? ' drawing' : ''}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      data-tool={tool} aria-label="Live pointers">
      {b && lr && (
        <svg className="pt-svg" width={lr.width} height={lr.height} aria-hidden="true">
          {[...board.highlights.entries()].map(([k, h]) => highlight(h, h.from, h.pinned ? 1 : fade(h.at, now, HIGHLIGHT_MS), k))}
          {draft && draft.k === 'hl' && highlight(draft, self.deviceId, 0.9, 'draft')}
          {[...board.inks.entries()].map(([k, s]) => {
            const pts: string[] = [];
            for (let i = 0; i + 1 < s.pts.length; i += 2) { const p = toLocal(s.pts[i], s.pts[i + 1]); pts.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`); }
            return <polyline key={k} points={pts.join(' ')} className="pt-ink" style={{ stroke: colorFor(s.from), opacity: s.done ? fade(s.at, now, INK_MS) : 1, strokeWidth: Math.max(2, scale / 300) }} />;
          })}
          {[...board.markers.entries()].map(([k, m]) => {
            const p = toLocal(m.x, m.y);
            const col = colorFor(m.from);
            // the numbered disc sits exactly on the point (its centre is the point, the ticks say so);
            // the note reads beside it, on the side with room
            const flip = !!lr && p.x > lr.width - 200;
            return (
              <g key={k} className="pt-pin" transform={`translate(${p.x} ${p.y})`} data-n={m.n}>
                <path d="M0 -18V-12.5M0 12.5V18M-18 0H-12.5M12.5 0H18" className="pt-pin-ticks" style={{ stroke: col }} />
                <circle cx={0} cy={0} r={10.5} className="pt-pin-disc" style={{ fill: col }} />
                <text x={0} y={3.9} className={`pt-pin-n${m.n > 99 ? ' small' : ''}`}>{m.n}</text>
                {m.note && <text x={flip ? -23 : 23} y={4} className="pt-pin-note" textAnchor={flip ? 'end' : 'start'}>{m.note}</text>}
              </g>
            );
          })}
          {note && (() => {
            // where the marker being written will land
            const p = toLocal(note.x, note.y);
            return (
              <g className="pt-pin draft" transform={`translate(${p.x} ${p.y})`}>
                <path d="M0 -18V-12.5M0 12.5V18M-18 0H-12.5M12.5 0H18" className="pt-pin-ticks" style={{ stroke: colorFor(self.deviceId) }} />
                <circle cx={0} cy={0} r={10.5} className="pt-pin-disc" style={{ fill: colorFor(self.deviceId) }} />
                <text x={0} y={3.9} className="pt-pin-n">{board.nextMarker()}</text>
              </g>
            );
          })()}
          {[...board.cursors.values()].filter((c) => (showOwnCursor || c.from !== self.deviceId) && now - c.at < CURSOR_IDLE_MS).map((c) => {
            const p = toLocal(c.x, c.y);
            const col = colorFor(c.from);
            const label = c.from === self.deviceId ? 'YOU' : capName(nameFor(c.from));
            return (
              <g key={c.from} className="pt-cursor" transform={`translate(${p.x} ${p.y})`}>
                <path d="M0 0 L0 15 L4.2 11.2 L7.4 18.2 L10 17 L6.9 10.1 L12.4 10.1 Z" style={{ fill: col }} />
                <g transform="translate(14 14)">
                  <rect x={0} y={0} width={label.length * 7.2 + 12} height={17} rx={3} style={{ fill: col }} />
                  <text x={6} y={12.2} className="pt-cursor-name">{label}</text>
                </g>
              </g>
            );
          })}
        </svg>
      )}
      {note && (
        <form className={`pt-note${lr && note.sx > lr.width - 320 ? ' flip' : ''}`} style={{ left: note.sx, top: note.sy }} onSubmit={(e) => { e.preventDefault(); placePin(); }} onPointerDown={(e) => e.stopPropagation()}>
          <span className="mono">MARKER {board.nextMarker()}</span>
          <input autoFocus className="input" maxLength={MAX_NOTE} placeholder="A short note (optional)" aria-label="Note on the marker" value={noteText} onChange={(e) => setNoteText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setNote(null); } }} />
          <button className="btn primary sm" type="submit">Place</button>
        </form>
      )}
      {tools && (
        <div className={`pt-tools at-${props.toolsAt ?? 'bottom'}`} role="toolbar" aria-label="Pointing tools" onPointerDown={(e) => e.stopPropagation()}>
          <span className="pt-tools-label mono">POINTERS{enabled ? '' : ' · OFF'}</span>
          {TOOLS.map((t) => (
            <button key={t.id} className={`pt-tool${tool === t.id ? ' on' : ''}`} aria-pressed={tool === t.id} disabled={!enabled && !isPresenter}
              title={!enabled && !isPresenter ? `${t.label}: the presenter has turned pointers off` : `${t.label} (${t.key})`} onClick={() => setTool(t.id)}>
              <ToolGlyph tool={t.id} />
            </button>
          ))}
          {(tool === 'rect' || tool === 'ellipse') && (
            <label className="pt-keep" title="Kept highlights stay until taken away; others fade after four seconds">
              <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />Keep
            </label>
          )}
          {isPresenter && (
            <>
              <span className="pt-sep" />
              <button className="pt-tool wide" title="Clear every mark for everyone" onClick={() => send({ k: 'clear' })}>Clear all</button>
              <button className={`pt-tool wide${enabled ? '' : ' off'}`} aria-pressed={!enabled} title={enabled ? 'Turn pointers off for everyone' : 'Turn pointers back on'}
                onClick={() => { const on = !enabled; send({ k: 'mode', on }); props.onEnabled?.(on); }}>
                <Icon name={enabled ? 'eye' : 'x'} size={13} />{enabled ? 'Pointers on' : 'Pointers off'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** The tools' glyphs, drawn on the shared 24 px grid. */
function ToolGlyph({ tool }: { tool: Tool }) {
  const d = {
    point: 'M6 3.5v14l4-3.6 3 6.6 2.6-1.2-3-6.5h5.4z',
    rect: 'M4 6h16v12H4z',
    ellipse: 'M12 18.5c4.7 0 8.5-2.9 8.5-6.5S16.7 5.5 12 5.5 3.5 8.4 3.5 12s3.8 6.5 8.5 6.5z',
    pin: 'M7 20.5 10.5 15M10.5 6.5h8v7h-8zM14.5 8.4v3.2',
    ink: 'M3.5 16c2.5-5 4.5-7.5 6-7.5 2.5 0 .5 7 3 7 2 0 3-4.5 4.5-4.5 1.2 0 2 1.3 3.5 3.5',
  }[tool];
  return <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
}

/** Pointer batches from a raw message (dropping anything that is not one). */
export const pointerBatch = (raw: unknown): PointerMsg[] => readPointerBatch(raw);
