// The job sheet: scheduled bot jobs on a time ruler in the office's time (IST), like a programme
// on a drawing. One lane per job; upcoming runs are marks along it (the next one filled, with a
// countdown), past runs carry their stamps (RAN, SKIPPED, FAILED, DRY), days off and holidays are
// hatched, NOW is an amber line. Hovering or focusing a run shows what it did or will do; a job's
// maker can pause it, skip its next run, move one run, run it now or dry-run it (what it would
// do, with nothing sent). Today, this week or this month; a phone stacks each lane's title above
// its ruler. For a maker: their bots' jobs (or one bot's); for an administrator, the office's.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BotJobLane, BotJobRun, BotJobSheet, Session } from '@dex/core';
import { addDays, hm, officeParts, officeTime, parseSchedule } from '@dex/core/botjobs';
import { Dialog, Icon, Segmented, trapTab, useDialogFocus, useToast } from '../../ui.tsx';
import { BotMarkTile } from '../BotMark.tsx';
import { scheduleWords, trLine } from './words.ts';
import './net.css';

type Range = 'today' | 'week' | 'month';
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The stretch of time a range shows, in office time. */
function span(range: Range, now: number, tz: number): { from: number; to: number } {
  const p = officeParts(now, tz);
  if (range === 'today') return { from: officeTime(p.date, 7 * 60, tz), to: officeTime(p.date, 22 * 60, tz) };
  if (range === 'week') { const monday = addDays(p.date, -((p.dow + 6) % 7)); return { from: officeTime(monday, 0, tz), to: officeTime(addDays(monday, 7), 0, tz) }; }
  const first = `${p.date.slice(0, 8)}01`;
  const [y, m] = first.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { from: officeTime(first, 0, tz), to: officeTime(next, 0, tz) };
}

/** When, in the office's time, in a few words: "Mon 16 Nov · 10:00". */
export function officeWhen(ts: number, tz = 330): string {
  const p = officeParts(ts, tz);
  const day = new Date(Date.UTC(p.y, p.m - 1, p.d)).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${day} · ${hm(p.minutes)}`;
}

/** How long until a moment: "in 2 h 14 min". */
export function countdown(ms: number): string {
  if (ms < 60_000) return 'in under a minute';
  const m = Math.round(ms / 60_000);
  if (m < 60) return m === 1 ? 'in 1 min' : `in ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `in ${h} h ${m % 60} min` : `in ${h} h`;
  return `in ${Math.round(h / 24)} days`;
}

interface Mark { at: number; x: number; kind: 'next' | 'upcoming' | 'past'; runs: BotJobRun[]; skip: boolean; moved: boolean; count: number }

function marksOf(lane: BotJobLane, from: number, to: number, width: number, now: number): Mark[] {
  const x = (t: number) => ((t - from) / (to - from)) * width;
  const movedTo = new Set(lane.moved.map((m) => m.to));
  const items: Mark[] = [];
  const next = lane.next.find((t) => t > now);
  for (const t of lane.next) if (t >= from && t <= to) items.push({ at: t, x: x(t), kind: t === next ? 'next' : 'upcoming', runs: [], skip: t === lane.skipAt, moved: movedTo.has(t), count: 1 });
  // past runs, grouped by their due time
  const past = new Map<number, BotJobRun[]>();
  for (const r of lane.past) if (r.at >= from && r.at <= to) past.set(r.at, [...(past.get(r.at) ?? []), r]);
  for (const [t, runs] of past) items.push({ at: t, x: x(t), kind: 'past', runs, skip: false, moved: false, count: 1 });
  items.sort((a, b) => a.x - b.x);
  // marks closer than a stamp's width fold into one, with a count
  const out: Mark[] = [];
  for (const m of items) {
    const prev = out[out.length - 1];
    if (prev && m.x - prev.x < 30 && prev.kind === m.kind && prev.kind !== 'next') { prev.count += 1; prev.runs.push(...m.runs); continue; }
    out.push({ ...m, runs: [...m.runs] });
  }
  return out;
}

