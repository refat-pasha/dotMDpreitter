/* =========================================================================
   cloudtest.js — drives assets/js/cloud.js (the real browser client module)
   against a live server, to prove the client/server contract holds.
   Run:  node cloudtest.js
   ========================================================================= */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { startServer } = require('./server');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(name, a, b) {
  ok(name, a === b, 'got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b));
}
function section(t) { console.log('\n' + t); }

/* ------------------------------------------------------ the sandbox */

/* A cookie jar so the module sees the same session a browser would. */
let jar = '';
const origFetch = global.fetch;
global.fetch = async (url, init = {}) => {
  const headers = Object.assign({}, init.headers || {});
  if (jar) headers.Cookie = jar;
  const res = await origFetch(url, init);
  const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (sc.length) jar = sc[0].split(';')[0];
  return res;
};

const sandbox = {
  console, setTimeout, clearTimeout, Promise, Error, JSON, Object, Array,
  String, Number, Boolean, Math, Date, RegExp, encodeURIComponent, decodeURIComponent,
  fetch: global.fetch,
  confirm: () => true,
  prompt: () => null
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

vm.runInContext(
  fs.readFileSync(path.join(__dirname, 'assets', 'js', 'cloud.js'), 'utf8'),
  sandbox,
  { filename: 'cloud.js' }
);

const Cloud = sandbox.Cloud;


/* ------------------------------------------------------------- main */

(async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotmd-cloud-'));
  const { port, close } = await startServer({ dataDir, port: 0, quiet: true });

  /* Point the sandbox's fetch at this server. */
  sandbox.fetch = (url, init) => {
    const headers = Object.assign({}, (init && init.headers) || {});
    if (jar) headers.Cookie = jar;
    return origFetch('http://127.0.0.1:' + port + url, Object.assign({}, init, { headers }))
      .then((res) => {
        const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
        if (sc.length) jar = sc[0].split(';')[0];
        return res;
      });
  };

  console.log('dotMDpritter cloud client tests  (port ' + port + ')');

  try {
    section('Signed-out behaviour');
    eq('starts signed out', Cloud.isSignedIn(), false);
    eq('no user object', Cloud.currentUser(), null);

    let err = null;
    try { await Cloud.list(''); } catch (e) { err = e; }
    ok('listing while signed out rejects', !!err && err.code === 'UNAUTHENTICATED', String(err));

    section('Registration and session');
    const user = await Cloud.register({
      email: 'carol@example.com', password: 'a good password', name: 'Carol'
    });
    eq('register returns the user', user.email, 'carol@example.com');
    eq('client is now signed in', Cloud.isSignedIn(), true);

    err = null;
    try { await Cloud.register({ email: 'carol@example.com', password: 'another pass' }); }
    catch (e) { err = e; }
    eq('duplicate registration surfaces the server message', err && err.code, 'EMAIL_TAKEN');

    section('Folders and files');
    let listing = await Cloud.list('');
    eq('root lists one folder', listing.folders.length, 1);
    eq('the default folder is notes', listing.folders[0].name, 'notes');

    await Cloud.createFolder('notes/work');
    await Cloud.createFile('notes/work/report.md', '# Quarterly report\n\nRevenue is up.\n');
    await Cloud.createFile('notes/ideas.md', '# Ideas\n');

    listing = await Cloud.list('notes/work');
    eq('nested folder lists its file', listing.files.length, 1);
    eq('title is extracted from the heading', listing.files[0].title, 'Quarterly report');
    eq('current folder is tracked', Cloud.currentPath(), 'notes/work');

    const opened = await Cloud.openDoc('notes/work/report.md');
    eq('openDoc returns the file name', opened.name, 'report.md');
    ok('openDoc returns the content', opened.content.includes('Revenue is up'));

    section('Saving an editor document');
    await Cloud.createFile('notes/journal.md', '# Journal\n\nEntry one.\n');
    eq('the journal was stored', (await Cloud.list('notes')).files.length, 2);

    await Cloud.writeFile('notes/journal.md', '# Journal\n\nEntry one, revised.\n');
    ok('overwrite persisted', (await Cloud.read('notes/journal.md')).content.includes('revised'));

    section('Rename and delete');
    await Cloud.rename('notes/journal.md', 'diary.md');
    eq('rename took effect',
      (await Cloud.list('notes')).files.some((f) => f.name === 'diary.md'), true);

    await Cloud.remove('notes/ideas.md');
    const after = await Cloud.list('notes');
    eq('delete removed the file', after.files.length, 1);
    eq('the right file remains', after.files[0].name, 'diary.md');

    section('Path encoding');
    const weird = await Cloud.createFile('notes/a b & c.md', 'x');
    eq('spaces and symbols in names are accepted', weird.path, 'notes/a b & c.md');
    eq('and read back correctly', (await Cloud.read('notes/a b & c.md')).name, 'a b & c.md');

    section('Server errors are surfaced');
    err = null;
    try { await Cloud.createFile('notes/nope.exe', 'x'); } catch (e) { err = e; }
    ok('rejected extension raises a typed error',
      err instanceof sandbox.Cloud.ApiError, String(err));
    eq('carrying the server status', err.status, 400);

    err = null;
    try { await Cloud.read('notes/does-not-exist.md'); } catch (e) { err = e; }
    eq('missing file gives 404', err.status, 404);


    section('Settings sync');
    const saved = await Cloud.syncSettings({ theme: 'light', accent: 'cyan', bogus: 1 });
    eq('settings saved', saved.theme, 'light');
    const loaded = await Cloud.loadSettings();
    eq('settings round-trip', loaded.accent, 'cyan');
    ok('unknown keys stripped server-side', !('bogus' in loaded));

    section('Sign out and back in');
    await Cloud.logout();
    eq('signed out', Cloud.isSignedIn(), false);
    err = null;
    try { await Cloud.list(''); } catch (e) { err = e; }
    ok('listing rejects again after sign out', !!err);

    err = null;
    try { await Cloud.login({ email: 'carol@example.com', password: 'wrong password' }); }
    catch (e) { err = e; }
    eq('bad password rejected', err.status, 401);
    eq('with the right code', err.code, 'BAD_CREDENTIALS');

    const back = await Cloud.login({ email: 'carol@example.com', password: 'a good password' });
    eq('can sign back in', back.email, 'carol@example.com');
    ok('files survived the session round trip',
      (await Cloud.list('notes')).files.length >= 1);

    section('Second account is isolated');
    await Cloud.logout();
    await Cloud.register({ email: 'dave@example.com', password: 'another good one' });
    eq('dave starts with an empty folder', (await Cloud.list('notes')).files.length, 0);
    ok('dave has a different user id', Cloud.currentUser().id !== user.id);

    section('Password reset through the client');
    await Cloud.logout();
    const asked = await Cloud.forgotPassword('carol@example.com');
    ok('forgotPassword resolves with a generic message',
      typeof asked.message === 'string' && asked.message.length > 0, JSON.stringify(asked));

    /* The link is only returned to loopback callers, and this harness is one. */
    ok('the loopback caller is shown the dev link', !!asked.devLink, JSON.stringify(asked));
    const token = new URL(asked.devLink).searchParams.get('reset');
    ok('the link carries a token', !!token && token.length >= 32);

    /* The server's policy is length-only (>= 8). Assert that boundary here so
       the rule is pinned down, and confirm a rejected password leaves the
       token usable — a burned token on a bad attempt would lock the user out
       of the very link they just asked for. */
    err = null;
    try { await Cloud.resetPassword(token, 'short'); } catch (e) { err = e; }
    ok('a too-short password is rejected by the server',
      !!err && err.code === 'WEAK_PASSWORD', String(err));
    ok('and the rejection does not burn the token',
      !!err && !/BAD_TOKEN/.test(String(err)), String(err));

    err = null;
    try { await Cloud.resetPassword(token, 'a brand new password'); }
    catch (e) { err = e; }
    ok('resetPassword succeeds', !err, String(err));
    eq('the new password signs in', (await Cloud.login({
      email: 'carol@example.com', password: 'a brand new password'
    })).email, 'carol@example.com');

    err = null;
    try { await Cloud.resetPassword(token, 'yet another one'); } catch (e) { err = e; }
    eq('the token cannot be replayed', err && err.code, 'BAD_TOKEN');

    await Cloud.logout();
    err = null;
    try { await Cloud.login({ email: 'carol@example.com', password: 'a good password' }); }
    catch (e) { err = e; }
    eq('the old password no longer works', err && err.status, 401);
    ok("carol's files survived the reset",
      (await (async () => { await Cloud.login({ email: 'carol@example.com', password: 'a brand new password' }); return Cloud.list('notes'); })())
        .files.some((f) => f.name === 'a b & c.md'));

    section('Reset while already signed in');
    /* Someone who forgot their password may well still have a live session
       when the link arrives. The reset must still work, and it must boot the
       session they were holding — otherwise a stolen-but-open tab would
       survive the owner changing the password. */
    await Cloud.logout();
    await Cloud.login({ email: 'carol@example.com', password: 'a brand new password' });
    eq('signed in before requesting a reset', Cloud.isSignedIn(), true);

    const midAsk = await Cloud.forgotPassword('carol@example.com');
    const midToken = new URL(midAsk.devLink).searchParams.get('reset');
    ok('a reset can be requested while signed in', !!midToken);
    eq('the live session survives merely asking', Cloud.isSignedIn(), true);

    await Cloud.resetPassword(midToken, 'the third password');
    eq('the reset succeeds while signed in', Cloud.isSignedIn(), false);
    err = null;
    try { await Cloud.list(''); } catch (e) { err = e; }
    ok('the pre-existing session was revoked by the reset',
      !!err && err.code === 'UNAUTHENTICATED', String(err));
    eq('and the newest password is the one that works',
      (await Cloud.login({ email: 'carol@example.com', password: 'the third password' })).email,
      'carol@example.com');
    await Cloud.logout();

    section('Reset links do not leak across accounts');
    await Cloud.logout();
    const daveReset = await Cloud.forgotPassword('nobody@example.com');
    eq('an unknown address gets the same message', daveReset.message, asked.message);
    ok('and no link at all', !daveReset.devLink, JSON.stringify(daveReset));
  /* ============================================ static wiring checks

       These catch the nastiest class of bug in a browser app: the UI calls
       a function or an element id that does not exist. Nothing throws, no
       console error appears, and the button simply does nothing. */

    section('Static wiring (ids, Cloud methods, App hooks)');

    const indexHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    const authuiSrc = fs.readFileSync(path.join(__dirname, 'assets', 'js', 'authui.js'), 'utf8');
    const appSrc = fs.readFileSync(path.join(__dirname, 'assets', 'js', 'app.js'), 'utf8');

    const collect = (src, re) => {
      const found = new Set();
      let m;
      const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      while ((m = rx.exec(src))) found.add(m[1]);
      return [...found];
    };

    for (const [label, src] of [['app.js', appSrc], ['authui.js', authuiSrc]]) {
      const ids = collect(src, /\$\('([A-Za-z][\w]*)'\)/g);
      const missing = ids.filter((id) => !indexHtml.includes('id="' + id + '"'));
      ok(label + ': all ' + ids.length + ' element ids exist in index.html',
        missing.length === 0, 'missing: ' + missing.join(', '));
    }

    const cloudCalls = collect(authuiSrc, /Cloud\(\)\.([A-Za-z_]\w*)/g);
    const missingCloud = cloudCalls.filter((m) => typeof Cloud[m] !== 'function');
    ok('authui.js calls only real Cloud methods',
      missingCloud.length === 0, 'missing: ' + missingCloud.join(', '));

    const appBlock = appSrc.slice(appSrc.indexOf('global.App = {'));
    const appKeys = collect(appBlock, /^ {4}([A-Za-z_]\w*):/gm);
    const appCalls = collect(authuiSrc, /global\.App\.([A-Za-z_]\w*)/g);
    const missingApp = appCalls.filter((m) => appKeys.indexOf(m) === -1);
    ok('authui.js calls only real App hooks',
      missingApp.length === 0, 'missing: ' + missingApp.join(', '));

    section('Regression: the bugs that made "save" silently do nothing');

    ok('app.js either receives `global` or never uses it',
      /\(function \(global\)/.test(appSrc) || !/\bglobal\./.test(appSrc),
      'app.js references `global.` but its IIFE takes no such parameter');

    ok('the "Save open doc here" button has its own click handler',
      /btnCloudSave[\s\S]{0,140}addEventListener\(\s*'click'/.test(authuiSrc),
      'btnCloudSave sits outside #cloudTree, so delegated wiring never reaches it');

    const openBlock = appSrc.slice(appSrc.indexOf('openFromCloud:'), appSrc.indexOf('openFromCloud:') + 900);
    ok('openFromCloud reuses an existing tab instead of always creating one',
      openBlock.includes('setContent') && openBlock.includes('dirtyIds'),
      'reopening a cloud file would add a duplicate tab every time');

    ok('every method named in wireTree has a handler',
      /case 'save': AuthUI\.saveActiveHere\(\); break;/.test(authuiSrc));

  } catch (e) {
    console.error('\nHarness error:', e && e.stack ? e.stack : e);
    fail++;
  } finally {
    await close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log('\n' + '-'.repeat(52));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('-'.repeat(52) + '\n');
  process.exit(fail === 0 ? 0 : 1);
})();

