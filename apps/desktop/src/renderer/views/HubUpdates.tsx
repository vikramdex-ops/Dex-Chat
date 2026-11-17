// Control room ▸ Backups & leavers ▸ Hub updates: the hub's version and how it keeps itself up to
// date (apps/hub/src/hub-update.ts). It installs newer versions by itself at a quiet time, after a
// backup and never during a meeting; here administrators see what it will do and when, switch it
// off, choose the time and the channel, update now, and read what happened (with Try again after an
// update that went back).
import { useCallback, useEffect, useState } from 'react';
import type { HubUpdateView, HubUpdateWait } from '@dex/core';
import { Icon, Toggle, relativeTime, useToast } from '../ui.tsx';
import { confirmAction } from '../confirm.tsx';
import { formatDateTime, formatTime } from '../time.ts';
import { bytes } from './Continuity.tsx';
import './continuity.css';
import './hubupdates.css';

/** Audit log wording (Control room ▸ Audit log). */
export const HUB_UPDATE_AUDIT: Record<string, string> = {
  'hub.updated': 'updated itself to a new version',
  'hub.update.started': 'started installing a new version',
  'hub.update.failed': 'could not update itself and went back to the version before',
  'hub.update.settings': 'changed how the hub updates itself',
  'hub.update.requested': 'asked the hub to update now',
  'hub.update.retry': 'let the hub try a failed update again',
};

const WAIT_TEXT: Record<HubUpdateWait, string> = {
  webinar: 'A webinar is live, so the update waits until it ends.',
  meeting: 'A meeting is live, so the update waits until it ends.',
  call: 'A call is going on, so the update waits until it ends.',
  'backup-running': 'The night\'s backup is still running; the update starts after it.',
  'backing-up': 'Backing up the hub before the update.',
  'backup-failed': 'The backup before the update did not work, and there is no good backup from the last day, so the update waits for the next night.',
};

const BACKUP_TEXT: Record<'fresh' | 'recent' | 'none', string> = {
  fresh: 'backed up just before',
  recent: 'after the night\'s backup',
  none: 'no backup: backups are not set up',
};

