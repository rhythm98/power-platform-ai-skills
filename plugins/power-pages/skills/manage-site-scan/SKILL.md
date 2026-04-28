---
name: manage-site-scan
description: >-
  Runs the Power Pages security scan — triggers a quick synchronous
  diagnostic scan, starts the long-running OWASP-based deep scan against
  the site's public surface, polls for deep-scan completion, and fetches
  the latest completed deep-scan report or security score. Use when the
  user mentions security scan, vulnerability scan, penetration test,
  OWASP scan, ZAP scan, scanning for vulnerabilities, checking the
  security score, reviewing the last scan report, or wants to see what
  findings the site has — even if they do not use the exact phrase
  "security scan". Out of scope: authenticated-page scanning (use
  Studio).
user-invocable: true
argument-hint: "[optional: quick, deep, report, score]"
allowed-tools: Read, Write, Bash, Glob, Grep, WebFetch, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Security Scan

Run a security scan against a Power Pages site and fetch the results. Four user intents:

- **Quick diagnostic scan** — synchronous, a few seconds, returns a list of pass / warning / error items for common configuration and security patterns.
- **Start a deep scan** — asynchronous OWASP-based dynamic test of the public surface. Runs for a substantial period server-side; completion is announced via email and visible in Studio.
- **Fetch the latest deep-scan report** — structured findings with per-rule status and vulnerability details.
- **Fetch the security score** — raw `{ totalRules, succeededRules }` pair from the latest deep scan; the skill computes a readable percentage for the user.

## When to load which reference

- `references/commands.md` — when building `--quick`, `--deep`, `--ongoing`, `--report`, or `--score` command lines; when interpreting exit codes on stderr.
- `${CLAUDE_PLUGIN_ROOT}/references/threat-context.md` — load in Phase 6 to frame results: OWASP Top 10:2025 mapping, scan-type coverage table, trusted public data sources, runtime metric fetching, and confidence-message templates.
- `${CLAUDE_PLUGIN_ROOT}/references/domain-attack-profiles.md` — load in Phase 3 for the detection guidance, and again in Phase 6 to rank findings against the chosen domain's `top_owasp` and pull the matching `failure_emphasis` / `pass_emphasis` snippets.
- `${CLAUDE_PLUGIN_ROOT}/references/admin-script-conventions.md` — when the user asks why the portal id differs from what they see in `pac pages list`, or when diagnosing prerequisite or auth failures.

## Gotchas

- `pac pages list` and `.powerpages-site/website.yml` store the **website record id**, not the portal id. Every command here takes the portal id. Resolve by running `website.js --websiteRecordId <guid>` first.
- Never resolve the site by name. Site names can duplicate inside an environment; only `--websiteRecordId` is safe.
- A `null` from the resolver is diagnosable — the site is not deployed, or the PAC auth profile is pointing at a different environment than the one that owns the site.
- **Deep scans are long-running.** The skill does NOT wait — start the scan, tell the user to expect a substantial wait server-side, and let them come back later to fetch the report. The completion signal is an email to the site admin plus a visible result in the Power Pages Studio interface under Security → Run scan.
- **Only one deep scan per site at a time.** `Z003` surfaces distinctly (exit code 4) when a start is attempted against a site that already has a scan running, or when a report/score is requested while a scan is mid-flight. Poll `--ongoing` until it settles; do not retry immediately.
- **Quick scan is not the same thing as deep scan.** Quick runs a synchronous set of built-in diagnostic checks against site configuration and common patterns. Deep runs an asynchronous OWASP-based dynamic scan that actively probes the public surface. Users often ask for "a scan" when they mean one specific type — ask them to pick.
- **Deep scan is anonymous only.** The scanner does not sign in; authenticated-page coverage is available through Studio.
- **Security score is raw, not a grade.** The underlying value is `{ totalRules, succeededRules }` from the most recent completed deep scan. The skill displays a human-readable percentage as a convenience, but the raw pair is the source of truth.
- **`A010` means invalid input, not site state.** `A010` can surface from `--quick` (missing / bad LCID, malformed portal id) or `--deep` (malformed portal id). Exit 5 carries it. Surface the stderr message verbatim so the user can see which input is being rejected.
- **`--quick` requires an LCID.** The diagnostic service expects a Microsoft Locale ID (e.g. `1033` for en-US) to choose the language of the returned messages. Omitting `--lcid` is rejected with `A010`. When the user does not specify a language, default to `1033`.
- **Rate limits apply.** There are daily and weekly caps on scans per site. When exceeded, the service returns a generic server error (exit 1 / transport). Wait and retry later is the only mitigation — this cap is not configurable from here.
- **A fresh site with no completed deep scan has no report and no score.** `--report` and `--score` both surface that as a distinct stderr message and exit code 1. Run a deep scan first.

