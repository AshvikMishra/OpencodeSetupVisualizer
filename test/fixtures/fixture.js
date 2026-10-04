/**
 * Fixture builders for the test suite.
 *
 * `buildFixture` writes a fake OpenCode home + project directory on disk.
 * `stubExec` returns canned CLI output so tests never depend on a real install.
 *
 * Expected counts live in `truth` and are computed from the fixture definition,
 * never read back out of the collector.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Adversarial canaries: fake secrets with unmistakable markers. */
export const CANARIES = Object.freeze({
  skKey: 'sk-FAKECANARY0123456789abcdefGHIJKL',
  ghToken: 'ghp_FAKECANARY0123456789abcdefghijklmnop',
  awsKey: 'AKIAFAKECANARY01234567',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5hcnkifQ.ZmFrZWd5LWNhbmFyeS1zaWc',
  pem: '-----BEGIN RSA PRIVATE KEY-----\nFAKECANARYMIIEow\n-----END RSA PRIVATE KEY-----',
  urlCreds: 'https://canaryuser:canarypass@example.invalid/path',
  password: 'CANARY-password-value-9000',
  oddCased: 'CANARY-odd-cased-7777',
  envSecret: 'CANARY_ENV_TOKEN=canaryvalue123',
  windowsPath: 'C:\\Users\\canaryuser\\.config\\opencode\\thing.json',
});

export const ALL_CANARY_VALUES = Object.freeze(Object.values(CANARIES));

