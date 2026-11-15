// Admin console (Phase 0): approve devices, manage devices and roles, read the audit trail.
import { useCallback, useEffect, useState } from 'react';
import type { AuditEntry, DeviceRecord, PublicUser, Session } from '@dex/core';
import type { AppState } from '../../shared/bridge.ts';
import { OfflineBanner } from '../App.tsx';
import { Integrations } from './Integrations.tsx';
import { BotsAdmin } from '../bots/BotsAdmin.tsx';
import { OrgAdmin } from './OrgAdmin.tsx';
import { ComplianceAdmin, GuestsAdmin } from './GuestsCompliance.tsx';
import { PoliciesAdmin, ReportsAdmin, UsageAdmin } from './PoliciesUsage.tsx';
import { RemoteAdmin } from './Remote.tsx';
import { AutomationsAdmin } from '../flows/FlowsPanel.tsx';
import { ItDeskAdmin } from '../help/ItDesk.tsx';
import { Avatar, Icon, ROLE_LABEL, Segmented, deviceCode, relativeTime, useToast } from '../ui.tsx';

type Tab = 'approvals' | 'devices' | 'roles' | 'organisation' | 'guests' | 'compliance' | 'reports' | 'policies' | 'remote' | 'usage' | 'integrations' | 'automations' | 'bots' | 'audit';

const STATUS_CHIP: Record<DeviceRecord['status'], { cls: string; label: string }> = {
  pending: { cls: 'warn', label: 'Waiting' },
  approved: { cls: 'ok', label: 'Approved' },
  rejected: { cls: 'bad', label: 'Declined' },
  revoked: { cls: 'bad', label: 'Removed' },
};

const AUDIT_TEXT: Record<string, string> = {
  'device.registered': 'registered a device',
  'device.approved': 'approved a device',
  'device.rejected': 'declined a device',
  'device.revoked': 'removed a device',
  'user.role': 'changed a role',
  'bot.created': 'created an integration token',
  'bot.revoked': 'revoked an integration token',
  'org.department.create': 'added a department',
  'org.department.update': 'changed a department',
  'org.department.delete': 'deleted a department',
  'org.fields': 'changed the profile fields',
  'org.profile': "changed someone's details",
  'org.import': 'imported people from a spreadsheet',
  'guest.invite': 'created a guest invite',
  'guest.inviteRevoked': 'withdrew a guest invite',
  'guest.joined': 'joined as a guest',
  'guest.extended': "extended a guest's access",
  'guest.ended': "ended a guest's access",
  'guest.expired': 'guest access expired',
  'compliance.policy': 'changed message retention',
  'compliance.hold': 'placed a legal hold',
  'compliance.release': 'released a legal hold',
  'compliance.export': 'exported messages',
  'compliance.purged': 'removed messages past retention',
  'bot.commands': "changed an integration's commands",
  'flow.created': 'created an automation',
  'flow.updated': 'changed an automation',
  'flow.enabled': 'turned an automation on',
  'flow.disabled': 'turned an automation off',
  'flow.deleted': 'removed an automation',
  'flow.settings': 'changed whether automations may call the office network',
};

