/**
 * Mutation harness for the share payload.
 *
 * Purpose: prove test/share.test.js would FAIL if the Share button regressed
 * to copying a single config file. A guard that has never been challenged is
 * not a guard — an earlier attempt at this file re-wrote the CORRECT
 * implementation and "passed", proving nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);
const ROOT = process.cwd();
const TPL = path.join(ROOT, 'template', 'opencode-dashboard-example.html');

const MUTATIONS = [
  {
    name: 'payload is one config file again (not the snapshot)',
    mustFail: true,
    apply: t => t.replace(
      'json = JSON.stringify(SNAPSHOT, null, 2);',
      "json = ((SNAPSHOT.configs || []).find(x => /opencode\\.json/.test(x.name || '')) || {}).body || '';"
    ),
    expect: /is the entire snapshot|far bigger than a single config|carries the inventory|a real setup, not a single file/,
  },
  {
    name: 'prompt reverts to single-config-file advice',
    mustFail: true,
    apply: t => t.replace(
      'Here is a real, working OpenCode setup, captured from a live machine.',
      'Reproduce this OpenCode configuration on another machine.'
    ),
    expect: /asks for a setup like this one/,
  },
  {
    name: '--no-contents is refused instead of labelled partial',
    mustFail: true,
    apply: t => t.replace(
      'const partial = bodiesHidden();',
      "if (bodiesHidden()) return { ok:false, why:'captured with --no-contents' };\n  const partial = false;"
    ),
    expect: /allowed and labelled partial/,
  },
  {
    name: 'privacy line stops naming the inventory',
    mustFail: true,
    // Remove the WHOLE disclosure sentence. An earlier version replaced only
    // its opening clause, leaving "skill names … git URLs … model IDs … token
    // costs" in place, so every assertion still matched and the mutation was
    // invisible — a no-op mutation that reported nothing.
    apply: t => t.replace(
      /This is the whole snapshot,[\s\S]*?token costs\./,
      'It is safe to share.'
    ),
    expect: /names what the snapshot actually leaks/,
  },
];

const original = fs.readFileSync(TPL, 'utf8');
let detected = 0;
let applicable = 0;

for (const m of MUTATIONS) {
  const mutated = m.apply(original);
  if (mutated === original) {
    console.log(`SKIP    ${m.name} :: mutation did not land (anchor drifted)`);
    continue;
  }
  if (!m.expect) {
    console.log(`RECORD  ${m.name} :: lands, but no unit test covers it (browser gate does)`);
    continue;
  }
  applicable++;
  fs.writeFileSync(TPL, mutated);
  let out = '';
  try {
    const r = await pexec(process.execPath, ['--test', 'test/share.test.js'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 300000 });
    out = r.stdout;
  } catch (e) {
    out = `${e.stdout || ''}${e.stderr || ''}`;
  }
  fs.writeFileSync(TPL, original);

  const failedNames = [...out.matchAll(/✖ ([^\n(]+)/g)].map(x => x[1].trim());
  const hit = failedNames.some(n => m.expect.test(n));
  if (hit) {
    detected++;
    console.log(`PASS    ${m.name} :: detected in "${failedNames[0]}"`);
  } else {
    console.log(`FAIL    ${m.name} :: tests did not flag it (failed: ${failedNames.join(', ') || 'none'})`);
  }
}

console.log(`\nSUMMARY  detected=${detected}/${applicable} applicable mutations`);
process.exit(detected === applicable && applicable > 0 ? 0 : 1);