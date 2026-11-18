// Dexterity Connect for iPhone (the web app, apps/web): the "Add to Home Screen" guide shown when
// it is opened in Safari, the notifications section in Preferences, and the one-time question
// that turns notifications on. iOS only lets a web app show notifications once it is on the Home
// Screen, and only asks the person from a tap, so both are explained here in plain words.
import { useEffect, useState } from 'react';
import type { AppState, WebPushState } from '../../shared/bridge.ts';
import logo from '../app-icon.svg';
import { Dialog, Icon, useToast } from '../ui.tsx';
import './webapp.css';

const ASKED_KEY = 'dex-push-asked';
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

/** A phone in outline, drawn here, with Safari's toolbar and the button to tap ringed in amber. */
function ShareDrawing() {
  return (
    <svg className="wa-drawing" viewBox="0 0 120 150" aria-hidden="true">
      <rect x="20" y="4" width="80" height="142" rx="12" className="wa-line" />
      <rect x="28" y="16" width="64" height="9" rx="4.5" className="wa-fill" />
      <line x1="28" y1="34" x2="80" y2="34" className="wa-faint" /><line x1="28" y1="42" x2="72" y2="42" className="wa-faint" /><line x1="28" y1="50" x2="84" y2="50" className="wa-faint" />
      <line x1="20" y1="118" x2="100" y2="118" className="wa-line" />
      <path d="M34 128l-4 4 4 4M44 128l4 4-4 4" className="wa-line" />
      <g transform="translate(51 122) scale(0.75)"><path d="M12 14.5V3.5M8.5 7 12 3.5 15.5 7M8 10H6.5A1.5 1.5 0 0 0 5 11.5v7A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-7a1.5 1.5 0 0 0-1.5-1.5H16" className="wa-accent" /></g>
      <circle cx="60" cy="131" r="11" className="wa-ring" />
      <rect x="76" y="127" width="9" height="9" rx="2" className="wa-line" />
    </svg>
  );
}

/** The share sheet's list, with the row to tap ringed. */
function SheetDrawing() {
  return (
    <svg className="wa-drawing" viewBox="0 0 120 150" aria-hidden="true">
      <rect x="20" y="4" width="80" height="142" rx="12" className="wa-line" />
      <rect x="24" y="60" width="72" height="82" rx="8" className="wa-sheet" />
      <line x1="30" y1="76" x2="90" y2="76" className="wa-faint" />
      <line x1="30" y1="90" x2="90" y2="90" className="wa-faint" />
      <rect x="27" y="95" width="66" height="16" rx="3" className="wa-ring" />
      <g transform="translate(78 97) scale(0.5)"><path d="M6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5v-11A2.5 2.5 0 0 1 6.5 4zM12 8.5v7M8.5 12h7" className="wa-accent" /></g>
      <line x1="31" y1="103" x2="70" y2="103" className="wa-line" />
      <line x1="30" y1="122" x2="90" y2="122" className="wa-faint" />
    </svg>
  );
}

