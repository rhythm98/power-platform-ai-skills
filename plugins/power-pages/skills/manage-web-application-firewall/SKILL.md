---
name: manage-web-application-firewall
description: >-
  Manages the Power Pages Web Application Firewall (WAF) — enables or
  disables WAF, adds, updates, and removes custom rules for geo-blocking,
  IP allow-lists and block-lists, URI-pattern matching, and rate
  limiting, and disables managed rules that fire on legitimate traffic.
  Use when the user mentions WAF, firewall, rate limit, geo block, IP
  allowlist or blocklist, blocking bots, managed rules, OWASP rules,
  DDoS protection rules, false positives on legitimate traffic, or a
  user-agent ban — even if they do not use the exact phrase "Web
  Application Firewall". Out of scope: WAF log retrieval.
user-invocable: true
argument-hint: "[optional: enable, disable, status, rules]"
allowed-tools: Read, Write, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Web Application Firewall

Configure the Power Pages WAF: turn it on or off, write custom rules (geo, IP, URI, rate limit), and disable managed rules that block legitimate traffic. Each change is one command call behind a user approval — no batch application, no silent writes.

## When to load which reference

- `references/commands.md` — when building any `--status`, `--rules`, `--enable`, `--disable`, `--create-rules`, or `--delete-custom` command line; when crafting the JSON body for rule-configuration operations; when interpreting exit codes on stderr.
- `${CLAUDE_PLUGIN_ROOT}/references/admin-script-conventions.md` — when the user asks why the portal id differs from what they see in `pac pages list`, or when diagnosing prerequisite or auth failures.

## Gotchas

- `pac pages list` and `.powerpages-site/website.yml` store the **website record id**, not the portal id. Every command here takes the portal id. Resolve by running `website.js --websiteRecordId <guid>` first.
- Never resolve the site by name. Site names can duplicate inside an environment; only `--websiteRecordId` is safe.
- A `null` from the resolver is diagnosable — the site is not deployed, or the PAC auth profile is pointing at a different environment than the one that owns the site.
- **Production sites only.** Trial portals refuse every WAF operation with `B023`. User must convert to production.
- **Regional restrictions.** Singapore Local, China, and UAE block WAF entirely (`B022`). GCC, GCC High, and DoD allow enable/disable but block rule configuration — the rule-config refusal is surfaced as an `A010` / rule-config failure at the service and the skill cannot pre-block it locally. Surface the error verbatim and stop.
- **Edge propagation takes up to an hour.** Rule changes reach the admin layer in seconds but can take up to an hour to reach all global edge locations. The skill polls briefly (5 minutes) for admin-layer convergence; full edge propagation is the user's responsibility to monitor.
- **Async enable / disable / delete.** `--enable`, `--disable`, and `--delete-custom` return immediately with a polling pointer — the operation continues server-side. Do NOT treat acceptance as completion; poll `--status` / `--rules` in Phase 5.
- **Concurrent-operation guard.** `B003` means another enable/disable is already in flight. Poll `--status` until it settles, then retry.
- **False-positive managed rule:** disable it via a rule override (`enabledState: Disabled` inside `RuleGroupOverrides`).
- **First-match-wins.** Rules evaluate in priority order and subsequent rules are skipped once one matches. A common mistake is writing a chain of rules assuming they run cumulatively — they do not. Geo-allow-then-default-deny requires an explicit default-deny rule AFTER the allow.
- **Custom rule priority starts at 11.** Values 1–10 are reserved for platform-managed rules; user rules at those values are rejected. Rate-limit windows are restricted to 1–5 minutes.
- **`--create-rules` submits a full rule configuration.** Always read the current rules first (Phase 2), merge your changes into a complete plan, and submit the full target collection in one call. Submitting a partial body can have unpredictable effects on rules you did not mention.
- **Use `--delete-custom` to remove individual custom rules by name.** Removing rules by omission from a `--create-rules` body is not reliable — the delete command is the safe path for targeted removal.

## Workflow

At the start of Phase 1, create one task per phase with `TaskCreate`. Mark `in_progress` when you enter a phase and `completed` the moment it ends — do not batch updates. The final response carries a progress tracking table (see the end of this file) so the user can see at-a-glance what each phase produced.

