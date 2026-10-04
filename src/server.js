/**
 * Local-only HTTP server.
 *
 * Security posture:
 *   - binds 127.0.0.1 only (never 0.0.0.0)
 *   - rejects any Host header that is not loopback (DNS-rebinding defence)
 *   - GET only; no other method is served
 *   - two fixed routes; everything else is 404
 *   - NO static file serving: nothing is ever read from a URL-derived path
 *   - no CORS headers
 */
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import { renderPage } from './inject.js';
import { sanitize, assertClean, newReport, formatReport } from './sanitize.js';
import { buildSnapshot } from './collect/index.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** True only for an exact loopback Host with our port. */
export function isAllowedHost(hostHeader, port) {
  if (!hostHeader) return false;
  const h = String(hostHeader).trim().toLowerCase();
  // Strip an optional trailing port, handling bracketed IPv6.
  let hostname = h;
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end === -1) return false;
    hostname = h.slice(0, end + 1);
    const rest = h.slice(end + 1);
    if (rest && !/^:\d+$/.test(rest)) return false;
  } else {
    const idx = h.lastIndexOf(':');
    if (idx !== -1) {
      const maybePort = h.slice(idx + 1);
      if (/^\d+$/.test(maybePort)) hostname = h.slice(0, idx);
      else if (maybePort.includes(':')) return false; // bare IPv6 without brackets
    }
    if (hostname.includes(':') && !hostname.startsWith('[')) return false;
  }
  // Require the port to match, when one was supplied.
  const portMatch = h.match(/:(\d+)$/);
  if (portMatch && Number(portMatch[1]) !== Number(port)) return false;
  return LOOPBACK_HOSTS.has(hostname);
}

/** Try to listen, walking forward from `start` if the port is busy. */
export function listen(server, { port, host = '127.0.0.1', maxTries = 20 } = {}) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    let current = port;
    const onError = err => {
      if (err.code === 'EADDRINUSE' && attempt < maxTries) {
        attempt += 1;
        current += 1;
        tryPort(current);
      } else {
        reject(err);
      }
    };
    const tryPort = p => {
      server.once('error', onError);
      server.listen(p, host, () => {
        // Resolve the ACTUAL bound port. With `--port 0` the OS assigns one, and
        // after an EADDRINUSE walk the bound port is not the requested one; the
        // Host check and the printed URL must both use what was really bound.
        const actual = server.address() && server.address().port ? server.address().port : p;
        // Remove ONLY our own listener, never every listener on the server.
        server.off('error', onError);
        resolve(actual);
      });
    };
    tryPort(current);
  });
}

/**
 * Start the server.
 *
 * @param {object} opts
 * @param {number} opts.port
 * @param {object} opts.collectOpts  forwarded to buildSnapshot
 * @param {boolean} opts.contents    false => --no-contents
 * @param {string}  opts.templatePath
 */
export async function startServer(opts = {}) {
  const { port: requestedPort = 4173, collectOpts = {}, contents = true, templatePath } = opts;

  // One in-flight collection shared by all concurrent requests, so 20 parallel
  // GETs spawn the CLI once, not twenty times.
  let inflight = null;
  let lastGood = null;
  let collectCount = 0;

  async function freshSnapshot() {
    if (inflight) return inflight;
    collectCount += 1;
    inflight = (async () => {
      try {
        const raw = await buildSnapshot(collectOpts);
        const report = newReport();
        const clean = sanitize(raw, { report, contents });
        assertClean(clean);
        lastGood = clean;
        return { snapshot: clean, report, error: null };
      } catch (e) {
        return { snapshot: null, report: newReport(), error: e.message };
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  // The bound port can differ from the requested one — with `--port 0` the OS
  // assigns one, and the EADDRINUSE walk moves to another. The Host check must
  // use what was actually bound or every request is 403ed.
  let boundPort = requestedPort;

  const server = http.createServer((req, res) => {
    const send = (code, body, headers = {}) => {
      const h = {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        // The template loads Tailwind, Lucide and fonts from CDNs. Those scripts
        // run in this origin and could read the injected snapshot, so the page is
        // denied outbound connections — which the tool never uses anyway.
        'Content-Security-Policy':
          "default-src 'none'; " +
          "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://unpkg.com; " +
          "style-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://fonts.googleapis.com; " +
          "font-src 'self' https://fonts.gstatic.com data:; " +
          "img-src 'self' data:; connect-src 'none'; form-action 'none'; " +
          "base-uri 'none'; frame-ancestors 'none'",
        'Referrer-Policy': 'no-referrer',
        ...headers,
      };
      res.writeHead(code, h);
      res.end(body);
    };

    if (!isAllowedHost(req.headers.host, boundPort)) {
      return send(403, 'Forbidden: this server only answers loopback requests.');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return send(405, 'Method Not Allowed');
    }

    // Path is matched literally. It is never joined with any filesystem root.
    // BOTH new URL() and decodeURIComponent() THROW on malformed input (e.g. "/%",
    // "//", "/\"), and an uncaught throw here escapes the request handler and
    // takes the whole server down — reachable from any web page the user visits,
    // since fetch() to loopback needs no preflight.
    let url, pathname;
    try {
      url = new URL(req.url || '/', `http://${req.headers.host}`);
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return send(400, 'Bad Request');
    }
    // A protocol-relative request target such as `//evil.example.com/` parses to
    // an off-site host with pathname `/`. Nothing is redirected and no outbound
    // request is made, but refuse it so the behaviour is explicit.
    if (url.host && !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
      return send(403, 'Forbidden: cross-host request target.');
    }

    if (pathname !== '/' && pathname !== '/api/snapshot') {
      return send(404, 'Not Found');
    }

    freshSnapshot().then(({ snapshot, error }) => {
      if (error) {
        // Never echo internal paths or CLI stderr back over HTTP.
        console.error('collection failed:', error);
        return send(500, 'Collection failed. See the terminal for details.');
      }
      if (pathname === '/api/snapshot') {
        return send(200, JSON.stringify(snapshot, null, 2), {
          'Content-Type': 'application/json; charset=utf-8',
        });
      }

      let html;
      try {
        html = renderPage(snapshot, templatePath);
      } catch (e) {
        // The injection error names the template path; never echo it over HTTP.
        console.error('template injection failed:', e.message);
        return send(500, 'Template injection failed. See the terminal for details.');
      }
      if (req.method === 'HEAD') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        return res.end();
      }
      return send(200, html, { 'Content-Type': 'text/html; charset=utf-8' });
    });
  });

  const port = await listen(server, { port: requestedPort });
  boundPort = port;

  // After a successful bind there is no 'error' listener left. An accept-level
  // failure (EMFILE, EADDRNOTAVAIL) is emitted on the server and, with nothing
  // listening, would become an uncaught exception and kill the process.
  server.on('error', err => {
    console.error(`server error: ${err && err.code ? err.code : err}`);
  });

  return {
    server,
    port,
    url: `http://127.0.0.1:${port}/`,
    get collectCount() {
      return collectCount;
    },
    get lastSnapshot() {
      return lastGood;
    },
    close: () => new Promise(res => {
      // An idle keep-alive socket would otherwise hold close() open forever.
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      server.close(() => res());
    }),
  };
}

export { formatReport, fs, net };