const worst = (runs: BotJobRun[]): BotJobRun['outcome'] => (runs.some((r) => r.outcome === 'FAILED') ? 'FAILED' : runs.some((r) => r.outcome === 'RAN') ? 'RAN' : runs.some((r) => r.outcome === 'DRY') ? 'DRY' : 'SKIPPED');

function Ruler({ range, from, to, width, tz, workdays, holidays, now }: { range: Range; from: number; to: number; width: number; tz: number; workdays: number[]; holidays: Array<{ date: string; name: string }>; now: number }) {
  const x = (t: number) => ((t - from) / (to - from)) * width;
  const ticks: Array<{ x: number; label: string; major: boolean }> = [];
  const off: Array<{ x: number; w: number; why: string }> = [];
  if (range === 'today') {
    for (let h = 7; h <= 22; h++) ticks.push({ x: x(from + (h - 7) * HOUR), label: String(h).padStart(2, '0'), major: h % 3 === 0 });
    const d = officeParts(from, tz).date;
    off.push({ x: 0, w: x(officeTime(d, 9 * 60 + 30, tz)), why: '' }, { x: x(officeTime(d, 18 * 60 + 30, tz)), w: width - x(officeTime(d, 18 * 60 + 30, tz)), why: '' });
  } else {
    for (let t = from; t < to; t += DAY) {
      const p = officeParts(t + HOUR, tz);
      const hol = holidays.find((hd) => hd.date === p.date);
      if (!workdays.includes(p.dow) || hol) off.push({ x: x(t), w: x(t + DAY) - x(t), why: hol?.name ?? '' });
      const label = range === 'week' ? `${['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][p.dow]} ${p.d}` : String(p.d);
      ticks.push({ x: x(t), label, major: range === 'week' || p.dow === 1 });
    }
  }
  const nx = x(now);
  return (
    <svg className="js-svg" width={width} height={34} aria-hidden="true">
      <defs><pattern id="js-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="var(--stroke-strong)" strokeWidth="1.2" /></pattern></defs>
      {off.map((o, i) => <rect key={i} x={o.x} y={0} width={Math.max(0, o.w)} height={34} className="js-off"><title>{o.why}</title></rect>)}
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={t.x} y1={t.major ? 14 : 22} x2={t.x} y2={34} className={`js-tick${t.major ? ' major' : ''}`} />
          {(range !== 'month' || width / ticks.length > 16 || t.major) && <text x={t.x + 3} y={12} className="js-label">{t.label}</text>}
        </g>
      ))}
      {nx >= 0 && nx <= width && (
        <g>
          <line x1={nx} y1={14} x2={nx} y2={34} className="js-nowline" />
          <rect x={nx - 14} y={0} width={28} height={11} className="js-nowtag" />
          <text x={nx} y={8.5} textAnchor="middle" className="js-nowt">NOW</text>
        </g>
      )}
    </svg>
  );
}

