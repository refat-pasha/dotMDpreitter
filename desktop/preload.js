/* =========================================================================
   desktop/preload.js — the only bridge between the app and Electron.

   Runs in a sandboxed, contextIsolated renderer: the page gets exactly
   this API and nothing else. No Node, no remote, no filesystem access.
   ========================================================================= */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dotmdDesktop', {
  isDesktop: true,
  platform: process.platform,

  /* Open a link outside the app (browser / mail client). The main process
     re-validates the scheme and refuses same-app URLs. */
  openExternal: (url) => ipcRenderer.invoke('desktop:open-external', String(url || '')),

  openNewWindow: () => ipcRenderer.invoke('desktop:new-window'),

  /* { data, downloads } — where accounts, sessions and documents live. */
  getPaths: () => ipcRenderer.invoke('desktop:get-paths'),

  /* Open the per-user data folder in the OS file manager. */
  openDataFolder: () => ipcRenderer.invoke('desktop:open-data-folder'),

  /* Native menu → renderer. Returns an unsubscribe function. */
  onMenu: (handler) => {
    const wrapped = (_event, action) => {
      try { handler(action); } catch (_) { /* a broken handler must not crash the menu */ }
    };
    ipcRenderer.on('desktop:menu', wrapped);
    return () => ipcRenderer.removeListener('desktop:menu', wrapped);
  }
});
