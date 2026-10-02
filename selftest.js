/* =========================================================================
   selftest.js — headless checks for the pure-logic parts of dotMDpritter.
   Run:  node selftest.js
   ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
let pass = 0, fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, 'got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected));
}
function section(t) { console.log('\n' + t); }

/* ---------------------------------------------------------- sandbox */

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  Math,
  Date,
  JSON,
  RegExp,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Error,
  isNaN,
  parseInt,
  parseFloat,
  encodeURIComponent,
  decodeURIComponent,
  Uint8Array
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.navigator = { clipboard: null, userAgent: 'node' };
sandbox.localStorage = (() => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
    get length() { return m.size; }
  };
})();
sandbox.document = {
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, classList: { add() {}, toggle() {} } }),
  addEventListener() {},
  querySelectorAll: () => [],
  querySelector: () => null,
  body: { appendChild() {}, removeChild() {} }
};
sandbox.requestAnimationFrame = (fn) => setTimeout(fn, 0);
sandbox.getSelection = () => null;
sandbox.CSS = { escape: (s) => s };
sandbox.NodeFilter = { SHOW_TEXT: 4 };

/* Minimal DOMParser good enough for the code-language labelling pass that
   buildStandalone() performs. It records where each <code> element starts so
   that innerHTML can be rebuilt with the inserted <span class="code-lang">. */
sandbox.DOMParser = class {
  parseFromString(markup) {
    const codeRe = /<code(?: class="([^"]*)")?>/g;
    const found = [];
    let m;
    while ((m = codeRe.exec(markup))) {
      found.push({ at: m.index, cls: m[1] || '', label: null });
    }

    const body = {
      querySelectorAll: (sel) => sel === 'pre > code' ? found.map((f) => makeCodeEl(f)) : [],
      querySelector: (sel) => (sel === 'body' ? body : null),
      get innerHTML() {
        let out = markup;
        for (let i = found.length - 1; i >= 0; i--) {
          if (found[i].label) {
            out = out.slice(0, found[i].at) +
              '<span class="code-lang">' + found[i].label + '</span>' +
              out.slice(found[i].at);
          }
        }
        return out;
      }
    };

    function makeCodeEl(f) {
      const pre = {
        firstChild: null,
        insertBefore(node) { f.label = node.textContent; }
      };
      return { className: f.cls, textContent: '', parentNode: pre };
    }

    return { body, createElement: (tag) => ({ tagName: tag, className: '', textContent: '' }) };
  }
};

vm.createContext(sandbox);

function loadVendor(file) {
  const code = fs.readFileSync(path.join(ROOT, 'vendor', file), 'utf8');
  vm.runInContext(code, sandbox, { filename: file });
}
function loadModule(file) {
  const code = fs.readFileSync(path.join(ROOT, 'assets', 'js', file), 'utf8');
  vm.runInContext(code, sandbox, { filename: file });
}

loadVendor('marked.min.js');
/* DOMPurify needs a DOM; the self-test focuses on the parser pipeline,
   so it is stubbed with an identity function. */
sandbox.DOMPurify = { sanitize: (html) => html };
loadModule('markdown.js');
loadModule('notes.js');
loadModule('exporters.js');
loadModule('store.js');



const { MD, Notes, Store, Exporters } = sandbox;
const SANDBOX_STORE = sandbox.localStorage;

/* ================================================= typography guards */

section('Typography must not break Markdown structure');

ok('table delimiter is recognised',
  MD.isTableDelimiter('| --- | :---: |'));
ok('a pipe-less delimiter is still protected (via the thematic-break guard)',
  MD.isTableDelimiter('---') || MD.isThematicBreak('---'));
ok('thematic break recognised',
  MD.isThematicBreak('---') && MD.isThematicBreak('***') && MD.isThematicBreak('___'));
ok('ordinary prose is not a delimiter',
  !MD.isTableDelimiter('hello --- world') && !MD.isThematicBreak('a --- b'));

const tbl = MD.typography('| A | B |\n| --- | --- |\n| 1 | 2 |');
ok('table delimiter row survives typography', /\|\s*---\s*\|/.test(tbl), JSON.stringify(tbl));

const hr = MD.typography('para\n\n---\n\nmore');
ok('thematic break survives typography', /^---\s*$/m.test(hr), JSON.stringify(hr));

eq('dashes become em dashes in prose',
  MD.typography('a --- b'), 'a \u2014 b');
eq('ellipsis becomes a single glyph',
  MD.typography('wait...'), 'wait\u2026');
eq('double quotes become smart quotes',
  MD.typography('say "hi"'), 'say \u201Chi\u201D');
eq('apostrophe becomes a right single quote',
  MD.typography("it's"), 'it\u2019s');
eq('multiplication sign', MD.typography('3 x 4'), '3 \u00D7 4');
eq('arrow', MD.typography('a -> b'), 'a \u2192 b');

