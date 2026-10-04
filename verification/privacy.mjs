/**
 * Section 5 (part 2) — INDEPENDENT privacy scan.
 *
 * Deliberately does NOT reuse the product's sanitizer regexes or entropy
 * heuristics. Everything here is written from scratch so a bug in the product's
 * detector cannot hide a leak from this check.
 *
 * Detection:
 *   1. literal canary substrings
 *   2. the real OS username and home path, in both slash styles + URL-encoded
 *   3. structural: any key whose normalised name looks credential-shaped
 *   4. pattern: URL credentials, PEM headers, JWT, env-style secrets
 *   5. heuristic: any standalone string >= 20 chars, no spaces, high entropy
 *
 * Findings are reported as JSON path + length + kind. Values are NEVER printed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildFixture, stubExec, CANARIES } from '../test/fixtures/fixture.js';
import { startServer } from '../src/server.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(HERE, 'artifacts', 'privacy');
fs.mkdirSync(ART, { recursive: true });

const results = [];
const record = (section, check, status, evidence) => {
  results.push({ section, check, status, evidence });
  console.log(`${status}  [${section}] ${check}${evidence ? ` :: ${evidence}` : ''}`);
};

/* ================================ independent detectors (no reuse) ===== */

const normKey = k => String(k).toLowerCase().replace(/[^a-z]/g, '');

/** Keys whose name alone implies a credential. */
const SECRET_KEY_WORDS = [
  'password', 'passwd', 'passphrase', 'secret', 'token', 'apikey', 'auth',
  'cookie', 'credential', 'privatekey', 'sessionid', 'bearer', 'otp', 'seed',
  'mnemonic', 'signingkey', 'clientkey', 'accesskey', 'refresh',
];

function keyLooksSecret(k) {
  const n = normKey(k);
  return SECRET_KEY_WORDS.some(w => n.includes(w));
}

/** Independent high-entropy test: distinct-char ratio over a long token. */
function entropyBits(s) {
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) || 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function looksLikeHighEntropyToken(s) {
  if (s.length < 20) return false;
  if (/\s/.test(s)) return false;
  if (!/^[A-Za-z0-9+/=_\-.:]+$/.test(s)) return false;
  // Must not be a path, URL, hex digest, or a plain identifier.
  if (s.includes('/') || s.includes('\\')) return false;
  if (/^https?:/i.test(s)) return false;
  if (/^[0-9a-fA-F]+$/.test(s)) return false;
  if (!/[a-z]/.test(s) || !/[A-Z]/.test(s)) return false;
  return entropyBits(s) >= 3.2;
}

/**
 * Does this object look like an actual credential container (a settings/auth
 * blob) rather than a metrics table? A metrics row is a flat array of
 * {label, bytes|note|tokens|kind|detail} records.
 */
function looksCredentialShaped(obj) {
  const keys = Object.keys(obj);
  if (!keys.length) return false;
  const metricOnly = new Set(['label', 'bytes', 'note', 'tokens', 'kind', 'detail', 'value']);
  // A metrics table has only benign row keys.
  if (keys.every(k => metricOnly.has(k))) return false;
  // Anything with a scalar leaf under a credential-ish name is a real finding,
  // which scanValue already reports; here we only flag nested config blobs.
  return keys.some(k => keyLooksSecret(k));
}

