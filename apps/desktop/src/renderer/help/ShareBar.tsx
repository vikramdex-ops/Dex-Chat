// The share bar: a small window of its own at the top of the requester's screen while IT sees it
// (#overlay=bar). It stays above everything, says who sees the screen, and stops sharing or
// control with one press. The amber frame around the screen is drawn by the main process.
import { useEffect, useState } from 'react';
import type { ShareBarState } from '../../shared/bridge.ts';
import './help.css';

export function ShareBar() {
  const [s, setS] = useState<ShareBarState | null>(null);
  useEffect(() => {
    document.documentElement.classList.add('sb-overlay-doc');
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { document.documentElement.dataset.theme = media.matches ? 'dark' : 'light'; };
    apply();
    media.addEventListener('change', apply);
    const off = window.dex.overlay?.onState((x) => setS(x as ShareBarState));
    window.dex.overlay?.ready();
    return () => { media.removeEventListener('change', apply); off?.(); };
  }, []);
  if (!s) return null;
  const act = (a: 'stop-control' | 'stop-screen') => window.dex.overlay?.action(a);
  return (
    <div className={`share-bar${s.control ? ' control' : ''}`} role="toolbar" aria-label="Screen shared with IT">
      <span className="share-bar-pip" aria-hidden="true" />
      <span className="share-bar-text">
        <b>{s.control ? `${s.tech} is using your mouse and keyboard` : `Sharing your ${s.scope === 'window' ? 'window' : 'screen'} with ${s.tech}`}</b>
        <span className="mono">{s.control ? `STOP: ${s.hotkey.toUpperCase()}` : 'DEXTERITY CONNECT · IT SUPPORT'}</span>
      </span>
      {s.control && <button className="share-bar-btn stop" onClick={() => act('stop-control')}>Stop control</button>}
      <button className={`share-bar-btn${s.control ? '' : ' stop'}`} onClick={() => act('stop-screen')}>Stop sharing</button>
    </div>
  );
}
