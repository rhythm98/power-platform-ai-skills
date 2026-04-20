# 1DS Telemetry Infrastructure — Design Spec

**Date:** 2026-04-20
**Status:** Draft — pending implementation plan
**Scope:** Add Microsoft 1DS (One Data Strategy) telemetry to the `power-platform-skills` plugin marketplace, wired into the `power-pages` plugin as the first consumer. A shared library under `shared/telemetry/` is the canonical source; other plugins adopt by running a sync script.

---

## 1. Goals and Non-Goals

### Goals

- Emit Microsoft 1DS telemetry events for skill lifecycle and Node script outcomes in the `power-pages` plugin.
- Establish a shared telemetry library at `shared/telemetry/` that additional plugins (`canvas-apps`, `code-apps`, `mcp-apps`, `model-apps`) can adopt without redesign.
- Respect user consent via an interactive first-run prompt; never emit without consent.
- Send only a strict allowlist of fields — no paths, inputs, IDs, or error messages.
- Fail closed: telemetry code never blocks or breaks a skill run.

### Non-Goals

- Wiring telemetry into the four non-`power-pages` plugins in this pass (they adopt later via the sync script).
- Instrumenting Dataverse HTTP calls individually (event volume too high for an initial rollout).
- Persisting events to disk when offline (no local queue; dropped events are acceptable).
- Automating `npm install` for the telemetry dependencies (surfaced as a one-time notice; not auto-executed).

---

## 2. Architectural Overview

### 2.1 Repository layout

The canonical source lives at `shared/telemetry/`. A sync script copies it into each adopting plugin. Only the synced copy under `plugins/<plugin>/scripts/lib/telemetry/` runs at user time; the `shared/` directory is development-time only (not shipped to users via the marketplace).

```
shared/telemetry/
├── README.md                          # Purpose, data sent, sync instructions
├── package.json                       # @microsoft/1ds-core-js, 1ds-post-js
├── ikey.json                          # Hardcoded iKey + OneCollector URL
├── sync-to-plugin.js                  # Copies lib/ + ikey.json + package.json into a plugin
├── lib/
│   ├── client.js                      # 1DS SDK init + emit() wrapper
│   ├── consent.js                     # Read/write ~/.power-platform-skills/telemetry.json
│   ├── events.js                      # Event builders with strict allowlists
│   ├── session.js                     # Per-process anonymized UUID
│   ├── scrubber.js                    # No-op placeholder for future PII regex
│   ├── check-consent.js               # CLI: stdout "NEEDS_PROMPT" | "ENABLED" | "DISABLED"
│   ├── record-consent.js              # CLI: --answer yes|no writes the consent file
│   └── with-telemetry.js              # Wrapper for plugin Node scripts

plugins/power-pages/
├── scripts/lib/telemetry/             # Synced copy of shared/telemetry/lib + ikey.json + package.json
│                                      # Tracked in git; do NOT hand-edit
├── hooks/
│   ├── hooks.json                     # Adds PreToolUse:Skill; keeps existing PostToolUse:Skill
│   ├── run-skill-pretool-telemetry.js # New: emits skill_started
│   └── run-skill-posttool-validation.js  # Existing; extended to emit skill_completed after validator
└── references/
    └── telemetry-consent-reference.md # Shared Phase-1 pointer doc every SKILL.md includes
```

### 2.2 Runtime components

1. **Consent gate** (`lib/consent.js`) — Reads `~/.power-platform-skills/telemetry.json`. Hooks read this synchronously; if missing or `enabled: false`, they exit 0 silently. The interactive prompt runs inside a skill's Phase 1 (hooks cannot invoke `AskUserQuestion`).
2. **Client** (`lib/client.js`) — Lazy-initialized 1DS post channel. Loads `ikey.json` and the `@microsoft/1ds-*` SDK. If `node_modules` is missing, returns a no-op emitter and writes a one-time `npm install --prefix ...` notice to stderr.
3. **Emitters** — Two hook scripts (`run-skill-pretool-telemetry.js`, existing `run-skill-posttool-validation.js`) and a `withTelemetry(scriptName, asyncFn)` wrapper for instrumenting individual Node scripts.
4. **Event builders** (`lib/events.js`) — Pure functions per event type that accept raw input and return a payload containing only allowlisted fields. `client.emit()` accepts nothing else; a test enforces this.

### 2.3 Data flow for one skill run

