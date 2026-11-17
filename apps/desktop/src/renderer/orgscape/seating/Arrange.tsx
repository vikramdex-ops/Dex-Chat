// Arranging seats (administrators and office managers): people to drag onto the plan, the move
// plan being put together (with its effective date, Apply and Undo), moving a whole team into a
// zone with a preview, importing a pasted list or the old free-text seats, and editing the layout
// itself. Loaded only when an editor opens it.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch } from 'react';
import type { Department, ImportRowMatch, PublicUser, SeatChange, SeatMove, SeatingView } from '@dex/core';
import { applyMoves, diffHolders, flowMoves, isSeatId, nextMonday, placeMoves, seatOfPeople, ymd } from '@dex/core';
import { tr } from '../../i18n/index.ts';
import { Icon, useToast } from '../../ui.tsx';
import { confirmAction } from '../../confirm.tsx';
import { addToDraft, currentDraft, draftHolders, dropFromDraft, reloadSeating } from './store.ts';
import type { EditorAction, EditorState } from './editor.ts';
import { problems } from './editor.ts';
import './seating.css';

export type ArrangeTab = 'people' | 'moves' | 'team' | 'import' | 'layout';

const dayText = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });

export default function Arrange({ view, people, users, departments, tab, onTab, onClose, onDragStart, onPreview, onFocusSeat, editor, dispatch, viewCentreFt, onUnderlay }: {
  view: SeatingView; people: PublicUser[]; users: Map<string, PublicUser>; departments: Map<string, Department>;
  tab: ArrangeTab; onTab: (t: ArrangeTab) => void; onClose: () => void;
  /** Start dragging people from the list onto the plan. */
  onDragStart: (ids: string[], e: React.PointerEvent) => void;
  /** Arrows for a preview (moving a team), or null to clear them. */
  onPreview: (moves: SeatMove[] | null) => void;
  onFocusSeat: (seatId: string) => void;
  editor: EditorState | null; dispatch: Dispatch<EditorAction>; viewCentreFt: () => [number, number];
  onUnderlay: () => void;
}) {
  const tabs: Array<[ArrangeTab, string]> = [['people', 'People'], ['moves', 'Move plan'], ['team', 'Move a team'], ['import', 'Import'], ['layout', 'Layout']];
  const draft = currentDraft(view);
  return (
    <aside className="seat-panel" aria-label="Arrange seats" onPointerDown={(e) => e.stopPropagation()}>
      <div className="seat-head">
        <span className="label">Arrange seats</span>
        <button type="button" className="icon-btn" aria-label="Close arranging" onClick={onClose}><Icon name="x" size={15} /></button>
      </div>
      <div className="seat-tabs" role="tablist" aria-label="Arrange seats">
        {tabs.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => onTab(k)}>
            {label}{k === 'moves' && draft && draft.changes.length > 0 && <span className="seat-count mono">{draft.changes.length}</span>}
          </button>
        ))}
      </div>
      <div className="seat-body" role="tabpanel">
        {tab === 'people' && <Waiting view={view} users={users} onFocusSeat={onFocusSeat} />}
        {tab === 'people' && <PeopleTab view={view} people={people} departments={departments} onDragStart={onDragStart} onFocusSeat={onFocusSeat} />}
        {tab === 'moves' && <MovesTab view={view} users={users} onFocusSeat={onFocusSeat} />}
        {tab === 'team' && <TeamTab view={view} people={people} users={users} departments={departments} onPreview={onPreview} />}
        {tab === 'import' && <ImportTab view={view} people={people} users={users} />}
        {tab === 'layout' && <LayoutTab view={view} editor={editor} dispatch={dispatch} viewCentreFt={viewCentreFt} onUnderlay={onUnderlay} />}
      </div>
    </aside>
  );
}

function changeLine(c: SeatChange, users: Map<string, PublicUser>): string {
  const who = c.userId ? users.get(c.userId)?.displayName ?? '' : c.label ?? '';
  return `${who}`;
}

