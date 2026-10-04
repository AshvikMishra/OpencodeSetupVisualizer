/**
 * 7. COLLECTOR ROBUSTNESS — missing dirs, malformed files, timeouts, absent CLI.
 *
 * Every case must produce an honest snapshot with explicit "unavailable" text,
 * never a throw and never a silently-empty section presented as complete.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildSnapshot } from '../src/collect/index.js';
import { sanitize } from '../src/sanitize.js';
import { renderPage } from '../src/inject.js';
import { runTemplate } from './helpers/browser-stub.js';
import { parseJsonc } from '../src/jsonc.js';
import { buildFixture, stubExec, cleanup } from './fixtures/fixture.js';

/** Boot the template against a snapshot; used to prove nothing throws. */
function boot(snapshot) {
  const clean = sanitize(snapshot, { contents: true });
  return runTemplate(renderPage(clean));
}

test('a completely missing home directory yields an honest empty snapshot', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ovz-missing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const missing = path.join(root, 'does', 'not', 'exist');

  const snapshot = await buildSnapshot({
    home: missing,
    projectDir: path.join(root, 'also-missing'),
    deps: stubExec({ failCli: true }),
  });

  for (const k of ['agents', 'skills', 'plugins', 'configs']) {
    assert.deepEqual(snapshot[k], [], `${k} should be empty`);
  }
  // No provider may be invented. The template's model drawer is now guarded
  // against an empty provider list, so an honest empty array is correct.
  assert.deepEqual(snapshot.providers, [],
    'a missing home must not produce a fabricated provider entry');
  assert.doesNotThrow(() => boot(snapshot));
});

test('a CLI that is not installed degrades to explicit unavailability', async t => {
  const fixture = buildFixture('rich');
  t.after(() => cleanup(fixture));
  const snapshot = await buildSnapshot({
    home: fixture.home,
    projectDir: fixture.project,
    deps: stubExec({ failCli: true }),
  });

  const text = JSON.stringify(snapshot);
  assert.match(text, /not found on PATH|unavailable|could not be read/i);
  assert.equal(snapshot.meta.opencodeVersion, 'unknown');
  assert.equal(snapshot.meta.versionEvidence, 'unavailable');
  assert.doesNotThrow(() => boot(snapshot));
});

test('a timing-out command is reported, not silently treated as empty', async t => {
  const fixture = buildFixture('rich');
  t.after(() => cleanup(fixture));
  const snapshot = await buildSnapshot({
    home: fixture.home,
    projectDir: fixture.project,
    deps: stubExec({ timeoutOn: new Set(['skill', 'agent', 'models']) }),
  });

  assert.deepEqual(snapshot.skills, [], 'a timeout must not fabricate skills');
  assert.match(JSON.stringify(snapshot), /timed out/i, 'timeout must be reported');
  assert.doesNotThrow(() => boot(snapshot));
});

test('malformed JSON and JSONC degrade to a note instead of throwing', async t => {
  const fixture = buildFixture('rich');
  t.after(() => cleanup(fixture));
  // The fixture already writes a malformed tui.json.
  const snapshot = await buildSnapshot({
    home: fixture.home, projectDir: fixture.project, deps: stubExec(),
  });
  const tui = snapshot.configs.find(c => /tui\.json/.test(c.name));
  assert.ok(tui, 'the malformed file must still be listed');
  assert.match(tui.note, /did not parse|verbatim/i);
  assert.doesNotThrow(() => boot(snapshot));
});

test('a malformed capabilities.json produces a warning, not a crash', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ovz-badcap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'opencode', 'capabilities.json'), '{ broken: ');

  const snapshot = await buildSnapshot({
    home, projectDir: path.join(root, 'proj'), deps: stubExec({ failCli: true }),
  });
  assert.ok(snapshot.warnings.some(w => /capabilities\.json could not be parsed/i.test(w.title)));
  assert.doesNotThrow(() => boot(snapshot));
});

test('an oversized config body is truncated with a visible marker', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ovz-big-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const g = path.join(home, '.config', 'opencode');
  fs.mkdirSync(g, { recursive: true });
  fs.writeFileSync(path.join(g, 'AGENTS.md'), 'x'.repeat(200 * 1024));

  const snapshot = await buildSnapshot({
    home, projectDir: path.join(root, 'proj'), deps: stubExec({ failCli: true }),
  });
  const agents = snapshot.configs.find(c => /AGENTS\.md/.test(c.name));
  assert.match(agents.body, /truncated/);
  assert.ok(Buffer.byteLength(agents.body) < 200 * 1024);
});

