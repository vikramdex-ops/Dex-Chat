// Phone Preferences ▸ Notifications check. Without Google push, notifications depend on the app
// staying connected in the background, which Android and some phone makers stop to save battery.
// This screen shows each requirement's state and opens the settings page that changes it, with
// precise steps for the makers known to stop background apps.
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { AppState, NotifyHealth, SettingsPage } from '../../shared/bridge.ts';
import { Dialog, Icon, Toggle, useToast } from '../ui.tsx';

/** Steps for the extra switches each maker adds (apps cannot read them, so people confirm them). */
const MAKER_STEPS: Record<string, { name: string; steps: string[] }> = {
  xiaomi: { name: 'Xiaomi, Redmi and POCO (MIUI, HyperOS)', steps: [
    'Settings › Apps › Manage apps › Dexterity Connect › Autostart: on.',
    'In the same page, Battery saver: No restrictions.',
    'Open Recents, press and hold Dexterity Connect and tap the lock, so clearing Recents leaves it running.',
  ] },
  vivo: { name: 'Vivo and iQOO (Funtouch OS, OriginOS)', steps: [
    'Settings › Battery › Background power consumption management › Dexterity Connect › Allow high background power usage.',
    'i Manager › App manager › Autostart manager (or Settings › Apps › Autostart) › Dexterity Connect: on.',
    'Open Recents, pull the Dexterity Connect card down to lock it.',
  ] },
  oppo: { name: 'Oppo and Realme (ColorOS, realme UI)', steps: [
    'Settings › Apps › App management › Dexterity Connect › Battery usage: Allow background activity, Allow auto launch.',
    'Settings › Battery › More settings › Optimise battery use: Dexterity Connect › Don’t optimise.',
    'Open Recents, tap the menu on the Dexterity Connect card and choose Lock.',
  ] },
  oneplus: { name: 'OnePlus (OxygenOS)', steps: [
    'Settings › Apps › Dexterity Connect › Battery: Allow background activity (Unrestricted on older versions).',
    'Settings › Apps › Auto-launch (or Special app access › Auto-launch): Dexterity Connect on.',
    'Open Recents, tap the menu on the Dexterity Connect card and choose Lock.',
  ] },
  samsung: { name: 'Samsung (One UI)', steps: [
    'Settings › Apps › Dexterity Connect › Battery: Unrestricted.',
    'Settings › Battery › Background usage limits › Never sleeping apps › + › Dexterity Connect.',
    'If it is listed under Sleeping apps or Deep sleeping apps on the same page, remove it there.',
  ] },
  huawei: { name: 'Huawei and Honor (EMUI, MagicOS)', steps: [
    'Settings › Battery › App launch › Dexterity Connect: switch off Manage automatically, then switch on Auto-launch, Secondary launch and Run in background.',
    'Open Recents, pull the Dexterity Connect card down to lock it.',
  ] },
};

const DONE_KEY = 'dex-autostart-confirmed';
const ASKED_KEY = 'dex-battery-explained';
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private storage off */ } },
};

function useHealth(): [NotifyHealth | null, () => void] {
  const [h, setH] = useState<NotifyHealth | null>(null);
  const load = useCallback(() => { void window.dex.phone?.notifyHealth().then(setH).catch(() => setH(null)); }, []);
  useEffect(() => {
    load();
    // coming back from a settings page
    const onShow = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', onShow);
    window.addEventListener('focus', load);
    return () => { document.removeEventListener('visibilitychange', onShow); window.removeEventListener('focus', load); };
  }, [load]);
  return [h, load];
}

/** Why the app asks for the battery exemption, shown before Android's own question. */
export function BatterySheet({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const go = async () => {
    store.set(ASKED_KEY, '1');
    try { await window.dex.phone!.requestBatteryExemption(); } catch (e) { toast((e as Error).message, true); }
    onClose();
  };
  return (
    <Dialog title="Let Dexterity Connect run in the background" onClose={() => { store.set(ASKED_KEY, '1'); onClose(); }} narrow>
      <p className="muted" style={{ margin: 0 }}>Messages reach your phone over the office’s own connection, not through Google. To keep that connection open while the phone is in your pocket, Android has to let Dexterity Connect run in the background.</p>
      <p className="muted" style={{ margin: 0 }}>Android asks next. Choose <b>Allow</b>. The connection is idle most of the time, so the effect on battery is small. You can change it later in Preferences ▸ Notifications check.</p>
      <div className="row-actions" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', width: '100%' }}>
        <button className="btn ghost" onClick={() => { store.set(ASKED_KEY, '1'); onClose(); }}>Not now</button>
        <button className="btn primary" onClick={() => void go()}>Continue</button>
      </div>
    </Dialog>
  );
}

/** Once, on a phone that stays connected but is not exempt: explain, then ask. */
export function BatteryPrompt({ state }: { state: AppState }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (state.platform !== 'android' || state.phase !== 'ready' || !state.settings.closeToTray || !window.dex.phone || store.get(ASKED_KEY)) return;
    let alive = true;
    const t = setTimeout(() => void window.dex.phone!.notifyHealth().then((h) => { if (alive && !h.batteryExempt) setOpen(true); }).catch(() => {}), 4000);
    return () => { alive = false; clearTimeout(t); };
  }, [state.platform, state.phase, state.settings.closeToTray]);
  return open ? <BatterySheet onClose={() => setOpen(false)} /> : null;
}

