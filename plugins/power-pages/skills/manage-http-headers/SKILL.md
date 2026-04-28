---
name: manage-http-headers
description: >-
  Manages HTTP security headers for a Power Pages site — Content Security
  Policy (CSP) including nonce handling and report-only mode, CORS
  headers, SameSite cookie policy, X-Frame-Options, Referrer-Policy,
  Permissions-Policy, and the other headers the Power Pages runtime
  reads from site settings. Discovers external URLs referenced in
  project HTML, CSS, and JavaScript and proposes a CSP allowlist that
  includes the Power-Pages-runtime sources a working site needs. Use
  when the user mentions security headers, CSP, content security
  policy, allowlist, blocked fonts or scripts, render issues after a
  policy change, CORS, cross-origin, preflight failure, SameSite
  cookies, iframe embedding, clickjacking, or wants a header audit —
  even if they do not use the exact phrase "security header" or name
  the specific header. Out of scope: `Strict-Transport-Security` and
  `Cache-Control` (Power-Pages-managed).
user-invocable: true
argument-hint: "[optional: audit, csp, cors, samesite]"
allowed-tools: Read, Write, Bash, Glob, Grep, AskUserQuestion, TaskCreate, TaskUpdate, TaskList
model: opus
---

> **Plugin check**: Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.js"` — if it outputs a message, show it to the user before proceeding.

# Security Headers

Configure HTTP security headers for a Power Pages site by writing site-setting YAML files that `/deploy-site` pushes to Dataverse. The Power Pages runtime reads these settings per-request and emits the corresponding headers on responses. This skill covers:

- **Audit** — read the current `HTTP/*` site-settings and categorize them (known, custom, missing).
- **Plan a change** — based on user intent, compose a new or updated setting. For CSP specifically, scan the project for external URLs and propose an allowlist that covers both the site's own code and the Power-Pages-runtime sources a working site needs.
- **Apply** — write or update the YAML file. Deployment happens downstream via `/deploy-site`; this skill stops at the file write.

## When to load which reference

- `references/headers.md` — load when the user asks about a specific header (what it does, accepted values, site-setting name), when planning CSP directives, when configuring CORS (especially `Allow-Credentials` and wildcard-Origin quirks), or when the agent needs the list of Power-Pages-runtime sources a CSP must allow.

## Gotchas

- **HSTS and Cache-Control are Power-Pages-managed.** Writing `HTTP/Strict-Transport-Security` is rejected with exit code `3`; do not work around it.
- **No value validation.** The runtime passes header values through verbatim — malformed CSP or CORS strings silently produce broken headers. Use `--dry-run` on `http-headers.js` to catch local YAML / name issues, but the value itself is the author's responsibility.
- **CSP is pass-through, not merged.** The runtime does NOT add Power-Pages-runtime sources automatically to your CSP. If your policy omits the runtime's `content.powerapps.*` sources, runtime resources fail to load and parts of the site will not render. Use `scan-external-urls.js` to get the full allowlist, including the runtime dependencies.
- **Use the `'nonce'` keyword in `script-src`, not `'unsafe-inline'`, for inline scripts.** The runtime replaces `'nonce'` with a per-request random value and auto-injects hashes for inline event handlers. Removing `'nonce'` from the directive silently disables that mechanism.
- **`Inject-unsafe-eval` is a site-setting, not a header.** Its name is `HTTP/Content-Security-Policy/Inject-unsafe-eval`, value `true` or `false` (default true). When true and `'nonce'` is present, the runtime auto-injects `'unsafe-eval'` into `script-src`. Set to `false` only if you are sure your site works without it — many Power-Pages-runtime components require it.
- **Report-Only is a separate site-setting**, not a flag on the main CSP setting. Name: `HTTP/Content-Security-Policy-Report-Only`. You can run both at once — the standard iteration path is: start with report-only, review browser-console violations, add sources incrementally to the enforcing policy, then delete the report-only setting.
- **CORS `Allow-Credentials` only accepts `true`.** There is no `false` value — to disable credentials, omit the setting entirely. Writing `false` produces an invalid header that browsers ignore for credentialed requests.
- **CORS `Allow-Origin: *` is auto-specialized.** The runtime replaces `*` with the specific requesting Origin on each response. This means `*` behaves like "reflect the Origin", not like a public wildcard — important for CDN / cache design.
- **A site-setting change triggers a soft restart.** After `/deploy-site` writes the change to Dataverse, header changes take effect once the restart propagates — there may be a brief delay. Verify after a short wait in an incognito browser tab or with curl.
- **Maker-mode traffic bypasses all `HTTP/*` headers entirely.** Requests from Power Pages Studio or other detected maker tools skip header emission. Viewing the site through maker tools won't show your headers — verify with an incognito browser tab or curl.
- **`--audit` marks non-catalogue names as `custom`.** The runtime emits any `HTTP/*` site-setting it finds, including names outside the recognized catalogue — so typos become real (broken) headers on the wire. The `custom` marker is the author's cue to confirm the name was intentional.

