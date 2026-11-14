// Control room ▸ Organisation: departments, custom profile fields and importing the whole office
// from a spreadsheet (CSV saved from Excel or Dexterity Sheets).
import { useState } from 'react';
import { parseCsv, rowsFromSheet } from '@dex/core';
import type { ImportResult, ImportRow, PublicUser } from '@dex/core';
import { Icon, useToast } from '../ui.tsx';
import { useOrg } from '../org/store.ts';
import { useCal } from '../calendar/store.ts';

const TEMPLATE = 'Account,Name,Designation,Department,Reports to,Extension,Phone,Email,Seat,Employee ID,Date of joining,Birthday\r\npriya,Priya Raman,Senior Piping Designer,Piping,vikram,214,+91 98450 00000,priya@example.com,Bay 2 Desk 4,DDS-0042,12/04/2021,09/07\r\n';

export function OrgAdmin({ users }: { users: PublicUser[] }) {
  const toast = useToast();
  const org = useOrg();
  const [newDept, setNewDept] = useState('');
  const venues = useCal((s) => s.venues);
  const [newVenue, setNewVenue] = useState({ name: '', capacity: '' });
  const [fields, setFields] = useState<string[] | null>(null);
  const [sheet, setSheet] = useState<{ name: string; rows: ImportRow[]; columns: Array<{ header: string; maps: string }>; dry: ImportResult } | null>(null);
  const [busy, setBusy] = useState(false);
  const people = users.filter((u) => u.role !== 'bot');
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try { await fn(); if (ok) toast(ok); } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };

  const pick = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast('That file is too large for a people list (5 MB at most).', true); return; }
    const { rows, columns } = rowsFromSheet(parseCsv(await file.text()));
    if (!rows.length) { toast('No rows found. The first row should be the column names.', true); return; }
    if (!columns.some((c) => c.maps === 'account')) { toast('Add a column called "Account" with each person\'s Windows user name.', true); return; }
    await act(async () => {
      const dry = await window.dex.request('admin.org.import', { rows, dryRun: true });
      setSheet({ name: file.name, rows, columns, dry });
    });
  };

  return (
    <div className="org-admin">
      <section className="card">
        <div className="eyebrow">Departments</div>
        <div className="org-admin-list">
          {org.departments.length === 0 && <p className="faint">No departments yet.</p>}
          {org.departments.map((d) => (
            <div key={d.id} className="org-admin-row">
              <input className="input" defaultValue={d.name} aria-label="Department name" maxLength={60}
                onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== d.name) void act(() => window.dex.request('admin.org.saveDepartment', { id: d.id, name: v }), 'Renamed'); }} />
              <select className="input" value={d.parentId ?? ''} aria-label="Part of" onChange={(e) => void act(() => window.dex.request('admin.org.saveDepartment', { id: d.id, name: d.name, parentId: e.target.value || null }), 'Saved')}>
                <option value="">Top level</option>
                {org.departments.filter((x) => x.id !== d.id).map((x) => <option key={x.id} value={x.id}>Part of {x.name}</option>)}
              </select>
              <select className="input" value={d.headId ?? ''} aria-label="Led by" onChange={(e) => void act(() => window.dex.request('admin.org.saveDepartment', { id: d.id, name: d.name, headId: e.target.value || null }), 'Saved')}>
                <option value="">No head</option>
                {people.map((u) => <option key={u.id} value={u.id}>Led by {u.displayName}</option>)}
              </select>
              <span className="faint org-count">{people.filter((u) => u.profile.departmentId === d.id).length}</span>
              <button className="icon-btn danger" aria-label={`Delete ${d.name}`} title="Delete" disabled={busy}
                onClick={() => { if (confirm(`Delete ${d.name}? People in it will have no department.`)) void act(() => window.dex.request('admin.org.deleteDepartment', { id: d.id }), 'Deleted'); }}><Icon name="trash" size={15} /></button>
            </div>
          ))}
        </div>
        <form className="org-admin-add" onSubmit={(e) => { e.preventDefault(); const n = newDept.trim(); if (n) void act(() => window.dex.request('admin.org.saveDepartment', { name: n }), `Added ${n}`).then(() => setNewDept('')); }}>
          <input className="input" placeholder="New department, for example Piping" value={newDept} maxLength={60} onChange={(e) => setNewDept(e.target.value)} />
          <button className="btn" disabled={!newDept.trim() || busy}><Icon name="plus" size={15} />Add</button>
        </form>
      </section>

      <section className="card">
        <div className="eyebrow">Conference rooms and cabins</div>
        <p className="muted" style={{ marginTop: 0 }}>Rooms people can book when they plan a meeting. A room is never booked twice for the same time.</p>
        <div className="org-admin-list">
          {venues.length === 0 && <p className="faint">No rooms yet.</p>}
          {venues.map((v) => (
            <div key={v.id} className="org-admin-row">
              <input className="input" defaultValue={v.name} maxLength={60} aria-label="Room name"
                onBlur={(e) => { const n = e.target.value.trim(); if (n && n !== v.name) void act(() => window.dex.request('admin.cal.saveVenue', { id: v.id, name: n, capacity: v.capacity, note: v.note }), 'Saved'); }} />
              <input className="input venue-seats" type="number" min={1} defaultValue={v.capacity ?? ''} placeholder="Seats" aria-label="Seats"
                onBlur={(e) => { const c = e.target.value ? Number(e.target.value) : null; if (c !== v.capacity) void act(() => window.dex.request('admin.cal.saveVenue', { id: v.id, name: v.name, capacity: c, note: v.note }), 'Saved'); }} />
              <button className="icon-btn danger" aria-label={`Delete ${v.name}`} disabled={busy}
                onClick={() => { if (confirm(`Delete ${v.name}? Meetings booked there keep their time but lose the booking.`)) void act(() => window.dex.request('admin.cal.deleteVenue', { id: v.id }), 'Deleted'); }}><Icon name="trash" size={15} /></button>
            </div>
          ))}
        </div>
        <form className="org-admin-add" onSubmit={(e) => { e.preventDefault(); const n = newVenue.name.trim(); if (n) void act(() => window.dex.request('admin.cal.saveVenue', { name: n, capacity: newVenue.capacity ? Number(newVenue.capacity) : null }), `Added ${n}`).then(() => setNewVenue({ name: '', capacity: '' })); }}>
          <input className="input" placeholder="New room, for example Conference room A" value={newVenue.name} maxLength={60} onChange={(e) => setNewVenue({ ...newVenue, name: e.target.value })} />
          <input className="input venue-seats" type="number" min={1} placeholder="Seats" value={newVenue.capacity} onChange={(e) => setNewVenue({ ...newVenue, capacity: e.target.value })} />
          <button className="btn" disabled={!newVenue.name.trim() || busy}><Icon name="plus" size={15} />Add</button>
        </form>
      </section>

      <section className="card">
        <div className="eyebrow">Custom profile fields</div>
        <p className="muted" style={{ marginTop: 0 }}>Extra details shown on everyone's profile, for example blood group or software skills.</p>
        {fields === null ? (
          <>
            <div className="chip-row">{org.fields.length ? org.fields.map((f) => <span key={f.id} className="chip">{f.label}</span>) : <span className="faint">None yet.</span>}</div>
            <button className="btn" style={{ marginTop: 12 }} onClick={() => setFields(org.fields.map((f) => f.label))}><Icon name="edit" size={15} />Edit fields</button>
          </>
        ) : (
          <>
            {fields.map((f, i) => (
              <div key={i} className="org-admin-row">
                <input className="input" value={f} maxLength={40} placeholder="Field name" onChange={(e) => setFields(fields.map((x, j) => (j === i ? e.target.value : x)))} />
                <button className="icon-btn" aria-label="Remove field" onClick={() => setFields(fields.filter((_, j) => j !== i))}><Icon name="x" size={15} /></button>
              </div>
            ))}
            <div className="row-actions" style={{ marginTop: 10 }}>
              {fields.length < 12 && <button className="btn ghost" onClick={() => setFields([...fields, ''])}><Icon name="plus" size={15} />Add field</button>}
              <span style={{ flex: 1 }} />
              <button className="btn ghost" onClick={() => setFields(null)}>Cancel</button>
              <button className="btn primary" disabled={busy} onClick={() => void act(async () => {
                // keep the ids of fields whose label did not change, so values are kept
                const next = fields.map((label) => ({ id: org.fields.find((f) => f.label === label.trim())?.id, label }));
                await window.dex.request('admin.org.saveFields', { fields: next });
                setFields(null);
              }, 'Fields saved')}>Save fields</button>
            </div>
          </>
        )}
      </section>

      <section className="card">
        <div className="eyebrow">Import people</div>
        <p className="muted" style={{ marginTop: 0 }}>
          Fill in everyone's designation, department, reporting line and contact details at once from a CSV file (save as CSV from Excel or Dexterity Sheets).
          People who have not installed Dexterity Connect yet get their details as soon as they join.
        </p>
        <div className="row-actions">
          <label className="btn primary">
            <Icon name="sheet" size={15} />Choose CSV file
            <input type="file" accept=".csv,text/csv" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
          <a className="btn ghost" download="dexterity-connect-people.csv" href={`data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE)}`}><Icon name="download" size={15} />Template</a>
        </div>
        {sheet && (
          <div className="import-preview">
            <div className="label">{sheet.name} · {sheet.rows.length} rows</div>
            <div className="chip-row">{sheet.columns.map((c, i) => <span key={i} className={`chip${c.maps === 'custom field' ? ' warn' : ' accent'}`} title={`Read as ${c.maps}`}>{c.header || '(blank)'} → {c.maps}</span>)}</div>
            <ul className="import-summary">
              <li><b>{sheet.dry.updated}</b> people already here will be updated</li>
              <li><b>{sheet.dry.waiting}</b> will get their details when they join</li>
              {sheet.dry.departmentsCreated > 0 && <li><b>{sheet.dry.departmentsCreated}</b> new departments will be created</li>}
            </ul>
            {sheet.dry.problems.length > 0 && (
              <div className="error-box">
                {sheet.dry.problems.slice(0, 12).map((p, i) => <div key={i}>Row {p.row}: {p.message}</div>)}
                {sheet.dry.problems.length > 12 && <div>…and {sheet.dry.problems.length - 12} more</div>}
              </div>
            )}
            <div className="row-actions">
              <button className="btn ghost" onClick={() => setSheet(null)}>Cancel</button>
              <button className="btn primary" disabled={busy} onClick={() => void act(async () => {
                const res = await window.dex.request('admin.org.import', { rows: sheet.rows });
                setSheet(null);
                toast(`Imported: ${res.updated} updated, ${res.waiting} waiting to join${res.problems.length ? `, ${res.problems.length} rows skipped` : ''}`);
              })}>Import {sheet.rows.length - sheet.dry.problems.length} rows</button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
