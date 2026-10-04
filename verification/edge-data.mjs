/**
 * Section 4 — edge-case data, in a real browser.
 *
 * (a) EMPTY setup          — nothing on disk, CLI reports nothing
 * (b) PARTIAL FAILURE      — CLI missing, one malformed JSON, one command timing out
 * (c) HUGE setup           — ~500 skills, ~200 models
 *
 * For each: no page errors, sections degrade to honest empty/unavailable text,
 * and nothing renders as a blank page. Also records timing for (c).
 *
 * Usage: node verification/edge-data.mjs <port>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildFixture, stubExec } from '../test/fixtures/fixture.js';
import { startServer } from '../src/server.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(HERE, 'artifacts', 'edge');
fs.mkdirSync(ART, { recursive: true });

const { pw, openBrowser, closeBrowser, available, prepare, consoleMessages } =
  await import(pathToFileURL(path.join(HERE, 'pw.mjs')).href);

const PORT = Number(process.argv[2]) || 4800;
const results = [];
const record = (section, check, status, evidence) => {
  results.push({ section, check, status, evidence });
  console.log(`${status}  [${section}] ${check}${evidence ? ` :: ${evidence}` : ''}`);
};

if (!(await available())) {
  console.log('BLOCKED  playwright-cli unavailable');
  process.exit(3);
}

let seq = 0;
async function ev(fn) {
  const file = path.join(ART, `eval-${String(seq++).padStart(3, '0')}.json`);
  try { fs.unlinkSync(file); } catch { /* first use */ }
  await pw(['eval', fn, '--filename', file], { allowFail: true });
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return { __noResult: true }; }
}

await openBrowser();

/** Boot one profile and assert the universal invariants. */
async function checkProfile(name, label, collectOpts) {
  const t0 = Date.now();
  const handle = await startServer({ port: PORT, collectOpts, contents: true });
  const serverUp = Date.now() - t0;

  const tCollect = Date.now();
  const res = await fetch(handle.url + 'api/snapshot');
  const collectMs = Date.now() - tCollect;

  await prepare(handle.url, { width: 1440, height: 900 });

  const msgs = await consoleMessages();
  // Separate product errors from template-CDN resource failures. The template
  // loads Tailwind, Lucide and Google Fonts from CDNs, so a flaky network
  // produces console errors that have nothing to do with the injected data.
  const allErrs = msgs.filter(l => /\[error\]|\berror\b/i.test(l) && !/favicon/i.test(l));
  const CDN = /tailwindcss\.com|unpkg\.com|googleapis\.com|gstatic\.com/i;
  const cdnErrs = allErrs.filter(l => CDN.test(l));
  const pageErrs = allErrs.filter(l => !CDN.test(l));

  const page = await ev(`() => {
    const sections = Array.from(document.querySelectorAll('main section')).map(s => s.getAttribute('aria-labelledby'));
    const text = document.body.textContent || '';
    const emptyVisible = !document.getElementById('empty').hidden;
    const cards = document.querySelectorAll('#sections [data-open]').length;
    // Every drawer must be callable without throwing.
    let threw = 0;
    for (const e of ENTITIES) { try { detail(e.kind, e.id); } catch (_) { threw++; } }
    const ov = {};
    for (const b of document.querySelectorAll('section[aria-labelledby="h-over"] button.card[data-open="metric"]')) {
      const spans = Array.from(b.querySelectorAll('span'));
      ov[b.getAttribute('data-id')] = (spans.find(s => s.className.includes('tnum')) || {}).textContent || '';
    }
    return {
      sections, cards, threw, ov,
      textLen: text.length,
      blank: text.trim().length === 0,
      saysUnavailable: /unavailable|could not be read|no longer|not found|timed out|incomplete/i.test(text),
      hasProvidersNote: /No provider discovered|unavailable/i.test(text),
      entityCount: ENTITIES.length,
    };
  }`);

  const shot = path.join(ART, `${name}.png`);
  await pw(['screenshot', '--full-page', '--filename', shot], { allowFail: true });

  record(label, 'page is not blank', page && !page.blank ? 'PASS' : 'FAIL',
    `body text ${page?.textLen} chars, sections=${page?.sections?.length}`);
  record(label, 'zero page errors (excluding template CDN fetches)',
    pageErrs.length === 0 ? 'PASS' : 'FAIL',
    pageErrs.length === 0 ? 'clean' : pageErrs.slice(0, 2).join(' | '));
  if (cdnErrs.length) {
    record(label, 'template CDN fetches (informational)', 'CDN',
      `${cdnErrs.length} resource error(s) from the template's own CDN tags — network flakiness, not the tool`);
  }
  record(label, 'no detail() call throws', page?.threw === 0 ? 'PASS' : 'FAIL',
    `${page?.threw} threw over ${page?.entityCount} entities`);
  record(label, 'at least one section renders', (page?.sections?.length || 0) > 0 ? 'PASS' : 'FAIL',
    `sections: ${(page?.sections || []).join(', ')}`);

  if (name === 'empty' || name === 'partial') {
    record(label, 'degrades with explicit unavailable/empty wording',
      page?.saysUnavailable === true ? 'PASS' : 'FAIL',
      `match=${page?.saysUnavailable}`);
  }

  await handle.close();
  return { serverUp, collectMs, page };
}

