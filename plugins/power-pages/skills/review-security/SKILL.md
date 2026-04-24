---
name: review-security
description: >-
  Orchestrates an end-to-end security review of a Power Pages site.
  Asks which framework to assess against (OWASP Top 10, CWE / CWE
  Top 25, OWASP ASVS, CVE / dependencies, or a bring-your-own
  checklist) and which long-running scans to include (ZAP deep
  scan, Semgrep or CodeQL SAST, Trivy SCA — recommended
  pre-selected); runs the posture snapshot plus selected scans;
  presents findings in a unified HTML report grouped by the
  framework; applies remediations per-change, delegating to the
  skill that owns each concern (manage-site-visibility,
  manage-web-application-firewall, manage-security-headers,
  manage-security-scan, analyze-code, setup-auth, create-webroles,
  audit-permissions, deploy-site). Use when the user asks for a security review,
  audit, posture check, OWASP assessment, or hardening sweep —
  even if they do not name a framework. Out of scope: single-check
  invocations (invoke that skill directly), IaC scanning (Power
  Pages infrastructure is Microsoft-managed), and compliance
  frameworks beyond the ones listed.
user-invocable: true
argument-hint: "[optional: focus area, e.g. 'full review' or 'only CSP']"
allowed-tools: Read, Write, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList, Agent
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Security

Coordinate a security review of a Power Pages site. This skill does no scanning of its own — every finding comes from one of the specialized security-area skills or existing plugin skills, and every remediation delegates back to the skill that owns the concern. The value here is the *framework-driven sequencing*, the *unified report*, and the *per-change approval loop* that makes hardening safe.

Every change is one delegated invocation behind explicit user approval — no batch application, no silent writes. The skill that owns the change stays authoritative; this skill never reimplements anything they do.

## When to load which reference

- `references/orchestration.md` — load at the start of Phase 2 (framework selection) for the OWASP category → security area mapping, the full finding-type → delegation table, and the JSON schema the HTML report consumes.

## Gotchas

- **Framework-driven, not tool-driven.** OWASP is a framework. `manage-security-scan` (ZAP-based dynamic scan) is a tool that covers *a subset* of OWASP. Running ZAP alone is not an OWASP review. Known ZAP gaps include design-time intent (table-permission misuse) and network-level checks — cover those via `/audit-permissions` and the posture snapshot.
- **Delegate table-permission audits; do not reimplement them.** `/audit-permissions` already produces an HTML report at `docs/permissions-audit.html` with severity-grouped findings and delegates fixes to the `table-permissions-architect` agent. This skill INCLUDES those findings in the unified report and keeps a link back to the existing `permissions-audit.html` for deep-dive evidence. Do NOT parse permission YAML or re-query Dataverse from here.
- **Auth / role remediations go through their own skills.** When the review surfaces an auth issue, the fix invokes `/setup-auth`. Role-based access fixes invoke `/create-webroles`. These skills have their own approval flows — do not bypass them with direct Dataverse writes.
- **Long-running security checks do NOT block.** `/manage-security-scan --deep` and `/analyze-code` SAST scans run in the background. Kick them off in Phase 3 as soon as the user has picked them in Phase 2, and let them run while the rest of the review proceeds. The HTML report shows partial results immediately; deeper findings append when the scans complete.
- **Skip-all must be explicit and documented.** If the user unchecks every long-running scan in Phase 2, surface the concrete trade-off (the review will miss dynamic vulnerability findings, SAST dataflow findings, and dependency CVEs depending on which were unchecked — see Phase 2 for the exact disclosure text). Accept the skip if the user confirms, and note it in the report's "Framework used" header so the gap is visible to later readers.
- **Cross-cloud runtime sources.** When proposing CSP remediations in Phase 6, remember `/manage-security-headers` needs the cloud-specific `content.powerapps.*` host — never propose a remediation that lists all four clouds' hosts together. Delegate to `/manage-security-headers` which handles this.
- **Per-change approval is mandatory.** Phase 6 pauses with `AskUserQuestion` before every remediation. The user can accept, skip, or defer each finding individually — never batch-approve.

## Workflow

At the start of Phase 1, create one task per phase with `TaskCreate`. Mark `in_progress` when you enter a phase, `completed` the moment it ends. The final response carries a progress tracking table (see the end of this file) so the user can see at-a-glance what each phase produced.

