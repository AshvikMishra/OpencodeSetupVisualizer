/**
 * Section 5 (part 3) — HTTP behaviour and process-level network posture.
 *
 * Complements test/server.test.js (which runs in-process) by checking the
 * binding address with an OS-level command and confirming the Node process
 * opens no outbound connections.
 *
 * Usage: node verification/http-security.mjs
 */
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { startServer } from '../src/server.js';

const pexec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(HERE, 'artifacts', 'security');
fs.mkdirSync(ART, { recursive: true });

const results = [];
const record = (check, status, evidence) => {
  results.push({ check, status, evidence });
  console.log(`${status}  [5] ${check}${evidence ? ` :: ${evidence}` : ''}`);
};

const PORT = Number(process.argv[2]) || 5200;
const handle = await startServer({ port: PORT, collectOpts: {} });

/** Raw HTTP over a socket, so the Host header can be controlled. */
function raw(port, requestText) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(requestText));
    let out = '';
    s.setEncoding('utf8');
    s.on('data', d => { out += d; });
    s.on('end', () => resolve(out));
    s.on('error', reject);
  });
}

const get = url => new Promise((res, rej) => {
  http.get(url, r => {
    let b = '';
    r.setEncoding('utf8');
    r.on('data', d => { b += d; });
    r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: b }));
  }).on('error', rej);
});

