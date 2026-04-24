#!/usr/bin/env node

// waf.js — Power Pages Web Application Firewall commands.
//
// Six modes:
//   --status                          Read current WAF status
//   --rules [--ruleType X]            Read current rule configuration
//   --enable                          Enable WAF (async)
//   --disable                         Disable WAF (async)
//   --create-rules --body <file>      Create/update rules (sync)
//   --delete-custom --names <file>    Delete custom rules by name (async)
//
// All write modes support --dry-run (validates locally without calling
// the service). Async modes (enable / disable / delete-custom) return
// { "accepted": true, "operation_location": "...", "retry_after_seconds": N }
// on acceptance; callers poll the paired read command for completion.
//
// CLI usage:
//   node waf.js --<mode> --portalId <guid> [mode flags] [--dry-run]
//   node waf.js --help

const fs = require('node:fs');
const { parseArgs } = require('node:util');
const { callAdminApi } = require('../../../scripts/lib/admin-api');

// Exit codes — documented in --help and in the skill's references/commands.md.
const EXIT = Object.freeze({
  OK: 0,
  UNKNOWN: 1,            // transport / unknown failure after retries (incl. 401/403)
  INVALID_ARGS: 2,       // bad or missing CLI flags / body
  NOT_FOUND: 3,          // A001
  NO_INFRASTRUCTURE: 4,  // B001
  IN_PROGRESS: 5,        // B003
  REGION_BLOCKED: 6,     // B022
  TRIAL_BLOCKED: 7,      // B023
  // A019 / A033 — caller-config issue (portal id not a GUID, or tenant
  // mismatch). Distinct from A010 (service rejected body) and exit 2
  // (local CLI args).
  CALLER_CONFIG: 8,
});

// Note: A010 stays on exit 2. A010 cannot fire pre-send because the local
// body validator catches malformed shapes first; when the service returns
// A010 it's still a body-schema reject, which is the same user-visible
// category as "invalid body file" (exit 2).
const CATALOGUED_EXIT = Object.freeze({
  A001: EXIT.NOT_FOUND,
  A010: EXIT.INVALID_ARGS,
  A019: EXIT.CALLER_CONFIG,
  A033: EXIT.CALLER_CONFIG,
  B001: EXIT.NO_INFRASTRUCTURE,
  B003: EXIT.IN_PROGRESS,
  B022: EXIT.REGION_BLOCKED,
  B023: EXIT.TRIAL_BLOCKED,
});

const VALID_RULE_TYPES = new Set(['Custom', 'Managed']);
const VALID_CUSTOM_RULE_TYPES = new Set(['MatchRule', 'RateLimitRule']);
const VALID_CUSTOM_RULE_ACTIONS = new Set(['Allow', 'Block', 'Log', 'Redirect']);
const VALID_MANAGED_RULE_SET_ACTIONS = new Set(['Block', 'Log', 'Redirect']);
const VALID_MATCH_VARIABLES = new Set([
  'RemoteAddr',
  'RequestMethod',
  'QueryString',
  'PostArgs',
  'RequestUri',
  'RequestHeader',
  'RequestBody',
  'Cookies',
  'SocketAddr',
]);
const VALID_MATCH_OPERATORS = new Set([
  'Any',
  'IPMatch',
  'GeoMatch',
  'Equal',
  'Contains',
  'LessThan',
  'GreaterThan',
  'LessThanOrEqual',
  'GreaterThanOrEqual',
  'BeginsWith',
  'EndsWith',
  'RegEx',
]);
// Reference set of documented Exclusions[].selectorMatchOperator values
// (mirrors the Azure Front Door ManagedRuleExclusionSelectorMatchOperator
// enum). Kept for documentation; the validator does NOT reject unknown
// values — Microsoft may add new operators over time, so the strict
// checks are limited to required-non-empty-string shape.
const KNOWN_EXCLUSION_SELECTOR_OPERATORS = new Set([
  'Equals',
  'EqualsAny',
  'Contains',
  'StartsWith',
  'EndsWith',
]);
// Reference set of documented Exclusions[].matchVariable values. Same
// "allow-through unknowns" policy as the operator set above.
const KNOWN_EXCLUSION_MATCH_VARIABLES = new Set([
  'RequestHeaderNames',
  'RequestCookieNames',
  'QueryStringArgNames',
  'RequestBodyPostArgNames',
  'RequestBodyJsonArgNames',
]);
const RATE_LIMIT_WINDOW_MIN_MINUTES = 1;
const RATE_LIMIT_WINDOW_MAX_MINUTES = 5;
// Lowest priority value accepted for a user-defined custom rule. Values
// at or below this are reserved for platform-managed rules; service rejects
// user rules with priority <= this bound.
const CUSTOM_RULE_MIN_PRIORITY = 11;

