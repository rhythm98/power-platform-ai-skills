#!/usr/bin/env node
/*
 * POC PostToolUse:Skill hook.
 * - Captures raw stdin JSON to hook-capture/posttool-stdin.log
 * - Reads correlation_id + start_ts written by hook-pretool.js
 * - Emits skill_completed event to 1DS INTERNAL cluster
 * - Always exits 0; does NOT interfere with the existing validator hook
 */

"use strict";

const path = require("path");
const {
  appendDiagnostic,
  buildEvent,
  clearCorrelation,
  flushAndWait,
  logError,
  makeCore,
  newUuid,
  readCorrelation,
  readStdinAll,
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
  appendDiagnostic("posttool-stdin.log", { raw: stdinRaw });

  let input;
  try {
    input = JSON.parse(stdinRaw);
  } catch (err) {
    logError("parse stdin", err);
    process.exit(0);
  }

  appendDiagnostic("posttool-parsed.log", { parsed: input });

  const skillName = getTrackedSkillFromToolInput(input.tool_input);
  if (!skillName) {
    appendDiagnostic("posttool-parsed.log", {
      note: "no tracked skill detected — skipping emit",
    });
    process.exit(0);
  }

  const corr = readCorrelation(skillName);
  const correlationId = (corr && corr.correlation_id) || newUuid();
  const startTs = (corr && corr.start_ts) || Date.now();
  const durationMs = Math.max(0, Date.now() - startTs);

  // PostToolUse does not carry thrown-error info. Mark success when we have no signal otherwise.
  const outcome = "success";

  let core;
  try {
    core = makeCore();
    core.track(
      buildEvent("skill_completed", {
        skill_name: skillName,
        correlation_id: correlationId,
        outcome,
        duration_ms: durationMs,
        error_class: "",
        session_id: newUuid(),
      })
    );
  } catch (err) {
    logError("emit skill_completed", err);
    process.exit(0);
  }

  await flushAndWait(core);

  // Best-effort cleanup of the correlation temp file.
  clearCorrelation(skillName);

  process.exit(0);
})().catch((err) => {
  logError("posttool main", err);
  process.exit(0);
});
