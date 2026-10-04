/**
 * Skills collector.
 *
 * Primary source: `opencode api get /api/skill` — returns
 *   { location, data: [{ id, name, description, path, content }] }
 *
 * `content` is the FULL SKILL.md body. It is used for exactly one thing: its
 * character length (the `chars` metric the dashboard reports). The body itself is
 * never placed in the snapshot. When a skill is not on disk in a location we can
 * read (builtin/plugin cache entries), we read only frontmatter + length.
 *
 * Scope is resolved by matching `path` against the known roots:
 *   builtin -> /builtin/...
 *   plugin  -> a plugin cache or plugin source tree
 *   local   -> <home>/.agents/skills, <home>/.config/opencode/skills
 *   project -> <project>/.opencode/skills
 * Any other scope would crash the template (SCOPE[s.scope]), so it is clamped.
 */
import { runOpencodeJson } from '../exec.js';
import { readFileSafe, isDir, listFilesRecursive } from './context.js';
import path from 'node:path';

const VALID_SCOPES = new Set(['builtin', 'plugin', 'local', 'project']);

/** Parse just the YAML frontmatter of a SKILL.md. No YAML dependency. */
export function parseFrontmatter(text) {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[^\S\n]*(?:\n|$)/.exec(text);
  if (!m) return { data: {}, bodyOffset: 0, hadFrontmatter: false };
  const block = m[1];
  const data = {};
  // Minimal flat key: value + list-item support. Good enough for skill metadata.
  const lines = block.split(/\r?\n/);
  let currentKey = null;
  for (const line of lines) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && currentKey) {
      if (!Array.isArray(data[currentKey])) data[currentKey] = [];
      data[currentKey].push(unquote(item[1]));
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const raw = kv[2].trim();
    currentKey = key;
    if (raw === '') {
      data[key] = [];
    } else if (raw.startsWith('[') && raw.endsWith(']')) {
      data[key] = raw
        .slice(1, -1)
        .split(',')
        .map(s => unquote(s.trim()))
        .filter(Boolean);
    } else {
      data[key] = unquote(raw);
    }
  }
  return { data, bodyOffset: m[0].length, hadFrontmatter: true };
}

function unquote(s) {
  const t = String(s).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * autoinvoke=false when frontmatter disables model invocation, either via
 * `disable-model-invocation` or `metadata.opencode.autoinvoke=false`.
 */
export function isAutoinvokeDisabled(fm) {
  if (fm['disable-model-invocation'] === true) return true;
  const t = String(fm['disable-model-invocation'] ?? '').toLowerCase();
  if (t === 'true') return true;
  const meta = fm.metadata;
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const oc = meta.opencode;
    if (oc && typeof oc === 'object' && oc.autoinvoke === false) return true;
  }
  return false;
}

/** Map an absolute or virtual skill path to one of the four legal scopes. */
export function scopeFor(skillPath, ctx) {
  const p = String(skillPath || '');
  if (p.startsWith('/builtin/') || p.startsWith('builtin/')) return 'builtin';
  const norm = p.replace(/\\/g, '/').toLowerCase();
  const roots = [
    [ctx.projectLocalDir, 'project'],
    [ctx.globalDir, 'local'],
    [ctx.agentsSkillDir, 'local'],
  ];
  for (const [root, scope] of roots) {
    if (!root) continue;
    const r = String(root).replace(/\\/g, '/').toLowerCase();
    if (norm.startsWith(r)) return scope;
  }
  if (norm.includes('/.cache/opencode/') || norm.includes('node_modules/')) return 'plugin';
  return 'local';
}

