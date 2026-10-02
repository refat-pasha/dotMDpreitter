# Release checklist — dotMDpritter

## Status

All source files parse, the headless self-test suite passes (70/70), and the
app was verified in a real browser (Chromium) against the local dev server.

## Verified in-browser

- App grid layout, top bar, tabs, outline sidebar, notes rail, status bar
- Split editor/preview panes honour `--editor-fr` (50/50)
- `app.css` fully parses (279 top-level rules, no swallowed blocks)
- GFM tables, headings, blockquotes, `hr`, `kbd`, task lists, `==highlight==`
- `highlight.js` colouring + language label + copy button on fenced code
- Editor -> preview scroll sync (1200px preview -> 1036px editor, proportional)
- Outline scroll-spy highlights the current heading
- Word/char/line/reading-time statistics
- No console errors

## Bugs found and fixed during verification

1. `app.css` — a truncated rule swallowed ~650 lines (sidebar, panes, editor,
   preview, markdown, notes, statusbar, modal, responsive, print). Fixed.
2. `app.css` — `.markdown-body` base rule and `.app.smooth-scroll` were lost
   in the damaged tail; restored.
3. `app.js` — `icon()` returns a string but was passed to `appendChild()`.
   Added `iconEl()`.
4. `app.js` — scroll sync ping-ponged between panes. Replaced the
   requestAnimationFrame guard with a time-based lock.
5. `store.js` — `this.active` is a getter but was called as `this.active()`.
   This threw on every tab switch. Fixed.
6. `markdown.js` — typography rewrote `---` inside table delimiter rows and
   thematic breaks, destroying tables and horizontal rules. Added
   `isTableDelimiter()` / `isThematicBreak()` guards and made the pass
   line-aware.
7. `markdown.js` — task-list `<li>` lost its class outside `enhance()`, so
   exports (which skip `enhance()`) rendered unstyled checkboxes. Moved the
   class into `postProcess()`.
8. `markdown.js` — `toPlainText()` left `[x]` / `[ ]` markers in the .txt
   export. Now stripped.
9. All source files — PowerShell round-tripping had double-encoded UTF-8, so
   em dashes and smart quotes were stored as their CP1252 mis-decoding. Every
   source file is now normalised to ASCII plus `\uXXXX` escapes.
10. `server.js` — added `ETag` / `Last-Modified` and 304 handling so the
    browser revalidates instead of serving stale assets.

---

## Phase 2 — accounts, folders and multi-user storage

### Verified

- **103** API assertions over real HTTP against a live server
  (`apitest.js`): registration, validation, login, logout, session cookies,
  password hashing on disk, password change, per-user settings, folder and
  file CRUD, seven path-traversal attacks, account isolation, auth guards on
  every protected route, and the static allow-list.
- **42** assertions driving the *real* `assets/js/cloud.js` client module
  against a live server (`cloudtest.js`): the client/server contract, typed
  errors, path encoding, session round-trips, and a second account seeing an
  empty tree.
- Manual end-to-end run against the running server: register, create a nested
  folder, save two files, list (titles extracted), read back, rename, sync
  settings, traversal blocked, logout, 401 afterwards. Confirmed the files
  land on disk at `data/users/<id>/notes/projects/*.md` and that
  `users.json` contains only a scrypt hash.
- All JS parses; `app.css`/`theme.css` brace-balanced; `index.html` tag
  balanced; all 121 element ids referenced by the client exist.

### Bugs found and fixed in phase 2

11. `api.js` — **`return promise` inside a `try` block does not catch the
    rejection.** Every async dispatch (`register`, `login`, `logout`,
    `changePassword`, `files`) bypassed the error handler, so a validation
    error surfaced as `500 Internal error` instead of `400`. Fixed with
    `return await`.
12. `api.js` — `randomId` was used but never imported, so registration threw
    `ReferenceError` and returned 500.
13. `api.js` — `GET /api/files/<folder>` was unroutable (the handler required
    a third path segment), so listing any non-root folder 404'd.
14. `storage.js` — `resolve()` treated the final path segment as a *file*, so
    folder listings failed extension validation. Replaced the boolean
    `folder` option with an explicit `kind: 'file' | 'folder' | 'any'`.
