/**
 * Section 8 — packaging.
 *
 * Packs the tarball, installs it into a FRESH temp project (local install only,
 * never global), runs the installed binary, and checks what did and did not ship.
 *
 * Also runs `npm test` three times to catch flakiness.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pexec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const ART = path.join(HERE, 'artifacts', 'packaging');
fs.mkdirSync(ART, { recursive: true });

const results = [];
const record = (check, status, evidence) => {
  results.push({ check, status, evidence });
  console.log(`${status}  [8] ${check}${evidence ? ` :: ${evidence}` : ''}`);
};

const sha256 = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// npm ships as a .cmd shim on Windows and Node refuses to spawn one without a
// shell (EINVAL). Spawn the JS entry point with an argv array instead.
const NPM_JS = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const npmArgs = args => {
  if (fs.existsSync(NPM_JS)) return { file: process.execPath, args: [NPM_JS, ...args] };
  return { file: 'npm', args };
};
const npm = (args, opts = {}) => {
  const n = npmArgs(args);
  return pexec(n.file, n.args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
};
const npmIn = (cwd, args, opts = {}) => {
  const n = npmArgs(args);
  return pexec(n.file, n.args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
};

/* --------------------------------------------------- 1. npm pack --dry-run */
let dryRun;
try {
  dryRun = await npm(['pack', '--dry-run', '--json']);
  var listing = JSON.parse(dryRun.stdout)[0];
} catch (e) {
  record('npm pack --dry-run', 'FAIL', String(e.message).split('\n')[0]);
  process.exit(1);
}
const files = listing.files.map(f => f.path.replace(/\\/g, '/'));
record('npm pack --dry-run succeeds', listing ? 'PASS' : 'FAIL',
  `${files.length} file(s), ${(listing.size / 1024).toFixed(1)} KB packed`);

/* ------------------------------- 2. what must / must not be in the tarball */

const templateIn = files.find(f => f.endsWith('template/opencode-dashboard-example.html'));
record('template is included', templateIn ? 'PASS' : 'FAIL', templateIn || 'MISSING');

const mustInclude = ['package.json', 'README.md', 'bin/opencode-setup-visualizer.js'];
for (const need of mustInclude) {
  record(`includes ${need}`, files.includes(need) ? 'PASS' : 'FAIL', files.includes(need) ? 'present' : 'MISSING');
}
record('includes every src module',
  files.filter(f => f.startsWith('src/') && f.endsWith('.js')).length >= 12 ? 'PASS' : 'FAIL',
  `${files.filter(f => f.startsWith('src/')).length} src file(s)`);

const mustExclude = [
  'verification/', 'test/', 'PROMPT/',
  'opencode-dashboard.html', '.env', 'service.json',
];
for (const bad of mustExclude) {
  const hit = files.filter(f => f === bad || f.startsWith(bad));
  record(`excludes ${bad}`, hit.length === 0 ? 'PASS' : 'FAIL',
    hit.length === 0 ? 'absent' : `LEAKED: ${hit.join(', ')}`);
}

