/*
 * Shared POC hook helpers: 1DS init, emit, correlation-file I/O.
 *
 * All functions fail closed — any error is swallowed and written to
 * poc/1ds-telemetry/hook-capture/error.log so the hook process never
 * affects the parent Skill tool result.
 */

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { AppInsightsCore } = require("@microsoft/1ds-core-js");
const { PostChannel } = require("@microsoft/1ds-post-js");

// Endpoint defaults to the public INTERNAL/test URL; iKey must be set
// via POWER_PLATFORM_SKILLS_IDS_IKEY. When unset, emit() is a no-op that
// logs once to error.log — matching the spec's fail-closed behaviour.
const ENDPOINT_URL =
  process.env.POWER_PLATFORM_SKILLS_IDS_ENDPOINT ||
  "https://self.pipe.aria.int.microsoft.com/OneCollector/1.0/";
const IKEY = process.env.POWER_PLATFORM_SKILLS_IDS_IKEY || "";
const COLLECTOR_EVENT_NAME = "PowerPlatformSkillsEvent";

const CAPTURE_DIR = path.resolve(__dirname, "hook-capture");

function ensureCaptureDir() {
  try {
    fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  } catch (_) {
    // best-effort
  }
}

function appendDiagnostic(filename, obj) {
  try {
    ensureCaptureDir();
    fs.appendFileSync(
      path.join(CAPTURE_DIR, filename),
      JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n",
      "utf8"
    );
  } catch (_) {
    // swallow
  }
}

function logError(context, err) {
  appendDiagnostic("error.log", {
    context,
    message: (err && err.message) || String(err),
    stack: (err && err.stack) || null,
  });
}

function makeCore() {
  if (!IKEY) {
    appendDiagnostic("error.log", {
      context: "makeCore",
      message:
        "POWER_PLATFORM_SKILLS_IDS_IKEY not set; emit() is a no-op. See poc/1ds-telemetry/README.md.",
    });
    return { track: () => {}, flush: () => {} };
  }

  const core = new AppInsightsCore();
  const channel = new PostChannel();

  const fetchOverride = {
    sendPOST: (payload, oncomplete) => {
      const body =
        typeof payload.data === "string"
          ? payload.data
          : new TextDecoder().decode(payload.data);
      appendDiagnostic("network.log", {
        direction: "request",
        url: payload.urlString,
        bytes: Buffer.byteLength(body, "utf8"),
      });
      fetch(payload.urlString, {
        method: "POST",
        headers: payload.headers,
        body,
      })
        .then(async (response) => {
          const headerMap = {};
          response.headers.forEach((v, n) => {
            headerMap[n] = v;
          });
          const text = response.body ? await response.text().catch(() => "") : "";
          appendDiagnostic("network.log", {
            direction: "response",
            status: response.status,
            body: text.slice(0, 300),
          });
          oncomplete(response.status, headerMap, text);
        })
        .catch((err) => {
          logError("fetch", err);
          oncomplete(0, {});
        });
    },
  };

  core.initialize(
    {
      instrumentationKey: IKEY,
      loggingLevelConsole: 0,
      disableDbgExt: true,
      endpointUrl: ENDPOINT_URL,
      extensions: [channel],
      extensionConfig: {
        [channel.identifier]: {
          alwaysUseXhrOverride: true,
          httpXHROverride: fetchOverride,
        },
      },
    },
    []
  );

  return core;
}

function pluginVersion() {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, "../../plugins/power-pages/.claude-plugin/plugin.json"),
        "utf8"
      )
    );
    return manifest.version || "unknown";
  } catch (_) {
    return "unknown";
  }
}

function buildEvent(eventName, data) {
  return {
    name: COLLECTOR_EVENT_NAME,
    data: {
      eventName,
      eventType: "Trace",
      severity: "Info",
      eventInfo: JSON.stringify({
        plugin_name: "power-pages",
        plugin_version: pluginVersion(),
        os_family: process.platform,
        node_version: process.versions.node.split(".")[0],
        harness: "claude-code-plugin",
        ...data,
      }),
    },
  };
}

// Correlation file: keyed by skill name so pre + post for the same skill link up.
// Uses OS temp dir to avoid polluting the repo.
function correlationPath(skillName) {
  return path.join(
    os.tmpdir(),
    `ppskills-1ds-poc-corr-${skillName || "unknown"}.json`
  );
}

function writeCorrelation(skillName, payload) {
  try {
    fs.writeFileSync(
      correlationPath(skillName),
      JSON.stringify(payload),
      "utf8"
    );
  } catch (err) {
    logError("writeCorrelation", err);
  }
}

function readCorrelation(skillName) {
  try {
    const raw = fs.readFileSync(correlationPath(skillName), "utf8");
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function clearCorrelation(skillName) {
  try {
    fs.unlinkSync(correlationPath(skillName));
  } catch (_) {
    // ignore
  }
}

async function flushAndWait(core, maxMs = 3000) {
  try {
    core.flush();
  } catch (err) {
    logError("flush", err);
  }
  // Give the fetch XHR override time to complete.
  await new Promise((resolve) => setTimeout(resolve, maxMs));
}

function readStdinAll() {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
    });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", () => resolve(buf));
  });
}

module.exports = {
  COLLECTOR_EVENT_NAME,
  appendDiagnostic,
  buildEvent,
  clearCorrelation,
  flushAndWait,
  logError,
  makeCore,
  newUuid: () => crypto.randomUUID(),
  readCorrelation,
  readStdinAll,
  writeCorrelation,
};