### Phase 1 — Prerequisites and portal id resolution

1. Confirm the working directory is a Power Pages code site by locating `.powerpages-site/website.yml`. If missing, tell the user to run `/deploy-site` first and stop.
2. Read the `id` field from `.powerpages-site/website.yml` — the **website record id**.
3. Resolve the portal id (only by `websiteRecordId`, not by name):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/website.js" --websiteRecordId <id-from-step-2>
   ```
   The `id` field of the returned JSON is the portal id.
4. Handle the failure modes as documented in `admin-script-conventions.md`:
   - Non-zero exit with a prerequisite message → surface verbatim, stop.
   - Exit 0 with `null` on stdout → ask the user which of the two causes applies (site not deployed, or PAC profile pointing at the wrong environment).

### Phase 2 — Read current WAF state

Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-web-application-firewall/scripts/waf.js" --status --portalId <guid>
```

Interpret the three possible outcomes:

- **JSON string** → WAF is available on this site. The value is one of `Created` (WAF enabled), `Creating` (enable in progress), `Deleting` (disable in progress), `CreationFailed`, `DeletionFailed`, or `None` (never enabled, or fully removed). See `references/commands.md` for the full state table.
- **`null`** → WAF is not applicable (region-blocked or trial portal). Tell the user and stop the skill.
- **Non-zero exit** → a prerequisite or transport failure. Surface the stderr message and stop.

If the current state already matches the user's intent (e.g., they asked to enable and the status is already `Created`), confirm and exit early. If the status is `Creating` or `Deleting`, another operation is in flight — wait for it to settle before issuing a new one.

If the user plans to change rules, also fetch the current rules:
```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-web-application-firewall/scripts/waf.js" --rules --portalId <guid>
```

Keep the current rule set in your response context — Phase 3 builds the target state by merging against it.

### Phase 3 — Align on the desired change

Use `AskUserQuestion` to confirm what the user wants. A session may combine more than one of these changes:

| Change | What it does | Command |
|---|---|---|
| Turn WAF on | Enable the firewall | `--enable` |
| Turn WAF off | Disable the firewall | `--disable` |
| Edit rules | Add / update / replace custom rules, or disable a specific managed rule | `--create-rules --body <file>` |
| Remove rules | Remove named custom rules | `--delete-custom --names <file>` |

For rule-configuration operations the skill uses a plan-validate-execute pattern. A single operation is relatively cheap to reverse; a rule change that blocks real traffic is not. Follow this order:

