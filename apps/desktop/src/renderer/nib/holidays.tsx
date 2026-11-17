// A holiday circular as Nib read it (docs/HOLIDAYS.md): the reference, the period and the file it
// came from, the days counted by kind, each row with its date, weekday, description, kind and
// check, the rows in doubt (never registered), what it changes against the days registered, and
// Register for an administrator. A scan with no text is read on this PC first. Drawn in the
// conversation with Nib and in Control room → Bots & tools → Office holidays.
import { useState } from 'react';
import type { CircularProblem, CircularRow, CircularWarning, HolidayReadView, OfficeDayKind } from '@dex/core/holidays';
import { Icon, useToast } from '../ui.tsx';
import { NibTile } from './NibMark.tsx';
import { canReadScans, readScanText } from '../ocr.ts';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const KIND_WORD: Record<OfficeDayKind, string> = { holiday: 'Holiday', weekoff: 'Week-off', compoff: 'Compensatory off', compwork: 'Compensatory work' };
/** The heading of each count: plural, as a column head. */
const KIND_HEAD: Record<OfficeDayKind, string> = { holiday: 'Holidays', weekoff: 'Week-offs', compoff: 'Comp. off', compwork: 'Comp. work' };
const KINDS: OfficeDayKind[] = ['holiday', 'weekoff', 'compoff', 'compwork'];

export const longDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
const stamp = (t: number) => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
const shortHash = (h: string) => h.slice(0, 8);
const daysWord = (n: number) => (n === 1 ? 'Register 1 day' : `Register ${n} days`);

function problemWords(p: CircularProblem, r: CircularRow, year: number | null): string {
  switch (p.code) {
    case 'date': return `The date “${r.dateText}” could not be read.`;
    case 'weekday': return r.date ? `${longDate(r.date)} is a ${DAY_NAMES[p.actual]}, not a ${r.dayText ?? ''}.` : 'The weekday does not match the date.';
    case 'year': return year ? `${p.year} is outside the circular’s year, ${year}.` : `${p.year} is outside the circular’s period.`;
    case 'dupDate': return p.sl !== null ? `Row ${p.sl} has the same date.` : 'Another row has the same date.';
    case 'forMissing': return p.for ? `It makes up for ${longDate(p.for)}, which is not a day off in this circular.` : 'It does not say which day off it makes up for.';
    case 'unknown': return 'There is no description, so the kind of day is not clear.';
  }
}
function warningWords(w: CircularWarning, year: number | null): string {
  switch (w.code) {
    case 'serialGap': return `Row ${w.next} follows row ${w.after}: a row may be missing.`;
    case 'serialDup': return `Row number ${w.sl} is used twice.`;
    case 'noPeriod': return year ? `The circular does not state its period: read as ${year}.` : 'The circular does not state its period.';
  }
}

function Frame({ caption, title, no, children }: { caption: string; title: string; no?: string | null; children: React.ReactNode }) {
  return (
    <div className="nib-card k-holidays">
      <div className="nib-card-tb">
        <NibTile size={20} />
        <span className="mono nib-card-kind">{caption}</span>
        <span className="nib-card-title" translate="no">{title}</span>
        {no && <span className="mono nib-card-no" translate="no">{no}</span>}
      </div>
      <div className="nib-card-body">{children}</div>
    </div>
  );
}

/** Where the circular came from: Ref, its date, the file and its fingerprint. */
function Source({ v }: { v: HolidayReadView }) {
  const r = v.read;
  return (
    <p className="mono hol-source">
      {r?.ref && <span translate="no">{`Ref ${r.ref}`}</span>}
      {r?.refDate && <span>{longDate(r.refDate)}</span>}
      <span translate="no">{v.file}</span>
      {v.hash && <span title={v.hash} translate="no">{`SHA ${shortHash(v.hash)}`}</span>}
    </p>
  );
}

function Counts({ counts, doubt }: { counts: Record<OfficeDayKind, number>; doubt: number }) {
  return (
    <div className="nib-head-cells hol-counts" role="list" aria-label="Days by kind">
      {KINDS.map((k) => <div key={k} role="listitem" className="nib-head-cell"><span className="nib-head-n">{counts[k]}</span><span className="label">{KIND_HEAD[k]}</span></div>)}
      <div role="listitem" className={`nib-head-cell${doubt ? ' warn' : ' ok'}`}><span className="nib-head-n">{doubt}</span><span className="label">In doubt</span></div>
    </div>
  );
}

