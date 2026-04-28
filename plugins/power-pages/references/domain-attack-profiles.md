# Domain attack profiles

Per-industry attack-prevalence profiles plus guidance on how the skill detects the site's domain. The skill uses this file in two places:

1. **Detection phase** — read available site signals (listed below) and reason about the domain. Classify directly from the signals. The user always confirms or overrides.
2. **Result-framing phase** — once a domain is confirmed, rank scan findings against that domain's `top_owasp` and use the `failure_emphasis` / `pass_emphasis` snippets when phrasing output.

## Contents

- [How to use this file](#how-to-use-this-file)
- [Domain catalog](#domain-catalog)
- [Profile schema](#profile-schema)
- [Profiles](#profiles)
- [Detection guidance](#detection-guidance)

## How to use this file

- The consuming skill's detection phase reads the [Detection guidance](#detection-guidance) — classification happens by reasoning over the listed signals.
- The consuming skill's result-framing phase reads [Profiles](#profiles) after a domain is confirmed and uses `top_owasp` to rank findings, plus the emphasis snippets for narrative.
- Adding a new domain: add an entry to the catalog and a profile section. No code change anywhere.

## Domain catalog

Eight categories. `general` is the fallback when no clear signal can be found or the user does not specify.

| Key | Display name |
|---|---|
| `finance` | Financial services |
| `healthcare` | Healthcare |
| `retail` | Retail / e-commerce |
| `government` | Government / public sector |
| `education` | Education |
| `b2b_saas` | B2B SaaS |
| `nonprofit` | Non-profit |
| `general` | General-purpose / unknown |

## Profile schema

Each profile has:

- `top_owasp` — ordered list of OWASP 2025 ranks most relevant to this industry (most-relevant first).
- `regulatory_frame` — the compliance regime that scopes risk for this industry; surface this in remediation messaging when present.
- `failure_emphasis` — short copy snippet to lead with when surfacing a failed finding for this domain.
- `pass_emphasis` — short copy snippet to lead with when surfacing an all-clear for this domain.

Snippets below are qualitative — they name OWASP categories by attribution. If a quantitative figure is genuinely useful at presentation time, fetch it at runtime per `threat-context.md` and append it with attribution.

## Profiles

### finance — Financial services

- **top_owasp**: A01 (Broken Access Control), A02 (Misconfiguration), A03 (Supply Chain), A05 (Injection)
- **regulatory_frame**: PCI-DSS, SOX, GLBA, regional (FFIEC / PSD2 / RBI)
- **failure_emphasis**: "Financial services is consistently among the highest-cost industries in industry breach analyses. Broken access control and software supply-chain failures are leading OWASP Top 10:2025 categories and both carry direct regulatory exposure under SOX / GLBA / PCI-DSS."
- **pass_emphasis**: "Your site is free of the OWASP Top 10:2025 categories most associated with financial-services breach exposure in industry analyses."

### healthcare — Healthcare

- **top_owasp**: A01 (Broken Access Control), A02 (Misconfiguration), A07 (Authentication Failures), A04 (Cryptographic Failures)
- **regulatory_frame**: HIPAA (US), HITECH, GDPR Article 9 (special-category data), regional (PIPEDA / PHIPA)
- **failure_emphasis**: "Healthcare PHI is regulated under HIPAA — broken access control or misconfigured APIs in this domain can trigger mandatory breach notification and per-record fines under the HHS enforcement framework."
- **pass_emphasis**: "Access controls and configurations on your site align with the technical safeguards expected by HIPAA's Security Rule."

### retail — Retail / e-commerce

- **top_owasp**: A05 (Injection), A01 (Broken Access Control), A02 (Misconfiguration), A03 (Supply Chain)
- **regulatory_frame**: PCI-DSS, regional consumer-protection (GDPR, CCPA)
- **failure_emphasis**: "Retail public-submission forms are a primary target — injection (A05) and broken access control (A01) are major OWASP Top 10:2025 categories, and PCI-DSS exposure follows immediately if cardholder data is in scope."
- **pass_emphasis**: "Your forms and checkout pages are protected against the injection and scripting weakness classes tracked under OWASP Top 10:2025."

### government — Government / public sector

- **top_owasp**: A02 (Misconfiguration), A01 (Broken Access Control), A07 (Authentication Failures), A08 (Integrity Failures)
- **regulatory_frame**: FedRAMP, FISMA, StateRAMP (US); ISO 27001 + national equivalents elsewhere; CISA KEV remediation deadlines apply to federal-civilian sites
- **failure_emphasis**: "Federal-civilian sites must remediate any CISA-KEV-listed CVE within the catalog's `dueDate`. Security misconfiguration is a leading OWASP Top 10:2025 category and a frequently cited cause of public-sector data exposure in aggregate analyses."
- **pass_emphasis**: "Your site is free of the misconfiguration patterns commonly cited in public-sector aggregate breach data, and free of CISA KEV-listed vulnerabilities at scan time."

### education — Education

- **top_owasp**: A01 (Broken Access Control), A02 (Misconfiguration), A07 (Authentication Failures), A05 (Injection)
- **regulatory_frame**: FERPA (US student records), COPPA (under-13), GDPR (EU institutions)
- **failure_emphasis**: "Student records under FERPA require strict access controls — broken access control is a major OWASP Top 10:2025 category and applies directly to portal access in education contexts."
- **pass_emphasis**: "Your site protects student records with proper access controls, consistent with FERPA's technical-safeguards expectations."

### b2b_saas — B2B SaaS

- **top_owasp**: A01 (Broken Access Control), A03 (Supply Chain), A05 (Injection), A02 (Misconfiguration)
- **regulatory_frame**: SOC 2, ISO 27001; sector-derived (e.g., HIPAA BAA, PCI when handling cards)
- **failure_emphasis**: "B2B SaaS findings carry blast radius beyond a single tenant — OWASP Top 10:2025 elevated software supply-chain failures specifically because compromise of a shared platform component cascades across customers."
- **pass_emphasis**: "Your site is free of the supply-chain and access-control weakness classes that drive multi-tenant exposure in OWASP Top 10:2025's risk model."

### nonprofit — Non-profit

- **top_owasp**: A02 (Misconfiguration), A01 (Broken Access Control), A07 (Authentication Failures), A04 (Cryptographic Failures)
- **regulatory_frame**: jurisdiction-dependent (GDPR for EU donors, CCPA for California, charitable-data rules); PCI-DSS if accepting donations
- **failure_emphasis**: "Donor data and PII on non-profit sites is a frequent target precisely because security investment is often lower — security misconfiguration is a leading OWASP Top 10:2025 category and a commonly cited path in."
- **pass_emphasis**: "Your site avoids the misconfiguration patterns commonly cited as a cause of donor-data exposure."

### general — General-purpose / unknown

- **top_owasp**: A01, A02, A03, A05 (commonly leading OWASP Top 10:2025 categories across industries)
- **regulatory_frame**: depends on data handled — surface a generic note that any PII collection invokes regional privacy law (GDPR / CCPA / etc.)
- **failure_emphasis**: "Cross-industry breach analyses and OWASP Top 10:2025 consistently surface broken access control, security misconfiguration, software supply-chain failures, and injection as leading causes of confirmed web breaches."
- **pass_emphasis**: "Your site is free of the OWASP Top 10:2025 weakness classes most consistently associated with web breaches in aggregate analyses."

## Detection guidance

Domain detection is a reasoning task — read the available signals, weigh them, and propose. Then ask the user to confirm or pick.

### Signals to read (best to worst)

Read the highest-signal sources first; stop once the picture is clear.

| Signal | Where it lives | Why it matters |
|---|---|---|
| Site title and description | `<title>` and `<meta name="description">` in `index.html` (project root) | Author-curated identity — strongest cue |
| Site name | `siteName` field in `powerpages.config.json` | Same origin as the title |
| Website name / description | `name` and `description` fields in `.powerpages-site/website.yml` | Author-supplied; lower density than title/description but reliable |
| Web-role names | `name` field across `.powerpages-site/web-roles/*.webrole.yml` | Implies the site's user types — "Patient", "Donor", "Constituent" are strong domain cues |
| Table-permission entity names | `name` / `tableName` fields in `.powerpages-site/table-permissions/*.tablepermission.yml` | Implies the data model's domain |
| Datamodel manifest displayNames | `tables[].displayName` and `tables[].logicalName` in `.datamodel-manifest.json` (if present) | Strong if the file exists |
| Site-setting names | `name` field in `.powerpages-site/site-settings/*.sitesetting.yml` | Often plumbing — weakest signal |

Read these with `Read` and `Grep` as needed. Gather what's available, skip what isn't, do not fail when files are missing (a fresh site may have only `website.yml`).

### How to reason about it

1. Read the highest-signal sources first. If `<title>` says "First National Banking Portal" and the description mentions loan applications, that's `finance` with high confidence — stop there.
2. If the top sources are generic ("Customer Portal", "Member Site"), drop to web-roles and table-permissions. Role names like "Patient" → `healthcare`; "Donor" → `nonprofit`; "Constituent" → `government`; "Student" / "Faculty" → `education`; "Tenant" / "Workspace Admin" → `b2b_saas`.
3. If signals conflict (e.g., "Patient" web-role and "Order" / "Cart" table) — that is genuinely ambiguous. Surface the conflict to the user rather than guessing.
4. If nothing is clearly domain-revealing, propose `general` and ask.

### Confidence levels (advisory, not algorithmic)

Phrase your proposal at one of three confidence levels:

| Confidence | Meaning | Skill behavior |
|---|---|---|
| **High** | Multiple high-signal sources agree on one domain (e.g., title + description + web-roles all point to healthcare). | Tell the user "Detected: <domain> — proceeding" in one line. Do not block on confirmation, but accept correction if the user disagrees. |
| **Medium** | One or two signals point to a domain but the rest are generic. | Show what you read and the proposed domain, then use `AskUserQuestion` to confirm or override. |
| **Low** | Conflicting signals, or only generic signals. | Default to `general`, use `AskUserQuestion` to ask the user to pick from the catalog. |

The user's choice is **always authoritative** — never override a confirmed user choice with a high-confidence detection on a follow-up turn.
