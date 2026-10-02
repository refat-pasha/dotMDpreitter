/* =========================================================================
   notes.js \u2014 margin notes: attach to a text selection in the preview,
   render the note rail, jump between notes, and serialise to Markdown.
   Exposes a single global: window.Notes
   ========================================================================= */
(function (global) {
  'use strict';

  var COLOR_LABEL = {
    amber: 'Amber', emerald: 'Green', rose: 'Red', cyan: 'Blue', violet: 'Violet'
  };

  var Notes = {
    /** Currently highlighted note id (preview + rail stay in sync). */
    activeId: null,
    /** Last captured selection, so `N` works even without a live selection. */
    _lastSelection: null,

    /* ---------------------------------------------------------- capture */

    /**
     * Read the current selection from the preview and remember it.
     * @returns {{text:string,start:number,end:number}|null}
     */
    captureSelection: function () {
      var sel = global.getSelection ? global.getSelection() : null;
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return Notes._lastSelection;

      var range = sel.getRangeAt(0);
      var preview = document.getElementById('preview');
      if (!preview) return null;

      /* Only accept selections that live inside the rendered document. */
      var container = range.commonAncestorContainer;
      var host = (container.nodeType === 1 ? container : container.parentElement);
      if (!host || !preview.contains(host)) return Notes._lastSelection;

      var text = sel.toString().trim();
      if (!text) return Notes._lastSelection;

      Notes._lastSelection = {
        text: text.slice(0, 400),
        start: range.startOffset,
        end: range.endOffset
      };
      return Notes._lastSelection;
    },

    /** Drop the cached selection (called when the doc/preview changes). */
    clearSelection: function () {
      Notes._lastSelection = null;
    },

    /** Highlight the text a note is attached to inside the preview. */
    highlight: function (root, note) {
      if (!root || !note || !note.quote) return;
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      var needle = note.quote.trim();
      if (!needle) return;

      var node;
      while ((node = walker.nextNode())) {
        var idx = node.nodeValue.indexOf(needle);
        if (idx === -1) continue;

        var range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + needle.length);

        var mark = document.createElement('mark');
        mark.className = 'anchor';
        mark.dataset.noteId = note.id;
        mark.title = note.text || 'Note';
        try {
          range.surroundContents(mark);
        } catch (e) {
          /* Selection spans element boundaries \u2014 fall back to a partial wrap. */
          mark.appendChild(node.splitText(idx));
          mark.appendChild(node.splitText(0));
          range.insertNode(mark);
        }
        return mark;
      }
    },

    /**
     * Apply all notes of a document as <mark class="anchor"> elements.
     * @param {HTMLElement} root
     * @param {Array} notes
     */
    applyHighlights: function (root, notes) {
      if (!root || !notes || !notes.length) return;

      /* Work from the most specific quote upward so nested notes behave. */
      var ordered = notes.slice().sort(function (a, b) {
        return (b.quote || '').length - (a.quote || '').length;
      });
      ordered.forEach(function (note) { Notes.highlight(root, note); });

      root.addEventListener('click', function (e) {
        var mark = e.target.closest && e.target.closest('mark.anchor');
        if (mark && mark.dataset.noteId) Notes.focus(mark.dataset.noteId, { scroll: true });
      });
    },


    /* ------------------------------------------------------------ focus */

    /**
     * Highlight a note in the rail and in the preview.
     * @param {string} id
     * @param {{scroll?:boolean}} [opts]
     */
    focus: function (id, opts) {
      var options = opts || {};
      Notes.activeId = id;

      document.querySelectorAll('.note-card').forEach(function (card) {
        card.classList.toggle('is-active', card.dataset.noteId === id);
      });
      document.querySelectorAll('mark.anchor').forEach(function (m) {
        m.classList.toggle('is-active', m.dataset.noteId === id);
      });

      if (!options.scroll) return;

      var esc = global.CSS && global.CSS.escape ? global.CSS.escape(id) : id;
      var card = document.querySelector('.note-card[data-note-id="' + esc + '"]');
      if (card) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

      var mark = document.querySelector('mark.anchor[data-note-id="' + esc + '"]');
      if (mark) mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
    },

    /** Move to the next/previous note relative to the current position. */
    cycle: function (doc, dir) {
      if (!doc || !doc.notes.length) return null;
      var i = doc.notes.findIndex(function (n) { return n.id === Notes.activeId; });
      var next = (i + dir + doc.notes.length * 2) % doc.notes.length;
      var note = doc.notes[next];
      Notes.focus(note.id, { scroll: true });
      return note;
    },

    /* ---------------------------------------------------------- render */

    /**
     * Render the notes rail for a document.
     * @param {object} refs  {list, hint, count}
     * @param {object} doc
     * @param {(id:string, text:string)=>void} onEdit
     * @param {(id:string)=>void} onDelete
     */
    renderRail: function (refs, doc, onEdit, onDelete) {
      var notes = (doc && doc.notes) || [];
      var listEl = refs.list, hintEl = refs.hint, countEl = refs.count;

      countEl.textContent = String(notes.length);
      hintEl.hidden = notes.length > 0;

      listEl.innerHTML = '';

      notes.forEach(function (note, index) {
        var card = document.createElement('div');
        card.className = 'note-card' + (note.id === Notes.activeId ? ' is-active' : '');
        card.dataset.noteId = note.id;
        card.style.borderLeftColor = Notes.colorValue(note.color);

        var quote = document.createElement('button');
        quote.type = 'button';
        quote.className = 'note-quote';
        quote.textContent = note.quote || '(no quoted text)';
        quote.title = 'Jump to this text in the document';
        quote.addEventListener('click', function () { Notes.focus(note.id, { scroll: true }); });
        card.appendChild(quote);

        var body = document.createElement('textarea');
        body.className = 'note-body';
        body.value = note.text;
        body.placeholder = 'Write your note\u2026';
        body.rows = 2;
        body.setAttribute('aria-label', 'Note ' + (index + 1) + ' text');
        body.addEventListener('input', function () { onEdit(note.id, body.value); });
        body.addEventListener('focus', function () { Notes.focus(note.id, { scroll: false }); });
        card.appendChild(body);

        var foot = document.createElement('div');
        foot.className = 'note-foot';

        var date = document.createElement('span');
        date.className = 'note-date';
        date.textContent = Notes.formatDate(note.updatedAt || note.createdAt);
        date.title = date.textContent;
        foot.appendChild(date);

        var jump = document.createElement('button');
        jump.type = 'button';
        jump.title = 'Jump to text';
        jump.setAttribute('aria-label', 'Jump to text');
        jump.innerHTML = '<svg class="ic sm"><use href="#i-eye"/></svg>';
        jump.addEventListener('click', function () { Notes.focus(note.id, { scroll: true }); });
        foot.appendChild(jump);

        var del = document.createElement('button');
        del.type = 'button';
        del.className = 'del';
        del.title = 'Delete note';
        del.setAttribute('aria-label', 'Delete note');
        del.innerHTML = '<svg class="ic sm"><use href="#i-trash"/></svg>';
        del.addEventListener('click', function () { onDelete(note.id); });
        foot.appendChild(del);

        card.appendChild(foot);
        listEl.appendChild(card);
      });
    },

    /* --------------------------------------------------------- helpers */

    colorValue: function (name) {
      var map = {
        amber: '#f59e0b', emerald: '#10b981',
        rose: '#f43f5e', cyan: '#06b6d4', violet: '#8b5cf6'
      };
      return map[name] || map.amber;
    },

    formatDate: function (ts) {
      if (!ts) return '';
      var d = new Date(ts);
      if (isNaN(d.getTime())) return '';
      var diff = (Date.now() - ts) / 1000;
      if (diff < 60) return 'just now';
      if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
      if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
      if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    },

    /**
     * Serialise a document's notes as a Markdown appendix.
     * @param {object} doc
     * @returns {string}
     */
    toMarkdown: function (doc) {
      var notes = (doc && doc.notes) || [];
      if (!notes.length) return '';

      var lines = ['', '---', '', '## Notes', ''];

      notes.forEach(function (note, i) {
        var n = i + 1;
        if (note.quote) {
          lines.push('> ' + note.quote.replace(/\n+/g, ' '));
          lines.push('');
        }
        var text = (note.text || '').trim();
        if (text) {
          text.split('\n').forEach(function (line) { lines.push(n + '. ' + line); });
        } else {
          lines.push('*' + n + '. (empty note)*');
        }
        lines.push('');
      });

      lines.push('---', '');
      lines.push('<sub>Notes captured with dotMDpritter on ' +
        new Date().toLocaleString() + '</sub>', '');

      return lines.join('\n');
    },

    /** Total notes across every stored document. */
    totalAcrossDocs: function (docs) {
      return (docs || []).reduce(function (sum, d) {
        return sum + (d.notes ? d.notes.length : 0);
      }, 0);
    }
  };

  global.Notes = Notes;
})(window);
