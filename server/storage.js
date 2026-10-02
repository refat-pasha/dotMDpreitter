/* =========================================================================
   server/storage.js — per-user Markdown files stored in real folders.

   Layout on disk:
       data/users/<userId>/<folder>/<file>.md

   Every path is resolved and then verified to sit inside the user's root,
   so no crafted name can ever escape into another account.
   ========================================================================= */
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { ensureDir } = require('./db');

const ROOT_FOLDER = 'notes';
const MAX_NAME_LEN = 120;
const MAX_FILE_BYTES = 8 * 1024 * 1024;   // 8 MB
const MAX_READ_BYTES = MAX_FILE_BYTES * 2;

const MD_EXT = /\.(md|markdown|mdown|mkd|txt)$/i;

/* Windows device names are reserved even with an extension. */
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
]);

class StorageError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST') {
    super(message);
    this.name = 'StorageError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Validate a single path segment (one folder or file name).
 * @param {string} name
 * @param {{folder?:boolean}} [opts]
 */
function assertValidName(name, opts = {}) {
  const raw = String(name == null ? '' : name);

  if (!raw || !raw.trim()) {
    throw new StorageError('Name cannot be empty.');
  }
  if (raw !== raw.trim()) {
    throw new StorageError('Name cannot start or end with whitespace.');
  }
  if (raw.length > MAX_NAME_LEN) {
    throw new StorageError(`Name must be ${MAX_NAME_LEN} characters or fewer.`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    throw new StorageError('Name contains control characters.');
  }
  if (/[<>:"/\\|?*]/.test(raw)) {
    throw new StorageError('Name cannot contain < > : " / \\ | ? *');
  }
  if (raw === '.' || raw === '..') {
    throw new StorageError('Name cannot be "." or "..".');
  }
  if (raw.endsWith('.') || raw.endsWith(' ')) {
    throw new StorageError('Name cannot end with a dot.');
  }
  if (RESERVED.has(raw.split('.')[0].toLowerCase())) {
    throw new StorageError(`"${raw}" is a reserved device name.`);
  }
  if (!opts.folder && !MD_EXT.test(raw)) {
    throw new StorageError('Only .md, .markdown, .mdown, .mkd and .txt files are allowed.');
  }
  return raw;
}

/** Split a client-supplied relative path into validated segments. */
function parseRelPath(rel, opts = {}) {
  const parts = String(rel == null ? '' : rel)
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '' && s !== '.');
  if (opts.allowEmpty) return parts;
  if (!parts.length) throw new StorageError('A path is required.');
  return parts;
}


/* ===================================================================== */

class UserStorage {
  /**
   * @param {string} usersDir  parent directory holding one folder per user
   * @param {string} userId
   */
  constructor(usersDir, userId) {
    this.userId = userId;
    this.root = path.join(usersDir, userId);
  }

  async init() {
    ensureDir(this.root);
    ensureDir(this.resolve([ROOT_FOLDER], { kind: 'folder' }));
  }

  /**
   * Resolve a relative path inside the user's root.
   * @param {string|string[]} rel
   * @param {{kind?:'file'|'folder'|'any', allowEmpty?:boolean}} [opts]
   *   `kind` describes what the LAST segment is. 'any' skips the extension
   *   check, which is what folder listings and rename sources need.
   * @returns {string} absolute path, guaranteed inside this.root
   */
  resolve(rel, opts = {}) {
    const kind = opts.kind || 'file';
    const segments = Array.isArray(rel)
      ? rel.slice()
      : parseRelPath(rel, opts);

    segments.forEach((s, i) => {
      const isLast = i === segments.length - 1;
      const asFolder = kind === 'folder' || (kind === 'any' && isLast) || !isLast;
      assertValidName(s, { folder: asFolder });
    });

    const abs = path.resolve(this.root, ...segments);
    const rootWithSep = this.root + path.sep;
    if (abs !== this.root && !abs.startsWith(rootWithSep)) {
      throw new StorageError('Invalid path.', 400, 'INVALID_PATH');
    }
    return abs;
  }

  relOf(abs) {
    return path.relative(this.root, abs).split(path.sep).join('/');
  }

  /* ------------------------------------------------------- listings */

  /** Tree of folders + Markdown files, directories first. */
  async list(rel = '') {
    const abs = this.resolve(rel, { allowEmpty: true, kind: 'any' });
    let entries;
    try {
      entries = await fsp.readdir(abs, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new StorageError('That folder does not exist.', 404, 'NOT_FOUND');
      }
      throw new StorageError('Could not read that folder.', 500, 'IO_ERROR');
    }

    const folders = [];
    const files = [];

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const childAbs = path.join(abs, entry.name);

      if (entry.isDirectory()) {
        folders.push({ name: entry.name, path: this.relOf(childAbs) });
        continue;
      }
      if (!entry.isFile() || !MD_EXT.test(entry.name)) continue;

      const st = await fsp.stat(childAbs).catch(() => null);
      if (!st) continue;
      files.push({
        name: entry.name,
        path: this.relOf(childAbs),
        size: st.size,
        modifiedAt: st.mtimeMs,
        title: readTitle(childAbs)
      });
    }

    folders.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => b.modifiedAt - a.modifiedAt);
    return { path: rel || '', parent: parentOf(rel), folders, files };
  }

  /* ---------------------------------------------------------- files */

  async read(rel) {
    const abs = this.resolve(rel);
    let st;
    try {
      st = await fsp.stat(abs);
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new StorageError('File not found.', 404, 'NOT_FOUND');
      }
      throw new StorageError('Could not read that file.', 500, 'IO_ERROR');
    }
    if (!st.isFile()) throw new StorageError('That path is not a file.', 400, 'NOT_A_FILE');
    if (st.size > MAX_FILE_BYTES) {
      throw new StorageError('That file is too large to open (limit 8 MB).', 413, 'TOO_LARGE');
    }
    const content = await fsp.readFile(abs, 'utf8');
    return {
      name: path.basename(abs), path: this.relOf(abs),
      content, size: st.size, modifiedAt: st.mtimeMs
    };
  }

  /** Create or overwrite a file. */
  async write(rel, content) {
    const abs = this.resolve(rel);
    const text = String(content == null ? '' : content);
    if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) {
      throw new StorageError('That file is too large to save (limit 8 MB).', 413, 'TOO_LARGE');
    }
    try {
      const st = await fsp.stat(abs);
      if (st.isDirectory()) {
        throw new StorageError('A folder already uses that name.', 409, 'CONFLICT');
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    ensureDir(path.dirname(abs));
    await fsp.writeFile(abs, text, 'utf8');
    const st = await fsp.stat(abs);
    return { name: path.basename(abs), path: this.relOf(abs), size: st.size, modifiedAt: st.mtimeMs };
  }

  async createFolder(rel) {
    const abs = this.resolve(rel, { kind: 'folder' });
    try {
      await fsp.mkdir(abs, { recursive: true });
    } catch (err) {
      if (err.code === 'EEXIST') {
        throw new StorageError('A folder with that name already exists.', 409, 'CONFLICT');
      }
      throw new StorageError('Could not create that folder.', 500, 'IO_ERROR');
    }
    return { name: path.basename(abs), path: this.relOf(abs) };
  }


  /* ------------------------------------------------ rename / delete */

  async rename(fromRel, toName) {
    const fromAbs = this.resolve(fromRel, { kind: 'any' });
    const segments = parseRelPath(fromRel);
    const targetName = assertValidName(toName, { folder: !MD_EXT.test(String(toName)) });
    const toAbs = this.resolve([...segments.slice(0, -1), targetName], {
      kind: MD_EXT.test(targetName) ? 'file' : 'folder'
    });

    if (fromAbs === toAbs) {
      return { name: targetName, path: this.relOf(toAbs), noop: true };
    }
    try {
      await fsp.access(toAbs);
      throw new StorageError('Something with that name already exists.', 409, 'CONFLICT');
    } catch (err) {
      if (err instanceof StorageError) throw err;
      if (err.code !== 'ENOENT') throw err;
    }
    try {
      await fsp.rename(fromAbs, toAbs);
    } catch (err) {
      throw new StorageError('Could not rename that item.', 500, 'IO_ERROR');
    }
    return { name: targetName, path: this.relOf(toAbs) };
  }

  /** Delete a file or a folder (recursively). */
  async remove(rel) {
    const abs = this.resolve(rel);
    try {
      await fsp.access(abs);
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new StorageError('Not found.', 404, 'NOT_FOUND');
      }
      throw new StorageError('Could not remove that item.', 500, 'IO_ERROR');
    }
    try {
      await fsp.rm(abs, { recursive: true, force: true });
    } catch (err) {
      throw new StorageError('Could not remove that item.', 500, 'IO_ERROR');
    }
    return { path: this.relOf(abs) };
  }

  async stat(rel) {
    const abs = this.resolve(rel);
    try {
      return await fsp.stat(abs);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw new StorageError('Could not stat that item.', 500, 'IO_ERROR');
    }
  }

  async exists(rel) {
    return (await this.stat(rel)) !== null;
  }

  /* -------------------------------------------------------- account */

  /** Delete every file this user owns. Used when an account is removed. */
  async destroy() {
    await fsp.rm(this.root, { recursive: true, force: true });
  }
}

/* ---------------------------------------------------------- helpers */

function parentOf(rel) {
  const s = String(rel || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!s || !s.includes('/')) return '';
  return s.slice(0, s.lastIndexOf('/'));
}

/**
 * First Markdown heading in a file, used as a subtitle in the file list.
 * Reads only the first few KB. Never throws.
 * @param {string} abs absolute path
 * @returns {string}
 */
function readTitle(abs) {
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
  } catch (_) {
    return '';
  }
  try {
    const size = Math.min(4096, fs.fstatSync(fd).size);
    if (size <= 0) return '';
    const buf = Buffer.allocUnsafe(size);
    fs.readSync(fd, buf, 0, size, 0);
    const head = buf.toString('utf8', 0, size);
    const m = /^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(head);
    return m ? m[1].trim().slice(0, 120) : '';
  } catch (_) {
    return '';
  } finally {
    try { fs.closeSync(fd); } catch (_) { /* ignore */ }
  }
}

module.exports = {
  UserStorage, StorageError,
  assertValidName, parseRelPath, parentOf, readTitle,
  ROOT_FOLDER, MAX_NAME_LEN, MAX_FILE_BYTES, MD_EXT
};

