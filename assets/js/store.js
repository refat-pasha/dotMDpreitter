/* =========================================================================
   store.js \u2014 application state, documents, notes and persistence.
   Exposes a single global: window.Store
   ========================================================================= */
(function (global) {
  'use strict';

  var LS_DOCS = 'dotmdpritter.docs.v1';
  var LS_ACTIVE = 'dotmdpritter.active.v1';
  var LS_SETTINGS = 'dotmdpritter.settings.v1';

  var DEFAULT_SETTINGS = {
    theme: 'dark',          // dark | light | system
    accent: 'indigo',
    font: 'sans',           // sans | serif | mono
    fontSize: 17,
    view: 'split',          // editor | split | preview
    zoom: 1,
    sidebar: true,
    notesOpen: false,
    syncScroll: true,
    autoSave: true,
    typography: true,
    lineNums: false
  };

  function uid() {
    return 'x' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
  }

  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var val = JSON.parse(raw);
      return (val === null || val === undefined) ? fallback : val;
    } catch (e) {
      console.warn('[store] could not read "' + key + '":', e);
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      // Quota exceeded, or storage unavailable (private mode / file://).
      console.warn('[store] could not write "' + key + '":', e);
      return false;
    }
  }

  function makeDoc(name, content) {
    var now = Date.now();
    return {
      id: uid(),
      name: name || 'untitled.md',
      content: typeof content === 'string' ? content : '',
      notes: [],
      createdAt: now,
      updatedAt: now,
      lastSavedAt: 0
    };
  }

  function normalizeNote(n) {
    return {
      id: n.id,
      quote: typeof n.quote === 'string' ? n.quote : '',
      text: typeof n.text === 'string' ? n.text : '',
      color: typeof n.color === 'string' ? n.color : 'amber',
      createdAt: Number(n.createdAt) || Date.now(),
      updatedAt: Number(n.updatedAt) || Date.now()
    };
  }

  function isValidNote(n) {
    return n && typeof n === 'object' && typeof n.id === 'string';
  }

  function sanitizeDoc(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
      id: (typeof raw.id === 'string' && raw.id) ? raw.id : uid(),
      name: (typeof raw.name === 'string' && raw.name.trim()) ? raw.name : 'untitled.md',
      content: typeof raw.content === 'string' ? raw.content : '',
      notes: Array.isArray(raw.notes) ? raw.notes.filter(isValidNote).map(normalizeNote) : [],
      createdAt: Number(raw.createdAt) || Date.now(),
      updatedAt: Number(raw.updatedAt) || Date.now(),
      lastSavedAt: Number(raw.lastSavedAt) || 0
    };
  }

  /* -------------------------------------------------------------- Store */

  var Store = {
    docs: [],
    activeId: null,
    settings: Object.assign({}, DEFAULT_SETTINGS),
    _listeners: { change: [], save: [] },
    _saveTimer: null,

    /* ---- lifecycle ---- */

    init: function () {
      var raw = readJSON(LS_DOCS, null);
      var list = Array.isArray(raw) ? raw.map(sanitizeDoc).filter(Boolean) : [];

      if (!list.length) list = [makeDoc('welcome.md', Store.WELCOME)];

      this.docs = list;
      this.settings = Object.assign({}, DEFAULT_SETTINGS, readJSON(LS_SETTINGS, {}));

      var wanted = readJSON(LS_ACTIVE, null);
      this.activeId = this.docs.some(function (d) { return d.id === wanted; })
        ? wanted
        : this.docs[0].id;

      return this;
    },

    /* ---- pub/sub ---- */

    on: function (event, fn) {
      if (this._listeners[event]) this._listeners[event].push(fn);
      var self = this;
      return function () { self.off(event, fn); };
    },

    off: function (event, fn) {
      var arr = this._listeners[event];
      if (!arr) return;
      var i = arr.indexOf(fn);
      if (i > -1) arr.splice(i, 1);
    },

    emit: function (event, payload) {
      var arr = this._listeners[event] || [];
      arr.slice().forEach(function (fn) {
        try { fn(payload); } catch (e) { console.error('[store] listener error on "' + event + '"', e); }
      });
    },

    /* ---- documents ---- */

    get active() {
      var id = this.activeId;
      return this.docs.find(function (d) { return d.id === id; }) || null;
    },

    get: function (id) {
      return this.docs.find(function (d) { return d.id === id; }) || null;
    },

    create: function (name, content, options) {
      var doc = makeDoc(name, content);
      this.docs.push(doc);
      var opts = options || {};
      if (opts.activate !== false) this.activeId = doc.id;
      this.persist();
      this.emit('change', { reason: 'create', doc: doc });
      return doc;
    },

    activate: function (id) {
      if (!this.get(id) || this.activeId === id) return;
      this.activeId = id;
      writeJSON(LS_ACTIVE, id);
      this.emit('change', { reason: 'activate', doc: this.active });
    },

    close: function (id) {
      var i = this.docs.findIndex(function (d) { return d.id === id; });
      if (i === -1) return null;

      var removed = this.docs.splice(i, 1)[0];
      if (!this.docs.length) this.docs.push(makeDoc('untitled.md', ''));

      if (this.activeId === id) {
        this.activeId = (this.docs[i] || this.docs[i - 1] || this.docs[0]).id;
        writeJSON(LS_ACTIVE, this.activeId);
      }
      this.persist();
      this.emit('change', { reason: 'close', doc: removed });
      return removed;
    },

    rename: function (id, name) {
      var doc = this.get(id);
      if (!doc || !name || !name.trim()) return;
      doc.name = name.trim();
      doc.updatedAt = Date.now();
      this.persist();
      this.emit('change', { reason: 'rename', doc: doc });
    },

    setContent: function (id, content) {
      var doc = this.get(id);
      if (!doc || doc.content === content) return false;
      doc.content = content;
      doc.updatedAt = Date.now();
      this.persist();
      return true;
    },

    markSaved: function (id) {
      var doc = this.get(id);
      if (!doc) return;
      doc.lastSavedAt = Date.now();
      this.persist();
    },

    /* ---- notes ---- */

    addNote: function (docId, quote, text) {
      var doc = this.get(docId);
      if (!doc) return null;
      var note = normalizeNote({
        id: uid(),
        quote: quote || '',
        text: text || '',
        color: 'amber',
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
      doc.notes.push(note);
      doc.updatedAt = Date.now();
      this.persist();
      this.emit('change', { reason: 'note-add', doc: doc, note: note });
      return note;
    },

    updateNote: function (docId, noteId, patch) {
      var doc = this.get(docId);
      if (!doc) return null;
      var note = doc.notes.find(function (n) { return n.id === noteId; });
      if (!note) return null;
      Object.assign(note, patch, { updatedAt: Date.now() });
      doc.updatedAt = Date.now();
      this.persist();
      this.emit('change', { reason: 'note-update', doc: doc, note: note });
      return note;
    },

    removeNote: function (docId, noteId) {
      var doc = this.get(docId);
      if (!doc) return false;
      var before = doc.notes.length;
      doc.notes = doc.notes.filter(function (n) { return n.id !== noteId; });
      if (doc.notes.length === before) return false;
      doc.updatedAt = Date.now();
      this.persist();
      this.emit('change', { reason: 'note-remove', doc: doc, noteId: noteId });
      return true;
    },

    /* ---- settings ---- */

    setSetting: function (key, value) {
      if (!(key in DEFAULT_SETTINGS)) {
        console.warn('[store] unknown setting "' + key + '"');
        return;
      }
      this.settings[key] = value;
      writeJSON(LS_SETTINGS, this.settings);
      this.emit('change', { reason: 'setting', key: key, value: value });
    },

    setSettings: function (patch) {
      Object.assign(this.settings, patch);
      writeJSON(LS_SETTINGS, this.settings);
      this.emit('change', { reason: 'settings', patch: patch });
    },

    /* ---- persistence (debounced) ---- */

    persist: function (immediate) {
      var self = this;
      if (this._saveTimer) clearTimeout(this._saveTimer);

      var run = function () {
        var ok = writeJSON(LS_DOCS, self.docs);
        self.emit('save', { ok: ok });
      };

      if (immediate) run();
      else this._saveTimer = setTimeout(run, 500);
    },

    clearAll: function () {
      try {
        localStorage.removeItem(LS_DOCS);
        localStorage.removeItem(LS_ACTIVE);
        localStorage.removeItem(LS_SETTINGS);
      } catch (e) { /* storage unavailable \u2014 nothing to clear */ }
    },

    storageBytes: function () {
      try { return (localStorage.getItem(LS_DOCS) || '').length; }
      catch (e) { return 0; }
    }
  };

  /* -------------------------------------------------------------- sample */

  Store.WELCOME = [
    '# Welcome to dotMDpritter',
    '',
    'A **beautiful**, offline-first Markdown studio. Drop a `.md` file anywhere on this',
    'window and it opens instantly. Everything you write is autosaved to this browser.',
    '',
    '---',
    '',
    '## Getting started',
    '',
    '| Action | Shortcut |',
    '| --- | :---: |',
    '| New document | `Ctrl` + `N` |',
    '| Open a `.md` file | `Ctrl` + `O` |',
    '| Download as `.md` | `Ctrl` + `S` |',
    '| Attach a note to a selection | `N` |',
    '| Toggle theme | `Ctrl` + `Alt` + `D` |',
    '',
    '> **Tip:** select any text in the preview pane and press <kbd>N</kbd> to pin a',
    '> margin note to it. Notes are saved with the document and can be exported.',
    '',
    '## What you get',
    '',
    '- [x] Live split-view editing with synced scrolling',
    '- [x] GitHub-flavoured Markdown (tables, task lists, footnotes)',
    '- [ ] Task you can tick right here in the preview',
    '- [x] Syntax-highlighted code blocks with a copy button',
    '- [x] Margin notes that travel with the document',
    '',
    '### Code looks good too',
    '',
    '```javascript',
    'const greet = (name) => {',
    '  const hour = new Date().getHours();',
    '  const part = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";',
    '  return `Good ${part}, ${name}!`;',
    '};',
    '',
    'console.log(greet("Markdown"));',
    '```',
    '',
    '```sql',
    "SELECT u.name, COUNT(o.id) AS orders, SUM(o.total) AS revenue",
    'FROM users u',
    'LEFT JOIN orders o ON o.user_id = u.id',
    "WHERE o.created_at >= NOW() - INTERVAL '30 days'",
    'GROUP BY u.name',
    'ORDER BY revenue DESC',
    'LIMIT 10;',
    '```',
    '',
    '## Exporting',
    '',
    'Use the **Export** menu in the top-right to download your work as:',
    '',
    '1. **PDF** \u2014 paginated and print-ready',
    '2. **Word (`.doc`)** \u2014 opens straight into Microsoft Word',
    '3. **HTML** \u2014 a single self-contained file',
    '4. **Markdown** \u2014 optionally with your notes appended',
    '5. **Plain text** \u2014 all markup stripped',
    '',
    '### Some formatting to admire',
    '',
    '> \u201CSimplicity is the ultimate sophistication.\u201D',
    '> \u2014 attributed to Leonardo da Vinci',
    '',
    'Inline `code`, ~~strikethrough~~, ==highlight==, **bold**, *italic*,',
    '`inline_code()`, and [links](https://commonmark.org).',
    '',
    '---',
    '',
    '*Ready when you are \u2014 start typing, or open your own file.*'
  ].join('\n');

  global.Store = Store;
})(window);
