// Control room ▸ Guests (invite codes for people outside the company) and ▸ Compliance
// (how long messages are kept, legal holds and exports).
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CompliancePolicy, GuestInvite, LegalHold, Ops, PublicUser } from '@dex/core';
import { Avatar, Icon, Segmented, relativeTime, useToast } from '../ui.tsx';
import { useChat } from '../chat/store.ts';

const day = (t: number) => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });

// ------------------------------------------------------------------ guests
export function GuestsAdmin({ users }: { users: PublicUser[] }) {
  const toast = useToast();
  const conversations = useChat((s) => s.conversations);
  const spaces = [...conversations.values()].filter((c) => c.kind === 'space' && !c.everyone && c.joined).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  const [invites, setInvites] = useState<GuestInvite[] | null>(null);
  const [guests, setGuests] = useState<Ops['admin.guests.list']['res']>([]);
  const [form, setForm] = useState({ spaceIds: [] as string[], accessDays: 30, validDays: 7, uses: 1, note: '' });
  const [code, setCode] = useState<string | null>(null);
  const load = useCallback(() => {
    void window.dex.request('admin.guests.invites').then(setInvites).catch(() => setInvites([]));
    void window.dex.request('admin.guests.list').then(setGuests).catch(() => setGuests([]));
  }, []);
  useEffect(() => { load(); return window.dex.onHubEvent((n) => { if (n === 'user.added' || n === 'device.updated') load(); }); }, [load]);
  const byId = new Map(users.map((u) => [u.id, u] as const));
  const create = async () => {
    try {
      const r = await window.dex.request('admin.guests.invite', { ...form, note: form.note || undefined });
      setCode(r.code);
      load();
    } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <div className="org-admin">
      <section className="card">
        <div className="eyebrow">Invite a guest</div>
        <p className="muted" style={{ marginTop: 0 }}>Guests (consultants, client engineers) join with a code. They are approved straight away, see only the Spaces you choose and the people in them, and lose access when their time is up.</p>
        {code ? (
          <div className="guest-code">
            <div className="label">Invite code · shown once</div>
            <div className="code big selectable">{code}</div>
            <p className="faint" style={{ fontSize: 12.5, margin: 0 }}>Send this code to your guest. They install Dexterity Connect, choose “I'm a guest with an invite code” and paste it.</p>
            <div className="row-actions">
              <button className="btn primary" onClick={() => { void navigator.clipboard.writeText(code); toast('Code copied'); }}><Icon name="copy" size={15} />Copy code</button>
              <button className="btn ghost" onClick={() => setCode(null)}>Done</button>
            </div>
          </div>
        ) : (
          <>
            <div className="field">
              <label>Spaces they can use</label>
              <div className="chip-row">
                {spaces.length === 0 && <span className="faint">Create a Space for the project first (you need to be in it).</span>}
                {spaces.map((s) => {
                  const on = form.spaceIds.includes(s.id);
                  return <button key={s.id} type="button" className={`when-chip${on ? ' on' : ''}`} onClick={() => setForm({ ...form, spaceIds: on ? form.spaceIds.filter((x) => x !== s.id) : [...form.spaceIds, s.id] })}>{s.name}</button>;
                })}
              </div>
            </div>
            <div className="form-row">
              <div className="field"><label htmlFor="g-access">Access lasts</label>
                <select id="g-access" className="input" value={form.accessDays} onChange={(e) => setForm({ ...form, accessDays: Number(e.target.value) })}>
                  {[1, 7, 14, 30, 60, 90, 180, 365].map((d) => <option key={d} value={d}>{d === 1 ? '1 day' : `${d} days`}</option>)}
                </select></div>
              <div className="field"><label htmlFor="g-valid">Code works for</label>
                <select id="g-valid" className="input" value={form.validDays} onChange={(e) => setForm({ ...form, validDays: Number(e.target.value) })}>
                  {[1, 3, 7, 14, 30].map((d) => <option key={d} value={d}>{d === 1 ? '1 day' : `${d} days`}</option>)}
                </select></div>
            </div>
            <div className="form-row">
              <div className="field"><label htmlFor="g-uses">How many guests can use it</label>
                <input id="g-uses" className="input" type="number" min={1} max={50} value={form.uses} onChange={(e) => setForm({ ...form, uses: Math.max(1, Math.min(50, Number(e.target.value) || 1)) })} /></div>
              <div className="field"><label htmlFor="g-note">Note (for you)</label>
                <input id="g-note" className="input" maxLength={120} placeholder="ACME client engineers" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></div>
            </div>
            <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
              <button className="btn primary" disabled={!form.spaceIds.length} onClick={() => void create()}><Icon name="plus" size={15} />Create invite code</button>
            </div>
          </>
        )}
      </section>

      <section className="card">
        <div className="eyebrow">Guests · {guests.length}</div>
        {guests.length === 0 && <p className="faint" style={{ margin: 0 }}>No guests right now.</p>}
        {guests.map((g) => (
          <div key={g.user.id} className="org-admin-row guest-row">
            <Avatar user={g.user} size="sm" />
            <span className="guest-name"><b>{g.user.displayName}</b><span className="faint mono">{g.user.account}</span></span>
            <span className={`chip${g.until && g.until - Date.now() < 3 * 86400_000 ? ' warn' : ''}`}>{g.until ? `until ${day(g.until)}` : 'ended'}</span>
            <button className="btn ghost sm" onClick={() => void window.dex.request('admin.guests.extend', { userId: g.user.id, days: 30 }).then(() => { toast('Extended by 30 days'); load(); }).catch((e: Error) => toast(e.message, true))}>+30 days</button>
            <button className="btn ghost danger sm" onClick={() => { if (confirm(`End ${g.user.displayName}'s access now?`)) void window.dex.request('admin.guests.end', { userId: g.user.id }).then(() => { toast('Access ended'); load(); }).catch((e: Error) => toast(e.message, true)); }}>End access</button>
          </div>
        ))}
      </section>

      <section className="card">
        <div className="eyebrow">Invite codes</div>
        {invites?.length === 0 && <p className="faint" style={{ margin: 0 }}>None yet.</p>}
        {invites?.map((i) => {
          const done = i.revoked || i.expiresAt < Date.now() || i.uses >= i.maxUses;
          return (
            <div key={i.id} className="org-admin-row guest-row">
              <span className="code">…{i.hint}</span>
              <span className="guest-name"><b>{i.note ?? i.spaceIds.map((id) => conversations.get(id)?.name ?? 'a Space').join(', ')}</b>
                <span className="faint">{i.uses} of {i.maxUses} used · {i.accessDays} days of access · by {byId.get(i.createdBy)?.displayName ?? 'an admin'} {relativeTime(i.createdAt)}</span></span>
              <span className={`chip ${done ? '' : 'ok'}`}>{i.revoked ? 'Withdrawn' : i.expiresAt < Date.now() ? 'Expired' : i.uses >= i.maxUses ? 'Used' : `Valid until ${day(i.expiresAt)}`}</span>
              {!done && <button className="btn ghost danger sm" onClick={() => void window.dex.request('admin.guests.revokeInvite', { id: i.id }).then(() => { toast('Code withdrawn'); load(); }).catch((e: Error) => toast(e.message, true))}>Withdraw</button>}
            </div>
          );
        })}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ compliance
const RETENTION: Array<[number | null, string]> = [[null, 'Keep forever'], [90, '90 days'], [180, '6 months'], [365, '1 year'], [730, '2 years'], [1825, '5 years'], [2555, '7 years']];

export function ComplianceAdmin({ users }: { users: PublicUser[] }) {
  const toast = useToast();
  const [policy, setPolicy] = useState<CompliancePolicy | null>(null);
  const [holds, setHolds] = useState<LegalHold[]>([]);
  const [convs, setConvs] = useState<Ops['admin.compliance.conversations']['res']>([]);
  const [holdKind, setHoldKind] = useState<'user' | 'conv'>('user');
  const [holdTarget, setHoldTarget] = useState('');
  const [holdNote, setHoldNote] = useState('');
  const [exp, setExp] = useState({ convIds: [] as string[], userIds: [] as string[], from: new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10), format: 'html' as 'json' | 'csv' | 'html', includeHistory: true });
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    void window.dex.request('admin.compliance.get').then((r) => { setPolicy(r.policy); setHolds(r.holds); }).catch(() => {});
    void window.dex.request('admin.compliance.conversations').then(setConvs).catch(() => {});
  }, []);
  useEffect(load, [load]);
  const people = users.filter((u) => u.role !== 'bot');
  const nameOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const u of users) m.set(u.id, u.displayName);
    for (const c of convs) m.set(c.id, c.kind === 'space' ? `Space: ${c.name}` : `Direct: ${c.name}`);
    return m;
  }, [users, convs]);
  const setRetention = (k: 'spaceRetentionDays' | 'directRetentionDays', v: number | null) => {
    if (!policy) return;
    const next = { spaceRetentionDays: policy.spaceRetentionDays, directRetentionDays: policy.directRetentionDays, [k]: v };
    if (v !== null && !confirm(`Messages older than ${RETENTION.find(([d]) => d === v)?.[1]} will be deleted for good, except anything on legal hold. Continue?`)) return;
    void window.dex.request('admin.compliance.setPolicy', next).then((p) => { setPolicy(p); toast('Retention saved'); }).catch((e: Error) => toast(e.message, true));
  };
  const runExport = async () => {
    setBusy(true);
    try {
      const r = await window.dex.request('admin.compliance.export', { convIds: exp.convIds, userIds: exp.userIds, from: new Date(`${exp.from}T00:00:00`).getTime(), to: new Date(`${exp.to}T23:59:59`).getTime() + 1, format: exp.format, includeHistory: exp.includeHistory });
      toast(`Exported ${r.messages} messages`);
      if (window.dex.saveFile) await window.dex.saveFile(r.file.id, r.file.name);
      else await window.dex.openFile?.(r.file.id, r.file.name);
    } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  if (!policy) return <div className="tl-more"><span className="spinner" /></div>;
  return (
    <div className="org-admin">
      <section className="card">
        <div className="eyebrow">How long messages are kept</div>
        <div className="form-row">
          <div className="field"><label htmlFor="r-space">Messages in Spaces</label>
            <select id="r-space" className="input" value={policy.spaceRetentionDays ?? ''} onChange={(e) => setRetention('spaceRetentionDays', e.target.value ? Number(e.target.value) : null)}>
              {RETENTION.map(([d, l]) => <option key={String(d)} value={d ?? ''}>{l}</option>)}
            </select></div>
          <div className="field"><label htmlFor="r-direct">Direct messages</label>
            <select id="r-direct" className="input" value={policy.directRetentionDays ?? ''} onChange={(e) => setRetention('directRetentionDays', e.target.value ? Number(e.target.value) : null)}>
              {RETENTION.map(([d, l]) => <option key={String(d)} value={d ?? ''}>{l}</option>)}
            </select></div>
        </div>
        <p className="faint" style={{ fontSize: 12.5, margin: '10px 0 0' }}>The hub checks every hour. {policy.lastPurgeAt ? `Last check ${relativeTime(policy.lastPurgeAt)}: ${policy.lastPurged} messages removed.` : ''} Files that no message uses any more are removed too.</p>
      </section>

      <section className="card">
        <div className="eyebrow">Legal holds</div>
        <p className="muted" style={{ marginTop: 0 }}>Nothing on hold is removed by retention, and every earlier version of an edited or deleted message is kept for export.</p>
        {holds.map((h) => (
          <div key={h.id} className="org-admin-row guest-row">
            <Icon name="shield" size={16} />
            <span className="guest-name"><b>{nameOf.get(h.targetId) ?? h.targetId}</b><span className="faint">{h.note ? `${h.note} · ` : ''}since {day(h.createdAt)}</span></span>
            <button className="btn ghost sm" onClick={() => { if (confirm('Release this hold? Retention applies to it again.')) void window.dex.request('admin.compliance.release', { id: h.id }).then(() => { toast('Hold released'); load(); }).catch((e: Error) => toast(e.message, true)); }}>Release</button>
          </div>
        ))}
        <div className="org-admin-add" style={{ marginTop: 10 }}>
          <Segmented<'user' | 'conv'> label="Hold" value={holdKind} onChange={(v) => { setHoldKind(v); setHoldTarget(''); }} options={[{ value: 'user', label: 'Person' }, { value: 'conv', label: 'Conversation' }]} />
          <select className="input" value={holdTarget} onChange={(e) => setHoldTarget(e.target.value)} aria-label="Hold target">
            <option value="">Choose…</option>
            {holdKind === 'user' ? people.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>) : convs.map((c) => <option key={c.id} value={c.id}>{c.kind === 'space' ? c.name : `Direct: ${c.name}`}</option>)}
          </select>
          <input className="input" placeholder="Matter or reason" maxLength={200} value={holdNote} onChange={(e) => setHoldNote(e.target.value)} />
          <button className="btn" disabled={!holdTarget} onClick={() => void window.dex.request('admin.compliance.hold', { kind: holdKind, targetId: holdTarget, note: holdNote || undefined }).then(() => { toast('On hold'); setHoldTarget(''); setHoldNote(''); load(); }).catch((e: Error) => toast(e.message, true))}>Place hold</button>
        </div>
      </section>

      <section className="card">
        <div className="eyebrow">Export</div>
        <p className="muted" style={{ marginTop: 0 }}>Export Spaces, or everything certain people wrote, for a period. Direct messages are private: an export shows that they exist and when, never what they say.</p>
        <div className="form-row">
          <div className="field"><label>Spaces</label>
            <select className="input" multiple size={5} value={exp.convIds} onChange={(e) => setExp({ ...exp, convIds: [...e.target.selectedOptions].map((o) => o.value) })}>
              {convs.filter((c) => c.kind === 'space').map((c) => <option key={c.id} value={c.id}>{c.name} · {c.messages}</option>)}
            </select></div>
          <div className="field"><label>People</label>
            <select className="input" multiple size={5} value={exp.userIds} onChange={(e) => setExp({ ...exp, userIds: [...e.target.selectedOptions].map((o) => o.value) })}>
              {people.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
            </select></div>
        </div>
        <div className="form-row">
          <div className="field"><label htmlFor="x-from">From</label><input id="x-from" className="input" type="date" value={exp.from} onChange={(e) => setExp({ ...exp, from: e.target.value })} /></div>
          <div className="field"><label htmlFor="x-to">To</label><input id="x-to" className="input" type="date" value={exp.to} onChange={(e) => setExp({ ...exp, to: e.target.value })} /></div>
        </div>
        <div className="row-actions">
          <Segmented<'html' | 'csv' | 'json'> label="Format" value={exp.format} onChange={(format) => setExp({ ...exp, format })} options={[{ value: 'html', label: 'Readable (HTML)' }, { value: 'csv', label: 'Spreadsheet (CSV)' }, { value: 'json', label: 'Data (JSON)' }]} />
          <label className="toggle-row" onClick={(e) => { e.preventDefault(); setExp({ ...exp, includeHistory: !exp.includeHistory }); }}><input type="checkbox" readOnly checked={exp.includeHistory} />Include earlier versions (held)</label>
          <span style={{ flex: 1 }} />
          <button className="btn primary" disabled={busy || (!exp.convIds.length && !exp.userIds.length)} onClick={() => void runExport()}>{busy ? <span className="spinner" /> : <Icon name="download" size={15} />}Export</button>
        </div>
      </section>
    </div>
  );
}
