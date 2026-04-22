/*
 * Proof-of-concept 1DS telemetry emitter for power-platform-skills.
 *
 * Mirrors the instrumentation pattern used by powerplatform-vscode
 * (src/common/OneDSLoggerTelemetry/oneDSLogger.ts):
 *
 *   - AppInsightsCore + PostChannel
 *   - Custom httpXHROverride that delegates to Node's global fetch
 *   - Collector event name "VscodeEvent" replaced with
 *     "PowerPlatformSkillsEvent" for this repo
 *
 * Targets the INTERNAL/test cluster:
 *   endpoint: https://self.pipe.aria.int.microsoft.com/OneCollector/1.0/
 *   iKey:     ffdb4c99ca3a4ad5b8e9ffb08bf7da0d-65357ff3-efcd-47fc-b2fd-ad95a52373f4-7402
 *
 * Run:
 *   cd poc/1ds-telemetry
 *   npm install
 *   node emit.js
 */

"use strict";

const crypto = require("crypto");
const os = require("os");

const { AppInsightsCore } = require("@microsoft/1ds-core-js");
const { PostChannel } = require("@microsoft/1ds-post-js");

// ---- Cluster settings --------------------------------------------------------
// Endpoint is the public 1DS OneCollector INTERNAL/test URL (not a secret).
// iKey must be provided via POWER_PLATFORM_SKILLS_IDS_IKEY so this POC cannot
// emit by accident into someone else's tenant.
const ENDPOINT_URL =
  process.env.POWER_PLATFORM_SKILLS_IDS_ENDPOINT ||
  "https://self.pipe.aria.int.microsoft.com/OneCollector/1.0/";
const IKEY = process.env.POWER_PLATFORM_SKILLS_IDS_IKEY;
if (!IKEY) {
  console.error(
    "POWER_PLATFORM_SKILLS_IDS_IKEY not set. See README.md in this directory."
  );
  process.exit(1);
}
const COLLECTOR_EVENT_NAME = "PowerPlatformSkillsEvent";

// ---- XHR override using Node 18+ global fetch --------------------------------
const fetchHttpXHROverride = {
  sendPOST: (payload, oncomplete) => {
    const body =
      typeof payload.data === "string"
        ? payload.data
        : new TextDecoder().decode(payload.data);

    console.log(`[poc] POST ${payload.urlString}`);
    console.log(`[poc] body bytes: ${Buffer.byteLength(body, "utf8")}`);

    fetch(payload.urlString, {
      method: "POST",
      headers: payload.headers,
      body,
    })
      .then(async (response) => {
        const headerMap = {};
        response.headers.forEach((value, name) => {
          headerMap[name] = value;
        });
        const text = response.body ? await response.text().catch(() => "") : "";
        console.log(
          `[poc] response status=${response.status} body=${text.slice(0, 200)}`
        );
        oncomplete(response.status, headerMap, text);
      })
      .catch((err) => {
        console.error("[poc] fetch error:", err);
        oncomplete(0, {});
      });
  },
};

// ---- Init SDK ----------------------------------------------------------------
const appInsightsCore = new AppInsightsCore();
const postChannel = new PostChannel();

const coreConfig = {
  instrumentationKey: IKEY,
  loggingLevelConsole: 0,
  disableDbgExt: true,
  endpointUrl: ENDPOINT_URL,
  extensions: [postChannel],
  extensionConfig: {
    [postChannel.identifier]: {
      alwaysUseXhrOverride: true,
      httpXHROverride: fetchHttpXHROverride,
    },
  },
};

appInsightsCore.initialize(coreConfig, []);

// ---- Common-attribute enrichment (subset of the vscode logger) ---------------
const sessionId = crypto.randomUUID();

appInsightsCore.addTelemetryInitializer((envelope) => {
  try {
    envelope.data = envelope.data || {};
    envelope.data.pluginName = "power-pages";
    envelope.data.pluginVersion = "1.2.2";
    envelope.data.clientSessionId = sessionId;
    envelope.data.osName = process.platform;
    envelope.data.nodeVersion = process.versions.node.split(".")[0];
    envelope.data.hostname_redacted = ""; // explicitly empty — no hostname sent
    envelope.data.timestamp = new Date().toISOString();
    envelope.data.harness = "claude-code-plugin";
    return true;
  } catch (ex) {
    console.warn("[poc] initializer exception:", ex && ex.message);
    return false;
  }
});

// ---- Emit helpers ------------------------------------------------------------
function emit(eventName, data) {
  const event = {
    name: COLLECTOR_EVENT_NAME,
    data: {
      eventName,
      eventType: "Trace",
      severity: "Info",
      eventInfo: JSON.stringify(data || {}),
    },
  };
  console.log(`[poc] track ${eventName} -> ${JSON.stringify(event.data)}`);
  appInsightsCore.track(event);
}

// ---- Sample events -----------------------------------------------------------
const correlationId = crypto.randomUUID();
const startedAt = Date.now();

emit("skill_started", {
  skill_name: "create-site",
  correlation_id: correlationId,
  os_family: process.platform,
  node_version: process.versions.node.split(".")[0],
});

// Simulate a short skill run
setTimeout(() => {
  const duration_ms = Date.now() - startedAt;

  emit("skill_completed", {
    skill_name: "create-site",
    correlation_id: correlationId,
    outcome: "success",
    duration_ms,
    error_class: "",
    os_family: process.platform,
    node_version: process.versions.node.split(".")[0],
  });

  // Flush + exit
  setTimeout(() => {
    console.log("[poc] flushing and exiting");
    try {
      appInsightsCore.flush();
    } catch (e) {
      console.warn("[poc] flush error:", e && e.message);
    }
    // Give the fetch a moment to drain before the process exits.
    setTimeout(() => process.exit(0), 2000);
  }, 250);
}, 50);
