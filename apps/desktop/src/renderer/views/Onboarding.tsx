// First run and every state before the app is usable: choose the hub, wait for approval,
// or recover from a declined device or a hub whose certificate changed.
import { useEffect, useState } from 'react';
import type { AppState } from '../../shared/bridge.ts';
import logo from '../app-icon.svg';
import { Icon, deviceCode } from '../ui.tsx';

export function Onboarding({ state }: { state: AppState }) {
  return (
    <div className="onboard">
      <header className="titlebar"><div className="brand"><img src={logo} alt="" />Dexterity Connect</div></header>
      <div className="onboard-stage">
        <div className="onboard-card" key={state.phase}>
          {state.phase === 'welcome' && <Welcome state={state} />}
          {(state.phase === 'connecting' || state.phase === 'offline') && <Connecting state={state} />}
          {state.phase === 'pending' && <Pending state={state} />}
          {state.phase === 'rejected' && <Problem title="Access not granted" text={state.error ?? 'An administrator declined this device.'} />}
          {state.phase === 'mismatch' && <Problem title="This hub's identity changed" text={`${state.error ?? ''} This can happen if the hub was reinstalled — or if something is impersonating it. Check with your administrator before connecting again.`} />}
        </div>
      </div>
    </div>
  );
}

function Welcome({ state }: { state: AppState }) {
  const [name, setName] = useState(state.account.displayName);
  const [selected, setSelected] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [address, setAddress] = useState('');
  const isPhone = state.platform === 'android';
  const [office, setOffice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // pick the hub automatically when there is exactly one
  useEffect(() => {
    if (!selected && state.hubs.length === 1) setSelected(state.hubs[0].id);
  }, [state.hubs, selected]);

  const canJoin = name.trim().length > 0 && (manual ? address.trim().length > 0 : !!selected) && !busy;
  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      const extra = isPhone && office.trim() ? { officeAccount: office } : {};
      await window.dex.join(manual ? { address, displayName: name, ...extra } : { hubId: selected!, displayName: name, ...extra });
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
      setBusy(false);
    }
  };

  return (
    <form className="stack-v" onSubmit={(e) => { e.preventDefault(); if (canJoin) void join(); }}>
      <div>
        <img className="mark" src={logo} alt="" />
        <h1>Welcome to Dexterity&nbsp;Connect</h1>
        <p className="lede">{isPhone
          ? 'Messages, calls and files that stay on the office network. Connect to the office Wi-Fi to join.'
          : "Messages, calls and files that stay on the office network. You're signed in through Windows — no password needed."}</p>
      </div>

      {!isPhone && (
        <div className="who-chip">
          <Icon name="user" />
          <div style={{ minWidth: 0 }}>
            <div className="mono">{state.account.domain}\{state.account.username}</div>
            <div className="faint" style={{ fontSize: 12 }}>on {state.account.hostname}</div>
          </div>
        </div>
      )}

      <div className="field">
        <label htmlFor="display-name">Your name, as colleagues will see it</label>
        <input id="display-name" className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      </div>

      {isPhone && (
        <div className="field">
          <label htmlFor="office-account">Your PC sign-in (optional)</label>
          <input id="office-account" className="input mono" placeholder="DEXTERITY\\priya.raman" value={office} autoCapitalize="none" autoCorrect="off"
            onChange={(e) => setOffice(e.target.value)} />
          <span className="faint" style={{ fontSize: 12 }}>Links this phone to your PC account so colleagues see one of you. Find it on your PC under Settings → This PC.</span>
        </div>
      )}

      <div className="field">
        <label>Office hub</label>
        {!manual && (
          <div className="hub-list" role="radiogroup" aria-label="Office hub">
            {state.hubs.map((h) => (
              <button type="button" key={h.id} role="radio" aria-checked={selected === h.id} className="hub-option" onClick={() => setSelected(h.id)}>
                <span className="ico"><Icon name="server" /></span>
                <span className="meta">
                  <div style={{ fontWeight: 600 }}>{h.name}</div>
                  <div className="faint mono">{h.address}:{h.port}</div>
                </span>
                <span className="chip ok"><Icon name="lock" size={13} />Secure</span>
              </button>
            ))}
            <div className="scanning">
              <span className="spinner" />
              {state.hubs.length ? 'Still looking for others…' : 'Looking for your office hub on the network…'}
            </div>
          </div>
        )}
        {manual && (
          <input className="input" placeholder="e.g. 192.168.1.20 or hub-pc:47900" value={address} onChange={(e) => setAddress(e.target.value)} autoFocus />
        )}
        <div>
          <button type="button" className="link" onClick={() => { setManual(!manual); setError(null); }}>
            {manual ? 'Find the hub automatically instead' : 'Enter the hub address yourself'}
          </button>
        </div>
      </div>

      {error && <div className="error-box">{error}</div>}

      <button className="btn primary lg" type="submit" disabled={!canJoin}>
        {busy ? <span className="spinner" /> : null}
        Request access
      </button>
    </form>
  );
}

function Connecting({ state }: { state: AppState }) {
  return (
    <div className="center stack-v">
      <div className="waiting"><img src={logo} alt="" /></div>
      <h2>{state.phase === 'offline' ? 'Reaching the office hub…' : 'Connecting…'}</h2>
      <p className="muted">
        {state.hub?.name ?? state.hub?.host}
        {state.phase === 'offline' && state.retryInMs ? ` · trying again in ${Math.ceil(state.retryInMs / 1000)}s` : ''}
      </p>
      {state.phase === 'offline' && <p className="faint" style={{ fontSize: 13 }}>Make sure this PC is on the office network. If the hub PC was moved, it will be found again automatically.</p>}
      <div><button className="btn ghost" onClick={() => void window.dex.forgetHub()}>Choose a different hub</button></div>
    </div>
  );
}

function Pending({ state }: { state: AppState }) {
  return (
    <div className="center stack-v">
      <div className="waiting"><img src={logo} alt="" /></div>
      <h2>Waiting for an administrator</h2>
      <p className="muted">
        Ask an admin to approve <b>{state.account.displayName}</b> on <b>{state.account.hostname}</b>.
        {state.pendingPosition > 1 ? ` ${state.pendingPosition - 1} other ${state.pendingPosition === 2 ? 'device is' : 'devices are'} ahead of you.` : ''}
        {' '}This screen continues by itself once you're approved.
      </p>
      <div className="field" style={{ justifyItems: 'center' }}>
        <label>Your device code — the admin will see the same code</label>
        <span className="code">{deviceCode(state.deviceId)}</span>
      </div>
      <p className="faint" style={{ fontSize: 13 }}>Connected to {state.hub?.name ?? state.hub?.host}</p>
      <div><button className="btn ghost" onClick={() => void window.dex.forgetHub()}>Use a different hub</button></div>
    </div>
  );
}

function Problem({ title, text }: { title: string; text: string }) {
  return (
    <div className="stack-v">
      <div style={{ color: 'var(--danger)' }}><Icon name="warning" size={40} /></div>
      <h2>{title}</h2>
      <p className="muted">{text}</p>
      <div><button className="btn primary" onClick={() => void window.dex.forgetHub()}>Choose another hub</button></div>
    </div>
  );
}
