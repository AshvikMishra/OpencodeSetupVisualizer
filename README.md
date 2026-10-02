# OpenCode Setup Visualizer

A single-file, offline observability dashboard for a **real** OpenCode installation.

`opencode-dashboard.html` is a static snapshot of what OpenCode actually reports about
itself — agents, skills, plugins, MCP servers, providers, models, config files and
context cost. It renders only what was verified on disk or via the OpenCode CLI/API.
Nothing is mocked, and a resource that does not exist is shown as an explicit empty
state rather than omitted.

![sections](https://img.shields.io/badge/sections-10-38e0d0?style=flat-square)
![deps](https://img.shields.io/badge/external_deps-2-CDNs-f0a92b?style=flat-square)
![build](https://img.shields.io/badge/build-none-3ddc84?style=flat-square)

---

## Quick start

Open the file. That is the entire setup.

```
opencode-dashboard.html          # double-click, or drag into any browser
```

No install, no build, no server, no Node. The page makes **no network calls of its own**
and executes no shell commands.

---

## What it visualizes

| Section | Contents |
|---|---|
| **Overview** | Live counts with drill-down; always-resident token cost |
| **Agent Fleet** | Mode, visibility, deny/ask permission rules, tools, source |
| **MCP Servers** | Explicit empty state when none are configured |
| **Skills & Automation** | Searchable grid split by scope, plus slash commands and the router |
| **Plugins** | Version, commit, resolved path, provided skills |
| **Providers & Models** | Reachable providers and every available model |
| **Config Inspector** | Tabbed, sanitized viewer of the real config files with copy buttons |
| **Context Overhead** | Approximate token cost, split always-resident vs on-demand |
| **Verified Findings** | Configuration problems confirmed against files or commands |
| **Project Scope** | Explicit empty state when a project contributes no config |
| **Relationship Graph** | Grid ↔ Graph toggle over config-derived edges only |

### Interaction

Global search (`/` to focus), category and scope filters, Grid ↔ Graph toggle,
click any entity for a detail drawer, `Esc` to close, focus trapping, and
`prefers-reduced-motion` support.

---

## Regenerating the snapshot

All data lives in one `SNAPSHOT` object at the top of the inline `<script>`. Presentation
lives entirely below it, so you can refresh the data without touching the UI.

```bash
opencode --version                              # meta.opencodeVersion
opencode api get /api/agent                     # → SNAPSHOT.agents
opencode api get /api/skill                     # → SNAPSHOT.skills
opencode api get /api/provider                  # → SNAPSHOT.providers
opencode models                                 # → provider.modelList
opencode mcp list                               # → SNAPSHOT.mcps (may be empty)
opencode plugin list                            # → SNAPSHOT.plugins
```

Then edit the `SNAPSHOT` object. Each entity is plain data; every field is optional.

### Local paths

Set `SNAPSHOT.meta.userName` to the Windows account that owns the config. All paths are
stored as `%USERPROFILE%` and expanded at render time, so the file contains **no
hard-coded username** and is safe to commit or share.

---

## Security

The dashboard is read-only, but it renders live local configuration, so a few things
matter before publishing.

**What was checked**

- No secrets. `service.json`'s local service password is redacted everywhere, including
  the config tab. No API keys, tokens, or auth material are embedded.
- No `eval`, `new Function`, `document.write`, or dynamic `script.src`.
- All `innerHTML` writes pass through a single `esc()` helper. Every interpolated value in
  the render functions is escaped — verified by an AST-style sweep that found zero
  unwrapped interpolations.
- No `fetch`, `XMLHttpRequest`, WebSocket, or storage APIs. The page cannot phone home.
- Zero horizontal overflow at 375 / 390 / 768 / 1024 / 1440 px.
- Git history contains no secrets.

**Dependencies** — two CDNs, both the only external runtime dependencies:

| CDN | Purpose |
|---|---|
| `cdn.tailwindcss.com` | Tailwind (required; note its own production advisory) |
| `unpkg.com/lucide@1.50.0` | Icons, **version-pinned with Subresource Integrity** |

`.gitignore` blocks `service.json`, `auth.json`, `*.db`, `*.pem`, `.env*` and
`.opencode/` so local secrets cannot be committed by accident.

**Known limitations**

- The file discloses local config *paths* and skill/plugin *names* from this machine.
  That is the point of the tool, but review it before pushing to a public repo.
- Tailwind's CDN build is not intended for production. It is used here because this
  project is explicitly a no-build, single-file deliverable.
- The Lucide SRI hash pins `1.50.0`. If you change that version you must recompute the
  `integrity` hash or icons silently fail.

---

## Verification

Checked with Playwright CLI against local Edge: JS parses clean, zero console errors,
67 interactive entities open a populated drawer, zero dead links, 114 Lucide icons
render, 9 config tabs show exactly one panel at a time, clipboard copy works, and
reduced-motion collapses animation to 1 µs. The Impeccable design detector reports zero
findings.

---

## Current snapshot

Taken from OpenCode **v2.0.22** on Windows 11:

- 7 agents (4 selectable, 3 hidden internal) — all built-in, no custom agent files
- 24 skills — 2 built-in, 14 plugin-provided, 8 local
- 1 plugin — `superpowers` 6.4.2
- 0 MCP servers
- 1 provider, 10 available models
- 0 project-local resources

Always-resident context ≈ **1.6k tokens**; on-demand skill bodies ≈ **59k** (chars/4).