# Build: OpenCode Setup Visualizer

You are the lead engineer coordinating a multi-agent implementation of a real local-first developer tool.

The current project contains an earlier static `opencode-dashboard.html` prototype and possibly related project artifacts. Treat the existing implementation as a prototype/reference, not as the final architecture.

The goal is to turn this into a genuinely usable tool that lets developers:

1. Discover their OpenCode installation dynamically.
2. Visualize their actual OpenCode configuration.
3. Capture immutable configuration snapshots.
4. Keep local snapshot history.
5. Compare snapshots and show configuration changes.
6. Sanitize sensitive information before export.
7. Export/import snapshots.
8. Share sanitized configurations.
9. Remain privacy-first and local-first by default.

This is also an evaluation of the project's agent/skill framework. Use subagents aggressively where work is safely parallelizable, but do NOT sacrifice correctness for concurrency.

---

# 0. NON-NEGOTIABLE RULES

## Safety

This is a development task.

Before modifying anything:

* Inspect the repository.
* Inspect the existing prototype.
* Inspect package/configuration files.
* Inspect the actual installed OpenCode environment only as needed.
* Determine the existing stack before choosing technologies.
* Do not assume the architecture from this prompt is already present.
* Do not blindly rewrite existing work.
* Preserve useful existing code where practical.

Never expose or copy:

* API keys
* access tokens
* passwords
* private keys
* cookies
* OAuth credentials
* auth database contents
* environment variable values
* OpenCode service credentials
* unrelated personal files
* unrelated project source code

Never transmit discovered OpenCode configuration to an external service without explicit user action.

Do not install global packages.

Do not modify the user's global OpenCode configuration.

Do not modify OpenCode itself.

All generated application state must remain project-local unless explicitly designed otherwise.

---

# 1. FIRST: LEAD-ENGINEER DISCOVERY

Before implementation, act as the lead engineer.

Create a concise implementation plan after inspecting the repository.

Determine:

* existing language/runtime
* existing framework
* package manager
* existing tests
* existing build system
* existing prototype architecture
* reusable code
* missing components
* platform constraints
* Windows compatibility requirements
* how OpenCode configuration can actually be discovered
* which discovery mechanisms are authoritative
* which information is unavailable or unsafe to inspect

Do NOT immediately start coding.

Create:

`.opencode/implementation-plan.md`

The plan must define:

* architecture
* data flow
* snapshot schema
* sanitization boundary
* storage strategy
* UI architecture
* API/IPC boundary if one is required
* testing strategy
* stage dependencies
* subagent ownership
* integration points
* known risks

Use the smallest reasonable architecture.

Do not introduce a database, backend, framework, cloud service, or dependency merely because it is fashionable.

---

# 2. STAGE SYSTEM

Divide implementation into these stages.

## Stage 1 — Architecture + Contracts

Define the contracts that allow agents to work independently.

Produce:

* normalized configuration schema
* snapshot schema
* sanitization contract
* collector interface
* storage interface
* import/export format
* diff format
* UI data contract

Prefer TypeScript types/interfaces or equivalent strongly typed contracts if the discovered stack supports them.

This stage MUST finish before parallel implementation begins.

---

# 3. STAGE 2 — PARALLEL IMPLEMENTATION

After Stage 1 is complete, spawn subagents concurrently for independent work.

You are responsible for deciding the exact agent count based on the repository.

Do not spawn redundant agents.

Every subagent MUST have:

* a clearly bounded responsibility
* explicit files/directories it owns
* explicit files/directories it must NOT modify
* required tests
* required output/report

## Agent A — OpenCode Collector

Implement the local OpenCode discovery layer.

Responsibilities:

* discover OpenCode installation/configuration
* collect relevant configuration metadata
* discover agents
* discover skills
* discover MCP configuration
* discover plugins
* discover providers/models
* discover commands/automation where safely available
* distinguish global vs project-local resources
* normalize everything into the Stage 1 schema
* handle missing resources gracefully
* handle Windows paths
* avoid reading secrets

Important:

The collector must never simply dump configuration files wholesale.

Extract only explicitly allowed structured metadata.

Unknown or unsupported data must be represented as unknown/unavailable rather than guessed.

Write unit tests using fixtures.

Do not modify UI code.

Do not modify storage code.

---

## Agent B — Sanitizer + Privacy Boundary

Implement the privacy/security layer.

Responsibilities:

* recursively sanitize snapshot data
* detect likely secrets
* redact credentials
* redact tokens
* redact API keys
* redact passwords
* redact private keys
* redact cookies
* redact sensitive environment values
* normalize or remove absolute filesystem paths where appropriate
* preserve useful structural information
* produce a redaction report

The sanitizer must be deterministic.

Tests must include malicious/adversarial fixtures such as:

* fake API keys
* JWT-like tokens
* passwords
* PEM private keys
* URLs containing credentials
* environment variable secrets
* nested secret fields
* secret-like strings with unusual casing
* Windows paths

Do NOT make the sanitizer depend solely on field names.

Use both structural and pattern-based detection.

Do not modify the collector implementation.

Do not modify the UI.

---

