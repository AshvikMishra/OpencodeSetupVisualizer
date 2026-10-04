/**
 * Credential classification.
 *
 * A store may hold service bookkeeping next to a real secret. Reporting `id`,
 * `version`, `url` and `pid` as "credential keys" overstates what is sensitive —
 * and this project claims never to present a guess as a measurement.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { collectConfigs } from '../src/collect/configs.js';
import { makeContext } from '../src/collect/context.js';

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ovz-creds-'));
const rm = d => fs.rmSync(d, { recursive: true, force: true });

function fixture(serviceJson) {
  const root = tmpRoot();
  const g = path.join(root, '.config', 'opencode');
  fs.mkdirSync(g, { recursive: true });
  if (serviceJson !== null) {
    fs.writeFileSync(path.join(g, 'service.json'), JSON.stringify(serviceJson, null, 2));
  }
  const ctx = makeContext({ home: root, projectDir: os.tmpdir() });
  return { root, ctx, g };
}

test('bookkeeping keys are not reported as credentials', () => {
  const { root, ctx } = fixture({ id: 'x', version: 2, url: 'http://127.0.0.1:1234', pid: 99, password: 'REAL' });
  const { configs, notes, shapeNotes } = collectConfigs(ctx);
  const entry = configs.find(c => /service\.json/.test(c.path));
  assert.ok(entry, 'service.json must still be listed');

  const shapeNote = shapeNotes.find(n => /service\.json/.test(n));
  assert.ok(shapeNote, 'a shape note must exist');
  assert.match(shapeNote, /1 credential key\(s\): password/,
    `only the password is a credential; got: ${shapeNote}`);
  assert.ok(!/credential key\(s\):[^.]*\bpid\b/.test(shapeNote), 'pid must not be counted');

  assert.match(entry.note, /credential key\(s\): password/);
  assert.ok(!/\bpid\b[^.]*credential key/i.test(entry.note), 'pid must not appear as a credential');
  assert.match(entry.note, /not credentials/i, 'note must name the bookkeeping keys');
  for (const k of ['id', 'version', 'url', 'pid']) {
    assert.ok(entry.note.includes(k), `note must list ${k} explicitly`);
  }
  rm(root);
});

test('a store with only bookkeeping keys says so honestly', () => {
  const { root, ctx } = fixture({ id: 'abc', version: 1, pid: 42 });
  const { configs, shapeNotes } = collectConfigs(ctx);
  const entry = configs.find(c => /service\.json/.test(c.path));
  assert.ok(entry);
  assert.match(entry.note, /no credential-shaped key names/i,
    'must not claim credentials where there are none');
  assert.match(shapeNotes.join(' '), /no credential-shaped keys/i);
  rm(root);
});

test('every real credential key is still counted', () => {
  const { root, ctx } = fixture({
    id: 'x', version: 1, password: 'A', token: 'B', apiKey: 'C', auth: 'D',
  });
  const { configs } = collectConfigs(ctx);
  const entry = configs.find(c => /service\.json/.test(c.path));
  assert.match(entry.note, /4 credential key\(s\): password, token, apiKey, auth/);
  rm(root);
});

test('key names are reported but VALUES never are', () => {
  const secret = 'CANARY-must-never-appear-here';
  const { root, ctx } = fixture({ id: 'x', password: secret });
  const { configs } = collectConfigs(ctx);
  const entry = configs.find(c => /service\.json/.test(c.path));
  const serialised = JSON.stringify(entry);
  assert.ok(!serialised.includes(secret), 'the value must never enter the snapshot');
  assert.ok(entry.body.includes('REDACTED'), 'the stub must be visibly redacted');
  assert.ok(entry.body.includes('password'), 'but the key name must be present');
  rm(root);
});

test('a missing store produces no entry and no note', () => {
  const { root, ctx } = fixture(null);
  const { configs, shapeNotes } = collectConfigs(ctx);
  assert.ok(!configs.some(c => /service\.json/.test(c.path)));
  assert.ok(!shapeNotes.some(n => /service\.json/.test(n)));
  rm(root);
});
