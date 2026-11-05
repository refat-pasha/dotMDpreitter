#!/usr/bin/env node
/* =========================================================================
   desktop/main.js — Electron main process for the dotMDpritter desktop app.

   The desktop shell reuses the entire web application untouched:

     - the zero-dependency HTTP server (server.js) is required in-process
       and started on an ephemeral loopback port,
     - a hidden BrowserWindow loads http://127.0.0.1:<port>/ — nothing is
       fetched from the network and nothing listens on a public interface,
     - all data (accounts, sessions, documents) lives under the OS user-data
       directory, never inside a Program Files install.

   Module level is deliberately Electron-free so desktop/desktop-selftest.js
   can require this file under plain Node and test the pure helpers.
   ========================================================================= */
'use strict';

const path = require('path');
const fs = require('fs');

const APP_NAME = 'dotMDpritter';
const APP_VERSION = '1.1.0';
const APP_ROOT = path.join(__dirname, '..');

/* ----------------------------------------------------------- pure helpers */

/**
 * Where the desktop build keeps everything. app.getPath('userData') is the
 * OS-correct per-user application folder (e.g.
 * %APPDATA%\dotMDpritter on Windows) — writable without elevation.
 * @param {{getPath:(name:string)=>string}} [app] Electron app (optional)
 */
function desktopPaths(app) {
  let base;
  try {
    base = (app && typeof app.getPath === 'function')
      ? app.getPath('userData')
      : path.join(require('os').homedir(), 'AppData', 'Roaming', APP_NAME);
  } catch (_) {
    base = path.join(require('os').homedir(), 'AppData', 'Roaming', APP_NAME);
  }
  return {
    base,
    data: path.join(base, 'data'),
    downloads: path.join(base, 'downloads')
  };
}

/**
 * True only for http(s) URLs whose host is this machine. The renderer is
 * served from loopback, so any other origin must leave through a real
 * browser, never an app window.
 * @param {string} url
 */
function isLoopbackUrl(url) {
  try {
    const u = new URL(String(url));
    const h = u.hostname.toLowerCase();
    return (u.protocol === 'http:' || u.protocol === 'https:') &&
      (h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]');
  } catch (_) {
    return false;
  }
}

/**
 * The only thing we add over the web build: a strict Content-Security-Policy
 * as a defence-in-depth layer under server.js's own headers. Script-src has
 * no 'unsafe-inline' — index.html loads every script from src, including
 * boot.js (extracted from a former inline block for exactly this reason).
 */
const BASE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",   // theme swatches use inline style attributes
  "img-src 'self' data: blob:",         // html2pdf rasterises to blob URLs
  "font-src 'self' data:",
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'"
].join('; ');

const CSP_META = BASE_CSP;

/**
 * Forward a native-menu action to the focused window's renderer. The
 * renderer bridge (assets/js/desktop-integration.js) maps it onto the same
 * toolbar buttons a user would click, so menu and UI never diverge.
 * @param {{window?:{webContents:{send:(ch:string,payload:string)=>void}}}} ctx
 * @param {string} action
 */
function sendMenuTo(ctx, action) {
  const win = ctx && ctx.window;
  const alive = win && win.webContents &&
    !(typeof win.isDestroyed === 'function' && win.isDestroyed());
  if (alive) {
    win.webContents.send('desktop:menu', String(action));
  }
}

/**
 * Native application menu. Every item either maps to an action the renderer
 * already implements (via sendMenuTo) or a Chromium role — there is no
 * duplicated editor logic in the main process.
 * @param {object} ctx shared context ({ window, app, instance, ... })
 */