## Agent C — Snapshot + Local History

Implement immutable snapshots.

Responsibilities:

* create snapshots
* assign stable IDs
* timestamp snapshots
* persist snapshots locally
* list snapshots
* load snapshots
* delete snapshots
* detect duplicates
* preserve snapshot immutability
* maintain metadata/indexes as needed

The storage layer must be local-only.

No cloud dependency.

No telemetry.

No analytics.

Write tests covering:

* creation
* persistence
* retrieval
* deletion
* corrupted snapshot
* duplicate snapshot
* schema versioning

Do not modify collector or UI implementation.

---

## Agent D — Diff Engine

Implement snapshot comparison.

Responsibilities:

* compare two snapshots
* identify added resources
* removed resources
* modified resources
* unchanged resources
* provide machine-readable diff output
* provide human-readable summaries

Diffing should understand the normalized schema rather than performing naive text comparison.

Test:

* agent changes
* skill additions/removals
* MCP changes
* plugin changes
* model changes
* configuration changes
* ordering-only changes
* renamed resources
* empty snapshots

Do not modify the UI.

---

## Agent E — Visualization/UI

Build the actual dashboard application.

The UI must support:

* current setup overview
* agents
* skills
* MCPs
* plugins
* providers/models
* commands
* project/global scope
* configuration explorer
* graph visualization
* snapshot history
* snapshot detail
* snapshot comparison
* privacy/redaction preview
* import/export

UX requirements:

* responsive
* keyboard accessible
* searchable
* filterable
* clear empty states
* clear unavailable states
* no fake data presented as real data
* distinguish current live configuration from snapshots
* show timestamps
* show source/scope
* explain redactions

Reuse useful parts of the existing dashboard prototype where appropriate.

Do not invent OpenCode resources.

Use fixture/demo data only in explicitly marked demo/test environments.

Do not modify collector/security/storage internals.

---

## Agent F — Import/Export + Sharing

Implement snapshot portability.

Responsibilities:

* export sanitized snapshots
* import snapshots
* validate schema/version
* reject malformed input safely
* produce shareable files
* support future compatibility/version migration
* ensure exported files never contain secrets

The default export must be sanitized.

The user must be able to inspect what is being exported.

Do not implement automatic uploading.

If a sharing mechanism is added, it must require explicit user action and must clearly show what leaves the machine.

Prefer file-based sharing initially unless the existing architecture strongly justifies another approach.

---

## Agent G — Testing + Threat Model

Independently review the architecture and implementation.

Do NOT blindly trust other agents.

Build:

* integration tests
* security tests
* sanitization tests
* malformed-input tests
* snapshot compatibility tests
* collector fixture tests
* UI interaction tests where supported

Specifically look for:

* secret leakage
* accidental telemetry
* network requests
* path leakage
* XSS
* unsafe import handling
* prototype pollution
* arbitrary file reads
* arbitrary command execution
* unsafe deserialization
* dependency risks
* race conditions
* concurrent snapshot corruption
* data loss

Do not rewrite other agents' implementations without documenting why.

Report findings separately.

---

# 4. CONCURRENCY RULES

Agents may run concurrently ONLY when their work is independent.

Before launching parallel agents:

* ensure Stage 1 contracts exist
* establish file ownership
* prevent multiple agents from editing the same files
* use separate worktrees/branches if supported by the framework
* otherwise use strictly separated directories/files

Never have two agents simultaneously rewrite the same core file.

Shared contract files become read-only after Stage 1 unless the lead explicitly coordinates a contract revision.

If an agent discovers that its required interface is wrong:

1. stop implementation of the conflicting portion
2. report the mismatch
3. let the lead reconcile the contract
4. update the contract deliberately
5. resume affected agents

Do not allow agents to silently invent incompatible APIs.

---

# 5. STAGE 3 — INTEGRATION

After all parallel agents finish:

Act as integration lead.

Do not assume their work is compatible.

Inspect:

* interfaces
* imports
* data flow
* error handling
* types
* storage
* sanitization boundary
* UI state
* collector behavior

Then integrate incrementally.

Run:

* type checking
* linting
* unit tests
* integration tests
* build
* security tests

Fix integration issues yourself or delegate narrowly scoped fixes.

Do NOT perform a giant rewrite.

---

# 6. STAGE 4 — END-TO-END VALIDATION

Test the actual application against a controlled fixture representing a realistic OpenCode setup.

The fixture should include:

* multiple agents
* global/project skills
* plugins
* MCPs
* providers/models
* commands
* missing resources
* malformed optional resources
* secret-like values

Verify:

```text
discover
   ↓
normalize
   ↓
sanitize
   ↓
snapshot
   ↓
store
   ↓
visualize
   ↓
diff
   ↓
export
   ↓
import
```

Every stage must preserve the privacy boundary.

Verify that the application never displays or exports the fixture's secrets.

---

# 7. LIVE DISCOVERY TEST

Only after fixture tests pass, test against the actual local OpenCode installation.

Use read-only discovery.

Do not modify:

* OpenCode config
* global skills
* global plugins
* global MCP configuration
* credentials
* auth state

