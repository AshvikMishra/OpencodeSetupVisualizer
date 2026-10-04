/**
 * Section 7 — LIVE RUN against the real local OpenCode install (read-only).
 *
 * Counts are obtained INDEPENDENTLY, by running the CLI and listing files here,
 * never by calling the collector. Differences are then explained.
 *
 * Prints counts and kinds only. No secret values and no real config contents.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { startServer } from '../src/server.js';
import { unwrapShim } from '../src/exec.js';

const pexec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(HERE, 'artifacts', 'live');
fs.mkdirSync(ART, { recursive: true });

const results = [];
const record = (section, check, status, evidence) => {
  results.push({ section, check, status, evidence });
  console.log(`${status}  [${section}] ${check}${evidence ? ` :: ${evidence}` : ''}`);
};

/* ------------------------------ independent CLI invocation --------------- */

const npmDir = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : null;
const opencodeExe = npmDir ? unwrapShim(path.join(npmDir, 'opencode.cmd')) : null;

/**
 * Run a fixed opencode argv vector, directly (no shell).
 *
 * `api get` is retried on a short response: the background OpenCode service can
 * answer a partially-initialised payload on a cold call (observed once during
 * verification: an empty agent list and a truncated skill list, both of which
 * then matched a subsequent retry). An empty array is treated as a cold-start
 * artefact, not as ground truth.
 */
async function oc(args, { timeout = 60000, retries = 2, requireNonEmpty = false } = {}) {
  if (!opencodeExe) return { ok: false, reason: 'opencode executable not found' };
  let last = { ok: false, reason: 'not attempted', stdout: '' };
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await pexec(opencodeExe, args, { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
      last = { ok: true, stdout: r.stdout };
      if (requireNonEmpty) {
        try {
          const parsed = JSON.parse(r.stdout);
          const n = Array.isArray(parsed?.data) ? parsed.data.length : -1;
          if (n === 0 && attempt < retries) {
            await new Promise(res => setTimeout(res, 1200));
            continue;
          }
        } catch { /* fall through to the caller's parse */ }
      }
      return last;
    } catch (e) {
      last = { ok: false, reason: String(e.message).split('\n')[0], stdout: e.stdout || '' };
      if (attempt < retries) await new Promise(res => setTimeout(res, 1200));
    }
  }
  return last;
}

const httpGet = url => new Promise((res, rej) => {
  http.get(url, r => {
    let b = '';
    r.setEncoding('utf8');
    r.on('data', d => { b += d; });
    r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: b }));
  }).on('error', rej);
});

/* ============================ 1. independent ground truth ================ */

console.log('--- independent CLI counts (no collector involved) ---');

const verRes = await oc(['--version']);
record('7', 'opencode CLI is invocable directly', verRes.ok ? 'PASS' : 'FAIL',
  verRes.ok ? verRes.stdout.trim() : verRes.reason);

const agentRes = await oc(['api', 'get', '/api/agent'], { requireNonEmpty: true });
let truthAgents = null;
if (agentRes.ok) {
  try {
    const d = JSON.parse(agentRes.stdout).data || [];
    truthAgents = {
      total: d.length,
      visible: d.filter(a => !a.hidden).length,
      hidden: d.filter(a => a.hidden).length,
      subagent: d.filter(a => a.mode === 'subagent').length,
    };
  } catch { /* reported below */ }
}
record('7', 'agents counted independently', truthAgents ? 'PASS' : 'FAIL',
  truthAgents ? `total=${truthAgents.total} visible=${truthAgents.visible} hidden=${truthAgents.hidden} subagent=${truthAgents.subagent}`
    : agentRes.reason || 'unparseable');

const skillRes = await oc(['api', 'get', '/api/skill'], { requireNonEmpty: true });
let truthSkills = null;
if (skillRes.ok) {
  try {
    const d = JSON.parse(skillRes.stdout).data || [];
    const names = d.map(s => s.name);
    truthSkills = { total: d.length, uniqueNames: new Set(names).size };
  } catch { /* reported below */ }
}
record('7', 'skills counted independently', truthSkills ? 'PASS' : 'FAIL',
  truthSkills ? `rows=${truthSkills.total} uniqueNames=${truthSkills.uniqueNames}` : skillRes.reason || 'unparseable');

