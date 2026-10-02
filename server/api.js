/* =========================================================================
   server/api.js — JSON REST API.
   Every route is mounted under /api. Mutating requests must carry the
   X-DotMD header (CSRF defence in depth alongside SameSite=Strict cookies).
   ========================================================================= */
'use strict';

const {
  hashPassword, verifyPassword, randomId, hashToken, createSessionToken,
  createResetToken, hashResetToken,
  parseCookies, sessionCookie, clearCookie,
  MAX_LOGIN_ATTEMPTS, ATTEMPT_WINDOW_MS, SESSION_TTL_MS, RESET_TTL_MS, COOKIE_NAME
} = require('./auth');
const { UserStorage, StorageError } = require('./storage');
const mailer = require('./mailer');

const CSRF_HEADER = 'x-dotmd';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_PASSWORD = 8;
const MAX_BODY_BYTES = 10 * 1024 * 1024;

class ApiError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    name: u.name || u.email.split('@')[0],
    createdAt: u.createdAt
  };
}

/** Only these settings may be stored server-side. */
const ALLOWED_SETTINGS = [
  'theme', 'accent', 'font', 'fontSize', 'view', 'zoom',
  'sidebar', 'notesOpen', 'syncScroll', 'autoSave', 'typography', 'lineNums'
];

function sanitizeSettings(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const key of ALLOWED_SETTINGS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) out[key] = input[key];
  }
  return out;
}

/* ------------------------------------------------- rate limiting */

/**
 * A real scrypt hash of a random secret, used when the email does not exist.
 * Verifying against it costs the same as verifying a genuine account, so
 * response timing cannot be used to enumerate registered emails.
 */
const DUMMY_HASH = (() => {
  const salt = require('crypto').randomBytes(16);
  const key = require('crypto').scryptSync(
    require('crypto').randomBytes(32), salt, 64,
    { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
  );
  return ['scrypt', 16384, 8, 1, salt.toString('hex'), key.toString('hex')].join('$');
})();

class RateLimiter {
  constructor(max, windowMs) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }
  hit(key) {
    const now = Date.now();
    const rec = this.hits.get(key);
    if (!rec || now - rec.start > this.windowMs) {
      this.hits.set(key, { start: now, count: 1 });
      return { allowed: true, remaining: this.max - 1 };
    }
    rec.count += 1;
    if (rec.count > this.max) {
      return { allowed: false, retryAfter: Math.ceil((rec.start + this.windowMs - now) / 1000) };
    }
    return { allowed: true, remaining: this.max - rec.count };
  }
  clear(key) { this.hits.delete(key); }
  /* Stop the map growing without bound on a long-running server. */
  sweep() {
    const now = Date.now();
    for (const [k, v] of this.hits) {
      if (now - v.start > this.windowMs) this.hits.delete(k);
    }
  }
}


/* ------------------------------------------------------------- API */

class Api {
  constructor({ db, usersDir, isSecure = false }) {
    this.db = db;
    this.usersDir = usersDir;
    /* Re-checked per request as well, so the Secure cookie flag is correct
       behind a TLS-terminating proxy even when this stays false. */
    this.isSecure = isSecure;
    this.loginLimiter = new RateLimiter(MAX_LOGIN_ATTEMPTS, ATTEMPT_WINDOW_MS);
    /* Generous, because many users share one NAT address; the limit exists
       to stop scripted mass-signup, not to inconvenience a small team. */
    this.registerLimiter = new RateLimiter(20, 60 * 60 * 1000);
    /* Reset requests are throttled hard: each one sends an email, so an
       attacker could otherwise use the endpoint to spam a third party. */
    this.resetLimiter = new RateLimiter(5, 60 * 60 * 1000);
    this._sweep = setInterval(() => {
      this.loginLimiter.sweep();
      this.resetLimiter.sweep();
    }, 5 * 60 * 1000);
    if (this._sweep.unref) this._sweep.unref();
  }

