import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
  type ZCodeSessionRuntimePreferencesScope,
} from "@zcode/shared";
import { createZCodeAgentService } from "../src/zcode-agent/zcodeAgentService.js";
import { ZCodeAgentProcessManager } from "../src/zcode-agent/zcodeAgentProcessManager.js";
import type { ZCodeProtocolClient } from "../src/zcode-agent/zcodeProtocolClient.js";
import { ZCODE_AGENT_MCP_STATUS_MODE_UNSUPPORTED_ERROR_CODE } from "../src/zcode-agent/zcodeAgentErrors.js";
import type { ZCodeAgentServiceEvent } from "../src/zcode-agent/zcodeAgent.js";
import { getTasksIndexDatabasePath, setDataBaseDir } from "../src/paths.js";

const protocolModelProperties = {
  inputFormat: {
    supportsText: true,
    supportsImage: false,
    supportsVideo: false,
    supportsAudio: false,
    supportsPdf: false,
  },
  outputFormat: { supportsText: true },
};
const protocolModelPropertiesJson = JSON.stringify(protocolModelProperties);

function createReadyZCodeAgentService(options?: Parameters<typeof createZCodeAgentService>[0]) {
  return createZCodeAgentService({
    modelSelectionReadinessSource: {
      async getView() {
        return {
          revision: 1,
          providers: [
            {
              providerId: "glm",
              config: {
                kind: "api" as const,
                api: {
                  type: "openai-chat-completions" as const,
                  baseUrl: "https://provider.test/v1",
                },
                models: ["glm-4.6"],
              },
              models: [{ modelId: "glm-4.6", config: {} }],
            },
          ],
        };
      },
    },
    ...options,
  });
}

// 一个最小的 ZCode Protocol stdio fake agent：
// 第一次收到 session/subscribe 返回错误（模拟 "Session is not active" 之类的瞬时失败），
// 第二次返回成功并带一条 session.titleUpdated 事件。用来验证订阅建立失败后会重试。
const FLAKY_SUBSCRIBE_FAKE_AGENT = `
let buf = "";
let subscribeCount = 0;
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "session/subscribe" && msg.id !== undefined) {
      subscribeCount += 1;
      if (subscribeCount === 1) {
        send({ id: msg.id, error: { code: -32000, message: "Session is not active" } });
      } else {
        send({
          id: msg.id,
          result: {
            sessionId: msg.params.sessionId,
            eventSeq: 1,
            events: [{
              type: "session.titleUpdated",
              eventId: "evt-1",
              sessionId: msg.params.sessionId,
              seq: 1,
              timestamp: 1700000000000,
              payload: { previousTitle: "", source: "default", title: "from-retry" },
            }],
          },
        });
      }
    }
  }
});
`;

const SUBSCRIBE_REPLAY_FAKE_AGENT = `
let buf = "";
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "session/subscribe" && msg.id !== undefined) {
      send({
        id: msg.id,
        result: {
          sessionId: msg.params.sessionId,
          eventSeq: 1,
          events: [{
            type: "session.titleUpdated",
            eventId: "evt-replay-title",
            sessionId: msg.params.sessionId,
            seq: 1,
            timestamp: 1700000000000,
            payload: { previousTitle: "", source: "generated", title: "replay-title" },
          }],
        },
      });
    }
  }
});
`;

const CUA_OPERATION_LIVE_EVENT_FAKE_AGENT = `
let buf = "";
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
function operationEvent(kind, eventId, sequenceNumber, sessionId, turnId, extra = {}) {
  return {
    kind,
    eventId,
    sequenceNumber,
    sessionId,
    timestamp: Date.now(),
    ...(turnId ? { turnId } : {}),
    ...extra,
  };
}
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method !== "session/subscribe" || msg.id === undefined) continue;
    const sessionId = msg.params.sessionId;
    send({ id: msg.id, result: { sessionId, eventSeq: 0, events: [] } });
    const turnId = "turn-cua-live";
    const started = operationEvent("tool-started", "evt-tool-started", 3, sessionId, turnId, {
      toolCallId: "call-cua-live",
    });
    setTimeout(() => {
      send({ method: "computer-use/operation-event", params: operationEvent(
        "turn-started", "evt-turn-started", 1, sessionId, turnId,
      ) });
      send({ method: "computer-use/operation-event", params: operationEvent(
        "tool-started", "evt-invalid", 2, sessionId, turnId, {
        toolCallId: "",
      }) });
      send({ method: "computer-use/operation-event", params: operationEvent(
        "tool-scheduled", "evt-tool-scheduled", 2, sessionId, turnId, {
        toolCallId: "call-cua-live",
        toolName: "mcp__node_repl__js",
        computerUse: true,
      }) });
      send({ method: "computer-use/operation-event", params: started });
      send({ method: "computer-use/operation-event", params: started });
      send({ method: "computer-use/operation-event", params: operationEvent(
        "turn-completed", "evt-turn-completed", 4, sessionId, turnId,
      ) });
    }, 0);
  }
});
`;

const CUA_OPERATION_RUNTIME_EXIT_FAKE_AGENT = `
let buf = "";
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
function operationEvent(kind, eventId, sequenceNumber, sessionId, turnId, extra = {}) {
  return {
    kind,
    eventId,
    sequenceNumber,
    sessionId,
    timestamp: Date.now(),
    ...(turnId ? { turnId } : {}),
    ...extra,
  };
}
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method !== "session/subscribe" || msg.id === undefined) continue;
    const sessionId = msg.params.sessionId;
    send({ id: msg.id, result: { sessionId, eventSeq: 0, events: [] } });
    setTimeout(() => {
      const turnId = "turn-cua-runtime-exit";
      send({ method: "computer-use/operation-event", params: operationEvent(
        "turn-started", "evt-runtime-exit-turn", 1, sessionId, turnId,
      ) });
      send({ method: "computer-use/operation-event", params: operationEvent(
        "tool-scheduled", "evt-runtime-exit-scheduled", 2, sessionId, turnId, {
        toolCallId: "call-runtime-exit",
        toolName: "mcp__node_repl__js",
        computerUse: true,
      }) });
      send({ method: "computer-use/operation-event", params: operationEvent(
        "tool-started", "evt-runtime-exit-tool", 3, sessionId, turnId, {
        toolCallId: "call-runtime-exit",
      }) });
      setTimeout(() => process.exit(1), 10);
    }, 0);
  }
});
`;

const BROWSER_DISCOVERY_FAKE_AGENT = `
let buf = "";
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
function context(sessionId) {
  return {
    requestId: "browser-request-context",
    sessionId,
    turnId: "turn-browser-1",
    workspaceKey: "remote:ssh:dev:/workspace/app",
    workspacePath: "/workspace/app",
    workspaceIdentity: "remote:ssh:dev:/workspace/app",
    remoteSessionId: "remote-session-1",
    clientMode: "web-remote-replayable",
    sessionContext: "live",
  };
}
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "session/subscribe" && msg.id !== undefined) {
      send({
        id: msg.id,
        result: { sessionId: msg.params.sessionId, eventSeq: 0, events: [] },
      });
      send({
        id: "browser-list-1",
        method: "interaction/browserList",
        params: context(msg.params.sessionId),
      });
      continue;
    }
    if (msg.id === "browser-list-1" && msg.result?.browsers?.[0]?.id) {
      send({
        id: "browser-execute-1",
        method: "interaction/browserExecute",
        params: {
          ...context("sess-browser"),
          requestId: "browser-execute-request",
          browserId: msg.result.browsers[0].id,
          browserGeneration: msg.result.browsers[0].generation,
          command: { method: "getState" },
        },
      });
    }
  }
});
`;
const SHELL_SETTINGS_SNAPSHOT_FAKE_AGENT = `
const fs = require("node:fs");
const logPath = process.argv[2];
const rejectBrowserAmbient = process.argv[3] === "reject-browser-ambient";
let buf = "";
let pendingCreate;
let pendingSend;
let userExecutionResolved = false;
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
function record(msg) {
  fs.appendFileSync(logPath, JSON.stringify({ method: msg.method, params: msg.params }) + "\\n");
}
function rejectBrowserAmbientParams(id) {
  const issues = [{
    code: "unrecognized_keys",
    keys: ["browserAmbientContext"],
    path: [],
    message: 'Unrecognized key: "browserAmbientContext"',
  }];
  send({
    id,
    error: {
      code: -32602,
      message: 'Invalid params — (root): Unrecognized key: "browserAmbientContext"',
      data: { name: "ZodError", message: JSON.stringify(issues) },
    },
  });
}
function workspaceState(workspace) {
  return {
    workspace,
    settings: {
      model: {
        current: { providerId: "zai-api", modelId: "glm-4.6" },
        available: [{ ref: { providerId: "zai-api", modelId: "glm-4.6" }, label: "GLM 4.6", properties: ${protocolModelPropertiesJson} }],
      },
      thoughtLevel: { enabled: false, available: [] },
      mode: { current: "build" },
    },
  };
}
function snapshot(workspace, sessionId = "sess_shell_settings") {
  return {
    protocol: { name: "ZCode Protocol", version: 1 },
    session: {
      sessionId,
      workspace,
      sessionKind: "interactive",
      title: "Shell settings",
      mode: "build",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    },
    settings: workspaceState(workspace).settings,
    projection: {
      sessionId,
      status: "idle",
      mode: "build",
      turnCount: 1,
      totalTokenCount: 0,
      contextUsed: 0,
      contextWindow: 128000,
      pendingPermissions: [],
      activeToolCalls: [],
      backgroundJobs: [],
    },
    runtime: { eventSeq: 0, stateRevision: 1, pendingRequestIds: [] },
    messages: [],
  };
}
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "session/create" && msg.id !== undefined) {
      record(msg);
      pendingCreate = msg;
      send({
        id: "runtime-preferences-materialization",
        method: "session/requestRuntimePreferences",
        params: {
          sessionId: msg.params.sessionId ?? "sess_shell_settings",
          scope: "runtime-materialization",
        },
      });
      continue;
    }
    if (msg.method === "session/resume" && msg.id !== undefined) {
      record(msg);
      send({ id: msg.id, result: snapshot(msg.params.workspace, msg.params.sessionId) });
      continue;
    }
    if (msg.method === "session/send" && msg.id !== undefined) {
      record(msg);
      if (rejectBrowserAmbient && msg.params.browserAmbientContext !== undefined) {
        rejectBrowserAmbientParams(msg.id);
        continue;
      }
      if (!userExecutionResolved) {
        pendingSend = msg;
        send({
          id: "runtime-preferences-user-execution",
          method: "session/requestRuntimePreferences",
          params: {
            sessionId: msg.params.sessionId,
            scope: "user-execution",
          },
        });
        continue;
      }
      send({
        id: msg.id,
        result: {
          sessionId: msg.params.sessionId,
          accepted: true,
          stateRevision: 2,
        },
      });
      continue;
    }
    if (msg.id === "runtime-preferences-materialization" && pendingCreate) {
      const create = pendingCreate;
      pendingCreate = undefined;
      send({ id: create.id, result: snapshot(create.params.workspace, create.params.sessionId) });
      continue;
    }
    if (msg.id === "runtime-preferences-user-execution" && pendingSend) {
      const prompt = pendingSend;
      pendingSend = undefined;
      userExecutionResolved = true;
      send({
        id: prompt.id,
        result: {
          sessionId: prompt.params.sessionId,
          accepted: true,
          stateRevision: 2,
        },
      });
    }
  }
});
`;