## Workflow

At the start of Phase 1, create one task per phase with `TaskCreate`. Mark `in_progress` when you enter a phase and `completed` the moment it ends — do not batch updates. The final response carries a progress tracking table (see the end of this file) so the user can see at-a-glance what each phase produced.

### Phase 1 — Prerequisites and portal id resolution

1. Confirm the working directory is a Power Pages code site by locating `.powerpages-site/website.yml`. If missing, tell the user to run `/deploy-site` first and stop.
2. Read the `id` field from `.powerpages-site/website.yml` — the **website record id**.
3. Resolve the portal id (only by `websiteRecordId`, not by name):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/website.js" --websiteRecordId <id-from-step-2>
   ```
   The `id` field on the returned record is the portal id.
4. Handle failure modes per `admin-script-conventions.md`:
   - Non-zero exit with a prerequisite message → surface verbatim and stop.
   - Exit 0 with `null` on stdout → ask the user which of the two causes applies (site not deployed, or PAC profile pointing at the wrong environment).

### Phase 2 — Read current scan state

Before asking the user what they want, check whether a deep scan is currently running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-site-scan/scripts/scan.js" --ongoing --portalId <guid>
```

The command returns `true` (a scan is running) or `false` (idle). Knowing the state changes Phase 4's options:

- **If a deep scan is ongoing** — the user cannot start a new deep scan (`Z003` refusal). They can run a quick scan, fetch an older completed report, or wait for the current scan to finish. `--report` and `--score` will also refuse until the ongoing scan completes.
- **If no scan is ongoing** — all Phase 4 options are available.

Summarize the state to the user in one sentence before continuing.

### Phase 3 — Detect the site's domain

Domain context (finance / healthcare / retail / government / education / B2B SaaS / non-profit / general) drives how Phase 6 ranks findings. Classify the site by reasoning over its content. Read the relevant signals, decide on a domain, and propose. The user always confirms or overrides.

Load `${CLAUDE_PLUGIN_ROOT}/references/domain-attack-profiles.md` and follow its **Detection guidance** section. In short:

1. Read the highest-signal sources first — `index.html` (`<title>`, `<meta name="description">`), `powerpages.config.json` (`siteName`), and `.powerpages-site/website.yml` (`name`, `description`).
2. If the picture isn't clear, drop to web-roles, table-permissions, and `.datamodel-manifest.json` (if present).
3. Skip site-settings unless still ambiguous — they are mostly plumbing.
4. Form a confidence judgment (high / medium / low) per the guidance doc:
   - **high**: confirm in one line and continue.
   - **medium**: show the proposal plus the signals you read, and use `AskUserQuestion` to offer override.
   - **low**: default to `general`, use `AskUserQuestion` to ask the user to pick from the eight-key catalog.
5. The user's selection is **always authoritative** — do not override a confirmed user choice with the proposed classification on a follow-up.

Stash the chosen domain key for Phase 6.

### Phase 4 — Align on the desired scan action

Use `AskUserQuestion` to confirm intent. The skill supports four actions; each session typically picks one:

| Intent | Command | Duration | Blocks session |
|---|---|---|---|
| Quick diagnostic scan | `--quick --lcid <id>` (e.g. `--lcid 1033` for en-US) | Seconds | Yes (synchronous) |
| Start a deep scan | `--deep` | Long-running server-side; start returns in seconds | No — skill exits after accepting the start |
| Fetch the latest deep-scan report | `--report` | Seconds | Yes |
| Fetch the security score | `--score` | Seconds | Yes |

For quick vs deep, explain the difference before asking — users frequently conflate them. If the user says "scan my site" without specifying, quick is the sensible default for a first interaction (instant feedback), and deep is the right pick when they want OWASP coverage.

If the user asks for authenticated-page coverage, point them at Studio.

### Phase 5 — Execute the action

For the write action (`--deep`), pause with `AskUserQuestion` showing the exact command and the disclosures below. Wait for approval, then run. Read actions (`--quick`, `--report`, `--score`) run without an approval pause since they do not modify state.

Reference: `references/commands.md` for command shapes and exit codes.

**Required disclosures before `--deep` approval**

