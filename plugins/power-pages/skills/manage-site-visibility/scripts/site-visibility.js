#!/usr/bin/env node

// site-visibility.js — flips a Power Pages site between Public and Private.
//
// The flip restarts the site; callers that re-read the website record
// immediately afterwards may still see the old value. Allow 30-60s for
// propagation.
//
// CLI usage:
//   node site-visibility.js --setVisibility --portalId <guid> --value Public|Private
//   node site-visibility.js --help
//
// On success: prints { "updated": true } on stdout and exits 0.
// On failure: prints a diagnostic to stderr and exits with one of the codes
// documented in HELP / in the skill's commands.md.

const { parseArgs } = require('node:util');
const { callAdminApi } = require('../../../scripts/lib/admin-api');

// The CLI accepts only these exact spellings. The admin surface itself accepts
// either case and normalises to lowercase server-side, but the CLI stays
// deterministic by rejecting anything else locally before a network call.
const VALID_VISIBILITY = new Set(['Public', 'Private']);

// Exit codes — documented in --help and in this skill's references/commands.md.
const EXIT = Object.freeze({
  OK: 0,
  UNKNOWN: 1,          // transport / unknown failure after retries
  INVALID_ARGS: 2,     // bad or missing CLI flags
  NOT_FOUND: 3,        // catalogued A001
  UNAUTHORIZED: 4,     // catalogued A037
  GOVERNANCE: 5,       // catalogued A039
  DEVELOPER: 6,        // catalogued D005
});

// Catalogued service-error codes → exit-code mapping. Codes not in this map
// fall through to EXIT.UNKNOWN so the caller still sees the raw stderr.
const CATALOGUED_EXIT = Object.freeze({
  A001: EXIT.NOT_FOUND,
  A037: EXIT.UNAUTHORIZED,
  A039: EXIT.GOVERNANCE,
  D005: EXIT.DEVELOPER,
});

const HELP = `Usage:
  site-visibility.js --setVisibility --portalId <guid> --value <Public|Private> [--dry-run]
  site-visibility.js --help

Flips a Power Pages site between Public and Private.

Options:
  --setVisibility           Select the flip operation. Required.
  --portalId <guid>         Power Pages portal id. Resolve via
                            scripts/lib/website.js first — this is NOT the
                            website record id stored in .powerpages-site.
  --value <Public|Private>  Target visibility. CLI accepts only these exact
                            spellings; the admin surface normalises the stored
                            value to lowercase, so subsequent reads return
                            "public" or "private".
  --dry-run                 Validate inputs and print the intended call without
                            contacting the admin API. Exits 0 on success.
  -h, --help                Show this help.

Output:
  stdout  On success: JSON { "updated": true }.
          With --dry-run: JSON { "dryRun": true, ...intended call... }.
  stderr  Diagnostic messages, transient-retry notices, and catalogued
          service error codes (A001 / A037 / A039 / D005) when applicable.

Exit codes:
  0  Success (or successful --dry-run).
  1  Unknown, transport, or uncategorised failure (after automatic retries).
     Raw stderr carries any service error code (A009, A010, A019, A033, ...)
     that was not mapped to one of the codes below.
  2  Invalid or missing CLI arguments.
  3  Portal not found (A001) — unknown id, deleted site, or the caller's auth
     context is pointing at a different tenant / environment.
  4  Caller not authorized to flip visibility (A037).
  5  Non-production site blocked from going Public by tenant governance
     policy (A039).
  6  Developer site — visibility cannot be changed to Public on a developer
     environment (D005).
`;

/**
 * Extract a catalogued service error code from a parsed response body.
 * The admin layer may surface the code under several keys depending on the
 * upstream error shape; try the common ones in turn.
 *
 * @param {unknown} body
 * @returns {string|null}
 */
function extractErrorCode(body) {
  if (!body || typeof body !== 'object') return null;
  return (
    body.errorCode ||
    body.code ||
    (body.error && (body.error.code || body.error.errorCode)) ||
    null
  );
}