### Phase 1 — Prerequisites and portal id resolution

1. Confirm the working directory is a Power Pages code site — `.powerpages-site/website.yml` must exist. If missing, tell the user to run `/deploy-site` first and stop.
2. Read the `id` field from `.powerpages-site/website.yml` — this is the website record id.
3. Resolve the portal id once, and keep it for every security-area read in Phase 3 onward:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/website.js" --websiteRecordId <id-from-step-2>
   ```
   The `id` field on the returned record is the portal id.
4. Failure modes (consistent with the other skills):
   - Non-zero exit with a prerequisite message → surface verbatim, stop. Do not install or re-authenticate on the user's behalf.
   - Exit 0 with `null` → site not deployed OR PAC profile pointed at the wrong environment. Ask which applies before recovering.

### Phase 2 — Select the framework and scans to include

Ask two questions sequentially with `AskUserQuestion`. Use plain, user-friendly labels — avoid internal terms like "sub-skill", phase numbers, or internal categorization vocabulary in option text.

**Question 1 — Which security framework should this review assess against?** Single-select. The framework drives both which scan tools are relevant AND how findings are organized in the final report, so findings group themselves automatically by the framework's own categories (A01–A10 for OWASP Top 10, CWE-NNN for CWE, etc.). Do NOT ask the user separately how to lay out the report — the framework answer covers both.

| Framework | What it covers |
|---|---|
| OWASP Top 10 | General posture review combining dynamic (runtime) and static (source) findings tagged A01–A10. Familiar framing for compliance conversations. |
| CWE / CWE Top 25 | Source-code and runtime findings tagged with CWE IDs; the Top 25 flags the most critical classes. |
| OWASP ASVS | Findings tagged against OWASP Application Security Verification Standard control sections. |
| CVE / dependency vulnerabilities (SCA) | Third-party dependency vulnerabilities tagged by CVE and severity. Also surfaces packages whose upstream has reached end-of-life (deprecated / unmaintained) so they can be planned for replacement before they become CVE targets. |
| Dependency license audit | Every third-party dependency's declared license, classified copyleft (GPL / AGPL / LGPL) / weak-copyleft (Mozilla-class) / permissive / unknown. Particularly important for non-open-source / commercial sites — the user needs to confirm they have a license to distribute any copyleft or unknown entries. |
| Bring-your-own checklist | User-supplied checklist (markdown / text / YAML) or tool config (Semgrep rules, CodeQL query pack). |

If the user asks "which should I pick", OWASP Top 10 is the most common for general posture reviews — but do not pre-select it.

**Question 2 — Which long-running scans should the review include?** Multi-select. Long-running scans take minutes to hours; they run in the background while the rest of the review proceeds, and results fold into the report when they complete.

Look up the applicable tools for the framework the user chose in `references/orchestration.md` → "Framework → scan tools". Present every applicable tool for that framework — do NOT hide tools the user might want. Pre-check the recommended ones (marked "recommended" in the reference table); the user can uncheck any they do not want.

Label the skip-all path **"Bypass long-running scans (not recommended)"** in the `AskUserQuestion` UI — the phrase "not recommended" MUST appear so the user sees the posture trade-off before they commit. If the user picks it, confirm explicitly before proceeding. Spell out what the review WILL still perform and what it will MISS, using the current framework's context:

> **Bypassing long-running scans is not recommended.** With no long-running scans, the review will still perform these fast checks from the posture snapshot:
> - Site visibility (Public / Private)
> - Web Application Firewall status + custom rule audit
> - HTTP security-header configuration (CSP, CORS, SameSite, X-Frame-Options) via `/manage-security-headers --audit`
> - Table permissions (via `/audit-permissions`)
> - Project language detection
>
> You will NOT get:
> - Dynamic vulnerability findings (injection, SSRF, TLS misconfig, confirmed exploits) — these require the ZAP deep dynamic scan
> - Static-code dataflow findings (CWE-79 XSS, CWE-89 SQL injection, CWE-78 command injection, and similar classes) — these require a SAST scan (Semgrep or CodeQL)
> - Third-party dependency CVEs — these require Trivy
>
> Confirm you want to proceed without any long-running scans.

List only the bullets that correspond to unchecked tools — do not dump all four bullets if only two scans were unchecked. If the user picks a framework whose only tooling is long-running (e.g., CVE / SCA, where Trivy IS the review), tell them the review has nothing to report without the scan and ask whether they want to re-select Trivy or change the framework.

Record the framework and the scan set — Phase 3 kicks off the selected scans in the background, Phase 4 organizes findings by the framework's categories, and Phase 5 renders the report using the framework-native layout.

### Phase 3 — Discover current posture

Run the posture snapshot — a bundled script that issues the read commands from every security area in parallel:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/review-security/scripts/posture-snapshot.js" \
  --portalId <guid> \
  --projectRoot "<project-root>"
```

