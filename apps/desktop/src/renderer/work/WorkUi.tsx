// Your working day in the UI: the day menu inside your own tile menu, the thin teal arc that
// traces the day around your tile, the DAY LOG card on Pulse, your timesheet on the Desk and the
// team's day log (with CSV export) in the Directory.
import { useEffect, useMemo, useRef, useState } from 'react';
import { toCsv } from '@dex/core';
import type { AttendanceDay, PublicUser, WorkMode } from '@dex/core';
import { Avatar, Icon, Popover, Segmented, presenceFor, useToast } from '../ui.tsx';
import {
  DAY_MS, MODES, MODE_SHORT, clockTime, closeDay, downloadText, duration, lastPlace, movePlace, startDay, stepOut, useWork, workMe, workedNow,
} from './store.ts';
import type { LiveWork } from './store.ts';
import '../views/people.css';

function useTick(ms: number, on: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, on]);
  return now;
}

// Place glyphs, drawn for us: an office block, a house, a hard hat, a briefcase.
const PLACE_PATH: Record<WorkMode, string> = {
  office: 'M5 20.5V4.5h9v16M14 9h5v11.5M8 8h3M8 11.5h3M8 15h3M3 20.5h18',
  home: 'M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z',
  site: 'M3.5 17h17M5.5 17a6.5 6.5 0 0 1 13 0M10 10.6V7.5h4v3.1M12 7.5v4M3.5 19.5h17',
  client: 'M4 8.5h16v11H4zM9 8.5V5.5h6v3M4 13.5h16M11 12.5h2v2h-2z',
};
export function PlaceGlyph({ mode, size = 15 }: { mode: WorkMode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PLACE_PATH[mode]} />
    </svg>
  );
}

/** The four places as a row of square chips. */
function Places({ value, onPick, disabled, label }: { value: WorkMode | null; onPick: (m: WorkMode) => void; disabled?: boolean; label: string }) {
  return (
    <div className="day-places" role="radiogroup" aria-label={label}>
      {MODES.map((m) => (
        <button key={m} type="button" role="radio" aria-checked={value === m} disabled={disabled} className="day-place" onClick={() => onPick(m)}>
          <PlaceGlyph mode={m} />
          <span>{MODE_SHORT[m]}</span>
        </button>
      ))}
    </div>
  );
}

/** An 8-hour dimension line: hour ticks, the worked part drawn in teal. */
function DayScale({ ms, out }: { ms: number; out?: boolean }) {
  const p = Math.min(1, ms / DAY_MS);
  return (
    <div className={`day-scale${out ? ' out' : ''}`} aria-hidden="true">
      <span className="day-scale-fill" style={{ width: `${p * 100}%` }} />
      {Array.from({ length: 9 }, (_, i) => <i key={i} style={{ left: `${(i / 8) * 100}%` }} className={i % 4 === 0 ? 'major' : ''} />)}
    </div>
  );
}

