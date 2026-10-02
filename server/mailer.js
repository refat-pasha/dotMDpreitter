/* =========================================================================
   server/mailer.js — minimal SMTP client for password-reset email.

   Node's built-in net/tls only; this project deliberately has no npm
   dependencies. That means a single plain-text email through AUTH LOGIN,
   which is all a reset notice needs.

   Configuration (all optional):
     DOTMD_SMTP_HOST       e.g. smtp.gmail.com
     DOTMD_SMTP_PORT       default 587 (STARTTLS), or 465 for implicit TLS
     DOTMD_SMTP_SECURE     1 to use implicit TLS (usually port 465)
     DOTMD_SMTP_USER       username / API key
     DOTMD_SMTP_PASS       password / API secret
     DOTMD_MAIL_FROM       "dotMDpritter <no-reply@example.com>"

   With no SMTP configured the mailer does NOT throw: it prints the message
   to the server console and reports delivery=false, so a self-hosted copy
   still works and the owner can copy the reset link from the terminal.
   ========================================================================= */
'use strict';

const net = require('net');
const tls = require('tls');
const { randomBytes } = require('crypto');

function config() {
  return {
    host: process.env.DOTMD_SMTP_HOST || '',
    port: Number(process.env.DOTMD_SMTP_PORT) || 587,
    secure: process.env.DOTMD_SMTP_SECURE === '1' || Number(process.env.DOTMD_SMTP_PORT) === 465,
    user: process.env.DOTMD_SMTP_USER || '',
    pass: process.env.DOTMD_SMTP_PASS || '',
    from: process.env.DOTMD_MAIL_FROM || 'dotMDpritter <no-reply@localhost>',
    /* Only for a relay whose certificate is self-signed or otherwise not
       verifiable. Off by default: accepting any certificate would let an
       attacker on the network read the reset link in transit. */
    insecure: process.env.DOTMD_SMTP_INSECURE === '1'
  };
}

function isConfigured() {
  const c = config();
  return !!(c.host && c.user && c.pass);
}

/** RFC 5322 wants CRLF line endings; anything else confuses some servers. */
function normalizeBody(text) {
  return String(text).replace(/\r?\n/g, '\r\n');
}

/** Extract the bare address from a `Name <addr@host>` style string. */
function envelopeAddress(from) {
  const m = /<([^>]+)>/.exec(String(from));
  return (m ? m[1] : String(from)).trim();
}

function encodeBase64(str) {
  return Buffer.from(String(str), 'utf8').toString('base64');
}

/** TLS options for both the implicit and the STARTTLS connection. */
function tlsOpts(opts) {
  return process.env.DOTMD_SMTP_INSECURE === '1'
    ? Object.assign({ rejectUnauthorized: false }, opts)
    : opts;
}

/** RFC 5322 date, e.g. "Mon, 02 Oct 2026 12:00:00 +0000". */
function rfcDate(d) {
  return d.toUTCString().replace('GMT', '+0000');
}

/**
 * Build the full DATA payload: headers, blank line, body.
 * Every field here is required by RFC 5322. Without a Date and a
 * Message-ID most providers will reject or spam-folder the message, and
 * without From/To/Subject it is not deliverable at all.
 */
function buildMessage(mail, from) {
  const domain = envelopeAddress(from).split('@')[1] || 'localhost';
  const messageId = '<' + randomBytes(16).toString('hex') + '@' + domain + '>';
  const headers = [
    'From: ' + from,
    'To: ' + mail.to,
    'Subject: ' + mail.subject,
    'Date: ' + rfcDate(new Date()),
    'Message-ID: ' + messageId,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    'Auto-Submitted: auto-generated'
  ];
  return headers.join('\r\n') + '\r\n\r\n' + normalizeBody(mail.text);
}
/**
 * Read SMTP replies, transparently consuming multi-line continuations
 * ("250-..." lines are followed by a final "250 ...").
 */
function readReply(socket) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();                       // keep any partial line
      const done = lines.filter((l) => /^\d{3}(?: |$)/.test(l));
      if (!done.length) return;
      socket.removeListener('data', onData);
      const last = done[done.length - 1];
      const code = Number(last.slice(0, 3));
      if (code >= 200 && code < 400) resolve(last);
      else reject(new Error(`SMTP ${code}: ${last.slice(4).trim()}`));
    };
    socket.on('data', onData);
    socket.on('error', reject);
    socket.on('close', () => reject(new Error('SMTP connection closed early')));
  });
}

