# 1DS Telemetry POC

Reference implementation proving out the approach documented in
`docs/superpowers/specs/2026-04-20-1ds-telemetry-design.md`.

**Not part of the shipping plugin.** This directory exists as an executable
reference for implementers. The real library will live at
`shared/telemetry/` per the spec.

## What this POC verifies

Run against the 1DS INTERNAL/test collector:

- `@microsoft/1ds-core-js` + `@microsoft/1ds-post-js` initialize cleanly in
  plain Node 22 (no browser polyfills required).
- A Node `fetch`-based `httpXHROverride` ports the pattern used by
  `powerplatform-vscode`'s `oneDSLogger.ts` to a Node CLI context.
- The collector accepts batched events with an `{"acc": N}` response.
- The hook scripts correctly parse the JSON Claude Code pipes on stdin and
  detect tracked power-pages skills via the existing
  `scripts/lib/powerpages-hook-utils.js` helper.
- Pre-hook writes a correlation file keyed by skill name; post-hook reads it
  and emits `skill_completed` with matching `correlation_id`.
- `core.flush()` followed by a ~3 s wait is sufficient to drain the event
  queue before the hook process exits.

## What this POC does NOT verify

- **Hook registration via marketplace install.** Under `--plugin-dir` dev
  mode, Claude Code loads skills/commands/agents but does not register the
  plugin's `hooks.json`. Final E2E verification (the Skill tool actually
  firing `PreToolUse:Skill` and `PostToolUse:Skill` hooks) requires a
  marketplace install — noted in the design spec's rollout sequence.
- **Real iKey-tenant provisioning.** The iKey for the plugin marketplace's
  own 1DS tenant must be provisioned separately; see spec §6.3.
- Consent file flow and the Phase-1 `AskUserQuestion` prompt — those live
  inside a skill body, not in hook scripts.

## Running

Requires an iKey you are authorized to emit to. Without it the scripts
no-op and log the reason to `hook-capture/error.log`.

```powershell
cd poc/1ds-telemetry
npm install
$env:POWER_PLATFORM_SKILLS_IDS_IKEY = "<your-1ds-ikey>"
node emit.js
```

Expected output: one POST to the collector, response
`status=200 body={"acc":2}`. Capture logs land under `hook-capture/`.

## Layout

```
poc/1ds-telemetry/
├── package.json                 # @microsoft/1ds-core-js, 1ds-post-js
├── emit.js                      # Standalone emitter (two sample events)
├── hook-lib.js                  # Shared init + emit + correlation helpers
├── hook-pretool.js              # PreToolUse:Skill hook — emits skill_started
├── hook-posttool.js             # PostToolUse:Skill hook — emits skill_completed
├── hook-capture/                # Diagnostic logs written by the hook scripts
│   ├── pretool-stdin.log        # raw stdin JSON received
│   ├── pretool-parsed.log       # parsed JSON + skill detection result
│   ├── posttool-stdin.log
│   ├── posttool-parsed.log
│   ├── network.log              # 1DS request/response pairs
│   ├── error.log                # swallowed failures (only created on error)
│   └── hooks.json.backup        # backup of plugin hooks.json used during POC
└── README.md
```

`node_modules/` is git-ignored.

## How this maps to the shipping implementation

| POC file | Ships as |
|---|---|
| `emit.js` | Absorbed into `shared/telemetry/lib/client.js` (init + emit wrapper). |
| `hook-lib.js` | Split into `shared/telemetry/lib/client.js`, `consent.js`, `events.js`, `session.js`. |
| `hook-pretool.js` | `plugins/power-pages/hooks/run-skill-pretool-telemetry.js`, synced from `shared/telemetry/`. |
| `hook-posttool.js` | Folded into the existing `plugins/power-pages/hooks/run-skill-posttool-validation.js` (emission after the validator). |
| `hook-capture/` | Replaced by real 1DS ingestion; no on-disk logging in the shipping version. |

## Teardown

`poc/` can be deleted once the real implementation lands at
`shared/telemetry/`. Until then, leave it here as a living reference that
implementers can run locally.