The output is a single JSON blob with:
- Visibility state + admin-delegation group id (from `website.js`)
- WAF status + current rules (from `waf.js --status` / `--rules`)
- Deep-scan state + latest report summary + score (from `scan.js --ongoing` / `--report` / `--score`)
- HTTP/* site-settings audit (from `security-headers.js --audit`)
- Detected project languages (from `detect-languages.js`)
- Local web-role definitions from `.powerpages-site/web-roles/*.webrole.yml` (read inline by the snapshot script). Shape: `{ present, count, roles[] }` or `{ error }` when the directory / files can't be read. Phase 4 uses this to flag OWASP A01 when a Public site lists web roles that are never bound to administratively-sensitive pages.

Also invoke the existing table-permissions flow in parallel:
```
/audit-permissions
```
This produces `docs/permissions-audit.html`. Wait for that skill to complete before Phase 4 — its findings are load-bearing for the unified report.

**Kick off every long-running scan the user picked in Phase 2, in the background, before proceeding to Phase 4.** Do NOT run any scan the user unchecked. The selected scans typically map to:

- ZAP deep dynamic scan → `node "${CLAUDE_PLUGIN_ROOT}/skills/manage-security-scan/scripts/scan.js" --deep --portalId <guid>` (returns immediately; runs server-side)
- Semgrep SAST → `semgrep scan --config <ruleset> --sarif --output <sarif-path> <project-root>` via `Bash run_in_background: true`
- CodeQL SAST → `node "${CLAUDE_PLUGIN_ROOT}/skills/analyze-code/scripts/run-codeql.js" --projectRoot <path> --language javascript-typescript --querySuite <suite> --sarifOut <sarif-path>` via `Bash run_in_background: true`
- Trivy SCA → `trivy fs --scanners vuln --format sarif --output <sarif-path> <project-root>` (usually sub-minute; can run synchronously)
- Trivy dependency license audit → `trivy fs --scanners license --format json --output <license-path> <project-root>` (sub-minute; synchronous). If both SCA and license are in scope, combine into a single `--scanners vuln,license --format json` run and parse both outputs from one file.

Ruleset / query-suite defaults follow the framework — see `skills/analyze-code/SKILL.md` Phase 4 (ruleset table) for the exact mapping. The scan completion hook at `plugins/power-pages/hooks/hooks.json` will surface results when the long-running scans finish; pick them up and fold into the report during Phase 5 or Phase 7.

### Phase 4 — Audit and analyze

For each signal gathered in Phase 3, classify it as Critical / High / Medium or Passing check per the severity scheme in `references/orchestration.md`. Then organize findings by the framework chosen in Phase 2 — the framework is the organizing principle, not a separate layout decision.

- **OWASP Top 10** — use the category → area mapping in `references/orchestration.md`. Each finding falls into A01–A10 based on the signal's source and nature. For web-role signals: on a Public site, if pages look administratively sensitive (admin / settings / internal-sounding paths) but no web role binds to them, raise a **Medium** finding under A01 and route the fix to `/create-webroles`.
- **CWE / CWE Top 25** — group by the CWE id on the finding. Posture-snapshot signals (WAF disabled, missing CSP, etc.) do not have native CWE ids; place them under the best-fit CWE (e.g., missing CSP → CWE-1021, WAF disabled → CWE-693) and annotate the mapping in the evidence line so the user can see the reasoning.
- **OWASP ASVS** — group by ASVS section (V1 Architecture, V2 Authentication, V3 Session, V4 Access Control, V5 Validation, …). Semgrep ASVS rules tag directly; posture signals need manual section assignment with evidence annotation.
- **CVE / SCA** — group by package name, ordered by highest severity CVE per package. The review has nothing useful to say in this framework without the SCA tool (Trivy) — if the tool was unselected, Phase 2 already warned the user.
- **Bring-your-own checklist** — each checklist item becomes a bucket. Decide which checklist item each signal fulfills or violates; findings land in the matching bucket with their severity and evidence. Items with no matching signal are flagged as manual-review in the report.

Severity assignment and source-area identification apply regardless of framework. The findings JSON schema in `references/orchestration.md` supports framework-specific category IDs — `categories[].id` is `A01` for OWASP, `CWE-79` for CWE, `V2.1` for ASVS, the package name for SCA, or the checklist-item slug for bring-your-own.

If the argument-hint captured a focused scope (e.g., "only CSP and WAF"), drop any signals outside the described scope before organizing. The framework still governs how the in-scope findings are grouped.

### Phase 5 — Present findings in a unified HTML report

Build a findings JSON that matches the schema in `references/orchestration.md`. **For OWASP Top 10 reviews**, before invoking the renderer, merge `permissionsAudit.findings[]` into `categories[id=A01].findings` so audit-permissions findings render inline with every other A01 finding. For every other framework (CWE, ASVS, SCA, license, bring-your-own), leave them in `permissionsAudit.findings[]` so the standalone Table Permissions section renders. Then render:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/review-security/scripts/render-report.js" \
  --findings <findings.json> \
  --output docs/security-review.html
```

Pass `--dry-run` to validate the findings JSON + template path and compute the rendered byte count without writing `docs/security-review.html` — the script prints `{ dryRun, wouldWrite, bytes, severityCounts }` on stdout. Use this to sanity-check the JSON before committing to a write.

The report includes, in this order:
- Executive summary (counts by severity + counts by the framework's own category axis — A01–A10 for OWASP, CWE-NNN for CWE, section id for ASVS, package for SCA, checklist item for bring-your-own)
- Framework used, timestamp, portal id + site name, and which long-running scans were included vs. skipped
- Per-category finding list, each finding showing: description, evidence (what was checked and what was seen), severity, source area, suggested remediation, and status (open / fixed / deferred).
- **Table-permissions findings**: folded into A01 for the OWASP framework (the Table Permissions tab becomes a deep-link back to `docs/permissions-audit.html`); rendered as a standalone Table Permissions section with the 4-stat grid and a prominent "Full evidence: docs/permissions-audit.html" link for every other framework. Do NOT duplicate the `permissions-audit.html` doc — link to it.
- Pending long-running results banner: if a deep scan or SAST is still running, the report carries a "Additional findings pending from <scan-type>" notice with the polling command.

Open the report in the browser (or tell the user the path) and pause here for review before any remediation.

### Phase 6 — Harden (per-change approval, delegated remediations)

For each open finding the user wants to address, delegate to the skill that owns that concern. Use `AskUserQuestion` per finding — accept / skip / defer. Never batch approvals.

Delegation map (full version in `references/orchestration.md`):

| Finding area | Delegate to | What that skill does |
|---|---|---|
| Authentication / identity provider / anti-forgery token | `/setup-auth` | Configures identity providers, login/logout, token handling |
| Web-role / role-based access | `/create-webroles` | Defines and assigns web roles |
| Table permissions | `/audit-permissions` | Runs `table-permissions-architect` agent for fixes |
| CSP / CORS / SameSite / other HTTP headers | `/manage-security-headers` | Writes `HTTP/<Header>` site-setting YAML |
| WAF enable/disable/rules | `/manage-web-application-firewall` | Admin-layer WAF changes |
| Visibility (Public/Private) | `/manage-site-visibility` | Admin-layer visibility flip |
| Dynamic scan (verification after hardening) | `/manage-security-scan` | Quick sync scan or deep async scan |
| Static-code finding (dependency CVE, SAST, dependency license) | `/analyze-code` | Framework-driven SAST / SCA / license audit |
| Deploy any Dataverse-bound change | `/deploy-site` | Push the YAML / site-setting changes |

After each successful remediation, update the `status` field in the findings JSON and re-render the HTML report so the "fixed" markers appear. Capture before / after state on anything that touched Dataverse — the report's `remediation` block shows both.

### Phase 7 — Post-hardening close-out

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
| 2. Align on framework | ☐ |
| 3. Discover current posture | ☐ |
| 4. Audit and analyze | ☐ |
| 5. Present findings in unified report | ☐ |
| 6. Harden (per-change approval) | ☐ |
| 7. Post-hardening close-out | ☐ |
