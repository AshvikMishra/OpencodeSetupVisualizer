/**
 * Context cost collector.
 *
 * Tokens are estimated with the chars/4 rule, which is what the dashboard
 * labels as approximate. Every number here is measured from a real file; the
 * `skill metadata` figure is derived from the descriptions the CLI returned,
 * not invented.
 */
import { readFileSafe, dirSize } from './context.js';
import path from 'node:path';

export const CHARS_PER_TOKEN = 4;

export const tokensFor = bytes => Math.round(bytes / CHARS_PER_TOKEN);

export function collectContext(ctx, { skills = [], configs = [], agentsMd = null, mcps = null, project = null } = {}) {
  // --- always resident ----------------------------------------------------
  const alwaysResident = [];

  // `agentsMd` is the config entry for AGENTS.md, identified by its path, so it
  // can be excluded from the aggregate below without guessing by size.
  const agentsMdBytes = agentsMd && agentsMd.bytes ? agentsMd.bytes : 0;

  if (agentsMdBytes > 0) {
    alwaysResident.push({
      label: 'AGENTS.md',
      bytes: agentsMdBytes,
      tokens: tokensFor(agentsMdBytes),
      kind: 'always',
      detail: 'Global agent instructions, loaded into every session.',
    });
  }

  // Skill frontmatter (name + description) is the index OpenCode keeps resident.
  // descChars is measured; `desc` may be a placeholder, which is not real cost.
  const metaBytes = skills.reduce((sum, s) => sum + s.name.length + (s.descChars || 0), 0);
  if (skills.length) {
    alwaysResident.push({
      label: `Skill metadata (${skills.length} skills)`,
      bytes: metaBytes,
      tokens: tokensFor(metaBytes),
      kind: 'always',
      detail: 'Name and description frontmatter for every skill the CLI reports. This is the index used to decide what to load.',
    });
  }

  // The remaining config files are resident too, but AGENTS.md already has its
  // own row above — including it again would double-count the single largest
  // always-resident item and inflate the headline figure. Exclusion is by path
  // identity, never by size, so an unrelated file of the same size stays counted.
  const isAgentsMd = c => !!agentsMd && c.path === agentsMd.path;
  const otherConfigs = configs.filter(c => !isAgentsMd(c));
  const otherConfigBytes = otherConfigs.reduce((sum, c) => sum + (c.bytes || 0), 0);
  if (otherConfigBytes > 0) {
    alwaysResident.push({
      label: 'Configuration files',
      bytes: otherConfigBytes,
      tokens: tokensFor(otherConfigBytes),
      kind: 'always',
      detail:
        `Total size of the ${otherConfigs.length} other allowlisted config file(s) on disk. ` +
        `AGENTS.md is listed separately above and is not counted again here.`,
    });
  }

  // --- on demand ----------------------------------------------------------
  const onDemand = [];
  const bodyBytes = skills.reduce((sum, s) => sum + (s.chars || 0), 0);
  if (skills.length) {
    const largest = [...skills].sort((a, b) => (b.chars || 0) - (a.chars || 0)).slice(0, 3);
    onDemand.push({
      label: `Skill bodies (${skills.length} skills)`,
      bytes: bodyBytes,
      tokens: tokensFor(bodyBytes),
      kind: 'ondemand',
      detail:
        `Skill body text (frontmatter excluded, since that is charged above as always-resident). ` +
        `Entering context only when a skill is invoked. Largest: ` +
        `${largest.map(s => `${s.name} ${s.chars.toLocaleString()}`).join(', ')}.`,
    });
  }

  // --- not present --------------------------------------------------------
  // Every sentence below is derived from collected data. Hardcoding "No MCP
  // server is configured" meant a user WITH five MCP servers was told they had
  // none — and contradicted the overview card counting them in the same table.
  const none = [];

  const mcpList = Array.isArray(mcps) ? mcps : null;
  if (mcpList === null) {
    none.push({
      label: 'MCP tool schemas',
      bytes: null,
      tokens: null,
      kind: 'none',
      detail: 'MCP servers were not read, so this cost was not measured.',
    });
  } else if (mcpList.length === 0) {
    none.push({
      label: 'MCP tool schemas',
      bytes: 0,
      tokens: 0,
      kind: 'none',
      detail: 'The MCP server list was read and is empty, so no tool schema is injected.',
    });
  } else {
    // The size of a tool schema is not something this tool reads, so the cost is
    // reported as unmeasured rather than as zero.
    none.push({
      label: 'MCP tool schemas',
      bytes: null,
      tokens: null,
      kind: 'none',
      detail: `${mcpList.length} MCP server(s) are configured. Their tool schemas are not read by this tool, so this cost was not measured.`,
    });
  }

  const proj = project && project.project ? project.project : null;
  if (!proj) {
    none.push({
      label: 'Project-local instructions',
      bytes: null,
      tokens: null,
      kind: 'none',
      detail: 'The project directory was not inspected, so this cost was not measured.',
    });
  } else {
    const localFiles = (proj.localConfig || []).length;
    const localRes = (proj.localSkills || []).length + (proj.localAgents || []).length +
      (proj.localPlugins || []).length;
    // `projectDisplay` collapses the project root to "." — read better as words.
    const where = !proj.root || proj.root === '.' ? 'the project directory' : proj.root;
    if (localFiles === 0 && localRes === 0) {
      none.push({
        label: 'Project-local instructions',
        bytes: 0,
        tokens: 0,
        kind: 'none',
        detail: `${where} was listed and holds no project config file or local skill/agent.`,
      });
    } else {
      none.push({
        label: 'Project-local instructions',
        bytes: null,
        tokens: null,
        kind: 'none',
        detail: `This project contributes ${localRes} local skill/agent file(s) and ` +
          `${localFiles} root config file(s). Their sizes were not measured here; ` +
          `see the Project Scope section.`,
      });
    }
  }

  // --- disk footprint -----------------------------------------------------
  const cacheFootprint = [];
  const roots = [
    // This is the whole npm-resolved cache OpenCode uses, not just plugin skills.
    ['OpenCode npm cache', path.join(ctx.cacheDir, 'npm')],
    ['~/.agents/skills', ctx.agentsSkillDir],
    ['~/.config/opencode/skills', ctx.globalSkillDir],
  ];
  for (const [label, dir] of roots) {
    if (!dir) continue;
    const { bytes, files, truncated } = dirSize(dir);
    if (bytes > 0) {
      // Never present a capped count as a measurement.
      cacheFootprint.push({
        // The caveat goes in the label: the template renders label and bytes
        // for this row and silently drops `note`, so a caveat there is invisible.
        label: truncated
          ? `${label} (at least ${files.toLocaleString()} files, walk truncated)`
          : label,
        bytes,
        note: truncated
          ? `at least ${files.toLocaleString()} file(s) on disk — measurement truncated`
          : `${files.toLocaleString()} file(s) on disk`,
      });
    }
  }

  return {
    ok: true,
    context: {
      note: `Approximate. Uses the chars/${CHARS_PER_TOKEN} rule against measured byte counts. A real tokenizer will differ, typically by around ±10%.`,
      alwaysResident,
      onDemand,
      none,
      cacheFootprint,
    },
  };
}