const code = MD.typography('```js\nconst a = "x" -- y;\n```');
ok('code fences are left untouched', code.includes('"x" -- y'), JSON.stringify(code));


/* ==================================================== markdown render */

section('Markdown rendering (GFM)');

const doc = [
  '# Title',
  '',
  '| A | B |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '- [x] done',
  '- [ ] todo',
  '',
  '> quote',
  '',
  '`inline`',
  '',
  '```js',
  'const x = 1;',
  '```'
].join('\n');

const html = MD.render(doc, { typography: false });
ok('heading rendered', /<h1[^>]*>Title<\/h1>/.test(html), html.slice(0, 140));
ok('table rendered', html.includes('<table>'), 'no <table> in output');
ok('table header rendered', /<th[^>]*>A<\/th>/.test(html));
ok('checked task item', /<input[^>]*checked[^>]*type="checkbox"/.test(html), html);
ok('unchecked task item',
  /<li class="task-list-item"><input[^>]*type="checkbox"/.test(html), html);
ok('blockquote rendered', html.includes('<blockquote>'));
ok('inline code rendered', html.includes('<code>inline</code>'));
ok('fenced code keeps its language', html.includes('language-js'));

eq('empty input renders nothing', MD.render(''), '');
eq('whitespace-only renders nothing', MD.render('   \n  \n '), '');


ok('inline code is left untouched by typography',
  MD.typography('use `a --- b` here').includes('`a --- b`'));

/* ==================================================== plain text/stats */

section('Plain-text conversion and statistics');

const plain = MD.toPlainText(doc);
ok('headings flattened', !plain.includes('#') && plain.includes('Title'), plain);
ok('table pipes removed', !plain.includes('|'), plain);
ok('fences unwrapped', !plain.includes('```'));
ok('checkbox markers removed', !plain.includes('[x]') && plain.includes('done'));
ok('inline code unwrapped', plain.includes('inline') && !plain.includes('`inline`'));

const st = MD.stats(doc);
ok('word count is positive', st.words > 0, String(st.words));
ok('char count matches source length', st.chars === doc.length, st.chars + ' vs ' + doc.length);
ok('line count matches', st.lines === doc.split('\n').length);
ok('reading time is at least 1 minute', st.minutes >= 1);
eq('empty document has zero words', MD.stats('').words, 0);
eq('empty document has zero minutes', MD.stats('').minutes, 0);

/* ============================================================== notes */

section('Notes: serialisation and counting');

const noteDoc = {
  name: 'x.md',
  content: 'body',
  notes: [
    { id: 'n1', quote: 'first quote', text: 'first note', color: 'amber', createdAt: Date.now(), updatedAt: Date.now() },
    { id: 'n2', quote: 'second quote', text: '', color: 'rose', createdAt: Date.now(), updatedAt: Date.now() }
  ]
};

const mdNotes = Notes.toMarkdown(noteDoc);
ok('notes produce a markdown appendix', mdNotes.includes('## Notes'), mdNotes.slice(0, 80));
ok('quoted text is included', mdNotes.includes('> first quote'));
ok('empty note is marked as empty', mdNotes.includes('*2. (empty note)*'), mdNotes);
eq('no notes means no appendix', Notes.toMarkdown({ notes: [] }), '');
ok('totalAcrossDocs counts every note',
  Notes.totalAcrossDocs([noteDoc, { notes: [{ id: 'a' }, { id: 'b' }] }, { notes: [] }]) === 4);

/* =============================================================== store */

section('Store: documents, activation and persistence');

Store.init();
ok('boots with the welcome document',
  Store.docs.length === 1 && Store.docs[0].name === 'welcome.md',
  Store.docs.map((d) => d.name).join(','));

const a = Store.create('a.md', '# A');
const b = Store.create('b.md', '# B');
eq('creating activates the new document', Store.activeId, b.id);
eq('doc count grows', Store.docs.length, 3);

Store.activate(a.id);
eq('activate switches the active document', Store.activeId, a.id);
ok('get() finds by id', Store.get(a.id) === a);
ok('get() returns null for an unknown id', Store.get('nope') === null);

eq('setContent reports a real change', Store.setContent(a.id, '# A2'), true);
eq('setContent is a no-op for identical text', Store.setContent(a.id, '# A2'), false);
eq('content is updated', Store.get(a.id).content, '# A2');

Store.rename(a.id, 'renamed.md');
eq('rename works', Store.get(a.id).name, 'renamed.md');

Store.close(a.id);
eq('close removes the document', Store.docs.length, 2);
ok('closed id is gone', Store.get(a.id) === null);

Store.create('only.md', 'x');
Store.close(Store.docs[Store.docs.length - 1].id);
ok('never ends up with zero documents', Store.docs.length >= 1, String(Store.docs.length));

