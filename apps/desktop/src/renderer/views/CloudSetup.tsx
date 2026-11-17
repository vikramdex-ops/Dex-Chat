// Control room ▸ Outside the office ▸ Set up with Cloudflare. The owner makes a Cloudflare account
// and one API token (a link opens Cloudflare's form with the permissions filled in), pastes it
// here once, and the hub does the rest: the gateway, its pin, the meeting site, the TURN key,
// outside access on, all checked (apps/hub/src/cfdeploy.ts). Each step shows as it happens; a
// step that stops says why in plain words, and Retry continues there. See docs/REMOTE-ACCESS.md.
import { useEffect, useRef, useState } from 'react';
import { CF_PERMISSIONS, CF_SIGNUP_LINK, CF_TOKEN_LINK } from '@dex/core';
import type { CfProblem, CfSetupView, CfStep, Ops } from '@dex/core';
import { Icon, relativeTime, useToast } from '../ui.tsx';
import './cloudsetup.css';

const STEP_LABEL: Record<CfStep, string> = {
  token: 'Check the token',
  account: 'Choose the Cloudflare account',
  subdomain: 'Workers address (workers.dev)',
  gateway: 'Upload the gateway',
  pin: 'Pin the gateway to this hub',
  workersdev: 'Turn on the gateway\'s address',
  project: 'Meeting site project',
  site: 'Publish the meeting site',
  connect: 'Connect this hub and allow access from outside',
  verify: 'Check the gateway, the pin and the meeting site',
  turn: 'Relay for calls (Cloudflare TURN)',
};

function Problem({ p }: { p: CfProblem }) {
  const detail = p.detail ? <span className="mono cf-detail" translate="no">{p.detail}</span> : null;
  let text: React.ReactNode;
  switch (p.code) {
    case 'token': text = 'Cloudflare did not accept the token. Check that it was copied whole and has not been deleted or expired, then paste it again.'; break;
    case 'permission': text = <><span>The token is missing this permission:</span><span className="mono cf-detail" translate="no">{CF_PERMISSIONS[p.perm ?? 'account']}</span><span className="cf-then">In Cloudflare, open My Profile ▸ API Tokens, edit the token, add the permission, then press Retry.</span></>; break;
    case 'no-account': text = 'The token does not reach any Cloudflare account. Make it again with the link above, with the office\'s account included.'; break;
    case 'subdomain': text = <>Cloudflare would not make a workers.dev address for the account. {detail}</>; break;
    case 'network': text = 'The hub PC could not reach Cloudflare. Check its internet connection, then press Retry.'; break;
    case 'dns': text = 'The new address does not answer yet. A new Cloudflare account can take a few minutes: press Retry in five minutes.'; break;
    case 'not-connected': text = <>The hub could not sign in to the gateway. {detail}</>; break;
    case 'not-pinned': text = <>The gateway did not confirm that it is pinned to this hub. {detail}</>; break;
    case 'site': text = 'The meeting site does not reach the gateway yet. Press Retry in a few minutes.'; break;
    case 'interrupted': text = 'The hub stopped during the setup. Press Retry to continue.'; break;
    case 'no-bundle': text = 'This hub was built without the Cloudflare parts.'; break;
    default: text = <>Cloudflare refused this step. {detail}</>;
  }
  return <p className="cf-problem" role="alert"><Icon name="warning" size={15} /><span>{text}</span></p>;
}

/** The schedule of steps, each as it stands. */
function Steps({ v }: { v: CfSetupView }) {
  return (
    <ol className="cf-steps" aria-label="Setup steps">
      {v.steps.map((s) => (
        <li key={s.id} className={`cf-step ${s.state}`}>
          <span className="cf-mark" aria-hidden>{s.state === 'done' ? <Icon name="check" size={14} /> : s.state === 'running' ? <span className="spinner" /> : s.state === 'failed' ? <Icon name="warning" size={14} /> : null}</span>
          <span className="cf-label">{STEP_LABEL[s.id]}</span>
          <span className="cf-st mono">{s.state === 'done' ? 'Done' : s.state === 'running' ? 'Working' : s.state === 'failed' ? 'Stopped' : ''}</span>
        </li>
      ))}
    </ol>
  );
}