Compare live discovery against known command/configuration sources where possible.

If something cannot be safely or reliably discovered:

show:

`Unavailable`

rather than guessing.

Document platform-specific limitations.

---

# 8. PRIVACY AUDIT

Perform a final privacy audit of:

* source code
* generated assets
* snapshots
* logs
* exports
* fixtures
* test artifacts

Search for:

* passwords
* API keys
* tokens
* private keys
* cookies
* credentials
* auth data
* absolute personal paths
* unrelated source code
* unexpected network endpoints

Also inspect application network behavior.

The default application must make no external requests except explicitly documented static dependencies if the architecture requires them.

Prefer bundling critical dependencies locally if practical.

---

# 9. PERFORMANCE AUDIT

Measure:

* collector execution time
* snapshot creation time
* UI startup
* large snapshot rendering
* graph rendering
* diffing
* memory usage where practical

Test with artificially large snapshots.

Avoid reading every skill body or unrelated file simply to populate the dashboard.

Discovery should collect metadata first and inspect detailed files only when necessary.

---

# 10. PRODUCT REQUIREMENTS

The finished product should feel like a real developer tool rather than a generated demo.

A user should be able to:

### First launch

```text
Open app
   ↓
Discover OpenCode
   ↓
Review detected configuration
   ↓
See privacy/redaction preview
   ↓
Create snapshot
```

### Later

```text
Open app
   ↓
See current setup
   ↓
See snapshot history
   ↓
Compare versions
   ↓
Export/share selected snapshot
```

The interface should make the distinction between:

* Live configuration
* Local snapshot
* Imported snapshot
* Exportable/shareable snapshot

immediately obvious.

---

# 11. PRIVACY MODEL

Treat privacy as a product feature, not documentation.

The UI should clearly communicate:

* what was discovered
* where it came from
* what was redacted
* what will be exported
* whether anything will leave the machine

Default:

`Local only`

Explicit user action:

`Export sanitized snapshot`

Future capability:

`Share snapshot`

Never silently upload configuration.

---

# 12. ARCHITECTURAL PRINCIPLES

Prefer:

* local-first
* offline-capable where practical
* deterministic behavior
* typed schemas
* immutable snapshots
* explicit boundaries
* small dependencies
* testable modules
* platform abstraction
* graceful degradation

Avoid:

* unnecessary microservices
* unnecessary databases
* unnecessary cloud infrastructure
* opaque telemetry
* hidden network calls
* giant monolithic files
* agent-generated fake configuration
* hardcoded assumptions about the user's OpenCode setup

---

# 13. AGENT REPORT FORMAT

Every subagent must finish with:

```text
## Completed
- ...

## Files Changed
- ...

## Tests
- ...

## Interfaces Used
- ...

## Assumptions
- ...

## Problems / Blockers
- ...

## Integration Notes
- ...
```

Keep reports concise.

Do not dump entire files into the report.

---

# 14. LEAD ENGINEER FINAL REVIEW

After integration, inspect the entire implementation as if reviewing a production PR.

Ask:

1. Can a user actually run this without OpenCode?
2. Can it dynamically discover their setup?
3. Does it work on Windows?
4. Does it avoid reading secrets?
5. Can users keep multiple snapshots?
6. Can users compare snapshots?
7. Can users export/import them?
8. Can users understand exactly what is being shared?
9. Is the default behavior local-only?
10. Is the architecture maintainable?
11. Are the agent boundaries clean?
12. Did parallel work introduce duplicated or conflicting implementations?
13. Did any agent over-engineer the solution?
14. Are there unnecessary dependencies?
15. Are there hidden network requests?
16. Are there any security/privacy regressions?

Fix concrete issues found.

Do not add speculative features.

---

# 15. DOCUMENTATION

Create/update:

* `README.md`
* architecture documentation
* privacy model
* snapshot format documentation
* development instructions
* platform limitations

Document actual behavior, not intended behavior.

Do not claim support that has not been tested.

---

# 16. FINAL OUTPUT

At the end, report:

```text
## Architecture
...

## Stages Completed
...

## Agents Used
...

## Files Added/Changed
...

## Tests
...

## Security Audit
...

## Privacy Audit
...

## Live OpenCode Discovery
...

## Snapshot Support
...

## Import/Export
...

## Known Limitations
...

## Remaining Work
...
```

Also provide:

* exact run command
* exact test command
* exact build command
* location of generated artifacts

---

# CRITICAL EXECUTION INSTRUCTION

Do NOT interpret this as a request to merely generate a plan.

After creating the implementation plan and contracts, actually execute the implementation.

Use parallel subagents where safe.

Use sequential execution where dependencies require it.

Continuously validate their work.

Do not ask me to manually coordinate the agents.

You are the lead engineer.

Your job is to demonstrate that the framework can take a substantial multi-component software project, decompose it, execute independent work concurrently, safely integrate it, test it, and produce a usable result.

Optimize for:

**correctness > privacy/security > maintainability > simplicity > speed.**

Do not stop at a prototype unless the repository's existing constraints make production implementation impossible. In that case, clearly identify the blocking constraint and implement everything that can safely be completed.
