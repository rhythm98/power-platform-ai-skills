# Security review orchestration reference

Single consolidated reference for the `review-security` meta-skill — the OWASP category → security area mapping, the full finding-type → delegation table, the findings JSON schema the HTML report consumes, and how `audit-permissions` integrates into the unified report.

## Contents

- [Framework → scan tools](#framework--scan-tools)
- [Framework → report grouping](#framework--report-grouping)
- [OWASP Top 10 → security area mapping](#owasp-top-10--security-area-mapping)
- [Full delegation table](#full-delegation-table)
- [Severity scheme](#severity-scheme)
- [Findings JSON schema](#findings-json-schema)
- [`audit-permissions` integration](#audit-permissions-integration)
- [Posture snapshot — what each read returns](#posture-snapshot--what-each-read-returns)
- [Bring-your-own checklist — how to scope](#bring-your-own-checklist--how-to-scope)

## Framework → scan tools

The meta-skill's Phase 2 asks the user which framework to assess against, then asks which long-running scans to include. Use this table to build the multi-select list for the second question: show every applicable tool for the chosen framework, pre-check the "recommended" column entries, and let the user uncheck any they do not want.

| Framework | Applicable tools | Recommended (pre-check) | Notes |
|---|---|---|---|
| **OWASP Top 10** | ZAP deep dynamic scan; Semgrep with `p/owasp-top-ten` pack; CodeQL with `javascript-security-extended.qls` | ZAP + Semgrep | Semgrep is preferred over CodeQL here because its rules ship with direct `owasp:A0N:*` tags — CodeQL tags only CWE, which means mapping to OWASP has to be done manually. |
| **CWE / CWE Top 25** | ZAP deep dynamic scan; Semgrep with `p/cwe-top-25`; CodeQL | ZAP + Semgrep | CodeQL is the strong alternative to Semgrep when deep dataflow matters; flag the longer runtime when proposing. |
| **OWASP ASVS** | Semgrep with `p/owasp-asvs`; ZAP deep dynamic scan for runtime-verification controls | Semgrep | ASVS is primarily a verification standard; most controls are static. Include ZAP only if the user wants runtime verification of session / transport controls. |
| **CVE / SCA** | Trivy filesystem scan (`--scanners vuln`, or `vuln,license` to fold in the license audit) | Trivy | SCA is the entire review in this framework — unchecking Trivy leaves the review with nothing to report. Warn the user and ask whether to re-select or switch framework. Trivy also flags end-of-life (deprecated) packages alongside CVEs; surface these even when no CVE is filed. |
| **Dependency license audit** | Trivy filesystem scan (`--scanners license`, or `vuln,license` for a single-pass combined SCA+license run) | Trivy | Unchecking Trivy leaves nothing to report. When CVE / SCA is also in scope, prefer the combined `vuln,license` invocation — one walk of the dependency tree, both outputs. |
| **Bring-your-own** | Whichever tool the user specifies (Semgrep custom rules, CodeQL query pack, etc.) | User-specified | The user names the tool when they pick this framework; pre-select that tool. |

**Tool availability caveat.** If a recommended tool is not installed on the user's machine (check via `skills/analyze-code/scripts/check-tools.js`), either (a) swap in the framework's alternative if present and call out the trade-off, or (b) surface an install pointer and mark the unavailable tool unchecked-with-reason so the user can see why. Never silently drop a tool from the list.

**Why DAST complements SAST.** For OWASP, CWE, and ASVS frameworks, include the ZAP deep dynamic scan alongside the SAST tool by default: dynamic runtime evidence catches classes SAST cannot (authentication-flow defects, rendered-output XSS, TLS misconfig). Users sometimes uncheck ZAP because it is long-running; let them, but do not default it off.

## Framework → report grouping

The framework the user picks in Phase 2 also determines how findings are grouped in the unified HTML report — there is NO separate "report layout" question. This table is the authoritative map Phase 4 uses to bucket findings and the `categories[].id` convention in the findings JSON.

| Framework | `categories[].id` | How findings are grouped |
|---|---|---|
| **OWASP Top 10** | `A01`, `A02`, …, `A10` | Each finding is placed in the OWASP category matching its signal source — see [OWASP Top 10 → security area mapping](#owasp-top-10--security-area-mapping). |
| **CWE / CWE Top 25** | `CWE-NNN` (the CWE id on the finding) | SAST findings already carry CWE tags; use them. Posture signals without native CWE ids get a best-fit CWE (e.g., missing CSP → CWE-1021, WAF disabled → CWE-693) with the mapping noted in evidence. |
| **OWASP ASVS** | ASVS section id (e.g., `V2.1`, `V4.2`) | Semgrep ASVS rules tag directly. Posture signals need manual section assignment with evidence annotation. |
| **CVE / SCA** | package name (one group per package, ordered by highest-severity CVE) | Within each package group, list CVEs in CRITICAL → HIGH → MEDIUM → LOW order. Call out end-of-life / deprecated upstreams in the package header even when no CVE is filed. |
| **Dependency license audit** | license class (`restricted` → `reciprocal` → `unknown` → `permissive`) | Within each class, list packages alphabetically. For commercial / non-open-source sites, `restricted` / `reciprocal` / `unknown` groups are action items — the user confirms licensing per package or swaps the dependency. |
| **Bring-your-own** | Slug of each checklist item (e.g., `verify-csp-set`, `verify-waf-enabled`) | Each checklist item becomes a group. Items with no matching signal are flagged manual-review. |

The report's executive summary always shows counts by severity regardless of framework, so "what should I fix first" is never lost. If the user captured a focused scope in the argument-hint (e.g., "only CSP and WAF"), drop out-of-scope signals before grouping; the framework's grouping still applies to what remains.

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

The `render-report.js` script consumes a single JSON file with this shape. Build it by aggregating the posture snapshot + individual skill outputs.

```json
{
  "metadata": {
    "framework": "OWASP Top 10",
    "siteName": "<site name from website record>",
    "portalId": "<guid>",
    "generatedAt": "2026-04-22T00:00:00Z",
    "pendingScans": [
      { "type": "deep-security-scan", "pollCommand": "node scan.js --ongoing --portalId <guid>" }
    ]
  },
  "summary": {
    "totalFindings": N,
    "bySeverity": { "critical": N, "high": N, "medium": N, "passing": N },
    "byCategory": { "A01 Broken Access Control": N, "A02 Cryptographic Failures": N, ... }
  },
  "categories": [
    {
      "id": "A01",
      "name": "A01 Broken Access Control",
      "findings": [
        {
          "id": "site-vis-public-nogate",
          "title": "Public site with no web-role gating on <page>",
          "severity": "high",
          "source": "manage-site-visibility + create-webroles",
          "evidence": "SiteVisibility=Public; page /admin reachable anonymously; no web role restricts access",
          "remediation": {
            "description": "Gate /admin behind a 'site-admin' web role, or switch visibility to Private",
            "delegateTo": "/create-webroles or /manage-site-visibility",
            "appliedStatus": "open",
            "beforeValue": null,
            "afterValue": null
          }
        }
      ]
    }
  ],
  "permissionsAudit": {
    "reportPath": "docs/permissions-audit.html",
    "summary": {
      "critical": N,
      "warning": N,
      "info": N,
      "pass": N
    },
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
    "note": "Full evidence lives in docs/permissions-audit.html; this summary is included under A01 Broken Access Control with deep-link to the original."
  }
}
```

Key integrity rules for the JSON:
- `categories[].id` is the OWASP short id (`A01`, `A02`, …) when using OWASP; for BYO-checklist it's a stable slug of the checklist item.
- `remediation.appliedStatus` transitions `open → fixed | skipped | deferred` as Phase 6 proceeds.
- `remediation.beforeValue` / `afterValue` are populated only when Phase 6 actually applies a change.
- `permissionsAudit.findings[]` is a normalized array of audit-permissions findings — each carries a unified `severity` (`critical` / `high` / `medium` / `passing`), `title`, `evidence`, and `owner` (typically `table-permissions-architect`). How these findings render is framework-dependent:
  - **OWASP Top 10** — the meta-skill MERGES `permissionsAudit.findings[]` into `categories[id=A01].findings` before invoking `render-report.js`, so they render inline with every other A01 finding. The standalone Table Permissions tab becomes a deep-link back to `docs/permissions-audit.html` for full evidence.
  - **Other frameworks** (CWE, ASVS, SCA, license, bring-your-own) — audit-permissions does not map cleanly into those frameworks' categories, so the standalone Table Permissions tab renders with the 4-stat grid (Critical / High / Medium / Passing) and a prominent "Full evidence: docs/permissions-audit.html" link at the top.
- `permissionsAudit.summary` is preserved for the non-OWASP standalone view and for the executive summary counts.

## `audit-permissions` integration

Per the plugin's established pattern, the meta-skill must integrate with — not duplicate — `audit-permissions`:

1. **Invoke `/audit-permissions`** during Phase 3 and wait for it to complete. Its output is the file at `docs/permissions-audit.html`.
2. **Parse** that output (or its intermediate JSON if captured) to build `permissionsAudit.findings[]` in the unified findings JSON — each finding carries a normalized `severity` (unified scheme), `title`, `evidence`, and `owner` (`table-permissions-architect`). Preserve the original severity counts in `permissionsAudit.summary`.
3. **Merge for OWASP, standalone otherwise.** When the Phase 2 framework is OWASP Top 10, the meta-skill merges `permissionsAudit.findings[]` into `categories[id=A01].findings` BEFORE invoking `render-report.js`, so they render inline with every other A01 finding under the unified severity scheme. The Table Permissions tab in that case becomes a deep-link back to `docs/permissions-audit.html`. For every other framework (CWE, ASVS, SCA, license, bring-your-own), the findings do not map cleanly into those frameworks' categories, so the standalone Table Permissions tab renders with the 4-stat grid and the "Full evidence: docs/permissions-audit.html" link at the top.
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