// Codes that represent "WAF is not applicable to this site" — trial portal
// or region without the feature. The read commands normalize these to null
// instead of throwing.
const WAF_UNAVAILABLE_CODES = new Set(['B022', 'B023']);

// Default polling interval when the service does not include Retry-After.
const DEFAULT_RETRY_AFTER_SECONDS = 60;

const HELP = `Usage:
  waf.js --<mode> --portalId <guid> [mode flags] [--dry-run]
  waf.js --help

Modes:
  --status                                 Read current WAF status.
  --rules [--ruleType <Custom|Managed>]    Read current rule configuration.
  --enable                                 Enable WAF on this site (async).
  --disable                                Disable WAF on this site (async).
  --create-rules --body <file>             Create or update rule collection.
  --delete-custom --names <file>           Remove named custom rules (async).

Common flags:
  --portalId <guid>                        Power Pages portal id (REQUIRED).
                                           Resolve via scripts/lib/website.js
                                           first — NOT the website record id.
  --dry-run                                For writes: validate locally and
                                           print the intended call; skip the
                                           network request.
  -h, --help                               Show this help.

Output:
  stdout  JSON result on success. Shapes:
          --status     JSON string — one of Created, Creating, None,
                       CreationFailed, Deleting, DeletionFailed — or null
                       when WAF is not applicable (trial / region-blocked).
          --rules      Without --ruleType: { ManagedRules, CustomRules }.
                       --ruleType Custom: array of custom rule objects.
                       --ruleType Managed: array of managed rule set
                       definition objects. null when not applicable.
          --create-rules  On success: { ManagedRules, CustomRules } echoing
                       the stored rule set.
          --enable / --disable / --delete-custom — async acceptance shape:
                       { "accepted": true, "operation_location": "...",
                         "retry_after_seconds": N }. Already-in-progress
                       returns { "accepted": false, "alreadyOngoing": true }.
  stderr  Diagnostics, transient-retry notices, and catalogued service
          error codes (A001 / A010 / B001 / B003 / B022 / B023) when
          applicable.

Exit codes:
  0  Success.
  1  Unknown or transport failure (includes HTTP 401/403 for non-admin).
  2  Invalid or missing CLI arguments, or invalid body file (A010).
  3  Portal not found (A001).
  4  Edge infrastructure missing for this site (B001).
  5  Another WAF operation is in progress (B003).
  6  WAF not available in this region (B022).
  7  Trial portal — WAF requires a production site (B023).
  8  Caller-config issue — portal id not a GUID (A019) or tenant
     mismatch (A033). Distinct from exit 2 (local arg / body).
`;

/**
 * Extract a catalogued service error code from a parsed response body.
 * The service uses a JSON envelope for most errors but returns plain-text
 * bodies for the region-unsupported / trial-unsupported 400 paths on the
 * status read. Handle both shapes.
 *
 * Region-unsupported plain-text phrase:
 *   "Power Pages built-in WAF feature is not supported in <region> region."
 * Trial-unsupported plain-text phrase:
 *   "WAF is not supported for trial portals. Convert your trial portal
 *    to a production portal to use this feature."
 */
function extractErrorCode(body) {
  if (body && typeof body === 'object') {
    return (
      body.errorCode ||
      body.code ||
      (body.error && (body.error.code || body.error.errorCode)) ||
      null
    );
  }
  if (typeof body === 'string') {
    const lower = body.toLowerCase();
    if (lower.includes('trial portal')) return 'B023';
    if (lower.includes('not supported') || lower.includes('not available')) return 'B022';
  }
  return null;
}