const RUNTIME_PREFERENCES_FAKE_AGENT = `
const fs = require("node:fs");
const logPath = process.argv[2];
const requestMode = process.argv[3] ?? "valid";
let buf = "";
let pendingCreate;
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
function record(obj) { fs.appendFileSync(logPath, JSON.stringify(obj) + "\\n"); }
function workspaceState(workspace) {
  return {
    workspace,
    settings: {
      model: {
        current: { providerId: "zai-api", modelId: "glm-4.6" },
        available: [{ ref: { providerId: "zai-api", modelId: "glm-4.6" }, label: "GLM 4.6", properties: ${protocolModelPropertiesJson} }],
      },
      thoughtLevel: { enabled: false, available: [] },
      mode: { current: "build" },
    },
  };
}
function snapshot(workspace) {
  const sessionId = "sess_runtime_preferences";
  return {
    protocol: { name: "ZCode Protocol", version: 1 },
    session: {
      sessionId,
      workspace,
      sessionKind: "interactive",
      title: "Runtime preferences",
      mode: "build",
      status: "idle",
      createdAt: 1,
      updatedAt: 2,
    },
    settings: workspaceState(workspace).settings,
    projection: {
      sessionId,
      status: "idle",
      mode: "build",
      turnCount: 0,
      totalTokenCount: 0,
      contextUsed: 0,
      contextWindow: 128000,
      pendingPermissions: [],
      activeToolCalls: [],
      backgroundJobs: [],
    },
    runtime: { eventSeq: 0, stateRevision: 1, pendingRequestIds: [] },
    messages: [],
  };
}
function completeCreateRequest() {
  const msg = pendingCreate;
  pendingCreate = undefined;
  record({ method: msg.method, params: msg.params });
  send({ id: msg.id, result: snapshot(msg.params.workspace) });
}
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "session/create" && msg.id !== undefined) {
      // Worker 进程已经自持 Registry，runtime preferences 在 session 创建时物化。
      pendingCreate = msg;
      send({
        id: "runtime-preferences-1",
        method: "session/requestRuntimePreferences",
        params: requestMode === "invalid"
          ? {}
          : { sessionId: "sess_runtime_preferences", scope: "runtime-materialization" },
      });
      if (requestMode === "disconnect") {
        process.stdin.destroy();
        process.stdout.end();
      }
      continue;
    }
    if (msg.id === "runtime-preferences-1" && (msg.result !== undefined || msg.error)) {
      record({
        method: "session/requestRuntimePreferences:response",
        result: msg.result,
        error: msg.error,
      });
      completeCreateRequest();
    }
  }
});
`;

const DELAYED_COMPACT_FAKE_AGENT = `
let buf = "";
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
function createSnapshot(sessionId) {
  return {
    protocol: { name: "ZCode Protocol", version: 1 },
    session: {
      sessionId,
      workspace: {
        workspacePath: "/workspace/compact",
        workspaceKey: "/workspace/compact",
      },
      sessionKind: "interactive",
      title: "Compact",
      mode: "build",
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
    },
    settings: {
      model: {
        current: { providerId: "glm", modelId: "glm-4.6" },
        available: [{ ref: { providerId: "glm", modelId: "glm-4.6" }, label: "GLM 4.6", properties: ${protocolModelPropertiesJson} }],
      },
      thoughtLevel: { enabled: true, available: [] },
      mode: { current: "build" },
    },
    projection: {
      sessionId,
      status: "idle",
      mode: "build",
      turnCount: 0,
      totalTokenCount: 0,
      contextUsed: 0,
      contextWindow: 128000,
      pendingPermissions: [],
      activeToolCalls: [],
      backgroundJobs: [],
    },
    runtime: { eventSeq: 0, stateRevision: 1, pendingRequestIds: [] },
    messages: [],
  };
}
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "session/compact" && msg.id !== undefined) {
      setTimeout(() => {
        send({
          id: msg.id,
          result: {
            response: "",
            snapshot: createSnapshot(msg.params.sessionId),
            compact: {
              state: "accepted",
              inputId: msg.params.inputId,
            },
          },
        });
      }, 80);
    }
  }
});
`;

const LEGACY_CREATE_PARAMS_FAKE_AGENT = `
let buf = "";
let currentWorkspace = null;
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
function createSnapshot(workspace, thoughtLevel) {
  return {
    protocol: { name: "ZCode Protocol", version: 1 },
    session: {
      sessionId: "sess_compat",
      workspace,
      sessionKind: "interactive",
      title: "Compat",
      mode: "build",
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
    },
    settings: {
      model: {
        current: { providerId: "glm", modelId: "glm-4.6" },
        available: [{ ref: { providerId: "glm", modelId: "glm-4.6" }, label: "GLM 4.6", properties: ${protocolModelPropertiesJson} }],
      },
      thoughtLevel: {
        enabled: true,
        current: thoughtLevel,
        available: [{ value: "max", label: "Max" }],
      },
      mode: { current: "build" },
    },
    projection: {
      sessionId: "sess_compat",
      status: "idle",
      mode: "build",
      turnCount: 0,
      totalTokenCount: 0,
      contextUsed: 0,
      contextWindow: 128000,
      pendingPermissions: [],
      activeToolCalls: [],
      backgroundJobs: [],
    },
    runtime: { eventSeq: 0, stateRevision: thoughtLevel ? 2 : 1, pendingRequestIds: [] },
    messages: [],
  };
}
function invalidParams(id, keys) {
  send({
    id,
    error: {
      code: -32602,
      message: "Invalid params",
      data: {
        name: "ZodError",
        message: JSON.stringify([
          {
            code: "unrecognized_keys",
            keys,
            path: [],
            message: "Unrecognized key",
          },
        ]),
      },
    },
  });
}
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "session/create" && msg.id !== undefined) {
      const rejectedKeys = [];
      if (Object.prototype.hasOwnProperty.call(msg.params, "persistence")) {
        rejectedKeys.push("persistence");
      }
      if (Object.prototype.hasOwnProperty.call(msg.params, "thoughtLevel")) {
        rejectedKeys.push("thoughtLevel");
      }
      if (Object.prototype.hasOwnProperty.call(msg.params, "mcpServers")) {
        rejectedKeys.push("mcpServers");
      }
      if (rejectedKeys.length > 0) {
        invalidParams(msg.id, rejectedKeys);
      } else {
        currentWorkspace = msg.params.workspace;
        send({ id: msg.id, result: createSnapshot(msg.params.workspace, undefined) });
      }
      continue;
    }
    if (msg.method === "session/setThoughtLevel" && msg.id !== undefined) {
      send({ id: msg.id, result: createSnapshot(currentWorkspace, msg.params.thoughtLevel) });
    }
  }
});
`;

const AUTOMATION_BINDING_CHECK_FAKE_AGENT = `
const fs = require("node:fs");
const logPath = process.argv[2];
let buf = "";
let requested = false;
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
setTimeout(() => {
  if (requested) return;
  requested = true;
  send({
    id: "binding-check-1",
    method: "automation/checkTaskBinding",
    params: { targetTaskId: "session-1" },
  });
}, 25);
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === "binding-check-1" && (msg.result || msg.error)) {
      fs.writeFileSync(logPath, JSON.stringify(msg));
    }
  }
});
`;

const STALE_THEN_PLUGIN_LIST_FAKE_AGENT = `
const fs = require("node:fs");
const markerPath = process.argv[2];
const shouldHang = !fs.existsSync(markerPath);
if (shouldHang) fs.writeFileSync(markerPath, "hung-once");
let buf = "";
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "plugins/list" && msg.id !== undefined) {
      if (shouldHang) continue;
      send({
        id: msg.id,
        result: {
          plugins: [{
            id: "skill-creator@zcode-plugins-official",
            name: "skill-creator",
            enabled: true,
            source: "official",
            marketplace: "zcode-plugins-official",
            skillCount: 1,
            skillRootCount: 1,
            commandRootCount: 0,
            mcpServerNames: [],
            rootPath: "/cache/skill-creator",
          }],
          diagnostics: [],
        },
      });
    }
  }
});
`;

const STALE_THEN_MCP_LIST_FAKE_AGENT = `
const fs = require("node:fs");
const markerPath = process.argv[2];
const shouldHang = !fs.existsSync(markerPath);
if (shouldHang) fs.writeFileSync(markerPath, "hung-once");
let buf = "";
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "mcp/list" && msg.id !== undefined) {
      if (shouldHang) continue;
      send({
        id: msg.id,
        result: {
          statuses: {
            filesystem: {
              status: "disconnected",
              transport: "stdio",
              toolCount: 0,
              updatedAt: "2026-06-23T00:00:00.000Z",
            },
          },
        },
      });
    }
  }
});
`;

const MCP_LIST_ECHO_CWD_FAKE_AGENT = `
let buf = "";
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "mcp/list" && msg.id !== undefined) {
      send({
        id: msg.id,
        result: {
          statuses: {
            cwd: {
              status: "disconnected",
              transport: "stdio",
              toolCount: 0,
              updatedAt: "2026-06-23T00:00:00.000Z",
              error: msg.params.workspace.workspacePath,
            },
          },
        },
      });
    }
  }
});
`;

const MCP_LIST_ECHO_MCP_SERVERS_FAKE_AGENT = `
let buf = "";
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "mcp/list" && msg.id !== undefined) {
      send({
        id: msg.id,
        result: {
          statuses: {
            explicit: {
              status: "disconnected",
              transport: "stdio",
              toolCount: 0,
              updatedAt: "2026-06-23T00:00:00.000Z",
              error: JSON.stringify(msg.params.mcpServers ?? null),
            },
          },
        },
      });
    }
  }
});
`;

const MCP_LIST_ECHO_MODE_FAKE_AGENT = `
let buf = "";
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "mcp/list" && msg.id !== undefined) {
      send({
        id: msg.id,
        result: {
          statuses: {
            mode: {
              status: "disconnected",
              transport: "stdio",
              toolCount: 0,
              updatedAt: "2026-06-23T00:00:00.000Z",
              error: JSON.stringify(msg.params.mode ?? null),
            },
          },
        },
      });
    }
  }
});
`;

const MCP_LIST_REJECTS_MCP_SERVERS_ONCE_FAKE_AGENT = `
let buf = "";
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "mcp/list" && msg.id !== undefined) {
      if (msg.params.mcpServers !== undefined) {
        send({
          id: msg.id,
          error: {
            code: -32602,
            message: "Invalid params",
            data: {
              message: JSON.stringify([{ code: "unrecognized_keys", keys: ["mcpServers"], path: [] }]),
            },
          },
        });
        continue;
      }
      send({
        id: msg.id,
        result: {
          statuses: {
            fallback: {
              status: "disconnected",
              transport: "stdio",
              toolCount: 0,
              updatedAt: "2026-06-23T00:00:00.000Z",
              error: JSON.stringify(msg.params.mcpServers ?? null),
            },
          },
        },
      });
    }
  }
});
`;

