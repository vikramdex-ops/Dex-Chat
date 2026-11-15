// Webinars on the Meet lens: the register of webinars (yours, the ones you are a panelist of, and
// the ones the office lists for everyone), planning one, and its sheet: Setup (the registration
// page and its questions), Registrants (a ruled table: approve, turn away, invitations and
// reminders as text and .ics, CSV), Live stream (the service's address and key, ffmpeg on the hub,
// the stream's health), Follow-up (a thank-you with the recording and a survey) and Report. No
// mail is sent from here: the app has no mail server, so the texts are copied or saved.
import { Fragment, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { formatMeetingId, mailMergeCsv, registrantsCsv, webinarReportCsv } from '@dex/core';
import type { PublicUser, RecordingInfo, Registrant, Session, WebinarCard, WebinarFieldInput, WebinarInfo, WebinarMail, WebinarReport } from '@dex/core';
import { Avatar, Dialog, Icon, presenceFor, useToast } from '../../ui.tsx';
import { Glyph } from '../../rooms/parts.tsx';
import { hm } from '../../calendar/store.ts';
import { saveText, whenText } from '../GuestLink.tsx';
import { bumpWebinars, joinAny, useWeb } from './store.ts';
import { streamLine } from './StageTabs.tsx';
import './webinar.css';

const STATE_LABEL: Record<WebinarCard['state'], string> = { scheduled: 'PLANNED', practice: 'PRACTICE', live: 'LIVE', ended: 'ENDED' };
const ROLE_LABEL: Record<WebinarCard['role'], string> = { organizer: 'ORGANISER', panelist: 'PANELIST', attendee: 'ATTENDEE' };
const safeFile = (s: string) => s.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Webinar';
const dayText = (t: number) => new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const when = (w: { startsAt: number; durationMin: number }) => whenText(w.startsAt, w.startsAt + w.durationMin * 60_000);

/** The ruled card the lens uses, here for webinars. */
function Block({ label, refText, children, className }: { label: string; refText?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`meet-block${className ? ` ${className}` : ''}`} aria-label={label}>
      <div className="meet-block-head"><span className="label">{label}</span>{refText && <span className="mono">{refText}</span>}</div>
      {children}
    </section>
  );
}

