/**
 * Config inspector.
 *
 * Only an ALLOWLIST of filenames is read, from directories we already know.
 * Nothing is globbed, so a stray secret file is never picked up by accident.
 *
 * `service.json` / `auth.json` are SHAPE-ONLY: we read them solely to list key
 * names and emit a redacted stub. Values are never read into the snapshot.
 *
 * `--no-contents` is applied later, in the sanitizer, so this module always
 * produces the real body when asked for one.
 */
import { readFileSafe, isDir } from './context.js';
import path from 'node:path';
import { parseJsonc } from '../jsonc.js';

export const MAX_BODY_BYTES = 64 * 1024;

/** Allowlisted filenames, read at both global and project scope. */
const ALLOWLIST = [
  { file: 'opencode.json', lang: 'json', jsonc: true },
  { file: 'opencode.jsonc', lang: 'json', jsonc: true },
  { file: 'cli.json', lang: 'json', jsonc: true },
  { file: 'tui.json', lang: 'json', jsonc: true },
  { file: 'capabilities.json', lang: 'json', jsonc: true },
  { file: 'skill-sources.json', lang: 'json', jsonc: true },
  { file: 'skills-lock.json', lang: 'json', jsonc: true },
  { file: 'AGENTS.md', lang: 'md' },
  { file: 'CLAUDE.md', lang: 'md' },
  { file: 'GEMINI.md', lang: 'md' },
];

/** Credential stores: existence + key names only, never values. */
const SHAPE_ONLY = ['service.json', 'auth.json'];

/** Escape a string for literal use inside a RegExp. */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Truncate with a visible marker. */
function capBody(text) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= MAX_BODY_BYTES) return { body: text, bytes: buf.length, truncated: false };
  const clipped = buf.subarray(0, MAX_BODY_BYTES).toString('utf8');
  const marker = `\n\n… [truncated: ${buf.length} bytes total, showing first ${MAX_BODY_BYTES}]`;
  return { body: clipped + marker, bytes: buf.length, truncated: true };
}

/** Infer a value's JSON type so the stub stays informative without leaking it. */
function valueKind(text, key) {
  const re = new RegExp(`"${escapeRe(key)}"\\s*:\\s*(.+?)(?:\\s*[,}]|$)`, 's');
  const m = text.match(re);
  if (!m) return 'value';
  const raw = m[1].trim();
  if (raw.startsWith('"')) return 'string';
  if (raw === 'true' || raw === 'false') return 'boolean';
  if (raw.startsWith('{')) return 'object';
  if (raw.startsWith('[')) return 'array';
  if (/^-?\d/.test(raw)) return 'number';
  return 'value';
}

/** Redacted stub preserving key names and value types only. */
function shapeOnlyStub(text, keys) {
  if (!keys.length) return '{\n  /* keys could not be determined; values are never read */\n}';
  const lines = keys.map(
    k => `  "${k}": "<REDACTED — ${valueKind(text, k)} value, never read>"`
  );
  return `{\n${lines.join(',\n')}\n}`;
}

/**
 * Service bookkeeping keys that sit alongside real credentials in the same
 * file. They are named in the store, so we report the key names, but calling
 * `id` or `pid` a credential overstates what is sensitive.
 */
const BOOKKEEPING_KEYS = new Set([
  'id', 'version', 'url', 'baseurl', 'pid', 'port', 'host', 'name',
  'created', 'createdat', 'updated', 'updatedat', 'started', 'startedat',
  'pidfile', 'schema', 'type', 'kind', 'enabled', 'platform', 'arch',
]);