function isWafUnavailable(res) {
  if (res.statusCode !== 400) return false;
  const code = extractErrorCode(res.body);
  return code != null && WAF_UNAVAILABLE_CODES.has(code);
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

/**
 * Extract async-handoff info from a 202 response. Callers must request
 * headers explicitly (via `includeHeaders: true`) — when a header is
 * absent we fall back to DEFAULT_RETRY_AFTER_SECONDS / null.
 */
function extractAsyncHandoff(res) {
  const headers = res.headers || {};
  const opLocation = headers['operation-location'] || headers['Operation-Location'] || null;
  const retryAfterRaw = headers['retry-after'] || headers['Retry-After'];
  const retryAfter = Number(retryAfterRaw);
  return {
    operation_location: opLocation,
    retry_after_seconds: Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter
      : DEFAULT_RETRY_AFTER_SECONDS,
  };
}

// ===== Public API functions =====

/**
 * Read current WAF status. Returns null when WAF is not applicable to the
 * site (trial portal or region-blocked).
 */
async function getWafStatus({ portalId, environmentId, cloud, deps } = {}) {
  requirePortalId(portalId);
  const res = await callAdminApi({
    method: 'GET',
    operation: 'getWafStatus',
    portalId,
    environmentId,
    cloud,
    deps,
  });
  if (isWafUnavailable(res)) return null;
  throwWithCode('getWafStatus', res);
  return res.body;
}

/**
 * Read current rule configuration. Optional ruleType filter narrows to
 * Custom or Managed. Returns null when WAF is not applicable.
 */
async function getWafRules({ portalId, ruleType, environmentId, cloud, deps } = {}) {
  requirePortalId(portalId);
  if (ruleType !== undefined && !VALID_RULE_TYPES.has(ruleType)) {
    throw invalidArgs(
      `--ruleType must be one of ${[...VALID_RULE_TYPES].join(', ')} (got: ${ruleType})`,
    );
  }
  const res = await callAdminApi({
    method: 'GET',
    operation: 'getWafRules',
    portalId,
    environmentId,
    cloud,
    extraQuery: ruleType ? { ruleType } : undefined,
    deps,
  });
  if (isWafUnavailable(res)) return null;
  throwWithCode('getWafRules', res);
  return res.body;
}

async function enableWaf(options) {
  return toggleWaf('enableWaf', options);
}

async function disableWaf(options) {
  return toggleWaf('disableWaf', options);
}

async function toggleWaf(operation, { portalId, environmentId, cloud, deps } = {}) {
  requirePortalId(portalId);
  const res = await callAdminApi({
    method: 'POST',
    operation,
    portalId,
    environmentId,
    cloud,
    includeHeaders: true,
    deps,
  });
  if (res.statusCode === 409) {
    return { accepted: false, alreadyOngoing: true };
  }
  if (res.statusCode === 202) {
    return { accepted: true, ...extractAsyncHandoff(res) };
  }
  // B003 can also surface as HTTP 400 with the catalogued code. Normalize
  // both paths (409 and 400+B003) to the same alreadyOngoing shape so
  // callers see identical output regardless of which the service picked.
  if (res.statusCode >= 400 && extractErrorCode(res.body) === 'B003') {
    return { accepted: false, alreadyOngoing: true };
  }
  throwWithCode(operation, res);
  // Non-standard success (e.g. 200 with empty body) — treat as accepted.
  return { accepted: true };
}

async function createWafRules({ portalId, body, environmentId, cloud, deps } = {}) {
  requirePortalId(portalId);
  const validationError = validateCreateRulesBody(body);
  if (validationError) {
    throw invalidArgs(`Body validation failed: ${validationError}`);
  }
  const res = await callAdminApi({
    method: 'PUT',
    operation: 'createWafRules',
    portalId,
    environmentId,
    cloud,
    body,
    deps,
  });
  throwWithCode('createWafRules', res);
  return res.body;
}

async function deleteWafCustomRules({ portalId, ruleNames, environmentId, cloud, deps } = {}) {
  requirePortalId(portalId);
  const validationError = validateNamesList(ruleNames);
  if (validationError) {
    throw invalidArgs(validationError);
  }
  const res = await callAdminApi({
    method: 'PUT',
    operation: 'deleteWafCustomRules',
    portalId,
    environmentId,
    cloud,
    body: ruleNames,
    includeHeaders: true,
    deps,
  });
  if (res.statusCode === 202) {
    // deleteWafCustomRules only emits Operation-Location (no Retry-After);
    // the polling interval falls back to the shared default.
    return { accepted: true, ...extractAsyncHandoff(res) };
  }
  throwWithCode('deleteWafCustomRules', res);
  return { accepted: true };
}

// ===== Local validation helpers =====

/**
 * Validate the body passed to --create-rules. Returns an error message
 * string on failure, or null on success. Checks structure, enum values,
 * unique names, unique priorities, and rate-limit window range.
 */
function validateCreateRulesBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Body must be a JSON object with CustomRules and/or ManagedRules arrays';
  }
  const customRules = body.CustomRules;
  const managedRules = body.ManagedRules;
  const hasCustom = Array.isArray(customRules) && customRules.length > 0;
  const hasManaged = Array.isArray(managedRules) && managedRules.length > 0;
  if (!hasCustom && !hasManaged) {
    return 'Body must contain at least one of CustomRules or ManagedRules (non-empty array)';
  }

  if (customRules !== undefined && !Array.isArray(customRules)) {
    return 'CustomRules must be an array';
  }
  if (managedRules !== undefined && !Array.isArray(managedRules)) {
    return 'ManagedRules must be an array';
  }

  const seenNames = new Set();
  const seenPriorities = new Map();
  for (const rule of customRules || []) {
    if (!rule || typeof rule !== 'object') {
      return 'Every custom rule must be an object';
    }
    if (typeof rule.name !== 'string' || rule.name.length === 0) {
      return 'Every custom rule must have a non-empty name';
    }
    if (seenNames.has(rule.name)) {
      return `Duplicate custom rule name: ${rule.name}`;
    }
    seenNames.add(rule.name);
    if (!Number.isInteger(rule.priority)) {
      return `Custom rule "${rule.name}": priority is required and must be an integer`;
    }
    if (rule.priority < CUSTOM_RULE_MIN_PRIORITY) {
      return `Custom rule "${rule.name}": priority must be >= ${CUSTOM_RULE_MIN_PRIORITY} (lower values are reserved for platform-managed rules)`;
    }
    if (seenPriorities.has(rule.priority)) {
      return `Duplicate priority ${rule.priority} between "${seenPriorities.get(rule.priority)}" and "${rule.name}"`;
    }
    seenPriorities.set(rule.priority, rule.name);
    if (!VALID_CUSTOM_RULE_TYPES.has(rule.ruleType)) {
      return `Custom rule "${rule.name}": ruleType must be one of ${[...VALID_CUSTOM_RULE_TYPES].join(', ')}`;
    }
    if (!VALID_CUSTOM_RULE_ACTIONS.has(rule.action)) {
      return `Custom rule "${rule.name}": action must be one of ${[...VALID_CUSTOM_RULE_ACTIONS].join(', ')}`;
    }
    if (rule.ruleType === 'MatchRule') {
      if (!Array.isArray(rule.matchConditions) || rule.matchConditions.length === 0) {
        return `Custom rule "${rule.name}": MatchRule requires at least one matchCondition`;
      }
      for (let i = 0; i < rule.matchConditions.length; i++) {
        const condErr = validateMatchCondition(rule.name, i, rule.matchConditions[i]);
        if (condErr) return condErr;
      }
    }
    if (rule.ruleType === 'RateLimitRule') {
      if (!Number.isInteger(rule.rateLimitThreshold) || rule.rateLimitThreshold < 1) {
        return `Custom rule "${rule.name}": RateLimitRule requires rateLimitThreshold as a positive integer`;
      }
      const window = rule.rateLimitDurationInMinutes;
      if (!Number.isInteger(window) || window < RATE_LIMIT_WINDOW_MIN_MINUTES || window > RATE_LIMIT_WINDOW_MAX_MINUTES) {
        return `Custom rule "${rule.name}": rateLimitDurationInMinutes must be ${RATE_LIMIT_WINDOW_MIN_MINUTES}-${RATE_LIMIT_WINDOW_MAX_MINUTES} (got ${window})`;
      }
    }
  }

  for (const managed of managedRules || []) {
    if (!managed || typeof managed !== 'object') {
      return 'Every managed rule must be an object';
    }
    if (typeof managed.RuleSetType !== 'string' || managed.RuleSetType.length === 0) {
      return 'Every managed rule requires RuleSetType';
    }
    if (typeof managed.RuleSetVersion !== 'string' || managed.RuleSetVersion.length === 0) {
      return 'Every managed rule requires RuleSetVersion';
    }
    if (typeof managed.RuleSetAction !== 'string' || managed.RuleSetAction.length === 0) {
      return 'Every managed rule requires RuleSetAction';
    }
    if (!VALID_MANAGED_RULE_SET_ACTIONS.has(managed.RuleSetAction)) {
      return `Managed rule set "${managed.RuleSetType}": RuleSetAction must be one of ${[...VALID_MANAGED_RULE_SET_ACTIONS].join(', ')}`;
    }
    // Rule-set-level Exclusions (applied to every rule in the set).
    const ruleSetExclusionsErr = validateExclusions(
      managed.Exclusions,
      `Managed rule set "${managed.RuleSetType}"`,
    );
    if (ruleSetExclusionsErr) return ruleSetExclusionsErr;

    if (managed.RuleGroupOverrides !== undefined && !Array.isArray(managed.RuleGroupOverrides)) {
      return `Managed rule set "${managed.RuleSetType}": RuleGroupOverrides must be an array when provided`;
    }
    for (const group of managed.RuleGroupOverrides || []) {
      if (!group || typeof group !== 'object') {
        return `Managed rule set "${managed.RuleSetType}": every RuleGroupOverride must be an object`;
      }
      if (typeof group.RuleGroupName !== 'string' || group.RuleGroupName.length === 0) {
        return `Managed rule set "${managed.RuleSetType}": RuleGroupOverride requires RuleGroupName`;
      }
      // Rule-group-level Exclusions (applied to every rule in this group).
      const groupExclusionsErr = validateExclusions(
        group.Exclusions,
        `Managed rule set "${managed.RuleSetType}": RuleGroupOverride "${group.RuleGroupName}"`,
      );
      if (groupExclusionsErr) return groupExclusionsErr;

      if (group.Rules !== undefined && !Array.isArray(group.Rules)) {
        return `Managed rule set "${managed.RuleSetType}": RuleGroupOverride "${group.RuleGroupName}": Rules must be an array when provided`;
      }
      for (const override of group.Rules || []) {
        if (!override || typeof override !== 'object') {
          return `Managed rule set "${managed.RuleSetType}": RuleGroupOverride "${group.RuleGroupName}": every override must be an object`;
        }
        if (typeof override.RuleId !== 'string' || override.RuleId.length === 0) {
          return `Managed rule set "${managed.RuleSetType}": override requires RuleId`;
        }
        if (override.EnabledState !== undefined && override.EnabledState !== 'Enabled' && override.EnabledState !== 'Disabled') {
          return `Managed rule set "${managed.RuleSetType}": override "${override.RuleId}": EnabledState must be Enabled or Disabled`;
        }
        if (override.Action !== undefined && !VALID_CUSTOM_RULE_ACTIONS.has(override.Action)) {
          return `Managed rule set "${managed.RuleSetType}": override "${override.RuleId}": Action must be one of ${[...VALID_CUSTOM_RULE_ACTIONS].join(', ')}`;
        }
        // Rule-override-level Exclusions (scoped to this single rule).
        const overrideExclusionsErr = validateExclusions(
          override.Exclusions,
          `Managed rule set "${managed.RuleSetType}": RuleGroupOverride "${group.RuleGroupName}": override "${override.RuleId}"`,
        );
        if (overrideExclusionsErr) return overrideExclusionsErr;
      }
    }
  }

  return null;
}

