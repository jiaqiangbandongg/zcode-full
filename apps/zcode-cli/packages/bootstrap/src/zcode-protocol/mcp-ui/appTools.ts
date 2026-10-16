import type { Logger, McpToolCallResult } from "@zcode/contracts";
import type { McpAppProvidedToolDefinition, McpAppProvidedToolExecutor } from "@zcode/core";
import {
  MCP_APPS_APP_TOOL_ARGUMENTS_MAX_BYTES,
  MCP_APPS_APP_TOOL_CALL_TIMEOUT_MS,
  MCP_APPS_APP_TOOL_CLAIM_TIMEOUT_MS,
  MCP_APPS_APP_TOOL_RESULT_MAX_BYTES,
  buildMcpAppsAppToolModelName,
  type McpAppsAppToolCallRequest,
  type McpAppsAppToolDescriptor,
} from "@zcode/shared/mcp-apps";
import { randomUUID } from "node:crypto";
import type {
  McpUiAppToolCallParams,
  McpUiAppToolInstance,
  McpUiRegisterAppToolsParams,
  McpUiRegisterAppToolsResult,
  McpUiResolveAppToolCallParams,
} from "./appToolsContract.js";

/**
 * App-Provided Tools 登记表：会话内页面实例的工具、暴露给模型的集合与待执行调用的唯一 owner。
 * 只在内存；会话关闭清空，不持久化。模型调用经"实例信箱"（`publishCall` → live-only 投影增量）投递给
 * 唯一实例，渲染端认领（claim）后页面 tools/call，结果经 resolve 回传。
 */
export interface McpUiAppToolsHost {
  /** 把暴露集合同步到会话 runtime（整体替换）；会话不在时返回 null。 */
  applyTools(
    sessionId: string,
    definitions: readonly McpAppProvidedToolDefinition[],
    execute: McpAppProvidedToolExecutor,
  ): string[] | null;
  /** 信箱投递：一次待执行调用 → 该会话的 live 投影（只投给 instance 一个实例）。 */
  publishCall(
    sessionId: string,
    target: {
      pluginId: string;
      serverName: string;
      instance: McpUiAppToolInstance;
      credential: import("@zcode/shared/mcp-apps").McpAppInstance;
    },
    call: McpAppsAppToolCallRequest,
  ): void;
  logger?: Logger;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => () => void;
  createCallId?: () => string;
}

interface InstanceRecord {
  credential: import("@zcode/shared/mcp-apps").McpAppInstance;
  instance: McpUiAppToolInstance;
  pluginId: string;
  serverName: string;
  /** 首次登记序号：同 server 只暴露序号最大的实例；重新登记不变。 */
  seq: number;
  tools: McpAppsAppToolDescriptor[];
}

interface PendingCall {
  instanceKey: string;
  toolName: string;
  claimed: boolean;
  settle(outcome: { result: McpToolCallResult } | { error: Error }): void;
  cancelTimer: () => void;
}

interface SessionState {
  instances: Map<string, InstanceRecord>;
  nextSeq: number;
  pending: Map<string, PendingCall>;
}

/** 实例键 = 沙箱作用域 + 代际；同作用域的新代际替换旧代际。 */
export const buildMcpUiAppToolInstanceKey = (instance: McpUiAppToolInstance) =>
  `${instance.scopeId}|${instance.generation}`;
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");

export class McpUiAppToolRegistry {
  private readonly sessions = new Map<string, SessionState>();
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => () => void;
  private readonly createCallId: () => string;

  constructor(private readonly host: McpUiAppToolsHost) {
    this.now = host.now ?? Date.now;
    this.setTimer =
      host.setTimer ??
      ((callback, ms) => {
        const timer = setTimeout(callback, ms);
        timer.unref?.();
        return () => clearTimeout(timer);
      });
    this.createCallId = host.createCallId ?? randomUUID;
  }

