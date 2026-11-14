// Remote work in the UI: the work clock in the title bar, the "today" card on Pulse, your
// timesheet on the Desk, and team attendance (with CSV export) in the Directory.
import { useEffect, useMemo, useRef, useState } from 'react';
import { toCsv } from '@dex/core';
import type { AttendanceDay, PublicUser, WorkMode, WorkState } from '@dex/core';
import { Avatar, Icon, Popover, Segmented, presenceFor, useToast } from '../ui.tsx';
import type { IconName } from '../ui.tsx';
import { MODES, MODE_LABEL, MODE_SHORT, downloadText, duration, setWork, useWork, workedNow } from './store.ts';

const MODE_ICON: Record<WorkMode, IconName> = { office: 'home', home: 'laptop', site: 'drawing', client: 'people' };
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function useTick(ms: number, on: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, on]);
  return now;
}

const act = async (p: Promise<WorkState>) => { setWork(await p); };

// ------------------------------------------------------------------ title bar clock
export function WorkClock({ meId, live, role }: { meId: string; live: boolean; role: PublicUser['role'] }) {
  const toast = useToast();
  const mine = useWork().get(meId);
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const now = useTick(30_000, mine?.status === 'in');
  if (role === 'bot' || role === 'guest') return null;
  const run = (p: Promise<WorkState>, ok: string) => { setOpen(false); void act(p).then(() => toast(ok)).catch((e: Error) => toast(e.message, true)); };
  const status = mine?.status ?? 'out';
  return (
    <>
      <button ref={btn} className={`work-pill ${status}`} disabled={!live} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}
        title={status === 'out' ? 'Check in for the day' : 'Your working day'}>
        {status === 'out' ? <><Icon name="clock" size={15} /><span>Check in</span></> : (
          <>
            <span className="work-dot" />
            <span className="mono">{duration(workedNow(mine, now))}</span>
            <span className="work-mode">{status === 'break' ? 'Break' : MODE_SHORT[mine!.mode!]}</span>
          </>
        )}
      </button>
      {open && (
        <Popover anchor={btn.current} onClose={() => setOpen(false)} className="menu work-menu">
          {status === 'out' ? (
            <>
              <div className="menu-label label">Check in · where are you working?</div>
              {MODES.map((m) => (
                <button key={m} role="menuitem" onClick={() => run(window.dex.request('work.checkIn', { mode: m }), `Checked in · ${MODE_LABEL[m].toLowerCase()}`)}>
                  <Icon name={MODE_ICON[m]} size={16} />{MODE_LABEL[m]}
                </button>
              ))}
            </>
          ) : (
            <>
              <div className="work-summary">
                <div className="label">Today</div>
                <div className="work-big mono">{duration(workedNow(mine, now))}</div>
                <div className="faint">Checked in at {clock(mine!.checkedInAt ?? mine!.since ?? now)}{status === 'break' && mine!.since ? ` · on a break since ${clock(mine!.since)}` : ''}</div>
              </div>
              <div className="menu-sep" />
              {status === 'in'
                ? <button role="menuitem" onClick={() => run(window.dex.request('work.break', { on: true }), 'Enjoy your break')}><Icon name="clock" size={16} />Take a break</button>
                : <button role="menuitem" onClick={() => run(window.dex.request('work.break', { on: false }), 'Welcome back')}><Icon name="play" size={16} />End break</button>}
              <div className="menu-label label">Working from</div>
              {MODES.map((m) => (
                <button key={m} role="menuitemradio" aria-checked={mine!.mode === m} onClick={() => run(window.dex.request('work.setMode', { mode: m }), MODE_LABEL[m])}>
                  <Icon name={MODE_ICON[m]} size={16} />{MODE_LABEL[m]}{mine!.mode === m && <Icon name="check" size={15} />}
                </button>
              ))}
              <div className="menu-sep" />
              <button role="menuitem" className="danger" onClick={() => run(window.dex.request('work.checkOut'), `Checked out · ${duration(workedNow(mine, Date.now()))} today`)}><Icon name="power" size={16} />Check out</button>
            </>
          )}
        </Popover>
      )}
    </>
  );
}

// ------------------------------------------------------------------ Pulse: who's working
export function TeamToday({ users, meId, onPerson }: { users: PublicUser[]; meId: string; onPerson: (id: string) => void }) {
  const work = useWork();
  const people = users.filter((u) => u.role !== 'bot');
  const counts = useMemo(() => {
    const c: Record<WorkMode | 'break', PublicUser[]> = { office: [], home: [], site: [], client: [], break: [] };
    for (const u of people) {
      const s = work.get(u.id);
      if (s?.status === 'break') c.break.push(u);
      else if (s?.status === 'in' && s.mode) c[s.mode].push(u);
    }
    return c;
  }, [work, people]);
  const working = MODES.reduce((n, m) => n + counts[m].length, 0) + counts.break.length;
  return (
    <div className="card team-today">
      <div className="eyebrow">Working today · {working} of {people.length}</div>
      <div className="team-bars">
        {MODES.map((m) => (
          <div key={m} className="team-bar">
            <span className="team-bar-label"><Icon name={MODE_ICON[m]} size={14} />{MODE_SHORT[m]}</span>
            <span className="team-bar-track"><span style={{ width: `${people.length ? (counts[m].length / people.length) * 100 : 0}%` }} /></span>
            <span className="mono team-bar-n">{counts[m].length}</span>
          </div>
        ))}
      </div>
      {working > 0 && (
        <div className="team-faces">
          {[...MODES.flatMap((m) => counts[m]), ...counts.break].slice(0, 14).map((u) => (
            <button key={u.id} className="team-face" title={`${u.displayName}${u.id === meId ? ' (you)' : ''}`} onClick={() => onPerson(u.id)}>
              <Avatar user={u} presence={presenceFor(u.id)} size="sm" />
            </button>
          ))}
        </div>
      )}
      {working === 0 && <p className="faint" style={{ margin: '8px 0 0' }}>No one has checked in yet today.</p>}
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
    // refresh when anyone's state changes (a check-out adds a row)
  }, [key, version]); // eslint-disable-line react-hooks/exhaustive-deps
  return { days, error };
}

