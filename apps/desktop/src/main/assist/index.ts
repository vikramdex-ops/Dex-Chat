// The help desk's and live pointers' main-process side: consent as this PC enforces it, remote
// control (Windows helper, xdotool on Linux, none on macOS), the stop hotkey, diagnostics, a
// screenshot for a Help Me request, and the overlay windows. Only the main window may grant or
// feed control; the share bar may only take things back.
import path from 'node:path';
import os from 'node:os';
import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen } from 'electron';
import type { Display } from 'electron';
import { STOP_HOTKEY } from '@dex/core/assist';
import type { Rect } from '@dex/core/assist';
import type { AssistCaps, ShareBarState, UpdateChannel } from '../../shared/bridge.ts';
import { appLog } from '../applog.ts';
import { RemoteControl, windowsSink, xdotoolSink } from './control.ts';
import type { InputSink } from './control.ts';
import { WindowsHelper } from './windows.ts';
import { Xdotool, xdotoolAvailable } from './linux.ts';
import { collectDiagnostics } from './diagnostics.ts';
import { Overlays } from './overlay.ts';

export interface AssistDeps {
  win: () => BrowserWindow | null;
  load: (w: BrowserWindow, hash: string) => void;
  preload: string;
  version: string;
  channel: () => UpdateChannel;
  /** The hub connection: where it is, how it is reached, a round trip, and the call servers. */
  hub: () => { address: string | null; route: 'office network' | 'internet gateway' | 'not connected'; gateway: string | null };
  ping: () => Promise<void>;
  iceUrls: () => Promise<string[]>;
}

const HOTKEY = 'CommandOrControl+Alt+Shift+S';

function caps(): AssistCaps {
  if (process.platform === 'win32') return { control: true, reason: null, platform: process.platform };
  if (process.platform === 'linux') { const x = xdotoolAvailable(); return { control: x.ok, reason: x.reason, platform: process.platform }; }
  if (process.platform === 'darwin') return { control: false, reason: 'On a Mac, remote control needs Accessibility permission, which this app does not ask for. IT can see your screen and guide you instead.', platform: process.platform };
  return { control: false, reason: 'Remote control is not available on this system.', platform: process.platform };
}

/** Transparent click-through windows need a compositor: Windows and macOS always, Linux desktops that composite. */
function pointerOverlaySupported(): boolean {
  if (process.platform !== 'linux') return process.platform === 'win32' || process.platform === 'darwin';
  if (process.env.DEXCONNECT_POINTER_OVERLAY === '1') return true;
  return process.env.XDG_SESSION_TYPE === 'wayland' || /gnome|kde|unity|cinnamon|pantheon|budgie|ubuntu|deepin/i.test(process.env.XDG_CURRENT_DESKTOP ?? '');
}

/** The display a desktopCapturer source shows (the primary one when it cannot tell). */
async function displayOf(sourceId: string | null | undefined): Promise<Display> {
  const all = screen.getAllDisplays();
  if (sourceId?.startsWith('screen:')) {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
      const s = sources.find((x) => x.id === sourceId);
      const d = s?.display_id ? all.find((x) => String(x.id) === s.display_id) : undefined;
      if (d) return d;
      // no display id (some Linux setups): the source's index
      const idx = Number(sourceId.split(':')[1]);
      if (Number.isInteger(idx) && all[idx]) return all[idx];
    } catch { /* fall back to the primary display */ }
  }
  return screen.getPrimaryDisplay();
}

/** The display in the injector's pixels: physical pixels on the Windows virtual screen, X pixels on Linux. */
function injectorRect(d: Display): Rect {
  if (process.platform === 'win32') { const r = screen.dipToScreenRect(null, d.bounds); return { x: r.x, y: r.y, width: r.width, height: r.height }; }
  const s = d.scaleFactor || 1;
  return { x: Math.round(d.bounds.x * s), y: Math.round(d.bounds.y * s), width: Math.round(d.bounds.width * s), height: Math.round(d.bounds.height * s) };
}

