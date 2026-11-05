#!/usr/bin/env node
/* =========================================================================
   desktop/desktop-selftest.js — self-tests for the Electron shell.

   Everything that can be tested without an Electron runtime is tested here
   with plain Node asserts: the pure helpers in desktop/main.js, the icon
   codecs in build/gen-icon.js, and the packaging-facing invariants
   (package.json main field, electron-builder.yml targets, preload bridge
   surface, menu accelerator wiring, index.html script hygiene).

   Run:  node desktop/desktop-selftest.js
   ========================================================================= */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;
function ok(cond, name) {
  if (!cond) { failed++; console.error('FAIL  ' + name); process.exitCode = 1; }
  else { passed++; console.log('OK    ' + name); }
}

/* ------------------------------------------------- desktop/main.js pure */

const desktop = require('./main');
const genIcon = require('../build/gen-icon');

/* desktopPaths: with a fake app object. */
{
  const fakeApp = { getPath: (n) => (n === 'userData' ? '/tmp/fake-user-data' : '/tmp/other') };
  const p = desktop.desktopPaths(fakeApp);
  ok(p.base === '/tmp/fake-user-data', 'desktopPaths uses app userData as base');
  ok(p.data === path.join('/tmp/fake-user-data', 'data'), 'desktopPaths data is base/data');
  ok(p.downloads === path.join('/tmp/fake-user-data', 'downloads'), 'desktopPaths downloads is base/downloads');

  /* Without an app (plain Node) it must not throw and must end in data/. */
  const p2 = desktop.desktopPaths();
  ok(path.basename(p2.data) === 'data', 'desktopPaths works without Electron');
  ok(p2.base.includes(desktop.APP_NAME), 'desktopPaths fallback uses the app name');
}

/* isLoopbackUrl. */
ok(desktop.isLoopbackUrl('http://127.0.0.1:45123/') === true, 'isLoopbackUrl accepts 127.0.0.1');
ok(desktop.isLoopbackUrl('http://localhost:45123/api') === true, 'isLoopbackUrl accepts localhost');
ok(desktop.isLoopbackUrl('http://[::1]:45123/') === true, 'isLoopbackUrl accepts ::1');
ok(desktop.isLoopbackUrl('https://example.com') === false, 'isLoopbackUrl rejects public hosts');
ok(desktop.isLoopbackUrl('file:///C:/Windows/System32') === false, 'isLoopbackUrl rejects file: scheme');
ok(desktop.isLoopbackUrl('') === false, 'isLoopbackUrl rejects empty input');
ok(desktop.isLoopbackUrl('not a url') === false, 'isLoopbackUrl rejects garbage');

/* CSP: no unsafe-inline scripts; styles allowed (theme swatches). */
ok(!/script-src[^;]*'unsafe-inline'/.test(desktop.BASE_CSP),
  'CSP script-src has no unsafe-inline');
ok(/default-src 'self'/.test(desktop.BASE_CSP), 'CSP has default-src self');
ok(/connect-src 'self'/.test(desktop.BASE_CSP), 'CSP locks connect-src to self');
ok(/object-src 'none'/.test(desktop.BASE_CSP), 'CSP disables plugins');
ok(/base-uri 'none'/.test(desktop.BASE_CSP), 'CSP disables base hijacking');

/* sendMenuTo: forwards the action, tolerates dead windows. */
{
  const seen = [];
  const fakeWin = { isDestroyed: () => false, webContents: { send: (ch, a) => seen.push([ch, a]) } };
  desktop.sendMenuTo({ window: fakeWin }, 'file:new');
  ok(seen.length === 1 && seen[0][0] === 'desktop:menu' && seen[0][1] === 'file:new',
    'sendMenuTo forwards action on desktop:menu channel');
  desktop.sendMenuTo({ window: null }, 'file:new');            // no window
  desktop.sendMenuTo({ window: { isDestroyed: () => true, webContents: { send() { throw new Error('no'); } } } }, 'x');
  ok(seen.length === 1, 'sendMenuTo is safe with missing/destroyed windows');
}

/* Menu: every click action has a renderer-side mapping. */
{
  const integration = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'desktop-integration.js'), 'utf8');
  const template = desktop.buildMenuTemplate({ window: null });
  const wanted = new Set();
  const walk = (items) => items.forEach((it) => {
    if (it.submenu) return walk(it.submenu);
    if (typeof it.click === 'function' && !it.role) wanted.add(it.label);
  });
  walk(template);

  const expected = {
    'New document': 'file:new',
    'Open…': 'file:open',
    'Download as .md': 'file:save-md',
    'Export as PDF': 'export:pdf',
    'Export as Word': 'export:doc',
    'Export as HTML': 'export:html',
    'Export as Markdown': 'export:md',
    'Export as plain text': 'export:txt',
    'Print…': 'export:print',
    'Editor only': 'view:editor',
    'Split view': 'view:split',
    'Preview only': 'view:preview',
    'Toggle notes panel': 'view:notes',
    'Toggle outline': 'view:toc',
    'Toggle theme': 'view:theme'
  };
  for (const [label, action] of Object.entries(expected)) {
    ok(wanted.has(label), `menu has "${label}"`);
    ok(integration.includes(`'${action}':`), `renderer maps ${action}`);
  }
  /* About + Open data folder are main-process-only and expected. */
  ok(wanted.size === Object.keys(expected).length + 2,
    'menu has no untested custom actions (' + wanted.size + ' custom items)');
}

/* ---------------------------------------------------------------- icons */

