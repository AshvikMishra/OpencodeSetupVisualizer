/**
 * MCP collector. Prefers `opencode api get /api/mcp` (structured), and always
 * also runs `opencode mcp list` so the "configured vs reported" cross-check in
 * warnings[] has a second, independent source.
 */
import { runOpencode, runOpencodeJson } from '../exec.js';

function normalizeName(s) {
  return String(s || '').trim().toLowerCase();
}

/** Parse the `opencode mcp list` table into names. */
export function parseMcpList(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^no mcp servers configured/i.test(line)) return [];
    if (/^name\s+status/i.test(line)) continue; // header row
    const first = line.split(/\s{2,}|\t/)[0];
    if (first) out.push(first.trim());
  }
  return out;
}

export async function collectMcps(ctx, deps = {}) {
  const runCli = deps.runOpencode || runOpencode;
  const runCliJson = deps.runOpencodeJson || runOpencodeJson;

  const evidence = [];
  const notes = [];

  const apiRes = await runCliJson('mcpApi', { cwd: ctx.projectDir });
  let mcps = [];
  let apiOk = false;
  if (apiRes.ok && apiRes.data && Array.isArray(apiRes.data.data)) {
    apiOk = true;
    evidence.push('opencode api get /api/mcp');
    mcps = apiRes.data.data.map((m, i) => ({
      name: String(m.name || m.id || `server-${i + 1}`),
      command: typeof m.command === 'string' ? m.command : '',
      // Environment holds credentials for stdio servers — key names only.
      envKeys: m.env && typeof m.env === 'object' ? Object.keys(m.env) : [],
      status: m.status ? String(m.status) : 'unknown',
    }));
  } else {
    notes.push(`MCP endpoint unavailable (${apiRes.reason || 'unknown reason'}).`);
  }

  const listRes = await runCli('mcpList', { cwd: ctx.projectDir });
  let listedNames = null;
  if (listRes.ok) {
    evidence.push('opencode mcp list');
    listedNames = parseMcpList(listRes.stdout);
  } else {
    notes.push(`opencode mcp list failed (${listRes.reason || 'unknown reason'}).`);
  }

  // If the list worked and the API did not, reconstruct from the list (names only).
  if (!apiOk && listedNames) {
    mcps = listedNames.map(n => ({ name: n, command: '', envKeys: [], status: 'reported' }));
  }

  const evidenceText = buildEvidence({ apiOk, listRes, listedNames, mcps, notes });

  return {
    ok: apiOk || !!listedNames,
    mcps,
    evidence,
    evidenceText,
    listedNames,
    notes: notes.filter(Boolean),
  };
}

function buildEvidence({ apiOk, listRes, listedNames, mcps, notes }) {
  const parts = [];
  if (apiOk) parts.push('opencode api get /api/mcp reported no servers.');
  else parts.push('opencode api get /api/mcp was unavailable, so this section may be incomplete.');

  if (listRes.ok && listedNames && listedNames.length === 0) {
    parts.push('opencode mcp list reports "No MCP servers configured".');
  } else if (listRes.ok && listedNames && listedNames.length) {
    parts.push(`opencode mcp list reports: ${listedNames.join(', ')}.`);
  } else if (!listRes.ok) {
    parts.push(`opencode mcp list failed: ${listRes.reason || 'unknown reason'}.`);
  }

  if (!mcps.length) {
    // Claiming what is "injected into any session" is a statement about runtime
    // behaviour this tool never observes. Report only the discovered count.
    parts.push('0 MCP server(s) were discovered, so this tool did not measure any tool-schema cost.');
  } else {
    parts.push(`${mcps.length} server(s) present; environment variable names are listed but values are never read.`);
  }

  if (notes.length) parts.push(notes.join(' '));
  return parts.join(' ');
}
