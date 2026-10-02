/* =========================================================================
   authui.js — the sign-in / register gate and the cloud file tree.
   Depends on window.Cloud. Exposes window.AuthUI
   ========================================================================= */
(function (global) {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function Cloud() { return global.Cloud; }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function svgIcon(name, cls) {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('class', 'ic ' + (cls || ''));
    var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    s.appendChild(use);
    return s;
  }

  function bytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function ago(ts) {
    if (!ts) return '';
    var d = (Date.now() - ts) / 1000;
    if (d < 60) return 'just now';
    if (d < 3600) return Math.floor(d / 60) + 'm ago';
    if (d < 86400) return Math.floor(d / 3600) + 'h ago';
    if (d < 604800) return Math.floor(d / 86400) + 'd ago';
    return new Date(ts).toLocaleDateString();
  }

  /** Stable hue from an email, so each account gets its own avatar colour. */
  function hashHue(str) {
    var h = 0;
    var s = String(str || '');
    for (var i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) % 360;
    }
    return h;
  }

  function initialsOf(email) {
    var name = String(email || '').split('@')[0] || '?';
    var parts = name.split(/[._-]+/).filter(Boolean);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  }

  function sinceLabel(ts) {
    if (!ts) return '';
    return 'Member since ' + new Date(ts).toLocaleDateString();
  }

  function openPasswordModal() {
    var form = $('pwForm');
    if (!form) return;
    form.reset();
    $('pwError').textContent = '';
    $('pwModal').hidden = false;
    setTimeout(function () {
      var cur = $('pwCurrent');
      if (cur) cur.focus();
    }, 60);
  }

  function toast(msg, kind) {
    if (global.App && global.App.toast) return global.App.toast(msg, kind);
    console.log('[toast]', kind || 'info', msg);
  }

  var AuthUI = {
    _pending: null,

    wireUserMenu: function () {
      var chip = $('userChip');
      var menu = $('userMenu');
      if (!chip || !menu) return;

      var close = function () {
        menu.hidden = true;
        chip.setAttribute('aria-expanded', 'false');
      };
      var open = function () {
        menu.hidden = false;
        chip.setAttribute('aria-expanded', 'true');
      };

      chip.addEventListener('click', function (e) {
        e.stopPropagation();
        if (menu.hidden) open(); else close();
      });

      document.addEventListener('click', function (e) {
        if (!menu.hidden && !menu.contains(e.target) && !chip.contains(e.target)) close();
      });

      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !menu.hidden) {
          close();
          chip.focus();
        }
      });

      $('btnChangePw').addEventListener('click', function () {
        close();
        openPasswordModal();
      });

      $('btnLogout').addEventListener('click', function () {
        close();
        Cloud().logout().catch(function () {
          toast('Could not sign out. Please try again.', 'err');
        });
      });

      chip.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          open();
          var first = menu.querySelector('button');
          if (first) first.focus();
        }
      });
    },

    init: function () {
      this.wireGate();
      this.wireUserMenu();
      this.wireTree();
      this.wirePasswordModal();

      Cloud().on('user', this.onUser.bind(this));
      Cloud().on('change', this.renderTree.bind(this));

      return Cloud().restoreSession().then(this.onUser.bind(this));
    },

    wirePasswordModal: function () {
      var close = function () { $('pwModal').hidden = true; };
      if ($('pwClose')) $('pwClose').addEventListener('click', close);
      if ($('pwCancel')) $('pwCancel').addEventListener('click', close);
      $('pwModal').addEventListener('click', function (e) {
        if (e.target === $('pwModal')) close();
      });
      $('pwForm').addEventListener('submit', function (e) {
        e.preventDefault();
        AuthUI.submitPassword();
      });
    },

    onUser: function (user) {
      this.renderUser(user);
      this.toggleGate(!user);
      /* Returning to the gate should start at sign-in so the
         "Forgot your password?" link (which lives on the sign-in pane) is
         reachable. It must not fight the recovery screens, and onUser can
         fire more than once per load, so the check is idempotent. */
      if (!user) {
        var m = $('authGate').dataset.mode;
        if (m !== 'forgot' && m !== 'reset') this.showMode('login');
        this.consumeResetToken();
      }
      if (user) this.refresh();
      this.renderTree();
    },

    toggleGate: function (show) {
      var gate = $('authGate');
      if (!gate) return;
      gate.hidden = !show;
      $('app').setAttribute('aria-hidden', show ? 'true' : 'false');
      if (show) {
        var first = gate.querySelector('input');
        if (first) setTimeout(function () { first.focus(); }, 60);
      }
    },

    wireGate: function () {
      var gate = $('authGate');
      if (!gate) return;

      gate.addEventListener('click', function (e) {
        var tab = e.target.closest('.auth-tab');
        if (tab) AuthUI.showMode(tab.dataset.mode);
      });

      gate.addEventListener('click', function (e) {
        var link = e.target.closest('.auth-link');
        if (!link) return;
        if (link.id === 'authForgot') return AuthUI.showMode('forgot');
        var back = link.dataset.back;
        if (back) AuthUI.showMode(back);
      });

      gate.addEventListener('submit', function (e) {
        e.preventDefault();
        var mode = gate.dataset.mode || 'login';
        if (mode === 'forgot') return AuthUI.submitForgot();
        if (mode === 'reset') return AuthUI.submitReset();
        AuthUI.submitGate();
      });

      gate.addEventListener('input', function () {
        /* Route to the validator for the pane actually on screen: the generic
           login/register check would otherwise re-disable the reset button
           after validateReset() had just enabled it. */
        var mode = gate.dataset.mode || 'login';
        if (mode === 'reset') AuthUI.validateReset();
        else if (mode === 'forgot') AuthUI.validateForgot();
        else AuthUI.validateGate();
      });
    },

    /** The reset screen has no email box; validate the pair of passwords. */
    validateForgot: function () {
      var email = ($('authEmailForgot') || {}).value || '';
      var btn = $('authSubmitForgot');
      var valid = email.indexOf('@') > 0;
      if (btn) btn.disabled = !valid;
      return valid;
    },

    /** The token from ?reset=..., kept only for this page view. */
    resetToken: '',

    /**
     * Read ?reset=<token> from the URL. The token is removed from the address
     * bar straight away so it is not left in history or sent in a Referer
     * header if the user clicks an external link.
     */
    consumeResetToken: function () {
      var token = '';
      try {
        var params = new URLSearchParams(global.location.search);
        token = params.get('reset') || '';
        if (token && params.has('reset')) {
          params.delete('reset');
          var q = params.toString();
          global.history.replaceState(null, '',
            global.location.pathname + (q ? '?' + q : ''));
        }
      } catch (e) { /* older browser: fall through */ }

      if (!token) return false;
      AuthUI.resetToken = token;
      AuthUI.showMode('reset');
      var first = $('authPasswordReset');
      if (first) first.focus();
      return true;
    },

    submitForgot: function () {
      var email = ($('authEmailForgot') || {}).value || '';
      var err = $('authError');
      var done = $('authForgotDone');
      var btn = $('authSubmitForgot');
      if (!email.trim()) return Promise.resolve(null);

      if (err) err.textContent = '';
      if (btn) { btn.disabled = true; btn.textContent = 'Sending\\u2026'; }

      var sent = false;
      return Cloud().forgotPassword(email.trim()).then(function (res) {
        sent = true;
        /* One request is enough, so hide the button and leave the
           confirmation on screen instead of re-enabling it afterwards. */
        if (btn) btn.hidden = true;
        if (done) {
          done.hidden = false;
          done.textContent = (res.message || 'Check your inbox.') +
            (res.devLink ? ' No mail server is configured, so use this link: ' : '');
          if (res.devLink) {
            var link = el('a', null, 'open the reset link');
            link.href = res.devLink;
            done.appendChild(link);
            done.appendChild(document.createTextNode('.'));
          }
        }
        toast(res.message || 'Check your inbox.', 'ok');
        return res;
      }).catch(function (e) {
        if (err) err.textContent = e.message || 'Something went wrong.';
      }).finally(function () {
        /* Only restore the button if the request failed. */
        if (!sent && btn) { btn.disabled = false; btn.textContent = 'Send reset link'; }
        AuthUI.validateGate();
      });
    },

    /** Both password boxes must match and reach the minimum length. */
    validateReset: function () {
      var a = ($('authPasswordReset') || {}).value || '';
      var b = ($('authPasswordReset2') || {}).value || '';
      var btn = $('authSubmitReset');
      var ok = a.length >= 8 && a === b;
      if (btn) btn.disabled = !ok;
      return ok;
    },

    submitReset: function () {
      var a = ($('authPasswordReset') || {}).value || '';
      var b = ($('authPasswordReset2') || {}).value || '';
      var err = $('authError');
      var btn = $('authSubmitReset');

      if (a !== b) {
        if (err) err.textContent = 'Those two passwords do not match.';
        return Promise.resolve(null);
      }
      if (a.length < 8) {
        if (err) err.textContent = 'Password must be at least 8 characters.';
        return Promise.resolve(null);
      }
      if (!AuthUI.resetToken) {
        if (err) err.textContent = 'That reset link is missing. Request a new one.';
        return Promise.resolve(null);
      }

      if (err) err.textContent = '';
      if (btn) { btn.disabled = true; btn.textContent = 'Saving\\u2026'; }

      return Cloud().resetPassword(AuthUI.resetToken, a).then(function () {
        AuthUI.resetToken = '';
        var p1 = $('authPasswordReset'), p2 = $('authPasswordReset2');
        if (p1) p1.value = '';
        if (p2) p2.value = '';
        toast('Password updated. Please sign in.', 'ok');
        AuthUI.showMode('login');
        var li = $('authPasswordLogin');
        if (li) li.focus();
        return true;
      }).catch(function (e) {
        if (err) err.textContent = e.message || 'Could not reset the password.';
        if (btn) btn.disabled = false;
        AuthUI.validateReset();
      });
    },

    /** Input elements for the mode currently on screen. */
    fields: function (mode) {
      return mode === 'register'
        ? { email: $('authEmailReg'), password: $('authPasswordReg'), name: $('authNameReg') }
        : { email: $('authEmailLogin'), password: $('authPasswordLogin') };
    },

    submitButton: function (mode) {
      return $(mode === 'register' ? 'authSubmitReg' : 'authSubmitLogin');
    },

    showMode: function (mode) {
      var gate = $('authGate');
      gate.dataset.mode = mode;

      /* The tabs only cover sign-in and register, so the recovery screens
         leave both unselected rather than lighting up the wrong one. */
      gate.querySelectorAll('.auth-tab').forEach(function (t) {
        var on = t.dataset.mode === mode;
        t.classList.toggle('is-active', on);
        t.setAttribute('aria-selected', String(on));
      });
      gate.querySelectorAll('.auth-pane').forEach(function (p) {
        p.hidden = p.dataset.pane !== mode;
      });

      $('authError').textContent = '';

      /* Clear a previous attempt so a second visit starts clean. */
      if (mode === 'forgot') {
        var done = $('authForgotDone');
        if (done) { done.hidden = true; done.textContent = ''; }
        var fb = $('authSubmitForgot');
        if (fb) { fb.hidden = false; fb.disabled = false; fb.textContent = 'Send reset link'; }
      }
      if (mode === 'reset') { AuthUI.validateReset(); return; }
      if (mode === 'forgot') { AuthUI.validateForgot(); return; }

      var f = AuthUI.fields(mode);
      if (f && f.email) f.email.focus();
      AuthUI.validateGate();
    },

    validateGate: function () {
      var mode = $('authGate').dataset.mode || 'login';
      var f = AuthUI.fields(mode);
      if (!f.email || !f.password) return false;

      var email = f.email.value.trim();
      var pass = f.password.value;
      var valid = email.indexOf('@') > 0 && (mode === 'login' || pass.length >= 8);

      var btn = AuthUI.submitButton(mode);
      if (btn) btn.disabled = !valid;
      return valid;
    },

    submitGate: function () {
      var mode = $('authGate').dataset.mode || 'login';
      var f = AuthUI.fields(mode);
      var err = $('authError');
      var btn = AuthUI.submitButton(mode);
      var idle = mode === 'login' ? 'Sign in' : 'Create account';

      var payload = { email: f.email.value.trim(), password: f.password.value };
      if (mode === 'register' && f.name) payload.name = f.name.value.trim();

      err.textContent = '';
      if (btn) {
        btn.disabled = true;
        btn.textContent = mode === 'login' ? 'Signing in\u2026' : 'Creating account\u2026';
      }

      var call = mode === 'login' ? Cloud().login(payload) : Cloud().register(payload);

      return call.then(function (user) {
        f.password.value = '';
        toast('Welcome, ' + (user.name || user.email) + '!', 'ok');
        return user;
      }).catch(function (e) {
        err.textContent = e.message || 'Something went wrong.';
      }).finally(function () {
        if (btn) btn.textContent = idle;
        AuthUI.validateGate();
      });
    },

    renderUser: function (user) {
      if (!$('userName')) return;
      var label, mail;

      if (user) {
        label = user.name || user.email.split('@')[0];
        mail = user.email;
        $('userAvatar').textContent = (label || '?').trim().charAt(0).toUpperCase();
        $('userAvatar').style.setProperty('--hue', String(hashHue(user.email)));
        $('userChip').hidden = false;
      } else {
        label = 'Guest';
        mail = 'Not signed in';
        $('userChip').hidden = true;
      }

      $('userName').textContent = label;
      $('userEmail').textContent = mail;
      if ($('userNameMenu')) $('userNameMenu').textContent = label;
      if ($('userEmailMenu')) $('userEmailMenu').textContent = mail;
    },


    /* ---------------------------------------------- file tree */

    wireTree: function () {
      var tree = $('cloudTree');
      if (!tree) return;
      tree.addEventListener('click', function (e) {
        var btn = e.target.closest('[data-act]');
        if (!btn) return;
        var item = btn.closest('[data-path]');
        var path = item ? item.dataset.path : '';
        var name = item ? item.dataset.name : '';

        switch (btn.dataset.act) {
          case 'open-folder': AuthUI.openFolder(path); break;
          case 'open-file': AuthUI.openCloudFile(path); break;
          case 'up': AuthUI.openFolder(Cloud().currentListing ? Cloud().currentListing.parent : ''); break;
          case 'save': AuthUI.saveActiveHere(); break;
          case 'new-folder': AuthUI.newFolder(); break;
          case 'new-file': AuthUI.newFile(); break;
          case 'rename': AuthUI.renameItem(path, name); break;
          case 'delete': AuthUI.deleteItem(path, name); break;
        }
      });

      // This button is a static sibling of #cloudTree, so the delegated
      // listener above never sees it. Wire it directly.
      var saveBtn = $('btnCloudSave');
      if (saveBtn) {
        saveBtn.addEventListener('click', function () {
          AuthUI.saveActiveHere();
        });
      }
    },

    refresh: function () {
      if (!Cloud().isSignedIn()) return Promise.resolve(null);
      $('cloudTree').setAttribute('aria-busy', 'true');
      return Cloud().list(Cloud().currentPath()).catch(function (e) {
        toast(e.message, 'err');
        return null;
      }).finally(function () {
        $('cloudTree').removeAttribute('aria-busy');
      });
    },

    renderTree: function () {
      var tree = $('cloudTree');
      if (!tree) return;

      var user = Cloud().currentUser();
      var listing = Cloud().currentListing();
      tree.innerHTML = '';

      if (!user) {
        $('cloudBar').hidden = true;
        var empty = el('div', 'cloud-empty');
        empty.appendChild(svgIcon('logo', 'lg'));
        empty.appendChild(el('p', null, 'Sign in to store documents in folders and open them on any device.'));
        tree.appendChild(empty);
        return;
      }

      $('cloudBar').hidden = false;
      $('cloudPath').textContent = '/' + (listing ? listing.path : '');

      /* ---- toolbar ---- */
      var bar = el('div', 'cloud-bar');

      var up = el('button', 'cloud-btn');
      up.type = 'button';
      up.dataset.act = 'up';
      up.title = 'Parent folder';
      up.setAttribute('aria-label', 'Parent folder');
      up.appendChild(svgIcon('chevron', 'up'));
      up.disabled = !listing || listing.parent === listing.path;
      bar.appendChild(up);

      var save = el('button', 'cloud-btn primary');
      save.type = 'button';
      save.dataset.act = 'save';
      save.title = 'Save the open document into this folder';
      save.appendChild(svgIcon('save'));
      save.appendChild(el('span', null, 'Save here'));
      bar.appendChild(save);

      var nf = el('button', 'cloud-btn');
      nf.type = 'button';
      nf.dataset.act = 'new-folder';
      nf.title = 'New folder';
      nf.setAttribute('aria-label', 'New folder');
      nf.appendChild(svgIcon('folder'));
      bar.appendChild(nf);

      var nfile = el('button', 'cloud-btn');
      nfile.type = 'button';
      nfile.dataset.act = 'new-file';
      nfile.title = 'New file';
      nfile.setAttribute('aria-label', 'New file');
      nfile.appendChild(svgIcon('file-plus'));
      bar.appendChild(nfile);

      tree.appendChild(bar);

      /* ---- breadcrumbs ---- */
      if (listing && listing.path) {
        var crumbs = el('div', 'cloud-crumbs');
        var acc = [];
        listing.path.split('/').forEach(function (seg) {
          acc.push(seg);
          var crumb = el('button', 'crumb', seg);
          crumb.type = 'button';
          crumb.dataset.act = 'open-folder';
          crumb.dataset.path = acc.join('/');
          crumbs.appendChild(crumb);
        });
        tree.appendChild(crumbs);
      }

      var ul = el('div', 'cloud-list');
      var any = false;

      (listing ? listing.folders : []).forEach(function (f) {
        any = true;
        ul.appendChild(AuthUI.row('folder', f.path, f.name, ''));
      });
      (listing ? listing.files : []).forEach(function (f) {
        any = true;
        var meta = bytes(f.size) + (f.title ? ' \u00b7 ' + f.title : ' \u00b7 ' + ago(f.modifiedAt));
        ul.appendChild(AuthUI.row('file', f.path, f.name, meta, f.path));
      });

      if (any) {
        tree.appendChild(ul);
      } else {
        var blank = el('div', 'cloud-empty small');
        blank.appendChild(el('p', null, 'This folder is empty. Use the buttons above to add something.'));
        tree.appendChild(blank);
      }
    },

    /** One row in the file tree. */
    row: function (kind, path, name, meta, openPath) {
      var row = el('div', 'cloud-row');
      row.dataset.path = path;
      row.dataset.name = name;

      var main = el('button', 'cr-main');
      main.type = 'button';
      main.dataset.act = kind === 'folder' ? 'open-folder' : 'open-file';
      main.dataset.path = openPath || path;
      main.title = name;
      main.appendChild(svgIcon(kind === 'folder' ? 'folder' : 'note'));
      main.appendChild(el('span', 'cr-name', name));
      row.appendChild(main);

      if (meta) row.appendChild(el('span', 'cr-meta', meta));

      var act = el('span', 'cr-act');
      [['note', 'rename', 'Rename'], ['trash', 'delete', 'Delete']].forEach(function (pair) {
        var b = el('button', 'cr-btn');
        b.type = 'button';
        b.dataset.act = pair[1];
        b.title = pair[2];
        b.setAttribute('aria-label', pair[2] + ' ' + name);
        b.appendChild(svgIcon(pair[0], 'sm'));
        act.appendChild(b);
      });
      row.appendChild(act);

      return row;
    },


    /* ------------------------------------------------- actions */

    openFolder: function (path) {
      return Cloud().list(path || '').catch(function (e) {
        toast(e.message, 'err');
      });
    },

    openCloudFile: function (path) {
      return Cloud().openDoc(path).then(function (file) {
        if (global.App && global.App.openFromCloud) {
          global.App.openFromCloud(file);
          toast('Opened ' + file.name + ' from your account.', 'ok');
        }
        return file;
      }).catch(function (e) { toast(e.message, 'err'); });
    },

    /** Save whatever document is currently open into the listed folder. */
    saveActiveHere: function () {
      if (!global.App) return Promise.resolve(null);
      var doc = global.App.activeDocSnapshot();
      if (!doc) { toast('No document is open.', 'err'); return Promise.resolve(null); }

      var folder = Cloud().currentPath() || 'notes';
      var target = folder + '/' + (/\.md$/i.test(doc.name) ? doc.name : doc.name + '.md');

      // Test against the listing we already hold. Reading the file first
      // would download the whole document just to find out it exists, and
      // logs a 404 in the console every time you save something new.
      var listing = Cloud().currentListing() || {};
      var exists = (listing.files || []).some(function (f) { return f.path === target; });

      // Confirm before writing, never after.
      if (exists && !global.confirm('“' + doc.name + '” already exists in ' +
          folder + '.\n\nOverwrite it?')) {
        return Promise.resolve(null);
      }

      var write = exists
        ? Cloud().writeFile(target, doc.content)
        : Cloud().createFile(target, doc.content);

      return write.then(function (r) {
        if (global.App && global.App.markSaved) global.App.markSaved(doc.id);
        toast('Saved to /' + r.path, 'ok');
        return r;
      }).catch(function (e) { toast(e.message, 'err'); });
    },

    newFolder: function () {
      var base = Cloud().currentPath() || 'notes';
      var name = global.prompt('New folder name', 'untitled');
      if (name === null) return Promise.resolve(null);
      name = String(name).trim();
      if (!name) return Promise.resolve(null);

      return Cloud().createFolder(base + '/' + name).then(function (f) {
        toast('Created folder ' + f.name, 'ok');
        return f;
      }).catch(function (e) { toast(e.message, 'err'); });
    },

    newFile: function () {
      var base = Cloud().currentPath() || 'notes';
      var name = global.prompt('New file name (a .md extension is added automatically)', 'untitled');
      if (name === null) return Promise.resolve(null);
      name = String(name).trim();
      if (!name) return Promise.resolve(null);
      if (!/\.md$/i.test(name)) name += '.md';

      var target = base + '/' + name;
      return Cloud().read(target).then(
        function () { toast('That file already exists.', 'err'); return null; },
        function () {
          return Cloud().createFile(target, '# ' + name.replace(/\.md$/i, '') + '\n\n')
            .then(function (f) {
              toast('Created ' + f.name, 'ok');
              return AuthUI.openCloudFile(f.path);
            });
        }
      ).catch(function (e) { toast(e.message, 'err'); });
    },

    renameItem: function (path, name) {
      var next = global.prompt('Rename "' + name + '" to', name);
      if (next === null) return Promise.resolve(null);
      next = String(next).trim();
      if (!next || next === name) return Promise.resolve(null);

      return Cloud().rename(path, next).then(function (r) {
        toast('Renamed to ' + r.name, 'ok');
        return r;
      }).catch(function (e) { toast(e.message, 'err'); });
    },

    deleteItem: function (path, name) {
      if (!global.confirm('Delete "' + name + '"?\n\nThis cannot be undone.')) {
        return Promise.resolve(null);
      }
      return Cloud().remove(path).then(function (r) {
        toast('Deleted ' + name, 'ok');
        return r;
      }).catch(function (e) { toast(e.message, 'err'); });
    }
  };

  global.AuthUI = AuthUI;
})(window);