export function WebinarsBlock({ session, busy, onOpen, onReport }: { session: Session; busy: boolean; onOpen: (id: string) => void; onReport: (roomId: string) => void }) {
  const toast = useToast();
  const version = useWeb((s) => s.version);
  const [list, setList] = useState<WebinarCard[] | null>(null);
  const [planning, setPlanning] = useState(false);
  const canHost = session.me.role !== 'guest';
  // the register follows a webinar going live or ending (and looks again every half minute)
  const watchingState = useWeb((s) => s.watching?.live.state);
  const [tick, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => { void window.dex.request('web.list').then(setList).catch(() => setList([])); }, [version, watchingState, tick]);
  const users = useMemo(() => new Map(session.users.map((u) => [u.id, u] as const)), [session.users]);
  const go = (id: string) => void joinAny(id, false).catch((e: Error) => toast(e.message, true));
  return (
    <Block label="Webinars" refText={list ? String(list.length) : undefined} className="meet-webinars">
      {list === null && <div className="tl-more"><span className="spinner" /></div>}
      {list?.length === 0 && <p className="meet-empty">A webinar has an organiser and panelists on a stage and an audience that watches: people outside the office register on a page of their own.</p>}
      {list && list.length > 0 && (
        <table className="wb-register">
          <tbody>
            {list.map((w) => (
              <tr key={w.meetingId} className={w.state === 'live' ? 'live' : ''}>
                <td className="mono wb-when">{dayText(w.startsAt).toUpperCase()}<br /><span>{hm(w.startsAt)}</span></td>
                <td className="wb-what"><b title={w.title}>{w.title}</b><span className="faint">{users.get(w.hostId)?.displayName ?? 'Someone'} · {formatMeetingId(w.meetingId)}{w.audience ? ` · ${w.audience} watching` : ''}</span></td>
                <td><span className={`wb-state-tag mono ${w.state}`}>{w.state === 'live' && <i aria-hidden="true" />}{STATE_LABEL[w.state]}</span><span className="mono faint wb-role">{ROLE_LABEL[w.role]}</span></td>
                <td className="wb-act">
                  {w.role !== 'attendee' && <button className="btn sm ghost" onClick={() => onOpen(w.meetingId)}>Sheet</button>}
                  {w.state === 'ended' && w.roomId && w.role !== 'attendee' && <button className="btn sm ghost" onClick={() => onReport(w.roomId!)}>Report</button>}
                  {w.state !== 'ended' && <button className={`btn sm${w.state === 'live' ? ' primary' : ''}`} disabled={busy} onClick={() => go(w.meetingId)}>{w.role === 'attendee' ? 'Watch' : 'Join the stage'}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {canHost && (
        <div className="meet-block-foot">
          <span className="faint">Registration, a practice session, Q&amp;A, polls, handouts and a live stream.</span>
          <button className="btn" onClick={() => setPlanning(true)}><Icon name="calendar" size={15} />Plan a webinar</button>
        </div>
      )}
      {planning && <PlanWebinar session={session} onClose={() => setPlanning(false)} onDone={(w) => { setPlanning(false); bumpWebinars(); onOpen(w.meetingId); }} />}
    </Block>
  );
}

// ------------------------------------------------------------------ the organiser's questions
export function FieldsEditor({ value, onChange, what }: { value: WebinarFieldInput[]; onChange: (v: WebinarFieldInput[]) => void; what: string }) {
  const set = (i: number, p: Partial<WebinarFieldInput>) => onChange(value.map((f, j) => (j === i ? { ...f, ...p } : f)));
  return (
    <div className="wb-fields">
      {value.map((f, i) => (
        <div key={i} className="wb-field-row">
          <span className="mono wb-field-no">Q{i + 1}</span>
          <input className="input" aria-label={`${what} ${i + 1}`} placeholder="For example, Company" maxLength={120} value={f.label} onChange={(e) => set(i, { label: e.target.value })} />
          <select className="input" aria-label={`Kind of answer to ${what.toLowerCase()} ${i + 1}`} value={f.kind} onChange={(e) => set(i, { kind: e.target.value as 'text' | 'choice' })}>
            <option value="text">A line of text</option><option value="choice">One of a list</option>
          </select>
          <label className="check-line"><input type="checkbox" checked={!!f.required} onChange={(e) => set(i, { required: e.target.checked })} />Required</label>
          <button type="button" className="icon-btn" aria-label={`Remove ${what.toLowerCase()} ${i + 1}`} onClick={() => onChange(value.filter((_, j) => j !== i))}><Icon name="x" size={14} /></button>
          {f.kind === 'choice' && <textarea className="input wb-field-opts" rows={3} aria-label={`Answers to choose from for ${what.toLowerCase()} ${i + 1}, one a line`} placeholder={'Answers to choose from, one a line'} value={(f.options ?? []).join('\n')} onChange={(e) => set(i, { options: e.target.value.split('\n') })} />}
        </div>
      ))}
      {value.length < 12 && <button type="button" className="btn sm ghost" onClick={() => onChange([...value, { label: '', kind: 'text', required: false }])}><Icon name="plus" size={14} />Add a question</button>}
    </div>
  );
}

const cleanFields = (v: WebinarFieldInput[]) => v.filter((f) => f.label.trim()).map((f) => ({ ...f, label: f.label.trim(), options: f.kind === 'choice' ? (f.options ?? []).map((o) => o.trim()).filter(Boolean) : [] }));
const toLocalInput = (t: number) => { const d = new Date(t); const p = (n: number) => String(n).padStart(2, '0'); return { date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: `${p(d.getHours())}:${p(d.getMinutes())}` }; };
const fromLocalInput = (date: string, time: string) => new Date(`${date}T${time || '00:00'}`).getTime();

function PlanWebinar({ session, onClose, onDone }: { session: Session; onClose: () => void; onDone: (w: WebinarInfo) => void }) {
  const toast = useToast();
  const soon = toLocalInput(Math.ceil((Date.now() + 86_400_000) / 1800_000) * 1800_000);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(soon.date);
  const [time, setTime] = useState(soon.time);
  const [duration, setDuration] = useState(60);
  const [panelists, setPanelists] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [approval, setApproval] = useState<'auto' | 'manual'>('auto');
  const [listed, setListed] = useState(true);
  const [fields, setFields] = useState<WebinarFieldInput[]>([{ label: 'Company', kind: 'text', required: false }]);
  const [saving, setSaving] = useState(false);
  const byId = new Map(session.users.map((u) => [u.id, u] as const));
  const candidates = session.users.filter((u) => u.role !== 'bot' && u.id !== session.me.id && !panelists.includes(u.id) && q && u.displayName.toLowerCase().includes(q.toLowerCase())).slice(0, 6);
  const save = async () => {
    setSaving(true);
    try {
      const w = await window.dex.request('web.create', { title: title.trim(), description: description.trim(), startsAt: fromLocalInput(date, time), durationMin: duration, panelists, settings: { approval, listed }, fields: cleanFields(fields) });
      toast('Webinar planned: share its registration page');
      onDone(w);
    } catch (e) { toast((e as Error).message, true); }
    setSaving(false);
  };
  return (
    <Dialog title="Plan a webinar" onClose={onClose}>
      <form className="wb-plan" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label className="field-label" htmlFor="wb-title">Title</label>
        <input id="wb-title" className="input" autoFocus maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Pump skid design review" />
        <label className="field-label" htmlFor="wb-desc">What it is about <span className="faint">(on the registration page)</span></label>
        <textarea id="wb-desc" className="input" rows={3} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
        <div className="wb-plan-when">
          <label><span className="field-label">Date</span><input className="input" type="date" aria-label="Date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label><span className="field-label">Starts</span><input className="input" type="time" aria-label="Starts" value={time} onChange={(e) => setTime(e.target.value)} /></label>
          <label><span className="field-label">Length</span>
            <select className="input" aria-label="Length" value={duration} onChange={(e) => setDuration(Number(e.target.value))}>{[30, 45, 60, 90, 120, 180].map((m) => <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} h${m % 60 ? ` ${m % 60} min` : ''}`}</option>)}</select>
          </label>
        </div>
        <span className="field-label">Panelists <span className="faint">(up to 7, besides you: they are seen and heard)</span></span>
        <div className="meet-invite">
          {panelists.map((id) => <span key={id} className="chip accent">{byId.get(id)?.displayName ?? 'Someone'}<button type="button" aria-label={`Remove ${byId.get(id)?.displayName ?? ''}`} onClick={() => setPanelists(panelists.filter((x) => x !== id))}><Icon name="x" size={11} /></button></span>)}
          <input className="input" placeholder="Add a panelist" aria-label="Add a panelist" value={q} onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && candidates[0]) { e.preventDefault(); setPanelists([...panelists, candidates[0].id]); setQ(''); } }} />
        </div>
        {candidates.length > 0 && (
          <div className="meet-suggest" role="listbox" aria-label="People">
            {candidates.map((u: PublicUser) => <button type="button" key={u.id} role="option" aria-selected="false" onClick={() => { setPanelists([...panelists, u.id]); setQ(''); }}><Avatar user={u} presence={presenceFor(u.id)} size="sm" />{u.displayName}<span className="faint">{u.title}</span></button>)}
          </div>
        )}
        <div className="wb-plan-opts">
          <label className="meet-opt"><span className="label">Registration</span>
            <select className="input" value={approval} onChange={(e) => setApproval(e.target.value as 'auto' | 'manual')}><option value="auto">Everyone who registers gets a place</option><option value="manual">I approve each registrant</option></select>
          </label>
          <label className="check-line"><input type="checkbox" checked={listed} onChange={(e) => setListed(e.target.checked)} />Everyone in the office can watch it from the Meet lens</label>
        </div>
        <span className="field-label">Questions on the registration page <span className="faint">(besides name and email)</span></span>
        <FieldsEditor value={fields} onChange={setFields} what="Question" />
        <div className="dialog-actions"><span /><button type="button" className="btn ghost" onClick={onClose}>Cancel</button><button className="btn primary" disabled={saving || !title.trim()}>{saving ? <span className="spinner" /> : <Icon name="calendar" size={15} />}Plan webinar</button></div>
      </form>
    </Dialog>
  );
}

// ------------------------------------------------------------------ the webinar's sheet
type SheetTab = 'setup' | 'registrants' | 'stream' | 'followup' | 'report';
const SHEET_TABS: Array<{ id: SheetTab; label: string }> = [{ id: 'setup', label: 'Setup' }, { id: 'registrants', label: 'Registrants' }, { id: 'stream', label: 'Live stream' }, { id: 'followup', label: 'Follow-up' }, { id: 'report', label: 'Report' }];

export function WebinarSheet({ meetingId, session, onClose, onReport }: { meetingId: string; session: Session; onClose: () => void; onReport: (roomId: string) => void }) {
  const toast = useToast();
  const [info, setInfo] = useState<WebinarInfo | null>(null);
  const [tab, setTab] = useState<SheetTab>('setup');
  // the counts follow new registrations and decisions
  const registered = useWeb((s) => s.stage.get(meetingId)?.registrants ?? 0);
  const [decided, setDecided] = useState(0);
  useEffect(() => { void window.dex.request('web.get', { id: meetingId }).then(setInfo).catch((e: Error) => { toast(e.message, true); onClose(); }); }, [meetingId, registered, decided]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.scrim')) onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  const organizer = info?.role === 'organizer';
  const tabs = organizer ? SHEET_TABS : SHEET_TABS.filter((t) => t.id === 'setup' || t.id === 'report');
  return (
    <div className="sheet-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet wide wb-sheet-panel" role="dialog" aria-label={info ? `Webinar: ${info.title}` : 'Webinar'}>
        <button className="sheet-close" aria-label="Close" onClick={onClose}><Icon name="x" size={16} /></button>
        {!info && <div className="tl-more"><span className="spinner" /></div>}
        {info && (
          <div className="wb-sheet-grid">
            <header className="wb-sheet-head">
              <span className="label">Webinar · {formatMeetingId(info.meetingId)}</span>
              <h1>{info.title}</h1>
              <p className="faint">{when(info)} · <span className={`wb-state-tag mono ${info.state}`}>{info.state === 'live' && <i aria-hidden="true" />}{STATE_LABEL[info.state]}</span></p>
              <nav className="wb-sheet-tabs" role="tablist" aria-label="Webinar sheet">
                {tabs.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>{t.label}{t.id === 'registrants' ? <span className="mono">{info.registrants.total}</span> : null}</button>)}
              </nav>
            </header>
            <div className="wb-sheet-body">
              {tab === 'setup' && <SetupTab info={info} session={session} onChange={setInfo} />}
              {tab === 'registrants' && <RegistrantsTab info={info} onDecided={() => setDecided((n) => n + 1)} />}
              {tab === 'stream' && <StreamTab info={info} session={session} onChange={setInfo} />}
              {tab === 'followup' && <FollowUpTab info={info} onChange={setInfo} />}
              {tab === 'report' && <ReportTab info={info} onReport={onReport} />}
            </div>
            <footer className="wb-sheet-foot">
              <dl className="wb-cells">
                <div><dt className="label">Registered</dt><dd className="mono">{info.registrants.total}</dd></div>
                <div><dt className="label">Approved</dt><dd className="mono">{info.registrants.approved}</dd></div>
                <div><dt className="label">Waiting</dt><dd className={`mono${info.registrants.pending ? ' wb-attn' : ''}`}>{info.registrants.pending}</dd></div>
                <div><dt className="label">On the stage</dt><dd className="mono">{info.panelists.length + 1} OF 8</dd></div>
              </dl>
              {info.state !== 'ended' && <button className="btn primary" onClick={() => { onClose(); void joinAny(info.meetingId, true).catch((e: Error) => toast(e.message, true)); }}><Glyph name="door" size={15} />{info.state === 'live' ? 'Back to the stage' : 'Open the stage (practice)'}</button>}
            </footer>
          </div>
        )}
      </div>
    </div>
  );
}

function SetupTab({ info, session, onChange }: { info: WebinarInfo; session: Session; onChange: (w: WebinarInfo) => void }) {
  const toast = useToast();
  const organizer = info.role === 'organizer';
  const [fields, setFields] = useState<WebinarFieldInput[]>(info.fields);
  const locked = info.registrants.total > 0;
  const save = (p: Record<string, unknown>, done = 'Saved') => void window.dex.request('web.update', { id: info.meetingId, ...p } as never).then((w) => { onChange(w as WebinarInfo); toast(done); }).catch((e: Error) => toast(e.message, true));
  const users = new Map(session.users.map((u) => [u.id, u] as const));
  return (
    <div className="wb-setup">
      <section className="wb-sec">
        <div className="tb-head"><span className="label">Registration page</span><span className="mono">{info.settings.approval === 'auto' ? 'AUTO-APPROVE' : 'YOU APPROVE'}</span></div>
        {info.registerUrl
          ? <div className="wb-linkrow"><code className="mono wb-url">{info.registerUrl}</code><button className="btn sm" onClick={() => void navigator.clipboard.writeText(info.registerUrl!).then(() => toast('Registration link copied'))}><Glyph name="copy" size={14} />Copy</button></div>
          : <p className="wb-problem-line">{info.problem}</p>}
        {info.registerUrl && info.problem && <p className="wb-problem-line">{info.problem}</p>}
        {organizer && (
          <div className="wb-toggles">
            <label className="check-line"><input type="checkbox" checked={info.settings.registrationOpen} onChange={(e) => save({ settings: { registrationOpen: e.target.checked } }, e.target.checked ? 'Registration is open' : 'Registration is closed')} />Registration is open</label>
            <label className="check-line"><input type="checkbox" checked={info.settings.approval === 'manual'} onChange={(e) => save({ settings: { approval: e.target.checked ? 'manual' : 'auto' } })} />I approve each registrant</label>
            <label className="check-line"><input type="checkbox" checked={info.settings.anonymousQuestions} onChange={(e) => save({ settings: { anonymousQuestions: e.target.checked } })} />Attendees may ask without their name</label>
            <label className="check-line"><input type="checkbox" checked={info.settings.listed} onChange={(e) => save({ settings: { listed: e.target.checked } })} />Everyone in the office can watch from the Meet lens</label>
            <label className="meet-opt"><span className="label">Most registrations</span>
              <input className="input wb-cap" type="number" min={1} max={5000} defaultValue={info.settings.cap} onBlur={(e) => { const n = Number(e.target.value); if (n !== info.settings.cap) save({ settings: { cap: n } }); }} /></label>
          </div>
        )}
      </section>
      <section className="wb-sec">
        <div className="tb-head"><span className="label">Questions on the form</span><span className="mono">{locked ? 'FIXED: PEOPLE HAVE REGISTERED' : `${fields.length}`}</span></div>
        {organizer && !locked
          ? <><FieldsEditor value={fields} onChange={setFields} what="Question" /><div className="wb-row-actions"><button className="btn sm primary" onClick={() => save({ fields: cleanFields(fields) }, 'The form is saved')}>Save the form</button></div></>
          : <ul className="wb-fieldlist">{info.fields.map((f) => <li key={f.id}><span className="mono">{f.id.toUpperCase()}</span>{f.label}{f.required ? ' *' : ''}<span className="faint"> · {f.kind === 'choice' ? f.options.join(' / ') : 'text'}</span></li>)}{!info.fields.length && <li className="faint">Name and email only.</li>}</ul>}
      </section>
      <section className="wb-sec">
        <div className="tb-head"><span className="label">On the stage</span><span className="mono">{info.panelists.length + 1} OF 8</span></div>
        <ul className="wb-people">
          <li><Avatar user={users.get(info.hostId) ?? { id: info.hostId, displayName: '?' }} size="sm" />{users.get(info.hostId)?.displayName ?? 'Someone'}<span className="role-tag">ORGANISER</span></li>
          {info.panelists.map((u) => <li key={u}><Avatar user={users.get(u) ?? { id: u, displayName: '?' }} size="sm" />{users.get(u)?.displayName ?? 'Someone'}<span className="role-tag">PANELIST</span></li>)}
        </ul>
        <p className="faint wb-note">Panelists meet in the webinar's backstage Space and on its stage. Attendees never see them until you go live.</p>
      </section>
    </div>
  );
}

function RegistrantsTab({ info, onDecided }: { info: WebinarInfo; onDecided: () => void }) {
  const toast = useToast();
  const bump = useWeb((s) => s.stage.get(info.meetingId)?.registrants ?? 0);
  const [list, setList] = useState<Registrant[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | Registrant['status']>('all');
  useEffect(() => { void window.dex.request('web.registrants', { id: info.meetingId }).then(setList).catch(() => setList([])); }, [info.meetingId, bump]);
  const shown = (list ?? []).filter((r) => filter === 'all' || r.status === filter);
  const ids = [...picked].filter((id) => shown.some((r) => r.id === id));
  const decide = (registrantIds: string[], approve: boolean) => void window.dex.request('web.decide', { id: info.meetingId, registrantIds, approve }).then((l) => { setList(l); setPicked(new Set()); onDecided(); toast(approve ? `${registrantIds.length} approved` : `${registrantIds.length} turned away`); }).catch((e: Error) => toast(e.message, true));
  const mails = (kind: 'invite' | 'reminder', registrantIds?: string[]) => window.dex.request('web.mail', { id: info.meetingId, kind, registrantIds, when: when(info) });
  const copyOne = (r: Registrant, kind: 'invite' | 'reminder') => void mails(kind, [r.id]).then((m) => { if (!m[0]) throw new Error('Approve them first.'); return navigator.clipboard.writeText(`To: ${m[0].email}\nSubject: ${m[0].subject}\n\n${m[0].text}`); }).then(() => toast(`${kind === 'invite' ? 'Invitation' : 'Reminder'} for ${r.name} copied`)).catch((e: Error) => toast(e.message, true));
  const icsOne = (r: Registrant) => void mails('invite', [r.id]).then((m) => { if (!m[0]?.ics) throw new Error('Approve them first.'); saveText(`${safeFile(info.title)} - ${safeFile(r.name)}.ics`, m[0].ics, 'text/calendar;charset=utf-8'); }).catch((e: Error) => toast(e.message, true));
  const bulk = (kind: 'invite' | 'reminder', how: 'copy' | 'csv') => void mails(kind, ids.length ? ids : undefined).then((m: WebinarMail[]) => {
    if (!m.length) throw new Error('No approved registrants to write to.');
    const links = new Map((list ?? []).map((r) => [r.id, r.joinUrl ?? ''] as const));
    if (how === 'csv') { saveText(`${safeFile(info.title)} ${kind === 'invite' ? 'invitations' : 'reminders'}.csv`, mailMergeCsv(m, links), 'text/csv;charset=utf-8'); toast(`${m.length} ${kind === 'invite' ? 'invitations' : 'reminders'} saved for a mail merge`); return; }
    return navigator.clipboard.writeText(m.map((x) => `To: ${x.email}\nSubject: ${x.subject}\n\n${x.text}`).join('\n\n———\n\n')).then(() => toast(`${m.length} ${kind === 'invite' ? 'invitations' : 'reminders'} copied`));
  }).catch((e: Error) => toast(e.message, true));
  const exportCsv = () => { if (list) saveText(`${safeFile(info.title)} registrants.csv`, registrantsCsv(info.fields, list), 'text/csv;charset=utf-8'); };
  const toggle = (id: string) => { const n = new Set(picked); if (n.has(id)) n.delete(id); else n.add(id); setPicked(n); };
  const after = info.state === 'ended' || (info.state !== 'live' && !!info.wentLiveAt);
  return (
    <div className="wb-regs">
      <div className="wb-regs-bar">
        <div className="wb-filter" role="tablist" aria-label="Which registrants">
          {(['all', 'pending', 'approved', 'rejected'] as const).map((f) => (
            <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}>{f === 'all' ? 'All' : f === 'pending' ? 'Waiting' : f === 'approved' ? 'Approved' : 'Turned away'}<span className="mono">{(list ?? []).filter((r) => f === 'all' || r.status === f).length}</span></button>
          ))}
        </div>
        <span className="wb-tools-fill" />
        <button className="btn sm ghost" onClick={exportCsv} disabled={!list?.length}><Icon name="download" size={14} />CSV</button>
      </div>
      <div className="wb-regs-bulk" role="group" aria-label="With the registrants chosen">
        <span className="mono faint">{ids.length ? `${ids.length} CHOSEN` : 'ALL APPROVED'}</span>
        {ids.length > 0 && <><button className="btn sm" onClick={() => decide(ids, true)}>Approve</button><button className="btn sm ghost" onClick={() => decide(ids, false)}>Turn away</button></>}
        <button className="btn sm ghost" onClick={() => bulk('invite', 'copy')}>Copy invitations</button>
        <button className="btn sm ghost" onClick={() => bulk('reminder', 'copy')}>Copy reminders</button>
        <button className="btn sm ghost" onClick={() => bulk('invite', 'csv')}>Mail-merge CSV</button>
      </div>
      {list === null && <div className="tl-more"><span className="spinner" /></div>}
      {list?.length === 0 && <p className="meet-empty">No one has registered yet. Share the registration page: {info.registerUrl ?? 'it needs the internet gateway'}.</p>}
      {shown.length > 0 && (
        <table className="wb-table">
          <thead><tr>
            <th className="wb-pick"><input type="checkbox" aria-label="Choose all shown" checked={ids.length === shown.length} onChange={(e) => setPicked(e.target.checked ? new Set(shown.map((r) => r.id)) : new Set())} /></th>
            <th>Name</th><th>Email</th><th>Registered</th><th>Status</th>{after && <th>Attended</th>}<th className="wb-act">Send</th>
          </tr></thead>
          <tbody>
            {shown.map((r) => (
              <Fragment key={r.id}>
                <tr className={`${r.status}${picked.has(r.id) ? ' picked' : ''}`}>
                  <td className="wb-pick"><input type="checkbox" aria-label={`Choose ${r.name}`} checked={picked.has(r.id)} onChange={() => toggle(r.id)} /></td>
                  <td><button className="wb-name" aria-expanded={open === r.id} onClick={() => setOpen(open === r.id ? null : r.id)}><b>{r.name}</b>{Object.keys(r.answers).length > 0 && <span className="mono faint"> · {Object.keys(r.answers).length} ANSWERS</span>}</button></td>
                  <td className="mono wb-email">{r.email}</td>
                  <td className="mono">{dayText(r.createdAt).toUpperCase()} {hm(r.createdAt)}</td>
                  <td>
                    <span className={`wb-status mono ${r.status}`}>{r.status === 'pending' ? 'WAITING' : r.status === 'approved' ? 'APPROVED' : 'TURNED AWAY'}</span>
                    {r.status === 'pending' && <span className="wb-inline"><button className="btn sm primary" onClick={() => decide([r.id], true)}>Approve</button><button className="btn sm ghost" onClick={() => decide([r.id], false)}>Turn away</button></span>}
                  </td>
                  {after && <td>{r.attended === null ? <span className="faint">—</span> : r.attended ? <span className="wb-status mono attended">ATTENDED · {r.minutes} MIN</span> : <span className="wb-status mono noshow">NO-SHOW</span>}</td>}
                  <td className="wb-act">
                    {r.status === 'approved' && <>
                      <button className="btn sm ghost" onClick={() => copyOne(r, 'invite')} title="The invitation with their personal link, to paste into an email">Invitation</button>
                      <button className="btn sm ghost" onClick={() => icsOne(r)} title="A calendar file with their personal link">.ics</button>
                      <button className="btn sm ghost" onClick={() => copyOne(r, 'reminder')}>Reminder</button>
                    </>}
                  </td>
                </tr>
                {open === r.id && (
                  <tr className="wb-answers"><td /><td colSpan={after ? 6 : 5}>
                    <dl>{info.fields.map((f) => <div key={f.id}><dt className="label">{f.label}</dt><dd>{r.answers[f.id] ?? '—'}</dd></div>)}</dl>
                    {r.joinUrl && <p className="mono faint wb-url">{r.joinUrl}</p>}
                  </td></tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
      <p className="faint wb-note">This app sends no email: copy the texts or save the .ics and mail-merge files and send them from your own mailbox. Each person's link is theirs alone.</p>
    </div>
  );
}

function StreamTab({ info, session, onChange }: { info: WebinarInfo; session: Session; onChange: (w: WebinarInfo) => void }) {
  const toast = useToast();
  const status = useWeb((s) => s.stage.get(info.meetingId)?.stream ?? null);
  const [url, setUrl] = useState(info.stream.url ?? '');
  const [key, setKey] = useState('');
  const [watch, setWatch] = useState(info.stream.watchUrl ?? '');
  const [ff, setFf] = useState<{ found: boolean; path: string | null; version: string | null; encoder: string | null; configured: string | null } | null>(null);
  const [path, setPath] = useState('');
  const [initial, setInitial] = useState(status);
  const admin = session.me.role === 'owner' || session.me.role === 'admin';
  useEffect(() => { void window.dex.request('web.ffmpeg').then((r) => { setFf(r); setPath(r.configured ?? ''); }).catch(() => {}); void window.dex.request('web.stream.status', { id: info.meetingId }).then(setInitial).catch(() => {}); }, [info.meetingId]);
  const st = status ?? initial;
  const on = !!st && ['starting', 'live', 'stalled'].includes(st.state);
  const save = () => void window.dex.request('web.stream.set', { id: info.meetingId, url: url.trim(), ...(key.trim() ? { key: key.trim() } : {}), watchUrl: watch.trim() }).then((w) => { onChange(w); setKey(''); toast('Stream settings saved on the hub'); }).catch((e: Error) => toast(e.message, true));
  const start = () => void window.dex.request('web.stream.start', { id: info.meetingId }).then(setInitial).catch((e: Error) => toast(e.message, true));
  const stop = () => void window.dex.request('web.stream.stop', { id: info.meetingId }).then(setInitial).catch((e: Error) => toast(e.message, true));
  return (
    <div className="wb-stream">
      <section className="wb-sec">
        <div className="tb-head"><span className="label">The streaming service</span><span className="mono">RTMP</span></div>
        <form className="wb-streamform" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <label><span className="field-label">Stream address</span><input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="rtmp://a.rtmp.youtube.com/live2" aria-label="Stream address" /></label>
          <label><span className="field-label">Stream key {info.stream.keyHint && <span className="faint">(saved: {info.stream.keyHint})</span>}</span><input className="input mono" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder={info.stream.keyHint ? 'Leave empty to keep it' : 'From the service (kept on the hub only)'} aria-label="Stream key" /></label>
          <label><span className="field-label">Watch page <span className="faint">(optional: shown to viewers the webinar cannot take)</span></span><input className="input" value={watch} onChange={(e) => setWatch(e.target.value)} placeholder="https://www.youtube.com/watch?v=…" aria-label="Watch page" /></label>
          <div className="wb-row-actions"><button className="btn sm primary">Save</button></div>
        </form>
      </section>
      <section className={`wb-sec wb-health ${st?.state ?? 'off'}`}>
        <div className="tb-head"><span className="label">Stream health</span><span className="mono">{(st?.state ?? 'off').toUpperCase()}</span></div>
        <dl className="wb-cells">
          <div><dt className="label">Bitrate</dt><dd className="mono">{st?.bitrate != null ? `${Math.round(st.bitrate).toLocaleString()} kbit/s` : '—'}</dd></div>
          <div><dt className="label">Frames</dt><dd className="mono">{st?.fps != null ? `${Math.round(st.fps)} fps` : '—'}</dd></div>
          <div><dt className="label">Dropped</dt><dd className={`mono${st?.dropped ? ' wb-attn' : ''}`}>{st?.dropped ?? 0}</dd></div>
          <div><dt className="label">Encoder</dt><dd className="mono">{st?.ffmpeg ?? ff?.encoder ?? '—'}</dd></div>
        </dl>
        <p className={`wb-health-line${st?.state === 'failed' || st?.state === 'unavailable' || st?.state === 'stalled' ? ' bad' : ''}`} role="status">{streamLine(st)}</p>
        <div className="wb-row-actions">
          {!on && <button className="btn primary" disabled={!info.stream.url || info.state === 'ended' || !ff?.found} onClick={start} title={info.state === 'scheduled' ? 'Open the stage first' : undefined}><Icon name="record" size={15} />Start streaming</button>}
          {on && <button className="btn danger" onClick={stop}>Stop streaming</button>}
        </div>
        <p className="faint wb-note">The PC composing the stage sends it to the hub; ffmpeg on the hub PC encodes H.264 and AAC and sends it to the service. Start it while the stage is open (the practice session counts).</p>
      </section>
      <section className="wb-sec">
        <div className="tb-head"><span className="label">ffmpeg on the hub PC</span><span className="mono">{ff ? (ff.found ? 'FOUND' : 'NOT FOUND') : '…'}</span></div>
        {ff?.found ? <p className="wb-line"><code className="mono">{ff.path}</code> · {ff.version} · {ff.encoder}</p> : <p className="wb-problem-line">ffmpeg is not installed on the hub PC, so live streaming is not available yet.</p>}
        <details className="wb-help">
          <summary>Installing ffmpeg on a Windows hub PC</summary>
          <ol>
            <li>On the hub PC, open PowerShell as an administrator and run <code className="mono">winget install --id Gyan.FFmpeg -e --scope machine</code>. (Or download a release build marked "essentials" from the FFmpeg Windows builds and unzip it so that <code className="mono">C:\ffmpeg\bin\ffmpeg.exe</code> exists.)</li>
            <li>The hub looks in the path set below, then in PATH, then in <code className="mono">C:\Program Files\ffmpeg\bin</code>, <code className="mono">C:\ffmpeg\bin</code> and the winget, Chocolatey and Scoop folders.</li>
            <li>Restart the hub if it was running when PATH changed, or set the path here; it is checked again within a minute.</li>
          </ol>
        </details>
        {admin && (
          <form className="wb-linkrow" onSubmit={(e) => { e.preventDefault(); void window.dex.request('web.ffmpeg', { path: path.trim() || null }).then((r) => { setFf(r); toast(r.found ? 'ffmpeg found' : 'ffmpeg is not at that path'); }).catch((e2: Error) => toast(e2.message, true)); }}>
            <input className="input mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\ffmpeg\bin\ffmpeg.exe" aria-label="Path to ffmpeg on the hub PC" />
            <button className="btn sm">Use this path</button>
          </form>
        )}
      </section>
    </div>
  );
}

function FollowUpTab({ info, onChange }: { info: WebinarInfo; onChange: (w: WebinarInfo) => void }) {
  const toast = useToast();
  const [note, setNote] = useState(`Thank you for joining ${info.title}. The slides are in the handouts.`);
  const [recs, setRecs] = useState<RecordingInfo[]>([]);
  const [rec, setRec] = useState('');
  const [outside, setOutside] = useState(info.stream.watchUrl ?? '');
  const [survey, setSurvey] = useState<WebinarFieldInput[]>(info.survey.length ? info.survey : [{ label: 'How useful was it?', kind: 'choice', options: ['Very useful', 'Somewhat useful', 'Not useful'], required: true }, { label: 'What should we cover next?', kind: 'text', required: false }]);
  const [withSurvey, setWithSurvey] = useState(true);
  const [result, setResult] = useState<{ sentInApp: number; mails: WebinarMail[] } | null>(null);
  const [sending, setSending] = useState(false);
  useEffect(() => { void window.dex.request('rec.list', { limit: 50 }).then((l) => setRecs(l.filter((r) => r.meetingId === info.meetingId && r.status === 'ready'))).catch(() => {}); }, [info.meetingId]);
  const ready = !!info.wentLiveAt && info.state !== 'live';
  const send = async () => {
    setSending(true);
    try {
      const r = await window.dex.request('web.followup', { id: info.meetingId, note, recordingId: rec || null, outsideLink: outside.trim() || null, survey: withSurvey ? cleanFields(survey) : [], when: when(info) });
      setResult(r);
      onChange({ ...info, followUpAt: Date.now() });
      toast(`Sent to ${r.sentInApp} ${r.sentInApp === 1 ? 'colleague' : 'colleagues'} in the app; ${r.mails.length} ${r.mails.length === 1 ? 'email' : 'emails'} to send`);
      setTimeout(() => document.querySelector('.wb-followup .wb-sent')?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 50);
    } catch (e) { toast((e as Error).message, true); }
    setSending(false);
  };
  const csv = () => { if (result) saveText(`${safeFile(info.title)} follow-up.csv`, mailMergeCsv(result.mails, new Map()), 'text/csv;charset=utf-8'); };
  return (
    <div className="wb-followup">
      {!ready && <p className="wb-problem-line">{info.state === 'live' ? 'End the webinar first: the follow-up goes to who attended.' : 'The follow-up is for after the webinar has been live.'}</p>}
      <section className="wb-sec">
        <div className="tb-head"><span className="label">The thank-you</span><span className="mono">{info.followUpAt ? `SENT ${dayText(info.followUpAt).toUpperCase()}` : 'NOT SENT'}</span></div>
        <textarea className="input" rows={4} maxLength={3000} value={note} onChange={(e) => setNote(e.target.value)} aria-label="Your note" />
        <label className="meet-opt"><span className="label">Recording, for colleagues</span>
          <select className="input" value={rec} onChange={(e) => setRec(e.target.value)} aria-label="Recording for colleagues">
            <option value="">No recording</option>{recs.map((r) => <option key={r.id} value={r.id}>{r.title} · {hm(r.startedAt)} · {r.recordedByName}</option>)}
          </select>
        </label>
        <label className="meet-opt"><span className="label">Recording link, for people outside</span>
          <input className="input" value={outside} onChange={(e) => setOutside(e.target.value)} placeholder="https://… (the live stream's video, for example)" aria-label="Recording link for people outside" />
        </label>
      </section>
      <section className="wb-sec">
        <div className="tb-head"><span className="label">Survey</span><label className="check-line"><input type="checkbox" checked={withSurvey} onChange={(e) => setWithSurvey(e.target.checked)} />Ask for answers</label></div>
        {withSurvey && <FieldsEditor value={survey} onChange={setSurvey} what="Survey question" />}
      </section>
      <div className="wb-row-actions">
        <span className="faint">Colleagues who watched get it in the app; people who registered get email text to send from your mailbox, marked by who attended.</span>
        <button className="btn primary" disabled={!ready || sending} onClick={() => void send()}>{sending ? <span className="spinner" /> : <Icon name="send" size={15} />}{info.followUpAt ? 'Send again' : 'Send the follow-up'}</button>
      </div>
      {result && (
        <section className="wb-sec wb-sent">
          <div className="tb-head"><span className="label">Sent in the app · {result.sentInApp}</span><span className="mono">{result.mails.length} EMAILS TO SEND</span></div>
          <div className="wb-row-actions">
            <button className="btn sm" onClick={() => void navigator.clipboard.writeText(result.mails.map((m) => `To: ${m.email}\nSubject: ${m.subject}\n\n${m.text}`).join('\n\n———\n\n')).then(() => toast('All follow-up emails copied'))}><Glyph name="copy" size={14} />Copy all</button>
            <button className="btn sm ghost" onClick={csv}><Icon name="download" size={14} />Mail-merge CSV</button>
          </div>
          <table className="wb-table">
            <thead><tr><th>Name</th><th>Email</th><th>Attended</th><th className="wb-act">Text</th></tr></thead>
            <tbody>{result.mails.map((m) => (
              <tr key={m.registrantId}><td><b>{m.name}</b></td><td className="mono wb-email">{m.email}</td><td>{/^Thank you/.test(m.subject) ? <span className="wb-status mono attended">ATTENDED</span> : <span className="wb-status mono noshow">NO-SHOW</span>}</td>
                <td className="wb-act"><button className="btn sm ghost" onClick={() => void navigator.clipboard.writeText(`To: ${m.email}\nSubject: ${m.subject}\n\n${m.text}`).then(() => toast(`Follow-up for ${m.name} copied`))}>Copy</button></td></tr>
            ))}</tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function ReportTab({ info, onReport }: { info: WebinarInfo; onReport: (roomId: string) => void }) {
  const toast = useToast();
  const [r, setR] = useState<WebinarReport | null>(null);
  useEffect(() => { void window.dex.request('web.report', { id: info.meetingId }).then(setR).catch((e: Error) => toast(e.message, true)); }, [info.meetingId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!r) return <div className="tl-more"><span className="spinner" /></div>;
  const approved = r.registrants.filter((x) => x.status === 'approved');
  const came = approved.filter((x) => x.attended).length;
  return (
    <div className="wb-report">
      <dl className="wb-cells wb-report-cells">
        <div><dt className="label">Registered</dt><dd className="mono">{r.registrants.length}</dd></div>
        <div><dt className="label">Attended</dt><dd className="mono">{came} OF {approved.length}</dd></div>
        <div><dt className="label">From the office</dt><dd className="mono">{r.attendees.filter((a) => a.office).length}</dd></div>
        <div><dt className="label">Most at once</dt><dd className="mono">{r.peakAudience}</dd></div>
        <div><dt className="label">Questions</dt><dd className="mono">{r.questions.length}</dd></div>
        <div><dt className="label">Survey answers</dt><dd className="mono">{r.survey.answers.length}</dd></div>
      </dl>
      <div className="wb-row-actions">
        <button className="btn sm" onClick={() => saveText(`${safeFile(r.title)} webinar report.csv`, webinarReportCsv(r), 'text/csv;charset=utf-8')}><Icon name="download" size={14} />Export CSV</button>
        {info.roomId && <button className="btn sm ghost" onClick={() => onReport(info.roomId!)}>The meeting's report</button>}
      </div>
      <section className="wb-sec">
        <div className="tb-head"><span className="label">Attendees</span><span className="mono">{r.attendees.length}</span></div>
        <table className="wb-table">
          <thead><tr><th>Name</th><th>From</th><th className="num">Minutes</th><th className="num">Hands</th></tr></thead>
          <tbody>{r.attendees.map((a, i) => <tr key={i}><td><b>{a.name}</b>{a.email && <span className="mono faint"> · {a.email}</span>}</td><td><span className="role-tag">{a.office ? 'OFFICE' : 'REGISTERED'}</span></td><td className="mono num">{a.minutes}</td><td className="mono num">{a.hands || '·'}</td></tr>)}</tbody>
        </table>
      </section>
      <section className="wb-sec">
        <div className="tb-head"><span className="label">Questions</span><span className="mono">{r.questions.filter((q) => q.status === 'answered' || q.status === 'live').length} ANSWERED</span></div>
        <ol className="wb-qlist">{r.questions.map((q) => <li key={q.id} className="wb-q"><span className="wb-votes mono">▲<b>{q.votes}</b></span><div className="wb-q-body"><p className="wb-q-text">{q.text}</p><p className="wb-q-meta mono">{[q.anonymous ? 'ANONYMOUS' : q.author.toUpperCase(), q.status === 'live' ? 'ANSWERED LIVE' : q.status.toUpperCase()].join(' · ')}</p>{q.answer?.text && <p className="wb-q-answer">{q.answer.text}</p>}</div></li>)}</ol>
      </section>
      {r.polls.length > 0 && (
        <section className="wb-sec">
          <div className="tb-head"><span className="label">Polls</span><span className="mono">{r.polls.length}</span></div>
          {r.polls.map((p, i) => { const most = Math.max(1, ...p.options.map((o) => o.votes)); return <div key={i} className="rep-poll"><p><b>{p.question}</b> <span className="faint mono">{p.voters} ANSWERED</span></p>{p.options.map((o) => <div key={o.text} className="rep-opt"><span>{o.text}</span><span className="rec-bar"><i style={{ width: `${(o.votes / most) * 100}%` }} /></span><span className="mono">{o.votes}</span></div>)}</div>; })}
        </section>
      )}
      {r.handouts.length > 0 && (
        <section className="wb-sec">
          <div className="tb-head"><span className="label">Handouts</span><span className="mono">{r.handouts.reduce((a, h) => a + h.downloads.length, 0)} DOWNLOADS</span></div>
          <ul className="wb-hlist">{r.handouts.map((h) => <li key={h.name}><Icon name="doc" size={16} /><span className="wb-hname"><b>{h.name}</b><span className="faint">{h.downloads.map((d) => d.name).join(', ') || 'Not downloaded'}</span></span><span className="mono">{h.downloads.length}</span></li>)}</ul>
        </section>
      )}
      {r.survey.fields.length > 0 && (
        <section className="wb-sec">
          <div className="tb-head"><span className="label">Survey</span><span className="mono">{r.survey.answers.length} ANSWERS</span></div>
          <table className="wb-table"><thead><tr><th>Who</th>{r.survey.fields.map((f) => <th key={f.id}>{f.label}</th>)}</tr></thead>
            <tbody>{r.survey.answers.map((a, i) => <tr key={i}><td><b>{a.name}</b></td>{r.survey.fields.map((f) => <td key={f.id}>{a.answers[f.id] ?? '—'}</td>)}</tr>)}</tbody></table>
        </section>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ the survey, for colleagues who watched
export function SurveySheet({ meetingId, onClose }: { meetingId: string; onClose: () => void }) {
  const toast = useToast();
  const [s, setS] = useState<{ title: string; fields: WebinarInfo['survey']; answered: boolean } | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);
  useEffect(() => { void window.dex.request('web.survey', { id: meetingId }).then(setS).catch((e: Error) => { toast(e.message, true); onClose(); }); }, [meetingId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return null;
  const send = () => void window.dex.request('web.survey.answer', { id: meetingId, answers }).then(() => { setDone(true); toast('Thank you: your answers are with the organiser'); }).catch((e: Error) => toast(e.message, true));
  return (
    <Dialog title={`Survey: ${s.title}`} onClose={onClose}>
      {s.answered || done
        ? <><p style={{ margin: 0 }}>Thank you. Your answers are with the organiser.</p><div className="dialog-actions"><span /><button className="btn primary" onClick={onClose}>Close</button></div></>
        : (
          <form className="wb-plan" onSubmit={(e) => { e.preventDefault(); send(); }}>
            {s.fields.map((f) => (
              <label key={f.id} className="wb-survey-q"><span className="field-label">{f.label}{f.required ? ' *' : ''}</span>
                {f.kind === 'choice'
                  ? <select className="input" value={answers[f.id] ?? ''} onChange={(e) => setAnswers({ ...answers, [f.id]: e.target.value })}><option value="">Choose one</option>{f.options.map((o) => <option key={o}>{o}</option>)}</select>
                  : <input className="input" maxLength={1000} value={answers[f.id] ?? ''} onChange={(e) => setAnswers({ ...answers, [f.id]: e.target.value })} />}
              </label>
            ))}
            <div className="dialog-actions"><span /><button type="button" className="btn ghost" onClick={onClose}>Not now</button><button className="btn primary" disabled={s.fields.some((f) => f.required && !answers[f.id]?.trim())}>Send answers</button></div>
          </form>
        )}
    </Dialog>
  );
}