/** The phone as one name ("Samsung SM-A515F"), so a sentence has one place for it. */
const phoneName = (h: { manufacturer: string; model: string }) => `${h.manufacturer} ${h.model}`;

function Row({ ok, unknown, title, detail, action }: { ok: boolean; unknown?: boolean; title: string; detail: string; action?: ReactNode }) {
  return (
    <div className={`check-row ${unknown ? 'unknown' : ok ? 'ok' : 'todo'}`}>
      <span className="check-state" role="img" aria-label={unknown ? 'Check by hand' : ok ? 'Done' : 'Needs attention'}><Icon name={unknown ? 'warning' : ok ? 'check' : 'x'} size={14} /></span>
      <div className="txt"><div>{title}</div><div className="faint">{detail}</div></div>
      {action}
    </div>
  );
}

export function NotificationsCheck({ state, onClose }: { state: AppState; onClose: () => void }) {
  const [h, reload] = useHealth();
  const [explain, setExplain] = useState(false);
  const [confirmed, setConfirmed] = useState(store.get(DONE_KEY) === '1');
  const toast = useToast();
  const open = async (page: SettingsPage) => {
    const r = await window.dex.phone!.openSettings(page).catch(() => null);
    if (!r) toast('This phone has no such settings page. Open Settings › Apps › Dexterity Connect.', true);
  };
  const maker = h ? MAKER_STEPS[h.maker] : undefined;
  const allOk = !!h && h.notifications && h.batteryExempt && !h.backgroundRestricted && state.settings.closeToTray && (!maker || confirmed);
  return (
    <Dialog title="Notifications check" onClose={onClose}>
      {!h ? <span className="spinner" /> : (
        <div className="notify-check">
          <p className="muted" style={{ margin: 0 }}>{allOk ? 'Everything is set for notifications to arrive while the phone is locked.' : 'Messages reach this phone through the office’s own connection. Each line below keeps it open; fix the ones marked.'}</p>
          <Row ok={h.notifications} title="Notifications allowed" detail={h.notifications ? 'Dexterity Connect may show notifications.' : 'Android is not showing Dexterity Connect’s notifications.'}
            action={!h.notifications && <button className="btn sm" onClick={() => void window.dex.phone!.askNotifications().then(() => setTimeout(() => { reload(); void window.dex.phone!.notifyHealth().then((x) => { if (!x.notifications) void open('notifications'); }); }, 600))}>Allow</button>} />
          <Row ok={state.settings.closeToTray} title="Stay connected in the background" detail={state.settings.closeToTray ? `On. ${h.serviceRunning ? 'The quiet “Connected to the office” notification keeps it running.' : 'It starts with the next connection to the office.'}` : 'Off: notifications arrive only while the app is open.'}
            action={<Toggle label="Stay connected in the background" checked={state.settings.closeToTray} onChange={(v) => void window.dex.setSettings({ closeToTray: v }).then(reload)} />} />
          <Row ok={h.batteryExempt} title="Battery optimisation off for Dexterity Connect" detail={h.batteryExempt ? 'Android lets it run in the background.' : 'Android may stop the connection when the phone sleeps.'}
            action={!h.batteryExempt && <button className="btn sm" onClick={() => setExplain(true)}>Allow</button>} />
          {h.backgroundRestricted && (
            <Row ok={false} title="Background use not restricted" detail="Background use is set to Restricted, which stops the app whatever else is set. In the app’s page, open Battery and choose Unrestricted." action={<button className="btn sm" onClick={() => void open('app')}>Open</button>} />
          )}
          {maker ? (
            <>
              <Row ok={confirmed} unknown={!confirmed} title={`Autostart and background on ${maker.name}`} detail="Your phone adds its own switches, which apps cannot read. Follow these steps, then tick below." action={<button className="btn sm" onClick={() => void open(h.autostartPage ? 'autostart' : 'app')}>Open</button>} />
              <ol className="maker-steps">{maker.steps.map((s) => <li key={s}>{s}</li>)}</ol>
              <label className="confirm-line"><input type="checkbox" checked={confirmed} onChange={(e) => { setConfirmed(e.target.checked); store.set(DONE_KEY, e.target.checked ? '1' : '0'); }} /> I have done these steps</label>
            </>
          ) : (
            <Row ok title="No extra switches on this phone" detail={`${phoneName(h)} uses Android’s own settings, checked above.`} />
          )}
          <div className="faint mono check-foot">
            {h.manufacturer} {h.model} · Android {h.androidVersion}
            {h.watching && (h.lastOk ? ` · reached the office in the background ${new Date(h.lastOk).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : h.lastError ? ` · background: ${h.lastError}` : '')}
          </div>
          <p className="faint" style={{ margin: 0, fontSize: 12 }}>Anything that arrives while the connection was stopped is shown as soon as the phone reconnects, so nothing is lost; at worst it is late.</p>
        </div>
      )}
      {explain && <BatterySheet onClose={() => { setExplain(false); reload(); }} />}
    </Dialog>
  );
}