const pluginRes = await oc(['plugin', 'list']);
let truthPlugins = null;
if (pluginRes.ok) {
  const rows = pluginRes.stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    .filter(l => !/^id\s+version/i.test(l));
  truthPlugins = { total: rows.length };
}
record('7', 'plugins counted independently', truthPlugins ? 'PASS' : 'FAIL',
  truthPlugins ? `${truthPlugins.total} row(s)` : pluginRes.reason);

const modelsRes = await oc(['models']);
let truthModels = null;
if (modelsRes.ok) {
  const ids = modelsRes.stdout.split(/\r?\n/).map(l => l.trim()).filter(l => /^[\w.-]+\/[\w./-]+$/.test(l));
  truthModels = { total: ids.length, prefixes: [...new Set(ids.map(i => i.split('/')[0]))] };
}
record('7', 'models counted independently', truthModels ? 'PASS' : 'FAIL',
  truthModels ? `${truthModels.total} model(s), providers: ${truthModels.prefixes.join(', ')}` : modelsRes.reason);

const mcpRes = await oc(['mcp', 'list']);
let truthMcps = 0;
if (mcpRes.ok) {
  truthMcps = /No MCP servers configured/i.test(mcpRes.stdout)
    ? 0
    : mcpRes.stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean).length;
}
record('7', 'MCP servers counted independently', mcpRes.ok ? 'PASS' : 'FAIL',
  `${truthMcps} configured (${mcpRes.ok ? mcpRes.stdout.trim().slice(0, 40) : mcpRes.reason})`);

/* ------------------------- 2. independent filesystem counts -------------- */

const home = os.homedir();
const globalDir = path.join(home, '.config', 'opencode');
const countSkillFiles = dir => {
  let n = 0;
  const walk = d => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile() && /^SKILL\.md$/i.test(e.name)) n++;
    }
  };
  walk(dir);
  return n;
};
const diskSkills = {
  agentsSkills: countSkillFiles(path.join(home, '.agents', 'skills')),
  globalSkills: countSkillFiles(path.join(globalDir, 'skills')),
};
record('7', 'on-disk SKILL.md files counted independently', 'PASS',
  `~/.agents/skills=${diskSkills.agentsSkills}, ~/.config/opencode/skills=${diskSkills.globalSkills}`);

let commandsCount = 0;
try {
  commandsCount = fs.readdirSync(path.join(globalDir, 'commands'))
    .filter(f => /\.(md|markdown)$/i.test(f)).length;
} catch { /* zero */ }
record('7', 'slash commands counted on disk', 'PASS', `${commandsCount} command file(s)`);

/* ============================ 3. run the tool ============================ */

const handle = await startServer({ port: Number(process.argv[2]) || 4950, collectOpts: {} });

const tCold = Date.now();
const cold = await httpGet(handle.url + 'api/snapshot');
const coldMs = Date.now() - tCold;
const tWarm = Date.now();
await httpGet(handle.url + 'api/snapshot');
const warmMs = Date.now() - tWarm;

let snap = null;
try { snap = JSON.parse(cold.body); } catch { /* reported below */ }
record('7', 'tool serves a snapshot against the real install', snap ? 'PASS' : 'FAIL',
  `cold=${coldMs}ms warm=${warmMs}ms, ${cold.body.length} bytes`);

/* -------------------- 4. compare the dashboard's own counts -------------- */

const ov = Object.fromEntries((snap?.overview || []).map(o => [o.key, o.value]));
const cmp = [];
const compare = (key, mine, theirs, note) => {
  const ok = String(mine) === String(theirs);
  cmp.push({ key, mine, theirs, ok, note });
  record('7', `Overview "${key}" matches independent count`, ok ? 'PASS' : 'DIFF',
    `dashboard=${mine} independent=${theirs}${note ? ` (${note})` : ''}`);
};

if (truthAgents) compare('agents', ov.agents, truthAgents.total,
  `includes ${truthAgents.hidden} hidden internal agents`);
