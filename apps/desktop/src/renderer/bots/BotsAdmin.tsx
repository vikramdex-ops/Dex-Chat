// Control room → Bots & tools: the step-by-step flows integrations run (switch on or off,
// write or change one), and the tools members can add to conversations (upload, review what
// each asks for, approve or reject, switch off). Every change is in the audit log.
import { useCallback, useEffect, useState } from 'react';
import type { BotFlowDefinition, BotFlowInfo, MiniAppInfo, Ops, PublicUser } from '@dex/core';
import { Icon, Segmented, Toggle, relativeTime, useToast } from '../ui.tsx';
import { filesSupported, formatSize, startUploads } from '../chat/files.tsx';
import { permissionWords } from './MiniAppCard.tsx';
import './bots.css';

type AdminFlow = BotFlowInfo & { definition: BotFlowDefinition };

const STARTER: BotFlowDefinition = {
  name: 'site-visit',
  title: 'Book a site visit',
  description: 'Ask for a site visit; the site lead gets it on their Desk.',
  command: 'sitevisit',
  steps: [
    { id: 'site', label: 'Site', prompt: 'Which site?', input: { kind: 'choice', options: [{ value: 'refinery', label: 'Refinery' }, { value: 'depot', label: 'Depot' }] } },
    { id: 'day', label: 'Day', prompt: 'Which day?', input: { kind: 'text', validate: { type: 'date', notBefore: 'today' } } },
    { id: 'people', label: 'People', prompt: 'How many people?', input: { kind: 'text', validate: { type: 'number', integer: true, min: 1, max: 10 } } },
    { id: 'lead', label: 'Site lead', prompt: 'Who is the site lead?', input: { kind: 'person' } },
    { id: 'ok', prompt: 'Send this to {{lead}}?\n\n{{summary}}', input: { kind: 'confirm', yes: 'Send', no: 'Change something' }, branches: [{ if: { equals: 'no' }, goto: 'site' }] },
  ],
  finish: [{ do: 'task', assignee: 'lead', text: 'Site visit to {{site}} on {{day}} for {{people}} ({{user}})', due: 'day' }],
  done: 'Sent to {{lead}}.',
};

const STATUS: Record<MiniAppInfo['status'], { cls: string; label: string }> = {
  pending: { cls: 'warn', label: 'Waiting for review' },
  approved: { cls: 'ok', label: 'Approved' },
  rejected: { cls: 'bad', label: 'Rejected' },
};

