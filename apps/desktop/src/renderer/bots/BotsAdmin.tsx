// Control room → Bots & tools: the step-by-step flows bots and integrations run (switch on or
// off, write or change one in the bot maker, approve members' bots for the whole office), and the tools members can add to conversations (upload, review what
// each asks for, approve or reject, switch off). Every change is in the audit log.
import { useCallback, useEffect, useState } from 'react';
import type { MiniAppInfo, Ops, PublicUser } from '@dex/core';
import { describeAction } from '@dex/core/botmaker';
import { Icon, Segmented, Toggle, relativeTime, useToast } from '../ui.tsx';
import { confirmAction } from '../confirm.tsx';
import { filesSupported, formatSize, startUploads } from '../chat/files.tsx';
import { permissionWords } from './MiniAppCard.tsx';
import { BotMarkTile } from './BotMark.tsx';
import { openBotMaker } from './maker/open.ts';
import { openBotNetwork, openJobSheet } from './net/open.ts';
import { KIND_TAG, kindOf } from './maker/model.ts';
import { OfficeHolidays } from './OfficeHolidays.tsx';
import './bots.css';

type AdminFlow = Ops['admin.botflows.list']['res'][number];

const STATUS: Record<MiniAppInfo['status'], { cls: string; label: string }> = {
  pending: { cls: 'warn', label: 'Waiting for review' },
  approved: { cls: 'ok', label: 'Approved' },
  rejected: { cls: 'bad', label: 'Rejected' },
};

/** One bot waiting for an administrator: what it asks, what it does at the end, a note, and the decision. */
function Review({ f, users, onDone }: { f: AdminFlow; users: PublicUser[]; onDone: () => void }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const def = f.pending ?? f.definition;
  const maker = users.find((u) => u.id === f.ownerId)?.displayName ?? 'A member';
  const decide = (approve: boolean) => void window.dex.request('admin.botflows.review', { name: f.name, approve, note: note.trim() || undefined })
    .then(() => { toast(approve ? `${def.title} is now office-wide` : `${def.title} was not approved`); onDone(); })
    .catch((e: Error) => toast(e.message, true));
  return (
    <div className="card token-card bm-review-card">
      <div className="bm-review-head">
        {def.persona && <BotMarkTile mark={def.persona.mark} colour={def.persona.colour} size={36} />}
        <div className="grow">
          <div className="eyebrow">Review · {f.pending ? `revision ${f.pendingVersion} of an office-wide bot` : 'share with the whole office'}</div>
          <b translate="no">{def.title}</b> <span className="faint" translate="no">by {maker}</span>
        </div>
      </div>
      {def.persona?.about && <p className="muted" style={{ margin: 0 }} translate="no">{def.persona.about}</p>}
      <ol className="bm-review-steps">
        {def.steps.map((s) => <li key={s.id}><span className="bm-kind">{KIND_TAG[kindOf(s.input)]}</span><span translate="no">{s.prompt.split('\n')[0]}</span></li>)}
      </ol>
      <ul className="flow-notes">{def.finish.map((a, i) => <li key={i}>{describeAction(a, def)}</li>)}</ul>
      <div className="field"><label htmlFor={`note-${f.name}`}>Note for {maker} and the audit log (optional)</label><input id={`note-${f.name}`} className="input" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></div>
      <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
        <button className="btn danger" onClick={() => decide(false)}>Turn down</button>
        <button className="btn primary" onClick={() => decide(true)}><Icon name="check" size={15} />Approve for the office</button>
      </div>
    </div>
  );
}

