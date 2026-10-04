# VERIFICATION.md

Independent QA of `opencode-setup-visualizer` against its template.

Run on: Windows 11 (PowerShell 5.1), Node v24.13.0, npm 11.12.1,
`@playwright/cli` 0.1.22 driving Edge, opencode v2.0.22.

Counts only for live data. No secret values and no real config contents appear below.

---

## Verdict

**SHIP WITH CAVEATS.** 187 checks pass, 0 fail, 0 blocked. The template parity gate is
exact. Nine product defects were found and fixed during verification; see the table at
the end. A pre-push leak audit was added afterwards and passes clean.

Caveats: browser verification covers Edge only; macOS and Linux remain untested;
the template's CDN dependencies mean the page is not fully offline.

**Safe to push.** `npm run audit:prepush` reports zero findings across the 49 files git
would publish, and no gitignored path is tracked or staged.

---

## Section 1 — Setup

| Check | Result | Evidence |
|---|---|---|
| Template SHA-256: pinned constant vs `template/` vs the tarball copy | PASS | all three `b08fc2d9f6a20dba…`; `verification/packaging.mjs` |
| `playwright-cli` discovered and its help read (no assumed commands) | PASS | `verification/pw.mjs`; uses `--browser msedge` |
| Chrome absent on this machine; Edge present | PASS | filesystem probe; `msedge.exe` found, `chrome.exe` absent |
| Deterministic runs: fixed viewport, reduced motion, dark scheme, fonts settled | PASS | `prepare()` in `verification/pw.mjs` |
| `.gitignore` covers `verification/artifacts/` **before** screenshots | PASS | added before any capture; live screenshots live there |

---

## Section 2 — Template parity (the key gate)

A harness (`verification/harness-server.mjs`) serves `/original` (pristine bytes) and
`/injected` (same template through the product's `inject()`, using the template's own
`SNAPSHOT` extracted in `node:vm`) from one origin, so the browser environment is
identical.

| Check | Result | Evidence |
|---|---|---|
| Bytes before the SNAPSHOT block unchanged | PASS | 15,668 bytes identical |
| Bytes after the SNAPSHOT block unchanged | PASS | 55,359 bytes identical |
| Entity count matches @1440 and @390 | PASS | 77 = 77 at both |
| `#sections` outerHTML identical | PASS | 117,971 chars, exact match |
| `#filters` outerHTML identical | PASS | 7,489 chars, exact match |
| `#hdrMeta` text identical | PASS | `v2.0.22 · Windows 11 · PowerShell 5.1 · snap 2026-10-03` |
| `#snapStamp` text identical | PASS | `snapshot 2026-10-03 · 77 entities` |
| `detail()` identical for **every** entity | PASS | 77/77 titles + chips + SHA-256(body) equal |
| No `detail()` threw on either page | PASS | 0 threw |
| Graph SVG outerHTML identical | PASS | 32,533 chars, exact match |
| Full-page screenshot pixel-identical @1440 | PASS | 0 of 8,058,240 pixels differ; **byte-identical** PNG |
| Full-page screenshot pixel-identical @390 | PASS | 0 of 4,407,780 pixels differ; **byte-identical** PNG |
| No console errors on the injected page | PASS | clean |

**Parity result: identical.** No differing entity, selector or byte.

Two corrections made during this section:

1. The first graph comparison selected `document.querySelector('svg')`, which matched
   the header logo rather than the graph. Now scoped to
   `section[aria-labelledby="h-graph"] svg`, which compares 32,533 chars.
2. Raw PNG hashes differed on an early run. Rather than dismiss it, a PNG decoder and
   pixel comparator were written (`verification/png-compare.mjs`). The pages were
   pixel-identical; the earlier difference was PNG compression metadata.

---

## Section 3 — Functional tests (rich fixture, real browser)

Fixture: fake home with agents, plugin skills, local skills, a missing resource, a
malformed `tui.json`, adversarial fake secrets, and non-allowlisted `notes.env` /
`private.pem` files that must never be read.