export function wireAssist(deps: AssistDeps): { stopAll(why: string): void; overlays: Overlays } {
  const overlays = new Overlays(deps.load, deps.preload);
  const log = (level: 'info' | 'warn', msg: string, extra?: Record<string, unknown>) => appLog.write(level, 'assist', msg, extra);
  let sink: InputSink | null = null;
  if (process.platform === 'win32') {
    const h = new WindowsHelper();
    h.onError = (m) => log('warn', 'input helper', { error: m });
    sink = windowsSink(h);
  } else if (process.platform === 'linux') {
    const x = new Xdotool();
    x.onError = (m) => log('warn', 'xdotool', { error: m });
    sink = xdotoolSink(x);
  }
  const control = sink ? new RemoteControl(sink, log) : null;
  let share: { display: Display | null; state: ShareBarState } | null = null;
  let hotkey = false;

  const tellMain = (what: 'control' | 'screen' | 'session') => deps.win()?.webContents.send('assist:stop', what);
  const fromMain = (e: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => { const w = deps.win(); return !!w && e.sender.id === w.webContents.id; };

  const setHotkey = (on: boolean) => {
    if (on && !hotkey) {
      try { hotkey = globalShortcut.register(HOTKEY, () => { stopControl('the stop keys'); tellMain('control'); }); } catch { hotkey = false; }
      if (!hotkey) log('warn', 'the stop keys are taken by another program; the share bar still stops control');
    } else if (!on && hotkey) { globalShortcut.unregister(HOTKEY); hotkey = false; }
  };

  const stopControl = (why: string) => {
    control?.revoke(why);
    setHotkey(false);
    if (share) { share.state = { ...share.state, control: false }; overlays.updateBar(share.state); }
  };

  const stopAll = (why: string) => {
    stopControl(why);
    control?.setDisplay(null);
    if (share) log('info', 'screen sharing for IT stopped', { why });
    share = null;
    overlays.hideShare();
  };

  ipcMain.handle('assist:caps', () => caps());

  ipcMain.handle('assist:consent', async (e, raw: { screen?: unknown; sourceId?: unknown; scope?: unknown; control?: unknown; tech?: unknown }) => {
    if (!fromMain(e)) return { screen: false, control: false, error: 'Not allowed from this window.' };
    const wantScreen = raw?.screen === true;
    const wantControl = raw?.control === true;
    const tech = typeof raw?.tech === 'string' ? raw.tech.slice(0, 80) : 'IT';
    const scope = raw?.scope === 'window' ? 'window' : 'screen';
    if (!wantScreen) { stopAll('the requester stopped sharing'); return { screen: false, control: false, error: null }; }
    const sourceId = typeof raw?.sourceId === 'string' ? raw.sourceId : null;
    const display = scope === 'screen' ? await displayOf(sourceId) : null;
    const state: ShareBarState = { tech, scope, control: false, hotkey: STOP_HOTKEY };
    if (!share || share.display?.id !== display?.id || share.state.scope !== scope) {
      share = { display, state };
      overlays.showShare(display, state);
      log('info', 'screen shared with IT', { scope, display: display ? `${display.bounds.width}x${display.bounds.height}` : 'one window' });
    }
    control?.setDisplay(display ? injectorRect(display) : null);
    if (!wantControl) { stopControl('the requester took control back'); return { screen: true, control: false, error: null }; }
    const c = caps();
    if (!c.control || !control) return { screen: true, control: false, error: c.reason ?? 'Remote control is not available on this PC.' };
    if (scope !== 'screen') return { screen: true, control: false, error: 'Share your whole screen to let IT use the mouse and keyboard.' };
    try {
      if (!control.active) await control.grant();
    } catch (err) {
      log('warn', 'remote control could not start', { error: (err as Error).message });
      return { screen: true, control: false, error: `Remote control could not start on this PC: ${(err as Error).message}` };
    }
    setHotkey(true);
    share.state = { ...share.state, control: true };
    overlays.updateBar(share.state);
    return { screen: true, control: true, error: null };
  });

  ipcMain.on('assist:input', (e, msg: unknown) => { if (fromMain(e)) control?.input(msg); });

  ipcMain.on('overlay:ready', (e) => overlays.resend(e.sender.id));
  ipcMain.on('overlay:action', (e, a: unknown) => {
    if (!overlays.isBar(e.sender.id)) return;
    if (a === 'stop-control') { stopControl('the share bar'); tellMain('control'); }
    else if (a === 'stop-screen') { stopAll('the share bar'); tellMain('screen'); }
    else if (a === 'end') { stopAll('the share bar'); tellMain('session'); }
  });

  ipcMain.handle('assist:diagnostics', async (e, rendererErrors: unknown) => {
    if (!fromMain(e)) throw new Error('Not allowed from this window.');
    const errs = Array.isArray(rendererErrors) ? rendererErrors.slice(-50).filter((x): x is { at: number; message: string; source?: string } => !!x && typeof (x as { message?: unknown }).message === 'string').map((x) => ({ at: Number(x.at) || Date.now(), message: x.message, ...(typeof x.source === 'string' ? { source: x.source } : {}) })) : [];
    const h = deps.hub();
    return collectDiagnostics({
      app: { version: deps.version, channel: deps.channel(), platform: process.platform, arch: process.arch, electron: process.versions.electron ?? '', chrome: process.versions.chrome ?? '', packaged: app.isPackaged, locale: app.getLocale() },
      displays: screen.getAllDisplays().map((d) => ({ id: String(d.id), primary: d.id === screen.getPrimaryDisplay().id, x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height, scale: d.scaleFactor, rotation: d.rotation, internal: !!d.internal })),
      dataDir: app.getPath('userData'),
      route: h.route, hubAddress: h.address, gateway: h.gateway,
      ping: deps.ping, iceUrls: deps.iceUrls,
      log: appLog.recent(200),
      rendererErrors: errs,
    });
  });

  ipcMain.handle('assist:screenshot', async (e) => {
    if (!fromMain(e)) return null;
    const w = deps.win();
    const display = w ? screen.getDisplayMatching(w.getBounds()) : screen.getPrimaryDisplay();
    // step aside so the picture shows what is behind the app
    const wasVisible = !!w?.isVisible() && !w.isMinimized();
    if (wasVisible) { w!.hide(); await new Promise((r) => setTimeout(r, 350)); }
    try {
      const size = { width: Math.round(display.bounds.width * display.scaleFactor), height: Math.round(display.bounds.height * display.scaleFactor) };
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
      const src = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
      if (!src || src.thumbnail.isEmpty()) return null;
      const png = src.thumbnail.toPNG();
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '');
      return { data: png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength), name: `Screen ${stamp}.png` };
    } finally {
      if (wasVisible) { w!.showInactive(); w!.focus(); }
    }
  });

  ipcMain.on('assist:pointers', (e, s: { on?: unknown; sourceId?: unknown }) => {
    if (!fromMain(e)) return;
    if (s?.on !== true || !pointerOverlaySupported()) { overlays.hidePointers(); return; }
    void displayOf(typeof s.sourceId === 'string' ? s.sourceId : null).then((d) => overlays.showPointers(d));
  });
  ipcMain.on('assist:pointer', (e, msg: unknown) => { if (fromMain(e)) overlays.pointer(msg); });

  app.on('before-quit', () => { stopAll('the app closed'); overlays.closeAll(); });
  app.on('will-quit', () => { if (hotkey) globalShortcut.unregister(HOTKEY); });
  appLog.info('main', 'help desk ready', { control: caps().control, os: `${os.type()} ${os.release()}`, data: path.basename(app.getPath('userData')) });
  return { stopAll, overlays };
}
