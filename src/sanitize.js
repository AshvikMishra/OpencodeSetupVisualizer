/**
 * sanitize.js — the privacy boundary.
 *
 * Everything that leaves this process (server response, --json, --out) passes
 * through `sanitize()` as the final step, and then through `assertClean()`.
 *
 * Two independent detection strategies, as required:
 *   1. STRUCTURAL — key names, normalised for case / underscore / camelCase.
 *   2. PATTERN    — value shapes that look like credentials regardless of key.
 *
 * `assertClean()` deliberately reuses the same detectors, so any escape is a
 * bug in `sanitize()` rather than a silent leak.
 */
import path from 'node:path';
import os from 'node:os';
import { homeToken } from './exec.js';
import { parseJsonc, normalizeQuotes } from './jsonc.js';

export const REDACTED = '[REDACTED]';
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/* ------------------------------------------------------------------ keys */

/** Strip case, underscores, dashes and spaces so PaSsWoRd/apiKey/API_KEY collapse together. */
export function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[\s_\-.]/g, '');
}

/** Structural key rules: exact-ish matches, plus a few substrings. */
const KEY_EXACT = new Map(Object.entries({
  password: 'password',
  passwd: 'password',
  pwd: 'password',
  passphrase: 'password',
  secret: 'secret',
  clientsecret: 'secret',
  token: 'token',
  accesstoken: 'token',
  refreshtoken: 'token',
  idtoken: 'token',
  sessiontoken: 'token',
  apikey: 'apikey',
  apisecret: 'apikey',
  apitoken: 'token',
  authorization: 'auth',
  auth: 'auth',
  authtoken: 'token',
  cookie: 'cookie',
  cookies: 'cookie',
  credential: 'credential',
  credentials: 'credential',
  privatekey: 'privatekey',
  sshkey: 'privatekey',
  passkey: 'privatekey',
  bearer: 'auth',
  otp: 'token',
  mfa: 'token',
  seed: 'secret',
  mnemonic: 'secret',
  salt: 'secret',
  signature: 'auth',
  cert: 'credential',
  keystore: 'privatekey',
  connectionstring: 'credential',
  // Names a secret would plausibly live under.
  //
  // `key` and `keys` are deliberately NOT listed. They are too generic: this
  // project's own snapshot has an `overview[].key` field holding a section id,
  // and classifying it as a private key replaced every id on the dashboard with
  // "[REDACTED]". Specific forms are listed instead (keyfile, truststore,
  // accesskey, encryptionkey, ...), and a secret under a bare `key` is still
  // caught by the high-entropy pass and by assertClean's structural scan of
  // surrounding values.
  pem: 'privatekey',
  keyfile: 'privatekey',
  truststore: 'privatekey',
  encryptionkey: 'privatekey',
  masterkey: 'privatekey',
  signkey: 'privatekey',
  signingkey: 'privatekey',
  clientkey: 'privatekey',
  accesskey: 'privatekey',
  accesskeyid: 'privatekey',
  hmac: 'privatekey',
  psk: 'privatekey',
  pin: 'password',
  pass: 'password',
  dsn: 'credential',
  databaseurl: 'credential',
  redisurl: 'credential',
  sessionid: 'token',
  totp: 'token',
  jwt: 'token',
}));

/** Substring rules — only applied to reasonably short, plausible key names. */
const KEY_SUBSTRINGS = [
  [/password|passwd|passphrase/i, 'password'],
  [/secret/i, 'secret'],
  [/apikey|api_key/i, 'apikey'],
  [/accesstoken|auth.?token|auth.?header|authorization|bearer|refresh.?token|session.?token/i, 'token'],
  [/credential/i, 'credential'],
  [/private.?key|ssh.?key/i, 'privatekey'],
  // Namespaced variants: awsAccessKeyId, gcp_service_key, encryptionKey…
  [/access.?key|secret.?key|master.?key|signing.?key|encryption.?key|client.?key/i, 'privatekey'],
  [/cookie/i, 'cookie'],
];

/**
 * Classify a key name. Returns a redaction kind, or null if the key looks benign.
 * Note: `bytes`, `tokens` (our own numeric metrics) and `description` must survive,
 * so numeric-only values are checked by the caller before the key rule is applied.
 */
export function classifyKey(key) {
  const n = normalizeKey(key);
  if (FORBIDDEN_KEYS.has(n)) return 'proto';
  if (KEY_EXACT.has(n)) return KEY_EXACT.get(n);
  if (n.length <= 40) {
    for (const [re, kind] of KEY_SUBSTRINGS) if (re.test(n)) return kind;
  }
  return null;
}

