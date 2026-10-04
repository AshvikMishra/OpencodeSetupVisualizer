/**
 * Collection context: resolves every location we may read, and provides the
 * helpers used to turn an absolute path into a home-tokenised display path.
 *
 * Nothing here touches the network or writes to disk.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { homeToken } from '../exec.js';

/** Build the set of well-known locations for a given home + project dir. */
export function makeContext({ home, projectDir, platform = process.platform } = {}) {
  const homeDir = home || os.homedir() || process.env.USERPROFILE || process.env.HOME || '';
  const isWin = platform === 'win32';
  const sep = isWin ? '\\' : '/';
  const token = isWin ? '%USERPROFILE%' : '~';

  // Build paths with the native separator, then display with '/' which the
  // template reads naturally and which is stable in JSON.
  const join = (...parts) => parts.filter(Boolean).join(sep);

  const globalDir = join(homeDir, '.config', 'opencode');
  const agentsSkillDir = join(homeDir, '.agents', 'skills');
  const globalSkillDir = join(globalDir, 'skills');
  const stateDir = join(homeDir, '.local', 'state', 'opencode');
  const cacheDir = join(homeDir, '.cache', 'opencode');
  const projectLocalDir = join(projectDir, '.opencode');

  return {
    isWin,
    sep,
    token,
    homeDir,
    projectDir,
    globalDir,
    agentsSkillDir,
    globalSkillDir,
    stateDir,
    cacheDir,
    projectLocalDir,
    /** Convert an absolute path into a tokenised, forward-slash display path. */
    display(abs) {
      if (!abs) return '';
      let s = String(abs);
      if (homeDir && homeDir.length > 1) {
        const win = homeDir.replace(/\//g, '\\');
        const posix = homeDir.replace(/\\/g, '/');
        s = s.split(win).join(token).split(posix).join(token);
      }
      return s.replace(/\\/g, '/');
    },
    /** Display a path relative to the project dir, tokenised. */
    projectDisplay(abs) {
      if (!abs) return '';
      const d = this.display(abs);
      if (this.homeDir && projectDir) {
        const p = this.display(projectDir);
        if (d.startsWith(p)) return '.' + d.slice(p.length);
      }
      return d;
    },
  };
}

/** fs helpers that never throw. */
export function readFileSafe(p, maxBytes = 1024 * 1024) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return { ok: false, reason: 'not a file' };
    if (st.size > maxBytes) {
      const fd = fs.openSync(p, 'r');
      try {
        const buf = Buffer.alloc(maxBytes);
        fs.readSync(fd, buf, 0, maxBytes, 0);
        return { ok: true, text: buf.toString('utf8'), bytes: st.size, truncated: true };
      } finally {
        fs.closeSync(fd);
      }
    }
    return { ok: true, text: fs.readFileSync(p, 'utf8'), bytes: st.size, truncated: false };
  } catch (e) {
    return { ok: false, reason: e.code === 'ENOENT' ? 'not found' : e.message };
  }
}

export function statSafe(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

export function readDirSafe(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function isFile(p) {
  const st = statSafe(p);
  return !!st && st.isFile();
}

export function isDir(p) {
  const st = statSafe(p);
  return !!st && st.isDirectory();
}

/**
 * Recursively list files under a dir, bounded. Never throws.
 *
 * Returns `{ files, truncated }`. A bare array would let a caller report the
 * cap as a real count, which is why truncation is explicit.
 */
export function listFilesRecursive(root, { maxDepth = 4, maxFiles = 500 } = {}) {
  const files = [];
  let truncated = false;
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    if (files.length >= maxFiles) { truncated = true; return; }
    for (const ent of readDirSafe(dir)) {
      if (files.length >= maxFiles) { truncated = true; return; }
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full, depth + 1);
      else if (ent.isFile()) files.push(full);
    }
  };
  if (isDir(root)) walk(root, 0);
  return { files, truncated };
}

/**
 * Total bytes and file count of a directory tree.
 *
 * `maxFiles` is a guard against pathological trees (a symlink loop, a mounted
 * filesystem). When it trips, `truncated` is true and the counts are a LOWER
 * BOUND — callers must say so rather than presenting them as a measurement.
 */
export function dirSize(root, { maxFiles = 200_000 } = {}) {
  let total = 0;
  let count = 0;
  let truncated = false;
  const walk = dir => {
    for (const ent of readDirSafe(dir)) {
      if (count >= maxFiles) {
        truncated = true;
        return;
      }
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) {
        const st = statSafe(full);
        if (st) {
          total += st.size;
          count++;
        }
      }
      if (truncated) return;
    }
  };
  if (isDir(root)) walk(root);
  return { bytes: total, files: count, truncated };
}