/**
 * Validate an Exclusions array attached to a rule-set, rule-group, or
 * individual rule override. Exclusions is optional at every level; when
 * present it must be an array of objects where matchVariable,
 * selectorMatchOperator, and selector are all required non-empty strings.
 * Unknown matchVariable / selectorMatchOperator values are allowed through
 * (Microsoft may add new ones); only shape is enforced locally.
 *
 * Returns an error message string on failure, or null on success /
 * when exclusions is undefined.
 */
function validateExclusions(exclusions, contextLabel) {
  if (exclusions === undefined) return null;
  if (!Array.isArray(exclusions)) {
    return `${contextLabel}: Exclusions must be an array when provided`;
  }
  for (let i = 0; i < exclusions.length; i++) {
    const ex = exclusions[i];
    if (!ex || typeof ex !== 'object' || Array.isArray(ex)) {
      return `${contextLabel}: Exclusions[${i}] must be an object`;
    }
    if (typeof ex.matchVariable !== 'string' || ex.matchVariable.length === 0) {
      return `${contextLabel}: Exclusions[${i}] requires matchVariable as a non-empty string`;
    }
    if (typeof ex.selectorMatchOperator !== 'string' || ex.selectorMatchOperator.length === 0) {
      return `${contextLabel}: Exclusions[${i}] requires selectorMatchOperator as a non-empty string`;
    }
    if (typeof ex.selector !== 'string' || ex.selector.length === 0) {
      return `${contextLabel}: Exclusions[${i}] requires selector as a non-empty string`;
    }
  }
  return null;
}

