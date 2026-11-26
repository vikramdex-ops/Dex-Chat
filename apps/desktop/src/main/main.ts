// Dexterity Connect — Electron main process.
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { app, BrowserWindow, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, Notification, powerMonitor, session, shell, Tray } from 'electron';
import type { OpName } from '@dex/core';
import type { JoinRequest, Settings } from '../shared/bridge.ts';
import { detectAccount } from './account.ts';
import { Controller } from './controller.ts';
import { loadConfig, loadEncKeys, loadIdentity, saveConfig } from './persist.ts';
import { Updater } from './updater.ts';
import { cachedFile, handleFileScheme, openFile, pruneCache, registerFileScheme, saveFile, saveSupportFile, supportFolder, uploadFile, useEncryption } from './files.ts';
import { safeRelativePath } from '@dex/core/assist';
import { wireSupportService } from './assist/service.ts';
import { editInSlate, slateExe, stopWatching } from './slate.ts';
import { PeerNet } from './peer.ts';
import { installedTools, openToolLink } from './tools.ts';
import { guardFrames, handleMiniAppScheme } from './miniapps.ts';
import { Drives, readTestHook } from './drives.ts';
import { signWith } from '@dex/core';
import type { HubAccess, UploadSource } from './files.ts';
import { appLog } from './applog.ts';
import { wireAssist } from './assist/index.ts';
import { dropIndexKey, indexKey } from './localindex.ts';
import { openTempCopy, pruneTempCopies, saveBytes } from './viewer.ts';
import { mailtoOk, openMailDraft, pruneMailDrafts } from './maildraft.ts';
import { fetchLikeBrowser, zohoSignIn } from './zoho.ts';

const APP_ID = 'in.co.dexteritydesign.connect';
const PROTOCOL = 'dexconnect';
const isWin = process.platform === 'win32';
const devUrl = process.env.VITE_DEV_SERVER_URL;

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let controller: Controller | null = null;
/** The office signed in to last (its search index key is dropped on sign-out or removal). */
let lastHubId: string | null = null;
let updater: Updater | null = null;
let quitting = false;
/**
 * This PC's drive letters, for share paths in messages (drives.ts). DEXCONNECT_TEST_DRIVES is a
 * TEST-ONLY fake map, honoured only in a development (unpackaged) build when it is set.
 */
const drives = new Drives({
  platform: process.platform,
  testHook: () => readTestHook(process.env.DEXCONNECT_TEST_DRIVES, app.isPackaged),
  open: (p) => shell.openPath(p),
});
if (readTestHook(process.env.DEXCONNECT_TEST_DRIVES, app.isPackaged)) (globalThis as { __dexTestShell?: unknown }).__dexTestShell = drives.testShell;
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

/** Conversations popped out into windows of their own, by conversation id. */
const popouts = new Map<string, BrowserWindow>();