| Check | Result | Evidence |
|---|---|---|
| Zero console errors | PASS | 6 console lines, none errors |
| Page boots | PASS | title `OpenCode Setup — Live Observability` |
| Overview counts match **independently computed** truth | PASS | agents 3, skills 2, mcps 0, plugins 1, providers 1, models 4 |
| Plugin skill count measured from disk | PASS | `superpowers` skillCount=3, provides=3 |
| All expected sections render | PASS | 10 sections |
| Search: nonsense query shows empty state | PASS | `#empty` shown, sections len 0 |
| Search: real query narrows results | PASS | 4,421 < 58,347 |
| Search: clearing restores the full list | PASS | 58,347 = 58,347 |
| Esc in the search box clears it | PASS | value `""` |
| `/` focuses the search box | PASS | activeElement is `#q` |
| Category filter toggles `aria-pressed` and filters | PASS | false→true, 58,347→7,709 |
| Scope filter toggles and filters | PASS | 58,347→2,615 |
| Every category filter is pressable and takes effect | PASS | 11/11 |
| Reset clears all filters | PASS | 10 sections restored, `aria-pressed=false` |
| Drawer opens for **every** entity kind | PASS | 11 kinds: agent, automation, command, config, ctx, metric, model, plugin, provider, skill, warning |
| Each drawer has a title and body | PASS | 11/11 non-empty |
| Esc closes every drawer | PASS | 11/11 |
| Drawer moves focus in and returns it on close | PASS | focus in `true`, restored `true` |
| Drawer focusables contained in the drawer | PASS | all inside |
| Graph renders nodes and edges | PASS | 9 nodes, 8 edges (fixture) |
| Graph node focusable; Enter opens drawer; Esc closes | PASS | node `build`, body 1,216 chars |
| Clicking an edge highlights it | PASS | 1 hot edge |
| Config tabs switch panels | PASS | 6 tabs, hidden flags invert correctly |
| Copy button writes to clipboard and toasts | PASS | `Snippet copied` |
| No horizontal scroll @390px | PASS | `scrollWidth 390 === innerWidth 390` |
| `--no-contents` hides every config body | PASS | 6/6 hidden |
| `--no-contents` leaks no body text into the DOM | PASS | no fixture body text anywhere |

**Correction:** the first run asserted `Enter` on a graph node via a synthetic
`KeyboardEvent` and failed. A real key press works (`titleLen=5, bodyLen=1216`). The
synthetic event does not reach the activation path, so the check now uses a real press.

---

## Section 4 — Edge-case data

| Profile | Result | Evidence |
|---|---|---|
| (a) Empty setup — page not blank | PASS | 69,001 chars, 6 sections |
| (a) Empty setup — zero page errors | PASS | clean |
| (a) Empty setup — no `detail()` throws | PASS | 0 of 21 entities |
| (a) Empty setup — explicit unavailable wording | PASS | match |
| (b) Partial failure (timeouts) — not blank | PASS | 75,916 chars, 9 sections |
| (b) Partial failure — zero page errors | PASS | clean |
| (b) Partial failure — no throws | PASS | 0 of 31 entities |
| (b) Partial failure — explicit wording | PASS | match |
| (b) CLI entirely missing — not blank | PASS | 77,171 chars, 8 sections |
| (b) CLI entirely missing — no throws | PASS | 0 of 33 entities |
| (c) Huge setup (500 skills / 200 models) — counts correct | PASS | skills=500, models=200 |
| (c) Huge setup — no `detail()` throws | PASS | 0 of 729 entities |
| (c) Huge setup — collection time | PASS | **148 ms** collect, 729 entities, 722 cards |
| (c) Huge setup — renders | PASS | 10 sections, 227,817 chars |

Nothing rendered as a blank page and nothing threw.

**Correction:** four checks initially failed on console errors that were all
`ERR_CONNECTION_TIMED_OUT` / `ERR_NETWORK_CHANGED` from the template's own CDN tags
during a long run. These are now reported separately as `CDN` (informational), with
page errors counted excluding the template's CDN hosts. No product error was present.

---

## Section 5 — Privacy and security

### Canary and identity scans

Detectors written independently of the product: literal canaries, credential-shaped key
names, URL credentials, PEM headers, JWTs, env-style secrets, and an
independent entropy test over tokens ≥ 20 chars with no spaces.

