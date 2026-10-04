/**
 * Agents collector: duplicate ids, permission formatting, and type coercion.
 *
 * `ENTITIES.find(kind==='agent' && id===a.id)` in the template means a duplicate
 * id makes the SECOND agent permanently unreachable — its card renders but its
 * drawer always shows the first one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { collectAgents } from '../src/collect/agents.js';
import { makeContext } from '../src/collect/context.js';

const ctx = () => makeContext({ home: 'FIXTURE_HOME', projectDir: 'FIXTURE_PROJ', platform: 'linux' });

const ok = stdout => ({ ok: true, stdout, stderr: '', code: 0 });
// runOpencodeJson must resolve to {ok, data, reason}, not a stdout envelope.
const deps = data => ({
  runOpencodeJson: async () => ({
    ok: true, reason: null,
    data: { location: { directory: 'FIXTURE' }, data },
  }),
  runOpencode: async () => ok(''),
});

test('duplicate agent ids are collapsed, keeping the first', async () => {
  const res = await collectAgents(ctx(), deps([
    { id: 'dup', name: 'First', description: 'ALPHAMARKER', mode: 'primary', permissions: [] },
    { id: 'dup', name: 'Second', description: 'BETAMARKER', mode: 'subagent', permissions: [] },
  ]));
  assert.equal(res.agents.length, 1, 'a duplicate id must not produce two entities');
  assert.equal(res.agents[0].role, 'ALPHAMARKER', 'the first wins');
  assert.match(JSON.stringify(res.notes || []), /duplicate/i,
    'the collision must be reported, not silently dropped');
});

test('a missing id still yields a usable agent', async () => {
  const res = await collectAgents(ctx(), deps([{}, { id: 'build', name: 'Build', permissions: [] }]));
  assert.ok(res.agents.length >= 1);
  for (const a of res.agents) {
    assert.equal(typeof a.id, 'string');
    assert.ok(a.id.length > 0, 'an agent with no id still needs a non-empty one');
  }
});

test('a permission with no action never renders "undefined:"', async () => {
  const res = await collectAgents(ctx(), deps([
    { id: 'a', name: 'A', permissions: [{ resource: '*', effect: 'deny' }] },
  ]));
  for (const perm of res.agents[0].deny) {
    assert.ok(!perm.startsWith('undefined'), `permission rendered as ${perm}`);
    // The action may legitimately be the `*` wildcard.
    assert.match(perm, /^[^:\s]+:\S*$/, `malformed permission: ${perm}`);
  }
});

test('a non-string description becomes a readable string', async () => {
  const res = await collectAgents(ctx(), deps([
    { id: 'a', name: 'A', description: { nested: true }, permissions: [] },
  ]));
  assert.equal(typeof res.agents[0].role, 'string');
  assert.ok(!res.agents[0].role.includes('[object Object]'),
    `role rendered as ${res.agents[0].role}`);
});

test('a blank name is replaced, never empty', async () => {
  const res = await collectAgents(ctx(), deps([
    { id: 'a', name: '   ', permissions: [] },
  ]));
  assert.ok(res.agents[0].name.trim().length > 0, 'a blank name would render an empty card');
});

test('an unknown mode falls back to a legal value', async () => {
  const res = await collectAgents(ctx(), deps([
    { id: 'a', name: 'A', mode: 'weird', permissions: [] },
  ]));
  assert.ok(['primary', 'subagent'].includes(res.agents[0].mode),
    `illegal mode ${res.agents[0].mode}`);
});

test('deny and ask are always arrays and permCount is a number', async () => {
  const res = await collectAgents(ctx(), deps([
    { id: 'a', name: 'A' }, // no permissions key at all
  ]));
  const a = res.agents[0];
  assert.ok(Array.isArray(a.deny));
  assert.ok(Array.isArray(a.ask));
  assert.equal(typeof a.permCount, 'number');
  assert.ok(Number.isFinite(a.permCount) && a.permCount >= 0);
});

test('tools is null or a non-empty array, never a string', async () => {
  const res = await collectAgents(ctx(), deps([
    { id: 'open', name: 'Open', permissions: [{ action: '*', resource: '*', effect: 'allow' }] },
    { id: 'closed', name: 'Closed', permissions: [
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'read', resource: '*.env.example', effect: 'allow' },
    ] },
  ]));
  for (const a of res.agents) {
    assert.ok(a.tools === null || Array.isArray(a.tools), `tools was ${typeof a.tools}`);
    if (Array.isArray(a.tools)) assert.ok(a.tools.length > 0, 'an empty tools array is noise');
  }
});

test('a missing agent list is reported, not silently empty', async () => {
  const res = await collectAgents(ctx(), {
    runOpencodeJson: async () => ({ ok: false, data: null, reason: 'ENOENT' }),
    runOpencode: async () => ok(''),
  });
  assert.equal(res.ok, false);
  assert.match(JSON.stringify([res.note, ...(res.notes || [])]), /could not be read|ENOENT|incomplete/i);
});
