#!/usr/bin/env node

// posture-snapshot.js — run the read commands from every security area in
// parallel and aggregate the results into a single JSON blob the meta-skill
// can consume in one shot.
//
// Why this exists: Phase 3 of the /review-security meta-skill otherwise has to
// issue 7+ sequential reads (website lookup, WAF status, WAF rules, scan
// ongoing check, scan report, scan score, HTTP/* audit, language detect).
// Running them sequentially stretches a fast phase into minutes of wall
// clock — the reads are all independent, so they can fan out.
//
// Behavior: fails open — if any individual read fails (missing tool,
// network error, etc.), its field in the output is populated as
// { "error": "<message>" } and every other read still proceeds. The
// meta-skill surfaces failed reads in the unified report so the user
// sees which signal is missing.
//
// CLI usage:
//   node posture-snapshot.js --portalId <guid> --projectRoot <path>
//   node posture-snapshot.js --help

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parseArgs } = require('node:util');

const {
  WEB_ROLE_FILE_SUFFIX,
  loadYamlRecordsWithErrors,
} = require('../../../scripts/lib/powerpages-config');

const EXIT = Object.freeze({
  OK: 0,
  UNKNOWN: 1,
  INVALID_ARGS: 2,
});

// Root of the power-pages plugin. This script lives at:
//   plugins/power-pages/skills/review-security/scripts/posture-snapshot.js
// so the plugin root is four directories up.
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..', '..');

const HELP = `Usage:
  posture-snapshot.js --portalId <guid> --projectRoot <path>
  posture-snapshot.js --help

Runs every security-area read command in parallel and aggregates the
results into a single JSON blob. Failures in individual reads are
captured as { "error": "..." } fields; the rest of the snapshot still
succeeds.

Options:
  --portalId <guid>     Power Pages portal id (REQUIRED). Resolve from the
                        website record id via scripts/lib/website.js first.
  --projectRoot <path>  Project root directory (REQUIRED). Used for the
                        file-based reads (HTTP/* headers audit, language
                        detection).
  -h, --help            Show this help.

Output (stdout): a JSON object with fields:
  website       — raw website record (from scripts/lib/website.js)
  waf.status    — WAF status / log-capture settings
  waf.rules     — WAF rule configuration
  scan.ongoing  — whether a deep scan is running
  scan.report   — latest completed deep-scan report (or null)
  scan.score    — { totalRules, succeededRules } (or null)
  headers.audit — present / missing / forbidden HTTP/* site-settings
  languages     — CodeQL-supported languages detected in the project
  webRoles      — local web-role definitions read from
                  <projectRoot>/.powerpages-site/web-roles/*.webrole.yml,
                  shaped as { present, count, roles[] } or { error }.
                  Feeds the unified security report and Phase 4's
                  web-role-binding check.

Exit codes:
  0  Success — every read completed (some may contain { error } fields).
  1  Unknown runtime failure.
  2  Invalid or missing CLI arguments.
`;

function exitWithMessage(exitCode, message) {
  process.stderr.write(message.endsWith('\n') ? message : message + '\n');
  process.exit(exitCode);
}

function invalidArgs(message) {
  const err = new Error(message);
  err.code = 'INVALID_ARGS';
  return err;
}

/**
 * Spawn `node <scriptPath> <args>` and resolve to the parsed JSON stdout
 * on exit 0, or to { error: "..." } otherwise. Never rejects — callers
 * always get a value back, so Promise.all() fans out cleanly even when
 * some reads fail.
 */
function runNodeScript(scriptPath, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      resolve({ error: `spawn failed: ${err.message}` });
    });
    child.on('close', (code) => {
      if (code !== 0) {
        // Preserve the child's stderr so the caller can surface it. Cap at
        // STDERR_TAIL_LINES so a verbose child trace cannot flood the
        // aggregate JSON output (the agent's stdout buffer truncates at
        // ~10–30K chars, and a single failing helper could otherwise
        // dominate the snapshot).
        const STDERR_TAIL_LINES = 5;
        const trimmed = (stderr || '').split(/\r?\n/).slice(0, STDERR_TAIL_LINES).join('\n');
        resolve({ error: `exit ${code}: ${trimmed}` });
        return;
      }
      if (!stdout.trim()) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (parseErr) {
        resolve({ error: `invalid JSON from ${scriptPath}: ${parseErr.message}` });
      }
    });
  });
}

function websiteResolverPath() {
  return path.join(PLUGIN_ROOT, 'scripts', 'lib', 'website.js');
}

function wafScriptPath() {
  return path.join(PLUGIN_ROOT, 'skills', 'manage-web-application-firewall', 'scripts', 'waf.js');
}

