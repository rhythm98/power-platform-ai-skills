#!/usr/bin/env node
/*
 * POC PreToolUse:Skill hook.
 * - Captures raw stdin JSON to hook-capture/pretool-stdin.log
 * - Extracts tracked-skill name via power-pages helper
 * - Writes correlation_id + start_ts to OS temp keyed by skill
 * - Emits skill_started event to 1DS INTERNAL cluster
 * - Always exits 0
 */

"use strict";

const path = require("path");
const {
  appendDiagnostic,
  buildEvent,
  flushAndWait,
  logError,
  makeCore,
  newUuid,
  readStdinAll,
  writeCorrelation,
} = require("./hook-lib");

let getTrackedSkillFromToolInput;
try {
  ({ getTrackedSkillFromToolInput } = require(path.resolve(
    __dirname,
    "../../plugins/power-pages/scripts/lib/powerpages-hook-utils.js"
  )));
} catch (err) {
  logError("require hook-utils", err);
  process.exit(0);
}

(async () => {
  const stdinRaw = await readStdinAll();
  appendDiagnostic("pretool-stdin.log", { raw: stdinRaw });

  let input;
  try {
    input = JSON.parse(stdinRaw);
  } catch (err) {
    logError("parse stdin", err);
    process.exit(0);
  }

  appendDiagnostic("pretool-parsed.log", { parsed: input });

  const skillName = getTrackedSkillFromToolInput(input.tool_input);
  if (!skillName) {
    appendDiagnostic("pretool-parsed.log", {
      note: "no tracked skill detected — skipping emit",
    });
    process.exit(0);
  }

  const correlationId = newUuid();
  const startTs = Date.now();

  writeCorrelation(skillName, { correlation_id: correlationId, start_ts: startTs });

  let core;
  try {
    core = makeCore();
    core.track(
      buildEvent("skill_started", {
        skill_name: skillName,
        correlation_id: correlationId,
        session_id: newUuid(),
      })
    );
  } catch (err) {
    logError("emit skill_started", err);
    process.exit(0);
  }

  await flushAndWait(core);
  process.exit(0);
})().catch((err) => {
  logError("pretool main", err);
  process.exit(0);
});
