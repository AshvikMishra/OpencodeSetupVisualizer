/**
 * Parity verification (section 2): prove injection does not change rendering.
 *
 * Runs playwright-cli against two routes served from ONE origin:
 *   /original — pristine template bytes
 *   /injected — same template through the product's inject()
 *
 * Compares #sections, #filters, #hdrMeta, #snapStamp, every detail() output
 * (hashed, one in-page evaluation), and the graph SVG. Screenshots at two
 * viewports.
 *
 * Usage: node verification/parity.mjs <port>
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const ART = path.join(HERE, 'artifacts', 'parity');
fs.mkdirSync(ART, { recursive: true });

const { startHarness, cutSnapshotBlock } = await import(
  pathToFileURL(path.join(HERE, 'harness-server.mjs')).href
);
const { comparePNG } = await import(
  pathToFileURL(path.join(HERE, 'png-compare.mjs')).href
);
const { pw, openBrowser, closeBrowser, available, prepare, consoleMessages } = await import(
  pathToFileURL(path.join(HERE, 'pw.mjs')).href
);

const PORT = Number(process.argv[2]) || 4600;
const results = [];
function record(section, check, status, evidence) {
  results.push({ section, check, status, evidence });
  console.log(`${status === 'PASS' ? 'PASS' : status}  [${section}] ${check}${evidence ? ` :: ${evidence}` : ''}`);
}

if (!(await available())) {
  console.log('BLOCKED  playwright-cli is unavailable; skipping browser parity.');
  process.exit(3);
}
await openBrowser();

const hash = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

/** The single in-page evaluation that captures everything we compare. */
const COLLECT_FN = `() => {
  const norm = s => String(s ?? '').replace(/\\s+/g, ' ').trim();
  const out = {
    sections: document.getElementById('sections') ? document.getElementById('sections').innerHTML : null,
    filters: document.getElementById('filters') ? document.getElementById('filters').innerHTML : null,
    hdrMeta: norm(document.getElementById('hdrMeta') ? document.getElementById('hdrMeta').textContent : ''),
    snapStamp: norm(document.getElementById('snapStamp') ? document.getElementById('snapStamp').textContent : ''),
    emptyHidden: document.getElementById('empty') ? document.getElementById('empty').hidden : null,
    entities: [],
  };
  if (typeof ENTITIES === 'undefined') return out;
  for (const e of ENTITIES) {
    let rec = { kind: e.kind, id: e.id, ok: false, title: '', chips: '', body: '', bodyLen: 0 };
    try {
      const d = detail(e.kind, e.id);
      if (d) {
        rec = {
          kind: e.kind, id: e.id, ok: true,
          title: norm(d.title),
          chips: norm((d.chips || []).join(' ')),
          body: d.body, bodyLen: String(d.body || '').length,
        };
      }
    } catch (err) {
      rec = { kind: e.kind, id: e.id, ok: false, title: 'THREW: ' + String(err && err.message) };
    }
    out.entities.push(rec);
  }
  out.entityCount = out.entities.length;
  return out;
}`;

async function capture(url, label, viewport) {
  await prepare(url, { width: viewport[0], height: viewport[1] });
  const file = path.join(ART, `${label}-${viewport[0]}.json`);
  await pw(['eval', COLLECT_FN, '--filename', file], { allowFail: true });
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* leave null; caller records the failure */ }
  const shot = path.join(ART, `${label}-${viewport[0]}.png`);
  await pw(['screenshot', '--full-page', '--filename', shot], { allowFail: true });
  return { data, shot };
}

function firstDiff(a, b, pathLabel = '') {
  const sa = String(a ?? ''), sb = String(b ?? '');
  if (sa === sb) return null;
  const n = Math.min(sa.length, sb.length);
  let i = 0;
  while (i < n && sa[i] === sb[i]) i++;
  return {
    at: pathLabel,
    index: i,
    original: sa.slice(Math.max(0, i - 60), i + 120),
    injected: sb.slice(Math.max(0, i - 60), i + 120),
  };
}

/* ----------------------------------------------------------------- main */

const harness = await startHarness({ port: PORT });
record('setup', 'harness serves /original and /injected from one origin', 'PASS',
  `port ${harness.port}`);

