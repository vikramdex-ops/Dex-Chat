// First run and every state before the app is usable: choose the hub, wait for approval,
// or recover from a declined device or a hub whose certificate changed.
import { useEffect, useState } from 'react';
import { parsePairCode, parseSetupCode } from '@dex/core/remote';
import { QrScanner } from './Pairing.tsx';
import './onboarding.css';
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

/** Joining another office: a way back to the ones this device already belongs to. */
function BackToOffices({ state }: { state: AppState }) {
  if (!state.offices?.length || !window.dex.switchOffice) return null;
  return (
    <div className="office-back">
      <span className="label">Your other offices</span>
      {state.offices.map((o) => (
        <button key={o.id} type="button" className="btn ghost sm" onClick={() => void window.dex.switchOffice!(o.id).then(() => location.reload())}><Icon name="back" size={14} />Back to {o.name}</button>
      ))}
    </div>
  );
}

function Welcome({ state }: { state: AppState }) {
  const isPhone = state.platform === 'android';
  // phones and personal laptops pair with a code from the person's own PC; office PCs join the hub
  const [mode, setMode] = useState<'pair' | 'office'>(isPhone ? 'pair' : 'office');
  const [code, setCode] = useState('');
  const [found, setFound] = useState<'clipboard' | 'link' | 'scan' | null>(null);
  const [scanning, setScanning] = useState(false);
  const pair = parsePairCode(code);
  const legacy = pair ? null : parseSetupCode(code);
  const [name, setName] = useState(state.account.displayName);
  const [selected, setSelected] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  const [address, setAddress] = useState('');
  const [office, setOffice] = useState('');
  const [guest, setGuest] = useState(false);
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noHub, setNoHub] = useState(false);

  const join = async (req: Parameters<typeof window.dex.join>[0]) => {
    setBusy(true);
    setError(null);
    try { await window.dex.join(req); }
    catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
      setBusy(false);
    }
  };
  const take = (text: string, how: 'clipboard' | 'link' | 'scan') => {
    const m = text.match(/DX[PC]1-[A-Za-z0-9_-]+/);
    if (!m) return false;
    setMode('pair'); setCode(m[0]); setFound(how); setError(null);
    // a code from the camera or a link is what the person meant to use: go straight on
    if (how !== 'clipboard' && parsePairCode(m[0])) void join({ pairCode: m[0], displayName: '' });
    return true;
  };
  // a pairing code from the download page (copied) or from a link that opened the app
  useEffect(() => {
    const look = () => { void window.dex.readClipboard?.().then((t) => { if (!code && /DXP1-/.test(t)) take(t, 'clipboard'); }).catch(() => {}); };
    look();
    window.addEventListener('focus', look);
    document.addEventListener('visibilitychange', look);
    return () => { window.removeEventListener('focus', look); document.removeEventListener('visibilitychange', look); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);
  useEffect(() => window.dex.onDeepLink((url) => {
    const raw = (() => { try { return decodeURIComponent(url); } catch { return url; } })();
    if (/^dexconnect:\/\/(pair|remote)/i.test(raw)) take(raw, 'link');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);
  // pick the hub automatically when there is exactly one; offer pairing when none turns up
  useEffect(() => { if (!selected && state.hubs.length === 1) setSelected(state.hubs[0].id); }, [state.hubs, selected]);
  useEffect(() => {
    if (state.hubs.length) { setNoHub(false); return; }
    const t = setTimeout(() => setNoHub(true), 6000);
    return () => clearTimeout(t);
  }, [state.hubs.length]);

  const deviceWord = isPhone ? 'phone' : 'laptop';
  const canOffice = name.trim().length > 0 && (manual ? address.trim().length > 0 : !!selected) && !busy;

  if (mode === 'pair') {
    return (
      <form className="stack-v" onSubmit={(e) => { e.preventDefault(); if (pair) void join({ pairCode: code, displayName: '' }); else if (legacy && name.trim()) void join({ setupCode: code, displayName: name }); }}>
        <div>
          <img className="mark" src={logo} alt="" />
          <h1>Pair this {deviceWord}</h1>
          <p className="lede">Use Dexterity Connect here as yourself, at home or on mobile data. Your PC at the office makes the code: <b>Preferences → Your devices → Add my {deviceWord}</b>.</p>
        </div>
        {isPhone && (
          <button type="button" className="pair-scan" onClick={() => setScanning(true)} disabled={busy}>
            <span className="ico"><Icon name="mobile" size={26} /></span>
            <span><b>Scan the code on your PC</b><span className="faint">Opens the camera</span></span>
          </button>
        )}
        <div className="field">
          <label htmlFor="pair-code">{isPhone ? 'Or paste the code' : 'Paste the code you sent yourself'}</label>
          <textarea id="pair-code" className="input mono pair-code" rows={3} placeholder="DXP1-…" value={code} autoCapitalize="none" autoCorrect="off" spellCheck={false}
            onChange={(e) => { setCode(e.target.value.trim()); setFound(null); }} />
          <span className="faint" style={{ fontSize: 12 }}>
            {pair ? <>{found === 'clipboard' ? 'Found on your clipboard. ' : ''}Adds this {deviceWord} to your account on <b>{pair.name ?? 'your office hub'}</b>. No approval needed.</>
              : legacy ? <>An older setup code: an administrator approves this {deviceWord} before it can be used.</>
              : code ? 'That is not a complete code. Copy all of it, starting with DXP1-.' : 'The code works once and lasts 24 hours.'}
          </span>
        </div>
        {legacy && (
          <div className="field">
            <label htmlFor="display-name">Your name, as colleagues will see it</label>
            <input id="display-name" className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </div>
        )}
        {error && <div className="error-box">{error}</div>}
        <BackToOffices state={state} />
        <button className="btn primary lg" type="submit" disabled={busy || !(pair || (legacy && name.trim()))} title={busy || pair ? undefined : legacy ? 'Enter your name first' : 'Paste the whole code first'}>
          {busy ? <span className="spinner" /> : null}{legacy ? 'Request access' : `Pair this ${deviceWord}`}
        </button>
        {!isPhone && <div className="faint" style={{ fontSize: 13 }}><button type="button" className="link" onClick={() => setScanning(true)}>Scan the QR code with this laptop's camera</button></div>}
        <div className="faint" style={{ fontSize: 13 }}>
          {isPhone ? 'On the office Wi-Fi without a code? ' : 'An office PC? '}
          <button type="button" className="link" onClick={() => { setMode('office'); setError(null); }}>Join the office hub instead</button>
        </div>
        {scanning && <QrScanner onCode={(t) => { setScanning(false); if (!take(t, 'scan')) setError('That QR code is not a Dexterity Connect pairing code.'); }} onClose={() => setScanning(false)} />}
      </form>
    );
  }

  return (
    <form className="stack-v" onSubmit={(e) => {
      e.preventDefault();
      if (!canOffice) return;
      const extra = { ...(isPhone && office.trim() ? { officeAccount: office } : {}), ...(guest && invite.trim() ? { invite } : {}) };
      void join(manual ? { address, displayName: name, ...extra } : { hubId: selected!, displayName: name, ...extra });
    }}>
      <div>
        <img className="mark" src={logo} alt="" />
        <h1>Welcome to Dexterity&nbsp;Connect</h1>
        <p className="lede">{isPhone
          ? 'Join on the office Wi-Fi. An administrator approves this phone once.'
          : "Messages, calls and files from the office's own hub. You're signed in through Windows, with no password."}</p>
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
          <span className="faint" style={{ fontSize: 12 }}>Links this phone to your PC account so colleagues see one of you.</span>
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

      {noHub && !manual && (
        <button type="button" className="pair-hint" onClick={() => { setMode('pair'); setError(null); }}>
          <Icon name={isPhone ? 'mobile' : 'laptop'} size={20} />
          <span><b>Not in the office?</b> Pair this {deviceWord} with a code from your office PC instead.</span>
        </button>
      )}

      {guest ? (
        <div className="field">
          <label htmlFor="invite">Guest invite code</label>
          <input id="invite" className="input mono" placeholder="DEX-XXXXX-XXXXX" value={invite} maxLength={20} autoCapitalize="characters" autoCorrect="off" onChange={(e) => setInvite(e.target.value.toUpperCase())} />
          <span className="faint" style={{ fontSize: 12 }}>From the Dexterity colleague who invited you. You will see only the Spaces it is for.</span>
        </div>
      ) : (
        <div className="faint" style={{ fontSize: 13 }}>
          <button type="button" className="link" onClick={() => setGuest(true)}>I'm a guest with an invite code</button>
          {' · '}
          <button type="button" className="link" onClick={() => { setMode('pair'); setError(null); }}>I have a pairing code</button>
        </div>
      )}

      {error && <div className="error-box">{error}</div>}
      <BackToOffices state={state} />

      <button className="btn primary lg" type="submit" disabled={!canOffice || (guest && !/^DEX-?[A-Z2-9]{5}-?[A-Z2-9]{5}$/.test(invite.trim()))}
        title={busy ? undefined : !name.trim() ? 'Enter your name first' : manual && !address.trim() ? 'Enter the hub address first' : !manual && !selected ? 'Choose the office hub first' : guest && !/^DEX-?[A-Z2-9]{5}-?[A-Z2-9]{5}$/.test(invite.trim()) ? 'Enter the whole invite code first' : undefined}>
        {busy ? <span className="spinner" /> : null}
        {guest ? 'Join as a guest' : 'Request access'}
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
      <div><button className="btn ghost" onClick={() => void window.dex.forgetHub()}>Choose a different hub</button></div>
    </div>
  );
}

function Problem({ title, text }: { title: string; text: string }) {
  return (
    <div className="stack-v">
      <div style={{ color: 'var(--danger)' }}><Icon name="warning" size={40} /></div>
      <h2>{title}</h2>
      <p className="muted">{text}</p>
      <div><button className="btn primary" onClick={() => void window.dex.forgetHub()}>Choose a different hub</button></div>
    </div>
  );
}
