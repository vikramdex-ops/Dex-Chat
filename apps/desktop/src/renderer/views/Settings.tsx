import { useState } from 'react';
import type { Session } from '@dex/core';
import type { AppState, Theme } from '../../shared/bridge.ts';
import { OfflineBanner } from '../App.tsx';
import { Avatar, Icon, Segmented, Toggle, deviceCode, useToast } from '../ui.tsx';
import { UpdateSettings } from '../UpdateUi.tsx';
import type { UpdateChannel } from '../../shared/bridge.ts';

export function SettingsView({ state, session }: { state: AppState; session: Session }) {
  const toast = useToast();
  const live = state.phase === 'ready';
  const [name, setName] = useState(session.me.displayName);
  const [title, setTitle] = useState(session.me.title ?? '');
  const [status, setStatus] = useState(session.me.statusText ?? '');
  const dirty = name.trim() !== session.me.displayName || title.trim() !== (session.me.title ?? '') || status.trim() !== (session.me.statusText ?? '');

  const saveProfile = async () => {
    try {
      await window.dex.request('me.update', { displayName: name, title: title.trim() || null, statusText: status.trim() || null });
      toast('Profile saved');
    } catch (e) { toast((e as Error).message, true); }
  };
  const set = (patch: Partial<AppState['settings']>) => void window.dex.setSettings(patch);

  return (
    <div className="view">
      <OfflineBanner state={state} />
      <div className="view-head"><div><h1>Preferences</h1></div></div>
      <div className="settings">
        <section>
          <h3>Profile</h3>
          <form className="form-grid" onSubmit={(e) => { e.preventDefault(); if (dirty) void saveProfile(); }}>
            <div className="full" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <Avatar user={{ id: session.me.id, displayName: name || '?' }} size="lg" />
              <div>
                <div style={{ fontWeight: 600 }}>{session.me.displayName}</div>
                <div className="faint mono">{session.me.account}</div>
              </div>
            </div>
            <div className="field"><label htmlFor="s-name">Display name</label>
              <input id="s-name" className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} disabled={!live} /></div>
            <div className="field"><label htmlFor="s-title">Job title</label>
              <input id="s-title" className="input" value={title} maxLength={80} placeholder="e.g. Piping Engineer" onChange={(e) => setTitle(e.target.value)} disabled={!live} /></div>
            <div className="field full"><label htmlFor="s-status">Status message</label>
              <input id="s-status" className="input" value={status} maxLength={120} placeholder="What are you working on?" onChange={(e) => setStatus(e.target.value)} disabled={!live} /></div>
            <div className="full row-actions" style={{ justifyContent: 'flex-end' }}>
              <button className="btn primary" disabled={!dirty || !live || !name.trim()}>Save profile</button>
            </div>
          </form>
        </section>

        <section>
          <h3>Appearance</h3>
          <div className="setting">
            <Icon name="sun" className="lead" />
            <div className="txt"><div>Theme</div><div className="faint">Follows Windows unless you choose otherwise.</div></div>
            <Segmented<Theme> label="Theme" value={state.settings.theme} onChange={(theme) => set({ theme })} options={[
              { value: 'system', label: 'System', icon: 'laptop' },
              { value: 'light', label: 'Light', icon: 'sun' },
              { value: 'dark', label: 'Dark', icon: 'moon' },
            ]} />
          </div>
        </section>

        {state.platform !== 'android' && <section>
          <h3>Start-up and windows</h3>
          <div className="setting">
            <Icon name="power" className="lead" />
            <div className="txt"><div>Start when I sign in to Windows</div><div className="faint">Opens quietly in the notification area.</div></div>
            <Toggle label="Start when I sign in" checked={state.settings.startAtLogin} onChange={(v) => set({ startAtLogin: v })} />
          </div>
          <div className="setting">
            <Icon name="tray" className="lead" />
            <div className="txt"><div>Keep running when the window is closed</div><div className="faint">So you keep receiving messages and calls. Quit from the tray icon.</div></div>
            <Toggle label="Keep running in the tray" checked={state.settings.closeToTray} onChange={(v) => set({ closeToTray: v })} />
          </div>
        </section>}

        <section>
          <h3>Office hub</h3>
          <div className="setting">
            <Icon name="server" className="lead" />
            <div className="txt">
              <div>{session.hub.name} <span className="faint">· version {session.hub.version}</span></div>
              <div className="faint mono selectable">{state.hub?.host}:{state.hub?.port}</div>
            </div>
            <span className={`chip ${live ? 'ok' : 'warn'}`}>{live ? 'Connected' : 'Reconnecting'}</span>
          </div>
          <div className="setting">
            <Icon name="lock" className="lead" />
            <div className="txt">
              <div>Hub certificate fingerprint</div>
              <div className="faint mono selectable" style={{ wordBreak: 'break-all' }}>{state.hub?.fingerprint}</div>
            </div>
          </div>
          <div className="setting">
            <Icon name="laptop" className="lead" />
            <div className="txt"><div>{state.platform === 'android' ? 'This phone' : 'This PC'}</div><div className="faint">{state.platform === 'android' ? '' : `${state.account.domain}\\${state.account.username} · `}{state.account.hostname} · device code <span className="mono">{deviceCode(state.deviceId)}</span></div></div>
            <button className="btn" onClick={() => { if (confirm('Disconnect from this hub? You can join it or another hub again from the welcome screen.')) void window.dex.forgetHub(); }}>Disconnect</button>
          </div>
        </section>

        <section>
          <h3>Updates</h3>
          <UpdateSettings state={state} />
          <div className="setting">
            <Icon name="list" className="lead" />
            <div className="txt"><div>Update channel</div><div className="faint">Beta gets new features first, from builds still being tested.</div></div>
            <Segmented<UpdateChannel> label="Update channel" value={state.settings.updateChannel} onChange={(updateChannel) => set({ updateChannel })} options={[
              { value: 'stable', label: 'Stable' },
              { value: 'beta', label: 'Beta' },
            ]} />
          </div>
          <div className="setting">
            <Icon name="tray" className="lead" />
            <div className="txt"><div>Download updates automatically</div><div className="faint">In the background; nothing installs until you restart or quit.</div></div>
            <Toggle label="Download updates automatically" checked={state.settings.autoDownloadUpdates} onChange={(v) => set({ autoDownloadUpdates: v })} />
          </div>
        </section>

        <section>
          <h3>About</h3>
          <div className="setting">
            <Icon name="info" className="lead" />
            <div className="txt"><div>Dexterity Connect {state.version}</div><div className="faint">Dexterity Design Services Pvt. Ltd. · works entirely on the office network</div></div>
          </div>
        </section>
      </div>
    </div>
  );
}
