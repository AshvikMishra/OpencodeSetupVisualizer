/**
 * Line-ending hygiene.
 *
 * A PowerShell `Set-Content` during a mutation experiment rewrote the template
 * with CRLF. Nothing failed loudly: the render tests reported "could not locate
 * the main inline script block", which points at the wrong cause, and the
 * template-integrity test still passed because the digest had been re-cut after
 * the damage. This asserts the repo does not mix conventions.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Text source files that must use LF. Binary assets are skipped by extension. */
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.html', '.css']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'artifacts', '.playwright-cli']);

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && e.name !== '.gitignore') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(full);
    } else if (TEXT_EXT.has(path.extname(e.name).toLowerCase())) {
      yield full;
    }
  }
}

function crlfCount(file) {
  const b = fs.readFileSync(file);
  let crlf = 0, lf = 0;
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 10) { if (i > 0 && b[i - 1] === 13) crlf++; else lf++; }
  }
  return { crlf, lf };
}

const files = [...walk(ROOT)];

test('every text source file uses LF line endings', () => {
  const offenders = [];
  for (const f of files) {
    const { crlf, lf } = crlfCount(f);
    if (crlf > 0) offenders.push(`${path.relative(ROOT, f)}: ${crlf} CRLF, ${lf} LF`);
  }
  assert.deepEqual(offenders, [],
    `CRLF found. A Windows line-ending conversion breaks the render tests with a ` +
    `misleading "could not locate the main script block" error:\n  ${offenders.join('\n  ')}`);
});

test('no file mixes CRLF and LF', () => {
  const mixed = [];
  for (const f of files) {
    const { crlf, lf } = crlfCount(f);
    if (crlf > 0 && lf > 0) mixed.push(`${path.relative(ROOT, f)}: ${crlf} CRLF + ${lf} LF`);
  }
  assert.deepEqual(mixed, [], `mixed line endings:\n  ${mixed.join('\n  ')}`);
});

test('the template is readable by the shared render stub', () => {
  // The concrete failure this prevents.
  const tpl = fs.readFileSync(path.join(ROOT, 'template', 'opencode-dashboard-example.html'), 'utf8');
  const m = /<script[^>]*>\r?\n([\s\S]*?)\r?\n<\/script>/.exec(tpl);
  assert.ok(m, 'the template must contain a script block the stub can locate');
  assert.ok(m[1].includes('const SNAPSHOT'), 'that block must be the injected one');
});

test('the walk actually inspected files', () => {
  // A scan that finds nothing because it looked at nothing is not a pass.
  assert.ok(files.length > 20, `only ${files.length} text files found — is the walk working?`);
  // Compare on normalized separators: path.join yields backslashes on Windows,
  // so endsWith('src/server.js') is false there.
  const rel = f => path.relative(ROOT, f).replace(/\\/g, '/');
  assert.ok(files.some(f => rel(f) === 'template/opencode-dashboard-example.html'),
    'the template must be in scope');
  assert.ok(files.some(f => rel(f) === 'src/server.js'),
    'product source must be in scope');
  assert.ok(files.some(f => rel(f) === 'test/line-endings.test.js'),
    'this file must be in scope');
});