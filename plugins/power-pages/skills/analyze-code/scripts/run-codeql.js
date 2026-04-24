#!/usr/bin/env node

// run-codeql.js — orchestrate a CodeQL static analysis run: create the
// database, analyze with a chosen query suite, emit SARIF. Designed to
// be invoked via `Bash run_in_background` — the scan is long-running
// (minutes to over an hour).
//
// Phase markers are written next to the database so external pollers can
// see progress:
//   <dbPath>/.state-create   written when `database create` starts
//   <dbPath>/.state-analyze  written when `database analyze` starts
//   <dbPath>/.state-done     written on success with the final JSON
//   <dbPath>/.state-error    written on failure with the stderr text
//
// CLI usage:
//   node run-codeql.js --projectRoot <path> --language <lang> \
//                      --querySuite <pack:suite.qls> \
//                      --dbPath <db> --sarifOut <sarif>
//                      [--ram <MB>] [--pathsIgnore <comma-paths>]
//   node run-codeql.js --help

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { parseArgs } = require('node:util');

const EXIT = Object.freeze({
  OK: 0,
  UNKNOWN: 1,
  INVALID_ARGS: 2,
  NOT_FOUND: 3,       // codeql not on PATH
  CODEQL_FAILED: 4,   // codeql ran but returned non-zero
});

// The analyze-code skill scopes to JavaScript/TypeScript only — the typical
// Power Pages code-site surface. CodeQL's CLI accepts other language ids
// (python, java, csharp, cpp, go, ruby, swift), but this wrapper does not
// orchestrate them. Callers who need other languages should invoke
// `codeql database create` / `analyze` directly.
const SUPPORTED_LANGUAGES = Object.freeze(new Set(['javascript-typescript']));

