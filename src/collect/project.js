/**
 * Project scope collector. Reports what the project directory contributes to
 * OpenCode, measured by listing the directories that would hold config.
 */
import { readDirSafe, isDir, isFile, listFilesRecursive } from './context.js';
import path from 'node:path';

const LOCAL_SUBDIRS = ['skill', 'skills', 'agent', 'agents', 'plugin', 'plugins', 'command', 'commands'];

// Guard against pathological trees. When it trips, counts are a LOWER BOUND and
// the note must say so rather than presenting the cap as a measurement.
const LOCAL_FILE_CAP = 500;

/** Config filenames a project could contribute. Presence is reported, not contents. */
const LOCAL_FILES = ['opencode.json', 'opencode.jsonc', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'cli.json', 'tui.json'];

export function collectProject(ctx) {
  const localDir = ctx.projectLocalDir;
  const hasLocal = isDir(localDir);

  // Each subdirectory is walked independently so a truncated walk is attributed
  // to the subdirectory that actually hit the cap, rather than being averaged
  // across all of them.
  const walk = (...subdirs) => {
    let truncated = false;
    const files = [];
    for (const sub of subdirs) {
      const r = listFilesRecursive(path.join(localDir, sub),
        { maxDepth: 3, maxFiles: LOCAL_FILE_CAP });
      files.push(...r.files);
      if (r.truncated) truncated = true;
    }
    return { files, truncated };
  };

  const skillWalk = hasLocal ? walk('skills', 'skill') : { files: [], truncated: false };
  const agentWalk = hasLocal ? walk('agent', 'agents') : { files: [], truncated: false };
  const pluginWalk = hasLocal ? walk('plugin') : { files: [], truncated: false };

  const localSkills = skillWalk.files.filter(f => /SKILL\.md$/i.test(f));
  const localAgents = agentWalk.files.filter(f => /\.(md|markdown)$/i.test(f));
  const localPlugins = pluginWalk.files.filter(f => /\.(js|mjs|ts)$/i.test(f));

  const truncated = skillWalk.truncated || agentWalk.truncated || pluginWalk.truncated;

  const localMcps = [];
  const localConfig = [];
  for (const f of LOCAL_FILES) {
    const full = path.join(ctx.projectDir, f);
    if (isFile(full)) localConfig.push(ctx.projectDisplay(full));
  }

  // Top-level entry count, to prove emptiness honestly.
  let entries = 0;
  let entriesKnown = false;
  try {
    entries = readDirSafe(ctx.projectDir, { withFileTypes: true }).length;
    entriesKnown = true;
  } catch {
    entries = 0;
  }

  const present = [];
  if (hasLocal) present.push('.opencode/');
  for (const c of localConfig) present.push(c);

  const total =
    localSkills.length + localAgents.length + localPlugins.length + localMcps.length + localConfig.length;

  // The note must describe checks that actually ran and locate files where they
  // really are. `localConfig` lives in the project ROOT, not under .opencode.
  const rootLabel = ctx.projectDisplay(ctx.projectDir);
  let note;
  if (!entriesKnown) {
    note = `The project directory ${rootLabel} could not be listed, so its contents are unknown. ` +
      `Global config still applies.`;
  } else if (truncated) {
    note = `At least ${total} local resource(s) found under ${ctx.projectDisplay(localDir)}; ` +
      `the walk hit its ${LOCAL_FILE_CAP}-file cap, so this count is a lower bound.`;
  } else if (total === 0) {
    note = `Listed ${entries} top-level entries in ${rootLabel} and read ${ctx.projectDisplay(localDir)}: ` +
      `no OpenCode configuration files were found, so this project contributes none. ` +
      `Global config still applies.`;
  } else {
    note = `This project contributes ${total} local resource(s): ` +
      `${localSkills.length} skill(s) and ${localAgents.length} agent file(s) under ` +
      `${ctx.projectDisplay(localDir)}, plus ${localConfig.length} config file(s) in ${rootLabel}.`;
  }

  return {
    ok: true,
    project: {
      exists: true,
      root: rootLabel,
      entries,
      entriesKnown,
      truncated,
      localSkills: localSkills.map(f => ctx.projectDisplay(f)),
      localAgents: localAgents.map(f => ctx.projectDisplay(f)),
      localPlugins: localPlugins.map(f => ctx.projectDisplay(f)),
      localMcps,
      localConfig,
      note,
    },
    subdirs: LOCAL_SUBDIRS,
    hasLocal,
  };
}
