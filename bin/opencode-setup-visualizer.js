#!/usr/bin/env node
/**
 * opencode-setup-visualizer
 *
 * Discovers the local OpenCode setup and serves the existing dashboard with live
 * data injected. Read-only. Nothing leaves the machine.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';

import { buildSnapshot } from '../src/collect/index.js';
import { renderPage, TEMPLATE_PATH } from '../src/inject.js';
import { sanitize, assertClean, newReport, formatReport } from '../src/sanitize.js';
import { startServer } from '../src/server.js';

const USAGE = `
opencode-setup-visualizer — local, read-only view of your OpenCode setup

Usage: opencode-setup-visualizer [options]

Options:
  --port <n>       Port to listen on (default 4173; walks forward if busy)
  --project <dir>  Project directory to inspect (default: cwd)
  --no-open        Do not launch a browser
  --no-contents    Omit file bodies from the config inspector
  --json           Print the sanitized snapshot to stdout and exit
  --out <file>     Write a static sanitized HTML copy and exit
  -h, --help       Show this help

Reads only. Never writes to your OpenCode configuration.
`.trim();

/** Parse argv. Unknown flags are an error rather than being silently ignored. */
export function parseArgs(argv) {
  const out = {
    port: 4173, project: process.cwd(), open: true, contents: true,
    json: false, out: null, help: false, unknown: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--port': case '--project': case '--out': {
        // A flag with a missing or empty value is an error, not a silent default.
        const v = argv[++i];
        if (!v || v.startsWith('--')) { out.unknown.push(a); break; }
        if (a === '--port') out.port = Number(v);
        else if (a === '--project') out.project = v;
        else out.out = v;
        break;
      }
      case '--no-open': out.open = false; break;
      case '--no-contents': out.contents = false; break;
      case '--json': out.json = true; break;
      case '-h': case '--help': out.help = true; break;
      default:
        out.unknown.push(a);
    }
  }
  return out;
}

/** Open a URL with fixed argv. Never builds a command string. */
function openBrowser(url) {
  // The URL is passed already quoted: `start` re-parses its arguments.
  const table = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', `"${url}"`]]
    : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(table[0], table[1], { stdio: 'ignore', windowsHide: true, detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* opening a browser is best-effort */
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.unknown.length) {
    console.error(`Unknown argument(s): ${args.unknown.join(', ')}\n`);
    console.error(USAGE);
    return 2;
  }
  if (!/^\d+$/.test(String(args.port)) || !Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
    console.error(`Invalid --port: ${args.port} (expected a plain integer 1-65535)`);
    return 2;
  }

  const collectOpts = { projectDir: path.resolve(args.project) };

  // ---- one-shot modes ---------------------------------------------------
  if (args.json && args.out) {
    console.error('Pass either --json or --out, not both.');
    return 2;
  }
  if (args.json || args.out) {
    const t0 = Date.now();
    const raw = await buildSnapshot(collectOpts);
    const report = newReport();
    const clean = sanitize(raw, { report, contents: args.contents });
    assertClean(clean);

    if (args.json) {
      process.stdout.write(JSON.stringify(clean, null, 2) + '\n');
    } else {
      const html = renderPage(clean);
      const dest = path.resolve(args.out);
      // 'wx' fails rather than overwriting, so --out can never destroy a config
      // or an unrelated file by accident.
      try {
        fs.writeFileSync(dest, html, { encoding: 'utf8', flag: 'wx' });
      } catch (e) {
        if (e.code === 'EEXIST') {
          console.error(`Refusing to overwrite ${dest}. Choose a new path or delete it first.`);
          return 2;
        }
        throw e;
      }
      const counts = {
        agents: clean.agents.length, skills: clean.skills.length,
        plugins: clean.plugins.length, providers: clean.providers.length,
        models: clean.providers.reduce((a, p) => a + p.models, 0),
        mcps: clean.mcps.length, commands: clean.commands.length,
        warnings: clean.warnings.length, configs: clean.configs.length,
      };
      console.error(`Wrote ${dest}`);
      console.error(
        `Contains: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}\n` +
        `Config bodies: ${args.contents ? 'included (sanitized)' : 'hidden'}\n` +
        'This file is sanitized and shareable, but review it before publishing.'
      );
    }
    console.error(formatReport(report));
    console.error(`Collected in ${Date.now() - t0}ms`);
    return 0;
  }

  // ---- server mode ------------------------------------------------------
  const handle = await startServer({
    port: args.port,
    collectOpts,
    contents: args.contents,
    templatePath: TEMPLATE_PATH,
  });

  console.log(`opencode-setup-visualizer listening on ${handle.url}`);
  console.log(`  project : ${collectOpts.projectDir}`);
  console.log(`  contents: ${args.contents ? 'included (sanitized)' : 'hidden'}`);
  console.log('  Press Ctrl+C to stop.');
  if (!fs.existsSync(TEMPLATE_PATH)) {
    console.error(`  WARNING: template not found at ${TEMPLATE_PATH}`);
  }

  if (args.open) openBrowser(handle.url);

  const shutdown = () => {
    console.log('\nShutting down.');
    handle.close().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep the process alive.
  await new Promise(() => {});
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) {
  main().then(code => {
    if (code !== 0) process.exit(code);
  }).catch(err => {
    console.error(`fatal: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}

export { main, USAGE };
