// Control room → Integrations → Dexterity Sheets: the Sheets server Nib reads (typed, or found on
// the office network) and the token generated in Sheets Server Manager. The token stays on the hub,
// sealed; it is never shown again or sent to anyone's PC. See docs/INTEGRATIONS.md.
import { useCallback, useEffect, useState } from 'react';
import type { SheetsAdminView, SheetsFound, SheetsTestResult } from '@dex/core/sheets';
import { relativeTime, useToast } from '../ui.tsx';
import './zoho.css';

export function SheetsAdmin({ live }: { live: boolean }) {
  const toast = useToast();
  const [v, setV] = useState<SheetsAdminView | null>(null);
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<'' | 'save' | 'test' | 'find'>('');
  const [found, setFound] = useState<SheetsFound[] | null>(null);
  const [test, setTest] = useState<SheetsTestResult | null>(null);
  const adopt = useCallback((x: SheetsAdminView) => { setV(x); setUrl(x.url ?? ''); setToken(''); }, []);
  useEffect(() => {
    if (!live) return;
    void window.dex.request('admin.sheets.get').then(adopt).catch(() => {});
    return window.dex.onHubEvent((n, d) => { if (n === 'admin.sheets') setV(d as SheetsAdminView); });
  }, [live, adopt]);
  if (!v) return null;

  const run = async <T,>(kind: 'save' | 'test' | 'find', f: () => Promise<T>): Promise<T | null> => {
    setBusy(kind);
    try { return await f(); } catch (e) { toast((e as Error).message, true); return null; } finally { setBusy(''); }
  };
  const save = () => void run('save', async () => {
    adopt(await window.dex.request('admin.sheets.set', { url: url.trim() || null, token: token.trim() }));
    toast('Dexterity Sheets saved');
  });
  // tests what is typed (or what is saved, when nothing changed)
  const changed = url.trim() !== (v.url ?? '') || !!token.trim();
  const check = () => void run('test', async () => setTest(await window.dex.request('admin.sheets.test', changed ? { url: url.trim() || undefined, token: token.trim() || undefined } : {})));
  const find = () => void run('find', async () => setFound(await window.dex.request('admin.sheets.discover')));
  const shown = test ?? v.lastTest;

  return (
    <section className="card zoho-admin" aria-labelledby="sheets-admin-h">
      <div className="eyebrow" id="sheets-admin-h">Dexterity Sheets · Nib answers from it</div>
      <p className="muted">With this, people can ask Nib “what’s assigned to me in Sheets?”, “any mentions for me?” or “who’s in the line list?”, and ask for a morning list of their open items. Each person only ever sees their own items. Notices from Sheets into Connect use an integration token below, as other tools do.</p>
      <form className="zoho-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <label className="field"><span className="label">Sheets server</span>
          <input className="input mono" value={url} placeholder="PC-SERVER or 10.0.0.5:47812" autoComplete="off" spellCheck={false} onChange={(e) => setUrl(e.target.value)} />
          <span className="faint">The PC running Dexterity Sheets Server. Its read API is on port 47812.</span>
        </label>
        {found && (found.length === 0
          ? <div className="faint">No Sheets server answered on this network. Type its name or address.</div>
          : <div className="list">{found.map((f) => (
            <div key={f.address} className="list-row">
              <div className="txt"><div>{f.name}</div><div className="faint mono">{f.address} · {f.version}</div></div>
              <button type="button" className="btn sm" onClick={() => setUrl(f.url)}>Use</button>
            </div>
          ))}</div>)}
        <label className="field"><span className="label">Token from Sheets Server Manager</span>
          <input className="input mono" type="password" value={token} autoComplete="new-password" placeholder={v.hasToken ? 'Saved. Leave empty to keep it' : 'Paste the token'} onChange={(e) => setToken(e.target.value)} />
          <span className="faint">Kept on the hub, sealed; never shown again or sent to anyone’s PC.</span>
        </label>
        {shown && <div className={`chip ${shown.ok ? 'ok' : 'warn'}`} role="status">{shown.ok ? `Connected to ${shown.name ?? 'the Sheets server'}${shown.version ? ` ${shown.version}` : ''} · ${relativeTime(shown.at)}` : shown.error}</div>}
        <div className="row-actions">
          <button className="btn primary" disabled={!live || !!busy || !url.trim() || (!v.hasToken && !token.trim())}>Save</button>
          <button type="button" className="btn" disabled={!live || !!busy || (!url.trim() && !v.url)} onClick={check}>{busy === 'test' ? 'Testing…' : 'Test'}</button>
          <button type="button" className="btn ghost" disabled={!live || !!busy} onClick={find}>{busy === 'find' ? 'Looking…' : 'Find on the network'}</button>
          {v.hasToken && <button type="button" className="btn ghost danger" disabled={!live || !!busy} onClick={() => { if (confirm('Remove the Sheets token? Nib stops answering Sheets questions until a token is saved again.')) void window.dex.request('admin.sheets.set', { token: null }).then(adopt).catch((e: Error) => toast(e.message, true)); }}>Remove token</button>}
        </div>
      </form>
      {v.configured && <div className="faint">{v.digestPeople === 1 ? '1 person gets' : `${v.digestPeople} people get`} the morning list of their open Sheets items.</div>}
    </section>
  );
}
