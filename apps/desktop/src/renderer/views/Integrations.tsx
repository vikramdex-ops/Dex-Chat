// Control room → Integrations: tokens for office tools (Hopper, Sheets, Sleuth…) that post
// into Dexterity Connect through the hub's Bot API.
import { useCallback, useEffect, useState } from 'react';
import type { Ops } from '@dex/core';
import type { AppState } from '../../shared/bridge.ts';
import { Avatar, Icon, relativeTime, useToast } from '../ui.tsx';
import { useChat } from '../chat/store.ts';

type Bots = Ops['admin.bots']['res'];

export function Integrations({ state }: { state: AppState }) {
  const toast = useToast();
  const [bots, setBots] = useState<Bots | null>(null);
  const [name, setName] = useState('');
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);
  const [cmdFor, setCmdFor] = useState<string | null>(null);
  const [cmdForm, setCmdForm] = useState({ url: '', lines: '', actions: '' });
  const [actions, setActions] = useState<Ops['actions.list']['res']>([]);
  const [secret, setSecret] = useState<{ name: string; secret: string } | null>(null);
  const [commands, setCommands] = useState<Ops['cmd.list']['res']>([]);
  useEffect(() => { void window.dex.request('cmd.list').then(setCommands).catch(() => {}); void window.dex.request('actions.list').then(setActions).catch(() => {}); }, [bots]);
  const saveCommands = async (botId: string, name: string) => {
    const list = cmdForm.lines.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const m = l.match(/^\/?([\w-]+)\s*(?:[-–—:]\s*)?(.*)$/);
      return { command: m?.[1] ?? l, description: m?.[2] ?? '' };
    });
    try {
      // "Raise an RFI (Spaces)" -> an action for Spaces only
      const acts = cmdForm.actions.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const m = l.match(/^(.*?)\s*\((spaces|direct|everywhere)\)\s*$/i);
        return { label: (m ? m[1] : l).slice(0, 40), scope: (m ? m[2].toLowerCase() : 'everywhere') as 'spaces' | 'direct' | 'everywhere' };
      });
      const r = await window.dex.request('admin.bots.commands', { userId: botId, webhookUrl: cmdForm.url, commands: list, actions: acts });
      setSecret({ name, secret: r.secret });
      setCmdFor(null);
      void load();
    } catch (e) { toast((e as Error).message, true); }
  };
  const live = state.phase === 'ready';
  const load = useCallback(() => window.dex.request('admin.bots').then(setBots).catch(() => setBots([])), []);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    try {
      const r = await window.dex.request('admin.bots.create', { name: name.trim() });
      setIssued({ name: r.bot.displayName, token: r.token });
      setName('');
      void load();
    } catch (e) { toast((e as Error).message, true); }
  };
  const config = issued ? JSON.stringify({ connect: { enabled: true, hub: `${state.hub?.host}:${state.hub?.port}`, fingerprint: state.hub?.fingerprint, token: issued.token } }, null, 2) : '';

  return (
    <div className="integrations">
      <p className="muted" style={{ marginBottom: 14 }}>
        Office tools post into Dexterity Connect with a token: Hopper file alerts, Sheets mentions, Project Opener tasks.
        A tool can tell people something through Nib (by their Windows sign-in), message them itself or post into a Space.
      </p>
      <form className="setting" onSubmit={(e) => { e.preventDefault(); if (name.trim()) void create(); }}>
        <Icon name="plus" className="lead" />
        <input className="input" style={{ flex: 1 }} placeholder="Name, e.g. Hopper" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} disabled={!live} />
        <button className="btn primary" disabled={!live || !name.trim()}>Create token</button>
      </form>

      {issued && (
        <div className="card token-card">
          <div className="eyebrow">New token for {issued.name} · shown once</div>
          <p className="muted" style={{ fontSize: 13 }}>Paste this into the tool's office settings (for Hopper: the office configuration). Anyone with the token can post as {issued.name}.</p>
          <pre className="md-pre selectable">{config}</pre>
          <div className="row-actions">
            <button className="btn primary" onClick={() => { void navigator.clipboard.writeText(config); toast('Copied'); }}><Icon name="copy" size={15} />Copy settings</button>
            <button className="btn" onClick={() => { void navigator.clipboard.writeText(issued.token); toast('Token copied'); }}>Copy token only</button>
            <button className="btn ghost" onClick={() => setIssued(null)}>Done</button>
          </div>
        </div>
      )}

      <div className="list" style={{ marginTop: 14 }}>
        {bots === null && <div className="list-row"><span className="spinner" /></div>}
        {bots?.length === 0 && <div className="list-row faint">No integrations yet.</div>}
        {bots?.map((b) => (
          <div key={b.bot.id} className="list-row roles">
            <Avatar user={b.bot} size="sm" />
            <div><div style={{ fontWeight: 600 }}>{b.bot.displayName}</div><div className="faint" style={{ fontSize: 12 }}>created {relativeTime(b.createdAt)} · last used {relativeTime(b.lastUsed)}{b.notices > 0 ? ` · ${b.notices} notices this week` : ''}</div></div>
            <span><span className={`chip ${b.active ? 'ok' : 'bad'}`}>{b.active ? 'Active' : 'Revoked'}</span></span>
            <span className="row-actions">
              {b.active && (
                <label className="faint" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }} title="On: what this tool tells people arrives in their conversation with Nib, under the tool's name. Off: it arrives as a Direct message from the tool.">
                  <input type="checkbox" checked={b.viaNib} disabled={!live} onChange={(e) => {
                    const viaNib = e.target.checked;
                    void window.dex.request('admin.bots.notices', { userId: b.bot.id, viaNib }).then(() => { toast(viaNib ? 'Its notices now arrive through Nib' : 'Its notices now arrive as its own messages'); void load(); }).catch((err: Error) => toast(err.message, true));
                  }} />
                  Notices through Nib
                </label>
              )}
              {b.active && <button className="btn ghost" disabled={!live} onClick={() => { setCmdFor(cmdFor === b.bot.id ? null : b.bot.id); setCmdForm({ url: '', lines: commands.filter((c) => c.botId === b.bot.id).map((c) => `/${c.command} - ${c.description}`).join('\n'), actions: actions.filter((a) => a.botId === b.bot.id).map((a) => `${a.label}${a.scope === 'everywhere' ? '' : ` (${a.scope})`}`).join('\n') }); }}>
                Commands{commands.some((c) => c.botId === b.bot.id) ? ` · ${commands.filter((c) => c.botId === b.bot.id).length}` : ''}
              </button>}
              {b.active && (
                <button className="btn ghost danger" disabled={!live} onClick={() => {
                  if (!confirm(`Revoke ${b.bot.displayName}'s token? It stops posting immediately.`)) return;
                  void window.dex.request('admin.bots.revoke', { userId: b.bot.id }).then(() => { toast('Revoked'); void load(); }).catch((e: Error) => toast(e.message, true));
                }}>Revoke</button>
              )}
            </span>
          </div>
        ))}
      </div>
      {cmdFor && (() => {
        const b = bots?.find((x) => x.bot.id === cmdFor);
        if (!b) return null;
        return (
          <div className="card token-card">
            <div className="eyebrow">Commands and message actions for {b.bot.displayName}</div>
            <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>When someone types one of these, the hub sends it to the address below and posts the reply in the conversation. Requests are signed with a secret (shown once after saving) in the <code>X-Dex-Signature</code> header.</p>
            <div className="field"><label htmlFor="cmd-url">Webhook address on the office network</label>
              <input id="cmd-url" className="input mono" placeholder="http://hopper-pc:8710/dexconnect" value={cmdForm.url} onChange={(e) => setCmdForm({ ...cmdForm, url: e.target.value })} /></div>
            <div className="field"><label htmlFor="cmd-lines">Commands, one per line</label>
              <textarea id="cmd-lines" className="input mono" rows={4} placeholder={'/open - Open a project folder\n/transmittal - Start a transmittal'} value={cmdForm.lines} onChange={(e) => setCmdForm({ ...cmdForm, lines: e.target.value })} /></div>
            <div className="field"><label htmlFor="cmd-actions">Message actions, one per line (in each message's menu)</label>
              <textarea id="cmd-actions" className="input mono" rows={3} placeholder={'Raise an RFI (spaces)\nLog as a defect'} value={cmdForm.actions} onChange={(e) => setCmdForm({ ...cmdForm, actions: e.target.value })} />
              <span className="faint" style={{ fontSize: 12 }}>The webhook receives the message, who wrote it and who chose the action. Add (spaces) or (direct) to offer it only there. Up to 10.</span></div>
            <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
              <button className="btn ghost" onClick={() => setCmdFor(null)}>Cancel</button>
              <button className="btn primary" disabled={!cmdForm.url.trim()} onClick={() => void saveCommands(b.bot.id, b.bot.displayName)}>Save</button>
            </div>
          </div>
        );
      })()}

      {secret && (
        <div className="card token-card">
          <div className="eyebrow">Signing secret for {secret.name} · shown once</div>
          <p className="muted" style={{ fontSize: 13 }}>The tool checks each request: HMAC-SHA256 of <code>timestamp.body</code> with this secret must equal the <code>X-Dex-Signature</code> header (after <code>sha256=</code>).</p>
          <pre className="md-pre selectable">{secret.secret}</pre>
          <div className="row-actions">
            <button className="btn primary" onClick={() => { void navigator.clipboard.writeText(secret.secret); toast('Secret copied'); }}><Icon name="copy" size={15} />Copy secret</button>
            <button className="btn ghost" onClick={() => setSecret(null)}>Done</button>
          </div>
        </div>
      )}

      <details className="api-help">
        <summary>For tool builders: the Bot API</summary>
        <pre className="md-pre selectable">{`POST https://${state.hub?.host}:${state.hub?.port}/api/bot/message
Authorization: Bearer <token>
Content-Type: application/json

{ "text": "Rev B of ISO-1001 is ready",
  "to": ["DEXTERITY\\\\priya.raman", "ravi"],
  "space": "Piping P-12513",
  "card": { "title": "Transmittal T-0412", "lines": ["3 drawings"], "url": "https://…" } }

Trust the hub's certificate by its fingerprint:
${state.hub?.fingerprint}`}</pre>
        <p className="muted" style={{ fontSize: 13 }}>To tell people something through Nib (a task, a mention, an alert), post a notice instead. The same key is delivered once, so a tool can safely send it again after a timeout.</p>
        <pre className="md-pre selectable">{`POST https://${state.hub?.host}:${state.hub?.port}/api/bot/notify
Authorization: Bearer <token>
Content-Type: application/json

{ "to": ["priya.raman"], "key": "task-0412-assigned", "kind": "task",
  "title": "Check ISO-1001 rev B", "text": "Due Friday.",
  "link": { "title": "Open in Project Opener", "url": "projectopener://open/…" } }

GET https://${state.hub?.host}:${state.hub?.port}/api/bot/hello   checks the token (a tool's Test button)`}</pre>
      </details>
      {bots && bots.some((b) => b.active) && <Webhooks state={state} bots={bots.filter((b) => b.active)} />}
    </div>
  );
}

