// Dexterity Connect — Electron main process.
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { app, BrowserWindow, desktopCapturer, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerMonitor, session, shell, Tray } from 'electron';
import type { OpName } from '@dex/core';
import type { JoinRequest, Settings } from '../shared/bridge.ts';
import { detectAccount } from './account.ts';
import { Controller } from './controller.ts';
import { loadConfig, loadEncKeys, loadIdentity, saveConfig } from './persist.ts';
import { Updater } from './updater.ts';
import { cachedFile, handleFileScheme, openFile, pruneCache, registerFileScheme, saveFile, uploadFile } from './files.ts';
import { editInSlate, slateExe, stopWatching } from './slate.ts';
import { PeerNet } from './peer.ts';
import { installedTools, openToolLink } from './tools.ts';
import { signWith } from '@dex/core';
import type { HubAccess, UploadSource } from './files.ts';

const APP_ID = 'in.co.dexteritydesign.connect';
const PROTOCOL = 'dexconnect';
const isWin = process.platform === 'win32';
const devUrl = process.env.VITE_DEV_SERVER_URL;

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let controller: Controller | null = null;
let updater: Updater | null = null;
let quitting = false;
let pendingDeepLink: string | null = process.argv.find((a) => a.startsWith(`${PROTOCOL}://`)) ?? null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const link = argv.find((a) => a.startsWith(`${PROTOCOL}://`));
    showWindow();
    if (link) routeDeepLink(link);
  });
}

app.setAppUserModelId(APP_ID);
registerFileScheme();
if (process.defaultApp && process.argv[1]) {
  app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

const resource = (name: string) => app.isPackaged
  ? path.join(process.resourcesPath, name)
  : path.join(__dirname, '..', 'build', name);
const iconPath = () => resource('icon.png');

function applyTheme(settings: Settings): void {
  nativeTheme.themeSource = settings.theme;
  if (win && isWin) {
    win.setTitleBarOverlay({ color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? '#e8f2f3' : '#15191b', height: 44 });
  }
}

function applyLogin(settings: Settings): void {
  if (!app.isPackaged) return; // never register a development build to start at sign-in
  app.setLoginItemSettings({ openAtLogin: settings.startAtLogin, args: ['--hidden'] });
}

function createWindow(startHidden: boolean): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    show: false,
    title: 'Dexterity Connect',
    icon: iconPath(),
    backgroundColor: isWin ? '#00000000' : (nativeTheme.shouldUseDarkColors ? '#132b2e' : '#f4f9f9'),
    ...(isWin ? {
      backgroundMaterial: 'mica' as const,
      titleBarStyle: 'hidden' as const,
      titleBarOverlay: { color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? '#e8f2f3' : '#15191b', height: 44 },
    } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  win.setMenuBarVisibility(false);

  win.once('ready-to-show', () => { if (!startHidden) win?.show(); });
  win.on('focus', () => win?.flashFrame(false));
  win.on('close', (e) => {
    if (!quitting && controller?.settings.closeToTray) {
      e.preventDefault();
      win?.hide();
    }
  });
  // external links open in the browser; the app itself never navigates away
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!devUrl || !url.startsWith(devUrl)) e.preventDefault();
  });

  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(path.join(__dirname, '..', 'dist-renderer', 'index.html'));

  win.webContents.on('did-finish-load', () => {
    if (pendingDeepLink) { routeDeepLink(pendingDeepLink); pendingDeepLink = null; }
  });
}

function showWindow(): void {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function routeDeepLink(url: string): void {
  if (!win || win.webContents.isLoading()) { pendingDeepLink = url; return; }
  win.webContents.send('app:deeplink', url);
}

const shownNotifications = new Set<Notification>();
function notify(title: string, body: string, link?: string): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: iconPath(), silent: false });
  shownNotifications.add(n); // keep a reference so the click handler survives garbage collection
  n.on('click', () => { showWindow(); if (link) routeDeepLink(link); });
  n.on('close', () => shownNotifications.delete(n));
  n.show();
}

