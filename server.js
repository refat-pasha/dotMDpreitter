#!/usr/bin/env node
/* =========================================================================
   server.js — HTTP server for dotMDpritter.

   Serves the static app and the JSON API under /api.
   Run:  node server.js [port]
   ========================================================================= */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const { Database, ensureDir } = require('./server/db');
const { Api } = require('./server/api');
const { SESSION_TTL_MS } = require('./server/auth');

const ROOT = __dirname;
const DEFAULT_PORT = Number(process.env.PORT) || 4173;
const DEFAULT_DATA_DIR = process.env.DOTMD_DATA || path.join(ROOT, 'data');

/* Never serve these, even though they sit inside the project folder. */

/* Only these top-level entries are reachable over HTTP. Everything else --
   the data directory, server sources, the test harnesses, package.json --
   is refused outright. An allow-list is used deliberately: a block-list
   would silently leak any file added to the project later. */
const PUBLIC_ROOTS = new Set(['assets', 'vendor']);
const PUBLIC_FILES = new Set(['index.html', 'README.md', 'LICENSE']);


const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.pdf': 'application/pdf'
};

function sendPlain(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

/**
 * Create and start the server.
 * @param {{port?:number, dataDir?:string, quiet?:boolean}} [options]
 */
function startServer(options = {}) {
  const dataDir = options.dataDir || DEFAULT_DATA_DIR;
  const quiet = !!options.quiet;

  ensureDir(dataDir);
  const usersDir = path.join(dataDir, 'users');
  ensureDir(usersDir);

  const db = new Database(dataDir);
  const api = new Api({
    db,
    usersDir,
    isSecure: /https/i.test(process.env.DOTMD_SECURE || '')
  });

  /* Housekeeping: drop expired sessions hourly. */
  const pruner = setInterval(() => {
    db.pruneSessions(SESSION_TTL_MS).catch(() => {});
    db.pruneResets().catch(() => {});
  }, 60 * 60 * 1000);
  if (pruner.unref) pruner.unref();

  const server = http.createServer(async (req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname || '/');
    } catch (_) {
      return sendPlain(res, 400, 'Bad request');
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      try {
        await api.handle(req, res, new URL(req.url, 'http://localhost'));
      } catch (err) {
        console.error('[server] api error', err);
        if (!res.headersSent) sendPlain(res, 500, 'Internal error');
        else res.destroy();
      }
      return;
    }

    if (pathname === '/') pathname = '/index.html';

    /* Resolve inside ROOT, then apply the public allow-list. */
    const target = path.join(ROOT, path.normalize(pathname));
    if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
      return sendPlain(res, 403, 'Forbidden');
    }

    const rel = path.relative(ROOT, target).split(path.sep).filter(Boolean);
    const top = rel[0] || '';
    const allowed = rel.length === 1
      ? PUBLIC_FILES.has(top)
      : PUBLIC_ROOTS.has(top);
    if (!allowed) {
      return sendPlain(res, 404, 'Not found');
    }

    fs.stat(target, (err, stat) => {
      if (err || !stat.isFile()) return sendPlain(res, 404, 'Not found: ' + pathname);

      const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
      const etag = '"' + stat.size.toString(16) + '-' + stat.mtimeMs.toString(16) + '"';

      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
        return res.end();
      }

      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': stat.size,
        'Cache-Control': 'no-cache',
        'Last-Modified': stat.mtime.toUTCString(),
        ETag: etag
      });
      if (req.method === 'HEAD') return res.end();

      const stream = fs.createReadStream(target);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(options.port !== undefined ? options.port : DEFAULT_PORT, () => {
      const port = server.address().port;
      if (!quiet) {
        console.log('');
        console.log('  \u{1F4DD} dotMDpritter is running');
        console.log('  \u2192  http://localhost:' + port);
        console.log('  \u{1F4C1} data: ' + dataDir);
        console.log('');
        console.log('  Press Ctrl+C to stop.');
        console.log('');
      }
      resolve({
        server,
        port,
        db,
        api,
        close: () => new Promise((done) => {
          clearInterval(pruner);
          if (server.closeAllConnections) server.closeAllConnections();
          server.close(() => done());
        })
      });
    });
  });
}

module.exports = { startServer, DEFAULT_PORT, DEFAULT_DATA_DIR, PUBLIC_ROOTS, PUBLIC_FILES };

/* Run directly: node server.js [port] */
if (require.main === module) {
  const port = Number(process.argv[2]) || DEFAULT_PORT;

  startServer({ port }).then((instance) => {
    /* Containers and process managers stop a service with SIGTERM. Flush the
       store and let in-flight requests finish instead of dying mid-write. */
    let shuttingDown = false;

    const shutdown = (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`\n  ${signal} received, shutting down\u2026`);

      const hardExit = setTimeout(() => {
        console.error('  Forced exit after 10s.');
        process.exit(1);
      }, 10000);
      hardExit.unref();

      instance.close()
        .then(() => {
          instance.db.users.flushSync();
          instance.db.sessions.flushSync();
          clearTimeout(hardExit);
          console.log('  Data flushed. Bye.');
          process.exit(0);
        })
        .catch((e) => {
          console.error('  Shutdown error:', e.message);
          process.exit(1);
        });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    process.on('unhandledRejection', (reason) => {
      console.error('[fatal] unhandled rejection:', reason);
    });
  }).catch((err) => {
    if (err.code === 'EADDRINUSE') {
      console.error('Port ' + port + ' is already in use. Try:  node server.js ' + (port + 1));
    } else {
      console.error(err.message);
    }
    process.exit(1);
  });
}

