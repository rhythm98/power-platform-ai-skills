#!/usr/bin/env node

// scan.js — Power Pages security scan commands.
//
// Five modes:
//   --quick --lcid N                  Quick synchronous diagnostic scan
//   --deep                            Start async OWASP deep scan (anonymous)
//   --ongoing                         Is a deep scan currently running?
//   --report                          Fetch latest completed deep-scan report
//   --score                           Fetch latest deep-scan score (totalRules / succeededRules)
//
// Notable behaviors:
//   - Deep-start is accepted asynchronously (HTTP 202) without a service-side
//     poll URL or Retry-After header; callers poll --ongoing to observe
//     completion (the scan runs for a substantial period server-side).
//   - Z003 (scan already ongoing) surfaces as HTTP 204 No Content on deep-start,
//     report, and score. Distinct exit code 4 so skills can branch.
//   - A010 (invalid input) can surface on --quick (missing/bad LCID, malformed
//     portal id) or --deep (malformed portal id); distinct exit code 5.
//
// CLI usage:
//   node scan.js --<mode> --portalId <guid> [mode flags] [--dry-run]
//   node scan.js --help

const { parseArgs } = require('node:util');
const { callAdminApi } = require('../../../scripts/lib/admin-api');

// Exit codes — documented in --help and in the skill's references/commands.md.
const EXIT = Object.freeze({
  OK: 0,
  UNKNOWN: 1,         // transport / unknown failure after retries; also A009
  INVALID_ARGS: 2,    // bad or missing CLI flags
  NOT_FOUND: 3,       // A001
  ALREADY_ONGOING: 4, // Z003 — applies to start, report, score
  INVALID_STATE: 5,   // A010 — invalid input (bad LCID, malformed portal id, etc.)
  CALLER_CONFIG: 6,   // A019 / A033 — caller-config issue (portal id not a GUID, or tenant mismatch).
});

const CATALOGUED_EXIT = Object.freeze({
  A001: EXIT.NOT_FOUND,
  Z003: EXIT.ALREADY_ONGOING,
  A010: EXIT.INVALID_STATE,
  A019: EXIT.CALLER_CONFIG,
  A033: EXIT.CALLER_CONFIG,
});

// Default caller-side wait before the first --ongoing poll after a successful
// deep-scan start. The service does not emit Retry-After for deep-scan start,
// so this is the skill's recommended cadence rather than a service-supplied
// value. 60 seconds matches the plugin-wide admin-API poll interval.
const DEEP_SCAN_DEFAULT_RETRY_AFTER_SECONDS = 60;

const HELP = `Usage:
  scan.js --<mode> --portalId <guid> [mode flags] [--dry-run]
  scan.js --help

Modes:
  --quick --lcid <int>                     Synchronous diagnostic scan.
                                           LCID (Microsoft Locale ID) is
                                           REQUIRED and controls the language
                                           of the diagnostic messages (e.g.
                                           1033 for en-US). Returns an array
                                           of pass/warn/error items
                                           immediately.
  --deep                                   Start async OWASP-based deep scan
                                           against the site's public surface
                                           (anonymous). Accepted asynchronously;
                                           scan runs server-side for an
                                           extended period.
  --ongoing                                Boolean: is a deep scan running?
  --report                                 Fetch latest completed deep-scan
                                           report as structured JSON.
  --score                                  Fetch latest deep-scan score as
                                           { totalRules, succeededRules }.

Common flags:
  --portalId <guid>                        Power Pages portal id (REQUIRED).
                                           Resolve via scripts/lib/website.js
                                           first — NOT the website record id.
  --dry-run                                For writes (--deep only): validate
                                           --portalId locally and return the
                                           would-be poll command / wait
                                           interval without contacting the
                                           service. stdout:
                                           { "dryRun": true,
                                             "operation": "startDeepScan",
                                             "portalId": "<guid>",
                                             "wouldPoll": "scan.js --ongoing
                                                 --portalId <guid>",
                                             "wouldWaitSeconds": 60 }
                                           No-op for read modes.
  -h, --help                               Show this help.

Output:
  stdout  JSON result on success. --deep returns the async-handoff shape:
          { "accepted": true,
            "operation_location": null,
            "retry_after_seconds": 60,
            "poll_command": "scan.js --ongoing --portalId <guid>" }
          operation_location is null because the service does not emit a
          poll URL for deep-scan start — poll via the poll_command instead.
          When a scan is already running, --deep returns:
          { "accepted": false, "alreadyOngoing": true, <same async fields> }
          --quick returns an array of items shaped as:
            { "issue": "<title>",
              "category": "<category>",
              "result": "Pass|Error|Warning|Information",
              "description": "<detail>",
              "learnMoreUrl": "<doc URL>" }
          --ongoing returns a JSON boolean (true / false). --report
          returns the structured report object (see
          references/commands.md). --score returns
          { "totalRules": <int>, "succeededRules": <int> }.
  stderr  Diagnostics, transient-retry notices, and catalogued service
          error codes (A001 / A010 / Z003) when applicable.

Exit codes:
  0  Success.
  1  Unknown / transport failure (includes rate-limit exhaustion and HTTP
     401/403 for callers lacking the required role).
  2  Invalid or missing CLI arguments.
  3  Portal not found (A001).
  4  A scan is already ongoing on this site (Z003). Poll --ongoing and retry.
  5  Invalid input (A010). Typical causes: missing or bad LCID on --quick,
     malformed portal id. Read stderr for the specific cause.
  6  Caller-config issue (A019 / A033). Portal id is not a GUID, or the
     caller's tenant does not match the portal's tenant. Distinct from
     exit 1 so callers can branch on caller-config vs transport failures.
`;

