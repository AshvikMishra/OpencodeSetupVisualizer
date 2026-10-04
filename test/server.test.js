/**
 * 5. SERVER — loopback binding, Host validation, method allow-list, no static files.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { startServer, isAllowedHost } from '../src/server.js';
import { buildFixture, stubExec, cleanup } from './fixtures/fixture.js';

let portCursor = 4410;
const nextPort = () => (portCursor += 1);

async function withServer(t, opts = {}) {
  const fixture = buildFixture('rich');
  const handle = await startServer({
    port: nextPort(),
    collectOpts: { home: fixture.home, projectDir: fixture.project, deps: stubExec() },
    contents: true,
    ...opts,
  });
  t.after(async () => {
    await handle.close();
    cleanup(fixture);
  });
  return handle;
}

/* ------------------------------------------------------- Host validation */

test('isAllowedHost accepts only loopback with the matching port', () => {
  assert.equal(isAllowedHost('127.0.0.1:4173', 4173), true);
  assert.equal(isAllowedHost('localhost:4173', 4173), true);
  assert.equal(isAllowedHost('127.0.0.1', 4173), true, 'bare loopback is fine');

  assert.equal(isAllowedHost('evil.example.com:4173', 4173), false);
  assert.equal(isAllowedHost('127.0.0.1:9999', 4173), false, 'wrong port');
  assert.equal(isAllowedHost('10.0.0.5:4173', 4173), false);
  assert.equal(isAllowedHost('0.0.0.0:4173', 4173), false);
  assert.equal(isAllowedHost('', 4173), false);
  assert.equal(isAllowedHost(undefined, 4173), false);
});

/* ------------------------------------------------------------- responses */

test('GET / serves injected HTML with no-store and no CORS headers', async t => {
  const handle = await withServer(t);
  const res = await fetch(handle.url);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('access-control-allow-origin'), null, 'must not send CORS');
  const body = await res.text();
  assert.ok(body.includes('const SNAPSHOT = {'), 'snapshot must be injected');
  assert.ok(body.includes('derived helpers'), 'rest of template must survive');
});

test('GET /api/snapshot serves JSON', async t => {
  const handle = await withServer(t);
  const res = await fetch(handle.url + 'api/snapshot');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  const j = await res.json();
  assert.ok(Array.isArray(j.agents));
  assert.ok(Array.isArray(j.skills));
});

test('a non-loopback Host header is rejected (DNS-rebinding defence)', async t => {
  const handle = await withServer(t);
  // fetch() cannot override Host, so use a raw socket.
  const res = await rawRequest(handle.port, 'GET / HTTP/1.1\r\nHost: evil.example.com\r\nConnection: close\r\n\r\n');
  assert.match(res, /^HTTP\/1\.1 403/, 'must reject a foreign Host');
  assert.ok(!res.includes('const SNAPSHOT'), 'must not serve the page');
});

test('a wrong-port Host header is rejected', async t => {
  const handle = await withServer(t);
  const res = await rawRequest(handle.port, 'GET / HTTP/1.1\r\nHost: 127.0.0.1:1\r\nConnection: close\r\n\r\n');
  assert.match(res, /^HTTP\/1\.1 403/);
});