/** Taskbar overlay (Windows) / dock badge (macOS) for things that need you. */
let badgeImage: Electron.NativeImage | null = null;
function setBadge(count: number): void {
  const n = Math.max(0, Math.floor(count));
  if (process.platform === 'darwin') { app.dock?.setBadge(n ? String(n > 99 ? '99+' : n) : ''); return; }
  app.setBadgeCount(n);
  if (win && isWin) {
    badgeImage ??= nativeImage.createFromPath(resource('badge.png'));
    win.setOverlayIcon(n ? badgeImage : null, n ? `${n} need you` : '');
    if (n && !win.isFocused()) win.flashFrame(true);
  }
  tray?.setToolTip(n ? `Dexterity Connect — ${n} need you` : 'Dexterity Connect');
}

function buildTray(): void {
  const image = nativeImage.createFromPath(resource('tray.png')).resize({ width: 16, height: 16, quality: 'best' });
  tray = new Tray(image);
  tray.setToolTip('Dexterity Connect');
  const refresh = () => {
    const s = controller?.state();
    const status = !s ? 'Starting…'
      : s.phase === 'ready' ? `Connected to ${s.session?.hub.name ?? 'the hub'}`
      : s.phase === 'pending' ? 'Waiting for approval'
      : s.phase === 'offline' ? 'Hub unreachable — retrying'
      : s.phase === 'welcome' ? 'Not set up yet'
      : 'Connecting…';
    tray?.setToolTip(`Dexterity Connect — ${status}`);
    tray?.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Dexterity Connect', click: showWindow },
      { label: status, enabled: false },
      { type: 'separator' },
      {
        label: 'Start when I sign in to Windows', type: 'checkbox', checked: controller?.settings.startAtLogin ?? true,
        click: (item) => { const s2 = controller?.updateSettings({ startAtLogin: item.checked }); if (s2) applyLogin(s2); },
      },
      { type: 'separator' },
      updater?.state.phase === 'ready'
        ? { label: `Restart to update to ${updater.state.available?.version ?? 'the new version'}`, click: () => { updater?.install(true); } }
        : { label: 'Check for updates', enabled: updater?.state.phase !== 'disabled', click: () => { void updater?.check(true); showWindow(); } },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ]));
  };
  refresh();
  controller?.on('state', refresh);
  updater?.on('state', refresh);
  tray.on('click', showWindow);
}

