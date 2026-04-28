# Manage-code-scan frameworks and tools

Single consolidated reference — the security frameworks this skill supports, which tool to use for each, install pointers, and command specs for the bundled scripts.

## Contents

- [Supported frameworks → recommended tool](#supported-frameworks--recommended-tool)
- [Semgrep — primary SAST tool](#semgrep--primary-sast-tool)
- [CodeQL — deep SAST alternative for JS/TS](#codeql--deep-sast-alternative-for-jsts)
- [Trivy — SCA, dependency CVE, and license scanning](#trivy--sca-dependency-cve-and-license-scanning)
- [Bring-your-own checklist](#bring-your-own-checklist)
- [Command spec — `check-tools.js`](#command-spec--check-toolsjs)
- [Command spec — `detect-languages.js`](#command-spec--detect-languagesjs)
- [Command spec — `run-codeql.js`](#command-spec--run-codeqljs)
- [Command spec — `parse-sarif.js`](#command-spec--parse-sarifjs)
- [Shared exit codes](#shared-exit-codes)

## Supported frameworks → recommended tool

Phase 3 of the skill asks the user which framework to assess against. Phase 4 then picks the tool based on the framework. The table below captures that mapping.

| Framework | Primary tool | Alternatives | Why this pairing |
|---|---|---|---|
| **CWE / CWE Top 25** (SAST) | Semgrep | CodeQL | Semgrep has a dedicated CWE Top 25 ruleset (`p/cwe-top-25`) and tags findings with CWE IDs directly. CodeQL covers CWE via its rule metadata; use it when deep dataflow analysis is worth the longer scan time. |
| **OWASP Top 10** (SAST aspect) | Semgrep | CodeQL | Semgrep has an OWASP Top 10 ruleset (`p/owasp-top-ten`) with direct OWASP category tags (`owasp:A01:2021`). CodeQL tags CWE but not OWASP directly. For the DAST aspect of OWASP Top 10, use `/manage-site-scan`. |
| **OWASP ASVS** | Semgrep | — | Semgrep ships an ASVS ruleset (`p/owasp-asvs`) that tags findings against ASVS control sections. No other OSS SAST CLI has a dedicated ASVS ruleset. |
| **CVE / dependency vulnerabilities** | Trivy | Grype+Syft, OSV-Scanner, OWASP Dependency-Check | Trivy is the de facto standard — single binary, scans filesystem / repo for dependency vulnerabilities, tags by CVE + severity + package. It also flags packages whose upstream has reached end-of-life alongside the CVEs, which catches forward-looking risk even when no CVE is currently filed. The alternatives cover the same ground; pick based on user preference or existing CI. |
| **Dependency license audit** | Trivy | ScanCode, Syft (SPDX-license output) | Trivy classifies every declared dependency license into `restricted` (copyleft — GPL / AGPL / LGPL), `reciprocal` (weak copyleft — Mozilla-class), `permissive` (MIT / Apache / BSD / ISC), or `unknown`. For non-open-source / commercial sites, the first two groups plus every `unknown` entry need explicit user confirmation that the distribution model permits them. Combine with CVE in one pass via `--scanners vuln,license`. |
| **Bring-your-own checklist** | User-supplied config / rules | — | User points at their own Semgrep rules, CodeQL query pack, or other config — the skill runs whichever primary tool fits. |

## Semgrep — primary SAST tool

**What it covers:** SAST against CWE, OWASP Top 10, OWASP ASVS, and many other rulesets. Multi-language (JS, TS, Python, Java, Go, Ruby, C#, PHP, and more). Rules are tagged with CWE and OWASP directly on findings — no cross-taxonomy mapping required.

**Install:** `pip install semgrep` or `pipx install semgrep`. Semgrep is a Python package and is also available via Homebrew and other system package managers.

**Recommended rulesets:**

| Framework | `--config` value |
|---|---|
| Default CI ruleset (recommended for a first scan) | `p/ci` |
| CWE Top 25 | `p/cwe-top-25` |
| OWASP Top 10 | `p/owasp-top-ten` |
| OWASP ASVS | `p/owasp-asvs` |
| General security audit | `p/security-audit` |

**Invocation:**
```bash
semgrep scan \
  --config <ruleset> \
  --sarif \
  --output <sarif-path> \
  <project-root>
```

**Excludes:** pass `--exclude` for each directory to skip (`--exclude node_modules --exclude dist --exclude build`). Semgrep respects `.semgrepignore` at the project root.

**Duration:** typically a few minutes for small / medium projects; larger monorepos can run tens of minutes. Run in the background via `Bash run_in_background`.

## CodeQL — deep SAST alternative for JS/TS

**What it covers:** deep dataflow-based SAST for JavaScript, TypeScript, Python, Java, C#, C/C++, Go, Ruby, Swift. Rules are CWE-tagged but NOT OWASP-tagged; if the user wants findings organized by OWASP category, use Semgrep instead.

**Install:** download the CodeQL CLI binary archive for your platform from the official GitHub maintainer-hosted release, unpack to a stable location (e.g., `~/codeql` on macOS / Linux or `C:/tools/codeql` on Windows), and add the directory containing the `codeql` executable to PATH.

**Licensing:** the CodeQL CLI is free for analyzing open-source codebases and for GitHub code scanning; other uses may require a separate license. The user is responsible for compliance — the skill orchestrates; it does not bundle or redistribute the CLI.

**Recommended query suite:** `codeql/javascript-queries:codeql-suites/javascript-security-extended.qls` — maximum OWASP / CWE security coverage without the maintainability-rule noise of `security-and-quality`.

**JS/TS-only note.** This skill scopes its CodeQL orchestration to the JavaScript/TypeScript extractor (one language id `javascript-typescript` covers both). CodeQL does support other languages (Python, Java, C#, C/C++, Go, Ruby, Swift) but this skill does not orchestrate them — users with significant non-JS/TS code in their project should invoke CodeQL directly against those trees, outside this skill.

**Workflow** — two steps wrapped by `run-codeql.js`:
```bash
codeql database create <db-path> --language=<language-id> --source-root=<project-root> [--ram=4096]
codeql database analyze <db-path> <query-suite> --format=sarif-latest --output=<sarif-path> [--ram=4096]
```

**Duration:** small JS/TS projects a few minutes; medium projects tens of minutes; large monorepos an hour or more. Run in the background.

## Trivy — SCA, dependency CVE, and license scanning

**What it covers:** scans the code-site filesystem (lock files + `package.json`, and equivalent manifests in other ecosystems) for third-party dependency vulnerabilities (CVE-tagged by severity) and declared licenses. Single binary, no runtime dependency.

**Install:** via a system package manager (`brew install trivy`, `apt install trivy`, `scoop install trivy`) or download the prebuilt binary from the official Trivy releases.

**Invocation for CVE / SCA:**
```bash
trivy fs \
  --scanners vuln \
  --severity HIGH,CRITICAL \
  --format sarif \
  --output <sarif-path> \
  <project-root>
```

**Invocation for dependency license audit:**
```bash
trivy fs \
  --scanners license \
  --format json \
  --output <license-output-path> \
  <project-root>
```

**Invocation for CVE + license in one pass (recommended when either framework is in scope):**
```bash
trivy fs \
  --scanners vuln,license \
  --format json \
  --output <combined-output-path> \
  <project-root>
```

License findings are richer in JSON than in SARIF — emit JSON when licenses are in scope and parse the `Licenses` array per package. Each license is classified by Trivy as `restricted` (GPL / AGPL / LGPL copyleft), `reciprocal` (Mozilla-class weak copyleft), `permissive` (MIT / Apache / BSD / ISC), or `unknown`.

Add `--scanners vuln,secret` to also scan for leaked secrets in the same run. Trivy also surfaces packages whose upstream has reached end-of-life (EOL) alongside CVE findings — call these out even when no CVE is currently filed, because an unmaintained package is a forward-looking risk.

**Duration:** fast — typically under a minute for small-to-medium projects. Can run synchronously without the background-launch pattern.

## Bring-your-own checklist

Users may have internal security checklists that are not captured by off-the-shelf rulesets. Two supported patterns:

1. **Custom Semgrep rules** — user points at a local rules file or private Semgrep ruleset via `--config <path-or-registry-url>`. The scan runs through the same Semgrep invocation above.
2. **Custom CodeQL query pack** — user points at a private query pack; `run-codeql.js` accepts any `<pack:suite.qls>` via the `--querySuite` argument.

If the user has a free-form checklist (e.g. a PDF or a wiki page), the skill cannot scan against it directly — offer to translate the top items into Semgrep rules or flag items that can be checked manually.

## Command spec — `check-tools.js`

Detect which of the supported CLIs are on PATH.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-code-scan/scripts/check-tools.js" \
  [--tool <semgrep|codeql|trivy>]
```

**Read or write**: read.

**Response** — JSON keyed by tool name; each entry has `present` (boolean), `version` (when present), `covers` (short description), and `install` (install pointer, only when absent).

## Command spec — `detect-languages.js`

Walk the project tree and report which languages are present (used to pick a CodeQL language and to warn about multi-language projects).

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-code-scan/scripts/detect-languages.js" \
  --projectRoot "<project-root>" \
  [--exclude <comma-separated directory names>]
```

**Response**

```json
{
  "languages": [{ "id": "javascript-typescript", "fileCount": N, "extensions": [".ts", ".tsx", ...] }, ...],
  "primary": "javascript-typescript",
  "totalFiles": N
}
```

`primary` is the language with the highest file count. For Power Pages code sites this is almost always `javascript-typescript`.

## Command spec — `run-codeql.js`

Orchestrate `codeql database create` + `codeql database analyze`. Designed to be invoked via `Bash run_in_background` — the scan is long-running.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-code-scan/scripts/run-codeql.js" \
  --projectRoot "<project-root>" \
  --language <language-id> \
  --querySuite "<pack:suite.qls>" \
  --dbPath "<db-path>" \
  --sarifOut "<sarif-path>" \
  [--ram <MB>] \
  [--pathsIgnore "<comma-separated paths>"]
```

Writes phase-marker files (`.state-create`, `.state-analyze`, `.state-done`, `.state-error`) next to the database so external pollers can see progress. Emits a structured JSON result on completion.

Semgrep and Trivy are invoked directly from the skill body (single-command tools); only CodeQL warrants a wrapper because of its two-step workflow.

## Command spec — `parse-sarif.js`

Read a SARIF file from any tool and produce a structured summary keyed by `ruleId` with tags surfaced verbatim.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-code-scan/scripts/parse-sarif.js" \
  --sarif "<sarif-path>" \
  [--limit <N>]
```

**Response**

```json
{
  "tool": "<tool name from SARIF driver>",
  "summary": {
    "totalFindings": N,
    "bySeverity": { "error": N, "warning": N, "note": N },
    "byRule": { "<ruleId>": N }
  },
  "byRule": { "<ruleId>": [{ ruleId, severity, file, line, message, tags, ... }] },
  "findings": [{ ruleId, severity, file, line, message, tags, ... }]
}
```

Tags from each tool (CWE from CodeQL, OWASP + CWE from Semgrep, CVE IDs and license classes from Trivy) are surfaced verbatim. The skill interprets per-tool in Phase 7 without a cross-taxonomy mapping.

## Shared exit codes

Every script uses the same exit-code space.

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Unknown / I/O failure |
| `2` | Invalid arguments or input file not found / malformed |
| `3` | Required tool not on PATH (for `run-codeql.js`; for detection scripts, absence is data, not an error) |
| `4` | Underlying tool ran but failed — scan error, out of memory, extractor failure. Stderr carries the tool's message. |

`node <script> --help` prints the same table where applicable.
