/**
 * Mutation check for the pre-push audit itself.
 *
 * Plants each leak class into a temp copy of the repo and asserts the auditor
 * reports it. An auditor that cannot fail is worthless.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const pexec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const results = [];
const record = (name, ok, note) => {
  results.push({ name, ok, note });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? ` :: ${note}` : ''}`);
};

const HOME = os.homedir();
const BASE = path.basename(HOME);
const LAN = (Object.values(os.networkInterfaces()).flat() || [])
  .find(n => n && n.family === 'IPv4' && !n.internal)?.address;

const MUTATIONS = [
  ['real username in a source file', 'src/server.js', `// owner: ${BASE}`],
  ['real home path in the README', 'README.md', `\nInstalled at ${HOME}\n`],
  ['URL-encoded home path', 'PLAN.md', `\nencoded: ${encodeURIComponent(HOME)}\n`],
  ['this machine LAN address', 'VERIFICATION.md', `\nhost: ${LAN || '203.0.113.7'}\n`],
  ['a provider API key', 'src/exec.js', `\n// key sk-ABCDEFGHIJKLMNOPQRSTUVWX\n`],
  ['a JWT', 'src/jsonc.js', `\n// eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.abcdefghijkl\n`],
  ['a PEM private key block', 'src/sanitize.js', `\n// -----BEGIN RSA PRIVATE KEY-----\n`],
  ['a URL with embedded credentials', 'src/inject.js', `\n// https://user:pass@example.com/x\n`],
  ['a fixture canary outside the fixture', 'src/collect/index.js', `\n// CANARY-password-value-9000\n`],
  ['a machine-only skill name', 'src/collect/skills.js', `\n// see also grill-me\n`],
];

for (const [name, rel, insert] of MUTATIONS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovz-audit-'));
  try {
    // Minimal repo copy: git needs the real tree, so mirror it cheaply.
    fs.cpSync(path.join(ROOT, '.git'), path.join(dir, '.git'), { recursive: true });
    for (const d of ['src', 'bin', 'test', 'verification', 'template']) {
      if (fs.existsSync(path.join(ROOT, d))) {
        fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true, filter: s => !s.includes(`${path.sep}artifacts${path.sep}`) });
      }
    }
    for (const f of ['package.json', 'README.md', 'PLAN.md', 'VERIFICATION.md', '.gitignore']) {
      if (fs.existsSync(path.join(ROOT, f))) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
    }
    const target = path.join(dir, rel);
    fs.appendFileSync(target, `\n${insert}\n`);

    let out = '';
    try {
      // Pass the copy as an explicit target; the auditor must inspect the copy.
      const r = await pexec(process.execPath,
        [path.join(ROOT, 'verification', 'prepush-audit.mjs'), dir],
        { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      out = r.stdout;
    } catch (e) {
      out = `${e.stdout || ''}`;
    }
    const notClean = /NOT CLEAN/.test(out);
    record(`detects ${name}`, notClean, notClean ? 'audit reported NOT CLEAN' : 'audit passed â€” LEAK NOT DETECTED');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// And the unmutated repo must still be clean.
try {
  const r = await pexec(process.execPath, [path.join(ROOT, 'verification', 'prepush-audit.mjs')],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  record('unmutated repo is clean', /CLEAN/.test(r.stdout), 'no findings');
} catch (e) {
  record('unmutated repo is clean', false, `audit failed: ${String(e.stdout || '').slice(0, 200)}`);
}

const fail = results.filter(r => !r.ok).length;
console.log(`\nSUMMARY  pass=${results.length - fail} fail=${fail}`);
process.exit(fail ? 1 : 0);
