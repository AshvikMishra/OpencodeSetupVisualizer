/**
 * Sanitizer bypass regressions.
 *
 * Every case here was a REAL leak, found by audit: the value reached the served
 * payload with assertClean() returning true. They are the reason the structural
 * pass exists.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { sanitize, assertClean, newReport, normalizePathString, classifyKey } from '../src/sanitize.js';

const F = 'FAKE';

/** Sanitize a single config body and return it plus the serialized output. */
function body(inText) {
  const report = newReport();
  const out = sanitize({ configs: [{ body: inText }] }, { report });
  return { body: out.configs[0].body, serialised: JSON.stringify(out), report };
}

/* ------------------------------------------------- H1: path normalization */

test('user paths are normalised in every slash style and case', () => {
  for (const p of [
    'C:\\Users\\FAKEUSER\\AppData\\x',
    'C:/Users/FAKEUSER/AppData/x',
    'c:\\users\\fakeuser\\appdata\\x',
    'C:/USERS/FAKEUSER/x',
    '/home/FAKEUSER/.config/opencode/x',
    '/Users/FAKEUSER/x',
  ]) {
    const out = normalizePathString(p);
    assert.ok(!/fakeuser/i.test(out), `${p} leaked the username -> ${out}`);
  }
});

test('the real home directory is always tokenised, both slash styles', () => {
  const home = os.homedir();
  if (home.length < 3) return;
  for (const p of [home, home.replace(/\\/g, '/')]) {
    assert.ok(!normalizePathString(p).includes(home.replace(/\\/g, '/')),
      'home path survived normalisation');
  }
});

/* --------------------------------------- H2: non-strict JSON in a body */

test('credentials survive neither comments, trailing commas nor single quotes', () => {
  for (const input of [
    `{\n // note\n "apiKey": "${F}hunter2"\n}`,
    `{\n "apiKey": "${F}hunter2",\n}`,
    `{ 'apiKey': '${F}hunter2' }`,
    `{ /* block */ "apiKey": "${F}hunter2" }`,
    `﻿{ "apiKey": "${F}hunter2" }`,
  ]) {
    const { serialised } = body(input);
    assert.ok(!serialised.includes(`${F}hunter2`),
      `leaked from: ${JSON.stringify(input).slice(0, 60)}`);
  }
});

test('a nested credential in a non-strict body is redacted', () => {
  const input = `{\n // provider\n "provider": {"openai": {"options": {"apiKey": "${F}hunter2"}}}\n}`;
  const { serialised } = body(input);
  assert.ok(!serialised.includes(`${F}hunter2`));
  assert.match(serialised, /REDACTED/);
});

/* ------------------------------------- H3: numeric and boolean secrets */

test('numeric secrets are redacted', () => {
  for (const obj of [{ pin: 483920 }, { otp: 123456 }, { password: 12345678 }]) {
    const report = newReport();
    const out = sanitize(obj, { report });
    assert.ok(String(Object.values(out)[0]).includes('REDACTED'),
      `numeric secret survived: ${JSON.stringify(obj)}`);
  }
});

test('boolean secrets are redacted', () => {
  const out = sanitize({ token: true }, { report: newReport() });
  assert.match(String(out.token), /REDACTED/);
});

test('numeric secrets inside an array are redacted', () => {
  const out = sanitize({ passwords: [1234, 5678, 9012] }, { report: newReport() });
  assert.ok(out.passwords.every(v => String(v).includes('REDACTED')));
});

test('the project own metric counters survive numeric redaction', () => {
  const out = sanitize({
    context: { alwaysResident: [{ label: 'AGENTS.md', bytes: 1021, tokens: 255 }] },
    overview: [{ value: 7, of: 7 }],
  }, { report: newReport() });
  assert.equal(out.context.alwaysResident[0].bytes, 1021);
  assert.equal(out.context.alwaysResident[0].tokens, 255);
  assert.equal(out.overview[0].value, 7);
});

/* --------------------------- M1: high-entropy secrets near punctuation */

test('high-entropy secrets are caught regardless of surrounding punctuation', () => {
  const tok = 'aB3xK9mQ2wR7tY5uI1oP4sD6';
  for (const input of [
    `?api_key=${tok}&mode=1`,
    `https://api.example.com/callback/${tok}`,
    `token (${tok}) saved`,
    `use \`${tok}\` here`,
    `[x](https://y/${tok})`,
    `token:${tok}`,
  ]) {
    const out = sanitize({ note: input }, { report: newReport() });
    assert.ok(!out.note.includes(tok), `leaked from: ${input.slice(0, 40)}`);
  }
});

test('a very long secret is no longer exempt', () => {
  const tok = 'aB3xK9mQ2wR7tY5uI1oP4sD6'.repeat(200); // 5200 chars
  const out = sanitize({ note: `prefix ${tok} suffix` }, { report: newReport() });
  assert.ok(!out.note.includes(tok));
});

/* ------------------------------------ M3: secrets used as object KEYS */

test('a secret used as an object key is redacted', () => {
  const tok = 'aB3xK9mQ2wR7tY5uI1oP4sD6';
  const out = sanitize({ [tok]: 'x' }, { report: newReport() });
  assert.ok(!JSON.stringify(out).includes(tok));
});

