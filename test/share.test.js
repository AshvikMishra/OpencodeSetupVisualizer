/**
 * The Share button must hand over the WHOLE snapshot.
 *
 * It previously copied `configs[].body` for `opencode.json` alone — 139 bytes
 * — while presenting itself as "share your setup". These assertions run the
 * template's own functions through the browser stub, so they test the shipped
 * code rather than a copy of it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildSnapshot } from '../src/collect/index.js';
import { sanitize, newReport } from '../src/sanitize.js';
import { renderPage, TEMPLATE_PATH } from '../src/inject.js';
import { createBrowserStub } from './helpers/browser-stub.js';
import vm from 'node:vm';

const HOME = process.env.USERPROFILE || process.env.HOME;

/** Run the template's script and hand back the share functions it defines. */
function shareApi(snapshot) {
  const html = renderPage(snapshot, TEMPLATE_PATH);
  const { documentStub, windowStub, navigatorStub } = createBrowserStub();
  // Find the INJECTED script — the one holding the snapshot — rather than the
  // first <script> on the page, which is the Tailwind CDN tag. Tolerate CRLF:
  // an earlier regex hard-coded \n and silently matched nothing.
  const blocks = [...html.matchAll(/<script[^>]*>\r?\n([\s\S]*?)\r?\n<\/script>/g)];
  const injected = blocks.map(b => b[1]).find(code => /const SNAPSHOT\s*=/.test(code));
  assert.ok(injected, `could not locate the injected script block (found ${blocks.length} script blocks)`);
  const code = injected;

  // Names the template declares as top-level functions.
  const wanted = ['sharePayload', 'sharePromptText', 'bodiesHidden', 'downloadSnapshot', 'openShare'];
  const factory = new vm.Script(
    `(function(){ ${code}\n; return { ${wanted.join(', ')} }; })()`,
    { filename: 'template-share.js' }
  );

  const created = [];
  const context = vm.createContext({
    document: documentStub,
    window: windowStub,
    navigator: navigatorStub,
    matchMedia: windowStub.matchMedia,
    lucide: windowStub.lucide,
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, URL, Intl, Blob: class { constructor() {} },
  });
  context.globalThis = context;
  const api = factory.runInContext(context);
  created.push(api);
  return { api, documentStub, context };
}

/** buildSnapshot is async: awaiting it matters, or sanitize() runs on a Promise. */
async function realSnapshot() {
  const snap = await buildSnapshot({ home: HOME });
  return sanitize(snap, { report: newReport(), contents: true });
}

test('the share payload is the entire snapshot, byte for byte', async () => {
  const snap = await realSnapshot();
  const { api } = shareApi(snap);
  const p = api.sharePayload();
  assert.equal(p.ok, true, `payload unavailable: ${p.why}`);
  assert.deepEqual(JSON.parse(p.json), JSON.parse(JSON.stringify(snap)),
    'the share payload must equal the snapshot exactly');
  assert.ok(Object.keys(JSON.parse(p.json)).length > 2,
    'the payload must not be a bare config object');
});

test('the payload is far bigger than a single config file', async () => {
  const snap = await realSnapshot();
  const { api } = shareApi(snap);
  const p = api.sharePayload();
  const biggestConfig = Math.max(0, ...(snap.configs || []).map(c => (c.bytes || 0)));
  assert.ok(p.bytes > biggestConfig * 2,
    `payload ${p.bytes} B is not meaningfully larger than the largest config ${biggestConfig} B`);
  assert.ok(p.bytes > 5000, `payload is only ${p.bytes} B — that is not a setup`);
});

test('the payload carries the inventory, not just config bodies', async () => {
  const snap = await realSnapshot();
  const { api } = shareApi(snap);
  const got = JSON.parse(api.sharePayload().json);
  assert.ok(Array.isArray(got.agents) && got.agents.length > 0, 'agents missing from payload');
  assert.ok(Array.isArray(got.skills) && got.skills.length > 0, 'skills missing from payload');
  assert.ok(Array.isArray(got.providers) && got.providers.length > 0, 'providers missing from payload');
  assert.ok(got.context, 'context overhead missing from payload');
});

test('a full snapshot is reported as complete, not partial', async () => {
  const snap = await realSnapshot();
  const { api } = shareApi(snap);
  const p = api.sharePayload();
  assert.equal(p.partial, false, 'a normal run must not be labelled partial');
  assert.equal(api.bodiesHidden(), false);
});

test('--no-contents is allowed and labelled partial, not refused', async () => {
  // The old behaviour refused to share at all, which threw away the inventory
  // (skill names, plugin sources, models, costs) along with the file bodies.
  const snap = await realSnapshot();
  snap.configs = (snap.configs || []).map(c => ({ ...c, body: '(contents hidden — re-run without --no-contents)' }));
  const { api } = shareApi(snap);
  const p = api.sharePayload();
  assert.equal(p.ok, true, 'a partial snapshot must still be shareable');
  assert.equal(p.partial, true, 'it must be labelled partial');
  assert.match(p.counts, /config file\(s\)/);
  assert.ok(p.bytes > 5000, 'the inventory must survive even without bodies');
});

