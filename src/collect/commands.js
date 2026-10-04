/**
 * Commands + automation collector.
 *
 * Both are pure filesystem discovery: slash commands are markdown files in
 * `commands/`, and automation entries are the small routing/config files that
 * sit alongside them. Only frontmatter and sizes are read; command bodies are
 * included because the dashboard's command drawer displays them, and they pass
 * through the sanitizer like everything else.
 */
import { readFileSafe, isDir, listFilesRecursive } from './context.js';
import path from 'node:path';

// Guard against a pathological command tree. When it trips, the walk reports
// truncation rather than silently returning a capped list.
const COMMAND_FILE_CAP = 500;

/** Files that describe local automation. Values are never emitted. */
const AUTOMATION_FILES = [
  {
    name: 'skillctl router',
    file: 'scripts/skillctl.mjs',
    kind: 'global CLI script',
    desc: 'Skill router invoked from AGENTS.md. Routes a task summary to an approved skill.',
  },
  {
    name: 'capabilities.json',
    file: 'capabilities.json',
    kind: 'routing table',
    desc: 'Maps capability keys to the skills that cover them.',
  },
  {
    name: 'skill-sources.json',
    file: 'skill-sources.json',
    kind: 'approved sources',
    desc: 'Approved skill install sources. Key names and byte counts only.',
  },
  {
    name: 'skills-lock.json',
    file: path.join('..', 'skills-lock.json'),
    kind: 'lockfile',
    desc: 'Pins computed hashes for skills installed outside the global config directory.',
  },
];

/**
 * Frontmatter `agent:` and `subtask:` for a command file.
 *
 * An absent `agent:` is `null`, never a default. Substituting a real agent name
 * displayed a value that was read from nowhere as though it came from the file.
 * `subtask:` is matched as a whole token so `untrue` cannot read as true.
 */
function commandMeta(text) {
  const fm = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!fm) return { agent: null, subtask: null };
  const block = fm[1];
  const a = /^\s*agent\s*:\s*(.+)$/mi.exec(block);
  const s = /^\s*subtask\s*:\s*(.+)$/mi.exec(block);
  return {
    agent: a ? a[1].trim().replace(/^["']|["']$/g, '') || null : null,
    subtask: s ? /^(true|yes|on)$/i.test(s[1].trim().replace(/^["']|["']$/g, '')) : null,
  };
}

/** Strip frontmatter and the description line; keep the actionable body. */
function commandBody(text) {
  const fm = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const rest = fm ? text.slice(fm[0].length) : text;
  return rest.replace(/\r\n/g, '\n').trim();
}

export function collectCommands(ctx) {
  const dirs = [
    path.join(ctx.projectLocalDir, 'command'),
    path.join(ctx.projectLocalDir, 'commands'),
    path.join(ctx.globalDir, 'command'),
    path.join(ctx.globalDir, 'commands'),
  ];

  const commands = [];
  const seen = new Set();
  const shadows = [];

  for (const dir of dirs) {
    if (!isDir(dir)) continue;
    // Recursive: OpenCode supports namespaced commands (`git/commit.md` is
    // invoked as `/git:commit`), so a flat scan silently dropped them.
    const walk = listFilesRecursive(dir, { maxDepth: 3, maxFiles: COMMAND_FILE_CAP });
    for (const full of walk.files) {
      if (!/\.(md|markdown)$/i.test(full)) continue;
      const rel = path.relative(dir, full).replace(/\\/g, '/');
      const stem = rel.replace(/\.(md|markdown)$/i, '');
      // `git/commit.md` -> `git:commit`
      const name = stem.includes('/') ? stem.replace(/\//g, ':') : stem;
      if (seen.has(name)) { shadows.push(name); continue; }
      seen.add(name);

      const read = readFileSafe(full, 512 * 1024);
      const { agent, subtask } = commandMeta(read.ok ? read.text : '');
      let body;
      if (!read.ok) body = '(file could not be read)';
      else if (read.truncated) {
        body = `${commandBody(read.text)}\n\n[truncated at ${Math.round(512 * 1024 / 1024 * 10) / 10} MB — the file is larger than the read limit]`;
      } else body = commandBody(read.text);

      commands.push({
        name,
        file: ctx.display(full),
        bytes: read.ok ? read.bytes : 0,
        // null means "not stated in the file", which the UI renders as such.
        agent,
        subtask,
        status: read.ok ? 'active' : 'unreadable',
        body,
      });
    }
  }

  return {
    ok: true,
    commands,
    notes: shadows.length
      ? [`${shadows.length} command name(s) defined in more than one location; the first found was used: ${[...new Set(shadows)].join(', ')}.`]
      : [],
  };
}

export function collectAutomation(ctx) {
  const entries = [];

  for (const spec of AUTOMATION_FILES) {
    const full = path.resolve(ctx.globalDir, spec.file);
    const read = readFileSafe(full, 4 * 1024 * 1024);
    // An absent file is reported as absent, not dropped. `continue` here made
    // the list look complete while silently omitting entries.
    entries.push({
      name: spec.name,
      // "present" is a fact (the file was read); "absent" is a fact too.
      // Neither implies the automation is wired up — nothing in this tool can
      // determine that, so no "active" claim is made.
      status: read.ok ? 'present' : 'absent',
      kind: spec.kind,
      bytes: read.ok ? read.bytes : null,
      path: ctx.display(full),
      desc: spec.desc,
    });
  }

  return { ok: true, automation: entries };
}
