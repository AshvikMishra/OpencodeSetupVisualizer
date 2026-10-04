/**
 * Plugins collector.
 *
 * Sources:
 *   - `opencode plugin list` -> TSV of ID / VERSION / SOURCE (verified).
 *   - the declared `plugins[]` array in opencode.json, for the declaration site.
 *   - the plugin cache directory, to enumerate the skills each plugin provides.
 *
 * A plugin's skill list is derived by finding SKILL.md files under its resolved
 * cache directory, so `provides` is measured rather than guessed.
 */
import { runOpencode } from '../exec.js';
import { readFileSafe, readDirSafe, isDir, listFilesRecursive } from './context.js';
import path from 'node:path';
import { parseJsonc } from '../jsonc.js';

/** Parse the `opencode plugin list` table. */
export function parsePluginList(text) {
  const rows = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const cols = line.split(/\t+|\s{2,}/).map(c => c.trim()).filter(Boolean);
    if (!cols.length) continue;
    if (/^id$/i.test(cols[0]) && /^version$/i.test(cols[1] || '')) continue; // header
    rows.push({ name: cols[0], version: cols[1] || '', source: cols.slice(2).join(' ') });
  }
  return rows;
}

/** Read `plugins[]` from a config object. Strings only, values never logged. */
function declaredPlugins(config) {
  if (!config || typeof config !== 'object') return [];
  const arr = config.plugins;
  if (!Array.isArray(arr)) return [];
  return arr.filter(p => typeof p === 'string' && p.trim());
}

/**
 * Locate a plugin's installed copy in the npm cache.
 *
 * Layout (verified on this machine):
 *   <cache>/npm/git-<name>-<hash>/<timestamp>/node_modules/<name>
 * The timestamp level is nested, so this descends two levels rather than
 * assuming a flat <cache>/npm/<dir>/node_modules layout.
 */
function resolvePluginDir(ctx, name) {
  const npmRoot = path.join(ctx.cacheDir, 'npm');
  if (!isDir(npmRoot)) return null;
  for (const ent of readDirSafe(npmRoot)) {
    if (!ent.isDirectory()) continue;
    const level1 = path.join(npmRoot, ent.name);
    // Flat layout: <npm>/<dir>/node_modules/<name>
    const nested = path.join(level1, 'node_modules', name);
    if (isDir(nested)) return nested;
    // Nested layout: <npm>/<dir>/<timestamp>/node_modules/<name>
    for (const inner of readDirSafe(level1)) {
      if (!inner.isDirectory()) continue;
      const deeper = path.join(level1, inner.name, 'node_modules', name);
      if (isDir(deeper)) return deeper;
    }
  }
  return null;
}

/** Enumerate skill names a plugin provides, by finding its SKILL.md files. */
function pluginSkillNames(dir) {
  if (!dir || !isDir(dir)) return [];
  const names = [];
  for (const f of listFilesRecursive(dir, { maxDepth: 5, maxFiles: 400 }).files) {
    if (path.basename(f).toLowerCase() !== 'skill.md') continue;
    const parent = path.basename(path.dirname(f));
    if (parent && parent !== 'skills') names.push(parent);
  }
  return [...new Set(names)].sort();
}

/**
 * A plugin spec may be a bare name ("superpowers") or a full spec
 * ("superpowers@git+https://github.com/obra/superpowers.git"). Both name the
 * same plugin, so they are collapsed to one entity keyed on the bare name.
 */
export function barePluginName(spec) {
  const s = String(spec || '').trim();
  const at = s.indexOf('@', 1); // skip a leading '@' for scoped packages
  return at > 0 ? s.slice(0, at) : s;
}

export async function collectPlugins(ctx, deps = {}) {
  const runCli = deps.runOpencode || runOpencode;
  const evidence = [];
  const notes = [];

  const listRes = await runCli('pluginList', { cwd: ctx.projectDir });
  let rows = [];
  if (listRes.ok) {
    evidence.push('opencode plugin list');
    rows = parsePluginList(listRes.stdout);
  } else {
    notes.push(`opencode plugin list failed (${listRes.reason || 'unknown reason'}).`);
  }

  // Declared plugins come from config; this also covers the case where the CLI
  // could not run at all.
  const cfgRead = readFileSafe(path.join(ctx.globalDir, 'opencode.json'), 512 * 1024);
  let declared = [];
  if (cfgRead.ok) {
    try {
      declared = declaredPlugins(parseJsonc(cfgRead.text));
    } catch (e) {
      notes.push(`opencode.json could not be parsed: ${e.message}`);
    }
    evidence.push('opencode.json');
  }

  // Key everything by the bare name so a CLI row and a config entry for the
  // same plugin merge into one entity instead of two.
  const byName = new Map();
  for (const d of declared) {
    const n = barePluginName(d);
    if (n && !byName.has(n)) byName.set(n, { name: n, declared: d, row: null });
  }
  for (const r of rows) {
    const n = barePluginName(r.name);
    const existing = byName.get(n);
    if (existing) existing.row = r;
    else byName.set(n, { name: n, declared: null, row: r });
  }

  const plugins = [...byName.values()].map(({ name, declared: decl, row }) => {
    const dir = resolvePluginDir(ctx, name);
    const provides = pluginSkillNames(dir);
    return {
      name,
      version: row?.version || 'unknown',
      commit: '',
      status: 'active',
      source: row?.source || decl || 'unknown',
      declaredIn: decl ? 'opencode.json → plugins[]' : 'not declared in opencode.json',
      entry: `.opencode/plugins/${name}.js`,
      resolved: dir ? ctx.display(dir) : 'not resolved to a local cache directory',
      skillCount: provides.length,
      provides,
      note: provides.length
        ? null
        : 'No SKILL.md files were found for this plugin in the local cache, so the skills it provides could not be enumerated.',
    };
  });

  for (const p of plugins) if (p.note) notes.push(`${p.name}: ${p.note}`);

  return {
    ok: listRes.ok || declared.length > 0,
    plugins,
    evidence,
    notes,
  };
}
