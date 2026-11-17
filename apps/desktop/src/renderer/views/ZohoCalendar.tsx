// Zoho Calendar (docs/ZOHO-CALENDAR.md): each person connects their own Zoho account once, in
// Preferences → Calendar or from the card on the Calendar lens; the hub then copies their
// meetings into Zoho and shows their Zoho events here as busy time. An administrator registers
// the office's Zoho client once, in Control room → Integrations. Guests see none of it.
import { useCallback, useEffect, useState } from 'react';
import type { PublicUser, Session } from '@dex/core';
import { ZOHO_DCS } from '@dex/core/zoho';
import type { ZohoAdminView, ZohoDc, ZohoStatus } from '@dex/core/zoho';
import { Avatar, Icon, Toggle, relativeTime, useToast } from '../ui.tsx';
import './zoho.css';

/** One person's Zoho status, kept fresh by the hub's zoho.status event. */
export function useZohoStatus(live: boolean): [ZohoStatus | null, (s: ZohoStatus) => void] {
  const [st, setSt] = useState<ZohoStatus | null>(null);
  useEffect(() => {
    if (!live) return;
    let alive = true;
    void window.dex.request('zoho.status').then((s) => { if (alive) setSt(s); }).catch(() => {});
    const off = window.dex.onHubEvent((n, d) => { if (n === 'zoho.status') setSt(d as ZohoStatus); });
    return () => { alive = false; off(); };
  }, [live]);
  return [st, setSt];
}

/** Connect (or reconnect): the browser signs in to Zoho, the hub keeps the connection. */
export async function connectZoho(): Promise<ZohoStatus> {
  if (!window.dex.zohoSignIn) throw new Error('Connect Zoho Calendar from Dexterity Connect on your Windows PC. It then syncs everywhere.');
  const { authUrl, state } = await window.dex.request('zoho.connect.start');
  const answer = await window.dex.zohoSignIn(authUrl, state);
  return window.dex.request('zoho.connect.finish', answer);
}

/** "Connected as asha@… · last synced 2 min ago" */
export function connectedLine(st: ZohoStatus): string {
  if (!st.lastSyncAt) return st.email ? `Connected as ${st.email} · first sync running` : 'Connected · first sync running';
  const when = relativeTime(st.lastSyncAt);
  return st.email ? `Connected as ${st.email} · last synced ${when}` : `Connected · last synced ${when}`;
}

function useConnect(set: (s: ZohoStatus) => void) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { set(await connectZoho()); toast('Zoho Calendar connected: your meetings are being copied'); } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  return { busy, run };
}