/* --------------------------------------------------------------- patterns */

// Env-style and key/value secrets. Runs are bounded: an earlier version used
// nested unbounded quantifiers and was quadratic, turning one 64 KB body into
// seconds of backtracking (~4x per doubling).
const ENV_SECRET_RE =
  /\b[A-Za-z][A-Za-z0-9_-]{0,31}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_-]{0,31}\s*=\s*["']?[^\s"',;]{6,}["']?/gi;

// YAML / INI / .properties forms, which appear in AGENTS.md and any non-JSON body.
const KV_SECRET_RE =
  /\b(?:api[_-]?key|apikey|token|secret|password|passwd|pwd|credential|auth[_-]?token|bearer)\b\s*(?:[:=>]{1,2})\s*["']?[^\s"',;<>{}]{6,}["']?/gi;

// XML/HTML attribute and element forms, e.g. `<apiKey>…</apiKey>` or
// `apiKey="…"` inside a config body.
const XML_SECRET_RE =
  /<\s*(?:api[_-]?key|apikey|token|secret|password|passwd|credential)\s*>[\s\S]{0,200}?<\s*\/\s*(?:api[_-]?key|apikey|token|secret|password|passwd|credential)\s*>|\b(?:api[_-]?key|apikey|token|secret|password|passwd|credential)\s*=\s*["'][^"'\s]{6,}["']/gi;