section('Store: notes');

const d = Store.active;
const n1 = Store.addNote(d.id, 'quoted', 'note text');
ok('addNote returns the new note', !!n1 && n1.quote === 'quoted');
eq('note count grows', Store.get(d.id).notes.length, 1);

Store.updateNote(d.id, n1.id, { text: 'edited' });
eq('updateNote applies the patch', Store.get(d.id).notes[0].text, 'edited');
ok('updateNote on an unknown id is a no-op',
  Store.updateNote(d.id, 'zzz', { text: 'x' }) === null);

eq('removeNote succeeds', Store.removeNote(d.id, n1.id), true);
eq('removeNote twice is safe', Store.removeNote(d.id, n1.id), false);
eq('note count back to zero', Store.get(d.id).notes.length, 0);

section('Store: settings and persistence');

Store.setSetting('accent', 'rose');
eq('setting is applied', Store.settings.accent, 'rose');
Store.setSetting('notARealKey', 1);
ok('unknown setting is ignored', Store.settings.notARealKey === undefined);
Store.setSettings({ font: 'serif', fontSize: 20 });
eq('setSettings patches several at once', Store.settings.fontSize, 20);

Store.persist(true);
ok('documents were written to storage', SANDBOX_STORE.length > 0);
ok('settings were written to storage',
  SANDBOX_STORE.getItem('dotmdpritter.settings.v1') !== null);

Store.docs = [];
Store.init();
ok('documents survive a reload', Store.docs.length > 0, String(Store.docs.length));
eq('settings survive a reload', Store.settings.accent, 'rose');
eq('font setting survives a reload', Store.settings.font, 'serif');

section('Corrupted storage is handled gracefully');
SANDBOX_STORE.setItem('dotmdpritter.docs.v1', '{not json');
SANDBOX_STORE.setItem('dotmdpritter.settings.v1', ']]]broken');
Store.docs = [];
Store.init();
ok('falls back to the welcome document',
  Store.docs.length === 1 && Store.docs[0].name === 'welcome.md');
eq('falls back to default settings', Store.settings.accent, 'indigo');

/* ============================================================ exports */

section('Exporters: filenames and standalone documents');

eq('extension is stripped for the base name',
  Exporters.baseName('notes.md'), 'notes');
eq('other extensions are stripped too',
  Exporters.baseName('report.markdown'), 'report');
eq('a name without an extension is left alone',
  Exporters.baseName('plain'), 'plain');
eq('an empty name falls back',
  Exporters.baseName(''), 'document');

const expDoc = {
  name: 'Report.md',
  content: '# Title\n\nSome **bold** text and a table:\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n',
  notes: [{ id: 'e1', quote: 'bold', text: 'make this louder', color: 'amber', createdAt: 1, updatedAt: 1 }]
};

const sa = Exporters.buildStandalone(expDoc, {});
ok('standalone output is a full HTML document',
  sa.startsWith('<!DOCTYPE html>') && sa.includes('</html>'));
ok('standalone output carries its own stylesheet', sa.includes('<style>') && sa.includes('body{'));
ok('standalone output has no color-mix (html2canvas cannot resolve it)',
  !sa.includes('color-mix'), 'color-mix found in export CSS');
ok('rendered content is embedded', sa.includes('<strong>bold</strong>'));
ok('rendered table is embedded', sa.includes('<table>'));
ok('the title is used', sa.includes('<title>Report</title>'));
ok('notes are appended as a section', sa.includes('notes-section') && sa.includes('make this louder'));
ok('a footer credits the exporter', sa.includes('exported with dotMDpritter'));

const codeDoc = {
  name: 'c.md',
  content: '```javascript\nconst a = 1;\n```\n',
  notes: []
};
const saCode = Exporters.buildStandalone(codeDoc, {});
ok('fenced code gets a language label in the export',
  saCode.includes('code-lang') && saCode.includes('>javascript<'),
  saCode.match(/<pre>[\s\S]{0,160}/)?.[0]);

const noNotes = Exporters.buildStandalone(expDoc, { withNotes: false });
ok('notes can be excluded', !noNotes.includes('make this louder'));
ok('body content survives note removal', noNotes.includes('<strong>bold</strong>'));

const empty = Exporters.buildStandalone({ name: 'e.md', content: '', notes: [] }, {});
ok('an empty document still yields a valid page',
  empty.startsWith('<!DOCTYPE html>') && empty.includes('</html>'));

const all = Exporters.allNotesMarkdown([expDoc, { name: 'x.md', notes: [] }]);
ok('all-notes export includes the note', all.includes('make this louder'));
eq('all-notes export is empty when there are no notes',
  Exporters.allNotesMarkdown([{ name: 'y.md', notes: [] }]), '');

/* ---------------------------------------------------------------- PDF host */

section('Exporters: the rasterised PDF host');