function Lane({ lane, range, from, to, width, now, tz, workdays, holidays, onSelect, selected, onChanged, onDetail, onMove }: {
  lane: BotJobLane; range: Range; from: number; to: number; width: number; now: number; tz: number; workdays: number[]; holidays: Array<{ date: string; name: string }>;
  onSelect: (k: string | null) => void; selected: string | null; onChanged: () => void; onDetail: (d: { title: string; run: BotJobRun }) => void; onMove: (l: BotJobLane) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [hover, setHover] = useState<Mark | null>(null);
  const marks = useMemo(() => marksOf(lane, from, to, width, now), [lane, from, to, width, now]);
  const x = (t: number) => ((t - from) / (to - from)) * width;
  const next = lane.next.find((t) => t > now);
  const set = async (d: Record<string, unknown>, words: string) => {
    setBusy(true);
    try { await window.dex.request('botjob.set', { flow: lane.flow, job: lane.job, ...d }); toast(words); onChanged(); } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  const run = async (dry: boolean) => {
    setBusy(true);
    try { const r = await window.dex.request('botjob.run', { flow: lane.flow, job: lane.job, ...(dry ? { dry: true } : {}) }); onDetail({ title: lane.title, run: r }); onChanged(); } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  const words = useMemo(() => { const p = parseSchedule(lane.when, now); return p.ok ? scheduleWords(p.rule) : lane.words; }, [lane.when, lane.words, now]);
  const label = (m: Mark) => {
    if (m.kind === 'past') return m.count > 1 ? `${m.count} runs, ${officeWhen(m.at, tz)}: ${worst(m.runs)}` : `${officeWhen(m.at, tz)}: ${m.runs[0].outcome}, ${m.runs[0].note}`;
    if (m.skip) return `${officeWhen(m.at, tz)}: will be skipped`;
    return m.kind === 'next' ? `Next run ${officeWhen(m.at, tz)}, ${countdown(m.at - now)}` : m.count > 1 ? `${m.count} runs from ${officeWhen(m.at, tz)}` : `Runs ${officeWhen(m.at, tz)}`;
  };
  return (
    <div className="js-lane" role="group" aria-label={`${lane.botTitle}: ${lane.title}`}>
      <div className="js-head">
        {lane.mark && lane.colour ? <BotMarkTile mark={lane.mark} colour={lane.colour} size={26} /> : <span />}
        <span className="js-title"><span translate="no">{lane.title}</span></span>
        <span className="js-words"><span translate="no">{lane.botTitle}</span><span>{' · '}</span><span>{words}</span></span>
        <span className="js-chips">
          {lane.paused && <span className="js-tag">PAUSED</span>}
          {lane.skipAt && <span className="js-tag">SKIP NEXT</span>}
          {lane.moved.some((m) => m.to > now) && <span className="js-tag">MOVED</span>}
          {lane.problem && <span className="js-tag warn" title={lane.problem}>CANNOT RUN</span>}
          {next && !lane.paused && <span className="js-tag mono">{countdown(next - now)}</span>}
        </span>
        {lane.problem && <span className="faint" style={{ gridColumn: '1 / -1', fontSize: 11.5 }}>{trLine(lane.problem)}</span>}
        {lane.canEdit && (
          <span className="js-acts">
            <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void set({ paused: !lane.paused }, lane.paused ? 'Resumed' : 'Paused')}><Icon name={lane.paused ? 'play' : 'pause'} size={13} />{lane.paused ? 'Resume' : 'Pause'}</button>
            <button type="button" className="btn ghost sm" disabled={busy || lane.paused} onClick={() => void set(lane.skipAt ? { unskip: true } : { skipNext: true }, lane.skipAt ? 'The next run will happen' : 'The next run will be skipped')}><Icon name="forward" size={13} />{lane.skipAt ? 'Do not skip' : 'Skip next'}</button>
            <button type="button" className="btn ghost sm" disabled={busy} onClick={() => onMove(lane)}><Icon name="schedule" size={13} />Move a run</button>
            <button type="button" className="btn ghost sm" disabled={busy} onClick={() => void run(true)}><Icon name="eye" size={13} />Dry run</button>
            <button type="button" className="btn sm" disabled={busy} onClick={() => void run(false)}><Icon name="play" size={13} />Run now</button>
          </span>
        )}
      </div>
      <div className="js-track" onMouseLeave={() => setHover(null)}>
        <svg className="js-svg" width={width} height={64}>
          {range !== 'today' && (() => {
            const offs: React.ReactNode[] = [];
            for (let t = from, i = 0; t < to; t += DAY, i++) {
              const p = officeParts(t + HOUR, tz);
              if (!workdays.includes(p.dow) || holidays.some((h) => h.date === p.date)) offs.push(<rect key={i} x={x(t)} y={0} width={x(t + DAY) - x(t)} height={64} className="js-off" aria-hidden="true" />);
            }
            return offs;
          })()}
          <line x1={0} y1={34} x2={width} y2={34} className="js-tick" aria-hidden="true" />
          {now >= from && now <= to && <line x1={x(now)} y1={0} x2={x(now)} y2={64} className="js-nowline" aria-hidden="true" />}
          {lane.moved.filter((m) => m.to > now).map((m) => (
            <path key={m.from} d={`M${x(m.from)} 34 Q${(x(m.from) + x(m.to)) / 2} 6 ${x(m.to)} 34`} className="js-moveline" aria-hidden="true" />
          ))}
          {marks.map((m) => {
            const key = `${lane.flow}/${lane.job}/${m.at}`;
            const cls = `js-run ${m.kind}${m.skip ? ' skip' : ''}${m.moved ? ' moved' : ''}${lane.paused && m.kind !== 'past' ? ' paused' : ''}${selected === key ? ' sel' : ''}`;
            const out = m.kind === 'past' ? worst(m.runs) : null;
            return (
              <g key={key} className={cls} transform={`translate(${m.x} 0)`} tabIndex={0} role="button" aria-label={label(m)}
                onMouseEnter={() => setHover(m)} onFocus={() => setHover(m)} onBlur={() => setHover(null)}
                onClick={() => { onSelect(selected === key ? null : key); if (m.runs[0]) onDetail({ title: lane.title, run: m.runs[0] }); }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(selected === key ? null : key); if (m.runs[0]) onDetail({ title: lane.title, run: m.runs[0] }); } }}>
                {out ? (
                  <g className={`js-stamp ${out}`} transform="rotate(-4)">
                    <rect x={-17} y={26} width={34} height={14} />
                    <text y={36} textAnchor="middle">{m.count > 1 ? `${m.count}×` : out}</text>
                  </g>
                ) : (
                  <>
                    <rect x={-5} y={29} width={10} height={10} transform="rotate(45 0 34)" className="js-mk" />
                    {m.count > 1 && <text x={8} y={30} className="js-count">{`${m.count}×`}</text>}
                    {m.kind === 'next' && !lane.paused && <text x={0} y={56} textAnchor="middle" className="js-count">{m.skip ? 'SKIP' : countdown(m.at - now)}</text>}
                  </>
                )}
              </g>
            );
          })}
        </svg>
        {hover && (
          <div className="js-pop" role="status" style={{ left: Math.max(4, Math.min(hover.x - 20, width - 304)), top: 52 }}>
            <b className="mono">{officeWhen(hover.at, tz)}</b>
            {hover.kind === 'past'
              ? hover.runs.slice(0, 3).map((r) => <span key={r.id}><span className={`rl-mini-stamp ${r.outcome === 'FAILED' ? 'bad' : 'ok'}`}>{r.outcome}</span>{' '}<span>{trLine(r.note)}</span></span>)
              : <span>{hover.skip ? 'It will be skipped, as asked.' : hover.kind === 'next' ? countdown(hover.at - now) : 'Coming up.'}</span>}
            {hover.kind === 'past' && hover.runs[0]?.lines.length > 0 && <ul>{hover.runs[0].lines.slice(0, 4).map((l, i) => <li key={i}>{trLine(l)}</li>)}</ul>}
          </div>
        )}
      </div>
    </div>
  );
}

