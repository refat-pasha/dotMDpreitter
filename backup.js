#!/usr/bin/env node
/* =========================================================================
   backup.js — make a timestamped, restorable snapshot of the data directory.
   Accounts, sessions and every user's .md files live in here, so this is the
   one file you want on a schedule.

   Usage:
     node backup.js                      → ./backups/dotmd-<stamp>.tar.gz
     node backup.js <dataDir> <outDir>
     node backup.js --restore <archive>  → extract into the data directory

   Cron (daily at 03:17):
     17 3 * * *  cd /opt/dotmdpritter && /usr/bin/node backup.js >> /var/log/dotmd-backup.log 2>&1
   ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);

if (args[0] === '--restore') {
  const archive = args[1];
  if (!archive || !fs.existsSync(archive)) {
    console.error('Usage: node backup.js --restore <archive.tar.gz>');
    process.exit(1);
  }

  const target = path.resolve(process.env.DOTMD_DATA || path.join(__dirname, 'data'));
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = now.getFullYear() + p(now.getMonth() + 1) + p(now.getDate()) +
    '-' + p(now.getHours()) + p(now.getMinutes()) + p(now.getSeconds());
  const rollback = target + '.replaced-' + stamp;

  console.log('Restoring into ' + target);
  console.log('The current data directory will be moved aside, not merged.');

  if (!fs.existsSync(target)) {
    console.error('Nothing to restore over — no data directory at ' + target);
    process.exit(1);
  }

  /* tar overwrites but never deletes, so extracting in place would leave
     files created after the snapshot behind and silently not roll back.
     Move the current directory aside first, then extract into a clean slate.
     If extraction fails, put the original back. */
  fs.renameSync(target, rollback);
  try {
    fs.mkdirSync(target, { recursive: true });
    execFileSync('tar', ['-xzf', archive, '-C', target], { stdio: 'inherit' });
  } catch (err) {
    console.error('Restore failed, rolling back:', err.message);
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(rollback, target);
    process.exit(1);
  }

  console.log('\nDone.');
  console.log('The replaced directory is kept at:\n  ' + rollback);
  console.log('Delete it once you have confirmed the restore.');
  console.log('Restart the app so it reloads the store.');
  process.exit(0);
}

const dataDir = path.resolve(args[0] || process.env.DOTMD_DATA || path.join(__dirname, 'data'));
const outDir = path.resolve(args[1] || path.join(__dirname, 'backups'));

if (!fs.existsSync(dataDir)) {
  console.error('No data directory at ' + dataDir);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

const now = new Date();
const p = (n) => String(n).padStart(2, '0');
const stamp = now.getFullYear() + p(now.getMonth() + 1) + p(now.getDate()) +
  '-' + p(now.getHours()) + p(now.getMinutes()) + p(now.getSeconds());
const archive = path.join(outDir, `dotmd-${stamp}.tar.gz`);

try {
  /* Archive the *contents* of dataDir, not the directory itself, so that
     extracting with -C <dataDir> does not produce data/data/. */
  execFileSync('tar', ['-czf', archive, '-C', dataDir, '.'], { stdio: 'inherit' });
} catch (err) {
  console.error('Backup failed:', err.message);
  process.exit(1);
}

const bytes = fs.statSync(archive).size;
const mb = (bytes / 1048576).toFixed(2);
console.log(`Backup written: ${archive} (${mb} MB)`);

/* Keep the 14 most recent snapshots. */
const all = fs.readdirSync(outDir)
  .filter((f) => /^dotmd-\d{8}-\d{6}\.tar\.gz$/.test(f))
  .sort();

for (const old of all.slice(0, Math.max(0, all.length - 14))) {
  fs.unlinkSync(path.join(outDir, old));
  console.log('Pruned old snapshot: ' + old);
}
