#!/usr/bin/env node

// security-headers.js — manage HTTP security header site-settings for a
// Power Pages code site.
//
// HTTP header site-settings are Dataverse site-setting records whose name
// starts with `HTTP/`. In code sites they materialize as YAML files under
// `.powerpages-site/site-settings/`. This script is FILE-based — it writes
// the YAML; `/deploy-site` pushes changes to Dataverse on the next deploy.
//
// Three modes:
//   --audit    Read every HTTP/* site-setting; categorize as recognized,
//              custom, or forbidden (attempting a Power Pages-managed header).
//   --write    Create or update a single HTTP/* site-setting. Preserves the
//              existing YAML id when updating.
//   --remove   Delete an HTTP/* site-setting's YAML file. No-op if absent.
//
// All write operations support --dry-run.
//
// CLI usage:
//   node security-headers.js --audit  --projectRoot <path>
//   node security-headers.js --write  --projectRoot <path> --name HTTP/<Header> --value <v> --description <d> [--dry-run]
//   node security-headers.js --remove --projectRoot <path> --name HTTP/<Header> [--dry-run]
//   node security-headers.js --help

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const generateUuid = require('../../../scripts/generate-uuid');
const { loadSiteSettings, SITE_SETTING_FILE_SUFFIX } = require('../../../scripts/lib/powerpages-config');

// Exit codes — documented in --help and in the skill's references/headers.md.
const EXIT = Object.freeze({
  OK: 0,
  UNKNOWN: 1,          // I/O failure, YAML parse error, etc.
  INVALID_ARGS: 2,     // bad / missing CLI flags
  FORBIDDEN: 3,        // attempted to write/remove a Power Pages-managed header
  NO_SITE_SETTINGS: 4, // .powerpages-site/site-settings/ missing
});

// Full catalogue of HTTP/* site-setting names the Power Pages runtime
// recognizes and emits as response headers. Settings outside this list are
// also emitted as-is by the runtime; the audit flags them as `custom` so
// the author can spot typos or confirm the non-standard name was intentional.
const RECOGNIZED_HTTP_HEADER_NAMES = Object.freeze([
  // CSP
  'HTTP/Content-Security-Policy',
  'HTTP/Content-Security-Policy-Report-Only',
  'HTTP/Content-Security-Policy/Inject-unsafe-eval', // boolean flag, not a header
  // CORS
  'HTTP/Access-Control-Allow-Origin',
  'HTTP/Access-Control-Allow-Credentials',
  'HTTP/Access-Control-Allow-Headers',
  'HTTP/Access-Control-Allow-Methods',
  'HTTP/Access-Control-Expose-Headers',
  'HTTP/Access-Control-Max-Age',
  // Clickjacking / framing
  'HTTP/X-Frame-Options',
  // MIME sniffing / download protections
  'HTTP/X-Content-Type-Options',
  'HTTP/X-Download-Options',
  'HTTP/X-Permitted-Cross-Domain-Policies',
  // Cross-origin isolation
  'HTTP/Cross-Origin-Resource-Policy',
  'HTTP/Cross-Origin-Opener-Policy',
  'HTTP/Cross-Origin-Embedder-Policy',
  // Referrer / permissions / privacy
  'HTTP/Referrer-Policy',
  'HTTP/Permissions-Policy',
  'HTTP/X-DNS-Prefetch-Control',
  'HTTP/X-XSS-Protection',
  // Cookies — global default
  'HTTP/SameSite/Default',
]);

// Prefix-based names where a dynamic segment (e.g. cookie name) follows.
// Any setting whose name starts with one of these prefixes is considered
// recognized even though it isn't in the exact-match list above.
const RECOGNIZED_HTTP_HEADER_PREFIXES = Object.freeze([
  'HTTP/SameSite/', // per-cookie SameSite overrides: HTTP/SameSite/<cookie-name>
]);

// Headers Power Pages owns and emits unconditionally. Attempting to set
// these via site settings is a configuration error — Power Pages ignores
// the setting and the maker's intent is never honored.
const FORBIDDEN_HTTP_HEADER_NAMES = Object.freeze(new Set([
  'HTTP/Strict-Transport-Security',
]));