function buildMenuTemplate(ctx) {
  const send = (action) => () => sendMenuTo(ctx, action);
  const isMac = process.platform === 'darwin';

  return [
    {
      label: APP_NAME,
      submenu: [
        { label: 'About dotMDpritter', click: () => showAbout(ctx) },
        { type: 'separator' },
        /* hide/unhide are macOS-only roles; including them elsewhere
           throws when the template is built. */
        ...(isMac ? [{ role: 'hide' }, { role: 'unhide' }, { type: 'separator' }] : []),
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        { label: 'New document', accelerator: 'CmdOrCtrl+N', click: send('file:new') },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: send('file:open') },
        { label: 'Download as .md', accelerator: 'CmdOrCtrl+S', click: send('file:save-md') },
        { type: 'separator' },
        { label: 'Export as PDF', accelerator: 'CmdOrCtrl+Shift+P', click: send('export:pdf') },
        { label: 'Export as Word', click: send('export:doc') },
        { label: 'Export as HTML', accelerator: 'CmdOrCtrl+Shift+H', click: send('export:html') },
        { label: 'Export as Markdown', click: send('export:md') },
        { label: 'Export as plain text', click: send('export:txt') },
        { type: 'separator' },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: send('export:print') }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Editor only', accelerator: 'CmdOrCtrl+Alt+1', click: send('view:editor') },
        { label: 'Split view', accelerator: 'CmdOrCtrl+Alt+2', click: send('view:split') },
        { label: 'Preview only', accelerator: 'CmdOrCtrl+Alt+3', click: send('view:preview') },
        { type: 'separator' },
        { label: 'Toggle notes panel', click: send('view:notes') },
        { label: 'Toggle outline', click: send('view:toc') },
        { label: 'Toggle theme', click: send('view:theme') },
        { type: 'separator' },
        { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' }, { role: 'zoom' },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Open data folder', click: () => openDataFolder(ctx) },
        { type: 'separator' },
        { label: 'About dotMDpritter', click: () => showAbout(ctx) }
      ]
    }
  ];
}

/* --------------------------------------------------------- electron parts */

/**
 * Attach the per-session security and download policies. Called once per
 * window, before the first load, so no request can slip through unguarded.
 */
function applySecurity(ctx, win) {
  const { session, shell } = require('electron');
  const ses = win.webContents.session;

  ses.webRequest.onHeadersReceived(
    { urls: ['http://127.0.0.1:*/*', 'http://localhost:*/*'] },
    (details, callback) => {
      const headers = Object.assign({}, details.responseHeaders, {
        'Content-Security-Policy': [BASE_CSP]
      });
      callback({ responseHeaders: headers });
    }
  );

  /* Downloads (exports) land in a folder the user can always find, with
     collision-safe names. The editor also offers a system save dialog via
     anchors — both are covered by setSavePath. */
  ses.on('will-download', (_event, item) => {
    const dir = desktopPaths(ctx.app).downloads;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* keep default */ }
    let name = String(item.getFilename() || 'download')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'download';
    let target = path.join(dir, name);
    const ext = path.extname(name);
    const stem = path.basename(name, ext);
    let i = 1;
    while (fs.existsSync(target)) target = path.join(dir, `${stem}-${i++}${ext}`);
    try { item.setSavePath(target); } catch (_) { /* user keeps the dialog */ }
    void shell;
  });

  /* window.open / target=_blank: internal URLs open a real app window,
     everything else goes to the user's browser. */
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isLoopbackUrl(url)) {
      createWindow(ctx, { url }).catch(() => {});
      return { action: 'deny' };
    }
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    /* The app is a one-page editor: same-origin reloads are fine, anything
       else is not an in-app navigation. */
    let sameOrigin = false;
    try {
      sameOrigin = !!ctx.baseUrl && new URL(url).origin === new URL(ctx.baseUrl).origin;
    } catch (_) { /* unparseable URL: treat as foreign */ }
    if (sameOrigin) return;
    event.preventDefault();
    if (!isLoopbackUrl(url)) require('electron').shell.openExternal(url).catch(() => {});
  });
}

