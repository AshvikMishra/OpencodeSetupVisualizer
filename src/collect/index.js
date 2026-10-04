/**
 * Collector orchestrator.
 *
 * Runs every source independently. One failing source never kills the run — it
 * degrades to an explicit "unavailable" note that ends up in the data, so the
 * dashboard renders an honest empty state instead of a blank page.
 */
import os from 'node:os';
import path from 'node:path';

import { runOpencode, runOpencodeJson, resolveOpencodeCommand } from '../exec.js';
import { makeContext, readFileSafe, isDir } from './context.js';
import { collectAgents } from './agents.js';
import { collectSkills } from './skills.js';
import { collectProviders } from './providers.js';
import { collectMcps } from './mcps.js';
import { collectPlugins } from './plugins.js';
import { collectCommands, collectAutomation } from './commands.js';
import { collectConfigs } from './configs.js';
import { collectProject } from './project.js';
import { collectContext } from './context-cost.js';
import { collectWarnings } from './warnings.js';

/** Run a collector defensively; a throw becomes an explicit unavailable result. */
async function guard(name, fn, fallback) {
  try {
    return await fn();
  } catch (e) {
    return {
      ...fallback,
      ok: false,
      notes: [...(fallback.notes || []), `${name} collector threw: ${e.message}`],
    };
  }
}

function hostString() {
  const plat = process.platform;
  if (plat === 'win32') {
    const rel = os.release();
    const major = parseInt(rel, 10);
    return `Windows ${major} · PowerShell`;
  }
  return `${os.type()} ${os.release()}`;
}

/** Compose the overview note for agents, matching the template's phrasing. */
function agentsNote(agents) {
  if (!agents.length) return 'none discovered';
  const primary = agents.filter(a => a.mode === 'primary').length;
  const sub = agents.filter(a => a.mode === 'subagent').length;
  const hidden = agents.filter(a => !a.visible).length;
  const bits = [`${primary} primary · ${sub} subagent`];
  if (hidden) bits.push(`${hidden} hidden`);
  return bits.join(' · ');
}

function skillsNote(skills) {
  if (!skills.length) return 'none discovered';
  const counts = { builtin: 0, plugin: 0, local: 0, project: 0 };
  for (const s of skills) counts[s.scope] = (counts[s.scope] || 0) + 1;
  return ['builtin', 'plugin', 'local', 'project']
    .filter(k => counts[k])
    .map(k => `${counts[k]} ${k}`)
    .join(' · ');
}

/**
 * Build a complete snapshot.
 *
 * @param {object} opts
 * @param {string} [opts.home]        override home directory (fixtures)
 * @param {string} [opts.projectDir]  project directory (default cwd)
 * @param {string} [opts.platform]    override platform (fixtures)
 * @param {object} [opts.deps]        injectable exec functions (fixtures)
 */