export function Admin({ state, session }: { state: AppState; session: Session }) {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('approvals');
  const [openReports, setOpenReports] = useState(0);
  useEffect(() => {
    void window.dex.request('admin.reports.list', {}).then((r) => setOpenReports(new Set(r.map((x) => x.messageId)).size)).catch(() => {});
    return window.dex.onHubEvent((n, d) => { if (n === 'admin.reports') setOpenReports((d as { open: number }).open); });
  }, []);
  const [devices, setDevices] = useState<DeviceRecord[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const live = state.phase === 'ready';

  const load = useCallback(async () => {
    try {
      const [d, a] = await Promise.all([window.dex.request('admin.devices'), window.dex.request('admin.audit', { limit: 200 })]);
      setDevices(d);
      setAudit(a);
    } catch { /* offline: keep what we have */ }
  }, []);

  useEffect(() => {
    if (!live) return;
    void load();
    return window.dex.onHubEvent((name) => {
      if (name === 'admin.pending' || name === 'device.updated' || name === 'user.updated' || name === 'user.added') void load();
    });
  }, [live, load]);

  const pending = devices.filter((d) => d.status === 'pending');
  const byId = new Map(session.users.map((u) => [u.id, u] as const));

  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try { await fn(); toast(ok); await load(); } catch (e) { toast((e as Error).message, true); } finally { setBusy(null); }
  };

  return (
    <div className="view">
      <OfflineBanner state={state} />
      <div className="view-head">
        <div>
          <h1>Control room</h1>
          <p className="muted">Approve who can join {session.hub.name} and keep track of every change.</p>
        </div>
      </div>
      <div className="toolbar">
        <Segmented<Tab> label="Admin section" className="seg-register" value={tab} onChange={setTab} options={[
          { value: 'approvals', label: 'Approvals', icon: 'check', badge: pending.length },
          { value: 'devices', label: 'Devices', icon: 'laptop' },
          { value: 'roles', label: 'People & roles', icon: 'people' },
          { value: 'organisation', label: 'Organisation', icon: 'list' },
          { value: 'guests', label: 'Guests', icon: 'user' },
          { value: 'compliance', label: 'Compliance', icon: 'archive' },
          { value: 'reports', label: 'Reports', icon: 'warning', badge: openReports },
          { value: 'policies', label: 'Policies', icon: 'shield' },
          { value: 'remote', label: 'Outside the office', icon: 'globe' },
          { value: 'usage', label: 'Usage', icon: 'pulse' },
          { value: 'integrations', label: 'Integrations', icon: 'grid' },
          { value: 'automations', label: 'Automations', icon: 'repeat' },
          { value: 'bots', label: 'Bots & tools', icon: 'branch' },
          { value: 'audit', label: 'Audit log', icon: 'list' },
        ]} />
      </div>

      {tab === 'approvals' && (pending.length === 0 ? (
        <div className="card empty"><Icon name="shield" size={36} /><span>No one is waiting for approval.</span></div>
      ) : (
        <div className="list">
          {pending.map((d) => (
            <div key={d.id} className="list-row approvals">
              <Avatar user={{ id: d.userId, displayName: d.displayName }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{d.displayName}</div>
                <div className="faint" style={{ fontSize: 13 }}>
                  <span className="mono">{d.account}</span> · {d.hostname} · {relativeTime(d.createdAt)}
                </div>
              </div>
              <span className="code" title="Ask the person to read out the code on their screen">{deviceCode(d.id)}</span>
              <div className="row-actions">
                <button className="btn ghost danger" disabled={!live || busy === d.id}
                  onClick={() => void act(d.id, () => window.dex.request('admin.decide', { deviceId: d.id, approve: false }), `Declined ${d.displayName}`)}>Decline</button>
                <button className="btn primary" disabled={!live || busy === d.id}
                  onClick={() => void act(d.id, () => window.dex.request('admin.decide', { deviceId: d.id, approve: true }), `${d.displayName} can now use Dexterity Connect`)}>
                  <Icon name="check" size={16} />Approve
                </button>
              </div>
            </div>
          ))}
        </div>
      ))}

      {tab === 'devices' && (
        <div className="list">
          <div className="list-row devices list-head"><span /><span>Person</span><span>PC</span><span>Status</span><span>Last seen</span><span /></div>
          {devices.map((d) => (
            <div key={d.id} className="list-row devices">
              <Avatar user={{ id: d.userId, displayName: d.displayName }} size="sm" />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{d.displayName}</div>
                <div className="faint mono">{d.account}</div>
              </div>
              <div>{d.hostname}{d.id === session.deviceId && <span className="chip accent" style={{ marginLeft: 8 }}>This PC</span>}</div>
              <span><span className={`chip ${STATUS_CHIP[d.status].cls}`}>{STATUS_CHIP[d.status].label}</span></span>
              <span className="faint">{relativeTime(d.lastSeen)}</span>
              <span>
                {d.status === 'approved' && d.id !== session.deviceId && (
                  <button className="btn ghost danger" disabled={!live || busy === d.id}
                    onClick={() => { if (confirm(`Remove ${d.hostname} for ${d.displayName}? It will be signed out immediately and must be approved again.`)) void act(d.id, () => window.dex.request('admin.revoke', { deviceId: d.id }), `Removed ${d.hostname}`); }}>
                    Remove
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      {tab === 'roles' && <ItDeskAdmin session={session} live={live} />}
      {tab === 'roles' && (
        <div className="list">
          <div className="list-row roles list-head"><span /><span>Person</span><span>Windows account</span><span>Role</span></div>
          {session.users.filter((u) => u.role !== 'bot').map((u: PublicUser) => {
            const locked = u.role === 'owner' || u.id === session.me.id || (u.role === 'admin' && session.me.role !== 'owner');
            return (
              <div key={u.id} className="list-row roles">
                <Avatar user={u} size="sm" />
                <div style={{ fontWeight: 600 }}>{u.displayName}</div>
                <div className="faint mono">{u.account}</div>
                {locked ? <span className="chip">{ROLE_LABEL[u.role]}</span> : (
                  <select className="input" value={u.role} disabled={!live || busy === u.id} aria-label={`Role for ${u.displayName}`}
                    onChange={(e) => void act(u.id, () => window.dex.request('admin.setRole', { userId: u.id, role: e.target.value as 'admin' | 'member' | 'guest' }), `${u.displayName} is now ${ROLE_LABEL[e.target.value as PublicUser['role']].toLowerCase()}`)}>
                    <option value="admin">Admin</option>
                    <option value="member">Member</option>
                    <option value="guest">Guest</option>
                  </select>
                )}
              </div>
            );
          })}
        </div>
      )}

      {tab === 'organisation' && <OrgAdmin users={session.users} />}
      {tab === 'guests' && <GuestsAdmin users={session.users} />}
      {tab === 'compliance' && <ComplianceAdmin users={session.users} />}
      {tab === 'policies' && <PoliciesAdmin />}
      {tab === 'reports' && <ReportsAdmin users={session.users} onOpen={(convId, messageId) => window.dispatchEvent(new CustomEvent('dex-open-message', { detail: { convId, messageId } }))} />}
      {tab === 'remote' && <RemoteAdmin />}
      {tab === 'usage' && <UsageAdmin users={session.users} />}
      {tab === 'integrations' && <Integrations state={state} />}
      {tab === 'automations' && <AutomationsAdmin session={session} />}
      {tab === 'bots' && <BotsAdmin users={session.users} />}

      {tab === 'audit' && (audit.length === 0 ? (
        <div className="card empty"><Icon name="list" size={36} /><span>Nothing recorded yet.</span></div>
      ) : (
        <div className="list">
          {audit.map((a) => {
            const actor = a.actor ? byId.get(a.actor)?.displayName ?? 'An administrator' : 'Someone';
            const target = devices.find((d) => d.id === a.target);
            const subject = target ? `${target.displayName} (${target.hostname})` : a.target ? byId.get(a.target)?.displayName ?? '' : '';
            const detail = a.detail as { account?: string; from?: string; to?: string } | null;
            return (
              <div key={a.id} className="list-row audit">
                <span className="faint" title={new Date(a.at).toLocaleString()}>{relativeTime(a.at)}</span>
                <span>
                  <b>{a.action === 'device.registered' && !a.actor ? detail?.account ?? 'A new device' : actor}</b>{' '}
                  {AUDIT_TEXT[a.action] ?? a.action}
                  {subject && a.action !== 'device.registered' ? <> · {subject}</> : null}
                  {a.action === 'user.role' && detail ? <> · {detail.from} → {detail.to}</> : null}
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
