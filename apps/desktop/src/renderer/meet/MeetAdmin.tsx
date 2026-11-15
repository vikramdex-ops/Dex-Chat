// The Control room's meeting settings (lobby default, join before the host, guest links, the
// largest recording kept on the hub) and the meeting totals on its Usage page (meetings per week,
// hours, average size, guests from a browser, recordings), with a CSV export.
import { useEffect, useState } from 'react';
import type { LobbyRule, MeetingUsage, OfficePolicy } from '@dex/core';
import { usageCsv } from '@dex/core/meet-csv';
import { Icon, Segmented, Toggle, useToast } from '../ui.tsx';
import { formatSize } from '../chat/files.tsx';
import { saveText } from './GuestLink.tsx';

const LOBBY: Array<[LobbyRule, string]> = [['outside', 'Guests and people from outside wait'], ['everyone', 'Everyone waits to be let in'], ['off', 'Nobody waits']];
const REC_MB: Array<[number, string]> = [[250, '250 MB'], [500, '500 MB'], [1024, '1 GB'], [2048, '2 GB'], [4096, '4 GB'], [8192, '8 GB']];

export function MeetingPolicies({ p, save }: { p: OfficePolicy; save: (patch: Partial<OfficePolicy>) => void }) {
  const recOptions = REC_MB.some(([v]) => v === p.recordingMaxMb) ? REC_MB : [...REC_MB, [p.recordingMaxMb ?? 2048, `${p.recordingMaxMb} MB`] as [number, string]].sort((a, b) => a[0] - b[0]);
  return (
    <section className="card">
      <div className="eyebrow">Meetings</div>
      <div className="form-row" style={{ marginTop: 6 }}>
        <div className="field"><label htmlFor="p-lobby">New meetings: who waits in the lobby</label>
          <select id="p-lobby" className="input" value={p.meetingLobby ?? 'outside'} onChange={(e) => save({ meetingLobby: e.target.value as LobbyRule })}>
            {LOBBY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select></div>
        <div className="field"><label htmlFor="p-recmb">Largest recording kept on the hub</label>
          <select id="p-recmb" className="input" value={p.recordingMaxMb ?? 2048} onChange={(e) => save({ recordingMaxMb: Number(e.target.value) })}>
            {recOptions.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select></div>
      </div>
      <div className="setting" style={{ marginTop: 12 }}>
        <div className="txt"><div>People can join new meetings before the host</div><div className="faint">Personal rooms always wait for their owner. Hosts can change it for each meeting.</div></div>
        <Toggle label="People can join new meetings before the host" checked={p.joinBeforeHost !== false} onChange={(v) => save({ joinBeforeHost: v })} />
      </div>
      <div className="setting">
        <div className="txt"><div>Hosts can invite guests who join from a browser</div><div className="faint">Through the internet gateway, with a passcode in the link. Guests always wait in the lobby, see only the meeting, and cannot join meetings of more than 8 people (those run on the office relay). Off: every guest link stops working.</div></div>
        <Toggle label="Hosts can invite guests who join from a browser" checked={p.guestLinks !== false} onChange={(v) => save({ guestLinks: v })} />
      </div>
      <p className="faint" style={{ fontSize: 12.5, margin: '10px 0 0' }}>Recordings follow the retention set in Compliance (as Space or Direct messages, by the meeting's conversation), and legal holds keep them. Every download is in the audit log.</p>
    </section>
  );
}

/** Meeting totals for the Usage page: by week, with a CSV. */
export function MeetingTotals() {
  const toast = useToast();
  const [days, setDays] = useState<28 | 91 | 182>(91);
  const [u, setU] = useState<MeetingUsage | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setTry] = useState(0);
  useEffect(() => { setU(null); setProblem(null); void window.dex.request('admin.meetings.usage', { days }).then(setU).catch((e: Error) => setProblem(e.message)); }, [days, attempt]);
  const max = Math.max(1, ...(u?.weeks ?? []).map((w) => w.meetings));
  return (
    <section className="card meet-totals">
      <div className="meet-totals-head">
        <div className="eyebrow">Meetings by week</div>
        <Segmented<'28' | '91' | '182'> label="Period" value={String(days) as '28' | '91' | '182'} onChange={(v) => setDays(Number(v) as 28 | 91 | 182)} options={[
          { value: '28', label: '4 weeks' }, { value: '91', label: '13 weeks' }, { value: '182', label: '26 weeks' },
        ]} />
        <button className="btn ghost sm" disabled={!u} onClick={() => { if (!u) return; saveText(`Meetings by week ${new Date().toISOString().slice(0, 10)}.csv`, usageCsv(u), 'text/csv;charset=utf-8'); toast('Saved as CSV'); }}><Icon name="download" size={14} />Export CSV</button>
      </div>
      {!u ? (problem ? <p className="load-problem" role="alert"><Icon name="warning" size={15} /><span><b>Meeting totals could not be loaded</b> · {problem}</span><button className="btn ghost sm" onClick={() => setTry((n) => n + 1)}>Try again</button></p> : <div className="tl-more"><span className="spinner" /></div>) : (
        <>
          <div className="usage-tiles">
            <div className="card tile"><span className="eyebrow">Meetings</span><b>{u.totals.meetings}</b><span className="faint">{(u.totals.meetings / Math.max(1, u.weeks.length)).toFixed(1)} a week</span></div>
            <div className="card tile"><span className="eyebrow">Hours</span><b>{u.totals.hours}</b><span className="faint">in meetings of two or more</span></div>
            <div className="card tile"><span className="eyebrow">Average size</span><b>{u.totals.averageSize}</b><span className="faint">people a meeting</span></div>
            <div className="card tile"><span className="eyebrow">Recordings</span><b>{u.totals.recordings}</b><span className="faint">{formatSize(u.totals.recordingBytes)} on the hub · {u.totals.guests} browser guests</span></div>
          </div>
          <div className="usage-table"><table>
            <thead><tr><th>Week of</th><th>Meetings</th><th>Hours</th><th>Average size</th><th>Guests</th><th aria-hidden="true" /></tr></thead>
            <tbody>{[...u.weeks].reverse().map((w) => (
              <tr key={w.week}><td className="mono">{w.week}</td><td>{w.meetings}</td><td>{w.hours}</td><td>{w.averageSize || '·'}</td><td>{w.guests || '·'}</td>
                <td className="meet-week-bar"><i style={{ width: `${(w.meetings / max) * 100}%` }} /></td></tr>
            ))}</tbody>
          </table></div>
        </>
      )}
    </section>
  );
}