1. **Plan** — write the target rule set to a transient JSON file at the project root (for example, `waf-plan.json`). Include ALL custom rules you want to end up with, not just the additions. Submitting a partial body can have unpredictable effects on rules you did not mention, so a complete target set is the safe default. The file is working state only — Phase 6 deletes it once the apply succeeds.
2. **Validate** — run the same command with `--dry-run`:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/skills/manage-web-application-firewall/scripts/waf.js" \
     --create-rules --portalId <guid> --body waf-plan.json --dry-run
   ```
   The command re-parses the body, re-validates its schema, checks for duplicate names and priorities, and verifies rate-limit windows are in range — all without contacting the service. Fix any errors and re-run until clean.
3. **Execute** — only after a clean `--dry-run`, proceed to Phase 4.

For `--delete-custom`, the plan is a JSON array of rule names. Follow the same dry-run-first pattern.

### Phase 4 — Apply

For each operation in the plan, pause with `AskUserQuestion` showing the exact command and the disclosures below. Wait for approval. Then run it. One approval, one command call.

Reference: `references/commands.md` for command shapes, body schemas, and exit codes.

**Required disclosures before approval**

- Enabling WAF: the site starts enforcing the Microsoft-managed rule set in Prevention mode immediately. Some legitimate requests may be blocked until the user reviews WAF logs and disables any over-eager rule.
- Disabling WAF: the site is no longer protected by managed or custom rules until re-enabled.
- Any rule change: applies globally; edge propagation can take up to an hour. First-match-wins — rule priority matters.
- Disabling a specific managed rule: that vector is no longer inspected until the rule is re-enabled. If the disable is intended as a temporary false-positive mitigation, log the intent in the session so the user can track it.

**Handling async operations**

`--enable`, `--disable`, and `--delete-custom` return asynchronously. Stdout on acceptance:

```json
{
  "accepted": true,
  "operation_location": "https://...",
  "retry_after_seconds": 60
}
```

Or, if another operation of the same kind is already in flight:

```json
{
  "accepted": false,
  "alreadyOngoing": true
}
```

Move directly to Phase 5 to poll. Do not claim success based on acceptance alone.

`--create-rules` is synchronous — on success the command exits `0` with the applied rule set echoed on stdout.

**Error handling**

Branch on the command's exit code. Full mapping in `references/commands.md`. The ones to handle here:

- Exit `3` (`A001`, portal not found): re-resolve via `website.js`; if still unknown, ask the user to confirm the site is deployed in the current environment.
- Exit `4` (`B001`, edge infrastructure not provisioned): not a self-service fix — escalate to support. Stop.
- Exit `5` (`B003`, another WAF operation in progress): run `--status` every 30–60 seconds until the in-flight operation settles, then retry the original command.
- Exit `6` (`B022`, region unsupported): not a self-service fix. Stop and tell the user which regions are excluded.
- Exit `7` (`B023`, trial portal): user must convert the site to production. Stop.
- Exit `2` (invalid arguments, body schema rejected, or `A010` from the service): re-read `commands.md`, correct the flag or fix the body, retry.
- Exit `8` (`A019` / `A033`, caller-config): the portal id is not a valid GUID, or the authenticated caller's tenant does not match the site's tenant. Re-resolve the portal id via `website.js` and confirm the active PAC auth profile points at the tenant that owns the site. Distinct from exit `2` — this is a caller-config problem, not a body-shape problem.
- Exit `1` (unknown or transport failure): surface the stderr message verbatim and stop. Authorization failures land in this bucket too — if the message indicates the caller is unauthorized, ask a site owner or tenant admin to re-run.

Do not retry on exit codes `4`, `6`, or `7` — those are state refusals that no retry will fix.

### Phase 5 — Verify

For **async operations** (`--enable`, `--disable`, `--delete-custom`), poll every 30–60 seconds for up to 5 minutes:

- After `--enable`: `--status` reports `Created` (and not `Creating` / `CreationFailed`).
- After `--disable`: `--status` reports `None` (and not `Deleting` / `DeletionFailed`).
- After `--delete-custom`: `--rules` no longer lists the deleted rule names.

If convergence has not happened within 5 minutes, do not claim success — show the user the current state, note that the admin layer is still settling, and ask how to proceed.

For the **sync operation** (`--create-rules`), the command's stdout already contains the applied rule set. Verify the submitted rules are present in it. A separate `--rules` call is redundant.

**Edge propagation** (full global rollout) can take up to an hour for any rule change. Tell the user this explicitly. The skill does not wait for edge propagation — it stops at admin-layer convergence.

### Phase 6 — Summarize and record usage

1. **Clean up transient plan files.** If Phase 3 wrote a `waf-plan.json` (or a names file for `--delete-custom`), delete it now — these are working state, not deliverables, and should not end up in version control. Only clean up after Phase 5 verified the apply; if verify failed and the user is still debugging, leave the plan files in place so they can iterate.

2. **Summarize the before → after state for the user**:
   - Whether WAF was enabled or disabled.
   - Which custom rules changed (added, updated, removed) with their priorities.
   - Which managed rules were disabled (if any).

3. **Remind them**:
   - Edge propagation is up to an hour.

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill-tracking instructions in the reference to record this skill's usage. Use `--skillName "ManageWebApplicationFirewall"`.

Close by asking: "Anything else on WAF, or done?" If the user wants a broader security review, suggest `/review-security`.

## Progress tracking table

Keep this table in your final response, filling each status as phases complete:

| Phase | Status |
|---|---|
| 1. Prerequisites and portal id resolution | ☐ |
| 2. Read current WAF state | ☐ |
| 3. Align on desired change | ☐ |
| 4. Apply | ☐ |
| 5. Verify | ☐ |
| 6. Summarize and record usage | ☐ |