function wireIpc(c: Controller): void {
  ipcMain.handle('app:getState', () => c.state());
  ipcMain.handle('app:join', (_e, req: JoinRequest) => c.join(req));
  ipcMain.handle('app:forgetHub', () => c.forgetHub());
  ipcMain.handle('app:rescan', () => c.rescan());
  ipcMain.handle('app:setSettings', (_e, patch: Partial<Settings>) => {
    const safe: Partial<Settings> = {};
    if (patch.theme === 'system' || patch.theme === 'light' || patch.theme === 'dark') safe.theme = patch.theme;
    if (typeof patch.startAtLogin === 'boolean') safe.startAtLogin = patch.startAtLogin;
    if (typeof patch.closeToTray === 'boolean') safe.closeToTray = patch.closeToTray;
    if (patch.updateChannel === 'stable' || patch.updateChannel === 'beta') safe.updateChannel = patch.updateChannel;
    if (typeof patch.autoDownloadUpdates === 'boolean') safe.autoDownloadUpdates = patch.autoDownloadUpdates;
    const channelChanged = safe.updateChannel && safe.updateChannel !== c.settings.updateChannel;
    const s = c.updateSettings(safe);
    applyTheme(s);
    applyLogin(s);
    if (channelChanged) void updater?.check(false);
    return s;
  });
  ipcMain.handle('hub:request', async (_e, op: OpName, data: unknown) => {
    try {
      return { ok: true, data: await c.request(op, data as never) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
  const access = (): HubAccess => {
    const hub = c.hubEndpoint();
    const token = c.state().session?.fileToken;
    if (!hub || !token) throw new Error('Not connected to the office hub.');
    return { ...hub, token };
  };
  const wrap = async <T>(fn: () => Promise<T>) => {
    try { return { ok: true, data: await fn() }; } catch (err) { return { ok: false, error: (err as Error).message }; }
  };
  ipcMain.handle('file:upload', (e, uploadId: string, src: UploadSource) => wrap(() => uploadFile(access(), {
    path: typeof src?.path === 'string' ? src.path : undefined,
    data: src?.data instanceof ArrayBuffer ? src.data : undefined,
    name: String(src?.name ?? 'file').slice(0, 200),
    mime: typeof src?.mime === 'string' ? src.mime : undefined,
  }, (sent, total) => e.sender.send('file:progress', uploadId, sent, total))));
  ipcMain.handle('file:open', (_e, id: string, name: string) => wrap(() => openFile(access(), String(id), String(name))));
  ipcMain.handle('file:save', (_e, id: string, name: string) => wrap(() => saveFile(access(), String(id), String(name))));
  ipcMain.handle('e2e:status', (_e, convId: string) => wrap(() => controller!.e2e.status(String(convId))));
  ipcMain.handle('tools:installed', () => installedTools());
  ipcMain.handle('tools:open', (_e, url: string) => wrap(async () => {
    if (String(url).startsWith('dexconnect://')) { routeDeepLink(String(url)); return; }
    await openToolLink(String(url));
  }));
  ipcMain.handle('file:stat', (_e, p: string) => wrap(async () => {
    const full = path.resolve(String(p));
    const st = await fs.promises.stat(full);
    return { name: path.basename(full), size: st.size, isFile: st.isFile() };
  }));
  ipcMain.on('slate:available', (e) => { e.returnValue = !!slateExe(); });
  ipcMain.handle('slate:edit', (_e, noteId: string, title: string, body: string) => wrap(() => editInSlate(String(noteId), String(title), String(body), (id, text) => win?.webContents.send('slate:changed', id, text))));
  ipcMain.handle('slate:open', (_e, id: string, name: string) => wrap(async () => {
    const exe = slateExe();
    if (!exe) throw new Error('Slate is not installed on this PC.');
    const p = await cachedFile(access(), String(id), String(name));
    spawn(exe, [p], { detached: true, stdio: 'ignore' }).unref();
  }));
  // screen sharing: the UI shows its own picker, then getDisplayMedia() gets the chosen source
  let chosenScreen: string | null = null;
  ipcMain.handle('screen:list', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: false });
    return sources.filter((s) => !/Dexterity Connect/.test(s.name)).map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
  });
  ipcMain.handle('screen:choose', (_e, id: string) => { chosenScreen = typeof id === 'string' ? id : null; });
  session.defaultSession.setDisplayMediaRequestHandler((_req, callback) => {
    void desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
      const pick = sources.find((s) => s.id === chosenScreen) ?? sources.find((s) => s.id.startsWith('screen:'));
      chosenScreen = null;
      if (pick) callback({ video: pick }); else callback({});
    });
  });
  // reports exported from the app (timesheets, attendance): ask where, starting in Downloads
  session.defaultSession.on('will-download', (_e, item) => {
    item.setSaveDialogOptions({ title: 'Save', defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
  });
  // camera, microphone and screen capture are allowed for the app itself only
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    const own = wc.getURL().startsWith('file://') || (!!devUrl && wc.getURL().startsWith(devUrl));
    cb(own && ['media', 'display-capture', 'notifications', 'clipboard-sanitized-write'].includes(permission));
  });
  ipcMain.handle('update:check', () => updater?.check(true));
  ipcMain.handle('update:download', () => updater?.download());
  ipcMain.handle('update:install', () => { updater?.install(true); });
  ipcMain.handle('update:dismissWhatsNew', () => updater?.dismissWhatsNew());
  ipcMain.on('app:notify', (_e, title: unknown, body: unknown, link: unknown) => {
    if (typeof title === 'string' && typeof body === 'string') {
      notify(title.slice(0, 120), body.slice(0, 400), typeof link === 'string' && link.startsWith(`${PROTOCOL}://`) ? link : undefined);
    }
  });
  ipcMain.on('app:badge', (_e, count: unknown) => { if (typeof count === 'number') setBadge(count); });

  c.on('state', (s) => win?.webContents.send('app:state', s));
  c.on('hub-event', (name: string, data: unknown) => {
    win?.webContents.send('hub:event', name, data);
    if (name === 'admin.pending' && !win?.isFocused()) {
      const d = data as { displayName: string; hostname: string };
      notify('New device waiting for approval', `${d.displayName} wants to join from ${d.hostname}.`);
    }
  });
}

