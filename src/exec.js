/**
 * Safe process execution.
 *
 * Hard rule: argument arrays are ALWAYS fixed constants defined in this repo.
 * No shell string is ever built from a discovered (untrusted) value.
 *
 * Windows note (verified on this machine): `opencode` on PATH is an `opencode.cmd`
 * shim. Node >= 20 refuses to spawn a `.cmd` without a shell (EINVAL). The shim
 * body is a single line naming the real executable, so we parse it out and spawn
 * the real binary directly. That avoids the shell entirely.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

/** Fixed argument vectors. Nothing discovered is ever concatenated into these. */
const FIXED_ARGS = Object.freeze({
  version: ['--version'],
  agent: ['api', 'get', '/api/agent'],
  skill: ['api', 'get', '/api/skill'],
  provider: ['api', 'get', '/api/provider'],
  mcpApi: ['api', 'get', '/api/mcp'],
  models: ['models'],
  mcpList: ['mcp', 'list'],
  pluginList: ['plugin', 'list']
});

/** Walk PATH looking for a candidate file, honouring PATHEXT on Windows. */
function findOnPath(name) {
  const isWin = process.platform === 'win32';
  const exts = isWin
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + (ext === '' ? '' : ext.toLowerCase()));
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* not here; keep looking */
      }
    }
  }
  return null;
}

/**
 * Read an npm .cmd/.bat shim and pull out the executable it wraps.
 *
 * npm shims are not uniform. The conventional form is
 *     "%~dp0\node_modules\@scope\pkg\bin\thing.exe"   %*
 * but the shim installed by this machine's npm writes `%dp0%` (no tilde).
 * Both are handled, plus a bare relative path.
 *
 * Returns an absolute path, or null if the shim isn't a recognisable wrapper.
 */
export function unwrapShim(shimPath) {
  let body;
  try {
    body = fs.readFileSync(shimPath, 'utf8');
  } catch {
    return null;
  }
  // Take the LAST quoted path that ends in .exe/.js/.cmd before any %* token.
  // Only a real executable is accepted. A .js or .cmd target cannot be spawned
  // by Node on Windows (EFTYPE / EINVAL), so accepting one would make every
  // subsequent call fail with a spawn error instead of a clear "unavailable".
  const quoted = [...body.matchAll(/"([^"]+\.(?:exe|com))"/gi)].map(m => m[1]);
  if (!quoted.length) return null;
  const target = quoted[quoted.length - 1];
  const shimDir = path.dirname(shimPath);

  // %~dp0  and  %dp0%  both mean "the directory containing this shim".
  const DP0 = /^%(?:~dp0|dp0%)/i;
  const candidates = [];
  if (DP0.test(target)) {
    candidates.push(path.resolve(shimDir, target.replace(DP0, '').replace(/^[\\/]+/, '')));
  }
  candidates.push(path.resolve(target));
  // Any other %VAR% left in the path is unresolved; try with it stripped too.
  const stripped = target.replace(/%[A-Za-z_][A-Za-z0-9_]*%/g, '').replace(/^[\\/]+/, '');
  if (stripped) candidates.push(path.resolve(shimDir, stripped));

  for (const resolved of candidates) {
    try {
      if (fs.statSync(resolved).isFile()) return resolved;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

let cachedCommand = null;

/**
 * Resolve `opencode` to something Node can spawn without a shell.
 * Order: shim -> unwrapped real exe -> PATH exe -> PATH js -> 'opencode'.
 */
export function resolveOpencodeCommand(name = 'opencode', { forcePath = null } = {}) {
  if (forcePath) return forcePath;
  if (cachedCommand) return cachedCommand;

  const found = findOnPath(name);
  if (found) {
    const lower = found.toLowerCase();
    if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
      const real = unwrapShim(found);
      if (real) {
        cachedCommand = real;
        return real;
      }
    }
    if (lower.endsWith('.exe') || lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
      cachedCommand = found;
      return found;
    }
  }
  // Last resort: let the OS resolve it (POSIX, or a direct .exe on PATH).
  cachedCommand = name;
  return cachedCommand;
}

/** Test seam: drop the memoised resolution. */
export function resetCommandCache() {
  cachedCommand = null;
}

/**
 * Run one of the fixed argument vectors. Always resolves; never rejects.
 * @returns {Promise<{ok:boolean, stdout:string, stderr:string, code:number|null, reason?:string, timedOut?:boolean}>}
 */
export function runOpencode(which, opts = {}) {
  const args = FIXED_ARGS[which];
  if (!args) {
    return Promise.resolve({ ok: false, stdout: '', stderr: '', code: null, reason: `unknown command: ${which}` });
  }
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    command = resolveOpencodeCommand(),
    cwd = undefined,
  } = opts;

  return new Promise(resolve => {
    let settled = false;
    const finish = r => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    const child = execFile(
      command,
      args,
      { timeout: timeoutMs, maxBuffer: maxBytes, windowsHide: true, cwd, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          const killed = err.killed === true || err.signal === 'SIGTERM';
          const notFound = err.code === 'ENOENT';
          const eacces = err.code === 'EACCES' || err.code === 'EINVAL';
          const reason = notFound
            ? 'opencode executable not found on PATH'
            : eacces
              ? `opencode could not be executed (${err.code}) — the .cmd shim may be unresolvable`
              : killed
                ? `command timed out after ${timeoutMs}ms`
                : `command failed: ${String(err.message).split('\n')[0]}`;
          return finish({ ok: false, stdout: stdout || '', stderr: stderr || '', code: err.code ?? null, reason, timedOut: killed });
        }
        finish({ ok: true, stdout: stdout || '', stderr: stderr || '', code: 0 });
      }
    );

    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
      finish({ ok: false, stdout: '', stderr: '', code: null, reason: `command timed out after ${timeoutMs}ms`, timedOut: true });
    }, timeoutMs + 500);
  });
}

/** Run a fixed command and parse stdout as JSON. Never throws. */
export async function runOpencodeJson(which, opts = {}) {
  const r = await runOpencode(which, opts);
  if (!r.ok) return { ok: false, data: null, reason: r.reason };
  if (!r.stdout.trim()) return { ok: false, data: null, reason: 'empty response' };
  try {
    return { ok: true, data: JSON.parse(r.stdout), reason: null };
  } catch {
    return { ok: false, data: null, reason: 'response was not valid JSON' };
  }
}

/** Locate the user's home directory. */
export function homeDir() {
  return os.homedir() || process.env.USERPROFILE || process.env.HOME || '';
}

/** The token used in place of the real home path in every emitted path. */
export function homeToken() {
  return process.platform === 'win32' ? '%USERPROFILE%' : '~';
}