// Anything that looks like a secret or a local artifact must not ship.
const suspicious = files.filter(f =>
  /(^|\/)(service|auth|credentials)\.json$/i.test(f) ||
  /\.env($|\.)/.test(f) || /(^|\/)\.local\//.test(f) ||
  /(^|\/)node_modules\//.test(f) || /\.(pem|key|pfx|db|sqlite3?)$/i.test(f));
record('no secret-shaped or local-state files in the tarball',
  suspicious.length === 0 ? 'PASS' : 'FAIL',
  suspicious.length === 0 ? 'none' : suspicious.join(', '));

/* ------------------------------------------------ 3. real pack + install */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ovz-pkg-'));
try {
  const packed = await npm(['pack', '--pack-destination', tmp]);
  const tgzName = packed.stdout.trim().split(/\r?\n/).pop().trim();
  const tgz = path.join(tmp, tgzName);
  record('npm pack produces a tarball', fs.existsSync(tgz) ? 'PASS' : 'FAIL',
    `${tgzName} (${(fs.statSync(tgz).size / 1024).toFixed(1)} KB)`);

  // Extract the template straight out of the tarball and compare hashes.
  const { execSync } = await import('node:child_process');
  const extractDir = path.join(tmp, 'extracted');
  fs.mkdirSync(extractDir, { recursive: true });
  execSync(`tar -xzf "${tgz}" -C "${extractDir}"`, { stdio: 'ignore' });
  const tplInTgz = path.join(extractDir, 'package', 'template', 'opencode-dashboard-example.html');
  const original = path.join(ROOT, 'template', 'opencode-dashboard-example.html');
  // The pinned digest of the template as originally authored. Comparing the
  // tarball against this constant proves the shipped bytes are the real thing,
  // without needing a second copy of the file in the repo.
  // Re-pinned alongside test/template-integrity.test.js after the freeze was lifted
  // for three data bindings (skill total, project-local count, model provider).
  // Both files must carry the same constant or one of them is lying.
  const PINNED = 'f2edca48a7cab1b80defe073af3d896399159c39978ab9f32832fe5c3b68bc07';
  const h1 = fs.existsSync(tplInTgz) ? sha256(tplInTgz) : null;
  const h2 = sha256(original);
  record('template inside the tarball matches the pinned original',
    h1 && h2 === PINNED && h1 === PINNED ? 'PASS' : 'FAIL',
    `tarball=${(h1 || 'n/a').slice(0, 16)} template=${h2.slice(0, 16)} pinned=${PINNED.slice(0, 16)}`);

  // Fresh project, LOCAL install only.
  const consumer = path.join(tmp, 'consumer');
  fs.mkdirSync(consumer, { recursive: true });
  fs.writeFileSync(path.join(consumer, 'package.json'),
    JSON.stringify({ name: 'consumer', version: '1.0.0', private: true }, null, 2));

  const install = await npmIn(consumer, ['install', '--no-audit', '--no-fund', tgz], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300000,
  });
  // Assert on the thing that actually matters — the package is present on disk
  // and resolvable — rather than on npm's human-facing progress prose, which
  // npm moves between stdout and stderr across versions and locales.
  const installTarget = path.join(consumer, 'node_modules', 'opencode-setup-visualizer');
  const installDetail =
    `installed=${fs.existsSync(installTarget)} ` +
    `stdout=${JSON.stringify((install.stdout || '').trim().slice(-60))} ` +
    `stderr=${JSON.stringify((install.stderr || '').trim().slice(-60))}`;
  record('installs into a fresh project (local only)',
    fs.existsSync(path.join(installTarget, 'package.json')) ? 'PASS' : 'FAIL',
    installDetail);

  const installedTpl = path.join(consumer, 'node_modules', 'opencode-setup-visualizer', 'template', 'opencode-dashboard-example.html');
  record('installed copy includes a hash-identical template',
    fs.existsSync(installedTpl) && sha256(installedTpl) === h2 ? 'PASS' : 'FAIL',
    fs.existsSync(installedTpl) ? sha256(installedTpl).slice(0, 16) : 'MISSING');

  // No install scripts in the installed package.
  const installedPkg = JSON.parse(fs.readFileSync(
    path.join(consumer, 'node_modules', 'opencode-setup-visualizer', 'package.json'), 'utf8'));
  const scriptKeys = Object.keys(installedPkg.scripts || {});
  const forbidden = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly'];
  record('installed package has no install scripts',
    forbidden.every(k => !scriptKeys.includes(k)) ? 'PASS' : 'FAIL',
    `scripts: ${scriptKeys.join(', ') || 'none'}`);
  record('installed package declares zero dependencies',
    Object.keys(installedPkg.dependencies || {}).length === 0 &&
    Object.keys(installedPkg.devDependencies || {}).length === 0 ? 'PASS' : 'FAIL',
    'none');

  const nodeModulesSize = (() => {
    let n = 0;
    const walk = d => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === '.bin') continue;
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f); else n++;
      }
    };
    try { walk(path.join(consumer, 'node_modules')); } catch { /* none */ }
    return n;
  })();
  record('installed tree contains only this package',
    nodeModulesSize < 400 ? 'PASS' : 'FAIL', `${nodeModulesSize} files under node_modules`);

  // Run the installed binary.
  const binJs = path.join(consumer, 'node_modules', '.bin', 'opencode-setup-visualizer.cmd');
  record('bin shim is installed', fs.existsSync(binJs) ? 'PASS' : 'FAIL', binJs.replace(consumer, '<consumer>'));

  const jsonRun = await pexec(process.execPath, [
    path.join(consumer, 'node_modules', 'opencode-setup-visualizer', 'bin', 'opencode-setup-visualizer.js'),
    '--json',
  ], { cwd: consumer, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180000 });
  let parsed = null;
  try { parsed = JSON.parse(jsonRun.stdout); } catch { /* below */ }
  // The consumer cwd has no OpenCode config of its own; `opencode models`
  // resolves against it. Record whatever it reports rather than asserting a
  // fixed number.
  record('installed bin runs and emits valid JSON',
    parsed && Array.isArray(parsed.agents) ? 'PASS' : 'FAIL',
    parsed ? `agents=${parsed.agents.length} skills=${parsed.skills.length} providers=${parsed.providers.length} models=${parsed.providers.reduce((a, p) => a + p.models, 0)} (consumer cwd has no project config)`
      : 'could not parse output');

  // And the server starts from the INSTALLED copy, not the repo source, so this
  // proves the shipped bin + src work together.
  const installedRoot = path.join(consumer, 'node_modules', 'opencode-setup-visualizer');
  const { startServer } = await import(pathToFileURL(path.join(installedRoot, 'src', 'server.js')).href);
  const srv = await startServer({ port: Number(process.argv[2]) || 4980, collectOpts: {} });
  try {
    const res = await fetch(srv.url);
    const html = await res.text();
    record('installed copy serves an injected page',
      res.status === 200 && html.includes('const SNAPSHOT = {') ? 'PASS' : 'FAIL',
      `status ${res.status}, ${html.length} bytes`);
  } finally {
    await srv.close();
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ----------------------------------------------------- 4. npm test × 3 */

const runs = [];
for (let i = 1; i <= 3; i++) {
  const t = Date.now();
  try {
    const r = await pexec(process.execPath, ['--test', 'test/**/*.test.js'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 900000,
    });
    runs.push({ n: i, ok: true, ms: Date.now() - t, out: r.stdout });
  } catch (e) {
    runs.push({ n: i, ok: false, ms: Date.now() - t, out: `${e.stdout || ''}${e.stderr || ''}` });
  }
}
const summary = out => {
  const t = /^. pass (\d+)$/m.exec(out);
  const f = /^. fail (\d+)$/m.exec(out);
  return { pass: t ? +t[1] : -1, fail: f ? +f[1] : -1 };
};
for (const r of runs) {
  const s = summary(r.out);
  record(`npm test run ${r.n}/3`, r.ok ? 'PASS' : 'FAIL', `pass=${s.pass} fail=${s.fail}, ${r.ms}ms`);
}
const stable = runs.every(r => r.ok) && new Set(runs.map(r => summary(r.out).pass)).size === 1;
record('npm test is stable across 3 runs', stable ? 'PASS' : 'FAIL',
  stable ? `identical pass count each run` : 'pass counts differed between runs');

const pass = results.filter(r => r.status === 'PASS').length;
const fail = results.filter(r => r.status === 'FAIL').length;
fs.writeFileSync(path.join(ART, 'results.json'), JSON.stringify({ results, pass, fail, files }, null, 2));
console.log(`\nSUMMARY  pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