// ------------------------------------------------------------------ your tile: menu and arc
/** Start, step out and close your day, and choose where you work. Shown inside your own tile menu. */
export function DayMenu({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const mine = useWork().get(workMe());
  const status = mine?.status ?? 'out';
  const now = useTick(30_000, status === 'in');
  const [place, setPlace] = useState<WorkMode>(() => mine?.mode ?? lastPlace());
  const [busy, setBusy] = useState(false);
  const run = (p: () => Promise<string>, close = true) => {
    setBusy(true);
    void p().then((line) => { toast(line); if (close) onClose(); }).catch((e: Error) => toast(e.message, true)).finally(() => setBusy(false));
  };
  const worked = workedNow(mine, now);
  return (
    <div className="day-menu" role="group" aria-label="Your day">
      <div className="day-block">
        <div className="day-cell day-cell-main">
          <span className="day-k">Day</span>
          <span className="day-v day-big mono">{status === 'out' ? (worked ? duration(worked) : 'Not started') : duration(worked)}</span>
        </div>
        <div className="day-cell">
          <span className="day-k">{status === 'break' ? 'Out since' : 'Started'}</span>
          <span className="day-v mono">{status === 'out' ? '–' : clockTime((status === 'break' ? mine?.since : mine?.checkedInAt ?? mine?.since) ?? now)}</span>
        </div>
        <div className="day-cell day-cell-scale"><DayScale ms={worked} out={status === 'break'} /></div>
      </div>
      <div className="menu-label label">{status === 'out' ? 'Where today' : 'Place'}</div>
      <Places label="Place" value={status === 'out' ? place : mine?.mode ?? null} disabled={busy}
        onPick={(m) => { if (status === 'out') setPlace(m); else if (m !== mine?.mode) run(() => movePlace(m), false); }} />
      <div className="menu-sep" />
      {status === 'out' ? (
        <button role="menuitem" className="day-go" disabled={busy} onClick={() => run(() => startDay(place))}>
          <Icon name="play" size={16} />Start my day<span className="day-go-at mono">{MODE_SHORT[place].toUpperCase()}</span>
        </button>
      ) : (
        <>
          {status === 'in'
            ? <button role="menuitem" disabled={busy} onClick={() => run(() => stepOut(true))}><Icon name="pause" size={16} />Step out</button>
            : <button role="menuitem" disabled={busy} onClick={() => run(() => stepOut(false))}><Icon name="play" size={16} />Back at desk</button>}
          <button role="menuitem" disabled={busy} onClick={() => run(closeDay)}><Icon name="power" size={16} />Close my day</button>
        </>
      )}
    </div>
  );
}

/**
 * A thin teal arc drawn around your own tile: it starts at the top centre when you start your
 * day and closes the loop after eight hours worked. Dimmed while you are stepped out; nothing
 * before the day starts. `size` is the tile's size in px; centre it over the tile.
 */
export function DayArc({ size }: { size: number }) {
  const mine = useWork().get(workMe());
  const on = mine?.status === 'in' || mine?.status === 'break';
  const now = useTick(60_000, mine?.status === 'in');
  if (!on || !mine) return null;
  const gap = 6;
  const side = size + gap * 2;
  const box = side + 6;
  const o = (box - side) / 2;
  const r = size * 0.3 + gap;
  const x0 = o; const y0 = o; const x1 = o + side; const y1 = o + side; const c = box / 2;
  const d = `M${c} ${y0}H${x1 - r}A${r} ${r} 0 0 1 ${x1} ${y0 + r}V${y1 - r}A${r} ${r} 0 0 1 ${x1 - r} ${y1}H${x0 + r}A${r} ${r} 0 0 1 ${x0} ${y1 - r}V${y0 + r}A${r} ${r} 0 0 1 ${x0 + r} ${y0}Z`;
  const p = Math.min(100, (workedNow(mine, now) / DAY_MS) * 100);
  return (
    <svg className={`day-arc${mine.status === 'break' ? ' out' : ''}`} width={box} height={box} viewBox={`0 0 ${box} ${box}`} aria-hidden="true">
      <path d={d} pathLength={100} className="day-arc-track" />
      <path d={d} pathLength={100} className="day-arc-fill" strokeDasharray={`${p} 100`} />
      {/* two-hour marks, like ticks on a dimension line */}
      <path className="day-arc-ticks" d={`M${c} ${y0 - 2}v4M${x1 - 2} ${c}h4M${c} ${y1 - 2}v4M${x0 - 2} ${c}h4`} />
    </svg>
  );
}

/** Kept for frames that still show the day as its own button: opens the day menu. */
export function WorkClock({ live, role }: { meId?: string; live: boolean; role: PublicUser['role'] }) {
  const mine = useWork().get(workMe());
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const now = useTick(30_000, mine?.status === 'in');
  if (role === 'bot' || role === 'guest') return null;
  const status = mine?.status ?? 'out';
  return (
    <>
      <button ref={btn} className={`day-tag ${status}`} disabled={!live} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} title="Your day">
        <span className="day-k">Day</span><span className="mono">{status === 'out' ? '–' : duration(workedNow(mine, now))}</span>
      </button>
      {open && (
        <Popover anchor={btn.current} onClose={() => setOpen(false)} className="menu day-pop">
          <DayMenu onClose={() => setOpen(false)} />
        </Popover>
      )}
    </>
  );
}