const MCP_LIST_REJECTS_MODE_ONCE_FAKE_AGENT = `
let buf = "";
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "mcp/list" && msg.id !== undefined) {
      if (msg.params.mode !== undefined) {
        send({
          id: msg.id,
          error: {
            code: -32602,
            message: "Invalid params",
            data: {
              message: JSON.stringify([{ code: "unrecognized_keys", keys: ["mode"], path: [] }]),
            },
          },
        });
        continue;
      }
      send({
        id: msg.id,
        result: {
          statuses: {
            fallback: {
              status: "disconnected",
              transport: "stdio",
              toolCount: 0,
              updatedAt: "2026-06-23T00:00:00.000Z",
            },
          },
        },
      });
    }
  }
});
`;

// 模拟真实 CLI transport 的串行队列：同一进程内 mcp/list 一直不返回，
// 排在它后面的所有请求都拿不到响应（Bug：卸载插件被 30s 的 MCP 探测卡死）。
const SERIAL_QUEUE_HANG_ON_MCP_LIST_FAKE_AGENT = `
const fs = require("node:fs");
const markerPath = process.argv[2];
let buf = "";
let blocked = false;
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id === undefined || !msg.method) continue;
    if (blocked) continue;
    if (msg.method === "mcp/list") {
      blocked = true;
      fs.writeFileSync(markerPath, String(process.pid));
      continue;
    }
    if (msg.method === "plugins/uninstall") {
      send({ id: msg.id, result: { diagnostics: [] } });
    }
  }
});
`;

const PLUGIN_LIST_ECHO_CWD_FAKE_AGENT = `
let buf = "";
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "plugins/list" && msg.id !== undefined) {
      send({
        id: msg.id,
        result: {
          plugins: [{
            id: "cwd-check@zcode-plugins-official",
            name: "cwd-check",
            enabled: true,
            source: "official",
            marketplace: "zcode-plugins-official",
            skillCount: 0,
            skillRootCount: 0,
            commandRootCount: 0,
            mcpServerNames: [],
            rootPath: process.cwd(),
          }],
          diagnostics: [{
            code: "workspace-path",
            message: msg.params.workspace.workspacePath,
          }],
        },
      });
    }
  }
});
`;

const PLUGIN_UPDATE_ECHO_FAKE_AGENT = `
let buf = "";
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "plugins/update" && msg.id !== undefined) {
      send({
        id: msg.id,
        result: {
          installedPlugins: [],
          dependencyClosure: [],
          diagnostics: [{
            code: "echo-plugin-id",
            message: String(msg.params.pluginId),
          }],
        },
      });
    }
  }
});
`;

const PLUGIN_RESTORE_BUILTIN_ECHO_FAKE_AGENT = `
let buf = "";
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "plugins/restoreBuiltin" && msg.id !== undefined) {
      send({
        id: msg.id,
        result: {
          pluginId: msg.params.pluginId,
          diagnostics: [],
        },
      });
    }
  }
});
`;

const INTERACTION_PREFERENCES_FAKE_AGENT = `
const fs = require("node:fs");
const logPath = process.argv[2];
const failFirst = process.argv[3] === "fail-first";
const delayFirst = process.argv[3] === "delay-first";
let buf = "";
let updateCount = 0;
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === "workspace/updateModelIoPreferences" && msg.id !== undefined) {
      fs.appendFileSync(logPath + ".model-io", JSON.stringify({
        method: msg.method,
        params: msg.params,
      }) + "\\n");
      send({
        id: msg.id,
        result: {
          workspace: msg.params.workspace,
          fullRetentionEnabled: msg.params.preferences.fullRetentionEnabled,
          updatedSessionCount: 0,
        },
      });
      continue;
    }
    if (msg.method !== "workspace/updateInteractionPreferences" || msg.id === undefined) {
      continue;
    }
    updateCount += 1;
    fs.appendFileSync(logPath, JSON.stringify({
      method: msg.method,
      params: msg.params,
      updateCount,
    }) + "\\n");
    if (failFirst && updateCount === 1) {
      send({ id: msg.id, error: { code: -32000, message: "transient sync failure" } });
      continue;
    }
    const response = {
      id: msg.id,
      result: {
        workspace: msg.params.workspace,
        askUserQuestionAutoResolutionEnabled:
          msg.params.preferences.askUserQuestionAutoResolutionEnabled,
        snoozedInteractionCount: 0,
      },
    };
    if (delayFirst && updateCount === 1) {
      setTimeout(() => send(response), 100);
    } else {
      send(response);
    }
  }
});
`;

