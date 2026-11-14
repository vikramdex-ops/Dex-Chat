// The Directory lens: everyone in the office as people cards, an org chart that walks the
// reporting lines, and departments. Selecting someone opens their profile beside the list.
import { useEffect, useMemo, useState } from 'react';
import type { Department, PublicUser, Session } from '@dex/core';
import type { AppState } from '../../shared/bridge.ts';
import { OfflineBanner } from '../App.tsx';
import { Avatar, Dialog, Icon, ROLE_LABEL, Segmented, presenceFor, useToast } from '../ui.tsx';
import { formatBirthday, formatJoined, managersOf, reportsOf, teamSize, useOrg } from '../org/store.ts';
import { startCall } from '../rooms/engine.ts';
import { addConversation } from '../chat/store.ts';

type View = 'people' | 'chart' | 'departments';
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
            <p className="label">{everyone.length} people · {online.size} online{org.departments.length ? ` · ${org.departments.length} departments` : ''}</p>
          </div>
          <Segmented<View> label="View" value={view} onChange={setView} options={[
            { value: 'people', label: 'People', icon: 'people' },
            { value: 'chart', label: 'Org chart', icon: 'list' },
            { value: 'departments', label: 'Departments', icon: 'grid' },
          ]} />
        </div>

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
                    <Avatar user={u} presence={presenceFor(u.id)} size="lg" />
                    <div className="who">
                      <div className="name">
                        <span className="line">{u.displayName}</span>
                        {u.id === session.me.id && <span className="chip accent">You</span>}
                        {(u.role === 'owner' || u.role === 'admin') && <span className="chip">{ROLE_LABEL[u.role]}</span>}
                        {u.role === 'guest' && <span className="chip warn">Guest</span>}
                      </div>
                      <div className="line muted">{u.title || (online.has(u.id) ? 'Online' : 'Offline')}</div>
                      <div className="line faint">{[departments.get(u.profile.departmentId ?? '')?.name, u.profile.extension && `Ext ${u.profile.extension}`].filter(Boolean).join(' · ') || u.account}</div>
                      {u.statusText && <div className="status">{u.statusText}</div>}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {view === 'chart' && <OrgChart people={everyone} users={users} meId={session.me.id} focus={selected} onFocus={setSelected} departments={departments} />}
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

// ------------------------------------------------------------------ profile panel
function ProfilePanel({ u, users, people, departments, meId, isAdmin, live, onClose, onPick, onMessage, onEdit, onChart }: {
  u: PublicUser; users: Map<string, PublicUser>; people: PublicUser[]; departments: Map<string, Department>; meId: string; isAdmin: boolean; live: boolean;
  onClose: () => void; onPick: (id: string) => void; onMessage: (id: string) => void; onEdit: () => void; onChart: () => void;
}) {
  const toast = useToast();
  const org = useOrg();
  const manager = u.profile.managerId ? users.get(u.profile.managerId) : undefined;
  const reports = reportsOf(u.id, people);
  const dept = u.profile.departmentId ? departments.get(u.profile.departmentId) : undefined;
  const call = async (video: boolean) => {
    try {
      const c = await window.dex.request('conv.create', { kind: 'direct', members: [u.id] });
      addConversation(c);
      await startCall(c.id, video);
    } catch (e) { toast((e as Error).message, true); }
  };
  const rows: Array<[string, string | null | undefined, boolean?]> = [
    ['Department', dept?.name],
    ['Extension', u.profile.extension, true],
    ['Phone', u.profile.phone, true],
    ['Email', u.profile.email, true],
    ['Seat', u.profile.location],
    ['Employee ID', u.profile.employeeId, true],
    ['Joined', formatJoined(u.profile.joinedOn)],
    ['Birthday', formatBirthday(u.profile.birthday)],
    ['Windows account', u.account, true],
    ...org.fields.map((f): [string, string | undefined] => [f.label, u.profile.fields[f.id]]),
  ];
  return (
    <aside className="profile-panel" aria-label={`${u.displayName}'s profile`}>
      <button className="icon-btn profile-close" onClick={onClose} aria-label="Close profile"><Icon name="x" size={16} /></button>
      <div className="profile-hero">
        <Avatar user={u} presence={presenceFor(u.id)} size="lg" />
        <h2>{u.displayName}</h2>
        <p className="muted">{u.title ?? ROLE_LABEL[u.role]}</p>
        {u.statusText && <div className="status">{u.statusText}</div>}
        {u.id !== meId && (
          <div className="row-actions">
            <button className="btn primary" disabled={!live} onClick={() => onMessage(u.id)}><Icon name="chat" size={15} />Message</button>
            <button className="icon-btn" disabled={!live} title="Voice call" aria-label="Voice call" onClick={() => void call(false)}><Icon name="phone" size={17} /></button>
            <button className="icon-btn" disabled={!live} title="Video call" aria-label="Video call" onClick={() => void call(true)}><Icon name="video" size={17} /></button>
          </div>
        )}
      </div>
      <dl className="profile-facts">
        {rows.filter(([, v]) => v).map(([k, v, mono]) => (
          <div key={k}><dt>{k}</dt><dd className={`selectable${mono ? ' mono' : ''}`}>{v}</dd></div>
        ))}
      </dl>
      {(manager || reports.length > 0) && (
        <div className="profile-line">
          {manager && (
            <>
              <div className="label">Reports to</div>
              <button className="mini-person" onClick={() => onPick(manager.id)}><Avatar user={manager} presence={presenceFor(manager.id)} size="sm" /><span><b>{manager.displayName}</b><span className="faint">{manager.title}</span></span></button>
            </>
          )}
          {reports.length > 0 && (
            <>
              <div className="label">Direct reports · {reports.length}</div>
              {reports.map((r) => (
                <button key={r.id} className="mini-person" onClick={() => onPick(r.id)}><Avatar user={r} presence={presenceFor(r.id)} size="sm" /><span><b>{r.displayName}</b><span className="faint">{r.title}</span></span></button>
              ))}
            </>
          )}
          <button className="link" onClick={onChart}>See in the org chart</button>
        </div>
      )}
      {isAdmin && u.role !== 'bot' && <button className="btn" onClick={onEdit}><Icon name="edit" size={15} />Edit details</button>}
    </aside>
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
    return <div className="empty"><Icon name="list" size={36} /><span>No reporting lines yet. An administrator can set who reports to whom in each profile, or import them from a spreadsheet in the Control room.</span></div>;
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
        {centre.id !== meId && <button className="btn ghost sm" onClick={() => onFocus(meId)}>Me</button>}
      </div>
      {ladder.length > 0 && <div className="org-ladder">{ladder.map((u) => node(u, 'up'))}</div>}
      <div className="org-centre">
        {node(centre, 'centre')}
        {peers.length > 0 && <div className="org-peers"><span className="label">Same manager</span>{peers.slice(0, 8).map((p) => node(p, 'peer'))}{peers.length > 8 && <span className="faint">+{peers.length - 8} more</span>}</div>}
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
      <div className="field"><label htmlFor="pe-mgr">Reports to</label>
        <select id="pe-mgr" className="input" value={f.managerId} onChange={set('managerId')}>
          <option value="">No one</option>
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
        <button className="btn primary" disabled={busy} onClick={() => void save()}>Save</button>
      </div>
    </Dialog>
  );
}
