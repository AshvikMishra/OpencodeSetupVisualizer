/**
 * Browser check: the served page must actually RENDER.
 *
 * Every previous gate checked status codes and byte counts. None of them loaded
 * the page. This one does, in a real browser, and asserts the things that only
 * exist at runtime: no CSP violations, no console errors, Tailwind/Lucide/fonts
 * applied, and each view openable.
 *
 * Exits non-zero on any failure. Screenshots land in verification/artifacts/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.js';
import { buildFixture, stubExec, cleanup } from '../test/fixtures/fixture.js';
import { available, openBrowser, closeBrowser, prepare, pw } from './pw.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(HERE, 'artifacts');
fs.mkdirSync(ART, { recursive: true });

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` :: ${detail}` : ''}`);
  return ok;
};

/**
 * Pull the JSON object out of a playwright-cli `eval` result.
 *
 * The CLI prints `### Result\n<json>\n### Ran Playwright code\n```js … ```` and
 * that trailing block contains braces of its own, so a greedy regex across the
 * whole output captures too much and JSON.parse fails silently. Slice between
 * the two headers first.
 */
function parseEval(out) {
  const s = String(out);
  const start = s.indexOf('### Result');
  if (start < 0) return {};
  const body = s.slice(start + '### Result'.length).split('### Ran Playwright code')[0];
  const m = body.match(/\{[\s\S]*\}/);
  if (!m) return {};
  try { return JSON.parse(m[0]); } catch { return {}; }
}

if (!(await available())) {
  console.error('FAIL  playwright-cli is not resolvable; the browser checks were NOT run.');
  process.exit(3);
}

const fixture = buildFixture('rich');
const handle = await startServer({
  port: Number(process.argv[2]) || 5151,
  collectOpts: { home: fixture.home, projectDir: fixture.project, deps: stubExec() },
  contents: true,
});

