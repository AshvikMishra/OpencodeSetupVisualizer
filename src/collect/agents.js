/**
 * Agents collector.
 *
 * Primary source: `opencode api get /api/agent`, which handles its own auth
 * (verified: needs no service password). Shape observed on this machine:
 *   { location, data: [{ id, name, description, mode, hidden, system?,
 *                        request:{body:{}}, permissions:[{action,resource,effect}] }] }
 *
 * `system` is the agent prompt. It is NEVER emitted â€” only `description` is.
 */
import { runOpencodeJson } from '../exec.js';
import { listFilesRecursive, readFileSafe } from './context.js';
import path from 'node:path';

const VALID_MODES = new Set(['primary', 'subagent']);

/** `read:*.env.example` is a permission carve-out, not a grant of the read tool. */
function isEnvExampleCarveOut(p) {
  return p.action === 'read' && /\.env(\.example)?$/i.test(String(p.resource || ''));
}

/**
 * Derive an explicit tool list.
 *
 * Only reported when the agent denies `*:*` â€” in that case the remaining named
 * allow-entries ARE the real tool set. Otherwise the agent inherits everything
 * except its denies and `null` is the honest answer.
 */
function deriveTools(permissions) {
  const deniesEverything = permissions.some(
    p => p.action === '*' && p.resource === '*' && p.effect === 'deny'
  );
  if (!deniesEverything) return null;
  const names = new Set();
  for (const p of permissions) {
    if (p.effect !== 'allow') continue;
    if (p.action === '*' || p.action === 'external_directory') continue;
    if (isEnvExampleCarveOut(p)) continue;
    names.add(p.action);
  }
  return names.size ? [...names] : null;
}

/** A permission missing its action must not render as the literal "undefined:*". */
function fmtPerm(p) {
  const action = typeof p.action === 'string' ? p.action.trim() : '';
  const resource = p.resource === undefined || p.resource === null ? '*' : String(p.resource);
  return `${action || '*'}:${resource}`;
}

/** Only a real string description may reach the card; objects must not stringify. */
function safeText(v, fallback) {
  if (typeof v === 'string' && v.trim()) return v;
  return fallback;
}

function normalizeAgent(raw, sourceLabel) {
  const permissions = Array.isArray(raw.permissions) ? raw.permissions : [];
  const body = (raw.request && raw.request.body) || {};
  const model = typeof body.model === 'string' && body.model.trim() ? body.model : 'unset (inherits session default)';
  const provider =
    typeof body.provider === 'string' && body.provider.trim() ? body.provider : 'unset';

  const id = safeText(raw.id, '') || 'unnamed';
  return {
    id,
    name: safeText(raw.name, '') || id || 'Unnamed',
    mode: VALID_MODES.has(raw.mode) ? raw.mode : 'primary',
    visible: raw.hidden !== true,
    builtIn: true,
    role: safeText(raw.description, 'No description provided.'),
    model,
    provider,
    tools: deriveTools(permissions),
    deny: permissions.filter(p => p.effect === 'deny').map(fmtPerm),
    ask: permissions.filter(p => p.effect === 'ask').map(fmtPerm),
    permCount: permissions.length,
    source: sourceLabel,
  };
}

/** Look for user-authored agent markdown files. Used only for the builtIn flag. */
function findCustomAgentFiles(ctx) {
  const roots = [ctx.projectLocalDir, path.join(ctx.globalDir, 'agent')].filter(Boolean);
  const found = [];
  for (const root of roots) {
    for (const f of listFilesRecursive(root, { maxDepth: 2, maxFiles: 100 }).files) {
      if (/\.(md|markdown)$/i.test(f)) found.push(f);
    }
  }
  return found;
}

/**
 * Filesystem fallback: parse agent markdown files with YAML frontmatter.
 * Deliberately minimal â€” we only report what the file states.
 */
function fallbackFromDisk(ctx) {
  const agents = [];
  const files = findCustomAgentFiles(ctx);
  for (const file of files) {
    const name = path.basename(file).replace(/\.(md|markdown)$/i, '');
    const rel = ctx.projectDir && file.startsWith(ctx.projectDir)
      ? ctx.projectDisplay(file)
      : ctx.display(file);
    let mode = 'primary';
    let description = '';
    const read = readFileSafe(file, 256 * 1024);
    if (read.ok) {
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(read.text);
      if (fm) {
        const modeLine = /^\s*mode\s*:\s*(\S+)\s*$/mi.exec(fm[1]);
        if (modeLine && VALID_MODES.has(modeLine[1])) mode = modeLine[1];
        const dLine = /^\s*description\s*:\s*(.+)$/mi.exec(fm[1]);
        if (dLine) description = dLine[1].trim().replace(/^["']|["']$/g, '');
      }
    }
    agents.push({
      id: name,
      name,
      mode,
      visible: true,
      builtIn: false,
      role: description || 'No description found in the agent file.',
      model: 'unset (inherits session default)',
      provider: 'unset',
      tools: null,
      deny: [],
      ask: [],
      permCount: 0,
      source: ctx.display(file),
    });
  }
  return agents;
}

export async function collectAgents(ctx, deps = {}) {
  const runCliJson = deps.runOpencodeJson || runOpencodeJson;
  const res = await runCliJson('agent', { cwd: ctx.projectDir });

  if (res.ok && res.data && Array.isArray(res.data.data)) {
    const customFiles = findCustomAgentFiles(ctx);
    const customNames = new Set(
      customFiles.map(f => path.basename(f).replace(/\.(md|markdown)$/i, ''))
    );
    // An agent whose id matches a file on disk is user-authored, not built-in.
    const normalized = res.data.data.map(raw =>
      normalizeAgent(raw, customNames.has(String(raw.id || '')) ? 'custom agent file' : 'OpenCode built-in')
    );
    for (const a of normalized) {
      if (customNames.has(a.id)) {
        a.builtIn = false;
        a.source = 'custom agent file on disk';
      }
    }

    // The template resolves agents with ENTITIES.find(kind==='agent' && id===a.id),
    // so a duplicate id makes every agent after the first permanently
    // unreachable: its card renders but its drawer always shows the first one.
    // Collapse to the first and say so.
    const seenIds = new Set();
    const agents = [];
    const collisions = [];
    for (const a of normalized) {
      if (seenIds.has(a.id)) { collisions.push(a.id); continue; }
      seenIds.add(a.id);
      agents.push(a);
    }

    return {
      ok: true,
      agents,
      evidence: ['opencode api get /api/agent'],
      note: null,
      notes: collisions.length
        ? [`${collisions.length} duplicate agent id(s) resolved to a single entry: ${[...new Set(collisions)].join(', ')}.`]
        : [],
    };
  }

  // --- fallback -----------------------------------------------------------
  const agents = fallbackFromDisk(ctx);
  return {
    ok: agents.length > 0,
    agents,
    evidence: agents.length ? 'filesystem: .opencode/agent' : null,
    note:
      `Agents could not be read from the CLI (${res.reason || 'unknown reason'}). ` +
      (agents.length
        ? `Fell back to agent files on disk; ${agents.length} found. Built-in agents are NOT included, so this list is incomplete.`
        : 'No agent files were found on disk either. The agent inventory is empty and incomplete.'),
  };
}
