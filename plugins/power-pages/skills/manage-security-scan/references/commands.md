# Security scan commands

Per-command spec for the five commands shipped with this skill. `SKILL.md` decides when to call each; this file is how to invoke them.

## Contents

- [Shared exit codes](#shared-exit-codes)
- [Run a quick diagnostic scan](#run-a-quick-diagnostic-scan) — sync
- [Start a deep scan](#start-a-deep-scan) — async
- [Is a deep scan ongoing?](#is-a-deep-scan-ongoing)
- [Fetch the latest completed deep-scan report](#fetch-the-latest-completed-deep-scan-report)
- [Fetch the security score](#fetch-the-security-score)
- [Response shape — quick scan items](#response-shape--quick-scan-items)
- [Response shape — deep scan report](#response-shape--deep-scan-report)

## Shared exit codes

Every command uses the same exit-code space.

| Code | Meaning |
|---|---|
| `0` | Success. Parse stdout for the result. |
| `1` | Unknown or transport failure. Includes rate-limit exhaustion (daily / weekly scan cap), generic server errors (`A009` — HTTP 500), and authorization failures (HTTP 401 for callers who lack one of the required roles: portal owner, environment system administrator, environment system customizer, Microsoft 365 admin, Power Platform service admin, Dynamics 365 service admin). |
| `2` | Invalid or missing CLI arguments. |
| `3` | Portal not found (`A001`, HTTP 404). |
| `4` | A scan is already ongoing for this site (`Z003`, HTTP 204 No Content with a standard error envelope). Distinct from exit 1 so the skill can branch — poll `--ongoing` until the in-flight scan settles, then retry. |
| `5` | Invalid input (`A010`, HTTP 400). Typical causes: missing / bad LCID on `--quick`, malformed portal id, or other input rejected by the service. Read the stderr message for the specific cause. |
| `6` | Caller-config issue (`A019` — portal id is not a GUID; `A033` — caller's tenant does not match the portal's tenant; both HTTP 400 under the standard error envelope). Distinct from exit 1 so skills can branch on caller-config vs transport failures, and distinct from exit 5 because these indicate a caller-configuration issue (wrong tenant, or the skill was handed the website record id instead of the portal id) rather than a user-supplied parameter the user can correct directly. |

`node scan.js --help` prints the same table.

## Run a quick diagnostic scan

Runs a synchronous set of built-in diagnostic checks against the site. Returns an array of pass / warning / error items covering common configuration and security patterns. The call is an HTTP `POST` with an empty body; the LCID travels as a query parameter on the URL.

**Command**

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-security-scan/scripts/scan.js" \
  --quick \
  --portalId <guid> \
  --lcid <integer>
```

**Read or write**: read (no state change).

**Parameters**

| Flag | Kind | Type | Required | Default | Validation |
|---|---|---|---|---|---|
| `--quick` | mode selector | flag | yes | — | must be present |
| `--portalId` | path value | GUID string | yes | — | non-empty |
| `--lcid` | query value | integer (sent as string) | yes | — | Microsoft Locale ID (e.g. `1033` for en-US) — controls the language of the diagnostic messages. Missing or malformed value returns `A010`. |

**Response**

HTTP `200 OK` with a JSON array. Each item:
```json
{
  "issue": "<issue title>",
  "category": "<category name>",
  "result": "<Pass|Error|Warning|Information>",
  "description": "<detailed explanation>",
  "learnMoreUrl": "<documentation URL>"
}
```

Items are camelCase. Diagnostic items whose test did not run are filtered out server-side and are not included in the array.

**Errors**: `A001` (portal not found, HTTP 404), `A010` (invalid input — includes missing / bad LCID and malformed portal id, HTTP 400), `A033` (tenant mismatch, HTTP 400 — exit 6, not exit 1), `A019` (portal id not a GUID, HTTP 400 — exit 6, not exit 1), `A009` (HTTP 500). 401 Unauthorized when the caller is not one of: portal owner, environment system administrator, environment system customizer, Microsoft 365 admin, Power Platform service admin, Dynamics 365 service admin.

## Start a deep scan

Kicks off an asynchronous OWASP-based dynamic scan against the site's public surface. The service accepts the request immediately (HTTP `202 Accepted` with no body and no `Operation-Location` / `Retry-After` headers); the scan runs server-side for an extended period and the user is notified by email on completion.

The HTTP call is a `POST` with no request body. The service also accepts an optional `{ "username": "<user>", "password": "<pass>" }` JSON body for authenticated scans — this script intentionally never sends it. Credentials on argv leak through process listings; for authenticated-page coverage, use Power Pages Studio.

**Command**

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-security-scan/scripts/scan.js" \
  --deep \
  --portalId <guid> \
  [--dry-run]
```

**Read or write**: write, async.

**Parameters**

| Flag | Kind | Type | Required | Default | Validation |
|---|---|---|---|---|---|
| `--deep` | mode selector | flag | yes | — | must be present |
| `--portalId` | path value | GUID string | yes | — | non-empty |
| `--dry-run` | safety flag | flag | no | off | validates locally, prints the intended call, does not contact the service |

**Response**

HTTP `202 Accepted` with an empty body and no `Operation-Location` or `Retry-After` headers. On acceptance, the script emits the plugin's async-handoff shape:
```json
{
  "accepted": true,
  "operation_location": null,
  "retry_after_seconds": 60,
  "poll_command": "scan.js --ongoing --portalId <guid>"
}
```

`operation_location` is `null` because the service does not emit a service-side poll URL for deep-scan start. The caller polls via `poll_command` (the skill's `--ongoing` mode) after waiting at least `retry_after_seconds` seconds; the 60-second default matches the plugin-wide admin-API poll cadence and is declared as `DEEP_SCAN_DEFAULT_RETRY_AFTER_SECONDS` in `scan.js`.

If a scan is already running on the site, the service returns HTTP `204 No Content` with a `Z003` envelope and the same async-handoff fields are emitted by the script along with an `alreadyOngoing` flag so the caller can distinguish "just started" from "already in flight":
```json
{
  "accepted": false,
  "alreadyOngoing": true,
  "operation_location": null,
  "retry_after_seconds": 60,
  "poll_command": "scan.js --ongoing --portalId <guid>"
}
```

**Errors**: `A001` (portal not found, HTTP 404), `Z003` (already ongoing — surfaces as HTTP 204 No Content with the standard error envelope; the script maps this to exit 4, distinct from transport failures), `A010` (invalid input — e.g., malformed portal id, HTTP 400), `A033` (tenant mismatch, HTTP 400 — exit 6, not exit 1), `A019` (portal id not a GUID, HTTP 400 — exit 6, not exit 1), `A009` (HTTP 500). Same caller-role requirement as `--quick`; 401 Unauthorized otherwise.

## Is a deep scan ongoing?

Returns a boolean — whether a deep scan is currently running for the site.

**Command**

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-security-scan/scripts/scan.js" \
  --ongoing \
  --portalId <guid>
```

**Read or write**: read (HTTP `GET`).

**Parameters**

| Flag | Kind | Type | Required | Default | Validation |
|---|---|---|---|---|---|
| `--ongoing` | mode selector | flag | yes | — | must be present |
| `--portalId` | path value | GUID string | yes | — | non-empty |

**Response**

Service-side: HTTP `200 OK` with `{ "status": <boolean> }` (service returns; script unwraps to naked boolean). The CLI emits a naked JSON boolean on stdout:

```json
true
```

or

```json
false
```

**Errors**: `A001` (HTTP 404), `A010` (HTTP 400), `A033` (HTTP 400 — exit 6, not exit 1), `A019` (HTTP 400 — exit 6, not exit 1), `A009` (HTTP 500), transport failures. Same caller-role requirement as the other scan endpoints; 401 Unauthorized otherwise.

## Fetch the latest completed deep-scan report

Returns the structured report from the most recently completed deep scan.

**Command**

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-security-scan/scripts/scan.js" \
  --report \
  --portalId <guid>
```

**Read or write**: read (HTTP `GET`).

**Parameters**

| Flag | Kind | Type | Required | Default | Validation |
|---|---|---|---|---|---|
| `--report` | mode selector | flag | yes | — | must be present |
| `--portalId` | path value | GUID string | yes | — | non-empty |

**Response**

HTTP `200 OK` with the report object — see [response shape — deep scan report](#response-shape--deep-scan-report).

If a scan is currently running, the service refuses with HTTP `204 No Content` + `Z003` → exit 4 (the running scan needs to finish first). If no deep scan has ever completed on this site, the service returns HTTP `500` + `A009` → exit 1 (the site has no report to fetch — run `--deep` first).

**Errors**: `A001` (HTTP 404), `A010` (HTTP 400), `Z003` (HTTP 204 No Content with standard envelope), `A033` (HTTP 400 — exit 6, not exit 1), `A019` (HTTP 400 — exit 6, not exit 1), `A009` (HTTP 500 — also covers "no completed scan exists yet"). Same caller-role requirement as the other scan endpoints; 401 Unauthorized otherwise.

## Fetch the security score

Returns the raw score pair from the latest completed deep scan.

**Command**

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-security-scan/scripts/scan.js" \
  --score \
  --portalId <guid>
```

**Read or write**: read (HTTP `GET`).

**Parameters**

| Flag | Kind | Type | Required | Default | Validation |
|---|---|---|---|---|---|
| `--score` | mode selector | flag | yes | — | must be present |
| `--portalId` | path value | GUID string | yes | — | non-empty |

**Response**

HTTP `200 OK` with:
```json
{
  "totalRules": 42,
  "succeededRules": 38
}
```

`totalRules` is the count of rules evaluated by the most recent scan; `succeededRules` is how many passed. No percentage, letter grade, or composite score is computed by the service — the caller derives whatever representation they want.

Same refusal behavior as `--report` when a scan is in progress (HTTP 204 `Z003`) or when no completed scan exists yet (HTTP 500 `A009`).

**Errors**: `A001` (HTTP 404), `A010` (HTTP 400), `Z003` (HTTP 204 No Content with standard envelope), `A033` (HTTP 400 — exit 6, not exit 1), `A019` (HTTP 400 — exit 6, not exit 1), `A009` (HTTP 500 — also covers "no completed scan exists yet"). Same caller-role requirement as the other scan endpoints; 401 Unauthorized otherwise.

## Response shape — quick scan items

Each element of the `--quick` response array (camelCase):

| Field | Type | Notes |
|---|---|---|
| `issue` | string | Human-readable issue title. |
| `category` | string | Category classification (configuration, security, etc.). |
| `result` | enum string | One of `Pass`, `Error`, `Warning`, `Information`. |
| `description` | string | Detailed explanation of the finding. |
| `learnMoreUrl` | string | Documentation URL for deeper context. |

Items whose test did not run are filtered out server-side before the response is returned.

## Response shape — deep scan report

The `--report` response is a structured object (PascalCase — note the case difference from the quick-scan items):

| Field | Type | Notes |
|---|---|---|
| `TotalRuleCount` | integer | Number of security rules the scan evaluated. |
| `FailedRuleCount` | integer | Count of rules that reported one or more alerts. |
| `TotalAlertCount` | integer | Total alert findings across all failed rules. |
| `UserName` | string | Username of the account that started the scan. |
| `StartTime` | string (date-time) | ISO 8601 timestamp when the scan started. |
| `EndTime` | string (date-time) | ISO 8601 timestamp when the scan finished. |
| `Rules` | array | Grouped list — one entry per evaluated rule. |

Each entry in `Rules`:

| Field | Type | Notes |
|---|---|---|
| `RuleId` | string | Identifier of the underlying scanner rule. |
| `RuleName` | string | Human-readable rule name. |
| `RuleStatus` | string | Status value (e.g. `RulePassed`, `RuleFailed`, `RuleNotRun`, `RuleTimedOut`). |
| `AlertsCount` | integer | Number of alerts raised under this rule (0 when the rule passed). |
| `Alerts` | array | Per-alert detail (populated only when `AlertsCount > 0`). |

Each entry in `Alerts`:

| Field | Type | Notes |
|---|---|---|
| `AlertId` | string | Alert identifier. |
| `AlertName` | string | Human-readable alert name. |
| `Description` | string | What was detected. |
| `Mitigation` | string | Recommended remediation. |
| `Risk` | integer | Risk rank (`0`=Informational, `1`=Low, `2`=Medium, `3`=High). |
| `RuleId` | string | Back-reference to the parent rule. |
| `LearnMoreLink` | string[] | Documentation URLs. |
| `CallToAction` | string[] | Suggested remediation actions (e.g. `EnableWAF`, `DisableCustomError`). May be absent. |

The exact key names and shape follow what the service returns — if a field is absent for a given scan, treat it as unset rather than throwing.