  /**
   * Did this request arrive over HTTPS? Checks the configured flag first,
   * then standard proxy headers. Trusting X-Forwarded-Proto is safe here
   * because its only effect is making the cookie stricter, never weaker.
   */
  requestIsSecure(req) {
    if (this.isSecure) return true;
    const h = (req && req.headers) || {};
    const proto = String(h['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    if (proto === 'https') return true;
    return String(h['x-forwarded-ssl'] || '').toLowerCase() === 'on';
  }

  storageFor(userId) {
    return new UserStorage(this.usersDir, userId);
  }

  /** Resolve the current user from the session cookie, or null. */
  currentUser(req) {
    const token = parseCookies(req)[COOKIE_NAME];
    if (!token) return null;

    const h = hashToken(token);
    const rec = this.db.getSession(h);
    if (!rec) return null;
    if (Date.now() - (rec.createdAt || 0) > SESSION_TTL_MS) {
      this.db.deleteSession(h);
      return null;
    }
    return this.db.findUserById(rec.userId);
  }

  requireUser(req) {
    const user = this.currentUser(req);
    if (!user) throw new ApiError('Please sign in.', 401, 'UNAUTHENTICATED');
    return user;
  }

  /* -------------------------------------------------------- routes */

  /** @returns {Promise<boolean>} true when the request was handled */
  async handle(req, res, url) {
    const seg = url.pathname.replace(/^\/api/, '').split('/').filter(Boolean);
    const method = req.method.toUpperCase();

    /* Unauthenticated liveness probe. PaaS platforms need this to decide
       whether the container is healthy; it reveals nothing. */
    if (seg[0] === 'health' && method === 'GET') {
      let writable = true;
      try {
        const fs = require('fs');
        const path = require('path');
        const probe = path.join(this.usersDir, '.health');
        fs.writeFileSync(probe, String(Date.now()), 'utf8');
        fs.unlinkSync(probe);
      } catch (e) {
        writable = false;
        console.error('[health] data dir not writable:', e.message);
      }
      return this.json(res, writable ? 200 : 503, {
        ok: writable,
        uptime: Math.round(process.uptime()),
        writable
      });
    }

    const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    if (isMutation && req.headers[CSRF_HEADER] !== '1') {
      return this.fail(res, new ApiError('Missing request header.', 403, 'CSRF'));
    }

    try {
      if (seg[0] === 'auth') {
        if (seg[1] === 'session' && method === 'GET') {
          return this.json(res, 200, { user: publicUser(this.currentUser(req)) });
        }
        if (seg[1] === 'register' && method === 'POST') return await this.register(req, res);
        if (seg[1] === 'login' && method === 'POST') return await this.login(req, res);
        if (seg[1] === 'logout' && method === 'POST') return await this.logout(req, res);
        if (seg[1] === 'password' && method === 'POST') return await this.changePassword(req, res);
        if (seg[1] === 'forgot' && method === 'POST') return await this.forgotPassword(req, res);
        if (seg[1] === 'reset' && method === 'POST') return await this.resetPassword(req, res);
      }

      if (seg[0] === 'settings') {
        if (method === 'GET') {
          const user = this.requireUser(req);
          return this.json(res, 200, { settings: user.settings || {} });
        }
        if (method === 'PUT') {
          const user = this.requireUser(req);
          const body = await this.body(req);
          const next = sanitizeSettings(body.settings);
          await this.db.updateUser(user.id, { settings: next });
          return this.json(res, 200, { settings: next });
        }
      }

      if (seg[0] === 'files') return await this.files(req, res, seg, method);

      return this.fail(res, new ApiError('Unknown endpoint.', 404, 'NOT_FOUND'));
    } catch (err) {
      if (err instanceof ApiError || err instanceof StorageError) {
        return this.fail(res, err);
      }
      console.error('[api] unhandled', err);
      return this.fail(res, new ApiError('Something went wrong.', 500, 'INTERNAL'));
    }
  }

  /* --------------------------------------------------------- files */

  async files(req, res, seg, method) {
    const user = this.requireUser(req);
    const store = this.storageFor(user.id);
    await store.init();

    /* A folder path may arrive either as separate segments
       (/api/files/notes/projects) or percent-encoded (%2F). */
    const rest = decodeURIComponent(seg.slice(1).join('/'));

    if (method === 'GET' && seg.length === 1) {
      return this.json(res, 200, await store.list(''));
    }
    if (method === 'GET' && seg[1] === 'raw' && seg.length >= 3) {
      return this.json(res, 200, await store.read(decodeURIComponent(seg.slice(2).join('/'))));
    }
    if (method === 'GET' && seg.length >= 2) {
      return this.json(res, 200, await store.list(rest));
    }

    if (method === 'POST' && seg[1] === 'folder') {
      const body = await this.body(req);
      return this.json(res, 201, await store.createFolder(body.path));
    }
    if (method === 'POST' && seg[1] === 'file') {
      const body = await this.body(req);
      return this.json(res, 201, await store.write(body.path, body.content));
    }
    if (method === 'PUT' && seg[1] === 'file') {
      const body = await this.body(req);
      return this.json(res, 200, await store.write(body.path, body.content));
    }
    if (method === 'POST' && seg[1] === 'rename') {
      const body = await this.body(req);
      return this.json(res, 200, await store.rename(body.path, body.name));
    }
    if (method === 'POST' && seg[1] === 'delete') {
      const body = await this.body(req);
      return this.json(res, 200, await store.remove(body.path));
    }
    return this.fail(res, new ApiError('Unknown endpoint.', 404, 'NOT_FOUND'));
  }


  /* ---------------------------------------------------------- auth */

  async register(req, res) {
    const ip = clientIp(req);
    const gate = this.registerLimiter.hit(ip);
    if (!gate.allowed) {
      return this.fail(res, new ApiError(
        `Too many accounts created from this address. Try again in ${gate.retryAfter}s.`,
        429, 'RATE_LIMITED'));
    }

    const body = await this.body(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const name = String(body.name || '').trim().slice(0, 60);

    if (!EMAIL_RE.test(email)) {
      return this.fail(res, new ApiError('Enter a valid email address.', 400, 'INVALID_EMAIL'));
    }
    if (password.length < MIN_PASSWORD) {
      return this.fail(res, new ApiError(
        `Password must be at least ${MIN_PASSWORD} characters.`, 400, 'WEAK_PASSWORD'));
    }
    if (password.length > 200) {
      return this.fail(res, new ApiError('Password is too long.', 400, 'WEAK_PASSWORD'));
    }
    if (this.db.findUserByEmail(email)) {
      return this.fail(res, new ApiError(
        'An account with that email already exists.', 409, 'EMAIL_TAKEN'));
    }

    const user = {
      id: randomId(12),
      email,
      name: name || email.split('@')[0],
      passwordHash: await hashPassword(password),
      createdAt: Date.now(),
      settings: {}
    };
    await this.db.addUser(user);
    await this.storageFor(user.id).init();

    console.log(`[auth] registered ${email}`);
    return this.issueSession(req, res, user);
  }

  async login(req, res) {
    const ip = clientIp(req);
    const gate = this.loginLimiter.hit(ip);
    if (!gate.allowed) {
      return this.fail(res, new ApiError(
        `Too many failed attempts. Try again in ${gate.retryAfter}s.`, 429, 'RATE_LIMITED'));
    }

    const body = await this.body(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');

    const user = this.db.findUserByEmail(email);

    // Always run a verification so that a missing account and a wrong
    // password take the same amount of time (no user enumeration).
    const stored = user ? user.passwordHash : DUMMY_HASH;
    const valid = await verifyPassword(password, stored);

    if (!user || !valid) {
      return this.fail(res, new ApiError('Incorrect email or password.', 401, 'BAD_CREDENTIALS'));
    }

    this.loginLimiter.clear(ip);
    return this.issueSession(req, res, user);
  }

  async issueSession(req, res, user) {
    const token = createSessionToken();
    await this.db.putSession(hashToken(token), {
      userId: user.id,
      createdAt: Date.now(),
      userAgent: String((req.headers && req.headers['user-agent']) || '').slice(0, 200)
    });
    res.setHeader('Set-Cookie', sessionCookie(token, this.requestIsSecure(req)));
    return this.json(res, 200, { user: publicUser(user) });
  }

  async logout(req, res) {
    const token = parseCookies(req)[COOKIE_NAME];
    if (token) await this.db.deleteSession(hashToken(token));
    res.setHeader('Set-Cookie', clearCookie(this.requestIsSecure(req)));
    return this.json(res, 200, { ok: true });
  }

  async changePassword(req, res) {
    const user = this.requireUser(req);
    const body = await this.body(req);
    const current = String(body.currentPassword || '');
    const next = String(body.newPassword || '');

    if (!(await verifyPassword(current, user.passwordHash))) {
      return this.fail(res, new ApiError('Your current password is incorrect.', 401, 'BAD_CREDENTIALS'));
    }
    if (next.length < MIN_PASSWORD) {
      return this.fail(res, new ApiError(
        `Password must be at least ${MIN_PASSWORD} characters.`, 400, 'WEAK_PASSWORD'));
    }

    await this.db.updateUser(user.id, { passwordHash: await hashPassword(next) });
    // Invalidate every other session, then re-issue this one.
    const token = parseCookies(req)[COOKIE_NAME];
    await this.db.deleteSessionsForUser(user.id);
    if (token) await this.db.putSession(hashToken(token), {
      userId: user.id, createdAt: Date.now(), userAgent: 'password-change'
    });

    console.log(`[auth] password changed for ${user.email}`);
    return this.json(res, 200, { ok: true });
  }

  /* ------------------------------------------------- password recovery */

  /** Absolute base URL for reset links, from the request or the env var. */
  resetBaseUrl(req) {
    const configured = String(process.env.DOTMD_PUBLIC_URL || '').trim().replace(/\/+$/, '');
    if (configured) return configured;
    // X-Forwarded-Proto/Host let this work behind nginx/Caddy unchanged.
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
      || (this.requestIsSecure(req) ? 'https' : 'http');
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost:4173')
      .split(',')[0].trim();
    return `${proto}://${host}`;
  }

  /**
   * Step 1: email a single-use reset link.
   *
   * Always answers 200 with the same message whether or not the address is
   * registered. Anything else would turn this endpoint into a way to discover
   * which email addresses have accounts.
   */
  async forgotPassword(req, res) {
    const ip = clientIp(req);
    const gate = this.resetLimiter.hit(ip);
    if (!gate.allowed) {
      return this.fail(res, new ApiError(
        `Too many reset requests. Try again in ${gate.retryAfter}s.`, 429, 'RATE_LIMITED'));
    }

    const body = await this.body(req);
    const email = String(body.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      return this.fail(res, new ApiError('Enter a valid email address.', 400, 'INVALID_EMAIL'));
    }

    const generic = 'If that address has an account, a reset link is on its way.';
    const user = this.db.findUserByEmail(email);
    if (!user) return this.json(res, 200, { ok: true, message: generic });

    // Any earlier unused links are dropped so only the newest one works.
    await this.db.deleteResetsForUser(user.id);

    const token = createResetToken();
    await this.db.putReset(hashResetToken(token), {
      userId: user.id,
      createdAt: Date.now(),
      expiresAt: Date.now() + RESET_TTL_MS
    });

    const link = `${this.resetBaseUrl(req)}/?reset=${encodeURIComponent(token)}`;
    const minutes = Math.round(RESET_TTL_MS / 60000);

    const result = await mailer.send({
      to: user.email,
      subject: 'Reset your dotMDpritter password',
      text: [
        'Hi ' + (user.name || 'there') + ',',
        '',
        'Somebody asked to reset the password for this dotMDpritter account.',
        'Open the link below to choose a new one:',
        '',
        link,
        '',
        `This link works once and expires in ${minutes} minutes.`,
        '',
        'If this was not you, nothing has changed and you can ignore this message.',
        '',
        '-- dotMDpritter'
      ].join('\n')
    });

    console.log(`[auth] reset requested for ${email} (delivered: ${result.delivered})`);

    // When no mail server is configured the link went to the console instead,
    // so return it to the caller on a loopback connection. That keeps a local
    // or single-user instance usable without any SMTP setup at all, while a
    // remote caller still learns nothing.
    const remote = String(req.socket.remoteAddress || '');
    const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    return this.json(res, 200, {
      ok: true,
      message: generic,
      ...(!result.delivered && isLocal ? { devLink: link, emailConfigured: false } : {})
    });
  }

  /** Step 2: spend the token and set the new password. */
  async resetPassword(req, res) {
    const body = await this.body(req);
    const token = String(body.token || '');
    const next = String(body.password || '');

    if (!token) {
      return this.fail(res, new ApiError('That reset link is not valid.', 400, 'BAD_TOKEN'));
    }
    if (next.length < MIN_PASSWORD) {
      return this.fail(res, new ApiError(
        `Password must be at least ${MIN_PASSWORD} characters.`, 400, 'WEAK_PASSWORD'));
    }
    if (next.length > 200) {
      return this.fail(res, new ApiError('Password is too long.', 400, 'WEAK_PASSWORD'));
    }

    const hash = hashResetToken(token);
    const record = this.db.getReset(hash);
    // A missing, unknown and expired token are all reported identically.
    if (!record) {
      return this.fail(res, new ApiError(
        'That reset link has expired or has already been used. Ask for a new one.',
        400, 'BAD_TOKEN'));
    }

    const user = this.db.findUserById(record.userId);
    if (!user) {
      await this.db.deleteReset(hash);
      return this.fail(res, new ApiError(
        'That reset link has expired or has already been used. Ask for a new one.',
        400, 'BAD_TOKEN'));
    }

    await this.db.updateUser(user.id, { passwordHash: await hashPassword(next) });
    await this.db.deleteResetsForUser(user.id);
    // Anyone who had the old password loses their session, including any
    // attacker who signed in before the reset.
    await this.db.deleteSessionsForUser(user.id);

    console.log(`[auth] password reset completed for ${user.email}`);
    return this.json(res, 200, { ok: true });
  }

  /* ------------------------------------------------------- plumbing */

  body(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          reject(new ApiError('Request body too large.', 413, 'TOO_LARGE'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (err) {
          reject(new ApiError('Malformed JSON body.', 400, 'BAD_JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  json(res, status, payload) {
    const text = JSON.stringify(payload);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store'
    });
    res.end(text);
    return true;
  }

  fail(res, err) {
    return this.json(res, err.status || 400, {
      error: err.message || 'Request failed',
      code: err.code || 'BAD_REQUEST'
    });
  }
}

function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

module.exports = { Api, ApiError, RateLimiter, sanitizeSettings, publicUser, CSRF_HEADER };