const CHANGE_WORD = { new: 'New', unchanged: 'Same', updated: 'Changed' } as const;

/** One row of the circular: Sl, the date and weekday as written, the description, the kind and its check. */
function Row({ r, change, year }: { r: CircularRow; change: 'new' | 'unchanged' | 'updated' | null; year: number | null }) {
  const bad = r.problems.length > 0;
  return (
    <li className={`hol-row${bad ? ' bad' : ''}`}>
      <span className="mono hol-sl" aria-label={r.sl !== null ? `Row ${r.sl}` : undefined}>{r.sl ?? '–'}</span>
      <span className="hol-when">
        <span className="mono" translate="no">{r.dateText}</span>
        {r.dayText && <span className="faint">{r.dayText}</span>}
      </span>
      <span className="hol-what">
        <span translate="no">{r.name || '—'}</span>
        {r.kind === 'compwork' && r.for && !bad && <span className="faint hol-for">{`Working day, makes up for ${longDate(r.for)}`}</span>}
        {bad && r.problems.map((p, i) => <span key={i} className="hol-problem"><Icon name="warning" size={12} />{problemWords(p, r, year)}</span>)}
      </span>
      <span className="hol-tags">
        {r.kind && <span className={`hol-kind k-${r.kind}`}>{KIND_WORD[r.kind]}</span>}
        {bad ? <span className="hol-check bad">Not registered</span> : change && <span className={`hol-check c-${change}`}>{CHANGE_WORD[change]}</span>}
      </span>
    </li>
  );
}