const HELP = `Usage:
  security-headers.js --audit  --projectRoot <path>
  security-headers.js --write  --projectRoot <path> --name HTTP/<Header> \\
                                --value <value> --description <description> \\
                                [--dry-run]
  security-headers.js --remove --projectRoot <path> --name HTTP/<Header> \\
                                [--dry-run]
  security-headers.js --help

Manages HTTP security header site-settings (YAML files under
.powerpages-site/site-settings/). Deployment to Dataverse happens downstream
via /deploy-site.

Modes:
  --audit   Read every HTTP/* site-setting and categorize them. Output JSON
            includes arrays: present (known and custom), missing (known names
            not on disk), and forbidden (Power Pages-managed headers that should
            not be in site settings).
  --write   Create or update a single HTTP/* site-setting. Preserves the
            existing YAML id when updating.
  --remove  Delete an HTTP/* site-setting's YAML file. Idempotent — removing
            a setting that does not exist returns { "removed": false }.

Common flags:
  --projectRoot <path>   The Power Pages code-site directory. Must contain
                         .powerpages-site/site-settings/.
  --name HTTP/<Header>   The site-setting name. Power Pages-managed headers
                         (Strict-Transport-Security) are rejected.
  --value <value>        Header value. Empty string allowed.
  --description <text>   Human-readable description. Shown in Dataverse UI.
  --dry-run              For write / remove: validate locally, skip the
                         file operation.
  -h, --help             Show this help.

Output:
  stdout  JSON result. Audit returns { present, missing, forbidden };
          write returns { filePath, id, updated }; remove returns
          { filePath, removed }.
  stderr  Diagnostics.

Exit codes:
  0  Success.
  1  Unknown or I/O failure.
  2  Invalid or missing CLI arguments.
  3  Forbidden header — Power Pages owns this header and refuses to
     let site settings override it (Strict-Transport-Security).
  4  .powerpages-site/site-settings/ is missing. Run /deploy-site first.
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

function isRecognizedHttpHeader(name) {
  if (RECOGNIZED_HTTP_HEADER_NAMES.includes(name)) return true;
  return RECOGNIZED_HTTP_HEADER_PREFIXES.some((p) => name.startsWith(p) && name.length > p.length);
}

function siteSettingsDir(projectRoot) {
  return path.join(projectRoot, '.powerpages-site', 'site-settings');
}

function siteSettingFileName(settingName) {
  // `/` is not a filename-safe character — replace with `-` for the on-disk name.
  return `${settingName.replace(/\//g, '-')}${SITE_SETTING_FILE_SUFFIX}`;
}

function writeYaml(fields) {
  // Keys sorted alphabetically so the on-disk file is stable / diff-friendly.
  const keys = Object.keys(fields).sort();
  return keys.map((k) => `${k}: ${fields[k]}`).join('\n') + '\n';
}

function requireProjectRoot(projectRoot) {
  if (!projectRoot || typeof projectRoot !== 'string') {
    throw invalidArgs('--projectRoot is required');
  }
}

function requireSiteSettingsDir(projectRoot) {
  const dir = siteSettingsDir(projectRoot);
  if (!fs.existsSync(dir)) {
    const err = new Error(
      `Site settings directory not found at ${dir}. Run /deploy-site first to deploy the code site.`,
    );
    err.code = 'NO_SITE_SETTINGS';
    throw err;
  }
  return dir;
}

function requireWritableName(name) {
  if (!name || typeof name !== 'string') {
    throw invalidArgs('--name is required');
  }
  if (!name.startsWith('HTTP/')) {
    throw invalidArgs(`--name must start with "HTTP/" (got: ${name})`);
  }
  if (FORBIDDEN_HTTP_HEADER_NAMES.has(name)) {
    const err = new Error(
      `${name} is managed by the Power Pages runtime and cannot be written via site settings.`,
    );
    err.code = 'FORBIDDEN';
    throw err;
  }
}

// ===== Public API =====

/**
 * Read every HTTP/* site-setting on disk and categorize.
 *
 * @returns {{
 *   present: Array<{ name: string, value: string, custom?: boolean }>,
 *   missing: string[],
 *   forbidden: Array<{ name: string, filePath: string }>
 * }}
 */
function auditSiteHeaders(projectRoot) {
  requireProjectRoot(projectRoot);
  const dir = requireSiteSettingsDir(projectRoot);
  const settings = loadSiteSettings(dir);

  const present = [];
  const forbidden = [];
  const byName = new Map();

  for (const setting of settings) {
    if (typeof setting.name !== 'string' || !setting.name.toLowerCase().startsWith('http/')) continue;
    byName.set(setting.name, setting);
    if (FORBIDDEN_HTTP_HEADER_NAMES.has(setting.name)) {
      forbidden.push({ name: setting.name, filePath: setting.filePath || null });
      continue;
    }
    const entry = { name: setting.name, value: setting.value };
    if (!isRecognizedHttpHeader(setting.name)) {
      entry.custom = true;
    }
    present.push(entry);
  }

  const missing = [];
  for (const name of RECOGNIZED_HTTP_HEADER_NAMES) {
    if (!byName.has(name)) missing.push(name);
  }

  return { present, missing, forbidden };
}

/**
 * Create or update a single HTTP/* site-setting. Preserves id on update.
 *
 * @returns {{ filePath: string, id: string, updated: boolean }}
 */
function writeSiteHeader({
  projectRoot,
  name,
  value,
  description,
  dryRun = false,
  uuidFn = generateUuid,
  fsImpl = fs,
} = {}) {
  requireProjectRoot(projectRoot);
  requireWritableName(name);
  if (value === undefined || value === null) {
    throw invalidArgs('--value is required (empty string is allowed)');
  }
  if (!description) {
    throw invalidArgs('--description is required');
  }
  const dir = requireSiteSettingsDir(projectRoot);

  const existing = loadSiteSettings(dir);
  const existingSetting = existing.find(
    (s) => typeof s.name === 'string' && s.name.toLowerCase() === name.toLowerCase(),
  );

  const fileName = siteSettingFileName(name);
  const defaultFilePath = path.join(dir, fileName);

  if (existingSetting) {
    const preservedId = existingSetting.id || uuidFn();
    const filePath = existingSetting.filePath || defaultFilePath;
    if (dryRun) {
      return { dryRun: true, filePath, id: preservedId, updated: true };
    }
    fsImpl.writeFileSync(filePath, writeYaml({ description, id: preservedId, name, value }), 'utf8');
    return { filePath, id: preservedId, updated: true };
  }

  if (fsImpl.existsSync(defaultFilePath)) {
    throw new Error(
      `File already exists at ${defaultFilePath} but no matching site setting was found — resolve manually.`,
    );
  }

  const id = uuidFn();
  if (dryRun) {
    return { dryRun: true, filePath: defaultFilePath, id, updated: false };
  }
  fsImpl.writeFileSync(defaultFilePath, writeYaml({ description, id, name, value }), 'utf8');
  return { filePath: defaultFilePath, id, updated: false };
}

/**
 * Remove an HTTP/* site-setting's YAML file. Idempotent.
 *
 * @returns {{ filePath: string | null, removed: boolean }}
 */
function removeSiteHeader({ projectRoot, name, dryRun = false, fsImpl = fs } = {}) {
  requireProjectRoot(projectRoot);
  requireWritableName(name);
  const dir = requireSiteSettingsDir(projectRoot);

  const existing = loadSiteSettings(dir);
  const existingSetting = existing.find(
    (s) => typeof s.name === 'string' && s.name.toLowerCase() === name.toLowerCase(),
  );

  if (!existingSetting) {
    return { filePath: null, removed: false };
  }
  const filePath = existingSetting.filePath || path.join(dir, siteSettingFileName(name));
  if (dryRun) {
    return { dryRun: true, filePath, removed: true };
  }
  fsImpl.unlinkSync(filePath);
  return { filePath, removed: true };
}

// ===== CLI wiring =====

function parseCli(argv) {
  const options = {
    audit: { type: 'boolean' },
    write: { type: 'boolean' },
    remove: { type: 'boolean' },
    projectRoot: { type: 'string' },
    name: { type: 'string' },
    value: { type: 'string' },
    description: { type: 'string' },
    'dry-run': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  };
  return parseArgs({ args: argv.slice(2), options, strict: true }).values;
}

function pickMode(args) {
  const modes = [args.audit && 'audit', args.write && 'write', args.remove && 'remove'].filter(Boolean);
  if (modes.length === 0) return null;
  if (modes.length > 1) return { error: `Multiple mode flags set: ${modes.join(', ')} — pick exactly one` };
  return { mode: modes[0] };
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
      `Missing mode flag — pick one of --audit, --write, --remove.\n\n${HELP}`,
    );
    return;
  }
  if (pick.error) {
    exitWithMessage(EXIT.INVALID_ARGS, `${pick.error}\n\n${HELP}`);
    return;
  }

  try {
    let result;
    switch (pick.mode) {
      case 'audit':
        result = auditSiteHeaders(args.projectRoot);
        break;
      case 'write':
        result = writeSiteHeader({
          projectRoot: args.projectRoot,
          name: args.name,
          value: args.value,
          description: args.description,
          dryRun: Boolean(args['dry-run']),
        });
        break;
      case 'remove':
        result = removeSiteHeader({
          projectRoot: args.projectRoot,
          name: args.name,
          dryRun: Boolean(args['dry-run']),
        });
        break;
      default:
        throw new Error(`Unreachable: unknown mode "${pick.mode}"`);
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    const exitCode =
      err.code === 'INVALID_ARGS' ? EXIT.INVALID_ARGS
      : err.code === 'FORBIDDEN' ? EXIT.FORBIDDEN
      : err.code === 'NO_SITE_SETTINGS' ? EXIT.NO_SITE_SETTINGS
      : EXIT.UNKNOWN;
    exitWithMessage(exitCode, err.stack || err.message);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  auditSiteHeaders,
  writeSiteHeader,
  removeSiteHeader,
  isRecognizedHttpHeader,
  RECOGNIZED_HTTP_HEADER_NAMES,
  RECOGNIZED_HTTP_HEADER_PREFIXES,
  FORBIDDEN_HTTP_HEADER_NAMES,
  EXIT,
};