- Deep scan is long-running server-side. The skill does not wait — it will hand off and exit; the user returns later (or via the meta-skill) to check progress and fetch the report.
- The scan runs against the site's public surface only; authenticated-only pages are not tested.
- Completion is signaled by email to the site admin and a visible result in Studio.
- Only one deep scan can run on a site at a time. While one is ongoing, further `--report` / `--score` / `--deep` calls will refuse with `Z003`.

**Error handling**

Branch on the command's exit code. Full table in `references/commands.md`. The ones to handle here:

- Exit `3` (`A001`, portal not found): re-resolve via `website.js`.
- Exit `4` (`Z003`, scan already ongoing): for `--deep`, tell the user a scan is in flight and offer to poll `--ongoing` or wait. Do NOT retry `--deep`. For `--report` / `--score`, it means the running scan hasn't finished — poll `--ongoing` and re-fetch when it completes.
- Exit `5` (`A010`, invalid input): interpret the stderr message — typical causes are a bad LCID on `--quick` or a malformed portal id. Surface the message to the user and stop.
- Exit `2` (invalid CLI arguments): re-read `commands.md`, correct the flag, retry.
- Exit `1` (unknown / transport / rate-limited): surface the stderr verbatim. If the message indicates rate limiting, tell the user the site's daily or weekly scan cap is exhausted and the only mitigation is to wait.

Do not retry exit codes `4` or `5` — those are state refusals that will not resolve with a quick retry.

### Phase 6 — Present results (domain-aware)

Phase 6 is the dynamic part of this skill. Before formatting any output, load both:

- `${CLAUDE_PLUGIN_ROOT}/references/threat-context.md` — for OWASP rank lookup, scan-type coverage, runtime metric fetching, and confidence-message templates.
- `${CLAUDE_PLUGIN_ROOT}/references/domain-attack-profiles.md` — for the chosen domain's `top_owasp`, `regulatory_frame`, and `failure_emphasis` / `pass_emphasis` snippets.

Anchor claims to OWASP rank labels (A01-A10), CVE IDs, and runtime-fetched CVSS / EPSS / CISA-KEV values, attributed to the source body (OWASP Top 10:2025, CISA KEV, NIST NVD, FIRST EPSS). When a quantitative figure adds value, fetch it via `WebFetch` from the trusted sources listed in `${CLAUDE_PLUGIN_ROOT}/references/threat-context.md` (see the **Trusted public data sources** section); on fetch failure, fall back to qualitative phrasing.

In all cases, **rank by domain relevance, not raw severity alone** — a high-severity finding outside the domain's top OWASP categories is still important, but the lead item should be the highest-severity finding whose OWASP rank appears in the domain's `top_owasp` list.

**Live CVE enrichment.** When findings include CVE identifiers, shell out to the plugin-shared helper to fetch live KEV / EPSS / CVSS values from public open-data sources:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/fetch-cve-context.js" --cves CVE-XXXX-NNNN,CVE-YYYY-MMMM,...
```

The script caps at 5 CVEs by default (sort findings by report-supplied severity and pass the top 5), batches the EPSS call, paces NVD calls under its 5/30s soft limit, and caches the KEV feed in-process. Stdout is a JSON `{ results, sources, allDown }` object. Exit codes:

- **0** — usable data; merge `results[].cvss` / `epss` / `kev` into each finding's display.
- **1** — all three sources are down. Skip enrichment and add a one-line note ("live enrichment unavailable; using report-supplied severity") to the output.
- **2** — bad CLI args.

Full source/format details are in `${CLAUDE_PLUGIN_ROOT}/references/threat-context.md` under **Runtime metric fetching** → **CVE-bearing findings**.

**`--quick` ran** — stdout is an array of diagnostic items shaped as `{ issue, category, result, description, learnMoreUrl }`. Build a summary count by `result`, then for each Error / Warning:

1. Map its `category` to an OWASP rank using the table in `threat-context.md`.
2. Compute relevance: `domain-priority` if the rank is in the chosen domain's `top_owasp`, else `general`.
3. Lead with the domain-priority items in order; follow with the rest. Do not dump Pass items unless the user asks.
4. For each surfaced finding, include: the issue, the OWASP rank label (A01-A10), a one-line "what this enables an attacker to do", and the `learnMoreUrl`. Optionally append a runtime-fetched figure from `https://owasp.org/Top10/` with attribution.

If everything passed, lead with the chosen domain's `pass_emphasis` line plus the `CM-OVERALL` template from `threat-context.md`.