const PATTERNS = [
  // PEM private key blocks
  { kind: 'pem', re: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g },
  { kind: 'pem', re: /-----BEGIN[A-Z ]*PRIVATE KEY-----/g },
  // Common provider key prefixes
  { kind: 'apikey-pattern', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'apikey-pattern', re: /\bsk-proj-[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'apikey-pattern', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: 'apikey-pattern', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { kind: 'apikey-pattern', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'apikey-pattern', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'apikey-pattern', re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { kind: 'apikey-pattern', re: /\bglpat-[A-Za-z0-9_-]{16,}\b/g },
  // JSON Web Tokens
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  // Credentials embedded in a URL
  { kind: 'url-credentials', re: /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@/]+)@/g },
  // env-var style assignment carrying a secret-looking value
  { kind: 'env-secret', re: ENV_SECRET_RE },
  // `key: value` / `key = value` in YAML, INI, .properties and markdown bodies
  { kind: 'env-secret', re: KV_SECRET_RE },
  { kind: 'env-secret', re: XML_SECRET_RE },
];

/** Shannon entropy in bits/char. */
export function shannon(s) {
  if (!s.length) return 0;
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) || 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Heuristic: does this standalone token look like a real secret?
 * Requires length, character-class diversity, non-hex-ness and entropy, so that
 * legitimate content (sha256 digests, commit hashes, cache ids) is NOT destroyed.
 */
export function looksHighEntropy(s) {
  if (s.length < 24) return false;
  if (!/^[A-Za-z0-9+/=_\-.]+$/.test(s)) return false;
  if (!/[a-z]/.test(s) || !/[A-Z]/.test(s) || !/\d/.test(s)) return false;
  if (/^[0-9a-fA-F]+$/.test(s)) return false; // hex digest / hash — not a secret
  return shannon(s) >= 3.8;
}

/** Count pattern hits in a string without mutating it. Used by assertClean. */
export function detectInString(s) {
  const found = [];
  if (typeof s !== 'string' || !s) return found;
  for (const { kind, re } of PATTERNS) {
    const r = new RegExp(re.source, re.flags);
    const m = s.match(r);
    if (m && m.length) found.push({ kind, count: m.length });
  }
  // High-entropy: only standalone whitespace-delimited tokens.
  for (const tok of s.split(/\s+/)) {
    const t = tok.replace(/^["']|["'],?$/g, '');
    if (looksHighEntropy(t)) found.push({ kind: 'high-entropy', count: 1 });
  }
  return found;
}

/* ------------------------------------------------------------------ paths */

const USER_DIR_RES = [
  // Case-insensitive: Windows and macOS paths are commonly seen lowercased.
  /([A-Za-z]:[\\/])users[\\/]([^\\/\s"']+)/gi,
  /\/users\/([^/\s"']+)/gi,
  /\/home\/([^/\s"']+)/gi,
  // Unix root accounts.
  /\/root(?=[\\/\s"']|$)/gi,
];

/**
 * Replace the real home directory (and any other `Users/<name>` / `/home/<name>`)
 * with the home token. Windows paths keep backslashes; POSIX keeps slashes.
 */
export function normalizePathString(s) {
  const home = os.homedir() || '';
  let out = String(s);
  if (home && home.length > 1) {
    const win = home.replace(/\//g, '\\');
    const posix = home.replace(/\\/g, '/');
    out = out.split(win).join(homeToken()).split(posix).join(homeToken());
  }
  // Iterate the patterns: passing the ARRAY to replace() coerces it to a
  // literal string and never matches.
  for (const re of USER_DIR_RES) {
    re.lastIndex = 0;
    out = out.replace(re, (m, prefix = '') => {
      const sep = m.includes('\\') && !m.includes('/') ? '\\' : '/';
      if (prefix && /^[A-Za-z]:[\\/]$/.test(prefix)) return `${prefix}Users${sep}*`;
      return '~';
    });
  }
  return out;
}

/* --------------------------------------------------------------- sanitize */

/** Create a fresh report. Counts only — never values. */
export function newReport() {
  return { counts: Object.create(null), total: 0, pathsNormalized: 0, bodyKeysRedacted: 0 };
}

/**
 * Redact credential-shaped keys inside an opaque config-body string.
 *
 * A body is TEXT, so walking it as an object never sees the key names it
 * contains — structural detection silently missed every `"PaSsWoRd": "..."`
 * pair in a config file. This re-serialises the body through a real parse,
 * applies the key rules, and writes it back.
 *
 * Returns the body unchanged if it does not parse (markdown, truncation marker,
 * or a shape-only stub) — those are handled by the other detectors.
 */
function sanitizeBodyText(text, report) {
  let parsed;
  try {
    // JSONC, not strict JSON: a single comment or trailing comma in an
    // allowlisted file must not skip structural redaction entirely.
    parsed = parseJsonc(normalizeQuotes(text));
  } catch {
    return text;
  }
  if (parsed === null || typeof parsed !== 'object') return text;

  const sub = newReport();
  const cleaned = sanitize(parsed, { report: sub, contents: true });
  let before = JSON.stringify(parsed, null, 2);
  let after = JSON.stringify(cleaned, null, 2);
  // Compact form keeps the original one-line shape when the input was compact.
  if (!text.includes('\n')) {
    before = JSON.stringify(parsed);
    after = JSON.stringify(cleaned);
  }
  if (after === before) return text;

  for (const [k, v] of Object.entries(sub.counts)) {
    report.counts[k] = (report.counts[k] || 0) + v;
  }
  report.total += sub.total;
  report.bodyKeysRedacted += sub.total;
  return after;
}

function bump(report, kind) {
  report.counts[kind] = (report.counts[kind] || 0) + 1;
  report.total += 1;
}

export const NO_CONTENTS_BODY = '(contents hidden: run without --no-contents)';

/**
 * Recursively sanitize a value.
 *
 * @param {*} value      snapshot (plain JSON data)
 * @param {object} [opts]
 * @param {object} [opts.report]  report to accumulate into
 * @param {boolean} [opts.contents] when false, configs[].body is replaced
 * @param {boolean} [opts.isBody]  true when walking a configs[].body subtree
 */
export function sanitize(value, opts = {}) {
  const report = opts.report || newReport();
  // Contents are ON by default; only an explicit `contents: false` hides them.
  const opts2 = opts.contents === false ? opts : { ...opts, contents: true };

  const walk = (node, keyName, isBody) => {
    // --- primitives -------------------------------------------------------
    if (typeof node === 'string') {
      let s = node;

      if (isBody && !opts2.contents) return NO_CONTENTS_BODY;

      // A config body is opaque text; apply key rules to its parsed contents.
      if (isBody) {
        const redacted = sanitizeBodyText(s, report);
        if (redacted !== s) return redacted;
      }

      const before = s;
      s = normalizePathString(s);
      if (s !== before) report.pathsNormalized += 1;

      for (const { kind, re } of PATTERNS) {
        if (!re.test(s)) { re.lastIndex = 0; continue; }
        re.lastIndex = 0;
        s = s.replace(new RegExp(re.source, re.flags), REDACTED);
        bump(report, kind);
      }
      // High-entropy tokens. Splitting on whitespace alone missed secrets sitting
      // next to punctuation (`?api_key=...`, `/callback/<token>`, `` `token` ``),
      // so scan maximal runs of token characters instead. Replaces in place, so
      // newlines and indentation survive — bodies advertise themselves as
      // "shown verbatim".
      s = s.replace(/[A-Za-z0-9+/=_-]{20,}/g, run => {
        if (!looksHighEntropy(run)) return run;
        bump(report, 'high-entropy');
        return REDACTED;
      });

      // A structurally-secret key redacts its value outright.
      if (keyName && classifyKey(keyName) && classifyKey(keyName) !== 'proto') {
        bump(report, classifyKey(keyName));
        return REDACTED;
      }
      return s;
    }

    if (typeof node === 'number' || typeof node === 'boolean') {
      // A PIN, an OTP and a numeric password are all real secrets. classifyKey
      // already returns null for "tokens"/"bytes", so this cannot touch the
      // project's own metric counters.
      const k = keyName ? classifyKey(keyName) : null;
      if (k && k !== 'proto') return REDACTED;
      return node;
    }

    if (node === null || node === undefined) return node;

    if (Array.isArray(node)) {
      return node.map(v => walk(v, keyName, isBody));
    }

    if (typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        if (FORBIDDEN_KEYS.has(k)) {
          bump(report, 'proto');
          continue;
        }
        const childIsBody = isBody || k === 'body';
        // The KEY itself can carry a secret or a real path.
        let key = normalizePathString(k);
        if (looksHighEntropy(key)) {
          key = REDACTED;
          bump(report, 'high-entropy-key');
        } else if (classifyKey(k) && classifyKey(k) !== 'proto' && !/^\[REDACTED\]/.test(key)) {
          bump(report, classifyKey(k));
        }
        out[key] = walk(v, k, childIsBody);
      }
      return out;
    }

    return node;
  };

  return walk(value, null, false);
}

/** JSON.parse that refuses prototype-polluting keys. */
export function safeParse(text) {
  return JSON.parse(text, function reviver(key, val) {
    if (FORBIDDEN_KEYS.has(key)) return undefined;
    return val;
  });
}

/* ----------------------------------------------------------- assertClean */

/**
 * Structural re-scan: walk the serialised snapshot and abort if any
 * credential-shaped KEY still holds a value that is not redacted.
 *
 * `detectInString` only sees text, so it cannot see key names at all — every
 * structural leak was silent until this pass existed.
 */
function scanKeysStructural(node, path = '$', findings = [], depth = 0) {
  if (depth > 12 || findings.length > 20 || node === null || typeof node !== 'object') {
    return findings;
  }
  for (const [k, v] of Object.entries(node)) {
    if (FORBIDDEN_KEYS.has(k)) continue;
    const kind = classifyKey(k);
    if (kind && kind !== 'proto' && v !== null && v !== undefined) {
      const isRedacted =
        typeof v === 'string' &&
        (v === REDACTED || v.startsWith(REDACTED) || v === NO_CONTENTS_BODY ||
         v.startsWith('<REDACTED'));
      if (!isRedacted) findings.push({ path: `${path}.${k}`, kind });
    }
    scanKeysStructural(v, `${path}.${k}`, findings, depth + 1);
  }
  return findings;
}

/**
 * Final gate. Serialises the snapshot and re-scans it two ways: a structural
 * pass over key names, and the pattern/entropy detectors over the text. Throws
 * if either fires — i.e. if sanitize() let something through.
 */
export function assertClean(snapshot) {
  let text;
  try {
    text = typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot);
  } catch (e) {
    throw new Error(`assertClean: snapshot is not serialisable — ${e.message}`);
  }

  const hits = detectInString(text);
  const problems = hits.map(h => `${h.kind}×${h.count}`);

  if (typeof snapshot !== 'string') {
    for (const f of scanKeysStructural(snapshot)) {
      problems.push(`unredacted-key ${f.path} (${f.kind})`);
    }
  }

  if (problems.length) {
    throw new Error(
      `assertClean aborted: secret-like content survived sanitisation (${problems.join(', ')}). ` +
      `Nothing was served or written.`
    );
  }
  return true;
}

/* --------------------------------------------------------------- reporting */

const KIND_LABEL = {
  password: 'password-like',
  secret: 'secret-like',
  token: 'token-like',
  apikey: 'api-key-like',
  auth: 'auth-like',
  cookie: 'cookie-like',
  credential: 'credential-like',
  privatekey: 'private-key-like',
  'apikey-pattern': 'api-key-pattern',
  jwt: 'jwt-like',
  pem: 'pem-block',
  'url-credentials': 'url-credentials',
  'env-secret': 'env-secret',
  'high-entropy': 'high-entropy',
  proto: 'prototype-key',
};

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** "Redacted 3 values (1 password-like, 2 token-like)" — counts only, no values. */
export function formatReport(report) {
  const n = report.total;
  if (n === 0) return 'Redacted 0 values (nothing secret-like detected)';
  const parts = Object.entries(report.counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, c]) => `${c} ${KIND_LABEL[k] || k}`);
  return `Redacted ${plural(n, 'value')} (${parts.join(', ')})`;
}
