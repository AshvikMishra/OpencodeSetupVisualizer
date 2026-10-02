Build a privacy-first, standalone visual dashboard of **the user's actual OpenCode setup**.

This prompt must work for any OpenCode installation and project. Do not use, assume, or hardcode the original author's paths, agents, skills, models, providers, MCPs, plugins, counts, or configuration.

## CORE RULE

**Discover first, visualize second.**

Inspect the current user's OpenCode environment using read-only commands/files wherever possible. Build the dashboard entirely from the verified results of that discovery.

Never invent resources. If something does not exist, show an accurate empty state.

## PRIVACY / SECURITY

This is a local setup visualizer.

* Never upload, transmit, or send discovered data anywhere.
* Do not use telemetry, analytics, tracking, webhooks, remote APIs, or external data services.
* Do not inspect unrelated personal files.
* Never expose API keys, passwords, tokens, cookies, credentials, private keys, auth databases, or secrets.
* Redact sensitive values before embedding anything in the HTML.
* Treat `service.json`, auth stores, environment variables, credential files, and databases as sensitive.
* Do not dump entire configuration files into context.
* Prefer metadata, structure, paths, names, descriptions, and status.
* Do not modify the user's OpenCode configuration.
* Do not install anything.
* Do not create MCPs, plugins, skills, packages, or agents.
* The generated HTML must work entirely from an embedded sanitized snapshot.
* The final HTML must not contain shell commands capable of modifying the system.
* Clearly display a "Local / No Data Sent" privacy indicator.

## DISCOVERY

Use parallel subagents where useful for fast read-only discovery.

Collect only what is necessary to visualize:

### OpenCode

* version
* configuration locations
* relevant configuration structure

### Agents

For each actual agent:

* name
* built-in/custom
* mode/type
* model/provider
* relevant permissions
* concise description
* source/scope

### Skills

For each discoverable skill:

* name
* description
* scope
* source
* invocation metadata when available
* plugin-provided/project-local/global status

Deduplicate physical copies, junctions, aliases, and duplicate discovery entries where appropriate.

### MCP

For each configured MCP:

* name
* transport/type
* status
* tool count if safely available
* source

If none exist, report zero.

### Plugins

* name
* version/commit if available
* source
* loaded/active/inactive state
* provided capabilities

### Providers / Models

* configured providers
* available models
* model/provider relationships

Never read provider credentials.

### Commands / Automation

Only summarize discoverable command/automation metadata.

### Project scope

Determine:

* project-local agents
* project-local skills
* project-local plugins
* project-local OpenCode configuration
* project memory if present

Clearly distinguish project-local resources from global resources.

## TOKEN / CONTEXT VIEW

Where safely measurable, estimate:

* persistent instruction/config overhead
* skill metadata overhead
* MCP schema overhead
* on-demand skill body size

Label estimates clearly.

Do not read every skill body merely to calculate this.

## OUTPUT

Create exactly one standalone file in the current project:

`opencode-dashboard.html`

No build system.

No supporting source files.

No generated README/product documentation.

No configuration changes.

The HTML may use CDN-hosted Tailwind CSS and Lucide icons for presentation, but the user's discovered setup data itself must never be sent to a remote service.

Embed the sanitized discovery snapshot as structured JavaScript data.

Keep data separate from presentation so the dashboard can be regenerated easily.

## DESIGN

Create a polished dark developer-tool dashboard:

* dense but readable
* modern developer aesthetic
* responsive
* accessible
* restrained neon accents
* clear hierarchy
* Fira Sans/Fira Code or an appropriate equivalent
* subtle motion
* respect `prefers-reduced-motion`

Do not use placeholder entities.

## DASHBOARD SECTIONS

### 1. Overview

Show actual counts for:

* Agents
* Skills
* MCPs
* Plugins
* Providers
* Models
* Project-local resources

### 2. Agent Fleet

Interactive cards/details for every discovered agent.

### 3. Skills

Searchable/filterable skill inventory with scope and source.

### 4. MCP

Configured MCP inventory and an explicit empty state when zero.

### 5. Plugins

Plugin inventory with status and provided capabilities.

### 6. Providers & Models

Show provider → model relationships.

### 7. Configuration

Show only sanitized, relevant configuration snippets.

Never display secrets or sensitive values.

### 8. Context / Token Cost

Show approximate persistent vs on-demand context overhead where available.

### 9. Relationship Graph

Interactive graph showing only verified relationships:

OpenCode → Agents
OpenCode → Skills
OpenCode → MCPs
OpenCode → Plugins
Providers → Models
Plugins → Skills
Projects → Project-local resources

Never fabricate graph edges.

## INTERACTION

Implement:

* global search
* category filters
* scope filters
* grid/list view
* graph view
* entity detail drawer
* keyboard navigation
* Escape to close
* focus management
* copy buttons for sanitized values
* responsive layout
* accessible controls
* empty states

Every visible control must work.

## VERIFICATION

After creating the dashboard:

1. Validate the HTML.
2. Verify JavaScript parses.
3. Check for console errors.
4. Verify search/filtering.
5. Verify drawers/modals.
6. Verify graph rendering.
7. Verify responsive layouts.
8. Verify zero horizontal overflow on mobile.
9. Verify empty categories render correctly.
10. Verify no secrets appear anywhere in the generated HTML.
11. Verify no placeholder/example resources appear.
12. If Playwright CLI is already available, use it for browser verification.
13. Do not install Playwright MCP or any other dependency.

## FINAL PRIVACY AUDIT

Before finishing, scan the generated HTML for likely sensitive material:

* passwords
* API keys
* access tokens
* bearer tokens
* private keys
* cookies
* auth credentials
* environment variable values
* database contents

If anything sensitive is found, remove/redact it before completion.

## FINAL RESPONSE

Report concisely:

* output path
* discovered resource counts
* verification performed
* whether anything was redacted
* any categories that could not safely be inspected
* approximate embedded snapshot size

Do not include sensitive values in the final response.