/**
 * Validate a single match condition object inside a MatchRule's
 * matchConditions array. Returns an error message string or null.
 */
function validateMatchCondition(ruleName, index, cond) {
  if (!cond || typeof cond !== 'object') {
    return `Custom rule "${ruleName}" matchConditions[${index}]: must be an object`;
  }
  if (!VALID_MATCH_VARIABLES.has(cond.matchVariable)) {
    return `Custom rule "${ruleName}" matchConditions[${index}]: matchVariable must be one of ${[...VALID_MATCH_VARIABLES].join(', ')}`;
  }
  if (!VALID_MATCH_OPERATORS.has(cond.operator)) {
    return `Custom rule "${ruleName}" matchConditions[${index}]: operator must be one of ${[...VALID_MATCH_OPERATORS].join(', ')}`;
  }
  if (!Array.isArray(cond.matchValue) || cond.matchValue.length === 0) {
    return `Custom rule "${ruleName}" matchConditions[${index}]: matchValue must be a non-empty array of strings`;
  }
  for (const v of cond.matchValue) {
    if (typeof v !== 'string') {
      return `Custom rule "${ruleName}" matchConditions[${index}]: matchValue entries must be strings`;
    }
  }
  if (cond.negateCondition !== undefined && typeof cond.negateCondition !== 'boolean') {
    return `Custom rule "${ruleName}" matchConditions[${index}]: negateCondition must be a boolean when provided`;
  }
  if (cond.transforms !== undefined) {
    if (!Array.isArray(cond.transforms)) {
      return `Custom rule "${ruleName}" matchConditions[${index}]: transforms must be an array of strings when provided`;
    }
    for (const t of cond.transforms) {
      if (typeof t !== 'string') {
        return `Custom rule "${ruleName}" matchConditions[${index}]: transforms entries must be strings`;
      }
    }
  }
  return null;
}

