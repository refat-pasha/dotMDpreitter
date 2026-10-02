/* =========================================================================
   app.js — UI controller: wires the DOM to Store / MD / Notes / Exporters.
   ========================================================================= */
(function (global) {
  'use strict';

  /* ----------------------------------------------------------- refs */

  function $(id) { return document.getElementById(id); }

  var el = {
    app: $('app'),
    tabs: $('tabs'),
    editor: $('editor'),
    preview: $('preview'),
    previewScroll: $('previewScroll'),
    gutter: $('gutter'),
    panes: $('panes'),
    toc: $('toc'),
    tocFilter: $('tocFilter'),
    fileList: $('fileList'),
    notesList: $('notesList'),
    notesHint: $('notesHint'),
    noteCount: $('noteCount'),
    fileInput: $('fileInput'),
    dropOverlay: $('dropOverlay'),
    toasts: $('toasts'),
    exportMenu: $('exportMenu'),
    settingsModal: $('settingsModal'),
    live: $('live'),
    stWords: $('stWords'),
    stChars: $('stChars'),
    stRead: $('stRead'),
    stNotes: $('stNotes'),
    stSave: $('stSave'),
    stPos: $('stPos'),
    stFile: $('stFile'),
    zoomLabel: $('zoomLabel'),
    themeIcon: $('themeIcon'),
    storageInfo: $('setStorageInfo')
  };

  var state = {
    outline: [],
    activeHeading: '',
    renderQueued: false,
    syncingScroll: false,
    scrollLock: 0,
    dirtyIds: Object.create(null)
  };

  var EMPTY_HTML =
    '<div class="md-empty">' +
    '<svg class="ic"><use href="#i-logo"/></svg>' +
    '<h3>Nothing to preview yet</h3>' +
    '<p>Start typing on the left, or drop a <b>.md</b> file anywhere on this window.</p>' +
    '</div>';

  /* -------------------------------------------------------- helpers */

  function debounce(fn, ms) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  function icon(name, cls) {
    return '<svg class="ic ' + (cls || '') + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>';
  }

  /** Build an <svg> element from the sprite (for appendChild targets). */
  function iconEl(name, cls) {
    var wrap = document.createElement('span');
    wrap.style.display = 'contents';
    wrap.innerHTML = icon(name, cls);
    return wrap.firstElementChild;
  }

  function announce(msg) {
    if (el.live) el.live.textContent = msg;
  }

  var ICONS = { ok: 'check', err: 'x', info: 'note' };

  function toast(message, kind) {
    var key = kind || 'info';
    var node = document.createElement('div');
    node.className = 'toast ' + key;
    node.innerHTML = icon(ICONS[key] || 'note') + '<span></span>';
    node.querySelector('span').textContent = message;
    el.toasts.appendChild(node);

    setTimeout(function () {
      node.classList.add('out');
      setTimeout(function () { node.remove(); }, 320);
    }, key === 'err' ? 5200 : 2800);

    announce(message);
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  function relativeTime(ts) {
    if (!ts) return 'never';
    var diff = (Date.now() - ts) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
    return new Date(ts).toLocaleDateString();
  }

  /* ------------------------------------------------- apply settings */

  function resolvedTheme() {
    var pref = Store.settings.theme;
    if (pref === 'system') {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light' : 'dark';
    }
    return pref === 'light' ? 'light' : 'dark';
  }

  function applySettings() {
    var s = Store.settings;
    var theme = resolvedTheme();
    var root = document.documentElement;

    root.setAttribute('data-theme', theme);
    root.setAttribute('data-accent', s.accent || 'indigo');
    root.setAttribute('data-font', s.font || 'sans');
    root.style.setProperty('--fs-body', (s.fontSize || 17) + 'px');
    root.style.setProperty('--zoom', String(s.zoom || 1));

    el.app.classList.toggle('no-sidebar', !s.sidebar);
    el.app.classList.toggle('no-notes', !s.notesOpen);
    el.app.classList.toggle('line-nums', !!s.lineNums);
    el.app.classList.add('smooth-scroll');

    el.panes.setAttribute('data-view', s.view || 'split');
    el.zoomLabel.textContent = Math.round((s.zoom || 1) * 100) + '%';
    el.themeIcon.innerHTML = '<use href="#i-' + (theme === 'dark' ? 'moon' : 'sun') + '"/>';

    document.querySelectorAll('#viewSeg button').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.view === (s.view || 'split'));
    });
    $('btnNotes').classList.toggle('is-on', !!s.notesOpen);
    $('btnToc').classList.toggle('is-on', !!s.sidebar);

    syncSettingsUI();
  }

  function syncSettingsUI() {
    var s = Store.settings;
    setActive('#setTheme', s.theme);
    setActive('#setAccent', s.accent);
    var font = $('setFont'); if (font) font.value = s.font;
    var fs = $('setFs'); if (fs) fs.value = s.fontSize;
    var out = $('setFsOut'); if (out) out.textContent = s.fontSize + 'px';
    $('setScroll').checked = !!s.syncScroll;
    $('setAutoSave').checked = !!s.autoSave;
    $('setTypo').checked = !!s.typography;
    $('setLineNums').checked = !!s.lineNums;
    if (el.storageInfo) {
      el.storageInfo.textContent = 'Local storage: ' + formatBytes(Store.storageBytes());
    }
  }

  function setActive(sel, value) {
    document.querySelectorAll(sel + ' button').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.v === value);
    });
  }


  /* ------------------------------------------------------- rendering */

  function render() {
    state.renderQueued = false;
    var doc = Store.active;
    if (!doc) return;

    var html = MD.render(doc.content, { typography: Store.settings.typography });

    if (html) {
      el.preview.innerHTML = html;
      MD.enhance(el.preview);
      if (doc.notes && doc.notes.length) {
        Notes.applyHighlights(el.preview, doc.notes);
      }
    } else {
      el.preview.innerHTML = EMPTY_HTML;
    }

    buildOutline();
    renderGutter();
    updateStatus();
  }

  function scheduleRender() {
    if (state.renderQueued) return;
    state.renderQueued = true;
    requestAnimationFrame(render);
  }

  /* ------------------------------------------------------- outline */

  function buildOutline() {
    state.outline = MD.outline(el.preview);
    renderToc();
  }

  function renderToc() {
    var filter = (el.tocFilter.value || '').trim().toLowerCase();
    var list = state.outline.filter(function (h) {
      return !filter || h.text.toLowerCase().indexOf(filter) > -1;
    });

    el.toc.innerHTML = '';
    if (!list.length) {
      var empty = document.createElement('div');
      empty.className = 'toc-empty';
      empty.textContent = filter
        ? 'No headings match that filter.'
        : 'Headings from your document will appear here.';
      el.toc.appendChild(empty);
      return;
    }

    list.forEach(function (h) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'toc-item' + (h.id === state.activeHeading ? ' is-active' : '');
      b.dataset.d = String(h.depth);
      b.dataset.target = h.id;
      b.textContent = h.text;
      b.title = h.text;
      b.addEventListener('click', function () { jumpTo(h.id); });
      el.toc.appendChild(b);
    });
  }

  function jumpTo(id) {
    var target = el.preview.querySelector('#' + (window.CSS && CSS.escape ? CSS.escape(id) : id));
    if (!target) return;
    el.previewScroll.scrollTo({
      top: Math.max(0, target.offsetTop - 16),
      behavior: 'smooth'
    });
    setActiveHeading(id);
  }

  function setActiveHeading(id) {
    if (state.activeHeading === id) return;
    state.activeHeading = id;
    el.toc.querySelectorAll('.toc-item').forEach(function (b) {
      b.classList.toggle('is-active', b.dataset.target === id);
    });
  }

  /** Highlight the TOC entry for the heading nearest the top of the view. */
  function spyHeadings() {
    if (!state.outline.length) return;
    var heads = el.preview.querySelectorAll('h1, h2, h3, h4, h5, h6');
    var top = el.previewScroll.scrollTop + 40;
    var current = '';

    for (var i = 0; i < heads.length; i++) {
      if (heads[i].offsetTop <= top) current = heads[i].id;
      else break;
    }
    if (current) setActiveHeading(current);
  }

  /* --------------------------------------------------- line gutter */

  function renderGutter() {
    if (!Store.settings.lineNums) return;
    var lines = el.editor.value.split('\n').length;
    var cur = el.editor.value.slice(0, el.editor.selectionStart).split('\n').length;

    var buf = [];
    for (var i = 1; i <= lines; i++) {
      buf.push(i === cur ? '<span class="cur">' + i + '</span>' : String(i));
    }
    el.gutter.innerHTML = buf.join('\n');
    el.gutter.scrollTop = el.editor.scrollTop;
  }

  /* -------------------------------------------------------- status */

  function updateStatus() {
    var doc = Store.active;
    if (!doc) return;

    var st = MD.stats(doc.content);
    el.stWords.textContent = st.words + (st.words === 1 ? ' word' : ' words');
    el.stChars.textContent = st.chars.toLocaleString() + ' chars';
    el.stRead.textContent = st.minutes + ' min read';
    el.stNotes.textContent = doc.notes.length + (doc.notes.length === 1 ? ' note' : ' notes');
    el.stFile.textContent = doc.name;
    el.stFile.title = doc.name;

    renderGutter();
  }

  function updateCaret() {
    var pos = el.editor.selectionStart || 0;
    var before = el.editor.value.slice(0, pos);
    var lines = before.split('\n');
    el.stPos.textContent = 'Ln ' + lines.length + ', Col ' + (lines[lines.length - 1].length + 1);
  }

  function setSaveState(kind) {
    if (kind === 'saving') {
      el.stSave.textContent = 'Saving…';
      el.stSave.className = 'saving';
    } else {
      el.stSave.textContent = 'All changes saved';
      el.stSave.className = 'saved';
    }
  }


  /* ----------------------------------------------------- doc switch */

  function loadActiveDoc() {
    var doc = Store.active;
    if (!doc) return;

    el.editor.value = doc.content;
    el.previewScroll.scrollTop = 0;
    el.editor.scrollTop = 0;
    Notes.activeId = null;
    Notes.clearSelection();
    state.activeHeading = '';

    applySettings();
    render();
    renderTabs();
    renderFileList();
    renderNotes();
    updateCaret();
  }

  function markDirty(id) {
    state.dirtyIds[id] = true;
    renderTabs();
  }

  function clearDirty(id) {
    delete state.dirtyIds[id];
    renderTabs();
  }

  /* ---------------------------------------------------------- tabs */

  function renderTabs() {
    el.tabs.innerHTML = '';

    Store.docs.forEach(function (doc) {
      var tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'tab' + (doc.id === Store.activeId ? ' is-active' : '');
      tab.title = doc.name + (state.dirtyIds[doc.id] ? ' (unsaved)' : '');
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(doc.id === Store.activeId));

      var dot = document.createElement('span');
      dot.className = 'tab-dirty';
      if (!state.dirtyIds[doc.id]) dot.style.visibility = 'hidden';

      var name = document.createElement('span');
      name.className = 'tab-name';
      name.textContent = doc.name;

      var x = document.createElement('span');
      x.className = 'tab-x';
      x.setAttribute('role', 'button');
      x.setAttribute('aria-label', 'Close ' + doc.name);
      x.innerHTML = icon('x');
      x.addEventListener('click', function (e) {
        e.stopPropagation();
        closeDocument(doc.id);
      });

      tab.appendChild(dot);
      tab.appendChild(name);
      tab.appendChild(x);
      tab.addEventListener('click', function () { Store.activate(doc.id); });
      el.tabs.appendChild(tab);
    });
  }

  function closeDocument(id) {
    var doc = Store.get(id);
    if (!doc) return;

    if (state.dirtyIds[id]) {
      var ok = window.confirm(
        '“' + doc.name + '” has unsaved changes.\n\n' +
        'Close it anyway? (Your work stays in browser storage.)'
      );
      if (!ok) return;
    }
    delete state.dirtyIds[id];
    Store.close(id);
  }

  /* ----------------------------------------------------- file list */

  function renderFileList() {
    el.fileList.innerHTML = '';

    Store.docs.forEach(function (doc) {
      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'file-row' + (doc.id === Store.activeId ? ' is-active' : '');
      row.title = doc.name;

      var body = document.createElement('span');
      body.className = 'fr-body';

      var name = document.createElement('span');
      name.className = 'fr-name';
      name.textContent = doc.name;

      var meta = document.createElement('span');
      meta.className = 'fr-meta';
      meta.textContent = MD.stats(doc.content).words + ' words · ' +
        doc.notes.length + (doc.notes.length === 1 ? ' note' : ' notes') +
        ' · ' + relativeTime(doc.updatedAt);

      body.appendChild(name);
      body.appendChild(meta);
      row.appendChild(iconEl('note'));
      row.appendChild(body);

      var del = document.createElement('span');
      del.className = 'tab-x';
      del.setAttribute('role', 'button');
      del.setAttribute('aria-label', 'Close ' + doc.name);
      del.innerHTML = icon('trash');
      del.addEventListener('click', function (e) { e.stopPropagation(); closeDocument(doc.id); });
      row.appendChild(del);

      row.addEventListener('click', function () { Store.activate(doc.id); });
      el.fileList.appendChild(row);
    });
  }

  /* --------------------------------------------------------- notes */

  function renderNotes() {
    var doc = Store.active;
    Notes.renderRail(
      { list: el.notesList, hint: el.notesHint, count: el.noteCount },
      doc,
      function (id, text) { Store.updateNote(doc.id, id, { text: text }); },
      function (id) { Store.removeNote(doc.id, id); }
    );
  }

  function addNoteFromSelection() {
    var doc = Store.active;
    if (!doc) return;

    var sel = Notes.captureSelection();
    if (!sel || !sel.text) {
      toast('Select some text in the preview first.', 'err');
      return;
    }

    var note = Store.addNote(doc.id, sel.text, '');
    if (!note) return;

    Store.setSetting('notesOpen', true);
    applySettings();
    render();

    renderNotes();
    requestAnimationFrame(function () {
      Notes.focus(note.id, { scroll: true });
      var card = el.notesList.querySelector('.note-card[data-note-id="' + note.id + '"]');
      var ta = card && card.querySelector('.note-body');
      if (ta) ta.focus();
    });

    toast('Note added to “' + sel.text.slice(0, 40) + (sel.text.length > 40 ? '…' : '') + '”', 'ok');
  }


  /* ------------------------------------------------- file opening */

  var MD_EXT = /\.(md|markdown|mdown|mkd|mdtxt|txt)$/i;

  function openFilePicker() { el.fileInput.click(); }

  function handleFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;

    var accepted = files.filter(function (f) {
      return MD_EXT.test(f.name) || /^text\/(markdown|plain)/.test(f.type);
    });

    if (!accepted.length) {
      toast('No Markdown files found in that drop.', 'err');
      return;
    }
    if (accepted.length < files.length) {
      toast('Skipped ' + (files.length - accepted.length) + ' non-Markdown file(s).', 'err');
    }

    var lastDoc = null;
    var remaining = accepted.length;

    accepted.forEach(function (file) {
      file.text()
        .then(function (text) {
          lastDoc = Store.create(file.name, text);
        })
        .catch(function (err) {
          console.error('[open] failed to read ' + file.name, err);
          toast('Could not read “' + file.name + '”.', 'err');
        })
        .finally(function () {
          remaining -= 1;
          if (remaining === 0) {
            if (lastDoc) {
              loadActiveDoc();
              toast('Opened “' + lastDoc.name + '”', 'ok');
            }
          }
        });
    });
  }

  function newDocument() {
    var n = 1;
    while (Store.docs.some(function (d) { return d.name === 'untitled-' + n + '.md'; })) n++;
    Store.create('untitled-' + n + '.md', '# Untitled\n\nStart writing…\n');
    el.editor.focus();
  }

  /* --------------------------------------------- markdown toolbar */

  var ACTIONS = {
    h1:     { line: '# ' },
    ul:     { line: '- ' },
    quote:  { line: '> ' },
    task:   { line: '- [ ] ' },
    hr:     { block: '\n\n---\n\n' },
    table:  { block: '\n| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n| Cell | Cell | Cell |\n' },
    bold:   { wrap: '**', sample: 'bold text' },
    italic: { wrap: '*', sample: 'italic text' },
    code:   { wrap: '`', sample: 'code' },
    link:   { wrap: '[', sample: 'link text', tail: '](https://)' },
    image:  { wrap: '![', sample: 'alt text', tail: '](image.png)' }
  };

  function replaceSelection(text, selStart, selEnd) {
    var start = selStart === undefined ? el.editor.selectionStart : selStart;
    var end = selEnd === undefined ? el.editor.selectionEnd : selEnd;
    el.editor.setRangeText(text, start, end, 'end');
  }

  function mdAction(kind) {
    var a = ACTIONS[kind];
    if (!a) return;

    if (a.line) {
      applyLinePrefix(a.line);
    } else if (a.block) {
      replaceSelection(a.block);
    } else {
      var start = el.editor.selectionStart, end = el.editor.selectionEnd;
      var selected = el.editor.value.slice(start, end) || a.sample;
      var payload = a.wrap + selected + (a.tail || a.wrap);
      replaceSelection(payload);
    }

    el.editor.focus();
    onEditorInput();
  }

  /** Toggle a line prefix across every line the caret touches. */
  function applyLinePrefix(prefix) {
    var value = el.editor.value;
    var start = el.editor.selectionStart;
    var end = el.editor.selectionEnd;

    var from = value.lastIndexOf('\n', start - 1) + 1;
    var toIdx = value.indexOf('\n', end);
    if (toIdx === -1) toIdx = value.length;
    var to = toIdx;

    var block = value.slice(from, to);
    var lines = block.split('\n');
    var allPrefixed = lines.every(function (l) { return l.indexOf(prefix) === 0; });

    var next = lines.map(function (line) {
      return allPrefixed ? line.slice(prefix.length) : prefix + line;
    }).join('\n');

    el.editor.setRangeText(next, from, to, 'preserve');
    el.editor.selectionStart = from;
    el.editor.selectionEnd = from + next.length;
  }

  /* ------------------------------------------------ editor events */

  function onEditorInput() {
    var doc = Store.active;
    if (!doc) return;

    if (Store.setContent(doc.id, el.editor.value)) markDirty(doc.id);

    setSaveState('saving');
    scheduleRender();
    renderFileListDebounced();
    updateCaret();
    debouncedCaret();
  }

  var renderFileListDebounced = debounce(renderFileList, 800);
  var debouncedCaret = debounce(renderGutter, 200);

  /* Ticking a checkbox in the preview rewrites the "- [ ]" / "- [x]" marker
     in the source, so the tick is part of the document: it survives a
     re-render, gets autosaved locally and is written to the cloud. */
  MD.onTaskToggle = function (index, checked) {
    var doc = Store.active;
    if (!doc) return;

    var next = MD.setTaskChecked(doc.content, index, checked);
    if (next === doc.content) return;

    Store.setContent(doc.id, next);

    /* Keep the textarea in step without stealing the caret from whatever the
       reader is doing in the preview. */
    if (el.editor.value !== next) {
      var pos = el.editor.selectionStart;
      el.editor.value = next;
      try { el.editor.setSelectionRange(pos, pos); } catch (e) { /* detached */ }
    }

    markDirty(doc.id);
    setSaveState('saving');
    renderFileListDebounced();
    announce(checked ? 'Task marked done.' : 'Task marked not done.');
  };


  /* ------------------------------------------------- scroll syncing */

  /* A short time-based lock stops the two panes from fighting each other:
     a programmatic scroll on one side would otherwise fire an event that
     scrolls the other side straight back. */
  function locked() { return Date.now() < state.scrollLock; }
  function lock() { state.scrollLock = Date.now() + 140; }

  function syncEditorToPreview() {
    if (!Store.settings.syncScroll || locked()) return;
    if (Store.settings.view !== 'split') return;

    var e = el.editor;
    var maxE = e.scrollHeight - e.clientHeight;
    var maxP = el.previewScroll.scrollHeight - el.previewScroll.clientHeight;
    if (maxE <= 0 || maxP <= 0) return;

    lock();
    el.previewScroll.scrollTop = (e.scrollTop / maxE) * maxP;
    spyHeadings();
  }

  function syncPreviewToEditor() {
    if (!Store.settings.syncScroll || locked()) return;
    if (Store.settings.view !== 'split') return;

    var p = el.previewScroll;
    var maxP = p.scrollHeight - p.clientHeight;
    var maxE = el.editor.scrollHeight - el.editor.clientHeight;
    if (maxP <= 0 || maxE <= 0) return;

    lock();
    el.editor.scrollTop = (p.scrollTop / maxP) * maxE;
    el.gutter.scrollTop = el.editor.scrollTop;
    spyHeadings();
  }

  /* ------------------------------------------------------ resizing */

  function makeResizer(handle, onMove) {
    handle.addEventListener('mousedown', function (e) {
      e.preventDefault();
      document.body.classList.add('resizing');

      function move(ev) { onMove(ev.clientX); }
      function up() {
        document.body.classList.remove('resizing');
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        if (Store.settings.autoSave) Store.persist();
      }
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  function setWidth(varName, px) {
    var min = 150;
    var max = Math.max(min + 40, window.innerWidth - 320);
    var clamped = Math.min(max, Math.max(min, px));
    document.documentElement.style.setProperty(varName, clamped + 'px');
  }

  /* ---------------------------------------------------- exporting */

  function runExport(kind) {
    var doc = Store.active;
    if (!doc) return;

    try {
      switch (kind) {
        case 'md':
          clearDirty(doc.id);
          Store.markSaved(doc.id);
          toast('Saved ' + Exporters.md(doc, true), 'ok');
          break;
        case 'txt':
          toast('Saved ' + Exporters.txt(doc), 'ok');
          break;
        case 'html':
          toast('Saved ' + Exporters.html(doc), 'ok');
          break;
        case 'doc':
          clearDirty(doc.id);
          Store.markSaved(doc.id);
          toast('Saved ' + Exporters.doc(doc), 'ok');
          break;
        case 'print':
          clearDirty(doc.id);
          Exporters.print(doc);
          break;
        case 'pdf':
          exportPdf(doc);
          break;
        default:
          console.warn('[export] unknown kind "' + kind + '"');
      }
    } catch (err) {
      console.error('[export] failed', err);
      toast('Export failed: ' + err.message, 'err');
    }
  }

  function exportPdf(doc) {
    var id = toast('Building PDF…', 'info');
    var node = el.toasts.querySelector('.toast:last-child');
    var label = node && node.querySelector('span');
    var lastPct = -1;

    Exporters.pdf(doc, {
      onProgress: function (p) {
        var pct = Math.round(p * 100);
        if (pct !== lastPct && label && pct % 10 === 0) {
          lastPct = pct;
          label.textContent = 'Building PDF… ' + pct + '%';
        }
      }
    }).then(function (name) {
      if (node) node.remove();
      clearDirty(doc.id);
      Store.markSaved(doc.id);
      toast('Saved ' + name, 'ok');
      return id;
    }).catch(function (err) {
      console.error('[export] pdf failed', err);
      if (node) node.remove();
      toast('PDF export failed: ' + (err && err.message ? err.message : 'unknown error'), 'err');
    });
  }

  function exportNotes() {
    var doc = Store.active;
    if (!doc || !doc.notes.length) {
      toast('No notes in this document yet.', 'err');
      return;
    }
    var name = Exporters.baseName(doc.name) + '-notes.md';
    Exporters.download(name, new Blob([Notes.toMarkdown(doc)], { type: 'text/markdown;charset=utf-8' }));
    toast('Saved ' + name, 'ok');
  }

  function exportAllNotes() {
    var md = Exporters.allNotesMarkdown(Store.docs);
    if (!md) {
      toast('No notes anywhere yet.', 'err');
      return;
    }
    Exporters.download('dotMDpritter-notes.md', new Blob([md], { type: 'text/markdown;charset=utf-8' }));
    toast('Saved dotMDpritter-notes.md', 'ok');
  }


  /* ------------------------------------------------------- events */

  function wireTopbar() {
    $('btnNew').addEventListener('click', newDocument);
    $('btnOpen').addEventListener('click', openFilePicker);
    $('btnSaveMd').addEventListener('click', function () { runExport('md'); });

    $('btnExport').addEventListener('click', function (e) {
      e.stopPropagation();
      el.exportMenu.classList.toggle('is-open');
    });
    el.exportMenu.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-export]');
      if (!btn) return;
      el.exportMenu.classList.remove('is-open');
      runExport(btn.dataset.export);
    });

    $('btnNotes').addEventListener('click', function () {
      Store.setSetting('notesOpen', !Store.settings.notesOpen);
      applySettings();
    });
    $('btnToc').addEventListener('click', function () {
      Store.setSetting('sidebar', !Store.settings.sidebar);
      applySettings();
    });
    $('btnTheme').addEventListener('click', function () {
      Store.setSetting('theme', resolvedTheme() === 'dark' ? 'light' : 'dark');
      applySettings();
    });
    $('btnSettings').addEventListener('click', function () {
      syncSettingsUI();
      el.settingsModal.hidden = false;
    });
    $('notesClose').addEventListener('click', function () {
      Store.setSetting('notesOpen', false);
      applySettings();
    });

    document.addEventListener('click', function () { el.exportMenu.classList.remove('is-open'); });
  }

  function wireSidebar() {
    document.querySelectorAll('.side-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        document.querySelectorAll('.side-tab').forEach(function (t) {
          t.classList.toggle('is-active', t === tab);
        });
        document.querySelectorAll('.side-panel').forEach(function (p) {
          p.classList.toggle('is-active', p.dataset.panel === tab.dataset.side);
        });
      });
    });

    el.tocFilter.addEventListener('input', renderToc);
    $('sideDrop').addEventListener('click', openFilePicker);
    $('exportNotesMd').addEventListener('click', exportNotes);
  }

  function wireEditor() {
    el.editor.addEventListener('input', onEditorInput);
    el.editor.addEventListener('scroll', function () {
      el.gutter.scrollTop = el.editor.scrollTop;
      syncEditorToPreview();
    });
    ['keyup', 'click', 'select'].forEach(function (evt) {
      el.editor.addEventListener(evt, function () { updateCaret(); debouncedCaret(); });
    });

    document.getElementById('toolbar').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-md]');
      if (btn) mdAction(btn.dataset.md);
    });

    el.previewScroll.addEventListener('scroll', function () {
      spyHeadings();
      syncPreviewToEditor();
    });

    document.getElementById('viewSeg').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-view]');
      if (!btn) return;
      Store.setSetting('view', btn.dataset.view);
      applySettings();
      requestAnimationFrame(renderGutter);
    });

    $('zoomIn').addEventListener('click', function () { setZoom(Store.settings.zoom + 0.1); });
    $('zoomOut').addEventListener('click', function () { setZoom(Store.settings.zoom - 0.1); });

    makeResizer($('sidebarResizer'), function (x) { setWidth('--sidebar-w', x); });
    makeResizer($('paneResizer'), function (x) {
      var box = el.panes.getBoundingClientRect();
      var pct = ((x - box.left) / box.width) * 100;
      document.documentElement.style.setProperty(
        '--editor-fr', Math.min(85, Math.max(15, pct)) + '%'
      );
    });
  }

  function setZoom(z) {
    var next = Math.min(2, Math.max(0.7, Math.round(z * 10) / 10));
    Store.setSetting('zoom', next);
    applySettings();
  }

  function wireFiles() {
    el.fileInput.addEventListener('change', function () {
      handleFiles(el.fileInput.files);
      el.fileInput.value = '';
    });

    var dragDepth = 0;
    var overlay = el.dropOverlay;

    window.addEventListener('dragenter', function (e) {
      if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') === -1) return;
      dragDepth++;
      overlay.hidden = false;
    });
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('dragleave', function () {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) overlay.hidden = true;
    });
    window.addEventListener('drop', function (e) {
      e.preventDefault();
      dragDepth = 0;
      overlay.hidden = true;
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        handleFiles(e.dataTransfer.files);
      }
    });
  }


  function wireSettings() {
    $('setTheme').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-v]');
      if (!b) return;
      Store.setSetting('theme', b.dataset.v);
      applySettings();
    });
    $('setAccent').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-v]');
      if (!b) return;
      Store.setSetting('accent', b.dataset.v);
      applySettings();
    });
    $('setFont').addEventListener('change', function () {
      Store.setSetting('font', this.value);
      applySettings();
    });
    $('setFs').addEventListener('input', function () {
      Store.setSetting('fontSize', Number(this.value));
      applySettings();
    });

    [['setScroll', 'syncScroll'], ['setAutoSave', 'autoSave'],
     ['setTypo', 'typography'], ['setLineNums', 'lineNums']].forEach(function (pair) {
      $(pair[0]).addEventListener('change', function () {
        Store.setSetting(pair[1], this.checked);
        applySettings();
        if (pair[1] === 'lineNums') renderGutter();
        if (pair[1] === 'typography') render();
      });
    });

    $('setExportAll').addEventListener('click', exportAllNotes);
    $('setClear').addEventListener('click', function () {
      if (!window.confirm('Clear all saved documents, notes and settings?\n\nThis cannot be undone.')) return;
      Store.clearAll();
      window.location.reload();
    });

    document.querySelectorAll('[data-close-modal]').forEach(function (b) {
      b.addEventListener('click', function () { el.settingsModal.hidden = true; });
    });
    el.settingsModal.addEventListener('click', function (e) {
      if (e.target === el.settingsModal) el.settingsModal.hidden = true;
    });
  }


  function wireShortcuts() {
    document.addEventListener('keydown', function (e) {
      var mod = e.ctrlKey || e.metaKey;
      var key = (e.key || '').toLowerCase();

      if (e.key === 'Escape') {
        el.exportMenu.classList.remove('is-open');
        el.settingsModal.hidden = true;
        return;
      }

      /* Ctrl+Alt+… : workspace toggles */
      if (mod && e.altKey) {
        if (key === 'n') { e.preventDefault(); $('btnNotes').click(); return; }
        if (key === 'o') { e.preventDefault(); $('btnToc').click(); return; }
        if (key === 'd') { e.preventDefault(); $('btnTheme').click(); return; }
        return;
      }

      if (mod) {
        switch (key) {
          case 'n': e.preventDefault(); newDocument(); return;
          case 'o': e.preventDefault(); openFilePicker(); return;
          case 's': e.preventDefault(); runExport('md'); return;
          case 'p': e.preventDefault(); runExport('pdf'); return;
          case 'b': if (document.activeElement === el.editor) { e.preventDefault(); mdAction('bold'); } return;
          case 'i': if (document.activeElement === el.editor) { e.preventDefault(); mdAction('italic'); } return;
          case 'k': if (document.activeElement === el.editor) { e.preventDefault(); mdAction('link'); } return;
          case '=': case '+': e.preventDefault(); setZoom(Store.settings.zoom + 0.1); return;
          case '-': e.preventDefault(); setZoom(Store.settings.zoom - 0.1); return;
          case '0': e.preventDefault(); setZoom(1); return;
        }
        return;
      }

      /* Alt+1/2/3 : view modes */
      if (e.altKey && (key === '1' || key === '2' || key === '3')) {
        e.preventDefault();
        var modes = { '1': 'editor', '2': 'split', '3': 'preview' };
        Store.setSetting('view', modes[key]);
        applySettings();
        return;
      }

      /* N : attach a note to the current preview selection */
      if (key === 'n' && !e.altKey) {
        var inEditor = document.activeElement === el.editor;
        var hasSelection = String(window.getSelection() || '').length > 0;
        if (!inEditor && hasSelection) {
          e.preventDefault();
          addNoteFromSelection();
        }
        return;
      }

      /* Alt+ArrowUp/Down : previous / next note */
      if (e.altKey && (key === 'arrowup' || key === 'arrowdown')) {
        var doc = Store.active;
        if (doc && doc.notes.length) {
          e.preventDefault();
          Notes.cycle(doc, key === 'arrowdown' ? 1 : -1);
        }
      }
    });
  }


  /* --------------------------------------------------------- init */

  function init() {
    Store.init();

    Store.on('change', function (payload) {
      if (!payload) return;
      switch (payload.reason) {
        case 'activate':
        case 'create':
        case 'close':
          loadActiveDoc();
          break;
        case 'rename':
          renderTabs();
          renderFileList();
          break;
        case 'setting':
        case 'settings':
          applySettings();
          break;
        case 'note-add':
        case 'note-remove':
          updateStatus();
          break;
      }
    });

    Store.on('save', function (p) { setSaveState(p.ok ? 'saved' : 'saving'); });

    /* Follow the OS colour scheme when the theme setting is "system". */
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: light)');
      var onScheme = function () {
        if (Store.settings.theme === 'system') applySettings();
      };
      if (mq.addEventListener) mq.addEventListener('change', onScheme);
      else if (mq.addListener) mq.addListener(onScheme);
    }

    wireTopbar();
    wireSidebar();
    wireEditor();
    wireFiles();
    wireSettings();
    wireShortcuts();

    window.addEventListener('focus', updateCaret);

    /* Flush pending edits before the tab goes away. */
    window.addEventListener('beforeunload', function (e) {
      Store.persist(true);
      if (!Object.keys(state.dirtyIds).length) return;
      e.preventDefault();
      e.returnValue = '';
    });

    loadActiveDoc();
    setSaveState('saved');

    if (Store.docs.length === 1 && Store.docs[0].name === 'welcome.md') {
      toast('Welcome! Drop a .md file anywhere, or press Ctrl+O.', 'ok');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* Hooks used by cloud.js / authui.js ---------------------------------
     They are defined on the same object the IIFE already built, so the
     cloud panel can open and save documents without knowing about the
     editor's internals. */

  global.App = {
    toast: toast,
    announce: announce,

    /** Snapshot of the document currently in the editor. */
    activeDocSnapshot: function () {
      var doc = Store.active;
      if (!doc) return null;
      return { id: doc.id, name: doc.name, content: doc.content };
    },

    /**
     * Called after a successful cloud write so the tab stops showing as
     * unsaved. The dirty flag is local UI state, so the cloud client cannot
     * clear it on its own.
     * @param {string} id document id
     */
    markSaved: function (id) {
      if (!id) return;
      clearDirty(id);
      Store.markSaved(id);
      setSaveState('saved');
      updateStatus();
    },

    /** Open a file fetched from the server. */
    openFromCloud: function (file) {
      var existing = null;
      for (var i = 0; i < Store.docs.length; i++) {
        if (Store.docs[i].name === file.name) { existing = Store.docs[i]; break; }
      }

      if (!existing) {
        Store.create(file.name, file.content);
        loadActiveDoc();
        return Store.active;
      }

      // Reuse the existing tab rather than opening a second one with the same
      // name. If it holds unsaved edits, ask before throwing them away.
      if (state.dirtyIds[existing.id]) {
        var ok = global.confirm('“' + file.name +
            '” is already open with unsaved changes.\n\nOpen the saved version from your account?');
        if (!ok) return null;
      }

      Store.setContent(existing.id, file.content);
      clearDirty(existing.id);
      Store.activate(existing.id);
      loadActiveDoc();
      return existing;
    },

    /** Settings are mirrored to the account when one is signed in. */
    pushSettingsToServer: function () {
      if (!global.Cloud || !global.Cloud.isSignedIn()) return Promise.resolve(null);
      return global.Cloud.syncSettings(Store.settings).catch(function (err) {
        console.warn('[app] could not sync settings:', err.message);
        return null;
      });
    },

    pullSettingsFromServer: function () {
      if (!global.Cloud || !global.Cloud.isSignedIn()) return Promise.resolve(null);
      return global.Cloud.loadSettings().then(function (settings) {
        if (settings && Object.keys(settings).length) {
          Store.setSettings(settings);
          applySettings();
        }
        return settings;
      }).catch(function () { return null; });
    }
  };
})(window);

