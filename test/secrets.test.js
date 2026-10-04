/**
 * 4. SECRETS — canary leakage across every output channel, and --no-contents.
 *
 * Independent of the product's own sanitizer: the canaries are scanned for as
 * literal substrings, so a sanitizer bug cannot hide itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { buildSnapshot } from '../src/collect/index.js';
import { sanitize, assertClean, newReport, formatReport } from '../src/sanitize.js';
import { renderPage } from '../src/inject.js';
import { startServer } from '../src/server.js';
import { buildFixture, stubExec, cleanup, CANARIES, ALL_CANARY_VALUES } from './fixtures/fixture.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'opencode-setup-visualizer.js');
const pexec = promisify(execFile);

/** Substring scan. Deliberately dumb: no shared code with the sanitizer. */
function scanCanaries(text) {
  return ALL_CANARY_VALUES.filter(v => v.length > 8 && text.includes(v));
}

async function collect(fixture, contents = true) {
  const snapshot = await buildSnapshot({
    home: fixture.home,
    projectDir: fixture.project,
    deps: stubExec(),
  });
  return sanitize(snapshot, { report: newReport(), contents });
}

test('no canary survives in the sanitized snapshot', async t => {
  const fixture = buildFixture('rich');
  t.after(() => cleanup(fixture));

  const clean = await collect(fixture);
  const text = JSON.stringify(clean);
  const hits = scanCanaries(text);
  assert.deepEqual(hits, [], `canaries leaked into snapshot: ${hits.length}`);
});

test('the provider settings object (apiKey) is never emitted', async t => {
  const fixture = buildFixture('rich');
  t.after(() => cleanup(fixture));
  const clean = await collect(fixture);
  const text = JSON.stringify(clean);
  assert.ok(!text.includes(CANARIES.skKey), 'provider apiKey must never appear');
  assert.ok(!/"settings"/.test(text), 'the whole settings object must be dropped');
});

test('service.json is shape-only: key names yes, values never', async t => {
  const fixture = buildFixture('rich');
  t.after(() => cleanup(fixture));
  const clean = await collect(fixture);

  const svc = clean.configs.find(c => /service\.json/.test(c.path));
  assert.ok(svc, 'service.json must still be reported as present');
  assert.match(svc.note, /SHAPE ONLY/i);
  assert.match(svc.body, /REDACTED/);
  // Key names are expected; the values must not be.
  assert.ok(!svc.body.includes(CANARIES.password), 'service.json password value must not appear');
  assert.ok(!svc.body.includes(CANARIES.jwt), 'service.json token value must not appear');
  assert.match(svc.body, /password/, 'key names should still be reported');
});

test('no canary survives in the served HTML or /api/snapshot', async t => {
  const fixture = buildFixture('rich');
  t.after(() => cleanup(fixture));

  const handle = await startServer({
    port: 4399,
    collectOpts: { home: fixture.home, projectDir: fixture.project, deps: stubExec() },
    contents: true,
  });
  t.after(() => handle.close());

  for (const route of ['/', '/api/snapshot']) {
    const res = await fetch(handle.url.replace(/\/$/, '') + route);
    assert.equal(res.status, 200, `${route} should be 200`);
    const body = await res.text();
    const hits = scanCanaries(body);
    assert.deepEqual(hits, [], `${route} leaked ${hits.length} canary value(s)`);
  }
});

