// Sandboxed preload: exposes a narrow, typed API to the UI.
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DexBridge } from '../shared/bridge.ts';

function subscribe<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]) => cb(...(args as T));
  ipcRenderer.on(channel, listener);
  return () => { ipcRenderer.removeListener(channel, listener); };
}

async function unwrap<T>(p: Promise<{ ok: boolean; data?: T; error?: string }>): Promise<T> {
  const r = await p;
  if (!r.ok) throw new Error(r.error);
  return r.data as T;
}

const bridge: DexBridge = {
  getState: () => ipcRenderer.invoke('app:getState'),
  popOut: (convId: string, title: string) => ipcRenderer.invoke('window:popout', convId, title),
  showMain: (convId?: string) => ipcRenderer.invoke('window:main', convId),
  onState: (cb) => subscribe('app:state', cb),
  onHubEvent: (cb) => subscribe('hub:event', cb),
  onDeepLink: (cb) => subscribe('app:deeplink', cb),
  join: (req) => ipcRenderer.invoke('app:join', req),
  readClipboard: () => ipcRenderer.invoke('app:clipboard'),
  addOffice: () => ipcRenderer.invoke('app:addOffice'),
  switchOffice: (id) => ipcRenderer.invoke('app:switchOffice', id),
  removeOffice: (id) => ipcRenderer.invoke('app:removeOffice', id),
  forgetHub: () => ipcRenderer.invoke('app:forgetHub'),
  rescan: () => ipcRenderer.invoke('app:rescan'),
  request: async (op, data) => {
    const r = await ipcRenderer.invoke('hub:request', op, data) as { ok: boolean; data?: unknown; error?: string };
    if (!r.ok) throw new Error(r.error);
    return r.data as never;
  },
  setSettings: (patch) => ipcRenderer.invoke('app:setSettings', patch),
  notify: (title, body, link) => ipcRenderer.send('app:notify', title, body, link),
  setBadge: (count) => ipcRenderer.send('app:badge', count),
  uploadFile: (uploadId, src) => unwrap(ipcRenderer.invoke('file:upload', uploadId, src)),
  onUploadProgress: (cb) => subscribe('file:progress', cb),
  pathForFile: (file) => webUtils.getPathForFile(file),
  openFile: (id, name) => unwrap(ipcRenderer.invoke('file:open', id, name)),
  saveFile: (id, name) => unwrap(ipcRenderer.invoke('file:save', id, name)),
  editInSlate: (noteId, title, body) => unwrap(ipcRenderer.invoke('slate:edit', noteId, title, body)),
  onSlateChange: (cb) => subscribe('slate:changed', cb),
  openInSlate: (id, name) => unwrap(ipcRenderer.invoke('slate:open', id, name)),
  hasSlate: ipcRenderer.sendSync('slate:available') === true,
  e2eStatus: (convId) => unwrap(ipcRenderer.invoke('e2e:status', convId)),
  statFile: (p) => unwrap(ipcRenderer.invoke('file:stat', p)),
  installedTools: () => ipcRenderer.invoke('tools:installed'),
  openLink: (url) => unwrap(ipcRenderer.invoke('tools:open', url)),
  listScreens: () => ipcRenderer.invoke('screen:list'),
  chooseScreen: (id) => ipcRenderer.invoke('screen:choose', id),
  assist: {
    caps: () => ipcRenderer.invoke('assist:caps'),
    consent: (c) => ipcRenderer.invoke('assist:consent', c),
    input: (msg) => ipcRenderer.send('assist:input', msg),
    onStop: (cb) => subscribe('assist:stop', cb),
    diagnostics: (errors) => ipcRenderer.invoke('assist:diagnostics', errors),
    screenshot: () => ipcRenderer.invoke('assist:screenshot'),
    pointers: (state) => ipcRenderer.send('assist:pointers', state),
    pointer: (msg) => ipcRenderer.send('assist:pointer', msg),
  },
  overlay: {
    onState: (cb) => subscribe('overlay:state', cb),
    action: (a) => ipcRenderer.send('overlay:action', a),
  },
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  dismissWhatsNew: () => ipcRenderer.invoke('update:dismissWhatsNew'),
};

contextBridge.exposeInMainWorld('dex', bridge);
