// The day's line: one line a day for the whole office, beside a technical drawing generated from the
// date that draws itself in like a pen plotter. The office can add its own lines (Control room).
// On the first visit of the day a short "morning moment" shows it full screen, unless switched off.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OfficeLine } from '@dex/core';
import { Icon, useToast } from '../ui.tsx';
import { LINES, dayNumber, lineForDay } from './lines.ts';
import type { Line } from './lines.ts';
import { drawingForDay } from './drawing.ts';
import './dayline.css';

const MOMENT_KEY = 'dex.dayline.moment';
const SEEN_KEY = 'dex.dayline.seen';
const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

/**
 * What this app session knew about the day when Pulse first showed it. Taken once per day for the whole
 * session, so Pulse mounting more than once while the app starts does not use up the plot or the moment.
 */
let firstLook: { day: number; seen: string | null; momentDone: boolean; plotted: boolean } | null = null;
function lookAt(today: number) {
  if (!firstLook || firstLook.day !== today) firstLook = { day: today, seen: store.get(SEEN_KEY), momentDone: false, plotted: false };
  return firstLook;
}

const isoDate = (day: number) => new Date(day * 86400_000).toISOString().slice(0, 10);

/** The office's dated line wins; otherwise every third day an office line; otherwise the built-in set. */
export function lineFor(day: number, office: OfficeLine[]): Line & { office?: boolean } {
  const dated = office.find((l) => l.date === isoDate(day));
  if (dated) return { text: dated.text, by: dated.by ?? 'Dexterity Design Services', office: true };
  const any = office.filter((l) => !l.date);
  if (any.length && day % 3 === 0) {
    const l = any[Math.floor(day / 3) % any.length];
    return { text: l.text, by: l.by ?? 'Dexterity Design Services', office: true };
  }
  return lineForDay(day, LINES).line;
}

function timeOfDay(h = new Date().getHours()): 'dawn' | 'day' | 'dusk' | 'night' {
  return h >= 5 && h < 11 ? 'dawn' : h < 16 ? 'day' : h < 20 ? 'dusk' : 'night';
}

function useOfficeLines(live: boolean): OfficeLine[] {
  const [list, setList] = useState<OfficeLine[]>([]);
  useEffect(() => { if (live) void window.dex.request('lines.office').then(setList).catch(() => {}); }, [live]);
  useEffect(() => window.dex.onHubEvent((name, data) => { if (name === 'lines.updated') setList(data as OfficeLine[]); }), []);
  return list;
}

/** The drawing: strokes draw in one after another; nothing re-renders while the pointer moves. */
const Plot = memo(function Plot({ day, animate }: { day: number; animate: boolean }) {
  const d = useMemo(() => drawingForDay(day), [day]);
  let i = 0;
  return (
    <svg className={`dl-plot${animate ? ' draw' : ''}`} viewBox="0 0 600 360" role="img" aria-label={`Today's drawing: ${d.title.toLowerCase()}`}>
      <g className="dl-layer back">{d.strokes.filter((s) => s.kind === 'hatch').map((s, k) => <path key={k} d={s.d} className="s-hatch" pathLength={1} style={{ ['--i' as string]: 0 }} />)}</g>
      <g className="dl-layer mid">
        {d.strokes.filter((s) => s.kind !== 'hatch').map((s, k) => <path key={k} d={s.d} className={`s-${s.kind}`} pathLength={1} style={{ ['--i' as string]: i++ }} />)}
        {d.nodes.map((n, k) => <circle key={k} cx={n.x} cy={n.y} r={n.r} className="s-node" style={{ ['--i' as string]: i + k * 0.3 }} />)}
      </g>
      <g className="dl-layer front">
        {d.labels.map((l, k) => (
          <text key={k} x={l.x} y={l.y} textAnchor={l.anchor ?? 'start'} transform={l.rotate ? `rotate(${l.rotate.toFixed(1)} ${l.x.toFixed(1)} ${l.y.toFixed(1)})` : undefined} style={{ ['--i' as string]: i + 2 + k * 0.5 }}>{l.text}</text>
        ))}
        <text x={592} y={352} textAnchor="end" className="dl-title">{d.title} · SHEET {String((day % 97) + 1).padStart(2, '0')}</text>
      </g>
    </svg>
  );
});

