/* =========================================================================
   desktop/smoke.js — headless boot verification for the desktop shell.

   Run with:  DOTMD_DESKTOP_SMOKE=1 npx electron .
   (main.js calls execInFocused() once its first window is ready)

   Verifies, inside the real renderer: the loopback server answered, the
   editor UI mounted, the preload bridge exists, and the fetch/API surface
   responds. Exits 0 on success, 1 with a failure list on stderr.
   ========================================================================= */
'use strict';

const CHECKS = `(async () => {
  const out = { server: false, ui: false, bridge: false, api: false };
  try {
    out.server = !!document.querySelector('.app') && document.title.includes('dotMDpritter');
    out.ui = !!document.querySelector('#editor') && !!document.querySelector('#preview');
    out.bridge = !!(window.dotmdDesktop && window.dotmdDesktop.isDesktop);
    const r = await fetch('/api/health');
    out.api = r.ok;   // health endpoint answers without a session
  } catch (_) { /* reported as failures below */ }
  return out;
})()`;

/**
 * Run the renderer checks against the focused window, print a PASS/FAIL
 * line for each, and resolve to a process exit code.
 * @param {{window?:object}} ctx shared shell context
 * @returns {Promise<number>}
 */
async function execInFocused(ctx) {
  const win = ctx.window;
  const label = (name, v) => console.log((v ? 'OK    ' : 'FAIL  ') + name);
  let results = null;
  let error = null;
  try {
    results = await win.webContents.executeJavaScript(CHECKS, true);
  } catch (err) {
    error = err;
  }

  let code = 0;
  if (!results) {
    console.error('FAIL  renderer never answered: ' + (error && error.message));
    code = 1;
  } else {
    label('server serves the app', results.server);
    label('editor UI mounted', results.ui);
    label('preload bridge present', results.bridge);
    label('API responds', results.api);
    code = (results.server && results.ui && results.bridge && results.api) ? 0 : 1;
  }

  if (code !== 0) {
    /* Headless-safe: no modal dialogs — the failure is in the console and
       in %TEMP%\dmd-smoke-result.json (written by main.js). */
    console.error('smoke test failed; see the result json for details');
  }
  return code;
}

module.exports = { execInFocused, CHECKS };
