/* =========================================================================
   apitest.js — end-to-end checks for the auth + storage backend.
   Spins up the real HTTP server on an ephemeral port with a throwaway
   data directory, then drives the API exactly like the browser would.
   Run:  node apitest.js
   ========================================================================= */
'use strict';

const fs = require('fs');
const net = require('net');
const tls = require('tls');
const os = require('os');
const path = require('path');
const http = require('http');

const { startServer } = require('./server');
const mailer = require('./server/mailer');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; console.log('  \u2717 ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, 'got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected));
}
function section(t) { console.log('\n' + t); }

/* ------------------------------------------------------ fake SMTP peer

   A stand-in mail server that walks the real conversation, including a genuine
   TLS handshake after STARTTLS. That matters: the client really does wrap the
   socket and really does speak the rest of the conversation over TLS, so the
   commands and DATA payload we capture are what a provider would receive.

   The certificate is a throwaway self-signed pair for 127.0.0.1, used by
   nothing but this test. The client skips verification for the duration
   (DOTMD_SMTP_INSECURE=1) — the same escape hatch a self-hosted relay needs. */
const FAKE_CERT = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIUENicrcJhvcNoC6bfmU19dOeHnhIwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMCAXDTI2MTAwMjEyMTk0NloYDzIxMjYw
OTA4MTIxOTQ2WjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQCeo7C8dFsXd9LCtb3MHPGPwPiWWhYkuxjiRPKz5d8h
mBXaZOcCGe/8purMcCCZHJWQK4OXg9uBZ5sOfx4ng6rOeFu8Yao4KWjbFKmyR6db
PfRFBfPDdix7xlnRJ4be/7QhoBMyG0O/ejHmqFhs4+cen4hce7hfeB5qSdK3HuoH
HUCHyGNK6xR6hKGAerND2aZmnqsh+DNq4UtC9TCAohY3IofFXWdyjPkRVgzBN1zD
4SDFq3hqmUzVTYUVYkfRzExe6z3h5yc4S+KC0i6mBp0seUFl1qOkpmk6+9nu1d6p
b/m3wXs6uJFEEF2d6ThiDMyH7hCzVdYlockHC/oQAS8zAgMBAAGjbzBtMB0GA1Ud
DgQWBBTcpY00gsqkRRIJ9lHJ5qBxJcnE6jAfBgNVHSMEGDAWgBTcpY00gsqkRRIJ
9lHJ5qBxJcnE6jAPBgNVHRMBAf8EBTADAQH/MBoGA1UdEQQTMBGHBH8AAAGCCWxv
Y2FsaG9zdDANBgkqhkiG9w0BAQsFAAOCAQEAXcnLtZ+qkIe8k8iKYiRNVUs1e7Vh
Qw7z3ww+CmOHxIbvX8Yzhkol6/JxaaeF+xaGy25XbYoHr3iDeY54uMTX2CIpp7Ju
WILcFjJzMsjpv3M5Fw3LQ4OyD3VRYVrchi/Tr9X+sfsTTgvMuRbvxpXLIexdpM8u
vyz6l8MKVxDKe66QpVFXQhgIdKzjkZ4+m9gL4aVNKyq+EQd4Xda6+AW3ZhwSrvcu
4XsHPEnO0MOxFGldpkr0Vkfeob+CVszLasyoYgC8TNb/LeHf6bUkJDbBMbcDvuaF
9nEn+ve/nCXdcV1hDcsbSriSCLRRR7hjcXhXP/7WeybHKizQVpW54VyfOQ==
-----END CERTIFICATE-----`;

const FAKE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCeo7C8dFsXd9LC
tb3MHPGPwPiWWhYkuxjiRPKz5d8hmBXaZOcCGe/8purMcCCZHJWQK4OXg9uBZ5sO
fx4ng6rOeFu8Yao4KWjbFKmyR6dbPfRFBfPDdix7xlnRJ4be/7QhoBMyG0O/ejHm
qFhs4+cen4hce7hfeB5qSdK3HuoHHUCHyGNK6xR6hKGAerND2aZmnqsh+DNq4UtC
9TCAohY3IofFXWdyjPkRVgzBN1zD4SDFq3hqmUzVTYUVYkfRzExe6z3h5yc4S+KC
0i6mBp0seUFl1qOkpmk6+9nu1d6pb/m3wXs6uJFEEF2d6ThiDMyH7hCzVdYlockH
C/oQAS8zAgMBAAECggEADKUVONL40c7kwfgU6ANPQ+XzSp9lUB8ztWbJMQq7yuSM
VWChQzsdtHX6QDptzBaJsLivNVwMGpf6CuFEs4ycsvbIBSTZxGk/Pjs66DGARwG8
tJBsD41IsBhYNMI2+hPICr1vhO5vFiufdPhqjUoV3uHYz4UIZgpf45lSePM3X0Ks
LP/nd4h2/9FwtSnBUjU6JDQNhj6n1huSu+L49r4S6SNekR1J0DbczLho6Cpq9WjJ
WAnLkvck68tucFMQYlZRkub2x/qj7JqdrzmvtyGssaYbvBE9t7ljTjN6Hyfo04YQ
tFEe4ltjWVkybS/KRQX8i/T5ZbEl26kKwCktNHrjzQKBgQDfyYGYDZppvx/EwgPP
vVhZiqh21g4L9BfvusG/8IdukXVyIXbL1Wcq9VOpU+G9NwYmqbA+jSoUpamxeo1V
DQnAburTskctWc1rRAMkuOggCouo2NiVmyvxuB31BriYTHYD+GQw1D9zSapQcEP2
5QB1qvfnwG4zPNptG5PlTiq3hwKBgQC1eYJBoAh+37wqXVxLqDoke0eG6h0ywVRQ
aNwLZ1Zaa16bgm/LxTv4t1k8xhwLB3kdmS1WZfaMIONeMrGQVh5dMO7UNJpWQAW/
30DI8/gRf8ja68WBDEqDSvYevFFR/TUVNxprh5A8598/HwwjYiGaw5EytZJIEcb8
2rAiZdDd9QKBgD0doQDPpj3+7kQj4DqZsUky7vMVXlyxWuAjlso+fB4cJ4D11qWw
MC6xNRnnSJ0OK+XfLbzHfJiK7Z8Eoxh5KRKeuA78fyfJgKosttcOkIY/mwiPwAaL
jCLFb5j9LuiY6RoIegRD0tg/Y/33yvfgbpG0EWP/T5k6o0Rs5aUYBd59AoGAPHZG
Yqz6B6NtYsQGOyLKdFsqgpW/sqhc+gllvtroF2oMdE1qB/8nsv8LWUc8EqSjwqvF
QjLoiNlwR3MmW8uFhFEIUWVRQolEISA1yn4WWWY0ulOxUwSQUtwH0ke15FYzeGUK
hWb+NHygkbw7ZBKO1axw1O9P1HkvzhDifCNmCn0CgYAmUbDV1inrqQrUT+SZDm04
xIwxm10Nit5KlweKYbM7vS88hTKNnK+Yuxvdn+j/3Mcdm2t9NxLdKGhyak38/xAK
KVmDnlu3g2StxIZ2bv5OH2T3d3q2Al2UeDVuzNjQcRk7DgzvLdTXZW54c+Q8o71u
80LAwQJq19U8rDbPHeeFLw==
-----END PRIVATE KEY-----`;

