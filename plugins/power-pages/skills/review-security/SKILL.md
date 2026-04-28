---
name: review-security
description: >-
  Orchestrates an end-to-end security review of a Power Pages site.
  Asks in plain language (technical names in parentheses): (1)
  single-select the site-code view — OWASP Top 10 / CWE Top 25 /
  OWASP ASVS / skip — which drives the same scan under different
  groupings; (2) multi-select additional checks — CVE / SCA,
  package licensing, bring-your-own checklist; (3) toggle the deep
  dynamic scan. Runs the posture snapshot plus scans implied by
  the selected concerns, produces a unified HTML report with one
  section per concern, and applies remediations per-change,
  delegating to the sibling skill that owns each concern
  (WAF, headers, scan, code analysis, auth, web roles,
  table permissions, deploy). Use when the user asks for a
  security review, audit, posture check, OWASP / CWE / CVE / ASVS
  assessment, license check, or hardening sweep — even without
  naming a framework. Out of scope: single-check invocations, IaC
  scanning, and frameworks beyond those listed.
user-invocable: true
argument-hint: "[optional: focus area, e.g. 'full review' or 'only CSP']"
allowed-tools: Read, Write, Bash, Glob, Grep, WebFetch, AskUserQuestion, TaskCreate, TaskUpdate, TaskList, Agent
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Security

Coordinate a security review of a Power Pages site. This skill does no scanning of its own — every finding comes from one of the specialized security-area skills or existing plugin skills, and every remediation delegates back to the skill that owns the concern. The value here is the *concern-driven sequencing*, the *unified report with one section per selected concern*, and the *per-change approval loop* that makes hardening safe.

Every change is one delegated invocation behind explicit user approval — no batch application, no silent writes. The skill that owns the change stays authoritative; this skill never reimplements anything they do.

## When to load which reference

- `references/orchestration.md` — load at the start of Phase 3 (concern selection) for the concern → scan-tool mapping, the concern → report-grouping mapping, the OWASP category → security area mapping, the full finding-type → delegation table, and the findings JSON schema the HTML report consumes.
- `${CLAUDE_PLUGIN_ROOT}/references/domain-attack-profiles.md` — load in Phase 2 for the detection guidance, and again when building the findings JSON in Phase 6 to pull the chosen domain's `top_owasp`, `regulatory_frame`, and `failure_emphasis` / `pass_emphasis` snippets.
- `${CLAUDE_PLUGIN_ROOT}/references/threat-context.md` — load when building the findings JSON in Phase 6 for OWASP rank lookup, runtime metric fetching (CVE enrichment), confidence-message templates, and tradeoff caveats.
- `${CLAUDE_PLUGIN_ROOT}/references/regulatory-controls.md` — load when building the findings JSON in Phase 6 to map the chosen domain's `regulatory_frame` to specific automatable controls, populate `metadata.regulatoryCoverage[]`, and link findings to the controls they satisfy.

## Gotchas

