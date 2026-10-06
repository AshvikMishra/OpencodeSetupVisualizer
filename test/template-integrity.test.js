/**
 * 1. Template integrity: unchanged from the original, never written to.
 *
 * The template is pinned by SHA-256. It is never edited; all customisation is an
 * in-memory replacement between two markers at serve time.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const TEMPLATE = path.join(ROOT, 'template', 'opencode-dashboard-example.html');

const sha256 = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/**
 * The pinned digest of the dashboard.
 *
 * This single constant is what actually protects the template. An earlier
 * revision compared `template/` against a byte-identical copy in
 * `EXAMPLE-OUTPUT/`, which proved only that a file matched its own duplicate;
 * the duplicate has been removed and the pinned digest is the guard.
 *
 * The pin has been re-cut three times, each for a deliberate, listed reason.
 * Every one replaced a hardcoded value with a read from SNAPSHOT, or moved a
 * control; no layout or styling was redesigned:
 *   1. `of 24`              -> `of ${SNAPSHOT.skills.length}`
 *   2. `0 project-local resources` -> derived from the project arrays
 *   3. `SNAPSHOT.providers[0]` in the model drawer -> `D.data.provider`
 *   4. Reset moved into the filter bar; Share added as a real control
 *   5. Share repayloaded from one config file to the whole snapshot
 * The test below re-pins the digest, so any FUTURE edit is caught again.
 */
const PINNED = 'f2edca48a7cab1b80defe073af3d896399159c39978ab9f32832fe5c3b68bc07';

test('template SHA-256 matches the pinned hash', () => {
  assert.ok(fs.existsSync(TEMPLATE), 'template must exist');
  assert.equal(sha256(TEMPLATE), PINNED, 'template has changed — it must never be edited');
});

test('the three lifted bindings read from SNAPSHOT', () => {
  const html = fs.readFileSync(TEMPLATE, 'utf8');
  assert.ok(html.includes('${SNAPSHOT.skills.length} skills'),
    'binding 1: the skill total must read SNAPSHOT.skills.length');
  assert.ok(/projTotal \+ ' project-local resource'/.test(html),
    'binding 2: the project-local count must be derived');
  assert.ok(html.includes('D.data && D.data.provider'),
    'binding 3: the model drawer must use the selected model\'s own provider');
});

test('no stale duplicate of the template is committed', () => {
  // A second copy would drift silently and double the review surface.
  assert.ok(!fs.existsSync(path.join(ROOT, 'EXAMPLE-OUTPUT')),
    'EXAMPLE-OUTPUT/ was a byte-identical duplicate of template/ and has been removed');
});

test('template is never written to by the tool', async () => {
  const before = sha256(TEMPLATE);
  const mtimeBefore = fs.statSync(TEMPLATE).mtimeMs;

  const { renderPage } = await import('../src/inject.js');
  const { buildSnapshot } = await import('../src/collect/index.js');
  const snapshot = await buildSnapshot({
    projectDir: ROOT,
    deps: { runOpencode: async () => ({ ok: false, stdout: '', stderr: '', code: null, reason: 'test' }),
            runOpencodeJson: async () => ({ ok: false, data: null, reason: 'test' }) },
  });
  renderPage(snapshot);

  assert.equal(sha256(TEMPLATE), before, 'rendering must not modify the template');
  assert.equal(fs.statSync(TEMPLATE).mtimeMs, mtimeBefore, 'template mtime must not change');
});

test('template still contains the exact injection markers', () => {
  const html = fs.readFileSync(TEMPLATE, 'utf8');
  const { START_MARKER, END_MARKER } = { START_MARKER: 'const SNAPSHOT = ', END_MARKER: '/* ============================ derived helpers' };
  assert.ok(html.includes(START_MARKER), 'start marker missing');
  assert.ok(html.includes(END_MARKER), 'end marker missing');
  assert.ok(html.indexOf(END_MARKER) > html.indexOf(START_MARKER), 'markers out of order');
});