test('the prompt asks for a setup like this one, not one config file', async () => {
  const snap = await realSnapshot();
  const { api } = shareApi(snap);
  const t = api.sharePromptText(api.sharePayload());
  // Assert on phrases unique to the NEW prompt. A loose /snapshot/i also matches
  // a line further down, so it passed even with the old intro restored — which
  // is exactly what the mutation harness caught.
  assert.match(t, /roughly this shape/i, 'the prompt must ask for a setup of this shape');
  assert.match(t, /a real, working OpenCode setup/i);
  assert.match(t, /```json/);
  assert.match(t, /agent\(s\)/);
  assert.ok(!/Write the JSON below to/.test(t),
    'the old prompt was instructions for writing one config file');
  assert.ok(!/Reproduce this OpenCode configuration on another machine/.test(t),
    'the old prompt framing is still present');
  assert.match(t, /absent/i, 'the prompt must forbid inventing missing resources');
});

test('the prompt discloses that bodies are missing when partial', async () => {
  const snap = await realSnapshot();
  snap.configs = (snap.configs || []).map(c => ({ ...c, body: '(contents hidden — re-run without --no-contents)' }));
  const { api } = shareApi(snap);
  const t = api.sharePromptText(api.sharePayload());
  assert.match(t, /--no-contents/, 'a partial share must say what is missing');
});

test('the share payload carries no username or internal URL', async () => {
  // The snapshot is about to be handed to someone else, so this is checked on
  // the exact bytes the button copies.
  const snap = await realSnapshot();
  const { api } = shareApi(snap);
  const json = api.sharePayload().json;
  const homeName = path.basename(HOME);
  assert.ok(homeName.length >= 3);
  assert.ok(!json.includes(homeName), 'the payload leaks the OS username');
  assert.ok(!json.includes(HOME), 'the payload leaks the home directory');

  // Match HOSTS, not substrings. A naive `.local` test fires on the standard
  // XDG path `~/.local/state/opencode`, which is public and expected.
  const HOST_IN_URL = /\b(?:https?:\/\/|git@|ssh:\/\/)([^\s/:@'"\\,]+)/gi;
  const PRIVATE = [
    /^192\.168\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./,
    /\.local$/i, /\.internal$/i, /\.lan$/i, /\.corp$/i, /\.home$/i, /^localhost$/i,
  ];
  const hosts = [...json.matchAll(HOST_IN_URL)].map(m => m[1]);
  const bad = [...new Set(hosts.filter(h => PRIVATE.some(rx => rx.test(h))))];
  assert.deepEqual(bad, [], `the payload references internal hosts: ${bad.join(', ')}`);

  // Bare private IPv4 literals, no scheme required.
  const bare = [...new Set([...json.matchAll(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g)]
    .map(m => m[1])
    .filter(ip => PRIVATE.some(rx => rx.test(ip))))];
  assert.deepEqual(bare, [], `the payload contains private IP literals: ${bare.join(', ')}`);
});

test('the share sheet names what the snapshot actually leaks', () => {
  // The button's whole job is handing this inventory to someone else, so the
  // sheet must not imply it is "just your config file with secrets redacted".
  const html = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const at = html.indexOf('id="shareModal"');
  assert.ok(at > 0, 'could not locate the share modal markup');
  const modal = html.slice(at, at + 4000).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  for (const phrase of [/secret/i, /skill/i, /git URL/i, /model ID/i, /token cost/i]) {
    assert.match(modal, phrase,
      `the share sheet does not disclose ${phrase} — it must say what is included`);
  }
  assert.match(modal, /Nothing is uploaded/i);
});

test('a real but empty setup still shares; only a missing snapshot is refused', async () => {
  // `{}` is not a reachable state: the template dereferences SNAPSHOT.agents at
  // load, so the script throws before sharePayload() could ever see it. What IS
  // reachable is a user with nothing configured — every array present, all empty.
  const bare = {
    meta: { version: 'v0.0.0' },
    agents: [], skills: [], plugins: [], providers: [], mcps: [], commands: [],
    automation: [], configs: [], warnings: [], overview: [],
    context: { alwaysResident: [], onDemand: [], none: [], cacheFootprint: [] },
    project: { localSkills: [], localAgents: [], localPlugins: [], localMcps: [], localConfig: [] },
  };
  const { api } = shareApi(bare);
  const p = api.sharePayload();
  assert.equal(p.ok, true, 'an empty-but-valid setup is still shareable');
  assert.equal(p.partial, false);
  assert.match(p.counts, /0 agent\(s\)/);
  assert.deepEqual(JSON.parse(p.json), bare, 'the payload must round-trip unchanged');
});