| Channel | Result | Evidence |
|---|---|---|
| `/` HTML: no canary | PASS | 80,042 bytes scanned, 0 hits |
| `/` HTML: no real username or home path | PASS | both slash styles + URL-encoded |
| `/` HTML: no secret-like values | PASS | 0 findings |
| `/api/snapshot`: no canary | PASS | 11,831 bytes |
| `/api/snapshot`: no real username / home path | PASS | none |
| `/api/snapshot`: no secret-like values | PASS | 0 findings |
| `--json`: no canary | PASS | 11,268 bytes |
| `--json`: no real username / home path | PASS | none |
| `--json`: no secret-like values | PASS | 0 findings |
| `--json` stderr: no canary | PASS | 201 bytes |
| `--out` file: no canary | PASS | 79,968 bytes |
| `--out` file: no real username / home path | PASS | none |
| `--out` file: no secret-like values | PASS | 0 findings |
| Rendered DOM after opening every drawer | PASS | 165,897 chars scanned, 0 canaries |
| Paths use the home token | PASS | `%USERPROFILE%` present |
| `--no-contents` bodies carry no file text | PASS | confirmed in the browser |

Canaries planted and all confirmed absent: `sk-` key, `ghp_` token, `AKIA` key, JWT,
PEM block, a URL with embedded credentials, odd-cased `PaSsWoRd`, an env-style secret, a Windows path
with a fake username.

### HTTP behaviour

| Check | Result | Evidence |
|---|---|---|
| Binds loopback only | PASS | `address=127.0.0.1` |
| OS listing shows the port on loopback only | PASS | 1 listener, 0 non-loopback |
| Unreachable on the LAN address | PASS | a non-loopback interface address was refused; the address itself is not recorded here |
| Host `evil.example.com` rejected | PASS | 403, no page |
| Host `127.0.0.1:1` (wrong port) rejected | PASS | 403 |
| Host `127.0.0.1.attacker.test` rejected | PASS | 403 (suffix confusion) |
| Host `192.168.x.x`, `0.0.0.0`, empty rejected | PASS | 403 each |
| Allowed host control case | PASS | 200 + page served |
| POST/PUT/DELETE/PATCH/OPTIONS/TRACE rejected | PASS | 405 each |
| Traversal probes leak nothing | PASS | 19 probes, 19 refused non-200, 0 leaked |
| No `Access-Control-Allow-Origin` / `-Credentials` | PASS | absent |
| `Cache-Control: no-store`, `nosniff`, `text/html` | PASS | present |
| No open redirect | PASS | no `Location`, no 3xx, off-site targets 403/404 |
| Node process has no non-loopback TCP connections | PASS | 3 socket rows, 0 non-loopback |

Probes included `/../package.json`, `/%2e%2e/%2e%2e/etc/passwd`, `//etc/passwd`,
`/%00`, a 3000-char path, `/.git/config`, `/verification/live.mjs`.

### Network requests made by the page

9 requests, hosts: `fonts.googleapis.com`, `cdn.tailwindcss.com`, `unpkg.com`,
`fonts.gstatic.com`, `127.0.0.1`. Only loopback plus the template's own CDNs. Nothing else.

### Source audit (`test/static-audit.test.js`, part of `npm test`)

| Check | Result |
|---|---|
| No outbound HTTP client in `src/` or `bin/` | PASS |
| No telemetry / analytics / error reporting | PASS |
| No `eval`, `new Function`, dynamic `script.src` | PASS |
| Only argv-based `child_process` APIs imported | PASS |
| No `exec` / `execSync` calls anywhere | PASS |
| Only `shell: true` is the fixed browser-launch table | PASS |
| No destructive filesystem call; only write is `--out` | PASS |
| `service.json` handled shape-only | PASS |
| Template never written | PASS |
| Zero dependencies, no install scripts | PASS |
| Every source file parses | PASS |

---

## Section 6 — Mutation checks (can the tests fail?)

All applied to a temp copy. Every mutation was detected.

| Mutation | Result | Evidence |
|---|---|---|
| Corrupt template end marker | PASS | 11 tests fail; `missing the end marker` |
| Remove `agents[].deny` | PASS | 11 tests fail |
| Illegal skill scope value | PASS | 9 tests fail |
| Disable the sanitizer entirely | PASS | 15 tests fail |
| Disable only config-body redaction | PASS | secrets suite fails |
| Disable `assertClean` | PASS | 3 tests fail |
| Change one byte of the template | PASS | pinned SHA-256 test fails |
| Make the Host check permissive | PASS | 5 tests fail |
| Remove the cross-host target guard | PASS | 3 tests fail |
| Remove the de-duplication guard | PASS | 3 tests fail |