## Workflow

At the start of Phase 1, create one task per phase with `TaskCreate`. Mark `in_progress` when you enter a phase and `completed` the moment it ends — do not batch updates. The final response carries a progress tracking table (see the end of this file) so the user can see at-a-glance what each phase produced.

### Phase 1 — Prerequisites

1. Confirm the working directory is a Power Pages code site by locating `.powerpages-site/website.yml`. If missing, tell the user to run `/deploy-site` first and stop.
2. Confirm `.powerpages-site/site-settings/` exists. If missing, the same `/deploy-site` path will create it on the first deploy — tell the user to deploy once before running this skill.

### Phase 2 — Audit current HTTP/* site-settings

Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-http-headers/scripts/http-headers.js" \
  --audit --projectRoot "<project-root>"
```

The script returns a JSON object with three arrays:

- `present` — every `HTTP/*` site-setting currently on disk, each with its name, value, and a `custom: true` flag when the name is outside the recognized catalogue (possible typo or truly custom header).
- `missing` — recognized-catalogue names that are NOT on disk. These are headers the runtime will simply not emit.
- `forbidden` — any `HTTP/*` file that attempts to set a Power Pages-managed header (e.g., `HTTP/Strict-Transport-Security`). Flag these to the user as definitely wrong.

Summarize the current posture to the user before asking what they want to change.

### Phase 3 — Plan the change

Use `AskUserQuestion` to confirm intent. The skill supports five kinds of change:

| Change | What it does | Notes |
|---|---|---|
| Add or update a header | Any recognized `HTTP/*` setting | One-shot; Phase 4 writes the YAML |
| Configure CSP | `HTTP/Content-Security-Policy` and/or `HTTP/Content-Security-Policy-Report-Only` | Run CSP allowlist discovery first (below) |
| Configure CORS | Any `HTTP/Access-Control-*` setting | Warn about `Allow-Credentials = true` only and `Allow-Origin: *` auto-specialization |
| Configure cookie SameSite | `HTTP/SameSite/Default` or per-cookie `HTTP/SameSite/<cookie-name>` | Accepted values: `None`, `Lax`, `Strict`. See SameSite section of `headers.md` for iframe-embedding guidance. |
| Remove a setting | Delete a YAML file | Phase 4 deletes with approval |

**For any CSP change, run the allowlist discovery first.** The Power Pages runtime does NOT merge a baseline with your CSP — your directive must include both the site's own external sources AND the runtime's required sources, or runtime resources fail to load and parts of the site will not render. Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-http-headers/scripts/scan-external-urls.js" \
  --projectRoot "<project-root>"
```

The output groups discovered URLs by CSP directive (`script-src`, `style-src`, `img-src`, `font-src`, `connect-src`, `frame-src`) and includes a `runtimeDependencies` bucket with the **cloud-agnostic** Power-Pages-runtime sources every Power Pages site requires (e.g., `'self'`, `'nonce'`, `'unsafe-inline'`, `https:`, `data:`). The cloud-specific `content.powerapps.*` host for `script-src` is NOT in this bucket — the agent composes it separately in Phase 3 after detecting the site's cloud via `pac auth who`.

**Build the plan with the plan-validate-execute pattern:**

1. **Detect the site's cloud.** Run `pac auth who` and read the `Cloud` field. The `script-src` directive needs exactly one cloud-specific `content.powerapps.*` host (see the mapping table in `headers.md` → Power-Pages-runtime sources a CSP must allow). Listing all four over-allows and defeats the point of the CSP.
2. **Plan** — compose the full target CSP directive, incorporating the scan output plus the cloud-matched runtime host plus the shared runtime dependencies, and write it to a transient JSON file at the project root (for example, `csp-plan.json`). This file is working state only — Phase 6 deletes it on success.
3. **Validate** — use the scan output to sanity-check that every source the scan found is either in the CSP plan or explicitly waived. Recommended first-pass approach: start with `HTTP/Content-Security-Policy-Report-Only` (not the enforcing header), so violations surface in the browser console without blocking real users. Once report-only is clean for a few days, promote to the enforcing header.
4. **Execute** — Phase 4 writes the YAML.

### Phase 4 — Apply

For each setting to write or delete, pause with `AskUserQuestion` showing the exact command and the value you are about to write. Wait for approval. Then run it. One approval, one file operation.

Reference: `references/headers.md` for command shapes, exit codes, and header-specific guidance.

**Writing a header:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-http-headers/scripts/http-headers.js" \
  --write --projectRoot "<project-root>" \
  --name "HTTP/<Header-Name>" \
  --value "<header-value>" \
  --description "<human-readable description>" \
  [--dry-run]
```

**Required disclosures before approval**

- CSP changes: remind the user that CSP is pass-through (not merged) and confirm the planned value includes all runtime-required sources.
- CORS changes: confirm `Allow-Credentials` is either `true` or omitted (no `false`); confirm `Allow-Origin: *` behavior is understood if in use.
- Header removal: confirm the header was actually set — removing a missing setting is a no-op.
- Report-Only: remind the user this is safe to deploy first; it does NOT enforce.

**Error handling**

Branch on the command's exit code (full table in `references/headers.md`):

- Exit `3` (forbidden header): the setting name is one Power Pages owns (`HTTP/Strict-Transport-Security` today). Stop and tell the user — do not attempt a workaround.
- Exit `4` (`.powerpages-site` missing or empty): the project is not a deployed code site yet. Tell the user to run `/deploy-site` first.
- Exit `2` (invalid arguments): re-read `headers.md`, correct the flag, retry.
- Exit `1` (unknown / I/O failure): surface the stderr verbatim and stop.

### Phase 5 — Verify

Re-run `--audit` and confirm every requested change is reflected in the `present` list. Specifically:

- Added / updated settings appear with the value the user approved.
- Removed settings are absent from `present` and appear in `missing` only if they are catalogue names.
- No new entries appear in `forbidden`.

If a verify fails, show the discrepancy and stop — do not iterate without the user.

### Phase 6 — Summarize and suggest deploy

1. **Clean up the transient plan file(s).** If Phase 3 wrote a `csp-plan.json` or any other working file at the project root, delete it now. Only clean up after Phase 5 confirmed success; if verify failed, leave the plan in place so the user can debug.

2. **Summarize the before → after state** for the user — every header that changed, its old value (if any), and its new value (if any).

3. **Suggest deployment.** The YAML changes do not reach Dataverse until `/deploy-site` runs. Ask: "Ready to deploy?" and if yes, invoke `/deploy-site`.

> Reference: `${CLAUDE_PLUGIN_ROOT}/references/skill-tracking-reference.md`

Follow the skill-tracking instructions in the reference to record this skill's usage. Use `--skillName "ManageHttpHeaders"`.

Close by asking: "Anything else on headers, or done?" If the user wants a broader security review, suggest `/review-security`.

## Progress tracking table

Keep this table in your final response, filling each status as phases complete:

| Phase | Status |
|---|---|
| 1. Prerequisites | ☐ |
| 2. Audit current HTTP/* site-settings | ☐ |
| 3. Plan the change | ☐ |
| 4. Apply | ☐ |
| 5. Verify | ☐ |
| 6. Summarize and suggest deploy | ☐ |
