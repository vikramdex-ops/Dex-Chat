// Lattice desktop shell — the parts of a chat client that only a native app can do:
// tray, launch at login, notifications, protocol links, download handling, version/about.
// The messenger itself is the same LAN server the browser uses, started in-process.
const { app, BrowserWindow, Menu, Tray, nativeImage, shell, dialog, session, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const APP_PORT = Number(process.env.LATTICE_PORT || 47825);

// All data stays beside the executable when possible (e.g. D:\lattice\data), so an
// install on D: never writes to C:. Falls back to the standard profile folder if that
// location is read-only (for example a machine-wide install under Program Files).
function resolveDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  const candidates = [path.join(path.dirname(app.getPath('exe')), 'data')];
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch { /* try the next location */ }
  }
  return path.join(app.getPath('userData'), 'data');
}

let mainWindow = null;
let tray = null;
let quitting = false;
let serverReady = false;

if (process.argv.includes('--lattice-serve-only')) {
  // headless helper mode is not used by the UI; kept explicit so the flag is harmless
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    focusWindow();
    const link = argv.find((a) => a.startsWith('lattice://'));
    if (link) handleDeepLink(link);
  });
}

function focusWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function handleDeepLink(link) {
  // lattice://<channelId>/<messageId> mirrors the browser hash route
  const target = link.replace(/^lattice:\/\//, '').replace(/\/+$/, '');
  if (!mainWindow || !target) return;
  const url = `http://127.0.0.1:${APP_PORT}/#${target}`;
  mainWindow.loadURL(url);
  focusWindow();
}

function trayImage() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <rect width="32" height="32" rx="6" fill="#101820"/>
    <path d="M6 25 L16 7 L26 25" fill="none" stroke="#f1f3ef" stroke-width="2.4"/>
    <circle cx="16" cy="7" r="2.8" fill="#a8660a"/>
  </svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

function serverUrl() {
  return `http://127.0.0.1:${APP_PORT}`;
}

function buildMenu() {
  const loginItem = app.getLoginItemSettings();
  return Menu.buildFromTemplate([
    { label: 'Open Lattice', click: focusWindow },
    { type: 'separator' },
    {
      label: 'Copy server link for colleagues',
      click: () => {
        const addr = LAN_ADDRESS();
        clipboard.writeText(addr ? `http://${addr}:${APP_PORT}` : serverUrl());
      },
    },
    {
      label: 'Start when I sign in',
      type: 'checkbox',
      checked: loginItem.openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] });
      },
    },
    { type: 'separator' },
    { label: `Version ${app.getVersion()}`, enabled: false },
    { label: 'About Lattice', click: showAbout },
    {
      label: 'Check for a newer installer',
      click: () => shell.openExternal('https://github.com/vikramdex-ops/Dex-Chat/releases/latest'),
    },
    { type: 'separator' },
    { label: 'Quit Lattice', click: () => { quitting = true; app.quit(); } },
  ]);
}

function LAN_ADDRESS() {
  const os = require('node:os');
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return null;
}

function showAbout() {
  dialog.showMessageBox({
    type: 'info',
    title: 'About Lattice',
    message: `Lattice ${app.getVersion()}`,
    detail: [
      'An offline-first messenger for the office LAN.',
      '',
      `This machine serves the workspace at ${serverUrl()}`,
      `Colleagues open http://${LAN_ADDRESS() || 'your-ip'}:${APP_PORT}`,
      '',
      'Messages and files never leave the office network.',
    ].join('\n'),
    buttons: ['OK'],
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 380,
    minHeight: 480,
    backgroundColor: '#f1f3ef',
    title: 'Lattice',
    autoHideMenuBar: true,
    icon: trayImage(),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(serverUrl())) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.webContents.on('did-fail-load', () => {
    setTimeout(() => mainWindow && mainWindow.loadURL(serverUrl()), 1200);
  });

  return mainWindow.loadURL(serverUrl());
}

function wireDownloads() {
  session.defaultSession.on('will-download', (_event, item) => {
    // keep the default save location, but make the transfer visible in the app
    item.once('done', (_e, state) => {
      if (state === 'completed' && mainWindow) {
        mainWindow.webContents.send?.('lattice:download', { file: item.getFilename() });
      }
    });
  });
}

async function startServer() {
  process.env.DATA_DIR = resolveDataDir();
  process.env.PORT = String(APP_PORT);
  process.env.WORKSPACE_NAME = process.env.WORKSPACE_NAME || 'Office';
  try {
    await import(pathToFileURL(path.join(__dirname, '..', 'server', 'index.js')).href);
    serverReady = true;
  } catch (err) {
    dialog.showMessageBoxSync({
      type: 'error',
      title: 'Lattice could not start its server',
      message: 'The local server failed to start.',
      detail: `${err && err.message ? err.message : err}\n\nThis build needs the Node.js runtime that ships with Electron 38 or newer (node:sqlite).`,
    });
    app.quit();
  }
}

app.setAboutPanelOptions({
  applicationName: 'Lattice',
  applicationVersion: app.getVersion(),
  credits: 'Offline-first messaging for the office network.',
});

app.on('open-url', (event, url) => {
  event.preventDefault();
  if (serverReady) handleDeepLink(url);
});

app.whenReady().then(async () => {
  if (process.defaultApp) {
    // development: register the protocol against the electron binary + entry script
    app.setAsDefaultProtocolClient('lattice', process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient('lattice');
  }

  await startServer();
  wireDownloads();
  await createWindow();

  tray = new Tray(trayImage());
  tray.setToolTip('Lattice');
  tray.setContextMenu(buildMenu());
  tray.on('click', focusWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else focusWindow();
  });
});

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => {
  // stay in the tray on Windows/Linux, standard behaviour on macOS
  if (process.platform === 'darwin') return;
});
