# Threat context for scan result framing

Reference data the skill consults when it presents `--quick` or `--report` output. The sections below cover: the OWASP Top 10:2025 rank-to-category mapping, the scan-type coverage table, the trusted public data sources the skill calls at runtime, the runtime metric-fetching procedure, the confidence-message templates for passing scans, the messaging principles for phrasing findings, and the tradeoffs to disclose.

## Contents

- [How to use this file](#how-to-use-this-file)
- [OWASP Top 10:2025 mapping](#owasp-top-102025-mapping)
- [Scan-type → OWASP coverage](#scan-type--owasp-coverage)
- [Trusted public data sources](#trusted-public-data-sources)
- [Runtime metric fetching](#runtime-metric-fetching)
- [Confidence-message templates](#confidence-message-templates)
- [Messaging principles](#messaging-principles)
- [Tradeoffs to disclose](#tradeoffs-to-disclose)

## How to use this file

When the consuming skill's result-presentation phase runs:

- For each **failed** rule, look up its OWASP category in the mapping table below. If quantitative grounding is useful (current OWASP ranking, current EPSS, KEV listing, CVSS), fetch it via [Runtime metric fetching](#runtime-metric-fetching). Frame the finding using the messaging principles — qualitative if the fetch fails, quantitative if it succeeds.
- For each **passed** rule cluster, pick the matching confidence-message template — substitute live numbers from the report's own counts only, plus any optional fetched figure that's relevant.
- Never recite this whole file; pick the smallest set of references relevant to the actual findings.

## OWASP Top 10:2025 mapping

This table maps OWASP rank IDs to category names and the primary scan type that exercises them. Specific incidence values, CVE counts, and rank ordinals are **not** stored here — fetch them via [Runtime metric fetching](#runtime-metric-fetching) when needed.

| Rank ID | Category | Primary scan type |
|---|---|---|
| A01 | Broken Access Control | Dynamic + auth checks |
| A02 | Security Misconfiguration | Configuration / hardening |
| A03 | Software Supply Chain Failures | Dependency / SCA |
| A04 | Cryptographic Failures | Static + secrets |
| A05 | Injection | Static + dynamic |
| A06 | Insecure Design | Manual review (out of scope for automated scan) |
| A07 | Authentication Failures | Dynamic + auth |
| A08 | Software or Data Integrity Failures | Configuration + dependency |
| A09 | Security Logging and Alerting Failures | Configuration |
| A10 | Mishandling of Exceptional Conditions | Static + dynamic |

Source: OWASP Top 10:2025 (https://owasp.org/Top10/).

## Scan-type → OWASP coverage

| Scan type | OWASP categories covered |
|---|---|
| Static code analysis (CodeQL / Semgrep) | A01, A04, A05 |
| Dynamic testing (OWASP ZAP) | A01, A05, A07 |
| Dependency / SCA scan | A03 |
| Configuration & hardening | A02 |
| Secrets detection | A02, A04 |
| Authentication & authorization | A01, A07 |

## Trusted public data sources

Quantitative claims in scan output trace back to a runtime fetch from one of these sources.

| Source | What it provides | Public access |
|---|---|---|
| OWASP Top 10:2025 | Current category ranking and incidence statistics | https://owasp.org/Top10/ (and per-category pages, e.g., `https://owasp.org/Top10/A01_2021-Broken_Access_Control/` once the 2025 URLs are published) |
| CISA Known Exploited Vulnerabilities (KEV) catalog | Confirmed-actively-exploited CVEs with `dateAdded`, `requiredAction`, `dueDate` | JSON: https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json |
| NIST National Vulnerability Database (NVD) | Authoritative CVE records, CVSS scores, CWE mappings | REST: https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=CVE-XXXX-NNNN |
| FIRST.org EPSS | Daily-refreshed exploit-prediction probability and percentile | API: https://api.first.org/data/v1/epss?cve=CVE-XXXX-NNNN |

When citing in output, attribute by source body — e.g., *"per OWASP Top 10:2025"*, *"CISA KEV currently lists this CVE (added <dateAdded>, due <dueDate>)"*, *"per NVD CVSS"*, *"FIRST EPSS"*.

## Runtime metric fetching

When the consuming skill needs a quantitative figure during result presentation, fetch it via `WebFetch`. Results from a single session can be cached. On any failure, drop the metric and fall back to qualitative phrasing.

### CVE-bearing findings

Use the plugin-shared helper (it batches, paces, and caches uniformly so each consuming skill stays small):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/fetch-cve-context.js" --cves CVE-XXXX-NNNN,CVE-YYYY-MMMM,...
```

Or pass a JSON list on stdin: `echo '{"cves":[...]}' | node ${CLAUDE_PLUGIN_ROOT}/scripts/fetch-cve-context.js --stdin`.

The helper queries:

1. **CISA KEV** — `https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json` (full feed, fetched once per process). Listed CVEs return `{ listed: true, dateAdded, dueDate, requiredAction }`; un-listed CVEs return `{ listed: false }`. Presence in KEV = "confirmed actively exploited in the wild" — high-priority remediation.
2. **FIRST EPSS** — `https://api.first.org/data/v1/epss?cve=<CVE-IDs>` (batched, comma-separated). Returns `{ epss, percentile }` per CVE.
3. **NVD CVSS** — `https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=<CVE-ID>` (one polite call per CVE, paced under NVD's 5/30s soft limit). Returns `{ baseScore, baseSeverity }` (CVSS v3.1 preferred, falls back to v3.0 / v2 if v3.1 absent).

Helper output (stdout JSON):

```json
{
  "results": [
    {
      "cveId": "CVE-XXXX-NNNN",
      "cvss": { "baseScore": 9.8, "baseSeverity": "CRITICAL" },
      "epss": { "epss": 0.955, "percentile": 0.998 },
      "kev":  { "listed": true, "dateAdded": "...", "dueDate": "..." },
      "errors": []
    }
  ],
  "sources": { "kev": {...}, "epss": {...}, "nvd": {...} },
  "allDown": false
}
```

Exit code **0** = at least one source returned usable data; **1** = all sources down (skill should degrade gracefully); **2** = bad CLI args.

Each sub-object (`cvss` / `epss` / `kev`) is independent — partial enrichment is allowed when one source 429s or errors. Render the parts that are present.

Display format: `CVE-XXXX-NNNN — CVSS <baseScore> <baseSeverity>, EPSS <epss> (top <100-percentile>%), KEV: <yes-with-dueDate / no>`.

### OWASP-page figures

For a finding mapped to an OWASP rank, optionally fetch the current ranking or incidence rate from the relevant page on https://owasp.org/Top10/ to anchor the finding. This is a courtesy, not a requirement — if the fetch fails or the page format changes, drop the figure and fall back to qualitative phrasing ("a leading category in OWASP Top 10:2025").

### Failure handling and rate limits

The `fetch-cve-context.js` helper handles rate limits and failure modes uniformly so consuming skills don't have to:

- NVD enforces ~5 calls/30s without an API key — the helper paces calls automatically (~6.5s between calls).
- FIRST EPSS is generous and the helper batches all CVEs into a single call.
- CISA KEV is a static JSON feed (~5MB) — the helper fetches it once per invocation and looks up each CVE in the cached map.
- The helper caps at 5 CVEs by default (configurable via `--max`).
- On HTTP 429, transport failure, or unparseable response for any one source, the helper marks that source's `sources[name].ok = false`, populates `error` / `rateLimited` flags, and still returns whatever the other sources produced. `allDown: true` only fires when *all three* sources are unreachable.

When `allDown: true` (exit code 1), the consuming skill should surface a single line in its output — *"live enrichment unavailable; using report-supplied severity"* — and continue with whatever metrics the scan report itself carried.

## Confidence-message templates

Use the template whose name matches the rule cluster that **passed**. Substitute live numbers from the scan report's own counts. If a quantitative industry figure adds value, fetch it via the runtime path above; otherwise leave the message qualitative.

### CM-OVERALL · All scans pass

> ✅ **Your site has a clean bill of health.** We checked every category in the OWASP Top 10:2025 — the industry standard for web security — plus outdated components, unsafe configurations, and exposed secrets. Your site is free of the critical weakness classes that public-breach analyses identify as the dominant attack surface.

### CM-DEPS · Dependency scan passes

> ✅ **All software components are up to date.** Unpatched known software flaws are a leading cause of breaches in industry aggregate analyses. By verifying every component on your site has the latest security patches, this scan closed off this attack path.

### CM-STATIC · Static analysis passes (no injection / unsafe input handling)

> ✅ **Your site's code is secure against injection attacks.** Injection (SQLi, XSS, command injection) remains a major OWASP Top 10:2025 category. We verified that your site handles all user input safely.

### CM-DAST · Dynamic scan passes

> ✅ **Your site held up against simulated real-world attacks.** We tested your live site the way an automated attacker would — probing forms, APIs, and access controls. No unauthorized access, no data leaks, no exploitable entry points.

### CM-CONFIG · Configuration / hardening passes

> ✅ **Your site's settings follow security best practices.** Security misconfiguration is among the leading risks tracked by OWASP Top 10:2025. No default passwords, open storage, exposed debug endpoints, or missing security headers detected.

### CM-AUTH · Access control / authentication passes

> ✅ **All access controls are properly enforced.** Broken access control is a top OWASP Top 10:2025 category. Every page, API, and data endpoint on your site requires proper authorization.

### CM-SECRETS · Secrets detection passes

> ✅ **No exposed credentials.** Leaked secrets in code repositories are a recurring source of breach exposure in industry aggregate analyses. Your site's storage and configuration files contain no embedded keys or credentials.

## Messaging principles

When phrasing findings for non-technical site makers:

| Principle | Phrase as… |
|---|---|
| Lead with protection, not threats | "Your forms are protected against data-theft attacks" |
| Anchor to source attribution | "We checked for the weakness classes tracked by OWASP Top 10:2025" |
| Use CVE IDs with live-fetched metrics | "CVE-XXXX-NNNN — CVSS <baseScore> <baseSeverity>, EPSS <epss>, KEV: <yes/no>" (values from runtime fetch) |
| Quantify via runtime fetch with attribution | "A leading category in OWASP Top 10:2025" — or the fetched figure with source name |
| Emphasize speed | "Findings surfaced in seconds" |

For **failures**, lead with what the finding enables an attacker to do, anchor to the OWASP-rank label and (if applicable) live-fetched CVE metrics, then state the mitigation.

## Tradeoffs to disclose

Always include at least one of these caveats — never leave the user with the impression that a clean scan = permanently safe:

- **Security is continuous.** Scan results reflect site state at scan time. Vulnerability disclosure rates are high and growing year over year (NVD aggregate); periodic re-scanning is essential.
- **Scans cover known patterns, not all attacks.** Zero-day vulnerabilities and business-logic flaws may not be caught by automated tools. Complement automated scans with manual review — `/review-security` is the right next step.
- **Detection isn't remediation.** Industry aggregate analyses consistently show that scanning alone is insufficient — promptly acting on findings is what closes the gap.
