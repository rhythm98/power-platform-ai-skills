# Power Pages admin script conventions

Shared conventions for the `scripts/lib/admin-api.js` transport layer and the per-skill `scripts/*.js` commands that depend on it. Skills in this plugin invoke the commands; they never reimplement any part of a command's behavior.

## Contents

- [Who uses these commands](#who-uses-these-commands)
- [Prerequisites](#prerequisites)
- [Portal id vs website record id](#portal-id-vs-website-record-id)
- [Invocation conventions](#invocation-conventions)
- [Output conventions](#output-conventions)
- [Exit behavior](#exit-behavior)
- [Shared error code catalogue](#shared-error-code-catalogue)
- [The site resolver command](#the-site-resolver-command)

## Who uses these commands

Two sub-skills of the `review-security` family depend on this command layer:

- `manage-web-application-firewall`
- `manage-site-scan`

Each of those skills ships `scripts/<name>.js` commands plus a `references/commands.md` that documents exactly what each command accepts and returns. Read this file for cross-skill conventions; read the per-skill `commands.md` for command-level detail.

## Prerequisites

Every command call requires all of the following. If any are missing, the command exits non-zero with a message naming what to fix — surface it to the user verbatim rather than guess.

- The working directory is a Power Pages code site that has been deployed at least once — `.powerpages-site/website.yml` exists with a valid `id` (the website record id).
- `pac auth who` succeeds. The commands read environment id and cloud from the active PAC profile.
- `az account get-access-token` succeeds. The commands acquire an access token for the Power Platform resource.

## Portal id vs website record id

These are two distinct GUIDs:

| Term | Where it lives | Used by |
|---|---|---|
| **Website record id** | `.powerpages-site/website.yml` `id` field, and the "Website Record ID" column in `pac pages list` | `website.js --websiteRecordId` |
| **Portal id** | The admin service's identifier for the site — only obtained by resolving the record id via `website.js` | Every `--portalId` argument on every per-skill command |

Every site-scoped command takes `--portalId`. Passing the website record id instead produces `A001` (portal not found), because the admin service does not recognize that value. Always resolve first.

## Invocation conventions

All commands in this family:

- Accept `--portalId <guid>` for site-scoped operations.
- Are non-interactive — they never prompt on stdin.
- Print JSON to stdout on success.
- Print diagnostics and transient-retry notices to stderr.
- Inherit a two-retry policy for `401` (token refresh) and `429 / 500 / 502 / 503` (backoff), so skills do not need to retry those classes themselves.

## Output conventions

A successful command call prints one of:

- The upstream response body as JSON (for read commands).
- A small status object — `{ "accepted": true }` or `{ "updated": true }` — for write commands whose upstream response is empty.
- `{ "accepted": true }` for async-start commands on acceptance. When the upstream service emits an `Operation-Location` header and a `Retry-After` value, the command additionally includes `"operation_location"` and `"retry_after_seconds"` fields; when it does not, the acceptance signal is the minimal shape. Either way, callers poll the paired status / ongoing / rules command for completion.
- `{ "accepted": false, "alreadyOngoing": true }` for async-start commands when another operation of the same kind is already in progress.
- `null` for read commands that represent "not applicable" or "no data yet" (e.g., WAF not applicable to this site, no completed scan yet).

Skills branch on the JSON shape. They do not branch on status codes — the commands already translate transport-level signals into structured output.

## Exit behavior

Every command exits `0` on success. Non-zero exits indicate failure and the message is on stderr — preserve it verbatim for the user.

Commands MAY use distinct non-zero exit codes per user-actionable failure class (invalid arguments, portal not found, authorization refused, state refusal, etc.), so skills can branch without parsing the stderr text. Per-command exit-code tables live in each skill's `references/commands.md` and in the command's own `--help`. A command that has not yet adopted per-class exit codes uses `1` for all failures; callers should therefore read the command's documentation rather than assume a shared mapping.

When the underlying service returned a catalogued error, the command's stderr message includes the code (e.g., `... failed: HTTP 404 (A001)`, or `HTTP 409` for cases without a catalogued code). Skills pattern-match on the code to choose a recovery path; unknown codes bubble up to the user unchanged.

## Shared error code catalogue

Codes the commands may surface on stderr and the condition each represents. Only codes that map to a user-actionable recovery path appear here; transient transport codes (`429`, `5xx`) are retried internally and never reach the skill.

| Code | Condition | Recommended skill response |
|---|---|---|
| `A001` | Portal not found | Re-resolve the portal id via `website.js`. If still unknown, ask the user to confirm the site is deployed in the current environment. |
| `A010` | Invalid argument value | Re-read the per-skill `commands.md` for the offending command; correct the flag and retry. |
| `A019` | Portal belongs to a different tenant than the signed-in user | Ask the user to re-auth in the correct tenant. |
| `A033` | Portal belongs to a different environment than the PAC default | Ask the user to switch PAC env, or pass `--environmentId` explicitly. |
| `A037` | Caller is not authorized to perform this change on the site. | Ask a tenant admin to perform the change; do not retry. |
| `B001` | The edge resource for this site is not provisioned | Not a self-service fix — escalate to support. |
| `B003` | Another operation of the same family is already in progress | Poll the matching status command, wait, then retry. |
| `B022` | WAF not available in this region | Regional gate — not a self-service fix. |
| `B023` | WAF not available on trial portals | Convert the site to production licensing. |
| `Z003` | A scan is already ongoing | Do NOT retry — poll the scan-ongoing check instead. |

## The site resolver command

Every site-scoped operation needs the portal id, and the portal id is never the value a user naturally has — they have the website record id. Resolve with:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/website.js" --websiteRecordId <guid>
```

Resolve **only** by `websiteRecordId`. Site names can duplicate across an environment, so a name-based lookup can silently target the wrong site — do not add a name-based fallback.

**On success**: prints the matched website record as JSON. The `id` field in that record is the portal id every per-skill command needs.

**On no match**: prints `null`. Null is diagnosable — it means one of the following, and the skill MUST surface both possibilities to the user rather than stopping with a generic "not found":

- The site has not been deployed yet. `.powerpages-site/website.yml` exists locally but no Dataverse record with that id has been created. Recovery: run `/deploy-site` first.
- The active PAC auth profile is pointing at a different environment than the one that owns the site. Recovery: run `pac auth who` to see the current environment, then `pac auth list` / `pac auth select` to switch to the right one and re-run the skill.

Skills that see `null` should ask the user which of the two applies before attempting any recovery.
