/**
 * 3. TEMPLATE CONTRACT — the most important test.
 *
 * Executes the template's own inline script in node:vm against real collector
 * output for three profiles, then calls every render*() and detail() for every
 * entity. Any schema mismatch (missing key, wrong type, illegal scope) throws
 * here instead of in a browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSnapshot } from '../src/collect/index.js';
import { renderPage } from '../src/inject.js';
import { sanitize } from '../src/sanitize.js';
import { runTemplate } from './helpers/browser-stub.js';
import { buildFixture, stubExec, cleanup } from './fixtures/fixture.js';

const LEGAL_SCOPES = ['builtin', 'plugin', 'local', 'project'];

/** Collect, sanitize, inject, and boot the template. Never throws. */
async function boot(fixture, deps, contents = true) {
  const snapshot = await buildSnapshot({
    home: fixture.home,
    projectDir: fixture.project,
    deps,
  });
  const clean = sanitize(snapshot, { contents });
  const html = renderPage(clean);
  const booted = runTemplate(html);
  return { snapshot: clean, html, booted };
}

const RENDERERS = [
  'renderOverview', 'renderAgents', 'renderMcps', 'renderSkills', 'renderPlugins',
  'renderProviders', 'renderContext', 'renderConfig', 'renderWarnings',
  'renderProject', 'renderCommands', 'renderAutomation', 'renderGraph',
];

for (const profile of ['rich', 'empty']) {
  test(`template contract: ${profile} setup renders every section and drawer`, async t => {
    const fixture = buildFixture(profile);
    t.after(() => cleanup(fixture));

    const { booted, snapshot } = await boot(fixture, stubExec());
    const { api } = booted;

    // --- top-level schema ------------------------------------------------
    for (const key of [
      'meta', 'overview', 'agents', 'mcps', 'mcpEvidence', 'skills', 'plugins',
      'providers', 'project', 'commands', 'automation', 'warnings', 'context', 'configs',
    ]) {
      assert.ok(key in snapshot, `snapshot must contain ${key}`);
    }
    assert.ok(Array.isArray(snapshot.providers) && snapshot.providers.length >= 1,
      'providers[0] must exist or the model drawer breaks');

    // --- every renderer runs without throwing ----------------------------
    for (const fn of RENDERERS) {
      assert.doesNotThrow(() => api[fn](), `${fn}() must not throw`);
    }
    assert.doesNotThrow(() => api.render(), 'render() must not throw');

    // --- detail() for EVERY entity ---------------------------------------
    assert.ok(api.ENTITIES.length > 0 || profile === 'empty');
    for (const e of api.ENTITIES) {
      const d = api.detail(e.kind, e.id);
      assert.ok(d, `detail(${e.kind}, ${e.id}) returned null`);
      assert.ok(typeof d.title === 'string' && d.title.length > 0, `${e.kind}/${e.id} needs a title`);
      assert.ok(Array.isArray(d.chips), `${e.kind}/${e.id} chips must be an array`);
      assert.ok(typeof d.body === 'string' && d.body.length > 0, `${e.kind}/${e.id} needs a body`);
    }

    // --- field-level typing the template relies on ------------------------
    for (const s of snapshot.skills) {
      assert.ok(LEGAL_SCOPES.includes(s.scope), `illegal skill scope: ${s.scope} (template would crash)`);
      assert.equal(typeof s.name, 'string');
      assert.equal(typeof s.chars, 'number');
      assert.equal(typeof s.descChars, 'number');
      assert.equal(typeof s.autoinvoke, 'boolean');
      assert.equal(typeof s.desc, 'string');
      assert.equal(typeof s.path, 'string');
    }
    for (const a of snapshot.agents) {
      assert.ok(Array.isArray(a.deny), 'agent.deny must be an array (.join/.includes)');
      assert.ok(Array.isArray(a.ask), 'agent.ask must be an array');
      assert.ok(a.tools === null || Array.isArray(a.tools));
      assert.equal(typeof a.source, 'string', 'agent.source needs .startsWith()');
      assert.equal(typeof a.permCount, 'number');
      assert.equal(typeof a.visible, 'boolean');
    }
    for (const c of snapshot.configs) {
      assert.equal(typeof c.path, 'string');
      assert.equal(typeof c.body, 'string');
      assert.equal(typeof c.name, 'string');
      assert.equal(typeof c.lang, 'string');
    }
    for (const p of snapshot.automation) {
      assert.equal(typeof p.path, 'string', 'automation.path needs .startsWith()');
      assert.ok(p.bytes === null || typeof p.bytes === 'number');
    }
    for (const p of snapshot.providers) {
      assert.ok(Array.isArray(p.modelList));
      assert.ok(Array.isArray(p.recent));
      assert.ok(Array.isArray(p.favorites));
      assert.equal(typeof p.models, 'number');
      assert.equal(typeof p.variant, 'string');
    }
    for (const c of snapshot.context.alwaysResident) {
      assert.equal(typeof c.tokens, 'number', 'context tokens are summed with +c');
      assert.equal(typeof c.bytes, 'number');
      assert.equal(typeof c.label, 'string');
    }
    for (const w of snapshot.warnings) {
      assert.ok(['warn', 'info'].includes(w.level), `illegal warning level ${w.level}`);
      assert.equal(typeof w.source, 'string');
    }
    for (const m of snapshot.overview) {
      assert.equal(typeof m.value, 'number');
      assert.equal(typeof m.note, 'string');
      assert.ok(typeof m.icon === 'string' && m.icon.length);
      assert.ok(typeof m.to === 'string' && m.to.length);
    }
  });
}

test('template contract: partial-failure setup degrades honestly', async t => {
  const fixture = buildFixture('rich');
  t.after(() => cleanup(fixture));

  // CLI entirely missing + specific commands timing out.
  const deps = stubExec({ timeoutOn: new Set(['skill', 'models']) });
  const { booted, snapshot } = await boot(fixture, deps);
  const { api } = booted;

  for (const fn of RENDERERS) {
    assert.doesNotThrow(() => api[fn](), `${fn}() must not throw on partial failure`);
  }
  for (const e of api.ENTITIES) {
    assert.doesNotThrow(() => api.detail(e.kind, e.id), `detail(${e.kind}, ${e.id})`);
  }

  // Missing sources must be SAID, not silently empty.
  const text = JSON.stringify(snapshot);
  assert.match(text, /unavailable|could not be read|timed out/i,
    'partial failure must be reported in the data');

  // And providers[0] must still exist so the drawer does not break.
  assert.ok(snapshot.providers.length >= 1);
});

test('template contract: every warning level renders (warn and info)', async t => {
  const fixture = buildFixture('rich');
  t.after(() => cleanup(fixture));
  const { booted, snapshot } = await boot(fixture, stubExec());
  const levels = new Set(snapshot.warnings.map(w => w.level));
  assert.ok(levels.has('warn'), 'fixture should produce at least one warn');
  assert.ok(levels.has('info'), 'fixture should produce at least one info');
  for (const w of snapshot.warnings) {
    assert.doesNotThrow(() => booted.api.detail('warning', `warn-${snapshot.warnings.indexOf(w)}`));
  }
});

test('template contract: search filter and detail() tolerate empty collections', async t => {
  const fixture = buildFixture('empty');
  t.after(() => cleanup(fixture));
  const { booted } = await boot(fixture, stubExec());
  const { api } = booted;

  api.S.q = 'zzzz-no-such-thing';
  assert.doesNotThrow(() => api.render());
  api.S.q = '';
  assert.doesNotThrow(() => api.render());

  api.S.view = 'graph';
  assert.doesNotThrow(() => api.render());
});