function extractErrorCode(body) {
  if (!body || typeof body !== 'object') {
    return null;
  }
  return (
    body.errorCode ||
    body.code ||
    (body.error && (body.error.code || body.error.errorCode)) ||
    null
  );
}

// Z003 surfaces as 204 No Content on start / report / score paths.
function isAlreadyOngoing(res) {
  return res.statusCode === 204;
}

function exitWithMessage(exitCode, message) {
  process.stderr.write(message.endsWith('\n') ? message : message + '\n');
  process.exit(exitCode);
}

function invalidArgs(message) {
  const err = new Error(message);
  err.code = 'INVALID_ARGS';
  return err;
}

function requirePortalId(portalId) {
  if (!portalId || typeof portalId !== 'string') {
    throw invalidArgs('--portalId is required');
  }
}

function throwWithCode(operation, res) {
  if (res.error) {
    const err = new Error(`${operation} failed: ${res.error}`);
    err.code = 'TRANSPORT';
    throw err;
  }
  if (res.statusCode >= 400) {
    const cataloguedCode = extractErrorCode(res.body);
    const suffix = cataloguedCode ? ` (${cataloguedCode})` : '';
    const err = new Error(`${operation} failed: HTTP ${res.statusCode}${suffix}`);
    err.statusCode = res.statusCode;
    err.code = cataloguedCode || 'HTTP_ERROR';
    throw err;
  }
}

// ===== Public API functions =====

/**
 * Quick synchronous diagnostic scan. Returns an array of diagnostic items
 * shaped as { issue, category, result, description, learnMoreUrl }.
 * LCID (Microsoft Locale ID, e.g. 1033 for en-US) is REQUIRED and controls
 * the language of the diagnostic messages.
 */
async function runQuickScan({ portalId, lcid, environmentId, cloud, deps } = {}) {
  requirePortalId(portalId);
  if (lcid === undefined || lcid === null || lcid === '') {
    throw invalidArgs('--lcid is required for --quick');
  }
  const res = await callAdminApi({
    method: 'POST',
    operation: 'scan/quick/execute',
    portalId,
    environmentId,
    cloud,
    extraQuery: { lcid: String(lcid) },
    deps,
  });
  throwWithCode('runQuickScan', res);
  return res.body;
}

/**
 * Start an async deep scan against the site's public surface (anonymous).
 * The service accepts the start asynchronously and runs the scan server-side
 * for an extended period.
 *
 * Output shape follows the plugin's async-handoff contract:
 *   { accepted, operation_location, retry_after_seconds, poll_command }
 * Where:
 *   - accepted                — true on acceptance, false if a scan is
 *                               already ongoing (Z003)
 *   - operation_location      — null, because the service does not provide
 *                               a service-side poll URL for this operation;
 *                               callers poll via the poll_command below
 *   - retry_after_seconds     — recommended wait before the first --ongoing
 *                               poll; honors the plugin-wide admin-API cadence
 *   - poll_command            — the exact command a caller runs to check
 *                               progress
 *   - alreadyOngoing          — present and true only when a scan was already
 *                               running when start was attempted
 */
async function startDeepScan({ portalId, environmentId, cloud, deps } = {}) {
  requirePortalId(portalId);
  const pollCommand = `scan.js --ongoing --portalId ${portalId}`;
  const asyncHandoff = {
    operation_location: null,
    retry_after_seconds: DEEP_SCAN_DEFAULT_RETRY_AFTER_SECONDS,
    poll_command: pollCommand,
  };
  // Body is intentionally omitted. The service accepts an optional
  // { username, password } pair for authenticated scans; this script scopes
  // itself to anonymous public-surface scans only — authenticated-page
  // coverage belongs in Power Pages Studio, not here (argv would leak secrets).
  const res = await callAdminApi({
    method: 'POST',
    operation: 'scan/deep/start',
    portalId,
    environmentId,
    cloud,
    deps,
  });
  if (isAlreadyOngoing(res)) {
    return { accepted: false, alreadyOngoing: true, ...asyncHandoff };
  }
  throwWithCode('startDeepScan', res);
  return { accepted: true, ...asyncHandoff };
}

/**
 * Is a deep scan currently running? Returns boolean.
 */
