// Outside the office: Preferences shows how this device reaches the hub and makes setup codes
// (with a QR code) for a phone or home laptop; the Control room turns the gateway on and shows
// its health. See docs/REMOTE-ACCESS.md.
import { useEffect, useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import type { Ops, RemoteView } from '@dex/core';
import type { AppState } from '../../shared/bridge.ts';
import { Dialog, Icon, Segmented, Toggle, relativeTime, useToast } from '../ui.tsx';
import { CloudSetup } from './CloudSetup.tsx';

export function Qr({ text, size = 220 }: { text: string; size?: number }) {
  const svg = useMemo(() => {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
  }, [text]);
  return <div className="qr" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} role="img" aria-label="QR code with the setup link" />;
}

/** Preferences ▸ Outside the office. */
export function RemoteSettings({ state }: { state: AppState }) {
  const [info, setInfo] = useState<Ops['remote.info']['res'] | null>(null);
  const live = state.phase === 'ready';
  useEffect(() => { if (live) void window.dex.request('remote.info').then(setInfo).catch(() => {}); }, [live, state.via]);
  const outside = state.via === 'remote';
  return (
    <section>
      <h3>Outside the office</h3>
      <div className="setting">
        <Icon name={outside ? 'globe' : 'server'} className="lead" />
        <div className="txt">
          <div>{outside ? 'Connected through the internet gateway' : live ? 'Connected on the office network' : 'Not connected'}</div>
          <div className="faint">{info?.url
            ? 'At home, on leave or on mobile data, the app reaches the office through its secure gateway. Messages are encrypted all the way to the hub.'
            : 'Your administrator has not turned on access from outside the office.'}</div>
        </div>
        {outside && <span className="chip ok"><Icon name="lock" size={13} />Encrypted</span>}
      </div>
    </section>
  );
}

/** Control room ▸ Outside the office. */
export function RemoteAdmin() {
  const toast = useToast();
  const [v, setV] = useState<RemoteView | null>(null);
  const [url, setUrl] = useState('');
  const load = () => void window.dex.request('admin.remote.get').then((x) => { setV(x); setUrl((u) => u || x.config.url || ''); }).catch((e: Error) => toast(e.message, true));
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const save = (patch: Ops['admin.remote.set']['req']) => void window.dex.request('admin.remote.set', patch).then((x) => { setV(x); toast('Saved'); }).catch((e: Error) => toast(e.message, true));
  if (!v) return <div className="tl-more"><span className="spinner" /></div>;
  const s = v.status;
  return (
    <div className="org-admin">
      <CloudSetup onChanged={load} />
      <section className="card">
        <div className="eyebrow">Access from outside the office</div>
        <p className="muted" style={{ marginTop: 0 }}>Phones and home laptops reach this hub through the office's own gateway on Cloudflare. The hub connects out to it, so no port is opened at the office, and every device's traffic is encrypted all the way to the hub: the gateway only passes it on.</p>
        <label htmlFor="gw-url" className="field-label">Gateway address</label>
        <div className="gw-url-row">
          <input id="gw-url" className="input mono" placeholder="https://dexconnect-gateway.<your-account>.workers.dev" value={url} onChange={(e) => setUrl(e.target.value)} />
          <button className="btn" disabled={url.trim() === (v.config.url ?? '')} onClick={() => save({ url: url.trim() || null })}>Save address</button>
        </div>
        <div className="setting" style={{ marginTop: 10 }}>
          <div className="txt"><div>Allow access from outside the office</div><div className="faint">Turning it off disconnects everyone who is outside at once.</div></div>
          <Toggle label="Allow access from outside the office" checked={v.config.enabled} onChange={(on) => save({ enabled: on })} />
        </div>
        <div className={`gw-status ${v.config.enabled ? (s.connected ? 'ok' : 'warn') : 'off'}`} role="status">
          <span className="dot" />
          {!v.config.enabled ? 'Off' : s.connected
            ? <>Connected{s.since ? ` ${relativeTime(s.since)}` : ''} · {s.devices === 1 ? '1 device outside now' : `${s.devices} devices outside now`}{s.pinned ? ' · gateway pinned to this hub' : ''}</>
            : <>Not connected{s.error ? `: ${s.error}` : ''}. Retrying.</>}
        </div>
        {v.config.enabled && s.connected && !s.pinned && (
          <p className="warn-note"><Icon name="warning" size={14} /><span>Recommended: pin the gateway to this hub so nothing else can take its place. Set up with Cloudflare (above) pins it for you.</span></p>
        )}
      </section>
      <MeetSite v={v} save={save} />
      <section className="card">
        <div className="eyebrow">Who may use it</div>
        <div className="setting">
          <div className="txt"><div>New devices may ask to join from outside</div><div className="faint">With a setup code. You still approve every device, as on the office network.</div></div>
          <Toggle label="New devices may ask to join from outside" checked={v.config.allowJoin} onChange={(on) => save({ allowJoin: on })} />
        </div>
        <div className="setting">
          <div className="txt"><div>The Control room works from outside</div><div className="faint">Off: administration (approvals, policies, exports) only on the office network.</div></div>
          <Toggle label="The Control room works from outside" checked={v.config.allowAdmin} onChange={(on) => save({ allowAdmin: on })} />
        </div>
      </section>
      <CallsAcross />
      <section className="card">
        <div className="eyebrow">This hub</div>
        <div className="kv"><span>Hub id</span><span className="mono selectable">{v.hubId}</span></div>
        <div className="kv"><span>Fingerprint</span><span className="mono selectable" style={{ wordBreak: 'break-all' }}>{v.fingerprint}</span></div>
      </section>
    </div>
  );
}