**Hole found in the first mutation harness:** it selected tests by
`--test-name-pattern`, and a pattern matching nothing exits 0 — so three mutations
looked "undetected" when the tests were in fact detecting them correctly. Fixed to
select whole test files; all ten mutations now report as detected.

---

## Section 7 — Live run (read-only, against the real install)

Counts obtained independently by invoking the CLI directly and listing files, never
through the collector.

| Resource | Dashboard | Independent | Note |
|---|---|---|---|
| Agents | 7 | 7 | includes 3 hidden internal |
| Skills | 24 | 24 | 24 rows, 24 unique names — no duplicates |
| Models | 10 | 10 | from `opencode models` |
| MCP servers | 0 | 0 | `opencode mcp list` |
| Plugins | 1 | 1 | from `opencode plugin list` |

**No unexplained differences.**

Sources that worked: `opencode --version`, `api get /api/agent`, `api get /api/skill`,
`api get /api/provider`, `opencode models`, `api get /api/mcp`, `opencode mcp list`,
`opencode plugin list`, `opencode.json`, local `model.json`. None needed the service
password. OpenCode version detected as v2.0.22.

| Check | Result | Evidence |
|---|---|---|
| Live output has no real username or home path | PASS | 33,346 bytes; home token present |
| Live output has no secret-shaped strings (independent scan) | PASS | 0 pattern hits |
| Every credential-shaped key has a redacted value | PASS | 1 key name seen, 0 non-redacted |
| Two collections deterministic (ignoring `meta.generated`) | PASS | identical |
| 20 parallel requests all succeed | PASS | all 200, 1,301 ms |
| Concurrent requests de-duplicated | PASS | **5 collections for 23 requests** |
| Cold / warm collection time | PASS | cold 1,576 ms, warm 1,357 ms |
| Live page renders every section | PASS | 10 sections, 62 cards, 70 entities |
| Live page: no `detail()` throws | PASS | 0 of 70 entities |
| Live graph renders | PASS | 35 nodes, 50 edges |

**One discrepancy observed and explained.** An early run reported the independent
counts as 0 agents and 17 skills while the dashboard showed 7 and 24. A direct probe
immediately afterwards returned 7 and 24, confirming the OpenCode background service
answered a partially-initialised payload on a cold call. The verification script now
retries an empty `api get` response; the tool itself reports what it was given. This is
recorded as a known limitation.

---

## Section 8 — Packaging

| Check | Result | Evidence |
|---|---|---|
| `npm pack --dry-run` succeeds | PASS | 22 files, 63.6 KB |
| Template included | PASS | `template/opencode-dashboard-example.html` |
| Includes package.json, README.md, bin | PASS | all present |
| Includes every src module | PASS | 17 src files |
| Excludes `verification/`, `test/`, `PROMPT/` | PASS | all absent |
| Excludes `opencode-dashboard.html`, `.env`, `service.json` | PASS | all absent |
| No secret-shaped or local-state files in the tarball | PASS | none |
| Template in the tarball matches the pinned original | PASS | all three `b08fc2d9f6a20dba…` |
| Installs into a fresh project (local only) | PASS | `added 1 package` |
| Installed copy's template is hash-identical | PASS | `b08fc2d9f6a20dba…` |
| No install scripts in the installed package | PASS | only `test` + `verify*` |
| Zero dependencies declared | PASS | none |
| Installed tree contains only this package | PASS | 23 files |
| Bin shim installed | PASS | `.bin\opencode-setup-visualizer.cmd` |
| Installed bin runs and emits valid JSON | PASS | agents=7, skills=24, providers=1 |
| Installed copy serves an injected page | PASS | status 200, 98,748 bytes |
| `npm test` × 3 | PASS | 71 pass / 0 fail each run, ~142 s each |