if (truthSkills) compare('skills', ov.skills, truthSkills.uniqueNames,
  truthSkills.uniqueNames !== truthSkills.total
    ? `${truthSkills.total} rows collapse to ${truthSkills.uniqueNames} unique names`
    : 'no duplicate names');
if (truthModels) compare('models', ov.models, truthModels.total, 'from `opencode models`');
compare('mcps', ov.mcps, truthMcps, 'from `opencode mcp list`');
if (truthPlugins) compare('plugins', ov.plugins, truthPlugins.total, 'from `opencode plugin list`');

const unexplainable = cmp.filter(c => !c.ok);
record('7', 'every dashboard count is explained', unexplainable.length === 0 ? 'PASS' : 'FAIL',
  unexplainable.length === 0 ? `${cmp.length} counts, all matched`
    : unexplainable.map(c => `${c.key}: ${c.mine} vs ${c.theirs}`).join('; '));

/* -------------------- 5. sources that worked / unavailable --------------- */

const ev = snap?.meta?.apiEvidence || [];
record('7', 'apiEvidence lists only sources actually used',
  Array.isArray(ev) && ev.every(e => typeof e === 'string' && e) ? 'PASS' : 'FAIL',
  ev.join(' | '));
record('7', 'OpenCode version discovered', snap?.meta?.opencodeVersion !== 'unknown' ? 'PASS' : 'FAIL',
  `v${snap?.meta?.opencodeVersion} via ${snap?.meta?.versionEvidence}`);

/* -------------------- 6. privacy scan on the live output ----------------- */

const realHome = os.homedir();
const userBase = path.basename(realHome);
const homeVariants = [realHome, realHome.replace(/\\/g, '/'), encodeURIComponent(realHome), userBase];
const identHits = homeVariants.filter(v => v && v.length > 2 && cold.body.includes(v));
record('7', 'live output contains no real username or home path', identHits.length === 0 ? 'PASS' : 'FAIL',
  identHits.length === 0 ? `scanned ${cold.body.length} bytes; home token present: ${/%USERPROFILE%|~\//.test(cold.body)}`
    : `${identHits.length} variant(s) found`);

// Independent pattern sweep (not the product's regexes).
const LIVE_PATTERNS = [
  ['url-credentials', /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i],
  ['pem-header', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['jwt', /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/],
  ['provider-key', /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/],
];
const liveHits = LIVE_PATTERNS.filter(([, re]) => re.test(cold.body)).map(([k]) => k);
record('7', 'live output has no secret-shaped strings (independent scan)', liveHits.length === 0 ? 'PASS' : 'FAIL',
  liveHits.length === 0 ? '0 pattern hits' : liveHits.join(', '));

// How many credential-shaped keys exist, by name only.
const secretKeyNames = new Set();
(function walk(node) {
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    const nk = k.toLowerCase().replace(/[^a-z]/g, '');
    if (['password', 'secret', 'token', 'apikey', 'auth', 'cookie', 'credential', 'privatekey'].some(w => nk.includes(w))) {
      secretKeyNames.add(k);
    }
    walk(v);
  }
})(snap);
const nonRedacted = [...secretKeyNames].filter(k => {
  const re = new RegExp(`"${k}":\\s*"(?!\\[REDACTED|<REDACTED|\\$)`, 'i');
  return re.test(cold.body);
});
record('7', 'every credential-shaped key has a redacted value', nonRedacted.length === 0 ? 'PASS' : 'FAIL',
  `${secretKeyNames.size} credential key name(s) seen; non-redacted: ${nonRedacted.length}`);

/* -------------------- 7. determinism across two runs -------------------- */

const runA = await httpGet(handle.url + 'api/snapshot');
const runB = await httpGet(handle.url + 'api/snapshot');
const strip = s => { const j = JSON.parse(s); delete j.meta.generated; return JSON.stringify(j); };
const same = strip(runA.body) === strip(runB.body);
record('7', 'two collections are deterministic (ignoring meta.generated)', same ? 'PASS' : 'FAIL',
  same ? 'identical' : 'outputs differ');

/* -------------------- 8. parallel load + de-duplication ------------------ */