test('non-GET methods are rejected', async t => {
  const handle = await withServer(t);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const res = await rawRequest(
      handle.port,
      `${method} / HTTP/1.1\r\nHost: 127.0.0.1:${handle.port}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
    );
    assert.match(res, /^HTTP\/1\.1 405/, `${method} must be rejected`);
  }
});

test('unknown paths 404 and never return file contents', async t => {
  const handle = await withServer(t);
  const probes = [
    '/index.html', '/package.json', '/src/server.js', '/.gitignore',
    '/../package.json', '/..%2fpackage.json', '/%2e%2e/%2e%2e/etc/passwd',
    '/template/opencode-dashboard-example.html', '/anything?x=1',
  ];
  for (const p of probes) {
    const res = await rawRequest(
      handle.port,
      `GET ${p} HTTP/1.1\r\nHost: 127.0.0.1:${handle.port}\r\nConnection: close\r\n\r\n`
    );
    assert.match(res, /^HTTP\/1\.1 404/, `${p} must 404`);
    assert.ok(!res.includes('opencode-setup-visualizer'), `${p} leaked file contents`);
    assert.ok(!res.includes('begin work'), `${p} leaked file contents`);
  }
});

test('the server binds loopback only, never 0.0.0.0', async t => {
  const handle = await withServer(t);
  assert.equal(handle.server.address().address, '127.0.0.1');

  const external = firstNonLoopbackIPv4();
  if (external) {
    assert.equal(await canConnect(external, handle.port), false,
      `must not be reachable on ${external}`);
  }
});

test('simultaneous requests share ONE in-flight collection', async t => {
  const fixture = buildFixture('rich');
  let collections = 0;
  const base = stubExec();
  const slowDeps = {
    // A slow collector guarantees real overlap between the 20 requests.
    runOpencode: async w => {
      if (w === 'version') { collections++; await delay(150); }
      return base.runOpencode(w);
    },
    runOpencodeJson: base.runOpencodeJson,
  };
  const handle = await startServer({
    port: nextPort(),
    collectOpts: { home: fixture.home, projectDir: fixture.project, deps: slowDeps },
    contents: true,
  });
  t.after(async () => { await handle.close(); cleanup(fixture); });

  // Open all sockets and write in the same tick, so the requests truly overlap.
  const responses = await Promise.all(
    Array.from({ length: 20 }, () => rawRequest(
      handle.port,
      `GET / HTTP/1.1\r\nHost: 127.0.0.1:${handle.port}\r\nConnection: close\r\n\r\n`
    ))
  );
  for (const r of responses) assert.match(r, /^HTTP\/1\.1 200/);

  assert.equal(collections, 1,
    `20 overlapping requests must trigger exactly 1 collection; saw ${collections}`);
});

test('sequential requests each get fresh data (no stale cache)', async t => {
  const fixture = buildFixture('rich');
  let collections = 0;
  const base = stubExec();
  const deps = {
    runOpencode: async w => { if (w === 'version') collections++; return base.runOpencode(w); },
    runOpencodeJson: base.runOpencodeJson,
  };
  const handle = await startServer({
    port: nextPort(),
    collectOpts: { home: fixture.home, projectDir: fixture.project, deps },
    contents: true,
  });
  t.after(async () => { await handle.close(); cleanup(fixture); });

  await (await fetch(handle.url)).text();
  assert.equal(collections, 1);
  await (await fetch(handle.url)).text();
  assert.equal(collections, 2, 'a later request must re-collect');
  await (await fetch(handle.url + 'api/snapshot')).text();
  assert.equal(collections, 3, '/api/snapshot collects too');
});

const delay = ms => new Promise(r => setTimeout(r, ms));

test('a corrupted template makes the server return a clear 500, not a blank page', async t => {
  const fixture = buildFixture('rich');
  const badTemplate = path.join(fixture.root, 'bad-template.html');
  fs.writeFileSync(badTemplate, '<html><script>\nconst SNAPSHOT = { };\n</script></html>');
  const handle = await startServer({
    port: nextPort(),
    collectOpts: { home: fixture.home, projectDir: fixture.project, deps: stubExec() },
    contents: true,
    templatePath: badTemplate,
  });
  t.after(async () => { await handle.close(); cleanup(fixture); });

  const res = await fetch(handle.url);
  assert.equal(res.status, 500);
  // The response body is deliberately generic so it cannot leak the template
  // path; the specific reason goes to the terminal instead.
  assert.match(await res.text(), /Template injection failed/i);
  assert.ok(!/marker|nope|ENOENT/i.test(await fetch(handle.url).then(r => r.text()).catch(() => '')),
    'the 500 body must not carry internal detail');
});

/* ------------------------------------------------------------- utilities */

function rawRequest(port, raw) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(raw));
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', d => { buf += d; });
    sock.on('end', () => resolve(buf));
    sock.on('error', reject);
  });
}

function firstNonLoopbackIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return null;
}

function canConnect(host, port, timeoutMs = 800) {
  return new Promise(resolve => {
    const sock = net.connect({ host, port });
    const done = v => { sock.destroy(); resolve(v); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
  });
}