test('--no-contents removes every config body and the --json / --out channels are clean', async t => {
  const fixture = buildFixture('rich');
  t.after(() => cleanup(fixture));

  // --json via the real CLI, pointed at the fixture home.
  const jsonOut = await pexec(process.execPath, [
    BIN, '--json', '--project', fixture.project,
  ], {
    env: { ...process.env, USERPROFILE: fixture.home, HOME: fixture.home, HOMEDRIVE: 'C:', HOMEPATH: '\\' },
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.deepEqual(scanCanaries(jsonOut.stdout), [], '--json leaked a canary');

  // --out writes a static file.
  const outFile = path.join(fixture.root, 'out.html');
  await pexec(process.execPath, [
    BIN, '--out', outFile, '--project', fixture.project,
  ], {
    env: { ...process.env, USERPROFILE: fixture.home, HOME: fixture.home, HOMEDRIVE: 'C:', HOMEPATH: '\\' },
    maxBuffer: 32 * 1024 * 1024,
  });
  const html = fs.readFileSync(outFile, 'utf8');
  assert.deepEqual(scanCanaries(html), [], '--out leaked a canary');
});

test('--no-contents replaces EVERY body and drops the canaries with them', async t => {
  const fixture = buildFixture('rich');
  t.after(() => cleanup(fixture));

  const withContents = await collect(fixture, true);
  const without = await collect(fixture, false);

  for (const c of without.configs) {
    assert.match(c.body, /contents hidden/, `${c.id} body should be hidden`);
  }
  // The benign body content is gone too.
  assert.ok(!JSON.stringify(without).includes('"animations"'));
  // And paths/sizes survive.
  assert.equal(withContents.configs.length, without.configs.length);
  assert.deepEqual(
    withContents.configs.map(c => c.path),
    without.configs.map(c => c.path)
  );
});

test('non-allowlisted secret files are never read at all', async t => {
  const fixture = buildFixture('rich');
  t.after(() => cleanup(fixture));
  // The fixture writes notes.env and private.pem containing canaries.
  const clean = await collect(fixture);
  const text = JSON.stringify(clean);
  assert.ok(!/notes\.env/.test(text), 'notes.env must not be collected');
  assert.ok(!/private\.pem/.test(text), 'private.pem must not be collected');
  assert.ok(!text.includes(CANARIES.envSecret));
  assert.ok(!text.includes(CANARIES.pem));
});

test('the real home directory and username never appear', async t => {
  const fixture = buildFixture('rich');
  t.after(() => cleanup(fixture));
  const clean = await collect(fixture);
  const text = JSON.stringify(clean);
  const realHome = process.env.USERPROFILE || '';
  if (realHome.length > 3) {
    assert.ok(!text.includes(realHome), 'real home path must not appear');
    assert.ok(!text.includes(realHome.replace(/\\/g, '/')), 'real home path must not appear');
  }
  assert.ok(
    text.includes('%USERPROFILE%') || text.includes('~/'),
    'a home token is expected in the output'
  );
});

test('assertClean aborts on unsanitised secret-like content', () => {
  assert.throws(() => assertClean({ x: CANARIES.skKey }), /assertClean aborted/);
  assert.throws(() => assertClean({ x: CANARIES.jwt }), /assertClean aborted/);
  assert.throws(() => assertClean({ x: CANARIES.pem }), /assertClean aborted/);
});

test('assertClean passes on sanitized output and reports counts without values', async t => {
  const fixture = buildFixture('rich');
  t.after(() => cleanup(fixture));
  const snapshot = await buildSnapshot({
    home: fixture.home, projectDir: fixture.project, deps: stubExec(),
  });
  const report = newReport();
  const clean = sanitize(snapshot, { report });
  assert.equal(assertClean(clean), true);
  assert.ok(report.total > 0, 'fixture should trigger redactions');

  const line = formatReport(report);
  assert.match(line, /^Redacted \d+ value/);
  for (const v of ALL_CANARY_VALUES) {
    assert.ok(!line.includes(v), 'the report must never contain a value');
  }
});

test('prototype-polluting keys are dropped, not merged', () => {
  const report = newReport();
  const out = sanitize(JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1},"ok":1}'), { report });
  assert.equal(out.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined, 'Object.prototype must be clean');
  assert.equal(out.ok, 1);
});

test('legitimate numeric metrics named tokens/bytes are NOT redacted', () => {
  const report = newReport();
  const out = sanitize({ context: { alwaysResident: [{ label: 'x', bytes: 1021, tokens: 255 }] } }, { report });
  assert.equal(out.context.alwaysResident[0].bytes, 1021);
  assert.equal(out.context.alwaysResident[0].tokens, 255);
});

test('a high-entropy hex digest is not mistaken for a secret', () => {
  const report = newReport();
  const digest = 'a'.repeat(32) + '0123456789abcdef' + 'f'.repeat(14);
  const out = sanitize({ note: `computedHash ${digest}` }, { report });
  assert.ok(out.note.includes(digest), 'a hex digest should survive');
});

test('a real high-entropy base64 secret IS redacted', () => {
  const report = newReport();
  const secret = 'Xk8sQ2vNpL9wZrT4yH7bN1mC5dF0gJ3kP6q';
  const out = sanitize({ note: `value ${secret}` }, { report });
  assert.ok(!out.note.includes(secret), 'high-entropy token should be redacted');
});
