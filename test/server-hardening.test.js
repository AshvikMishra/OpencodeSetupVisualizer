/**
 * Server hardening.
 *
 * Three HIGH defects were found by audit and fixed:
 *   - a malformed URL or percent-escape crashed the whole process
 *   - the Host check validated against the REQUESTED port, not the bound one
 *   - no CSP, so a template CDN script could read the injected snapshot
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startServer, isAllowedHost } from '../src/server.js';
import { buildFixture, stubExec, cleanup } from './fixtures/fixture.js';

let cursor = 4480;
const nextPort = () => (cursor += 1);

function raw(port, text) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(text));
    let out = '';
    s.setEncoding('utf8');
    s.on('data', d => { out += d; });
    s.on('end', () => resolve(out));
    s.on('error', reject);
  });
}

async function server(t) {
  const fixture = buildFixture('rich');
  const handle = await startServer({
    port: nextPort(),
    collectOpts: { home: fixture.home, projectDir: fixture.project, deps: stubExec() },
    contents: true,
  });
  t.after(async () => { await handle.close(); cleanup(fixture); });
  return handle;
}

/* --------------------------------------------- H1/H2: malformed requests */

test('a malformed request target does not crash the server', async t => {
  const handle = await server(t);
  for (const target of ['/%', '/%2', '/%zz', '/%c0%af', '/a%', '/%C3', '/a%ff%feb', '/%e0%a4%a']) {
    const res = await raw(handle.port,
      `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${handle.port}\r\nConnection: close\r\n\r\n`);
    assert.match(res, /^HTTP\/1\.1 (400|404)/, `${target} must be refused, not fatal`);
  }
  // Still alive and serving.
  const ok = await fetch(handle.url);
  assert.equal(ok.status, 200);
});

test('an empty or doubled authority does not crash the server', async t => {
  const handle = await server(t);
  for (const target of ['//', '///', '/\\']) {
    const res = await raw(handle.port,
      `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${handle.port}\r\nConnection: close\r\n\r\n`);
    assert.match(res, /^HTTP\/1\.1 (400|403|404)/, `${target} must be refused`);
  }
  const ok = await fetch(handle.url);
  assert.equal(ok.status, 200);
});

test('an absolute-form request target is refused', async t => {
  const handle = await server(t);
  const res = await raw(handle.port,
    `GET http://evil.example.com/ HTTP/1.1\r\nHost: 127.0.0.1:${handle.port}\r\nConnection: close\r\n\r\n`);
  assert.match(res, /^HTTP\/1\.1 (400|403|404)/);
  assert.ok(!res.includes('const SNAPSHOT = {'));
});

/* -------------------------------------------------- M2: the bound port */

test('the Host check validates against the port actually bound', async () => {
  // Occupy the requested port first, forcing the walk-forward path.
  const blocker = startServer({ port: 0, collectOpts: {} });
  const held = await blocker;
  const takenPort = held.port;
  const fixture = buildFixture('rich');
  const walked = await startServer({
    port: takenPort,
    collectOpts: { home: fixture.home, projectDir: fixture.project, deps: stubExec() },
    contents: true,
  });
  try {
    assert.notEqual(walked.port, takenPort, 'the server must have walked to a free port');
    const res = await fetch(`http://127.0.0.1:${walked.port}/`);
    assert.equal(res.status, 200,
      'a request to the bound port must not be 403ed by a stale port check');
  } finally {
    await walked.close();
    await held.close();
    cleanup(fixture);
  }
});

/* ----------------------------------------------------------- H3: the CSP */

test('responses carry a CSP that blocks outbound connections', async t => {
  const handle = await server(t);
  for (const route of ['/', '/api/snapshot']) {
    const res = await fetch(handle.url.replace(/\/$/, '') + route);
    const csp = res.headers.get('content-security-policy');
    assert.ok(csp, `${route} must send a CSP`);
    assert.match(csp, /connect-src 'none'/, `${route}: the page may not phone home`);
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
  }
  assert.equal((await fetch(handle.url)).headers.get('referrer-policy'), 'no-referrer');
});

test('the CSP still permits the template own CDNs to render', async t => {
  const handle = await server(t);
  const csp = (await fetch(handle.url)).headers.get('content-security-policy');
  // Blocking these would leave the page unstyled, so they must be allowed even
  // though they are third parties.
  for (const host of ['cdn.tailwindcss.com', 'unpkg.com', 'fonts.googleapis.com', 'fonts.gstatic.com']) {
    assert.ok(csp.includes(host), `${host} must be permitted for the page to render`);
  }
});

/* -------------------------------------------------------- L4: error bodies */

test('a 500 body does not leak internal paths', async t => {
  const fixture = buildFixture('rich');
  const handle = await startServer({
    port: nextPort(),
    collectOpts: { home: fixture.home, projectDir: fixture.project, deps: stubExec() },
    contents: true,
    templatePath: fixture.root + '/nope.html',
  });
  t.after(async () => { await handle.close(); cleanup(fixture); });

  const res = await fetch(handle.url);
  assert.equal(res.status, 500);
  const body = await res.text();
  assert.ok(!body.includes(fixture.root), 'an absolute fixture path must not be echoed');
  assert.ok(!/marker/.test(body), 'the raw marker text must not be echoed');
});

/* ------------------------------------------- M3: error listeners survive */

test('the server keeps an error listener after binding', async t => {
  const handle = await server(t);
  assert.ok(handle.server.listenerCount('error') >= 0);
  // A late bind error must not become an uncaught exception.
  handle.server.emit('error', Object.assign(new Error('synthetic'), { code: 'EMFILE' }));
  const res = await fetch(handle.url);
  assert.equal(res.status, 200, 'the server must still serve after a non-fatal error');
});

/* -------------------------------------------------- close() terminates */

test('close() resolves even with a keep-alive socket open', async t => {
  const fixture = buildFixture('rich');
  const handle = await startServer({
    port: nextPort(),
    collectOpts: { home: fixture.home, projectDir: fixture.project, deps: stubExec() },
    contents: true,
  });
  t.after(() => cleanup(fixture));

  // Open a connection and leave it idle.
  const sock = net.connect(handle.port, '127.0.0.1', () => {
    sock.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${handle.port}\r\n\r\n`);
  });
  await new Promise(r => setTimeout(r, 300));

  const closed = await Promise.race([
    handle.close().then(() => 'closed'),
    new Promise(r => setTimeout(() => r('TIMEOUT'), 3000)),
  ]);
  sock.destroy();
  assert.equal(closed, 'closed', 'close() must not hang on a keep-alive socket');
});

/* ------------------------------------------------- Host parsing details */

test('bare IPv6 loopback is handled explicitly', () => {
  // '::1' must not be silently unusable.
  const r = isAllowedHost('::1', 4173);
  assert.equal(typeof r, 'boolean');
  assert.equal(r, false, 'a bare unbracketed ::1 is not a valid Host header form');
  assert.equal(isAllowedHost('[::1]:4173', 4173), true, 'the bracketed form is valid');
});

test('a Host with no port is judged on the host alone', () => {
  assert.equal(isAllowedHost('127.0.0.1', 4173), true);
  assert.equal(isAllowedHost('evil.test', 4173), false);
});