/** The card for one read circular. `onChange` gets the view after Register or after a scan is read. */
export function HolidayCircularCard({ v, onChange, users }: { v: HolidayReadView; onChange: (v: HolidayReadView) => void; users?: Map<string, { displayName: string }> }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);
  const [ocr, setOcr] = useState<string | null>(null);
  const r = v.read;
  const p = v.plan;
  if (v.state === 'denied') return <Frame caption="HOLIDAY CIRCULAR" title={v.file}><p className="nib-line">Office holidays are registered by an administrator. Send the circular to one of them.</p></Frame>;
  if (v.state === 'unreadable') return <Frame caption="HOLIDAY CIRCULAR" title={v.file}><p className="nib-line">I could not read that PDF.</p>{v.error && <p className="faint nib-fine">{v.error}</p>}</Frame>;
  if (v.state === 'notCircular') return <Frame caption="HOLIDAY CIRCULAR" title={v.file}><p className="nib-line">That PDF does not read like a holiday circular: there is no table of dates in it.</p>{v.ocr && <p className="faint nib-fine">Its text was read from a scan on this PC. A clearer scan, or the PDF with text, may do better.</p>}</Frame>;
  if (v.state === 'textless') {
    const readScan = async () => {
      if (!v.fileId) return;
      setBusy(true);
      try {
        const text = await readScanText({ id: v.fileId, name: v.file }, (n, of) => setOcr(`Reading page ${n} of ${of}…`));
        onChange(await window.dex.request('nib.holidays.read', { id: v.id, text }));
      } catch (e) { toast((e as Error).message || 'The scan could not be read on this PC.', true); } finally { setBusy(false); setOcr(null); }
    };
    return (
      <Frame caption="HOLIDAY CIRCULAR" title={v.file}>
        <p className="nib-line">This circular is a scan: there is no text in it for the hub to read.</p>
        {canReadScans() && v.fileId ? (
          <>
            <p className="faint nib-fine">This PC can read the pages itself and send the text. Check every row afterwards: a scan can be misread.</p>
            <div className="nib-card-actions">
              <button className="btn sm" disabled={busy} onClick={() => void readScan()}>{busy ? <span className="spinner" /> : <Icon name="eye" size={14} />}Read the scan on this PC</button>
              {ocr && <span className="faint nib-fine" role="status">{ocr}</span>}
            </div>
          </>
        ) : <p className="faint nib-fine">Ask for the circular as a PDF with text, or open this conversation on a PC to read the scan there.</p>}
      </Frame>
    );
  }
  if (!r || !p) return null;
  const change = new Map(p.rows.map((x) => [`${x.sl}|${x.date}`, x.change] as const));
  const ordered = [...r.rows].sort((a, b) => Number(b.problems.length > 0) - Number(a.problems.length > 0));
  const shown = all ? ordered : ordered.slice(0, Math.max(6, p.exceptions.length));
  const revision = p.updated + p.removed.length > 0 || (p.unchanged > 0 && p.added > 0);
  const register = async () => {
    setBusy(true);
    try { onChange(await window.dex.request('nib.holidays.register', { id: v.id })); toast('Office holidays registered'); } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  const by = v.done?.by ? users?.get(v.done.by)?.displayName : null;
  return (
    <Frame caption="HOLIDAY CIRCULAR" title={r.year ? String(r.year) : v.file} no={r.ref}>
      <Source v={v} />
      {r.period && <p className="nib-fine">{`For ${longDate(r.period.from)} to ${longDate(r.period.to)}`}</p>}
      {v.ocr && <p className="faint nib-fine">Read from a scan on this PC: check each row against the paper.</p>}
      <Counts counts={p.counts} doubt={p.exceptions.length} />
      {revision && (
        <p className="hol-diff" aria-label="What changes">
          <span>{`${p.added} new`}</span><span>{`${p.updated} changed`}</span><span>{`${p.removed.length} removed`}</span><span className="faint">{`${p.unchanged} the same`}</span>
        </p>
      )}
      {r.warnings.length > 0 && <ul className="hol-warnings">{r.warnings.map((w, i) => <li key={i}><Icon name="warning" size={12} />{warningWords(w, r.year)}</li>)}</ul>}
      {p.exceptions.length > 0 && <p className="hol-doubt">{p.exceptions.length === 1 ? '1 row is in doubt and will not be registered. Add it by hand once it is checked.' : `${p.exceptions.length} rows are in doubt and will not be registered. Add them by hand once they are checked.`}</p>}
      <ol className="hol-rows" aria-label="Rows read">
        {shown.map((x, i) => <Row key={`${x.sl}-${x.dateText}-${i}`} r={x} year={r.year} change={x.date ? change.get(`${x.sl}|${x.date}`) ?? null : null} />)}
      </ol>
      {ordered.length > shown.length && <button className="btn ghost sm hol-more" onClick={() => setAll(true)}>{`Show all ${ordered.length} rows`}</button>}
      {p.removed.length > 0 && (
        <div className="hol-removed">
          <span className="label">Removed: no longer in the circular</span>
          <ul>{p.removed.map((d) => <li key={d.date}><span className="mono">{longDate(d.date)}</span> <span translate="no">{d.name}</span></li>)}</ul>
        </div>
      )}
      {v.state === 'registered' && v.done && <p className="hol-stamp" role="status"><Icon name="check" size={14} />{by ? `Registered on ${stamp(v.done.at)} by ${by}.` : `Registered on ${stamp(v.done.at)}.`}</p>}
      {v.state === 'already' && p.already && <p className="hol-stamp" role="status"><Icon name="check" size={14} />{p.already.ref ? `Already registered on ${stamp(p.already.at)} from Ref ${p.already.ref}. Nothing changes.` : `Already registered on ${stamp(p.already.at)}. Nothing changes.`}</p>}
      {v.state === 'open' && (v.canRegister ? (
        <div className="nib-card-actions">
          <button className="btn sm" disabled={busy} onClick={() => void register()}>{busy ? <span className="spinner" /> : <Icon name="calendar" size={14} />}{daysWord(p.rows.length)}</button>
        </div>
      ) : p.rows.length === 0 ? <p className="faint nib-fine">There is nothing in this circular to register.</p> : <p className="faint nib-fine">An administrator registers office holidays.</p>)}
    </Frame>
  );
}

/** Nib's summary once a circular is registered. */
export function HolidaysDoneCard({ v }: { v: HolidayReadView }) {
  const d = v.done;
  if (!d) return null;
  return (
    <Frame caption="HOLIDAYS REGISTERED" title={v.read?.year ? String(v.read.year) : v.file} no={v.read?.ref}>
      <Counts counts={d.counts} doubt={d.exceptions} />
      <p className="nib-line">Scheduled jobs, day sheets and hot-desk booking skip these days. Compensatory working days are worked.</p>
      {(d.updated > 0 || d.removed > 0) && <p className="nib-fine">{`${d.added} new, ${d.updated} changed, ${d.removed} removed.`}</p>}
      {d.exceptions > 0 && <p className="hol-doubt">{d.exceptions === 1 ? '1 row in doubt was not registered.' : `${d.exceptions} rows in doubt were not registered.`}</p>}
      <div className="nib-card-actions">
        <button className="btn ghost sm" onClick={() => window.dispatchEvent(new CustomEvent('dex-deeplink', { detail: 'dexconnect://admin/holidays' }))}>Open Office holidays</button>
      </div>
    </Frame>
  );
}