const HELP = `Usage:
  run-codeql.js --projectRoot <path> --language <lang> \\
                --querySuite <pack:suite.qls> \\
                --dbPath <db-path> --sarifOut <sarif-path> \\
                [--ram <MB>] [--pathsIgnore <comma-paths>]
  run-codeql.js --help

Orchestrates 'codeql database create' followed by 'codeql database analyze'
and writes a SARIF result file. Designed to be invoked via
Bash run_in_background — the scan is long-running.

Options:
  --projectRoot <path>      Source root (REQUIRED).
  --language <id>           CodeQL language id. This wrapper accepts only
                            'javascript-typescript' — the skill scopes to
                            JS/TS. Callers who need other languages should
                            invoke CodeQL directly.
  --querySuite <suite>      Query pack + suite, e.g.
                            codeql/javascript-queries:codeql-suites/javascript-security-extended.qls
  --dbPath <path>           Where to write the CodeQL database.
  --sarifOut <path>         Where to write the SARIF output.
  --ram <MB>                Override CodeQL's default memory cap for large
                            projects. Applied to both create and analyze.
  --pathsIgnore <list>      Comma-separated paths (relative to projectRoot)
                            to exclude from analysis.
  -h, --help                Show this help.

Output (stdout, JSON, on success):
  {
    "status": "done",
    "dbPath": "...",
    "sarifOut": "...",
    "createDurationSeconds": N,
    "analyzeDurationSeconds": N
  }

Exit codes:
  0  Success. SARIF is at --sarifOut.
  1  Unknown / I/O failure.
  2  Invalid or missing CLI arguments.
  3  CodeQL CLI is not on PATH.
  4  CodeQL ran but failed. Stderr carries the CodeQL message.
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

function codeqlAvailable() {
  try {
    execFileSync('codeql', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

function writeMarker(dbPath, name, content = '') {
  try {
    fs.mkdirSync(dbPath, { recursive: true });
    fs.writeFileSync(path.join(dbPath, `.state-${name}`), content, 'utf8');
  } catch {
    // Markers are best-effort — do not fail the run if we can't write one.
  }
}

function clearMarker(dbPath, name) {
  try {
    fs.unlinkSync(path.join(dbPath, `.state-${name}`));
  } catch {
    // Ignore — marker may not exist yet.
  }
}

/**
 * Write a CodeQL config file (YAML) capturing user-supplied paths-ignore,
 * which is how the CLI accepts exclusions for analysis. Returns the path
 * to the file, or null if no excludes were provided.
 */
function writeConfigFile(dbPath, pathsIgnore) {
  if (!pathsIgnore || pathsIgnore.length === 0) return null;
  const configPath = path.join(dbPath, 'codeql-config.yml');
  const lines = ['paths-ignore:', ...pathsIgnore.map((p) => `  - ${p}`), ''];
  fs.mkdirSync(dbPath, { recursive: true });
  fs.writeFileSync(configPath, lines.join('\n'), 'utf8');
  return configPath;
}

function runStep(name, args, dbPath) {
  const started = Date.now();
  const result = spawnSync('codeql', args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  const elapsedSeconds = Math.round((Date.now() - started) / 1000);

  // Forward CodeQL's stderr to ours so the caller sees progress / errors.
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.status !== 0) {
    writeMarker(dbPath, 'error', `${name} failed (exit ${result.status}):\n${result.stderr || ''}`);
    const err = new Error(`codeql ${name} failed with exit code ${result.status}`);
    err.code = 'CODEQL_FAILED';
    err.elapsedSeconds = elapsedSeconds;
    throw err;
  }

  return elapsedSeconds;
}

function runScan({
  projectRoot,
  language,
  querySuite,
  dbPath,
  sarifOut,
  ram,
  pathsIgnore,
} = {}) {
  if (!projectRoot || typeof projectRoot !== 'string') throw invalidArgs('--projectRoot is required');
  if (!language || typeof language !== 'string') throw invalidArgs('--language is required');
  if (!SUPPORTED_LANGUAGES.has(language)) {
    throw invalidArgs(
      `--language must be one of ${[...SUPPORTED_LANGUAGES].join(', ')} (got: ${language})`,
    );
  }
  if (!querySuite || typeof querySuite !== 'string') throw invalidArgs('--querySuite is required');
  if (!dbPath || typeof dbPath !== 'string') throw invalidArgs('--dbPath is required');
  if (!sarifOut || typeof sarifOut !== 'string') throw invalidArgs('--sarifOut is required');
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    throw invalidArgs(`--projectRoot does not exist or is not a directory: ${projectRoot}`);
  }

  if (!codeqlAvailable()) {
    const err = new Error('codeql CLI not on PATH — run check-tools.js for install guidance');
    err.code = 'NOT_FOUND';
    throw err;
  }

  // Clean up any stale markers from a prior run. --done is informational so
  // a rerun's fresh markers will write over it cleanly.
  for (const marker of ['create', 'analyze', 'done', 'error']) clearMarker(dbPath, marker);

  const configPath = writeConfigFile(dbPath, pathsIgnore);

  // ---- database create ----
  writeMarker(dbPath, 'create', new Date().toISOString());
  const createArgs = [
    'database', 'create', dbPath,
    `--language=${language}`,
    `--source-root=${projectRoot}`,
    '--overwrite', // re-runs overwrite a prior database at the same path
  ];
  if (ram) createArgs.push(`--ram=${ram}`);
  const createSeconds = runStep('database create', createArgs, dbPath);
  clearMarker(dbPath, 'create');

  // ---- database analyze ----
  writeMarker(dbPath, 'analyze', new Date().toISOString());
  const analyzeArgs = [
    'database', 'analyze', dbPath,
    querySuite,
    '--format=sarif-latest',
    `--output=${sarifOut}`,
  ];
  if (ram) analyzeArgs.push(`--ram=${ram}`);
  if (configPath) analyzeArgs.push(`--codescanning-config=${configPath}`);
  const analyzeSeconds = runStep('database analyze', analyzeArgs, dbPath);
  clearMarker(dbPath, 'analyze');

  const result = {
    status: 'done',
    dbPath,
    sarifOut,
    createDurationSeconds: createSeconds,
    analyzeDurationSeconds: analyzeSeconds,
  };
  writeMarker(dbPath, 'done', JSON.stringify(result, null, 2));
  return result;
}

function parseCli(argv) {
  const options = {
    projectRoot: { type: 'string' },
    language: { type: 'string' },
    querySuite: { type: 'string' },
    dbPath: { type: 'string' },
    sarifOut: { type: 'string' },
    ram: { type: 'string' },
    pathsIgnore: { type: 'string' },
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
    const pathsIgnore = args.pathsIgnore
      ? args.pathsIgnore.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const ram = args.ram ? Number.parseInt(args.ram, 10) : undefined;
    if (args.ram && (!Number.isFinite(ram) || ram <= 0)) {
      throw invalidArgs(`--ram must be a positive integer (MB); got: ${args.ram}`);
    }
    const result = runScan({
      projectRoot: args.projectRoot,
      language: args.language,
      querySuite: args.querySuite,
      dbPath: args.dbPath,
      sarifOut: args.sarifOut,
      ram,
      pathsIgnore,
    });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    const exitCode =
      err.code === 'INVALID_ARGS' ? EXIT.INVALID_ARGS
      : err.code === 'NOT_FOUND' ? EXIT.NOT_FOUND
      : err.code === 'CODEQL_FAILED' ? EXIT.CODEQL_FAILED
      : EXIT.UNKNOWN;
    exitWithMessage(exitCode, err.stack || err.message);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  runScan,
  codeqlAvailable,
  SUPPORTED_LANGUAGES,
  EXIT,
};
