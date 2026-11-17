// Control room → Bots & tools → Office holidays (docs/HOLIDAYS.md): the office's days off by year,
// each with its kind and where it came from (the circular's reference, the file and its
// fingerprint, or typed in here), the circulars registered, "Read a holiday circular…" (the same
// card Nib shows), and a day added or removed by hand. Scheduled jobs, Nib's day sheets and
// hot-desk booking skip every day off here and work on a compensatory working day.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Ops, PublicUser } from '@dex/core';
import type { CircularRecord, HolidayReadView, OfficeDay, OfficeDayKind } from '@dex/core/holidays';
import { Icon, useToast } from '../ui.tsx';
import { HolidayCircularCard, KIND_WORD, longDate } from '../nib/holidays.tsx';

const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dow = (d: string) => new Date(`${d}T12:00:00`).getDay();
const when = (t: number) => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });

export function OfficeHolidays({ users }: { users: PublicUser[] }) {
  const toast = useToast();
  const [days, setDays] = useState<OfficeDay[] | null>(null);
  const [circulars, setCirculars] = useState<CircularRecord[]>([]);
  const [year, setYear] = useState<number>(() => new Date().getFullYear());
  const [read, setRead] = useState<HolidayReadView | null>(null);
  const [reading, setReading] = useState(false);
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<OfficeDayKind>('holiday');
  const file = useRef<HTMLInputElement>(null);
  const people = useMemo(() => new Map(users.map((u) => [u.id, u] as const)), [users]);
  const load = useCallback(() => void window.dex.request('botjob.calendar').then((c: Ops['botjob.calendar']['res']) => {
    setDays(c.days ?? c.holidays.map((h) => ({ date: h.date, name: h.name, kind: 'holiday' as const })));
    setCirculars(c.circulars ?? []);
  }).catch(() => setDays([])), []);
  useEffect(() => { load(); }, [load]);

  const years = useMemo(() => [...new Set([new Date().getFullYear(), ...(days ?? []).map((d) => Number(d.date.slice(0, 4)))])].sort((a, b) => a - b), [days]);
  const shown = (days ?? []).filter((d) => d.date.startsWith(`${year}-`));
  const save = (next: OfficeDay[]) => void window.dex.request('admin.botjob.holidays', { holidays: next.map((d) => ({ date: d.date, name: d.name, kind: d.kind, for: d.for ?? null })) })
    .then((r) => { setDays(r.holidays); toast('Office holidays saved'); }).catch((e: Error) => toast(e.message, true));

  const pick = async (f: File | undefined) => {
    if (!f || !window.dex.uploadFile) return;
    setReading(true);
    try {
      const info = await window.dex.uploadFile(`circular-${Date.now().toString(36)}`, { data: await f.arrayBuffer(), name: f.name, mime: 'application/pdf' });
      setRead(await window.dex.request('nib.holidays.read', { fileId: info.id }));
    } catch (e) { toast((e as Error).message, true); } finally { setReading(false); if (file.current) file.current.value = ''; }
  };

  return (
    <section className="bots-holidays" aria-labelledby="bots-hol-h" id="office-holidays">
      <div className="hol-admin-head">
        <h3 id="bots-hol-h" className="label">Office holidays</h3>
        {window.dex.uploadFile && (
          <>
            <input ref={file} type="file" accept="application/pdf,.pdf" hidden aria-hidden="true" tabIndex={-1} onChange={(e) => void pick(e.target.files?.[0])} />
            <button className="btn sm" disabled={reading} onClick={() => file.current?.click()}>{reading ? <span className="spinner" /> : <Icon name="doc" size={14} />}Read a holiday circular…</button>
          </>
        )}
      </div>
      <p className="faint" style={{ margin: '0 0 8px', fontSize: 12.5 }}>Scheduled bot jobs, Nib’s day sheets and hot-desk booking skip every day off here. Compensatory working days are worked, even on a day the office does not normally work (Control room → Nib & day sheets). You can also give the circular’s PDF to Nib.</p>
      {read && (
        <div className="hol-admin-read">
          <HolidayCircularCard v={read} users={people} onChange={(v) => { setRead(v); if (v.state === 'registered') { load(); if (v.read?.year) setYear(v.read.year); } }} />
          <button className="btn ghost sm" onClick={() => setRead(null)}>Close</button>
        </div>
      )}
      <div className="seg hol-years" role="tablist" aria-label="Year">
        {years.map((y) => <button key={y} role="tab" aria-selected={y === year} aria-pressed={y === year} onClick={() => setYear(y)}>{String(y)}</button>)}
      </div>
      <div className="list hol-list">
        {shown.map((h) => (
          <div key={h.date} className={`list-row hol-day k-${h.kind}`}>
            <span className="hol-day-when"><span className="mono">{h.date}</span><span className="faint">{DAY_SHORT[dow(h.date)]}</span></span>
            <span className="grow hol-day-what">
              <span translate="no">{h.name}</span>
              {h.kind === 'compwork' && h.for && <span className="faint hol-for">{`Working day, makes up for ${longDate(h.for)}`}</span>}
              <span className="mono faint hol-prov" title={h.source?.hash}>
                {h.source ? <span translate="no">{[h.source.ref ? `Ref ${h.source.ref}` : null, h.source.file, `SHA ${h.source.hash.slice(0, 8)}`, h.source.sl !== null ? `Sl. ${h.source.sl}` : null].filter(Boolean).join(' · ')}</span> : <span>Added by hand</span>}
              </span>
            </span>
            <span className={`hol-kind k-${h.kind}`}>{KIND_WORD[h.kind]}</span>
            <button type="button" className="icon-btn sm" aria-label={`Remove ${h.name}`} onClick={() => days && save(days.filter((x) => x.date !== h.date))}><Icon name="trash" size={14} /></button>
          </div>
        ))}
        {days && shown.length === 0 && <div className="list-row faint">{`No office holidays for ${year} yet. Read the year’s circular, or add days below.`}</div>}
      </div>
      <form className="row-actions hol-add" style={{ marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); if (!date || !name.trim() || !days) return; save([...days.filter((x) => x.date !== date), { date, name: name.trim(), kind }]); setDate(''); setName(''); }}>
        <input className="input" type="date" aria-label="Holiday date" value={date} onChange={(e) => setDate(e.target.value)} />
        <input className="input" aria-label="Holiday name" placeholder="Diwali" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        <select className="input" aria-label="Kind of day" value={kind} onChange={(e) => setKind(e.target.value as OfficeDayKind)}>
          {(['holiday', 'weekoff', 'compoff', 'compwork'] as const).map((k) => <option key={k} value={k}>{KIND_WORD[k]}</option>)}
        </select>
        <button className="btn" disabled={!date || !name.trim()}><Icon name="plus" size={14} />Add day</button>
      </form>
      {circulars.length > 0 && (
        <div className="hol-circulars">
          <h4 className="label">Circulars registered</h4>
          <ul>
            {circulars.map((c) => (
              <li key={c.hash}>
                <span className="mono" translate="no">{c.ref ? `Ref ${c.ref}` : c.file}</span>
                {c.refDate && <span className="faint">{longDate(c.refDate)}</span>}
                <span className="faint" translate="no">{c.file}</span>
                <span className="mono faint" title={c.hash} translate="no">{`SHA ${c.hash.slice(0, 8)}`}</span>
                <span className="faint">{c.by ? `Registered on ${when(c.at)} by ${people.get(c.by)?.displayName ?? 'an administrator'}` : `Built into the hub on ${when(c.at)}`}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