/**
 * Validate the array passed to --delete-custom. Returns an error message
 * string on failure, or null on success.
 */
function validateNamesList(ruleNames) {
  if (!Array.isArray(ruleNames) || ruleNames.length === 0) {
    return '--names must be a non-empty JSON array of rule names';
  }
  for (const name of ruleNames) {
    if (typeof name !== 'string' || name.length === 0) {
      return `Each rule name must be a non-empty string (got: ${JSON.stringify(name)})`;
    }
  }
  return null;
}

function readJsonFile(path) {
  if (!fs.existsSync(path)) {
    throw invalidArgs(`File not found: ${path}`);
  }
  let raw;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch (e) {
    throw invalidArgs(`Could not read ${path}: ${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw invalidArgs(`Invalid JSON in ${path}: ${e.message}`);
  }
}

// ===== CLI wiring =====

function parseCli(argv) {
  const options = {
    status: { type: 'boolean' },
    rules: { type: 'boolean' },
    enable: { type: 'boolean' },
    disable: { type: 'boolean' },
    'create-rules': { type: 'boolean' },
    'delete-custom': { type: 'boolean' },
    portalId: { type: 'string' },
    ruleType: { type: 'string' },
    body: { type: 'string' },
    names: { type: 'string' },
    'dry-run': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  };
  return parseArgs({ args: argv.slice(2), options, strict: true }).values;
}

function pickMode(args) {
  const modes = [
    args.status && 'status',
    args.rules && 'rules',
    args.enable && 'enable',
    args.disable && 'disable',
    args['create-rules'] && 'create-rules',
    args['delete-custom'] && 'delete-custom',
  ].filter(Boolean);
  if (modes.length === 0) return null;
  if (modes.length > 1) return { error: `Multiple mode flags set: ${modes.join(', ')} — pick exactly one` };
  return { mode: modes[0] };
}

async function runMode(mode, args) {
  switch (mode) {
    case 'status':
      return getWafStatus({ portalId: args.portalId });

    case 'rules':
      return getWafRules({ portalId: args.portalId, ruleType: args.ruleType });

    case 'enable':
      if (args['dry-run']) {
        requirePortalId(args.portalId);
        return { dryRun: true, operation: 'enableWaf', portalId: args.portalId };
      }
      return enableWaf({ portalId: args.portalId });

    case 'disable':
      if (args['dry-run']) {
        requirePortalId(args.portalId);
        return { dryRun: true, operation: 'disableWaf', portalId: args.portalId };
      }
      return disableWaf({ portalId: args.portalId });

    case 'create-rules': {
      if (!args.body) throw invalidArgs('--create-rules requires --body <file>');
      const body = readJsonFile(args.body);
      const validationError = validateCreateRulesBody(body);
      if (validationError) throw invalidArgs(`Body validation failed: ${validationError}`);
      if (args['dry-run']) {
        requirePortalId(args.portalId);
        return { dryRun: true, operation: 'createWafRules', portalId: args.portalId, body };
      }
      return createWafRules({ portalId: args.portalId, body });
    }

    case 'delete-custom': {
      if (!args.names) throw invalidArgs('--delete-custom requires --names <file>');
      const ruleNames = readJsonFile(args.names);
      const validationError = validateNamesList(ruleNames);
      if (validationError) throw invalidArgs(validationError);
      if (args['dry-run']) {
        requirePortalId(args.portalId);
        return { dryRun: true, operation: 'deleteWafCustomRules', portalId: args.portalId, ruleNames };
      }
      return deleteWafCustomRules({ portalId: args.portalId, ruleNames });
    }

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
      `Missing mode flag — pick one of --status, --rules, --enable, --disable, --create-rules, --delete-custom.\n\n${HELP}`,
    );
    return;
  }
  if (pick.error) {
    exitWithMessage(EXIT.INVALID_ARGS, `${pick.error}\n\n${HELP}`);
    return;
  }

  try {
    const result = await runMode(pick.mode, args);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    const exitCode = err.code === 'INVALID_ARGS'
      ? EXIT.INVALID_ARGS
      : CATALOGUED_EXIT[err.code] ?? EXIT.UNKNOWN;
    exitWithMessage(exitCode, err.stack || err.message);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  getWafStatus,
  getWafRules,
  enableWaf,
  disableWaf,
  createWafRules,
  deleteWafCustomRules,
  extractErrorCode,
  isWafUnavailable,
  validateCreateRulesBody,
  validateMatchCondition,
  validateExclusions,
  validateNamesList,
  VALID_RULE_TYPES,
  VALID_CUSTOM_RULE_TYPES,
  VALID_CUSTOM_RULE_ACTIONS,
  VALID_MANAGED_RULE_SET_ACTIONS,
  VALID_MATCH_VARIABLES,
  VALID_MATCH_OPERATORS,
  KNOWN_EXCLUSION_SELECTOR_OPERATORS,
  KNOWN_EXCLUSION_MATCH_VARIABLES,
  CUSTOM_RULE_MIN_PRIORITY,
  EXIT,
  CATALOGUED_EXIT,
};
