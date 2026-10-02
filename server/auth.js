/* =========================================================================
   server/auth.js — passwords, sessions, cookies, rate limiting.
   Everything here uses Node's built-in crypto; no third-party dependencies.
   ========================================================================= */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------ tuning */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;   // 14 days
const RESET_TTL_MS = 1000 * 60 * 30;                // 30 minutes
const COOKIE_NAME = 'dmd_sid';
const MAX_LOGIN_ATTEMPTS = 8;
const ATTEMPT_WINDOW_MS = 1000 * 60 * 10;

/* -------------------------------------------------------- passwords */

/**
 * Derive a scrypt hash. Format: scrypt$N$r$p$saltHex$hashHex
 * @param {string} password
 * @returns {Promise<string>}
 */
function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(
      String(password), salt, SCRYPT.keylen,
      { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 },
      (err, key) => {
        if (err) return reject(err);
        resolve([
          'scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p,
          salt.toString('hex'), key.toString('hex')
        ].join('$'));
      }
    );
  });
}

/**
 * Constant-time password verification.
 * @param {string} password
 * @param {string} stored  value produced by hashPassword()
 * @returns {Promise<boolean>}
 */
function verifyPassword(password, stored) {
  return new Promise((resolve) => {
    if (typeof stored !== 'string') return resolve(false);
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return resolve(false);

    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4], 'hex');
    const expected = Buffer.from(parts[5], 'hex');

    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) {
      return resolve(false);
    }

    crypto.scrypt(
      String(password), salt, expected.length,
      { N, r, p, maxmem: 64 * 1024 * 1024 },
      (err, key) => {
        if (err) return resolve(false);
        // timingSafeEqual throws on length mismatch, so check first.
        if (key.length !== expected.length) return resolve(false);
        resolve(crypto.timingSafeEqual(key, expected));
      }
    );
  });
}

/* --------------------------------------------------------- sessions */

function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** Only the hash of a session token is persisted, never the token itself. */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function createSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/* --------------------------------------------------- password resets */

/** A single-use token emailed to the account owner. 32 bytes of entropy. */
function createResetToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Hash a reset token. Same rule as sessions: the plaintext token only ever
 * exists in the user's inbox, never on disk.
 */
function hashResetToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/* ---------------------------------------------------------- cookies */

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(v); } catch (_) { out[k] = v; }
  }
  return out;
}

function serializeCookie(name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path || '/'}`);
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.expires) parts.push(`Expires=${opts.expires.toUTCString()}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  parts.push(`SameSite=${opts.sameSite || 'Strict'}`);
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

function sessionCookie(token, secure) {
  return serializeCookie(COOKIE_NAME, token, {
    maxAge: SESSION_TTL_MS / 1000,
    httpOnly: true,
    sameSite: 'Strict',
    secure: !!secure
  });
}

function clearCookie(secure) {
  return serializeCookie(COOKIE_NAME, '', {
    maxAge: 0, expires: new Date(0),
    httpOnly: true, sameSite: 'Strict', secure: !!secure
  });
}

module.exports = {
  SCRYPT, SESSION_TTL_MS, RESET_TTL_MS, COOKIE_NAME,
  MAX_LOGIN_ATTEMPTS, ATTEMPT_WINDOW_MS,
  hashPassword, verifyPassword,
  randomId, hashToken, createSessionToken,
  createResetToken, hashResetToken,
  parseCookies, serializeCookie, sessionCookie, clearCookie
};