/** The token box: paste, keep or not, and the button that starts. */
function TokenForm({ busy, cta, keepDefault, onGo }: { busy: boolean; cta: string; keepDefault: boolean; onGo: (token: string, keep: boolean) => void }) {
  const [token, setToken] = useState('');
  const [keep, setKeep] = useState(keepDefault);
  return (
    <form className="cf-token" onSubmit={(e) => { e.preventDefault(); if (token.trim()) onGo(token.trim(), keep); }}>
      <label htmlFor="cf-token" className="field-label">Cloudflare API token</label>
      <div className="gw-url-row">
        <input id="cf-token" className="input mono" type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} placeholder="Paste the token here" />
        <button className="btn primary" type="submit" disabled={busy || !token.trim()}>{cta}</button>
      </div>
      <label className="cf-keep">
        <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
        <span>Keep it on the hub for gateway updates</span>
      </label>
      <p className="faint cf-hint">The token is used for this setup and then forgotten, unless you keep it. It is never shown again or sent to any device.</p>
    </form>
  );
}

export function CloudSetup({ onChanged }: { onChanged?: () => void }) {
  const toast = useToast();
  const [v, setV] = useState<CfSetupView | null>(null);
  const [again, setAgain] = useState(false);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  useEffect(() => {
    void window.dex.request('admin.cloudflare.get').then(setV).catch(() => {});
    return window.dex.onHubEvent((n, d) => {
      if (n !== 'admin.cloudflare') return;
      const x = d as CfSetupView;
      setV(x);
      if (x.phase === 'done' || x.phase === 'failed') changed.current?.();
    });
  }, []);
  const act = async <K extends 'admin.cloudflare.start' | 'admin.cloudflare.retry' | 'admin.cloudflare.update' | 'admin.cloudflare.choose' | 'admin.cloudflare.forget'>(op: K, req: Ops[K]['req']) => {
    setBusy(true);
    try { setV(await window.dex.request(op, req as never) as CfSetupView); setAgain(false); } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  };
  if (!v) return null;
  if (!v.bundled) {
    return (
      <section className="card cf-sheet off" aria-label="Set up with Cloudflare">
        <div className="eyebrow">Set up with Cloudflare</div>
        <p className="muted" style={{ margin: 0 }}>This hub was built without the Cloudflare parts. Deploy the gateway with Deploy-Gateway.cmd and enter its address below.</p>
      </section>
    );
  }
  const running = v.phase === 'running';
  const showSteps = v.phase !== 'idle' && !again;
  const state = running ? 'run' : v.phase === 'failed' || v.phase === 'choose' ? 'warn' : v.phase === 'done' ? 'ok' : 'off';
  const start = (token: string, keep: boolean) => void act('admin.cloudflare.start', { token, keep });
  return (
    <section className={`card cf-sheet ${state}`} aria-label="Set up with Cloudflare" aria-busy={running}>
      <div className="cf-head">
        <div>
          <div className="eyebrow">Set up with Cloudflare</div>
          <div className="cf-state" role="status">
            {running ? <><span className="spinner" />Setting up</>
              : v.phase === 'done' ? <><Icon name="check" size={18} />{v.deployedAt ? `Set up ${relativeTime(v.deployedAt)}` : 'Set up'}</>
                : v.phase === 'failed' ? <><Icon name="warning" size={18} />The setup stopped</>
                  : v.phase === 'choose' ? <><Icon name="warning" size={18} />Choose the account</>
                    : <>Put the office online in one step</>}
          </div>
        </div>
        {v.phase === 'done' && !again && <button className="btn" onClick={() => setAgain(true)}>Run the setup again</button>}
      </div>

      {(v.phase === 'idle' || again) && (
        <>
          <p className="muted cf-lead">The hub deploys the gateway and the meeting site to the office's own Cloudflare account, pins the gateway to this hub, sets up calls across networks and checks that everything answers. You need a free Cloudflare account and one API token.</p>
          <ol className="cf-todo">
            <li>
              <span className="cf-n mono" aria-hidden>01</span>
              <div className="txt"><div>Create a free Cloudflare account and confirm your email.</div><div className="faint">Skip this if the office has one.</div></div>
              <a className="btn sm" href={CF_SIGNUP_LINK} target="_blank" rel="noreferrer noopener"><Icon name="open" size={14} />Cloudflare sign-up</a>
            </li>
            <li>
              <span className="cf-n mono" aria-hidden>02</span>
              <div className="txt">
                <div>Create an API token. The link opens Cloudflare's form with these permissions filled in:</div>
                <ul className="cf-perms mono" translate="no">
                  <li>{CF_PERMISSIONS.workers}</li><li>{CF_PERMISSIONS.pages}</li><li>{CF_PERMISSIONS.account}</li>
                </ul>
                <div className="faint">Add one more permission yourself (Cloudflare Realtime may be listed as Calls), then create the token and copy it:</div>
                <ul className="cf-perms cf-clicks mono" translate="no">
                  <li>+ Add more ▸ Account ▸ Cloudflare Realtime ▸ Edit</li><li>Continue to summary ▸ Create Token ▸ Copy</li>
                </ul>
              </div>
              <a className="btn sm" href={CF_TOKEN_LINK} target="_blank" rel="noreferrer noopener"><Icon name="open" size={14} />Open the token form</a>
            </li>
            <li>
              <span className="cf-n mono" aria-hidden>03</span>
              <div className="txt cf-grow"><TokenForm busy={busy} cta="Set up" keepDefault={v.tokenKept} onGo={start} /></div>
            </li>
          </ol>
          {again && <div className="row-actions"><button className="btn ghost sm" onClick={() => setAgain(false)}>Cancel</button></div>}
        </>
      )}

      {showSteps && v.phase !== 'done' && <Steps v={v} />}

      {v.phase === 'choose' && (
        <fieldset className="cf-choose">
          <legend>This token can use more than one Cloudflare account. Which one is the office's?</legend>
          {v.accounts.map((a) => (
            <label key={a.id} className="cf-acct">
              <input type="radio" name="cf-acct" value={a.id} checked={pick === a.id} onChange={() => setPick(a.id)} />
              <span>{a.name}</span><span className="faint mono" translate="no">{a.id.slice(0, 8)}…</span>
            </label>
          ))}
          <div className="row-actions"><button className="btn primary" disabled={!pick || busy} onClick={() => void act('admin.cloudflare.choose', { accountId: pick })}>Continue</button></div>
        </fieldset>
      )}

      {v.phase === 'failed' && v.problem && !again && (
        <>
          <Problem p={v.problem} />
          {v.tokenHeld
            ? <div className="row-actions"><button className="btn ghost" onClick={() => setAgain(true)}>Start again</button><button className="btn primary" disabled={busy} onClick={() => void act('admin.cloudflare.retry', {})}><Icon name="refresh" size={15} />Retry</button></div>
            : <TokenForm busy={busy} cta="Retry" keepDefault={false} onGo={(token, keep) => void act('admin.cloudflare.retry', { token, keep })} />}
        </>
      )}

      {v.phase === 'done' && !again && (
        <>
          <div className="cf-block" role="list">
            <div className="cf-cell" role="listitem"><span className="label">Cloudflare account</span><span className="v">{v.account?.name ?? '–'}</span></div>
            <div className="cf-cell" role="listitem"><span className="label">Gateway</span><span className="v mono" translate="no">{v.gatewayUrl?.replace(/^https?:\/\//, '') ?? '–'}</span></div>
            <div className="cf-cell" role="listitem"><span className="label">Meeting site</span><span className="v mono" translate="no">{v.siteUrl?.replace(/^https?:\/\//, '') ?? '–'}</span></div>
            <div className="cf-cell" role="listitem"><span className="label">Calls</span><span className="v">{v.turnKeyId ? 'Cloudflare TURN' : 'As set below'}</span></div>
          </div>
          {v.updateAvailable && (
            <div className="cf-update">
              <p className="cf-problem"><Icon name="download" size={15} /><span>This version of the hub carries a newer gateway and meeting site.</span></p>
              {v.tokenKept
                ? <div className="row-actions"><button className="btn primary" disabled={busy} onClick={() => void act('admin.cloudflare.update', {})}>Update the gateway</button></div>
                : <TokenForm busy={busy} cta="Update the gateway" keepDefault={false} onGo={(token, keep) => void act('admin.cloudflare.update', { token, keep })} />}
            </div>
          )}
          <details className="cf-fold">
            <summary>Show the steps</summary>
            <Steps v={v} />
          </details>
          {v.tokenKept && <p className="faint cf-hint">The token is kept on the hub for updates. <button className="link" onClick={() => void act('admin.cloudflare.forget', undefined)}>Forget the token</button></p>}
        </>
      )}
    </section>
  );
}
