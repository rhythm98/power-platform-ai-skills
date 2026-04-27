# Security review orchestration reference

Single consolidated reference for the `review-security` meta-skill — the concern → scan-tool mapping, the concern → report-grouping mapping, the OWASP category → security area mapping, the full finding-type → delegation table, the findings JSON schema the HTML report consumes, and how `audit-permissions` integrates into the unified report.

## Contents

- [Concern → scan tools](#concern--scan-tools)
- [Concern → report grouping](#concern--report-grouping)
- [OWASP Top 10 → security area mapping](#owasp-top-10--security-area-mapping)
- [Full delegation table](#full-delegation-table)
- [Severity scheme](#severity-scheme)
- [Findings JSON schema](#findings-json-schema)
- [`audit-permissions` integration](#audit-permissions-integration)
- [Posture snapshot — what each read returns](#posture-snapshot--what-each-read-returns)
- [Bring-your-own checklist — how to scope](#bring-your-own-checklist--how-to-scope)

## Concern → scan tools

Phase 2 of the meta-skill asks the user which **concerns** to review in a three-question sequence (Q1 single-select site-code view; Q2 multi-select additive concerns; Q3 deep-scan toggle — see `SKILL.md` Phase 2 for the exact picker text). Each concern the user ends up picking implies a specific set of scan tools. Use this table to decide which scans to kick off in Phase 3.

| Concern (Phase 2 label) | Technical name | Phase 2 question | Applicable tools | Default state | Notes |
|---|---|---|---|---|---|
| **Site code — common web attacks view** | OWASP Top 10 | Q1 (single-select, site-code group) | ZAP deep dynamic scan; Semgrep with `p/owasp-top-ten`; CodeQL with `javascript-security-extended.qls` | Not pre-selected | Semgrep is preferred over CodeQL because its rules ship with direct `owasp:A0N:*` tags; CodeQL tags only CWE, so mapping to OWASP would be manual. |
| **Site code — detailed weakness view** | CWE Top 25 | Q1 (single-select, site-code group) | ZAP deep dynamic scan; Semgrep with `p/cwe-top-25`; CodeQL | ✅ Pre-selected (Q1 default) | Pre-selected as the default code-scan view because CWE Top 25 subsumes most OWASP Top 10 classes and adds finer-grained weakness types. CodeQL is the strong alternative to Semgrep when deep dataflow matters; flag the longer runtime when proposing. |
| **Site code — compliance-standard view** | OWASP ASVS | Q1 (single-select, site-code group) | Semgrep with `p/owasp-asvs`; ZAP deep dynamic scan (only for runtime-verification controls) | Not pre-selected | ASVS is primarily a verification standard; most controls are static. Include ZAP only if the user wants runtime verification of session / transport controls. |
| **Skip the site-code scan** | — | Q1 (single-select, site-code group) | None (posture snapshot + Q2 picks still run) | Not pre-selected | The fourth option on Q1. Selecting it means no code-scan bucket in the report; Q3 (deep-scan toggle) is skipped. |
| **Third-party packages — known vulnerabilities** | CVE / SCA | Q2 (multi-select, additive) | Trivy filesystem scan (`--scanners vuln`, or `vuln,license` to fold in the license audit) | ✅ Pre-checked | Trivy also flags end-of-life (deprecated) packages alongside CVEs; surface these even when no CVE is filed. |
| **Third-party packages — licensing** | License audit | Q2 (multi-select, additive) | Trivy filesystem scan (`--scanners license`, or `vuln,license` for a single-pass combined SCA+license run) | ✅ Pre-checked | When CVE / SCA is also in scope, prefer the combined `vuln,license` invocation — one walk of the dependency tree, both outputs. |
| **Your own checklist** | Bring-your-own | Q2 (multi-select, additive) | Whichever tool the user specifies (Semgrep custom rules, CodeQL query pack, organizational checklist, etc.) | ✅ Pre-checked | The user names the tool / checklist when they pick this concern. Items with no matching automated signal are flagged manual-review. |

**Bypass-all is a derived state, not a concern.** When Q1 is "Skip the site-code scan" AND Q2 has zero ticks, the concerns list is empty and only the posture snapshot runs. Phase 2 surfaces a "not recommended" confirmation in that case — see `SKILL.md` Phase 2 for the exact disclosure text. Do NOT add a "Bypass all" row to either picker question.

**Deep scan toggle.** Phase 2's second question — "How thorough should the code scan be?" — gates whether ZAP is included. ZAP is pre-selected (thorough) because dynamic runtime evidence catches classes SAST cannot (authentication-flow defects, rendered-output XSS, TLS misconfig). The user can opt to the fast-only path to skip ZAP; the ZAP-only findings are left for `/manage-security-scan --deep` to run later.

**Tool availability caveat.** If a recommended tool is not installed on the user's machine (check via `skills/analyze-code/scripts/check-tools.js`), either (a) swap in the concern's alternative if present and call out the trade-off, or (b) surface an install pointer and leave the tool unavailable with a visible reason. Never silently drop a tool from the concern's scan set.

## Concern → report grouping

Each concern picked in Phase 2 drives one section in the unified HTML report. This table is the authoritative map Phase 4 uses to bucket findings inside each section and the `concerns[].categories[].id` convention in the findings JSON.

| Concern | Section heading | `categories[].id` | How findings are grouped inside the section |
|---|---|---|---|
| **OWASP Top 10** | "Site code — common web attacks (OWASP Top 10)" | `A01`, `A02`, …, `A10` | Each finding is placed in the OWASP category matching its signal source — see [OWASP Top 10 → security area mapping](#owasp-top-10--security-area-mapping). |
| **CWE Top 25** | "Site code — detailed weaknesses (CWE Top 25)" | `CWE-NNN` (the CWE id on the finding) | SAST findings already carry CWE tags; use them. Posture signals without native CWE ids get a best-fit CWE (e.g., missing CSP → CWE-1021, WAF disabled → CWE-693) with the mapping noted in evidence. |
| **OWASP ASVS** | "Site code — compliance standard (OWASP ASVS)" | ASVS section id (e.g., `V2.1`, `V4.2`) | Semgrep ASVS rules tag directly. Posture signals need manual section assignment with evidence annotation. |
| **CVE / SCA** | "Third-party package vulnerabilities" | package name (one group per package, ordered by highest-severity CVE) | Within each package group, list CVEs in CRITICAL → HIGH → MEDIUM → LOW order. Call out end-of-life / deprecated upstreams in the package header even when no CVE is filed. |
| **License audit** | "Third-party package licensing" | license class (`restricted` → `reciprocal` → `unknown` → `permissive`) | Within each class, list packages alphabetically. For commercial / non-open-source sites, `restricted` / `reciprocal` / `unknown` groups are action items — the user confirms licensing per package or swaps the dependency. |
| **Bring-your-own** | "Custom checklist" | Slug of each checklist item (e.g., `verify-csp-set`, `verify-waf-enabled`) | Each checklist item becomes a group. Items with no matching signal are flagged manual-review. |

The report's executive summary always shows counts by severity across every concern plus per-concern subtotals, so "what should I fix first" is never lost regardless of how many concerns were selected. If the user captured a focused scope in the argument-hint (e.g., "only CSP and WAF"), drop out-of-scope signals before grouping; each concern's grouping still applies to what remains.

## OWASP Top 10 → security area mapping

Each OWASP category can draw signals from multiple security areas. This table is the authoritative map the meta-skill uses to bucket findings.

| Category | Description | Signals from |
|---|---|---|
| **A01 Broken Access Control** | Resources / functions reachable without the right checks | `/manage-site-visibility` (public site with no gating); `/audit-permissions` (overly-broad table-permission scope); posture-snapshot's `webRoles` read (Public site with admin-looking pages but unbound web roles — routed to `/create-webroles` for the fix); `/manage-security-headers` (CORS that bypasses same-origin); `/analyze-code` (CWE-22 path traversal, CWE-284/285 improper authz) |
| **A02 Cryptographic Failures** | Data-in-transit or data-at-rest protections bypassed or misconfigured | `/manage-security-headers` (HSTS is Power-Pages-managed — flag only if TLS is being disabled elsewhere); `/manage-security-scan` deep scan (TLS misconfig, weak crypto detection) |
| **A03 Injection** | SQLi, XSS, command injection, expression-language injection, etc. | `/manage-security-scan` deep scan (dynamic reflection / confirmed injections); `/analyze-code` with Semgrep or CodeQL (static dataflow findings tagged CWE-79, CWE-89, CWE-78, CWE-917, etc.) |
| **A04 Insecure Design** | Design-level weaknesses beyond mis-configuration | `/manage-security-headers` (CORS `*` + credentials, overly-permissive CSP that defeats same-origin intent); `/manage-site-visibility` (Private site without Entra-auth-required access list); `/audit-permissions` (design gaps the `table-permissions-architect` agent identifies) |
| **A05 Security Misconfiguration** | Missing hardening on well-known controls | `/manage-security-headers` (missing `HTTP/Content-Security-Policy`, missing `HTTP/X-Frame-Options`, `--audit` reporting catalogued names under `missing`); `/manage-web-application-firewall` (WAF disabled on a production site); `/manage-security-scan` quick scan (Pass/Warning items for common misconfig patterns) |
| **A06 Vulnerable and Outdated Components** | Known CVEs in third-party dependencies, plus packages whose upstream is end-of-life / deprecated (forward-looking risk even without a filed CVE) | `/analyze-code` in CVE / SCA mode (Trivy); Trivy's EOL signal feeds this category too |
| **A07 Identification and Authentication Failures** | Missing or weak auth, session handling, credential protection | `/setup-auth` (login/logout, identity providers, anti-forgery tokens); `/analyze-code` (CWE-287, CWE-306, CWE-798 hardcoded credentials) |
| **A08 Software and Data Integrity Failures** | Unvalidated deserialization, code signing gaps, CI/CD integrity | `/analyze-code` (CWE-502 deserialization, CWE-494 untrusted code) |
| **A09 Security Logging and Monitoring Failures** | Insufficient visibility into what's happening | `/manage-web-application-firewall` log capture setting (log capture disabled, retention too short); `/manage-security-scan` (findings not being reviewed — flag if the latest completed report is stale relative to recent deploys) |
| **A10 Server-Side Request Forgery (SSRF)** | Server-side requests to attacker-controlled URLs | `/manage-security-scan` deep scan; `/analyze-code` (CWE-918) |

Categories that rely on both dynamic AND static evidence (A03, A06, A08, A10) benefit most from running `/manage-security-scan --deep` and `/analyze-code` early so their long-running scans complete before the report is finalized.

## Full delegation table

Every finding type and which skill owns both the analysis AND the remediation. The meta-skill never reimplements these — it invokes them with per-change approval.

| Finding area | Read / analyze via | Remediate via | Notes |
|---|---|---|---|
| Site visibility (Public / Private) | `/manage-site-visibility` (Phase 2 read) | `/manage-site-visibility` | Public → Private and back only; admin-delegation group is separate admin tooling |
| HTTP security headers (CSP, CORS, SameSite, X-Frame-Options, etc.) | `/manage-security-headers --audit` | `/manage-security-headers --write` | CSP changes use plan-validate-execute; cloud-specific runtime host required |
| WAF enable / disable | `/manage-web-application-firewall --status` | `/manage-web-application-firewall --enable` or `--disable` | Async; poll status after kicking off |
| WAF rules (custom + managed-rule overrides) | `/manage-web-application-firewall --rules` | `/manage-web-application-firewall --create-rules` or `--delete-custom` | Plan file required; first-match-wins semantics matter |
| Dynamic vulnerability scan | `/manage-security-scan --ongoing` / `--report` / `--score` | `/manage-security-scan --deep` (to trigger a fresh scan) | Long-running; starts in background |
| Static-code vulnerabilities (SAST) | `/analyze-code` (Semgrep or CodeQL) | Code edits — the skill produces findings; the user fixes the code | Long-running for CodeQL |
| Dependency CVEs (SCA) | `/analyze-code` (Trivy) | `package.json` / lock-file updates — out of scope beyond reporting | Fast scan |
| Table permissions | `/audit-permissions` | `/audit-permissions` (which invokes the `table-permissions-architect` agent for fixes) | The `table-permissions-architect` agent is preserved as the fix path; this skill never bypasses it |
| Web roles | `/create-webroles` | `/create-webroles` | Creates role records + UI gating rules |
| Authentication / identity providers / anti-forgery | `/setup-auth` | `/setup-auth` | Configures OAuth / OIDC providers, login/logout, token handling |
| Deploy any Dataverse-bound change | — | `/deploy-site` | Site-settings YAML needs `/deploy-site` to reach Dataverse; visibility and WAF are admin-layer so they skip this |

## Severity scheme

The unified report uses a four-level scheme aligned with the existing `audit-permissions` report:

| Level | Meaning |
|---|---|
| **Critical** | Active exploit path exists, or sensitive data is exposed. Fix before any further deploy. |
| **High** | Significant weakness; a typical attacker could exploit it. Fix before the next release. |
| **Medium** | Weakness that raises attack surface or indicates risky design. Fix as part of routine follow-up work. |
| **Passing check** | Control is in place and working as intended. Surface in the report so users see what is NOT flagged — not everything is a problem. |

Severity assignment guidance:

- `/manage-security-scan` deep-scan findings come with the scanner's own severity — map `error` to Critical, `warning` to High, `note` to Medium.
- `/analyze-code` tags (CWE, OWASP, `security-severity` number) feed into the same map — findings with `security-severity` ≥ 7 are Critical, 4 ≤ s < 7 are High, < 4 are Medium.
- `/audit-permissions` uses its own severity; preserve its output verbatim in the report.
- Configuration absences (e.g., no CSP at all, WAF disabled on production) are High by default; the user can re-rank if context warrants.

## Findings JSON schema

The `render-report.js` script consumes a single JSON file with this shape. Build it by aggregating the posture snapshot + individual skill outputs. The top-level `concerns[]` array mirrors the concerns the user picked in Phase 2 — one entry per concern, in the order they were picked.

```json
{
  "metadata": {
    "concerns": ["CWE Top 25", "CVE / SCA", "License audit"],
    "deepScan": true,
    "siteName": "<site name from website record>",
    "portalId": "<guid>",
    "generatedAt": "2026-04-22T00:00:00Z",
    "scansIncluded": ["Semgrep (p/cwe-top-25)", "ZAP deep", "Trivy vuln,license"],
    "scansSkipped": [],
    "pendingScans": [
      { "type": "deep-security-scan", "pollCommand": "node scan.js --ongoing --portalId <guid>" }
    ]
  },
  "summary": {
    "totalFindings": N,
    "bySeverity": { "critical": N, "high": N, "medium": N, "passing": N },
    "byConcern": {
      "CWE Top 25": { "critical": N, "high": N, "medium": N, "passing": N },
      "CVE / SCA":  { "critical": N, "high": N, "medium": N, "passing": N },
      "License audit": { "critical": N, "high": N, "medium": N, "passing": N }
    }
  },
  "concerns": [
    {
      "name": "CWE Top 25",
      "categories": [
        {
          "id": "CWE-79",
          "name": "CWE-79 Cross-Site Scripting",
          "findings": [
            {
              "id": "semgrep-xss-index-tsx-42",
              "title": "Reflected XSS in src/pages/Index.tsx:42",
              "severity": "high",
              "source": "Semgrep (p/cwe-top-25)",
              "evidence": "User-supplied value `location.search` rendered via dangerouslySetInnerHTML without sanitization",
              "remediation": {
                "description": "Sanitize or escape the user-supplied value; prefer text rendering over dangerouslySetInnerHTML.",
                "delegateTo": "/analyze-code",
                "appliedStatus": "open",
                "beforeValue": null,
                "afterValue": null
              }
            }
          ]
        }
      ]
    },
    {
      "name": "CVE / SCA",
      "categories": [
        {
          "id": "express",
          "name": "express@4.17.1",
          "findings": [ /* one per CVE */ ]
        }
      ]
    }
  ],
  "permissionsAudit": {
    "reportPath": "docs/permissions-audit.html",
    "summary": { "critical": N, "warning": N, "info": N, "pass": N },
    "findings": [
      {
        "id": "tp-contact-read-anonymous",
        "title": "Contact table grants Read to anonymous web role",
        "severity": "critical",
        "source": "audit-permissions",
        "owner": "table-permissions-architect",
        "evidence": "table-permission 'contact-anon-read' binds contact.Read to the Anonymous web role"
      }
    ],
    "note": "Full evidence lives in docs/permissions-audit.html; when OWASP Top 10 is a selected concern, this array is merged into concerns[name='OWASP Top 10'].categories[id='A01'] upstream of the renderer."
  }
}
```

Key integrity rules for the JSON:
- `metadata.concerns[]` names every concern the user picked in Phase 2 (plain technical names — `"OWASP Top 10"`, `"CWE Top 25"`, `"OWASP ASVS"`, `"CVE / SCA"`, `"License audit"`, `"Bring-your-own"`). When the user picks Bypass alone, this is an empty array and `concerns[]` below is also empty; only the posture-snapshot-sourced `permissionsAudit` section renders.
- `concerns[]` has exactly one entry per name in `metadata.concerns`, in the same order.
- `concerns[].categories[].id` follows the concern-specific convention from [Concern → report grouping](#concern--report-grouping): `A01`–`A10` for OWASP Top 10; `CWE-NNN` for CWE Top 25; `V2.1`-style for ASVS; package name for CVE / SCA; license class for licenses; checklist-item slug for BYO.
- `summary.byConcern` is keyed by the same names as `metadata.concerns[]`; per-concern severity tallies must reconcile with the global `summary.bySeverity`.
- `remediation.appliedStatus` transitions `open → fixed | skipped | deferred` as Phase 6 proceeds.
- `remediation.beforeValue` / `afterValue` are populated only when Phase 6 actually applies a change.
- `permissionsAudit.findings[]` is a normalized array of audit-permissions findings — each carries a unified `severity` (`critical` / `high` / `medium` / `passing`), `title`, `evidence`, and `owner` (typically `table-permissions-architect`). How these findings render is concern-set-dependent:
  - **When "OWASP Top 10" is among the selected concerns** — the meta-skill MERGES `permissionsAudit.findings[]` into `concerns[name="OWASP Top 10"].categories[id="A01"].findings` before invoking `render-report.js`, so they render inline with every other A01 finding. The standalone Table Permissions section becomes a deep-link back to `docs/permissions-audit.html` for full evidence.
  - **Otherwise** — audit-permissions findings do not map cleanly into the other concerns' groupings, so the standalone Table Permissions section renders with the 4-stat grid (Critical / High / Medium / Passing) and a prominent "Full evidence: docs/permissions-audit.html" link at the top.
- `permissionsAudit.summary` is preserved for the non-OWASP standalone view and for the executive summary counts.

## `audit-permissions` integration

Per the plugin's established pattern, the meta-skill must integrate with — not duplicate — `audit-permissions`:

1. **Invoke `/audit-permissions`** during Phase 3 and wait for it to complete. Its output is the file at `docs/permissions-audit.html`.
2. **Parse** that output (or its intermediate JSON if captured) to build `permissionsAudit.findings[]` in the unified findings JSON — each finding carries a normalized `severity` (unified scheme), `title`, `evidence`, and `owner` (`table-permissions-architect`). Preserve the original severity counts in `permissionsAudit.summary`.
3. **Merge when OWASP Top 10 is a selected concern; otherwise standalone.** When `metadata.concerns` includes `"OWASP Top 10"`, the meta-skill merges `permissionsAudit.findings[]` into `concerns[name="OWASP Top 10"].categories[id="A01"].findings` BEFORE invoking `render-report.js`, so they render inline with every other A01 finding under the unified severity scheme. The standalone Table Permissions section in that case is a deep-link back to `docs/permissions-audit.html`. When OWASP Top 10 is NOT among the selected concerns (e.g., the user picked CWE Top 25 alone, or CVE + License), the findings do not map cleanly into those concerns' categories, so the standalone Table Permissions section renders with the 4-stat grid and the "Full evidence: docs/permissions-audit.html" link at the top.
4. **Do not** re-render the full permission-audit findings inline — the original report is the deep-dive; the unified report shows the merged / standalone summary.
5. **Preserve delegation** — remediation of a permission finding in Phase 6 invokes `/audit-permissions`, which in turn delegates fixes to the `table-permissions-architect` agent. The meta-skill does not write permission YAML directly.

## Posture snapshot — what each read returns

`scripts/posture-snapshot.js` runs these reads in parallel and aggregates them into a single JSON. Each row below is one field of the output.

| Field | Source command | Purpose |
|---|---|---|
| `website` | `scripts/lib/website.js --websiteRecordId <id>` | Site name, portal id, `SiteVisibility`, cloud, etc. |
| `waf.status` | `skills/manage-web-application-firewall/scripts/waf.js --status` | WAF enabled / disabled, region availability, log capture |
| `waf.rules` | `skills/manage-web-application-firewall/scripts/waf.js --rules` | Current custom + managed-rule overrides |
| `scan.ongoing` | `skills/manage-security-scan/scripts/scan.js --ongoing` | Whether a deep scan is currently running |
| `scan.report` | `skills/manage-security-scan/scripts/scan.js --report` | Latest completed deep-scan report (or `null` if none) |
| `scan.score` | `skills/manage-security-scan/scripts/scan.js --score` | `{ totalRules, succeededRules }` from the latest completed scan |
| `headers.audit` | `skills/manage-security-headers/scripts/security-headers.js --audit --projectRoot <root>` | Present / missing / forbidden HTTP/* site-settings |
| `languages` | `skills/analyze-code/scripts/detect-languages.js --projectRoot <root>` | Which CodeQL-supported languages are in the project |
| `webRoles` | Inline file read of `<projectRoot>/.powerpages-site/web-roles/*.webrole.yml` via the plugin-shared `powerpages-config` loader (no child process, no network) | `{ present, count, roles[] }` or `{ error }`. On a Public site with admin-looking pages but unbound web roles, Phase 4 raises A01 (Medium) with a recommendation to bind the role via `/create-webroles`. |

The script fails open — if any individual read fails, its field is populated as `{ "error": "<message>" }` and the others still proceed. The meta-skill surfaces any failed reads in the report so the user sees what information is missing.

## Bring-your-own checklist — how to scope

When the user picks "bring-your-own checklist" in Phase 2, collect the checklist in one of two ways:

- **File pointer** — user names a path (`.md`, `.txt`, `.yml`); read the file and parse each line / bullet / YAML entry as one checklist item.
- **Inline paste** — user pastes the checklist into the conversation; treat each line as one item.

For each checklist item, in Phase 4:

1. Decide which security area's output is the right evidence source.
2. Grade the item Critical / High / Medium / Passing based on what that area reports.
3. Add the item to the unified report under a custom `checklists` top-level category (parallel to `categories` in the findings JSON — `render-report.js` handles both shapes).
4. For remediation, delegate to whichever skill owns the concern, same as OWASP mode.

If a checklist item has no matching signal — e.g., "verify legal review was performed" — flag it as a manual-review item in the report and stop; the meta-skill does not pretend to cover non-automatable concerns.