/** Native About box — no window needed. */
async function showAbout(ctx) {
  const { dialog, app } = require('electron');
  const lines = [
    `${APP_NAME} ${APP_VERSION}`,
    'A beautiful, offline-first Markdown editor with margin notes.',
    '',
    `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
    `Data: ${desktopPaths(ctx.app).data}`,
    '',
    'Released under the MIT licence.'
  ];
  const opts = {
    type: 'info',
    title: 'About dotMDpritter',
    message: APP_NAME,
    detail: lines.join('\n'),
    buttons: ['OK']
  };
  if (ctx.window) dialog.showMessageBox(ctx.window, opts);
  else dialog.showMessageBox(opts);
  void app;
}

/** Reveal the per-user data folder in the OS file manager. */
async function openDataFolder(ctx) {
  const { shell } = require('electron');
  const p = desktopPaths(ctx.app);
  try { fs.mkdirSync(p.data, { recursive: true }); } catch (_) { /* may exist */ }
  await shell.openPath(p.data);
}

function smokeMark(step, extra) {
  if (process.env.DOTMD_DESKTOP_SMOKE !== '1') return;
  try {
    fs.appendFileSync(
      path.join(require('os').tmpdir(), 'dmd-smoke-steps.log'),
      new Date().toISOString() + '  ' + step + (extra ? '  ' + extra : '') + '\n'
    );
  } catch (_) { /* diagnostics only */ }
}

/**
 * Boot (or reuse) the loopback server, then create and load one window.
 * @param {object} ctx shared context; receives app/window/instance/baseUrl
 * @param {{width?:number,height?:number,url?:string,hidden?:boolean}} [opts]
 */
async function createWindow(ctx, opts = {}) {
  smokeMark('createWindow:enter');
  const { BrowserWindow } = require('electron');

  /* One server for the whole app; extra windows reuse it. */
  if (!ctx.instance) {
    const { startServer } = require('../server');
    smokeMark('server:starting');
    ctx.instance = await startServer({
      port: 0,                                       // ephemeral, loopback only
      dataDir: desktopPaths(ctx.app).data,
      quiet: true
    });
    smokeMark('server:listening', 'port=' + ctx.instance.port);
  }
  ctx.baseUrl = 'http://127.0.0.1:' + ctx.instance.port + '/';

  const win = new BrowserWindow({
    width: opts.width || 1280,
    height: opts.height || 820,
    minWidth: 860,
    minHeight: 560,
    backgroundColor: '#0d0f15',                    // theme --bg-1, dark default
    show: false,
    title: APP_NAME,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  });
  ctx.window = win;
  smokeMark('window:created');
  win.webContents.once('did-start-loading', () => smokeMark('renderer:loading'));
  win.webContents.once('did-finish-load', () => smokeMark('renderer:loaded'));
  win.webContents.once('did-fail-load', (_e, code, desc) => smokeMark('renderer:fail-load', code + ' ' + desc));
  win.webContents.once('render-process-gone', (_e, d) => smokeMark('renderer:gone', JSON.stringify(d)));
  win.once('ready-to-show', () => smokeMark('window:ready-to-show'));
  win.on('closed', () => { if (ctx.window === win) ctx.window = null; });

  applySecurity(ctx, win);
  win.once('ready-to-show', () => { if (!opts.hidden) win.show(); });

  await win.loadURL(opts.url || ctx.baseUrl);
  return win;
}

/**
 * Wire IPC + lifecycle, then open the first window. Called from
 * app.whenReady() inside start(); split out for clarity, not for tests.
 * @param {object} ctx shared context
 */
function wireIpc(ctx) {
  const { app, ipcMain, BrowserWindow, shell } = require('electron');

  ipcMain.handle('desktop:get-paths', () => desktopPaths(app));

  ipcMain.handle('desktop:open-data-folder', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    return openDataFolder(ctx);
  });

  ipcMain.handle('desktop:open-external', (event, raw) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    const url = String(raw || '');
    if (!isLoopbackUrl(url)) {
      let ok = false;
      try {
        const u = new URL(url);
        ok = u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:';
      } catch (_) { /* not a URL */ }
      if (ok) shell.openExternal(url).catch(() => {});
    }
    return true;
  });

  ipcMain.handle('desktop:new-window', async (event) => {
    if (!BrowserWindow.fromWebContents(event.sender)) return false;
    await createWindow(ctx, {});
    return true;
  });
}

/**
 * Application entry point. `ctx` is created here and shared with every
 * handler; tests never call this (it requires the real Electron runtime).
 */
function start() {
  const { app, ipcMain, Menu, dialog } = require('electron');

  const ctx = { app, window: null, instance: null, baseUrl: null, closed: false };
  ctx.app = app;

  /* One instance: a second launch focuses the existing window. */
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return ctx;
  }
  app.on('second-instance', () => {
    const win = ctx.window;
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  wireIpc(ctx);

  process.on('unhandledRejection', (reason) => {
    console.error('[desktop] unhandled rejection:', reason);
  });

  app.whenReady().then(async () => {
    smokeMark('app:whenReady');
    try {
      Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(ctx)));
      smokeMark('menu:set');
      await createWindow(ctx, {});
      smokeMark('window:loadURL resolved');
    } catch (err) {
      smokeMark('fatal', String(err && err.stack || err));
      console.error('[desktop] fatal:', err);
      console.error('[desktop] fatal:', err);
      dialog.showErrorBox(
        APP_NAME + ' failed to start',
        String((err && err.stack) || err)
      );
      app.exit(1);
    }
    /* macOS: clicking the dock icon with no window re-creates one. */
    app.on('activate', () => {
      if (!ctx.window) createWindow(ctx, {}).catch(() => {});
    });

    /* Headless smoke test: DOTMD_DESKTOP_SMOKE=1 boots the real app, checks
       the editor actually came up in the renderer, then exits. Results are
       also written to %TEMP%\dmd-smoke-result.json because stdout from a
       GUI process cannot always be captured. */
    if (process.env.DOTMD_DESKTOP_SMOKE === '1') {
      const smokeLog = [];
      const origLog = console.log.bind(console);
      console.log = (...a) => { smokeLog.push(a.join(' ')); origLog(...a); };
      console.error = (...a) => { smokeLog.push('ERR: ' + a.join(' ')); origLog(...a); };
      const { execInFocused } = require('./smoke');
      const smokeFile = path.join(require('os').tmpdir(), 'dmd-smoke-result.json');
      try {
        const code = await execInFocused(ctx);
        fs.writeFileSync(smokeFile, JSON.stringify({ code, log: smokeLog }, null, 2));
        app.exit(code);
      } catch (err) {
        fs.writeFileSync(smokeFile, JSON.stringify({ code: 1, error: String(err && err.stack || err), log: smokeLog }, null, 2));
        app.exit(1);
      }
    }
  });

  app.on('window-all-closed', () => app.quit());

  /* Flush the JSON stores before exiting — mirrors server.js SIGTERM. */
  app.on('will-quit', (event) => {
    if (!ctx.instance || ctx.closed) return;
    event.preventDefault();
    ctx.closed = true;
    Promise.resolve()
      .then(() => ctx.instance.close())
      .then(() => app.quit())
      .catch(() => app.exit(0));
  });

  return ctx;
}

/* Run directly: electron .  (package.json "main" points here).
   NOTE: under `electron .` the entry is loaded by Electron's default app,
   so `require.main === module` is FALSE here — the reliable check is the
   Electron version being present in process.versions. Under plain Node
   (the self-test) it is absent and the app must not boot. */
if (process.versions.electron) start();

module.exports = {
  APP_NAME,
  APP_VERSION,
  desktopPaths,
  isLoopbackUrl,
  BASE_CSP,
  CSP_META,
  sendMenuTo,
  buildMenuTemplate,
  applySecurity,
  openDataFolder,
  showAbout,
  createWindow,
  wireIpc,
  start
};