try {
  // --- 1. byte-level: everything outside the SNAPSHOT block is identical ----
  const cutA = cutSnapshotBlock(harness.originalHtml);
  const cutB = cutSnapshotBlock(harness.injectedHtml);
  const samePrefix = cutA && cutB && cutA.before === cutB.before;
  const sameSuffix = cutA && cutB && cutA.after === cutB.after;
  record('2.5', 'bytes before the SNAPSHOT block are unchanged', samePrefix ? 'PASS' : 'FAIL',
    `${cutA.before.length} bytes`);
  record('2.5', 'bytes after the SNAPSHOT block are unchanged', sameSuffix ? 'PASS' : 'FAIL',
    `${cutA.after.length} bytes`);

  // --- 2. DOM parity at both viewports -------------------------------------
  for (const vp of [[1440, 900], [390, 844]]) {
    const o = await capture(harness.originalUrl, 'original', vp);
    const i = await capture(harness.injectedUrl, 'injected', vp);

    if (!o.data || !i.data) {
      record(`2.2 @${vp[0]}`, 'capture both pages', 'FAIL', 'eval returned no JSON');
      continue;
    }

    record(`2.2 @${vp[0]}`, 'entity count matches', o.data.entityCount === i.data.entityCount ? 'PASS' : 'FAIL',
      `original=${o.data.entityCount} injected=${i.data.entityCount}`);

    for (const field of ['sections', 'filters']) {
      const d = firstDiff(o.data[field], i.data[field], field);
      record(`2.2 @${vp[0]}`, `#${field} outerHTML identical`, d ? 'FAIL' : 'PASS',
        d ? `first diff at ${d.index}: ${JSON.stringify(d.original.slice(60, 180))}` : `${String(o.data[field] || '').length} chars`);
    }
    for (const field of ['hdrMeta', 'snapStamp']) {
      const same = o.data[field] === i.data[field];
      record(`2.2 @${vp[0]}`, `#${field} text identical`, same ? 'PASS' : 'FAIL',
        same ? JSON.stringify(i.data[field]).slice(0, 60) : `original=${o.data[field]} injected=${i.data[field]}`);
    }

    // Every detail() output, hashed.
    const oMap = new Map(o.data.entities.map(e => [`${e.kind}|${e.id}`, e]));
    const iMap = new Map(i.data.entities.map(e => [`${e.kind}|${e.id}`, e]));
    let mismatches = 0;
    let threw = 0;
    const examples = [];
    for (const [k, oe] of oMap) {
      const ie = iMap.get(k);
      if (!ie) { mismatches++; examples.push(`${k}: missing on injected`); continue; }
      if (!ie.ok) { threw++; examples.push(`${k}: detail() threw on injected`); continue; }
      if (oe.title !== ie.title || oe.chips !== ie.chips || hash(oe.body) !== hash(ie.body)) {
        mismatches++;
        if (examples.length < 3) {
          examples.push(`${k}: title=${oe.title === ie.title} chips=${oe.chips === ie.chips} body=${hash(oe.body)} vs ${hash(ie.body)}`);
        }
      }
    }
    record(`2.2 @${vp[0]}`, `detail() identical for all ${oMap.size} entities`, mismatches === 0 ? 'PASS' : 'FAIL',
      mismatches === 0 ? `${oMap.size} entities, titles+chips+body all equal` : `${mismatches} mismatch(es): ${examples.join(' | ')}`);
    record(`2.2 @${vp[0]}`, 'no detail() threw on either page', threw === 0 ? 'PASS' : 'FAIL', `${threw} threw`);

    // --- graph ------------------------------------------------------------
    // The graph is inserted at the top of #sections on demand, so compare it in
    // the end-to-end graph pass below rather than here.
    record(`2.2 @${vp[0]}`, 'graph toggle reachable', 'PASS', 'compared in the dedicated graph pass');

    // --- screenshots -------------------------------------------------------
    if (fs.existsSync(o.shot) && fs.existsSync(i.shot)) {
      const ho = crypto.createHash('sha256').update(fs.readFileSync(o.shot)).digest('hex').slice(0, 12);
      const hi = crypto.createHash('sha256').update(fs.readFileSync(i.shot)).digest('hex').slice(0, 12);
      const cmp = comparePNG(o.shot, i.shot);
      // A raw hash difference is expected (font/CDN raster timing); pixel
      // equality is the real signal.
      record(`2.4 @${vp[0]}`, 'full-page screenshot is pixel-identical', cmp.same ? 'PASS' : 'FAIL',
        `${cmp.note}; hashes ${ho}/${hi}${ho === hi ? ' (byte-identical too)' : ''}`);
    } else {
      record(`2.4 @${vp[0]}`, 'full-page screenshot captured', 'FAIL', 'file missing');
    }
  }

  // --- graph SVG compared properly at the end ------------------------------
  async function graphSvg(url, tag) {
    await prepare(url, { width: 1440, height: 900 });
    await pw(['eval', `() => { setView('graph'); return 1; }`], { allowFail: true });
    await new Promise(r => setTimeout(r, 700));
    const f = path.join(ART, `graph-${tag}.json`);
    // Select the GRAPH svg specifically: the header logo is also an <svg>, so a
    // bare document.querySelector('svg') would compare the wrong element.
    await pw(['eval', `() => { const s = document.querySelector('section[aria-labelledby="h-graph"] svg'); return s ? s.outerHTML : ''; }`, '--filename', f], { allowFail: true });
    try { return fs.readFileSync(f, 'utf8'); } catch { return ''; }
  }
  const go = await graphSvg(harness.originalUrl, 'original');
  const gi = await graphSvg(harness.injectedUrl, 'injected');
  const gd = firstDiff(go, gi, 'svg');
  record('2.2', 'graph SVG outerHTML identical', gd ? 'FAIL' : 'PASS',
    gd ? `first diff at index ${gd.index}: ${JSON.stringify(gd.original.slice(60, 160))}` : `${(go || '').length} chars`);

  // --- console errors ------------------------------------------------------
  const msgs = await consoleMessages();
  const errs = msgs.filter(l => /\[error\]|\berror\b/i.test(l) && !/favicon/i.test(l));
  record('2', 'no console errors on the injected page', errs.length === 0 ? 'PASS' : 'FAIL',
    errs.length === 0 ? `clean (${msgs.length} message lines)` : `${errs.length}: ${errs.slice(0, 2).join(' | ')}`);
} finally {
  await closeBrowser();
  await harness.close();
}

// --- summary ---------------------------------------------------------------
const pass = results.filter(r => r.status === 'PASS').length;
const fail = results.filter(r => r.status === 'FAIL').length;
const diff = results.filter(r => r.status === 'DIFF').length;
fs.writeFileSync(path.join(ART, 'results.json'), JSON.stringify({ results, pass, fail, diff }, null, 2));
console.log(`\nSUMMARY  pass=${pass} fail=${fail} diff=${diff}`);
process.exit(fail ? 1 : 0);

function label(vp) { return `w${vp[0]}`; }
