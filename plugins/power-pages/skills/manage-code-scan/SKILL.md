---
name: manage-code-scan
description: >-
  Runs static security analysis on a Power Pages site's source code
  against a chosen framework — CWE / CWE Top 25, OWASP Top 10 (SAST
  aspect), OWASP ASVS, or CVE / dependency vulnerabilities. Scoped
  to JavaScript / TypeScript, the typical code-site surface. Picks
  the tool: Semgrep for CWE / OWASP / ASVS SAST, CodeQL for deep
  JS/TS dataflow, Trivy for dependency / SCA. Use when the user
  mentions static analysis, SAST, SCA, dependency scan, Semgrep,
  CodeQL, Trivy, CWE, CVE, OWASP scan of source code, or ASVS —
  even if they do not use the phrase "static analysis". SAST scans
  are long-running and run in the background. Out of scope:
  dynamic / runtime scanning (use /manage-site-scan),
  infrastructure-as-code, cloud compliance, mobile, LLM,
  threat modeling, adversary emulation.
user-invocable: true
argument-hint: "[optional: framework name or tool name]"
allowed-tools: Read, Write, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Code Analysis

Pick a security framework, pick the right tool for that framework, run it against the site's source code, and surface findings grouped by whatever taxonomy the chosen tool tags its rules with. Framework selection drives tool selection — the user doesn't need to know which CLI covers which framework ahead of time.

The skill orchestrates external tools (Semgrep, CodeQL, Trivy). It does not install or bundle any of them — for each missing tool, the skill stops with install guidance that points at the tool's canonical source.

## When to load which reference

- `references/frameworks.md` — load at the start of Phase 2 (framework selection) to see the full framework → tool mapping, install pointers for each tool, and command specs for the bundled scripts.

## Gotchas