/**
 * Control room ▸ Outside the office ▸ Meeting site: the clean address of every meeting's page
 * (Dexterity Meet), https://dexterity-meet.pages.dev by default or the office's own domain later.
 * It is configuration, not code: changing it here moves new links at once, and old ones redirect.
 */
function MeetSite({ v, save }: { v: RemoteView; save: (patch: Ops['admin.remote.set']['req']) => void }) {
  const [site, setSite] = useState(v.config.siteUrl ?? '');
  const [org, setOrg] = useState(v.config.orgName ?? '');
  const base = (v.config.siteUrl || v.config.url || '').replace(/\/+$/, '');
  return (
    <section className="card meet-site-card">
      <div className="eyebrow">Meeting site · Dexterity Meet</div>
      <p className="muted" style={{ marginTop: 0 }}>Every meeting has a page guests open from their invitation, at a clean address such as <span className="mono">{base ? `${base.replace(/^https?:\/\//, '')}/482-913-207` : 'dexterity-meet.pages.dev/482-913-207'}</span> or a name its host chose. The site passes everything to the gateway, so guests never see the gateway's own address. Deploy it with <span className="mono">Deploy-Gateway.cmd</span>, which prints the address to paste here.</p>
      <label htmlFor="meet-site" className="field-label">Meeting site address</label>
      <div className="gw-url-row">
        <input id="meet-site" className="input mono" placeholder="https://dexterity-meet.pages.dev" value={site} onChange={(e) => setSite(e.target.value)} />
        <button className="btn" disabled={site.trim().replace(/\/+$/, '') === (v.config.siteUrl ?? '')} onClick={() => save({ siteUrl: site.trim() || null })}>Save address</button>
      </div>
      <p className="faint site-note">{v.config.siteUrl ? 'Links made from now on use this address. Older links on the gateway\'s address and /m/ links are sent here.' : 'Empty: meeting pages are served on the gateway\'s own address until the site is set up.'} Your own domain later (for example meet.dexteritydesign.co.in): add it to the Pages project under Custom domains, then enter it here.</p>
      <label htmlFor="meet-org" className="field-label site-label">Name on meeting pages</label>
      <div className="gw-url-row">
        <input id="meet-org" className="input" maxLength={80} placeholder="Dexterity Design Services" value={org} onChange={(e) => setOrg(e.target.value)} />
        <button className="btn" disabled={org.trim() === (v.config.orgName ?? '')} onClick={() => save({ orgName: org.trim() })}>Save name</button>
      </div>
      <p className="faint site-note">Before the passcode, a page says only "Meeting with" this name, the date and the time (and the title, if its host allows it).</p>
    </section>
  );
}

