/* =========================================================================
   assets/js/boot.js — last script to run.
   AuthUI starts once the editor has booted, so the cloud panel can
   open documents immediately. (Extracted from the inline script that used
   to live at the bottom of index.html so the desktop shell can enforce a
   script-src 'self' content-security policy.)
   ========================================================================= */
'use strict';

window.addEventListener('DOMContentLoaded', function () {
  window.AuthUI.init().then(function () {
    if (window.App) window.App.pullSettingsFromServer();
  });
});
