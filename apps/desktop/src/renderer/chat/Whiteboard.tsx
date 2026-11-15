// Whiteboards: a shared canvas for a conversation. Everyone in the conversation sees strokes,
// shapes and labels as they are added. Pan with the middle button or Space + drag, zoom with
// the wheel, undo your own last mark, and post the board into the conversation as an image.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Board, BoardOp } from '@dex/core';
import { Icon, useToast } from '../ui.tsx';
import type { IconName } from '../ui.tsx';
import { sendMessage } from './store.ts';
import { BoardPointers } from '../pointers/surfaces.tsx';

type Tool = 'pen' | 'line' | 'arrow' | 'rect' | 'ellipse' | 'text' | 'erase';
type Mark = Exclude<BoardOp, { t: 'erase' } | { t: 'clear' }>;
const COLORS = ['#15191b', '#1c7680', '#2f5d8a', '#b23628', '#e8921e', '#2b8a4b', '#6a4c93'];
const WIDTHS = [2, 4, 8];
const TOOLS: Array<{ id: Tool; icon: IconName; label: string; key: string }> = [
  { id: 'pen', icon: 'edit', label: 'Pen', key: 'p' },
  { id: 'line', icon: 'drawing', label: 'Line', key: 'l' },
  { id: 'arrow', icon: 'forward', label: 'Arrow', key: 'a' },
  { id: 'rect', icon: 'grid', label: 'Rectangle', key: 'r' },
  { id: 'ellipse', icon: 'smile', label: 'Ellipse', key: 'o' },
  { id: 'text', icon: 'doc', label: 'Text', key: 't' },
  { id: 'erase', icon: 'trash', label: 'Eraser', key: 'e' },
];

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function bounds(m: Mark): [number, number, number, number] {
  if (m.t === 'stroke') {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (let i = 0; i < m.points.length; i += 2) { x1 = Math.min(x1, m.points[i]); y1 = Math.min(y1, m.points[i + 1]); x2 = Math.max(x2, m.points[i]); y2 = Math.max(y2, m.points[i + 1]); }
    return [x1, y1, x2, y2];
  }
  if (m.t === 'shape') return [Math.min(m.x1, m.x2), Math.min(m.y1, m.y2), Math.max(m.x1, m.x2), Math.max(m.y1, m.y2)];
  return [m.x, m.y - m.size, m.x + m.text.length * m.size * 0.6, m.y + 4];
}

function draw(ctx: CanvasRenderingContext2D, m: Mark): void {
  ctx.strokeStyle = m.color;
  ctx.fillStyle = m.color;
  if (m.t === 'text') {
    ctx.font = `600 ${m.size}px "Segoe UI", system-ui, sans-serif`;
    m.text.split('\n').forEach((line, i) => ctx.fillText(line, m.x, m.y + i * m.size * 1.25));
    return;
  }
  ctx.lineWidth = m.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  if (m.t === 'stroke') {
    ctx.moveTo(m.points[0], m.points[1]);
    for (let i = 2; i < m.points.length; i += 2) ctx.lineTo(m.points[i], m.points[i + 1]);
  } else if (m.shape === 'rect') ctx.rect(Math.min(m.x1, m.x2), Math.min(m.y1, m.y2), Math.abs(m.x2 - m.x1), Math.abs(m.y2 - m.y1));
  else if (m.shape === 'ellipse') ctx.ellipse((m.x1 + m.x2) / 2, (m.y1 + m.y2) / 2, Math.abs(m.x2 - m.x1) / 2, Math.abs(m.y2 - m.y1) / 2, 0, 0, Math.PI * 2);
  else {
    ctx.moveTo(m.x1, m.y1);
    ctx.lineTo(m.x2, m.y2);
    if (m.shape === 'arrow') {
      const a = Math.atan2(m.y2 - m.y1, m.x2 - m.x1);
      const h = 8 + m.width * 2.5;
      ctx.moveTo(m.x2, m.y2); ctx.lineTo(m.x2 - h * Math.cos(a - 0.45), m.y2 - h * Math.sin(a - 0.45));
      ctx.moveTo(m.x2, m.y2); ctx.lineTo(m.x2 - h * Math.cos(a + 0.45), m.y2 - h * Math.sin(a + 0.45));
    }
  }
  ctx.stroke();
}