test('a path used as an object key is normalised', () => {
  const out = sanitize({ 'C:\\Users\\FAKEUSER\\x': 1 }, { report: newReport() });
  assert.ok(!JSON.stringify(out).includes('FAKEUSER'));
});

/* ------------------------------- M4: key: value secrets in text bodies */

test('yaml, ini and xml style secrets in a body are redacted', () => {
  for (const input of [
    `- apiKey: ${F}hunter2\n- password: ${F}hunter3`,
    `[provider]\napiKey=${F}hunter2`,
    `<apiKey>${F}hunter2</apiKey>`,
    `apiKey="${F}hunter2"`,
    `api_key = ${F}hunter2`,
  ]) {
    const { serialised } = body(input);
    assert.ok(!serialised.includes(`${F}hunter2`),
      `leaked from: ${JSON.stringify(input).slice(0, 50)}`);
  }
});

/* ------------------------------------ M6: assertClean is structural now */

test('assertClean aborts on an unredacted credential KEY', () => {
  for (const obj of [
    { password: 'FAKEhunter2' },
    { pin: '483920' },
    { db_password: 'FAKEhunter2' },
    { nested: { deep: { apiKey: 'FAKEhunter2' } } },
  ]) {
    assert.throws(() => assertClean(obj), /assertClean aborted/,
      `assertClean passed: ${JSON.stringify(obj)}`);
  }
});

test('assertClean accepts already-redacted credentials', () => {
  assert.equal(assertClean({ password: '[REDACTED]' }), true);
  assert.equal(assertClean({ pin: '[REDACTED]' }), true);
});

test('assertClean accepts the projects own metric shape', () => {
  assert.equal(assertClean({
    context: {
      alwaysResident: [{ label: 'x', bytes: 1021, tokens: 255, kind: 'always', detail: 'd' }],
      onDemand: [], none: [], cacheFootprint: [],
    },
    overview: [{ value: 7, of: 7 }],
  }), true);
});

test('assertClean still catches pattern leaks in strings', () => {
  assert.throws(() => assertClean({ x: 'sk-ABCDEFGHIJKLMNOP1234567890' }), /assertClean aborted/);
  // Each JWT segment must reach the 8-char minimum the pattern requires.
  assert.throws(() => assertClean({ x: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhIiwiaWF0IjoxfQ.abcdefghijklmnop' }),
    /assertClean aborted/);
  assert.throws(() => assertClean({ x: 'https://user:hunter2pass@example.invalid/x' }),
    /assertClean aborted/);
  assert.throws(() => assertClean({ x: '-----BEGIN RSA PRIVATE KEY-----' }), /assertClean aborted/);
});

/* ----------------------------------------- key-name classification gaps */

test('plausible credential key names are classified', () => {
  for (const k of [
    'encryptionKey', 'masterKey', 'signingKey', 'sessionId', 'authorization_header',
    'psk', 'totp', 'access_key_id', 'keyfile', 'pem', 'pin', 'pass', 'dsn',
    'database_url', 'redis_url', 'aws_access_key_id', 'clientKey',
  ]) {
    assert.ok(classifyKey(k), `${k} must be treated as credential-shaped`);
  }
});

test('a generic field name is NOT treated as a credential', () => {
  // `key` and `keys` are ordinary identifiers. This snapshot has an
  // `overview[].key` field; classifying it as a private key replaced every
  // section id on the dashboard with "[REDACTED]".
  for (const k of ['key', 'keys', 'name', 'label', 'value', 'of', 'note', 'icon', 'to', 'id']) {
    assert.equal(classifyKey(k), null,
      `${k} must not be classified as a credential — it would redact real data`);
  }
});

/* -------------------------------------------------- prototype pollution */

test('prototype keys are dropped at every depth', () => {
  const out = sanitize(JSON.parse('{"__proto__":{"p":1},"constructor":{"c":1},"ok":{"__proto__":{"q":2}}}'), {});
  assert.equal(Object.prototype.p, undefined);
  assert.equal(out.polluted, undefined);
  assert.ok(out.ok);
});

/* ----------------------------------------------------- no false positives */

test('benign config content is not mangled', () => {
  const out = sanitize({
    configs: [{ body: '{"theme":"opencode","animations":false,"session":{"sidebar":"auto"}}' }],
  }, { report: newReport(), contents: true });
  assert.match(out.configs[0].body, /"theme":"opencode"/);
  assert.match(out.configs[0].body, /"animations":false/);
});

test('markdown bodies keep their newlines', () => {
  const md = '# Title\n\n- one\n- two\n\n```sh\nexport A=1\n```\n';
  const out = sanitize({ configs: [{ body: md }] }, { report: newReport(), contents: true });
  assert.equal(out.configs[0].body, md, 'a body advertised as verbatim must stay verbatim');
});

test('a legitimate hex digest is not redacted', () => {
  const digest = 'a1b2c3d4'.repeat(8); // 64 hex chars
  const out = sanitize({ note: `computedHash ${digest}` }, { report: newReport() });
  assert.ok(out.note.includes(digest));
});

test('the redaction report never contains a value', () => {
  const report = newReport();
  const secret = `${F}-unique-marker-12345`;
  sanitize({ configs: [{ body: JSON.stringify({ apiKey: secret }) }] }, { report });
  const line = JSON.stringify(report);
  assert.ok(!line.includes(secret));
});