export async function buildSnapshot(opts = {}) {
  const projectDir = path.resolve(opts.projectDir || process.cwd());
  const ctx = makeContext({ home: opts.home, projectDir, platform: opts.platform });

  const deps = {
    runOpencode: opts.deps?.runOpencode || runOpencode,
    runOpencodeJson: opts.deps?.runOpencodeJson || runOpencodeJson,
  };

  const evidence = new Set();
  const problems = [];
  const collect = r => {
    // A collector may return a bare string (or accidentally a non-array) for
    // evidence. Accept a string, never spread one character at a time.
    const ev = r?.evidence;
    if (typeof ev === 'string') {
      if (ev) evidence.add(ev);
    } else if (Array.isArray(ev)) {
      for (const e of ev) if (typeof e === 'string' && e) evidence.add(e);
    }
    for (const n of r?.notes || []) if (typeof n === 'string' && n) problems.push(n);
  };

  // ---- CLI-independent sources (always attempted) ----------------------
  const commands = collectCommands(ctx);
  const automation = collectAutomation(ctx);
  const configs = collectConfigs(ctx);
  const project = collectProject(ctx);
  for (const n of configs.notes || []) problems.push(n);

  // ---- CLI sources, each isolated --------------------------------------
  const versionRes = await deps.runOpencode('version', { cwd: projectDir });
  let opencodeVersion = 'unknown';
  if (versionRes.ok) {
    evidence.add('opencode --version');
    const m = /v?(\d+\.\d+\.\d+[\w.+-]*)/.exec(versionRes.stdout.trim());
    opencodeVersion = m ? m[1] : versionRes.stdout.trim().replace(/^opencode\s*/i, '') || 'unknown';
  } else {
    problems.push(`Could not determine the OpenCode version (${versionRes.reason}).`);
  }

  const agentsRes = await guard('agents', () => collectAgents(ctx, deps), { agents: [], notes: [] });
  collect(agentsRes);
  if (!agentsRes.ok && agentsRes.note) problems.push(agentsRes.note);

  const skillsRes = await guard('skills', () => collectSkills(ctx, deps), { skills: [], notes: [] });
  collect(skillsRes); // pushes evidence + notes into problems
  if (!skillsRes.ok && skillsRes.note) problems.push(skillsRes.note);

  const providersRes = await guard('providers', () => collectProviders(ctx, deps), {
    providers: [], notes: [],
  });
  collect(providersRes);

  const mcpsRes = await guard('mcps', () => collectMcps(ctx, deps), { mcps: [], notes: [] });
  collect(mcpsRes);

  const pluginsRes = await guard('plugins', () => collectPlugins(ctx, deps), { plugins: [], notes: [] });
  collect(pluginsRes);

  // ---- derived sections ------------------------------------------------
  const contextRes = collectContext(ctx, {
    skills: skillsRes.skills,
    configs: configs.configs,
    // Pass the config entry itself so the aggregate can exclude it by path.
    agentsMd: configs.configs.find(c => /(^|\/)AGENTS\.md$/.test(c.path)) || null,
    // The "not present" rows must describe what was actually discovered, so
    // these two are threaded through rather than asserted as literal text.
    // `ok:false` means the collector failed, which is "not measured" — not zero.
    mcps: mcpsRes.ok && Array.isArray(mcpsRes.mcps) ? mcpsRes.mcps : null,
    project: project.ok ? project : null,
  });

  // Only real on-disk config files are handed to the plaintext-secret check;
  // the tokenised display paths cannot be re-read from the filesystem.
  const configFiles = [
    ...['opencode.json', 'opencode.jsonc', 'cli.json', 'tui.json', 'capabilities.json', 'skill-sources.json']
      .map(n => ({ name: n, full: path.join(ctx.globalDir, n) })),
    ...['opencode.json', 'opencode.jsonc', 'AGENTS.md']
      .map(n => ({ name: n, full: path.join(ctx.projectDir, n) })),
  ];

  const warningsRes = collectWarnings(ctx, {
    skills: skillsRes.skills,
    mcps: mcpsRes.mcps,
    listedNames: mcpsRes.listedNames,
    configFiles,
  });

  // Credential stores found on disk: informational, and explicitly NOT a
  // collection problem.
  for (const n of configs.shapeNotes || []) {
    warningsRes.warnings.push({
      level: 'info',
      title: 'A credential store is present on disk',
      detail: `${n} It is listed in the config inspector as a shape-only entry.`,
      source: 'filesystem',
    });
  }

  // ---- meta -------------------------------------------------------------
  const projectLocalCount =
    project.project.localSkills.length +
    project.project.localAgents.length +
    project.project.localPlugins.length +
    project.project.localMcps.length +
    project.project.localConfig.length;

  const meta = {
    generated: new Date().toISOString().slice(0, 10),
    opencodeVersion,
    versionEvidence: versionRes.ok ? 'opencode --version' : 'unavailable',
    host: hostString(),
    globalConfig: ctx.display(ctx.globalDir),
    projectRoot: ctx.projectDisplay(projectDir),
    projectScoped: projectLocalCount > 0,
    projectNote: project.project.note,
    stateDir: ctx.display(ctx.stateDir),
    installPath: ctx.display(path.join(ctx.globalDir, '..', '..', 'AppData', 'Roaming', 'npm', 'node_modules', '@opencode', 'cli')),
    apiEvidence: [...evidence],
  };

  if (problems.length) {
    meta.apiEvidence = [...evidence];
  }

  // ---- overview ---------------------------------------------------------
  const totalModels = providersRes.providers.reduce((a, p) => a + (p.models || 0), 0);
  const overview = [
    {
      key: 'agents', label: 'Agents', value: agentsRes.agents.length, of: agentsRes.agents.length,
      status: agentsRes.ok ? 'active' : 'inactive', note: agentsNote(agentsRes.agents),
      icon: 'bot', to: 'agents',
    },
    {
      key: 'skills', label: 'Skills', value: skillsRes.skills.length, of: skillsRes.skills.length,
      status: skillsRes.ok ? 'active' : 'inactive', note: skillsNote(skillsRes.skills),
      icon: 'sparkles', to: 'skills',
    },
    {
      key: 'mcps', label: 'MCP servers', value: mcpsRes.mcps.length, of: mcpsRes.mcps.length,
      status: mcpsRes.mcps.length ? 'active' : 'inactive',
      note: mcpsRes.mcps.length ? `${mcpsRes.mcps.length} configured` : 'none discovered',
      icon: 'plug', to: 'mcps',
    },
    {
      key: 'plugins', label: 'Plugins', value: pluginsRes.plugins.length, of: pluginsRes.plugins.length,
      status: pluginsRes.plugins.length ? 'active' : 'inactive',
      note: pluginsRes.plugins.map(p => p.name).join(', ') || 'none discovered',
      icon: 'package', to: 'plugins',
    },
    {
      key: 'providers', label: 'Providers', value: providersRes.providers.length, of: providersRes.providers.length,
      status: providersRes.providers.length ? 'active' : 'inactive',
      note: providersRes.providers.map(p => p.name).slice(0, 2).join(', ') || 'none discovered',
      icon: 'cloud', to: 'providers',
    },
    {
      key: 'models', label: 'Available models', value: totalModels, of: totalModels,
      status: totalModels ? 'active' : 'inactive',
      note: totalModels ? `${totalModels} across ${providersRes.providers.length} provider(s)` : 'none discovered',
      icon: 'cpu', to: 'providers',
    },
    {
      key: 'project', label: 'Project-local', value: projectLocalCount, of: projectLocalCount,
      status: projectLocalCount ? 'active' : 'inactive',
      note: projectLocalCount ? `${projectLocalCount} resource(s)` : 'no project-local config',
      icon: 'folder', to: 'project',
    },
  ];

  // ---- assemble ---------------------------------------------------------
  // Unavailable sources become warnings so the user sees them in the UI.
  // Deduplicated: several collectors often report the same missing CLI.
  const seenProblems = new Set();
  for (const p of problems) {
    const key = p.replace(/\s*\(.*\)\.?$/, '').trim();
    if (seenProblems.has(key)) continue;
    seenProblems.add(key);
    warningsRes.warnings.push({
      level: 'info',
      title: 'Some sources were unavailable during collection',
      detail: p,
      source: 'collector',
    });
  }

  return {
    meta,
    overview,
    agents: agentsRes.agents,
    mcps: mcpsRes.mcps,
    mcpEvidence: mcpsRes.evidenceText || 'MCP state could not be determined.',
    skills: skillsRes.skills,
    plugins: pluginsRes.plugins,
    providers: providersRes.providers,
    project: project.project,
    commands: commands.commands,
    automation: automation.automation,
    warnings: warningsRes.warnings,
    context: contextRes.context,
    configs: configs.configs,
  };
}

export { makeContext, isDir, resolveOpencodeCommand };
