/**
 * Providers + models collector.
 *
 * `opencode api get /api/provider` returns items shaped like
 *   { id, integrationID, name, activation, package, settings:{ apiKey, baseURL } }
 *
 * `settings` is DROPPED WHOLE and never read into our data — that is where the
 * provider API key lives. Only `models`, `favorites` and `recent` are set, and
 * only from sources that cannot contain credentials:
 *   - model ids   : `opencode models`
 *   - recent      : the local model state file, filtered to known model ids
 *   - favorites   : the local model state file
 */
import { runOpencode, runOpencodeJson } from '../exec.js';
import { readFileSafe } from './context.js';
import path from 'node:path';

/** Model ids look like `provider/model`. Nothing else is accepted. */
const MODEL_ID_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+$/;

function isModelId(s) {
  return typeof s === 'string' && MODEL_ID_RE.test(s.trim());
}

/** Read the local model state file. Only ids/favorites/recent are extracted. */
function readModelState(ctx) {
  const file = path.join(ctx.stateDir, 'model.json');
  const read = readFileSafe(file, 4 * 1024 * 1024);
  if (!read.ok) return { ok: false, recent: [], favorites: [], note: `model.json ${read.reason}` };
  let json;
  try {
    json = JSON.parse(read.text);
  } catch {
    return { ok: false, recent: [], favorites: [], note: 'model.json is not valid JSON' };
  }
  const rec = json && typeof json === 'object' ? json.recent : undefined;
  const fav = json && typeof json === 'object' ? json.favorite : undefined;
  const recent = Array.isArray(rec) ? rec.filter(isModelId) : [];
  const favorites = Array.isArray(fav) ? fav.filter(isModelId) : [];
  return { ok: true, recent, favorites, note: null };
}

export async function collectProviders(ctx, deps = {}) {
  const runCli = deps.runOpencode || runOpencode;
  const runCliJson = deps.runOpencodeJson || runOpencodeJson;
  const evidence = [];
  const notes = [];

  // --- provider identities (settings discarded) --------------------------
  const provRes = await runCliJson('provider', { cwd: ctx.projectDir });
  let identities = [];
  if (provRes.ok && provRes.data && Array.isArray(provRes.data.data)) {
    evidence.push('opencode api get /api/provider');
    identities = provRes.data.data
      .map(p => ({
        id: String(p.id || p.integrationID || 'unknown'),
        name: String(p.name || p.id || 'Unknown provider'),
        // settings intentionally not referenced anywhere below.
      }))
      .filter(p => p.id);
  } else {
    notes.push(`Provider list unavailable (${provRes.reason || 'unknown reason'}).`);
  }

  // --- model ids ---------------------------------------------------------
  const modelsRes = await runCli('models', { cwd: ctx.projectDir });
  let modelIds = [];
  if (modelsRes.ok) {
    evidence.push('opencode models');
    modelIds = modelsRes.stdout
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(isModelId);
    modelIds = [...new Set(modelIds)];
  } else {
    notes.push(`Model list unavailable (${modelsRes.reason || 'unknown reason'}).`);
  }

  const state = readModelState(ctx);
  if (state.ok) evidence.push('local model.json');
  else if (state.note) notes.push(state.note);

  // Group models by their provider prefix.
  const byProvider = new Map();
  for (const id of modelIds) {
    const prefix = id.split('/')[0];
    if (!byProvider.has(prefix)) byProvider.set(prefix, []);
    byProvider.get(prefix).push(id);
  }

  // Build one entry per known provider, plus one per provider prefix seen in the
  // model list (so a provider present only in `models` is still reported).
  const keys = new Set([...identities.map(p => p.id), ...byProvider.keys()]);
  const providers = [];

  for (const key of keys) {
    const identity = identities.find(p => p.id === key);
    const list = byProvider.get(key) || [];
    const recent = state.recent.filter(m => list.includes(m));
    providers.push({
      id: key,
      name: identity ? identity.name : key,
      models: list.length,
      status: identity ? 'active' : 'active',
      note: identity
        ? list.length
          ? `Reported by the CLI with ${list.length} reachable model(s). Provider settings are never read.`
          : 'Listed as a provider but the CLI returned no models for it.'
        : 'Seen only in the model list; not returned by the provider endpoint.',
      modelList: list,
      recent,
      // Filtered per provider, like `recent`. Sharing the global array made every
      // provider list models it does not offer, including ids no provider has.
      favorites: state.favorites.filter(m => list.includes(m)),
      variant: 'default',
      source: 'opencode models · ~/.local/state/opencode/model.json',
    });
  }

  // An empty array is the honest answer when no provider could be discovered.
  // A fabricated entry named "No provider discovered" rendered as a real
  // provider card with a "0 models" chip and a green active status.
  if (!providers.length) {
    notes.push(
      'Neither `opencode api get /api/provider` nor `opencode models` returned usable data, ' +
      'so no provider or model is listed. This is an empty result, not a rendering failure.'
    );
  } else {
    notes.push(null);
  }

  return {
    ok: provRes.ok || modelsRes.ok,
    providers,
    evidence,
    notes: notes.filter(Boolean),
  };
}