// ------------------------------------------------------------------ Preferences → Calendar
export function ZohoCalendarSettings({ session, live }: { session: Session; live: boolean }) {
  const toast = useToast();
  const [st, setSt] = useZohoStatus(live);
  const { busy, run } = useConnect(setSt);
  const [working, setWorking] = useState(false);
  if (session.me.role === 'guest' || session.me.role === 'bot') return null;
  const act = async (fn: () => Promise<ZohoStatus>, ok: string) => {
    setWorking(true);
    try { setSt(await fn()); toast(ok); } catch (e) { toast((e as Error).message, true); } finally { setWorking(false); }
  };
  const isAdmin = session.me.role === 'owner' || session.me.role === 'admin';
  const canSignIn = !!window.dex.zohoSignIn;

  if (!st) return null;
  if (st.state === 'off' || st.state === 'not-connected') {
    return (
      <div className="setting zoho-cta">
        <Icon name="calendar" className="lead" />
        <div className="txt">
          <div><b>Zoho Calendar</b></div>
          {st.state === 'off'
            ? <div className="faint"><span>Your office's Zoho connection isn't set up yet.</span> <span>{isAdmin ? 'Set it up once in Control room → Integrations.' : 'An administrator sets it up once for everyone.'}</span></div>
            : <div className="faint">Your meetings appear in your Zoho Calendar, and your Zoho appointments show here as busy time, so nobody books over them. You sign in to Zoho once; it keeps syncing while your PC is off.</div>}
          {st.state === 'not-connected' && !canSignIn && <div className="faint">Connect from Dexterity Connect on your Windows PC. It then syncs everywhere.</div>}
        </div>
        <button className="btn primary" disabled={st.state === 'off' || !live || busy || !canSignIn} onClick={() => void run()}>
          {busy ? <span className="spinner" /> : <Icon name="calendar" size={15} />}{busy ? 'Waiting for Zoho…' : 'Connect Zoho Calendar'}
        </button>
      </div>
    );
  }

  return (
    <div className="zoho-box">
      {st.state === 'reconnect' ? (
        <div className="setting zoho-warn" role="status">
          <Icon name="warning" className="lead" />
          <div className="txt">
            <div><b>Zoho Calendar: reconnect needed</b></div>
            <div className="faint">{st.lastError ?? 'Zoho no longer accepts the connection.'} Your meetings are copied again once you reconnect.</div>
          </div>
          <button className="btn primary" disabled={!live || busy || !canSignIn} onClick={() => void run()}>{busy ? 'Waiting for Zoho…' : 'Reconnect Zoho Calendar'}</button>
        </div>
      ) : (
        <div className="setting">
          <Icon name="calendar" className="lead" />
          <div className="txt">
            <div><b>Zoho Calendar</b> <span className="chip ok">Connected</span></div>
            <div className="faint selectable" data-zoho-line>{connectedLine(st)}</div>
            {st.lastError && <div className="zoho-err">{st.lastError}</div>}
          </div>
          <button className="btn" disabled={!live || working} onClick={() => void act(() => window.dex.request('zoho.syncNow'), 'Synced with Zoho Calendar')}><Icon name="refresh" size={15} />Sync now</button>
        </div>
      )}
      {st.state === 'connected' && (
        <div className="setting">
          <Icon name="list" className="lead" />
          <div className="txt">
            <div>Copy my meetings into</div>
            <div className="faint">{st.pushed === 1 ? '1 meeting copied' : `${st.pushed} meetings copied`} · {st.imported === 1 ? '1 Zoho event shown as busy' : `${st.imported} Zoho events shown as busy`}</div>
          </div>
          <select className="input zoho-cal" aria-label="Zoho calendar for my meetings" value={st.calendarUid ?? ''} disabled={!live || working}
            onChange={(e) => void act(() => window.dex.request('zoho.calendar.set', { calendarUid: e.target.value }), 'Your meetings now go to that Zoho calendar')}>
            {st.calendars.map((c) => <option key={c.uid} value={c.uid}>{c.name}</option>)}
          </select>
        </div>
      )}
      <div className="setting">
        <Icon name="info" className="lead" />
        <div className="txt">
          <div className="faint">Meetings you organise or said Going to are copied, with their meeting link but never the passcode. Change them here: an edit made in Zoho is put back. Zoho events are read every ten minutes and shown only to you; colleagues see only that you are busy.</div>
        </div>
        <button className="btn ghost danger" disabled={!live || working} onClick={() => { if (confirm('Disconnect Zoho Calendar? Copies of your upcoming meetings are removed from Zoho, and Zoho events stop showing here.')) void act(() => window.dex.request('zoho.disconnect'), 'Zoho Calendar disconnected'); }}>Disconnect</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ the Calendar lens
const HIDE_KEY = 'dex.zoho.card.hidden';

/** A card above the week: the call to connect (or reconnect), or a short line once connected. */
export function ZohoCalendarCard({ session }: { session: Session }) {
  const [st, setSt] = useZohoStatus(true);
  const { busy, run } = useConnect(setSt);
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(HIDE_KEY) === '1'; } catch { return false; } });
  if (!st || session.me.role === 'guest' || session.me.role === 'bot') return null;
  const isAdmin = session.me.role === 'owner' || session.me.role === 'admin';
  if (st.state === 'connected') {
    return <div className="zoho-strip faint" role="status"><Icon name="calendar" size={14} /><span>Zoho Calendar · {connectedLine(st)}</span>{st.lastError && <span className="chip warn">{st.lastError}</span>}</div>;
  }
  if (st.state === 'not-connected' && hidden) return null;
  const off = st.state === 'off';
  return (
    <div className={`zoho-card${st.state === 'reconnect' ? ' warn' : ''}`}>
      <Icon name={st.state === 'reconnect' ? 'warning' : 'calendar'} size={22} />
      <div className="zoho-card-txt">
        <b>{st.state === 'reconnect' ? 'Zoho Calendar needs reconnecting' : 'See your Zoho Calendar here'}</b>
        <span className="faint">
          {off ? <><span>Your office's Zoho connection isn't set up yet.</span>{isAdmin && <> <span>Set it up once in Control room → Integrations.</span></>}</>
            : st.state === 'reconnect' ? 'Zoho stopped accepting the connection, so nothing is syncing.'
              : 'Connect once: your meetings go to Zoho, and Zoho appointments block your time here.'}
        </span>
      </div>
      <div className="row-actions">
        {st.state === 'not-connected' && <button className="btn ghost sm" onClick={() => { setHidden(true); try { localStorage.setItem(HIDE_KEY, '1'); } catch { /* private */ } }}>Not now</button>}
        <button className="btn primary" disabled={off || busy || !window.dex.zohoSignIn} onClick={() => void run()}>
          {busy ? 'Waiting for Zoho…' : st.state === 'reconnect' ? 'Reconnect Zoho Calendar' : 'Connect Zoho Calendar'}
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Control room → Integrations
export function ZohoAdmin({ users, live }: { users: PublicUser[]; live: boolean }) {
  const toast = useToast();
  const [v, setV] = useState<ZohoAdminView | null>(null);
  const [form, setForm] = useState<{ dc: ZohoDc; clientId: string; secret: string; enabled: boolean }>({ dc: 'in', clientId: '', secret: '', enabled: true });
  const [saving, setSaving] = useState(false);
  const adopt = useCallback((x: ZohoAdminView) => { setV(x); setForm({ dc: x.dc, clientId: x.clientId ?? '', secret: '', enabled: x.enabled }); }, []);
  useEffect(() => {
    if (!live) return;
    void window.dex.request('admin.zoho.get').then(adopt).catch(() => {});
    return window.dex.onHubEvent((n, d) => { if (n === 'admin.zoho') setV(d as ZohoAdminView); });
  }, [live, adopt]);
  if (!v) return null;
  const byId = new Map(users.map((u) => [u.id, u] as const));
  const save = async () => {
    setSaving(true);
    try {
      adopt(await window.dex.request('admin.zoho.set', { dc: form.dc, clientId: form.clientId.trim() || null, clientSecret: form.secret.trim(), enabled: form.enabled }));
      toast('Zoho Calendar saved');
    } catch (e) { toast((e as Error).message, true); } finally { setSaving(false); }
  };
  const copy = (t: string) => void navigator.clipboard.writeText(t).then(() => toast('Copied')).catch(() => {});
  const console_ = `https://api-console.${ZOHO_DCS[form.dc].accounts.replace(/^https:\/\/accounts\./, '')}`;

  return (
    <section className="card zoho-admin" aria-labelledby="zoho-admin-h">
      <div className="eyebrow" id="zoho-admin-h">Zoho Calendar · one step for the whole office</div>
      <p className="muted">Zoho lets an app reach someone's calendar only through an OAuth client that a Zoho account owns, so the office registers one client once. After that, everyone connects their own Zoho Calendar themselves in Preferences → Calendar; you approve nothing per person and never see their events.</p>
      <ol className="zoho-steps">
        <li><span>Open Zoho's API console and sign in with the office's Zoho administrator account:</span> <span className="mono selectable">{console_}</span></li>
        <li>Choose Add Client, then Server-based Applications.</li>
        <li><span>Name it Dexterity Connect, with the office's website as its homepage. As the Authorized Redirect URI, enter exactly:</span>
          <span className="zoho-copy"><span className="mono selectable">{v.redirectUri}</span><button className="btn sm" onClick={() => copy(v.redirectUri)}><Icon name="copy" size={13} />Copy</button></span></li>
        <li>Create it. If colleagues have Zoho accounts in other regions, turn on Multi-DC in the client's settings.</li>
        <li><span>Paste its Client ID and Client Secret below and save. Each person is asked for this access:</span> <span className="mono">{v.scopes.join(', ')}</span></li>
      </ol>
      <form className="zoho-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label className="field"><span className="label">Zoho data centre</span>
          <select className="input" value={form.dc} onChange={(e) => setForm({ ...form, dc: e.target.value as ZohoDc })}>
            {(Object.keys(ZOHO_DCS) as ZohoDc[]).map((k) => <option key={k} value={k}>{ZOHO_DCS[k].label}</option>)}
          </select>
          <span className="faint">Where the client was registered. Each person's own region is found from their sign-in.</span>
        </label>
        <label className="field"><span className="label">Client ID</span>
          <input className="input mono" value={form.clientId} placeholder="1000.XXXXXXXXXXXX" autoComplete="off" spellCheck={false} onChange={(e) => setForm({ ...form, clientId: e.target.value })} />
        </label>
        <label className="field"><span className="label">Client secret</span>
          <input className="input mono" type="password" value={form.secret} autoComplete="new-password" placeholder={v.hasSecret ? 'Saved. Leave empty to keep it' : 'Paste the client secret'} onChange={(e) => setForm({ ...form, secret: e.target.value })} />
          <span className="faint">Kept on the hub, sealed; never shown again or sent to anyone's PC.</span>
        </label>
        <div className="setting">
          <div className="txt"><div>Zoho Calendar for everyone</div><div className="faint">Off pauses every connection without forgetting it.</div></div>
          <Toggle label="Zoho Calendar for everyone" checked={form.enabled} onChange={(on) => setForm({ ...form, enabled: on })} />
        </div>
        <div className="row-actions">
          <button className="btn primary" disabled={!live || saving || !form.clientId.trim() || (!v.hasSecret && !form.secret.trim())}>{v.configured ? 'Save' : 'Save and invite everyone'}</button>
          {v.hasSecret && <button type="button" className="btn ghost danger" disabled={!live || saving} onClick={() => { if (confirm('Remove the client secret? Syncing stops for everyone until a secret is saved again.')) void window.dex.request('admin.zoho.set', { clientSecret: null }).then(adopt).catch((e: Error) => toast(e.message, true)); }}>Remove secret</button>}
        </div>
      </form>

      <div className="label zoho-people-h">{v.people.length === 1 ? '1 person connected' : `${v.people.length} people connected`}</div>
      {v.people.length === 0 ? <div className="faint">No one has connected yet. Everyone was invited when the client was saved.</div> : (
        <div className="list zoho-people">
          {v.people.map((p) => {
            const u = byId.get(p.userId);
            return (
              <div key={p.userId} className="list-row">
                {u && <Avatar user={u} size="sm" />}
                <div className="txt">
                  <div>{u?.displayName ?? 'Former colleague'} <span className="faint">{p.email ?? ''}</span></div>
                  <div className="faint">{p.calendarName ?? '—'} · {p.lastSyncAt ? `synced ${relativeTime(p.lastSyncAt)}` : 'not synced yet'}{p.lastError ? ` · ${p.lastError}` : ''}</div>
                </div>
                <span className={`chip ${p.state === 'connected' ? (p.lastError ? 'warn' : 'ok') : 'warn'}`}>{p.state === 'connected' ? (p.lastError ? 'Retrying' : 'Connected') : p.state === 'reconnect' ? 'Reconnect needed' : 'Paused'}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