try {
  /* --------------------------------- 1. binding address, OS-verified */
  record('server reports a loopback bind address',
    handle.server.address().address === '127.0.0.1' ? 'PASS' : 'FAIL',
    `address=${handle.server.address().address} port=${handle.port}`);

  // Confirm with a system listing that nothing is listening on 0.0.0.0.
  let netstat = '';
  try {
    // On Windows these are .cmd/.exe shims; spawn the real binary via a shell
    // ONLY for these fixed, literal argv (no discovered value is involved).
    if (process.platform === 'win32') {
      const r = await pexec('cmd.exe', ['/d', '/c', 'netstat', '-ano'], {
        encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60000,
      });
      netstat = r.stdout;
    } else {
      const r = await pexec('ss', ['-ltnp'], { encoding: 'utf8', timeout: 30000 });
      netstat = r.stdout;
    }
  } catch (e) {
    netstat = '';
    record('OS network listing available', 'BLOCKED', String(e.message).split('\n')[0]);
  }
  if (netstat) {
    const listening = netstat.split(/\r?\n/).filter(l => new RegExp(`[:.]${handle.port}\\s`).test(l) && /LISTEN/i.test(l));
    const nonLoopback = listening.filter(l => !/127\.0\.0\.1|\[::1\]|::1/.test(l));
    record('OS listing shows the port bound to loopback only',
      listening.length > 0 && nonLoopback.length === 0 ? 'PASS' : 'FAIL',
      listening.length ? `${listening.length} listener(s), ${nonLoopback.length} non-loopback` : 'port not found in listing');
    fs.writeFileSync(path.join(ART, 'netstat.txt'), netstat);
  }

  /* ---------------------------- 2. an external address is unreachable */
  const external = (Object.values(os.networkInterfaces()).flat() || [])
    .find(n => n && n.family === 'IPv4' && !n.internal)?.address;
  if (external) {
    const reachable = await new Promise(resolve => {
      const s = net.connect({ host: external, port: handle.port });
      const done = v => { s.destroy(); resolve(v); };
      s.setTimeout(1200, () => done(false));
      s.on('connect', () => done(true));
      s.on('error', () => done(false));
    });
    // The address is deliberately NOT recorded: this report is committed.
    const shape = external.replace(/\d+/g, '#');
    record('unreachable on the host LAN address', reachable === false ? 'PASS' : 'FAIL',
      `a non-loopback interface (${shape}) refused the connection; reachable=${reachable}`);
  } else {
    record('unreachable on the host LAN address', 'BLOCKED', 'no non-loopback IPv4 interface');
  }

  /* ------------------------------------------- 3. Host header defence */
  const hostCases = [
    ['evil.example.com', 'external hostname'],
    ['127.0.0.1:1', 'loopback, wrong port'],
    [`localhost:${handle.port}`, 'allowed form (control)'],
    ['127.0.0.1.attacker.test', 'suffix-confusion hostname'],
    ['192.168.1.10', 'private LAN address'],
    ['0.0.0.0', 'wildcard'],
    ['', 'empty host'],
  ];
  for (const [host, label] of hostCases) {
    const res = await raw(handle.port, `GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    const isAllowed = label.includes('control');
    const code = /^HTTP\/1\.1 (\d+)/.exec(res)?.[1];
    const served = res.includes('const SNAPSHOT = {');
    const ok = isAllowed ? code === '200' && served : code === '403' && !served;
    record(`Host "${host}" (${label})`, ok ? 'PASS' : 'FAIL',
      `status=${code} pageServed=${served}`);
  }

  /* ------------------------------------------------- 4. method allow-list */
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'TRACE']) {
    const res = await raw(handle.port, `${method} / HTTP/1.1\r\nHost: 127.0.0.1:${handle.port}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    const code = /^HTTP\/1\.1 (\d+)/.exec(res)?.[1];
    record(`${method} is rejected`, code === '405' ? 'PASS' : 'FAIL', `status=${code}`);
  }

  /* -------------------------------- 5. no static file serving / traversal */
  const traversals = [
    '/package.json', '/src/server.js', '/src/sanitize.js', '/bin/opencode-setup-visualizer.js',
    '/../package.json', '/../../package.json', '/%2e%2e/package.json',
    '/..%2fpackage.json', '/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    '/template/opencode-dashboard-example.html', '/test/fixtures/fixture.js',
    '/.gitignore', '/.git/config', '/verification/live.mjs', '/PLAN.md',
    '/api/snapshot/../', '//etc/passwd', '/%00', '/a'.repeat(3000),
  ];
  let leaked = 0;
  let refused = 0;
  for (const p of traversals) {
    const res = await raw(handle.port, `GET ${p} HTTP/1.1\r\nHost: 127.0.0.1:${handle.port}\r\nConnection: close\r\n\r\n`);
    const head = res.split('\r\n\r\n')[0];
    const code = Number(/^HTTP\/1\.1 (\d+)/.exec(head)?.[1] ?? 0);
    const body = res.split('\r\n\r\n').slice(1).join('\r\n\r\n');
    const bad = /"dependencies"|"name"\s*:\s*"opencode|begin work|root =|CANARY|passwd|getElementById/.test(body);
    // Only two routes exist, so anything other than 200 is a refusal. The real
    // assertion is that no file content was ever returned.
    if (code !== 200) refused++;
    if (code === 200 || bad) {
      leaked++;
      record(`traversal "${p.slice(0, 40)}"`, 'FAIL', `status=${code} leaked=${bad}`);
    }
  }
  record('no static-file leak across all traversal probes', leaked === 0 ? 'PASS' : 'FAIL',
    `${traversals.length} probes, ${refused} refused with a non-200, ${leaked} leaked`);

  /* ------------------------------------------- 6. headers: no CORS, etc. */
  const r1 = await get(handle.url);
  const h = r1.headers;
  record('no Access-Control-Allow-Origin header',
    !('access-control-allow-origin' in h) ? 'PASS' : 'FAIL', 'absent');
  record('no Access-Control-Allow-Credentials header',
    !('access-control-allow-credentials' in h) ? 'PASS' : 'FAIL', 'absent');
  record('Cache-Control: no-store on /',
    /no-store/.test(h['cache-control'] || '') ? 'PASS' : 'FAIL', h['cache-control']);
  record('X-Content-Type-Options: nosniff',
    /nosniff/.test(h['x-content-type-options'] || '') ? 'PASS' : 'FAIL',
    h['x-content-type-options'] || 'absent');
  record('Content-Type is html on /',
    /text\/html/.test(h['content-type'] || '') ? 'PASS' : 'FAIL', h['content-type']);

  /* ------------------------------------------- 7. no open redirect */
  // A 200 with the dashboard is NOT a redirect: the invariant that matters is
  // that no response carries a Location header and nothing is fetched from the
  // off-site host. Protocol-relative targets are refused outright (403).
  for (const p of ['//evil.example.com/', '/\\evil.example.com', '/%2f%2fevil.example.com', '/?next=https://evil.example.com']) {
    const res = await raw(handle.port, `GET ${p} HTTP/1.1\r\nHost: 127.0.0.1:${handle.port}\r\nConnection: close\r\n\r\n`);
    const head = res.split('\r\n\r\n')[0];
    const code = /^HTTP\/1\.1 (\d+)/.exec(head)?.[1];
    const hasLocation = /(^|\r\n)location\s*:/i.test(head);
    const is3xx = /^HTTP\/1\.1 30\d/.test(head);
    const offsiteTarget = p.startsWith('//') || p.startsWith('/\\') || p.startsWith('/%2f%2f');
    // The security invariant is: no Location header, no 3xx, and nothing from
    // the off-site host. An off-site authority must also not be served (200).
    const ok = !hasLocation && !is3xx && !(offsiteTarget && code === 200);
    record(`no open redirect via "${p.slice(0, 30)}"`, ok ? 'PASS' : 'FAIL',
      `status=${code} Location=${hasLocation} is3xx=${is3xx}`);
  }

  /* ------------------------ 8. the Node process opens no outbound socket */
  // Sample this process's TCP connections while the server is live.
  const pid = process.pid;
  let sockets = [];
  try {
    let cmd, args;
    if (process.platform === 'win32') {
      cmd = 'cmd.exe'; args = ['/d', '/c', 'netstat', '-ano'];
    } else {
      cmd = 'ss'; args = ['-tpn'];
    }
    const r = await pexec(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 60000 });
    sockets = r.stdout.split(/\r?\n/)
      .filter(l => l.includes(String(pid)))
      .map(l => l.trim().split(/\s+/));
  } catch (e) {
    record('per-process socket listing', 'BLOCKED', String(e.message).split('\n')[0]);
  }
  if (sockets.length) {
    // Windows netstat columns: Proto LocalAddr ForeignAddr State PID
    // Non-ESTABLISHED outbound entries would show a foreign address here.
    const loopbackOrListening = sockets.filter(cols => {
      const foreign = cols.find(c => /\d+\.\d+\.\d+\.\d+:\d+$|^\[?::1\]?:/.test(c) || /127\.0\.0\.1/.test(c));
      return !foreign || /127\.0\.0\.1|\[::1\]|::1/.test(foreign);
    });
    const externalConns = sockets.length - loopbackOrListening.length;
    record('process has no non-loopback TCP connections', externalConns === 0 ? 'PASS' : 'FAIL',
      `${sockets.length} socket row(s) for pid ${pid}, ${externalConns} non-loopback`);
    fs.writeFileSync(path.join(ART, 'process-sockets.txt'), sockets.join('\n'));
  }

  /* ------------------------------- 9. an unknown Host gets nothing useful */
  const bad = await raw(handle.port, 'GET /api/snapshot HTTP/1.1\r\nHost: evil.test\r\nConnection: close\r\n\r\n');
  record('foreign Host cannot read /api/snapshot either',
    /^HTTP\/1\.1 403/.test(bad) ? 'PASS' : 'FAIL',
    /^HTTP\/1\.1 (\d+)/.exec(bad)?.[1] || '?');
} finally {
  await handle.close();
}

const pass = results.filter(r => r.status === 'PASS').length;
const fail = results.filter(r => r.status === 'FAIL').length;
const blocked = results.filter(r => r.status === 'BLOCKED').length;
fs.writeFileSync(path.join(ART, 'results.json'), JSON.stringify({ results, pass, fail, blocked }, null, 2));
console.log(`\nSUMMARY  pass=${pass} fail=${fail} blocked=${blocked}`);
if (blocked) {
  console.error(
    `${blocked} network-posture check(s) could not run on this machine. They were not\n` +
    '      evaluated, so they cannot be reported as passing.'
  );
}
process.exit(fail || blocked ? 1 : 0);
void pathToFileURL;