function write(root, parts, content) {
  const full = path.join(root, ...parts);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

/**
 * Build a fixture.
 * @param {'rich'|'empty'|'huge'} profile
 * @param {{hugeSkills?:number, hugeModels?:number}} opts
 */
export function buildFixture(profile = 'rich', opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ovz-${profile}-`));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });

  const truth = {
    profile,
    agents: 0, skills: 0, mcps: 0, plugins: 0, models: 0,
    commands: 0, configs: 0, warningsAtLeast: 0,
  };
  const pluginSkills = [];
  const localSkills = [];

  if (profile === 'empty') {
    // A home dir that exists but contains nothing OpenCode-related.
    fs.mkdirSync(path.join(home, '.config', 'opencode'), { recursive: true });
    return { root, home, project, truth, pluginSkills, localSkills };
  }

  // ---- config -----------------------------------------------------------
  write(home, ['.config', 'opencode', 'opencode.json'], JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    plugins: ['superpowers@git+https://github.com/obra/superpowers.git'],
  }, null, 2));
  truth.plugins = 1;
  truth.configs += 1;

  write(home, ['.config', 'opencode', 'AGENTS.md'], '# Fixture router\n\nRoute things here.\n');
  truth.configs += 1;

  // Malformed optional file: must degrade to a note, never throw.
  write(home, ['.config', 'opencode', 'tui.json'], '{ this is not valid json ');

  // A capability pointing at a skill that is NOT installed -> verifiable warning.
  write(home, ['.config', 'opencode', 'capabilities.json'], JSON.stringify({
    capabilities: {
      'frontend-ui': { type: 'skill', keywords: ['ui'], covered_by: ['local-helper', 'missing-skill'] },
    },
  }, null, 2));
  truth.configs += 1;
  truth.warningsAtLeast += 1;

  // ---- adversarial secrets ---------------------------------------------
  write(home, ['.config', 'opencode', 'cli.json'], JSON.stringify({
    theme: 'opencode',
    animations: false,
    PaSsWoRd: CANARIES.password,
    apiKey: CANARIES.skKey,
    nested: { secret: CANARIES.oddCased, deep: { auth_token: CANARIES.jwt } },
    endpoint: CANARIES.urlCreds,
    cert: CANARIES.pem,
  }, null, 2));
  truth.configs += 1;
  truth.warningsAtLeast += 1; // plaintext secret keys

  // Shape-only: the tool must report key names and never read values.
  write(home, ['.config', 'opencode', 'service.json'],
    JSON.stringify({ password: CANARIES.password, refreshToken: CANARIES.jwt }, null, 2));

  // A non-allowlisted file that also holds a canary: must never be read at all.
  write(home, ['.config', 'opencode', 'notes.env'], CANARIES.envSecret);
  write(home, ['.config', 'opencode', 'private.pem'], CANARIES.pem);

  // ---- skills -----------------------------------------------------------
  const nPlugin = profile === 'huge' ? (opts.hugeSkills ?? 500) : 3;
  for (let i = 0; i < nPlugin; i++) {
    const n = `plugin-skill-${i}`;
    write(home, ['.cache', 'opencode', 'npm', 'git-superpowers-abc123', '1790711835417',
      'node_modules', 'superpowers', 'skills', n, 'SKILL.md'],
      `---\nname: ${n}\ndescription: Plugin skill number ${i}.\n---\nBody.\n`);
    pluginSkills.push(n);
  }
  truth.skills += nPlugin;

  const nLocal = profile === 'huge' ? 0 : 2;
  for (let i = 0; i < nLocal; i++) {
    const n = i === 0 ? 'local-helper' : 'local-blocked';
    const extra = n === 'local-blocked' ? 'disable-model-invocation: true\n' : '';
    write(home, ['.agents', 'skills', n, 'SKILL.md'],
      `---\nname: ${n}\ndescription: Local skill ${n}.\n${extra}---\nBody of ${n}.\n`);
    localSkills.push(n);
  }
  truth.skills += nLocal;

  // ---- commands ---------------------------------------------------------
  write(home, ['.config', 'opencode', 'commands', 'demo.md'],
    '---\nagent: build\nsubtask: true\n---\nRun the demo command.\n');
  truth.commands += 1;

  // ---- state ------------------------------------------------------------
  write(home, ['.local', 'state', 'opencode', 'model.json'],
    JSON.stringify({ recent: ['opencode/m1'], favorite: [] }));

  return { root, home, project, truth, pluginSkills, localSkills };
}

export function cleanup(fixture) {
  try {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  } catch { /* best effort */ }
}

/* ------------------------------------------------------------------ stubs */

const AGENT_FIXTURE = [
  {
    id: 'build', name: 'Build', description: 'The default agent.', mode: 'primary', hidden: false,
    permissions: [
      { action: '*', resource: '*', effect: 'allow' },
      { action: 'external_directory', resource: '*', effect: 'ask' },
      { action: 'browser', resource: '*', effect: 'deny' },
    ],
  },
  {
    id: 'explore', name: 'Explore', description: 'Codebase search.', mode: 'subagent', hidden: false,
    permissions: [
      { action: '*', resource: '*', effect: 'deny' },
      { action: 'grep', resource: '*', effect: 'allow' },
      { action: 'glob', resource: '*', effect: 'allow' },
      { action: 'read', resource: '*.env.example', effect: 'allow' },
    ],
  },
  {
    id: 'title', name: 'Title', description: 'Title generator.', mode: 'primary', hidden: true,
    permissions: [{ action: '*', resource: '*', effect: 'deny' }],
  },
];

/**
 * Build injectable exec functions.
 * @param {object} o
 * @param {number} [o.modelCount]
 * @param {boolean} [o.failCli]     make every CLI call fail (missing binary)
 * @param {boolean} [o.hangCli]     make version+skill hang (timeout path)
 * @param {Set<string>} [o.timeoutOn] which commands should time out
 */
export function stubExec(o = {}) {
  const modelCount = o.modelCount ?? 4;
  const timeoutOn = o.timeoutOn || new Set();

  const run = async which => {
    if (o.hangCli || timeoutOn.has(which)) {
      return { ok: false, stdout: '', stderr: '', code: null, reason: `command timed out after 10000ms`, timedOut: true };
    }
    if (o.failCli) {
      return { ok: false, stdout: '', stderr: '', code: 'ENOENT', reason: 'opencode executable not found on PATH' };
    }
    switch (which) {
      case 'version':
        return ok('opencode v9.9.9');
      case 'agent':
        return ok(JSON.stringify({ location: { directory: 'FIXTURE' }, data: AGENT_FIXTURE }));
      case 'skill':
        return ok(JSON.stringify({ location: { directory: 'FIXTURE' }, data: fixtureSkills(o) }));
      case 'provider':
        // settings.apiKey must never reach the snapshot.
        return ok(JSON.stringify({
          location: { directory: 'FIXTURE' },
          data: [{ id: 'opencode', name: 'OpenCode Zen', settings: { apiKey: CANARIES.skKey, baseURL: 'https://api.example.invalid' } }],
        }));
      case 'mcpApi':
        return ok(JSON.stringify({ location: { directory: 'FIXTURE' }, data: [] }));
      case 'models':
        return ok(Array.from({ length: modelCount }, (_, i) => `opencode/m${i + 1}`).join('\n') + '\n');
      case 'mcpList':
        return ok('No MCP servers configured\n');
      case 'pluginList':
        return ok('ID\tVERSION\tSOURCE\nsuperpowers\t8ca22db\tsuperpowers@git+https://github.com/obra/superpowers.git\n');
      default:
        return { ok: false, stdout: '', stderr: '', code: null, reason: `stub: unsupported ${which}` };
    }
  };

  const runJson = async which => {
    const r = await run(which);
    if (!r.ok) return { ok: false, data: null, reason: r.reason };
    return { ok: true, data: JSON.parse(r.stdout), reason: null };
  };

  return { runOpencode: run, runOpencodeJson: runJson, truthAgents: AGENT_FIXTURE };
}

function ok(stdout) {
  return { ok: true, stdout, stderr: '', code: 0 };
}

/** Skill list matching whatever the fixture put on disk. */
function fixtureSkills(o) {
  if (o.skills) return o.skills;
  return [
    { id: 'local-helper', name: 'local-helper', description: 'A local skill.', path: 'HOME/.agents/skills/local-helper/SKILL.md', content: '---\nname: local-helper\n---\nx' },
    { id: 'local-blocked', name: 'local-blocked', description: 'Blocked.', path: 'HOME/.agents/skills/local-blocked/SKILL.md', content: '---\nname: local-blocked\ndisable-model-invocation: true\n---\nx' },
  ];
}