try {
  await openBrowser('about:blank');
  await prepare(handle.url, { settleMs: 4000 });

  // --- console + CSP violations -------------------------------------------
  // Errors and CSP violations are failures. The Tailwind CDN emits a benign
  // "should not be used in production" WARNING; that is a warning, not an
  // error, and is reported separately so it is visible but not fatal.
  const consoleOut = await pw(['console'], { allowFail: true });
  const allLines = String(consoleOut).split('\n').map(l => l.trim()).filter(Boolean);
  const errors = allLines.filter(l => /\[ERROR\]|\bError\b|violat|refused to|blocked by/i.test(l) && !/favicon/i.test(l));
  const warnings = allLines.filter(l => /\[WARNING\]|\bwarn\b/i.test(l));
  record('zero console errors', errors.length === 0,
    errors.length ? errors.slice(0, 6).join(' || ') : `${warnings.length} benign warning(s)`);
  record('zero CSP violations', !/Content Security Policy|violat/i.test(String(consoleOut)),
    'no CSP violation reported');

  // --- the page is not blank ----------------------------------------------
  // `eval` takes a bare function, not an `await page.evaluate(...)` expression.
  const probe = `() => {
    const q = s => document.querySelectorAll(s).length;
    const cs = getComputedStyle(document.body);
    const icon = document.querySelector('svg');
    const util = document.querySelector('.flex, .grid, [class*="gap-"]');
    return {
      textLen: document.body.innerText.trim().length,
      htmlLen: document.body.innerHTML.length,
      fontFamily: cs.fontFamily,
      bg: cs.backgroundColor,
      twDisplay: util ? getComputedStyle(util).display : 'none-found',
      twGap: util ? (getComputedStyle(util).gap || '0px') : 'n/a',
      iconTag: icon ? icon.tagName : null,
      iconCount: q('svg'),
      // A rendered Lucide glyph is an <svg> containing <path>/<line>. Counting
      // bare <svg> tags would also match decorative shapes.
      iconWithPath: q('svg path, svg line, svg circle, svg polyline'),
      lucideDefined: typeof window.lucide,
      tailwindDefined: typeof window.tailwind,
      fontFaces: document.fonts ? document.fonts.size : 0,
      snapshotKeys: (typeof SNAPSHOT !== 'undefined') ? Object.keys(SNAPSHOT).length : -1,
      drawable: q('[data-open], [data-id]'),
    };
  }`;
  const probeOut = await pw(['eval', probe], { allowFail: true });
  const P = parseEval(probeOut);

  record('page is not blank', (P.textLen || 0) > 200 && (P.htmlLen || 0) > 5000,
    `textLen=${P.textLen} htmlLen=${P.htmlLen}`);
  record('SNAPSHOT present in page', P.snapshotKeys > 0, `top-level keys=${P.snapshotKeys}`);
  record('Tailwind utilities applied', !!P.twDisplay && P.twDisplay !== 'none-found' &&
    ['flex', 'grid', 'block', 'inline-flex'].includes(P.twDisplay),
    `display=${P.twDisplay} gap=${P.twGap} tailwindGlobal=${P.tailwindDefined}`);
  // tagName for SVG-namespaced elements is lower-case, so compare case-insensitively.
  record('Lucide icons rendered as SVG',
    (P.iconCount || 0) > 0 && String(P.iconTag || '').toUpperCase() === 'SVG' &&
    (P.iconWithPath || 0) > 0,
    `svgCount=${P.iconCount} withPath=${P.iconWithPath} lucideGlobal=${P.lucideDefined}`);
  record('webfont applied (not the fallback stack)',
    /Fira/i.test(P.fontFamily || ''), `font-family=${P.fontFamily} fontFaces=${P.fontFaces}`);
  record('cards present to interact with', (P.drawable || 0) > 0, `interactive elements=${P.drawable}`);

  const shotGrid = path.join(ART, 'browser-grid.png');
  await pw(['screenshot', '--full-page', '--filename', shotGrid], { allowFail: true });
  record('grid screenshot captured', fs.existsSync(shotGrid) && fs.statSync(shotGrid).size > 1000,
    `${fs.existsSync(shotGrid) ? fs.statSync(shotGrid).size : 0} bytes`);

  // --- graph view ----------------------------------------------------------
  await pw(['click', '#vGraph'], { allowFail: true });
  await new Promise(r => setTimeout(r, 1200));
  const shotGraph = path.join(ART, 'browser-graph.png');
  await pw(['screenshot', '--full-page', '--filename', shotGraph], { allowFail: true });
  record('graph screenshot captured', fs.existsSync(shotGraph) && fs.statSync(shotGraph).size > 1000,
    `${fs.existsSync(shotGraph) ? fs.statSync(shotGraph).size : 0} bytes`);

  // --- back to grid, open a drawer ---------------------------------------
  await pw(['click', '#vGrid'], { allowFail: true });
  await new Promise(r => setTimeout(r, 800));
  const clickOut = await pw(['eval', `() => {
    const el = document.querySelector('[data-open][data-id]') || document.querySelector('[data-id]');
    if (!el) return { clicked: false };
    el.click();
    return { clicked: true, kind: el.dataset.open || 'unknown', id: el.dataset.id || '' };
  }`], { allowFail: true });
  const C = parseEval(clickOut);
  await new Promise(r => setTimeout(r, 1200));
  const drawerState = await pw(['eval', `() => {
    const d = document.querySelector('#drawer, .drawer, [data-drawer]:not([hidden])');
    return {
      found: !!d,
      visible: d ? (getComputedStyle(d).display !== 'none' && d.getBoundingClientRect().height > 40) : false,
      textLen: d ? d.innerText.trim().length : 0,
    };
  }`], { allowFail: true });
  const D = parseEval(drawerState);
  record('a drawer opens', D.visible === true && (D.textLen || 0) > 20,
    `visible=${D.visible} textLen=${D.textLen} clicked=${C.clicked} kind=${C.kind}`);

  const shotDrawer = path.join(ART, 'browser-drawer.png');
  await pw(['screenshot', '--full-page', '--filename', shotDrawer], { allowFail: true });
  record('drawer screenshot captured', fs.existsSync(shotDrawer) && fs.statSync(shotDrawer).size > 1000,
    `${fs.existsSync(shotDrawer) ? fs.statSync(shotDrawer).size : 0} bytes`);

  await closeBrowser();
} finally {
  await handle.close();
  cleanup(fixture);
}

const pass = results.filter(r => r.ok).length;
const fail = results.length - pass;
console.log(`\nSUMMARY  pass=${pass} fail=${fail}`);
console.log(`screenshots: ${['browser-grid', 'browser-graph', 'browser-drawer'].map(n => path.join(ART, n + '.png')).join(', ')}`);
process.exit(fail ? 1 : 0);