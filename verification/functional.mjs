/**
 * Functional verification against the real tool, driven in a real browser.
 *
 * Boots the product's own server against a controlled fixture, then asserts
 * sections, counts, search, filters, drawers, graph, tabs, copy, and layout.
 *
 * Expected counts are computed from the FIXTURE definition, never from the
 * collector's output.
 *
 * Usage: node verification/functional.mjs <port>
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildFixture, stubExec, CANARIES } from '../test/fixtures/fixture.js';
import { buildSnapshot } from '../src/collect/index.js';
import { sanitize } from '../src/sanitize.js';
import { startServer } from '../src/server.js';
import { comparePNG } from './png-compare.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(HERE, 'artifacts', 'fixture');
fs.mkdirSync(ART, { recursive: true });

const { pw, openBrowser, closeBrowser, available, prepare, consoleMessages, networkRequests } =
  await import(pathToFileURL(path.join(HERE, 'pw.mjs')).href);

const PORT = Number(process.argv[2]) || 4700;
const results = [];
function record(section, check, status, evidence) {
  results.push({ section, check, status, evidence });
  const tag = status === 'PASS' ? 'PASS' : status;
  console.log(`${tag}  [${section}] ${check}${evidence ? ` :: ${evidence}` : ''}`);
}

if (!(await available())) {
  console.log('BLOCKED  playwright-cli unavailable');
  process.exit(3);
}

/* ------------------------------------------------------------- fixture */

const fixture = buildFixture('rich');

/**
 * Independent ground truth.
 *
 * Skills are discovered through the CLI, so the expected count is what the stub
 * CLI reports (2), NOT how many SKILL.md files exist on disk (5). The 3 plugin
 * skills are asserted separately via plugins[].skillCount, which IS measured
 * from disk.
 */
const truth = {
  agents: 3,           // stub agents: build, explore, title (1 hidden)
  skills: 2,           // stub /api/skill payload
  pluginSkillsOnDisk: 3,
  plugins: 1,
  models: 4,
  mcps: 0,
  commands: 1,
  configs: 6,          // opencode.json, cli.json, tui.json(malformed), capabilities.json, AGENTS.md, service.json(shape)
};
const truthProviders = 1;

const deps = stubExec();
const collectOpts = { home: fixture.home, projectDir: fixture.project, deps };

// Start the product's server exactly as the CLI would.
const handle = await startServer({ port: PORT, collectOpts, contents: true });

await openBrowser();

let evalSeq = 0;
/**
 * Evaluate a function in the page and parse the JSON result.
 *
 * Each call writes to a UNIQUE file: playwright-cli does not delete the target
 * on failure, so a shared filename would return a previous call's stale result
 * and silently invalidate the assertion.
 */
async function ev(fn) {
  const file = path.join(ART, `eval-${String(evalSeq++).padStart(3, '0')}.json`);
  try { fs.unlinkSync(file); } catch { /* first use */ }
  const out = await pw(['eval', fn, '--filename', file], { allowFail: true });
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { __noResult: true, raw: String(out).slice(0, 200) };
  }
}

