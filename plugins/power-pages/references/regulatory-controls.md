# Regulatory controls — automatable coverage map

Maps regulatory and compliance standards to the specific scan checks the plugin actually performs. Used by `review-security` Phase 6 to populate `metadata.regulatoryCoverage[]` in the findings JSON, which the report renders as a per-standard control list with covered / manual-only / not-applicable status.

**Honesty principle**: only controls that an automated scan can meaningfully verify are mapped to a check. Process-level controls (training, governance, contractual obligations, physical safeguards, breach-notification timelines, data-retention scheduling, vendor-management documentation) are explicitly marked **manual-only** so the report doesn't claim coverage it didn't earn. Even a thorough mapping covers ~20–30% of any given standard's controls — the rest is process / governance / documentation outside this skill's scope.

## Contents

- [How to use this file](#how-to-use-this-file)
- [Check sources — names and what they exercise](#check-sources--names-and-what-they-exercise)
- [Control coverage by standard](#control-coverage-by-standard)
  - [PCI-DSS v4.0](#pci-dss-v40)
  - [HIPAA Security Rule (45 CFR §164.308–§164.318)](#hipaa-security-rule-45-cfr-164308164318)
  - [GDPR](#gdpr)
  - [CCPA / CPRA](#ccpa--cpra)
  - [FERPA](#ferpa)
  - [NIST 800-53 Rev 5 (basis for FedRAMP / FISMA / StateRAMP)](#nist-800-53-rev-5-basis-for-fedramp--fisma--stateramp)
  - [ISO/IEC 27001:2022 Annex A](#isoiec-270012022-annex-a)
  - [SOC 2 — Trust Services Criteria 2017](#soc-2--trust-services-criteria-2017)
- [How `review-security` matches `regulatory_frame` to standards in this file](#how-review-security-matches-regulatory_frame-to-standards-in-this-file)

## How to use this file

For each standard, the table below maps **automatable controls** to a `checkSource` — the scan or check in this plugin that exercises the control. Phase 6 of `review-security`:

1. Reads the chosen domain's `regulatory_frame` (e.g., `"PCI-DSS, GDPR, CCPA"`).
2. Resolves each named standard to a section in this file (see [matching guidance](#how-review-security-matches-regulatory_frame-to-standards-in-this-file)).
3. For each control row in that section: if the listed `checkSource` is in `metadata.scansIncluded`, sets `status: "covered"`; otherwise `status: "not-applicable"` (scan was not run). Manual-only controls always render with `status: "manual-only"`.
4. For covered controls, walks the findings list and links any findings whose `source` matches the `checkSource` into `findingsRefs[]`.

The renderer surfaces this as a per-standard card with one row per control, status pill, link to evidence findings.

## Check sources — names and what they exercise

These are the canonical `checkSource` names referenced from the control tables below. The names match what `metadata.scansIncluded[]` carries (loose match — the source string contains the name).

| Check source name | Exercises |
|---|---|
| `Semgrep` | Static analysis: injection (SQL/XSS/command), unsafe input handling, hardcoded credentials, weak crypto patterns, insecure deserialization |
| `CodeQL` | Static dataflow analysis (deeper than Semgrep): tainted-data tracking through callgraphs |
| `Trivy vuln` | Software Composition Analysis: dependency CVEs, EOL packages |
| `Trivy license` | Dependency license classification |
| `ZAP deep` | Dynamic Application Security Testing: live injection probing, broken auth, missing security headers, TLS configuration, SSRF |
| `manage-site-scan quick` | Synchronous Power-Pages-specific config diagnostic checks |
| `manage-http-headers` | HTTP security-header configuration audit (CSP, CORS, HSTS, X-Frame-Options, SameSite, etc.) |
| `manage-web-application-firewall` | WAF enable/disable status, custom + managed-rule audit, log-capture configuration |
| `audit-permissions` | Table-permission YAML audit + Dataverse permission analysis |
| `setup-auth` (post-deploy audit) | Identity-provider configuration, anti-forgery token, session settings |
| `create-webroles` (audit phase) | Web-role definitions and assignments |
| `posture-snapshot` | Aggregate read of WAF + headers + scan state + roles + permissions |

A control may list more than one `checkSource` if multiple scans contribute. The skill considers the control covered when **any** of the listed sources ran.

## Control coverage by standard

### PCI-DSS v4.0

PCI-DSS applies to any system that stores, processes, or transmits cardholder data. The mapping below covers automatable Requirement 6 (secure development) and selected Requirements 7, 8, 10, 11 controls. Source: PCI-DSS v4.0 (PCI Security Standards Council, March 2022).

| Control ID | Title | Coverage | Check source |
|---|---|---|---|
| 6.2.4 | Software-development training | manual-only | — |
| 6.4.1 | Public-facing web app vulnerability detection | covered | `ZAP deep`, `Semgrep`, `manage-site-scan quick` |
| 6.4.2 | Public-facing web app protected by automated technical solution (WAF) | covered | `manage-web-application-firewall` |
| 6.4.3 | Public-facing web app payment-page integrity | manual-only | — |
| 6.5.1 | Bespoke and custom software developed securely (injection) | covered | `Semgrep`, `CodeQL`, `ZAP deep` |
| 6.5.2 | Bespoke and custom software (buffer overflow / unsafe memory) | covered | `Semgrep`, `CodeQL` |
| 6.5.3 | Bespoke and custom software (cryptography) | covered | `Semgrep`, `manage-http-headers` |
| 6.5.4 | Insecure communications | covered | `manage-http-headers`, `ZAP deep` |
| 6.5.5 | Improper error handling | covered | `Semgrep`, `CodeQL` |
| 6.5.6 | Vulnerabilities identified in security alerts (KEV) | covered | `Trivy vuln`, `fetch-cve-context.js` (KEV listing) |
| 6.5.7 | Cross-site scripting | covered | `Semgrep`, `CodeQL`, `ZAP deep` |
| 6.5.8 | Improper access control | covered | `audit-permissions`, `ZAP deep`, `setup-auth` |
| 6.5.9 | Cross-site request forgery | covered | `setup-auth`, `manage-http-headers` |
| 6.5.10 | Broken authentication / session management | covered | `setup-auth`, `manage-http-headers` |
| 7.2 | Define access control by role/job-function | covered | `create-webroles`, `audit-permissions` |
| 7.3 | Access enforced by access-control system | covered | `audit-permissions` |
| 8.3 | Strong authentication for users | covered | `setup-auth` |
| 8.4 | Multi-factor authentication for non-console access | manual-only | — |
| 10.2 | Audit logs for system events | covered | `manage-web-application-firewall` (log capture), `posture-snapshot` |
| 11.3.1 | External penetration testing | manual-only | — |
| 11.3.2 | Internal penetration testing | manual-only | — |
| 11.4 | Network intrusion detection | covered | `manage-web-application-firewall` |
| 12.x | Information security policy / programme | manual-only | — |

### HIPAA Security Rule (45 CFR §164.308–§164.318)

HIPAA applies to any system processing Protected Health Information (PHI). The Security Rule has Administrative (§164.308), Physical (§164.310), and Technical (§164.312) safeguards. Most administrative and all physical safeguards are manual-only; this table covers the automatable technical safeguards plus selected administrative ones.

| Control ID | Title | Coverage | Check source |
|---|---|---|---|
| §164.308(a)(1)(ii)(A) | Risk analysis | manual-only | — |
| §164.308(a)(1)(ii)(B) | Risk management | manual-only | — |
| §164.308(a)(3)(ii)(A) | Authorization / supervision | covered | `audit-permissions`, `create-webroles` |
| §164.308(a)(4) | Information access management | covered | `audit-permissions`, `create-webroles` |
| §164.308(a)(5)(ii)(B) | Protection from malicious software | manual-only | — |
| §164.308(a)(8) | Evaluation (technical/non-technical) | covered | `posture-snapshot`, `ZAP deep`, `Semgrep` |
| §164.310 | Physical safeguards (facility access, workstation security, device controls) | manual-only | — |
| §164.312(a)(1) | Access control — technical policies/procedures | covered | `audit-permissions`, `create-webroles`, `setup-auth` |
| §164.312(a)(2)(i) | Unique user identification | covered | `setup-auth` |
| §164.312(a)(2)(iii) | Automatic logoff | manual-only | — |
| §164.312(a)(2)(iv) | Encryption and decryption (at rest) | manual-only | — |
| §164.312(b) | Audit controls | covered | `manage-web-application-firewall` (log capture) |
| §164.312(c)(1) | Integrity of ePHI | covered | `Semgrep` (CWE-345/494/502 patterns) |
| §164.312(c)(2) | Mechanism to authenticate ePHI integrity | manual-only | — |
| §164.312(d) | Person/entity authentication | covered | `setup-auth` |
| §164.312(e)(1) | Transmission security | covered | `manage-http-headers` (HSTS / TLS), `ZAP deep` (TLS misconfig) |
| §164.312(e)(2)(i) | Integrity controls (transmission) | covered | `manage-http-headers` |
| §164.312(e)(2)(ii) | Encryption (transmission) | covered | `manage-http-headers`, `ZAP deep` |
| §164.314 | Organizational requirements (BAAs etc.) | manual-only | — |
| §164.316 | Policies/procedures and documentation | manual-only | — |

### GDPR

GDPR Article 32 ("Security of processing") is the primary article with technical implications. Articles 25 (Data Protection by Design), 30 (Records of processing), 33–34 (Breach notification), 35 (DPIA) are largely process-level. HITECH provisions in healthcare contexts overlay similar requirements.

| Control ID | Title | Coverage | Check source |
|---|---|---|---|
| Art 25(1) | Data protection by design (technical measures) | covered | `Semgrep`, `audit-permissions`, `manage-http-headers` |
| Art 25(2) | Data protection by default (data minimisation) | manual-only | — |
| Art 30 | Records of processing activities | manual-only | — |
| Art 32(1)(a) | Pseudonymisation and encryption | covered | `manage-http-headers` (TLS), `Semgrep` (crypto patterns) |
| Art 32(1)(b) | Confidentiality, integrity, availability, resilience | covered | `posture-snapshot`, `audit-permissions`, `manage-web-application-firewall` |
| Art 32(1)(c) | Restoration of availability after incident | manual-only | — |
| Art 32(1)(d) | Regular testing of effectiveness | covered | `ZAP deep`, `Semgrep`, `Trivy vuln` |
| Art 32(2) | Risk assessment | manual-only | — |
| Art 33 | Breach notification to supervisory authority | manual-only | — |
| Art 34 | Communication of breach to data subject | manual-only | — |
| Art 35 | Data Protection Impact Assessment | manual-only | — |

### CCPA / CPRA

California Consumer Privacy Act (Cal. Civ. Code §1798.100 et seq.) plus CPRA amendments. Most CCPA/CPRA obligations are process-level (consumer rights handling, opt-out flows, vendor contracts). Cal. Civ. Code §1798.81.5 ("reasonable security procedures") is the closest technical hook.

| Control ID | Title | Coverage | Check source |
|---|---|---|---|
| §1798.81.5 | Reasonable security procedures and practices | covered | `posture-snapshot`, `Semgrep`, `Trivy vuln`, `manage-http-headers` |
| §1798.100(a) | Notice at collection | manual-only | — |
| §1798.105 | Right to delete | manual-only | — |
| §1798.110 | Right to know what personal information is collected | manual-only | — |
| §1798.120 | Right to opt-out of sale/sharing | manual-only | — |
| §1798.135 | "Do Not Sell or Share" link / signal | manual-only | — |
| §1798.140 | Sensitive personal information limits | manual-only | — |
| §1798.150(a)(1)(A) | Right of action when reasonable security violated and breach occurs | covered | `posture-snapshot` (forward-looking — surfaces gaps) |

### FERPA

Family Educational Rights and Privacy Act (20 U.S.C. §1232g; 34 CFR Part 99). FERPA is largely process-level — most requirements are about disclosure conditions, parental consent, directory-information opt-outs. Technical safeguards are inferred from the general "reasonable methods" standard (34 CFR §99.31(a)(1)(ii)).

| Control ID | Title | Coverage | Check source |
|---|---|---|---|
| §99.31(a)(1)(ii) | Reasonable methods to ensure school officials only access records for legitimate educational interest | covered | `audit-permissions`, `create-webroles`, `setup-auth` |
| §99.32 | Recordkeeping of disclosures | manual-only | — |
| §99.33 | Limitation on redisclosure | manual-only | — |
| §99.34 | Conditions for disclosure to other educational agencies | manual-only | — |
| Technical inference: access control on student-record portals | covered | `audit-permissions`, `create-webroles` |
| Technical inference: authentication for student/parent access | covered | `setup-auth` |
| Technical inference: transmission security | covered | `manage-http-headers` (TLS/HSTS) |
| Technical inference: audit logging | covered | `manage-web-application-firewall` (log capture) |

### NIST 800-53 Rev 5 (basis for FedRAMP / FISMA / StateRAMP)

NIST 800-53 Rev 5 defines controls for federal information systems. FedRAMP and FISMA inherit these. The full catalogue has ~1,200 controls; the table below covers the automatable subset most relevant to a public-facing web application.

| Control ID | Title | Coverage | Check source |
|---|---|---|---|
| AC-2 | Account management | covered | `audit-permissions`, `create-webroles` |
| AC-3 | Access enforcement | covered | `audit-permissions`, `setup-auth` |
| AC-4 | Information flow enforcement | covered | `manage-http-headers` (CORS, CSP) |
| AC-6 | Least privilege | covered | `audit-permissions`, `create-webroles` |
| AC-17 | Remote access | manual-only | — |
| AT-2 | Literacy training | manual-only | — |
| AU-2 | Event logging | covered | `manage-web-application-firewall` (log capture) |
| AU-3 | Content of audit records | manual-only | — |
| AU-12 | Audit record generation | covered | `manage-web-application-firewall` |
| CM-3 | Configuration change control | manual-only | — |
| CM-7 | Least functionality | covered | `manage-http-headers`, `audit-permissions` |
| CP-9 | System backup | manual-only | — |
| IA-2 | Identification and authentication (organizational users) | covered | `setup-auth` |
| IA-5 | Authenticator management | manual-only | — |
| IR-4 | Incident handling | manual-only | — |
| RA-5 | Vulnerability scanning and analysis | covered | `Semgrep`, `Trivy vuln`, `ZAP deep`, `manage-site-scan quick` |
| SA-11 | Developer testing and evaluation | covered | `Semgrep`, `ZAP deep`, `Trivy vuln` |
| SA-15 | Development process / standards / tools | manual-only | — |
| SC-5 | Denial-of-service protection | covered | `manage-web-application-firewall` |
| SC-7 | Boundary protection | covered | `manage-web-application-firewall`, `manage-http-headers` |
| SC-8 | Transmission confidentiality and integrity | covered | `manage-http-headers` (TLS/HSTS) |
| SC-13 | Cryptographic protection | covered | `Semgrep`, `manage-http-headers` |
| SC-23 | Session authenticity | covered | `setup-auth`, `manage-http-headers` (SameSite) |
| SI-2 | Flaw remediation | covered | `Trivy vuln`, `fetch-cve-context.js` (KEV listing) |
| SI-3 | Malicious code protection | manual-only | — |
| SI-4 | System monitoring | covered | `manage-web-application-firewall` |
| SI-7 | Software, firmware, and information integrity | covered | `Semgrep` |
| SI-10 | Information input validation | covered | `Semgrep`, `CodeQL`, `ZAP deep` |
| SI-11 | Error handling | covered | `Semgrep` |

CISA KEV remediation deadlines apply to federal-civilian agencies (CISA Binding Operational Directive 22-01). The skill surfaces KEV listing per CVE via `fetch-cve-context.js`; meeting the deadline is operational and out of scope for the scan itself.

### ISO/IEC 27001:2022 Annex A

ISO 27001:2022 reorganized Annex A into 93 controls across 4 themes (Organizational, People, Physical, Technological). The table covers Technological (A.8) controls that automated scans can verify.

| Control ID | Title | Coverage | Check source |
|---|---|---|---|
| A.5.x | Organizational controls (policies, ISMS roles, etc.) | manual-only | — |
| A.6.x | People controls (screening, training, NDAs) | manual-only | — |
| A.7.x | Physical controls (perimeter, equipment) | manual-only | — |
| A.8.2 | Privileged access rights | covered | `audit-permissions`, `create-webroles` |
| A.8.3 | Information access restriction | covered | `audit-permissions`, `setup-auth` |
| A.8.5 | Secure authentication | covered | `setup-auth` |
| A.8.7 | Protection against malware | manual-only | — |
| A.8.8 | Management of technical vulnerabilities | covered | `Trivy vuln`, `Semgrep`, `ZAP deep` |
| A.8.16 | Monitoring activities | covered | `manage-web-application-firewall` (log capture) |
| A.8.20 | Networks security | covered | `manage-web-application-firewall` |
| A.8.21 | Security of network services | covered | `manage-http-headers` |
| A.8.22 | Segregation of networks | manual-only | — |
| A.8.23 | Web filtering | covered | `manage-web-application-firewall` |
| A.8.24 | Use of cryptography | covered | `manage-http-headers`, `Semgrep` |
| A.8.25 | Secure development life cycle | manual-only | — |
| A.8.26 | Application security requirements | covered | `Semgrep`, `ZAP deep` |
| A.8.28 | Secure coding | covered | `Semgrep`, `CodeQL` |
| A.8.29 | Security testing in development and acceptance | covered | `Semgrep`, `ZAP deep`, `Trivy vuln` |
| A.8.30 | Outsourced development | manual-only | — |
| A.8.32 | Change management | manual-only | — |

### SOC 2 — Trust Services Criteria 2017

SOC 2 audits assess against five Trust Services Criteria: Security (Common Criteria, mandatory), Availability, Processing Integrity, Confidentiality, Privacy. The Common Criteria (CC1–CC9) are the always-in-scope set. The table covers automatable Common Criteria entries.

| Control ID | Title | Coverage | Check source |
|---|---|---|---|
| CC1.x | Control environment (governance, ethics, structure) | manual-only | — |
| CC2.x | Communication and information | manual-only | — |
| CC3.x | Risk assessment | manual-only | — |
| CC4.x | Monitoring activities (control monitoring) | manual-only | — |
| CC5.x | Control activities (selection, deployment) | manual-only | — |
| CC6.1 | Logical and physical access — restrict access | covered | `audit-permissions`, `create-webroles`, `setup-auth` |
| CC6.2 | Logical and physical access — register/authorize new users | covered | `audit-permissions`, `setup-auth` |
| CC6.3 | Logical and physical access — modify and remove access | manual-only | — |
| CC6.6 | Logical and physical access — security incident response | manual-only | — |
| CC6.7 | Logical and physical access — restrict transmission/movement | covered | `manage-http-headers` (TLS/HSTS), `ZAP deep` |
| CC6.8 | Logical and physical access — prevent/detect malicious software | manual-only | — |
| CC7.1 | System operations — detection of vulnerabilities | covered | `Trivy vuln`, `Semgrep`, `ZAP deep`, `manage-site-scan quick` |
| CC7.2 | System operations — monitoring of system components | covered | `manage-web-application-firewall` (log capture) |
| CC7.3 | System operations — security incident evaluation | manual-only | — |
| CC7.4 | System operations — incident response activities | manual-only | — |
| CC7.5 | System operations — recovery from incidents | manual-only | — |
| CC8.1 | Change management — authorization, design, develop, deploy | manual-only | — |
| CC9.1 | Risk mitigation — risk-mitigation activities | covered | `posture-snapshot`, `Trivy vuln` |
| CC9.2 | Risk mitigation — vendors and business partners | manual-only | — |

## How `review-security` matches `regulatory_frame` to standards in this file

Each domain profile in `domain-attack-profiles.md` lists a `regulatory_frame` string like `"PCI-DSS, SOX, GLBA, regional (FFIEC / PSD2 / RBI)"`. Phase 6 of `review-security` parses that string and matches each named standard against this file's section headings — case-insensitive, whitespace-tolerant, partial match acceptable.

| `regulatory_frame` token | Matches section |
|---|---|
| `PCI-DSS`, `PCI DSS` | [PCI-DSS v4.0](#pci-dss-v40) |
| `HIPAA`, `HITECH` | [HIPAA Security Rule](#hipaa-security-rule-45-cfr-164308164318) (HITECH technical safeguards subset of HIPAA) |
| `GDPR`, `GDPR Article 32`, `GDPR Article 9` | [GDPR](#gdpr) |
| `CCPA`, `CPRA` | [CCPA / CPRA](#ccpa--cpra) |
| `FERPA` | [FERPA](#ferpa) |
| `FedRAMP`, `FISMA`, `StateRAMP`, `NIST 800-53` | [NIST 800-53 Rev 5](#nist-800-53-rev-5-basis-for-fedramp--fisma--stateramp) |
| `ISO 27001`, `ISO/IEC 27001` | [ISO/IEC 27001:2022 Annex A](#isoiec-270012022-annex-a) |
| `SOC 2`, `SOC2`, `Trust Services Criteria` | [SOC 2 — Trust Services Criteria](#soc-2--trust-services-criteria-2017) |

Standards in `regulatory_frame` not represented in this file (`SOX`, `GLBA`, `COPPA`, `FFIEC`, `PSD2`, `RBI`, `PIPEDA`, `PHIPA`, `charitable-data`, etc.) are recorded in `metadata.regulatoryCoverage[]` with a single placeholder row of `status: "manual-only"` and `controlName: "<Standard> — controls not modeled in regulatory-controls.md; assess separately"`. This keeps the report honest about gaps without inventing coverage.

When `regulatory_frame` is empty (e.g., `general` domain), `metadata.regulatoryCoverage[]` is an empty array and the report's Regulatory coverage tab shows an empty-state message ("No regulatory framework was selected for this review").