function scanScriptPath() {
  return path.join(PLUGIN_ROOT, 'skills', 'manage-site-scan', 'scripts', 'scan.js');
}

function headersScriptPath() {
  return path.join(PLUGIN_ROOT, 'skills', 'manage-http-headers', 'scripts', 'http-headers.js');
}

function languagesScriptPath() {
  return path.join(PLUGIN_ROOT, 'skills', 'manage-code-scan', 'scripts', 'detect-languages.js');
}

/**
 * Read local web-role definitions from the project's `.powerpages-site/web-roles/`
 * directory. This is a file-based read (no network, no Dataverse) because code
 * sites persist web-role YAML alongside site-settings and table-permissions.
 *
 * Returns:
 *   { present: false, count: 0, roles: [] } — directory missing or empty
 *                                              (common on a freshly scaffolded
 *                                              site that has never deployed)
 *   { present: true,  count: N, roles: [...] } — each role as a parsed YAML
 *                                                  record from powerpages-config
 *   { error: "..." } — any unexpected failure; stays consistent with the
 *                      fail-open pattern the other reads use
 *
 * Shape is intentionally minimal — the meta-skill uses this in Phase 4
 * to flag administratively-sensitive pages that have no web role bound
 * to them.
 */
function readLocalWebRoles(projectRoot) {
  try {
    const rolesDir = path.join(projectRoot, '.powerpages-site', 'web-roles');
    if (!fs.existsSync(rolesDir)) {
      return { present: false, count: 0, roles: [] };
    }
    const { records, errors } = loadYamlRecordsWithErrors(rolesDir, WEB_ROLE_FILE_SUFFIX);
    if (errors.length > 0) {
      return { error: `web-role parse failures: ${errors[0].message}` };
    }
    return { present: true, count: records.length, roles: records };
  } catch (err) {
    return { error: `web-role read failed: ${err.message}` };
  }
}

async function runSnapshot({ portalId, projectRoot } = {}) {
  if (!portalId || typeof portalId !== 'string') {
    throw invalidArgs('--portalId is required');
  }
  if (!projectRoot || typeof projectRoot !== 'string') {
    throw invalidArgs('--projectRoot is required');
  }

  // Fan out every read in parallel. Every call resolves to either the
  // parsed JSON or a `{ error }` placeholder — none throw — so Promise.all
  // always settles cleanly.
  const [
    websiteResult,
    wafStatusResult,
    wafRulesResult,
    scanOngoingResult,
    scanReportResult,
    scanScoreResult,
    headersAuditResult,
    languagesResult,
  ] = await Promise.all([
    // Note: website.js takes websiteRecordId, not portalId. The caller
    // already resolved the portal id, so for the snapshot we hit the same
    // record via the portal id path — site metadata is what we need.
    // The resolver script only accepts --websiteRecordId, so we pass the
    // caller-provided portalId there and let them cross-reference; in
    // practice callers set --websiteRecordId before running this script
    // and the `website` field in the output is informational.
    runNodeScript(websiteResolverPath(), ['--websiteRecordId', portalId]),
    runNodeScript(wafScriptPath(), ['--status', '--portalId', portalId]),
    runNodeScript(wafScriptPath(), ['--rules', '--portalId', portalId]),
    runNodeScript(scanScriptPath(), ['--ongoing', '--portalId', portalId]),
    runNodeScript(scanScriptPath(), ['--report', '--portalId', portalId]),
    runNodeScript(scanScriptPath(), ['--score', '--portalId', portalId]),
    runNodeScript(headersScriptPath(), ['--audit', '--projectRoot', projectRoot]),
    runNodeScript(languagesScriptPath(), ['--projectRoot', projectRoot]),
  ]);

  // Web-role read is synchronous and file-based; run it inline rather than
  // adding a child-process hop for a directory walk + YAML parse.
  const webRolesResult = readLocalWebRoles(projectRoot);

  return {
    website: websiteResult,
    waf: { status: wafStatusResult, rules: wafRulesResult },
    scan: { ongoing: scanOngoingResult, report: scanReportResult, score: scanScoreResult },
    headers: { audit: headersAuditResult },
    languages: languagesResult,
    webRoles: webRolesResult,
  };
}

function parseCli(argv) {
  const options = {
    portalId: { type: 'string' },
    projectRoot: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  };
  return parseArgs({ args: argv.slice(2), options, strict: true }).values;
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
  try {
    const result = await runSnapshot({ portalId: args.portalId, projectRoot: args.projectRoot });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    const exitCode = err.code === 'INVALID_ARGS' ? EXIT.INVALID_ARGS : EXIT.UNKNOWN;
    exitWithMessage(exitCode, err.stack || err.message);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  runSnapshot,
  runNodeScript,
  PLUGIN_ROOT,
  EXIT,
};