/** Slack-style incoming webhooks: a URL per Space for CI, monitoring and scripts. */
function Webhooks({ state, bots }: { state: AppState; bots: Bots }) {
  const toast = useToast();
  const conversations = useChat((s) => s.conversations);
  const spaces = [...conversations.values()].filter((c) => c.kind === 'space' && c.joined && !c.archived).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  const [list, setList] = useState<Ops['admin.hooks.list']['res']>([]);
  const [botId, setBotId] = useState(bots[0]?.bot.id ?? '');
  const [convId, setConvId] = useState('');
  const [made, setMade] = useState<string | null>(null);
  const load = () => void window.dex.request('admin.hooks.list').then(setList).catch(() => {});
  useEffect(load, []);
  const base = state.hub ? `https://${state.hub.host}:${state.hub.port}` : '';
  const names = new Map(bots.map((b) => [b.bot.id, b.bot.displayName] as const));
  return (
    <section className="card">
      <div className="eyebrow">Webhooks for other tools</div>
      <p className="muted" style={{ marginTop: 0 }}>For anything that can post to a Slack incoming webhook: CI and build servers, Grafana or other monitoring, scripts. Paste the address where the tool asks for a Slack webhook URL; its messages appear in the Space as the integration. The hub uses its own certificate, so turn on the tool's option to skip certificate checks, or trust the hub's certificate (fingerprint above).</p>
      <div className="org-admin-add">
        <select className="input" value={botId} onChange={(e) => setBotId(e.target.value)} aria-label="Integration">{bots.map((b) => <option key={b.bot.id} value={b.bot.id}>{b.bot.displayName}</option>)}</select>
        <select className="input" value={convId} onChange={(e) => setConvId(e.target.value)} aria-label="Space"><option value="">Space…</option>{spaces.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <button className="btn primary" disabled={!botId || !convId} onClick={() => void window.dex.request('admin.hooks.create', { botId, convId }).then((r) => { setMade(`${base}${r.path}`); load(); }).catch((e: Error) => toast(e.message, true))}><Icon name="plus" size={14} />Create webhook</button>
      </div>
      {made && (
        <div className="issued">
          <p className="faint" style={{ margin: '8px 0 4px', fontSize: 12.5 }}>Copy it now: it is shown only once.</p>
          <div className="row-actions"><code className="mono selectable" style={{ wordBreak: 'break-all', flex: 1 }}>{made}</code><button className="btn" onClick={() => { void navigator.clipboard.writeText(made); toast('Copied'); }}><Icon name="copy" size={14} />Copy</button></div>
        </div>
      )}
      {list.map((h) => (
        <div key={h.id} className="org-admin-row">
          <Icon name="open" size={15} />
          <span style={{ flex: 1 }}><b>{names.get(h.botId) ?? 'Integration'}</b> → {h.convName} <span className="faint">· {h.lastUsed ? `last used ${relativeTime(h.lastUsed)}` : 'not used yet'}</span></span>
          <button className="btn ghost sm" onClick={() => { if (confirm('Stop this webhook? Tools using it will get an error.')) void window.dex.request('admin.hooks.revoke', { id: h.id }).then(load); }}>Stop</button>
        </div>
      ))}
    </section>
  );
}
