/**
 * Section 6 — mutation checks: prove the tests can FAIL.
 *
 * Every mutation is applied to a TEMP COPY of the repo. The real source and the
 * template are never touched.
 *
 * For each mutation: run the relevant check against the mutated copy and assert
 * that it reports a failure. A mutation that goes undetected is a hole in the
 * verification, not a pass.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const pexec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const results = [];
const record = (check, status, evidence) => {
  results.push({ check, status, evidence });
  console.log(`${status}  [6] ${check}${evidence ? ` :: ${evidence}` : ''}`);
};

/** Copy the shipped source + tests + template into a temp dir. */
function makeCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovz-mut-'));
  for (const rel of ['package.json', 'src', 'bin', 'test', 'template']) {
    fs.cpSync(path.join(ROOT, rel), path.join(dir, rel), { recursive: true });
  }
  return dir;
}

/**
 * Run node:test in the copy and report pass/fail.
 *
 * `files` selects whole test FILES rather than a name pattern: a pattern that
 * matches nothing exits 0 and would make every mutation look "undetected".
 */
async function runTests(dir, { files = ['test/**/*.test.js'], timeoutMs = 600000 } = {}) {
  const args = ['--test', ...files];
  try {
    const r = await pexec(process.execPath, args, { cwd: dir, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, out: r.stdout };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

/** Assert a mutation is DETECTED: the run must fail, and say why. */
function assertDetected(name, res, expectPattern) {
  if (res.ok) {
    record(`${name} is detected`, 'FAIL', 'tests still passed — this check is not load-bearing');
    return false;
  }
  const matched = expectPattern ? new RegExp(expectPattern, 'i').test(res.out) : true;
  record(`${name} is detected`, matched ? 'PASS' : 'FAIL',
    matched ? `run failed as expected (${(res.out.match(/✖/g) || []).length} failing)` : 'failed, but not for the expected reason');
  return matched;
}

/* ---------------------------------------------------- 1. corrupt the marker */
{
  const dir = makeCopy();
  const tpl = path.join(dir, 'template', 'opencode-dashboard-example.html');
  fs.writeFileSync(tpl, fs.readFileSync(tpl, 'utf8').replace('/* ============================ derived helpers', '/* marker removed'));
  const res = await runTests(dir, { files: ['test/injection.test.js'] });
  assertDetected('corrupted template end marker', res, 'missing the end marker');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ------------------------------------- 2. remove a required schema field */
{
  const dir = makeCopy();
  const f = path.join(dir, 'src', 'collect', 'agents.js');
  let src = fs.readFileSync(f, 'utf8');
  // Drop `deny`, which the template calls with .length / .includes / .join.
  src = src.replace(/deny: permissions\.filter\(p => p\.effect === 'deny'\)\.map\(fmtPerm\),/, 'deny: undefined,');
  fs.writeFileSync(f, src);
  const res = await runTests(dir, { files: ['test/template-contract.test.js'] });
  assertDetected('missing agents[].deny', res, 'deny|throw|must be an array');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ------------------------------------- 2b. an illegal skill scope value */
{
  const dir = makeCopy();
  const f = path.join(dir, 'src', 'collect', 'skills.js');
  let src = fs.readFileSync(f, 'utf8');
  src = src.replace(
    "const scope = VALID_SCOPES.has(scopeFor(raw.path, ctx)) ? scopeFor(raw.path, ctx) : 'local';",
    "const scope = 'globalish';"
  );
  fs.writeFileSync(f, src);
  const res = await runTests(dir, { files: ['test/template-contract.test.js'] });
  assertDetected('illegal skill scope', res, 'illegal skill scope|SCOPE');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ------------------------------------------------ 3. disable the sanitizer */
{
  const dir = makeCopy();
  const f = path.join(dir, 'src', 'sanitize.js');
  let src = fs.readFileSync(f, 'utf8');
  // Make sanitize a pass-through, so every secret flows through untouched.
  src = src.replace('export function sanitize(value, opts = {}) {',
    'export function sanitize(value, opts = {}) {\n  if (value && typeof value === "object") return value; // MUTATION');
  fs.writeFileSync(f, src);
  const res = await runTests(dir, { files: ['test/secrets.test.js'] });
  assertDetected('disabled sanitizer (secrets suite)', res, 'canary|leak|REDACTED|secret');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* --------------------------------- 3b. disable only the body-text redaction */
{
  const dir = makeCopy();
  const f = path.join(dir, 'src', 'sanitize.js');
  let src = fs.readFileSync(f, 'utf8');
  // Remove the branch that re-parses config bodies; pattern detection still runs,
  // so only the structural body check should catch this.
  src = src.replace('      if (isBody) {\n        const redacted = sanitizeBodyText(s, report);', '      if (false) {\n        const redacted = sanitizeBodyText(s, report);');
  fs.writeFileSync(f, src);
  const res = await runTests(dir, { files: ['test/secrets.test.js'] });
  const detected = !res.ok;
  record('disabled config-body redaction (secrets suite)', detected ? 'PASS' : 'FAIL',
    detected ? 'run failed as expected' : 'tests still passed — the structural body check is not load-bearing');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ------------------------------------------ 3c. disable assertClean only */
{
  const dir = makeCopy();
  const f = path.join(dir, 'src', 'sanitize.js');
  let src = fs.readFileSync(f, 'utf8');
  src = src.replace('export function assertClean(snapshot) {', 'export function assertClean(snapshot) {\n  return true; // MUTATION');
  fs.writeFileSync(f, src);
  const res = await runTests(dir, { files: ['test/secrets.test.js'] });
  assertDetected('disabled assertClean', res, 'assertClean aborted');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ------------------------------------------- 4. change one template byte */
{
  const dir = makeCopy();
  const tpl = path.join(dir, 'template', 'opencode-dashboard-example.html');
  const html = fs.readFileSync(tpl, 'utf8');
  fs.writeFileSync(tpl, html.replace('OpenCode Setup', 'OpenCode Setup '));
  const res = await runTests(dir, { files: ['test/template-integrity.test.js'] });
  const hashFail = !res.ok && /template has changed/.test(res.out);
  record('one-byte template change is detected', hashFail ? 'PASS' : 'FAIL',
    hashFail ? 'pinned SHA-256 test failed' : `hash test ${hashFail ? '' : 'did not fail'} (run ok=${res.ok})`);
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ------------------------------- 5. weaken the Host check (server suite) */
{
  const dir = makeCopy();
  const f = path.join(dir, 'src', 'server.js');
  let src = fs.readFileSync(f, 'utf8');
  src = src.replace('  return LOOPBACK_HOSTS.has(hostname);', '  return true; // MUTATION');
  fs.writeFileSync(f, src);
  const res = await runTests(dir, { files: ['test/server.test.js'] });
  assertDetected('permissive Host header check', res, '403|loopback');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* --------------------------- 5b. remove the cross-host target guard */
{
  const dir = makeCopy();
  const f = path.join(dir, 'src', 'server.js');
  let src = fs.readFileSync(f, 'utf8');
  src = src.replace(
    "    if (url.host && !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {\n      return send(403, 'Forbidden: cross-host request target.');\n    }",
    '    // MUTATION: cross-host guard removed'
  );
  fs.writeFileSync(f, src);
  const res = await runTests(dir, { files: ['test/cross-host.test.js'] });
  assertDetected('cross-host request-target guard', res, '403');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ------------------------- 10. re-introduce the AGENTS.md double count */
{
  const dir = makeCopy();
  const f = path.join(dir, 'src', 'collect', 'context-cost.js');
  let src = fs.readFileSync(f, 'utf8');
  src = src.replace(
    "  const isAgentsMd = c => !!agentsMd && c.path === agentsMd.path;\n  const otherConfigs = configs.filter(c => !isAgentsMd(c));",
    '  const otherConfigs = configs; // MUTATION: no exclusion'
  );
  fs.writeFileSync(f, src);
  const res = await runTests(dir, { files: ['test/metrics.test.js'] });
  assertDetected('AGENTS.md double counting', res, 'double-count|must exclude AGENTS');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* --------------------- 11. present the file cap as a measurement again */
{
  const dir = makeCopy();
  const f = path.join(dir, 'src', 'collect', 'context.js');
  let src = fs.readFileSync(f, 'utf8');
  // Revert to the old capped walk that never reported truncation.
  src = src.replace(
    /export function dirSize\(root, \{ maxFiles = 200_000 \} = \{\}\) \{[\s\S]*?\n\}/,
    [
      'export function dirSize(root, { maxFiles = 5000 } = {}) {',
      '  let total = 0;',
      '  let count = 0;',
      '  const walk = dir => {',
      '    for (const ent of readDirSafe(dir)) {',
      '      if (count >= maxFiles) return;',
      '      const full = path.join(dir, ent.name);',
      '      if (ent.isDirectory()) walk(full);',
      '      else if (ent.isFile()) {',
      '        const st = statSafe(full);',
      '        if (st) { total += st.size; count++; }',
      '      }',
      '    }',
      '  };',
      '  if (isDir(root)) walk(root);',
      '  return { bytes: total, files: count, truncated: false }; // MUTATION',
      '}',
    ].join('\n')
  );
  fs.writeFileSync(f, src);
  const res = await runTests(dir, { files: ['test/metrics.test.js'] });
  assertDetected('dirSize truncation flag removed', res, 'truncat');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* --------------------- 12. mislabel bookkeeping keys as credentials */
{
  const dir = makeCopy();
  const f = path.join(dir, 'src', 'collect', 'configs.js');
  let src = fs.readFileSync(f, 'utf8');
  src = src.replace(
    'const credentialKeys = keys.filter(k => !BOOKKEEPING_KEYS.has(k.toLowerCase()));',
    'const credentialKeys = keys; // MUTATION: call everything a credential'
  );
  fs.writeFileSync(f, src);
  const res = await runTests(dir, { files: ['test/credentials.test.js'] });
  assertDetected('bookkeeping keys counted as credentials', res, 'pid|credential key');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* --------------------- 13. restore the mojibake frontmatter regex */
{
  const dir = makeCopy();
  const f = path.join(dir, 'src', 'collect', 'skills.js');
  let src = fs.readFileSync(f, 'utf8');
  // A regex that can never match: every skill loses its frontmatter.
  src = src.replace(/const m = \/\^.*\?---\\r\?\\n.*\.exec\(text\);/,
    "  const m = /^\\u00EF\\u00BB\\u00BF?---\\r?\\n([\\s\\S]*?)\\r?\\n---/.exec(text);");
  fs.writeFileSync(f, src);
  const res = await runTests(dir, { files: ['test/skills.test.js'] });
  assertDetected('mojibake frontmatter regex', res, 'hadFrontmatter|frontmatter');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ------------------- 14. drop the numeric-secret redaction again */
{
  const dir = makeCopy();
  const f = path.join(dir, 'src', 'sanitize.js');
  let src = fs.readFileSync(f, 'utf8');
  src = src.replace('      if (k && k !== ' + "'proto'" + ') return REDACTED;', '      return node; // MUTATION');
  fs.writeFileSync(f, src);
  const res = await runTests(dir, { files: ['test/sanitizer-bypass.test.js'] });
  assertDetected('numeric secrets left unredacted', res, 'numeric secret|pin|otp');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ------------- 15. revert the JSONC body redaction to raw JSON.parse */
{
  const dir = makeCopy();
  const f = path.join(dir, 'src', 'sanitize.js');
  let src = fs.readFileSync(f, 'utf8');
  src = src.replace('parsed = parseJsonc(normalizeQuotes(text));', 'parsed = JSON.parse(text); // MUTATION');
  fs.writeFileSync(f, src);
  const res = await runTests(dir, { files: ['test/sanitizer-bypass.test.js'] });
  assertDetected('JSONC bodies skip structural redaction', res, 'leaked|comments|trailing');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ------------------- 16. drop the USER_DIR_RES iteration fix */
{
  const dir = makeCopy();
  const f = path.join(dir, 'src', 'sanitize.js');
  let src = fs.readFileSync(f, 'utf8');
  // Passing the array to replace() coerces it to a literal and never matches.
  src = src.replace(/for \(const re of USER_DIR_RES\) \{[\s\S]*?\n  \}/, '  // MUTATION');
  fs.writeFileSync(f, src);
  const res = await runTests(dir, { files: ['test/sanitizer-bypass.test.js'] });
  assertDetected('user paths stop being normalised', res, 'username|normalis|leaked');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* --------------- 17. make the server crash on a malformed URL again */
{
  const dir = makeCopy();
  const f = path.join(dir, 'src', 'server.js');
  let src = fs.readFileSync(f, 'utf8');
  // Must consume the whole `catch` block. An earlier version stopped at the first
  // `\n    }`, which is `} catch {`, leaving a dangling catch clause — so the
  // mutation produced a SYNTAX error rather than the runtime crash it was
  // meant to simulate, and the check passed for the wrong reason.
  src = src.replace(
    /let url, pathname;\n    try \{[\s\S]*?\n    \} catch \{[\s\S]*?\n    \}/,
    "  const url = new URL(req.url || '/', \`http://\${req.headers.host}\`);\n    const pathname = decodeURIComponent(url.pathname);"
  );
  if (src.includes('let url, pathname')) {
    console.log('  MUTATION DID NOT LAND — the try/catch pattern has drifted');
  }
  fs.writeFileSync(f, src);
  const res = await runTests(dir, { files: ['test/server-hardening.test.js'] });
  // The un-guarded version throws URIError / TypeError out of the request
  // handler and takes the process down.
  assertDetected('server crashes on a malformed request', res,
    'URIError|TypeError|Invalid URL|cannot be reached|not defined');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* --------------- 18. remove the CSP from every response */
{
  const dir = makeCopy();
  const f = path.join(dir, 'src', 'server.js');
  let src = fs.readFileSync(f, 'utf8');
  // Anchored on the start of the header and the whole terminating line, so it
// survives a change in quote nesting. An earlier version matched on
// `frame-ancestors 'none",` which does not exist — the value ends `'none'",`
  // — so the mutation silently never fired and the check was vacuous.
  src = src.replace(/'Content-Security-Policy':[\s\S]*?frame-ancestors[^\n]*/, '// MUTATION');
  if (src.includes('Content-Security-Policy')) {
    console.log('  MUTATION DID NOT LAND — CSP header pattern has drifted');
  }
  fs.writeFileSync(f, src);
  const res = await runTests(dir, { files: ['test/server-hardening.test.js'] });
  assertDetected('CSP removed from responses', res, 'CSP|content-security-policy');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* --------- 19. stop excluding AGENTS.md from the config aggregate */
{
  const dir = makeCopy();
  const f = path.join(dir, 'src', 'collect', 'context-cost.js');
  let src = fs.readFileSync(f, 'utf8');
  src = src.replace('const otherConfigs = configs.filter(c => !isAgentsMd(c));', 'const otherConfigs = configs; // MUTATION');
  fs.writeFileSync(f, src);
  const res = await runTests(dir, { files: ['test/metrics.test.js'] });
  assertDetected('AGENTS.md counted twice again', res, 'double-count|must exclude AGENTS');
  fs.rmSync(dir, { recursive: true, force: true });
}
/* ---------------------------------- 6. remove the concurrent de-dup guard */
{
  const dir = makeCopy();
  const f = path.join(dir, 'src', 'server.js');
  let src = fs.readFileSync(f, 'utf8');
  src = src.replace('    if (inflight) return inflight;', '    // MUTATION: no de-dup');
  fs.writeFileSync(f, src);
  const res = await runTests(dir, { files: ['test/server.test.js'] });
  assertDetected('removed request de-duplication', res, 'exactly 1 collection');
  fs.rmSync(dir, { recursive: true, force: true });
}

const pass = results.filter(r => r.status === 'PASS').length;
const fail = results.filter(r => r.status === 'FAIL').length;
fs.writeFileSync(path.join(HERE, 'artifacts', 'mutations.json'), JSON.stringify({ results, pass, fail }, null, 2));
console.log(`\nSUMMARY  pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
