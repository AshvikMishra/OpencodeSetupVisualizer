/**
 * Pre-share privacy scan of the snapshot that the Share button would copy.
 *
 * The snapshot is about to become the thing a user hands to someone else, so
 * it gets checked for the two things that would be embarrassing in that
 * context:
 *   1. an OS username anywhere (paths, URLs, free text)
 *   2. internal/private URLs (RFC1918 hosts, .local, .internal, bare LAN IPs)
 *
 * This is a REPORT, not a fix. It prints findings with JSON paths and kinds,
 * never values.
 */
import os from 'node:os';
import path from 'node:path';
import { buildSnapshot } from '../src/collect/index.js';
import { sanitize, assertClean, newReport } from '../src/sanitize.js';

const HOME = process.env.USERPROFILE || process.env.HOME;

// The username as it appears in a path, plus the raw homedir.
const homeName = path.basename(HOME);
const USER_TOKENS = [...new Set([homeName, HOME, HOME.replace(/\\/g, '/')].filter(Boolean))];

const INTERNAL_URL = /\b(?:https?:\/\/|git@|\bssh:\/\/)([^\s/:@'"\\]+)/gi;
const PRIVATE_HOST = [
  /^192\.168\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./,
  /\.local\b/i, /\.internal\b/i, /\.lan\b/i, /\.corp\b/i, /\.home\b/i,
  /^localhost$/i, /host\.docker\.internal$/i,
];

const findings = [];

function note(kind, jsonPath, detail) {
  findings.push({ kind, jsonPath, detail });
}

function inspect(str, jsonPath) {
  for (const tok of USER_TOKENS) {
    if (tok.length >= 3 && str.includes(tok)) {
      note('username', jsonPath, `contains the OS username (${tok.length} chars, not shown)`);
    }
  }
  for (const m of str.matchAll(INTERNAL_URL)) {
    const host = m[1];
    if (PRIVATE_HOST.some(rx => rx.test(host))) note('internal-url', jsonPath, `private host (${host.length} chars, not shown)`);
  }
  // A bare private IP not preceded by a scheme.
  for (const m of str.matchAll(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g)) {
    if (PRIVATE_HOST.some(rx => rx.test(m[1]))) note('internal-ip', jsonPath, 'private IPv4 literal');
  }
}

/* --- canary: prove the detector fires before trusting a clean verdict ----- */
{
  const canary = JSON.stringify({
    path: HOME + '/.config/opencode/opencode.json',
    other: 'C:/Users/' + homeName + '/notes',
    lan: 'http://192.168.1.50:8080/admin',
    dotlocal: 'git@build.corp:team/repo.git',
    clean: '%USERPROFILE%/.config/opencode/AGENTS.md',
  });
  const before = findings.length;
  inspect(canary, '$ (canary)');
  const kinds = new Set(findings.slice(before).map(f => f.kind));
  const wanted = ['username', 'internal-url', 'internal-ip'];
  const missing = wanted.filter(k => !kinds.has(k));
  console.log(`canary self-test     : ${missing.length ? 'MISSING ' + missing.join(',') : 'all 3 detectors fire'}`);
  if (missing.length) {
    console.error('\nFAIL  the scanner cannot detect what it claims to. Its clean verdict is worthless.');
    process.exit(1);
  }
  // Drop the canary's own findings; they are not about the real snapshot.
  findings.length = 0;
}

const snap = await buildSnapshot({ home: HOME });
const clean = sanitize(snap, { report: newReport(), contents: true });
assertClean(clean);

const json = JSON.stringify(clean, null, 2);
// Scan the whole serialised document: that covers values AND keys, so a
// username hidden in an object key is caught too.
inspect(json, '$ (whole document)');

console.log(`username probed      : ${USER_TOKENS.length} token(s), longest ${Math.max(...USER_TOKENS.map(t => t.length))} chars`);
console.log(`share payload size   : ${json.length} bytes pretty-printed`);
console.log(`top-level keys       : ${Object.keys(clean).length}`);
console.log(`findings             : ${findings.length}`);

// De-duplicate by kind so the report is readable; keep up to 6 distinct paths.
const byKind = new Map();
for (const f of findings) {
  if (!byKind.has(f.kind)) byKind.set(f.kind, []);
  byKind.get(f.kind).push(f.jsonPath);
}
for (const [kind, paths] of byKind) {
  console.log(`\n  ${kind}: ${paths.length} occurrence(s)`);
  for (const p of [...new Set(paths)].slice(0, 6)) console.log(`    ${p}`);
}

console.log(findings.length
  ? '\nRESULT  NEEDS NORMALISATION before this can be shared'
  : '\nRESULT  clean — no username, no internal URL');
process.exit(findings.length ? 1 : 0);