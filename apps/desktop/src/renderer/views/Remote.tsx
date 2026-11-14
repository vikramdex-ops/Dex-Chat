// Outside the office: Preferences shows how this device reaches the hub and makes setup codes
// (with a QR code) for a phone or home laptop; the Control room turns the gateway on and shows
// its health. See docs/REMOTE-ACCESS.md.
import { useEffect, useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import type { Ops, RemoteView } from '@dex/core';
import { setupCode } from '@dex/core/remote';
import type { AppState } from '../../shared/bridge.ts';
import { Dialog, Icon, Toggle, relativeTime, useToast } from '../ui.tsx';

function Qr({ text, size = 220 }: { text: string; size?: number }) {
  const svg = useMemo(() => {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
  }, [text]);
  return <div className="qr" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} role="img" aria-label="QR code with the setup link" />;
}

function SetupDialog({ info, onClose }: { info: Ops['remote.info']['res']; onClose: () => void }) {
  const toast = useToast();
  const code = setupCode({ url: info.url!, hubId: info.hubId, fp: info.fingerprint, name: info.name });
  const link = `${info.url}/join#${code}`;
  return (
    <Dialog title="Set up a phone or laptop" onClose={onClose}>
      <div className="setup-grid">
        <Qr text={link} />
        <ol className="setup-steps">
          <li>Install Dexterity Connect on the phone or laptop.</li>
          <li>Scan this code with the phone's camera, or open the app and choose <b>I'm outside the office</b> and paste the setup code.</li>
          <li>An administrator approves the new device, as on the office network.</li>
        </ol>
      </div>
      <textarea className="input mono" rows={3} readOnly value={code} onFocus={(e) => e.currentTarget.select()} aria-label="Setup code" />
      <div className="dialog-actions">
        <span className="faint">The code is not a password: it says where the office is and how to recognise it.</span>
        <button className="btn" onClick={() => { void navigator.clipboard.writeText(code); toast('Setup code copied'); }}><Icon name="copy" size={15} />Copy code</button>
        <button className="btn primary" onClick={onClose}>Done</button>
      </div>
    </Dialog>
  );
}

/** Preferences ▸ Outside the office. */
export function RemoteSettings({ state }: { state: AppState }) {
  const [info, setInfo] = useState<Ops['remote.info']['res'] | null>(null);
  const [dialog, setDialog] = useState(false);
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
      {info?.url && (
        <div className="setting">
          <Icon name="mobile" className="lead" />
          <div className="txt"><div>Set up a phone or laptop</div><div className="faint">A QR code and setup code for a device that is not on the office network.</div></div>
          <button className="btn" onClick={() => setDialog(true)}>Show code</button>
        </div>
      )}
      {dialog && info?.url && <SetupDialog info={info} onClose={() => setDialog(false)} />}
    </section>
  );
}

/** Control room ▸ Outside the office. */
export function RemoteAdmin() {
  const toast = useToast();
  const [v, setV] = useState<RemoteView | null>(null);
  const [url, setUrl] = useState('');
  const [dialog, setDialog] = useState(false);
  const load = () => void window.dex.request('admin.remote.get').then((x) => { setV(x); setUrl((u) => u || x.config.url || ''); }).catch((e: Error) => toast(e.message, true));
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const save = (patch: Ops['admin.remote.set']['req']) => void window.dex.request('admin.remote.set', patch).then((x) => { setV(x); toast('Saved'); }).catch((e: Error) => toast(e.message, true));
  if (!v) return <div className="tl-more"><span className="spinner" /></div>;
  const s = v.status;
  return (
    <div className="org-admin">
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
            ? <>Connected{s.since ? ` ${relativeTime(s.since)}` : ''} · {s.devices} {s.devices === 1 ? 'device' : 'devices'} outside now{s.pinned ? ' · gateway pinned to this hub' : ''}</>
            : <>Not connected{s.error ? `: ${s.error}` : ''}. Retrying.</>}
        </div>
        {v.config.enabled && s.connected && !s.pinned && (
          <p className="warn-note"><Icon name="warning" size={14} /><span>Recommended: pin the gateway to this hub so nothing else can take its place. Run <span className="mono">npx wrangler secret put HUB_FINGERPRINT</span> in <span className="mono">apps/gateway</span> and paste the fingerprint below.</span></p>
        )}
      </section>
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
      <section className="card">
        <div className="eyebrow">This hub</div>
        <div className="kv"><span>Hub id</span><span className="mono selectable">{v.hubId}</span></div>
        <div className="kv"><span>Fingerprint</span><span className="mono selectable" style={{ wordBreak: 'break-all' }}>{v.fingerprint}</span></div>
        {v.config.url && <button className="btn" style={{ marginTop: 10 }} onClick={() => setDialog(true)}><Icon name="mobile" size={15} />Setup code for a phone or laptop</button>}
      </section>
      {dialog && v.config.url && <SetupDialog info={{ url: v.config.url, hubId: v.hubId, fingerprint: v.fingerprint, name: v.name, viaGateway: false }} onClose={() => setDialog(false)} />}
    </div>
  );
}