```
User invokes /create-site
      │
      ▼
Skill Phase 1 runs:
  1. Existing plugin-version check (unchanged).
  2. New: node check-consent.js
       - outputs "ENABLED"      → continue
       - outputs "DISABLED"     → continue (hooks will no-op)
       - outputs "NEEDS_PROMPT" → AskUserQuestion; then
                                  node record-consent.js --answer yes|no
      │
      ▼
Claude invokes Skill tool
      │
      ├─► PreToolUse:Skill hook
      │     run-skill-pretool-telemetry.js
      │     → emit skill_started {plugin, plugin_version, skill, session_id,
      │                           correlation_id, os_family, node_version}
      │
      ▼
Skill body runs. Instrumented Node scripts wrap their main() in withTelemetry()
  → emit script_started / script_completed
      │
      ├─► PostToolUse:Skill hook
      │     run-skill-posttool-validation.js
      │     1. Runs existing per-skill validator (unchanged).
      │     2. Emits skill_completed {outcome, duration_ms, error_class, correlation_id,
      │                                common envelope fields}
      │        outcome = "success" if validator exit 0, "failure" otherwise.
      │     3. Exits with the validator's status code (telemetry does not change it).
```

---

## 3. Event Schema

All events use the 1DS Common Schema 4.0 envelope. Custom per-event fields live under the envelope's `data` property.

### 3.1 Fields common to every event (allowlisted)

| Field | Source | Example |
|---|---|---|
| `plugin_name` | `plugins/power-pages/.claude-plugin/plugin.json` | `"power-pages"` |
| `plugin_version` | same | `"1.2.2"` |
| `session_id` | random UUIDv4 generated once per Node process (not persisted) | `"f7c2..."` |
| `os_family` | `process.platform` | `"win32"`, `"darwin"`, `"linux"` |
| `node_version` | `process.versions.node` → major only | `"v22"` |
| `correlation_id` | random UUIDv4 per skill or script invocation | `"a3e1..."` |

### 3.2 Event-specific fields

| Event | Additional fields |
|---|---|
| `skill_started` | `skill_name` |
| `skill_completed` | `skill_name`, `outcome` (`"success"` or `"failure"`), `duration_ms` (number), `error_class` (constructor name or `""`) |
| `script_started` | `script_name` (explicit string arg to `withTelemetry`) |
| `script_completed` | `script_name`, `outcome`, `duration_ms`, `error_class` |

### 3.3 Fields explicitly never sent

- `cwd`, absolute file paths
- Environment variables (except the telemetry consent flag, and only as a boolean)
- Tenant IDs, site names, site URLs, Dataverse org URLs
- Error `.message` strings, stack traces
- Skill arguments, tool inputs
- Usernames, email addresses, hostnames

Builders in `events.js` pick only allowlisted keys; unknown fields are dropped. A `node:test` asserts the final payload contains exactly the expected keyset for every event type.

---

## 4. Consent Flow

### 4.1 Consent file

Location: `~/.power-platform-skills/telemetry.json`

```json
{
  "version": 1,
  "enabled": true,
  "consented_at": "2026-04-20T18:04:00Z",
  "prompt_version": 1
}
```

- `version` — Schema version. A bump (e.g., to `2`) forces re-prompt on the next skill run.
- `prompt_version` — Version of the consent prompt text. Bump to force re-prompt (e.g., when the privacy statement URL changes).
- `enabled` — Boolean. Only `true` permits emission.
- `consented_at` — ISO 8601 timestamp.

A malformed or unreadable file is treated as "absent" → prompt again.

### 4.2 Prompt

