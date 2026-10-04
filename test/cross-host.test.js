/**
 * Cross-host request-target guard. A protocol-relative target such as
 * `//evil.example.com/` parses to an off-site authority with pathname `/`.
 * Nothing should be served for it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { startServer } from '../src/server.js';
import { buildFixture, stubExec, cleanup } from './fixtures/fixture.js';

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

test('a cross-host request target is refused', async t => {
  const fixture = buildFixture('rich');
  const handle = await startServer({
    port: 4470,
    collectOpts: { home: fixture.home, projectDir: fixture.project, deps: stubExec() },
    contents: true,
  });
  t.after(async () => { await handle.close(); cleanup(fixture); });

  for (const target of ['//evil.example.com/', '/\\evil.example.com']) {
    const res = await raw(handle.port,
      `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${handle.port}\r\nConnection: close\r\n\r\n`);
    assert.match(res, /^HTTP\/1\.1 403/, `${target} must be refused`);
    assert.ok(!res.includes('const SNAPSHOT'), `${target} must not serve the page`);
  }

  // The legitimate root still works.
  const ok = await raw(handle.port,
    `GET / HTTP/1.1\r\nHost: 127.0.0.1:${handle.port}\r\nConnection: close\r\n\r\n`);
  assert.match(ok, /^HTTP\/1\.1 200/);
});

test('a same-host request target with a query string still serves', async t => {
  const fixture = buildFixture('rich');
  const handle = await startServer({
    port: 4471,
    collectOpts: { home: fixture.home, projectDir: fixture.project, deps: stubExec() },
    contents: true,
  });
  t.after(async () => { await handle.close(); cleanup(fixture); });

  const res = await raw(handle.port,
    `GET /?refresh=1 HTTP/1.1\r\nHost: 127.0.0.1:${handle.port}\r\nConnection: close\r\n\r\n`);
  assert.match(res, /^HTTP\/1\.1 200/);
  assert.ok(res.includes('const SNAPSHOT = {'));
});
