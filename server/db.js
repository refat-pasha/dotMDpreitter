/* =========================================================================
   server/db.js — tiny atomic JSON document store.
   Holds users, sessions and password-reset tokens. Writes are serialised and
   atomic (tmp + rename) so a crash mid-write can never truncate the file.
   ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

class JsonStore {
  /**
   * @param {string} file  absolute path to the JSON file
   * @param {object} seed  default contents used when the file is absent
   */
  constructor(file, seed) {
    this.file = file;
    this.seed = seed;
    this.data = null;
    this._queue = Promise.resolve();
    this.load();
  }

  load() {
    ensureDir(path.dirname(this.file));
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      this.data = JSON.parse(raw);
      if (!this.data || typeof this.data !== 'object') throw new Error('not an object');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // A corrupt file must not take the whole server down: keep a copy
        // for forensics and start clean.
        console.warn(`[db] ${path.basename(this.file)} unreadable (${err.message}); starting fresh.`);
        try {
          fs.renameSync(this.file, this.file + '.corrupt-' + Date.now());
        } catch (_) { /* best effort */ }
      }
      this.data = JSON.parse(JSON.stringify(this.seed));
      this.flushSync();
    }
    return this.data;
  }

  /** Write immediately, atomically. */
  flushSync() {
    ensureDir(path.dirname(this.file));
    const tmp = this.file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  /**
   * Queue a mutation and persist it. Mutations never interleave.
   * @param {(data:object)=>any} mutator
   * @returns {Promise<any>} whatever mutator returned
   */
  update(mutator) {
    const run = async () => {
      const result = mutator(this.data);
      this.flushSync();
      return result;
    };
    this._queue = this._queue.then(run, run);
    return this._queue;
  }
}

/* --------------------------------------------------------------- model */

const USERS_SEED = { users: [], version: 1 };
const SESSIONS_SEED = { sessions: {}, version: 1 };
const RESETS_SEED = { resets: {}, version: 1 };

class Database {
  constructor(dataDir) {
    ensureDir(dataDir);
    this.dataDir = dataDir;
    this.users = new JsonStore(path.join(dataDir, 'users.json'), USERS_SEED);
    this.sessions = new JsonStore(path.join(dataDir, 'sessions.json'), SESSIONS_SEED);
    this.resets = new JsonStore(path.join(dataDir, 'resets.json'), RESETS_SEED);
  }

  get usersData() { return this.users.data.users; }
  get sessionsData() { return this.sessions.data.sessions; }
  get resetsData() { return this.resets.data.resets; }

  findUserByEmail(email) {
    const needle = String(email || '').trim().toLowerCase();
    return this.usersData.find((u) => u.email === needle) || null;
  }

  findUserById(id) {
    return this.usersData.find((u) => u.id === id) || null;
  }

  addUser(user) {
    return this.users.update((d) => {
      d.users.push(user);
      return user;
    });
  }

  updateUser(id, patch) {
    return this.users.update((d) => {
      const u = d.users.find((x) => x.id === id);
      if (u) Object.assign(u, patch, { updatedAt: Date.now() });
      return u || null;
    });
  }

  putSession(tokenHash, record) {
    return this.sessions.update((d) => {
      d.sessions[tokenHash] = record;
      return record;
    });
  }

  getSession(tokenHash) {
    return this.sessionsData[tokenHash] || null;
  }

  deleteSession(tokenHash) {
    return this.sessions.update((d) => {
      const had = Object.prototype.hasOwnProperty.call(d.sessions, tokenHash);
      delete d.sessions[tokenHash];
      return had;
    });
  }

  /** Drop sessions belonging to a user (e.g. on password change). */
  deleteSessionsForUser(userId) {
    return this.sessions.update((d) => {
      let n = 0;
      for (const [k, v] of Object.entries(d.sessions)) {
        if (v && v.userId === userId) { delete d.sessions[k]; n++; }
      }
      return n;
    });
  }

  /* --------------------------------------------------- password resets */

  /**
   * Store a password-reset token. Only the HASH is persisted, exactly like
   * session tokens, so a leaked resets.json cannot be used to take over an
   * account.
   * @param {string} tokenHash
   * @param {object} record {userId, createdAt, expiresAt}
   */
  putReset(tokenHash, record) {
    return this.resets.update((d) => {
      d.resets[tokenHash] = record;
      return record;
    });
  }

  /** Look up a reset token. Returns null when unknown or expired. */
  getReset(tokenHash) {
    const rec = this.resetsData[tokenHash];
    if (!rec) return null;
    if ((rec.expiresAt || 0) < Date.now()) return null;
    return rec;
  }

  /** Spend a token so it can only ever be used once. */
  deleteReset(tokenHash) {
    return this.resets.update((d) => {
      const had = Object.prototype.hasOwnProperty.call(d.resets, tokenHash);
      delete d.resets[tokenHash];
      return had;
    });
  }

  /** Drop every outstanding token for a user (after a successful reset). */
  deleteResetsForUser(userId) {
    return this.resets.update((d) => {
      let n = 0;
      for (const [k, v] of Object.entries(d.resets)) {
        if (v && v.userId === userId) { delete d.resets[k]; n++; }
      }
      return n;
    });
  }

  /** Remove expired reset tokens; called alongside the session pruner. */
  pruneResets() {
    const now = Date.now();
    return this.resets.update((d) => {
      let n = 0;
      for (const [k, v] of Object.entries(d.resets)) {
        if (!v || (v.expiresAt || 0) < now) { delete d.resets[k]; n++; }
      }
      return n;
    });
  }

  /** Remove expired sessions; called periodically. */
  pruneSessions(ttlMs) {
    const cutoff = Date.now() - ttlMs;
    return this.sessions.update((d) => {
      let n = 0;
      for (const [k, v] of Object.entries(d.sessions)) {
        if (!v || (v.createdAt || 0) < cutoff) { delete d.sessions[k]; n++; }
      }
      return n;
    });
  }
}

module.exports = { JsonStore, Database, ensureDir };
