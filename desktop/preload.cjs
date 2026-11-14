// Minimal, sandboxed bridge: the UI only needs to know it is running in the desktop app.
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('latticeDesktop', {
  isDesktop: true,
  version: process.env.npm_package_version || undefined,
  platform: process.platform,
});