/** Send one command and wait for a reply whose code passes `expect`. */
async function sendCommand(socket, cmd, expect) {
  if (cmd !== null) socket.write(cmd + '\r\n');
  const reply = await readReply(socket);
  if (expect && !expect(Number(reply.slice(0, 3)))) {
    throw new Error(`Unexpected SMTP reply: ${reply.trim()}`);
  }
  return reply;
}

/** Print a reset email to the console when no mail server is configured. */
function printToConsole(mail) {
  const line = '  | ';
  console.log('');
  console.log('  +--- dotMDpritter password reset (no SMTP configured) ------------+');
  console.log(line + 'To:      ' + mail.to);
  console.log(line + 'Subject: ' + mail.subject);
  console.log(line);
  for (const l of String(mail.text).split('\n')) console.log(line + l);
  console.log('  +--------------------------------------------------------------+');
  console.log('  Set DOTMD_SMTP_HOST / _USER / _PASS to send this by email.');
  console.log('');
}
/**
 * Send one plain-text email.
 * @param {{to:string, subject:string, text:string}} mail
 * @returns {Promise<{delivered:boolean, reason?:string}>} never rejects
 */
async function send(mail) {
  const c = config();

  if (!isConfigured()) {
    printToConsole(mail);
    return { delivered: false, reason: 'smtp-not-configured' };
  }

  const from = envelopeAddress(c.from);
  const domain = from.split('@')[1] || 'localhost';

  return new Promise((resolve) => {
    let socket = null;
    const finish = (result) => {
      try { if (socket) socket.destroy(); } catch (_) { /* already gone */ }
      resolve(result);
    };
    const fail = (err) => {
      console.error('[mail] send failed:', err.message);
      finish({ delivered: false, reason: err.message });
    };

    socket = c.secure
      ? tls.connect(tlsOpts({ host: c.host, port: c.port, servername: c.host }), () => talk())
      : net.connect({ host: c.host, port: c.port }, () => talk());

    socket.setTimeout(20000, () => fail(new Error('SMTP timed out')));
    socket.on('error', fail);

    function upgrade() {
      if (c.secure) return Promise.resolve();
      return new Promise((res, rej) => {
        const plain = socket;
        plain.once('error', rej);
        const secured = tls.connect(tlsOpts({ socket: plain, servername: c.host }), () => {
          socket = secured;
          res();
        });
        secured.on('error', rej);
      });
    }

    async function talk() {
      try {
        await sendCommand(socket, null, (x) => x === 220);
        if (!c.secure) {
          // RFC 3207: greet with EHLO *before* STARTTLS so the server can
          // advertise what it supports, then again on the encrypted socket.
          await sendCommand(socket, `EHLO ${domain}`, (x) => x === 250);
          await sendCommand(socket, 'STARTTLS', (x) => x === 220);
        }
        await upgrade();
        await sendCommand(socket, `EHLO ${domain}`, (x) => x === 250);
        await sendCommand(socket, 'AUTH LOGIN', (x) => x === 334);
        await sendCommand(socket, encodeBase64(c.user), (x) => x === 334);
        await sendCommand(socket, encodeBase64(c.pass), (x) => x === 235);
        await sendCommand(socket, `MAIL FROM:<${from}>`, (x) => x === 250);
        await sendCommand(socket, `RCPT TO:<${envelopeAddress(mail.to)}>`,
          (x) => x === 250 || x === 251);
        await sendCommand(socket, 'DATA', (x) => x === 354);
        // Dot-stuffing: a bare "." line would otherwise end the message early.
        const body = buildMessage(mail, c.from).replace(/^\./gm, '..');
        await sendCommand(socket, body + '\r\n.', (x) => x === 250);
        await sendCommand(socket, 'QUIT', () => true);
        console.log('[mail] reset email sent to ' + mail.to);
        finish({ delivered: true });
      } catch (err) {
        fail(err);
      }
    }
  });
}

module.exports = { send, isConfigured, config, envelopeAddress, buildMessage };