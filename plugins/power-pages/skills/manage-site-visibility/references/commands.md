# Site visibility commands

Per-command spec for the single command shipped with this skill. `SKILL.md` decides when to call it; this file is how to invoke it.

## Contents

- [Set site visibility](#set-site-visibility)

## Set site visibility

Switch the site between Public and Private.

**Command**

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-site-visibility/scripts/site-visibility.js" \
  --setVisibility \
  --portalId <guid> \
  --value <Public|Private> \
  [--dry-run]
```

**Read or write**: write. Supports `--dry-run`, which validates the arguments locally and prints the intended call on stdout without contacting the admin API. A successful `--dry-run` does NOT imply the real call would succeed — upstream state checks only run when `--dry-run` is absent.

**Parameters**

| Flag | Kind | Type | Required | Default | Validation |
|---|---|---|---|---|---|
| `--setVisibility` | mode selector | flag | yes | — | must be present (chooses this command's operation) |
| `--portalId` | path value | GUID string | yes | — | non-empty string; format is not deep-checked locally — malformed values come back as `A001` or `A010` from the service |
| `--value` | query value | enum string | yes | — | one of `Public`, `Private` (case-sensitive); the command rejects anything else before any network call |
| `--dry-run` | safety flag | flag | no | off | when present, validates the other flags locally, prints the intended call as JSON on stdout, and exits `0` without contacting the admin API |

**Response**

On success the command prints `{ "updated": true }` to stdout and exits `0`.

**Exit codes**

| Code | Meaning |
|---|---|
| `0` | Success. |
| `1` | Unknown or transport-level failure (after automatic retries). |
| `2` | Invalid or missing CLI arguments. |
| `3` | Portal not found (`A001`). |
| `4` | Caller not authorized to flip visibility (`A037`). |
| `5` | Tenant governance policy blocks non-production → Public (`A039`). |
| `6` | Developer site — cannot be made Public; no admin can override (`D005`). |

Skills branch on the exit code and fall back to parsing the stderr message only when the exit code is `1` (unknown).

**Errors this command can surface**

| Code on stderr | HTTP | Condition |
|---|---|---|
| `A001` | 404 | Portal id not found — wrong id, site deleted, or caller's auth context is pointing at a different tenant |
| `A010` | 400 | Portal id segment is null / empty / whitespace, or `--value` was an input the service could not interpret as `public` or `private` |
| `A019` | 400 | Portal id segment is not a valid GUID |
| `A033` | 400 | Tenant id mismatch — the caller's token is for a different tenant than the resolved environment |
| `A037` | 401 | Caller is not authorized to flip visibility — change refused |
| `A039` | 400 | Non-production site blocked from going Public by tenant governance |
| `A009` | 500 | Unhandled server-side failure |
| `D005` | 400 | Developer site — visibility cannot be changed to Public on a developer environment |

Only `A001`, `A037`, `A039`, and `D005` are mapped to dedicated exit codes (`3`, `4`, `5`, `6`). The rest fall through to exit `1` with the raw stderr carrying the code and message so the caller can decide whether to retry or surface to the user.

Transport-level failures (`HTTP 4xx` or `HTTP 5xx` without a catalogued code) are surfaced verbatim in the stderr message. Transient `401 / 429 / 500 / 502 / 503` classes are retried internally (up to two retries) — by the time the command exits non-zero for one of them, retry has already failed.