- **Concern-driven, not tool-driven.** OWASP Top 10 / CWE Top 25 / ASVS are *views* the user picks — they describe how findings are grouped in the report, not which tool to run. `manage-site-scan` (ZAP-based dynamic scan) is a tool that covers *a subset* of those views. Running ZAP alone is not a code-security review. Known ZAP gaps include design-time intent (table-permission misuse) and network-level checks — cover those via `/audit-permissions` and the posture snapshot.
- **"Site code" view is single-select.** CWE Top 25, OWASP Top 10, and OWASP ASVS drive the same scan (Semgrep, optionally ZAP) and only differ in grouping. Phase 3 Question 1 MUST be a single-select — presenting them in a multi-select would invite a pick that regroups the same findings twice. CWE Top 25 is the pre-selected default because it has the broadest coverage of the three (the industry Top 25 subsumes most of the OWASP Top 10 classes). Do NOT fold CVE, license, or BYO into Question 1 — those are separate additive concerns handled by Question 2's multi-select.
- **Delegate table-permission audits; do not reimplement them.** `/audit-permissions` already produces an HTML report at `docs/permissions-audit.html` with severity-grouped findings and delegates fixes to the `table-permissions-architect` agent. This skill INCLUDES those findings in the unified report and keeps a link back to the existing `permissions-audit.html` for deep-dive evidence. Do NOT parse permission YAML or re-query Dataverse from here.
- **Auth / role remediations go through their own skills.** When the review surfaces an auth issue, the fix invokes `/setup-auth`. Role-based access fixes invoke `/create-webroles`. These skills have their own approval flows — do not bypass them with direct Dataverse writes.
- **Long-running security checks do NOT block.** `/manage-site-scan --deep` and `/manage-code-scan` SAST scans run in the background. Kick them off in Phase 4 as soon as the user has picked them in Phase 3, and let them run while the rest of the review proceeds. The HTML report shows partial results immediately; deeper findings append when the scans complete.
- **Bypass-all must be explicit and documented.** Bypass is derived from the Phase 3 answers — it is NOT a concern row. If Question 1 was "Skip the site-code scan" AND Question 2 had zero ticks, surface the concrete trade-off (no code-scan findings, no dependency CVE findings, no license flags — only the posture snapshot survives; see Phase 3 for the exact disclosure text) and confirm before proceeding. Accept the bypass if the user confirms, and note it in the report's "Concerns" metadata (which will be an empty list) so the gap is visible to later readers.
- **Cross-cloud runtime sources.** When proposing CSP remediations in Phase 7, remember `/manage-http-headers` needs the cloud-specific `content.powerapps.*` host — never propose a remediation that lists all four clouds' hosts together. Delegate to `/manage-http-headers` which handles this.
- **Per-change approval is mandatory.** Phase 7 pauses with `AskUserQuestion` before every remediation. The user can accept, skip, or defer each finding individually — never batch-approve.

## Workflow

At the start of Phase 1, create one task per phase with `TaskCreate`. Mark `in_progress` when you enter a phase, `completed` the moment it ends. The final response carries a progress tracking table (see the end of this file) so the user can see at-a-glance what each phase produced.

### Phase 1 — Prerequisites and portal id resolution

