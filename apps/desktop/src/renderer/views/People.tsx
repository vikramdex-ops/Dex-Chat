// The Directory lens: everyone in the office as people cards, an org chart that walks the
// reporting lines, departments and the team's day log. Selecting someone opens their card beside
// the list, drawn as a drawing title block.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Department, PublicUser, Session } from '@dex/core';
import type { AppState } from '../../shared/bridge.ts';
import { OfflineBanner } from '../App.tsx';
import { Avatar, Dialog, Icon, Popover, ROLE_LABEL, Segmented, presenceFor, presenceText, useToast, relativeTime } from '../ui.tsx';
import type { IconName } from '../ui.tsx';
import { formatBirthday, formatJoined, managersOf, reportsOf, teamSize, useOrg } from '../org/store.ts';
import { startCall } from '../rooms/engine.ts';
import { addConversation } from '../chat/store.ts';
import { useWork, workLine } from '../work/store.ts';
import { TeamDayLog } from '../work/WorkUi.tsx';
import './people.css';

/**
 * Sheet tabs: labels sitting on a ruled line, the open one cut into it like the tab of a
 * drawing sheet. Counts sit in a small mono box. Shared by the Directory, the Desk and Search.
 */
export function SheetTabs<T extends string>({ value, onChange, label, tabs }: {
  value: T; onChange: (v: T) => void; label: string; tabs: Array<{ value: T; label: string; count?: number | string; icon?: IconName; attention?: boolean }>;
}) {
  return (
    <div className="sheet-tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button key={t.value} type="button" role="tab" aria-selected={value === t.value} className="sheet-tab" onClick={() => onChange(t.value)}>
          {t.icon && <Icon name={t.icon} size={15} />}
          <span>{t.label}</span>
          {!!t.count && <span className={`sheet-n mono${t.attention ? ' attention' : ''}`}>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

type View = 'people' | 'chart' | 'departments' | 'daylog';
type Filter = 'all' | 'online';

export function People({ state, session, query, setQuery, focusUser, onMessage }: {
  state: AppState; session: Session; query: string; setQuery: (q: string) => void; focusUser: string | null; onMessage: (userId: string) => void;
}) {
  const [view, setView] = useState<View>('people');
  const [filter, setFilter] = useState<Filter>('all');
  const [dept, setDept] = useState<string>('');
  const [selected, setSelected] = useState<string | null>(focusUser);
  const [editing, setEditing] = useState<string | null>(null);
  const org = useOrg();
  const online = useMemo(() => new Set(session.online), [session.online]);
  const users = useMemo(() => new Map(session.users.map((u) => [u.id, u] as const)), [session.users]);
  const everyone = useMemo(() => session.users.filter((u) => u.role !== 'bot'), [session.users]);
  const departments = useMemo(() => new Map(org.departments.map((d) => [d.id, d] as const)), [org.departments]);
  const isAdmin = session.me.role === 'owner' || session.me.role === 'admin';
  const live = state.phase === 'ready';
  const work = useWork();
  const managesSomeone = everyone.some((u) => u.profile.managerId === session.me.id);

  useEffect(() => { if (focusUser) { setSelected(focusUser); setView('people'); } }, [focusUser]);

  const people = useMemo(() => {
    const q = query.trim().toLowerCase();
    return everyone
      .filter((u) => filter === 'all' || online.has(u.id))
      .filter((u) => !dept || u.profile.departmentId === dept)
      .filter((u) => !q || [u.displayName, u.account, u.title ?? '', u.statusText ?? '', departments.get(u.profile.departmentId ?? '')?.name ?? '',
        u.profile.location ?? '', u.profile.extension ?? '', u.profile.employeeId ?? '', ...Object.values(u.profile.fields)].some((f) => f.toLowerCase().includes(q)))
      .sort((a, b) => Number(online.has(b.id)) - Number(online.has(a.id)) || a.displayName.localeCompare(b.displayName));
  }, [everyone, online, filter, query, dept, departments]);

  useEffect(() => {
    if (focusUser) document.getElementById(`person-${focusUser}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focusUser]);

  const sel = selected ? users.get(selected) : undefined;

  return (
    <div className={`directory${sel ? ' with-profile' : ''}`}>
      <div className="view directory-main">
        <OfflineBanner state={state} />
        <div className="view-head">
          <div>
            <h1>Directory</h1>
            <p className="label">{`${everyone.length} people · ${online.size} online`}{org.departments.length ? ` · ${org.departments.length} departments` : ''}</p>
          </div>
        </div>
        <SheetTabs<View> label="Directory view" value={view} onChange={setView} tabs={[
          { value: 'people', label: 'People' },
          { value: 'chart', label: 'Org chart' },
          { value: 'departments', label: 'Departments' },
          ...(isAdmin || managesSomeone ? [{ value: 'daylog' as View, label: 'Day log' }] : []),
        ]} />

        {view === 'people' && (
          <>
            <div className="toolbar">
              <input className="input" placeholder="Search name, title, department, extension…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search people" />
              {org.departments.length > 0 && (
                <select className="input dept-filter" value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Department">
                  <option value="">All departments</option>
                  {org.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              )}
              <Segmented<Filter> label="Show" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'Everyone' }, { value: 'online', label: 'Online' }]} />
            </div>
            {people.length === 0 ? (
              <div className="empty"><Icon name="people" size={36} /><span>No one matches.</span></div>
            ) : (
              <div className="grid cols-people">
                {people.map((u) => (
                  <button key={u.id} id={`person-${u.id}`} className={`card person interactive${selected === u.id ? ' selected' : ''}${focusUser === u.id ? ' flash' : ''}`} onClick={() => setSelected(u.id)}>
                    {u.profile.extension && <span className="person-ext mono" aria-label={`Extension ${u.profile.extension}`}>EXT {u.profile.extension}</span>}
                    <Avatar user={u} presence={presenceFor(u.id)} size="lg" />
                    <div className="who">
                      <div className="name">
                        <span className="line" translate="no" title={u.displayName}>{u.displayName}</span>
                        {u.id === session.me.id && <span className="chip accent">You</span>}
                        {(u.role === 'owner' || u.role === 'admin') && <span className="chip">{ROLE_LABEL[u.role]}</span>}
                        {u.role === 'guest' && <span className="chip warn">Guest</span>}
                      </div>
                      <div className="line muted" translate={u.title ? 'no' : undefined} title={u.title || undefined}>{u.title || (online.has(u.id) ? 'Online' : 'Offline')}</div>
                      <div className="line faint" translate="no">{departments.get(u.profile.departmentId ?? '')?.name ?? u.account}</div>
                      {workLine(work.get(u.id)) && <div className={`work-line ${work.get(u.id)?.status}`}><span className="work-dot" />{workLine(work.get(u.id))}</div>}
                      {u.ooo && u.ooo.until > Date.now() && <div className="work-line leave"><span className="work-dot" />On leave until {new Date(u.ooo.until).toLocaleDateString([], { day: 'numeric', month: 'short' })}</div>}
                      {u.statusText && <div className="status" translate="no">{u.statusEmoji ? `${u.statusEmoji} ` : ""}{u.statusText}</div>}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {view === 'chart' && <OrgChart people={everyone} users={users} meId={session.me.id} focus={selected} onFocus={setSelected} departments={departments} />}
        {view === 'daylog' && <TeamDayLog users={everyone} meId={session.me.id} isAdmin={isAdmin} />}
        {view === 'departments' && <Departments people={everyone} departments={org.departments} users={users} onOpen={(id) => { setDept(id); setView('people'); }} />}
      </div>

      {sel && (
        <ProfilePanel u={sel} users={users} people={everyone} departments={departments} meId={session.me.id} isAdmin={isAdmin} live={live}
          onClose={() => setSelected(null)} onPick={setSelected} onMessage={onMessage} onEdit={() => setEditing(sel.id)}
          onChart={() => setView('chart')} />
      )}
      {editing && users.get(editing) && <ProfileEditor u={users.get(editing)!} people={everyone} onClose={() => setEditing(null)} />}
    </div>
  );
}

// ------------------------------------------------------------------ profile: a title block
type Cell = { k: string; v: ReactNode; wide?: boolean; mono?: boolean; span?: boolean };

/** Lay cells out two to a row; a wide cell takes a whole row, and a cell left alone stretches. */
function rowsOf(cells: Cell[]): Cell[] {
  const out: Cell[] = [];
  let col = 0;
  for (const c of cells) {
    if (c.wide && col === 1) { out[out.length - 1] = { ...out[out.length - 1], span: true }; col = 0; }
    out.push(c.wide ? { ...c, span: true } : c);
    if (!c.wide) col ^= 1;
  }
  if (col === 1) out[out.length - 1] = { ...out[out.length - 1], span: true };
  return out;
}

const shortDate = (t: number) => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' });
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function ProfilePanel({ u, users, people, departments, meId, isAdmin, live, onClose, onPick, onMessage, onEdit, onChart }: {
  u: PublicUser; users: Map<string, PublicUser>; people: PublicUser[]; departments: Map<string, Department>; meId: string; isAdmin: boolean; live: boolean;
  onClose: () => void; onPick: (id: string) => void; onMessage: (id: string) => void; onEdit: () => void; onChart: () => void;
}) {
  const toast = useToast();
  const org = useOrg();
  const work = useWork().get(u.id);
  const [roomMenu, setRoomMenu] = useState(false);
  const roomBtn = useRef<HTMLButtonElement>(null);
  const manager = u.profile.managerId ? users.get(u.profile.managerId) : undefined;
  const reports = reportsOf(u.id, people);
  const dept = u.profile.departmentId ? departments.get(u.profile.departmentId) : undefined;
  const presence = presenceFor(u.id);
  const first = u.displayName.split(/\s+/)[0];
  const call = async (video: boolean) => {
    setRoomMenu(false);
    try {
      const c = await window.dex.request('conv.create', { kind: 'direct', members: [u.id] });
      addConversation(c);
      await startCall(c.id, video);
    } catch (e) { toast((e as Error).message, true); }
  };
  const onLeave = u.ooo && u.ooo.until > Date.now() ? u.ooo : null;
  const cells: Cell[] = [
    { k: 'Dept', v: dept?.name },
    { k: 'Ext', v: u.profile.extension, mono: true },
    { k: 'Seat', v: u.profile.location },
    {
      k: 'Line manager',
      v: manager ? <button className="tb-link" onClick={() => onPick(manager.id)}>{manager.displayName}</button> : null,
    },
    { k: 'Status', v: u.role === 'bot' ? null : <>{sentence(presenceText(u.id, presence))}{u.statusText && <span className="tb-sub">{u.statusEmoji ? `${u.statusEmoji} ` : ''}{u.statusText}</span>}</> },
    { k: 'Day', v: workLine(work) },
    { k: 'Last on', v: u.id !== meId && presence === 'off' && u.lastSeen ? relativeTime(u.lastSeen) : null },
    {
      k: 'On leave', wide: true,
      v: onLeave ? <>Until {shortDate(onLeave.until)}{onLeave.delegateId && <span className="tb-sub">Ask {users.get(onLeave.delegateId)?.displayName ?? 'a colleague'} meanwhile</span>}</> : null,
    },
    { k: 'Phone', v: u.profile.phone, mono: true },
    { k: 'Employee ID', v: u.profile.employeeId, mono: true },
    { k: 'Email', v: u.profile.email, mono: true, wide: true },
    { k: 'Joined', v: formatJoined(u.profile.joinedOn) },
    { k: 'Birthday', v: formatBirthday(u.profile.birthday) },
    ...org.fields.map((f): Cell => ({ k: f.label, v: u.profile.fields[f.id] })),
    { k: 'Windows account', v: u.account, mono: true, wide: true },
  ].filter((c) => c.v !== null && c.v !== undefined && c.v !== '');
  return (
    <aside className="profile-panel" aria-label={`${u.displayName}'s profile`}>
      <div className="pp-head">
        <span className="label">Directory card</span>
        <button className="icon-btn" onClick={onClose} aria-label="Close profile"><Icon name="x" size={16} /></button>
      </div>
      <div className="tblock">
        <div className="tb-head">
          <div className="tb-tile"><Avatar user={u} presence={presence} size="lg" /></div>
          <div className="tb-cell"><span className="tb-k">Name</span><span className="tb-v tb-name">{u.displayName}</span></div>
          <div className="tb-cell"><span className="tb-k">Title</span><span className="tb-v">{u.title ?? ROLE_LABEL[u.role]}</span></div>
        </div>
        <dl className="tb-body profile-facts">
          {rowsOf(cells).map((c) => (
            <div key={c.k} className={`tb-cell${c.span ? ' span' : ''}`}>
              <dt className="tb-k">{c.k}</dt>
              <dd className={`tb-v selectable${c.mono ? ' mono' : ''}`}>{c.v}</dd>
            </div>
          ))}
        </dl>
      </div>
      {u.id !== meId && u.role !== 'bot' && (
        <div className="pp-actions">
          <button className="btn primary" disabled={!live} onClick={() => onMessage(u.id)}><Icon name="edit" size={15} />Write to {first}</button>
          <button ref={roomBtn} className="btn room-btn" disabled={!live} aria-haspopup="menu" aria-expanded={roomMenu} onClick={() => setRoomMenu(!roomMenu)}>
            Open a Room<Icon name="back" size={13} className="chev-down" />
          </button>
          {roomMenu && (
            <Popover anchor={roomBtn.current} onClose={() => setRoomMenu(false)} className="menu" align="start">
              <button role="menuitem" onClick={() => void call(false)}><Icon name="phone" size={16} />With voice</button>
              <button role="menuitem" onClick={() => void call(true)}><Icon name="video" size={16} />With video</button>
            </Popover>
          )}
        </div>
      )}
      {reports.length > 0 && (
        <div className="profile-line">
          <div className="label">Their team · {reports.length}</div>
          {reports.map((r) => (
            <button key={r.id} className="mini-person" onClick={() => onPick(r.id)}><Avatar user={r} presence={presenceFor(r.id)} size="sm" /><span><b>{r.displayName}</b><span className="faint">{r.title}</span></span></button>
          ))}
        </div>
      )}
      {(manager || reports.length > 0) && <button className="link pp-chart" onClick={onChart}>See in the org chart</button>}
      {u.id !== meId && live && <InCommon userId={u.id} />}
      {isAdmin && u.role !== 'bot' && <button className="btn" onClick={onEdit}><Icon name="edit" size={15} />Edit details</button>}
    </aside>
  );
}

/** Spaces you are both in, and the Rooms you held together lately. */
function InCommon({ userId }: { userId: string }) {
  const [d, setD] = useState<{ spaces: Array<{ id: string; name: string }>; calls: Array<{ at: number; durationMs: number; missed: boolean; video: boolean; convId: string }> } | null>(null);
  useEffect(() => {
    let live = true;
    setD(null);
    window.dex.request('people.common', { userId }).then((v) => { if (live) setD(v); }).catch(() => {});
    return () => { live = false; };
  }, [userId]);
  if (!d || (!d.spaces.length && !d.calls.length)) return null;
  const mins = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`);
  return (
    <div className="profile-line in-common">
      {d.spaces.length > 0 && (
        <>
          <div className="label">Spaces in common · {d.spaces.length}</div>
          <div className="chip-row">{d.spaces.slice(0, 12).map((s) => <button key={s.id} className="chip" translate="no" title={s.name} onClick={() => void window.dex.openLink?.(`dexconnect://conversation/${s.id}`).catch(() => {})}># {s.name}</button>)}</div>
        </>
      )}
      {d.calls.length > 0 && (
        <>
          <div className="label">Rooms together</div>
          <ul className="call-history">{d.calls.slice(0, 6).map((c) => (
            <li key={c.at}><Icon name={c.video ? 'video' : 'phone'} size={13} /><span className={c.missed ? 'missed' : ''}>{c.missed ? 'Missed' : mins(c.durationMs)}</span><span className="faint">{new Date(c.at).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</span></li>
          ))}</ul>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ org chart
function OrgChart({ people, users, meId, focus, onFocus, departments }: {
  people: PublicUser[]; users: Map<string, PublicUser>; meId: string; focus: string | null; onFocus: (id: string) => void; departments: Map<string, Department>;
}) {
  const hasLines = people.some((u) => u.profile.managerId);
  // start at the top of the organisation (the person with the largest team)
  const top = useMemo(() => [...people].filter((u) => !u.profile.managerId || !users.has(u.profile.managerId))
    .sort((a, b) => teamSize(b.id, people) - teamSize(a.id, people))[0], [people, users]);
  const centre = (focus && users.get(focus)) || users.get(meId);
  if (!hasLines) {
    return <div className="empty"><Icon name="list" size={36} /><span>No line managers set yet. An administrator can set each person's line manager in their details, or import them from a spreadsheet in the Control room.</span></div>;
  }
  if (!centre) return null;
  const ladder = managersOf(centre.id, users).reverse();
  const reports = reportsOf(centre.id, people);
  const peers = centre.profile.managerId ? reportsOf(centre.profile.managerId, people).filter((p) => p.id !== centre.id) : [];
  const node = (u: PublicUser, kind: 'up' | 'centre' | 'down' | 'peer') => (
    <button key={u.id} className={`org-node ${kind}${u.id === meId ? ' me' : ''}`} onClick={() => onFocus(u.id)}>
      <Avatar user={u} presence={presenceFor(u.id)} size={kind === 'centre' ? 'lg' : 'sm'} />
      <span className="org-who">
        <b>{u.displayName}</b>
        <span className="faint">{u.title ?? departments.get(u.profile.departmentId ?? '')?.name ?? ''}</span>
        {kind !== 'up' && teamSize(u.id, people) > 0 && <span className="org-team">{teamSize(u.id, people)} in team</span>}
      </span>
    </button>
  );
  return (
    <div className="org-chart">
      <div className="org-tools">
        {top && top.id !== centre.id && <button className="btn ghost sm" onClick={() => onFocus(top.id)}><Icon name="back" size={14} />Top of the organisation</button>}
        {centre.id !== meId && <button className="btn ghost sm" onClick={() => onFocus(meId)}>Back to me</button>}
      </div>
      {ladder.length > 0 && <div className="org-ladder">{ladder.map((u) => node(u, 'up'))}</div>}
      <div className="org-centre">
        {node(centre, 'centre')}
        {peers.length > 0 && <div className="org-peers"><span className="label">Same line manager</span>{peers.slice(0, 8).map((p) => node(p, 'peer'))}{peers.length > 8 && <span className="faint">+{peers.length - 8} more</span>}</div>}
      </div>
      {reports.length > 0 && (
        <>
          <div className="org-rule"><span className="label">Direct reports · {reports.length}</span></div>
          <div className="org-reports">{reports.map((u) => node(u, 'down'))}</div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ departments
function Departments({ people, departments, users, onOpen }: { people: PublicUser[]; departments: Department[]; users: Map<string, PublicUser>; onOpen: (id: string) => void }) {
  if (!departments.length) return <div className="empty"><Icon name="grid" size={36} /><span>No departments yet. An administrator can add them in the Control room.</span></div>;
  const unassigned = people.filter((u) => !u.profile.departmentId).length;
  return (
    <div className="grid cols-3">
      {departments.map((d) => {
        const members = people.filter((u) => u.profile.departmentId === d.id);
        const head = d.headId ? users.get(d.headId) : undefined;
        const parent = d.parentId ? departments.find((x) => x.id === d.parentId) : undefined;
        return (
          <button key={d.id} className="card interactive dept-card" onClick={() => onOpen(d.id)}>
            <div className="eyebrow">{parent ? `${parent.name} ›` : 'Department'}</div>
            <h3>{d.name}</h3>
            <p className="muted">{members.length} {members.length === 1 ? 'person' : 'people'}{head ? ` · led by ${head.displayName}` : ''}</p>
            <div className="dept-faces">
              {members.slice(0, 8).map((u) => <Avatar key={u.id} user={u} presence={presenceFor(u.id)} size="sm" />)}
              {members.length > 8 && <span className="faint">+{members.length - 8}</span>}
            </div>
          </button>
        );
      })}
      {unassigned > 0 && <div className="card dept-card muted"><div className="eyebrow">Not in a department</div><h3>{unassigned}</h3><p className="faint">people</p></div>}
    </div>
  );
}

// ------------------------------------------------------------------ admin: edit someone's details
function ProfileEditor({ u, people, onClose }: { u: PublicUser; people: PublicUser[]; onClose: () => void }) {
  const toast = useToast();
  const org = useOrg();
  const [f, setF] = useState({
    title: u.title ?? '', departmentId: u.profile.departmentId ?? '', managerId: u.profile.managerId ?? '', phone: u.profile.phone ?? '',
    extension: u.profile.extension ?? '', location: u.profile.location ?? '', email: u.profile.email ?? '', employeeId: u.profile.employeeId ?? '',
    joinedOn: u.profile.joinedOn ?? '', birthday: u.profile.birthday ?? '', fields: { ...u.profile.fields } as Record<string, string>,
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    setBusy(true);
    try {
      await window.dex.request('admin.org.setProfile', {
        userId: u.id, title: f.title || null, departmentId: f.departmentId || null, managerId: f.managerId || null, phone: f.phone || null,
        extension: f.extension || null, location: f.location || null, email: f.email || null, employeeId: f.employeeId || null,
        joinedOn: f.joinedOn || null, birthday: f.birthday || null, fields: f.fields,
      });
      toast(`Saved ${u.displayName}'s details`);
      onClose();
    } catch (e) { toast((e as Error).message, true); setBusy(false); }
  };
  const input = (k: keyof typeof f, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div className="field"><label htmlFor={`pe-${k}`}>{label}</label><input id={`pe-${k}`} className="input" value={f[k] as string} onChange={set(k)} {...props} /></div>
  );
  return (
    <Dialog title={`${u.displayName}'s details`} onClose={onClose}>
      <div className="form-row">
        {input('title', 'Designation', { maxLength: 80, placeholder: 'Senior Piping Designer' })}
        <div className="field"><label htmlFor="pe-dept">Department</label>
          <select id="pe-dept" className="input" value={f.departmentId} onChange={set('departmentId')}>
            <option value="">None</option>
            {org.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
      </div>
      <div className="field"><label htmlFor="pe-mgr">Line manager</label>
        <select id="pe-mgr" className="input" value={f.managerId} onChange={set('managerId')}>
          <option value="">None</option>
          {people.filter((p) => p.id !== u.id).sort((a, b) => a.displayName.localeCompare(b.displayName)).map((p) => <option key={p.id} value={p.id}>{p.displayName}{p.title ? ` · ${p.title}` : ''}</option>)}
        </select>
      </div>
      <div className="form-row">
        {input('extension', 'Extension', { maxLength: 12 })}
        {input('phone', 'Phone', { maxLength: 40 })}
      </div>
      <div className="form-row">
        {input('email', 'Email', { maxLength: 120, type: 'email' })}
        {input('location', 'Seat or location', { maxLength: 80 })}
      </div>
      <div className="form-row">
        {input('employeeId', 'Employee ID', { maxLength: 40 })}
        {input('joinedOn', 'Joined on', { type: 'date' })}
      </div>
      <div className="form-row">
        {input('birthday', 'Birthday (MM-DD)', { maxLength: 5, placeholder: '06-30' })}
        <span />
      </div>
      {org.fields.length > 0 && (
        <div className="form-row">
          {org.fields.map((fd) => (
            <div key={fd.id} className="field"><label htmlFor={`pe-f-${fd.id}`}>{fd.label}</label>
              <input id={`pe-f-${fd.id}`} className="input" maxLength={200} value={f.fields[fd.id] ?? ''} onChange={(e) => setF({ ...f, fields: { ...f.fields, [fd.id]: e.target.value } })} />
            </div>
          ))}
        </div>
      )}
      <div className="dialog-actions">
        <span className="faint">{u.account}</span>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={() => void save()}>Save details</button>
      </div>
    </Dialog>
  );
}