function popOut(convId: string, title: string): void {
  if (!/^[0-9A-Za-z_-]{8,40}$/.test(convId)) return;
  const open = popouts.get(convId);
  if (open && !open.isDestroyed()) { open.show(); open.focus(); return; }
  const p = new BrowserWindow({
    width: 560, height: 760, minWidth: 380, minHeight: 420,
    title: `${title.slice(0, 80)} · Dexterity Connect`, icon: iconPath(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#132b2e' : '#f4f9f9',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
  });
  p.setMenuBarVisibility(false);
  p.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
  p.webContents.on('will-navigate', (e, url) => { if (url.split('#')[0] === p.webContents.getURL().split('#')[0]) return; if (!devUrl || !url.startsWith(devUrl)) e.preventDefault(); });
  guardFrames(p.webContents);
  p.webContents.on('did-finish-load', () => p.webContents.setZoomFactor((controller?.settings.textSize ?? 100) / 100));
  if (devUrl) void p.loadURL(`${devUrl}#popout=${convId}`);
  else void p.loadFile(path.join(__dirname, '..', 'dist-renderer', 'index.html'), { hash: `popout=${convId}` });
  popouts.set(convId, p);
  p.on('closed', () => popouts.delete(convId));
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
  // drive letters are read again when the window comes back (at most once a minute: it is cached)
  win.on('focus', () => { win?.flashFrame(false); void drives.get(); });
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
    // the app may reload itself (switching offices, a new language); it never goes anywhere else
    const here = (u: string) => u.split('#')[0];
    if (here(url) === here(win?.webContents.getURL() ?? '')) return;
    if (!devUrl || !url.startsWith(devUrl)) e.preventDefault();
  });
  guardFrames(win.webContents);

  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(path.join(__dirname, '..', 'dist-renderer', 'index.html'));

  // errors in the window go into the app's log (for diagnostics); never the page's content
  win.webContents.on('console-message', (e: Electron.Event & { level?: string | number; message?: string; sourceId?: string }, level?: number, message?: string, _line?: number, sourceId?: string) => {
    const lv = e.level ?? level;
    if (lv === 'error' || lv === 3) appLog.error('renderer', String(e.message ?? message ?? ''), { source: String(e.sourceId ?? sourceId ?? '').split('/').pop() ?? '' });
  });
  win.webContents.on('render-process-gone', (_e, d) => appLog.error('renderer', 'the window stopped', { reason: d.reason, exitCode: d.exitCode }));
  win.webContents.on('did-finish-load', () => {
    win?.webContents.setZoomFactor((controller?.settings.textSize ?? 100) / 100);
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
      { label: 'Tell Nib…', enabled: s?.phase === 'ready', click: () => { showWindow(); routeDeepLink(`${PROTOCOL}://nib`); } },
      { label: 'Help me…', enabled: s?.phase === 'ready', click: () => { showWindow(); routeDeepLink(`${PROTOCOL}://help`); } },
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
  drives.onChange((m) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('drives:changed', m); });
  void drives.get();
  ipcMain.handle('app:getState', () => c.state());
  ipcMain.handle('app:join', (_e, req: JoinRequest) => c.join(req));
  ipcMain.handle('app:clipboard', async () => String(await clipboard.readText()).slice(0, 4000));
  // signing out of an office drops its search index key (the window deletes the index too)
  ipcMain.handle('app:forgetHub', async () => { await dropIndexKey(c.state().session?.hub.id ?? lastHubId).catch(() => {}); c.forgetHub(); });
  ipcMain.handle('app:addOffice', () => c.addOffice());
  ipcMain.handle('app:switchOffice', (_e, id: string) => c.switchOffice(String(id)));
  ipcMain.handle('app:removeOffice', async (_e, id: string) => { await dropIndexKey(String(id)).catch(() => {}); c.removeOffice(String(id)); });
  ipcMain.handle('app:rescan', () => c.rescan());
  ipcMain.handle('app:setSettings', (_e, patch: Partial<Settings>) => {
    const safe: Partial<Settings> = {};
    if (patch.theme === 'system' || patch.theme === 'light' || patch.theme === 'dark') safe.theme = patch.theme;
    if (typeof patch.startAtLogin === 'boolean') safe.startAtLogin = patch.startAtLogin;
    if (typeof patch.closeToTray === 'boolean') safe.closeToTray = patch.closeToTray;
    if (patch.updateChannel === 'stable' || patch.updateChannel === 'beta') safe.updateChannel = patch.updateChannel;
    if (typeof patch.autoDownloadUpdates === 'boolean') safe.autoDownloadUpdates = patch.autoDownloadUpdates;
    if (patch.sound === 'chime' || patch.sound === 'tick' || patch.sound === 'drop' || patch.sound === 'none') safe.sound = patch.sound;
    if (patch.notifyFor === 'all' || patch.notifyFor === 'mentions' || patch.notifyFor === 'none') safe.notifyFor = patch.notifyFor;
    if (typeof patch.showPreviews === 'boolean') safe.showPreviews = patch.showPreviews;
    if (patch.density === 'comfortable' || patch.density === 'compact') safe.density = patch.density;
    if (patch.textSize === 90 || patch.textSize === 100 || patch.textSize === 110 || patch.textSize === 125) safe.textSize = patch.textSize;
    if (patch.timeFormat === 'system' || patch.timeFormat === '12' || patch.timeFormat === '24') safe.timeFormat = patch.timeFormat;
    for (const k of ['quietFrom', 'quietTo'] as const) {
      const v = patch[k];
      if (v === null || (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v))) safe[k] = v;
    }
    const channelChanged = safe.updateChannel && safe.updateChannel !== c.settings.updateChannel;
    const s = c.updateSettings(safe);
    applyTheme(s);
    applyLogin(s);
    win?.webContents.setZoomFactor(s.textSize / 100);
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
    return { ...hub, token, tunnel: c.viaGateway ? (r) => c.http(r) : undefined };
  };
  const wrap = async <T>(fn: () => Promise<T>) => {
    try { return { ok: true, data: await fn() }; } catch (err) { return { ok: false, error: (err as Error).message }; }
  };
  ipcMain.handle('file:upload', (e, uploadId: string, src: UploadSource) => wrap(() => uploadFile(access(), {
    path: typeof src?.path === 'string' ? src.path : undefined,
    data: src?.data instanceof ArrayBuffer ? src.data : undefined,
    name: String(src?.name ?? 'file').slice(0, 200),
    mime: typeof src?.mime === 'string' ? src.mime : undefined,
    convId: typeof src?.convId === 'string' ? src.convId : undefined,
  }, (sent, total) => e.sender.send('file:progress', uploadId, sent, total))));
  ipcMain.handle('file:open', (_e, id: string, name: string) => wrap(() => openFile(access(), String(id), String(name))));
  // saving reports progress as "save:<id>" on the upload progress channel
  ipcMain.handle('file:save', (e, id: string, name: string) => wrap(() => saveFile(access(), String(id), String(name), (got, total) => e.sender.send('file:progress', `save:${String(id)}`, got, total))));
  // files dropped into a support session (policy assistFiles): saved under Downloads\Dexterity IT\<ticket>
  const ticketFolder = (ref: unknown) => (typeof ref === 'string' && /^T-\d{1,9}$/.test(ref) ? ref : null);
  ipcMain.handle('assist:save-file', (_e, id: unknown, ref: unknown, rel: unknown) => wrap(async () => {
    const segs = typeof rel === 'string' ? safeRelativePath(rel) : null;
    const t = ticketFolder(ref);
    if (typeof id !== 'string' || !/^[0-9A-Z]{26}$/.test(id) || !segs || !t) throw new Error('That file cannot be saved here.');
    return saveSupportFile(access(), id, t, segs);
  }));
  ipcMain.handle('assist:open-folder', async (_e, ref: unknown) => { const t = ticketFolder(ref); if (t) await shell.openPath(supportFolder(t)); });
  ipcMain.handle('e2e:status', (_e, convId: string) => wrap(() => controller!.e2e.status(String(convId))));
  // the file viewer: open a temporary copy in the default app, or save, from bytes or a hub file
  const viewerSource = async (name: string, src: { id?: unknown; data?: unknown }) => {
    if (src?.data instanceof ArrayBuffer || ArrayBuffer.isView(src?.data)) return { data: src.data as ArrayBuffer };
    if (typeof src?.id === 'string' && /^[0-9A-Z]{26}$/.test(src.id)) return { path: await cachedFile(access(), src.id, name) };
    throw new Error('There is nothing to open.');
  };
  ipcMain.handle('file:openCopy', (_e, name: string, src: { id?: unknown; data?: unknown }) => wrap(async () => openTempCopy(String(name), await viewerSource(String(name), src))));
  // Send by email: the invitation as a draft in the PC's mail program, or a mailto: link
  ipcMain.handle('mail:draft', (_e, name: unknown, eml: unknown) => wrap(async () => openMailDraft(String(name), eml, {
    open: (p) => shell.openPath(p),
    record: readTestHook(process.env.DEXCONNECT_TEST_DRIVES, app.isPackaged) ? (p) => drives.testShell.push({ kind: 'file', path: p }) : null,
  })));
  // Connect Zoho Calendar: the browser signs in, Zoho returns to a short-lived loopback address (zoho.ts)
  ipcMain.handle('zoho:signIn', (_e, authUrl: unknown, state: unknown) => wrap(async () => {
    const test = !app.isPackaged && process.env.DEXCONNECT_TEST_ZOHO_BROWSER === 'fetch';
    const answer = await zohoSignIn(String(authUrl), String(state), test ? fetchLikeBrowser : (u) => shell.openExternal(u), test);
    showWindow();
    return answer;
  }));
  ipcMain.handle('mail:to', (_e, url: unknown) => wrap(async () => { if (!mailtoOk(url)) throw new Error('That is not a mail link.'); await shell.openExternal(url); }));
  ipcMain.handle('file:saveCopy', (_e, name: string, src: { id?: unknown; data?: unknown }) => wrap(async () => saveBytes(String(name), await viewerSource(String(name), src))));
  // the key of this office's on-device search index (sealed by the system's secure storage)
  ipcMain.handle('search:key', (_e, scope: string) => wrap(() => indexKey(String(scope))));
  ipcMain.handle('search:dropKey', (_e, scope: string) => wrap(() => dropIndexKey(String(scope))));
  ipcMain.handle('tools:installed', () => installedTools());
  ipcMain.handle('window:popout', (_e, convId: string, title: string) => { popOut(String(convId), String(title ?? '')); });
  ipcMain.handle('window:main', (_e, convId: string) => { showWindow(); if (typeof convId === 'string') win?.webContents.send('app:deeplink', `${PROTOCOL}://conversation/${convId}`); });
  ipcMain.handle('tools:open', (_e, url: string) => wrap(async () => {
    if (String(url).startsWith('dexconnect://')) { routeDeepLink(String(url)); return; }
    await openToolLink(String(url));
  }));
  // Open folder on a link card: a share or drive folder that exists, never a file or program,
  // through whichever form of the path works on this PC (as written, UNC, or this PC's letter)
  ipcMain.handle('shell:openFolder', (_e, p: unknown) => wrap(() => drives.openFolder(p)));
  // Open on a share path's card: drawings, sheets and documents only, never programs or scripts
  ipcMain.handle('shell:openSharePath', (_e, p: unknown) => wrap(() => drives.openFile(p)));
  // this PC's drive letters (Preferences → Your network drives; share paths in messages)
  ipcMain.handle('drives:get', (_e, force: unknown) => wrap(() => drives.get(force === true)));
  ipcMain.handle('drives:check', (_e, p: unknown) => wrap(() => drives.check(p)));
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
  session.defaultSession.setDisplayMediaRequestHandler((req, callback) => {
    void desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
      const pick = sources.find((s) => s.id === chosenScreen) ?? sources.find((s) => s.id.startsWith('screen:'));
      chosenScreen = null;
      // the computer's own sound, when asked for (Windows can capture it)
      if (pick) callback({ video: pick, ...(req.audioRequested && process.platform === 'win32' ? { audio: 'loopback' as const } : {}) });
      else callback({});
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

  c.on('state', (s) => { win?.webContents.send('app:state', s); for (const p of popouts.values()) p.webContents.send('app:state', s); });
  c.on('hub-event', (name: string, data: unknown) => {
    win?.webContents.send('hub:event', name, data);
    for (const p of popouts.values()) p.webContents.send('hub:event', name, data);
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
  appLog.toFile(path.join(app.getPath('userData'), 'logs', 'connect.log'));
  process.on('uncaughtExceptionMonitor', (err) => appLog.error('main', err.message, { name: err.name }));
  const config = loadConfig();
  let identity: ReturnType<typeof loadIdentity>;
  let encKeys: ReturnType<typeof loadEncKeys>;
  try {
    identity = loadIdentity();
    encKeys = loadEncKeys();
  } catch (err) {
    // the keys exist but the system cannot unseal them right now: never replace them with new ones
    dialog.showErrorBox('Dexterity Connect cannot start yet', (err as Error).message);
    quitting = true;
    app.quit();
    return;
  }
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
    // the hub's mirror on the office network, or through the gateway outside it (a network that
    // blocks GitHub still gets updates from the office), alongside the public feed and its mirror
    hub: () => (controller?.viaGateway ? null : controller?.hubEndpoint() ?? null),
    tunnel: () => (controller?.viaGateway ? (r) => controller!.http(r) : null),
    feedBase: devUpdates ? process.env.DEXCONNECT_FEED_BASE : undefined,
    mirrorBase: devUpdates ? process.env.DEXCONNECT_MIRROR_BASE : undefined,
    log: (msg, extra) => appLog.info('update', msg, extra),
    platformOverride: devUpdates ? (process.env.DEXCONNECT_UPDATER_PLATFORM as never) || undefined : undefined,
    allowHttp: devUpdates,
    beforeInstall: (v, notes) => { config.pendingNotes = { version: v, notes }; saveConfig(config); },
    quit: () => { quitting = true; app.quit(); },
  }, justUpdated ?? null);

  controller = new Controller(account, identity, config, { platform: process.platform, version, update: () => updater!.state }, encKeys);
  // files in end-to-end encrypted Direct messages: encrypted before upload, decrypted after download
  useEncryption({ plan: (convId, file) => controller!.e2e.planUpload(convId, file), decrypt: (id) => controller!.e2e.downloadTransform(id) });
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
  // what happened on this PC, for "Send diagnostics" (no message content is ever logged)
  appLog.info('main', 'app started', { version, platform: process.platform, packaged: app.isPackaged });
  let lastPhase = '';
  controller.on('state', (s: { phase: string; via?: string; error: string | null; session?: { hub: { id: string } } | null }) => {
    if (s.session?.hub.id) lastHubId = s.session.hub.id;
    // removed (or declined) by an administrator: this device's search index goes with it
    if (s.phase === 'rejected' && lastPhase !== 'rejected' && lastHubId) void dropIndexKey(lastHubId).catch(() => {});
    if (s.phase === lastPhase) return;
    const was = lastPhase;
    lastPhase = s.phase;
    appLog.write(s.phase === 'offline' || s.phase === 'rejected' || s.phase === 'mismatch' ? 'warn' : 'info', 'hub', `connection: ${s.phase}`, { via: s.via ?? '', error: s.error ?? '' });
    // a support session cannot be audited without the hub: whatever was shared stops
    if (was === 'ready' && s.phase !== 'ready') { assist.stopAll('the hub connection was lost'); win?.webContents.send('assist:stop', 'session'); }
  });
  controller.on('warning', (err: Error) => appLog.warn('hub', err.message));
  let lastUpdate = '';
  updater.on('state', () => {
    const u = updater!.state;
    if (u.phase === lastUpdate) return;
    lastUpdate = u.phase;
    appLog.write(u.phase === 'error' ? 'warn' : 'info', 'update', `update: ${u.phase}`, { version: u.available?.version ?? '', error: u.error ?? '' });
  });
  const assist = wireAssist({
    win: () => win,
    load: (w, hash) => { if (devUrl) void w.loadURL(`${devUrl}#${hash}`); else void w.loadFile(path.join(__dirname, '..', 'dist-renderer', 'index.html'), { hash }); },
    preload: path.join(__dirname, 'preload.cjs'),
    version,
    channel: () => config.settings.updateChannel,
    hub: () => {
      const s = controller!.state();
      const ep = controller!.hubEndpoint();
      return {
        address: ep ? `${ep.host}:${ep.port}` : null,
        route: s.phase !== 'ready' ? 'not connected' : controller!.viaGateway ? 'internet gateway' : 'office network',
        gateway: s.hub?.gateway ? (() => { try { return new URL(s.hub!.gateway!).host; } catch { return null; } })() : null,
      };
    },
    ping: async () => { await controller!.request('ping'); },
    iceUrls: async () => (await controller!.request('room.ice')).iceServers.flatMap((x) => [x.urls].flat()),
  });
  wireSupportService({
    endpoint: () => (controller?.viaGateway ? null : controller?.hubEndpoint() ?? null),
    fromMain: (e) => !!win && e.sender.id === win.webContents.id,
    log: (level, msg, extra) => appLog.write(level, 'assist', msg, extra),
  });
  // Ctrl+Alt+D from anywhere in Windows brings Dexterity Connect forward (or hides it again)
  try {
    globalShortcut.register('CommandOrControl+Alt+D', () => {
      if (win && win.isVisible() && win.isFocused()) win.hide(); else showWindow();
    });
  } catch { /* another app owns the combination */ }
  // Ctrl+Alt+N from anywhere: Nib's box, ready to type (docs/NIB.md)
  try {
    globalShortcut.register('CommandOrControl+Alt+N', () => { showWindow(); routeDeepLink(`${PROTOCOL}://nib`); });
  } catch { /* another app owns the combination */ }
  app.on('will-quit', () => globalShortcut.unregisterAll());
  handleFileScheme(() => {
    const hub = controller?.hubEndpoint();
    const token = controller?.state().session?.fileToken;
    return hub && token ? { ...hub, token, tunnel: controller!.viaGateway ? (r) => controller!.http(r) : undefined } : null;
  });
  handleMiniAppScheme((op, data) => controller!.request(op, data));
  void pruneCache();
  void pruneTempCopies();
  void pruneMailDrafts();
  applyLogin(config.settings);
  nativeTheme.themeSource = config.settings.theme;
  nativeTheme.on('updated', () => applyTheme(controller!.settings));

  createWindow(process.argv.includes('--hidden'));
  // a reloaded window has forgotten what it shared: stop sharing and control
  win?.webContents.on('did-start-navigation', (e: Electron.Event & { isSameDocument?: boolean; isMainFrame?: boolean }, _url?: string, inPlace?: boolean, mainFrame?: boolean) => {
    if ((e.isMainFrame ?? mainFrame) && !(e.isSameDocument ?? inPlace)) assist.stopAll('the window reloaded');
  });
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