1. Confirm the working directory is a Power Pages code site — `.powerpages-site/website.yml` must exist. If missing, tell the user to run `/deploy-site` first and stop.
2. Read the `id` field from `.powerpages-site/website.yml` — this is the website record id.
3. Resolve the portal id once, and keep it for every security-area read in Phase 4 onward:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/website.js" --websiteRecordId <id-from-step-2>
   ```
   The `id` field on the returned record is the portal id.
4. Failure modes (consistent with the other skills):
   - Non-zero exit with a prerequisite message → surface verbatim, stop. Do not install or re-authenticate on the user's behalf.
   - Exit 0 with `null` → site not deployed OR PAC profile pointed at the wrong environment. Ask which applies before recovering.

### Phase 2 — Detect the site's domain

Domain context (finance / healthcare / retail / government / education / B2B SaaS / non-profit / general) drives how Phase 6 frames the unified report — domain-priority findings rank first, the headline pulls the right `failure_emphasis` / `pass_emphasis` snippet, and the regulatory frame (PCI-DSS, HIPAA, FERPA, etc.) is surfaced prominently. Classify the site by reasoning over its content. Read the relevant signals, decide on a domain, and propose. The user always confirms or overrides.

Load `${CLAUDE_PLUGIN_ROOT}/references/domain-attack-profiles.md` and follow its **Detection guidance** section. In short:

1. Read the highest-signal sources first — `index.html` (`<title>`, `<meta name="description">`), `powerpages.config.json` (`siteName`), and `.powerpages-site/website.yml` (`name`, `description`).
2. If the picture isn't clear, drop to web-roles, table-permissions, and `.datamodel-manifest.json` (if present). Role and table names like "Patient", "Donor", "Constituent", "Tenant" are strong cues.
3. Skip site-settings unless still ambiguous — they are mostly plumbing.
4. Form a confidence judgment (high / medium / low) per the guidance doc:
   - **high**: confirm in one line and continue.
   - **medium**: show the proposal plus the signals you read, and use `AskUserQuestion` to offer override.
   - **low**: default to `general`, use `AskUserQuestion` to ask the user to pick from the eight-key catalog.
5. The user's selection is **always authoritative** — do not override a confirmed user choice with the proposed classification on a follow-up.

Stash the chosen domain key for Phase 6. The findings JSON built there carries `metadata.domain`, `metadata.regulatoryFrame`, and the matching emphasis snippets so the renderer can show them.

### Phase 3 — Select the concerns to review

Ask **three questions in sequence** with `AskUserQuestion`. **Citizen developers running this skill do not know security jargon** (OWASP, CWE, CVE, SCA, ASVS) — primary labels MUST be everyday language with the technical name in parentheses for users who already know the term. Every option MUST disclose (a) what it catches in plain words and (b) how long it takes — demo feedback consistently showed citizen developers asking both questions before they can commit.

The three-question split is intentional: Question 1 is **single-select** (the three site-code views drive the same scan and differ only in how findings are grouped — offering them in a multi-select would invite a pick that regroups the same findings twice). Question 2 is **multi-select** (those concerns are additive — they scan different surfaces and can freely combine). Question 3 is a single toggle that only applies when a code scan was picked.

**Question 1 — single-select: "Which site-code view do you want?"**

Exactly one of these four rows is picked. Pre-select row 1 (Detailed weakness view) as the default because it gives the broadest coverage among the three code-scan views — the industry Top 25 subsumes most of the OWASP Top 10 classes and adds finer-grained weakness types.

| Option (plain label) | Plain explanation | Time | Default | Maps to |
|---|---|---|---|---|
| Detailed weakness view (CWE Top 25) | Scans your site's code for specific weakness types — cross-site scripting, injection, path traversal, hardcoded credentials, and the other 20 in the industry Top 25. Broadest code-level coverage. | ~5–15 min | ✅ Pre-selected | CWE Top 25 |
| Common web attacks view (OWASP Top 10) | Same scan as above, findings grouped by the ten most common attack categories instead of specific weakness types. Familiar framing for compliance conversations. | ~5–15 min | — | OWASP Top 10 |
| Compliance-standard view (OWASP ASVS) | Scans your site's code against formal application-security verification controls (authentication strength, session handling, transport security). Strictest framing for audits. | ~5–15 min | — | OWASP ASVS |
| Skip the site-code scan | Skips the site-code scan. The review still runs the posture snapshot and whatever else is picked in Question 2. | instant | — | — |

The times above are for the static code scan only. Q3 (deep scan toggle) may extend the runtime — that trade-off is explained on Q3's screen where the user can actually act on it.

**Question 2 — multi-select: "Include these additional checks?"**

Zero or more of these rows are picked. All three are pre-checked (recommended) because each scans a different surface than Question 1 and combines freely with any Question 1 answer. Zero ticks is a valid answer — treat it as "no additional checks".

| Option (plain label) | Plain explanation | Time | Recommended | Maps to |
|---|---|---|---|---|
| Third-party packages — known vulnerabilities (CVE / SCA) | Checks the npm packages your site depends on against public vulnerability databases. Also flags packages whose upstream is abandoned / end-of-life. | under 1 min | ✅ Yes | Trivy `vuln` |
| Third-party packages — licensing | Checks what licenses your dependencies use; flags copyleft (GPL-class) and unknown entries that may create legal obligations for commercial or redistributed sites. | under 1 min | ✅ Yes | Trivy `license` |
| Your own checklist | Runs the review against a checklist you provide (file path or inline paste). Useful for internal governance / policy requirements. | varies by checklist | ✅ Yes | Bring-your-own |

Do NOT add a "None of the above" option to Question 2 — submitting with zero ticks already means "none". Do NOT add a "Bypass all" option to Question 2 either — bypass is the natural result of picking "Skip the site-code scan" in Question 1 AND unticking everything in Question 2, and the skill handles that combination explicitly below.

**Bypass-all confirmation.** If Question 1 was "Skip the site-code scan" AND Question 2 had zero ticks, confirm explicitly before proceeding — the phrase "not recommended" MUST appear in this confirmation so the user sees the posture trade-off:

> **Skipping every automated check is not recommended.** The review will still perform these fast posture checks:
> - Web Application Firewall status + custom rule audit
> - HTTP header configuration (CSP, CORS, SameSite, X-Frame-Options) via `/manage-http-headers --audit`
> - Table permissions (via `/audit-permissions`)
> - Web roles + project language detection
>
> You will NOT get:
> - Site-code vulnerability findings (XSS, injection, authorization gaps) — these require a code scan
> - Third-party package CVE findings — these require the dependency vulnerability scan
> - Third-party package license flags — these require the license audit
>
> Confirm you want to proceed with the posture snapshot only.

**Question 3 — single toggle: "How thorough should the code scan be?"**

Only ask this question if Question 1 was NOT "Skip the site-code scan". Skip it otherwise — there is no code scan to make thorough or fast.

| Option | Meaning | Default |
|---|---|---|
| Thorough — include the deep dynamic scan | Runs the ZAP deep dynamic scan against the live site in addition to the static code scan. Catches injection, SSRF, TLS misconfig, and similar classes that static analysis alone cannot see. Takes up to ~1 hour and runs in the background — the rest of the review proceeds without waiting. | ✅ Pre-selected |
| Fast only — skip the deep dynamic scan | Runs the static code scan only (~5–15 min). Leaves dynamic findings out of the report; the user can run them later with `/manage-site-scan --deep`. | — |

**Record the selection** — normalize Q1 + Q2 answers into a `concerns` array (e.g., `["CWE Top 25", "CVE / SCA", "License audit"]`; empty array when the user bypassed everything) and Q3 into a `deepScan` boolean. The Q1 answer contributes at most one concern name ("CWE Top 25", "OWASP Top 10", "OWASP ASVS", or nothing when "Skip" was picked); each Q2 tick contributes one concern name. Phase 4 uses the concerns list to decide which scans to kick off; Phase 5 organizes findings with one bucket per concern; Phase 6 renders one section per concern in the unified HTML report. The mapping from each concern to its scan tools and its report-grouping convention is in `references/orchestration.md` → "Concern → scan tools" and "Concern → report grouping".

### Phase 4 — Discover current posture

Run the posture snapshot — a bundled script that issues the read commands from every security area in parallel:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/review-security/scripts/posture-snapshot.js" \
  --portalId <guid> \
  --projectRoot "<project-root>"
```