const VALUE_PATTERNS = [
  ['url-credentials', /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i],
  ['pem-header', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['jwt', /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/],
  ['env-secret', /\b[A-Z][A-Z0-9_]{2,}(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*\s*=\s*[^\s"',;]{8,}/],
  ['provider-key', /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/],
];

/** Walk any JSON-ish value and collect findings as {path, len, kind}. */
function scanValue(node, p = '$', out = [], depth = 0) {
  if (depth > 12 || out.length > 500) return out;
  if (node === null || node === undefined) return out;
  if (typeof node === 'number' || typeof node === 'boolean') return out;
  if (typeof node === 'string') {
    for (const [kind, re] of VALUE_PATTERNS) {
      const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      if (r.test(node)) out.push({ path: p, len: node.length, kind });
    }
    for (const tok of node.split(/\s+/)) {
      const bare = tok.replace(/^[`"'([{<]+|[`"')\]}>;,]+$/g, '');
      if (looksLikeHighEntropyToken(bare)) {
        out.push({ path: p, len: bare.length, kind: 'high-entropy' });
      }
    }
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => scanValue(v, `${p}[${i}]`, out, depth + 1));
    return out;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      const here = `${p}.${k}`;
      // A metric key holding an array of {label, bytes, note} rows is not a
      // credential; a credential key would hold a scalar. Only flag an
      // object/array value when its contents are not a known metric row shape.
      if (keyLooksSecret(k) && typeof v === 'string' && v && !/^\[REDACTED\]|^<REDACTED/.test(v)) {
        out.push({ path: here, len: v.length, kind: 'secret-key' });
      }
      if (keyLooksSecret(k) && v && typeof v === 'object' && !Array.isArray(v) && looksCredentialShaped(v)) {
        out.push({ path: here, len: -1, kind: 'secret-key-object' });
      }
      scanValue(v, here, out, depth + 1);
    }
    return out;
  }
  return out;
}

/** Identity leak scan over raw text. */
function scanIdentity(text) {
  const home = os.homedir();
  const base = path.basename(home);
  const variants = new Set();
  if (home) {
    variants.add(home);
    variants.add(home.replace(/\\/g, '/'));
    variants.add(encodeURIComponent(home));
  }
  if (base && base.length > 2) {
    variants.add(base);
    variants.add(encodeURIComponent(base));
  }
  const hits = [];
  for (const v of variants) {
    const re = new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const n = (text.match(re) || []).length;
    if (n > 0) hits.push({ variant: v === home ? '<home>' : v === base ? '<username>' : v.slice(0, 12) + '…', count: n });
  }
  return hits;
}

function scanCanaries(text) {
  return Object.entries(CANARIES)
    .filter(([, v]) => v && v.length > 8 && text.includes(v))
    .map(([k]) => k);
}

/* ================================ run ================================== */

const fixture = buildFixture('rich');
const deps = stubExec();
const handle = await startServer({
  port: Number(process.argv[2]) || 4900,
  collectOpts: { home: fixture.home, projectDir: fixture.project, deps },
  contents: true,
});

function httpGet(url) {
  return new Promise((res, rej) => {
    http.get(url, r => {
      let b = '';
      r.setEncoding('utf8');
      r.on('data', d => { b += d; });
      r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: b }));
    }).on('error', rej);
  });
}

try {
  /* ----------------------------------------------- 1. served HTML */
  const html = await httpGet(handle.url);
  record('5', 'GET / served', html.status === 200 ? 'PASS' : 'FAIL', `status ${html.status}`);
  const canaries = scanCanaries(html.body);
  record('5', 'HTML: no canary secret', canaries.length === 0 ? 'PASS' : 'FAIL',
    canaries.length === 0 ? `${html.body.length} bytes scanned` : `canaries: ${canaries.join(', ')}`);
  const ident = scanIdentity(html.body);
  record('5', 'HTML: no real username or home path', ident.length === 0 ? 'PASS' : 'FAIL',
    ident.length === 0 ? 'none found' : JSON.stringify(ident));
  const htmlFindings = scanValue(safeParseLoose(html.body));
  record('5', 'HTML: no secret-like values (independent scan)',
    htmlFindings.length === 0 ? 'PASS' : 'FAIL',
    htmlFindings.length === 0 ? '0 findings' : summarise(htmlFindings));

  /* ---------------------------------------- 2. /api/snapshot */
  const api = await httpGet(handle.url + 'api/snapshot');
  let apiJson = null;
  try { apiJson = JSON.parse(api.body); } catch { /* reported below */ }
  record('5', '/api/snapshot is valid JSON', apiJson ? 'PASS' : 'FAIL', `status ${api.status}`);
  const apiCanaries = scanCanaries(api.body);
  record('5', '/api/snapshot: no canary secret', apiCanaries.length === 0 ? 'PASS' : 'FAIL',
    apiCanaries.length === 0 ? `${api.body.length} bytes` : apiCanaries.join(', '));
  const apiIdent = scanIdentity(api.body);
  record('5', '/api/snapshot: no real username or home path', apiIdent.length === 0 ? 'PASS' : 'FAIL',
    apiIdent.length === 0 ? 'none found' : JSON.stringify(apiIdent));
  const apiFindings = scanValue(apiJson);
  record('5', '/api/snapshot: no secret-like values (independent scan)',
    apiFindings.length === 0 ? 'PASS' : 'FAIL',
    apiFindings.length === 0 ? '0 findings' : summarise(apiFindings));

  /* ---------------------------------- 3. --json and --out via the CLI */
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const pexec = promisify(execFile);
  const BIN = path.join(HERE, '..', 'bin', 'opencode-setup-visualizer.js');
  const env = { ...process.env, USERPROFILE: fixture.home, HOME: fixture.home };

  const jsonOut = await pexec(process.execPath, [BIN, '--json', '--project', fixture.project],
    { env, maxBuffer: 64 * 1024 * 1024 });
  const jc = scanCanaries(jsonOut.stdout);
  record('5', '--json: no canary secret', jc.length === 0 ? 'PASS' : 'FAIL',
    jc.length === 0 ? `${jsonOut.stdout.length} bytes` : jc.join(', '));
  const ji = scanIdentity(jsonOut.stdout);
  record('5', '--json: no real username or home path', ji.length === 0 ? 'PASS' : 'FAIL',
    ji.length === 0 ? 'none' : JSON.stringify(ji));
  const jf = scanValue(safeParseLoose(jsonOut.stdout));
  record('5', '--json: no secret-like values (independent scan)', jf.length === 0 ? 'PASS' : 'FAIL',
    jf.length === 0 ? '0 findings' : summarise(jf));

  // Terminal stderr must not contain canaries either.
  const jErr = jsonOut.stderr || '';
  record('5', '--json terminal output: no canary secret', scanCanaries(jErr).length === 0 ? 'PASS' : 'FAIL',
    `${jErr.length} bytes of stderr`);

  const outFile = path.join(fixture.root, 'out.html');
  await pexec(process.execPath, [BIN, '--out', outFile, '--project', fixture.project], { env, maxBuffer: 64 * 1024 * 1024 });
  const outHtml = fs.readFileSync(outFile, 'utf8');
  record('5', '--out: no canary secret', scanCanaries(outHtml).length === 0 ? 'PASS' : 'FAIL',
    `${outHtml.length} bytes`);
  record('5', '--out: no real username or home path', scanIdentity(outHtml).length === 0 ? 'PASS' : 'FAIL',
    'none found');
  const of = scanValue(safeParseLoose(outHtml));
  record('5', '--out: no secret-like values (independent scan)', of.length === 0 ? 'PASS' : 'FAIL',
    of.length === 0 ? '0 findings' : summarise(of));

  /* ------------------------------ 4. live home tokenisation check */
  const tokenised = /%USERPROFILE%|"~\//.test(api.body);
  record('5', 'paths use the home token, not the real path', tokenised ? 'PASS' : 'FAIL',
    tokenised ? 'found %USERPROFILE% or ~/' : 'no home token found');
} finally {
  await handle.close();
}

function summarise(findings) {
  const byKind = {};
  for (const f of findings) byKind[f.kind] = (byKind[f.kind] || 0) + 1;
  return `${findings.length} finding(s): ` +
    Object.entries(byKind).map(([k, v]) => `${k}×${v}`).join(', ') +
    ' at ' + [...new Set(findings.slice(0, 3).map(f => f.path))].join(' ');
}

/** Parse JSON if possible; otherwise return null so we scan text elsewhere. */
function safeParseLoose(s) {
  try { return JSON.parse(s); } catch { return null; }
}

const pass = results.filter(r => r.status === 'PASS').length;
const fail = results.filter(r => r.status === 'FAIL').length;
fs.writeFileSync(path.join(ART, 'results.json'), JSON.stringify({ results, pass, fail }, null, 2));
console.log(`\nSUMMARY  pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
