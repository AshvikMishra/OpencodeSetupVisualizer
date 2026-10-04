/**
 * Verified findings.
 *
 * Every entry here is produced by actually checking something — a file on disk
 * or a command that was run. There are no hand-written findings. If a check
 * cannot run because its input is missing, no warning is emitted.
 *
 * Secret-bearing checks report KEY NAMES ONLY, never values.
 */
import { readFileSafe, isFile, isDir } from './context.js';
import path from 'node:path';
import { parseJsonc } from '../jsonc.js';
import { classifyKey } from '../sanitize.js';

/** Walk a parsed object and return credential-shaped key paths. */
export function findSecretKeys(node, pathPrefix = '', depth = 0, out = []) {
  if (depth > 8 || node === null || typeof node !== 'object') return out;
  for (const [k, v] of Object.entries(node)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    const here = pathPrefix ? `${pathPrefix}.${k}` : k;
    const kind = classifyKey(k);
    if (kind && kind !== 'proto' && typeof v !== 'object') {
      out.push({ keyPath: here, key: k, kind });
    }
    if (v && typeof v === 'object') findSecretKeys(v, here, depth + 1, out);
  }
  return out;
}

/**
 * Capability router entries that point at a skill which is not installed.
 * Only runs when a capabilities-style file actually exists.
 */
function checkRouterCoverage(ctx, installedSkillNames) {
  const file = path.join(ctx.globalDir, 'capabilities.json');
  const read = readFileSafe(file, 2 * 1024 * 1024);
  if (!read.ok) return [];
  let cfg;
  try {
    cfg = parseJsonc(read.text);
  } catch (e) {
    return [{
      level: 'warn',
      title: 'capabilities.json could not be parsed',
      detail: `The routing table failed to parse (${e.message}), so its coverage cannot be verified.`,
      source: ctx.display(file),
    }];
  }

  const caps = cfg && typeof cfg.capabilities === 'object' ? cfg.capabilities : null;
  if (!caps) return [];

  const warnings = [];
  for (const [capName, entry] of Object.entries(caps)) {
    const covered = entry && Array.isArray(entry.covered_by) ? entry.covered_by : [];
    const missing = covered.filter(name => !installedSkillNames.has(name));
    if (missing.length) {
      warnings.push({
        level: 'warn',
        title: `Capability "${capName}" points at ${missing.length} uninstalled skill${missing.length > 1 ? 's' : ''}`,
        detail:
          `capabilities.json lists covered_by: ${missing.join(', ')}, but no SKILL.md for ` +
          `${missing.join(' or ')} was found in the global skills directory, the user skills directory, ` +
          `or the plugin cache. Routing this capability will report it as covered and then fail at invoke time.`,
        source: ctx.display(file),
      });
    }
  }
  return warnings;
}

/** Credential keys stored in plaintext in a config file. Names only. */
function checkPlaintextSecrets(ctx, configFiles) {
  const warnings = [];
  for (const { name, full } of configFiles) {
    if (!isFile(full)) continue;
    if (/^(service|auth)\.json$/i.test(name)) continue; // shape-only by design
    const read = readFileSafe(full, 2 * 1024 * 1024);
    if (!read.ok) continue;
    let parsed;
    try {
      parsed = parseJsonc(read.text);
    } catch {
      continue; // malformed JSON: not our business to flag as a secret leak
    }
    const hits = findSecretKeys(parsed);
    if (!hits.length) continue;
    const kinds = [...new Set(hits.map(h => h.kind))];
    warnings.push({
      level: 'warn',
      title: `${name} stores ${hits.length} credential-shaped key(s) in plaintext`,
      detail:
        `Found key(s) ${hits.slice(0, 8).map(h => h.keyPath).join(', ')}` +
        `${hits.length > 8 ? `, and ${hits.length - 8} more` : ''} in a file that is shown in full on ` +
        `this dashboard. Values are withheld here, but consider an environment variable or a credential ` +
        `store if this file is ever shared or synced.`,
      source: ctx.display(full),
    });
    void kinds;
  }
  return warnings;
}

/** Duplicate skill names across scopes. */
function checkDuplicateSkills(skills) {
  const byName = new Map();
  for (const s of skills) {
    if (!byName.has(s.name)) byName.set(s.name, []);
    byName.get(s.name).push(s);
  }
  const dupes = [...byName.entries()].filter(([, list]) => list.length > 1);
  if (!dupes.length) return [];
  return [{
    level: 'info',
    title: `${dupes.length} skill name${dupes.length > 1 ? 's resolve' : ' resolves'} from more than one path`,
    detail:
      dupes.map(([name, list]) =>
        `"${name}" appears at ${list.map(s => s.path).join(' and ')}; only the first resolution is counted.`
      ).join(' '),
    source: 'opencode api get /api/skill',
  }];
}

/** MCP servers present in config but not reported by the CLI. */
function checkMcpMismatch(configFiles, mcps, listedNames) {
  if (!Array.isArray(listedNames)) return [];
  const apiNames = new Set(mcps.map(m => String(m.name).toLowerCase()));
  const listNames = new Set(listedNames.map(n => String(n).toLowerCase()));
  if (!apiNames.size && !listNames.size) return [];

  const onlyApi = [...apiNames].filter(n => !listNames.has(n));
  const onlyList = [...listNames].filter(n => !apiNames.has(n));
  if (!onlyApi.length && !onlyList.length) return [];

  const parts = [];
  if (onlyApi.length) parts.push(`The API endpoint reports ${onlyApi.join(', ')} but \`opencode mcp list\` does not.`);
  if (onlyList.length) parts.push(`\`opencode mcp list\` reports ${onlyList.join(', ')} but the API endpoint does not.`);

  return [{
    level: 'warn',
    title: 'MCP server list disagrees between the API and the CLI',
    detail:
      `${parts.join(' ')} One of the two sources is stale, so the MCP section may be incomplete. ` +
      `Re-run with the service stopped and started to reconcile them.`,
    source: 'opencode api get /api/mcp vs opencode mcp list',
  }];
}

/** Skills with no autoinvoke frontmatter, so the model cannot reach them. */
function checkNonInvocable(skills) {
  const blocked = skills.filter(s => s.autoinvoke === false);
  if (!blocked.length) return [];
  return [{
    level: 'info',
    title: `${blocked.length} skill${blocked.length > 1 ? 's are' : ' is'} user-invoke only`,
    detail:
      `${blocked.map(s => s.name).join(', ')} set disable-model-invocation or ` +
      `metadata.opencode.autoinvoke=false in frontmatter, so the model will never select them on its own.`,
    source: 'SKILL.md frontmatter',
  }];
}

export function collectWarnings(ctx, { skills = [], mcps = [], listedNames = [], configFiles = [] } = {}) {
  const warnings = [];

  const safePush = fn => {
    try {
      warnings.push(...fn());
    } catch (e) {
      warnings.push({
        level: 'info',
        title: 'A verification check could not complete',
        detail: `${fn.name} threw: ${e.message}. No conclusion was drawn.`,
        source: 'collector',
      });
    }
  };

  safePush(() => checkRouterCoverage(ctx, new Set(skills.map(s => s.name))));
  safePush(() => checkPlaintextSecrets(ctx, configFiles));
  safePush(() => checkDuplicateSkills(skills));
  safePush(() => checkMcpMismatch(configFiles, mcps, listedNames));
  safePush(() => checkNonInvocable(skills));

  void isDir;
  return { ok: true, warnings };
}
