# Web Application Firewall commands

Per-command spec for the six commands shipped with this skill. `SKILL.md` decides when to call them; this file is how to invoke each one and what each one expects.

## Contents

- [Shared exit codes](#shared-exit-codes)
- [Check WAF status](#check-waf-status)
- [List WAF rules](#list-waf-rules)
- [Enable WAF](#enable-waf) — async
- [Disable WAF](#disable-waf) — async
- [Create or update WAF rules](#create-or-update-waf-rules) — sync, body
- [Delete custom WAF rules by name](#delete-custom-waf-rules-by-name) — async, body
- [Body schema — custom rules](#body-schema--custom-rules)
- [Body schema — managed rules](#body-schema--managed-rules)
- [Body schema — names file for delete](#body-schema--names-file-for-delete)

## Shared exit codes

Every command in this skill uses the same exit-code space.

| Code | Meaning |
|---|---|
| `0` | Success. Parse stdout for the result. |
| `1` | Unknown or transport failure (after automatic retries). Includes `HTTP 401 / 403` for callers who lack the required role. |
| `2` | Invalid or missing CLI arguments, invalid body file contents, or body rejected by the service with `A010` (schema validation failure). |
| `3` | Portal not found (`A001`). |
| `4` | Edge infrastructure not provisioned for this site (`B001`). Not a self-service fix. |
| `5` | Another WAF enable/disable operation is already in progress (`B003`). Poll `--status` and retry once it settles. |
| `6` | WAF not available in this region (`B022`). Not a self-service fix. |
| `7` | Trial portal — WAF only supported on production sites (`B023`). User must convert to production. |
| `8` | Caller-config issue — portal id is not a valid GUID (`A019`) or the authenticated caller's tenant does not match the site's tenant (`A033`). Distinct from exit `2` (which covers local CLI-arg errors and `A010` body-schema rejects). |

`node waf.js --help` prints the same table.

## Check WAF status

Returns the current WAF state for the site, or `null` when WAF is not applicable (trial portal or region-blocked).

**Command**

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-web-application-firewall/scripts/waf.js" \
  --status \
  --portalId <guid>
```

**Read or write**: read.

**Parameters**

| Flag | Kind | Type | Required | Default | Validation |
|---|---|---|---|---|---|
| `--status` | mode selector | flag | yes | — | must be present |
| `--portalId` | path value | GUID string | yes | — | non-empty; format not deep-checked locally |

**Response**

On success, a JSON **string** with the current provisioning state. Possible values:

| Value | Meaning |
|---|---|
| `Created` | WAF is enabled and provisioned. |
| `Creating` | Enable operation is still running. |
| `Deleting` | Disable operation is still running. |
| `CreationFailed` | Most recent enable failed. |
| `DeletionFailed` | Most recent disable failed. |
| `None` | WAF has never been enabled on this site, or is fully removed. |

Returns `null` when WAF is not applicable to this site. The service returns a plain-text (non-JSON) body for the region-blocked / trial-portal 400 paths; the command detects those and normalizes to `null`.

**Errors**: `A001` (portal not found, exit `3`), `A019` (portal id not a GUID, exit `8`), `A033` (tenant mismatch, exit `8`), other codes from the shared catalogue.

## List WAF rules

Returns the current rule configuration — custom rules and managed-rule overrides.

**Command**

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-web-application-firewall/scripts/waf.js" \
  --rules \
  --portalId <guid> \
  [--ruleType <Custom|Managed>]
```

**Read or write**: read.

**Parameters**

| Flag | Kind | Type | Required | Default | Validation |
|---|---|---|---|---|---|
| `--rules` | mode selector | flag | yes | — | must be present |
| `--portalId` | path value | GUID string | yes | — | non-empty |
| `--ruleType` | query value | enum | no | (both) | one of `Custom`, `Managed` — filters the response; omit to return both |

**Response**

The response shape depends on whether `--ruleType` is passed:

- **Without `--ruleType`** — a JSON object with both arrays:
  ```json
  {
    "ManagedRules": [ ... ],
    "CustomRules": [ ... ]
  }
  ```
  Custom rules at reserved priorities (≤10) are filtered out server-side and do not appear here.

- **`--ruleType Custom`** — a flat JSON array of custom rule objects (reserved-priority rules filtered out).
- **`--ruleType Managed`** — a flat JSON array of managed rule set definition objects. Each element carries `id`, `name`, `properties.provisioningState`, `properties.ruleSetId`, `properties.ruleSetType`, `properties.ruleSetVersion`, and `properties.ruleGroups`.

Returns `null` when WAF is not applicable (same rule as `--status`).

**Errors**: same catalogue codes as `--status`.

## Enable WAF

Starts enabling WAF on the site. Returns immediately; provisioning continues server-side.

**Command**

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-web-application-firewall/scripts/waf.js" \
  --enable \
  --portalId <guid> \
  [--dry-run]
```

**Read or write**: write, async.

**Parameters**

| Flag | Kind | Type | Required | Default | Validation |
|---|---|---|---|---|---|
| `--enable` | mode selector | flag | yes | — | must be present |
| `--portalId` | path value | GUID string | yes | — | non-empty |
| `--dry-run` | safety flag | flag | no | off | validates locally without contacting the service |

**Response**

On acceptance (`202`), a polling pointer:

```json
{
  "accepted": true,
  "operation_location": "https://...",
  "retry_after_seconds": 60
}
```

If another enable/disable operation is already in flight, the response instead is:

```json
{
  "accepted": false,
  "alreadyOngoing": true
}
```

**Errors**: `A001` (portal not found, exit `3`), `A019` / `A033` (caller-config, exit `8`), `B001` (edge infrastructure missing, exit `4`), `B003` (concurrent op — surfaced as `alreadyOngoing` whether the service returns 409 or 400+B003), `B022` (region, exit `6`), `B023` (trial, exit `7`).

## Disable WAF

Starts disabling WAF on the site. Same response and error model as `--enable`.

**Command**

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-web-application-firewall/scripts/waf.js" \
  --disable \
  --portalId <guid> \
  [--dry-run]
```

**Read or write**: write, async. See `--enable` for parameters, response, and errors.

## Create or update WAF rules

Submits a rule configuration. Custom rules carry a `name`, managed rules a `RuleSetType` + `RuleSetVersion`. Submit the full target collection in one call — partial bodies can have unpredictable effects on rules that are not mentioned.

To remove individual custom rules by name, use [`--delete-custom`](#delete-custom-waf-rules-by-name) instead — do not try to remove rules by omitting them from a `--create-rules` body.

**Command**

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-web-application-firewall/scripts/waf.js" \
  --create-rules \
  --portalId <guid> \
  --body <file> \
  [--dry-run]
```

**Read or write**: write, sync.

**Parameters**

| Flag | Kind | Type | Required | Default | Validation |
|---|---|---|---|---|---|
| `--create-rules` | mode selector | flag | yes | — | must be present |
| `--portalId` | path value | GUID string | yes | — | non-empty |
| `--body` | body file | file path | yes | — | file must exist; contents must be valid JSON with `CustomRules` and/or `ManagedRules` top-level arrays; at least one non-empty; names and priorities unique across custom rules; rate-limit windows in 1–5 |
| `--dry-run` | safety flag | flag | no | off | runs the same local validation without contacting the service |

**Body shape (top level)**

```json
{
  "CustomRules": [ ... ],
  "ManagedRules": [ ... ]
}
```

Both top-level keys are optional individually; at least one must be present and non-empty. See [custom rules schema](#body-schema--custom-rules) and [managed rules schema](#body-schema--managed-rules) for the per-rule structure.

Field names on nested objects are case-sensitive. Custom rules use `camelCase` field names (e.g., `name`, `priority`, `matchConditions`); managed rules use `PascalCase` field names (e.g., `RuleSetType`, `RuleGroupOverrides`, `Rules`).

**Response**

On success, the applied rule set as a JSON object:
```json
{ "ManagedRules": [ ... ], "CustomRules": [ ... ] }
```
`CustomRules` echoes every user-configured rule as stored (reserved-priority rules are filtered out). `ManagedRules` echoes the managed rule set definitions after the update.

**Errors**: `A001` (portal not found, or the site has no WAF policy provisioned — enable WAF first; exit `3`), `A010` (schema validation failure — surfaced locally by the command, or rejected by the service; also triggered by a custom rule with `priority` ≤ 10; exit `2`), `A019` / `A033` (caller-config, exit `8`), `B001`, `B022`, `B023`.

## Delete custom WAF rules by name

Removes the named custom rules. Returns immediately; deletion is asynchronous.

**Command**

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-web-application-firewall/scripts/waf.js" \
  --delete-custom \
  --portalId <guid> \
  --names <file> \
  [--dry-run]
```

**Read or write**: write, async.

**Parameters**

| Flag | Kind | Type | Required | Default | Validation |
|---|---|---|---|---|---|
| `--delete-custom` | mode selector | flag | yes | — | must be present |
| `--portalId` | path value | GUID string | yes | — | non-empty |
| `--names` | body file | file path | yes | — | file must exist; contents must be a non-empty JSON array of non-empty strings |
| `--dry-run` | safety flag | flag | no | off | validates the names file locally without contacting the service |

**Body shape**

See [names-file schema](#body-schema--names-file-for-delete).

**Response**

On acceptance (`202`), same shape as `--enable`:

```json
{
  "accepted": true,
  "operation_location": "https://...",
  "retry_after_seconds": 60
}
```

Note: unlike `--enable` / `--disable`, the delete endpoint only sets the polling URL header; it does not emit a service-side `Retry-After`, so `retry_after_seconds` in the output is always the script's shared 60-second default.

**Errors**: `A001` (portal not found, exit `3`), `A010` (invalid input — most commonly an attempt to delete a rule at a reserved priority ≤ 10; exit `2`), `A019` / `A033` (caller-config, exit `8`), `B001`, `B022`, `B023`.

Unknown rule names in the input do not fail the call — they are silently ignored by the service (best-effort deletion).

## Body schema — custom rules

Field names in the `CustomRules` array and the nested match condition objects are **camelCase** and case-sensitive.

Each object in the `CustomRules` array:

| Field | Type | Required | Values / notes |
|---|---|---|---|
| `name` | string | yes | Unique identifier for the rule. Used as the key for updates and deletes. Matched case-insensitively by the service. |
| `priority` | integer | yes | Evaluation order — lower values run first. Must be unique across the rule set. **Minimum value is `11`**: priorities 1–10 are reserved for platform-managed rules and the service rejects user rules at those values. |
| `enabledState` | string | no | `Enabled` (default) or `Disabled`. A Disabled rule is retained but not evaluated. |
| `ruleType` | string | yes | `MatchRule` (single evaluation) or `RateLimitRule` (threshold over a window). |
| `action` | string | yes | One of `Allow`, `Block`, `Log`, `Redirect`. |
| `matchConditions` | array of condition objects | required for `MatchRule` | See match condition schema below. |
| `rateLimitThreshold` | integer | required for `RateLimitRule` | Request count above which the action fires. Must be a positive integer. |
| `rateLimitDurationInMinutes` | integer | required for `RateLimitRule` | Window length in minutes — must be in `1..5`. |

**Match condition object**

| Field | Type | Required | Values / notes |
|---|---|---|---|
| `matchVariable` | string | yes | One of: `RemoteAddr` (original client IP, honors `X-Forwarded-For`), `SocketAddr` (direct edge-connection IP, e.g. a proxy), `RequestMethod`, `QueryString`, `PostArgs`, `RequestUri`, `RequestHeader`, `RequestBody`, `Cookies`. |
| `selector` | string | no | Key inside the chosen variable. Used with `QueryString`, `PostArgs`, `RequestHeader`, or `Cookies` to target a specific key (for example, a specific header name). Typically empty for the other variables. |
| `operator` | string | yes | One of: `Any`, `IPMatch`, `GeoMatch`, `Equal`, `Contains`, `LessThan`, `GreaterThan`, `LessThanOrEqual`, `GreaterThanOrEqual`, `BeginsWith`, `EndsWith`, `RegEx`. |
| `negateCondition` | boolean | no | Default `false`. Inverts the match result. |
| `matchValue` | array of strings | yes | Values to test against. For `GeoMatch` use ISO 3166-1 alpha-2 country codes (two-letter, uppercase). For `IPMatch` use IPs or CIDRs. Name is singular (`matchValue`), **not** `matchValues`. |
| `transforms` | array of strings | no | Pre-match transforms to apply to the extracted value (for example `Lowercase`, `Uppercase`, `Trim`, `UrlDecode`, `UrlEncode`, `RemoveNulls`). Omit when no transform is needed. |

Priority is first-match-wins. Once a rule matches, later rules are skipped. To express an allow-list pattern — "allow only these countries, block the rest" — use two rules: an allow rule listing the permitted country codes, followed by a block-all rule with a higher priority number.

## Body schema — managed rules

Field names in the `ManagedRules` array and all nested override objects are **PascalCase** and case-sensitive (in contrast with the camelCase custom rule schema above).

Each object in the `ManagedRules` array:

| Field | Type | Required | Values / notes |
|---|---|---|---|
| `RuleSetType` | string | yes | Microsoft-managed rule-set family name. Read from a `--rules --ruleType Managed` response to discover the supported value for this site. |
| `RuleSetVersion` | string | yes | Version of the rule set. Microsoft updates the set over time; version here is the baseline the site is tracking. |
| `RuleSetAction` | string | yes | Default action applied when a managed rule matches. One of `Block`, `Log`, `Redirect`. |
| `Exclusions` | array of exclusion objects | no | Rule-set-level exclusions applied to every rule in the set. See exclusion schema below. |
| `RuleGroupOverrides` | array | no | Disable or override behavior of specific rules / groups inside the set — see below. |

**Rule group override object**

| Field | Type | Required | Values / notes |
|---|---|---|---|
| `RuleGroupName` | string | yes | Group within the managed rule set. Read from `--rules --ruleType Managed` to discover valid group names. |
| `Exclusions` | array of exclusion objects | no | Exclusions applied to every rule in this group. Shape as below. |
| `Rules` | array of rule-override objects | no | Individual rule overrides inside the group. See rule override schema below. |

**Rule override object**

| Field | Type | Required | Values / notes |
|---|---|---|---|
| `RuleId` | string | yes | Managed rule id — read from `--rules --ruleType Managed` output to find the specific rule to override. |
| `EnabledState` | string | no | `Enabled` or `Disabled`. `Disabled` is the standard false-positive mitigation. |
| `Action` | string | no | Override the action for this rule specifically. One of `Allow`, `Block`, `Log`, `Redirect`. |
| `Exclusions` | array of exclusion objects | no | Exclusions scoped to this single rule. Shape as below. |

**Exclusion object** (used at any of the three levels: rule-set, rule-group, individual rule)

| Field | Type | Required | Values / notes |
|---|---|---|---|
| `matchVariable` | string | yes | Request variable to exclude from evaluation. Values such as `RequestHeaderNames`, `RequestCookieNames`, `QueryStringArgNames`, `RequestBodyPostArgNames`, etc. Field names on exclusion objects are camelCase. |
| `selectorMatchOperator` | string | yes | How `selector` is matched. Allowed values are: `Equals`, `EqualsAny`, `Contains`, `StartsWith`, `EndsWith`. |
| `selector` | string | yes | The specific name / value to exclude (for example, a header name). |

## Body schema — names file for delete

The `--names` file for `--delete-custom` must be a non-empty JSON array of strings, each a `name` of an existing custom rule:

```json
["rule-to-delete-1", "rule-to-delete-2"]
```

Unknown names do not fail the call — the service silently skips them.