async function isDeepScanOngoing({ portalId, environmentId, cloud, deps } = {}) {
  requirePortalId(portalId);
  const res = await callAdminApi({
    method: 'GET',
    operation: 'scan/deep/isongoing',
    portalId,
    environmentId,
    cloud,
    deps,
  });
  throwWithCode('isDeepScanOngoing', res);
  const body = res.body;
  if (body && typeof body === 'object') {
    return body.status === true || body.status === 'true';
  }
  return Boolean(body);
}

/**
 * Fetch the latest completed deep-scan report. Throws with code Z003 if a
 * scan is in progress (HTTP 204); throws with TRANSPORT / HTTP_ERROR if no
 * deep scan has ever completed on this site.
 */
async function getLatestDeepScanReport({ portalId, environmentId, cloud, deps } = {}) {
  requirePortalId(portalId);
  const res = await callAdminApi({
    method: 'GET',
    operation: 'scan/deep/getLatestCompletedReport',
    portalId,
    environmentId,
    cloud,
    deps,
  });
  if (isAlreadyOngoing(res)) {
    const err = new Error(
      'getLatestDeepScanReport failed: a scan is currently running (Z003). Wait for it to complete.',
    );
    err.code = 'Z003';
    throw err;
  }
  throwWithCode('getLatestDeepScanReport', res);
  return res.body;
}

/**
 * Fetch the security score. Same refusal pattern as getLatestDeepScanReport.
 */
async function getSecurityScore({ portalId, environmentId, cloud, deps } = {}) {
  requirePortalId(portalId);
  const res = await callAdminApi({
    method: 'GET',
    operation: 'scan/deep/getSecurityScore',
    portalId,
    environmentId,
    cloud,
    deps,
  });
  if (isAlreadyOngoing(res)) {
    const err = new Error(
      'getSecurityScore failed: a scan is currently running (Z003). Wait for it to complete.',
    );
    err.code = 'Z003';
    throw err;
  }
  throwWithCode('getSecurityScore', res);
  return res.body;
}

// ===== CLI wiring =====

function parseCli(argv) {
  const options = {
    quick: { type: 'boolean' },
    deep: { type: 'boolean' },
    ongoing: { type: 'boolean' },
    report: { type: 'boolean' },
    score: { type: 'boolean' },
    portalId: { type: 'string' },
    lcid: { type: 'string' },
    'dry-run': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  };
  return parseArgs({ args: argv.slice(2), options, strict: true }).values;
}

function pickMode(args) {
  const modes = [
    args.quick && 'quick',
    args.deep && 'deep',
    args.ongoing && 'ongoing',
    args.report && 'report',
    args.score && 'score',
  ].filter(Boolean);
  if (modes.length === 0) return null;
  if (modes.length > 1) {
    return { error: `Multiple mode flags set: ${modes.join(', ')} — pick exactly one` };
  }
  return { mode: modes[0] };
}

function parseLcid(raw) {
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw invalidArgs(`--lcid must be a positive integer (got: ${raw})`);
  }
  return parsed;
}

async function runMode(mode, args) {
  switch (mode) {
    case 'quick': {
      const lcid = parseLcid(args.lcid);
      return runQuickScan({ portalId: args.portalId, lcid });
    }

    case 'deep': {
      if (args['dry-run']) {
        requirePortalId(args.portalId);
        return {
          dryRun: true,
          operation: 'startDeepScan',
          portalId: args.portalId,
          wouldPoll: `scan.js --ongoing --portalId ${args.portalId}`,
          wouldWaitSeconds: DEEP_SCAN_DEFAULT_RETRY_AFTER_SECONDS,
        };
      }
      return startDeepScan({ portalId: args.portalId });
    }

    case 'ongoing':
      return isDeepScanOngoing({ portalId: args.portalId });

    case 'report':
      return getLatestDeepScanReport({ portalId: args.portalId });

    case 'score':
      return getSecurityScore({ portalId: args.portalId });

    default:
      throw new Error(`Unreachable: unknown mode "${mode}"`);
  }
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

  const pick = pickMode(args);
  if (pick === null) {
    exitWithMessage(
      EXIT.INVALID_ARGS,
      `Missing mode flag — pick one of --quick, --deep, --ongoing, --report, --score.\n\n${HELP}`,
    );
    return;
  }
  if (pick.error) {
    exitWithMessage(EXIT.INVALID_ARGS, `${pick.error}\n\n${HELP}`);
    return;
  }

  try {
    const result = await runMode(pick.mode, args);
    // --ongoing returns a boolean; serialize directly so stdout is valid JSON.
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    const exitCode =
      err.code === 'INVALID_ARGS'
        ? EXIT.INVALID_ARGS
        : CATALOGUED_EXIT[err.code] ?? EXIT.UNKNOWN;
    // Surface a single-line actionable message to the user. The stack is only
    // useful for debugging — gate it behind DEBUG so it does not leak Node
    // internals into normal CLI output.
    const message = process.env.DEBUG ? (err.stack || err.message) : err.message;
    exitWithMessage(exitCode, message);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  runQuickScan,
  startDeepScan,
  isDeepScanOngoing,
  getLatestDeepScanReport,
  getSecurityScore,
  extractErrorCode,
  isAlreadyOngoing,
  EXIT,
};