function MoveDialog({ lane, tz, onClose, onMoved }: { lane: BotJobLane; tz: number; onClose: () => void; onMoved: () => void }) {
  const upcoming = lane.next.filter((t) => t > Date.now() && !lane.moved.some((m) => m.from === t || m.to === t)).slice(0, 10);
  const [from, setFrom] = useState<number>(upcoming[0] ?? 0);
  const p = officeParts(from || Date.now(), tz);
  const [date, setDate] = useState(p.date);
  const [time, setTime] = useState(hm(p.minutes));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (from) { const q = officeParts(from, tz); setDate(q.date); setTime(hm(q.minutes)); } }, [from, tz]);
  const save = async () => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(time);
    if (!m || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { setError('Choose a day and a time.'); return; }
    setBusy(true);
    setError(null);
    try { await window.dex.request('botjob.set', { flow: lane.flow, job: lane.job, move: { from, to: officeTime(date, Number(m[1]) * 60 + Number(m[2]), tz) } }); onMoved(); onClose(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Dialog title="Move a run" onClose={onClose} narrow>
      <div className="field">
        <label htmlFor="js-mv-from">Which run</label>
        <select id="js-mv-from" className="input" value={from} onChange={(e) => setFrom(Number(e.target.value))}>
          {upcoming.map((t) => <option key={t} value={t}>{officeWhen(t, tz)}</option>)}
        </select>
      </div>
      <div className="bm-grid">
        <div className="field"><label htmlFor="js-mv-d">To the day</label><input id="js-mv-d" className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div className="field"><label htmlFor="js-mv-t">At (office time)</label><input id="js-mv-t" className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} /></div>
      </div>
      <p className="faint" style={{ margin: 0, fontSize: 12 }}>Only this one run moves; the schedule stays as it is. A working day, between 08:00 and 21:00.</p>
      {error && <div className="flow-err" role="alert">{error}</div>}
      <div className="dialog-actions">
        <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" disabled={busy || !from} onClick={() => void save()}>Move this run</button>
      </div>
    </Dialog>
  );
}