15. `server.js` — used the deprecated `url.parse()`, which Node warns is
    "prone to errors that have security implications". Switched to the WHATWG
    `URL` API.
16. `server.js` — the static file **deny-list** missed `runall.js`,
    `cloudtest.js` and `package.json`, which were served over HTTP. Replaced
    with an allow-list; a deny-list silently leaks any file added later.
17. `api.js` — the registration limit of 5/hour counted *validation failures*,
    so a few typo'd signups locked out a whole NAT'd office. Raised to 20.
18. `authui.js` — referenced input ids (`authEmail`, `authPassword`) that
    never existed, because each auth form owns its own fields.

### Deliberate design decisions

- **Percent-encoded `..` in a JSON body is literal text, not traversal.** The
  body path is a logical path, not a URL. The test asserts containment
  instead of rejection, which is the actual security property.
- **Registration is deliberately lenient (20/hour/IP).** The limit stops
  scripted mass-signup; it is not meant to inconvenience a small team sharing
  one address.
- **Sessions store only the SHA-256 of the token**, so a leaked
  `sessions.json` cannot be replayed.
- **Unknown emails still perform a full scrypt verification** against a dummy
  hash, so response timing cannot enumerate accounts.
- **Settings sync is explicit, not per-keystroke.** Preferences push on
  sign-in; documents save on demand via "Save here", so the editor stays
  usable offline.

### Known limitations (phase 2)

- No email verification. Password reset *is* implemented, but sending a
  verification email on registration would mean mail is configured for
  everyone, and it is deliberately optional.
- No file version history or conflict resolution: last write wins. Two
  browsers editing the same cloud file will overwrite each other.
- The data store is a JSON file. It is correct for a small team and is
  written atomically, but it is not a database — not meant for thousands of
  accounts or concurrent writers. Swap `server/db.js` for SQLite if needed.
- Sessions cannot be revoked individually (no "sign out everywhere" without
  changing the password, which does revoke them all).
- CSRF protection is a required custom header plus `SameSite=Strict`; a
  synchroniser token would be stronger.
- **Password strength is length-only: 8 characters, no composition rules.**
  `aaaaaaaa` is accepted. Adding "one capital, one digit" would be a one-line
  change in `server/api.js` (`MIN_PASSWORD` sits next to the check), but it is
  a deliberate trade-off: this app is for a small trusted team, and a strict
  rule mostly pushes people toward `Password1!`, which is worse.
- `DOTMD_SECURE=1` must be set behind TLS or the cookie lacks `Secure`.

### Known limitations (phase 1, still true)

- PDF export rasterises via html2canvas. Remote images need CORS headers
  (`useCORS` is on, but the host must allow it); relative images work. Very
  long documents take a few seconds. The bundled html2pdf build exposes no
  `.on('progress')`, so the progress bar in the export toast does not animate;
  the export itself is unaffected.
- The `.doc` export is Word-compatible HTML. Word does not honour modern CSS
  (colour-mix, grid) and degrades to simpler styling by design.
- Task checkboxes in the preview are editable and write `- [x]` / `- [ ]` back
  into the Markdown source, so they autosave and reach the cloud. Ticking a box
  only rewrites the *marker*; editing the text of a task is still done in the
  editor.
- Local autosave is per-browser `localStorage`; there is no offline cloud
  cache, so clearing site data clears local documents.
- Drag-and-drop only accepts `.md/.markdown/.mdown/.mkd/.txt`; other files are
  skipped with a toast rather than silently ignored.
- `color-mix()` is used for accent tints, so browsers older than ~2023 fall
  back to literal accent colours.

## Run

```bash
node server.js          # http://localhost:4173
npm test                # all three suites, 324 assertions
```

Opening `index.html` directly via `file://` still works for the editor, but
accounts and folders need the server.

## Verification gap

The Playwright MCP server became unavailable partway through this work, so the
**auth gate, account menu and cloud file tree were never clicked in a real
browser** — their visual layout is unverified. Everything they call is
covered: `cloud.js` is tested directly against a live server, and all 121
element ids referenced by the client exist in `index.html`. A visual pass over
the sign-in screen and the Cloud tab is the first thing to do.