/** Is a board point near this mark? (for the eraser) */
function hit(m: Mark, x: number, y: number, r: number): boolean {
  const [x1, y1, x2, y2] = bounds(m);
  if (x < x1 - r || x > x2 + r || y < y1 - r || y > y2 + r) return false;
  if (m.t !== 'stroke') return true;
  for (let i = 0; i < m.points.length; i += 2) if (Math.hypot(m.points[i] - x, m.points[i + 1] - y) < r + m.width) return true;
  return false;
}

export function WhiteboardStage({ board, convId, onClose }: { board: Board; convId: string; onClose: () => void }) {
  const toast = useToast();
  const canvas = useRef<HTMLCanvasElement>(null);
  const marks = useRef(new Map<string, Mark>());
  const mine = useRef<string[]>([]);
  const [, bump] = useState(0);
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState(COLORS[1]);
  const [width, setWidth] = useState(WIDTHS[1]);
  const [title, setTitle] = useState(board.title);
  const [loaded, setLoaded] = useState(false);
  const view = useRef({ x: 0, y: 0, z: 1 });
  const live = useRef<Mark | null>(null);
  const drag = useRef<{ kind: 'draw' | 'pan'; sx: number; sy: number; vx: number; vy: number } | null>(null);
  const space = useRef(false);
  const [textAt, setTextAt] = useState<{ x: number; y: number; sx: number; sy: number } | null>(null);
  const [text, setText] = useState('');

  const apply = useCallback((op: BoardOp) => {
    if (op.t === 'clear') marks.current.clear();
    else if (op.t === 'erase') for (const id of op.ids) marks.current.delete(id);
    else marks.current.set(op.id, op);
  }, []);

  const render = useCallback(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const v = view.current;
    // drafting grid
    ctx.save();
    const step = 24 * v.z;
    ctx.strokeStyle = getComputedStyle(c).getPropertyValue('--grid').trim() || 'rgba(19,43,46,.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = ((v.x % step) + step) % step; x < w; x += step) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); }
    for (let y = ((v.y % step) + step) % step; y < h; y += step) { ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); }
    ctx.stroke();
    ctx.restore();
    ctx.setTransform(dpr * v.z, 0, 0, dpr * v.z, dpr * v.x, dpr * v.y);
    for (const m of marks.current.values()) draw(ctx, m);
    if (live.current) draw(ctx, live.current);
  }, []);

  const frame = useRef(0);
  const schedule = useCallback(() => { cancelAnimationFrame(frame.current); frame.current = requestAnimationFrame(render); }, [render]);

  // load, then follow live changes
  useEffect(() => {
    let alive = true;
    void window.dex.request('board.open', { boardId: board.id }).then((r) => {
      if (!alive) return;
      marks.current.clear();
      for (const o of r.ops) apply(o.op);
      setLoaded(true);
      schedule();
    }).catch((e: Error) => { toast(e.message, true); onClose(); });
    const off = window.dex.onHubEvent((name, data) => {
      if (name === 'board.op' && (data as { boardId: string }).boardId === board.id) { apply((data as { op: BoardOp }).op); schedule(); }
      if (name === 'board.removed' && (data as { boardId: string }).boardId === board.id) { toast('This whiteboard was deleted'); onClose(); }
    });
    return () => { alive = false; off(); };
  }, [board.id, apply, schedule, toast, onClose]);

  useLayoutEffect(() => {
    const ro = new ResizeObserver(schedule);
    if (canvas.current) ro.observe(canvas.current);
    return () => ro.disconnect();
  }, [schedule]);

  const send = useCallback((op: BoardOp) => {
    apply(op);
    schedule();
    void window.dex.request('board.draw', { boardId: board.id, op }).catch((e: Error) => toast(e.message, true));
  }, [apply, schedule, board.id, toast]);

  const undo = useCallback(() => {
    while (mine.current.length) {
      const id = mine.current.pop()!;
      if (marks.current.has(id)) { send({ t: 'erase', ids: [id] }); return; }
    }
  }, [send]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'TEXTAREA' || (e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.key === ' ') { space.current = e.type === 'keydown'; e.preventDefault(); return; }
      if (e.type !== 'keydown') return;
      if (e.key === 'Escape') onClose();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
      const t = TOOLS.find((x) => x.key === e.key.toLowerCase());
      if (t && !e.ctrlKey) setTool(t.id);
    };
    window.addEventListener('keydown', key);
    window.addEventListener('keyup', key);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('keyup', key); };
  }, [onClose, undo]);

  const toBoard = (e: React.PointerEvent | React.WheelEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    const v = view.current;
    return { x: (e.clientX - r.left - v.x) / v.z, y: (e.clientY - r.top - v.y) / v.z, sx: e.clientX - r.left, sy: e.clientY - r.top };
  };

  const down = (e: React.PointerEvent) => {
    if (textAt) return;
    canvas.current!.setPointerCapture(e.pointerId);
    const p = toBoard(e);
    if (e.button === 1 || space.current) { drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.current.x, vy: view.current.y }; return; }
    if (e.button !== 0) return;
    if (tool === 'text') { setTextAt(p); setText(''); return; }
    if (tool === 'erase') {
      const ids = [...marks.current.values()].filter((m) => hit(m, p.x, p.y, 8 / view.current.z)).map((m) => m.id);
      if (ids.length) send({ t: 'erase', ids: ids.slice(-1) });
      drag.current = { kind: 'draw', sx: p.x, sy: p.y, vx: 0, vy: 0 };
      return;
    }
    const id = newId();
    live.current = tool === 'pen'
      ? { t: 'stroke', id, color, width, points: [p.x, p.y, p.x + 0.1, p.y + 0.1] }
      : { t: 'shape', id, shape: tool as 'rect', color, width, x1: p.x, y1: p.y, x2: p.x, y2: p.y };
    drag.current = { kind: 'draw', sx: p.x, sy: p.y, vx: 0, vy: 0 };
    schedule();
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === 'pan') { view.current = { ...view.current, x: d.vx + e.clientX - d.sx, y: d.vy + e.clientY - d.sy }; schedule(); return; }
    const p = toBoard(e);
    if (tool === 'erase') {
      const ids = [...marks.current.values()].filter((m) => hit(m, p.x, p.y, 8 / view.current.z)).map((m) => m.id);
      if (ids.length) send({ t: 'erase', ids });
      return;
    }
    const m = live.current;
    if (!m) return;
    if (m.t === 'stroke') {
      const lx = m.points[m.points.length - 2], ly = m.points[m.points.length - 1];
      if (Math.hypot(p.x - lx, p.y - ly) * view.current.z > 1.5 && m.points.length < 7900) m.points.push(Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10);
    } else if (m.t === 'shape') {
      m.x2 = p.x; m.y2 = p.y;
      if (e.shiftKey && (m.shape === 'rect' || m.shape === 'ellipse')) { const s = Math.max(Math.abs(m.x2 - m.x1), Math.abs(m.y2 - m.y1)); m.x2 = m.x1 + Math.sign(m.x2 - m.x1 || 1) * s; m.y2 = m.y1 + Math.sign(m.y2 - m.y1 || 1) * s; }
    }
    schedule();
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    const m = live.current;
    live.current = null;
    if (!d || d.kind === 'pan' || !m) return;
    if (m.t === 'shape' && Math.hypot(m.x2 - m.x1, m.y2 - m.y1) < 3) { schedule(); return; }
    mine.current.push(m.id);
    send(m);
  };
  const wheel = (e: React.WheelEvent) => {
    const p = toBoard(e);
    const v = view.current;
    const z = Math.max(0.2, Math.min(5, v.z * Math.exp(-e.deltaY * 0.0015)));
    view.current = { z, x: p.sx - p.x * z, y: p.sy - p.y * z };
    schedule();
  };

  const placeText = () => {
    if (textAt && text.trim()) {
      const id = newId();
      mine.current.push(id);
      send({ t: 'text', id, color, x: textAt.x, y: textAt.y + 18, size: 14 + width * 2, text: text.trim() });
    }
    setTextAt(null);
    setText('');
  };

  const postImage = async () => {
    const all = [...marks.current.values()];
    if (!all.length) { toast('The whiteboard is empty', true); return; }
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const m of all) { const b = bounds(m); x1 = Math.min(x1, b[0]); y1 = Math.min(y1, b[1]); x2 = Math.max(x2, b[2]); y2 = Math.max(y2, b[3]); }
    const pad = 32;
    const scale = Math.min(2, 4000 / Math.max(x2 - x1 + pad * 2, y2 - y1 + pad * 2));
    const off = document.createElement('canvas');
    off.width = Math.ceil((x2 - x1 + pad * 2) * scale);
    off.height = Math.ceil((y2 - y1 + pad * 2) * scale);
    const ctx = off.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, off.width, off.height);
    ctx.setTransform(scale, 0, 0, scale, (pad - x1) * scale, (pad - y1) * scale);
    for (const m of all) draw(ctx, m);
    const blob = await new Promise<Blob | null>((r) => off.toBlob(r, 'image/png'));
    if (!blob || !window.dex.uploadFile) return;
    try {
      const name = `${title.replace(/[^\w -]/g, '').trim() || 'Whiteboard'}.png`;
      const info = await window.dex.uploadFile(newId(), { data: await blob.arrayBuffer(), name, mime: 'image/png', convId });
      await sendMessage(convId, '', null, [info]);
      toast('Posted to the conversation');
    } catch (e) { toast((e as Error).message, true); }
  };

  return createPortal(
    <div className="board-stage" role="dialog" aria-label={`Whiteboard: ${title}`}>
      <header className="board-bar">
        <button className="icon-btn" onClick={onClose} aria-label="Close whiteboard" title="Close (Esc)"><Icon name="back" size={17} /></button>
        <input className="note-title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)}
          onBlur={() => { if (title.trim() && title !== board.title) void window.dex.request('board.rename', { boardId: board.id, title }).catch(() => {}); }} aria-label="Whiteboard name" />
        <span className="faint board-live"><span className="work-dot" />Live for everyone in this conversation</span>
        <span style={{ flex: 1 }} />
        <button className="btn ghost" onClick={undo} title="Undo your last mark (Ctrl+Z)">Undo</button>
        <button className="btn ghost danger" onClick={() => { if (confirm('Clear the whole whiteboard for everyone?')) send({ t: 'clear' }); }}>Clear</button>
        <button className="btn primary" onClick={() => void postImage()}><Icon name="send" size={15} />Post as image</button>
      </header>
      <div className="board-tools" role="toolbar" aria-label="Drawing tools">
        {TOOLS.map((t) => (
          <button key={t.id} className={`board-tool${tool === t.id ? ' on' : ''}`} onClick={() => setTool(t.id)} title={`${t.label} (${t.key.toUpperCase()})`} aria-pressed={tool === t.id}>
            {t.id === 'rect' ? <span className="glyph rect" /> : t.id === 'ellipse' ? <span className="glyph ellipse" /> : t.id === 'line' ? <span className="glyph line" /> : <Icon name={t.icon} size={17} />}
          </button>
        ))}
        <span className="board-sep" />
        {COLORS.map((c) => <button key={c} className={`board-color${color === c ? ' on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={`Colour ${c}`} />)}
        <span className="board-sep" />
        {WIDTHS.map((w) => <button key={w} className={`board-tool${width === w ? ' on' : ''}`} onClick={() => setWidth(w)} aria-label={`Thickness ${w}`}><span className="glyph dot" style={{ width: w + 3, height: w + 3 }} /></button>)}
      </div>
      <canvas ref={canvas} className={`board-canvas tool-${tool}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onWheel={wheel} onContextMenu={(e) => e.preventDefault()} />
      <BoardPointers boardId={board.id} view={view} canvas={canvas} />
      {!loaded && <div className="board-loading"><span className="spinner" /></div>}
      {textAt && (
        <textarea className="board-text" autoFocus style={{ left: textAt.sx, top: textAt.sy, color }} value={text} placeholder="Type, then click away"
          onChange={(e) => setText(e.target.value)} onBlur={placeText} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); placeText(); } if (e.key === 'Escape') { setTextAt(null); setText(''); } }} />
      )}
      <div className="board-hint faint">Wheel to zoom · Space + drag to move · Shift for squares and circles</div>
    </div>,
    document.body,
  );
}
