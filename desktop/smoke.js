/* =========================================================================
   desktop/smoke.js — headless boot verification for the desktop shell.

   Run with:  DOTMD_DESKTOP_SMOKE=1 npx electron .
   (main.js calls execInFocused() once its first window is ready)

   Verifies, inside the real renderer: the loopback server answered, the
   editor UI mounted, the preload bridge exists, the fetch/API surface
   responds, and — when the app was launched with a Markdown file — that the
   file actually landed in the document store. Exits 0 on success, 1 with a
   failure list on stderr.
   ========================================================================= */
'use strict';

/**
 * Build the renderer check script. When `expectFile` is given (the app was
 * started with a file argument, e.g. via "Open with"), the script also waits
 * up to 5 s for that document to appear in the store.
 * @param {string|null} [expectFile] basename of the file Windows passed in
 * @returns {string} JavaScript source evaluated in the renderer
 */
function checksFor(expectFile) {
  const expect = JSON.stringify(expectFile || null);
  return `(async () => {
  const out = { server: false, ui: false, bridge: false, api: false };
  try {
    out.server = !!document.querySelector('.app') && document.title.includes('dotMDpritter');
    out.ui = !!document.querySelector('#editor') && !!document.querySelector('#preview');
    out.bridge = !!(window.dotmdDesktop && window.dotmdDesktop.isDesktop);
    const r = await fetch('/api/health');
    out.api = r.ok;   // health endpoint answers without a session

    const expect = ${expect};
    if (expect) {
      const deadline = Date.now() + 5000;
      const has = () => !!(window.Store && window.Store.docs &&
        window.Store.docs.some((d) => d && d.name === expect));
      while (Date.now() < deadline && !has()) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      out.file = has();
    }
  } catch (_) { /* reported as failures below */ }
  return out;
})()`;
}

/**
 * Run the renderer checks against the focused window, print a PASS/FAIL
 * line for each, and resolve to a process exit code.
 * @param {{window?:object}} ctx shared shell context
 * @param {{expectFile?:string|null}} [opts] file expected to be open
 * @returns {Promise<number>}
 */
async function execInFocused(ctx, opts = {}) {
  const win = ctx.window;
  const expectFile = opts.expectFile || null;
  const label = (name, v) => console.log((v ? 'OK    ' : 'FAIL  ') + name);
  let results = null;
  let error = null;
  try {
    results = await win.webContents.executeJavaScript(checksFor(expectFile), true);
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
    if (expectFile) label('opened "' + expectFile + '" from the command line', results.file);

    code = (results.server && results.ui && results.bridge && results.api && (!expectFile || results.file)) ? 0 : 1;
  }

  if (code !== 0) {
    /* Headless-safe: no modal dialogs — the failure is in the console and
       in %TEMP%\dmd-smoke-result.json (written by main.js). */
    console.error('smoke test failed; see the result json for details');
  }
  return code;
}

module.exports = { execInFocused, checksFor };
