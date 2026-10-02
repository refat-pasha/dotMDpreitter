/* =========================================================================
   markdown.js \u2014 parsing, rendering, outline extraction, plain-text
   conversion and document statistics.
   Exposes a single global: window.MD
   ========================================================================= */
(function (global) {
  'use strict';

  if (global.marked && typeof global.marked.setOptions === 'function') {
    global.marked.setOptions({ gfm: true, breaks: false, pedantic: false });
  }

  var ALLOWED_TAGS = [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'strong', 'em', 'del',
    'ins', 'mark', 'sub', 'sup', 'blockquote', 'ul', 'ol', 'li', 'a', 'img',
    'code', 'pre', 'kbd', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
    'caption', 'colgroup', 'col', 'span', 'div', 'input', 'label', 'section',
    'figure', 'figcaption', 'details', 'summary', 'abbr', 'dl', 'dt', 'dd',
    'small', 'u', 's', 'hgroup', 'ruby', 'rt', 'rp', 'bdi', 'bdo', 'wbr',
    'cite', 'time', 'video', 'audio', 'source', 'iframe'
  ];

  var PURIFY_CONFIG = {
    ALLOWED_TAGS: ALLOWED_TAGS,
    ALLOWED_ATTR: [
      'href', 'title', 'src', 'alt', 'width', 'height', 'align', 'class', 'id',
      'type', 'checked', 'disabled', 'start', 'colspan', 'rowspan', 'target',
      'rel', 'lang', 'dir', 'open', 'controls', 'allow', 'loading', 'style'
    ],
    ALLOW_DATA_ATTR: false,
    ADD_ATTR: ['target', 'rel'],
    FORBID_TAGS: ['style', 'form', 'button', 'script', 'object', 'embed', 'base', 'link', 'meta'],
    FORBID_ATTR: ['srcset', 'formaction', 'ping']
  };

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function slugify(text) {
    return String(text)
      .toLowerCase()
      .replace(/<[^>]*>/g, '')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 64) || 'section';
  }


  /* ---------------------------------------------------------------- API */

  /* A GFM task marker: an unordered or ordered list item whose first content
     is "[ ]" or "[x]". The capture groups are (prefix)(marker)(rest). */
  var TASK_RE = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/;

  /**
   * Find the source line behind the Nth rendered task checkbox.
   *
   * The preview renders one checkbox per task list item, in document order, so
   * the Nth checkbox maps to the Nth task line in the source. Fenced code is
   * skipped because a "- [ ]" inside a code block is not a task item.
   * @param {string} src Markdown source
   * @param {number} index zero-based checkbox index
   * @returns {{line:number, start:number, end:number}|null}
   */
  function findTaskLine(src, index) {
    var lines = String(src == null ? '' : src).split('\n');
    var seen = 0;
    var fence = null;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);

      if (fenceMatch) {
        if (fence === null) fence = fenceMatch[1].charAt(0);
        else if (fenceMatch[1].charAt(0) === fence) fence = null;
        continue;
      }
      if (fence !== null) continue;

      var m = TASK_RE.exec(line);
      if (!m) continue;
      if (seen === index) {
        return { line: i, start: m[1].length, end: m[1].length + 1 };
      }
      seen++;
    }
    return null;
  }

  var MD = {
    escapeHtml: escapeHtml,
    findTaskLine: findTaskLine,

    /**
     * Set the checked state of one task item in a Markdown source.
     * @param {string} src
     * @param {number} index zero-based task index
     * @param {boolean} checked
     * @returns {string} the updated source, or the original when the index is unknown
     */
    setTaskChecked: function (src, index, checked) {
      var target = findTaskLine(src, index);
      if (!target) return src;

      var lines = String(src).split('\n');
      var line = lines[target.line];
      lines[target.line] =
        line.slice(0, target.start) + (checked ? 'x' : ' ') + line.slice(target.end);
      return lines.join('\n');
    },

    /**
     * Render Markdown source to a sanitized HTML string.
     * @param {string} src
     * @param {{typography?: boolean}} [opts]
     * @returns {string} safe HTML
     */
    render: function (src, opts) {
      if (!src || !String(src).trim()) return '';

      var options = opts || {};
      var input = options.typography === false ? String(src) : MD.typography(String(src));

      var html;
      try {
        html = global.marked.parse(input, { async: false });
      } catch (err) {
        console.error('[markdown] parse failed', err);
        return '<pre class="md-error">' + escapeHtml(String(src)) + '</pre>';
      }

      html = MD.postProcess(html);

      if (global.DOMPurify) {
        html = global.DOMPurify.sanitize(html, PURIFY_CONFIG);
      } else {
        console.warn('[markdown] DOMPurify unavailable \u2014 skipping sanitisation');
      }
      return html;
    },

    /**
     * DOM-level enhancements that are easier on a live element:
     * heading ids, code highlighting, external links, task lists.
     * @param {HTMLElement} root
     */
    enhance: function (root) {
      if (!root) return;

      /* --- heading ids --- */
      var used = Object.create(null);
      root.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(function (h) {
        var base = slugify(h.textContent.trim());
        var id = base;
        var n = 2;
        while (used[id]) id = base + '-' + n++;
        used[id] = true;
        h.id = id;
      });

      /* --- code blocks: wrap, label, copy button, highlight --- */
      root.querySelectorAll('pre > code').forEach(function (code) {
        var pre = code.parentNode;
        if (!pre) return;
        if (pre.parentNode && pre.parentNode.classList.contains('code-block')) return;

        var wrap = document.createElement('div');
        wrap.className = 'code-block';
        pre.parentNode.insertBefore(wrap, pre);
        wrap.appendChild(pre);

        var m = /language-([\w+#-]+)/.exec(code.className || '');
        var lang = m ? m[1] : '';

        if (lang) {
          var label = document.createElement('span');
          label.className = 'code-lang';
          label.textContent = lang;
          wrap.appendChild(label);
        }

        var btn = document.createElement('button');
        btn.className = 'code-copy';
        btn.type = 'button';
        btn.setAttribute('aria-label', 'Copy code');
        btn.innerHTML = '<svg class="ic sm" aria-hidden="true"><use href="#i-save"/></svg><span>Copy</span>';
        btn.addEventListener('click', function () { MD.copyCode(btn, code.textContent); });
        wrap.appendChild(btn);

        if (lang && global.hljs) {
          try {
            global.hljs.highlightElement(code);
          } catch (e) {
            console.warn('[markdown] highlight failed for "' + lang + '"', e);
          }
        }
      });

      /* --- external links open safely in a new tab --- */
      root.querySelectorAll('a[href]').forEach(function (a) {
        var href = a.getAttribute('href') || '';
        if (/^(https?:)?\/\//i.test(href)) {
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
        }
      });

      /* --- task lists ---
         Ticking a box writes the change back into the Markdown source
         ("- [ ]" <-> "- [x]") so the state survives a re-render, an
         autosave and a cloud save. Each box is given the source line it
         came from by taskLineIndex(). */
      root.querySelectorAll('li input[type="checkbox"]').forEach(function (box, index) {
        box.disabled = false;
        var li = box.closest('li');
        if (li) {
          li.classList.add('task-list-item');
          li.classList.toggle('is-done', box.checked);
        }
        box.addEventListener('change', function () {
          if (li) li.classList.toggle('is-done', box.checked);
          if (typeof MD.onTaskToggle === 'function') MD.onTaskToggle(index, box.checked);
        });
      });
    },

    /* Copy helper used by the code copy buttons. */
    copyCode: function (btn, text) {
      var span = btn.querySelector('span');
      var done = function () {
        btn.classList.add('is-done');
        if (span) span.textContent = 'Copied';
        setTimeout(function () {
          btn.classList.remove('is-done');
          if (span) span.textContent = 'Copy';
        }, 1600);
      };
      if (global.navigator.clipboard && global.navigator.clipboard.writeText) {
        global.navigator.clipboard.writeText(text)
          .then(done, function () { MD.fallbackCopy(text); done(); });
      } else {
        MD.fallbackCopy(text);
        done();
      }
    },

    fallbackCopy: function (text) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) { console.warn('[markdown] copy failed', e); }
      document.body.removeChild(ta);
    },

    /**
     * Build a flat outline from rendered headings.
     * @param {HTMLElement} root
     * @returns {{id:string,text:string,depth:number}[]}
     */
    outline: function (root) {
      if (!root) return [];
      return Array.prototype.map.call(
        root.querySelectorAll('h1, h2, h3, h4, h5, h6'),
        function (h) {
          return {
            id: h.id,
            text: (h.textContent || '').trim(),
            depth: Number(h.tagName.slice(1))
          };
        }
      );
    },

    /** Strip Markdown down to readable plain text. */
    toPlainText: function (src) {
      if (!src) return '';
      var text = String(src);

      text = text.replace(/^```[\s\S]*?^```/gm, function (block) {
        return block.replace(/^```[\w+#-]*\n?/gm, '').replace(/```\s*$/gm, '');
      });
      text = text.replace(/`([^`\n]+)`/g, '$1');
      text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
      text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
      text = text.replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1');
      text = text.replace(/^\s{0,3}>\s?/gm, '');
      text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '');
      text = text.replace(/^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/gm, '---');
      text = text.replace(/^\s{0,3}[-*+]\s+/gm, '\u2022 ');
      text = text.replace(/^\s{0,3}(\d+)[.)]\s+/gm, '$1. ');
      text = text.replace(/^(\u2022|\d+\.)\s*\[([ xX])\]\s+/gm, '$1 ');
      text = text.replace(/(\*\*|__)(.*?)\1/g, '$2');
      text = text.replace(/(\*|_)(.*?)\1/g, '$2');
      text = text.replace(/~~(.*?)~~/g, '$1');
      text = text.replace(/==(.*?)==/g, '$1');
      text = text.replace(/^\s*\|(.+)\|\s*$/gm, function (row) {
        return row.replace(/\|/g, '  ').replace(/\s{2,}/g, '  ').trim();
      });
      text = text.replace(/^\s*[-:|\s]{3,}$/gm, '');
      text = text.replace(/\n{3,}/g, '\n\n');
      return text.trim();
    },

    /** Word / character / reading-time statistics. */
    stats: function (src) {
      var raw = typeof src === 'string' ? src : '';
      var plain = MD.toPlainText(raw);
      var words = plain ? (plain.match(/[^\s]+/g) || []).length : 0;
      return {
        words: words,
        chars: raw.length,
        charsNoSpace: raw.replace(/\s/g, '').length,
        lines: raw ? raw.split('\n').length : 0,
        minutes: words ? Math.max(1, Math.round(words / 220)) : 0
      };
    },

    /**
     * Typographic refinements applied to the *source* before parsing so that
     * exported output matches the preview exactly.
     */
    typography: function (src) {
      var parts = String(src).split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g);

      return parts.map(function (chunk) {
        if (/^(```|~~~|`)/.test(chunk)) return chunk;

        /* Work line-by-line so tables and rules are never rewritten. */
        return chunk.split('\n').map(function (line) {
          if (MD.isTableDelimiter(line) || MD.isThematicBreak(line)) return line;

          /* em dash / en dash */
          line = line.replace(/(\s)--(\s)/g, '$1\u2014$2');
          line = line.replace(/(\w)\s--\s(\w)/g, '$1 \u2014 $2');
          line = line.replace(/(^|\s)---(\s|$)/g, '$1\u2014$2');

          /* ellipsis */
          line = line.replace(/\.\.\.(\s|$)/g, '\u2026$1');

          /* smart quotes */
          line = line.replace(/(^|[\s(\[{>"'\u2014\u2013])"/g, '$1\u201C');
          line = line.replace(/"/g, '\u201D');
          line = line.replace(/(^|[\s(\[{'\u2014\u2013])'/g, '$1\u2018');
          line = line.replace(/'/g, '\u2019');

          /* multiplication sign & arrow */
          line = line.replace(/(\d)\s?[xX]\s?(\d)/g, '$1 \u00D7 $2');
          line = line.replace(/->/g, '\u2192');

          return line;
        }).join('\n');
      }).join('');
    },

    /**
     * True for a GFM table delimiter row, e.g. "| --- | :---: |"
     * or "---". These must never be typographically rewritten.
     */
    isTableDelimiter: function (line) {
      var t = String(line).trim();
      if (!t) return false;
      if (t.charAt(0) !== '|' && t.charAt(t.length - 1) !== '|') return false;
      if (t.indexOf('-') === -1) return false;
      return /^\|?[\s:|-]+\|[\s:|-]*$/.test(t) && /-{2,}/.test(t);
    },

    /**
     * True for a Markdown thematic break ("---", "***", "___").
     */
    isThematicBreak: function (line) {
      return /^\s{0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/.test(String(line));
    },

    /**
     * Small HTML rewrites that run *before* sanitisation because they
     * introduce markup the document author did not write.
     */
    postProcess: function (html) {
      /* ==highlight== */
      html = html.replace(/==([^=\n]+)==/g, '<mark>$1</mark>');

      /* ~~strike~~ that marked missed (e.g. inside tables) */
      html = html.replace(/(^|[\s(])~~([^~\n]+)~~/g, '$1<del>$2</del>');

      /* GFM task lists. marked already emits the checkbox, so make sure the
         <li> carries our class here too -- the export pipeline renders
         without calling enhance(). */
      html = html.replace(/<li>(\s*<input[^>]*type="checkbox"[^>]*>)/g,
        '<li class="task-list-item">$1');

      /* Non-GFM variants: a literal "[ ]" that marked left as text. */
      html = html.replace(/<li>\s*\[([ xX])\]\s?/g, function (_m, state) {
        var checked = state.toLowerCase() === 'x' ? ' checked' : '';
        return '<li class="task-list-item"><input type="checkbox" disabled' + checked + '> ';
      });
      html = html.replace(/<li>\s*<p>\[([ xX])\]\s?/g, function (_m, state) {
        var checked = state.toLowerCase() === 'x' ? ' checked' : '';
        return '<li class="task-list-item"><p><input type="checkbox"' + checked + '> ';
      });

      return html;
    }
  };

  global.MD = MD;
})(window);