The output is a single JSON blob with:
- Site name + admin-delegation group id (from `website.js`)
- WAF status + current rules (from `waf.js --status` / `--rules`)
- Deep-scan state + latest report summary + score (from `scan.js --ongoing` / `--report` / `--score`)
- HTTP/* site-settings audit (from `http-headers.js --audit`)
- Detected project languages (from `detect-languages.js`)
- Local web-role definitions from `.powerpages-site/web-roles/*.webrole.yml` (read inline by the snapshot script). Shape: `{ present, count, roles[] }` or `{ error }` when the directory / files can't be read. Phase 5 uses this to flag OWASP A01 when the site lists web roles that are never bound to administratively-sensitive pages.

Also invoke the existing table-permissions flow in parallel:
```
/audit-permissions
```
This produces `docs/permissions-audit.html`. Wait for that skill to complete before Phase 5 — its findings are load-bearing for the unified report.

**Kick off every scan implied by the concerns the user picked in Phase 3, before proceeding to Phase 5.** Do NOT run any scan for a concern the user did not pick. The concern-to-scan mapping in `references/orchestration.md` → "Concern → scan tools" is authoritative; the typical invocations are:

- ZAP deep dynamic scan (only if `deepScan=true` AND at least one "Site code" concern is picked) → `node "${CLAUDE_PLUGIN_ROOT}/skills/manage-site-scan/scripts/scan.js" --deep --portalId <guid>` (returns immediately; runs server-side)
- Semgrep SAST (any "Site code" concern) → `semgrep scan --config <ruleset> --sarif --output <sarif-path> <project-root>` via `Bash run_in_background: true`. Pick the ruleset that matches the selected code-scan concern (`p/cwe-top-25`, `p/owasp-top-ten`, or `p/owasp-asvs`).
- CodeQL SAST (alternative to Semgrep for CWE / OWASP when the tool is available) → `node "${CLAUDE_PLUGIN_ROOT}/skills/manage-code-scan/scripts/run-codeql.js" --projectRoot <path> --language javascript-typescript --querySuite <suite> --sarifOut <sarif-path>` via `Bash run_in_background: true`
- Trivy (CVE / SCA and / or License concerns) → when both are picked, run a single pass: `trivy fs --scanners vuln,license --format json --output <path> <project-root>`. When only one is picked, pass just that scanner. Usually sub-minute; can run synchronously.

Ruleset / query-suite defaults follow the selected code-scan concern — see `skills/manage-code-scan/SKILL.md` Phase 5 (Plan, ruleset table) for the exact mapping. The scan completion hook at `plugins/power-pages/hooks/hooks.json` will surface results when the long-running scans finish; pick them up and fold into the report during Phase 6 or Phase 8.

### Phase 5 — Audit and analyze

For each signal gathered in Phase 4, classify it as Critical / High / Medium or Passing check per the severity scheme in `references/orchestration.md`. Then organize findings into one bucket per concern the user picked in Phase 3 — a review that picked "CWE Top 25" + "CVE / SCA" produces two top-level concern buckets in the final report, each with its own grouping convention inside.

Grouping convention per concern (authoritative table in `references/orchestration.md` → "Concern → report grouping"):

- **Common web attacks view (OWASP Top 10)** — group findings into A01–A10 via the category → area mapping in `references/orchestration.md`. For web-role signals: if pages look administratively sensitive (admin / settings / internal-sounding paths) but no web role binds to them, raise a **Medium** finding under A01 and route the fix to `/create-webroles`.
- **Detailed weakness view (CWE Top 25)** — group by the CWE id on the finding. Posture-snapshot signals (WAF disabled, missing CSP, etc.) do not have native CWE ids; place them under the best-fit CWE (e.g., missing CSP → CWE-1021, WAF disabled → CWE-693) and annotate the mapping in the evidence line so the user can see the reasoning.
- **Compliance-standard view (OWASP ASVS)** — group by ASVS section (V1 Architecture, V2 Authentication, V3 Session, V4 Access Control, V5 Validation, …). Semgrep ASVS rules tag directly; posture signals need manual section assignment with evidence annotation.
- **CVE / SCA** — group by package name, ordered by highest severity CVE per package. If Trivy was unavailable at run time, the CVE concern renders with an empty-state card explaining the tool was missing; do not silently drop it.
- **License audit** — group by license class (restricted / reciprocal / unknown / permissive), packages alphabetical within each group.
- **Bring-your-own checklist** — each checklist item becomes a bucket. Decide which checklist item each signal fulfills or violates; findings land in the matching bucket with their severity and evidence. Items with no matching signal are flagged as manual-review in the report.

Severity assignment and source-area identification apply regardless of concern. The findings JSON schema in `references/orchestration.md` supports concern-specific category IDs — `categories[].id` is `A01` for OWASP Top 10, `CWE-79` for CWE Top 25, `V2.1` for ASVS, the package name for SCA, the license class for licenses, or the checklist-item slug for bring-your-own.

**Cross-concern signals.** Phase 3 Question 1 is single-select, so at most one code-scan bucket exists — the selected site-code view's grouping applies to the Semgrep / ZAP output. A Trivy run feeds both the CVE and License concerns when both are picked in Question 2; each concern filters to its own set of findings.

If the argument-hint captured a focused scope (e.g., "only CSP and WAF"), drop any signals outside the described scope before organizing. The grouping convention still applies to each concern bucket for what remains.

### Phase 6 — Present findings in a unified HTML report (domain-aware)

Before building the findings JSON, load both shared references:

- `${CLAUDE_PLUGIN_ROOT}/references/threat-context.md` — for the runtime-fetch URLs and confidence-message templates.
- `${CLAUDE_PLUGIN_ROOT}/references/domain-attack-profiles.md` — for the chosen domain's `top_owasp`, `regulatory_frame`, and `failure_emphasis` / `pass_emphasis` snippets.

**Live CVE enrichment.** Walk the assembled findings list and collect every CVE identifier (typical sources: Trivy CVE / SCA findings, dynamic-scan alerts that reference a CVE in `AlertName` / `Description`). Sort by report-supplied severity, take the top 5, then shell out to the plugin-shared helper:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/fetch-cve-context.js" --cves CVE-XXXX-NNNN,CVE-YYYY-MMMM,...
```

Or pipe a JSON list:

```bash
echo '{"cves":["CVE-XXXX-NNNN","CVE-YYYY-MMMM"]}' | node "${CLAUDE_PLUGIN_ROOT}/scripts/fetch-cve-context.js" --stdin
```

The script fetches CISA KEV (full feed once, cached in-process), FIRST EPSS (single batched call), and NVD CVSS (one polite call per CVE). Stdout is a JSON object with `results[]`, per-source `sources` health, and an `allDown` boolean. Exit codes:

- **0** — at least one source returned data; map `results[].cvss` / `epss` / `kev` directly into each finding's `cveEnrichment`.
- **1** — all three sources are down (transport / 429 / parse errors). Skip enrichment, surface a one-line note in the report ("live enrichment unavailable; using report-supplied severity"), and proceed.
- **2** — bad CLI args; treat as a bug in the skill invocation.

Do NOT use `WebFetch` directly for these three URLs — the helper handles batching, NVD pacing, KEV-feed caching, and rate-limit detection uniformly. `WebFetch` remains available for ad-hoc lookups against the OWASP Top 10:2025 page or other one-offs.

**Build the findings JSON** matching the schema in `references/orchestration.md`. Beyond the existing `metadata` / `summary` / `concerns` / `permissionsAudit` fields, populate:

- `metadata.domain` — `{ key, displayName }` from the domain catalog (e.g., `{ key: "finance", displayName: "Financial services" }`).
- `metadata.regulatoryFrame` — the chosen profile's `regulatory_frame` string (or null when empty for `general`).
- `metadata.headline` — `{ kind: "pass" | "failure", text }` — pass emphasis when the global severity totals are zero across critical/high, otherwise failure emphasis.
- `metadata.confidenceMessages[]` — one entry per scan family that produced zero findings (deps clean → `CM-DEPS`, static clean → `CM-STATIC`, etc.). Pull the template text from `threat-context.md`.
- `metadata.tradeoffs[]` — at least one caveat from `threat-context.md`'s **Tradeoffs to disclose** section.
- `metadata.regulatoryCoverage[]` — built by walking the chosen profile's `regulatory_frame` token list and looking each token up in `${CLAUDE_PLUGIN_ROOT}/references/regulatory-controls.md` (matching guidance is in that file's last section). For each control row in the matched standard's section:
   - If any of the row's `Check source` names appears in `metadata.scansIncluded`, set `status: "covered"` and copy the matched `checkSource` value.
   - Else if the row is marked `manual-only`, set `status: "manual-only"` and `checkSource: null`.
   - Else (control is automatable but the relevant scan was not run), set `status: "not-applicable"` and `checkSource: null`.
   - Walk `concerns[].categories[].findings[]` and append any whose `source` matches the row's `checkSource` to `findingsRefs[]` (use the finding's `id`).
   For `regulatory_frame` tokens not represented in the controls file (e.g., `SOX`, `GLBA`, `COPPA`, regional codes), append a single placeholder row with `status: "manual-only"` and `controlName: "<Standard> — controls not modeled in regulatory-controls.md; assess separately"`. When `regulatory_frame` is empty, leave the array empty.

**Audit-permissions fold-in rule.** When "Common web attacks view (OWASP Top 10)" is among the selected concerns, merge `permissionsAudit.findings[]` into `concerns[name="OWASP Top 10"].categories[id=A01].findings` before invoking the renderer, so audit-permissions findings render inline with every other A01 finding. For every other selected concern (CWE Top 25, ASVS, CVE / SCA, license, BYO), the permission findings stay in `permissionsAudit.findings[]` and render in the standalone Table Permissions section. If the user picked OWASP Top 10 alongside other concerns, the fold-in still happens for the OWASP concern only — the other concerns' sections are unaffected.

Render:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/review-security/scripts/render-report.js" \
  --findings <findings.json> \
  --output docs/security-review.html
```

Pass `--dry-run` to validate the findings JSON + template path and compute the rendered byte count without writing `docs/security-review.html` — the script prints `{ dryRun, wouldWrite, bytes, severityCounts }` on stdout. Use this to sanity-check the JSON before committing to a write.

The report includes, in this order:
- Domain banner — detected domain, regulatory frame (when present), and the headline emphasis line.
- Executive summary (counts by severity across every concern + per-concern subtotals).
- Concerns reviewed (the list from Phase 3), timestamp, portal id + site name, whether the deep scan was included, and which scan tools ran vs. were skipped.
- Confidence messages for any clean clusters, when present.
- Per-concern section, each with its own grouping axis inside (A01–A10 for OWASP Top 10, CWE-NNN for CWE Top 25, section id for ASVS, package for SCA, license class for licenses, checklist item for BYO). Every finding shows: description, evidence, severity, source area, suggested remediation, status (open / fixed / deferred), and — when applicable — the live CVE-enrichment line (`CVSS <baseScore> <baseSeverity> · EPSS <epss> · KEV: <yes-with-dueDate / no>`).
- **Table-permissions findings**: folded into A01 when OWASP Top 10 is among the selected concerns (the Table Permissions tab becomes a deep-link back to `docs/permissions-audit.html`); rendered as a standalone Table Permissions section with the 4-stat grid and a prominent "Full evidence: docs/permissions-audit.html" link otherwise. Do NOT duplicate the `permissions-audit.html` doc — link to it.
- Regulatory coverage tab — one card per standard from the chosen domain's `regulatory_frame`, with each control showing covered / not-applicable / manual-only status and deep-links to the findings that count as evidence.
- Tradeoffs disclosed at the bottom.
- Pending long-running results banner: if a deep scan or SAST is still running, the report carries a "Additional findings pending from <scan-type>" notice with the polling command.

Open the report in the browser (or tell the user the path) and pause here for review before any remediation.

### Phase 7 — Harden (per-change approval, delegated remediations)

For each open finding the user wants to address, delegate to the skill that owns that concern. Use `AskUserQuestion` per finding — accept / skip / defer. Never batch approvals.

Delegation map (full version in `references/orchestration.md`):

| Finding area | Delegate to | What that skill does |
|---|---|---|
| Authentication / identity provider / anti-forgery token | `/setup-auth` | Configures identity providers, login/logout, token handling |
| Web-role / role-based access | `/create-webroles` | Defines and assigns web roles |
| Table permissions | `/audit-permissions` | Runs `table-permissions-architect` agent for fixes |
| CSP / CORS / SameSite / other HTTP headers | `/manage-http-headers` | Writes `HTTP/<Header>` site-setting YAML |
| WAF enable/disable/rules | `/manage-web-application-firewall` | Admin-layer WAF changes |
| Dynamic scan (verification after hardening) | `/manage-site-scan` | Quick sync scan or deep async scan |
| Static-code finding (dependency CVE, SAST, dependency license) | `/manage-code-scan` | Framework-driven SAST / SCA / license audit |
| Deploy any Dataverse-bound change | `/deploy-site` | Push the YAML / site-setting changes |

After each successful remediation, update the `status` field in the findings JSON and re-render the HTML report so the "fixed" markers appear. Capture before / after state on anything that touched Dataverse — the report's `remediation` block shows both.

### Phase 8 — Post-hardening close-out

1. If the user applied any remediation, offer to re-run the relevant read command to verify the change stuck (e.g., re-read `--status` after a WAF enable; re-audit site-settings after a header change).
2. For long-running scans that completed during the session, incorporate their findings — re-render the report with the updated JSON so the final artifact is complete.
3. Clean up transient working files at the project root (findings JSON drafts, plan files produced during the review) unless the user wants to keep them. The unified HTML report itself is a deliverable — leave it in place at `docs/security-review.html`.
4. Summarize for the user:
   - Total findings → how many fixed / deferred / skipped.
   - Per-category counts post-hardening.
   - Any bypassed checks (deep scan, SAST) and the command the user can run later to complete them.

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill-tracking instructions in the reference to record this skill's usage. Use `--skillName "ReviewSecurity"`.

Close by asking: "Anything else on the security review, or done?"

## Progress tracking table

Keep this table in your final response, filling each status as phases complete:

| Phase | Status |
|---|---|
| 1. Prerequisites and portal id resolution | ☐ |
| 2. Detect site domain | ☐ |
| 3. Align on concerns | ☐ |
| 4. Discover current posture | ☐ |
| 5. Audit and analyze | ☐ |
| 6. Present findings in unified report (domain-aware) | ☐ |
| 7. Harden (per-change approval) | ☐ |
| 8. Post-hardening close-out | ☐ |
