// Control room ▸ Nib & day sheets (docs/NIB.md §8): who hands out work, who receives the register,
// the times, how often Nib may ask, the workdays, the job codes and who sees day sheets. Every
// change is in the audit log (nib.config).
import { useEffect, useMemo, useState } from 'react';
import type { NibConfig, NibGiver, NibGiverKind, PublicUser, Session } from '@dex/core';
import { projectsFromText } from '@dex/core/nib';
import { Avatar, Icon, Segmented, Toggle, useToast } from '../ui.tsx';
import { useOrg } from '../org/store.ts';
import { PersonPick, Stepper } from './parts.tsx';
import { NibTile } from './NibMark.tsx';

const KINDS: Array<{ k: NibGiverKind; label: string; hint: string; scope: string }> = [
  { k: 'area', label: 'Area leads', hint: 'They hand out work for an area of a plant or a job.', scope: 'Area 4' },
  { k: 'discipline', label: 'Discipline leads', hint: 'Piping, structural, E&I, civil…', scope: 'Piping' },
  { k: 'team', label: 'Team leads', hint: 'Anyone else who gives people work.', scope: 'Modelling' },
];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function NibAdmin({ session }: { session: Session }) {
  const toast = useToast();
  const org = useOrg();
  const [cfg, setCfg] = useState<NibConfig | null>(null);
  const [saved, setSaved] = useState<string>('');
  const [jobs, setJobs] = useState('');
  const [busy, setBusy] = useState(false);
  const users = useMemo(() => new Map(session.users.map((u) => [u.id, u] as const)), [session.users]);
  const people = useMemo(() => session.users.filter((u) => u.role !== 'bot' && u.role !== 'guest'), [session.users]);
  useEffect(() => {
    void window.dex.request('admin.nib.get').then((c) => { setCfg(c); setSaved(JSON.stringify(c)); setJobs(c.projects.map((p) => `${p.code} ${p.name}`.trim()).join('\n')); }).catch((e: Error) => toast(e.message, true));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!cfg) return <div className="tl-more"><span className="spinner" /></div>;
  const set = (patch: Partial<NibConfig>) => setCfg({ ...cfg, ...patch });
  const next = { ...cfg, projects: projectsFromText(jobs) };
  const dirty = JSON.stringify(next) !== saved;
  const save = () => {
    setBusy(true);
    void window.dex.request('admin.nib.set', next).then((c) => { setCfg(c); setSaved(JSON.stringify(c)); toast('Saved. Nib uses it from now.'); }).catch((e: Error) => toast(e.message, true)).finally(() => setBusy(false));
  };
  const addGiver = (k: NibGiverKind, u: PublicUser, scope = '') => set({ givers: [...cfg.givers.filter((g) => !(g.userId === u.id && g.kind === k)), { userId: u.id, kind: k, scope }] });
  const heads = org.departments.filter((d) => d.headId && users.has(d.headId) && !cfg.givers.some((g) => g.userId === d.headId && g.kind === 'discipline'));
  const exempt = cfg.exempt;
  return (
    <div className="settings nib-admin">
      <div className="nib-admin-intro">
        <NibTile size={40} />
        <p className="muted">Nib asks people who gave them work, keeps their day sheets, sends each lead one card a day and the management one register. Set who is who, and when.</p>
      </div>

      <section>
        <h3>Activity givers</h3>
        {KINDS.map(({ k, label, hint, scope }) => {
          const list = cfg.givers.filter((g) => g.kind === k);
          return (
            <div key={k} className="setting nib-admin-givers">
              <Icon name="people" className="lead" />
              <div className="txt">
                <div>{list.length ? `${label} · ${list.length}` : label}</div>
                <div className="faint">{hint}</div>
                <ul className="nib-admin-list">
                  {list.map((g) => <GiverRow key={g.userId} g={g} u={users.get(g.userId)} placeholder={scope} onScope={(s) => set({ givers: cfg.givers.map((x) => (x === g ? { ...x, scope: s } : x)) })} onRemove={() => set({ givers: cfg.givers.filter((x) => x !== g) })} />)}
                </ul>
                <PersonPick users={people} exclude={list.map((g) => g.userId)} onPick={(u) => addGiver(k, u)} placeholder="Add someone" label={`Add one of the ${label.toLowerCase()}`} />
                {k === 'discipline' && heads.length > 0 && (
                  <button className="btn sm" onClick={() => set({ givers: [...cfg.givers, ...heads.map((d) => ({ userId: d.headId!, kind: 'discipline' as const, scope: d.name.slice(0, 40) }))] })}>
                    <Icon name="plus" size={14} />{heads.length === 1 ? 'Add the department head' : `Add the ${heads.length} department heads`}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </section>

      <section>
        <h3>Management</h3>
        <div className="setting">
          <Icon name="shield" className="lead" />
          <div className="txt">
            <div>Who receives the register</div>
            <div className="faint">One daily register, one follow-up when sheets come in late, and the week on its last workday. Never a message for each person.</div>
            <div className="nib-pick">
              {cfg.managers.map((id) => { const u = users.get(id); return u ? <button key={id} type="button" className="nib-giver on rm" aria-pressed onClick={() => set({ managers: cfg.managers.filter((x) => x !== id) })} title="Remove"><Avatar user={u} size="sm" /><span className="nib-giver-name" translate="no" title={u.displayName}>{u.displayName}</span><Icon name="x" size={12} /></button> : null; })}
            </div>
            <PersonPick users={people} exclude={cfg.managers} onPick={(u) => set({ managers: [...cfg.managers, u.id] })} placeholder="Add the office manager, a director…" label="Add someone to the management" />
          </div>
        </div>
        <div className="setting">
          <Icon name="user" className="lead" />
          <div className="txt">
            <div>Who keeps a day sheet</div>
            <div className="faint">{exempt === null ? 'Everyone except the management.' : exempt.length ? (exempt.length === 1 ? 'Everyone except one person.' : `Everyone except ${exempt.length} people.`) : 'Everyone, the management too.'}</div>
            {exempt !== null && (
              <>
                <div className="nib-pick">{exempt.map((id) => { const u = users.get(id); return u ? <button key={id} type="button" className="nib-giver on rm" aria-pressed onClick={() => set({ exempt: exempt.filter((x) => x !== id) })}><Avatar user={u} size="sm" /><span className="nib-giver-name" translate="no" title={u.displayName}>{u.displayName}</span><Icon name="x" size={12} /></button> : null; })}</div>
                <PersonPick users={people} exclude={exempt} onPick={(u) => set({ exempt: [...exempt, u.id] })} placeholder="Someone who keeps no day sheet" label="Someone who keeps no day sheet" />
              </>
            )}
          </div>
          <Segmented<'management' | 'custom'> label="Who keeps a day sheet" value={exempt === null ? 'management' : 'custom'} onChange={(v) => set({ exempt: v === 'management' ? null : [...cfg.managers] })} options={[{ value: 'management', label: 'All but the management' }, { value: 'custom', label: 'Choose' }]} />
        </div>
      </section>

      <section>
        <h3>Times</h3>
        <div className="setting nib-admin-times">
          <Icon name="clock" className="lead" />
          <div className="txt">
            <div>When Nib asks, and when the register goes</div>
            <div className="faint">A follow-up time before the register time means the next workday’s morning.</div>
            <div className="nib-admin-grid">
              <label className="field"><span>Start of the day card</span><input type="time" className="input" value={cfg.startPromptAt} onChange={(e) => set({ startPromptAt: e.target.value })} /></label>
              <label className="field"><span>Wrap-up</span><input type="time" className="input" value={cfg.wrapAt} onChange={(e) => set({ wrapAt: e.target.value })} /></label>
              <label className="field"><span>Register</span><input type="time" className="input" value={cfg.digestAt} onChange={(e) => set({ digestAt: e.target.value })} /></label>
              <label className="field"><span>Follow-up</span><input type="time" className="input" value={cfg.followUpAt} onChange={(e) => set({ followUpAt: e.target.value })} /></label>
            </div>
          </div>
        </div>
        <div className="setting">
          <Icon name="bell" className="lead" />
          <div className="txt"><div>Asks a day</div><div className="faint">At the wrap-up time a quiet mark, then a card, then one message. Never in a Room, a meeting or on Do not disturb.</div></div>
          <Stepper value={cfg.nudgeLimit} max={5} onChange={(v) => set({ nudgeLimit: Math.max(1, v) })} label="Asks a day" />
        </div>
        <div className="setting">
          <Icon name="calendar" className="lead" />
          <div className="txt"><div>Workdays</div><div className="faint">No asks and no register on other days.</div></div>
          <div className="seg" role="group" aria-label="Workdays">
            {[1, 2, 3, 4, 5, 6, 0].map((d) => { const on = cfg.workdays.includes(d); return <button key={d} type="button" aria-pressed={on} onClick={() => set({ workdays: on ? cfg.workdays.filter((x) => x !== d) : [...cfg.workdays, d].sort() })}>{DAYS[d]}</button>; })}
          </div>
        </div>
      </section>

      <section>
        <h3>Jobs and privacy</h3>
        <div className="setting">
          <Icon name="list" className="lead" />
          <div className="txt">
            <div>Job codes</div>
            <div className="faint">One per line, the code then its name. Nib reads them in people’s words and totals the register by them.</div>
            <textarea className="input mono" rows={4} value={jobs} placeholder={'P-12 Refinery revamp\nP-14 Tank farm'} aria-label="Job codes" onChange={(e) => setJobs(e.target.value)} />
          </div>
        </div>
        <div className="setting">
          <Icon name="eye" className="lead" />
          <div className="txt"><div>Who sees day sheets</div><div className="faint">{cfg.openSheets ? 'Everyone in the office sees everyone’s day sheet.' : 'Each person sees their own; a lead sees the items they gave; the management sees all.'}</div></div>
          <Segmented<'private' | 'open'> label="Who sees day sheets" value={cfg.openSheets ? 'open' : 'private'} onChange={(v) => set({ openSheets: v === 'open' })} options={[{ value: 'private', label: 'Private' }, { value: 'open', label: 'Open to the office' }]} />
        </div>
        <div className="setting">
          <Icon name="nib" className="lead" />
          <div className="txt"><div>Day sheets</div><div className="faint">Off: Nib still does leave notes, reminders and its other skills.</div></div>
          <Toggle checked={cfg.enabled} onChange={(v) => set({ enabled: v })} label="Day sheets" />
        </div>
      </section>

      <div className="nib-admin-actions">
        <button className="btn primary" disabled={busy || !dirty} onClick={save}>Save</button>
        <button className="btn" disabled={busy} onClick={() => void window.dex.request('admin.nib.preview').then(() => toast('Today’s register is in your conversation with Nib.')).catch((e: Error) => toast(e.message, true))}>Send me a register now</button>
        {dirty && <span className="faint">Not saved yet.</span>}
      </div>
    </div>
  );
}

function GiverRow({ g, u, placeholder, onScope, onRemove }: { g: NibGiver; u: PublicUser | undefined; placeholder: string; onScope: (s: string) => void; onRemove: () => void }) {
  return (
    <li className="nib-admin-row">
      {u && <Avatar user={u} size="sm" />}
      <span className="nib-admin-name" translate="no">{u?.displayName ?? 'Former member'}</span>
      <input className="input sm" value={g.scope} maxLength={40} placeholder={placeholder} aria-label={`Scope for ${u?.displayName ?? ''}`} onChange={(e) => onScope(e.target.value)} />
      <button className="icon-btn sm" aria-label={`Remove ${u?.displayName ?? ''}`} onClick={onRemove}><Icon name="trash" size={14} /></button>
    </li>
  );
}