/** Opened in Safari (not from the Home Screen): how to add it, and why. */
export function InstallGuide({ state }: { state: AppState }) {
  const web = window.dex.web!;
  const toast = useToast();
  const code = web.pendingCode();
  const [copied, setCopied] = useState(false);
  const where = web.device === 'ipad' ? 'iPad' : 'iPhone';
  const copy = () => {
    if (!code) return;
    void navigator.clipboard.writeText(code).then(() => { setCopied(true); toast('Pairing code copied'); }).catch(() => toast('The code could not be copied. Select it and copy it instead.', true));
  };
  if (web.device === 'other') {
    return (
      <div className="stack-v wa-guide">
        <div>
          <img className="mark" src={logo} alt="" />
          <span className="wa-caption mono">Dexterity Connect · for iPhone</span>
          <h1 className="balance">This is the iPhone app</h1>
          <p className="lede">Open this page on your iPhone: point its camera at the code on your PC. On an Android phone, install the app from the download page instead; on a PC, use the desktop app.</p>
        </div>
        <button className="btn ghost" onClick={() => web.continueInBrowser()}>Use it in this browser</button>
        <p className="faint" style={{ fontSize: 12.5, margin: 0 }}>In a browser it works while the page is open. Notifications need the iPhone app on the Home Screen.</p>
      </div>
    );
  }
  return (
    <div className="stack-v wa-guide">
      <div>
        <img className="mark" src={logo} alt="" />
        <span className="wa-caption mono" translate="no">{`Dexterity Connect · ${state.version}`}</span>
        <h1 className="balance">{where === 'iPad' ? 'Add Dexterity Connect to your iPad' : 'Add Dexterity Connect to your iPhone'}</h1>
        <p className="lede">{where === 'iPad' ? 'On iPad, Dexterity Connect is a web app from your office. Added to the Home Screen, it opens like any other app and can show notifications. There is nothing to download from the App Store.' : 'On iPhone, Dexterity Connect is a web app from your office. Added to the Home Screen, it opens like any other app and can show notifications. There is nothing to download from the App Store.'}</p>
      </div>
      <ol className="wa-steps">
        {code && (
          <li>
            <span className="wa-n mono">1</span>
            <div className="wa-txt">
              <b>Copy your pairing code</b>
              <span className="faint">The app on your Home Screen starts fresh, so you paste the code there.</span>
              <button className={`btn ${copied ? '' : 'primary'} sm`} onClick={copy}><Icon name={copied ? 'check' : 'copy'} size={15} />{copied ? 'Copied' : 'Copy the code'}</button>
            </div>
          </li>
        )}
        <li>
          <span className="wa-n mono">{code ? 2 : 1}</span>
          <div className="wa-txt"><b>Tap Share in Safari <Icon name="share-out" size={16} /></b><span className="faint">At the bottom of the screen (on an iPad, at the top).</span></div>
          <ShareDrawing />
        </li>
        <li>
          <span className="wa-n mono">{code ? 3 : 2}</span>
          <div className="wa-txt"><b>Tap Add to Home Screen <Icon name="add-box" size={16} /></b><span className="faint">Then tap Add. Scroll down the list if you do not see it.</span></div>
          <SheetDrawing />
        </li>
        <li>
          <span className="wa-n mono">{code ? 4 : 3}</span>
          <div className="wa-txt"><b>Open Dexterity Connect from your Home Screen</b><span className="faint">{code ? 'Tap Paste the code. You are signed in as yourself.' : 'Scan the code on your PC or paste it.'}</span></div>
        </li>
      </ol>
      <p className="faint" style={{ fontSize: 12.5, margin: 0 }}>No Add to Home Screen in the list? Open this page in Safari. It needs iOS 16.4 or later for notifications.</p>
      <div className="wa-skip">
        <button type="button" className="link" onClick={() => web.continueInBrowser()}>Continue in Safari without adding it</button>
        <span className="faint">No notifications, and Safari may clear it after a few weeks unused.</span>
      </div>
    </div>
  );
}

const PUSH_LINE: Record<WebPushState, string> = {
  unsupported: 'This browser cannot show notifications from web apps. On an iPhone they need iOS 16.4 or later (Settings ▸ General ▸ Software Update).',
  'not-installed': 'Add Dexterity Connect to your Home Screen first: an iPhone shows notifications only for apps there.',
  off: 'Off. Messages reach you while the app is open.',
  denied: 'Blocked for Dexterity Connect. Turn them on in the iPhone\'s Settings ▸ Notifications ▸ Dexterity.',
  on: 'On. Your office sends them through Apple\'s push service, encrypted so only this iPhone can read them.',
};