export default function JobSheet({ session, scope: first, flow, onClose }: { session: Session; scope: BotJobSheet['scope']; flow?: string; onClose: () => void }) {
  const box = useRef<HTMLElement>(null);
  useDialogFocus(box, false);
  const admin = session.me.role === 'owner' || session.me.role === 'admin';
  const [scope, setScope] = useState<BotJobSheet['scope']>(first === 'office' && !admin ? 'mine' : first);
  const [range, setRange] = useState<Range>('week');
  // the sheet follows the office's clock, as the hub keeps it
  const [skew, setSkew] = useState(0);
  const [tick, setTick] = useState(Date.now());
  const now = tick + skew;
  const [sheet, setSheet] = useState<BotJobSheet | null>(null);
  const [cal, setCal] = useState<{ workdays: number[]; tzOffset: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ title: string; run: BotJobRun } | null>(null);
  const [moving, setMoving] = useState<BotJobLane | null>(null);
  const [width, setWidth] = useState(640);
  const board = useRef<HTMLDivElement>(null);
  const tz = cal?.tzOffset ?? 330;
  const { from, to } = span(range, now, tz);
  const load = useCallback(() => {
    const asked = Date.now();
    void window.dex.request('botjob.sheet', { scope, ...(scope === 'bot' && flow ? { flow } : {}), from: from - DAY, to }).then((s) => {
      setSheet(s); setError(null);
      const off = s.now - asked;
      setSkew((cur) => (Math.abs(off - cur) > 60_000 ? off : cur));
    }).catch((e: Error) => setError(e.message));
  }, [scope, flow, from, to]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { void window.dex.request('botjob.calendar').then(setCal).catch(() => {}); }, []);
  useEffect(() => { const t = setInterval(() => setTick(Date.now()), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => window.dex.onHubEvent((n) => { if (n === 'botjob.changed') load(); }), [load]);
  useLayoutEffect(() => {
    const el = board.current;
    if (!el) return;
    const measure = () => { const track = el.querySelector('.js-ruler > :last-child') as HTMLElement | null; setWidth(Math.max(240, Math.floor((track ?? el).getBoundingClientRect().width))); };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [sheet !== null]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && !moving) { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose, moving]);
  const p = officeParts(now, tz);
  const rangeWords = range === 'today' ? officeWhen(now, tz).split(' · ')[0] : range === 'week' ? `Week of ${officeWhen(from + HOUR, tz).split(' · ')[0]}` : `${MON[p.m - 1]} ${p.y}`;
  const lanes = sheet?.lanes ?? [];
  const failed = lanes.reduce((n, l) => n + l.past.filter((r) => r.outcome === 'FAILED').length, 0);
  return createPortal(
    <div className="sheet-scrim net-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside ref={box} tabIndex={-1} className="net-sheet" role="dialog" aria-modal="true" aria-label="Job sheet" onKeyDown={trapTab}>
        <header className="net-tb">
          <div className="net-tb-mark"><Icon name="schedule" size={24} /></div>
          <div className="net-tb-name">
            <span className="net-cap">{scope === 'office' ? 'Programme · the office' : scope === 'bot' ? 'Programme · one bot' : 'Programme · your bots'}</span>
            <h2>Job sheet</h2>
          </div>
          <dl className="net-tb-cells">
            <div><dt className="net-cap">Jobs</dt><dd>{lanes.length}</dd></div>
            <div><dt className="net-cap">Failed</dt><dd>{failed}</dd></div>
            <div><dt className="net-cap">Office time</dt><dd>{`IST ${hm(p.minutes)}`}</dd></div>
          </dl>
          <div className="net-tb-actions">
            {admin && scope !== 'bot' && <Segmented<'mine' | 'office'> label="Whose jobs" value={scope === 'office' ? 'office' : 'mine'} onChange={(s) => setScope(s)} options={[{ value: 'mine', label: 'My bots' }, { value: 'office', label: 'The office' }]} />}
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" title="Close (Esc)"><Icon name="x" size={18} /></button>
          </div>
        </header>
        <div className="net-body no-side">
          <div className="net-main">
            <div className="js-range">
              <Segmented<Range> label="Show" value={range} onChange={setRange} options={[{ value: 'today', label: 'Today' }, { value: 'week', label: 'This week' }, { value: 'month', label: 'This month' }]} />
              <span className="js-now">{rangeWords}</span>
            </div>
            {error && <div className="flow-err" role="alert">{error}</div>}
            {!sheet && !error && <div className="tl-more"><span className="spinner" /></div>}
            {sheet && !lanes.length && (
              <div className="net-empty"><Icon name="schedule" size={22} /><span>No scheduled jobs yet. In the bot maker, Schedule adds one in plain words, like “every Monday at 10:00”.</span></div>
            )}
            {sheet && lanes.length > 0 && (
              <div className="js-board" ref={board}>
                <div className="js-ruler">
                  <div className="js-ruler-cap"><span className="net-cap">Job</span></div>
                  <div><Ruler range={range} from={from} to={to} width={width} tz={tz} workdays={cal?.workdays ?? [1, 2, 3, 4, 5, 6]} holidays={sheet.holidays} now={now} /></div>
                </div>
                {lanes.map((l) => (
                  <Lane key={`${l.flow}/${l.job}`} lane={l} range={range} from={from} to={to} width={width} now={now} tz={tz} workdays={cal?.workdays ?? [1, 2, 3, 4, 5, 6]} holidays={sheet.holidays}
                    selected={sel} onSelect={setSel} onChanged={load} onDetail={setDetail} onMove={setMoving} />
                ))}
              </div>
            )}
            {sheet && sheet.holidays.length > 0 && <p className="faint" style={{ fontSize: 12, margin: '8px 0 0' }}>{`Holidays: ${sheet.holidays.map((h) => `${h.name} (${h.date})`).join(', ')}`}</p>}
            {detail && (
              <section className="js-detail" aria-live="polite" aria-label="What the run did">
                <span className="net-cap"><span translate="no">{detail.title}</span>{` · ${officeWhen(detail.run.at, tz)}`}</span>
                <span><span className={`rl-mini-stamp ${detail.run.outcome === 'FAILED' ? 'bad' : 'ok'}`}>{detail.run.outcome}</span>{' '}<span>{trLine(detail.run.note)}</span></span>
                {detail.run.lines.length > 0 && <ul>{detail.run.lines.map((l, i) => <li key={i}>{trLine(l)}</li>)}</ul>}
                <button type="button" className="btn ghost sm" style={{ justifySelf: 'start' }} onClick={() => setDetail(null)}>Close</button>
              </section>
            )}
          </div>
        </div>
        {moving && <MoveDialog lane={moving} tz={tz} onClose={() => setMoving(null)} onMoved={load} />}
      </aside>
    </div>,
    document.body,
  );
}
