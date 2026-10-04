/**
 * playwright-cli driver for verification scripts.
 *
 * `playwright-cli` is installed globally by npm as an `opencode.cmd`-style shim,
 * and Node >= 20 refuses to spawn a `.cmd` without a shell (EINVAL). We reuse the
 * product's own verified `unwrapShim()` to reach the real `.js` entry point, then
 * spawn that with an argv array — no shell, no quoting.
 *
 * `--browser msedge` because Chrome is not installed on this machine.
 *
 * Nothing here is shipped in the package.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pexec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BROWSER = process.env.OVZ_BROWSER || 'msedge';
const SESSION = process.env.OVZ_SESSION || 'default';

/**
 * Resolve playwright-cli to a `.js` entry point Node can actually spawn.
 *
 * This resolver is deliberately INDEPENDENT of the product's `unwrapShim()`.
 * The product spawns the `opencode` binary and must refuse anything Node cannot
 * exec, so `unwrapShim()` is restricted to `.exe`/`.com` targets inside the npm
 * tree. Playwright ships as a pure-JS CLI: its npm shim points straight at a
 * `.js` file, which Node refuses to exec directly (EFTYPE) — the `.cmd` shim
 * works only because cmd.exe runs it under `node`.
 *
 * So this harness spawns the current node binary with that `.js` as argv[1],
 * which is exactly what the `.cmd` does internally, and applies its own
 * containment check. It never relaxes the product's rule.
 */
const SHIM_CANDIDATES = ['playwright-cli.cmd', 'playwright-cli.ps1', 'playwright-cli'];

function npmGlobalDirs() {
  const dirs = [];
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
  if (process.env.ProgramFiles) dirs.push(path.join(process.env.ProgramFiles, 'npm'));
  const prefix = process.env.npm_config_prefix;
  if (prefix) dirs.push(prefix);
  return dirs.filter(d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
}

/** Pull a quoted relative-or-absolute path ending in `.js` out of a shim file. */
function jsEntryFromShim(file) {
  let body;
  try { body = fs.readFileSync(file, 'utf8'); } catch { return null; }
  for (const m of body.matchAll(/["']?((?:%dp0%|~\/|\$basedir[\\/])?[^"'\r\n]*?\.js)["']?/g)) {
    let p = m[1].replace(/%dp0%|~\/|\$basedir[\\/]/g, '');
    if (!p) continue;
    let abs = path.isAbsolute(p) ? p : path.resolve(path.dirname(file), p);
    try { if (fs.statSync(abs).isFile()) return abs; } catch { /* keep looking */ }
  }
  return null;
}

/** Look for the package directly, in case no shim is present. */
function jsEntryByScan() {
  for (const dir of npmGlobalDirs()) {
    for (const rel of [
      ['node_modules', '@playwright', 'cli', 'playwright-cli.js'],
      ['node_modules', 'playwright', 'cli.js'],
      ['node_modules', 'playwright-core', 'cli.js'],
    ]) {
      const abs = path.join(dir, ...rel);
      try { if (fs.statSync(abs).isFile()) return abs; } catch { /* keep looking */ }
    }
  }
  return null;
}

/**
 * Resolve playwright-cli to something Node can spawn.
 * Returns `{ file, args }` or null when nothing usable is installed.
 */
export function resolveCli() {
  for (const dir of npmGlobalDirs()) {
    for (const name of SHIM_CANDIDATES) {
      const found = jsEntryFromShim(path.join(dir, name));
      // Containment: the entry must live inside the npm prefix we just read.
      // The shim's own bytes must not be able to point the spawn elsewhere.
      if (found && path.resolve(found).toLowerCase().startsWith(path.resolve(dir).toLowerCase() + path.sep)) {
        return { file: process.execPath, args: [found] };
      }
    }
  }
  const scanned = jsEntryByScan();
  if (scanned) return { file: process.execPath, args: [scanned] };
  return null;
}

/**
 * Run a playwright-cli command with an argv array. Every argument is a literal
 * defined in this repository; no discovered value is ever interpolated.
 */
export async function pw(args, { allowFail = false, timeout = 180000 } = {}) {
  const c = resolveCli();
  try {
    const r = await pexec(c.file, [...c.args, '-s=' + SESSION, ...args], {
      encoding: 'utf8',
      maxBuffer: 96 * 1024 * 1024,
      windowsHide: true,
      timeout,
    });
    return r.stdout;
  } catch (e) {
    if (allowFail) return `${e.stdout || ''}${e.stderr || ''}`;
    throw new Error(
      `playwright-cli ${args[0]}: ${String(e.message).split('\n').slice(0, 3).join(' | ')}`
    );
  }
}

/** Is the CLI usable at all? */
export async function available() {
  const c = resolveCli();
  if (!c) return false;
  try {
    const r = await pexec(c.file, [...c.args, '--version'], {
      encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 16 * 1024 * 1024,
    });
    // A non-zero exit is still a resolution failure even if it printed a version.
    return /^\s*\d/.test(r.stdout) || /version/i.test(r.stdout);
  } catch {
    return false;
  }
}

export async function openBrowser(url = 'about:blank') {
  await pw(['kill-all'], { allowFail: true });
  await pw(['open', '--browser', BROWSER, url]);
}

export async function closeBrowser() {
  await pw(['close'], { allowFail: true });
}

/**
 * Deterministic page setup: fixed viewport, reduced motion (removes the
 * template's entrance animations), dark scheme, then reload and settle for the
 * Tailwind CDN and webfonts.
 */
export async function prepare(url, { width = 1440, height = 900, settleMs = 2500 } = {}) {
  await pw(['resize', String(width), String(height)]);
  await pw(['set-reduced-motion', 'reduce']);
  await pw(['set-color-scheme', 'dark']);
  await pw(['goto', url]);
  await new Promise(r => setTimeout(r, settleMs));
  return url;
}

/** Console messages emitted so far. */
export async function consoleMessages() {
  const out = await pw(['console'], { allowFail: true });
  return out.split('\n').map(l => l.trim()).filter(Boolean);
}

/** All network requests the page has made. */
export async function networkRequests() {
  return pw(['requests'], { allowFail: true });
}

export { BROWSER, SESSION, fs };