// ------------------------------------------------------------------ names from the drawing to confirm
/**
 * Names from the office drawing that someone in the directory may be, but not certainly (a first
 * name two people share, a name that only starts theirs). One click confirms who it is: they take
 * the seat and are told, like anyone the hub matched itself.
 */
function Waiting({ view, users, onFocusSeat }: { view: SeatingView; users: Map<string, PublicUser>; onFocusSeat: (s: string) => void }) {
  const toast = useToast();
  const [pick, setPick] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const waiting = view.waiting ?? [];
  if (!waiting.length) return null;
  const confirm = async (seatId: string, userId: string) => {
    const name = users.get(userId)?.displayName ?? '';
    setBusy(true);
    try {
      await window.dex.request('seating.claim', { seatId, userId });
      toast(tr(`${name} now holds ${seatId}`));
      await reloadSeating();
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  return (
    <section className="seat-waiting" aria-labelledby="seat-waiting-h">
      <h3 id="seat-waiting-h" className="label">Waiting to be matched <span className="seat-count mono">{waiting.length}</span></h3>
      <p className="faint seat-hint">Names from the office drawing that someone in the directory may be. Confirm who it is: they take the seat and are told.</p>
      <ul className="seat-people seat-wait-list" aria-label="Waiting to be matched">
        {waiting.map((w) => {
          const chosen = pick[w.seatId] && w.suggestions.some((x) => x.userId === pick[w.seatId]) ? pick[w.seatId] : w.suggestions[0].userId;
          const who = users.get(chosen)?.displayName ?? '';
          return (
            <li key={w.seatId} className="seat-wait">
              <button type="button" className="chip mono" onClick={() => onFocusSeat(w.seatId)} aria-label={tr(`Show seat ${w.seatId}`)}>{w.seatId}</button>
              <span className="seat-who"><b translate="no">{w.name}</b><span className="faint">On the drawing</span></span>
              <button type="button" className="btn sm primary" disabled={busy} onClick={() => void confirm(w.seatId, chosen)} aria-label={tr(`Confirm ${who} for ${w.seatId}`)}>Confirm</button>
              <span className="seat-wait-who">
                {w.suggestions.length === 1
                  ? <><span className="faint">Suggested</span> <b translate="no">{who}</b></>
                  : (
                    <select className="input" value={chosen} onChange={(e) => setPick((p) => ({ ...p, [w.seatId]: e.target.value }))} aria-label={tr(`Who is ${w.name} on the drawing?`)}>
                      {w.suggestions.map((x) => <option key={x.userId} value={x.userId} translate="no">{users.get(x.userId)?.displayName ?? ''}</option>)}
                    </select>
                  )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ------------------------------------------------------------------ people to drag
function PeopleTab({ view, people, departments, onDragStart, onFocusSeat }: {
  view: SeatingView; people: PublicUser[]; departments: Map<string, Department>; onDragStart: (ids: string[], e: React.PointerEvent) => void; onFocusSeat: (s: string) => void;
}) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [to, setTo] = useState('');
  const holders = useMemo(() => draftHolders(view), [view]);
  const seatOf = useMemo(() => seatOfPeople(holders), [holders]);
  const shown = people.filter((u) => {
    if (filter === 'none' && seatOf.has(u.id)) return false;
    if (filter && filter !== 'none' && u.profile.departmentId !== filter) return false;
    const t = q.trim().toLowerCase();
    return !t || u.displayName.toLowerCase().includes(t) || (seatOf.get(u.id) ?? '').toLowerCase().includes(t);
  }).sort((a, b) => a.displayName.localeCompare(b.displayName));
  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const ids = [...sel];
  const place = async () => {
    const seat = view.plan.seats.find((s) => s.id === to.trim().toUpperCase())?.id;
    if (!seat) { toast(tr(`There is no seat ${to.trim()} on the plan.`), true); return; }
    try {
      const moves = ids.length === 1 ? placeMoves(holders, ids[0], seat) : flowMoves(view.plan, holders, ids, { zoneId: view.plan.seats.find((s) => s.id === seat)!.zone, fromSeat: seat }).moves;
      await addToDraft(moves);
      toast(ids.length === 1 ? tr('Added to the move plan') : tr(`${ids.length} people added to the move plan`));
      setSel(new Set()); setTo('');
    } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <>
      <p className="faint seat-hint">Drag people onto a seat. Drop on someone to swap. Tick several (or a department) and drag them to a zone: they fill its free seats in order.</p>
      <div className="seat-row">
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a person or seat" aria-label="Find a person or seat" />
        <select className="input" value={filter} onChange={(e) => { setFilter(e.target.value); setSel(new Set()); }} aria-label="Show people">
          <option value="">Everyone</option>
          <option value="none">No seat yet</option>
          {[...departments.values()].sort((a, b) => a.name.localeCompare(b.name)).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </div>
      <div className="seat-row seat-sel">
        <button type="button" className="btn sm ghost" onClick={() => setSel(new Set(shown.map((u) => u.id)))}>Select all shown</button>
        {sel.size > 0 && <span className="mono faint">{tr(`${sel.size} selected`)}</span>}
        {sel.size > 0 && <button type="button" className="btn sm ghost" onClick={() => setSel(new Set())}>Clear</button>}
      </div>
      <ul className="seat-people" aria-label="People">
        {shown.slice(0, 400).map((u) => {
          const seat = seatOf.get(u.id);
          return (
            <li key={u.id} className={`seat-person${sel.has(u.id) ? ' on' : ''}`}>
              <input type="checkbox" checked={sel.has(u.id)} onChange={() => toggle(u.id)} aria-label={tr(`Select ${u.displayName}`)} />
              <span className="seat-grip" role="button" tabIndex={-1} aria-label={tr(`Drag ${u.displayName} onto a seat`)} data-person={u.id}
                onPointerDown={(e) => { e.preventDefault(); onDragStart(sel.has(u.id) ? ids : [u.id], e); }}><Icon name="grip" size={14} /></span>
              <span className="seat-who"><b translate="no">{u.displayName}</b><span className="faint" translate="no">{departments.get(u.profile.departmentId ?? '')?.name ?? ''}</span></span>
              {seat ? <button type="button" className="chip mono" onClick={() => onFocusSeat(seat)} aria-label={tr(`Show seat ${seat}`)}>{seat}</button> : <span className="chip faint">No seat</span>}
            </li>
          );
        })}
      </ul>
      {sel.size > 0 && (
        <form className="seat-row seat-to" onSubmit={(e) => { e.preventDefault(); void place(); }}>
          <label className="label" htmlFor="seat-to">{sel.size === 1 ? tr('Move to seat') : tr('Move them from seat')}</label>
          <input id="seat-to" className="input mono" value={to} onChange={(e) => setTo(e.target.value)} placeholder="W-A14" />
          <button type="submit" className="btn sm primary" disabled={!to.trim()}>Add to plan</button>
        </form>
      )}
    </>
  );
}

// ------------------------------------------------------------------ the move plan
function MovesTab({ view, users, onFocusSeat }: { view: SeatingView; users: Map<string, PublicUser>; onFocusSeat: (s: string) => void }) {
  const toast = useToast();
  const draft = currentDraft(view);
  const [title, setTitle] = useState(draft?.title ?? '');
  const [day, setDay] = useState(() => draft && draft.effective > ymd(Date.now()) ? draft.effective : nextMonday(Date.now()));
  const [busy, setBusy] = useState(false);
  useEffect(() => { setTitle(draft?.title ?? ''); }, [draft?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const scheduled = view.plans.filter((p) => p.status === 'scheduled');
  const lastApplied = view.revisions.find((r) => r.planId && (r.kind === 'moves'));
  const run = async (f: () => Promise<unknown>, ok: string) => { setBusy(true); try { await f(); await reloadSeating(); toast(ok); } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); } };
  const today = ymd(Date.now());
  return (
    <>
      {!draft || !draft.changes.length ? (
        <p className="faint seat-hint">No moves yet. Drag people onto seats, move a team or import a list: each move shows here and as a dashed arrow on the plan.</p>
      ) : (
        <section className="seat-draft" aria-label="Move plan">
          <label className="label" htmlFor="seat-title">Plan</label>
          <input id="seat-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => { if (title.trim() && title !== draft.title) void window.dex.request('seating.draft', { id: draft.id, title, moves: draft.moves }).then(reloadSeating).catch((e: Error) => toast(e.message, true)); }} />
          <ol className="seat-changes" aria-label="Moves">
            {draft.changes.map((c, i) => (
              <li key={`${c.userId ?? c.label}-${i}`}>
                <span className="seat-who" translate="no">{changeLine(c, users)}</span>
                <span className="mono seat-ft">
                  {c.from ? <button type="button" className="tb-link" onClick={() => onFocusSeat(c.from!)}>{c.from}</button> : <span className="faint">{tr('No seat')}</span>}
                  <span aria-hidden="true"> → </span>
                  {c.to ? <button type="button" className="tb-link" onClick={() => onFocusSeat(c.to!)}>{c.to}</button> : <span className="faint">{tr('No seat')}</span>}
                </span>
                <button type="button" className="icon-btn" aria-label={tr('Take this move out')} onClick={() => void dropFromDraft(c.to ?? c.from ?? '').catch((e: Error) => toast(e.message, true))}><Icon name="x" size={13} /></button>
              </li>
            ))}
          </ol>
          <div className="seat-row">
            <label className="label" htmlFor="seat-day">From</label>
            <input id="seat-day" className="input mono" type="date" value={day} min={today} onChange={(e) => setDay(e.target.value)} />
            <span className="faint">{day <= today ? tr('Today') : dayText(day)}</span>
          </div>
          <div className="seat-row seat-actions">
            <button type="button" className="btn primary" disabled={busy} onClick={() => void run(() => window.dex.request('seating.apply', { id: draft.id, effective: day }), day <= today ? tr('Applied: the seats have changed') : tr(`Published: the moves take effect on ${dayText(day)}`))}>
              <Icon name="check" size={15} />{day <= today ? 'Apply now' : tr(`Apply from ${dayText(day)}`)}
            </button>
            <button type="button" className="btn ghost" disabled={busy} onClick={async () => { if (await confirmAction({ title: tr('Throw away this move plan?'), body: tr('The moves are dropped. Nobody has been told yet.'), confirm: tr('Throw away'), danger: true })) void run(() => window.dex.request('seating.discard', { id: draft.id }), tr('Move plan thrown away')); }}>Discard</button>
          </div>
          <p className="faint seat-hint">Everyone who moves is told once, with a link that walks them to their new seat. Their directory seat changes on the day.</p>
        </section>
      )}
      {scheduled.length > 0 && (
        <section aria-label="Published, to take effect">
          <h4 className="label">Published, to take effect</h4>
          {scheduled.map((p) => (
            <div key={p.id} className="seat-plan">
              <span className="seat-who"><b translate="no">{p.title}</b><span className="faint">{tr(`From ${dayText(p.effective)} · ${p.changes.length} moves`)}</span></span>
              <button type="button" className="btn sm ghost" disabled={busy} onClick={() => void run(() => window.dex.request('seating.undo', { id: p.id }), tr('Taken back to draft'))}><Icon name="back" size={14} />Take back</button>
            </div>
          ))}
        </section>
      )}
      {lastApplied?.planId && (
        <section aria-label="Last applied">
          <h4 className="label">Last applied</h4>
          <div className="seat-plan">
            <span className="seat-who"><b translate="no">{lastApplied.note}</b><span className="faint mono">{tr(`Rev ${lastApplied.rev} · ${new Date(lastApplied.at).toLocaleDateString([], { day: 'numeric', month: 'short' })}`)}</span></span>
            <button type="button" className="btn sm ghost" disabled={busy} onClick={async () => { if (await confirmAction({ title: tr(`Undo Rev ${lastApplied.rev}?`), body: tr('Everyone it moved goes back to the seat they had before.'), confirm: tr('Undo') })) void run(() => window.dex.request('seating.undo', { id: lastApplied.planId! }), tr('Undone: the seats are back')); }}><Icon name="history" size={14} />Undo</button>
          </div>
        </section>
      )}
    </>
  );
}

// ------------------------------------------------------------------ a team into a zone
function TeamTab({ view, people, users, departments, onPreview }: {
  view: SeatingView; people: PublicUser[]; users: Map<string, PublicUser>; departments: Map<string, Department>; onPreview: (m: SeatMove[] | null) => void;
}) {
  const toast = useToast();
  const [dept, setDept] = useState('');
  const [zone, setZone] = useState(view.plan.zones[0]?.id ?? '');
  const [from, setFrom] = useState('');
  const [res, setRes] = useState<{ moves: SeatMove[]; changes: SeatChange[]; unplaced: string[] } | null>(null);
  useEffect(() => () => onPreview(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  const holders = useMemo(() => draftHolders(view), [view]);
  const preview = () => {
    const ids = people.filter((u) => u.profile.departmentId === dept).sort((a, b) => a.displayName.localeCompare(b.displayName)).map((u) => u.id);
    if (!ids.length) { toast(tr('No one is in that department.'), true); return; }
    const fromSeat = isSeatId(from.trim().toUpperCase()) ? from.trim().toUpperCase() : undefined;
    // against the draft as it stands, so the preview adds to what is already planned
    const r = flowMoves(view.plan, holders, ids, { zoneId: zone, fromSeat });
    setRes({ ...r, changes: diffHolders(holders, applyMoves(holders, r.moves)) });
    onPreview(r.moves);
  };
  const zoneName = view.plan.zones.find((z) => z.id === zone)?.name ?? '';
  return (
    <>
      <p className="faint seat-hint">Move a whole department into a zone in one go. Preview who goes where, then add it to the move plan.</p>
      <div className="seat-form">
        <label className="label" htmlFor="seat-dept">Department</label>
        <select id="seat-dept" className="input" value={dept} onChange={(e) => { setDept(e.target.value); setRes(null); onPreview(null); }}>
          <option value="">Choose…</option>
          {[...departments.values()].sort((a, b) => a.name.localeCompare(b.name)).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <label className="label" htmlFor="seat-zone">To</label>
        <select id="seat-zone" className="input" value={zone} onChange={(e) => { setZone(e.target.value); setRes(null); onPreview(null); }}>
          {view.plan.zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
        </select>
        <label className="label" htmlFor="seat-from">Starting at seat (optional)</label>
        <input id="seat-from" className="input mono" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="W-A21" />
        <button type="button" className="btn primary" disabled={!dept || !zone} onClick={preview}><Icon name="eye" size={15} />Preview</button>
      </div>
      {res && (
        <section className="seat-preview" aria-label="Preview">
          <h4 className="label">{tr(`${departments.get(dept)?.name ?? ''} to ${zoneName}`)}</h4>
          {res.changes.length === 0 ? <p className="faint">Everyone is already there.</p> : (
            <ol className="seat-changes">
              {res.changes.map((c, i) => <li key={i}><span className="seat-who" translate="no">{changeLine(c, users)}</span><span className="mono seat-ft">{c.from ?? tr('No seat')} → {c.to ?? tr('No seat')}</span></li>)}
            </ol>
          )}
          {res.unplaced.length > 0 && <p className="seat-warn">{res.unplaced.length === 1 ? tr('1 person does not fit: the zone is full.') : tr(`${res.unplaced.length} people do not fit: the zone is full.`)}</p>}
          <div className="seat-row seat-actions">
            <button type="button" className="btn primary" disabled={!res.moves.length} onClick={() => void addToDraft(res.moves, tr(`${departments.get(dept)?.name ?? ''} to ${zoneName}`)).then(() => { toast(tr('Added to the move plan')); setRes(null); onPreview(null); }).catch((e: Error) => toast(e.message, true))}>Add to the move plan</button>
            <button type="button" className="btn ghost" onClick={() => { setRes(null); onPreview(null); }}>Cancel</button>
          </div>
        </section>
      )}
    </>
  );
}

// ------------------------------------------------------------------ import
function ImportTab({ view, people, users }: { view: SeatingView; people: PublicUser[]; users: Map<string, PublicUser> }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [rows, setRows] = useState<Array<ImportRowMatch & { pick: string; use: boolean }> | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const match = async () => {
    setBusy(true);
    try {
      const r = await window.dex.request('seating.importMatch', { text });
      setRows(r.rows.map((x) => ({ ...x, pick: x.userId ?? x.suggestions[0]?.userId ?? '', use: !!x.userId && !x.problem })));
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  const fromProfiles = async () => {
    setBusy(true);
    try {
      const r = await window.dex.request('seating.importProfiles');
      if (!r.moves.length) { toast(tr('No one\'s Seat field names a seat on the plan.')); return; }
      setRows(r.moves.map((m, i) => ({ line: i + 1, raw: '', seatId: m.seatId, name: m.to?.kind === 'person' ? users.get(m.to.userId)?.displayName ?? '' : '', userId: m.to?.kind === 'person' ? m.to.userId : null, sure: true, suggestions: [], problem: null, pick: m.to?.kind === 'person' ? m.to.userId : '', use: true })));
      if (r.skipped.length) toast(r.skipped.length === 1 ? tr('1 Seat field did not name a seat and was left out.') : tr(`${r.skipped.length} Seat fields did not name a seat and were left out.`));
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  const chosen = (rows ?? []).filter((r) => r.use && r.pick && !r.problem);
  const add = async () => {
    const seen = new Set<string>();
    const moves: SeatMove[] = [];
    for (const r of chosen) { if (seen.has(r.pick)) continue; seen.add(r.pick); moves.push({ seatId: r.seatId, to: { kind: 'person', userId: r.pick } }); }
    try { await addToDraft(moves, tr('Imported seats')); toast(moves.length === 1 ? tr('1 seat added to the move plan') : tr(`${moves.length} seats added to the move plan`)); setRows(null); setText(''); } catch (e) { toast((e as Error).message, true); }
  };
  const names = useMemo(() => [...people].sort((a, b) => a.displayName.localeCompare(b.displayName)), [people]);
  return (
    <>
      <p className="faint seat-hint">Paste lines of seat and name (W-A14, Priya Raman), or open a CSV. Names are matched against the directory; check the ones marked.</p>
      <textarea className="input seat-paste" value={text} onChange={(e) => setText(e.target.value)} rows={6} aria-label="Seats and names" placeholder={'W-A14, Priya Raman\nPOD1-3, Logesh M'} />
      <div className="seat-row">
        <button type="button" className="btn sm" onClick={() => file.current?.click()}><Icon name="open" size={14} />Open a CSV</button>
        <input ref={file} type="file" accept=".csv,.txt,text/csv,text/plain" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void f.text().then((t) => setText(t.slice(0, 200_000))); e.target.value = ''; }} />
        <button type="button" className="btn sm primary" disabled={!text.trim() || busy} onClick={() => void match()}>Match names</button>
        <button type="button" className="btn sm ghost" disabled={busy} onClick={() => void fromProfiles()}>From the directory's Seat field</button>
      </div>
      {rows && (
        <section aria-label="Matches">
          <table className="seat-import">
            <thead><tr><th scope="col"><span className="sr">Use</span></th><th scope="col">Seat</th><th scope="col">Written</th><th scope="col">Person</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className={r.problem ? 'bad' : !r.sure ? 'check' : ''}>
                  <td><input type="checkbox" checked={r.use} disabled={!!r.problem || !r.pick} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, use: e.target.checked } : x)))} aria-label={tr(`Use line ${r.line}`)} /></td>
                  <td className="mono">{r.seatId}</td>
                  <td translate="no">{r.name}</td>
                  <td>
                    {r.problem ? <span className="seat-warn">{tr(r.problem)}</span> : (
                      <>
                        <select className="input" value={r.pick} aria-label={tr(`Person for ${r.seatId}`)} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, pick: e.target.value, use: !!e.target.value } : x)))}>
                          <option value="">Skip</option>
                          {r.suggestions.length > 0 && <optgroup label={tr('Suggested')}>{r.suggestions.map((sg) => <option key={sg.userId} value={sg.userId}>{users.get(sg.userId)?.displayName}</option>)}</optgroup>}
                          <optgroup label={tr('Everyone')}>{names.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}</optgroup>
                        </select>
                        {!r.sure && r.pick && <span className="chip accent seat-chk">Check</span>}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="seat-row seat-actions">
            <button type="button" className="btn primary" disabled={!chosen.length} onClick={() => void add()}>{chosen.length === 1 ? tr('Add 1 seat to the move plan') : tr(`Add ${chosen.length} seats to the move plan`)}</button>
            <button type="button" className="btn ghost" onClick={() => setRows(null)}>Cancel</button>
          </div>
        </section>
      )}
    </>
  );
}

// ------------------------------------------------------------------ the layout itself
function LayoutTab({ view, editor, dispatch, viewCentreFt, onUnderlay }: { view: SeatingView; editor: EditorState | null; dispatch: Dispatch<EditorAction>; viewCentreFt: () => [number, number]; onUnderlay: () => void }) {
  const toast = useToast();
  const [n, setN] = useState(4);
  const [zone, setZone] = useState(view.plan.zones[0]?.id ?? '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const bad = useMemo(() => (editor ? problems(editor.plan) : null), [editor?.plan]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!editor) {
    return (
      <>
        <p className="faint seat-hint">Change the drawing itself: move, turn and copy seats and benches, add a bench or a pod, rename rooms. Changes are saved as a new revision.</p>
        <button type="button" className="btn primary" onClick={() => dispatch({ t: 'open', plan: view.plan, base: view.version })}><Icon name="edit" size={15} />Edit the layout</button>
        <section className="seat-underlay" aria-label="Underlay">
          <h4 className="label">Underlay</h4>
          <p className="faint seat-hint">When the office changes, put the new drawing (PDF or image) under the plan, faint, and trace it.</p>
          <button type="button" className="btn sm" onClick={onUnderlay}><Icon name="drawing" size={14} />{view.underlay ? 'Change the underlay' : 'Add an underlay'}</button>
        </section>
      </>
    );
  }
  const sel = editor.plan.seats.filter((s) => editor.sel.includes(s.id));
  const one = sel.length === 1 ? sel[0] : null;
  const room = editor.room ? editor.plan.rooms.find((r) => r.id === editor.room) : null;
  const save = async () => {
    setBusy(true);
    try {
      const r = await window.dex.request('seating.layout', { plan: editor.plan, baseVersion: editor.base, note: note.trim() || undefined });
      dispatch({ t: 'saved', base: r.version });
      await reloadSeating();
      toast(tr(`Layout saved as Rev ${r.rev}`));
      setNote('');
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  const num = (v: string) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
  const centre = () => viewCentreFt();
  return (
    <div className="seat-layout">
      <div className="seat-row seat-tools" role="toolbar" aria-label="Layout tools">
        <button type="button" className="icon-btn" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!editor.undo.length} onClick={() => dispatch({ t: 'undo' })}><Icon name="back" size={15} /></button>
        <button type="button" className="icon-btn seat-redo" aria-label="Redo" title="Redo (Ctrl+Y)" disabled={!editor.redo.length} onClick={() => dispatch({ t: 'redo' })}><Icon name="back" size={15} /></button>
        <button type="button" className="icon-btn" aria-label="Turn 90 degrees" title="Turn 90° (R)" disabled={!sel.length} onClick={() => dispatch({ t: 'rotate', deg: 90 })}><Icon name="rotate" size={15} /></button>
        <button type="button" className="icon-btn" aria-label="Duplicate" title="Duplicate (Ctrl+D)" disabled={!sel.length} onClick={() => dispatch({ t: 'duplicate' })}><Icon name="copy" size={15} /></button>
        <button type="button" className="icon-btn" aria-label="Remove the selected seats" title="Remove (Delete)" disabled={!sel.length} onClick={() => dispatch({ t: 'delete' })}><Icon name="trash" size={15} /></button>
        <button type="button" className="btn sm ghost" disabled={!one} onClick={() => one && dispatch({ t: 'selectGroup', id: one.id })}>Select its bench</button>
      </div>
      <p className="faint seat-hint">{tr(`Click a seat to select it (Shift for more), drag to move. Arrow keys nudge by ${editor.plan.snapInches} inches, Shift and the arrows by a foot, and R turns.`)}</p>
      <div className="seat-form seat-add">
        <label className="label" htmlFor="seat-n">Add a bench of</label>
        <input id="seat-n" className="input mono" type="number" min={1} max={40} value={n} onChange={(e) => setN(Math.max(1, Math.min(40, Number(e.target.value) || 1)))} />
        <label className="label" htmlFor="seat-z">in</label>
        <select id="seat-z" className="input" value={zone} onChange={(e) => setZone(e.target.value)}>{editor.plan.zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}</select>
        <button type="button" className="btn sm" onClick={() => { const [x, y] = centre(); dispatch({ t: 'addBench', zone, n, x: x - n * 1, y: y - 3 }); }}><Icon name="plus" size={14} />Add bench</button>
        <button type="button" className="btn sm" onClick={() => { const [x, y] = centre(); dispatch({ t: 'addPod', zone, n: 6, x, y }); }}><Icon name="plus" size={14} />Add a pod of 6</button>
      </div>
      {one && (
        <fieldset className="seat-fields">
          <legend className="label">{tr(`Seat ${one.id}`)}</legend>
          <label>ID<input className="input mono" defaultValue={one.id} key={`id-${one.id}`} onBlur={(e) => { const v = e.target.value.trim().toUpperCase(); if (v && v !== one.id) { if (!isSeatId(v)) toast(tr('A seat ID is letters, digits and dashes, like W-A14.'), true); else dispatch({ t: 'set', id: one.id, patch: { id: v } }); } }} /></label>
          <label>X (ft)<input className="input mono" type="number" step={0.25} value={one.x} onChange={(e) => { const v = num(e.target.value); if (v !== null) dispatch({ t: 'set', id: one.id, patch: { x: v } }); }} /></label>
          <label>Y (ft)<input className="input mono" type="number" step={0.25} value={one.y} onChange={(e) => { const v = num(e.target.value); if (v !== null) dispatch({ t: 'set', id: one.id, patch: { y: v } }); }} /></label>
          <label>Facing (°)<input className="input mono" type="number" step={15} value={one.facing} onChange={(e) => { const v = num(e.target.value); if (v !== null) dispatch({ t: 'set', id: one.id, patch: { facing: v } }); }} /></label>
          <label>Zone<select className="input" value={one.zone} onChange={(e) => dispatch({ t: 'set', id: one.id, patch: { zone: e.target.value } })}>{editor.plan.zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}</select></label>
        </fieldset>
      )}
      {sel.length > 1 && <p className="mono faint">{tr(`${sel.length} seats selected`)}</p>}
      {room && (
        <fieldset className="seat-fields">
          <legend className="label">Room</legend>
          <label>Name<input className="input" key={room.id} defaultValue={room.name} onBlur={(e) => { if (e.target.value.trim() && e.target.value !== room.name) dispatch({ t: 'renameRoom', id: room.id, name: e.target.value }); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} /></label>
        </fieldset>
      )}
      {bad && bad.list.length > 0 && (
        <ul className="seat-problems" aria-label="Problems">{bad.list.slice(0, 6).map((p, i) => <li key={i} className="seat-warn">{p}</li>)}</ul>
      )}
      <div className="seat-form">
        <label className="label" htmlFor="seat-note">What changed</label>
        <input id="seat-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Bench of 4 added by the printers" />
      </div>
      <div className="seat-row seat-actions">
        <button type="button" className="btn primary" disabled={busy || !editor.dirty || !!bad?.list.length} onClick={() => void save()}><Icon name="check" size={15} />Save layout</button>
        <button type="button" className="btn ghost" onClick={async () => { if (!editor.dirty || await confirmAction({ title: tr('Leave without saving?'), body: tr('Your changes to the layout are dropped.'), confirm: tr('Leave'), danger: true })) dispatch({ t: 'close' }); }}>{editor.dirty ? 'Discard changes' : 'Close the editor'}</button>
      </div>
      <p className="faint mono">{tr(`${editor.plan.seats.length} seats · version ${editor.base}`)}</p>
    </div>
  );
}
