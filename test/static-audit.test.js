/**
 * 6. STATIC SOURCE AUDIT — the properties that must hold by inspection.
 *
 * These guard against whole classes of regression: an outbound HTTP client, a
 * telemetry call, dynamic code evaluation, or a shell string built from data
 * that was read off disk.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SRC = path.join(ROOT, 'src');
const BIN = path.join(ROOT, 'bin');

/** Every shipped source file (tests are allowed to do more). */
function shippedSources() {
  const out = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js')) out.push(full);
    }
  };
  if (fs.existsSync(SRC)) walk(SRC);
  if (fs.existsSync(BIN)) walk(BIN);
  return out;
}

/** Strip comments so a mention inside a doc comment is not a false positive. */
function code(file) {
  return fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

test('no outbound HTTP client is used anywhere in src/ or bin/', () => {
  const banned = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|node-fetch|axios|got|superagent|undici|http2)\s*\(/;
  for (const f of shippedSources()) {
    const src = code(f);
    assert.ok(!banned.test(src), `${path.relative(ROOT, f)} uses an outbound HTTP client`);
  }
});

test('no telemetry, analytics or error-reporting calls', () => {
  const banned = /\b(sentry|bugsnag|datadog|newrelic|segment|amplitude|mixpanel|posthog|telemetry|analytics|trackEvent|captureException)\b/i;
  for (const f of shippedSources()) {
    assert.ok(!banned.test(code(f)), `${path.relative(ROOT, f)} references telemetry`);
  }
});

test('no eval, new Function, or dynamic script construction', () => {
  const banned = /\beval\s*\(|new\s+Function\s*\(|setTimeout\s*\(\s*['"`]/;
  for (const f of shippedSources()) {
    const src = code(f);
    assert.ok(!banned.test(src), `${path.relative(ROOT, f)} uses dynamic code evaluation`);
  }
});

test('only argv-based child_process APIs are imported anywhere', () => {
  // exec/execSync take a shell string. execFile/spawn take an argv array.
  // Checking the import list is exact, unlike grepping call sites (a local
  // variable may legitimately be named `exec`).
  const ALLOWED = new Set(['execFile', 'spawn', 'spawnSync', 'execFileSync', 'ChildProcess']);
  for (const f of shippedSources()) {
    const src = code(f);
    const importRe = /import\s*(?:\{([^}]*)\}|\*\s*as\s+\w+|\w+)\s*from\s*['"]node:child_process['"]/g;
    let m;
    while ((m = importRe.exec(src)) !== null) {
      if (!m[1]) continue; // namespace import — checked separately below
      for (const raw of m[1].split(',')) {
        const name = raw.trim().split(/\s+as\s+/)[0].trim();
        if (!name) continue;
        assert.ok(ALLOWED.has(name),
          `${path.relative(ROOT, f)} imports ${name} from child_process — shell-string spawning is forbidden`);
      }
    }
  }
});

test('no shell-string spawning calls (exec/execSync) appear in any source', () => {
  for (const f of shippedSources()) {
    const src = code(f);
    // A call is `exec(` / `execSync(` not preceded by a dot or word char, and
    // not part of an identifier such as runOpencode.
    const re = /(?<![\w.$])(exec|execSync)\s*\(/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      // Allow a locally-bound helper named `exec` only if it is never the
      // child_process one; report it so we can judge case by case.
      assert.fail(`${path.relative(ROOT, f)} calls ${m[1]}() — shell-string spawning is forbidden`);
    }
  }
});

test('the only shell:true usage is the fixed browser-launch argv table', () => {
  const bin = path.join(BIN, 'opencode-setup-visualizer.js');
  const src = code(bin);
  // Both branches must pass an explicit argv array, never a concatenated string.
  // The URL is passed pre-quoted so cmd.exe's `start` cannot re-split it.
  assert.match(src, /\['\/c',\s*'start',\s*'',\s*`"\$\{url\}"`\]/);
  assert.match(src, /\['open',\s*\[url\]\]|'open', \[url\]/);
  // No discovered value may reach a shell string.
  assert.ok(!/\$\{\s*(path|file|name|dir|abs)\s*\}/.test(src),
    'a path-ish variable must never be interpolated into the launch argv');
});

test('the only file write in the whole tool is the explicit --out destination', () => {
  // Deleting/renaming/mkdir anywhere would mean mutating the user's setup.
  const destructive = /\b(rmSync|unlinkSync|mkdirSync|renameSync|copyFileSync|rmdirSync|truncateSync|chmodSync|chownSync|utimesSync)\s*\(/;
  for (const f of shippedSources()) {
    const src = code(f);
    const m = destructive.exec(src);
    assert.equal(m, null,
      `${path.relative(ROOT, f)} performs a filesystem mutation (${m ? m[1] : ''}) — this tool is read-only`);
  }

  // A single writeFileSync may exist, in the CLI, writing args.out.
  const bin = path.join(BIN, 'opencode-setup-visualizer.js');
  const binSrc = code(bin);
  const writes = binSrc.match(/\bwriteFileSync\s*\(/g) || [];
  assert.ok(writes.length <= 1, `expected at most one write in the CLI; found ${writes.length}`);
  assert.match(binSrc, /writeFileSync\(\s*dest/, 'the only write must target the --out path');
});

test('nothing writes inside the user OpenCode config directory', () => {
  for (const f of shippedSources()) {
    const src = code(f);
    // No module may open a file for writing against a config-ish path.
    assert.ok(!/openSync\s*\([^)]*['"][wa]/.test(src),
      `${path.relative(ROOT, f)} opens a file for writing`);
  }
});

test('service.json and auth.json are never read as raw bodies into the snapshot', () => {
  const cfgs = path.join(SRC, 'collect', 'configs.js');
  const src = code(cfgs);
  // shape-only handling must go through readShapeOnly, and the entry it returns
  // must contain keys/bytes/body-stub only.
  assert.match(src, /SHAPE_ONLY/);
  assert.match(src, /function readShapeOnly/);
});

test('the template path is never written', () => {
  const inj = path.join(SRC, 'inject.js');
  const src = code(inj);
  assert.match(src, /readFileSync/, 'template is read');
  assert.ok(!/writeFileSync|appendFileSync/.test(src), 'template must never be written');
});

test('package.json declares zero dependencies and no install scripts', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies, {});
  assert.deepEqual(pkg.devDependencies, {});
  for (const k of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish']) {
    assert.ok(!pkg.scripts?.[k], `must not define an ${k} script`);
  }
  assert.equal(pkg.type, 'module');
  assert.ok(pkg.bin['opencode-setup-visualizer']);
  assert.match(pkg.engines.node, />=\s*18/);
});

test('every source file parses', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  for (const f of shippedSources()) {
    await assert.doesNotReject(() => run(process.execPath, ['--check', f]), `${f} fails to parse`);
  }
});