const dayLabel = (date: string) => new Date(`${date}T00:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });

export function Timesheet({ me }: { me: PublicUser }) {
  const [range, setRange] = useState<Range>('week');
  const { days, error } = useReport(range, [me.id]);
  const total = (days ?? []).reduce((n, d) => n + d.workedMs, 0);
  const exportCsv = () => {
    const { from, to } = rangeOf(range);
    downloadText(`timesheet-${me.account.split('\\').pop()}-${from}-to-${to}.csv`, toCsv([
      ['Date', 'Checked in', 'Checked out', 'Worked (hours)', 'Breaks (minutes)', 'Where', 'Note'],
      ...(days ?? []).map((d) => [d.date, clock(d.firstIn), d.lastOut ? clock(d.lastOut) : 'still in', (d.workedMs / 3600_000).toFixed(2), Math.round(d.breakMs / 60_000), d.modes.map((m) => MODE_SHORT[m]).join(' + '), d.autoClosed ? 'check-out added automatically' : '']),
    ]));
  };
  return (
    <div className="timesheet">
      <div className="toolbar">
        <Segmented<Range> label="Period" value={range} onChange={setRange} options={[
          { value: 'week', label: 'This week' }, { value: 'last-week', label: 'Last week' }, { value: 'month', label: 'This month' }, { value: 'last-month', label: 'Last month' },
        ]} />
        <span className="faint">Total <b className="mono">{duration(total)}</b></span>
        <span style={{ flex: 1 }} />
        <button className="btn" disabled={!days?.length} onClick={exportCsv}><Icon name="download" size={15} />Export CSV</button>
      </div>
      {error && <div className="error-box">{error}</div>}
      {days && days.length === 0 && <div className="empty desk-empty"><Icon name="clock" size={36} /><span>No working time recorded for {rangeOf(range).label.toLowerCase()}. Check in from the clock at the top of the window.</span></div>}
      {days && days.length > 0 && (
        <table className="att-table">
          <thead><tr><th>Day</th><th>In</th><th>Out</th><th>Breaks</th><th>Where</th><th className="num">Worked</th></tr></thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.date}>
                <td>{dayLabel(d.date)}</td>
                <td className="mono">{clock(d.firstIn)}</td>
                <td className="mono">{d.lastOut ? clock(d.lastOut) : <span className="chip ok">In now</span>}{d.autoClosed && <span className="chip warn" title="You did not check out; it was closed at your last activity">auto</span>}</td>
                <td className="mono">{d.breakMs ? duration(d.breakMs) : '–'}</td>
                <td>{d.modes.map((m) => MODE_SHORT[m]).join(' + ')}</td>
                <td className="num mono"><span className="att-bar" style={{ width: `${Math.min(100, (d.workedMs / (10 * 3600_000)) * 100)}%` }} /><span className="att-val">{duration(d.workedMs)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function TeamAttendance({ users, meId, isAdmin }: { users: PublicUser[]; meId: string; isAdmin: boolean }) {
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
    downloadText(`attendance-${from}-to-${to}.csv`, toCsv([
      ['Name', 'Account', 'Date', 'Checked in', 'Checked out', 'Worked (hours)', 'Breaks (minutes)', 'Where', 'Auto check-out'],
      ...(days ?? []).map((d) => [name.get(d.userId)?.displayName ?? '', name.get(d.userId)?.account ?? '', d.date, clock(d.firstIn), d.lastOut ? clock(d.lastOut) : '', (d.workedMs / 3600_000).toFixed(2), Math.round(d.breakMs / 60_000), d.modes.map((m) => MODE_SHORT[m]).join(' + '), d.autoClosed ? 'yes' : '']),
    ]));
  };
  return (
    <div className="attendance">
      <div className="toolbar">
        <Segmented<Range> label="Period" value={range} onChange={setRange} options={[
          { value: 'week', label: 'This week' }, { value: 'last-week', label: 'Last week' }, { value: 'month', label: 'This month' }, { value: 'last-month', label: 'Last month' },
        ]} />
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
                        title={day ? `${clock(day.firstIn)} – ${day.lastOut ? clock(day.lastOut) : 'now'} · ${day.modes.map((m) => MODE_SHORT[m]).join(' + ')}` : ''}>
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
        <span>Hours worked, excluding breaks. Hover a cell for times.</span>
      </div>
    </div>
  );
}
