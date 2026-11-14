// Update surfaces: the title-bar pill, the required-update prompt and the "what's new" card.
import type { AppState } from '../shared/bridge.ts';
import { Icon } from './ui.tsx';

export const formatBytes = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(0)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;
const pct = (p: { received: number; total: number } | null) => (p && p.total ? Math.floor((p.received / p.total) * 100) : 0);

export function UpdatePill({ state }: { state: AppState }) {
  const u = state.update;
  if (u.phase === 'downloading') {
    return (
      <span className="conn" title={`Downloading Dexterity Connect ${u.available?.version}`}>
        <span className="ring" style={{ ['--p' as string]: `${pct(u.progress)}%` }} />Updating {pct(u.progress)}%
      </span>
    );
  }
  if (u.phase === 'ready' || u.phase === 'installing') {
    return (
      <button className="btn primary update-btn" onClick={() => void window.dex.installUpdate()} disabled={u.phase === 'installing'}>
        <Icon name="refresh" size={15} />{u.phase === 'installing' ? 'Restarting…' : 'Restart to update'}
      </button>
    );
  }
  return null;
}

export function RequiredUpdate({ state }: { state: AppState }) {
  const u = state.update;
  if (!u.available?.mandatory || (u.phase !== 'downloading' && u.phase !== 'ready' && u.phase !== 'installing' && u.phase !== 'error')) return null;
  return (
    <div className="scrim" role="alertdialog" aria-modal="true" aria-labelledby="req-title">
      <div className="dialog">
        <Icon name="shield" size={32} />
        <h2 id="req-title">A required update is {u.phase === 'downloading' ? 'downloading' : 'ready'}</h2>
        <p className="muted">Version {u.available.version} includes changes everyone in the office needs. It installs in a few seconds and reopens where you left off.</p>
        {u.phase === 'downloading' && <div className="bar"><span style={{ width: `${pct(u.progress)}%` }} /></div>}
        {u.phase === 'error' && <div className="error-box">{u.error} It will retry automatically.</div>}
        <button className="btn primary lg" disabled={u.phase !== 'ready'} onClick={() => void window.dex.installUpdate()}>
          {u.phase === 'installing' ? 'Restarting…' : 'Restart now'}
        </button>
      </div>
    </div>
  );
}

export function WhatsNew({ state }: { state: AppState }) {
  const j = state.update.justUpdated;
  if (!j) return null;
  const lines = j.notes.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 8);
  return (
    <div className="card whats-new" role="status">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <span className="chip accent">Updated</span>
        <h3 style={{ margin: 0 }}>You're on Dexterity Connect {j.version}</h3>
        <span style={{ flex: 1 }} />
        <button className="btn ghost" onClick={() => void window.dex.dismissWhatsNew()} aria-label="Dismiss">
          <Icon name="x" size={16} />
        </button>
      </div>
      {lines.length > 0 && <ul>{lines.map((l, i) => <li key={i}>{l.replace(/^[-*•]\s*/, '')}</li>)}</ul>}
    </div>
  );
}

export function UpdateSettings({ state }: { state: AppState }) {
  const u = state.update;
  const disabled = u.phase === 'disabled';
  const busy = u.phase === 'checking' || u.phase === 'downloading' || u.phase === 'installing';
  let line: string;
  switch (u.phase) {
    case 'disabled': line = 'Updates are managed outside the app for development builds.'; break;
    case 'checking': line = 'Checking for updates…'; break;
    case 'up-to-date': line = `You're up to date${u.lastCheck ? ` · checked ${new Date(u.lastCheck).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}.`; break;
    case 'available': line = `Version ${u.available?.version} is available (${formatBytes(u.available?.size ?? 0)}, from ${u.available?.source === 'hub' ? 'the office hub' : 'the internet'}).`; break;
    case 'downloading': line = `Downloading ${u.available?.version}… ${pct(u.progress)}% of ${formatBytes(u.progress?.total ?? 0)}`; break;
    case 'ready': line = `Version ${u.available?.version} is ready. It installs when you restart or quit.`; break;
    case 'installing': line = 'Installing…'; break;
    case 'error': line = u.error ?? 'Something went wrong.'; break;
    default: line = u.lastCheck ? `Last checked ${new Date(u.lastCheck).toLocaleString()}.` : 'Checks automatically when the app opens and every few hours.';
  }
  return (
    <>
      <div className="setting">
        <Icon name="refresh" className="lead" />
        <div className="txt">
          <div>Dexterity Connect {u.currentVersion}</div>
          <div className={`faint${u.phase === 'error' ? ' danger-text' : ''}`}>{line}</div>
          {u.phase === 'downloading' && <div className="bar" style={{ marginTop: 8 }}><span style={{ width: `${pct(u.progress)}%` }} /></div>}
        </div>
        {u.phase === 'ready'
          ? <button className="btn primary" onClick={() => void window.dex.installUpdate()}>Restart to update</button>
          : u.phase === 'available'
            ? <button className="btn primary" onClick={() => void window.dex.downloadUpdate()}>Download</button>
            : <button className="btn" disabled={disabled || busy} onClick={() => void window.dex.checkForUpdates()}>
                {u.phase === 'checking' ? <span className="spinner" /> : null}Check for updates
              </button>}
      </div>
    </>
  );
}