function whenText(at: number, now = Date.now()): string {
  if (at <= now + 60_000) return 'As soon as it can';
  const d = new Date(at);
  const t = formatTime(d);
  if (d.toDateString() === new Date(now).toDateString()) return d.getHours() >= 18 || d.getHours() < 6 ? `Tonight at ${t}` : `Today at ${t}`;
  if (d.toDateString() === new Date(now + 86_400_000).toDateString()) return `Tomorrow at ${t}`;
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} at ${t}`;
}

export function HubUpdatesAdmin({ live }: { live: boolean }) {
  const toast = useToast();
  const [v, setV] = useState<HubUpdateView | null>(null);
  const [busy, setBusy] = useState(false);
  const [time, setTime] = useState('03:00');
  useEffect(() => {
    if (!live) return;
    void window.dex.request('admin.hubUpdate.get', {}).then((x) => { setV(x); setTime(x.config.time); }).catch((e: Error) => toast(e.message, true));
    return window.dex.onHubEvent((n, d) => { if (n === 'admin.hubUpdate') setV(d as HubUpdateView); });
  }, [live, toast]);
  const act = useCallback(async (fn: () => Promise<HubUpdateView>, ok?: string) => {
    setBusy(true);
    try { const x = await fn(); setV(x); setTime(x.config.time); if (ok) toast(ok); } catch (e) { toast((e as Error).message, true); } finally { setBusy(false); }
  }, [toast]);
  if (!v) return <div className="tl-more"><span className="spinner" /></div>;

  const a = v.available;
  const liveNow = v.waiting === 'meeting' || v.waiting === 'call' || v.waiting === 'webinar';
  const state = v.installing || v.checking ? 'run' : v.failed || (v.waiting && v.waiting !== 'backing-up') ? 'warn' : v.supported ? 'ok' : 'off';
  const updateNow = async () => {
    if (!a) return;
    if (!(await confirmAction({ title: `Update the hub to ${a.version} now?`, body: 'The hub is offline for about a minute while it installs; everyone reconnects by themselves. It backs up first, and waits for any meeting or call on the hub to end.', confirm: 'Update now' }))) return;
    await act(() => window.dex.request('admin.hubUpdate.now', { force: false }), 'The hub updates as soon as nothing is live on it');
  };
  const force = async () => {
    if (!(await confirmAction({ title: 'Update during the meeting?', body: 'Everyone in a meeting, call or webinar on the hub is cut off for about a minute and has to join again.', confirm: 'Update now anyway', danger: true }))) return;
    await act(() => window.dex.request('admin.hubUpdate.now', { force: true }), 'The hub is updating now');
  };

  return (
    <>
      <section className={`card bk-sheet hu-sheet ${state}`} aria-labelledby="hu-title">
        <div className="bk-head">
          <div>
            <div className="eyebrow" id="hu-title">Hub updates</div>
            <div className="bk-state" role="status">
              {v.installing ? <><span className="spinner" />{`Installing ${v.installing.version}: back in about a minute`}</>
                : v.failed ? <><Icon name="warning" size={18} />{`The update to ${v.failed.version} did not work`}</>
                  : !v.supported ? <>This hub is updated by hand</>
                    : a ? <><Icon name="download" size={18} />{v.downloaded ? `Version ${a.version} is ready to install` : `Version ${a.version} is on its way`}</>
                      : v.checking ? <><span className="spinner" />Looking for a newer version</>
                        : <><Icon name="check" size={18} />The hub is up to date</>}
            </div>
          </div>
          <div className="hu-actions">
            <button className="btn sm" disabled={!live || busy || v.checking || !!v.installing} onClick={() => void act(() => window.dex.request('admin.hubUpdate.get', { check: true }))}>
              <Icon name="refresh" size={14} />Look now
            </button>
            {v.supported && a && !v.installing && !v.requested && (
              <button className="btn primary sm" disabled={!live || busy} onClick={() => void updateNow()}><Icon name="download" size={14} />Update now</button>
            )}
          </div>
        </div>
        {v.waiting && <p className={liveNow || v.waiting === 'backup-failed' ? 'bk-problem' : 'hu-note'}><Icon name={liveNow ? 'video' : 'archive'} size={14} /><span>{WAIT_TEXT[v.waiting]}</span></p>}
        {v.requested && liveNow && (
          <div className="hu-force">
            <span className="faint">{`Update now was clicked ${relativeTime(v.requested.at)}.`}</span>
            <button className="btn sm ghost danger" disabled={!live || busy} onClick={() => void force()}>Update now anyway</button>
          </div>
        )}
        {!v.supported && v.unsupportedReason && <p className="hu-note"><Icon name="info" size={14} /><span>{v.unsupportedReason}</span></p>}
        {v.lastError && !v.failed && <p className="hu-note"><Icon name="info" size={14} /><span>{v.lastError}</span></p>}
        {v.failed && (
          <div className="bk-problem hu-failed">
            <Icon name="warning" size={14} />
            <div className="txt">
              <span>{v.failed.message}</span>
              <span>{`The hub does not try ${v.failed.version} again by itself.`}</span>
              {v.failed.log && <span className="mono selectable">{v.failed.log}</span>}
            </div>
            <button className="btn sm" disabled={!live || busy} onClick={() => void act(() => window.dex.request('admin.hubUpdate.retry'), `${v.failed!.version} is tried again at the next quiet time`)}>Try again</button>
          </div>
        )}
        <div className="bk-block" role="list">
          <div className="bk-cell" role="listitem"><span className="label">Running</span><span className="v mono">{v.version}</span></div>
          <div className="bk-cell" role="listitem"><span className="label">Channel</span><span className="v">{v.config.channel === 'beta' ? 'Beta' : 'Stable'}</span></div>
          <div className="bk-cell" role="listitem"><span className="label">Last looked</span><span className="v">{v.lastCheck ? relativeTime(v.lastCheck) : '–'}</span></div>
          <div className="bk-cell" role="listitem"><span className="label">Next update</span>
            <span className="v">{v.installing ? 'Now' : v.nextAt ? whenText(v.nextAt) : a && v.supported && !v.config.auto ? 'When you click Update now' : '–'}</span>
            {a && <span className="sub mono">{`${a.version} · ${bytes(a.size)}`}</span>}
          </div>
        </div>
      </section>

      {v.supported && (
        <section className="card">
          <div className="eyebrow">How the hub updates itself</div>
          <div className="setting" style={{ marginTop: 6 }}>
            <Icon name="repeat" className="lead" />
            <div className="txt"><div>Install new versions by themselves</div><div className="faint">At the quiet time below, after a backup, and never while a meeting, call or webinar is live. The hub is offline for about a minute. If the new version does not start, the hub goes back to the version before.</div></div>
            <Toggle label="Install new hub versions by themselves" checked={v.config.auto} onChange={(on) => void act(() => window.dex.request('admin.hubUpdate.set', { auto: on }), on ? 'The hub updates itself' : 'The hub no longer updates itself')} />
          </div>
          <div className="setting bk-time">
            <Icon name="clock" className="lead" />
            <div className="txt"><div>Quiet time</div><div className="faint">The hub PC's time. Keep it after the night's backup. If a meeting is going on, the update waits up to two hours, then tries the next night.</div></div>
            <input type="time" className="input" aria-label="Quiet time for hub updates" value={time} disabled={!live || busy}
              onChange={(e) => { setTime(e.target.value); if (e.target.value && e.target.value !== v.config.time) void act(() => window.dex.request('admin.hubUpdate.set', { time: e.target.value }), `Hub updates at ${e.target.value}`); }} />
          </div>
          <div className="setting">
            <Icon name="branch" className="lead" />
            <div className="txt"><div>Channel</div><div className="faint">Stable is what every office gets. Beta also takes builds published for trying out; use it only on a test hub.</div></div>
            <select className="input hu-channel" aria-label="Hub update channel" value={v.config.channel} disabled={!live || busy}
              onChange={(e) => void act(() => window.dex.request('admin.hubUpdate.set', { channel: e.target.value as 'stable' | 'beta' }), e.target.value === 'beta' ? 'The hub takes beta builds' : 'The hub takes stable builds')}>
              <option value="stable">Stable</option>
              <option value="beta">Beta</option>
            </select>
          </div>
          <p className="faint bk-hint">The hub installs a setup only if its size and SHA-512 fingerprint match the release feed, never an older version, and never a beta build on the stable channel. The installers are not code-signed.</p>
        </section>
      )}

      {v.history.length > 0 && (
        <section className="card">
          <div className="eyebrow">Updates</div>
          <div className="bk-runs">
            {v.history.slice(0, 10).map((r) => (
              <div key={r.at} className={`bk-run ${r.ok ? 'ok' : 'bad'}`}>
                <span className="bk-tick" aria-hidden />
                <div className="txt">
                  <div>{formatDateTime(r.at, { weekday: 'short', day: 'numeric', month: 'short' })}
                    <span className="faint mono">{` · ${r.from} → ${r.to}`}</span>
                    <span className="faint"> · {r.by ? 'Update now' : 'at the quiet time'} · {BACKUP_TEXT[r.backup]}</span></div>
                  <div className="faint">{r.message}</div>
                  {r.log && <div className="faint mono selectable">{r.log}</div>}
                </div>
                <span className={`chip ${r.ok ? 'ok' : 'warn'}`}>{r.ok ? 'Updated' : 'Went back'}</span>
              </div>
            ))}
          </div>
        </section>
      )}
      <p className="faint bk-hint">{`The setup writes what it does to ${v.setupLog} on the hub PC.`}</p>
    </>
  );
}