const FAKE_CERT_KEY = () => tls.createSecureContext({ cert: FAKE_CERT, key: FAKE_KEY });

function fakeSmtpServer() {
  let transcript = '', commands = [], full = [], data = '', inData = false, waiter = null;
  let received = [];

  const handle = (sock, greet) => {
    let buf = '';
    let authStep = 0;                        // 0 = none, 1 = username, 2 = password
    const reply = (line) => { sock.write(line + '\r\n'); transcript += 'S: ' + line + '\n'; };
    const finish = () => { if (waiter) { const w = waiter; waiter = null; w(); } };
    /* The greeting is only for the initial plain connection. After STARTTLS
       the client keeps waiting for a reply to the EHLO it already sent, so
       sending 220 again would desynchronise the conversation. */
    if (greet) reply('220 fake.smtp.test ESMTP ready');

    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\r\n');
      buf = lines.pop();
      for (const line of lines) {
        transcript += 'C: ' + line + '\n';
        if (inData) {
          if (line === '.') { inData = false; data = received.join('\r\n'); reply('250 2.0.0 Ok: queued'); finish(); }
          else received.push(line);
          continue;
        }
        const verb = line.split(' ')[0].toUpperCase();
        commands.push(verb);
        full.push(line);              // the command exactly as the client sent it
        if (verb === 'EHLO') { reply('250-fake.smtp.test greets you'); reply('250 AUTH LOGIN PLAIN'); }
        else if (verb === 'STARTTLS') {
          reply('220 2.0.0 Ready to start TLS');
          const plain = sock;
          plain.removeAllListeners('data');
          handle(new tls.TLSSocket(plain, { isServer: true, secureContext: FAKE_CERT_KEY() }), false);
        }
        else if (verb === 'AUTH') { authStep = 1; reply('334 VXNlcm5hbWU6'); }
        else if (verb === 'MAIL') reply('250 2.1.0 Ok');
        else if (verb === 'RCPT') reply('250 2.1.5 Ok');
        else if (verb === 'DATA') { inData = true; reply('354 End data with <CR><LF>.<CR><LF>'); }
        else if (verb === 'QUIT') { reply('221 2.0.0 Bye'); finish(); sock.end(); }
        else if (authStep === 1) { authStep = 2; reply('334 UGFzc3dvcmQ6'); }  // password
        else if (authStep === 2) { authStep = 0; reply('235 2.7.0 Authentication successful'); }
      }
    });
    sock.on('error', () => {});
  };

  const server = net.createServer((sock) => handle(sock, true));
  server.on('tlsClientError', () => {});

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      done: () => new Promise((res) => { waiter = res; setTimeout(res, 5000); })
        .then(() => ({ transcript, commands, full, data })),
      reset: () => { transcript = ''; commands = []; full = []; data = ''; received = []; },
      close: () => new Promise((res) => { server.close(res); setTimeout(res, 200); })
    }));
  });
}