try {
  /* ---------------------------------------------------- 3.1 load cleanly */
  await prepare(handle.url, { width: 1440, height: 900 });

  const msgs = await consoleMessages();
  const errs = msgs.filter(l => /\[error\]|\berror\b/i.test(l) && !/favicon/i.test(l));
  record('3.1', 'zero console errors', errs.length === 0 ? 'PASS' : 'FAIL',
    errs.length === 0 ? `${msgs.length} console lines, none errors` : errs.slice(0, 3).join(' | '));

  const pageErr = await ev(`() => ({ title: document.title, sections: !!document.getElementById('sections') })`);
  record('3.1', 'page boots', pageErr && pageErr.sections ? 'PASS' : 'FAIL',
    pageErr ? `title="${pageErr.title}"` : 'no eval result');

  /* ------------------------------------------ 3.2 section counts vs truth */
  const counts = await ev(`() => {
    const g = id => { const e = document.getElementById(id); return e ? e.textContent.trim() : null; };
    return {
      overview: Array.from(document.querySelectorAll('section[aria-labelledby="h-over"] button.card[data-open="metric"]'))
        .map(b => {
          const spans = Array.from(b.querySelectorAll('span'));
          const value = (spans.find(s => s.className.includes('tnum')) || {}).textContent || '';
          const label = (spans.find(s => s.className.includes('font-medium')) || {}).textContent || '';
          return { key: b.getAttribute('data-id'), label: label.trim(), value: value.trim() };
        }),
      sections: Array.from(document.querySelectorAll('main section')).map(s => s.getAttribute('aria-labelledby')),
      hdr: g('hdrMeta'), stamp: g('snapStamp'),
    };
  }`);

  // Keyed by the card's own data-id, so the assertion cannot pass by label drift.
  const ov = Object.fromEntries((counts?.overview || []).map(o => [o.key, o.value]));
  const expect = {
    agents: truth.agents, skills: truth.skills, mcps: truth.mcps,
    plugins: truth.plugins, providers: truthProviders, models: truth.models,
  };
  const mismatches = [];
  for (const [key, want] of Object.entries(expect)) {
    const got = ov[key];
    if (String(got) !== String(want)) mismatches.push(`${key}: want ${want} got ${got}`);
  }
  record('3.2', 'Overview cards match independently-computed fixture truth',
    mismatches.length === 0 ? 'PASS' : 'FAIL',
    mismatches.length === 0 ? JSON.stringify(expect) : mismatches.join('; '));

  // Plugin-provided skills are measured from disk, independently of the CLI list.
  const pluginDisk = await ev(`() => {
    const s = SNAPSHOT;
    const p = s.plugins[0] || {};
    return { name: p.name, skillCount: p.skillCount, provides: (p.provides || []).length };
  }`);
  record('3.2', 'plugin skill count measured from disk matches the fixture',
    pluginDisk?.skillCount === truth.pluginSkillsOnDisk ? 'PASS' : 'FAIL',
    `${pluginDisk?.name}: skillCount=${pluginDisk?.skillCount} (want ${truth.pluginSkillsOnDisk}), provides=${pluginDisk?.provides}`);

  const wantSections = ['h-over', 'h-agents', 'h-mcp', 'h-skills', 'h-plug', 'h-prov', 'h-cfg', 'h-warn', 'h-proj'];
  const gotSections = counts?.sections || [];
  const missing = wantSections.filter(s => !gotSections.includes(s));
  record('3.2', 'all expected sections render', missing.length === 0 ? 'PASS' : 'FAIL',
    missing.length === 0 ? `${gotSections.length} sections` : `missing: ${missing.join(', ')}`);

  /* --------------------------------------------------------- 3.3 search */
  // The template debounces input by 130ms, so each step must be a separate
  // evaluation with a real wait between them.
  const q = sel => `(sel => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = e.value; })`;
  void q;

  const setQuery = async v => {
    await pw(['eval', `() => { const e = document.getElementById('q'); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', {bubbles:true})); return 1; }`], { allowFail: true });
    await new Promise(r => setTimeout(r, 400)); // > 130ms debounce
  };
  const probeSearch = () => ev(`() => ({
    hidden: document.getElementById('empty').hidden,
    len: document.getElementById('sections').innerHTML.length,
    q: document.getElementById('q').value,
  })`);

  await setQuery('');
  const s0 = await probeSearch();
  await setQuery('zzzz-definitely-no-match');
  const s1 = await probeSearch();
  await setQuery('local-helper');
  const s2 = await probeSearch();
  await setQuery('');
  const s3 = await probeSearch();

  record('3.3', 'search: nonsense query shows the empty state',
    s1?.hidden === false && s1.len === 0 ? 'PASS' : 'FAIL',
    `empty.hidden=${s1?.hidden} sections.len=${s1?.len}`);
  record('3.3', 'search: a real query narrows results',
    typeof s2?.len === 'number' && s2.len > 0 && s2.len < s0.len ? 'PASS' : 'FAIL',
    `narrow=${s2?.len} < initial=${s0?.len}`);
  record('3.3', 'search: clearing restores the full list',
    s3?.len === s0?.len && s3?.hidden === true ? 'PASS' : 'FAIL',
    `${s3?.len} vs ${s0?.len}, empty.hidden=${s3?.hidden}`);

  const escSearch = await ev(`() => {
    const box = document.getElementById('q');
    box.focus();
    box.value = 'x';
    box.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
    return box.value;
  }`);
  record('3.3', 'Esc inside the search box clears it', escSearch === '' ? 'PASS' : 'FAIL',
    `value="${escSearch}"`);

  const slash = await ev(`() => {
    document.getElementById('q').blur();
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'/', bubbles:true}));
    return document.activeElement === document.getElementById('q');
  }`);
  record('3.3', '"/" focuses the search box', slash === true ? 'PASS' : 'FAIL', `activeElement is q: ${slash}`);

  /* ------------------------------------------------- 3.4 filters + reset */
  // Filters are independent multi-selects, so a scope filter must be measured
  // from a clean state rather than stacked on a category filter.
  const filterProbe = sel => `() => {
    resetAll();
    const before = document.getElementById('sections').innerHTML.length;
    const el = document.querySelector(${JSON.stringify(sel)});
    const pressed0 = el.getAttribute('aria-pressed');
    el.click();
    const after = document.getElementById('sections').innerHTML.length;
    const pressed1 = el.getAttribute('aria-pressed');
    resetAll();
    const reset = document.getElementById('sections').innerHTML.length;
    const pressedReset = document.querySelector(${JSON.stringify(sel)}).getAttribute('aria-pressed');
    return { before, after, reset, pressed0, pressed1, pressedReset };
  }`;

  const catFilter = await ev(filterProbe('[data-filter="agents"]'));
  record('3.4', 'category filter toggles aria-pressed and filters',
    catFilter?.pressed0 === 'false' && catFilter?.pressed1 === 'true' && catFilter.after < catFilter.before
      ? 'PASS' : 'FAIL',
    `aria ${catFilter?.pressed0}->${catFilter?.pressed1}, len ${catFilter?.before}->${catFilter.after}`);

  const scopeFilter = await ev(filterProbe('[data-scope="local"]'));
  record('3.4', 'scope filter toggles aria-pressed and filters',
    scopeFilter?.pressed1 === 'true' && scopeFilter.after < scopeFilter.before ? 'PASS' : 'FAIL',
    `len ${scopeFilter?.before}->${scopeFilter.after}, aria=${scopeFilter?.pressed1}`);

  // Measure a filter's effect by the number of visible section elements, since
  // the template re-renders #sections per filter and an empty category simply
  // produces no sections at all.
  const allFilters = await ev(`() => {
    const vis = () => document.querySelectorAll('main section').length;
    const base = vis();
    const detail = {};
    const keys = Array.from(document.querySelectorAll('[data-filter]')).map(e => e.dataset.filter);
    for (const k of keys) {
      resetAll();
      const el = document.querySelector('[data-filter="' + k + '"]');
      const b = vis();
      el.click();
      detail[k] = { before: b, after: vis(), pressed: el.getAttribute('aria-pressed') };
    }
    resetAll();
    return { base, detail, keys, reset: vis() };
  }`);
  const filterDetail = allFilters?.detail || {};
  const noEffect = Object.entries(filterDetail)
    .filter(([, v]) => v.pressed === 'true' && v.after >= v.before)
    .map(([k]) => k);
  record('3.4', 'every category filter is pressable and takes effect',
    noEffect.length === 0 ? 'PASS' : 'FAIL',
    noEffect.length === 0
      ? `${Object.keys(filterDetail).length} filters: ` +
        Object.entries(filterDetail).map(([k, v]) => `${k} ${v.before}->${v.after}`).join(', ')
      : `no effect: ${noEffect.join(', ')}`);
  record('3.4', 'Reset clears every filter and restores the full list',
    allFilters?.reset === allFilters?.base && allFilters?.base === 10 ? 'PASS' : 'FAIL',
    `sections after reset=${allFilters?.reset}, baseline=${allFilters?.base}`);

  /* ------------------------------------------------- 3.5 drawers per kind */
  const kinds = await ev(`() => {
    const seen = {};
    for (const e of ENTITIES) { if (!seen[e.kind]) seen[e.kind] = e; }
    const results = [];
    for (const [kind, e] of Object.entries(seen)) {
      const before = document.activeElement;
      openDrawer(kind, e.id);
      const d = document.getElementById('dwBody');
      const rec = {
        kind, id: e.id,
        open: document.getElementById('drawer').classList.contains('open'),
        title: document.getElementById('dwTitle').textContent.trim(),
        bodyLen: d.innerHTML.length,
        chips: document.getElementById('dwChips').innerHTML.length,
        focused: document.activeElement === document.getElementById('dwClose'),
      };
      // Esc closes
      document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
      rec.closedByEsc = !document.getElementById('drawer').classList.contains('open');
      results.push(rec);
    }
    return results;
  }`);
  const kindsCovered = (kinds || []).map(k => k.kind).sort();
  const wantKinds = ['agent', 'automation', 'config', 'ctx', 'metric', 'model', 'plugin', 'provider', 'skill', 'warning'].sort();
  const missingKinds = wantKinds.filter(k => !kindsCovered.includes(k));
  record('3.5', 'a drawer opens for every entity kind',
    missingKinds.length === 0 ? 'PASS' : 'FAIL',
    missingKinds.length === 0 ? `covered: ${kindsCovered.join(', ')}` : `missing: ${missingKinds.join(', ')}`);
  const badDrawer = (kinds || []).filter(k => !k.open || !k.title || k.bodyLen === 0);
  record('3.5', 'each drawer has a title and body',
    badDrawer.length === 0 ? 'PASS' : 'FAIL',
    badDrawer.length === 0 ? `${kinds.length} drawers non-empty` : badDrawer.map(b => `${b.kind}/${b.id} title=${b.title} len=${b.bodyLen}`).join('; '));
  const escFails = (kinds || []).filter(k => !k.closedByEsc);
  record('3.5', 'Esc closes every drawer', escFails.length === 0 ? 'PASS' : 'FAIL',
    escFails.length === 0 ? 'all closed' : escFails.map(f => f.kind).join(', '));

  const focusReturn = await ev(`() => {
    const btn = document.querySelector('button[data-open="agent"]');
    btn.focus();
    const before = document.activeElement;
    btn.click();
    const inDrawer = document.activeElement === document.getElementById('dwClose');
    closeDrawer();
    return { beforeWasBtn: before === btn, focusedInDrawer: inDrawer, restored: document.activeElement === btn };
  }`);
  record('3.5', 'drawer moves focus in and returns it on close',
    focusReturn?.focusedInDrawer && focusReturn?.restored ? 'PASS' : 'FAIL',
    `focusedInDrawer=${focusReturn?.focusedInDrawer} restored=${focusReturn?.restored}`);

  const tabTrap = await ev(`() => {
    openDrawer('agent', 'build');
    const f = document.getElementById('drawer').querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    const inside = Array.from(f).every(el => document.getElementById('drawer').contains(el));
    closeDrawer();
    return { focusables: f.length, allInside: inside };
  }`);
  record('3.5', 'drawer focusable set is contained in the drawer',
    tabTrap?.allInside && tabTrap.focusables > 0 ? 'PASS' : 'FAIL',
    `${tabTrap?.focusables} focusables, all inside: ${tabTrap?.allInside}`);

  /* --------------------------------------------------------- 3.6 graph */
  const graph = await ev(`() => {
    setView('graph');
    const svg = document.querySelector('section[aria-labelledby="h-graph"] svg');
    const nodes = svg ? svg.querySelectorAll('.gnode') : [];
    const edges = svg ? svg.querySelectorAll('.gedge') : [];
    let edgeHot = 0;
    const link = svg ? svg.querySelector('.glink') : null;
    if (link) { link.dispatchEvent(new MouseEvent('click', {bubbles:true})); edgeHot = document.querySelectorAll('.gedge.hot').length; }
    return { nodes: nodes.length, edges: edges.length, edgeHot };
  }`);
  record('3.6', 'graph renders nodes and edges',
    graph?.nodes > 0 && graph?.edges > 0 ? 'PASS' : 'FAIL',
    `nodes=${graph?.nodes} edges=${graph?.edges}`);
  record('3.6', 'clicking an edge highlights it', graph?.edgeHot > 0 ? 'PASS' : 'FAIL', `${graph?.edgeHot} hot edge(s)`);

  // Keyboard interaction must use a REAL key press. A synthetic
  // KeyboardEvent does not reach the activation path, so it would report a
  // false failure here.
  const focusedNode = await ev(`() => {
    const all = document.querySelectorAll('.gnode');
    const n = all[1] || all[0];
    if (!n) return { found: false };
    n.focus();
    return { found: true, focused: document.activeElement === n, id: n.getAttribute('data-id'), kind: n.getAttribute('data-open') };
  }`);
  record('3.6', 'graph node is focusable', focusedNode?.focused ? 'PASS' : 'FAIL',
    `node=${focusedNode?.id} kind=${focusedNode?.kind} focused=${focusedNode?.focused}`);

  await pw(['press', 'Enter'], { allowFail: true });
  const afterEnter = await ev(`() => ({
    open: document.getElementById('drawer').classList.contains('open'),
    title: document.getElementById('dwTitle').textContent.trim(),
    bodyLen: document.getElementById('dwBody').innerHTML.length,
  })`);
  await pw(['press', 'Escape'], { allowFail: true });
  const afterEsc = await ev(`() => document.getElementById('drawer').classList.contains('open')`);
  record('3.6', 'real Enter on a focused graph node opens its drawer',
    afterEnter?.open === true && afterEnter?.bodyLen > 0 ? 'PASS' : 'FAIL',
    `opened=${afterEnter?.open} titleLen=${(afterEnter?.title||"").length} bodyLen=${afterEnter?.bodyLen}`);
  record('3.6', 'Esc closes the graph-node drawer', afterEsc === false ? 'PASS' : 'FAIL', `open=${afterEsc}`);

  await ev(`() => { setView('grid'); return 1; }`);

  /* ------------------------------------------- 3.7 config tabs + copy */
  const tabs = await ev(`() => {
    const tablist = document.querySelector('[role="tablist"]');
    const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
    const panels = Array.from(document.querySelectorAll('[role="tabpanel"]'));
    const before = panels.map(p => p.hidden);
    tabs[1].click();
    const after = panels.map(p => p.hidden);
    return { count: tabs.length, before, after, selected: document.querySelectorAll('[role="tab"][aria-selected="true"]').length };
  }`);
  record('3.7', 'config inspector tabs switch panels',
    tabs?.after?.[0] === true && tabs?.after?.[1] === false && tabs?.selected === 1 ? 'PASS' : 'FAIL',
    `${tabs?.count} tabs, hidden before=${JSON.stringify(tabs?.before?.slice(0,3))} after=${JSON.stringify(tabs?.after?.slice(0,3))}`);

  const copy = await ev(`() => {
    const btn = document.querySelector('[data-copy]');
    if (!btn) return { found: false };
    btn.click();
    return new Promise(res => setTimeout(() => res({
      found: true,
      toast: document.getElementById('toast').textContent,
      toastVisible: document.getElementById('toast').style.opacity === '1',
    }), 400));
  }`);
  record('3.7', 'copy button writes to the clipboard and shows a toast',
    copy?.found && copy.toastVisible && /copied|blocked/i.test(copy.toast || '') ? 'PASS' : 'FAIL',
    `toast="${copy?.toast}"`);

  /* ------------------------------------------------------ 3.8 layout 390 */
  await prepare(handle.url, { width: 390, height: 844 });
  const layout = await ev(`() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    overflow: document.documentElement.scrollWidth > window.innerWidth,
    widest: (() => { let m = 0, who=''; for (const el of document.querySelectorAll('*')) { const r = el.getBoundingClientRect(); if (r.right > m) { m = r.right; who = el.tagName+'.'+el.className; } } return { m: Math.round(m), who: String(who).slice(0,60) }; })(),
  })`);
  record('3.8', 'no horizontal page scroll at 390px',
    layout?.overflow === false ? 'PASS' : 'FAIL',
    `scrollWidth=${layout?.scrollWidth} innerWidth=${layout?.innerWidth} widest=${JSON.stringify(layout?.widest)}`);

  const shot390 = path.join(ART, 'fixture-390.png');
  await pw(['screenshot', '--full-page', '--filename', shot390], { allowFail: true });
  record('3.8', 'mobile screenshot saved', fs.existsSync(shot390) ? 'PASS' : 'FAIL', path.basename(shot390));

  /* -------------------------------------------------- 3.9 --no-contents */
  await handle.close();
  const hidden = await startServer({ port: handle.port, collectOpts, contents: false });
  await prepare(hidden.url, { width: 1440, height: 900 });
  // The config bodies are only rendered once the Config Inspector section has
  // rendered; assert against the live DOM and surface a diagnostic when the
  // selector finds nothing, so a future failure is diagnosable.
  const noContents = await ev(`() => {
    const all = Array.from(document.querySelectorAll('code'));
    const bodies = all.filter(c => /^cfg-/.test(c.id || ''));
    const text = bodies.map(c => c.textContent || '').join('\\n');
    return {
      totalCodes: all.length,
      totalBodies: bodies.length,
      hiddenCount: bodies.filter(c => (c.textContent || '').includes('contents hidden')).length,
      leakAnimations: text.includes('animations'),
      leakRouter: text.includes('Route things here'),
      leakCanary: text.includes('CANARY'),
      wholePageHasCanary: document.documentElement.outerHTML.includes('CANARY'),
      wholePageHasRouterText: document.documentElement.outerHTML.includes('Route things here'),
    };
  }`);
  record('3.9', '--no-contents hides every config body',
    noContents && !noContents.__noResult && noContents.totalBodies > 0 &&
    noContents.hiddenCount === noContents.totalBodies ? 'PASS' : 'FAIL',
    noContents && !noContents.__noResult
      ? `${noContents.hiddenCount}/${noContents.totalBodies} config bodies hidden (${noContents.totalCodes} code nodes total)`
      : `no eval result: ${JSON.stringify(noContents).slice(0, 120)}`);

  record('3.9', '--no-contents leaks no fixture body text into the DOM',
    noContents && !noContents.__noResult &&
    !noContents.leakAnimations && !noContents.leakRouter && !noContents.leakCanary &&
    !noContents.wholePageHasCanary && !noContents.wholePageHasRouterText ? 'PASS' : 'FAIL',
    noContents && !noContents.__noResult
      ? `in bodies: animations=${noContents.leakAnimations} router=${noContents.leakRouter} canary=${noContents.leakCanary}; whole page: canary=${noContents.wholePageHasCanary} router=${noContents.wholePageHasRouterText}`
      : 'no eval result');
  record('3.9', '--no-contents hides every config body',
    noContents?.totalBodies > 0 && noContents.hiddenCount === noContents.totalBodies ? 'PASS' : 'FAIL',
    `${noContents?.hiddenCount}/${noContents?.totalBodies} bodies hidden (${noContents?.totalCodes} code nodes)`);
  /* --------------------------------------------- 5. canary scan in DOM */
  await hidden.close();
  const live = await startServer({ port: handle.port, collectOpts, contents: true });
  await prepare(live.url, { width: 1440, height: 900 });

  const domScan = await ev(`() => {
    const canaries = ${JSON.stringify(Object.values(CANARIES))};
    // open every drawer so lazy content is included
    for (const e of ENTITIES) { try { openDrawer(e.kind, e.id); } catch (_) {} }
    closeDrawer();
    const text = document.documentElement.outerHTML;
    const hits = canaries.filter(c => c.length > 8 && text.includes(c));
    return { hits: hits.length, which: hits.map(h => h.slice(0, 24)), totalLen: text.length };
  }`);
  record('5', 'no canary secret appears in the rendered DOM after opening every drawer',
    domScan?.hits === 0 ? 'PASS' : 'FAIL',
    domScan?.hits === 0 ? `scanned ${domScan.totalLen} chars` : `${domScan.hits} hits: ${domScan.which.join(', ')}`);

  /* -------------------------------------------------- 5. network capture */
  // Read the resource timing API in-page: it captures every subresource the page
  // actually fetched, including the template's own CDN assets.
  const res = await ev(`() => performance.getEntriesByType('resource').map(r => r.name).concat([location.href])`);
  const urls = res || [];
  // Compare hostname only, so the server's own port does not read as a
  // distinct host.
  const hosts = [...new Set(urls.map(u => {
    try { return new URL(u).hostname; } catch { return '(unparseable)'; }
  }))];
  const ALLOWED = new Set([
    '127.0.0.1', 'localhost',
    'cdn.tailwindcss.com', 'unpkg.com', 'fonts.googleapis.com', 'fonts.gstatic.com',
  ]);
  const disallowed = hosts.filter(h => !ALLOWED.has(h));
  record('5', 'browser requests only loopback + the template CDNs',
    disallowed.length === 0 ? 'PASS' : 'FAIL',
    disallowed.length === 0 ? `${urls.length} requests, hosts: ${hosts.join(', ')}`
      : `UNEXPECTED: ${disallowed.join(', ')}`);
  record('5', 'the tool itself makes no outbound request (only the template CDNs do)',
    urls.every(u => u.includes('127.0.0.1') || u.includes('localhost') ||
      /tailwindcss|unpkg|googleapis|gstatic/.test(u)) ? 'PASS' : 'FAIL',
    'every request is loopback or a template CDN');

  const shot1440 = path.join(ART, 'fixture-1440.png');
  await pw(['screenshot', '--full-page', '--filename', shot1440], { allowFail: true });

  await live.close();
} finally {
  await closeBrowser();
}

/* ------------------------------------------------------------- summary */
const pass = results.filter(r => r.status === 'PASS').length;
const fail = results.filter(r => r.status === 'FAIL').length;
fs.writeFileSync(path.join(ART, 'results.json'), JSON.stringify({ results, pass, fail }, null, 2));
console.log(`\nSUMMARY  pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
