/* =========================================================================
   assets/js/desktop-integration.js — native window bridge (Electron).

   Loaded by both the web app and the desktop app. In a plain browser
   window.dotmdDesktop does not exist and this file does nothing, so the
   web build stays untouched. Inside the desktop shell it:

     - executes native menu commands by clicking the same toolbar buttons
       a user would click (no duplicate action logic),
     - adds an "Open data folder" button to Settings → Data, revealing
       where the desktop build stores accounts and documents.

   The bridge is created by desktop/preload.js with contextIsolation on:
   the renderer never sees Node or Electron directly.
   ========================================================================= */
'use strict';

(function () {
  var desk = window.dotmdDesktop;
  if (!desk || !desk.isDesktop) return;

  /* Native menu action → the toolbar button that owns the behaviour.
     Keys must match the actions sent by desktop/main.js. */
  var ACTIONS = {
    'file:new':      '#btnNew',
    'file:open':     '#btnOpen',
    'file:save-md':  '#btnSaveMd',

    'view:editor':   '#viewSeg [data-view="editor"]',
    'view:split':    '#viewSeg [data-view="split"]',
    'view:preview':  '#viewSeg [data-view="preview"]',
    'view:notes':    '#btnNotes',
    'view:toc':      '#btnToc',
    'view:theme':    '#btnTheme',
    'view:zoom-in':  '#zoomIn',
    'view:zoom-out': '#zoomOut',

    'export:pdf':    '[data-export="pdf"]',
    'export:doc':    '[data-export="doc"]',
    'export:html':   '[data-export="html"]',
    'export:md':     '[data-export="md"]',
    'export:txt':    '[data-export="txt"]',
    'export:print':  '[data-export="print"]'
  };

  desk.onMenu(function (action) {
    var selector = ACTIONS[action];
    if (!selector) return;
    var el = document.querySelector(selector);
    if (el) el.click();
  });

  /* Settings → Data: reveal the per-user data folder in the file manager. */
  window.addEventListener('DOMContentLoaded', function () {
    try {
      var modal = document.getElementById('settingsModal');
      var group = modal && modal.querySelector('.set-group .set-row.btns');
      if (!group || document.getElementById('btnOpenDataFolder')) return;

      var btn = document.createElement('button');
      btn.id = 'btnOpenDataFolder';
      btn.className = 'btn btn-ghost';
      btn.type = 'button';
      btn.textContent = 'Open data folder';
      btn.addEventListener('click', function () { desk.openDataFolder(); });
      group.appendChild(btn);

      desk.getPaths().then(function (paths) {
        if (!paths || !paths.data) return;
        var foot = modal.querySelector('.modal-foot .muted');
        if (foot) foot.title = 'Desktop data folder: ' + paths.data;
      }).catch(function () {});
    } catch (_) { /* settings DOM may change; never break boot */ }
  });
})();