test('a directory named like a config file does not break the inspector', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ovz-dir-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const g = path.join(home, '.config', 'opencode');
  fs.mkdirSync(path.join(g, 'opencode.json'), { recursive: true }); // a DIRECTORY
  const snapshot = await buildSnapshot({
    home, projectDir: path.join(root, 'proj'), deps: stubExec({ failCli: true }),
  });
  assert.ok(!snapshot.configs.some(c => c.name === 'opencode.json'),
    'a directory must not be read as a file');
  assert.doesNotThrow(() => boot(snapshot));
});

test('a skill with an out-of-scope path is clamped to a legal scope', async t => {
  const fixture = buildFixture('rich');
  t.after(() => cleanup(fixture));
  const weird = '/opt/nowhere/skills/odd/SKILL.md';
  const deps = stubExec({
    skills: [{ id: 'odd', name: 'odd', description: 'Odd.', path: weird, content: '---\nname: odd\n---\nx' }],
  });
  const snapshot = await buildSnapshot({ home: fixture.home, projectDir: fixture.project, deps });
  for (const s of snapshot.skills) {
    assert.ok(['builtin', 'plugin', 'local', 'project'].includes(s.scope),
      `illegal scope ${s.scope} would crash SCOPE[s.scope] in the template`);
  }
  assert.doesNotThrow(() => boot(snapshot));
});

test('duplicate skill names are counted once and reported', async t => {
  const fixture = buildFixture('rich');
  t.after(() => cleanup(fixture));
  const dup = { id: 'dup', name: 'dup', description: 'D.', path: '/x/dup/SKILL.md', content: 'x' };
  const deps = stubExec({ skills: [dup, { ...dup, path: '/y/dup/SKILL.md' }] });
  const snapshot = await buildSnapshot({ home: fixture.home, projectDir: fixture.project, deps });
  assert.equal(snapshot.skills.filter(s => s.name === 'dup').length, 1);
  assert.match(JSON.stringify(snapshot), /duplicate/i);
});

test('a huge setup (500 skills, 200 models) collects without throwing', async t => {
  const fixture = buildFixture('huge', { hugeSkills: 500 });
  t.after(() => cleanup(fixture));
  const skills = Array.from({ length: 500 }, (_, i) => ({
    id: `bulk-${i}`, name: `bulk-${i}`, description: `Bulk skill ${i}.`,
    path: `/cache/skills/bulk-${i}/SKILL.md`, content: `---\nname: bulk-${i}\n---\nbody`,
  }));
  const deps = stubExec({ skills, modelCount: 200 });

  const t0 = Date.now();
  const snapshot = await buildSnapshot({ home: fixture.home, projectDir: fixture.project, deps });
  const ms = Date.now() - t0;

  assert.equal(snapshot.skills.length, 500);
  assert.equal(snapshot.overview.find(o => o.key === 'models').value, 200);
  const booted = boot(snapshot);
  assert.ok(booted.api.ENTITIES.length > 500);
  for (const e of booted.api.ENTITIES) {
    assert.doesNotThrow(() => booted.api.detail(e.kind, e.id));
  }
  t.diagnostic(`500 skills + 200 models collected and rendered in ${ms}ms`);
});

test('jsonc: comments and trailing commas parse, strings are preserved', () => {
  const src = `{
    // line comment
    "a": 1, /* block */
    "b": "http://x/y",  // not a comment
    "c": [1, 2, 3,],
  }`;
  assert.deepEqual(parseJsonc(src), { a: 1, b: 'http://x/y', c: [1, 2, 3] });
});

test('jsonc: a // inside a string is not treated as a comment', () => {
  assert.deepEqual(parseJsonc('{"url":"https://example.com/a//b"}'),
    { url: 'https://example.com/a//b' });
});

test('jsonc: malformed input throws rather than returning garbage', () => {
  assert.throws(() => parseJsonc('{ "a": }'));
  assert.throws(() => parseJsonc('not json at all'));
});

test('a collector that throws is contained and reported', async t => {
  const fixture = buildFixture('rich');
  t.after(() => cleanup(fixture));
  const base = stubExec();
  const deps = {
    runOpencode: base.runOpencode,
    runOpencodeJson: async w => {
      if (w === 'skill') throw new Error('synthetic collector explosion');
      return base.runOpencodeJson(w);
    },
  };
  const snapshot = await buildSnapshot({ home: fixture.home, projectDir: fixture.project, deps });
  assert.match(JSON.stringify(snapshot), /synthetic collector explosion/,
    'a throwing collector must surface its reason in the data');
  assert.doesNotThrow(() => boot(snapshot));
});