const pdfHost = Exporters.buildPdfHost(expDoc, { title: 'Report' });

ok('the PDF host is a fragment, not a full document',
  !pdfHost.includes('<!DOCTYPE') && !pdfHost.includes('<html'),
  pdfHost.slice(0, 60));
ok('the PDF host carries its own stylesheet', pdfHost.includes('<style>'));
ok('the document wrapper is present for html2canvas to target',
  pdfHost.includes('class="md-pdf-host"'));
ok('body rules are scoped so they still apply off-screen',
  pdfHost.includes('.md-pdf-host{'),
  'no scoped body rule found');
ok('the content lives inside the scoped wrapper, after the stylesheet',
  pdfHost.indexOf('<style>') < pdfHost.indexOf('class="md-pdf-host"') &&
  pdfHost.indexOf('class="md-pdf-host"') < pdfHost.indexOf('<strong>bold</strong>'));
ok('the PDF host carries the rendered content', pdfHost.includes('<strong>bold</strong>'));
ok('the PDF host has no color-mix', !pdfHost.includes('color-mix'));
ok('the PDF host keeps the notes section', pdfHost.includes('make this louder'));

const taskDoc = { name: 't.md', content: '- [x] done\n- [ ] open\n', notes: [] };
const taskHost = Exporters.buildPdfHost(taskDoc, {});
ok('a finished task is marked done in the export',
  taskHost.includes('task-list-item is-done'));
ok('an unfinished task is not marked done in the export',
  !/task-list-item is-done[^]*?\[\s*\]/.test(taskHost.split('<li class="task-list-item')[2] || ''));
ok('task list styling keys off the item class marked actually emits',
  taskHost.includes('.task-list-item{') && !taskHost.includes('ul.task-list'));

/* The other exporters all delegate to bodyHtml()/buildStandalone(), so a
   regression in the refactor would break them together. */
section('Exporters: the shared body markup is reused everywhere');

const sa2 = Exporters.buildStandalone(expDoc, {});
ok('the standalone document still wraps the shared body',
  sa2.includes('<body>') && sa2.includes('<div class="doc">') &&
  sa2.includes('</body></html>'));
ok('the standalone document keeps the head stylesheet',
  sa2.includes('<head>') && sa2.includes('<style>') && sa2.includes('body{'));
ok('the PDF host and the standalone document render the same content',
  Exporters.buildPdfHost(expDoc, {}).includes('<strong>bold</strong>') &&
  sa2.includes('<strong>bold</strong>'));

/* print() used to `return name` where no such variable existed, throwing a
   ReferenceError on every print. Guard the regression by checking the
   function body no longer references a free `name`. */
const printSrc = String(Exporters.print);
ok('print() declares the name it returns',
  /var\s+name\s*=/.test(printSrc), printSrc.replace(/\s+/g, ' ').slice(0, 160));

/* ------------------------------------------------------ task list mapping */

section('Markdown: task checkboxes map back to the source');

const taskSrc = [
  '# Tasks',
  '',
  '- [ ] first',
  '- [x] second',
  '- [ ] third'
].join('\n');

eq('the first task line is found', MD.findTaskLine(taskSrc, 0).line, 2);
eq('the second task line is found', MD.findTaskLine(taskSrc, 1).line, 3);
eq('the third task line is found', MD.findTaskLine(taskSrc, 2).line, 4);
eq('an out-of-range task index finds nothing', MD.findTaskLine(taskSrc, 9), null);

eq('ticking a task rewrites its marker',
  MD.setTaskChecked(taskSrc, 0, true),
  '# Tasks\n\n- [x] first\n- [x] second\n- [ ] third');
eq('unticking a task rewrites its marker back',
  MD.setTaskChecked(taskSrc, 1, false),
  '# Tasks\n\n- [ ] first\n- [ ] second\n- [ ] third');
eq('the rest of the line is preserved',
  MD.setTaskChecked('- [ ] **bold** task text', 0, true),
  '- [x] **bold** task text');
eq('indented and ordered tasks are matched',
  MD.setTaskChecked('1. [ ] ordered', 0, true), '1. [x] ordered');
eq('an unknown index leaves the source untouched',
  MD.setTaskChecked(taskSrc, 42, true), taskSrc);

const fenced = ['- [ ] real', '```', '- [ ] not a task', '```', '- [ ] also real'].join('\n');
eq('task markers inside a fenced code block are skipped',
  MD.setTaskChecked(fenced, 1, true),
  '- [ ] real\n```\n- [ ] not a task\n```\n- [x] also real');

eq('uppercase X is normalised to lowercase x',
  MD.setTaskChecked('- [X] done', 0, false), '- [ ] done');

/* ================================================================ end */

console.log('\n' + '-'.repeat(52));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('-'.repeat(52) + '\n');
process.exit(fail === 0 ? 0 : 1);




