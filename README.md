# opencode-setup-visualizer

**See what your agent setup actually costs you.**

Your OpenCode setup is invisible. You have dozens of skills, a plugin tree, config
files scattered across two directories, and a number in a file somewhere called
`tokens`. None of it tells you what any of it is *doing* to you — until you count
yourself.

This tool reads your real installation and shows you the bill.

```
24 skills · 1.4k tokens resident in every single session
```

That's the number that made me cut things. Once you can see it, optimising stops
being guesswork.

<sub>Zero dependencies · Node >= 18 · nothing leaves your machine</sub>

![The dashboard: counts read live from OpenCode, with an agent fleet, context
overhead breakdown, config inspector and verified findings](docs/dashboard.png)

<sub>Rendered from the synthetic test fixture, not a real machine — see
[Privacy](#privacy-wasnt-a-feature-it-was-a-constraint).</sub>

---

## What I built it for

I wanted to look at my setup. Then I wanted to *share* it — and a screenshot of a
dashboard can't do that. What I have instead is a JSON snapshot that another person
could hand to an agent and say: *build me something like this.*

That's the v2 direction. This is v1: the collector already produces exactly that
artifact (`--json`), it's already sanitised, and it's already deterministic. The
visualisation is how I found the problems in the first place.

---

## The part I'm proudest of: context overhead

Every session silently pays a tax before you type a word. Most of it is
*frontmatter* — the name and description of every skill you own, loaded on every
single turn so the model knows what it *could* reach. That index is pure overhead
until a skill actually fires.

The dashboard breaks it down:

- **Always resident** — what you're paying before your first message. The skill
  index is almost always the biggest line item.
- **On demand** — the bodies, which cost nothing until invoked. This is where the
  real cost hides if you misread the first chart.
- **Not present** — zero, but stated explicitly. Zero cost and *unknown* are very
  different, and a dashboard that can't tell you apart is lying by omission.

It measures real bytes on disk and the real character counts the CLI reports. The
chars/4 rule is an estimate and the dashboard says so; a real tokenizer typically
lands within ±10%.

**What I changed because of it:**

The clearest win was retiring an MCP server and moving that capability to the CLI.
An MCP server injects its tool schemas into context permanently. A CLI subcommand
costs nothing until invoked. Same capability, and the resident number dropped
because a whole schema block stopped being charged to every session. That
dashboard is why I knew to do it, and why I'd know when to do it again.

---

## Privacy wasn't a feature, it was a constraint

The tool reads the directory that holds your credentials, then hands you a page
that renders its contents in full. Getting that wrong isn't embarrassing, it's
dangerous — so the design started from "what could possibly leak" rather than
"what should I bother masking."

Concretely:

- **The dashboard template is copied, not rewritten.** It's read byte-for-byte and
  its SHA-256 is pinned in a test, so any change fails the suite. All data
  injection happens in memory at serve time. The pin has been re-cut exactly once,
  for three data bindings that replaced hardcoded values with reads from the
  snapshot: the skill total, the project-local resource count, and which provider
  a model's drawer describes. Nothing else in the template was touched.
- **A privacy boundary, not a filter.** Everything leaving the process passes
  through one recursive sanitizer. It combines structural detection (key names
  normalised for case and camelCase, so `PaSsWoRd` and `api_key` both match) with
  pattern detection (key prefixes, JWTs, PEM blocks, credential-in-URL, high-entropy
  tokens). Then `assertClean()` re-scans the serialised output and **aborts rather
  than serving** if anything still matches.
- **Config file *bodies* are re-parsed.** This was a real bug I found and fixed:
  a key inside a JSON blob is invisible to object-walking, so a password sitting in
  `cli.json` sailed straight through. The sanitizer now parses bodies and applies
  the same rules.
- **Credential stores are shape-only.** `service.json` and `auth.json` are opened
  solely to read their key *names*. Values are never read into the snapshot, never
  logged, never emitted. The redaction report holds counts per kind and never a
  value.
- **Provider API keys are dropped wholesale.** The `settings` object is discarded
  before an entry is even normalised.
- **Skill bodies are never emitted.** The API hands you every `SKILL.md` in full;
  only the character count is kept.
- **Your paths are tokenised.** `%USERPROFILE%` or `~`, everywhere.
- **Nothing leaves the machine.** No telemetry, no analytics, no outbound HTTP
  client anywhere in the source. The server binds loopback and answers nothing but
  `127.0.0.1`.

The `--json` output is a shareable artifact *by construction*, not by a cleanup step
you forgot to run. That's what makes the v2 "hand someone a snapshot" plan viable —
and it's also why there's a pre-push audit, which scans everything Git would publish
for leaks and is mutation-tested so it can't pass vacuously.

---

## What it shows you

Ten sections, all measured, none guessed: agents and what they're allowed to do,
skills with their real on-disk sizes, plugins and the skills each provides, MCP
servers, providers and reachable models, slash commands, context overhead, a config
inspector with a redacted view of your actual files, verified findings, and a
relationship graph.

A drawer on anything explains it. So does an honest empty state — if a source
couldn't be read, the dashboard says so in that section rather than quietly
rendering nothing, because "zero" and "unknown" are different answers.

**What leaves the machine: nothing.** One nuance worth stating plainly — the
dashboard template loads Tailwind, Lucide and Google Fonts from CDNs, so the *page*
needs internet for styling and icons. Those requests come from the template's own
tags, not from this tool. It is not fully offline.

---

## Who it's for

Anyone running OpenCode with a non-trivial setup — enough skills that the resident
context index has become a number worth arguing with, and enough customisation that
nobody remembers what's configured. If you're still on the built-in defaults, this
will tell you that, which is also useful.

If you've ever installed a skill and genuinely didn't know whether it was being
loaded every turn: this answers that.

It is read-only and makes no changes to your configuration.

---

## Running it

```bash
node bin/opencode-setup-visualizer.js
```

Discovers your OpenCode install, serves the dashboard on `127.0.0.1:4173` with live
data injected, opens your browser. `Ctrl+C` stops it. Zero dependencies, Node >= 18.

```bash
npm test          # 158 tests, no browser needed
npm run verify    # browser-driven parity, functional, edge-case and privacy checks
npm run audit:prepush   # scans everything Git would publish for leaks
```

<details>
<summary>Flags</summary>

| Flag | Effect |
|---|---|
| `--port <n>` | Listen on `n` (default `4173`); walks forward if busy |
| `--project <dir>` | Project directory to inspect (default: cwd) |
| `--no-open` | Don't launch a browser |
| `--no-contents` | Hide config file bodies; keeps paths and sizes |
| `--json` | Print the sanitized snapshot and exit |
| `--out <file.html>` | Write a static sanitized copy and exit |

**To refresh, reload the tab.** The template's Reset button only re-runs in-page
filters and search — it doesn't re-collect. The server collects on every request,
so a reload is always fresh.
</details>

<details>
<summary>Platform support</summary>

Tested on Windows 11 (PowerShell 5.1), Node 24, Edge. macOS and Linux are written
for but untested — I won't claim support I didn't exercise.

</details>

---

## Known limitations

- The template's own text is still there: the `static snapshot` badge, the
  `Redacted: service.json → password` footer, and the Reset button.
- Not fully offline — see above.
- Tokens are chars/4 estimates, labelled approximate.
- A cold `opencode api get` call can return a partial payload. The tool reports
  what it was given rather than inventing numbers.
- `--out` is sanitised but still reveals your local path structure and your skill
  and plugin names. Read it before you publish.
