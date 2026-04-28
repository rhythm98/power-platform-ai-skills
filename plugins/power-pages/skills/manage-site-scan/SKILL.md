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
allowed-tools: Read, Write, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
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

The command returns `true` (a scan is running) or `false` (idle). Knowing the state changes Phase 3's options:

- **If a deep scan is ongoing** — the user cannot start a new deep scan (`Z003` refusal). They can run a quick scan, fetch an older completed report, or wait for the current scan to finish. `--report` and `--score` will also refuse until the ongoing scan completes.
- **If no scan is ongoing** — all Phase 3 options are available.

Summarize the state to the user in one sentence before continuing.

### Phase 3 — Align on the desired scan action

Use `AskUserQuestion` to confirm intent. The skill supports four actions; each session typically picks one:

| Intent | Command | Duration | Blocks session |
|---|---|---|---|
| Quick diagnostic scan | `--quick --lcid <id>` (e.g. `--lcid 1033` for en-US) | Seconds | Yes (synchronous) |
| Start a deep scan | `--deep` | Long-running server-side; start returns in seconds | No — skill exits after accepting the start |
| Fetch the latest deep-scan report | `--report` | Seconds | Yes |
| Fetch the security score | `--score` | Seconds | Yes |

For quick vs deep, explain the difference before asking — users frequently conflate them. If the user says "scan my site" without specifying, quick is the sensible default for a first interaction (instant feedback), and deep is the right pick when they want OWASP coverage.

If the user asks for authenticated-page coverage, point them at Studio.

### Phase 4 — Execute the action

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

### Phase 5 — Present results or polling instructions

The Phase 5 shape depends on which action ran in Phase 4:

**`--quick` ran** — the stdout is an array of diagnostic items. Each item has `issue` (title), `category`, `result` (one of Pass / Error / Warning / Information), `description`, and `learnMoreUrl`. Group by `result`, present a summary count, then list the errors and warnings in detail with their description and documentation link. Skip the Pass items unless the user asks for the full list.

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

After acknowledgment, Phase 5 is done — do NOT spin on `--ongoing` for the full scan duration; it is long enough to exhaust the session.

**`--report` ran** — the stdout is a structured report object with `TotalRuleCount`, `FailedRuleCount`, `TotalAlertCount`, `UserName` (who started the scan), `StartTime`, `EndTime`, and a `Rules` array grouped by rule (each entry has `RuleId`, `RuleName`, `RuleStatus`, `AlertsCount`, and `Alerts`). Each alert carries `AlertName`, `Description`, `Mitigation`, and a `Risk` rank (0=Informational, 1=Low, 2=Medium, 3=High). Present a summary (counts + start/end times) and then drill into the failed rules with their alerts' descriptions and mitigations. Do not dump the full pass list.

**`--score` ran** — the stdout is `{ totalRules, succeededRules }`. Compute and show a percentage as well as the raw pair. Tell the user the source scan's timestamp if they want context (they can fetch it via `--report`).

### Phase 6 — Summarize and record usage

Summarize what ran and what the user should do next:

- For `--quick`: list the top 3–5 warnings/errors and suggest remediation paths (delegate to `/review-security` for a framework-driven review if the findings span multiple areas).
- For `--deep` start: remind the user of the email-on-completion signal and the polling commands.
- For `--report` / `--score`: point out any deltas vs prior expectations.

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill-tracking instructions in the reference to record this skill's usage. Use `--skillName "ManageSiteScan"`.

Close by asking: "Anything else on scanning, or done?" If the user wants a broader security review, suggest `/review-security`.

## Progress tracking table

Keep this table in your final response, filling each status as phases complete:

| Phase | Status |
|---|---|
| 1. Prerequisites and portal id resolution | ☐ |
| 2. Read current scan state | ☐ |
| 3. Align on desired scan action | ☐ |
| 4. Execute the action | ☐ |
| 5. Present results or polling instructions | ☐ |
| 6. Summarize and record usage | ☐ |