// ------------------------------------------------------------------ Pulse: DAY LOG
export function DayLogCard({ users, meId, onPerson }: { users: PublicUser[]; meId: string; onPerson: (id: string) => void }) {
  const toast = useToast();
  const work = useWork();
  const people = users.filter((u) => u.role !== 'bot');
  const mine = work.get(meId);
  const now = useTick(30_000, mine?.status === 'in');
  const [busy, setBusy] = useState(false);
  const counts = useMemo(() => {
    const c: Record<WorkMode | 'break', PublicUser[]> = { office: [], home: [], site: [], client: [], break: [] };
    for (const u of people) {
      const s = work.get(u.id);
      if (s?.status === 'break') c.break.push(u);
      else if (s?.status === 'in' && s.mode) c[s.mode].push(u);
    }
    return c;
  }, [work, people]);
  const started = MODES.reduce((n, m) => n + counts[m].length, 0) + counts.break.length;
  const me = users.find((u) => u.id === meId);
  const canLog = me && me.role !== 'guest';
  const start = () => { setBusy(true); void startDay().then((l) => toast(l)).catch((e: Error) => toast(e.message, true)).finally(() => setBusy(false)); };
  return (
    <div className="card day-log">
      <div className="eyebrow">Day log · {started} of {people.length} started</div>
      <div className="day-log-grid">
        {MODES.map((m) => (
          <div key={m} className={`day-log-cell${counts[m].length ? ' some' : ''}`}>
            <span className="day-k"><PlaceGlyph mode={m} size={13} />{MODE_SHORT[m]}</span>
            <span className="day-log-n">{counts[m].length}</span>
          </div>
        ))}
      </div>
      {counts.break.length > 0 && <div className="day-log-out mono">STEPPED OUT · {counts.break.length}</div>}
      {started > 0 ? (
        <div className="day-log-faces">
          {[...MODES.flatMap((m) => counts[m]), ...counts.break].slice(0, 14).map((u) => (
            <button key={u.id} className="team-face" title={`${u.displayName}${u.id === meId ? ' (you)' : ''}`} onClick={() => onPerson(u.id)}>
              <Avatar user={u} presence={presenceFor(u.id)} size="sm" />
            </button>
          ))}
        </div>
      ) : <p className="faint day-log-empty">No one has started their day yet.</p>}
      {canLog && <MyDayLine mine={mine} now={now} busy={busy} onStart={start} />}
    </div>
  );
}

function MyDayLine({ mine, now, busy, onStart }: { mine: LiveWork | undefined; now: number; busy: boolean; onStart: () => void }) {
  if (!mine || mine.status === 'out') {
    return (
      <div className="day-log-me">
        <span className="faint">{mine?.workedTodayMs ? `You closed your day · ${duration(mine.workedTodayMs)}` : 'Not started yet'}</span>
        {!mine?.workedTodayMs && <button className="btn sm" disabled={busy} onClick={onStart}><Icon name="play" size={13} />Start my day · {MODE_SHORT[lastPlace()]}</button>}
      </div>
    );
  }
  return (
    <div className="day-log-me">
      <span className="day-log-you"><b>You</b><span className="faint">{mine.status === 'break' ? 'Stepped out' : MODE_SHORT[mine.mode ?? 'office']}</span></span>
      <DayScale ms={workedNow(mine, now)} out={mine.status === 'break'} />
      <span className="mono">{duration(workedNow(mine, now))}</span>
    </div>
  );
}