describe("createZCodeAgentService", () => {
  it("资源查询仅观察就绪的现存 runtime，透传取消且不启动或等待迁移", async () => {
    const request = vi.fn(async () => ({ processes: [] }));
    const migratingRequest = vi.fn();
    const enumeration = vi
      .spyOn(ZCodeAgentProcessManager.prototype, "listManagedProcesses")
      .mockReturnValue([])
      .mockReturnValueOnce([
        {
          pid: 101,
          workspacePath: "/ready",
          client: {
            request,
            isDisposed: false,
            storageStartup: { isWaiting: false },
          } as unknown as ZCodeProtocolClient,
        },
        {
          pid: 102,
          workspacePath: "/migrating",
          client: {
            request: migratingRequest,
            isDisposed: false,
            storageStartup: { isWaiting: true },
          } as unknown as ZCodeProtocolClient,
        },
      ]);
    const commandResolver = vi.fn(() => null);
    const service = createZCodeAgentService({ commandResolver });
    const controller = new AbortController();
    try {
      await expect(service.collectLocalRuntimeChildProcesses(controller.signal)).resolves.toEqual([
        { pid: 101, workspacePath: "/ready", provider: "glm", children: [] },
      ]);
      expect(request).toHaveBeenCalledWith("process/childProcesses", {}, expect.anything(), {
        lifecycle: "observation",
        timeoutMs: 800,
        signal: controller.signal,
      });
      expect(migratingRequest).not.toHaveBeenCalled();
      expect(commandResolver).not.toHaveBeenCalled();
    } finally {
      enumeration.mockRestore();
      await service.disposeAllAndWait();
    }
  });

  it("does not resolve or spawn a command while provider/model is unavailable", async () => {
    const commandResolver = vi.fn(() => ({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000);"],
    }));
    const processLifecycleReporter = {
      onSpawn: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    };
    const service = createZCodeAgentService({
      commandResolver,
      processLifecycleReporter,
      modelSelectionReadinessSource: {
        async getView() {
          return { revision: 1, providers: [] };
        },
      },
    });

    await expect(
      service.initialize({ workspacePath: "/workspace/provider-waiting" }),
    ).resolves.toMatchObject({
      available: false,
      reasonCode: "provider_not_ready",
    });
    expect(commandResolver).not.toHaveBeenCalled();
    expect(processLifecycleReporter.onSpawn).not.toHaveBeenCalled();
    expect(processLifecycleReporter.onError).not.toHaveBeenCalled();
    await service.disposeAllAndWait();
  });

  const createdDirs: string[] = [];

  afterEach(() => {
    setDataBaseDir(null);
    for (const dir of createdDirs.splice(0).reverse()) {
      // 根因同 zcodeAgentService.v4.test.ts：Windows 上仍有打开句柄的目录删不掉，
      // `force: true` 不重试，afterEach 会以 EPERM 把断言已通过的用例判成失败。
      try {
        rmSync(dir, {
          recursive: true,
          force: true,
          maxRetries: 20,
          retryDelay: 100,
        });
      } catch {
        /* 清理失败不影响断言结论，交给操作系统回收临时目录。 */
      }
    }
  });

  it("caches interaction preferences without spawning and applies ordered snapshots to active/new runtimes", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-interaction-preferences-"));
    createdDirs.push(workspacePath);
    const scriptPath = join(workspacePath, "interaction-preferences-agent.cjs");
    const logPath = join(workspacePath, "protocol.log");
    writeFileSync(scriptPath, INTERACTION_PREFERENCES_FAKE_AGENT);
    const commandResolver = vi.fn(() => ({
      command: process.execPath,
      args: [scriptPath, logPath],
    }));
    const service = createReadyZCodeAgentService({ commandResolver });

    try {
      await service.syncAppRuntimePreferences({
        askUserQuestionAutoResolutionEnabled: false,
        modelIoFullRetentionEnabled: false,
      });
      expect(commandResolver).not.toHaveBeenCalled();

      await expect(service.initialize({ workspacePath })).resolves.toMatchObject({
        available: true,
      });
      await Promise.all([
        service.syncAppRuntimePreferences({
          askUserQuestionAutoResolutionEnabled: true,
          modelIoFullRetentionEnabled: true,
        }),
        service.syncAppRuntimePreferences({
          askUserQuestionAutoResolutionEnabled: false,
          modelIoFullRetentionEnabled: false,
        }),
      ]);

      const updates = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              params: {
                preferences: {
                  askUserQuestionAutoResolutionEnabled: boolean;
                };
                workspace: {
                  workspaceKey: string;
                  workspacePath: string;
                };
              };
            },
        );
      expect(
        updates.map((entry) => entry.params.preferences.askUserQuestionAutoResolutionEnabled),
      ).toEqual([false, true, false]);
      expect(updates[0]?.params.workspace).toMatchObject({
        workspaceKey: workspacePath,
        workspacePath,
      });
      const modelIoUpdates = readFileSync(`${logPath}.model-io`, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              params: { preferences: { fullRetentionEnabled: boolean } };
            },
        );
      expect(modelIoUpdates.map((entry) => entry.params.preferences.fullRetentionEnabled)).toEqual([
        false,
        true,
        false,
      ]);
      expect(commandResolver).toHaveBeenCalledTimes(1);

      await service.disposeWorkspace({ workspacePath });
      await expect(service.initialize({ workspacePath })).resolves.toMatchObject({
        available: true,
      });
      const restartedUpdates = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { params: { preferences: object } });
      expect(restartedUpdates).toHaveLength(4);
      expect(restartedUpdates[3]?.params.preferences).toEqual({
        askUserQuestionAutoResolutionEnabled: false,
      });
      expect(commandResolver).toHaveBeenCalledTimes(2);
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("retries cached interaction preferences when a new runtime sync fails", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-interaction-retry-"));
    createdDirs.push(workspacePath);
    const scriptPath = join(workspacePath, "interaction-preferences-agent.cjs");
    const logPath = join(workspacePath, "protocol.log");
    writeFileSync(scriptPath, INTERACTION_PREFERENCES_FAKE_AGENT);
    const service = createReadyZCodeAgentService({
      commandResolver: () => ({
        command: process.execPath,
        args: [scriptPath, logPath, "fail-first"],
      }),
    });

    try {
      await service.syncAppRuntimePreferences({
        askUserQuestionAutoResolutionEnabled: false,
      });
      await expect(service.initialize({ workspacePath })).resolves.toMatchObject({
        available: false,
      });
      await expect(service.initialize({ workspacePath })).resolves.toMatchObject({
        available: true,
      });

      const updates = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { updateCount: number });
      expect(updates.map((entry) => entry.updateCount)).toEqual([1, 2]);
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("does not lose a rapid preference toggle while a new runtime is applying its cache", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-interaction-startup-race-"));
    createdDirs.push(workspacePath);
    const scriptPath = join(workspacePath, "interaction-preferences-agent.cjs");
    const logPath = join(workspacePath, "protocol.log");
    writeFileSync(scriptPath, INTERACTION_PREFERENCES_FAKE_AGENT);
    const service = createReadyZCodeAgentService({
      commandResolver: () => ({
        command: process.execPath,
        args: [scriptPath, logPath, "delay-first"],
      }),
    });

    try {
      await service.syncAppRuntimePreferences({
        askUserQuestionAutoResolutionEnabled: false,
      });
      const initializing = service.initialize({ workspacePath });
      await vi.waitFor(() => expect(existsSync(logPath)).toBe(true));
      const enabling = service.syncAppRuntimePreferences({
        askUserQuestionAutoResolutionEnabled: true,
      });

      await expect(initializing).resolves.toMatchObject({ available: true });
      await expect(enabling).resolves.toBeUndefined();
      const updates = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              params: {
                preferences: {
                  askUserQuestionAutoResolutionEnabled: boolean;
                };
              };
            },
        );
      expect(updates[0]?.params.preferences.askUserQuestionAutoResolutionEnabled).toBe(false);
      expect(updates.at(-1)?.params.preferences.askUserQuestionAutoResolutionEnabled).toBe(true);
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("dispatcher 缺失时 Run Now 不创建台账或占用 manual claim", async () => {
    const sandboxRoot = mkdtempSync(join(tmpdir(), "zcode-agent-service-run-now-"));
    createdDirs.push(sandboxRoot);
    setDataBaseDir(sandboxRoot);
    const workspacePath = "/workspace/run-now";
    const serviceWithoutDispatcher = createZCodeAgentService();
    const automation = await serviceWithoutDispatcher.createAutomation({
      workspacePath,
      title: "daily check",
      cronExpr: "0 9 * * *",
      prompt: "check logs",
      recurring: true,
    });

    await expect(
      serviceWithoutDispatcher.runAutomationNow({
        workspacePath,
        automationId: automation.automationId,
      }),
    ).rejects.toThrow("Automation immediate dispatcher is unavailable.");
    await expect(
      serviceWithoutDispatcher.listAutomationRuns({
        workspacePath,
        automationId: automation.automationId,
      }),
    ).resolves.toEqual([]);

    const dispatch = vi.fn(async () => undefined);
    const serviceWithDispatcher = createZCodeAgentService({
      onAutomationManualRunRequested: dispatch,
    });
    await expect(
      serviceWithDispatcher.runAutomationNow({
        workspacePath,
        automationId: automation.automationId,
      }),
    ).resolves.toEqual({ status: "queued" });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("automation/checkTaskBinding 不依赖完整列表字段，历史空 mode 仍可完成归属判断", async () => {
    const sandboxRoot = mkdtempSync(join(tmpdir(), "zcode-agent-binding-check-"));
    createdDirs.push(sandboxRoot);
    setDataBaseDir(sandboxRoot);
    const workspacePath = sandboxRoot;
    const scriptPath = join(sandboxRoot, "binding-check-agent.cjs");
    const logPath = join(sandboxRoot, "binding-check-response.json");
    writeFileSync(scriptPath, AUTOMATION_BINDING_CHECK_FAKE_AGENT);
    const service = createReadyZCodeAgentService({
      commandResolver: () => ({ command: process.execPath, args: [scriptPath, logPath] }),
    });
    const automation = await service.createAutomation({
      workspacePath,
      title: "legacy task",
      cronExpr: "0 9 * * *",
      prompt: "summarize",
      mode: "build",
      recurring: true,
    });
    const db = new DatabaseSync(getTasksIndexDatabasePath());
    db.prepare(
      "UPDATE automations SET mode = '', target_task_id = 'session-1' WHERE automation_id = ?",
    ).run(automation.automationId);
    db.close();

    try {
      await expect(service.initialize({ workspacePath })).resolves.toMatchObject({
        available: true,
      });
      await vi.waitFor(() => expect(existsSync(logPath)).toBe(true), { timeout: 5000 });
      expect(JSON.parse(readFileSync(logPath, "utf8"))).toEqual({
        id: "binding-check-1",
        result: { bound: true },
      });
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("reports unavailable without starting a process when no command is configured", async () => {
    const service = createReadyZCodeAgentService({ commandResolver: () => null });

    await expect(
      service.initialize({
        workspacePath: "/workspace/app",
        workspaceIdentity: "remote:ssh:dev:/workspace/app",
      }),
    ).resolves.toMatchObject({
      available: false,
      workspaceKey: "remote:ssh:dev:/workspace/app",
      protocolName: "ZCode Protocol",
      protocolVersion: 1,
    });
  });

  it("starts stdio app-server during initialize", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-service-"));
    createdDirs.push(workspacePath);
    const commandResolver = vi.fn(() => ({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000);"],
    }));
    const processLifecycleReporter = {
      onSpawn: vi.fn(),
      onReady: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    };
    const service = createReadyZCodeAgentService({ commandResolver, processLifecycleReporter });

    await expect(
      service.initialize({
        workspacePath,
      }),
    ).resolves.toMatchObject({
      available: true,
      workspaceKey: workspacePath,
      protocolName: "ZCode Protocol",
      protocolVersion: 1,
      transportKind: "stdio",
    });
    expect(commandResolver).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(processLifecycleReporter.onReady).toHaveBeenCalledTimes(1));
    expect(processLifecycleReporter.onReady.mock.calls[0]![0]).toMatchObject({
      pid: processLifecycleReporter.onSpawn.mock.calls[0]![0].pid,
      provider: "glm",
      workspacePath,
      runtimeGeneration: 1,
      runtimeInstanceId: processLifecycleReporter.onSpawn.mock.calls[0]![0].runtimeInstanceId,
      readyAt: expect.any(Number),
      startupDurationMs: expect.any(Number),
    });

    await expect(
      service.initialize({
        workspacePath,
      }),
    ).resolves.toMatchObject({ available: true });
    expect(processLifecycleReporter.onReady).toHaveBeenCalledTimes(1);

    await service.disposeAllAndWait();
    await vi.waitFor(() => expect(processLifecycleReporter.onExit).toHaveBeenCalledTimes(1));
    expect(processLifecycleReporter.onExit.mock.calls[0]![0]).toMatchObject({
      runtimeReady: true,
      runtimeInstanceId: processLifecycleReporter.onReady.mock.calls[0]![0].runtimeInstanceId,
    });
  });

  it("routes browser discovery and browserId-aware execute with full remote context", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-service-browser-"));
    createdDirs.push(workspacePath);
    const scriptPath = join(workspacePath, "browser-agent.cjs");
    writeFileSync(scriptPath, BROWSER_DISCOVERY_FAKE_AGENT);
    const list = vi.fn(async () => [
      {
        id: "iab-runtime-1",
        generation: 1,
        type: "iab" as const,
        name: "ZCode In-app Browser",
        capabilities: {},
      },
    ]);
    const execute = vi.fn(async () => ({
      ok: true,
      state: {
        url: "https://example.com",
        title: "Example",
        canGoBack: false,
        canGoForward: false,
      },
      elapsedMs: 1,
    }));
    const service = createReadyZCodeAgentService({
      commandResolver: () => ({ command: process.execPath, args: [scriptPath] }),
      browserControlExecutor: { list, execute },
    });
    const subscription = service.onDynamicSessionEvent({
      workspacePath,
      workspaceIdentity: "remote:ssh:dev:/workspace/app",
      sessionId: "sess-browser",
      deliveryKind: "web-remote-replayable",
      includeSnapshot: false,
    })(() => {});

    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1), {
      timeout: 5000,
      interval: 25,
    });
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceKey: "remote:ssh:dev:/workspace/app",
        workspaceIdentity: "remote:ssh:dev:/workspace/app",
        remoteSessionId: "remote-session-1",
        clientMode: "web-remote-replayable",
      }),
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "browser-execute-request",
        browserId: "iab-runtime-1",
        browserGeneration: 1,
        sessionId: "sess-browser",
        turnId: "turn-browser-1",
        workspaceKey: "remote:ssh:dev:/workspace/app",
        workspaceIdentity: "remote:ssh:dev:/workspace/app",
        remoteSessionId: "remote-session-1",
        clientMode: "web-remote-replayable",
        command: { method: "getState" },
      }),
    );

    subscription.dispose();
    await service.disposeAllAndWait();
  });

  it("passes session tool lists through protocol session/create", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-service-tool-list-"));
    createdDirs.push(workspacePath);
    const scriptPath = join(workspacePath, "tool-list-agent.cjs");
    const logPath = join(workspacePath, "protocol.log");
    writeFileSync(scriptPath, SHELL_SETTINGS_SNAPSHOT_FAKE_AGENT);
    // 修复原因：本用例只验证 session/create 的工具列表透传，不验证 provider readiness。
    // 门禁启用后必须复用标准 ready registry fixture，否则测试会在协议请求前被正确拦截。
    const service = createReadyZCodeAgentService({
      commandResolver: () => ({ command: process.execPath, args: [scriptPath, logPath] }),
    });

    try {
      await service.createSession({
        workspacePath,
        toolAllowlist: ["mcp__zcode-cua__request_access", "mcp__zcode-cua__list_apps"],
        toolDenylist: ["Bash"],
      });

      const createRequest = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> })
        .find((entry) => entry.method === "session/create");
      expect(createRequest?.params.toolAllowlist).toEqual([
        "mcp__zcode-cua__request_access",
        "mcp__zcode-cua__list_apps",
      ]);
      expect(createRequest?.params.toolDenylist).toEqual(["Bash"]);
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("resolves runtime preferences at materialization and first execution without forwarding them", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-service-shell-snapshot-"));
    createdDirs.push(workspacePath);
    const scriptPath = join(workspacePath, "shell-settings-agent.cjs");
    const logPath = join(workspacePath, "protocol.log");
    writeFileSync(scriptPath, SHELL_SETTINGS_SNAPSHOT_FAKE_AGENT);
    const resolveSessionRuntimePreferences = vi.fn(
      async (scope: ZCodeSessionRuntimePreferencesScope) => ({
        askUserQuestionAutoResolutionEnabled: false,
        nativeSearchEnhancementsEnabled: false,
        memoryEnabled: false,
        modelContextBudgetStrategy:
          scope === "runtime-materialization" ? ("preflight-v1" as const) : ("legacy" as const),
        ...(scope === "user-execution"
          ? {
              integratedTerminalShell: {
                mode: "shell" as const,
                dialect: "git-bash" as const,
                id: "git-bash:/usr/bin/new-session-bash",
                label: "Git Bash",
                path: "/usr/bin/new-session-bash",
              },
            }
          : {}),
      }),
    );
    const service = createReadyZCodeAgentService({
      commandResolver: () => ({ command: process.execPath, args: [scriptPath, logPath] }),
      resolveSessionRuntimePreferences,
    });

    const created = await service.createSession({ workspacePath });
    expect(resolveSessionRuntimePreferences).toHaveBeenCalledTimes(1);
    expect(resolveSessionRuntimePreferences).toHaveBeenNthCalledWith(1, "runtime-materialization");
    await service.resumeSession({
      workspacePath,
      sessionId: created.session.sessionId,
    });
    expect(resolveSessionRuntimePreferences).toHaveBeenCalledTimes(1);
    await service.sendPrompt({
      workspacePath,
      sessionId: created.session.sessionId,
      content: "continue",
    });
    expect(resolveSessionRuntimePreferences).toHaveBeenCalledTimes(2);
    expect(resolveSessionRuntimePreferences).toHaveBeenNthCalledWith(2, "user-execution");
    await service.sendPrompt({
      workspacePath,
      sessionId: created.session.sessionId,
      content: "second prompt",
      modelSelection: {
        providerId: "test-provider",
        modelId: "test-model",
        options: { reasoningLevel: "high" },
      },
      modelExecution: { selectionScope: "execution", memoryExtraction: "skip" },
    });

    const requests = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
    expect(resolveSessionRuntimePreferences).toHaveBeenCalledTimes(2);
    expect(requests).toMatchObject([
      { method: "session/create" },
      { method: "session/resume" },
      { method: "session/send" },
      {
        method: "session/send",
        params: {
          modelSelection: {
            providerId: "test-provider",
            modelId: "test-model",
            options: { reasoningLevel: "high" },
          },
          modelExecution: { selectionScope: "execution", memoryExtraction: "skip" },
        },
      },
    ]);
    for (const request of requests) {
      expect(request.params).not.toHaveProperty("integratedTerminalShell");
      expect(request.params).not.toHaveProperty("nativeSearchEnhancementsEnabled");
      expect(request.params).not.toHaveProperty("memoryEnabled");
      expect(request.params).not.toHaveProperty("modelContextBudgetStrategy");
    }

    await service.disposeAllAndWait();
  });

  it("adds bounded IAB ambient context to session/send without changing prompt content", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-service-browser-ambient-"));
    createdDirs.push(workspacePath);
    const scriptPath = join(workspacePath, "browser-ambient-agent.cjs");
    const logPath = join(workspacePath, "protocol.log");
    writeFileSync(scriptPath, SHELL_SETTINGS_SNAPSHOT_FAKE_AGENT);
    const list = vi.fn(async () => [
      {
        id: "iab-runtime-1",
        generation: 3,
        type: "iab" as const,
        name: "ZCode In-app Browser",
        capabilities: {},
      },
    ]);
    const execute = vi.fn(async (input: { command: { method: string } }) =>
      input.command.method === "list"
        ? { ok: true, tabs: [], elapsedMs: 0 }
        : {
            ok: true,
            userTabs: [
              {
                id: "user-tab-1",
                title: "Current",
                url: "https://example.com/current?q=1",
              },
            ],
            elapsedMs: 0,
          },
    );
    const service = createReadyZCodeAgentService({
      commandResolver: () => ({
        command: process.execPath,
        args: [scriptPath, logPath],
      }),
      browserControlExecutor: { list, execute } as never,
    });

    const workspaceIdentity = "remote:ssh:dev:/workspace/app";
    const created = await service.createSession({
      workspacePath,
      workspaceIdentity,
    });
    await service.sendPrompt({
      workspacePath,
      workspaceIdentity,
      remoteSessionId: "remote-session-1",
      sessionId: created.session.sessionId,
      clientMode: "web-remote-replayable",
      content: "continue",
    });

    const sendRequest = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            method: string;
            params: Record<string, unknown>;
          },
      )
      .find((request) => request.method === "session/send");
    expect(sendRequest?.params).toMatchObject({
      content: "continue",
      browserAmbientContext: {
        tabCount: 1,
        currentUrl: "https://example.com/current?q=1",
      },
    });
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceKey: workspaceIdentity,
        remoteSessionId: "remote-session-1",
        clientMode: "web-remote-replayable",
      }),
    );
    expect(execute).toHaveBeenCalledTimes(2);

    await service.disposeAllAndWait();
  });

  it("retries session/send without browser ambient context when a legacy agent returns an enhanced invalid params error", async () => {
    const workspacePath = mkdtempSync(
      join(tmpdir(), "zcode-agent-service-browser-ambient-compat-"),
    );
    createdDirs.push(workspacePath);
    const scriptPath = join(workspacePath, "browser-ambient-compat-agent.cjs");
    const logPath = join(workspacePath, "protocol.log");
    writeFileSync(scriptPath, SHELL_SETTINGS_SNAPSHOT_FAKE_AGENT);
    const service = createReadyZCodeAgentService({
      commandResolver: () => ({
        command: process.execPath,
        args: [scriptPath, logPath, "reject-browser-ambient"],
      }),
      browserControlExecutor: {
        list: vi.fn(async () => [
          {
            id: "iab-runtime-legacy",
            generation: 1,
            type: "iab" as const,
            name: "ZCode In-app Browser",
            capabilities: {},
          },
        ]),
        execute: vi.fn(async (input: { command: { method: string } }) =>
          input.command.method === "list"
            ? { ok: true, tabs: [], elapsedMs: 0 }
            : {
                ok: true,
                userTabs: [
                  {
                    id: "user-tab-legacy",
                    title: "Current",
                    url: "https://example.com/current",
                  },
                ],
                elapsedMs: 0,
              },
        ),
      } as never,
    });

    const created = await service.createSession({ workspacePath });
    await expect(
      service.sendPrompt({
        workspacePath,
        sessionId: created.session.sessionId,
        content: "continue",
      }),
    ).resolves.toMatchObject({ accepted: true });

    const sendRequests = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            method: string;
            params: Record<string, unknown>;
          },
      )
      .filter((request) => request.method === "session/send");
    expect(sendRequests).toHaveLength(2);
    expect(sendRequests[0]?.params).toHaveProperty("browserAmbientContext");
    expect(sendRequests[1]?.params).not.toHaveProperty("browserAmbientContext");
    expect(sendRequests[1]?.params.content).toBe("continue");

    await service.disposeAllAndWait();
  });

  it("resolves execution preferences before a deferred draft accepts its first prompt", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-service-shell-draft-"));
    createdDirs.push(workspacePath);
    const scriptPath = join(workspacePath, "shell-settings-agent.cjs");
    const logPath = join(workspacePath, "protocol.log");
    writeFileSync(scriptPath, SHELL_SETTINGS_SNAPSHOT_FAKE_AGENT);
    const resolveSessionRuntimePreferences = vi.fn(async () => ({
      askUserQuestionAutoResolutionEnabled: true,
      nativeSearchEnhancementsEnabled: true,
      memoryEnabled: true,
      integratedTerminalShell: {
        mode: "shell" as const,
        dialect: "git-bash" as const,
        id: "git-bash:/usr/bin/first-send-bash",
        label: "Git Bash",
        path: "/usr/bin/first-send-bash",
      },
    }));
    const service = createReadyZCodeAgentService({
      commandResolver: () => ({ command: process.execPath, args: [scriptPath, logPath] }),
      resolveSessionRuntimePreferences,
    });

    const draft = await service.createSession({ workspacePath, persistence: "deferred" });
    expect(resolveSessionRuntimePreferences).toHaveBeenCalledTimes(1);

    await service.sendPrompt({
      workspacePath,
      sessionId: draft.session.sessionId,
      content: "first prompt",
    });

    const requests = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
    expect(resolveSessionRuntimePreferences).toHaveBeenCalledTimes(2);
    expect(requests).toMatchObject([
      {
        method: "session/create",
        params: {
          persistence: "deferred",
        },
      },
      {
        method: "session/send",
      },
    ]);
    for (const request of requests) {
      expect(request.params).not.toHaveProperty("integratedTerminalShell");
      expect(request.params).not.toHaveProperty("nativeSearchEnhancementsEnabled");
      expect(request.params).not.toHaveProperty("memoryEnabled");
    }

    await service.disposeAllAndWait();
  });

  it("answers Agent runtime preference requests from the Host resolver", async () => {
    const cases: Array<{
      name: string;
      requestMode?: "invalid" | "valid";
      resolver?: ReturnType<
        typeof vi.fn<
          () => Promise<{
            askUserQuestionAutoResolutionEnabled: boolean;
            nativeSearchEnhancementsEnabled: boolean;
            memoryEnabled: boolean;
          }>
        >
      >;
      expectedResult?: {
        askUserQuestionAutoResolutionEnabled: boolean;
        nativeSearchEnhancementsEnabled: boolean;
        subagentRuntimeConfigEnabled: boolean;
        memoryEnabled: boolean;
        modelContextBudgetStrategy: "legacy" | "preflight-v1";
      };
      expectedErrorCode?: number;
      expectedResolverCalls: number;
    }> = [
      {
        name: "current-setting",
        resolver: vi.fn(async () => ({
          askUserQuestionAutoResolutionEnabled: false,
          nativeSearchEnhancementsEnabled: false,
          memoryEnabled: false,
        })),
        expectedResult: {
          askUserQuestionAutoResolutionEnabled: false,
          nativeSearchEnhancementsEnabled: false,
          subagentRuntimeConfigEnabled: false,
          memoryEnabled: false,
          modelContextBudgetStrategy: "preflight-v1" as const,
        },
        expectedResolverCalls: 1,
      },
      {
        name: "missing-resolver",
        expectedResult: {
          askUserQuestionAutoResolutionEnabled: true,
          nativeSearchEnhancementsEnabled: true,
          subagentRuntimeConfigEnabled: false,
          memoryEnabled: false,
          modelContextBudgetStrategy: "preflight-v1" as const,
        },
        expectedResolverCalls: 0,
      },
      {
        name: "resolver-failure",
        resolver: vi.fn(async () => {
          throw new Error("setting failed");
        }),
        expectedErrorCode: -32603,
        expectedResolverCalls: 1,
      },
      {
        name: "invalid-params",
        requestMode: "invalid",
        resolver: vi.fn(async () => ({
          askUserQuestionAutoResolutionEnabled: false,
          nativeSearchEnhancementsEnabled: false,
          memoryEnabled: false,
        })),
        expectedErrorCode: -32602,
        expectedResolverCalls: 0,
      },
    ];

    for (const testCase of cases) {
      const workspacePath = mkdtempSync(
        join(tmpdir(), `zcode-agent-runtime-preferences-${testCase.name}-`),
      );
      createdDirs.push(workspacePath);
      const scriptPath = join(workspacePath, "runtime-preferences-agent.cjs");
      const logPath = join(workspacePath, "protocol.log");
      writeFileSync(scriptPath, RUNTIME_PREFERENCES_FAKE_AGENT);
      const service = createReadyZCodeAgentService({
        commandResolver: () => ({
          command: process.execPath,
          args: [scriptPath, logPath, testCase.requestMode ?? "valid"],
        }),
        resolveSessionRuntimePreferences: testCase.resolver,
      });

      try {
        await service.createSession({ workspacePath });
        const response = readFileSync(logPath, "utf8")
          .trim()
          .split("\n")
          .map(
            (line) =>
              JSON.parse(line) as {
                error?: { code: number; message: string };
                method: string;
                result?: {
                  askUserQuestionAutoResolutionEnabled: boolean;
                  nativeSearchEnhancementsEnabled: boolean;
                  subagentRuntimeConfigEnabled: boolean;
                  memoryEnabled: boolean;
                  modelContextBudgetStrategy: "legacy" | "preflight-v1";
                };
              },
          )
          .find((entry) => entry.method === "session/requestRuntimePreferences:response");

        expect(response, testCase.name).toBeDefined();
        if (testCase.expectedResult) {
          expect(response?.result, testCase.name).toEqual(testCase.expectedResult);
          expect(response?.error, testCase.name).toBeUndefined();
        } else {
          expect(response?.error, testCase.name).toMatchObject({
            code: testCase.expectedErrorCode,
          });
        }
        if (testCase.resolver) {
          expect(testCase.resolver, testCase.name).toHaveBeenCalledTimes(
            testCase.expectedResolverCalls,
          );
        }
      } finally {
        await service.disposeAllAndWait();
      }
    }
  });

  it("does not send a second runtime preference response after the Agent disconnects", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-runtime-preferences-close-"));
    createdDirs.push(workspacePath);
    const scriptPath = join(workspacePath, "runtime-preferences-agent.cjs");
    const logPath = join(workspacePath, "protocol.log");
    writeFileSync(scriptPath, RUNTIME_PREFERENCES_FAKE_AGENT);
    let markResolverStarted!: () => void;
    let releaseResolver!: () => void;
    let markResolverFinished!: () => void;
    const resolverStarted = new Promise<void>((resolve) => {
      markResolverStarted = resolve;
    });
    const resolverReleased = new Promise<void>((resolve) => {
      releaseResolver = resolve;
    });
    const resolverFinished = new Promise<void>((resolve) => {
      markResolverFinished = resolve;
    });
    const service = createReadyZCodeAgentService({
      commandResolver: () => ({
        command: process.execPath,
        args: [scriptPath, logPath, "disconnect"],
      }),
      resolveSessionRuntimePreferences: async () => {
        markResolverStarted();
        await resolverReleased;
        markResolverFinished();
        return {
          askUserQuestionAutoResolutionEnabled: false,
          nativeSearchEnhancementsEnabled: false,
          memoryEnabled: false,
        };
      },
    });

    try {
      const createResult = service.createSession({ workspacePath }).then(
        () => null,
        (error: unknown) => error,
      );
      await resolverStarted;
      expect(await createResult).toBeInstanceOf(Error);

      releaseResolver();
      await resolverFinished;
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("routes external runtime preference requests by opaque requestId", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "zcode-agent-external-preferences-"));
    const firstWorkspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-preferences-first-"));
    const secondWorkspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-preferences-second-"));
    createdDirs.push(fixtureDir, firstWorkspacePath, secondWorkspacePath);
    const scriptPath = join(fixtureDir, "runtime-preferences-agent.cjs");
    const logPath = join(fixtureDir, "protocol.log");
    writeFileSync(scriptPath, RUNTIME_PREFERENCES_FAKE_AGENT);
    const service = createReadyZCodeAgentService({
      commandResolver: () => ({ command: process.execPath, args: [scriptPath, logPath] }),
      sessionRuntimePreferencesAuthority: "external",
    });
    const requests: Array<{ requestId: string; sessionId: string; scope: string }> = [];
    const subscription = service.onDynamicSessionRuntimePreferencesRequest()((request) => {
      requests.push(request);
      void service.respondSessionRuntimePreferences({
        requestId: request.requestId,
        resolution: {
          status: "resolved",
          preferences: {
            askUserQuestionAutoResolutionEnabled: false,
            nativeSearchEnhancementsEnabled: false,
            memoryEnabled: false,
          },
        },
      });
    });

    try {
      await service.createSession({ workspacePath: firstWorkspacePath });
      await service.createSession({ workspacePath: secondWorkspacePath });

      expect(requests).toHaveLength(2);
      expect(new Set(requests.map((request) => request.requestId)).size).toBe(2);
      for (const request of requests) {
        expect(request).toMatchObject({
          sessionId: "sess_runtime_preferences",
          scope: "runtime-materialization",
        });
        expect(request).not.toHaveProperty("workspacePath");
        expect(request).not.toHaveProperty("workspaceIdentity");
      }
    } finally {
      subscription.dispose();
      await service.disposeAllAndWait();
    }
  });

  it("expires unanswered external runtime preference requests without replaying them", async () => {
    vi.useFakeTimers({ toFake: ["clearTimeout", "setTimeout"] });
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-preferences-timeout-"));
    createdDirs.push(workspacePath);
    const scriptPath = join(workspacePath, "runtime-preferences-agent.cjs");
    const logPath = join(workspacePath, "protocol.log");
    writeFileSync(scriptPath, RUNTIME_PREFERENCES_FAKE_AGENT);
    const service = createReadyZCodeAgentService({
      commandResolver: () => ({ command: process.execPath, args: [scriptPath, logPath] }),
      sessionRuntimePreferencesAuthority: "external",
    });
    let markRequestSeen!: () => void;
    const requestSeen = new Promise<void>((resolve) => {
      markRequestSeen = resolve;
    });
    const subscription = service.onDynamicSessionRuntimePreferencesRequest()(() => {
      markRequestSeen();
    });

    try {
      const createPromise = service.createSession({ workspacePath });
      await requestSeen;

      await vi.advanceTimersByTimeAsync(ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS);
      await createPromise;

      const response = readFileSync(logPath, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              error?: { code: number; data?: { timeoutMs?: number } };
              method: string;
            },
        )
        .find((entry) => entry.method === "session/requestRuntimePreferences:response");
      expect(response?.error).toEqual({
        code: -32022,
        data: {
          timeoutMs: ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
        },
        message: "Session runtime preferences request timed out",
      });

      subscription.dispose();
      const replayedRequests: unknown[] = [];
      const replaySubscription = service.onDynamicSessionRuntimePreferencesRequest()((request) => {
        replayedRequests.push(request);
      });
      expect(replayedRequests).toEqual([]);
      replaySubscription.dispose();
    } finally {
      subscription.dispose();
      vi.useRealTimers();
      await service.disposeAllAndWait();
    }
  });

  it("uses the compact-specific request timeout for delayed compact ACKs", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-service-compact-timeout-"));
    createdDirs.push(workspacePath);
    const scriptPath = join(workspacePath, "delayed-compact-agent.cjs");
    writeFileSync(scriptPath, DELAYED_COMPACT_FAKE_AGENT);
    const service = createReadyZCodeAgentService({
      commandResolver: () => ({ command: process.execPath, args: [scriptPath] }),
      requestTimeoutMs: 20,
    });

    try {
      const result = await service.compactSession({
        workspacePath,
        sessionId: "sess_compact_timeout",
        inputId: "input_compact_timeout",
      });

      expect(result.compact).toMatchObject({
        state: "accepted",
        inputId: "input_compact_timeout",
      });
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("retries session subscription after a transient subscribe failure", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-service-retry-"));
    createdDirs.push(workspacePath);
    const scriptPath = join(workspacePath, "flaky-agent.cjs");
    writeFileSync(scriptPath, FLAKY_SUBSCRIBE_FAKE_AGENT);
    const service = createReadyZCodeAgentService({
      commandResolver: () => ({ command: process.execPath, args: [scriptPath] }),
    });

    const received: ZCodeAgentServiceEvent[] = [];
    const subscription = service.onDynamicSessionEvent({
      workspacePath,
      sessionId: "sess-1",
      deliveryKind: "desktop-continuous",
      includeSnapshot: false,
    })((event) => received.push(event));

    // 第一次 subscribe 失败后必须重试，最终把成功响应里的事件投递出来。
    await vi.waitFor(
      () => {
        expect(received.some((event) => event.type === "session.event")).toBe(true);
      },
      { timeout: 5000, interval: 50 },
    );

    subscription.dispose();
    await service.disposeAllAndWait();
  });

  it("delivers subscribe replay events only to the subscriber that requested them", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-service-replay-"));
    createdDirs.push(workspacePath);
    const scriptPath = join(workspacePath, "replay-agent.cjs");
    writeFileSync(scriptPath, SUBSCRIBE_REPLAY_FAKE_AGENT);
    const service = createReadyZCodeAgentService({
      commandResolver: () => ({ command: process.execPath, args: [scriptPath] }),
    });

    const firstReceived: ZCodeAgentServiceEvent[] = [];
    const firstSubscription = service.onDynamicSessionEvent({
      workspacePath,
      sessionId: "sess-1",
      deliveryKind: "desktop-continuous",
      includeSnapshot: false,
    })((event) => firstReceived.push(event));

    await vi.waitFor(
      () => {
        expect(firstReceived.filter((event) => event.type === "session.event")).toHaveLength(1);
      },
      { timeout: 5000, interval: 50 },
    );

    const secondReceived: ZCodeAgentServiceEvent[] = [];
    const secondSubscription = service.onDynamicSessionEvent({
      workspacePath,
      sessionId: "sess-1",
      deliveryKind: "desktop-continuous",
      includeSnapshot: false,
    })((event) => secondReceived.push(event));

    await vi.waitFor(
      () => {
        expect(secondReceived.filter((event) => event.type === "session.event")).toHaveLength(1);
      },
      { timeout: 5000, interval: 50 },
    );

    // Bugfix: 第二个订阅者自己的 replay 缺口不能广播回第一个订阅者。
    expect(firstReceived.filter((event) => event.type === "session.event")).toHaveLength(1);

    firstSubscription.dispose();
    secondSubscription.dispose();
    await service.disposeAllAndWait();
  });

  it("reports only validated de-duplicated CUA sideband events without legacy session delivery", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-cua-operation-live-"));
    createdDirs.push(workspacePath);
    const scriptPath = join(workspacePath, "cua-operation-live-agent.cjs");
    writeFileSync(scriptPath, CUA_OPERATION_LIVE_EVENT_FAKE_AGENT);
    const reportedStates: Array<{ active: boolean; sessionId: string; turnId: string }> = [];
    const observedServiceActiveStates: boolean[] = [];
    let service: ReturnType<typeof createReadyZCodeAgentService>;
    const onStateChanged = vi.fn(
      (event: { active: boolean; sessionId: string; turnId: string }) => {
        reportedStates.push(event);
        observedServiceActiveStates.push(service.hasActiveCuaOperationTurn());
        if (event.active) throw new Error("host port closed");
      },
    );
    service = createReadyZCodeAgentService({
      commandResolver: () => ({ command: process.execPath, args: [scriptPath] }),
      cuaOperationStateReporter: { onStateChanged },
    });
    expect(service.hasActiveCuaOperationTurn()).toBe(false);
    const received: ZCodeAgentServiceEvent[] = [];
    const subscription = service.onDynamicSessionEvent({
      workspacePath,
      sessionId: "sess-cua-live",
      deliveryKind: "desktop-continuous",
      includeSnapshot: false,
    })((event) => received.push(event));

    try {
      await vi.waitFor(
        () => {
          expect(reportedStates.map((event) => event.active)).toEqual([true, false]);
        },
        { timeout: 5_000, interval: 50 },
      );

      const liveEvents = received
        .filter(
          (event): event is Extract<ZCodeAgentServiceEvent, { type: "session.event" }> =>
            event.type === "session.event",
        )
        .map((event) => event.event);
      expect(liveEvents).toEqual([]);
      expect(onStateChanged).toHaveBeenCalledTimes(2);
      expect(observedServiceActiveStates).toEqual([true, false]);
    } finally {
      subscription.dispose();
      await service.disposeAllAndWait();
    }
  });

  it("clears CUA state when the runtime becomes unavailable without a restart", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-cua-runtime-exit-"));
    createdDirs.push(workspacePath);
    const scriptPath = join(workspacePath, "cua-operation-runtime-exit-agent.cjs");
    writeFileSync(scriptPath, CUA_OPERATION_RUNTIME_EXIT_FAKE_AGENT);
    const reportedStates: boolean[] = [];
    const service = createReadyZCodeAgentService({
      commandResolver: () => ({ command: process.execPath, args: [scriptPath] }),
      cuaOperationStateReporter: {
        onStateChanged: (event) => reportedStates.push(event.active),
      },
    });
    const subscription = service.onDynamicSessionEvent({
      workspacePath,
      sessionId: "sess-cua-runtime-exit",
      deliveryKind: "desktop-continuous",
      includeSnapshot: false,
    })(() => undefined);

    try {
      await vi.waitFor(
        () => {
          expect(reportedStates).toEqual([true, false]);
          expect(service.hasActiveCuaOperationTurn()).toBe(false);
        },
        { timeout: 5_000, interval: 50 },
      );
    } finally {
      subscription.dispose();
      await service.disposeAllAndWait();
    }
  });

  it("retries createSession without optional fields rejected by legacy agents", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-service-compat-"));
    createdDirs.push(workspacePath);
    const scriptPath = join(workspacePath, "legacy-create-agent.cjs");
    writeFileSync(scriptPath, LEGACY_CREATE_PARAMS_FAKE_AGENT);
    const service = createReadyZCodeAgentService({
      commandResolver: () => ({ command: process.execPath, args: [scriptPath] }),
    });

    try {
      const snapshot = await service.createSession({
        workspacePath,
        model: { providerId: "glm", modelId: "glm-4.6" },
        persistence: "deferred",
        thoughtLevel: "max",
        mcpServers: [
          {
            name: "chrome-devtools",
            command: "npx",
            args: ["-y", "chrome-devtools-mcp@latest"],
            env: [],
          },
        ],
      });

      expect(snapshot.session.sessionId).toBe("sess_compat");
      expect(snapshot.settings.thoughtLevel.current).toBe("max");
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("restarts a stale protocol client and retries plugin list without provider registry sync", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-service-plugins-"));
    createdDirs.push(workspacePath);
    const scriptPath = join(workspacePath, "stale-plugin-agent.cjs");
    const markerPath = join(workspacePath, "first-run-marker");
    writeFileSync(scriptPath, STALE_THEN_PLUGIN_LIST_FAKE_AGENT);
    const commandResolver = vi.fn(() => ({
      command: process.execPath,
      args: [scriptPath, markerPath],
    }));
    const service = createReadyZCodeAgentService({
      commandResolver,
      // Bugfix: 该用例只需要首个 fake agent 超时，full suite 并发时第二个进程启动到响应可能超过 500ms。
      // 局部放宽 request timeout，避免把重启后成功恢复的路径误判成第二次 stale。
      requestTimeoutMs: 1_500,
    });

    try {
      const result = await service.listPlugins({ workspacePath });

      expect(result.plugins.map((plugin) => plugin.name)).toEqual(["skill-creator"]);
      expect(commandResolver).toHaveBeenCalledTimes(2);
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("loads plugin list from the dedicated plugin workspace when the real workspace is missing", async () => {
    const sandboxRoot = mkdtempSync(join(tmpdir(), "zcode-agent-service-plugin-cwd-"));
    createdDirs.push(sandboxRoot);
    setDataBaseDir(sandboxRoot);
    const scriptPath = join(sandboxRoot, "plugin-cwd-agent.cjs");
    writeFileSync(scriptPath, PLUGIN_LIST_ECHO_CWD_FAKE_AGENT);
    const missingWorkspacePath = join(sandboxRoot, "deleted-workspace");
    const pluginWorkspacePath = join(sandboxRoot, ".zcode", "plugin-workspace");
    const commandResolver = vi.fn(({ workspacePath }) => ({
      command: process.execPath,
      args: [scriptPath],
      cwd: workspacePath,
    }));
    const service = createReadyZCodeAgentService({ commandResolver });

    try {
      const result = await service.listPlugins({ workspacePath: missingWorkspacePath });

      expect(existsSync(pluginWorkspacePath)).toBe(true);
      expect(realpathSync(result.plugins[0]!.rootPath)).toBe(realpathSync(pluginWorkspacePath));
      expect(result.diagnostics[0]?.message).toBe(missingWorkspacePath);
      expect(commandResolver).toHaveBeenCalledWith({
        workspacePath: pluginWorkspacePath,
        workspaceKey: pluginWorkspacePath,
      });
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("updatePlugin issues plugins/update with the requested pluginId", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-service-plugin-update-"));
    createdDirs.push(workspacePath);
    const scriptPath = join(workspacePath, "plugin-update-agent.cjs");
    writeFileSync(scriptPath, PLUGIN_UPDATE_ECHO_FAKE_AGENT);
    const service = createReadyZCodeAgentService({
      commandResolver: () => ({ command: process.execPath, args: [scriptPath] }),
    });

    try {
      const result = await service.updatePlugin({
        workspacePath,
        pluginId: "skill-creator@zcode-plugins-official",
      });

      expect(result.installedPlugins).toEqual([]);
      expect(result.diagnostics[0]?.code).toBe("echo-plugin-id");
      expect(result.diagnostics[0]?.message).toBe("skill-creator@zcode-plugins-official");
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("restoreBuiltinPlugin issues plugins/restoreBuiltin with the requested pluginId", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-service-plugin-restore-"));
    createdDirs.push(workspacePath);
    const scriptPath = join(workspacePath, "plugin-restore-agent.cjs");
    writeFileSync(scriptPath, PLUGIN_RESTORE_BUILTIN_ECHO_FAKE_AGENT);
    const service = createReadyZCodeAgentService({
      commandResolver: () => ({ command: process.execPath, args: [scriptPath] }),
    });

    try {
      const result = await service.restoreBuiltinPlugin({
        workspacePath,
        pluginId: "skill-creator@zcode-plugins-official",
      });

      expect(result.pluginId).toBe("skill-creator@zcode-plugins-official");
      expect(result.diagnostics).toEqual([]);
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("restarts a stale protocol client and retries MCP status list without provider registry sync", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-service-mcp-list-"));
    createdDirs.push(workspacePath);
    const scriptPath = join(workspacePath, "stale-mcp-list-agent.cjs");
    const markerPath = join(workspacePath, "first-run-marker");
    writeFileSync(scriptPath, STALE_THEN_MCP_LIST_FAKE_AGENT);
    const commandResolver = vi.fn(() => ({
      command: process.execPath,
      args: [scriptPath, markerPath],
    }));
    const service = createReadyZCodeAgentService({
      commandResolver,
      requestTimeoutMs: 1_500,
    });

    try {
      const result = await service.listMcpServerStatuses({ workspacePath });

      expect(result.statuses.filesystem?.status).toBe("disconnected");
      expect(commandResolver).toHaveBeenCalledTimes(2);
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("loads MCP status list through the dedicated plugin workspace", async () => {
    const sandboxRoot = mkdtempSync(join(tmpdir(), "zcode-agent-service-mcp-cwd-"));
    createdDirs.push(sandboxRoot);
    setDataBaseDir(sandboxRoot);
    const scriptPath = join(sandboxRoot, "mcp-cwd-agent.cjs");
    writeFileSync(scriptPath, MCP_LIST_ECHO_CWD_FAKE_AGENT);
    const missingWorkspacePath = join(sandboxRoot, "deleted-workspace");
    const pluginWorkspacePath = join(sandboxRoot, ".zcode", "plugin-workspace");
    const commandResolver = vi.fn(({ workspacePath }) => ({
      command: process.execPath,
      args: [scriptPath],
      cwd: workspacePath,
    }));
    const service = createReadyZCodeAgentService({ commandResolver });

    try {
      const result = await service.listMcpServerStatuses({ workspacePath: missingWorkspacePath });

      expect(existsSync(pluginWorkspacePath)).toBe(true);
      expect(result.statuses.cwd?.error).toBe(missingWorkspacePath);
      expect(commandResolver).toHaveBeenCalledWith({
        workspacePath: pluginWorkspacePath,
        workspaceKey: pluginWorkspacePath,
      });
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("plugins/uninstall 不会排在挂起的 mcp/list 后面：MCP 状态探测使用独立 agent 进程", async () => {
    const sandboxRoot = mkdtempSync(join(tmpdir(), "zcode-agent-service-mcp-lane-"));
    createdDirs.push(sandboxRoot);
    setDataBaseDir(sandboxRoot);
    const scriptPath = join(sandboxRoot, "serial-queue-agent.cjs");
    const markerPath = join(sandboxRoot, "mcp-list-received");
    writeFileSync(scriptPath, SERIAL_QUEUE_HANG_ON_MCP_LIST_FAKE_AGENT);
    const commandResolver = vi.fn(() => ({
      command: process.execPath,
      args: [scriptPath, markerPath],
    }));
    const service = createReadyZCodeAgentService({ commandResolver });

    try {
      // connect 模式的 mcp/list 在真实环境里会因坏 MCP server 吃满 30s 超时；这里让它永不返回。
      const mcpListPromise = service.listMcpServerStatuses({ workspacePath: sandboxRoot });
      mcpListPromise.catch(() => undefined);
      await vi.waitFor(() => expect(existsSync(markerPath)).toBe(true), { timeout: 5_000 });

      const result = await Promise.race([
        service.uninstallPlugin({ workspacePath: sandboxRoot, pluginId: "pick-funds" }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("plugins/uninstall 被 mcp/list 阻塞")), 3_000),
        ),
      ]);

      expect(result.diagnostics).toEqual([]);
      // 两类请求必须落在不同的 agent 进程上
      expect(commandResolver).toHaveBeenCalledTimes(2);
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("mcp-status lane 进程的 spawn/exit 会上报 processLifecycleReporter", async () => {
    const sandboxRoot = mkdtempSync(join(tmpdir(), "zcode-agent-service-mcp-lane-report-"));
    createdDirs.push(sandboxRoot);
    setDataBaseDir(sandboxRoot);
    const scriptPath = join(sandboxRoot, "serial-queue-agent.cjs");
    const markerPath = join(sandboxRoot, "mcp-list-received");
    writeFileSync(scriptPath, SERIAL_QUEUE_HANG_ON_MCP_LIST_FAKE_AGENT);
    const processLifecycleReporter = {
      onSpawn: vi.fn(),
      onReady: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    };
    const service = createReadyZCodeAgentService({
      commandResolver: () => ({ command: process.execPath, args: [scriptPath, markerPath] }),
      processLifecycleReporter,
    });

    try {
      // 只走 mcp-status lane：该进程是本 lane 新增的长驻 agent，进程监控器必须能看到它。
      const mcpListPromise = service.listMcpServerStatuses({ workspacePath: sandboxRoot });
      mcpListPromise.catch(() => undefined);
      await vi.waitFor(() => expect(existsSync(markerPath)).toBe(true), { timeout: 5_000 });

      await vi.waitFor(() => expect(processLifecycleReporter.onSpawn).toHaveBeenCalledTimes(1));
      // macOS tmpdir 会被 realpath 成 /private/var，这里不比对 workspacePath 字面值。
      // 评审 SG-02：mcp-status 与 plugin lane 共用同一 workspacePath/command，事件必须带 lane 才可归因。
      expect(processLifecycleReporter.onSpawn.mock.calls[0]![0]).toMatchObject({
        pid: expect.any(Number),
        provider: "glm",
        lane: "mcp-status",
      });
    } finally {
      await service.disposeAllAndWait();
    }
    await vi.waitFor(() => expect(processLifecycleReporter.onExit).toHaveBeenCalledTimes(1));
    expect(processLifecycleReporter.onExit.mock.calls[0]![0]).toMatchObject({ lane: "mcp-status" });
  });

  it("mcp-status lane 空闲超时后回收进程并释放 MCP 连接，下次探测重新拉起", async () => {
    const sandboxRoot = mkdtempSync(join(tmpdir(), "zcode-agent-service-mcp-lane-idle-"));
    createdDirs.push(sandboxRoot);
    setDataBaseDir(sandboxRoot);
    const scriptPath = join(sandboxRoot, "mcp-echo-agent.cjs");
    writeFileSync(scriptPath, MCP_LIST_ECHO_MODE_FAKE_AGENT);
    const commandResolver = vi.fn(() => ({ command: process.execPath, args: [scriptPath] }));
    const processLifecycleReporter = {
      onSpawn: vi.fn(),
      onReady: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    };
    const service = createReadyZCodeAgentService({
      commandResolver,
      processLifecycleReporter,
      mcpStatusIdleTimeoutMs: 300,
    });

    try {
      await service.listMcpServerStatuses({ workspacePath: sandboxRoot });
      expect(commandResolver).toHaveBeenCalledTimes(1);

      // 探测完成后无请求在飞，超过空闲阈值必须主动回收，且以 expected/idle-timeout 归因。
      await vi.waitFor(() => expect(processLifecycleReporter.onExit).toHaveBeenCalledTimes(1), {
        timeout: 5_000,
      });
      expect(processLifecycleReporter.onExit.mock.calls[0]![0]).toMatchObject({
        lane: "mcp-status",
        terminationKind: "expected",
        terminationReason: "idle-timeout",
      });

      // 回收后再次探测要透明地重新拉起进程，而不是拿到已回收的 client 报错。
      await service.listMcpServerStatuses({ workspacePath: sandboxRoot });
      expect(commandResolver).toHaveBeenCalledTimes(2);
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("mcp/list 超时触发 watchdog 回收后重试仍落在 mcp-status lane，plugin lane 进程不受影响", async () => {
    const sandboxRoot = mkdtempSync(join(tmpdir(), "zcode-agent-service-mcp-lane-timeout-"));
    createdDirs.push(sandboxRoot);
    setDataBaseDir(sandboxRoot);
    const scriptPath = join(sandboxRoot, "serial-queue-agent.cjs");
    const markerPath = join(sandboxRoot, "mcp-list-received");
    writeFileSync(scriptPath, SERIAL_QUEUE_HANG_ON_MCP_LIST_FAKE_AGENT);
    const commandResolver = vi.fn(() => ({
      command: process.execPath,
      args: [scriptPath, markerPath],
    }));
    const processLifecycleReporter = {
      onSpawn: vi.fn(),
      onReady: vi.fn(),
      onExit: vi.fn(),
      onError: vi.fn(),
    };
    const service = createReadyZCodeAgentService({
      commandResolver,
      processLifecycleReporter,
      // 覆盖 fake agent 冷启动（node 进程拉起 + 首个响应），又足够短让两次超时在秒级完成。
      requestTimeoutMs: 1_500,
    });

    try {
      // 先让 plugin lane 起一个进程，作为“不受影响”的对照（该 fake agent 只应答 plugins/uninstall）。
      await service.uninstallPlugin({ workspacePath: sandboxRoot, pluginId: "pick-funds" });
      expect(commandResolver).toHaveBeenCalledTimes(1);

      // mcp/list 永不返回：首次超时 → watchdog 回收 mcp-status 进程 → 重试一次 → 再超时 → 抛错。
      await expect(service.listMcpServerStatuses({ workspacePath: sandboxRoot })).rejects.toThrow(
        /timed out/u,
      );
      // plugin lane 1 次 + mcp-status lane 首发 1 次 + 重试重新拉起 1 次
      expect(commandResolver).toHaveBeenCalledTimes(3);

      await vi.waitFor(
        () =>
          expect(
            processLifecycleReporter.onExit.mock.calls.filter(
              ([event]) =>
                event.lane === "mcp-status" && event.terminationKind === "watchdog_recycle",
            ),
          ).toHaveLength(2),
        // 修复原因：第二次 watchdog 与 mcp/list 的 reject 同 tick 触发，exit 事件要等
        // Windows 进程树回收（taskkill /T + 重试）完成后才上报；vi.waitFor 默认 1000ms
        // 在慢盘/高负载本机会先超时，把环境慢误报成用例失败。CI 快机器不受影响。
        { timeout: 8_000 },
      );
      // plugin lane 进程从未被回收，且仍能正常服务。
      expect(
        processLifecycleReporter.onExit.mock.calls.filter(([event]) => event.lane !== "mcp-status"),
      ).toHaveLength(0);
      await service.uninstallPlugin({ workspacePath: sandboxRoot, pluginId: "pick-funds" });
      expect(commandResolver).toHaveBeenCalledTimes(3);
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("passes UI-resolved MCP servers to mcp/list", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-service-mcp-explicit-"));
    createdDirs.push(workspacePath);
    const scriptPath = join(workspacePath, "mcp-explicit-agent.cjs");
    writeFileSync(scriptPath, MCP_LIST_ECHO_MCP_SERVERS_FAKE_AGENT);
    const service = createReadyZCodeAgentService({
      commandResolver: () => ({ command: process.execPath, args: [scriptPath] }),
    });

    try {
      const result = await service.listMcpServerStatuses({
        workspacePath,
        mcpServers: [
          {
            name: "agents-fallback",
            command: "node",
            args: ["server.mjs"],
            env: [{ name: "TOKEN", value: "secret" }],
            timeoutMs: 3000,
          },
        ],
      });

      expect(JSON.parse(result.statuses.explicit?.error ?? "null")).toEqual([
        {
          name: "agents-fallback",
          command: "node",
          args: ["server.mjs"],
          env: [{ name: "TOKEN", value: "secret" }],
          timeoutMs: 3000,
        },
      ]);
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("passes status mode to mcp/list", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-service-mcp-mode-"));
    createdDirs.push(workspacePath);
    const scriptPath = join(workspacePath, "mcp-mode-agent.cjs");
    writeFileSync(scriptPath, MCP_LIST_ECHO_MODE_FAKE_AGENT);
    const service = createZCodeAgentService({
      commandResolver: () => ({ command: process.execPath, args: [scriptPath] }),
    });

    try {
      const result = await service.listMcpServerStatuses({
        workspacePath,
        mode: "status",
      });

      expect(JSON.parse(result.statuses.mode?.error ?? "null")).toBe("status");
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("retries mcp/list without explicit MCP servers for legacy agents", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-service-mcp-compat-"));
    createdDirs.push(workspacePath);
    const scriptPath = join(workspacePath, "mcp-compat-agent.cjs");
    writeFileSync(scriptPath, MCP_LIST_REJECTS_MCP_SERVERS_ONCE_FAKE_AGENT);
    const service = createReadyZCodeAgentService({
      commandResolver: () => ({ command: process.execPath, args: [scriptPath] }),
    });

    try {
      const result = await service.listMcpServerStatuses({
        workspacePath,
        mcpServers: [],
      });

      expect(result.statuses.fallback?.status).toBe("disconnected");
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("retries connect-mode mcp/list without mode for legacy agents", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-agent-service-mcp-mode-compat-"));
    createdDirs.push(workspacePath);
    const scriptPath = join(workspacePath, "mcp-mode-compat-agent.cjs");
    writeFileSync(scriptPath, MCP_LIST_REJECTS_MODE_ONCE_FAKE_AGENT);
    const service = createZCodeAgentService({
      commandResolver: () => ({ command: process.execPath, args: [scriptPath] }),
    });

    try {
      const result = await service.listMcpServerStatuses({
        workspacePath,
        mode: "connect",
      });

      expect(result.statuses.fallback?.status).toBe("disconnected");
      expect(JSON.parse(result.statuses.fallback?.error ?? "null")).toBeNull();
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("does not retry status-only mcp/list as connect for legacy agents", async () => {
    const workspacePath = mkdtempSync(
      join(tmpdir(), "zcode-agent-service-mcp-mode-subset-compat-"),
    );
    createdDirs.push(workspacePath);
    const scriptPath = join(workspacePath, "mcp-mode-subset-compat-agent.cjs");
    writeFileSync(scriptPath, MCP_LIST_REJECTS_MODE_ONCE_FAKE_AGENT);
    const service = createZCodeAgentService({
      commandResolver: () => ({ command: process.execPath, args: [scriptPath] }),
    });

    try {
      await expect(
        service.listMcpServerStatuses({
          workspacePath,
          mode: "status",
          mcpServers: [
            {
              name: "plugin:canva:canva",
              type: "http",
              url: "https://mcp.canva.example.test/mcp",
              headers: [],
            },
          ],
        }),
      ).rejects.toMatchObject({
        code: ZCODE_AGENT_MCP_STATUS_MODE_UNSUPPORTED_ERROR_CODE,
        name: "ZCodeAgentMcpStatusModeUnsupportedError",
      });
    } finally {
      await service.disposeAllAndWait();
    }
  });
});
