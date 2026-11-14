// Control room → Integrations: tokens for office tools (Hopper, Sheets, Sleuth…) that post
// into Dexterity Connect through the hub's Bot API.
import { useCallback, useEffect, useState } from 'react';
import type { Ops } from '@dex/core';
import type { AppState } from '../../shared/bridge.ts';
import { Avatar, Icon, relativeTime, useToast } from '../ui.tsx';

type Bots = Ops['admin.bots']['res'];

export function Integrations({ state }: { state: AppState }) {
  const toast = useToast();
  const [bots, setBots] = useState<Bots | null>(null);
  const [name, setName] = useState('');
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);
  const [cmdFor, setCmdFor] = useState<string | null>(null);
  const [cmdForm, setCmdForm] = useState({ url: '', lines: '' });
  const [secret, setSecret] = useState<{ name: string; secret: string } | null>(null);
  const [commands, setCommands] = useState<Ops['cmd.list']['res']>([]);
  useEffect(() => { void window.dex.request('cmd.list').then(setCommands).catch(() => {}); }, [bots]);
  const saveCommands = async (botId: string, name: string) => {
    const list = cmdForm.lines.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const m = l.match(/^\/?([\w-]+)\s*(?:[-–—:]\s*)?(.*)$/);
      return { command: m?.[1] ?? l, description: m?.[2] ?? '' };
    });
    try {
      const r = await window.dex.request('admin.bots.commands', { userId: botId, webhookUrl: cmdForm.url, commands: list });
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
        Office tools post into Dexterity Connect with a token: Hopper file alerts, Sheets mentions, Sleuth reports.
        A tool can message people directly (by their Windows sign-in) or post into a Space.
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
            <div><div style={{ fontWeight: 600 }}>{b.bot.displayName}</div><div className="faint" style={{ fontSize: 12 }}>created {relativeTime(b.createdAt)} · last used {relativeTime(b.lastUsed)}</div></div>
            <span><span className={`chip ${b.active ? 'ok' : 'bad'}`}>{b.active ? 'Active' : 'Revoked'}</span></span>
            <span className="row-actions">
              {b.active && <button className="btn ghost" disabled={!live} onClick={() => { setCmdFor(cmdFor === b.bot.id ? null : b.bot.id); setCmdForm({ url: '', lines: commands.filter((c) => c.botId === b.bot.id).map((c) => `/${c.command} - ${c.description}`).join('\n') }); }}>
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
            <div className="eyebrow">Slash commands for {b.bot.displayName}</div>
            <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>When someone types one of these, the hub sends it to the address below and posts the reply in the conversation. Requests are signed with a secret (shown once after saving) in the <code>X-Dex-Signature</code> header.</p>
            <div className="field"><label htmlFor="cmd-url">Webhook address on the office network</label>
              <input id="cmd-url" className="input mono" placeholder="http://hopper-pc:8710/dexconnect" value={cmdForm.url} onChange={(e) => setCmdForm({ ...cmdForm, url: e.target.value })} /></div>
            <div className="field"><label htmlFor="cmd-lines">Commands, one per line</label>
              <textarea id="cmd-lines" className="input mono" rows={4} placeholder={'/open - Open a project folder\n/transmittal - Start a transmittal'} value={cmdForm.lines} onChange={(e) => setCmdForm({ ...cmdForm, lines: e.target.value })} /></div>
            <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
              <button className="btn ghost" onClick={() => setCmdFor(null)}>Cancel</button>
              <button className="btn primary" disabled={!cmdForm.url.trim()} onClick={() => void saveCommands(b.bot.id, b.bot.displayName)}>Save commands</button>
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
      </details>
    </div>
  );
}