- **This skill does not install tools.** If Semgrep, CodeQL, or Trivy is missing, the detect step reports the install pointer — the user installs the tool themselves and re-runs the skill. Do not attempt to `pip install` / `apt install` / download anything on their behalf.
- **Framework choice drives tool choice.** Do not pick the tool first and then pick the framework — the user's mental model is "I want an OWASP Top 10 scan," and the skill's job is to map that to Semgrep with the right ruleset. Picking CodeQL for an OWASP-Top-10 ask produces findings the user has to cross-map themselves, which is backwards.
- **SAST scans are long-running.** Semgrep runs in minutes for small projects, longer for monorepos; CodeQL typically takes a few minutes for small JS/TS projects, tens of minutes for medium, an hour or more for large. Always run SAST via `Bash run_in_background` and hand off to Phase 6 — do NOT wait synchronously.
- **SCA and license scans are fast.** Trivy typically completes in under a minute on a typical code site. It can run synchronously in Phase 5 without the background-launch pattern.
- **Each tool tags findings differently and that's fine.** Semgrep tags `cwe:CWE-89` and `owasp:A03:2021` directly on findings. CodeQL tags `external/cwe/cwe-NNN` on rules. Trivy uses CVE IDs on rule IDs (and license classes for license audit). `parse-sarif.js` surfaces tags verbatim — do not try to cross-map one taxonomy to another. Present findings using whatever tags the chosen tool emits.
- **CodeQL's license restricts commercial closed-source use.** If the user chooses CodeQL for a commercial closed-source project, remind them the license applies; point at the CodeQL release page link surfaced by `check-tools.js`. The skill does not enforce license compliance — that is the user's responsibility.
- **Node_modules and build output skew scans.** All four tools have defaults that exclude `node_modules` — other generated directories (`dist`, `build`, `.next`, vendored `lib/`) do not, and running against them produces duplicated and irrelevant findings. Detect and exclude them in Phase 4.
- **Non-JS/TS code is out of scope.** This skill scans JavaScript / TypeScript source only — the typical Power Pages code-site surface. `detect-languages.js` still reports every detected language so the skill can flag significant non-JS/TS content (e.g., a sizable Python or C# subtree) to the user, but it will not scan it. Users who need Python, Java, C#, etc. coverage should run Semgrep / CodeQL directly against those trees outside this skill.
- **False positives are expected.** Static analyzers can't always know what is or isn't reachable. Present findings with severity and let the user triage; do not claim a vulnerability exists based on a single hit alone.

## Workflow

At the start of Phase 1, create one task per phase with `TaskCreate`. Mark `in_progress` when you enter a phase and `completed` the moment it ends — do not batch updates. The final response carries a progress tracking table (see the end of this file) so the user can see at-a-glance what each phase produced.

### Phase 1 — Check which scan tools are installed

Run the tool detection:
```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-code-scan/scripts/check-tools.js"
```

The output lists every supported CLI with `present: true|false`, the version if present, and an install pointer if absent. Keep the output — Phase 3 uses it to propose a tool the user actually has.

If NO tool is installed, tell the user the skill needs at least one of Semgrep / CodeQL / Trivy depending on the framework they pick, surface the install pointers, and stop.

### Phase 2 — Select the security framework

Use `AskUserQuestion` to ask which framework to assess against. The supported options are:

| Framework | What it covers |
|---|---|
| CWE / CWE Top 25 (SAST) | Source-code weaknesses tagged with CWE IDs; the CWE Top 25 list specifically flags the most critical classes. |
| OWASP Top 10 (SAST aspect) | Source-code findings tagged with OWASP Top 10 categories. For the DAST aspect — runtime vulnerabilities — delegate to `/manage-site-scan`. |
| OWASP ASVS | Findings tagged against OWASP Application Security Verification Standard control sections. |
| CVE / dependency vulnerabilities (SCA) | Vulnerabilities in third-party dependencies, tagged by CVE ID and severity. Trivy also surfaces packages whose upstream has reached end-of-life ("deprecated" / EOL) alongside the CVEs. |
| Dependency license audit | Licenses declared by each third-party dependency, flagging copyleft (GPL / AGPL / LGPL) and "unknown / unclassified" entries so the user can confirm the site's distribution model permits them. Important for non-open-source / commercial sites. |
| Bring-your-own checklist | User-supplied Semgrep rules, CodeQL query pack, or custom config. |

For frameworks outside this skill's scope, repeat the scope note from the top of this file and stop. Do not pretend to run a framework this skill can't service.

Keep the chosen framework in your response context — Phase 3 maps it to a tool.

### Phase 3 — Select the tool for that framework

Based on the framework chosen in Phase 2 and the tools available from Phase 1, propose a primary tool and any acceptable alternative. Reference: `references/frameworks.md` for the full mapping.

Include the typical duration and whether the scan blocks the session when proposing — that's what the user needs to decide "run it now" vs "fit it into a CI pipeline" vs "I'll bring you back when it's done".

| Framework | Primary tool | Alternative | Typical duration (primary) | Runs as |
|---|---|---|---|---|
| CWE / CWE Top 25 | Semgrep | CodeQL (deeper but slower) | Minutes for small projects; tens of minutes for monorepos | SAST — **background** (Phase 5 hands off) |
| OWASP Top 10 (SAST) | Semgrep | CodeQL (loses direct OWASP tags — findings come CWE-tagged only) | Same as above | SAST — **background** |
| OWASP ASVS | Semgrep | — | Same as above | SAST — **background** |
| CVE / SCA | Trivy | — (user can name another if they prefer) | Typically under a minute | SCA — **synchronous** (Phase 5 waits) |
| Dependency license audit | Trivy | — | Typically under a minute; can be combined with CVE in one Trivy call | SCA — **synchronous** |
| Bring-your-own | Whichever tool fits the user's rules / query pack | — | Depends on the chosen tool — quote the primary-tool row above | Depends |

CodeQL's duration range is wider than Semgrep's — a few minutes for small JS/TS projects, tens of minutes for medium, an hour or more for large monorepos. Flag this when proposing CodeQL as an alternative — the user may decide the OWASP-tag convenience of Semgrep outweighs CodeQL's deeper dataflow analysis if they're iterating interactively.

If the primary tool is not installed but an alternative is, propose the alternative explicitly and note BOTH the trade-off and the duration difference (e.g. "Semgrep isn't installed; CodeQL is available but it only tags CWE, not OWASP directly — you will need to interpret findings against OWASP categories yourself, and the scan will likely take longer"). If neither is installed, stop and surface the install pointers from Phase 1.

Confirm the choice with the user before moving on.

### Phase 4 — Plan

Gather the scan configuration. Show the user what you propose; get explicit approval.

| Decision | Default | Override when |
|---|---|---|
| Project root | current working directory | User wants to scan a subdirectory |
| Language (CodeQL only) | `javascript-typescript` — this skill scopes to JS/TS | N/A — this skill does not scan other languages. If `detect-languages.js` shows significant non-JS/TS content, flag it to the user but do not scan it here |
| Ruleset / query suite | See framework → ruleset table below | User explicitly requests a different ruleset |
| Excludes | Tool defaults plus common build outputs (`dist`, `build`, `out`, `.next`, minified files, vendored `lib/`) | Add any project-specific dirs you spot |
| Output path | `.manage-code-scan-output.sarif` at the project root | User wants a dated / named output file |

**Ruleset / query-suite map:**

| Tool | Framework | Ruleset / suite |
|---|---|---|
| Semgrep | CWE Top 25 | `p/cwe-top-25` |
| Semgrep | OWASP Top 10 | `p/owasp-top-ten` |
| Semgrep | OWASP ASVS | `p/owasp-asvs` |
| Semgrep | General security | `p/security-audit` or `p/ci` |
| CodeQL | CWE / OWASP (SAST) | `codeql/javascript-queries:codeql-suites/javascript-security-extended.qls` |
| Trivy | CVE / SCA | `--scanners vuln` (default filesystem scan) |
| Trivy | Dependency license audit | `--scanners license` (filesystem scan, license-only output) |
| Trivy | CVE + license combined | `--scanners vuln,license` (single Trivy call, both concerns covered in one pass) |

For the language detection step (CodeQL path), run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-code-scan/scripts/detect-languages.js" --projectRoot "<project-root>"
```

### Phase 5 — Execute

**SAST (Semgrep or CodeQL) — long-running, run in the background.**

Semgrep:
```bash
semgrep scan \
  --config <ruleset> \
  --sarif \
  --output <sarif-path> \
  --exclude node_modules --exclude dist --exclude build \
  <project-root>
```

CodeQL — use the wrapper, which handles `database create` + `database analyze`:
```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-code-scan/scripts/run-codeql.js" \
  --projectRoot "<project-root>" \
  --language javascript-typescript \
  --querySuite "codeql/javascript-queries:codeql-suites/javascript-security-extended.qls" \
  --dbPath "<project-root>/.codeql-db" \
  --sarifOut "<sarif-path>"
```

Invoke via `Bash` with `run_in_background: true`. Tell the user the scan is running, estimate the duration (minutes for small projects, longer for monorepos), and give them the paired parse command for when it completes:
```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-code-scan/scripts/parse-sarif.js" --sarif "<sarif-path>"
```

A registered `UserPromptSubmit` hook (`hooks/code-scan-check.js`) watches for the `.codeql-db/.state-done` marker that `run-codeql.js` writes on completion. When the user returns to the session with any new prompt, the hook surfaces a one-time note to Claude reminding it the scan is done and pointing at the paired parse command — so you do not need to poll manually.

Then jump to Phase 6 with what you have — the parse command is the follow-up.

**SCA / license audit (Trivy) — fast, run synchronously.**

Trivy for CVE-only:
```bash
trivy fs \
  --scanners vuln \
  --severity HIGH,CRITICAL \
  --format sarif \
  --output <sarif-path> \
  <project-root>
```

Trivy for license-only (dependency license audit):
```bash
trivy fs \
  --scanners license \
  --format json \
  --output <license-output-path> \
  <project-root>
```

Trivy for both CVE + license in one pass (recommended when the user chose either framework — covers both with a single walk of the dependency tree):
```bash
trivy fs \
  --scanners vuln,license \
  --format json \
  --output <combined-output-path> \
  <project-root>
```

License output is richer in JSON than SARIF (SARIF lacks a clean license-finding shape), so emit JSON when licenses are in scope and parse the `Licenses` array per package. Findings of interest: any license classified `restricted` or `reciprocal` by Trivy (GPL / AGPL / LGPL families), plus any entries with `unknown` / unclassified licenses — those need the user to confirm they have commercial rights.

Then run `parse-sarif.js` inline to get the structured summary for Phase 6.

**Error handling**

Branch on exit codes (full table in `references/frameworks.md`). Common ones:

- Exit `3` (for `run-codeql.js`) — CodeQL CLI not on PATH. This should have been caught in Phase 1 — re-run `check-tools.js` and re-read install guidance.
- Exit `4` — the underlying tool ran but failed. Surface the tool's stderr verbatim. For CodeQL, common fix is `--ram=4096` on large projects. For Semgrep, often a ruleset-config issue. For Trivy, typically a parseable lockfile issue.
- Exit `2` — invalid arguments or input; re-read `frameworks.md`, correct, retry.
- Exit `1` — unknown; surface stderr and stop.

### Phase 6 — Present findings

Run `parse-sarif.js` on whichever SARIF was produced. The output gives you the tool name, total count, counts by severity, counts per rule, and a flat list (truncated to `--limit`).

Present to the user:

1. **Headline** — which tool ran, against which framework / ruleset, and how many findings at each severity.
2. **Top rules / findings** — the 3–5 rules with the most hits. For each, show the rule id, severity, and a representative finding (file + line + message).
3. **Organize findings by framework tag** (framework-specific — look at the rule tags):
   - **Semgrep + OWASP Top 10**: Semgrep tags `owasp:A01:2021` etc. directly. Organize findings by the OWASP tag; if a finding has no OWASP tag, list it under the rule id instead.
   - **Semgrep + CWE Top 25 / ASVS**: Organize by the relevant tag (`cwe:CWE-NNN`, `asvs:v*.*.*`).
   - **CodeQL**: Organize by the CWE tag in `external/cwe/cwe-NNN`. If the user asked for OWASP Top 10, note that CodeQL tags CWE not OWASP — list findings under CWE and let the user map if they want.
   - **Trivy CVE / SCA**: Organize by CVE severity (CRITICAL / HIGH / MEDIUM / LOW) and package name. Call out any EOL / deprecated upstreams Trivy reports alongside CVEs — an unmaintained package is a forward-looking risk even when no CVE is currently filed.
   - **Trivy license audit**: Group by license family (`restricted` → copyleft like GPL / AGPL / LGPL; `reciprocal` → Mozilla-class weak copyleft; `permissive` → MIT / Apache / BSD; `unknown`). For a commercial / non-open-source site, the first two groups plus every `unknown` entry require explicit user confirmation that the distribution model permits them.
4. **Action hints** — for each prominent finding, briefly note the remediation direction (e.g. "parameterize queries" for injection, "pin / upgrade the package" for CVE, "swap to a permissive-licensed package or secure a commercial license" for a copyleft dependency). Keep these terse.

Do not dump the full finding list unless asked. Large scans produce hundreds of findings; a wall of text buries the important ones.

### Phase 7 — Summarize and record usage

Summarize the session:
- Framework chosen, tool used, ruleset applied.
- Headline numbers — total findings, breakdown by severity, top rule / tag categories.
- Next actions — if a SAST scan was started in the background, remind the user of the paired `parse-sarif.js` command and where the SARIF will land. If a scan was skipped, record that the user consciously skipped this analysis.

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill-tracking instructions in the reference to record this skill's usage. Use `--skillName "ManageCodeScan"`.

Close by asking: "Anything else on code analysis, or done?" If the user wants a broader security review, suggest `/review-security`.

## Progress tracking table

Keep this table in your final response, filling each status as phases complete:

| Phase | Status |
|---|---|
| 1. Check scan tools | ☐ |
| 2. Select framework | ☐ |
| 3. Select tool | ☐ |
| 4. Plan | ☐ |
| 5. Execute | ☐ |
| 6. Present findings | ☐ |
| 7. Summarize and record usage | ☐ |