/* ------------------------------------------------------ http client */

let COOKIE = '';

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { 'X-DotMD': '1' };
    if (COOKIE) headers.Cookie = COOKIE;
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = data.length;
    }

    const req = http.request(
      { host: '127.0.0.1', port, method, path: urlPath, headers },
      (res) => {
        const setCookie = res.headers['set-cookie'];
        if (setCookie && setCookie[0]) {
          COOKIE = setCookie[0].split(';')[0];
        }
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(raw); } catch (_) { /* not JSON */ }
          resolve({ status: res.statusCode, body: json, raw, headers: res.headers });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function clearCookieJar() { COOKIE = ''; }

/* ------------------------------------------------------------- main */

async function run() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dotmd-test-'));
  const { port, close, db, api } = await startServer({ dataDir, port: 0, quiet: true });
  const P = port;

  console.log('dotMDpritter API tests  (port ' + P + ')');

  try {
    /* ---------------------------------------------- registration */
    section('Registration');

    let r = await request(P, 'GET', '/api/auth/session');
    eq('anonymous session returns a null user', r.body.user, null);

    r = await request(P, 'POST', '/api/auth/register',
      { email: 'not-an-email', password: 'longenough1' });
    eq('rejects an invalid email', r.status, 400);
    eq('invalid email code', r.body.code, 'INVALID_EMAIL');

    r = await request(P, 'POST', '/api/auth/register',
      { email: 'a@b.com', password: 'short' });
    eq('rejects a short password', r.status, 400);
    eq('short password code', r.body.code, 'WEAK_PASSWORD');

    r = await request(P, 'POST', '/api/auth/register',
      { email: 'alice@example.com', password: 'correct horse', name: 'Alice' });
    eq('registers a new account', r.status, 200);
    eq('returns the user email', r.body.user.email, 'alice@example.com');
    eq('returns the display name', r.body.user.name, 'Alice');
    ok('never returns the password hash', !('passwordHash' in r.body.user));
    ok('sets an HttpOnly cookie',
      String(r.headers['set-cookie']).includes('HttpOnly'));
    ok('cookie is SameSite=Strict',
      String(r.headers['set-cookie']).includes('SameSite=Strict'));

    r = await request(P, 'POST', '/api/auth/register',
      { email: 'alice@example.com', password: 'another one' });
    eq('duplicate email is rejected', r.status, 409);
    eq('duplicate email code', r.body.code, 'EMAIL_TAKEN');

    r = await request(P, 'POST', '/api/auth/register',
      { email: 'ALICE@Example.com', password: 'yet another' });
    eq('email uniqueness is case-insensitive', r.status, 409);

    const usersFile = path.join(dataDir, 'users.json');
    const onDisk = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
    ok('user was written to disk', onDisk.users.length >= 1);
    ok('password stored as a scrypt hash',
      String(onDisk.users[0].passwordHash).startsWith('scrypt$'));
    ok('plaintext password is never stored',
      !JSON.stringify(onDisk).includes('correct horse'));

    /* ----------------------------------------------- csrf header */
    section('CSRF protection');

    r = await new Promise((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port: P, method: 'POST', path: '/api/auth/logout',
          headers: { Cookie: COOKIE } },
        (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); }
      );
      req.end();
    });
    eq('mutation without the custom header is blocked', r.status, 403);

    /* The recovery endpoints are unauthenticated, so CSRF is their only
       defence against a cross-site request that mails a reset link. */
    for (const p of ['/api/auth/forgot', '/api/auth/reset']) {
      const c = await new Promise((resolve) => {
        const req = http.request(
          { host: '127.0.0.1', port: P, method: 'POST', path: p,
            headers: { 'Content-Type': 'application/json' } },
          (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); }
        );
        req.write('{"email":"x@y.z","token":"t","password":"aaaaaaaa"}');
        req.end();
      });
      eq(p + ' without the custom header is blocked', c.status, 403);
    }

    /* ---------------------------------------------- login / logout */
    section('Login and logout');

    clearCookieJar();
    r = await request(P, 'POST', '/api/auth/login',
      { email: 'alice@example.com', password: 'wrong' });
    eq('wrong password is rejected', r.status, 401);
    eq('wrong password code', r.body.code, 'BAD_CREDENTIALS');
    ok('error does not reveal whether the account exists',
      !/no such|unknown|not found/i.test(r.body.error), r.body.error);

    const unknown = await request(P, 'POST', '/api/auth/login',
      { email: 'ghost@example.com', password: 'whatever' });
    eq('unknown account gives an identical error', unknown.body.error, r.body.error);
    eq('unknown account gives an identical status', unknown.status, r.status);

    r = await request(P, 'POST', '/api/auth/login',
      { email: 'alice@example.com', password: 'correct horse' });
    eq('correct credentials log in', r.status, 200);
    eq('logged-in user email', r.body.user.email, 'alice@example.com');

    r = await request(P, 'GET', '/api/auth/session');
    eq('session endpoint reports the user', r.body.user.email, 'alice@example.com');

    /* ----------------------------------------------- file storage */
    section('File storage');

    r = await request(P, 'GET', '/api/files');
    eq('root starts with the default notes folder', r.body.folders.length, 1);
    eq('default folder is named notes', r.body.folders[0].name, 'notes');

    r = await request(P, 'POST', '/api/files/folder', { path: 'notes/projects' });
    eq('creates a nested folder', r.status, 201);
    eq('returns the folder path', r.body.path, 'notes/projects');

    r = await request(P, 'POST', '/api/files/file',
      { path: 'notes/hello.md', content: '# Hello\n\nFirst note.\n' });
    eq('saves a file', r.status, 201);

    r = await request(P, 'POST', '/api/files/file',
      { path: 'notes/projects/deep.md', content: '## Deep\n' });
    eq('saves a nested file', r.status, 201);

    r = await request(P, 'GET', '/api/files/notes');
    eq('lists files in a folder', r.body.files.length, 1);
    eq('file name is correct', r.body.files[0].name, 'hello.md');
    eq('title is extracted from the heading', r.body.files[0].title, 'Hello');
    eq('root listing reports an empty parent', r.body.parent, '');

    r = await request(P, 'GET', '/api/files/notes/projects');
    eq('lists nested folder contents', r.body.files.length, 1);
    eq('nested listing reports its parent', r.body.parent, 'notes');

    r = await request(P, 'GET', '/api/files/raw/notes%2Fhello.md');
    eq('reads a file back', r.body.content, '# Hello\n\nFirst note.\n');

    r = await request(P, 'PUT', '/api/files/file',
      { path: 'notes/hello.md', content: '# Hello\n\nEdited.\n' });
    eq('overwrites a file', r.status, 200);
    r = await request(P, 'GET', '/api/files/raw/notes%2Fhello.md');
    ok('edit persisted', r.body.content.includes('Edited'));

    r = await request(P, 'POST', '/api/files/rename',
      { path: 'notes/hello.md', name: 'renamed.md' });
    eq('renames a file', r.body.name, 'renamed.md');
    r = await request(P, 'GET', '/api/files/raw/notes%2Frenamed.md');
    eq('renamed file is still readable', r.status, 200);

    /* ---------------------------------------- path traversal defence */
    section('Path traversal defence');

    const attacks = [
      ['parent traversal', '../../../etc/passwd'],
      ['mid-path traversal', 'notes/../../escape.md'],
      ['absolute path', '/etc/passwd'],
      ['backslash traversal', '..\\..\\windows\\system32\\x.md'],
      ['drive-letter path', 'C:/Windows/win.ini'],
      ['null byte', 'notes/ok.md\0.png']
    ];
    for (const attack of attacks) {
      const res = await request(P, 'POST', '/api/files/file',
        { path: attack[1], content: 'x' });
      ok('blocks ' + attack[0], res.status >= 400, 'status ' + res.status);
    }

    /* A percent-encoded ".." in a JSON body is LITERAL text, not a traversal.
       It must be allowed, but the result must still be contained. */
    r = await request(P, 'POST', '/api/files/file',
      { path: 'notes/%2e%2e/encoded.md', content: 'x' });
    eq('percent-encoded dots are treated as a literal name', r.status, 201);
    ok('and the result stays inside the user folder',
      r.body && r.body.path === 'notes/%2e%2e/encoded.md', JSON.stringify(r.body));

    r = await request(P, 'POST', '/api/files/file', { path: 'notes/bad.exe', content: 'x' });
    eq('rejects non-markdown extensions', r.status, 400);

    r = await request(P, 'GET', '/api/files/raw/..%2F..%2Fusers.json');
    ok('cannot read the user database via traversal', r.status >= 400, 'status ' + r.status);

    r = await request(P, 'GET', '/api/files/raw/..%2F..%2F..%2Fdotmdpritter%2Fpackage.json');
    ok('cannot escape the project directory', r.status >= 400, 'status ' + r.status);

    /* ------------------------------------------------- isolation */
    section('Multi-user isolation');

    clearCookieJar();
    r = await request(P, 'POST', '/api/auth/register',
      { email: 'bob@example.com', password: 'bobs password', name: 'Bob' });
    eq('second user registers', r.status, 200);
    const bobId = r.body.user.id;

    const aliceId = JSON.parse(fs.readFileSync(usersFile, 'utf8'))
      .users.find((u) => u.email === 'alice@example.com').id;
    ok('each user gets a distinct id', bobId !== aliceId);

    r = await request(P, 'GET', '/api/files/notes');
    eq("bob does not see alice's files", r.body.files.length, 0);
    eq('bob sees only his own default folder',
      (await request(P, 'GET', '/api/files')).body.folders.length, 1);

    r = await request(P, 'GET', '/api/files/raw/notes%2Frenamed.md');
    eq("bob cannot read alice's file", r.status, 404);

    const usersDir = path.join(dataDir, 'users');
    ok('each user has their own folder on disk',
      fs.existsSync(path.join(usersDir, bobId)) &&
      fs.existsSync(path.join(usersDir, aliceId)));
    ok("bob's folder does not contain alice's file",
      !fs.existsSync(path.join(usersDir, bobId, 'notes', 'renamed.md')));
    ok("alice's file is still on disk in her own folder",
      fs.existsSync(path.join(usersDir, aliceId, 'notes', 'renamed.md')));

    r = await request(P, 'POST', '/api/files/file',
      { path: 'notes/bob.md', content: '# Bob doc\n' });
    eq('bob can save his own file', r.status, 201);
    r = await request(P, 'GET', '/api/files/notes');
    eq('bob sees exactly his own file', r.body.files[0].name, 'bob.md');
    eq("bob's file is not alice's", r.body.files[0].name !== 'renamed.md', true);

    /* ------------------------------------------------- settings */
    section('Per-user settings');

    r = await request(P, 'PUT', '/api/settings',
      { settings: { theme: 'light', accent: 'rose', fontSize: 20, evil: 'x' } });
    eq('saves settings', r.status, 200);
    eq('stores the theme', r.body.settings.theme, 'light');
    ok('drops unknown keys', !('evil' in r.body.settings), JSON.stringify(r.body.settings));

    r = await request(P, 'GET', '/api/settings');
    eq('reads settings back', r.body.settings.accent, 'rose');

    clearCookieJar();
    r = await request(P, 'GET', '/api/settings');
    eq('settings require authentication', r.status, 401);
    r = await request(P, 'GET', '/api/files');
    eq('files require authentication', r.status, 401);
    r = await request(P, 'POST', '/api/files/file', { path: 'notes/x.md', content: 'x' });
    eq('writes require authentication', r.status, 401);

    /* -------------------------------------------------- password */
    section('Password change');

    clearCookieJar();
    await request(P, 'POST', '/api/auth/login',
      { email: 'bob@example.com', password: 'bobs password' });

    r = await request(P, 'POST', '/api/auth/password',
      { currentPassword: 'nope', newPassword: 'brand new pass' });
    eq('rejects the wrong current password', r.status, 401);

    r = await request(P, 'POST', '/api/auth/password',
      { currentPassword: 'bobs password', newPassword: 'short' });
    eq('rejects a weak new password', r.status, 400);

    r = await request(P, 'POST', '/api/auth/password',
      { currentPassword: 'bobs password', newPassword: 'brand new pass' });
    eq('changes the password', r.status, 200);

    clearCookieJar();
    r = await request(P, 'POST', '/api/auth/login',
      { email: 'bob@example.com', password: 'bobs password' });
    eq('old password no longer works', r.status, 401);
    r = await request(P, 'POST', '/api/auth/login',
      { email: 'bob@example.com', password: 'brand new pass' });
    eq('new password works', r.status, 200);

    /* -------------------------------------------- password reset */
    section('Forgotten password');

    /* This section makes more reset requests than the hourly allowance, so the
       limiter is cleared between steps. The limit itself is asserted at the
       end of the section. */
    const clearResetLimit = () => api.resetLimiter.hits.clear();

    /* A fresh account so the reset flow cannot disturb the password-change
       checks above. */
    clearCookieJar();
    await request(P, 'POST', '/api/auth/register', {
      email: 'reset@example.com', password: 'the forgotten one', name: 'Reset Tester'
    });
    await request(P, 'POST', '/api/auth/logout');
    clearResetLimit();

    r = await request(P, 'POST', '/api/auth/forgot',
      { email: 'reset@example.com' });
    eq('forgot accepts a known address', r.status, 200);
    ok('forgot never echoes the password or a hash', !r.body.passwordHash);

    /* Enumeration check: an unknown address must be indistinguishable. */
    clearResetLimit();
    const known = await request(P, 'POST', '/api/auth/forgot',
      { email: 'reset@example.com' });
    clearResetLimit();
    const unknownAddr = await request(P, 'POST', '/api/auth/forgot',
      { email: 'no.such.person@example.com' });
    eq('unknown address is also 200', unknownAddr.status, 200);
    eq('unknown address gets the identical message',
      unknownAddr.body.message, known.body.message);
    ok('unknown address leaks no reset link', !unknownAddr.body.devLink);

    r = await request(P, 'POST', '/api/auth/forgot', { email: 'not-an-email' });
    eq('forgot rejects a malformed address', r.status, 400);

    /* The test client runs on loopback, so the no-SMTP fallback returns the
       link in the response instead of mailing it. That is exactly the token
       a user's email would carry. */
    const link = new URL(known.body.devLink).searchParams.get('reset');
    ok('a reset token is issued', !!link);
    ok('the reset link points at the app root',
      known.body.devLink.endsWith('/?reset=' + encodeURIComponent(link)));

    /* Only the hash may be persisted. */
    const resetsRaw = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'resets.json'), 'utf8'));
    const stored = Object.keys(resetsRaw.resets);
    eq('exactly one reset token is stored', stored.length, 1);
    ok('the raw token is never written to disk',
      stored.every((h) => !h.includes(link)));
    ok('stored tokens are sha256 hex',
      stored.every((h) => /^[0-9a-f]{64}$/.test(h)));

    r = await request(P, 'POST', '/api/auth/reset',
      { token: link, password: 'no' });
    eq('reset rejects a weak password', r.status, 400);
    eq('weak password reports the right code', r.body.code, 'WEAK_PASSWORD');

    r = await request(P, 'POST', '/api/auth/reset',
      { token: 'not-a-real-token', password: 'a fine new password' });
    eq('reset rejects a forged token', r.status, 400);
    eq('forged token reports the right code', r.body.code, 'BAD_TOKEN');

    r = await request(P, 'POST', '/api/auth/reset',
      { token: '', password: 'a fine new password' });
    eq('reset rejects a missing token', r.body.code, 'BAD_TOKEN');

    /* A live session must be killed by a reset, so an attacker who stole the
       old password loses access the moment the owner recovers. */
    clearCookieJar();
    await request(P, 'POST', '/api/auth/login',
      { email: 'reset@example.com', password: 'the forgotten one' });
    r = await request(P, 'GET', '/api/files');
    eq('the attacker session can read files first', r.status, 200);

    r = await request(P, 'POST', '/api/auth/reset',
      { token: link, password: 'a fine new password' });
    eq('reset succeeds', r.status, 200);

    clearCookieJar();
    r = await request(P, 'POST', '/api/auth/login',
      { email: 'reset@example.com', password: 'the forgotten one' });
    eq('the old password no longer works', r.status, 401);
    r = await request(P, 'POST', '/api/auth/login',
      { email: 'reset@example.com', password: 'a fine new password' });
    eq('the new password works', r.status, 200);
    clearCookieJar();

    r = await request(P, 'GET', '/api/auth/session');
    eq('pre-reset sessions were invalidated', r.body.user, null);

    /* Single use: the spent token must not work a second time. */
    r = await request(P, 'POST', '/api/auth/reset',
      { token: link, password: 'yet another password' });
    eq('a used token cannot be replayed', r.body.code, 'BAD_TOKEN');

    /* Asking again replaces the outstanding link rather than stacking. */
    clearResetLimit();
    await request(P, 'POST', '/api/auth/forgot', { email: 'reset@example.com' });
    const resetsAfter = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'resets.json'), 'utf8'));
    eq('only one live token per user', Object.keys(resetsAfter.resets).length, 1);

    /* -------------------------------------------- expiry */
    section('Reset token expiry');

    clearResetLimit();
    const stale = await request(P, 'POST', '/api/auth/forgot',
      { email: 'reset@example.com' });
    const staleToken = new URL(stale.body.devLink).searchParams.get('reset');
    /* Age the record directly: waiting 30 minutes is not practical. */
    await db.resets.update((d) => {
      for (const k of Object.keys(d.resets)) d.resets[k].expiresAt = Date.now() - 1000;
    });
    r = await request(P, 'POST', '/api/auth/reset',
      { token: staleToken, password: 'should not be allowed' });
    eq('an expired token is refused', r.body.code, 'BAD_TOKEN');
    clearCookieJar();
    r = await request(P, 'POST', '/api/auth/login',
      { email: 'reset@example.com', password: 'a fine new password' });
    eq('the password is untouched by the expired attempt', r.status, 200);
    await request(P, 'POST', '/api/auth/logout');
    await db.resets.update((d) => { d.resets = {}; });

    /* ---------------------------------------- abuse limits */
    section('Password-reset abuse limits');

    /* Reset emails could be used to spam a third party, so the endpoint is
       throttled per address. Exhaust the allowance and confirm it holds. */
    clearResetLimit();
    let last = null;
    for (let i = 0; i < 8; i++) {
      last = await request(P, 'POST', '/api/auth/forgot',
        { email: 'victim@example.com' });
      if (last.status === 429) break;
    }
    eq('repeated reset requests are throttled', last.status, 429);
    eq('the throttle reports the right code', last.body.code, 'RATE_LIMITED');
    clearResetLimit();

    /* ------------------------------------- the SMTP conversation itself
       The console fallback is the only path exercised above, so nothing has
       yet proven the mailer speaks real SMTP. This is a fake server that
       accepts a connection and walks the whole conversation, asserting the
       order of commands and the headers in the DATA payload. */
    section('SMTP delivery (against a fake server)');

    const fake = await fakeSmtpServer();
    const prevEnv = Object.assign({}, process.env);
    process.env.DOTMD_SMTP_HOST = '127.0.0.1';
    process.env.DOTMD_SMTP_PORT = String(fake.port);
    process.env.DOTMD_SMTP_USER = 'me@example.com';
    process.env.DOTMD_SMTP_PASS = 'app-password';
    process.env.DOTMD_MAIL_FROM = 'dotMDpritter <no-reply@example.com>';
    process.env.DOTMD_SMTP_INSECURE = '1';
    delete process.env.DOTMD_SMTP_SECURE;

    try {
      const result = await mailer.send({
        to: 'carol@example.com',
        subject: 'Reset your dotMDpritter password',
        text: 'Use this link:\n\nhttp://127.0.0.1/?reset=abc123\n'
      });
      const seen = await fake.done();
      if (process.env.DOTMD_TEST_DEBUG) {
        console.log('\n----- SMTP transcript -----\n' + seen.transcript + '----- end -----\n');
      }

      eq('delivery is reported as successful', result.delivered, true);
      eq('EHLO is sent before STARTTLS is offered',
        seen.commands.indexOf('EHLO') < seen.commands.indexOf('STARTTLS'), true);
      eq('EHLO is sent again after STARTTLS',
        seen.commands.filter((c) => c === 'EHLO').length, 2);
      eq('STARTTLS is attempted on an implicit-TLS-free port',
        seen.commands.includes('STARTTLS'), true);
      eq('authentication happens after the upgrade',
        seen.commands.indexOf('AUTH') > seen.commands.indexOf('STARTTLS'), true);
      eq('the envelope sender is the configured From',
        seen.full.includes('MAIL FROM:<no-reply@example.com>'), true);
      eq('the envelope recipient is the real user',
        seen.full.includes('RCPT TO:<carol@example.com>'), true);

      /* The headers are the whole ballgame: a message without From/To/Date
         is undeliverable or lands in spam, so assert them explicitly. */
      const body = seen.data;
      ok('DATA carries a From header', /^From: dotMDpritter <no-reply@example\.com>$/im.test(body), body.slice(0, 200));
      ok('DATA carries a To header', /^To: carol@example\.com$/im.test(body));
      ok('DATA carries the Subject', /^Subject: Reset your dotMDpritter password$/im.test(body));
      ok('DATA carries an RFC 5322 Date',
        /^Date: \w{3}, \d{2} \w{3} \d{4} \d{2}:\d{2}:\d{2} [+-]\d{4}$/im.test(body),
        (/^Date:.*$/im.exec(body) || ['none'])[0]);
      ok('DATA carries a unique Message-ID',
        /^Message-ID: <[0-9a-f]{32}@example\.com>$/im.test(body),
        (/^Message-ID:.*$/im.exec(body) || ['none'])[0]);
      ok('DATA declares text/plain',
        /^Content-Type: text\/plain; charset=utf-8$/im.test(body));
      ok('headers are separated from the body by a blank line',
        /\r\n\r\nUse this link:/.test(body));
      ok('the reset link is in the body', body.includes('http://127.0.0.1/?reset=abc123'));
      ok('the message is closed with the terminating dot',
        seen.data.length > 0 && seen.transcript.includes('C: .\n'));

      /* Dot-stuffing: a body line that is just "." would end DATA early. */
      await fake.reset();
      const dotted = await mailer.send({
        to: 'carol@example.com', subject: 'Dots', text: 'line one\n.\nline three\n'
      });
      const seen2 = await fake.done();
      eq('a dotted body still delivers', dotted.delivered, true);
      ok('a bare dot line is escaped', /\r\n\.\.\r\n/.test(seen2.data), JSON.stringify(seen2.data));
    } finally {
      await fake.close();
      for (const k of ['DOTMD_SMTP_HOST', 'DOTMD_SMTP_PORT', 'DOTMD_SMTP_USER',
        'DOTMD_SMTP_PASS', 'DOTMD_MAIL_FROM', 'DOTMD_SMTP_SECURE',
        'DOTMD_SMTP_INSECURE']) {
        if (prevEnv[k] === undefined) delete process.env[k];
        else process.env[k] = prevEnv[k];
      }
    }

    /* ---------------------------------------------------- logout */
    section('Logout');

    r = await request(P, 'POST', '/api/auth/logout');
    eq('logout succeeds', r.status, 200);
    r = await request(P, 'GET', '/api/auth/session');
    eq('session is gone after logout', r.body.user, null);
    r = await request(P, 'GET', '/api/files');
    eq('files are unreachable after logout', r.status, 401);

    /* ---------------------------------------------- static files */
    section('Static assets are still served');

    const get = (p) => new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: P, path: p }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
    });

    section('Health endpoint (used by PaaS probes)');
    const health = await request(P, 'GET', '/api/health');
    eq('health returns 200', health.status, 200);
    eq('health reports ok', health.body.ok, true);
    eq('health confirms the data dir is writable', health.body.writable, true);
    ok('health reports uptime', typeof health.body.uptime === 'number');
    ok('health leaks nothing about users',
      !JSON.stringify(health.body).includes('@'), JSON.stringify(health.body));

    section('HTTPS detection behind a proxy');
    const httpsCookie = await new Promise((resolve) => {
      const body = Buffer.from(JSON.stringify({ email: 'a@b.co', password: 'password123' }));
      const req = http.request(
        { host: '127.0.0.1', port: P, method: 'POST', path: '/api/auth/register',
          headers: {
            'X-DotMD': '1',
            'X-Forwarded-Proto': 'https',
            'Content-Type': 'application/json',
            'Content-Length': body.length
          } },
        (res) => { res.resume(); res.on('end', () => resolve(String(res.headers['set-cookie']))); }
      );
      req.write(body);
      req.end();
    });
    ok('X-Forwarded-Proto: https sets the Secure flag',
      httpsCookie.includes('Secure'), httpsCookie);
    ok('cookie is HttpOnly', httpsCookie.includes('HttpOnly'));
    ok('cookie is SameSite=Strict', httpsCookie.includes('SameSite=Strict'));
    ok('index.html is served', (await get('/')) === 200);
    ok('app.css is served', (await get('/assets/css/app.css')) === 200);
    ok('vendored library is served', (await get('/vendor/marked.min.js')) === 200);
    ok('cloud client is served', (await get('/assets/js/cloud.js')) === 200);

    /* Static serving uses an allow-list, not a deny-list. */
    const mustBlock = [
      '/data/users.json', '/server/api.js', '/server/storage.js',
      '/apitest.js', '/selftest.js', '/cloudtest.js', '/runall.js',
      '/package.json', '/.gitignore', '/server.js'
    ];
    for (const p of mustBlock) {
      const status = await get(p);
      ok('blocks ' + p, status >= 400, 'status ' + status);
    }

    eq('unknown api route 404s', await get('/api/nope'), 404);
  } catch (err) {
    console.error('\nHarness error:', err && err.stack ? err.stack : err);
    fail++;
  } finally {
    await close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  console.log('\n' + '-'.repeat(52));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('-'.repeat(52) + '\n');
  process.exit(fail === 0 ? 0 : 1);
}

run();