function Flows({ users }: { users: PublicUser[] }) {
  const toast = useToast();
  const [flows, setFlows] = useState<AdminFlow[] | null>(null);
  const [bots, setBots] = useState<Ops['admin.bots']['res']>([]);
  const load = useCallback(() => {
    void window.dex.request('admin.botflows.list').then(setFlows).catch(() => setFlows([]));
    void window.dex.request('admin.bots').then(setBots).catch(() => {});
  }, []);
  useEffect(() => { load(); return window.dex.onHubEvent((n) => { if (n === 'botflow.catalog') load(); }); }, [load]);
  const active = bots.filter((b) => b.active);
  const botName = (id: string) => users.find((u) => u.id === id)?.displayName ?? 'Integration';
  const who = (f: AdminFlow) => (f.source === 'member' ? `made by ${users.find((u) => u.id === f.ownerId)?.displayName ?? 'a member'} · ${f.scope === 'office' ? 'office-wide' : f.scope === 'space' ? 'one Space' : 'private'}` : `${botName(f.botId)} · ${f.source === 'builtin' ? 'comes with the hub' : f.source === 'api' ? 'kept by the integration' : 'written here'}`);
  const waiting = flows?.filter((f) => f.requested === 'office') ?? [];
  return (
    <>
      <p className="muted" style={{ margin: '0 0 12px' }}>
        A flow asks people one step at a time in their conversation with a bot or an integration, keeps their place, and at the end puts a task on someone's Desk,
        posts a summary, sets a reminder or calls the integration's webhook. Members make their own bots from the Desk; those for the whole office wait here for you.
        Integrations also keep flows through the Bot API (PUT /api/flows/&lt;name&gt;).
      </p>
      <div className="row-actions" style={{ marginBottom: 12 }}>
        <button className="btn primary" disabled={!active.length} onClick={() => openBotMaker({ admin: {} })}><Icon name="plus" size={15} />Write a flow</button>
        <button className="btn" onClick={() => openBotNetwork('office')}><Icon name="branch" size={15} />Bot network</button>
        <button className="btn" onClick={() => openJobSheet('office')}><Icon name="schedule" size={15} />Job sheet</button>
        {!active.length && <span className="faint">Create an integration first (Integrations).</span>}
      </div>
      {waiting.map((f) => <Review key={f.name} f={f} users={users} onDone={load} />)}
      <div className="list">
        {flows === null && <div className="list-row"><span className="spinner" /></div>}
        {flows?.length === 0 && <div className="list-row faint">No flows yet.</div>}
        {flows?.map((f) => (
          <div key={f.name} className="list-row bots-row">
            {f.persona ? <BotMarkTile mark={f.persona.mark} colour={f.persona.colour} size={26} /> : <span className="mapp-mark" aria-hidden="true"><Icon name="branch" size={15} /></span>}
            <div className="grow">
              <div><b>{f.title}</b> <span className="mono faint">{f.name}{f.command ? ` · /${f.command}` : ''} · {f.steps} steps · rev {f.version}</span>{f.requested === 'office' && <> <span className="chip warn">Waiting for review</span></>}{f.status !== 'live' && <> <span className="chip">{f.status === 'paused' ? 'Paused' : 'Retired'}</span></>}</div>
              <div className="faint" style={{ fontSize: 12 }}>{who(f)} · changed {relativeTime(f.updatedAt)}</div>
            </div>
            <Toggle checked={f.enabled} label={`${f.title} on`} onChange={(on) => void window.dex.request('admin.botflows.enable', { name: f.name, enabled: on }).then(load).catch((e: Error) => toast(e.message, true))} />
            <span className="row-actions">
              <button className="btn ghost sm" onClick={() => openBotMaker({ admin: { name: f.name } })}>Change</button>
              {f.source !== 'builtin' && <button className="btn ghost sm danger" onClick={() => void confirmAction({ title: `Remove ${f.title}?`, body: 'Anyone in the middle of it is stopped.', confirm: 'Remove', danger: true }).then((ok) => { if (ok) void window.dex.request('admin.botflows.remove', { name: f.name }).then(load).catch((e: Error) => toast(e.message, true)); })}>Remove</button>}
            </span>
          </div>
        ))}
      </div>
      <OfficeHolidays users={users} />
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
          .then((t) => { const tool = `${t.name} ${t.version}`; toast(`${tool} is waiting for your review`); setReview({ id: t.id, hosts: new Set(t.requestedHosts), note: '', source: null }); load(); })
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
                {' · '}{t.builtin ? 'comes with Dexterity Connect' : `uploaded ${relativeTime(t.uploadedAt)} by ${who(t.uploadedBy)}`}{!t.builtin && t.reviewedAt ? ` · reviewed by ${who(t.reviewedBy)}` : ''}{t.note ? ` · “${t.note}”` : ''}
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