const before = Date.now();
const responses = await Promise.all(
  Array.from({ length: 20 }, () => httpGet(handle.url).then(r => r.status))
);
const parallelMs = Date.now() - before;
const allOk = responses.every(s => s === 200);
record('7', '20 parallel requests all succeed', allOk ? 'PASS' : 'FAIL',
  `statuses: ${[...new Set(responses)].join(',')}, ${parallelMs}ms total`);
record('7', 'collection count after 20 parallel + 3 earlier requests is small',
  handle.collectCount <= 8 ? 'PASS' : 'FAIL',
  `${handle.collectCount} collection(s) for 23 requests (de-duplicated)`);

/* -------------------- 9. serve the page in a browser --------------------- */

const { pw, openBrowser, closeBrowser, available, prepare } =
  await import(pathToFileURL(path.join(HERE, 'pw.mjs')).href);
let browserRan = false;
if (await available()) {
  browserRan = true;
  await openBrowser();
  try {
    await prepare(handle.url, { width: 1440, height: 900 });
    const f = path.join(ART, 'live-dom.json');
    await pw(['eval', `() => ({
      sections: Array.from(document.querySelectorAll('main section')).map(s => s.getAttribute('aria-labelledby')),
      cards: document.querySelectorAll('#sections [data-open]').length,
      entities: typeof ENTITIES === 'undefined' ? 0 : ENTITIES.length,
      threw: (() => { let t = 0; for (const e of ENTITIES) { try { detail(e.kind, e.id); } catch (_) { t++; } } return t; })(),
      canary: document.documentElement.outerHTML.includes('CANARY'),
    })`, '--filename', f], { allowFail: true });
    let d = null;
    try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* below */ }
    record('7', 'live page renders every section', d && d.sections.length >= 8 ? 'PASS' : 'FAIL',
      d ? `${d.sections.length} sections, ${d.cards} cards, ${d.entities} entities` : 'no eval result');
    record('7', 'live page: no detail() throws', d && d.threw === 0 ? 'PASS' : 'FAIL',
      d ? `${d.threw} threw over ${d.entities} entities` : 'no eval result');

    // Graph view.
    await pw(['eval', `() => { setView('graph'); return 1; }`], { allowFail: true });
    await new Promise(r => setTimeout(r, 800));
    const gf = path.join(ART, 'live-graph.json');
    await pw(['eval', `() => { const s = document.querySelector('section[aria-labelledby="h-graph"] svg'); return s ? { nodes: s.querySelectorAll('.gnode').length, edges: s.querySelectorAll('.gedge').length } : null; }`, '--filename', gf], { allowFail: true });
    let g = null;
    try { g = JSON.parse(fs.readFileSync(gf, 'utf8')); } catch { /* below */ }
    record('7', 'live graph renders nodes and edges', g && g.nodes > 0 && g.edges > 0 ? 'PASS' : 'FAIL',
      g ? `nodes=${g.nodes} edges=${g.edges}` : 'no svg found');

    await pw(['eval', `() => { setView('grid'); return 1; }`], { allowFail: true });
    const shot = path.join(ART, 'live-1440.png');
    await pw(['screenshot', '--full-page', '--filename', shot], { allowFail: true });
    record('7', 'live screenshot saved to a gitignored path', fs.existsSync(shot) ? 'PASS' : 'FAIL',
      path.relative(path.join(HERE, '..'), shot));
  } finally {
    await closeBrowser();
  }
} else {
  record('7', 'browser checks of the live page', 'BLOCKED', 'playwright-cli unavailable');
}

await handle.close();

const pass = results.filter(r => r.status === 'PASS').length;
const fail = results.filter(r => r.status === 'FAIL').length;
const diff = results.filter(r => r.status === 'DIFF').length;
// A BLOCKED check was never evaluated. It must not be allowed to exit 0.
const blocked = results.filter(r => r.status === 'BLOCKED').length;
fs.writeFileSync(path.join(ART, 'results.json'),
  JSON.stringify({ results, pass, fail, diff, blocked, comparisons: cmp }, null, 2));
console.log(`\nSUMMARY  pass=${pass} fail=${fail} diff=${diff} blocked=${blocked}`);
void browserRan;
process.exit(fail || blocked ? 1 : 0);
