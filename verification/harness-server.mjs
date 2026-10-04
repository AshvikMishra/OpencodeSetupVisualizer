/**
 * Throwaway parity harness (verification only, not shipped).
 *
 * Serves two routes from ONE origin so the browser sees an identical environment:
 *   /original — the pristine template bytes, unmodified
 *   /injected — the same template through the PRODUCT's inject(), using the
 *               template's OWN SNAPSHOT as the data
 *
 * The original SNAPSHOT is extracted by evaluating the template's
 * `const SNAPSHOT = {...}` block in node:vm — it is a JS object literal, not JSON.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const TEMPLATE = path.join(ROOT, 'template', 'opencode-dashboard-example.html');

// On Windows an absolute path is not a valid ESM specifier; it needs a file:// URL.
const { inject, START_MARKER, END_MARKER } = await import(
  pathToFileURL(path.join(ROOT, 'src', 'inject.js')).href
);

/**
 * Evaluate the template's own SNAPSHOT block. Returns the live object.
 * The block spans from START_MARKER to END_MARKER.
 */
export function extractOriginalSnapshot(html = fs.readFileSync(TEMPLATE, 'utf8')) {
  const start = html.indexOf(START_MARKER) + START_MARKER.length;
  const end = html.indexOf(END_MARKER, start);
  const literal = html.slice(start, end).trim().replace(/;$/, '');
  // Evaluate as an expression object literal. `location`/`window` are absent,
  // so the template's boot code is NOT run — only the literal is read.
  const ctx = vm.createContext({ Object, Array, JSON, Math, Date, String, Number, Boolean, RegExp, Set, Map });
  return vm.runInContext(`(${literal})`, ctx, { filename: 'template-snapshot.js' });
}

/** Cut the SNAPSHOT block out of a document, so the rest can be byte-compared. */
export function cutSnapshotBlock(html) {
  const start = html.indexOf(START_MARKER);
  const end = html.indexOf(END_MARKER, start + START_MARKER.length);
  if (start === -1 || end === -1) return null;
  return { before: html.slice(0, start), after: html.slice(end) };
}

export async function startHarness({ port = 4600, templatePath = TEMPLATE } = {}) {
  const originalBytes = fs.readFileSync(templatePath);
  const originalHtml = originalBytes.toString('utf8');
  const snapshot = extractOriginalSnapshot(originalHtml);
  const injectedHtml = inject(originalHtml, JSON.parse(JSON.stringify(snapshot)));

  const server = http.createServer((req, res) => {
    const host = String(req.headers.host || '');
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
      res.writeHead(403); return res.end('loopback only');
    }
    const p = (req.url || '/').split('?')[0];
    if (p === '/original') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(originalBytes);
    }
    if (p === '/injected') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(injectedHtml);
    }
    res.writeHead(404); res.end('not found');
  });

  await new Promise(r => server.listen(port, '127.0.0.1', r));
  const actualPort = server.address().port;
  return {
    port: actualPort,
    originalUrl: `http://127.0.0.1:${actualPort}/original`,
    injectedUrl: `http://127.0.0.1:${actualPort}/injected`,
    originalBytes,
    originalHtml,
    injectedHtml,
    snapshot,
    close: () => new Promise(r => server.close(() => r())),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const h = await startHarness({ port: Number(process.argv[2]) || 4600 });
  console.log(JSON.stringify({
    port: h.port,
    originalUrl: h.originalUrl,
    injectedUrl: h.injectedUrl,
    snapshotKeys: Object.keys(h.snapshot),
    originalBytes: h.originalBytes.length,
    injectedBytes: Buffer.byteLength(h.injectedHtml),
  }, null, 2));
  // Stay up so a browser (or curl) can hit the two routes.
  if (process.argv.includes('--serve')) {
    console.error('harness listening; ctrl+C to stop');
  } else {
    await h.close();
  }
}
