/**
 * Capture the README hero image.
 *
 * Uses the SYNTHETIC fixture, never a real setup. The live render contains a
 * real inventory of the maintainer's machine — actual skill names, the git URLs
 * their skills were installed from, model IDs — and this project promises that
 * nothing leaves the machine. A README is the one file that definitely leaves.
 *
 * Viewport-sized rather than --full-page: a 2400px strip is unreadable inline
 * and ~590 KB. The top of the page is the first impression anyway.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../src/server.js';
import { buildFixture, stubExec, cleanup } from '../test/fixtures/fixture.js';
import { available, openBrowser, closeBrowser, prepare, pw } from './pw.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'docs', 'dashboard.png');

if (!(await available())) {
  console.error('BLOCKED  playwright-cli unavailable; the README image was NOT captured.');
  process.exit(3);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });

const fixture = buildFixture('rich');
const handle = await startServer({
  port: Number(process.argv[2]) || 5188,
  collectOpts: { home: fixture.home, projectDir: fixture.project, deps: stubExec() },
});

try {
  await openBrowser('about:blank');
  await prepare(handle.url, { width: 1440, height: 940, settleMs: 4000 });
  await pw(['screenshot', '--filename', OUT], { allowFail: true });
  console.log(`captured ${path.relative(process.cwd(), OUT)} (${fs.statSync(OUT).size} bytes)`);
} finally {
  await closeBrowser();
  await handle.close();
  cleanup(fixture);
}