/**
 * Flip the site between Public and Private.
 *
 * Throws on any failure. The thrown Error carries:
 *   - `code`       — the catalogued service code (e.g. 'A037') when one was
 *                    surfaced; 'TRANSPORT' for network / unknown transport
 *                    failures; 'INVALID_ARGS' for local validation failures;
 *                    'HTTP_ERROR' for HTTP errors without a catalogued code.
 *   - `statusCode` — the HTTP status, when applicable.
 *
 * @param {object} options
 * @param {string} options.portalId
 * @param {'Public'|'Private'} options.siteVisibility
 * @param {string} [options.environmentId]
 * @param {string} [options.cloud]
 * @param {object} [options.deps]  Test-only dependency overrides.
 *
 * @returns {Promise<{ updated: true }>}
 */
async function updateSiteVisibility({
  portalId,
  siteVisibility,
  environmentId,
  cloud,
  deps,
} = {}) {
  if (!portalId || typeof portalId !== 'string') {
    const err = new Error('portalId is required');
    err.code = 'INVALID_ARGS';
    throw err;
  }
  if (!VALID_VISIBILITY.has(siteVisibility)) {
    const err = new Error(
      `siteVisibility must be one of ${[...VALID_VISIBILITY].join(', ')} (got: ${siteVisibility})`,
    );
    err.code = 'INVALID_ARGS';
    throw err;
  }

  const res = await callAdminApi({
    method: 'POST',
    operation: 'updateSiteVisibility',
    portalId,
    environmentId,
    cloud,
    extraQuery: { siteVisibility },
    deps,
  });

  if (res.error) {
    const err = new Error(`updateSiteVisibility failed: ${res.error}`);
    err.code = 'TRANSPORT';
    throw err;
  }

  if (res.statusCode >= 400) {
    let cataloguedCode = extractErrorCode(res.body);
    // For this operation, Caller not authorized to flip visibility (A037).
    // The platform strips the error body on 401 so the code
    // is not recoverable from the body — infer it from the status.
    if (!cataloguedCode && res.statusCode === 401) {
      cataloguedCode = 'A037';
    }
    const suffix = cataloguedCode ? ` (${cataloguedCode})` : '';
    const err = new Error(
      `updateSiteVisibility failed: HTTP ${res.statusCode}${suffix}`,
    );
    err.statusCode = res.statusCode;
    err.code = cataloguedCode || 'HTTP_ERROR';
    throw err;
  }

  return { updated: true };
}

function parseCli(argv) {
  const options = {
    setVisibility: { type: 'boolean' },
    portalId: { type: 'string' },
    value: { type: 'string' },
    'dry-run': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  };
  return parseArgs({ args: argv.slice(2), options, strict: true }).values;
}

function exitWithMessage(exitCode, message) {
  process.stderr.write(message.endsWith('\n') ? message : message + '\n');
  process.exit(exitCode);
}

async function main() {
  let args;
  try {
    args = parseCli(process.argv);
  } catch (err) {
    exitWithMessage(EXIT.INVALID_ARGS, `Argument error: ${err.message}\n\n${HELP}`);
    return;
  }

  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  if (!args.setVisibility) {
    exitWithMessage(EXIT.INVALID_ARGS, `Missing --setVisibility.\n\n${HELP}`);
    return;
  }

  if (args['dry-run']) {
    if (!args.portalId || typeof args.portalId !== 'string') {
      exitWithMessage(EXIT.INVALID_ARGS, 'portalId is required');
      return;
    }
    if (!VALID_VISIBILITY.has(args.value)) {
      exitWithMessage(
        EXIT.INVALID_ARGS,
        `siteVisibility must be one of ${[...VALID_VISIBILITY].join(', ')} (got: ${args.value})`,
      );
      return;
    }
    process.stdout.write(
      JSON.stringify(
        { dryRun: true, operation: 'updateSiteVisibility', portalId: args.portalId, siteVisibility: args.value },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  try {
    const result = await updateSiteVisibility({
      portalId: args.portalId,
      siteVisibility: args.value,
    });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    const exitCode =
      err.code === 'INVALID_ARGS'
        ? EXIT.INVALID_ARGS
        : CATALOGUED_EXIT[err.code] ?? EXIT.UNKNOWN;
    exitWithMessage(exitCode, err.stack || err.message);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  updateSiteVisibility,
  extractErrorCode,
  VALID_VISIBILITY,
  EXIT,
};