export function DayLine({ live }: { live: boolean }) {
  const toast = useToast();
  const today = dayNumber();
  const [back, setBack] = useState(0);
  const office = useOfficeLines(live);
  const day = today - back;
  const line = lineFor(day, office);
  const card = useRef<HTMLElement>(null);
  const look = lookAt(today);
  const [animate] = useState(() => look.seen !== String(today) && !look.plotted);
  // the morning moment greets people from their second day on (not on the very first start), once a day
  const [moment, setMoment] = useState(() => animate && look.seen !== null && !look.momentDone && store.get(MOMENT_KEY) !== 'off' && !location.hash.includes('popout'));
  useEffect(() => { store.set(SEEN_KEY, String(today)); lookAt(today).plotted = true; }, [today]);
  const closeMoment = useCallback(() => { lookAt(today).momentDone = true; setMoment(false); }, [today]);
  // a slight parallax between the drawing's layers, without React re-rendering
  useEffect(() => {
    const el = card.current;
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let frame = 0;
    const move = (e: PointerEvent) => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const r = el.getBoundingClientRect();
        el.style.setProperty('--px', ((e.clientX - r.left) / r.width - 0.5).toFixed(3));
        el.style.setProperty('--py', ((e.clientY - r.top) / r.height - 0.5).toFixed(3));
      });
    };
    el.addEventListener('pointermove', move);
    return () => { el.removeEventListener('pointermove', move); cancelAnimationFrame(frame); };
  }, []);
  const when = new Date(day * 86400_000 + new Date().getTimezoneOffset() * 60_000);
  const share = () => void window.dex.openLink?.(`dexconnect://share?text=${encodeURIComponent(`“${line.text}” · ${line.by}`)}&from=${encodeURIComponent("The day's line")}`).catch(() => {});
  return (
    <>
      <section ref={card} className={`dayline tod-${timeOfDay()}`} aria-label="The day's line">
        <div className="dl-text">
          <div className="dl-head mono">
            <span>THE DAY'S LINE</span>
            <span>{when.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase()}{line.office ? ' · FROM THE OFFICE' : ''}</span>
          </div>
          <blockquote key={day} className="dl-quote">{line.text}</blockquote>
          <div className="dl-by"><span className="dl-rule" />{line.attributed ? 'attributed to ' : ''}<b translate="no">{line.by}</b>{line.role && <span className="faint"> · {line.role}</span>}</div>
          <div className="dl-actions">
            <button className="icon-btn" title="The day before" aria-label="The day before" disabled={back >= 6} onClick={() => setBack(back + 1)}><Icon name="back" size={15} /></button>
            <button className="icon-btn flip" title="The day after" aria-label="The day after" disabled={back === 0} onClick={() => setBack(back - 1)}><Icon name="back" size={15} /></button>
            <span className="dl-sep" />
            <button className="btn ghost sm" onClick={() => { void navigator.clipboard.writeText(`“${line.text}” · ${line.by}`).then(() => toast('Line copied')); }}><Icon name="copy" size={14} />Copy</button>
            <button className="btn ghost sm" onClick={share}><Icon name="send" size={14} />Share</button>
            <button className="btn ghost sm" onClick={() => setMoment(true)} title="See it full screen"><Icon name="expand" size={14} />Full screen</button>
          </div>
        </div>
        <Plot day={day} animate={animate && back === 0} />
      </section>
      {moment && <Moment day={today} line={lineFor(today, office)} onClose={closeMoment} />}
    </>
  );
}

/** The morning moment: the day's line full screen for a few seconds; any key or click closes it. */
function Moment({ day, line, onClose }: { day: number; line: Line; onClose: () => void }) {
  const [off, setOff] = useState(store.get(MOMENT_KEY) === 'off');
  useEffect(() => {
    const t = setTimeout(onClose, 7000);
    const key = () => onClose();
    window.addEventListener('keydown', key);
    return () => { clearTimeout(t); window.removeEventListener('keydown', key); };
  }, [onClose]);
  return (
    <div className={`dl-moment tod-${timeOfDay()}`} role="dialog" aria-label="The day's line" onClick={onClose}>
      <Plot day={day} animate />
      <div className="dl-moment-text">
        <div className="mono dl-head"><span>THE DAY'S LINE</span><span>{new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }).toUpperCase()}</span></div>
        <blockquote className="dl-quote">{line.text}</blockquote>
        <div className="dl-by"><span className="dl-rule" />{line.attributed ? 'attributed to ' : ''}<b translate="no">{line.by}</b></div>
      </div>
      <label className="dl-moment-opt" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={off} onChange={(e) => { setOff(e.target.checked); store.set(MOMENT_KEY, e.target.checked ? 'off' : 'on'); }} />
        Don't show this when I start the day
      </label>
    </div>
  );
}