/** Preferences ▸ Notifications on this iPhone. */
export function WebPushSettings({ state }: { state: AppState }) {
  const web = window.dex.web;
  const toast = useToast();
  const [st, setSt] = useState<WebPushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [guide, setGuide] = useState(false);
  useEffect(() => { void web?.pushState().then(setSt).catch(() => setSt('unsupported')); }, [web, state.phase]);
  if (!web || !st) return null;
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); } catch (e) { toast((e as Error).message, true); }
    setSt(await web.pushState().catch(() => 'unsupported' as const));
    setBusy(false);
  };
  return (
    <section>
      <h3>{web.device === 'ipad' ? 'On this iPad' : 'On this iPhone'}</h3>
      <div className="setting">
        <Icon name="bell" className="lead" />
        <div className="txt"><div>Notifications</div><div className="faint">{PUSH_LINE[st]}</div></div>
        {st === 'off' ? <button className="btn primary" disabled={busy || state.phase !== 'ready'} onClick={() => void act(() => web.enablePush())}>Turn on</button>
          : st === 'on' ? <button className="btn" disabled={busy} onClick={() => void act(() => web.disablePush())}>Turn off</button>
          : st === 'not-installed' ? <button className="btn" onClick={() => setGuide(true)}><Icon name="add-box" size={15} />How to add it</button>
          : <span className="chip warn">{st === 'denied' ? 'Blocked' : 'Not available'}</span>}
      </div>
      {st === 'on' && (
        <div className="setting">
          <Icon name="send" className="lead" />
          <div className="txt"><div>Test notification</div><div className="faint">Your office sends one to this iPhone now.</div></div>
          <button className="btn" disabled={busy} onClick={() => void act(async () => { const r = await web.testPush(); toast(r.ok ? 'Test notification sent' : r.error ?? 'The test did not go through.', !r.ok); })}>Send a test</button>
        </div>
      )}
      <div className="setting">
        <Icon name="info" className="lead" />
        <div className="txt">
          <div>What works differently on iPhone</div>
          <div className="faint">Calls ring only while the app is open: iPhone does not let web apps ring in the background. Messages to an end-to-end encrypted conversation say only "New encrypted message" until you open the app. Screen sharing needs the desktop app.</div>
        </div>
      </div>
      {guide && <Dialog title="Add to Home Screen" onClose={() => setGuide(false)}><InstallGuide state={state} /></Dialog>}
    </section>
  );
}

/** Once, in the app on the Home Screen: turn notifications on (iOS asks only from a tap). */
export function WebPushPrompt({ state }: { state: AppState }) {
  const web = window.dex.web;
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!web || state.phase !== 'ready' || store.get(ASKED_KEY)) return;
    let alive = true;
    void web.pushState().then((s) => { if (alive && s === 'off') setShow(true); }).catch(() => {});
    return () => { alive = false; };
  }, [web, state.phase]);
  if (!show || !web) return null;
  const done = () => { store.set(ASKED_KEY, '1'); setShow(false); };
  return (
    <div className="wa-prompt" role="dialog" aria-labelledby="wa-prompt-title">
      <Icon name="bell" size={22} />
      <div className="wa-txt">
        <b id="wa-prompt-title">Get notified of new messages?</b>
        <span className="faint">While Dexterity Connect is closed, your office sends a notification for Direct messages, mentions and Spaces, as your Notifications preferences say.</span>
      </div>
      <div className="row-actions">
        <button className="btn ghost sm" onClick={done}>Not now</button>
        <button className="btn primary sm" disabled={busy} onClick={() => { setBusy(true); void web.enablePush().finally(done); }}>Turn on</button>
      </div>
    </div>
  );
}

/** The welcome screen in the app on the Home Screen: paste the code from Safari (iOS shows its own Paste button). */
export function PasteCode({ onCode }: { onCode: (text: string) => void }) {
  const web = window.dex.web;
  const toast = useToast();
  if (!web) return null;
  return (
    <button type="button" className="pair-scan" onClick={() => void web.pasteCode().then((t) => { if (t) onCode(t); else toast('Nothing to paste. Copy the code in Safari first.', true); })}>
      <span className="ico"><Icon name="copy" size={24} /></span>
      <span><b>Paste the code</b><span className="faint">Copied in Safari, or sent to yourself</span></span>
    </button>
  );
}