  register(params: McpUiRegisterAppToolsParams): McpUiRegisterAppToolsResult {
    const session = this.sessionOf(params.sessionId);
    const key = buildMcpUiAppToolInstanceKey(params);
    // 同一沙箱作用域的新代际（页面重载 / 重挂载）替换旧代际。
    for (const [existingKey, record] of Array.from(session.instances)) {
      if (existingKey !== key && record.instance.scopeId === params.scopeId) {
        this.dropInstance(params.sessionId, session, existingKey, "App page was reloaded");
      }
    }
    const existing = session.instances.get(key);
    session.instances.set(key, {
      credential: params.instance,
      instance: { scopeId: params.scopeId, generation: params.generation },
      pluginId: params.pluginId,
      serverName: params.serverName,
      seq: existing?.seq ?? session.nextSeq++,
      tools: params.tools,
    });
    const exposed = this.sync(params.sessionId, session);
    const mine = exposed.filter(
      (item) => item.scopeId === params.scopeId && item.generation === params.generation,
    );
    this.host.logger?.info("MCP UI app tools registered", {
      event: "mcp.ui.app_tools.registered",
      mcpServerName: params.serverName,
      sessionId: params.sessionId,
      toolCount: params.tools.length,
      exposedCount: mine.length,
    });
    return { tools: mine.map((item) => ({ name: item.toolName, modelName: item.modelName })) };
  }

  unregister(sessionId: string, instance: McpUiAppToolInstance): number {
    const session = this.sessions.get(sessionId);
    const key = buildMcpUiAppToolInstanceKey(instance);
    const record = session?.instances.get(key);
    if (!session || !record) return 0;
    this.dropInstance(sessionId, session, key, "App page was closed");
    this.sync(sessionId, session);
    return record.tools.length;
  }

  claim(params: McpUiAppToolCallParams): boolean {
    const session = this.sessions.get(params.sessionId);
    const pending = session?.pending.get(params.callId);
    const key = buildMcpUiAppToolInstanceKey(params);
    if (!session || !pending || pending.instanceKey !== key) return false;
    // callId 幂等：同一实例重放认领仍回 true，不重置执行计时；渲染端按 callId 去重，不会执行两次。
    if (pending.claimed) return true;
    pending.cancelTimer();
    pending.claimed = true;
    pending.cancelTimer = this.setTimer(
      () =>
        pending.settle({
          error: new Error(
            `App tool ${pending.toolName} timed out after ${MCP_APPS_APP_TOOL_CALL_TIMEOUT_MS} ms`,
          ),
        }),
      MCP_APPS_APP_TOOL_CALL_TIMEOUT_MS,
    );
    return true;
  }

  resolve(params: McpUiResolveAppToolCallParams): boolean {
    const session = this.sessions.get(params.sessionId);
    const pending = session?.pending.get(params.callId);
    if (
      !pending ||
      !pending.claimed ||
      pending.instanceKey !== buildMcpUiAppToolInstanceKey(params)
    ) {
      return false;
    }
    if (params.error) {
      pending.settle({ error: new Error(params.error.message || "App tool failed") });
      return true;
    }
    const result = params.result as McpToolCallResult;
    if (jsonBytes(result) > MCP_APPS_APP_TOOL_RESULT_MAX_BYTES) {
      pending.settle({
        error: new Error(`App tool result exceeds ${MCP_APPS_APP_TOOL_RESULT_MAX_BYTES} bytes`),
      });
      return true;
    }
    pending.settle({ result });
    return true;
  }

