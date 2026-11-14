import { useRef, useState } from 'react';
import { EmojiPicker } from '../chat/EmojiPicker.tsx';
import { QUICK_DEFAULT, quickReactions, setQuickReactions } from '../chat/quick.ts';
import type { Session } from '@dex/core';
import type { AppState, MessageSound, Settings, Theme } from '../../shared/bridge.ts';
import { playSound } from '../sounds.ts';
import { RemoteSettings } from './Remote.tsx';
import { OfflineBanner } from '../App.tsx';
import { Avatar, Icon, Popover, Segmented, Toggle, deviceCode, useToast } from '../ui.tsx';
import { UpdateSettings } from '../UpdateUi.tsx';
import type { UpdateChannel } from '../../shared/bridge.ts';

export function SettingsView({ state, session }: { state: AppState; session: Session }) {
  const toast = useToast();
  const live = state.phase === 'ready';
  const [name, setName] = useState(session.me.displayName);
  const [title, setTitle] = useState(session.me.title ?? '');
  const [status, setStatus] = useState(session.me.statusText ?? '');
  const [statusEmoji, setStatusEmoji] = useState(session.me.statusEmoji ?? '');
  const [emojiOpen, setEmojiOpen] = useState(false);
  const emojiBtn = useRef<HTMLButtonElement>(null);
  const dirty = name.trim() !== session.me.displayName || title.trim() !== (session.me.title ?? '') || status.trim() !== (session.me.statusText ?? '') || statusEmoji !== (session.me.statusEmoji ?? '');

  const saveProfile = async () => {
    try {
      await window.dex.request('me.update', { displayName: name, title: title.trim() || null, statusText: status.trim() || null, statusEmoji: statusEmoji || null });
      toast('Profile saved');
    } catch (e) { toast((e as Error).message, true); }
  };
  const set = (patch: Partial<AppState['settings']>) => void window.dex.setSettings(patch);
  const [contact, setContact] = useState({ phone: session.me.profile.phone ?? '', extension: session.me.profile.extension ?? '', location: session.me.profile.location ?? '', birthday: session.me.profile.birthday ?? '' });
  const contactDirty = contact.phone !== (session.me.profile.phone ?? '') || contact.extension !== (session.me.profile.extension ?? '')
    || contact.location !== (session.me.profile.location ?? '') || contact.birthday !== (session.me.profile.birthday ?? '');
  const saveContact = async () => {
    try {
      await window.dex.request('me.profile', { phone: contact.phone || null, extension: contact.extension || null, location: contact.location || null, birthday: contact.birthday || null });
      toast('Contact details saved');
    } catch (e) { toast((e as Error).message, true); }
  };

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
              <div className="status-row">
                <button type="button" ref={emojiBtn} className="btn status-emoji" onClick={() => setEmojiOpen(!emojiOpen)} aria-label="Status emoji" disabled={!live}>{statusEmoji || '🙂'}</button>
                <input id="s-status" className="input" value={status} maxLength={120} placeholder="What are you working on?" onChange={(e) => setStatus(e.target.value)} disabled={!live} />
              </div>
              {emojiOpen && (
                <Popover anchor={emojiBtn.current} onClose={() => setEmojiOpen(false)} className="emoji-pop-wrap" align="start">
                  <EmojiPicker onPick={(e) => { setStatusEmoji(e.startsWith(':') ? '' : e); setEmojiOpen(false); }} onClose={() => setEmojiOpen(false)} />
                </Popover>
              )}
            </div>
            <div className="full row-actions" style={{ justifyContent: 'flex-end' }}>
              <button className="btn primary" disabled={!dirty || !live || !name.trim()}>Save profile</button>
            </div>
          </form>
        </section>

        <section>
          <h3>Contact details</h3>
          <form className="form-grid" onSubmit={(e) => { e.preventDefault(); if (contactDirty) void saveContact(); }}>
            <div className="field"><label htmlFor="s-ext">Extension</label>
              <input id="s-ext" className="input" value={contact.extension} maxLength={12} onChange={(e) => setContact({ ...contact, extension: e.target.value })} disabled={!live} /></div>
            <div className="field"><label htmlFor="s-phone">Phone</label>
              <input id="s-phone" className="input" value={contact.phone} maxLength={40} onChange={(e) => setContact({ ...contact, phone: e.target.value })} disabled={!live} /></div>
            <div className="field"><label htmlFor="s-seat">Seat or location</label>
              <input id="s-seat" className="input" value={contact.location} maxLength={80} placeholder="Bay 2, Desk 4" onChange={(e) => setContact({ ...contact, location: e.target.value })} disabled={!live} /></div>
            <div className="field"><label htmlFor="s-bday">Birthday (MM-DD)</label>
              <input id="s-bday" className="input" value={contact.birthday} maxLength={5} placeholder="06-30" onChange={(e) => setContact({ ...contact, birthday: e.target.value })} disabled={!live} /></div>
            <div className="full row-actions" style={{ justifyContent: 'space-between' }}>
              <span className="faint" style={{ fontSize: 12.5 }}>Your department, designation and manager are set by an administrator.</span>
              <button className="btn primary" disabled={!contactDirty || !live}>Save contact details</button>
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
          <div className="setting">
            <Icon name="rows" className="lead" />
            <div className="txt"><div>Density</div><div className="faint">Compact fits more messages and conversations on screen.</div></div>
            <Segmented<Settings['density']> label="Density" value={state.settings.density} onChange={(density) => set({ density })} options={[
              { value: 'comfortable', label: 'Comfortable' },
              { value: 'compact', label: 'Compact' },
            ]} />
          </div>
          <div className="setting">
            <Icon name="textsize" className="lead" />
            <div className="txt"><div>Text size</div><div className="faint">Makes everything larger or smaller. <span className="mono">Ctrl</span>+<span className="mono">=</span> and <span className="mono">Ctrl</span>+<span className="mono">-</span> work too.</div></div>
            <Segmented<Settings['textSize']> label="Text size" value={state.settings.textSize} onChange={(textSize) => set({ textSize })} options={[
              { value: 90, label: 'Small' },
              { value: 100, label: 'Default' },
              { value: 110, label: 'Large' },
              { value: 125, label: 'Larger' },
            ]} />
          </div>
        </section>

        <section>
          <h3>Privacy</h3>
          <div className="setting">
            <Icon name="check" className="lead" />
            <div className="txt"><div>Read receipts</div><div className="faint">Colleagues see when you have read their messages. Turn off and you will not see theirs either.</div></div>
            <Toggle label="Read receipts" checked={session.me.readReceipts !== false} onChange={(v) => void window.dex.request('me.update', { readReceipts: v }).catch((e: Error) => toast(e.message, true))} />
          </div>
        </section>

        <section>
          <h3>Quick reactions</h3>
          <QuickReactions />
        </section>

        <section>
          <h3>Notifications</h3>
          <div className="setting">
            <Icon name="bell" className="lead" />
            <div className="txt"><div>Notify me about</div><div className="faint">Reminders and meetings always notify.</div></div>
            <Segmented<Settings['notifyFor']> label="Notify me about" value={state.settings.notifyFor} onChange={(notifyFor) => set({ notifyFor })} options={[
              { value: 'all', label: 'Everything' },
              { value: 'mentions', label: 'Direct and mentions' },
              { value: 'none', label: 'Nothing' },
            ]} />
          </div>
          <div className="setting">
            <Icon name="volume" className="lead" />
            <div className="txt"><div>Sound</div><div className="faint">Plays with each notification.</div></div>
            <Segmented<MessageSound> label="Sound" value={state.settings.sound} onChange={(sound) => { set({ sound }); playSound(sound, 0.6, true); }} options={[
              { value: 'chime', label: 'Chime' },
              { value: 'tick', label: 'Tick' },
              { value: 'drop', label: 'Drop' },
              { value: 'none', label: 'Off' },
            ]} />
          </div>
          <div className="setting">
            <Icon name="eye" className="lead" />
            <div className="txt"><div>Show message text in notifications</div><div className="faint">Turn off if others can see your screen.</div></div>
            <Toggle label="Show message text in notifications" checked={state.settings.showPreviews} onChange={(v) => set({ showPreviews: v })} />
          </div>
        </section>

        {state.platform === 'android' && <section>
          <h3>Background</h3>
          <div className="setting">
            <Icon name="tray" className="lead" />
            <div className="txt"><div>Stay connected in the background</div><div className="faint">So messages, reminders and calls reach you when the app is closed. Android shows a quiet notification while this is on.</div></div>
            <Toggle label="Stay connected in the background" checked={state.settings.closeToTray} onChange={(v) => set({ closeToTray: v })} />
          </div>
        </section>}

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

        <RemoteSettings state={state} />

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

/** The three reactions on the message hover bar. */
function QuickReactions() {
  const [list, setList] = useState(quickReactions());
  const [editing, setEditing] = useState<number | null>(null);
  const refs = [useRef<HTMLButtonElement>(null), useRef<HTMLButtonElement>(null), useRef<HTMLButtonElement>(null)];
  return (
    <div className="setting">
      <Icon name="smile" className="lead" />
      <div className="txt"><div>On the message bar</div><div className="faint">One click to react. Choose your own three.</div></div>
      <div className="quick-pick">
        {list.map((e, i) => <button key={i} ref={refs[i]} className="btn" aria-label={`Quick reaction ${i + 1}: ${e}`} onClick={() => setEditing(i)}>{e}</button>)}
        <button className="link" onClick={() => { setQuickReactions(QUICK_DEFAULT); setList(QUICK_DEFAULT); }}>Reset</button>
      </div>
      {editing !== null && (
        <Popover anchor={refs[editing].current} onClose={() => setEditing(null)} className="emoji-pop-wrap">
          <EmojiPicker onClose={() => setEditing(null)} onPick={(e) => { if (e.startsWith(':')) return; const next = list.map((x, j) => (j === editing ? e : x)); setQuickReactions(next); setList(next); setEditing(null); }} />
        </Popover>
      )}
    </div>
  );
}