**`--deep` started** — acknowledge that the scan is running server-side. Tell the user:
- Expected duration: a substantial wait server-side — the completion email is the authoritative signal; the skill should not poll tightly.
- Completion signal: email to the site admin + visible in the Power Pages Studio interface under Security → Run scan.
- Polling command the user or meta-skill can run later to check:
  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/skills/manage-site-scan/scripts/scan.js" --ongoing --portalId <guid>
  ```
- Fetch command once it completes:
  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/skills/manage-site-scan/scripts/scan.js" --report --portalId <guid>
  ```
- Note that when the report is fetched later, the same domain-aware framing will be applied — record the chosen domain key so a follow-up session can reuse it without re-running detection.

After acknowledgment, Phase 6 is done — do NOT spin on `--ongoing` for the full scan duration; it is long enough to exhaust the session.

**`--report` ran** — stdout is a structured report with `TotalRuleCount`, `FailedRuleCount`, `TotalAlertCount`, `UserName`, `StartTime`, `EndTime`, and `Rules` (each with `RuleId`, `RuleName`, `RuleStatus`, `AlertsCount`, `Alerts`). Each alert carries `AlertName`, `Description`, `Mitigation`, and `Risk` (0=Informational, 1=Low, 2=Medium, 3=High).

Before presenting, scan the alerts for any CVE references in `AlertName` or `Description` and run the **Live CVE enrichment** step above for the top-5 by Risk. Then present in this order:

1. **Headline** — one paragraph: the chosen domain's `pass_emphasis` (if `FailedRuleCount === 0`) or `failure_emphasis` (otherwise), plus counts and the run window.
2. **Domain-priority failures** — failures whose mapped OWASP rank is in `top_owasp` for the chosen domain. For each, include the rule, the alerts (sorted Risk 3 → 0), and:
   - If the alert references a CVE: the enriched metrics line — `CVE-XXXX-NNNN (CVSS <baseScore> <baseSeverity>, EPSS <epss> — top <100-percentile>%, KEV: <yes-with-dueDate / no>)`.
   - Otherwise (no CVE in the alert): the OWASP rank label only, optionally augmented with a runtime-fetched figure from the OWASP per-category page (https://owasp.org/Top10/) with attribution.
   - Followed by the alert's `Mitigation` text.
   Use the failure messaging principles from `threat-context.md` — lead with attacker capability, anchor to public metrics, then the mitigation.
3. **Other failures** — remaining failures, condensed to one line each (rule + count + top alert), unless the user asks for full detail.
4. **Confidence summary for passing clusters** — for each scan family that passed cleanly (deps, static, dynamic, config, secrets, auth/access), pick the matching `CM-*` template from `threat-context.md` and substitute live numbers. Skip a cluster if the report does not exercise it.
5. **Tradeoffs to disclose** — close with one of the caveats from `threat-context.md`'s tradeoffs section. Always include one — never leave the user with the impression a clean scan = permanently safe.

Do not dump the full pass list of rules.

**`--score` ran** — stdout is `{ totalRules, succeededRules }`. Compute and show a percentage and the raw pair. Frame it for the chosen domain: "<X>% of the rules relevant to <regulatory_frame> sites passed" when `regulatory_frame` is non-empty, otherwise the plain percentage. If the user wants context, point them at `--report`.

### Phase 7 — Summarize and record usage

Summarize what ran and what the user should do next, keeping the domain framing consistent with Phase 6:

- For `--quick`: list the top 3–5 warnings/errors **ordered by domain priority** (domain-`top_owasp` matches first), with one-line remediation paths. If findings span multiple areas, suggest `/review-security` for a framework-driven review — call out the `regulatory_frame` if one applies.
- For `--deep` start: remind the user of the email-on-completion signal and the polling commands. Note the detected domain so the follow-up session can skip detection.
- For `--report` / `--score`: point out any deltas vs prior expectations and reiterate the highest-priority unresolved item for the domain.

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill-tracking instructions in the reference to record this skill's usage. Use `--skillName "ManageSiteScan"`.

Close by asking: "Anything else on scanning, or done?" If the user wants a broader security review, suggest `/review-security`.

## Progress tracking table

Keep this table in your final response, filling each status as phases complete:

| Phase | Status |
|---|---|
| 1. Prerequisites and portal id resolution | ☐ |
| 2. Read current scan state | ☐ |
| 3. Detect site domain | ☐ |
| 4. Align on desired scan action | ☐ |
| 5. Execute the action | ☐ |
| 6. Present results (domain-aware) | ☐ |
| 7. Summarize and record usage | ☐ |
