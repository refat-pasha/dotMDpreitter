/* =========================================================================
   exporters.js \u2014 download helpers and document exporters.
   Everything is generated client-side; no network access is required.
   Exposes a single global: window.Exporters
   ========================================================================= */
(function (global) {
  'use strict';

  /* ======================================================== utilities */

  /* Extensions we recognise when deriving a download filename. Kept explicit
     so that names like "v1.2.3" are left alone. */
  var DOC_EXT = /\.(md|markdown|mdown|mkd|mdtxt|txt|html?|docx?)$/i;

  function baseName(name) {
    return String(name || 'document').replace(DOC_EXT, '').trim() || 'document';
  }

  /** Trigger a browser download for a Blob. */
  function download(filename, blob) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* =============================================== standalone document */

  /* Plain hex colours only \u2014 html2canvas (bundled with html2pdf) cannot
     resolve color-mix() or other modern colour syntax, so every export uses
     literal values that the canvas rasteriser understands. */
  var DOC_CSS = [
    '*{box-sizing:border-box;}',
    'body{margin:0;padding:44px 52px;background:#fff;color:#16181d;',
    'font-family:"Segoe UI",system-ui,-apple-system,Helvetica,Arial,sans-serif;',
    'font-size:16px;line-height:1.7;}',
    '.doc{max-width:820px;margin:0 auto;}',
    'h1,h2,h3,h4,h5,h6{color:#0b0d12;line-height:1.25;margin:1.7em 0 .6em;',
    'font-weight:700;letter-spacing:-.02em;page-break-after:avoid;}',
    'h1{font-size:2em;font-weight:800;padding-bottom:.32em;border-bottom:2px solid #e2e6ee;margin-top:0;}',
    'h2{font-size:1.45em;padding-bottom:.28em;border-bottom:1px solid #e2e6ee;}',
    'h3{font-size:1.18em;} h4{font-size:1.04em;} h5{font-size:.95em;}',
    'h6{font-size:.85em;color:#4a5160;text-transform:uppercase;letter-spacing:.06em;}',
    'p{margin:0 0 1.05em;}',
    'a{color:#2563eb;text-decoration:underline;}',
    'strong{color:#0b0d12;font-weight:700;}',
    'ul,ol{margin:0 0 1.05em;padding-left:1.6em;} li{margin:.28em 0;}',
    'hr{height:1px;border:0;margin:2.2em 0;background:linear-gradient(90deg,transparent,#d3d8e2 15%,#d3d8e2 85%,transparent);}',
    'blockquote{margin:1.3em 0;padding:.85em 1.1em;background:#f7f8fc;',
    'border-left:3px solid #4f46e5;border-radius:0 6px 6px 0;color:#4a5160;}',
    'blockquote p:last-child{margin:0;}',
    'code{font-family:"Cascadia Code",Consolas,"SF Mono",Menlo,monospace;font-size:.86em;',
    'padding:.16em .4em;border-radius:4px;background:#eef2ff;color:#3730a3;border:1px solid #dfe3f5;}',
    'pre{background:#f6f7fb;border:1px solid #e2e6ee;border-radius:8px;padding:14px 16px;',
    'margin:1.3em 0;page-break-inside:avoid;}',
    'pre code{background:none;border:0;padding:0;color:#24292f;font-size:.85em;line-height:1.6;',
    'white-space:pre;display:block;}',
    'pre .code-lang{display:block;font-size:10px;letter-spacing:.09em;text-transform:uppercase;',
    'color:#767e8f;margin-bottom:8px;}',
    'table{width:100%;border-collapse:collapse;margin:1.3em 0;font-size:.92em;page-break-inside:avoid;}',
    'th,td{border:1px solid #e2e6ee;padding:8px 11px;text-align:left;}',
    'th{background:#f4f6fa;font-weight:700;color:#0b0d12;}',
    'tbody tr:nth-child(even){background:#fafbfd;}',
    'img{max-width:100%;height:auto;border-radius:8px;display:block;margin:1em 0;}',
    'figure{margin:1.3em 0;} figcaption{font-size:.85em;color:#767e8f;text-align:center;margin-top:.5em;}',
    'mark{background:#fde68a;padding:.05em .25em;border-radius:3px;}',
    'del{color:#767e8f;}',
    '.footnotes{margin-top:2.4em;padding-top:1em;border-top:1px solid #e2e6ee;font-size:.9em;color:#4a5160;}',
    '.footnotes h2{font-size:1.05em;border:0;margin:0 0 .6em;padding:0;}',
    'kbd{font-size:.82em;padding:.1em .4em;border:1px solid #e2e6ee;border-bottom-width:2px;',
    'border-radius:4px;background:#f4f6fa;}',
    'details{border:1px solid #e2e6ee;border-radius:8px;padding:12px 14px;margin:1.2em 0;}',
    'summary{font-weight:700;}',
    /* marked emits class="task-list-item" on the <li> (see MD.postProcess),
       not on the list, so these must key off the item itself. */
    'ul:has(> .task-list-item){list-style:none;padding-left:.4em;}',
    '.task-list-item{display:flex;gap:.55em;align-items:flex-start;}',
    '.task-list-item > input[type="checkbox"]{margin:.5em 0 0;flex:0 0 auto;}',
    '.task-list-item.is-done{color:#8a91a0;text-decoration:line-through;}',
    '.task-list-item.is-done > input[type="checkbox"]{accent-color:#4f46e5;}',
    '.notes-section{margin-top:2.6em;padding-top:1.2em;border-top:2px solid #e2e6ee;}',
    '.notes-section h2{border:0;padding:0;margin-top:0;}',
    '.note-item{margin:0 0 1.1em;padding:12px 14px;background:#f7f8fc;border:1px solid #e2e6ee;',
    'border-left:3px solid #4f46e5;border-radius:6px;page-break-inside:avoid;}',
    '.note-item .nq{margin:0 0 7px;font-style:italic;font-size:.9em;color:#767e8f;',
    'border-bottom:1px dashed #e2e6ee;padding-bottom:7px;}',
    '.note-item .nb{margin:0;white-space:pre-wrap;font-size:.94em;}',
    '.doc-foot{margin-top:3em;padding-top:.9em;border-top:1px solid #e2e6ee;',
    'font-size:11.5px;color:#767e8f;text-align:center;}',
    '@media print{body{padding:0;} .doc{max-width:none;}}',
    '@page{margin:16mm 14mm;}'
  ].join('');

  /**
   * Render the inner markup of an exported document: the rendered Markdown,
   * the notes appendix and the footer. Shared by every export so the HTML,
   * DOC, PDF and print outputs all match.
   * @param {object} doc  store document {name, content, notes}
   * @param {{withNotes?:boolean, codeLabels?:boolean, title?:string}} [opts]
   * @returns {string} inner HTML of the document body
   */
  function bodyHtml(doc, opts) {
    var options = opts || {};
    var name = (doc && doc.name) || 'document';

    var html = global.MD.render((doc && doc.content) || '', { typography: true });

    /* Label fenced code blocks (pre>code[class*=language-]). */
    if (options.codeLabels !== false) {
      try {
        var parsed = new DOMParser().parseFromString('<body>' + html + '</body>', 'text/html');
        var blocks = parsed.body.querySelectorAll('pre > code');
        for (var i = 0; i < blocks.length; i++) {
          var code = blocks[i];
          var m = /language-([\w+#-]+)/.exec(code.className || '');
          if (!m) continue;
          var pre = code.parentNode;
          var label = parsed.createElement('span');
          label.className = 'code-lang';
          label.textContent = m[1];
          pre.insertBefore(label, pre.firstChild);
        }
        html = parsed.body.innerHTML;
      } catch (e) {
        console.warn('[exporters] code labelling skipped:', e);
      }
    }

    /* The live preview marks finished tasks with .is-done in MD.enhance(),
       which exports never run. Add it here so exports agree with the preview. */
    html = html.replace(/<li class="task-list-item">(\s*<input[^>]*checked[^>]*>)/g,
      '<li class="task-list-item is-done">$1');

    var notesHtml = '';
    var notes = (options.withNotes === false) ? [] : ((doc && doc.notes) || []);
    if (notes.length) {
      var parts = ['<section class="notes-section"><h2>Notes</h2>'];
      notes.forEach(function (note) {
        parts.push('<div class="note-item">');
        if (note.quote) parts.push('<p class="nq">' + escapeHtml(note.quote) + '</p>');
        parts.push('<p class="nb">' +
          (note.text ? escapeHtml(note.text) : '<em>(empty note)</em>') + '</p>');
        parts.push('</div>');
      });
      parts.push('</section>');
      notesHtml = parts.join('\n');
    }

    return [
      '<div class="doc">',
      html,
      notesHtml,
      '<div class="doc-foot">',
      escapeHtml(name) + ' &middot; exported with dotMDpritter &middot; ' +
        new Date().toLocaleString(),
      '</div>',
      '</div>'
    ].join('\n');
  }

  /**
   * Build a fully self-contained HTML document string for one Markdown doc.
   * Shared by the HTML, DOC and print exporters.
   * @param {object} doc  store document {name, content, notes}
   * @param {{withNotes?:boolean, codeLabels?:boolean, title?:string}} [opts]
   * @returns {string} full HTML document
   */
  function buildStandalone(doc, opts) {
    var options = opts || {};
    var title = options.title || baseName((doc && doc.name) || 'document');

    return [
      '<!DOCTYPE html>',
      '<html lang="en"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width,initial-scale=1">',
      '<title>' + escapeHtml(title) + '</title>',
      '<style>' + DOC_CSS + '</style>',
      '</head><body>',
      bodyHtml(doc, options),
      '</body></html>'
    ].join('\n');
  }

  /**
   * Build the markup for the rasterised PDF host.
   *
   * html2canvas cannot use the page stylesheet, and it ignores `body` rules
   * when the content is not inside a <body>. The DOC_CSS is therefore scoped
   * under .md-pdf-host so the very same rules drive the rasterised output.
   * @param {object} doc
   * @param {object} [opts]
   * @returns {string} inner HTML for the PDF host element
   */
  function buildPdfHost(doc, opts) {
    var options = opts || {};
    var scoped = DOC_CSS.replace(/\bbody\b/g, '.md-pdf-host');

    return [
      '<style>' + scoped + '</style>',
      '<div class="md-pdf-host">',
      bodyHtml(doc, options),
      '</div>'
    ].join('\n');
  }

  global.Exporters = {
    buildStandalone: buildStandalone,
    buildPdfHost: buildPdfHost,
    baseName: baseName,
    download: download,
    escapeHtml: escapeHtml,

    /* --------------------------------------------------------- exports */

    /** Markdown (.md), optionally with the notes appendix. */
    md: function (doc, withNotes) {
      var name = baseName(doc.name) + '.md';
      var body = doc.content || '';
      if (withNotes !== false) body += global.Notes.toMarkdown(doc);
      download(name, new Blob([body], { type: 'text/markdown;charset=utf-8' }));
      return name;
    },

    /** Plain text (.txt) with all markup stripped. */
    txt: function (doc) {
      var name = baseName(doc.name) + '.txt';
      var body = global.MD.toPlainText(doc.content || '');
      var notes = (doc.notes || []).filter(function (n) { return (n.text || '').trim(); });
      if (notes.length) {
        body += '\n\n========== NOTES ==========\n\n';
        notes.forEach(function (n, i) {
          body += (i + 1) + '. ' + (n.text || '').trim() + '\n';
        });
      }
      download(name, new Blob([body], { type: 'text/plain;charset=utf-8' }));
      return name;
    },

    /** Self-contained HTML file. */
    html: function (doc) {
      var name = baseName(doc.name) + '.html';
      download(name, new Blob([buildStandalone(doc, {})], { type: 'text/html;charset=utf-8' }));
      return name;
    },

    /**
     * Microsoft Word document. Word renders HTML served with the
     * `application/msword` MIME type; the mso- additions keep headings,
     * tables and pagination Word-native.
     */
    doc: function (doc) {
      var name = baseName(doc.name) + '.doc';
      var inner = buildStandalone(doc, {});
      var head = inner.slice(inner.indexOf('<head>') + 6, inner.indexOf('</head>'));
      var body = inner.slice(inner.indexOf('<body>') + 6, inner.lastIndexOf('</body>'));

      var wordCss =
        '<style>@page WordSection1{size:11906px 16838px;margin:1134px 1134px 1134px 1134px;}' +
        'div.WordSection1{page:WordSection1;}' +
        'h1,h2,h3{page-break-after:avoid;} table{border-collapse:collapse;}</style>';

      var html = [
        '<html xmlns:o="urn:schemas-microsoft-com:office:office"',
        ' xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">',
        '<head><meta charset="utf-8">',
        '<title>' + escapeHtml(baseName(doc.name)) + '</title>',
        head,
        wordCss,
        '<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View>',
        '<w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->',
        '</head><body lang="EN-US"><div class="WordSection1">',
        body,
        '</div></body></html>'
      ].join('\n');


      download(name, new Blob(['\ufeff', html], { type: 'application/msword;charset=utf-8' }));
      return name;
    },


    /**
     * PDF via html2pdf (html2canvas + jsPDF, both bundled locally).
     * The document is rendered in an off-screen host with the export
     * stylesheet so the rasterised output matches the HTML/DOC exports.
     * @param {object} doc
     * @param {{onProgress?:(p:number)=>void}} [opts]
     * @returns {Promise<string>} the filename that was produced
     */
    pdf: function (doc, opts) {
      var options = opts || {};
      var name = baseName(doc.name) + '.pdf';

      if (!global.html2pdf) {
        return Promise.reject(new Error('PDF engine failed to load (html2pdf.bundle.min.js).'));
      }
      if (!String((doc && doc.content) || '').trim() && !(doc.notes || []).length) {
        return Promise.reject(new Error('Nothing to export \u2014 this document is empty.'));
      }

      var host = document.createElement('div');
      host.setAttribute('aria-hidden', 'true');
      host.style.cssText =
        'position:fixed;left:-10000px;top:0;width:820px;background:#fff;' +
        'pointer-events:none;';
      host.innerHTML = buildPdfHost(doc, { title: name });
      document.body.appendChild(host);

      /* The markup starts with a <style> element, so firstElementChild would
         be the stylesheet rather than the document. Select the wrapper we
         actually want to rasterise. */
      var target = host.querySelector('.md-pdf-host');
      if (!target) {
        document.body.removeChild(host);
        return Promise.reject(new Error('Could not build the PDF layout.'));
      }

      var onProgress = options.onProgress || function () {};

      var chain = global.html2pdf()
        .set({
          margin: [14, 12, 16, 12],
          filename: name,
          image: { type: 'jpeg', quality: 0.96 },
          html2canvas: {
            scale: 2,
            useCORS: true,
            allowTaint: true,
            backgroundColor: '#ffffff',
            logging: false,
            scrollX: 0,
            scrollY: 0
          },
          jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait', compress: true },
          pagebreak: { mode: ['css', 'legacy'], avoid: ['pre', 'table', 'img', 'blockquote'] }
        })
        .from(target);

      /* The bundled build exposes progress as a thenable `progress` property
         rather than an `.on('progress', cb)` method, and its Worker is not
         chainable. Older builds do have .on(); support both, but never assume
         it -- calling a missing method used to abort every PDF export. */
      if (chain && typeof chain.on === 'function') {
        chain.on('progress', onProgress);
      } else if (chain && chain.progress && typeof chain.progress.then === 'function') {
        chain.progress.then(onProgress, function () { /* progress only */ });
      }

      if (!chain || typeof chain.save !== 'function') {
        document.body.removeChild(host);
        return Promise.reject(new Error('The PDF engine returned an unexpected worker.'));
      }

      return Promise.resolve(chain.save())
        .then(function () {
          document.body.removeChild(host);
          return name;
        })
        .catch(function (err) {
          document.body.removeChild(host);
          throw err;
        });
    },

    /** Open the browser print dialog for the current document. */
    print: function (doc) {
      var name = baseName(doc.name);

      var host = document.getElementById('printHost');
      if (!host) {
        host = document.createElement('div');
        host.id = 'printHost';
        host.style.cssText = 'position:fixed;left:-10000px;top:0;width:820px;';
        document.body.appendChild(host);
      }

      /* A full document string assigned to innerHTML loses its <html>/<head>
         wrapper, so the body{} rules in DOC_CSS would never apply. Use the
         same self-contained host markup the PDF exporter uses. */
      host.innerHTML = buildPdfHost(doc, { title: name });

      var restore = function () {
        window.removeEventListener('afterprint', restore);
        if (host.parentNode) host.remove();
      };
      window.addEventListener('afterprint', restore);
      setTimeout(function () { window.print(); }, 60);
      return name;
    },

    /* ------------------------------------------------- bulk notes dump */

    /** Every note across every document, as one Markdown file. */
    allNotesMarkdown: function (docs) {
      var lines = ['# dotMDpritter \u2014 all notes', ''];
      var total = 0;

      (docs || []).forEach(function (doc) {
        if (!doc.notes || !doc.notes.length) return;
        total += doc.notes.length;
        lines.push('## ' + doc.name, '');
        doc.notes.forEach(function (note, i) {
          if (note.quote) lines.push('> ' + note.quote.replace(/\n+/g, ' '), '');
          lines.push((i + 1) + '. ' + ((note.text || '').trim() || '*(empty note)*'));
          lines.push('');
        });
        lines.push('---', '');
      });

      if (!total) return '';
      lines.push('<sub>Exported ' + new Date().toLocaleString() + '</sub>', '');
      return lines.join('\n');
    }
  };
})(window);