try {
  /* -------------------------------------------------- (a) EMPTY setup */
  const emptyFx = buildFixture('empty');
  const emptyDeps = stubExec({
    failCli: true,
    skills: [],
  });
  const emptyRes = await checkProfile('empty', '4a empty setup', {
    home: emptyFx.home, projectDir: emptyFx.project, deps: emptyDeps,
  });
  console.log(`      (empty: ${emptyRes.page.entityCount} entities, collect ${emptyRes.collectMs}ms)`);

  /* ------------------------------------------- (b) PARTIAL FAILURE setup */
  const partFx = buildFixture('rich');
  // CLI missing entirely for some commands, timing out for others, plus the
  // fixture's already-malformed tui.json.
  const partDeps = stubExec({ timeoutOn: new Set(['agent', 'models', 'pluginList']) });
  const partialRes = await checkProfile('partial', '4b partial failure', {
    home: partFx.home, projectDir: partFx.project, deps: partDeps,
  });
  console.log(`      (partial: ${partialRes.page.entityCount} entities, collect ${partialRes.collectMs}ms)`);

  // A truly absent CLI.
  const goneFx = buildFixture('rich');
  const goneRes = await checkProfile('nocli', '4b no CLI at all', {
    home: goneFx.home, projectDir: goneFx.project, deps: stubExec({ failCli: true }),
  });
  console.log(`      (no CLI: ${goneRes.page.entityCount} entities, collect ${goneRes.collectMs}ms)`);

  /* ---------------------------------------------------- (c) HUGE setup */
  const hugeFx = buildFixture('huge', { hugeSkills: 500 });
  const skills = Array.from({ length: 500 }, (_, i) => ({
    id: `bulk-${i}`, name: `bulk-${i}`, description: `Bulk skill ${i}.`,
    path: `/cache/opencode/npm/git-superpowers-abc123/1790711835417/node_modules/superpowers/skills/bulk-${i}/SKILL.md`,
    content: `---\nname: bulk-${i}\ndescription: Bulk skill ${i}.\n---\nBody ${i}.\n`,
  }));
  const hugeDeps = stubExec({ skills, modelCount: 200 });
  const hugeRes = await checkProfile('huge', '4c huge setup (500 skills / 200 models)', {
    home: hugeFx.home, projectDir: hugeFx.project, deps: hugeDeps,
  });
  const ov = hugeRes.page.ov || {};
  record('4c', 'huge setup reports 500 skills and 200 models',
    ov.skills === '500' && ov.models === '200' ? 'PASS' : 'FAIL',
    `skills=${ov.skills} models=${ov.models}`);
  record('4c', 'huge setup renders in reasonable time',
    hugeRes.collectMs < 30000 ? 'PASS' : 'FAIL',
    `collect=${hugeRes.collectMs}ms, entities=${hugeRes.page.entityCount}, cards=${hugeRes.page.cards}`);
  console.log(`      (huge: collect ${hugeRes.collectMs}ms, ${hugeRes.page.entityCount} entities, ${hugeRes.page.cards} cards)`);
} finally {
  await closeBrowser();
}

const pass = results.filter(r => r.status === 'PASS').length;
const fail = results.filter(r => r.status === 'FAIL').length;
fs.writeFileSync(path.join(ART, 'results.json'), JSON.stringify({ results, pass, fail }, null, 2));
console.log(`\nSUMMARY  pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