/** Locate a skill's file on disk so we can read frontmatter + length only. */
function locateSkillFile(skillPath, ctx) {
  const p = String(skillPath || '');
  if (!p) return null;
  if (p.startsWith('/builtin/') || p.startsWith('builtin/')) return null; // not on disk
  if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/')) {
    // Already absolute — but only trust it if it is inside the home dir.
    const norm = p.replace(/\\/g, '/').toLowerCase();
    const home = String(ctx.homeDir).replace(/\\/g, '/').toLowerCase();
    return norm.startsWith(home) ? p : null;
  }
  // Relative: search the known skill roots by basename.
  const name = p.split(/[\\/]/).filter(Boolean).pop();
  if (!name) return null;
  const want = name.toLowerCase();
  for (const root of [ctx.projectLocalDir, ctx.globalSkillDir, ctx.agentsSkillDir, ctx.globalDir]) {
    if (!isDir(root)) continue;
    // Match ONLY the requested basename. Accepting any `SKILL.md` here made the
    // first one in the tree answer for every skill, so every skill could be
    // measured from the same unrelated file. A miss returns null, which the
    // caller reports as "size could not be measured" rather than guessing.
    const hits = listFilesRecursive(root, { maxDepth: 3, maxFiles: 400 }).files.filter(f =>
      path.basename(f).toLowerCase() === want
    );
    if (hits.length) return hits[0];
  }
  return null;
}

export async function collectSkills(ctx, deps = {}) {
  const runCliJson = deps.runOpencodeJson || runOpencodeJson;
  const res = await runCliJson('skill', { cwd: ctx.projectDir });

  if (!(res.ok && res.data && Array.isArray(res.data.data))) {
    return {
      ok: false,
      skills: [],
      evidence: null,
      note: null,
      notes: [
        `Skills could not be read from the CLI (${res.reason || 'unknown reason'}). ` +
        `The skill inventory is empty and incomplete.`,
      ],
    };
  }

  const skills = [];
  for (const raw of res.data.data) {
    const name = String(raw.name || raw.id || '').trim();
    if (!name) continue;

    // `chars` is ONE definition: the skill body, without frontmatter.
    // The API's `content` is already body-only. Measuring the whole file
    // instead would count the frontmatter twice, since the same frontmatter is
    // already charged to the always-resident "Skill metadata" row.
    let chars = typeof raw.content === 'string' ? raw.content.length : 0;
    let desc = typeof raw.description === 'string' ? raw.description : '';
    let fm = {};
    let note = null;

    const file = locateSkillFile(raw.path, ctx);
    if (file) {
      const read = readFileSafe(file, 4 * 1024 * 1024);
      if (read.ok) {
        const parsed = parseFrontmatter(read.text);
        fm = parsed.data;
        // Whole file MINUS the frontmatter block = the body.
        chars = Math.max(0, read.text.length - parsed.bodyOffset);
        if (fm.description && typeof fm.description === 'string') desc = fm.description;
      }
    } else if (!chars) {
      // Builtin skill with no on-disk copy and no content — be honest.
      note = 'Body not available; size could not be measured.';
    }

    const scope = VALID_SCOPES.has(scopeFor(raw.path, ctx)) ? scopeFor(raw.path, ctx) : 'local';
    // The CLI reports the authoritative value; frontmatter is the fallback
    // for when it does not. Never silently claim a skill is invocable.
    const autoinvoke = typeof raw.autoinvoke === "boolean"
      ? raw.autoinvoke
      : !isAutoinvokeDisabled(fm);

    skills.push({
      name,
      scope,
      status: autoinvoke ? 'active' : 'inactive',
      chars,
      descChars: desc.length,
      autoinvoke,
      desc: desc || 'No description provided.',
      path: raw.path ? ctx.display(raw.path) : '',
      ...(fm.version ? { version: String(fm.version) } : {}),
      ...(fm.source ? { source: String(fm.source) } : {}),
      ...(note ? { note } : {}),
      ...(fm['disable-model-invocation'] !== undefined && !autoinvoke
        ? { note: 'Frontmatter disables model invocation — the model cannot invoke this skill.' }
        : {}),
    });
  }

  // Deduplicate by name, keeping the first (the CLI already resolves shadowing,
  // but be defensive so the dashboard does not show duplicates).
  const seen = new Set();
  const deduped = [];
  const dupes = [];
  for (const s of skills) {
    if (seen.has(s.name)) {
      dupes.push(s.name);
      continue;
    }
    seen.add(s.name);
    deduped.push(s);
  }

  return {
    ok: true,
    skills: deduped,
    evidence: ['opencode api get /api/skill'],
    duplicates: dupes,
    note: null,
    notes: dupes.length
      ? [`${dupes.length} duplicate skill name(s) resolved to a single path: ${dupes.join(', ')}.`]
      : [],
  };
}