**Correction:** `npm pack` initially failed with `spawn EINVAL` for the same
`.cmd`-shim reason as `opencode`. The script now spawns `npm-cli.js` with the current
Node binary. The browser CLI had the same problem (`.js` entry, `EFTYPE`); `pw.mjs`
resolves and spawns it directly.

---

## Defects found and fixed

All nine were found by this verification, not by the original test suite.

| # | Defect | Before | After |
|---|---|---|---|
| 1 | `plugins.js` had `*/` inside a JSDoc comment (`skills/*/SKILL.md`), terminating it early — **the file did not parse** | `SyntaxError` on import | Comment reworded; file parses |
| 2 | `unwrapShim` only handled `%~dp0`; this npm writes `%dp0%`, so the CLI was never resolved | `opencode v… unknown`, all 8 commands failed | Handles both forms plus bare relative; all 8 commands work |
| 3 | `stripLeadingBOM` called `.replace` on non-strings, crashing every injection | `TypeError` on any object snapshot | Type-guarded |
| 4 | Config **body** redaction missed keys inside file text: `"PaSsWoRd":"…"` survived sanitisation, and `assertClean` did not catch it | canary `hunter2-not-real` present in output | Bodies re-parsed and key rules applied; canary redacted, `assertClean` passes |
| 5 | `sanitize()` defaulted `contents` to falsy, hiding all bodies unless explicitly enabled | `sanitize(x, {})` wiped every body | Defaults to contents on; only explicit `contents:false` hides |
| 6 | Collector `evidence` returned as a string was spread character-by-character | `apiEvidence` listed `"o","p","e","n","c","d"` | Strings accepted as single entries |
| 7 | Duplicate plugin entity: the CLI row `superpowers` and the config spec `superpowers@git+…` produced two plugins, and `provides` was empty because the npm cache is nested two levels deep | 2 plugins, skillCount=0 | Keyed by bare name; nested cache descent; 1 plugin, 15 skills |
| 8 | Warnings dedup was ineffective, producing two identical "sources unavailable" entries for one absent CLI | duplicate entries | Normalised dedup; credential-store notes reclassified as informational, not collection failures |
| 9 | Server ignored a cross-host request target: `//evil.example.com/` parsed to pathname `/` and served the page | 200 with the dashboard | 403; covered by `test/cross-host.test.js` and a mutation check |

---

## Holes found in the original test suite

| Hole | Fix |
|---|---|
| `npm test` used `node --test test/`, which is not a valid directory target on Windows — the whole suite errored out without running a single test | `node --test "test/**/*.test.js"` |
| No test covered the plugin-entity merge or nested npm cache, so defect 7 was invisible | Added to the fixture: nested cache + duplicate spec; asserted in `verify:functional` |
| `checkPlaintextSecrets` was called with tokenised display paths that cannot be re-read from disk, so the check never matched | Pass real filesystem paths; the fixture's `cli.json` now raises a real warning |
| `SKIP`/`CDN` statuses did not exist, so template-CDN network flakeness was reported as a product failure | Classified separately as `CDN`, informational |
| No test asserted the `--out` file for canaries as a distinct channel (only via the secrets suite) | Now a first-class check in `verify:privacy` |
| The template-integrity test compared `template/` against a byte-identical copy in `EXAMPLE-OUTPUT/`, so it would have passed even if both files had been edited — it verified a file against itself, not against the original | Duplicate removed; the pinned SHA-256 is now the sole guard, with a test asserting the duplicate has not returned |

---

## Remaining known issues

1. **The tool reports whatever the CLI returns, including a partial cold-start
   payload.** Observed once (0 agents / 17 skills from a cold `api get`). The
   verification harness retries; the tool does not. An intentional trade-off: the tool
   never invents numbers.
2. **API responses are parsed with plain `JSON.parse`,** not the
   prototype-pollution-safe `safeParse`. Not reachable today — every collector builds
   fresh objects with explicit keys rather than spreading CLI output — but worth
   tightening before v2 makes `--json` an artifact other people parse.
3. **CDN dependency.** The template loads Tailwind, Lucide and Google Fonts from CDNs.
   The page needs internet for styling and icons even though the tool makes no requests
   of its own. Not fully offline.
4. **Token estimates** use the chars/4 rule; a real tokenizer typically differs by ±10%.
   The dashboard labels them approximate.
