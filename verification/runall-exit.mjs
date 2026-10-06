/**
 * Does run-all.mjs exit non-zero when a section fails?
 *
 * A gate that prints "1 section(s) failed" and exits 0 is worse than no gate.
 * This asserts it directly instead of inferring it from a green run.
 *
 * DO NOT add this to run-all.mjs's SECTIONS list: it spawns run-all.mjs, which
 * would recurse forever. Run it standalone via `npm run verify:runall-exit`.
 *
 * Two traps already hit while writing this, both of which made it pass while
 * proving nothing:
 *   - the patched copy must live directly in verification/, because run-all
 *     imports './pw.mjs' relatively and a copy elsewhere exits 1 with
 *     ERR_MODULE_NOT_FOUND — a non-zero exit that looks like propagation.
 *   - the stand-in must be referenced by a RELATIVE name, because run-all does
 *     `path.join(HERE, s.script)` and path.join mangles an absolute second arg.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_ALL = path.join(HERE, 'run-all.mjs');

if (path.basename(process.argv[1] || '') === 'run-all.mjs') {
  console.error('FAIL  runall-exit must not be a run-all section: it would recurse.');
  process.exit(1);
}

const failScript = path.join(HERE, '.runall-exit-fail.mjs');
const patchedPath = path.join(HERE, '.runall-exit-patched.mjs');
const cleanup = () => { for (const f of [failScript, patchedPath]) fs.rmSync(f, { force: true }); };

fs.writeFileSync(failScript,
  "console.log('FAIL  deliberately failing section');\nprocess.exit(1);\n");

const original = fs.readFileSync(RUN_ALL, 'utf8');
const patched = original.replace("script: 'browser.mjs'", "script: '.runall-exit-fail.mjs'");
if (patched === original) {
  console.error('FAIL  could not patch run-all.mjs — the section line moved');
  cleanup();
  process.exit(1);
}
fs.writeFileSync(patchedPath, patched);

const code = await new Promise(resolve => {
  const child = spawn(process.execPath, [patchedPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  child.on('exit', c => resolve({ c, out }));
});

const sawSectionFail = /deliberately failing section/.test(code.out);
const saidFailed = /section\(s\) failed/.test(code.out);
const propagated = code.c !== 0;

console.log(`the failing section actually ran     : ${sawSectionFail}`);
console.log(`run-all said the section failed      : ${saidFailed}`);
console.log(`run-all exit code was non-zero       : ${propagated} (${code.c})`);

const ok = sawSectionFail && saidFailed && propagated;
console.log(ok
  ? '\nPASS  a failing section makes run-all report it AND exit non-zero'
  : '\nFAIL  run-all did not propagate the failure');

cleanup();
process.exit(ok ? 0 : 1);