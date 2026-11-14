// Dexterity Connect — Electron main process.
import path from 'node:path';
import { app, BrowserWindow, ipcMain, Menu, nativeImage, nativeTheme, Notification, shell, Tray } from 'electron';
import type { OpName } from '@dex/core';
import type { JoinRequest, Settings } from '../shared/bridge.ts';
import { detectAccount } from './account.ts';
import { Controller } from './controller.ts';
import { loadConfig, loadIdentity } from './persist.ts';

const APP_ID = 'in.co.dexteritydesign.connect';
const PROTOCOL = 'dexconnect';
const isWin = process.platform === 'win32';
const devUrl = process.env.VITE_DEV_SERVER_URL;

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let controller: Controller | null = null;
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
if (process.defaultApp && process.argv[1]) {
  app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

const iconPath = () => app.isPackaged
  ? path.join(process.resourcesPath, 'icon.png')
  : path.join(__dirname, '..', 'build', 'icon.png');

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

function notify(title: string, body: string): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: iconPath(), silent: false });
  n.on('click', showWindow);
  n.show();
}

function buildTray(): void {
  const image = nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16, quality: 'best' });
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
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ]));
  };
  refresh();
  controller?.on('state', refresh);
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
    const s = c.updateSettings(safe);
    applyTheme(s);
    applyLogin(s);
    return s;
  });
  ipcMain.handle('hub:request', async (_e, op: OpName, data: unknown) => {
    try {
      return { ok: true, data: await c.request(op, data as never) };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
  ipcMain.on('app:notify', (_e, title: unknown, body: unknown) => {
    if (typeof title === 'string' && typeof body === 'string') notify(title.slice(0, 120), body.slice(0, 400));
  });

  c.on('state', (s) => win?.webContents.send('app:state', s));
  c.on('hub-event', (name: string, data: unknown) => {
    win?.webContents.send('hub:event', name, data);
    if (name === 'admin.pending' && !win?.isFocused()) {
      const d = data as { displayName: string; hostname: string };
      notify('New device waiting for approval', `${d.displayName} wants to join from ${d.hostname}.`);
    }
  });
}

app.on('before-quit', () => { quitting = true; controller?.stop(); });
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
  controller = new Controller(account, identity, config, { platform: process.platform, version: app.getVersion() });
  wireIpc(controller);
  applyLogin(config.settings);
  nativeTheme.themeSource = config.settings.theme;
  nativeTheme.on('updated', () => applyTheme(controller!.settings));

  createWindow(process.argv.includes('--hidden'));
  buildTray();
  controller.start();
});