5. **`--out` is shareable but still structural.** Sanitized of secrets, but it reveals
   local path structure and skill/plugin names.
6. **Browser verification is Edge-only** on this machine; Chrome is not installed.
7. **macOS and Linux are untested.** The code is written for them (platform-conditional
   separators, `os.homedir()`, plain-binary CLI resolution) but no run was performed.
8. **`verification/` is excluded from the package** (confirmed by `npm pack`), so the
   shipped tarball contains no verification harness.

---

## Commands to rerun everything

```bash
npm test                  # 71 node:test tests
npm run verify            # sections 2, 3, 4, 5 (browser required)
npm run verify:parity     # section 2 only
npm run verify:functional # section 3 only
npm run verify:edge       # section 4 only
npm run verify:privacy    # section 5 privacy only
npm run verify:live       # section 7, read-only against the real install
npm run verify:packaging  # section 8
node verification/mutations.mjs   # section 6
node verification/http-security.mjs
npm run audit:prepush     # leak scan of everything git would publish
npm run audit:mutation    # proves the audit can fail (11/11)
```

---

## Pre-push leak audit

Added after the initial report flagged two committed files carrying machine detail.
`verification/prepush-audit.mjs` scans every file `git ls-files --cached --others
--exclude-standard` would publish, using detectors independent of the product's
sanitizer.

| Leak class | Detected |
|---|---|
| Real username | yes |
| Real home path (backslash, forward, URL-encoded) | yes |
| This machine's LAN address | yes |
| Another RFC1918 literal | yes |
| PEM private-key block | yes |
| Provider API key | yes |
| JWT | yes |
| URL with embedded credentials | yes |
| Fixture canary outside the fixture | yes |
| Machine-only skill or config name | yes |
| Gitignored path staged or tracked | yes |

Ten mutations, each planted in a temp copy, are all detected, and the unmutated repo
is clean. The auditor reports **path + kind + length only, never a value**.

**Hole found in the auditor while proving it:** it derived its root from
`import.meta.url`, so running it against a copy with a different `cwd` still audited
the real repository and every mutation looked "undetected". It now takes an explicit
target directory.

Scrubbed as a result:

| File | Was | Now |
|---|---|---|
| `VERIFICATION.md` | this machine's RFC1918 LAN address | removed, and `http-security.mjs` reports the address masked (`#.#.#.#`) so a re-run cannot reintroduce it |
| `VERIFICATION.md` | `192.168.1.10` written out in full | `192.168.x.x` |
| `VERIFICATION.md` | a literal credential-bearing URL written out in prose | described in words |
| `PLAN.md` | this machine's `~/.config/opencode` inventory, skill counts, plugin cache path with git hash and install timestamp | rewritten as the generic layout the collector targets |
| `PLAN.md` | wording naming "the real username" | wording describing an absolute path containing the account name |

Confirmed safe and left as-is: `template/` is the anonymized dashboard (it necessarily
contains the worked example's skill and plugin names); `src/` resolves paths at runtime
and hardcodes no username; the fixture secrets are fake by construction and the auditor
knows where they are allowed to appear.

---

## Commit hygiene

A pre-push review found three things worth changing before the first push.

**1. `EXAMPLE-OUTPUT/` removed.** It was a byte-identical 99 KB duplicate of
`template/` (same SHA-256), tracked from an earlier commit and referenced only by the
integrity test — which made that test circular, since it compared the template against
a copy of itself and would have passed even if both had been edited. The pinned digest
is now the only guard, and a new test asserts the duplicate has not returned. Two files
that must stay in sync are now one file plus a constant.

**2. The global `*.png` ignore rule removed.** It was there for Playwright output, but
it would also have silently ignored a README diagram or a documentation screenshot
added later. The two real sources are covered precisely:
`.playwright-cli/` and `verification/artifacts/`. Verified: `docs/diagram.png` is now
committable.

**3. `node_modules` deliberately not ignored.** The project has zero dependencies, so
it should never exist. If it appears, that is a bug worth seeing rather than a routine
occurrence to hide.

Result: 49 files, ~0.5 MB. No ignored path is tracked or staged, and no artifact would
enter a commit.

`npm run verify` exits with a clear skip message (exit 0) when `playwright-cli` is
absent, rather than failing obscurely.