The prompt is declared once in `shared/telemetry/references/telemetry-consent-reference.md` (synced into each plugin's `references/`). Every tracked SKILL.md adds this one-liner in Phase 1, immediately after the existing plugin-version check:

```markdown
> **Telemetry consent**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/telemetry/check-consent.js"` —
> if it outputs `NEEDS_PROMPT`, use AskUserQuestion to ask the user per
> `${CLAUDE_PLUGIN_ROOT}/references/telemetry-consent-reference.md` and then run
> `node "${CLAUDE_PLUGIN_ROOT}/scripts/lib/telemetry/record-consent.js" --answer yes|no`.
```

The AskUserQuestion payload (defined once in the reference doc):

- **Question:** "Share anonymous usage telemetry with Microsoft?"
- **Body:** "The power-pages plugin can send anonymous usage signals (skill name, success/failure, duration, OS family, plugin version) to Microsoft to help improve these tools. No paths, inputs, tenant data, or error messages are sent. The full field list is at `shared/telemetry/README.md` in the repo. Your answer is saved at `~/.power-platform-skills/telemetry.json`; edit that file any time to change it."
- **Options:**
  - `"Yes, enable telemetry"`
  - `"No, keep it off"`

### 4.3 Override

- `POWER_PLATFORM_SKILLS_TELEMETRY=0` — Disables emission regardless of the file. Checked by the client on every emit.
- Any other value (including `1`, unset, empty) — No effect. Emission is governed entirely by the consent file. The env var is a one-way off switch only; it cannot enable telemetry that the user has not explicitly consented to via the file.

### 4.4 Hook behavior when consent is absent

Both hooks exit 0 silently. No stderr noise (gate debug output behind `process.env.DEBUG`, matching the existing `run-skill-posttool-validation.js` convention). The prompt runs exclusively inside the skill body.

**Consequence:** the *very first* skill invocation on a fresh machine emits no events — the consent prompt happens during that run. Every subsequent run emits normally.

---

## 5. Hook Wiring

### 5.1 `plugins/power-pages/hooks/hooks.json` (new contents)

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Skill",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/run-skill-pretool-telemetry.js\"",
            "timeout": 30
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Skill",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/run-skill-posttool-validation.js\"",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

### 5.2 `run-skill-pretool-telemetry.js` (new)

Reads `tool_input`, calls `getTrackedSkillFromToolInput()` (existing helper), gates on consent, emits `skill_started` with a fresh `correlation_id` that is cached to a short-lived temp file keyed by skill name + session so the PostToolUse hook can correlate. Always exits 0.

### 5.3 `run-skill-posttool-validation.js` (extended)

The existing validator flow is preserved byte-for-byte. A new block runs *after* the validator:

```js
const outcome = validatorStatus === 0 ? 'success' : 'failure';
const duration_ms = Date.now() - startTs;
const errorClass = ''; // PostToolUse does not carry thrown-error info
emit(buildSkillCompletedEvent({ skill_name, outcome, duration_ms, error_class: errorClass, correlation_id }));
process.exit(validatorStatus ?? 0);
```

Telemetry emission never changes the validator's exit code.

### 5.4 `withTelemetry(scriptName, asyncFn)` (new)

Consumed from inside plugin scripts:

```js
const { withTelemetry } = require('./lib/telemetry/with-telemetry');

async function main() { /* existing script body */ }

if (require.main === module) {
  withTelemetry('deploy-site', main).catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
```

`withTelemetry` emits `script_started`, awaits `asyncFn()`, then emits `script_completed` with the computed outcome. It rethrows the original error unchanged so existing error handling is preserved.

**Initial scripts to instrument** (chosen for signal value):

- `scripts/deploy-site.js` *(if present — verify during implementation)*
- `scripts/check-activation-status.js`
- `scripts/verify-dataverse-access.js`
- `scripts/render-audit-report.js`
- Each validator under `scripts/`

Low-value scripts (`generate-uuid.js`, template renderers) are not instrumented.

---

## 6. Dependencies and Install

### 6.1 `shared/telemetry/package.json`

```json
{
  "name": "@power-platform-skills/telemetry",
  "version": "0.1.0",
  "private": true,
  "dependencies": {
    "@microsoft/1ds-core-js": "^3.2.0",
    "@microsoft/1ds-post-js": "^3.2.0"
  }
}
```

Exact version pins are resolved during implementation against the currently published versions. Versions are synced into each plugin's copy.

### 6.2 Install story

Users run `npm install --prefix plugins/power-pages/scripts/lib/telemetry` once. This is documented in:

- `plugins/power-pages/AGENTS.md` (Key Conventions section)
- `plugins/power-pages/CLAUDE.md` (same content, symlinked)
- The consent prompt body (see §4.2)
- The root `README.md` setup section

The client fails closed on missing `node_modules`, so forgetting this step drops events but never breaks a skill.

### 6.3 iKey provisioning

`shared/telemetry/ikey.json`:

```json
{
  "ikey": "<32-char-iKey-provisioned-via-1DS-tenant>",
  "collector_url": "https://self.events.data.microsoft.com/OneCollector/1.0"
}
```

The iKey is committed in plaintext (Microsoft OSS precedent: VS Code, dotnet SDK, Azure CLI). It is a write-only identifier, not a secret. The tenant token and iKey must be provisioned through whichever Microsoft 1DS tenant owns this data before the first commit that populates `ikey.json`. Until then, a placeholder causes the client to no-op (client validates the iKey format at init).

---

## 7. Failure Modes

All failure paths exit cleanly and never break the user's skill run.

| Failure | Behavior |
|---|---|
| Consent file missing | Hook exits 0 silently. Skill Phase 1 triggers prompt. |
| Consent file `enabled: false` | Hook exits 0 silently. |
| `POWER_PLATFORM_SKILLS_TELEMETRY=0` | Hook exits 0 silently. |
| Consent file malformed | Treated as missing → re-prompt. |
| `node_modules` missing | Client returns no-op; one-time stderr notice with `npm install --prefix` command. Hook exits 0. |
| `ikey.json` missing or placeholder | Client returns no-op; no stderr output. |
| 1DS POST fails, times out, or network unreachable | Fire-and-forget 2s timeout; errors swallowed; no retries; no on-disk queue. |
| Event builder receives unexpected field | Dropped silently; caught by `node:test` in CI, not at runtime. |
| Hook script throws | Top-level catch-all → `process.exit(0)`. |
| Validator throws in PostToolUse | Telemetry still emits with `outcome: "failure"`; validator exit code is preserved. |

**Non-negotiable rule:** telemetry code cannot raise a visible error. Enforced by `telemetry-hook-pretool.test.js` and `telemetry-hook-posttool.test.js`, which inject throws at every mockable seam and assert `exit(0)`.

---

## 8. Testing

### 8.1 Layout

Mirrors the existing `scripts/tests/` convention (node:test, PowerShell runner, zero external deps):

```
shared/telemetry/tests/                # Canonical tests
plugins/power-pages/scripts/tests/     # Synced copy (by sync-to-plugin.js)
  ├── telemetry-client.test.js
  ├── telemetry-consent.test.js
  ├── telemetry-events.test.js
  ├── telemetry-session.test.js
  ├── telemetry-with-telemetry.test.js
  ├── telemetry-hook-pretool.test.js
  └── telemetry-hook-posttool.test.js
```

Both directories are committed and both are run in CI.

### 8.2 Assertions per file

- **client** — no-op when deps missing; no-op when consent disabled; respects env override; respects placeholder iKey.
- **consent** — read/write round-trip; malformed file → treated as absent; version bump forces re-prompt; prompt_version bump forces re-prompt; default path under `~/.power-platform-skills/`.
- **events** — each builder returns exactly the allowlisted keyset; unknown input keys dropped; `error_class` is the constructor name, never a message; `duration_ms` is a non-negative integer.
- **session** — stable within a process; unique across processes.
- **with-telemetry** — success path emits both events; rejection path emits completed with `outcome: "failure"` and rethrows the original error.
- **hooks** — happy path emits; missing consent emits nothing; throws at each seam → `exit(0)`.

### 8.3 Live end-to-end test

`tests/live-1ds-post.test.js`, skipped unless `RUN_1DS_LIVE_TEST=1`. Posts one synthetic event using the real iKey and asserts a 200 response. Not run in CI by default to avoid polluting production telemetry.

---

## 9. Rollout Sequence

1. Land `shared/telemetry/` (library, `package.json`, `ikey.json` placeholder, sync script, tests). No plugin wiring yet.
2. Run `node shared/telemetry/sync-to-plugin.js --target plugins/power-pages` to populate the synced copy. Commit the synced files.
3. Add `plugins/power-pages/hooks/run-skill-pretool-telemetry.js` and update `plugins/power-pages/hooks/hooks.json` to register the PreToolUse:Skill entry.
4. Extend `plugins/power-pages/hooks/run-skill-posttool-validation.js` to emit `skill_completed` after the validator.
5. Add `plugins/power-pages/references/telemetry-consent-reference.md` (synced).
6. Add the Phase-1 one-liner to every tracked SKILL.md (per the list in `scripts/lib/powerpages-hook-utils.js`).
7. Wrap the chosen high-value scripts (§5.4) in `withTelemetry(...)`.
8. Update `plugins/power-pages/AGENTS.md`, root `AGENTS.md`, and `README.md` with telemetry conventions, the `npm install --prefix` command, and a link to `shared/telemetry/README.md`.
9. Provision the real iKey through the 1DS tenant and replace the placeholder in `ikey.json`.
10. Manual smoke test: fresh machine, run `/create-site`, observe the consent prompt, confirm "Yes", re-run, confirm an event reaches the 1DS collector (via the live test or tenant dashboard).

---

## 10. Open Implementation Details (resolved during planning)

- Exact `@microsoft/1ds-core-js` and `@microsoft/1ds-post-js` version pins — check npm at implementation time.
- The mechanism for passing `correlation_id` from PreToolUse to PostToolUse (candidates: a short-lived temp file keyed by PID + skill name, or re-generating per hook and relying on `session_id` + `skill_name` + timestamp for correlation on the ingest side). Defaults to the temp-file approach unless the plan phase finds a cleaner option.
- Verification that `process.stdin` JSON received by the hooks contains enough data to identify the skill (the existing `getTrackedSkillFromToolInput` usage confirms it does).
- Whether `plugins/power-pages/scripts/lib/telemetry/node_modules/` should be `.gitignore`d (yes; the install step is a user-run prerequisite, not a committed artifact).

---

## 11. Out of Scope (future work)

- Rolling the shared library out to `canvas-apps`, `code-apps`, `mcp-apps`, `model-apps` (each is a run of `sync-to-plugin.js` plus per-plugin hook wiring).
- Dataverse API-call–level telemetry.
- Richer error-class taxonomy (HTTP status codes, known error kinds from `validation-helpers.js`).
- A local event queue for offline runs.
- An `opt-in` consent posture; today's posture is interactive-first-run per the brainstorm.
