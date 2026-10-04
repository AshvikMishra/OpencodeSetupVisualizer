/**
 * Skill frontmatter parsing and the `chars` definition.
 *
 * `parseFrontmatter` once contained a mojibake regex that could never match, so
 * autoinvoke, version and source were silently wrong for EVERY skill.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseFrontmatter, isAutoinvokeDisabled, collectSkills, scopeFor } from '../src/collect/skills.js';
import { makeContext } from '../src/collect/context.js';

const F = '---\nname: demo\ndescription: A demo skill.\nversion: 9.9.9\nsource: acme/skills\n---\nBody text here.';

test('frontmatter is actually parsed', () => {
  const r = parseFrontmatter(F);
  assert.equal(r.hadFrontmatter, true, 'the regex must match a normal SKILL.md');
  assert.equal(r.data.name, 'demo');
  assert.equal(r.data.description, 'A demo skill.');
  assert.equal(r.data.version, '9.9.9');
  assert.equal(r.data.source, 'acme/skills');
});

test('frontmatter after a BOM is parsed', () => {
  const r = parseFrontmatter('﻿' + F);
  assert.equal(r.hadFrontmatter, true);
  assert.equal(r.data.name, 'demo');
});

test('a file with no frontmatter reports so honestly', () => {
  const r = parseFrontmatter('# Just markdown\n\nno frontmatter here');
  assert.equal(r.hadFrontmatter, false);
  assert.deepEqual(r.data, {});
});

test('bodyOffset points at the body, so chars excludes frontmatter', () => {
  const r = parseFrontmatter(F);
  assert.equal(F.slice(r.bodyOffset), 'Body text here.',
    'bodyOffset must exclude exactly the frontmatter block');
});

test('disable-model-invocation is detected', () => {
  for (const value of ['true', 'TRUE', true]) {
    assert.equal(isAutoinvokeDisabled({ 'disable-model-invocation': value }), true,
      `value ${value} must disable invocation`);
  }
  assert.equal(isAutoinvokeDisabled({}), false);
  assert.equal(isAutoinvokeDisabled({ 'disable-model-invocation': false }), false);
});

test('a list value is parsed', () => {
  const r = parseFrontmatter('---\nname: x\nallowed-tools:\n  - read\n  - grep\n---\nbody');
  assert.deepEqual(r.data['allowed-tools'], ['read', 'grep']);
});

test('the CLI autoinvoke flag wins over frontmatter', async () => {
  const ctx = makeContext({ home: 'HOME', projectDir: 'PROJ', platform: 'linux' });
  const skill = { id: 'blocked', name: 'blocked', description: 'd', path: '/x/SKILL.md' };
  const mk = autoinvoke => ({
    runOpencodeJson: async () => ({ ok: true, reason: null, data: { data: [{ ...skill, autoinvoke }] } }),
    runOpencode: async () => ({ ok: true, stdout: '', stderr: '', code: 0 }),
  });

  const off = await collectSkills(ctx, mk(false));
  assert.equal(off.skills[0].autoinvoke, false);
  assert.equal(off.skills[0].status, 'inactive',
    'a skill the model cannot invoke must not read as active');

  const on = await collectSkills(ctx, mk(true));
  assert.equal(on.skills[0].autoinvoke, true);
  assert.equal(on.skills[0].status, 'active');
});

test('every skill scope is one the template can index', () => {
  const HOME = 'HOME';
  const ctx = makeContext({ home: HOME, projectDir: 'PROJ', platform: 'linux' });
  for (const [p, want] of [
    ['/builtin/opencode.md', 'builtin'],
    [HOME + '/.agents/skills/x/SKILL.md', 'local'],
    [HOME + '/.config/opencode/skills/x/SKILL.md', 'local'],
    [HOME + '/.cache/opencode/npm/git-x/node_modules/superpowers/skills/x/SKILL.md', 'plugin'],
    ['PROJ/.opencode/skills/x/SKILL.md', 'project'],
    ['/nowhere/at/all/SKILL.md', 'local'],
  ]) {
    assert.equal(scopeFor(p, ctx), want, `wrong scope for ${p}`);
  }
});

test('duplicate skill names collapse once and are reported', async () => {
  const ctx = makeContext({ home: 'HOME', projectDir: 'PROJ', platform: 'linux' });
  const s = { id: 'dup', name: 'dup', description: 'd', path: '/a/SKILL.md' };
  const res = await collectSkills(ctx, {
    runOpencodeJson: async () => ({ ok: true, reason: null, data: { data: [s, { ...s, path: '/b/SKILL.md' }] } }),
    runOpencode: async () => ({ ok: true, stdout: '', stderr: '', code: 0 }),
  });
  assert.equal(res.skills.filter(x => x.name === 'dup').length, 1);
  assert.match(JSON.stringify(res.notes || []), /duplicate/i);
});

test('skill bodies are never emitted, only measured', async () => {
  const ctx = makeContext({ home: 'HOME', projectDir: 'PROJ', platform: 'linux' });
  const body = '---\nname: secret-skill\ndescription: d\n---\nA VERY-UNIQUE-BODY-MARKER';
  const res = await collectSkills(ctx, {
    runOpencodeJson: async () => ({
      ok: true, reason: null,
      data: { data: [{ id: 'secret-skill', name: 'secret-skill', description: 'd', path: '/x/SKILL.md', content: body }] },
    }),
    runOpencode: async () => ({ ok: true, stdout: '', stderr: '', code: 0 }),
  });
  const s = res.skills[0];
  assert.equal(s.chars, body.length, 'chars must be the body length');
  assert.ok(!JSON.stringify(s).includes('A VERY-UNIQUE-BODY-MARKER'),
    'the body text must never reach the snapshot');
});
