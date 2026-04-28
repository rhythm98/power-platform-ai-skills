# Security headers — reference

Single consolidated reference for the `manage-http-headers` skill: the header catalogue the Power Pages runtime recognizes, product-specific quirks, command specs for the two bundled scripts, and external-doc pointers.

## Contents

- [Site-setting naming convention](#site-setting-naming-convention)
- [Recognized header catalogue](#recognized-header-catalogue)
- [Power Pages-managed headers (not settable)](#power-pages-managed-headers-not-settable)
- [Default behavior when a setting is absent](#default-behavior-when-a-setting-is-absent)
- [CSP specifics](#csp-specifics)
- [CORS specifics](#cors-specifics)
- [SameSite cookies](#samesite-cookies)
- [Power-Pages-runtime sources a CSP must allow](#power-pages-runtime-sources-a-csp-must-allow)
- [Deployment and caching](#deployment-and-caching)
- [Command spec — `http-headers.js`](#command-spec--http-headersjs)
- [Command spec — `scan-external-urls.js`](#command-spec--scan-external-urlsjs)
- [Shared exit codes](#shared-exit-codes)

## Site-setting naming convention

Every HTTP header site-setting uses the prefix `HTTP/` followed by the header name. Examples: `HTTP/X-Frame-Options`, `HTTP/Content-Security-Policy`, `HTTP/Access-Control-Allow-Origin`.

SameSite cookie settings use dynamic segments rather than a single header-named key:
- `HTTP/SameSite/Default` — applies to every cookie unless overridden.
- `HTTP/SameSite/<cookie-name>` — per-cookie override for the named cookie.

In code sites, each site-setting is a separate YAML file under `.powerpages-site/site-settings/` — the file name uses `-` instead of `/` (e.g. `HTTP-X-Frame-Options.sitesetting.yml`) because `/` is not a filename-safe character.

## Recognized header catalogue

The Power Pages runtime reads these `HTTP/*` site-settings and emits the corresponding response header. Names outside this catalogue are also emitted by the runtime as-is; the audit command flags them as `custom` so the author can spot typos or confirm the non-standard name was intentional.

**CSP**
- `HTTP/Content-Security-Policy`
- `HTTP/Content-Security-Policy-Report-Only`
- `HTTP/Content-Security-Policy/Inject-unsafe-eval` — boolean flag, not a header (see [CSP specifics](#csp-specifics))

**CORS**
- `HTTP/Access-Control-Allow-Origin`
- `HTTP/Access-Control-Allow-Credentials`
- `HTTP/Access-Control-Allow-Headers`
- `HTTP/Access-Control-Allow-Methods`
- `HTTP/Access-Control-Expose-Headers`
- `HTTP/Access-Control-Max-Age`

**Clickjacking / framing**
- `HTTP/X-Frame-Options`

**MIME sniffing / download**
- `HTTP/X-Content-Type-Options`
- `HTTP/X-Download-Options`
- `HTTP/X-Permitted-Cross-Domain-Policies`

**Cross-origin isolation**
- `HTTP/Cross-Origin-Resource-Policy`
- `HTTP/Cross-Origin-Opener-Policy`
- `HTTP/Cross-Origin-Embedder-Policy`

**Referrer / permissions / privacy**
- `HTTP/Referrer-Policy`
- `HTTP/Permissions-Policy`
- `HTTP/X-DNS-Prefetch-Control`
- `HTTP/X-XSS-Protection` — legacy; modern browsers ignore it but the runtime will emit whatever you set

**Cookies**
- `HTTP/SameSite/Default`
- `HTTP/SameSite/<cookie-name>`

## Power Pages-managed headers (not settable)

`Strict-Transport-Security` and `Cache-Control` are emitted by the runtime and cannot be overridden. Writing `HTTP/Strict-Transport-Security` is rejected by `http-headers.js` with exit code `3`.

## Default behavior when a setting is absent

When an `HTTP/<Header>` site-setting is absent, the runtime omits that header. The one exception is CSP: some sites have a default CSP applied when `HTTP/Content-Security-Policy` is absent, so an audit may show a CSP even with no site-setting YAML on disk. Explicitly configure `HTTP/Content-Security-Policy` so the policy is reviewable in source control.

## CSP specifics

**Policy is pass-through, not merged.** The runtime emits whatever value you write in `HTTP/Content-Security-Policy` verbatim. Power-Pages-runtime sources are NOT added automatically — your directive must include them explicitly (see [Power-Pages-runtime sources a CSP must allow](#power-pages-runtime-sources-a-csp-must-allow)). If a runtime source is missing from your policy, those resources fail to load and parts of the site will not render.

**Nonce mechanism.** When `script-src` contains the keyword `'nonce'`, the runtime replaces it per-request with `'nonce-<random>'` and injects a matching `nonce` attribute on every Liquid-rendered inline `<script>` tag. Inline event handlers (e.g. `onclick=...`) are auto-hashed and those hashes are injected into the same directive. Scripts that are dynamically created in the browser via `document.createElement` do NOT receive the server-side nonce — refactor them to a file loaded from an allowlisted origin if the policy blocks them.

**`'unsafe-eval'` auto-injection.** The site-setting `HTTP/Content-Security-Policy/Inject-unsafe-eval` (boolean, default `true`) causes the runtime to auto-inject `'unsafe-eval'` into `script-src` when a `'nonce'` placeholder is present. This exists because several Power-Pages-runtime components require `'unsafe-eval'`. Setting it to `false` hardens the policy but may break runtime functionality — only disable after testing the site in report-only mode first.

**Report-Only.** A separate site-setting (`HTTP/Content-Security-Policy-Report-Only`) emits the standard Report-Only header. Enforcement and report-only can run simultaneously — the standard iteration workflow is:
1. Start with only the Report-Only setting configured.
2. Review the browser console for `Content-Security-Policy-Report-Only` violations on real traffic.
3. Add sources incrementally to a draft of the enforcing policy until Report-Only runs clean.
4. Promote the draft to `HTTP/Content-Security-Policy` (the enforcing setting).
5. Optionally delete the Report-Only setting once the enforcing policy is stable.

**Supported directives** include `default-src`, `img-src`, `font-src`, `script-src`, `style-src`, `connect-src`, `media-src`, `frame-src`, `frame-ancestors`, `form-action`, `object-src`, `worker-src`, `manifest-src`, `child-src`.

**`X-Frame-Options` vs CSP `frame-ancestors`.** Modern browsers use `frame-ancestors` when both are present; older browsers use `X-Frame-Options`. Setting both is safe. If the user only wants same-origin framing, `frame-ancestors 'self'` in CSP plus `HTTP/X-Frame-Options: SAMEORIGIN` covers both eras.

## CORS specifics

**`HTTP/Access-Control-Allow-Credentials` only accepts the value `true`** (case-sensitive). Browsers reject any other value. To disable credentials, omit the setting entirely — do not set it to `false`.

**`HTTP/Access-Control-Allow-Origin: *` is auto-specialized.** The runtime replaces `*` per-request with the specific requesting Origin — the browser sees a single-origin header, not a wildcard. This is important:
- It means `*` with credentials effectively works (since the response is actually per-origin), unlike the browser wildcard + credentials rule in raw HTTP.
- It means CDN / cache design that assumes a static wildcard header will see a different `Vary: Origin` behavior — plan cache keys accordingly.

**Preflight (`OPTIONS`) behavior** follows standard browser mechanics. Configure `HTTP/Access-Control-Allow-Methods` to include every method your Web API exposes; configure `HTTP/Access-Control-Max-Age` to cache the preflight response (in seconds) and reduce round-trips. If browsers still send preflights on every request, check that the requested headers are covered by `HTTP/Access-Control-Allow-Headers`.

CORS headers are applied to every response, not only Web API responses — a missing `Allow-Origin` on a static asset response is visible in browser dev tools even for same-origin requests.

## SameSite cookies

**`HTTP/SameSite/Default`** — applies to every cookie the site sets unless overridden. Accepted values: `None`, `Lax`, `Strict`.

**`HTTP/SameSite/<cookie-name>`** — per-cookie override. Use when the global default is too restrictive for a specific cookie (e.g., the site is hosted in an iframe on a third-party domain and needs `None` for its session cookie).

**`None` requires `Secure`.** Browsers reject a `SameSite=None` cookie without the `Secure` attribute. The runtime sets `Secure` on every cookie when the site is served over HTTPS, so `None` works in practice for HTTPS sites.

For iframe-embedding scenarios (hosting a Power Pages site inside a third-party page), use `HTTP/SameSite/<session-cookie-name>: None` on the specific cookies the embed needs so they survive cross-site contexts.

## Power-Pages-runtime sources a CSP must allow

The runtime loads resources from these hosts. Any CSP you deploy must include them in the corresponding directives, or the site fails to render.

**Required on `script-src`** — one cloud-specific runtime host plus the nonce keyword:

| Site's cloud | Required `content.powerapps.*` host |
|---|---|
| Public / Commercial | `content.powerapps.com` |
| US Government (GCC / GCC High) | `content.powerapps.us` |
| US Department of Defense | `content.appsplatform.us` |
| China | `content.powerapps.cn` |

Include only the one that matches the site's cloud — adding the others over-allows and defeats the point of the CSP. Resolve the cloud via `pac auth who` (the `Cloud` field) before composing the directive.

Also required on `script-src`:
- `'nonce'` — enables the per-request nonce mechanism for inline Liquid-rendered scripts

**Required on `style-src`**:
- `'unsafe-inline'` (runtime platform limitation for certain out-of-the-box styles)
- `https:` (broad but matches the default)

**Required on `font-src` / `img-src` / `connect-src`**: depends on the site's own content. The `scan-external-urls.js` helper detects these.

If the user is starting a CSP from scratch, a reasonable starting directive (with `<cloud-host>` replaced by the cloud-specific host from the table above) is:
```
default-src 'self';
script-src 'self' 'nonce' <cloud-host>;
style-src 'self' 'unsafe-inline' https:;
img-src 'self' data: https:;
font-src 'self' https: data:;
connect-src 'self' https:;
frame-ancestors 'self';
```

Run `scan-external-urls.js` to tighten the `https:` wildcards into specific hosts before promoting to enforcement.

## Deployment and caching

Header changes land in Dataverse via `/deploy-site`. The site-setting update triggers a soft restart (no downtime); new values take effect once the restart propagates. Verify after a short wait in an incognito browser tab or via `curl -I <site-url>`.

**Maker-mode requests skip all HTTP/* header emission.** Requests from Power Pages Studio or other detected maker tools bypass the header middleware. Consequence: viewing the site through maker tools will NOT show your headers. Always verify with a fresh browser tab that isn't authenticated as a maker.

## Command spec — `http-headers.js`

**Audit current site-settings**

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-http-headers/scripts/http-headers.js" \
  --audit \
  --projectRoot "<project-root>"
```

Read-only. Returns JSON: `{ present: [...], missing: [...], forbidden: [...] }`. Each item in `present` has `name`, `value`, and an optional `custom: true` flag when the name is outside the recognized catalogue.

**Write or update a setting**

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-http-headers/scripts/http-headers.js" \
  --write \
  --projectRoot "<project-root>" \
  --name "HTTP/<Header-Name>" \
  --value "<header-value>" \
  --description "<human-readable description>" \
  [--dry-run]
```

Write. Preserves the existing YAML id when updating. Rejects Power Pages-managed headers (exit code `3`). `--dry-run` validates the name and path without writing.

**Remove a setting**

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-http-headers/scripts/http-headers.js" \
  --remove \
  --projectRoot "<project-root>" \
  --name "HTTP/<Header-Name>" \
  [--dry-run]
```

Write (delete). Removing a setting that does not exist is a no-op (exit 0 with `{ removed: false }`).

**Parameters (common)**

| Flag | Required | Validation |
|---|---|---|
| `--projectRoot` | yes for all modes | Must contain `.powerpages-site/site-settings/`. Missing → exit `4` |
| `--name` | `--write` / `--remove` | Must start with `HTTP/`. Power Pages-managed names (HSTS) rejected with exit `3` |
| `--value` | `--write` | Any non-null string. Empty string is allowed and means "disabled but present" |
| `--description` | `--write` | Non-empty string. Shown in the Dataverse UI |
| `--dry-run` | optional | Validates locally, skips the file write/delete |

## Command spec — `scan-external-urls.js`

Scan the project for external URLs referenced in HTML, CSS, and JavaScript. Produces a structured allowlist keyed by CSP directive plus the cloud-agnostic Power-Pages-runtime dependencies. The cloud-specific `content.powerapps.*` host is intentionally omitted — compose it separately after detecting the site's cloud via `pac auth who` (see [Power-Pages-runtime sources a CSP must allow](#power-pages-runtime-sources-a-csp-must-allow)).

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/manage-http-headers/scripts/scan-external-urls.js" \
  --projectRoot "<project-root>" \
  [--exclude "<comma-separated directory names>"]
```

Read-only. Walks the project tree (excluding `node_modules`, `.git`, `.powerpages-site`, and similar build directories by default). `--exclude` adds extra directory names (at any depth) to skip on top of the defaults. Returns JSON:

```json
{
  "byDirective": {
    "script-src": ["<hosts>"],
    "style-src": ["<hosts>"],
    "img-src": ["<hosts>"],
    "font-src": ["<hosts>"],
    "connect-src": ["<hosts>"],
    "frame-src": ["<hosts>"]
  },
  "runtimeDependencies": {
    "script-src": ["'self'", "'nonce'"],
    "style-src": ["'self'", "'unsafe-inline'", "https:"],
    "img-src": ["'self'", "data:", "https:"],
    "font-src": ["'self'", "https:", "data:"],
    "connect-src": ["'self'", "https:"],
    "frame-ancestors": ["'self'"]
  },
  "bySourceFile": [
    { "file": "src/components/widget.tsx", "urls": ["https://..."] }
  ]
}
```

URL extraction is pattern-based and intentionally conservative — dynamic URLs built at runtime from template strings or computed hostnames will not be caught. Review the `bySourceFile` list and cross-check any gaps.

## Shared exit codes

Both commands use the same exit-code space.

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Unknown or I/O failure (file read/write error, YAML parse error, etc.) |
| `2` | Invalid or missing CLI arguments |
| `3` | Forbidden header — name is one Power Pages owns (e.g. `HTTP/Strict-Transport-Security`). Do not retry or work around. |
| `4` | `.powerpages-site/site-settings/` is missing. The project is not a deployed code site yet — run `/deploy-site` first. |

`node http-headers.js --help` and `node scan-external-urls.js --help` print the same exit-code table.