/** Control room ▸ Outside the office ▸ Calls across networks. */
function CallsAcross() {
  const toast = useToast();
  const [c, setC] = useState<Ops['admin.ice.get']['res'] | null>(null);
  const [mode, setMode] = useState<'auto' | 'cloudflare' | 'custom'>('auto');
  const [keyId, setKeyId] = useState('');
  const [token, setToken] = useState('');
  const [turn, setTurn] = useState({ urls: '', username: '', credential: '' });
  useEffect(() => {
    void window.dex.request('admin.ice.get').then((x) => {
      setC(x); setMode(x.mode); setKeyId(x.keyId ?? '');
      const s0 = x.servers[0];
      if (s0) setTurn({ urls: (Array.isArray(s0.urls) ? s0.urls : [s0.urls]).join(' '), username: s0.username ?? '', credential: '' });
    }).catch(() => {});
  }, []);
  const save = () => {
    const req: Ops['admin.ice.set']['req'] = mode === 'cloudflare'
      ? { mode, keyId: keyId.trim(), ...(token.trim() ? { token: token.trim() } : {}) }
      : mode === 'custom'
        ? { mode, servers: [{ urls: turn.urls.split(/[\s,]+/).filter(Boolean), ...(turn.username ? { username: turn.username } : {}), ...(turn.credential ? { credential: turn.credential } : {}) }] }
        : { mode };
    void window.dex.request('admin.ice.set', req).then((x) => { setC(x); setToken(''); toast('Saved'); }).catch((e: Error) => toast(e.message, true));
  };
  if (!c) return null;
  return (
    <section className="card">
      <div className="eyebrow">Calls across networks</div>
      <p className="muted" style={{ marginTop: 0 }}>On the office network, calls go straight between PCs. With someone at home or on mobile data, calls need a relay to get through routers. Calls stay encrypted end to end; a relay only forwards them.</p>
      <Segmented<'auto' | 'cloudflare' | 'custom'> label="Relay for calls" value={mode} onChange={setMode} options={[
        { value: 'auto', label: 'Basic' }, { value: 'cloudflare', label: 'Cloudflare TURN' }, { value: 'custom', label: 'Own TURN server' },
      ]} />
      {mode === 'auto' && <p className="faint" style={{ fontSize: 12.5 }}>Uses a public STUN server when access from outside is on. Works on most home routers; calls on some mobile networks may not connect without a TURN relay.</p>}
      {mode === 'cloudflare' && (
        <div className="form-row" style={{ marginTop: 10 }}>
          <div className="field"><label htmlFor="cf-key">TURN key id</label><input id="cf-key" className="input mono" value={keyId} onChange={(e) => setKeyId(e.target.value)} placeholder="32 characters" /></div>
          <div className="field"><label htmlFor="cf-token">API token</label><input id="cf-token" className="input mono" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={c.hasToken ? 'Saved (leave empty to keep)' : 'From Cloudflare > Realtime > TURN'} /></div>
        </div>
      )}
      {mode === 'custom' && (
        <div className="form-row" style={{ marginTop: 10 }}>
          <div className="field" style={{ flex: 2 }}><label htmlFor="turn-urls">Addresses</label><input id="turn-urls" className="input mono" value={turn.urls} onChange={(e) => setTurn({ ...turn, urls: e.target.value })} placeholder="turn:turn.example.com:3478 turns:turn.example.com:5349" /></div>
          <div className="field"><label htmlFor="turn-user">Username</label><input id="turn-user" className="input" value={turn.username} onChange={(e) => setTurn({ ...turn, username: e.target.value })} /></div>
          <div className="field"><label htmlFor="turn-pass">Password</label><input id="turn-pass" className="input" type="password" value={turn.credential} onChange={(e) => setTurn({ ...turn, credential: e.target.value })} placeholder="Leave empty to keep" /></div>
        </div>
      )}
      <div className="row-actions" style={{ marginTop: 10, justifyContent: 'flex-end' }}><button className="btn primary" onClick={save}>Save</button></div>
    </section>
  );
}
