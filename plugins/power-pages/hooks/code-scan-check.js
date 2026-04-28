#!/usr/bin/env node

// code-scan-check.js — Claude Code UserPromptSubmit hook.
//
// Req doc §8.4 requires the manage-code-scan skill to register a post-scan
// hook that "re-enters the session when the scan completes". Claude Code
// hooks fire on Claude Code events (prompt submit, tool use, session
// start), not on external process completion, so the closest
// implementation is this one: on every user prompt, check whether a
// background CodeQL scan started by the skill has produced its
// completion marker. If so, emit a one-line note to stdout so Claude
// sees the scan is done and can act on it (summarize findings, prompt
// the user, etc.).
//
// The notification fires once per completed scan — a `.state-notified`
// sibling marker is written to suppress repeated surfacing.
//
// The hook is conservative — it only fires when the expected marker
// path exists, so projects not using this skill see no side effect.

const fs = require('node:fs');
const path = require('node:path');

// The manage-code-scan skill's `run-codeql.js` writes phase markers here
// by default. The skill's SKILL.md recommends this path for --dbPath,
// so this hook polls the same location.
const DB_DIR_NAME = '.codeql-db';
const DONE_MARKER = '.state-done';
const NOTIFIED_MARKER = '.state-notified';

function main() {
  const cwd = process.cwd();
  const dbDir = path.join(cwd, DB_DIR_NAME);
  const doneFile = path.join(dbDir, DONE_MARKER);
  const notifiedFile = path.join(dbDir, NOTIFIED_MARKER);

  // Fast path: no completed scan here — skip cleanly so the hook is
  // invisible in projects that don't use this skill.
  if (!fs.existsSync(doneFile)) return;

  // Avoid re-notifying the same completed scan on every subsequent prompt.
  if (fs.existsSync(notifiedFile)) return;

  let doneData = '';
  try {
    doneData = fs.readFileSync(doneFile, 'utf8').trim();
  } catch {
    // Unreadable — skip the notification, don't block the prompt.
    return;
  }

  process.stdout.write(
    '[manage-code-scan] A background CodeQL scan started by /manage-code-scan has ' +
    'completed in this project.\n' +
    `Result summary from ${path.join(DB_DIR_NAME, DONE_MARKER)}:\n${doneData}\n` +
    'Run `node "${CLAUDE_PLUGIN_ROOT}/skills/manage-code-scan/scripts/parse-sarif.js" ' +
    '--sarif <sarifOut-path-from-above>` to get the structured findings ' +
    'summary — or re-invoke /manage-code-scan to resume the workflow.\n',
  );

  // Best effort — create the notified marker so this only surfaces once.
  // If the write fails we accept the minor risk of a duplicate notification
  // rather than blocking the user's prompt.
  try {
    fs.writeFileSync(notifiedFile, new Date().toISOString(), 'utf8');
  } catch {
    // Swallow intentionally — hook should not block on marker writes.
  }
}

// Hooks must exit quickly and never block the user's prompt. Wrap main in
// a try/catch so an unexpected failure (e.g. a transient fs error) drops
// the hook output rather than surfacing a stack trace.
try {
  main();
} catch {
  // Intentionally silent.
}
