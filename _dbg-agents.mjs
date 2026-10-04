import { collectAgents } from './src/collect/agents.js';
import { makeContext } from './src/collect/context.js';

const ctx = makeContext({ home: 'FIXTURE_HOME', projectDir: 'FIXTURE_PROJ', platform: 'linux' });
const deps = data => ({
  runOpencodeJson: async () => ({ ok: true, data: { data }, reason: null }),
  runOpencode: async () => ({ ok: true, stdout: '', stderr: '', code: 0 }),
});
const r = await collectAgents(ctx, deps([
  { id: 'build', name: 'Build', description: 'd', mode: 'primary', permissions: [] },
]));
console.log('ok:', r.ok);
console.log('agents:', Array.isArray(r.agents) ? r.agents.length : typeof r.agents);
console.log('note:', r.note);
console.log('notes:', r.notes);
