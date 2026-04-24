#!/usr/bin/env node

// parse-sarif.js — read a SARIF file (from any tool: CodeQL, Semgrep,
// Trivy, etc.) and produce a structured summary grouped by rule,
// severity, and the tags each tool attached to its rules.
//
// Different tools tag findings differently:
//   CodeQL   — CWE via `external/cwe/cwe-NNN` on rule.properties.tags
//   Semgrep  — CWE, OWASP, and category tags directly on results and rules
//              (e.g. `cwe:CWE-89`, `owasp:A03:2021`)
//   Trivy    — SCA findings with CVE IDs on ruleId + severity; license
//              findings with license classes (restricted / reciprocal / …)
//
// The skill interprets tags per-tool in its Phase 6; this script stays
// generic — it surfaces tags verbatim without a cross-tool mapping.
//
// CLI usage:
//   node parse-sarif.js --sarif <path> [--limit <N>]
//   node parse-sarif.js --help

const fs = require('node:fs');
const { parseArgs } = require('node:util');

const EXIT = Object.freeze({
  OK: 0,
  UNKNOWN: 1,
  INVALID_ARGS: 2,
});

const DEFAULT_FLAT_LIMIT = 100;

// Severity ordering for stable sort. `error`, `warning`, `note` is the
// SARIF standard vocabulary; some tools emit `none` or other values —
// those fall to the end.
const SEVERITY_ORDER = Object.freeze({ error: 0, warning: 1, note: 2, none: 3 });

const HELP = `Usage:
  parse-sarif.js --sarif <path> [--limit <N>]
  parse-sarif.js --help

Reads a SARIF file from any supported tool (CodeQL, Semgrep, Trivy) and
produces a structured summary. Tags (CWE, OWASP, CVE, license classes)
are surfaced verbatim — this script does NOT map one taxonomy to another.
The skill interprets tags per-tool in the presentation phase.

Options:
  --sarif <path>   Path to the SARIF file (REQUIRED).
  --limit <N>      Max findings in the flat list (default ${DEFAULT_FLAT_LIMIT}).
                   Summary counts include all findings regardless.
  -h, --help       Show this help.

Output (stdout):
  {
    "tool": "<tool name from SARIF driver>",
    "summary": {
      "totalFindings": N,
      "bySeverity": { "error": N, "warning": N, ... },
      "byRule": { "<ruleId>": N, ... }
    },
    "byRule": {
      "<ruleId>": [ { ruleId, severity, file, line, message, tags, ... }, ... ]
    },
    "findings": [ { ruleId, severity, file, line, message, tags, ... }, ... ]
  }

Exit codes:
  0  Success.
  1  Unknown / I/O failure.
  2  Invalid arguments, file not found, or malformed SARIF.
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
 * Walk the run's rule lists (`tool.driver.rules` plus any
 * `tool.extensions[].rules`) and build a Map keyed by rule id.
 */
function indexRules(run) {
  const byId = new Map();
  const driverRules = run?.tool?.driver?.rules || [];
  for (const rule of driverRules) {
    if (rule?.id) byId.set(rule.id, rule);
  }
  const extensions = run?.tool?.extensions || [];
  for (const ext of extensions) {
    for (const rule of ext?.rules || []) {
      if (rule?.id && !byId.has(rule.id)) byId.set(rule.id, rule);
    }
  }
  return byId;
}

/**
 * Collect all tags attached to a rule or a result. Returns an array of
 * strings; deduped and sorted. Looks in:
 *   rule.properties.tags
 *   result.properties.tags (some tools — e.g. Semgrep — put tags here)
 */
function collectTags(rule, result) {
  const tags = new Set();
  for (const tag of rule?.properties?.tags || []) tags.add(String(tag));
  for (const tag of result?.properties?.tags || []) tags.add(String(tag));
  return [...tags].sort();
}

function parseSarif({ sarifPath, flatLimit = DEFAULT_FLAT_LIMIT } = {}) {
  if (!sarifPath || typeof sarifPath !== 'string') {
    throw invalidArgs('--sarif is required');
  }
  if (!fs.existsSync(sarifPath)) {
    throw invalidArgs(`SARIF file not found: ${sarifPath}`);
  }
  let raw;
  try {
    raw = fs.readFileSync(sarifPath, 'utf8');
  } catch (err) {
    throw invalidArgs(`Could not read SARIF file: ${err.message}`);
  }
  let sarif;
  try {
    sarif = JSON.parse(raw);
  } catch (err) {
    throw invalidArgs(`SARIF file is not valid JSON: ${err.message}`);
  }

  const findings = [];
  const runs = sarif?.runs || [];
  let toolName = null;

  for (const run of runs) {
    if (!toolName && run?.tool?.driver?.name) toolName = run.tool.driver.name;
    const rulesById = indexRules(run);
    for (const result of run?.results || []) {
      const ruleId = result?.ruleId || result?.rule?.id;
      const rule = ruleId ? rulesById.get(ruleId) : null;
      const location = result?.locations?.[0]?.physicalLocation;
      findings.push({
        ruleId: ruleId || '(unknown)',
        severity: result?.level || 'warning',
        securitySeverity: rule?.properties?.['security-severity'] || null,
        file: location?.artifactLocation?.uri || null,
        line: location?.region?.startLine ?? null,
        column: location?.region?.startColumn ?? null,
        message: result?.message?.text || rule?.shortDescription?.text || '',
        tags: collectTags(rule, result),
      });
    }
  }

  // Summary counts across all findings (not the truncated flat list).
  const bySeverity = {};
  const byRuleCount = {};
  const byRuleDetail = {};
  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
    byRuleCount[f.ruleId] = (byRuleCount[f.ruleId] || 0) + 1;
    if (!byRuleDetail[f.ruleId]) byRuleDetail[f.ruleId] = [];
    byRuleDetail[f.ruleId].push(f);
  }

  // Sort per-rule buckets by severity, then file.
  for (const bucket of Object.values(byRuleDetail)) {
    bucket.sort((a, b) => {
      const sevDiff = (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99);
      if (sevDiff !== 0) return sevDiff;
      return String(a.file || '').localeCompare(String(b.file || ''));
    });
  }

  // Flat list, sorted + truncated. Errors first, then warnings, then notes.
  const flat = findings
    .slice()
    .sort((a, b) => {
      const sevDiff = (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99);
      if (sevDiff !== 0) return sevDiff;
      return String(a.file || '').localeCompare(String(b.file || ''));
    })
    .slice(0, flatLimit);

  return {
    tool: toolName || 'unknown',
    summary: {
      totalFindings: findings.length,
      bySeverity,
      byRule: byRuleCount,
    },
    byRule: byRuleDetail,
    findings: flat,
  };
}

function parseCli(argv) {
  const options = {
    sarif: { type: 'string' },
    limit: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  };
  return parseArgs({ args: argv.slice(2), options, strict: true }).values;
}

function main() {
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
    let flatLimit = DEFAULT_FLAT_LIMIT;
    if (args.limit !== undefined) {
      flatLimit = Number.parseInt(args.limit, 10);
      if (!Number.isFinite(flatLimit) || flatLimit <= 0) {
        throw invalidArgs(`--limit must be a positive integer (got: ${args.limit})`);
      }
    }
    const result = parseSarif({ sarifPath: args.sarif, flatLimit });
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
  parseSarif,
  indexRules,
  collectTags,
  DEFAULT_FLAT_LIMIT,
  EXIT,
};
