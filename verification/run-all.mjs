/**
 * Reruns the automated parts of verification: sections 2, 3 and 5.
 *
 * Sections that need a judgment call (mutations, live run, packaging) have their
 * own scripts and are listed below for reference.
 *
 * A section that cannot run is a FAILURE, never a skip. A gate that inspects
 * nothing proves nothing, and an unavailable browser means the browser checks
 * never happened — so this exits non-zero rather than reporting success.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const ART = path.join(HERE, 'artifacts');
fs.mkdirSync(ART, { recursive: true });

const { available } = await import(pathToFileURL(path.join(HERE, 'pw.mjs')).href);

const SECTIONS = [
  { name: '1. real-browser render (CSP, Tailwind, Lucide, fonts, views)', script: 'browser.mjs', port: 5100 },
  { name: '2. template parity', script: 'parity.mjs', port: 5101 },
  { name: '3. functional (fixture)', script: 'functional.mjs', port: 5102 },
  { name: '4. edge-case data', script: 'edge-data.mjs', port: 5103 },
  { name: '5. privacy', script: 'privacy.mjs', port: 5104 },
  { name: '5. HTTP behaviour + network posture', script: 'http-security.mjs', port: 5105 },
];

if (!(await available())) {
  console.error(
    'FAIL  playwright-cli is not resolvable on this machine, so every browser\n' +
    '      check in this run was NOT PERFORMED. A gate that inspects nothing is\n' +
    '      not a pass.\n' +
    '      Fix: npm i -g @playwright/cli  (then re-run)\n' +
    '      Section scripts: parity.mjs, functional.mjs, edge-data.mjs,\n' +
    '                    privacy.mjs, http-security.mjs, live.mjs'
  );
  process.exit(3);
}

const only = process.argv[2]; // optional section filter
let failed = 0;
let notRun = 0;
let skipped = 0;

for (const s of SECTIONS) {
  if (only && !s.name.includes(only)) { skipped++; continue; }
  console.log(`\n${'='.repeat(72)}\n== ${s.name}\n${'='.repeat(72)}`);
  const code = await new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(HERE, s.script), String(s.port)], {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, NO_COLOR: '1' },
    });
    child.on('exit', c => resolve(c ?? 1));
  });
  // Exit 3 from a section means "could not run". That is a failure here, not a
  // skip: the section's assertions were never evaluated.
  if (code !== 0) {
    failed++;
    if (code === 3) notRun++;
  }
}

console.log(`\n${'='.repeat(72)}`);
if (failed === 0) {
  console.log(`ALL AUTOMATED VERIFICATION SECTIONS PASSED${skipped ? ` (${skipped} not selected by filter)` : ''}`);
} else {
  console.log(`${failed} section(s) failed` +
    (notRun ? `, of which ${notRun} could not run at all (blocked)` : '') +
    ' — see the output above.');
}
console.log('Not covered by `npm run verify` (need a judgment call):');
console.log('  verify:mutations  — proves the test suite can fail');
console.log('  verify:live       — read-only run against the real install');
console.log('  verify:packaging  — npm pack, install the tarball, npm test x3');
console.log(`${'='.repeat(72)}`);
process.exit(failed ? 1 : 0);
