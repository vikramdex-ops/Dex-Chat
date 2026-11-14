// Sandboxed preload: exposes a narrow, typed API to the UI.
import { contextBridge, ipcRenderer } from 'electron';
import type { DexBridge } from '../shared/bridge.ts';

function subscribe<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]) => cb(...(args as T));
  ipcRenderer.on(channel, listener);
  return () => { ipcRenderer.removeListener(channel, listener); };
}

const bridge: DexBridge = {
  getState: () => ipcRenderer.invoke('app:getState'),
  onState: (cb) => subscribe('app:state', cb),
  onHubEvent: (cb) => subscribe('hub:event', cb),
  onDeepLink: (cb) => subscribe('app:deeplink', cb),
  join: (req) => ipcRenderer.invoke('app:join', req),
  forgetHub: () => ipcRenderer.invoke('app:forgetHub'),
  rescan: () => ipcRenderer.invoke('app:rescan'),
  request: async (op, data) => {
    const r = await ipcRenderer.invoke('hub:request', op, data) as { ok: boolean; data?: unknown; error?: string };
    if (!r.ok) throw new Error(r.error);
    return r.data as never;
  },
  setSettings: (patch) => ipcRenderer.invoke('app:setSettings', patch),
  notify: (title, body) => ipcRenderer.send('app:notify', title, body),
};

contextBridge.exposeInMainWorld('dex', bridge);
