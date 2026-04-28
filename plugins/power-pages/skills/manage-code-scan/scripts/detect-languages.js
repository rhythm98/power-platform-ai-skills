#!/usr/bin/env node

// detect-languages.js — walk a project directory and report which
// CodeQL-supported languages are present. Used by the manage-code-scan
// skill to pick the right language for `run-codeql.js`.
//
// Detection is extension-based — a file's extension determines its
// language bucket. This is intentionally simple: CodeQL's own detection
// is shebang-and-content-based, but for a code-site project an extension
// heuristic is plenty and doesn't require reading every file's content.
//
// CLI usage:
//   node detect-languages.js --projectRoot <path> [--exclude <names>]
//   node detect-languages.js --help

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');

const EXIT = Object.freeze({
  OK: 0,
  UNKNOWN: 1,
  INVALID_ARGS: 2,
});

// Language ID → file extensions CodeQL uses to identify it. JavaScript and
// TypeScript share the same extractor and the same database — CodeQL
// exposes that as the language id "javascript-typescript".
const LANGUAGE_EXTENSIONS = Object.freeze({
  'javascript-typescript': ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.vue'],
  python: ['.py'],
  java: ['.java', '.kt', '.kts'],
  csharp: ['.cs', '.cshtml'],
  cpp: ['.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hh'],
  go: ['.go'],
  ruby: ['.rb', '.erb'],
  swift: ['.swift'],
});

// Invert the map once so per-file classification is O(1).
const EXTENSION_TO_LANGUAGE = Object.freeze(
  Object.fromEntries(
    Object.entries(LANGUAGE_EXTENSIONS).flatMap(([lang, exts]) => exts.map((ext) => [ext, lang])),
  ),
);

// Directory names skipped by default at any depth. Build artifacts, VCS
// metadata, dependency folders, and this skill's own scratch directories.
const DEFAULT_EXCLUDE_DIRS = Object.freeze([
  'node_modules',
  '.git',
  '.svelte-kit',
  '.next',
  '.nuxt',
  '.vite',
  '.astro',
  '.turbo',
  '.cache',
  '.output',
  'dist',
  'build',
  'out',
  'coverage',
  '.codeql-db',      // this skill's database output
  '.powerpages-site', // deployment artifacts; we scan source, not the upload bundle
]);

const HELP = `Usage:
  detect-languages.js --projectRoot <path> [--exclude <comma-separated names>]
  detect-languages.js --help

Walks the project tree and reports which CodeQL-supported languages are
present. Detection is extension-based.

Options:
  --projectRoot <path>   Project root directory (REQUIRED).
  --exclude <names>      Extra directory names (at any depth) to skip.
                         Added to the defaults: ${DEFAULT_EXCLUDE_DIRS.join(', ')}.
  -h, --help             Show this help.

Output (stdout):
  {
    "languages": [
      { "id": "<language-id>", "fileCount": N, "extensions": [".x", ".y"] },
      ...
    ],
    "primary": "<language-id>",   // highest file count; used as run-codeql.js default
    "totalFiles": N
  }

Exit codes:
  0  Success.
  1  Unknown or I/O failure.
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
 * Recursively walk `dir`, skipping `excludedDirs` at any depth and symlinks.
 * Yields file paths in arbitrary order.
 */
function* walkFiles(dir, excludedDirs) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable — skip silently
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (excludedDirs.has(entry.name)) continue;
      yield* walkFiles(full, excludedDirs);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function detectLanguages({ projectRoot, extraExcludes = [] } = {}) {
  if (!projectRoot || typeof projectRoot !== 'string') {
    throw invalidArgs('--projectRoot is required');
  }
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    throw invalidArgs(`--projectRoot does not exist or is not a directory: ${projectRoot}`);
  }
  const excluded = new Set([...DEFAULT_EXCLUDE_DIRS, ...extraExcludes]);

  const counts = new Map(); // language id → file count
  const seenExts = new Map(); // language id → Set of extensions actually observed
  let totalFiles = 0;

  for (const file of walkFiles(projectRoot, excluded)) {
    totalFiles += 1;
    const ext = path.extname(file).toLowerCase();
    const lang = EXTENSION_TO_LANGUAGE[ext];
    if (!lang) continue; // not a CodeQL-supported language
    counts.set(lang, (counts.get(lang) || 0) + 1);
    if (!seenExts.has(lang)) seenExts.set(lang, new Set());
    seenExts.get(lang).add(ext);
  }

  const languages = [...counts.entries()]
    .map(([id, fileCount]) => ({
      id,
      fileCount,
      extensions: [...seenExts.get(id)].sort(),
    }))
    .sort((a, b) => b.fileCount - a.fileCount);

  const primary = languages.length > 0 ? languages[0].id : null;

  return { languages, primary, totalFiles };
}

function parseCli(argv) {
  const options = {
    projectRoot: { type: 'string' },
    exclude: { type: 'string' },
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
    const extraExcludes = args.exclude
      ? args.exclude.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const result = detectLanguages({ projectRoot: args.projectRoot, extraExcludes });
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
  detectLanguages,
  LANGUAGE_EXTENSIONS,
  EXTENSION_TO_LANGUAGE,
  DEFAULT_EXCLUDE_DIRS,
  EXIT,
};
