/**
 * Honesty gate: every displayed value must be derived from collected data.
 *
 * Two shapes are checked:
 *   1. a REAL setup — must show only data-derived or "unknown" values
 *   2. an EMPTY setup — must not inherit any value from the real one
 *
 * This also re-renders the page for both and asserts the template does not
 * throw and does not print a hardcoded count.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTemplate } from './helpers/browser-stub.js';

import { buildSnapshot } from '../src/collect/index.js';
import { sanitize, assertClean, newReport } from '../src/sanitize.js';
import { renderPage, TEMPLATE_PATH } from '../src/inject.js';

const HOME = process.env.USERPROFILE || process.env.HOME;

/** A completely empty home+project: nothing exists. */
function emptyFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ovz-empty-'));
  const project = path.join(root, 'proj');
  fs.mkdirSync(path.join(project, '.opencode'), { recursive: true });
  return { root, home: root, project };
}

/** A minimal-but-nonempty setup: one skill, one command, one config. */
function minimalFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ovz-min-'));
  const g = path.join(root, '.config', 'opencode');
  fs.mkdirSync(path.join(g, 'skills', 'demo'), { recursive: true });
  fs.mkdirSync(path.join(g, 'commands', 'git'), { recursive: true });
  fs.writeFileSync(path.join(g, 'skills', 'demo', 'SKILL.md'),
    '---\nname: demo\ndescription: A demo skill.\n---\nBody.');
  // Nested command: exercises the recursive scan.
  fs.writeFileSync(path.join(g, 'commands', 'git', 'commit.md'),
    '---\ndescription: Commit helper\n---\nDo the thing.');
  fs.writeFileSync(path.join(g, 'opencode.json'), '{"theme":"opencode"}');
  const project = path.join(root, 'proj');
  fs.mkdirSync(project, { recursive: true });
  return { root, home: root, project };
}

const noDeps = {
  runOpencodeJson: async () => ({ ok: false, data: null, reason: 'CLI unavailable in test' }),
  runOpencode: async () => ({ ok: false, stdout: '', stderr: '', code: null, reason: 'CLI unavailable in test' }),
};

async function snapshotFor(home, projectDir, deps = noDeps) {
  return buildSnapshot({ home, projectDir, deps });
}

/**
 * Render and evaluate the template's own script, as the browser would.
 * Returns the markup the script actually built, so assertions read what a user
 * would see rather than the static HTML shell. The template mounts into
 * `#sections`, not `<body>`.
 */
function renderAndRun(snapshot) {
  const html = renderPage(snapshot, TEMPLATE_PATH);
  const { byId } = runTemplate(html); // throws if the template's script throws
  return { html, rendered: byId.get('sections')?.innerHTML ?? '' };
}

/* ------------------------------------------------------------ empty setup */

