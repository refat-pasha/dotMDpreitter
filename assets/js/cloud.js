/* =========================================================================
   cloud.js — API client, authentication gate, and the server-backed file
   tree. Exposes a single global: window.Cloud
   ========================================================================= */
(function (global) {
  'use strict';

  function $(id) { return document.getElementById(id); }

  /* ------------------------------------------------------- transport */

  class ApiError extends Error {
    constructor(message, code, status) {
      super(message);
      this.name = 'ApiError';
      this.code = code || 'ERROR';
      this.status = status || 0;
    }
  }

  /**
   * Every mutating call carries X-DotMD, which the server requires as a
   * CSRF defence in depth on top of the SameSite=Strict session cookie.
   */
  async function api(method, path, body) {
    let res;
    try {
      res = await fetch('/api' + path, {
        method: method,
        credentials: 'same-origin',
        headers: {
          'X-DotMD': '1',
          ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (_) {
      throw new ApiError('Cannot reach the server. Is it still running?', 'NETWORK', 0);
    }

    let data = null;
    try { data = await res.json(); } catch (_) { /* empty body */ }

    if (!res.ok) {
      throw new ApiError(
        (data && data.error) || ('Request failed (' + res.status + ')'),
        (data && data.code) || 'ERROR',
        res.status
      );
    }
    return data;
  }

  /* ------------------------------------------------------------ state */

  var state = {
    user: null,
    ready: false,
    path: '',            // folder currently listed
    listing: null,
    syncing: null,
    listeners: { change: [], user: [], toast: [] }
  };

  function on(evt, fn) {
    (state.listeners[evt] = state.listeners[evt] || []).push(fn);
  }
  function emit(evt, payload) {
    (state.listeners[evt] || []).forEach(function (fn) {
      try { fn(payload); } catch (e) { console.error('[cloud] listener', e); }
    });
  }


  /* ----------------------------------------------------------- auth */

  function setUser(user) {
    state.user = user || null;
    emit('user', state.user);
  }

  function register(payload) {
    return api('POST', '/auth/register', payload).then(function (r) {
      setUser(r.user);
      return r.user;
    });
  }

  function login(payload) {
    return api('POST', '/auth/login', payload).then(function (r) {
      setUser(r.user);
      return r.user;
    });
  }

  function logout() {
    return api('POST', '/auth/logout').then(function () {
      setUser(null);
      state.path = '';
      state.listing = null;
    });
  }

  function changePassword(currentPassword, newPassword) {
    return api('POST', '/auth/password', { currentPassword, newPassword });
  }

  /**
   * Ask for a password-reset email.
   * The server answers identically for unknown addresses, so this never
   * reveals whether an account exists.
   * @param {string} email
   * @returns {Promise<{message:string, devLink?:string}>}
   */
  function forgotPassword(email) {
    return api('POST', '/auth/forgot', { email: email });
  }

  /**
   * Spend a reset token and set a new password.
   *
   * The server revokes every session when a reset succeeds — including this
   * one, if the caller happened to be signed in. So drop the cached user here
   * too, otherwise the app keeps rendering as signed in against a cookie the
   * server will now reject.
   */
  function resetPassword(token, password) {
    return api('POST', '/auth/reset', { token: token, password: password })
      .then(function (r) { setUser(null); return r; });
  }

  /** Ask the server who we are (if anyone). Safe to call on a dead server. */
  function restoreSession() {
    return api('GET', '/auth/session')
      .then(function (r) { setUser(r.user); return r.user; })
      .catch(function () { setUser(null); return null; });
  }

  function syncSettings(settings) {
    if (!state.user) return Promise.resolve(null);
    return api('PUT', '/settings', { settings: settings })
      .then(function (r) { return r.settings; });
  }

  function loadSettings() {
    if (!state.user) return Promise.resolve(null);
    return api('GET', '/settings').then(function (r) { return r.settings; });
  }

  /* ---------------------------------------------------------- files */

  function encodePath(p) {
    return String(p || '').split('/').filter(Boolean)
      .map(encodeURIComponent).join('/');
  }

  function list(p) {
    if (!state.user) return Promise.reject(new ApiError('Not signed in.', 'UNAUTHENTICATED', 401));
    const target = p === undefined ? state.path : p;
    return api('GET', '/files' + (target ? '/' + encodePath(target) : ''))
      .then(function (listing) {
        state.path = target;
        state.listing = listing;
        emit('change', listing);
        return listing;
      });
  }

  function read(p) {
    return api('GET', '/files/raw/' + encodePath(p));
  }

  function writeFile(p, content) {
    return api('PUT', '/files/file', { path: p, content: content }).then(function (r) {
      return refresh().then(function () { return r; });
    });
  }

  function createFile(p, content) {
    return api('POST', '/files/file', { path: p, content: content || '' }).then(function (r) {
      return refresh().then(function () { return r; });
    });
  }

  function createFolder(p) {
    return api('POST', '/files/folder', { path: p }).then(function (r) {
      return refresh().then(function () { return r; });
    });
  }

  function rename(from, toName) {
    return api('POST', '/files/rename', { path: from, name: toName }).then(function (r) {
      return refresh().then(function () { return r; });
    });
  }

  function remove(p) {
    return api('POST', '/files/delete', { path: p }).then(function (r) {
      state.path = state.path === p ? '' : state.path;
      return refresh().then(function () { return r; });
    });
  }

  function refresh() {
    if (!state.user) return Promise.resolve(null);
    return list(state.path).catch(function () { return list(''); });
  }

  /* ------------------------------------------------- doc <-> server */

  /**
   * Save the current local document to the server.
   * @param {{id:string,name:string,content:string}} doc
   * @param {string} [folder]  defaults to the folder currently open
   * @returns {Promise<object>} the stored file
   */
  function saveDoc(doc, folder) {
    if (!state.user) return Promise.reject(new ApiError('Sign in to save to the cloud.', 'UNAUTHENTICATED', 401));

    var base = (folder === undefined ? state.path : folder) || 'notes';
    var name = /[.]md$/i.test(doc.name) ? doc.name : doc.name + '.md';
    var full = base ? base + '/' + name : name;

    return read(full).then(
      function () { return api('PUT', '/files/file', { path: full, content: doc.content }); },
      function (err) {
        if (err.status === 404) return api('POST', '/files/file', { path: full, content: doc.content });
        throw err;
      }
    ).then(function (r) {
      return refresh().then(function () { return r; });
    });
  }

  /**
   * Open a server file as a local document.
   * @param {string} p
   */
  function openDoc(p) {
    return read(p).then(function (file) {
      return { name: file.name, content: file.content, path: file.path };
    });
  }

  global.Cloud = {
    api: api,
    ApiError: ApiError,
    state: state,
    on: on,
    emit: emit,
    isSignedIn: function () { return !!state.user; },
    currentUser: function () { return state.user; },
    currentPath: function () { return state.path; },
    currentListing: function () { return state.listing; },
    setUser: setUser,
    register: register,
    login: login,
    logout: logout,
    changePassword: changePassword,
    forgotPassword: forgotPassword,
    resetPassword: resetPassword,
    restoreSession: restoreSession,
    syncSettings: syncSettings,
    loadSettings: loadSettings,
    list: list,
    read: read,
    writeFile: writeFile,
    createFile: createFile,
    createFolder: createFolder,
    rename: rename,
    remove: remove,
    refresh: refresh,
    saveDoc: saveDoc,
    openDoc: openDoc
  };
})(window);

