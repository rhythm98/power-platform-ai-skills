#!/usr/bin/env node

// check-tools.js — detect which of the analyze-code skill's supported
// CLI tools are installed. Does NOT install, download, or extract any
// tool — for each missing tool, the output includes a canonical install
// pointer that the skill surfaces to the user verbatim.
//
// Supported tools and what they cover:
//   semgrep  — SAST against CWE / OWASP Top 10 / OWASP ASVS rulesets
//   codeql   — SAST (deep JS/TS dataflow analysis; CWE-tagged rules)
//   trivy    — SCA (CVE-tagged dependency scan) + dependency license audit
//
// CLI usage:
//   node check-tools.js
//   node check-tools.js --tool <name>     # check one specific tool
//   node check-tools.js --help

const { execFileSync } = require('node:child_process');
const { parseArgs } = require('node:util');

const EXIT = Object.freeze({
  OK: 0,
  UNKNOWN: 1,
  INVALID_ARGS: 2,
});

// One entry per tool: how to invoke it to get a version, what install
// pointer to surface when it is missing. All install pointers point at
// canonical, maintainer-hosted sources.
const TOOLS = Object.freeze({
  semgrep: {
    command: 'semgrep',
    versionArgs: ['--version'],
    versionPattern: /(\d+\.\d+\.\d+)/,
    install:
      'Install via pip (`pip install semgrep`) or pipx (`pipx install semgrep`). ' +
      'Semgrep is a Python package and is also available via Homebrew and other system package managers.',
    covers: 'SAST against CWE / OWASP Top 10 / OWASP ASVS rulesets',
  },
  codeql: {
    command: 'codeql',
    versionArgs: ['--version'],
    versionPattern: /release\s+(\d+\.\d+\.\d+)/i,
    install:
      'Download the CodeQL CLI binary archive for your platform from the official GitHub ' +
      'maintainer-hosted release, unpack to a stable location, and add the directory ' +
      'containing the `codeql` executable to PATH.',
    covers: 'Deep SAST for JavaScript/TypeScript (CWE-tagged rules)',
  },
  trivy: {
    command: 'trivy',
    versionArgs: ['--version'],
    versionPattern: /Version:\s*(\d+\.\d+\.\d+)/i,
    install:
      'Install via a system package manager (`brew install trivy`, `apt install trivy`, ' +
      '`scoop install trivy`) or download the prebuilt binary from the official Trivy releases.',
    covers: 'SCA (CVE-tagged dependency scan), dependency license audit, secret scanning',
  },
});

const HELP = `Usage:
  check-tools.js
  check-tools.js --tool <semgrep|codeql|trivy>
  check-tools.js --help

Detects which of the analyze-code skill's supported CLI tools are on PATH.
Does NOT install, download, or extract anything. Each missing tool's output
includes an install pointer the skill surfaces to the user.

Options:
  --tool <name>  Check one tool; skip the others. When omitted, checks all.
  -h, --help     Show this help.

Output (stdout): JSON object keyed by tool name:
  {
    "<tool>": {
      "present": true|false,
      "version": "x.y.z" (when present),
      "covers": "<what this tool scans for>",
      "install": "<install guidance>" (when absent)
    },
    ...
  }

Exit codes:
  0  Ran to completion (even if some tools are absent — that is a data
     signal, not an error — the caller decides what to do).
  1  Unknown runtime failure.
  2  Invalid CLI arguments.
`;

function exitWithMessage(exitCode, message) {
  process.stderr.write(message.endsWith('\n') ? message : message + '\n');
  process.exit(exitCode);
}

function checkOne(toolName, spec) {
  try {
    const output = execFileSync(spec.command, spec.versionArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const match = spec.versionPattern.exec(output);
    return {
      present: true,
      version: match ? match[1] : null,
      covers: spec.covers,
    };
  } catch {
    return {
      present: false,
      covers: spec.covers,
      install: spec.install,
    };
  }
}

function parseCli(argv) {
  const options = {
    tool: { type: 'string' },
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

  const result = {};
  if (args.tool) {
    const spec = TOOLS[args.tool];
    if (!spec) {
      exitWithMessage(
        EXIT.INVALID_ARGS,
        `Unknown tool: ${args.tool}. Supported: ${Object.keys(TOOLS).join(', ')}`,
      );
      return;
    }
    result[args.tool] = checkOne(args.tool, spec);
  } else {
    for (const [name, spec] of Object.entries(TOOLS)) {
      result[name] = checkOne(name, spec);
    }
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (require.main === module) {
  main();
}

module.exports = {
  TOOLS,
  checkOne,
  EXIT,
};