app.on('before-quit', () => {
  stopWatching();
  quitting = true;
  updater?.installOnQuit();
  updater?.stop();
  controller?.stop();
});
app.on('window-all-closed', () => { /* stay in the tray */ });
app.on('open-url', (e, url) => { e.preventDefault(); showWindow(); routeDeepLink(url); });

void app.whenReady().then(async () => {
  const config = loadConfig();
  const identity = loadIdentity();
  const account = await detectAccount();
  // Development only: simulate several colleagues on one machine ("username|Display Name").
  const devAccount = !app.isPackaged ? process.env.DEXCONNECT_DEV_ACCOUNT : undefined;
  if (devAccount) {
    const [username, displayName] = devAccount.split('|');
    Object.assign(account, { username, displayName: displayName || username, hostname: `${username.toUpperCase()}-PC` });
  }
  // "What's new" after relaunching into a newer version
  const version = app.getVersion();
  const justUpdated = config.lastRunVersion && config.lastRunVersion !== version && config.pendingNotes?.version === version
    ? config.pendingNotes : null;
  if (config.lastRunVersion !== version || config.pendingNotes) {
    config.lastRunVersion = version;
    config.pendingNotes = null;
    saveConfig(config);
  }

  const devUpdates = !app.isPackaged && process.env.DEXCONNECT_UPDATER_DEV === '1';
  updater = new Updater({
    version,
    enabled: app.isPackaged || devUpdates,
    downloadDir: path.join(app.getPath('userData'), 'updates'),
    channel: () => config.settings.updateChannel,
    autoDownload: () => config.settings.autoDownloadUpdates,
    hub: () => controller?.hubEndpoint() ?? null,
    feedBase: devUpdates ? process.env.DEXCONNECT_FEED_BASE : undefined,
    platformOverride: devUpdates ? (process.env.DEXCONNECT_UPDATER_PLATFORM as never) || undefined : undefined,
    allowHttp: devUpdates,
    beforeInstall: (v, notes) => { config.pendingNotes = { version: v, notes }; saveConfig(config); },
    quit: () => { quitting = true; app.quit(); },
  }, justUpdated ?? null);

  controller = new Controller(account, identity, config, { platform: process.platform, version, update: () => updater!.state }, loadEncKeys());
  // hub-off fallback: Direct messages straight between PCs on the office network
  const peers = new PeerNet({ e2e: controller.e2e, deviceId: identity.deviceId, sign: (p) => signWith(identity, p), dataDir: app.getPath('userData') });
  void peers.start().then(() => controller!.usePeers(peers)).catch(() => { /* no network: the hub path still works */ });
  app.on('before-quit', () => peers.stop());
  updater.on('state', () => controller?.push());
  updater.on('ready', (v: string, mandatory: boolean) => {
    if (!win?.isFocused()) notify(mandatory ? 'Required update ready' : 'Update ready', `Dexterity Connect ${v} is ready. Restart to install it.`);
  });
  controller.on('hub-ready', () => {
    const last = updater?.state.lastCheck ?? 0;
    if (Date.now() - last > 30 * 60 * 1000) void updater?.check(false);
  });
  wireIpc(controller);
  handleFileScheme(() => {
    const hub = controller?.hubEndpoint();
    const token = controller?.state().session?.fileToken;
    return hub && token ? { ...hub, token } : null;
  });
  void pruneCache();
  applyLogin(config.settings);
  nativeTheme.themeSource = config.settings.theme;
  nativeTheme.on('updated', () => applyTheme(controller!.settings));

  createWindow(process.argv.includes('--hidden'));
  buildTray();
  controller.start();
  updater.start();

  // away after 10 minutes without input, or while the screen is locked
  let locked = false;
  const checkIdle = () => controller?.setIdle(locked || powerMonitor.getSystemIdleTime() >= 600);
  setInterval(checkIdle, 30_000);
  powerMonitor.on('lock-screen', () => { locked = true; checkIdle(); });
  powerMonitor.on('unlock-screen', () => { locked = false; checkIdle(); });
  powerMonitor.on('suspend', () => { locked = true; checkIdle(); });
  powerMonitor.on('resume', () => { locked = false; checkIdle(); });
});