{
  const png = genIcon.encodePng(8, new Buffer.alloc(8 * 8 * 4, 128));
  ok(png.length > 60 && png[0] === 0x89 && png[1] === 0x50, 'encodePng emits a PNG signature');
  const pngBig = genIcon.encodePng(300, new Buffer.alloc(300 * 300 * 4, 1));
  ok(pngBig.readUInt32BE(16) === 300 && pngBig.readUInt32BE(20) === 300,
    'encodePng writes the IHDR dimensions');
  const ico = genIcon.encodeIco(png);
  ok(ico.length === 6 + 16 + png.length, 'encodeIco wraps exactly one PNG entry');
  ok(ico.readUInt16LE(2) === 1 && ico.readUInt16LE(4) === 1, 'encodeIco header: type 1, count 1');
  ok(ico.readUInt32LE(6 + 8) === png.length, 'encodeIco records the PNG size');
  ok(ico.readUInt32LE(6 + 12) === 22, 'encodeIco offset points past header+entry');

  /* SDF primitives. */
  ok(Math.abs(genIcon.sdRoundRect(0.8, 0.5, 0.5, 0.5, 0.3, 0.3, 0.05)) < 1e-9,
    'sdRoundRect is 0 on the right edge');
  ok(genIcon.sdRoundRect(0.5, 0.5, 0.5, 0.5, 0.3, 0.3, 0.05) < -0.29,
    'sdRoundRect is negative (inside) at the centre');
  ok(genIcon.sdRoundRect(0.99, 0.5, 0.5, 0.5, 0.3, 0.3, 0.05) > 0,
    'sdRoundRect is positive outside');
  ok(genIcon.sdSegment(0.5, 0.5, 0, 0, 1, 1, 0) < 1e-9, 'sdSegment is 0 on the line');

  /* Full render: corners transparent, centre opaque. */
  const acc = genIcon.renderMaster(16, 2);
  const at = (x, y) => acc[(y * 16 + x) * 4 + 3];
  ok(at(0, 0) < 8, 'icon corners are transparent');
  ok(at(8, 8) > 200, 'icon centre is opaque');
  ok(at(8, 3) > 200, 'icon sheet area is opaque');

  const buf = genIcon.toBuffer(acc);
  ok(buf.length === 16 * 16 * 4, 'toBuffer returns one RGBA byte per sample');
}

/* ------------------------------------------------- packaging invariants */

{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  ok(pkg.main === 'desktop/main.js', 'package.json main points at the desktop shell');
  ok(pkg.scripts.desktop === 'electron .', 'npm run desktop starts Electron');
  ok(pkg.scripts.icons === 'node build/gen-icon.js', 'npm run icons generates icons');
  ok(pkg.scripts.dist === 'electron-builder --win', 'npm run dist builds installers');
  ok(typeof pkg.devDependencies.electron === 'string', 'electron is a dev dependency');
  ok(pkg.version === desktop.APP_VERSION, 'package.json and shell versions agree');

  const yml = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  ok(/target:\s*\n\s*-\s*target:\s*nsis/.test(yml), 'electron-builder targets NSIS');
  ok(/portable/.test(yml), 'electron-builder targets portable exe');
  ok(/desktop\/\*\*/.test(yml), 'the desktop/ directory ships in the package');
  ok(/server\.js/.test(yml) && /assets\/\*\*/.test(yml) && /vendor\/\*\*/.test(yml),
    'the package ships the whole web app');
  ok(!/^  - data/m.test(yml), 'data/ is not shipped');
  ok(!/docs\/\*\*/.test(yml), 'docs/ screenshots are not shipped');
  ok(/asar:\s*true/.test(yml), 'app is packed into an asar archive');
}

/* The web app must still boot with the desktop bridge absent. */
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  ok(/desktop-integration\.js/.test(html), 'index.html loads the desktop bridge');
  ok(/boot\.js/.test(html), 'index.html loads boot.js');
  ok(!/<script(?![^>]*\ssrc=)[^>]*>/.test(html),
    'index.html has no inline executable code left');
  ok(/Content-Security-Policy/.test(html), 'index.html carries a CSP meta tag');

  const preload = fs.readFileSync(path.join(ROOT, 'desktop', 'preload.js'), 'utf8');
  for (const api of ['isDesktop', 'openExternal', 'openNewWindow', 'getPaths', 'openDataFolder', 'onMenu']) {
    ok(preload.includes(api), `preload exposes ${api}`);
  }
  ok(!preload.includes('nodeIntegration') || !/(require\('fs'\)|require\("fs"\))/.test(preload),
    'preload does not hand raw Node to the renderer');

  const integ = fs.readFileSync(path.join(ROOT, 'assets', 'js', 'desktop-integration.js'), 'utf8');
  ok(/if\s*\(!desk\s*\|\|\s*!desk\.isDesktop\)\s*return;/.test(integ),
    'the bridge no-ops in a plain browser');
}

/* server.js must export startServer with the options the shell uses. */
{
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(/function startServer\(options\s*=\s*\{\}\)/.test(src), 'server.js exposes startServer(options)');
  ok(/module\.exports\s*=\s*\{\s*startServer/.test(src), 'server.js exports startServer');
  ok(/server\.address\(\)\.port/.test(src), 'server.js reports the bound port');
}

/* -------------------------------------------------------------- summary */

console.log('');
if (process.exitCode) {
  console.log(`${passed} passed, ${failed} failed`);
  console.log('');
  console.log('Desktop self-test FAILED');
} else {
  console.log(`${passed} passed, 0 failed`);
  console.log('');
  console.log(`OK    ${passed} passed  desktop shell`);
  console.log('');
  console.log('All desktop checks green');
}
