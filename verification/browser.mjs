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
 * Pull the result out of a playwright-cli `eval`.
 *
 * The CLI prints `### Result\n<json>\n### Ran Playwright code\n```js … ```` and
 * that trailing block contains braces of its own, so a greedy regex across the
 * whole output captures too much and JSON.parse fails silently. Slice between
 * the two headers first.
 *
 * Handles scalars too: an expression returning `true` has no braces, and
 * falling back to `{}` would silently turn a passing check into a failure.
 */
function parseEval(out) {
  const s = String(out);
  const start = s.indexOf('### Result');
  if (start < 0) return {};
  const body = s.slice(start + '### Result'.length).split('### Ran Playwright code')[0].trim();
  if (!body) return {};
  // Preferred: the whole result is valid JSON — covers objects, arrays, scalars.
  try { return JSON.parse(body); } catch { /* fall through to brace extraction */ }
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

  /* ==================== header controls: Reset + Share ==================== */
  const controls = parseEval(await pw(['eval', `() => {
    const share = document.getElementById('btnShare');
    const reset = document.getElementById('btnRefresh');
    // Where a control lives is a layout preference another session may change,
    // so assert that both EXIST and are enabled, and report position as info.
    const row = el => el ? (el.closest('#filters') ? 'filter-bar'
      : el.closest('header') ? 'header-top-right' : 'elsewhere') : 'absent';
    return {
      shareExists: !!share,
      shareDisabled: share ? share.disabled : null,
      shareRow: row(share),
      resetExists: !!reset,
      resetDisabled: reset ? reset.disabled : null,
      resetRow: row(reset),
      scopeButtons: document.querySelectorAll('[data-scope]').length,
    };
  }`], { allowFail: true }));

  record('Share is present and enabled',
    controls.shareExists === true && controls.shareDisabled === false,
    `exists=${controls.shareExists} disabled=${controls.shareDisabled} row=${controls.shareRow}`);
  record('Reset is present and enabled',
    controls.resetExists === true && controls.resetDisabled === false,
    `exists=${controls.resetExists} disabled=${controls.resetDisabled} row=${controls.resetRow} (scopes=${controls.scopeButtons})`);

  // A moved button can look identical in a screenshot while being dead, so
  // prove it still works: press a filter, then Reset.
  const flow = parseEval(await pw(['eval', `() => {
    const count = () => document.querySelectorAll(
      '[data-filter][aria-pressed="true"],[data-scope][aria-pressed="true"]').length;
    document.querySelector('[data-filter]').click();
    const afterFilter = count();
    document.getElementById('btnRefresh').click();
    return { afterFilter, afterReset: count() };
  }`], { allowFail: true }));
  record('Reset still clears filters from its new position',
    flow.afterFilter > 0 && flow.afterReset === 0,
    `pressed ${flow.afterFilter} -> ${flow.afterReset}`);

  /* ================= the share sheet shares the WHOLE snapshot ============= */
  // Click via the DOM, not a synthetic pointer event: playwright's click can
  // land on an overlaying element, and a modal that silently fails to open is
  // exactly the failure this check exists to catch.
  const opened = parseEval(await pw(['eval', `() => {
    try {
      document.getElementById('btnShare').click();
      const m = document.getElementById('shareModal');
      const dis = id => { const e = document.getElementById(id); return !!(e && e.disabled); };
      return {
        threw: false,
        open: m ? m.classList.contains('open') : false,
        jsonBtn: !!document.getElementById('shareJson'),
        promptBtn: !!document.getElementById('sharePrompt'),
        downloadBtn: !!document.getElementById('shareDownload'),
        anyDisabled: dis('shareJson') || dis('sharePrompt') || dis('shareDownload'),
        src: (document.getElementById('shareSrc') || {}).textContent || '',
      };
    } catch (e) { return { threw: true, err: String(e && e.message) }; }
  }`], { allowFail: true }));
  await new Promise(r => setTimeout(r, 500));
  record('Share opens a sheet with three enabled options',
    opened.threw === false && opened.open === true && opened.jsonBtn && opened.promptBtn &&
    opened.downloadBtn && opened.anyDisabled === false,
    `open=${opened.open} json=${opened.jsonBtn} prompt=${opened.promptBtn} download=${opened.downloadBtn} anyDisabled=${opened.anyDisabled} src="${opened.src}"${opened.err ? ' err=' + opened.err : ''}`);

  // The regression that motivated this: the payload used to be ONE config
  // file's body (139 bytes). Assert it is the entire snapshot instead.
  const payload = parseEval(await pw(['eval', `() => {
    const p = sharePayload();
    if (!p.ok) return { ok: false, why: p.why };
    const round = JSON.parse(p.json);
    const sameKeys = JSON.stringify(Object.keys(round).sort())
                  === JSON.stringify(Object.keys(SNAPSHOT).sort());
    const deepEqual = sameKeys && JSON.stringify(round) === JSON.stringify(SNAPSHOT);
    return {
      ok: true, bytes: p.bytes, kb: p.kb, partial: p.partial, counts: p.counts,
      sameKeys, deepEqual,
      topLevelKeys: Object.keys(round).length,
      agents: (round.agents || []).length,
      skills: (round.skills || []).length,
      providers: (round.providers || []).length,
      configs: (round.configs || []).length,
      hasContext: !!round.context,
    };
  }`], { allowFail: true }));
  record('the share payload IS the whole snapshot, byte-for-byte',
    payload.ok === true && payload.deepEqual === true && payload.topLevelKeys > 2,
    `bytes=${payload.bytes} deepEqual=${payload.deepEqual} topLevelKeys=${payload.topLevelKeys}`);
  record('the payload carries the inventory, not just config bodies',
    payload.agents > 0 && payload.skills > 0 && payload.providers > 0 && payload.hasContext === true,
    `agents=${payload.agents} skills=${payload.skills} providers=${payload.providers} configs=${payload.configs} context=${payload.hasContext}`);
  record('the payload is a real setup, not a single file',
    payload.bytes > 5000, `${payload.bytes} bytes (${payload.kb} KB)`);

  const dl = parseEval(await pw(['eval',
    '() => { try { return { ok: downloadSnapshot() }; } catch (e) { return { ok: false, err: String(e && e.message) }; } }'],
    { allowFail: true }));
  record('the download handler produces a snapshot file', dl.ok === true,
    dl.ok === true ? 'downloadSnapshot() returned true' : `err=${dl.err}`);

  const prompt = parseEval(await pw(['eval', `() => {
    const p = sharePayload();
    if (!p.ok) return { ok: false };
    const t = sharePromptText(p);
    return {
      ok: true, len: t.length,
      mentionsSnapshot: /snapshot/i.test(t),
      hasJson: t.indexOf('\`\`\`json') >= 0,
      listsCounts: /agent\\(s\\)/.test(t),
      forbidsInventing: /absent/i.test(t),
      oldSingleFileAdvice: /Write the JSON below to/.test(t),
    };
  }`], { allowFail: true }));
  record('the prompt asks for a setup like this one, not one config file',
    prompt.ok === true && prompt.mentionsSnapshot === true && prompt.hasJson === true &&
    prompt.listsCounts === true && prompt.forbidsInventing === true &&
    prompt.oldSingleFileAdvice === false,
    `len=${prompt.len} snapshot=${prompt.mentionsSnapshot} counts=${prompt.listsCounts} noInvent=${prompt.forbidsInventing} oldAdvice=${prompt.oldSingleFileAdvice}`);

  const shotShare = path.join(ART, 'browser-share.png');
  await pw(['screenshot', '--filename', shotShare], { allowFail: true });
  record('share sheet screenshot captured',
    fs.existsSync(shotShare) && fs.statSync(shotShare).size > 1000,
    `${fs.existsSync(shotShare) ? fs.statSync(shotShare).size : 0} bytes`);
  await pw(['click', '#shareClose'], { allowFail: true });
  const closed = parseEval(await pw(['eval',
    "() => !document.getElementById('shareModal').classList.contains('open')"],
    { allowFail: true }));
  record('the share sheet closes again', closed === true, `closed=${closed}`);

  await closeBrowser();
} finally {
  await handle.close();
  cleanup(fixture);
}

const pass = results.filter(r => r.ok).length;
const fail = results.length - pass;
console.log(`\nSUMMARY  pass=${pass} fail=${fail}`);
console.log(`screenshots: ${['browser-grid', 'browser-graph', 'browser-drawer', 'browser-share'].map(n => path.join(ART, n + '.png')).join(', ')}`);
process.exit(fail ? 1 : 0);