/** Read a secret-store file for its key names only. Returns null if absent. */
function readShapeOnly(ctx, full) {
  const read = readFileSafe(full, 1024 * 1024);
  if (!read.ok) return null;
  let keys = [];
  let parseNote = '';
  try {
    keys = Object.keys(parseJsonc(read.text));
  } catch (e) {
    parseNote = ` It could not be parsed (${e.message}), so key names are unknown.`;
  }

  // Separate actual credential keys from service bookkeeping, using the same
  // classifier the sanitizer uses so the two agree.
  const credentialKeys = keys.filter(k => !BOOKKEEPING_KEYS.has(k.toLowerCase()));
  const otherKeys = keys.filter(k => BOOKKEEPING_KEYS.has(k.toLowerCase()));

  const keySummary = credentialKeys.length
    ? `${credentialKeys.length} credential key(s): ${credentialKeys.join(', ')}`
    : 'no credential-shaped key names (bookkeeping fields only)';
  const otherNote = otherKeys.length
    ? ` Also present, not credentials: ${otherKeys.join(', ')}.`
    : '';

  return {
    path: ctx.display(full),
    bytes: read.bytes,
    keys,
    credentialKeys,
    body: shapeOnlyStub(read.text, keys),
    note:
      `SHAPE ONLY. Credential store with ${keySummary}.${otherNote} ` +
      `Values are never read, never logged and never emitted.${parseNote}`,
  };
}

/** Build a configs[] entry from an allowlisted file. */
function readConfigEntry(ctx, dir, spec, scopeLabel) {
  const full = path.join(dir, spec.file);
  const read = readFileSafe(full, 8 * 1024 * 1024);
  if (!read.ok) return null;

  const prefix = scopeLabel === 'project' ? 'project/' : '';
  const id = `${scopeLabel}-${spec.file.replace(/\.(md|jsonc?)$/i, '')}`.toLowerCase();

  const { body, bytes } = capBody(read.text);
  let note;
  if (spec.jsonc) {
    try {
      parseJsonc(read.text);
      note = 'Parsed as JSONC. Comments and trailing commas are supported.';
    } catch (e) {
      note = `Stored as JSONC but did not parse (${e.message}). Shown verbatim.`;
    }
  } else {
    note = 'Markdown, shown verbatim.';
  }

  return {
    id,
    name: `${prefix}${spec.file}`,
    path: ctx.display(full),
    bytes,
    lang: spec.lang,
    note,
    body,
  };
}

export function collectConfigs(ctx) {
  const configs = [];
  const notes = [];
  const shapeNotes = [];

  for (const { dir, label } of [
    { dir: ctx.globalDir, label: 'global' },
    { dir: ctx.projectDir, label: 'project' },
  ]) {
    if (!isDir(dir)) continue;
    for (const spec of ALLOWLIST) {
      const entry = readConfigEntry(ctx, dir, spec, label);
      if (entry) configs.push(entry);
    }
  }

  // Secret stores are not in the allowlist — they are added explicitly, and only
  // as a shape.
  for (const dir of [ctx.globalDir, ctx.stateDir]) {
    if (!isDir(dir)) continue;
    for (const name of SHAPE_ONLY) {
      const shape = readShapeOnly(ctx, path.join(dir, name));
      if (!shape) continue;
      configs.push({
        id: `shape-${name.replace(/\.json$/i, '')}-${dir === ctx.globalDir ? 'global' : 'state'}`,
        name: `${name} (shape only)`,
        path: shape.path,
        bytes: shape.bytes,
        lang: 'json',
        note: shape.note,
        body: shape.body,
      });
      shapeNotes.push(
        shape.credentialKeys.length
          ? `${shape.path} contains ${shape.credentialKeys.length} credential key(s): ${shape.credentialKeys.join(', ')}. Values were never read.`
          : `${shape.path} exists and is read for its key names only; it has no credential-shaped keys. Values were never read.`
      );
    }
  }

  if (!configs.length) {
    notes.push('No allowlisted configuration files were found in the global or project directories.');
  }

  // Credential-store detection is informational, not a collection problem, so it
  // is reported separately and never becomes an "unavailable source" warning.
  return { ok: true, configs, notes, shapeNotes };
}
