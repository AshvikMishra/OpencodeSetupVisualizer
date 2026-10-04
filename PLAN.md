# PLAN.md — opencode-setup-visualizer

## 1. Empirically verified CLI surface (inspected, not assumed)

Probed on this machine (Windows 11, PowerShell 5.1, Node v24.13.0, opencode v2.0.22).

| Command | Works? | Auth needed | Observed output shape |
|---|---|---|---|
| `opencode --version` | yes | no | `opencode v2.0.22` |
| `opencode api get /api/agent` | yes | **no** | `{location:{directory}, data:[{id,name,description,mode,hidden,permissions:[{action,resource,effect}],system?,request?}]}` |
| `opencode api get /api/skill` | yes | **no** | `{location, data:[{id,name,description,path,content}]}` n=24 |
| `opencode api get /api/provider` | yes | **no** | `{location, data:[{id,integrationID,name,activation,package,settings:{apiKey,baseURL}}]}` n=1 |
| `opencode api get /api/mcp` | yes | no | `{location, data:[]}` |
| `opencode models` | yes | no | 10 newline-separated `provider/model` ids |
| `opencode mcp list` | yes | no | `No MCP servers configured` |
| `opencode plugin list` | yes | no | TSV `ID / VERSION / SOURCE` |

**Conclusion: every source works without the service password.** No fallback-only situation.
`service.json` is never read; only its key names are reported.

### Critical platform finding: `.cmd` shim breaks Node spawn

`opencode` on PATH resolves to `opencode.cmd`. Node 24 `spawnSync`/`execFileSync` on that
path fails with **EINVAL** (verified — 6/6 endpoints failed). The shim is a thin wrapper:

```
"%~dp0\node_modules\@opencode\cli\bin\opencode.exe"   %*
```

**Fix:** parse the shim to resolve the real executable, then `spawn` the `.exe` directly
with a fixed argument array. No shell, no quoting, no EINVAL. Falls back to a resolved
`.js`/`.exe` on PATH, then to `shell:true` with constant args only.

### Two data hazards in the API payloads

- `/api/skill` items carry a `content` field = **full skill body**. Used only for
  `.length` (the `chars` metric); the body is never propagated.
- `/api/provider` items carry `settings.apiKey`. The `settings` object is **dropped
  whole** before the object is normalized; it is never read into our own data.
- Every response embeds `location.directory`, an absolute path that includes the
  account name — it is discarded, and all remaining absolute paths are normalized to
  the home token by the sanitizer.

## 2. Filesystem layout the collector targets

The collector resolves these locations generically; the layout below is the
convention the collectors expect, not an inventory of any one machine.

- global config: `~/.config/opencode/` — allowlisted files only
  (`opencode.json`, `cli.json`, `tui.json`, `capabilities.json`,
  `skill-sources.json`, `AGENTS.md`, …), plus `commands/`, `scripts/`, `skills/`
- skills: `~/.config/opencode/skills/` and `~/.agents/skills/`
- state: `~/.local/state/opencode/` (`model.json` for recent/favourite model ids)
- project: `<projectDir>/.opencode/`, discovered but reported as empty when absent

Nothing is globbed; only the allowlist above is ever opened.

## 3. npm

`npm view opencode-setup-visualizer` → **E404 → name is AVAILABLE.** Will not publish.

## 4. Architecture (smallest reasonable)

```
bin/            CLI entry: flag parse → collect → inject → serve | --json | --out
src/exec.js     safe spawn + opencode executable resolution (.cmd shim unwrap)
src/inject.js   SNAPSHOT marker replacement + script-safe JSON embedding
src/sanitize.js privacy boundary: recursive redaction + assertClean
src/collect/*   one module per concern, each independently failure-isolated
src/server.js   127.0.0.1-only, Host-checked, GET-only, no static serving
template/       byte-identical copy of the dashboard; SHA-256 pinned in a test
```

Data flow: `collect/*` → normalized snapshot → `sanitize()` (recursive, final step)
→ `assertClean()` → `inject()` → response. Nothing reaches the wire unsanitized.

## 5. Decisions

- **Template is immutable.** Copied byte-for-byte; SHA-256 pinned in a test. All
  customization is an in-memory string replacement between the two markers.
- **Collectors never throw.** Each returns `{ok, data|reason}`; failures surface as
  `warnings[]` entries or `note` text, never as a blank page.
- **`providers[0]` is always emitted.** If no provider is discoverable we emit an honest
  `models:0` entry with an "unavailable" note, because the model drawer dereferences it.
- **Home token only.** No real username is ever placed in the snapshot; the sanitizer
  normalizes any absolute path that slips through as a second line of defense.