  /** 会话关闭：结束全部待执行调用并丢弃登记（runtime 随会话关闭，不再同步工具）。 */
  clearSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    for (const pending of Array.from(session.pending.values())) {
      pending.settle({ error: new Error("Session was closed") });
    }
  }

  private readonly execute = (sessionId: string): McpAppProvidedToolExecutor => {
    return (call, options) => {
      const session = this.sessions.get(sessionId);
      const instanceKey = buildMcpUiAppToolInstanceKey(call.definition);
      const instance = session?.instances.get(instanceKey);
      if (!session || !instance) {
        return Promise.reject(
          new Error(`The ${call.definition.serverName} app page is not running`),
        );
      }
      if (jsonBytes(call.arguments) > MCP_APPS_APP_TOOL_ARGUMENTS_MAX_BYTES) {
        return Promise.reject(new Error("App tool arguments are too large"));
      }
      if (options.signal.aborted) return Promise.reject(new Error("App tool call was cancelled"));
      return new Promise<McpToolCallResult>((resolve, reject) => {
        const callId = this.createCallId();
        let settled = false;
        const onAbort = () => pending.settle({ error: new Error("App tool call was cancelled") });
        const pending: PendingCall = {
          instanceKey,
          toolName: call.definition.toolName,
          claimed: false,
          settle: (outcome) => {
            if (settled) return;
            settled = true;
            pending.cancelTimer();
            options.signal.removeEventListener("abort", onAbort);
            session.pending.delete(callId);
            if ("result" in outcome) resolve(outcome.result);
            else {
              this.host.publishCall(
                sessionId,
                {
                  pluginId: instance.pluginId,
                  serverName: instance.serverName,
                  instance: instance.instance,
                  credential: instance.credential,
                },
                { callId, toolName: call.definition.toolName, arguments: {}, cancelled: true },
              );
              reject(outcome.error);
            }
          },
          // 认领期限：没有渲染端认领视为页面未运行（信箱不重发），结束调用并注销该实例。
          cancelTimer: this.setTimer(() => {
            pending.settle({
              error: new Error(`The ${instance.serverName} app page is not running`),
            });
            if (session.instances.has(instanceKey)) {
              this.dropInstance(sessionId, session, instanceKey, "App page is not running");
              this.sync(sessionId, session);
            }
          }, MCP_APPS_APP_TOOL_CLAIM_TIMEOUT_MS),
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        session.pending.set(callId, pending);
        this.host.publishCall(
          sessionId,
          {
            pluginId: instance.pluginId,
            serverName: instance.serverName,
            instance: instance.instance,
            credential: instance.credential,
          },
          { callId, toolName: call.definition.toolName, arguments: call.arguments },
        );
      });
    };
  };

  private sessionOf(sessionId: string): SessionState {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { instances: new Map(), nextSeq: 1, pending: new Map() };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  private dropInstance(
    sessionId: string,
    session: SessionState,
    instanceKey: string,
    reason: string,
  ): void {
    session.instances.delete(instanceKey);
    for (const pending of Array.from(session.pending.values())) {
      if (pending.instanceKey === instanceKey) pending.settle({ error: new Error(reason) });
    }
    this.host.logger?.debug?.("MCP UI app tool instance dropped", {
      event: "mcp.ui.app_tools.dropped",
      sessionId,
      reason,
    });
  }

  /** 计算暴露集合（同 server 只暴露最近登记的实例）并同步到 runtime；返回暴露的定义。 */
  private sync(sessionId: string, session: SessionState): McpAppProvidedToolDefinition[] {
    const latestByServer = new Map<string, InstanceRecord>();
    for (const record of session.instances.values()) {
      const current = latestByServer.get(record.serverName);
      if (!current || record.seq > current.seq) latestByServer.set(record.serverName, record);
    }
    const definitions: McpAppProvidedToolDefinition[] = [];
    const seen = new Set<string>();
    const servers = Array.from(latestByServer.values()).sort((a, b) =>
      a.serverName.localeCompare(b.serverName),
    );
    for (const record of servers) {
      for (const tool of record.tools) {
        const modelName = buildMcpAppsAppToolModelName(record.serverName, tool.name);
        if (seen.has(modelName)) continue;
        seen.add(modelName);
        definitions.push({
          modelName,
          serverName: record.serverName,
          pluginId: record.pluginId,
          scopeId: record.instance.scopeId,
          generation: record.instance.generation,
          toolName: tool.name,
          ...(tool.title ? { title: tool.title } : {}),
          ...(tool.description ? { description: tool.description } : {}),
          inputSchema: tool.inputSchema,
          ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
          ...(tool.annotations?.readOnlyHint !== undefined
            ? { readOnlyHint: tool.annotations.readOnlyHint }
            : {}),
          ...(tool.annotations?.destructiveHint !== undefined
            ? { destructiveHint: tool.annotations.destructiveHint }
            : {}),
          ...(tool.annotations?.idempotentHint !== undefined
            ? { idempotentHint: tool.annotations.idempotentHint }
            : {}),
        });
      }
    }
    const applied = this.host.applyTools(sessionId, definitions, this.execute(sessionId));
    if (applied === null) {
      this.clearSession(sessionId);
      return [];
    }
    const appliedNames = new Set(applied);
    return definitions.filter((definition) => appliedNames.has(definition.modelName));
  }
}