// ------------------------------------------------------------------ reports
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
type Range = 'week' | 'last-week' | 'month' | 'last-month';
function rangeOf(r: Range): { from: string; to: string; label: string } {
  const now = new Date();
  if (r === 'week' || r === 'last-week') {
    const mon = new Date(now); mon.setDate(now.getDate() - ((now.getDay() + 6) % 7) - (r === 'last-week' ? 7 : 0));
    const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
    return { from: ymd(mon), to: ymd(sun), label: r === 'week' ? 'This week' : 'Last week' };
  }
  const first = new Date(now.getFullYear(), now.getMonth() - (r === 'last-month' ? 1 : 0), 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  return { from: ymd(first), to: ymd(last), label: first.toLocaleDateString([], { month: 'long', year: 'numeric' }) };
}
const RANGES: Array<{ value: Range; label: string }> = [
  { value: 'week', label: 'This week' }, { value: 'last-week', label: 'Last week' }, { value: 'month', label: 'This month' }, { value: 'last-month', label: 'Last month' },
];

function useReport(range: Range, userIds?: string[]) {
  const [days, setDays] = useState<AttendanceDay[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = `${range}|${userIds?.join(',') ?? ''}`;
  const version = useWork();
  useEffect(() => {
    let alive = true;
    const { from, to } = rangeOf(range);
    window.dex.request('work.report', { from, to, userIds }).then((r) => { if (alive) { setDays(r.days); setError(null); } }).catch((e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; };
    // refresh when anyone's day changes (closing a day adds a row)
  }, [key, version]); // eslint-disable-line react-hooks/exhaustive-deps
  return { days, error };
}

const dayLabel = (date: string) => new Date(`${date}T00:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const places = (d: AttendanceDay) => d.modes.map((m) => MODE_SHORT[m]).join(' + ');

export function Timesheet({ me }: { me: PublicUser }) {
  const [range, setRange] = useState<Range>('week');
  const { days, error } = useReport(range, [me.id]);
  const total = (days ?? []).reduce((n, d) => n + d.workedMs, 0);
  const exportCsv = () => {
    const { from, to } = rangeOf(range);
    downloadText(`timesheet-${me.account.split('\\').pop()}-${from}-to-${to}.csv`, toCsv([
      ['Date', 'Day started', 'Day closed', 'Worked (hours)', 'Stepped out (minutes)', 'Place', 'Note'],
      ...(days ?? []).map((d) => [d.date, clockTime(d.firstIn), d.lastOut ? clockTime(d.lastOut) : 'still open', (d.workedMs / 3600_000).toFixed(2), Math.round(d.breakMs / 60_000), places(d), d.autoClosed ? 'closed automatically at the last activity' : '']),
    ]));
  };
  return (
    <div className="timesheet">
      <div className="toolbar">
        <Segmented<Range> label="Period" value={range} onChange={setRange} options={RANGES} />
        <span className="day-total"><span className="day-k">Total</span><b className="mono">{duration(total)}</b></span>
        <span style={{ flex: 1 }} />
        <button className="btn" disabled={!days?.length} onClick={exportCsv}><Icon name="download" size={15} />Export CSV</button>
      </div>
      {error && <div className="error-box">{error}</div>}
      {days && days.length === 0 && <div className="empty desk-empty"><Icon name="clock" size={36} /><span>No working time for {rangeOf(range).label.toLowerCase()}. Start your day from the menu on your own tile, top right.</span></div>}
      {days && days.length > 0 && (
        <table className="att-table">
          <thead><tr><th>Day</th><th>Started</th><th>Closed</th><th>Stepped out</th><th>Place</th><th className="num">Worked</th></tr></thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.date}>
                <td>{dayLabel(d.date)}</td>
                <td className="mono">{clockTime(d.firstIn)}</td>
                <td className="mono">{d.lastOut ? clockTime(d.lastOut) : <span className="chip ok">Open</span>}{d.autoClosed && <span className="chip warn" title="Your day was not closed; it was closed at your last activity">auto</span>}</td>
                <td className="mono">{d.breakMs ? duration(d.breakMs) : '–'}</td>
                <td>{places(d)}</td>
                <td className="num mono"><span className="att-bar" style={{ width: `${Math.min(100, (d.workedMs / (10 * 3600_000)) * 100)}%` }} /><span className="att-val">{duration(d.workedMs)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** The team's day log: hours per person per day, coloured by place. */
export function TeamDayLog({ users, meId, isAdmin }: { users: PublicUser[]; meId: string; isAdmin: boolean }) {
  const [range, setRange] = useState<Range>('week');
  const { days, error } = useReport(range);
  const byUser = useMemo(() => {
    const m = new Map<string, AttendanceDay[]>();
    for (const d of days ?? []) m.set(d.userId, [...(m.get(d.userId) ?? []), d]);
    return m;
  }, [days]);
  const { from, to } = rangeOf(range);
  const dates = useMemo(() => {
    const out: string[] = [];
    const d = new Date(`${from}T00:00:00`);
    const end = new Date(`${to}T00:00:00`);
    while (d <= end && out.length < 31) { out.push(ymd(d)); d.setDate(d.getDate() + 1); }
    return out;
  }, [from, to]);
  const people = users.filter((u) => u.role !== 'bot' && (isAdmin || byUser.has(u.id) || u.id === meId || u.profile.managerId === meId))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  const exportCsv = () => {
    const name = new Map(users.map((u) => [u.id, u] as const));
    downloadText(`day-log-${from}-to-${to}.csv`, toCsv([
      ['Name', 'Account', 'Date', 'Day started', 'Day closed', 'Worked (hours)', 'Stepped out (minutes)', 'Place', 'Closed automatically'],
      ...(days ?? []).map((d) => [name.get(d.userId)?.displayName ?? '', name.get(d.userId)?.account ?? '', d.date, clockTime(d.firstIn), d.lastOut ? clockTime(d.lastOut) : '', (d.workedMs / 3600_000).toFixed(2), Math.round(d.breakMs / 60_000), places(d), d.autoClosed ? 'yes' : '']),
    ]));
  };
  return (
    <div className="attendance">
      <div className="toolbar">
        <Segmented<Range> label="Period" value={range} onChange={setRange} options={RANGES} />
        <span style={{ flex: 1 }} />
        <button className="btn" disabled={!days?.length} onClick={exportCsv}><Icon name="download" size={15} />Export CSV</button>
      </div>
      {error && <div className="error-box">{error}</div>}
      <div className="att-grid-wrap">
        <table className="att-table att-grid">
          <thead>
            <tr><th>Person</th>{dates.map((d) => <th key={d} className="num" title={d}>{range.includes('month') ? new Date(`${d}T00:00:00`).getDate() : dayLabel(d).split(',')[0]}</th>)}<th className="num">Total</th></tr>
          </thead>
          <tbody>
            {people.map((u) => {
              const mine = new Map((byUser.get(u.id) ?? []).map((d) => [d.date, d] as const));
              const total = (byUser.get(u.id) ?? []).reduce((n, d) => n + d.workedMs, 0);
              return (
                <tr key={u.id}>
                  <td><span className="att-person"><Avatar user={u} presence={presenceFor(u.id)} size="sm" />{u.displayName}</span></td>
                  {dates.map((d) => {
                    const day = mine.get(d);
                    return (
                      <td key={d} className={`num att-cell${day ? ` m-${day.modes[0] ?? 'office'}` : ''}${day?.autoClosed ? ' auto' : ''}`}
                        title={day ? `${clockTime(day.firstIn)} – ${day.lastOut ? clockTime(day.lastOut) : 'now'} · ${places(day)}` : ''}>
                        {day ? (day.workedMs / 3600_000).toFixed(1) : ''}
                      </td>
                    );
                  })}
                  <td className="num mono"><b>{(total / 3600_000).toFixed(1)}</b></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="att-legend faint">
        {MODES.map((m) => <span key={m}><i className={`m-${m}`} />{MODE_SHORT[m]}</span>)}
        <span>Hours worked, not counting time stepped out. Hover a cell for the times.</span>
      </div>
    </div>
  );
}