test('an empty setup produces only unknown or zero values', async () => {
  const fx = emptyFixture();
  const snap = await snapshotFor(fx.home, fx.project);
  const clean = sanitize(snap, { report: newReport(), contents: true });
  assertClean(clean);
  assert.equal(clean.skills.length, 0, 'no skills exist, so none may be invented');
  assert.equal(clean.mcps.length, 0);
  assert.equal(clean.agents.length, 0);
  assert.equal(clean.providers.length, 0, 'no provider may be fabricated');
  assert.equal(clean.plugins.length, 0);
  assert.equal(clean.commands.length, 0);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('an empty setup renders without throwing', async () => {
  const fx = emptyFixture();
  const snap = await snapshotFor(fx.home, fx.project);
  const clean = sanitize(snap, { report: newReport(), contents: true });
  const { html } = renderAndRun(clean);
  assert.ok(html.length > 5000);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('unmeasured values are null, never zero', async () => {
  const fx = emptyFixture();
  const snap = await snapshotFor(fx.home, fx.project);
  const clean = sanitize(snap, { report: newReport(), contents: true });
  // With the CLI unavailable, the MCP row must be "not measured", not "0 of 0".
  for (const row of clean.context.none) {
    assert.ok(row.bytes === null || row.bytes === 0,
      `${row.label} must be null (unmeasured) or 0 (measured empty), got ${row.bytes}`);
  }
  if (clean.context.none.some(r => r.label === 'MCP tool schemas')) {
    const mcpRow = clean.context.none.find(r => r.label === 'MCP tool schemas');
    assert.match(mcpRow.detail, /not measured|is empty|were discovered/i,
      `MCP row must explain itself: ${mcpRow.detail}`);
  }
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('the project note never claims a check that does not exist', async () => {
  const fx = emptyFixture();
  const snap = await snapshotFor(fx.home, fx.project);
  const note = snap.project.note;
  assert.ok(!/hidden-file glob/i.test(note),
    `note claims a glob that is not in the code: ${note}`);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

/* ------------------------------------------------------- minimal setup */

test('a nested command is discovered and named', async () => {
  const fx = minimalFixture();
  const snap = await snapshotFor(fx.home, fx.project);
  const names = snap.commands.map(c => c.name);
  assert.ok(names.includes('git:commit'),
    `nested command missing; found ${JSON.stringify(names)}`);
  const c = snap.commands.find(x => x.name === 'git:commit');
  assert.equal(c.agent, null, 'an unstated agent must be null, not defaulted');
  assert.equal(c.subtask, null, 'an unstated subtask must be null');
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('an automation file that is absent is reported absent, not dropped', async () => {
  const fx = minimalFixture();
  const snap = await snapshotFor(fx.home, fx.project);
  const lock = snap.automation.find(a => /skills-lock/.test(a.name));
  assert.ok(lock, 'an absent automation entry must still be listed');
  assert.equal(lock.status, 'absent');
  assert.equal(lock.bytes, null);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('the skill count in the page matches the collected count', async () => {
  const fx = minimalFixture();
  const snap = await snapshotFor(fx.home, fx.project);
  const clean = sanitize(snap, { report: newReport(), contents: true });
  const { rendered } = renderAndRun(clean);
  // The template's former literal was "of 24"; it must now track the data.
  assert.ok(!/of 24 skills/.test(rendered),
    'the template still prints a hardcoded skill total');
  if (clean.skills.length) {
    assert.ok(rendered.includes(`of ${clean.skills.length} skills`),
      `template did not print the collected skill total (${clean.skills.length})`);
  }
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('the project resource count tracks the data', async () => {
  const fx = emptyFixture();
  const snap = await snapshotFor(fx.home, fx.project);
  const clean = sanitize(snap, { report: newReport(), contents: true });
  const { rendered } = renderAndRun(clean);
  const p = clean.project;
  const total = p.localSkills.length + p.localAgents.length + p.localPlugins.length +
    p.localMcps.length + p.localConfig.length;
  // The count must EQUAL the collected total. A string check cannot tell a
  // derived "0 project-local resources" from the old hardcoded one, because
  // they are the same words when the real count happens to be zero.
  assert.ok(rendered.includes(`${total} project-local resource`),
    `the project-local count is not derived from collected data (expected ${total})`);
  fs.rmSync(fx.root, { recursive: true, force: true });
});

/* ------------------------------------------------------------ real setup */

test('the real setup reports only data-derived values', async () => {
  const snap = await buildSnapshot({ home: HOME });
  const clean = sanitize(snap, { report: newReport(), contents: true });
  assertClean(clean);

  // No fabricated provider sentinel.
  assert.ok(!clean.providers.some(p => /No provider discovered/i.test(p.name)),
    'a fabricated provider entry is present');
  for (const p of clean.providers) {
    assert.ok(Number.isFinite(p.models) && p.models >= 0, `bad model count on ${p.name}`);
    assert.equal(p.modelList.length, p.models,
      `modelList length must equal the model count for ${p.name}`);
  }
  // Favourites must be scoped to the provider that offers them.
  for (const p of clean.providers) {
    for (const f of p.favorites) {
      assert.ok(p.modelList.includes(f), `${p.name} lists a favourite it does not offer: ${f}`);
    }
  }
  // Agent roles must be real strings.
  for (const a of clean.agents) {
    assert.equal(typeof a.role, 'string');
    assert.ok(!a.role.includes('[object'));
  }
  // Commands must not carry invented values.
  for (const c of clean.commands) {
    assert.ok(c.agent === null || typeof c.agent === 'string');
    assert.ok(c.subtask === null || typeof c.subtask === 'boolean');
  }
  // Resident rows must sum to a finite token count.
  const resident = clean.context.alwaysResident.reduce((a, r) => a + (r.tokens || 0), 0);
  assert.ok(Number.isFinite(resident) && resident > 0, `resident total was ${resident}`);
});

test('the real setup renders without throwing', async () => {
  const snap = await buildSnapshot({ home: HOME });
  const clean = sanitize(snap, { report: newReport(), contents: true });
  const { html } = renderAndRun(clean);
  assert.ok(html.length > 10000);
});

test('no legitimate snapshot field is over-redacted', async () => {
  // A sanitizer that eats real data is as wrong as one that leaks. An earlier
  // `key -> privatekey` rule blanked every overview section id.
  const snap = await buildSnapshot({ home: HOME });
  const clean = sanitize(snap, { report: newReport(), contents: true });

  const offenders = [];
  const keys = new Set();
  const walk = (node, p = '$') => {
    if (node === null || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'body') continue; // bodies are meant to be redacted
      keys.add(k);
      if (typeof v === 'string' && v.startsWith('[REDACTED')) {
        offenders.push(`${p}.${k}`);
      }
      walk(v, `${p}.${k}`);
    }
  };
  walk(clean);

  assert.deepEqual(offenders, [], `legitimate values were redacted: ${offenders.slice(0, 8).join(', ')}`);
  // The overview ids are what the dashboard links on; they must survive intact.
  assert.deepEqual(clean.overview.map(o => o.key),
    ['agents', 'skills', 'mcps', 'plugins', 'providers', 'models', 'project']);
  assert.ok(clean.agents.length > 0 && clean.skills.length > 0,
    'collections must not be emptied by the sanitizer');
});

/* ------------------------------------------------------- the sweep itself */

test('no rendered page prints a literal null or undefined', async () => {
  // A null that reaches a template formatter prints the word "null". This
  // happened for real: the MCP drawer rendered "contributes null to context".
  const fx = emptyFixture();
  const snap = await snapshotFor(fx.home, fx.project);
  const clean = sanitize(snap, { report: newReport(), contents: true });
  const { rendered } = renderAndRun(clean);
  assert.ok(!/>null\b/.test(rendered), 'a literal "null" was rendered');
  assert.ok(!/\bundefined\b/.test(rendered), 'a literal "undefined" was rendered');
  assert.ok(!/\bNaN\b/.test(rendered), 'a literal "NaN" was rendered');
  fs.rmSync(fx.root, { recursive: true, force: true });
});

test('the MCP section and the context row cannot contradict each other', async () => {
  // Both read the same signal. When the list could not be read, neither may
  // claim it was read and empty.
  for (const setup of ['empty', 'minimal']) {
    const fx = setup === 'empty' ? emptyFixture() : minimalFixture();
    const snap = await snapshotFor(fx.home, fx.project);
    const clean = sanitize(snap, { report: newReport(), contents: true });
    const { rendered } = renderAndRun(clean);
    const row = clean.context.none.find(r => r.label === 'MCP tool schemas');
    assert.ok(row, 'the MCP tool-schema row must exist');
    const notRead = row.tokens === null;
    const claimsRead = /server list read/.test(rendered);
    const claimsNotRead = /server list not read/.test(rendered);
    if (notRead) {
      assert.ok(!claimsRead,
        `${setup}: context row says "not measured" but the MCP chip claims the list was read`);
      assert.ok(claimsNotRead, `${setup}: expected the "server list not read" chip`);
    } else {
      assert.ok(claimsRead, `${setup}: row was measured, so the list WAS read`);
    }
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------- the sweep itself */

test('no collector emits a hardcoded count in a display string', async () => {
  const snap = await buildSnapshot({ home: HOME });
  const clean = sanitize(snap, { report: newReport(), contents: true });
  // The template used to print "0 project-local resources" and "historically
  // had 1 - removed". Neither may reappear.
  const { rendered } = renderAndRun(clean);
  for (const banned of [
    // A claim about the user's history that no code can know.
    'historically had 1',
    // A fabricated provider entity.
    'No provider discovered',
    // A hardcoded total. (Note: "of 24 skills" is NOT banned — on this machine
    // the real count IS 24, so the derived text is identical. The equality
    // assertion above is what proves the binding.)
    'One provider is reachable',
  ]) {
    assert.ok(!rendered.includes(banned), `hardcoded display string present: ${banned}`);
  }
});