function Flows({ users }: { users: PublicUser[] }) {
  const toast = useToast();
  const [flows, setFlows] = useState<AdminFlow[] | null>(null);
  const [bots, setBots] = useState<Ops['admin.bots']['res']>([]);
  const [editing, setEditing] = useState<{ botId: string; text: string; isNew: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    void window.dex.request('admin.botflows.list').then(setFlows).catch(() => setFlows([]));
    void window.dex.request('admin.bots').then(setBots).catch(() => {});
  }, []);
  useEffect(() => { load(); return window.dex.onHubEvent((n) => { if (n === 'botflow.catalog') load(); }); }, [load]);
  const active = bots.filter((b) => b.active);
  const save = async () => {
    if (!editing) return;
    setError(null);
    let definition: BotFlowDefinition;
    try { definition = JSON.parse(editing.text) as BotFlowDefinition; } catch (e) { setError(`That is not valid JSON: ${(e as Error).message}`); return; }
    try {
      await window.dex.request('admin.botflows.save', { botId: editing.botId, definition });
      toast(`${definition.title ?? 'Flow'} saved`);
      setEditing(null);
      load();
    } catch (e) { setError((e as Error).message); }
  };
  const botName = (id: string) => users.find((u) => u.id === id)?.displayName ?? 'Integration';
  return (
    <>
      <p className="muted" style={{ margin: '0 0 12px' }}>
        A flow asks people one step at a time in their conversation with an integration, keeps their place for a week, and at the end posts a summary,
        calls the integration's webhook, or puts a task on someone's Desk. Integrations also keep flows themselves through the Bot API (PUT /api/flows/&lt;name&gt;).
      </p>
      <div className="row-actions" style={{ marginBottom: 12 }}>
        <button className="btn primary" disabled={!active.length} onClick={() => { setError(null); setEditing({ botId: active[0]?.bot.id ?? '', text: JSON.stringify(STARTER, null, 2), isNew: true }); }}><Icon name="plus" size={15} />Write a flow</button>
        {!active.length && <span className="faint">Create an integration first (Integrations).</span>}
      </div>
      {editing && (
        <div className="card token-card">
          <div className="eyebrow">{editing.isNew ? 'New flow' : 'Change flow'}</div>
          <div className="field"><label htmlFor="flow-bot">Integration that asks</label>
            <select id="flow-bot" className="input" value={editing.botId} onChange={(e) => setEditing({ ...editing, botId: e.target.value })}>
              {active.map((b) => <option key={b.bot.id} value={b.bot.id}>{b.bot.displayName}</option>)}
            </select></div>
          <div className="field"><label htmlFor="flow-json">Definition (JSON: steps, branches, finish actions; see INTEGRATIONS.md)</label>
            <textarea id="flow-json" className="input mono flow-json" rows={18} spellCheck={false} value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} /></div>
          {error && <div className="flow-err" role="alert">{error}</div>}
          <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
            <button className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
            <button className="btn primary" onClick={() => void save()}>Save flow</button>
          </div>
        </div>
      )}
      <div className="list">
        {flows === null && <div className="list-row"><span className="spinner" /></div>}
        {flows?.length === 0 && <div className="list-row faint">No flows yet.</div>}
        {flows?.map((f) => (
          <div key={f.name} className="list-row bots-row">
            <span className="mapp-mark" aria-hidden="true"><Icon name="branch" size={15} /></span>
            <div className="grow">
              <div><b>{f.title}</b> <span className="mono faint">{f.name}{f.command ? ` · /${f.command}` : ''} · {f.steps} steps</span></div>
              <div className="faint" style={{ fontSize: 12 }}>{botName(f.botId)} · {f.source === 'builtin' ? 'comes with the hub' : f.source === 'api' ? 'kept by the integration' : 'written here'} · changed {relativeTime(f.updatedAt)}</div>
            </div>
            <Toggle checked={f.enabled} label={`${f.title} on`} onChange={(on) => void window.dex.request('admin.botflows.enable', { name: f.name, enabled: on }).then(load).catch((e: Error) => toast(e.message, true))} />
            <span className="row-actions">
              <button className="btn ghost sm" onClick={() => { setError(null); setEditing({ botId: f.botId, text: JSON.stringify(f.definition, null, 2), isNew: false }); }}>Change</button>
              {f.source !== 'builtin' && <button className="btn ghost sm danger" onClick={() => { if (confirm(`Remove ${f.title}? Anyone in the middle of it is stopped.`)) void window.dex.request('admin.botflows.remove', { name: f.name }).then(load).catch((e: Error) => toast(e.message, true)); }}>Remove</button>}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

function Tools({ users }: { users: PublicUser[] }) {
  const toast = useToast();
  const [tools, setTools] = useState<MiniAppInfo[] | null>(null);
  const [review, setReview] = useState<{ id: string; hosts: Set<string>; note: string; source: string | null } | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const load = useCallback(() => void window.dex.request('admin.miniapps.list').then(setTools).catch(() => setTools([])), []);
  useEffect(() => { load(); return window.dex.onHubEvent((n) => { if (n === 'miniapp.catalog') load(); }); }, [load]);
  const upload = (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    setUploading(f.name);
    startUploads([f], (_k, patch) => {
      if (!patch) return;
      if (patch.error) { setUploading(null); toast(patch.error, true); }
      if (patch.info) {
        void window.dex.request('admin.miniapps.upload', { fileId: patch.info.id })
          .then((t) => { toast(`${t.name} ${t.version} is waiting for your review`); setReview({ id: t.id, hosts: new Set(t.requestedHosts), note: '', source: null }); load(); })
          .catch((e: Error) => toast(e.message, true)).finally(() => setUploading(null));
      }
    });
  };
  const who = (id: string | null) => (id ? users.find((u) => u.id === id)?.displayName ?? 'an administrator' : 'the hub');
  const current = review ? tools?.find((t) => t.id === review.id) : undefined;
  const decide = (approve: boolean) => {
    if (!review) return;
    void window.dex.request('admin.miniapps.review', { id: review.id, approve, hosts: [...review.hosts], note: review.note || undefined })
      .then((t) => { toast(approve ? `${t.name} approved` : `${t.name} rejected`); setReview(null); load(); })
      .catch((e: Error) => toast(e.message, true));
  };
  return (
    <>
      <p className="muted" style={{ margin: '0 0 12px' }}>
        Tools run inside conversations in a sealed frame: no access to the app, the hub or the network unless you grant hosts. They post or open a file
        only after the person agrees. Upload one HTML page or a zip with manifest.json; members can add it once you approve it.
      </p>
      <div className="row-actions" style={{ marginBottom: 12 }}>
        <label className={`btn primary${!filesSupported() || uploading ? ' disabled' : ''}`}>
          <Icon name="plus" size={15} />{uploading ? `Uploading ${uploading}…` : 'Upload a tool'}
          <input type="file" hidden accept=".zip,.html,.htm" disabled={!filesSupported() || !!uploading} onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
        </label>
      </div>
      {review && current && (
        <div className="card token-card">
          <div className="eyebrow">Review {current.name} {current.version}</div>
          <p className="muted" style={{ marginTop: 0 }}>{current.description || 'No description.'} <span className="mono faint">{formatSize(current.size)} · sha256 {current.sha256.slice(0, 12)}</span></p>
          <div className="field"><label>It asks to</label>
            <div className="mapp-perms">{current.permissions.length ? current.permissions.map((p) => <span key={p} className="chip">{permissionWords(p)}</span>) : <span className="faint">Nothing beyond running in its frame.</span>}</div></div>
          {current.requestedHosts.length > 0 && (
            <div className="field"><label>Hosts it may reach (untick to refuse)</label>
              {current.requestedHosts.map((h) => (
                <label key={h} className="check-line mono"><input type="checkbox" checked={review.hosts.has(h)} onChange={(e) => { const s = new Set(review.hosts); if (e.target.checked) s.add(h); else s.delete(h); setReview({ ...review, hosts: s }); }} />{h}</label>
              ))}</div>
          )}
          <div className="field"><label htmlFor="tool-note">Note for the audit log (optional)</label><input id="tool-note" className="input" maxLength={300} value={review.note} onChange={(e) => setReview({ ...review, note: e.target.value })} /></div>
          {review.source !== null
            ? <pre className="md-pre selectable tool-source">{review.source}</pre>
            : <button className="btn ghost" onClick={() => void window.dex.request('admin.miniapps.source', { id: current.id }).then((r) => setReview({ ...review, source: r.html })).catch((e: Error) => toast(e.message, true))}><Icon name="doc" size={15} />Read its page</button>}
          <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
            <button className="btn ghost" onClick={() => setReview(null)}>Later</button>
            <button className="btn danger" onClick={() => decide(false)}>Reject</button>
            <button className="btn primary" onClick={() => decide(true)}><Icon name="check" size={15} />Approve</button>
          </div>
        </div>
      )}
      <div className="list">
        {tools === null && <div className="list-row"><span className="spinner" /></div>}
        {tools?.map((t) => (
          <div key={t.id} className="list-row bots-row">
            <span className="mapp-mark" aria-hidden="true"><Icon name="grid" size={15} /></span>
            <div className="grow">
              <div><b>{t.name}</b> <span className="mono faint">{t.id} · v{t.version}</span> <span className={`chip ${STATUS[t.status].cls}`}>{STATUS[t.status].label}</span></div>
              <div className="faint" style={{ fontSize: 12 }}>
                {t.permissions.map(permissionWords).join(' · ') || 'Runs on its own'}{t.hosts.length ? ` · ${t.hosts.join(', ')}` : ''}
                {' · '}{t.builtin ? 'comes with Dexterity Connect' : `uploaded by ${who(t.uploadedBy)} ${relativeTime(t.uploadedAt)}`}{!t.builtin && t.reviewedAt ? ` · reviewed by ${who(t.reviewedBy)}` : ''}{t.note ? ` · “${t.note}”` : ''}
              </div>
            </div>
            <Toggle checked={t.enabled} label={`${t.name} on`} onChange={(on) => void window.dex.request('admin.miniapps.enable', { id: t.id, enabled: on }).then(load).catch((e: Error) => toast(e.message, true))} />
            <span className="row-actions">
              {!t.builtin && <button className={`btn ${t.status === 'pending' ? 'primary' : 'ghost'} sm`} onClick={() => setReview({ id: t.id, hosts: new Set(t.status === 'approved' ? t.hosts : t.requestedHosts), note: t.note ?? '', source: null })}>{t.status === 'pending' ? 'Review' : 'Review again'}</button>}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

export function BotsAdmin({ users }: { users: PublicUser[] }) {
  const [part, setPart] = useState<'flows' | 'tools'>('flows');
  return (
    <div className="bots-admin">
      <div style={{ marginBottom: 12 }}>
        <Segmented<'flows' | 'tools'> label="Bots and tools" value={part} onChange={setPart} options={[{ value: 'flows', label: 'Flows', icon: 'branch' }, { value: 'tools', label: 'Tools in conversations', icon: 'grid' }]} />
      </div>
      {part === 'flows' ? <Flows users={users} /> : <Tools users={users} />}
    </div>
  );
}
