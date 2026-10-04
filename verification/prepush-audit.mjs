/**
 * PRE-PUSH LEAK AUDIT.
 *
 * Scans every file that git would actually publish, using detectors written
 * independently of the product's sanitizer, and fails on any of:
 *
 *   1. the real OS username or home path (both slash styles, URL-encoded)
 *   2. a non-loopback IP address belonging to this machine
 *   3. a private-key / provider-key / JWT shape
 *   4. any canary planted in the test fixtures
 *   5. real OpenCode config file names that would fingerprint THIS machine's setup
 *   6. gitignored paths that are staged or tracked
 *
 * Deliberately prints only JSON path + kind + length, never a matched value.
 *
 * Usage: node verification/prepush-audit.mjs [targetDir]
 *
 * targetDir defaults to this repository. It MUST be an explicit argument rather
 * than process.cwd(), so that auditing a copy actually inspects that copy.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const pexec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.argv[2] || path.join(HERE, '..'));

const home = os.homedir();
const userBase = path.basename(home);

/** Text files git would publish (tracked + untracked, excluding ignored). */
async function publishableFiles() {
  const args = ['ls-files', '--cached', '--others', '--exclude-standard'];
  const { stdout } = await pexec('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

/* ------------------------------- detectors (independent of the product) -- */

const VALUE_PATTERNS = [
  ['private-key-block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['provider-key', /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/],
  ['jwt', /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/],
  ['url-credentials', /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i],
];

const canaries = [
  'sk-FAKECANARY0123456789abcdefGHIJKL',
  'ghp_FAKECANARY0123456789abcdefghijklmnop',
  'AKIAFAKECANARY01234567',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5hcnkifQ.ZmFrZWd5LWNhbmFyeS1zaWc',
  'https://canaryuser:canarypass@example.invalid/path',
  'CANARY-password-value-9000',
  'CANARY-odd-cased-7777',
  'CANARY_ENV_TOKEN=canaryvalue123',
  'C:\\Users\\canaryuser\\.config\\opencode\\thing.json',
];

/**
 * Machine-specific config inventory that would fingerprint THIS setup.
 *
 * These are the file and skill names that exist on the developer's machine only.
 * A term listed here is NOT a leak on its own — see FINGERPRINT_ALLOWED below —
 * it only matters in a file that is not entitled to mention it.
 */
const machineFingerprint = [
  'skillctl.mjs', 'skill-sources.json', 'capabilities.json', 'skills-lock.json',
  'grill-me', 'ui-ux-pro-max', 'karpathy-guidelines', 'using-superpowers',
  'find-skills', 'stop-slop', 'diagnosing-superpowers', 'git-superpowers-',
];

/**
 * Files entitled to mention those terms, and why.
 *
 * - the template ships a worked EXAMPLE snapshot, so it necessarily names
 *   example skills and an example router
 * - the collectors implement generic support for these filenames
 * - the fixtures create them on purpose
 * - the docs describe the allowlist
 */
const FINGERPRINT_ALLOWED = new Set([
  'src/collect/commands.js',
  'src/collect/warnings.js',
  'src/collect/configs.js',
  'src/collect/index.js',
  'test/fixtures/fixture.js',
  'test/robustness.test.js',
  'verification/edge-data.mjs',
  'verification/functional.mjs',
  'verification/prepush-audit.mjs',
  'template/opencode-dashboard-example.html',
  'README.md',
  'PLAN.md',
  'VERIFICATION.md',
  // Names the leak classes it plants.
  'verification/audit-mutation.mjs',
]);

/**
 * Synthetic IPs used as test inputs in the suite. These are not this machine's
 * addresses and are safe to commit; a real address would be flagged instead.
 */
const SYNTHETIC_IPS = new Set(['10.0.0.5', '192.168.1.10', '127.0.0.1', '0.0.0.0']);

function scanFile(rel, text) {
  const findings = [];

  // 1. username / home path
  const variants = new Set();
  if (home && home.length > 2) {
    variants.add(home);
    variants.add(home.replace(/\\/g, '/'));
    variants.add(encodeURIComponent(home));
  }
  if (userBase && userBase.length > 2) {
    variants.add(userBase);
    variants.add(encodeURIComponent(userBase));
  }
  for (const v of variants) {
    const re = new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    if (re.test(text)) {
      findings.push({ file: rel, kind: 'username-or-home-path', len: v.length });
    }
  }

  // 2a. non-loopback addresses belonging to THIS machine, by definition a leak
  for (const ni of Object.values(os.networkInterfaces()).flat()) {
    if (!ni || ni.family !== 'IPv4' || ni.internal) continue;
    const re = new RegExp(ni.address.replace(/\./g, '\\.'), 'g');
    if (re.test(text)) findings.push({ file: rel, kind: 'host-lan-address', len: ni.address.length });
  }

  // 2b. any other RFC1918 literal, excluding the known synthetic test inputs.
  //     Match a full dotted quad so `10.0.0.5` is compared whole, not as `10.0.0`.
  const privates = text.match(/(?<!\d)(?:(?:172\.(?:1[6-9]|2\d|3[01])|10|192\.168)\.\d{1,3}\.\d{1,3}\.\d{1,3})(?!\d)/g) || [];
  for (const a of privates) {
    if (!SYNTHETIC_IPS.has(a)) findings.push({ file: rel, kind: 'private-ip-literal', len: a.length });
  }

  // 3. secret shapes. The fixture holds FAKE secrets on purpose, and this
  //    auditor necessarily contains the patterns it looks for.
  const SECRET_ALLOWED = new Set([
    'test/fixtures/fixture.js',
    'test/secrets.test.js',
    // Holds fake credential shapes on purpose, as regression fixtures.
    'test/sanitizer-bypass.test.js',
    'verification/prepush-audit.mjs',
    'verification/privacy.mjs',
    'verification/functional.mjs',
    // Plants each leak class on purpose to prove the auditor fires.
    'verification/audit-mutation.mjs',
  ]);
  if (!SECRET_ALLOWED.has(rel)) {
    for (const [kind, re] of VALUE_PATTERNS) {
      if (re.test(text)) findings.push({ file: rel, kind, len: -1 });
    }
  }

  // 4. fixture canaries — fake by design, and only the fixture/auditor may hold them
  const CANARY_ALLOWED = new Set([
    'test/fixtures/fixture.js',
    'verification/prepush-audit.mjs',
    'verification/audit-mutation.mjs',
  ]);
  if (!CANARY_ALLOWED.has(rel)) {
    for (const c of canaries) {
      if (c.length > 8 && text.includes(c)) findings.push({ file: rel, kind: 'fixture-canary', len: c.length });
    }
  }

  // 5. machine fingerprint terms
  if (!FINGERPRINT_ALLOWED.has(rel)) {
    for (const term of machineFingerprint) {
      if (text.includes(term)) findings.push({ file: rel, kind: `machine-fingerprint:${term}`, len: term.length });
    }
  }

  return findings;
}

/* ===================================== run ============================== */

const files = await publishableFiles();
console.log(`Auditing ${files.length} file(s) that git would publish.\n`);

const allFindings = [];
let binary = 0;
for (const rel of files) {
  const abs = path.join(ROOT, rel);
  let buf;
  try { buf = fs.readFileSync(abs); } catch { continue; }
  // Skip binaries (images, tarballs).
  if (buf.includes(0) && rel.match(/\.(png|jpe?g|webp|gz|tgz|zip)$/i)) { binary++; continue; }
  const text = buf.toString('utf8');
  allFindings.push(...scanFile(rel.replace(/\\/g, '/'), text));
}

/* --- 6. gitignored paths must not be tracked or staged ------------------ */
const { stdout: trackedIgnored } = await pexec('git',
  ['ls-files', '--cached', '--ignored', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
const ignoredTracked = trackedIgnored.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

const { stdout: staged } = await pexec('git', ['ls-files', '--cached'], { cwd: ROOT, encoding: 'utf8' });
const ignoredStaged = staged.split(/\r?\n/)
  .map(s => s.trim())
  .filter(Boolean)
  .filter(f => {
    const ignored = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
      .split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    return ignored.some(p => f === p || f.startsWith(p.endsWith('/') ? p : p + '/'));
  });

/* ------------------------------- report -------------------------------- */

const byKind = {};
for (const f of allFindings) byKind[f.kind] = (byKind[f.kind] || 0) + 1;

console.log('=== Findings by kind ===');
if (!allFindings.length) console.log('  (none)');
for (const [k, v] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(3)}  ${k}`);
}

if (allFindings.length) {
  console.log('\n=== Per-file (path + kind only; no values) ===');
  for (const f of allFindings) console.log(`  ${f.file}  ${f.kind}  len=${f.len}`);
}

console.log('\n=== Gitignored paths ===');
console.log(`  files under ignored rules: ${ignoredTracked.length ? ignoredTracked.join(', ') : '(none)'}`);
console.log(`  ignored AND tracked/staged: ${ignoredStaged.length ? ignoredStaged.join(', ') : '(none)'}`);
const ignoredLeak = ignoredStaged.length > 0;
console.log(`  binary files skipped: ${binary}`);

const total = allFindings.length + (ignoredLeak ? 1 : 0);
console.log(`\n${total === 0 ? 'CLEAN' : 'NOT CLEAN'} — ${allFindings.length} finding(s), ${ignoredLeak ? 'ignored path staged' : 'no ignored path staged'}`);
process.exit(total === 0 ? 0 : 1);
