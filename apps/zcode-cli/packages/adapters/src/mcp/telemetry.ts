import { Buffer } from "node:buffer";
import { createHmac, randomUUID } from "node:crypto";
import type { ZCodeMcpTelemetryEvent } from "@zcode/shared";
import {
  createMcpResourceTelemetry,
  type McpResourceTelemetryOptions,
} from "./resource-telemetry.js";

const BUILTIN_MCP_ID_PREFIX = "builtin:";
const BUILTIN_NODE_REPL_SERVER_NAME = "node_repl";
const MCP_ID_SAFE_CHARACTER_PATTERN = /^[A-Za-z0-9._~-]$/;
const PLUGIN_MCP_NAMESPACE_PREFIX = "plugin:";

export type McpTelemetryEvent = ZCodeMcpTelemetryEvent;
export type McpTelemetrySource = Extract<
  ZCodeMcpTelemetryEvent,
  { kind: "process_start" }
>["mcpSource"];
export type McpTelemetryIsolation = Extract<
  ZCodeMcpTelemetryEvent,
  { kind: "process_start" }
>["mcpIsolation"];
export interface McpProcessTelemetryIdentity {
  mcpId: string;
  mcpInstanceId: string;
}

/**
 * 资源管理器用的 MCP 子进程视图：只回 pid 与归属，不含任何采样值。
 * 这里保留明文 serverName / pluginName——只在本机 host ↔ CLI 之间流转，
 * 不出本机，无需脱敏；Host 用它把 ps 进程树上的 pid 归到具体插件。
 */
export interface McpTrackedProcess {
  pid: number;
  serverName: string;
  mcpSource: McpTelemetrySource;
  /** `plugin:<name>:<key>` 命名空间里的插件名；builtin host MCP（node_repl）由调用方按官方插件表补齐 */
  pluginName?: string;
}

export interface McpTelemetryTracker {
  acquireOwner(input: { connectionId: string; ownerId: string; sessionId?: string }): void;
  recordSessionStartup(input: {
    configuredCount: number;
    connectedCount: number;
    failedCount: number;
    processCount: number;
    sessionId: string;
  }): void;
  recordProcessCrashed(input: {
    connectionId: string;
    exitCode: number | null;
    signal: string | null;
  }): void;
  recordProcessClosed(input: { connectionId: string }): void;
  recordProcessStarted(input: {
    connectionId: string;
    pid: number;
  }): McpProcessTelemetryIdentity | undefined;
  releaseOwner(input: { connectionId: string; ownerId: string }): void;
  registerConnection(input: {
    connectionId: string;
    isolation: McpTelemetryIsolation;
    serverName: string;
    source?: McpTelemetrySource;
  }): void;
  unregisterConnection(input: { connectionId: string }): void;
  /** 当前仍有存活进程记录的 MCP 连接（纯内存，无 I/O） */
  listProcesses(): McpTrackedProcess[];
  sampleNow(): Promise<void>;
  start(): void;
  stop(): void;
}

export interface CreateMcpTelemetryTrackerOptions {
  arch?: ZCodeMcpTelemetryEvent["arch"];
  idSalt: string;
  now?: () => number;
  onEvent(event: McpTelemetryEvent): void;
  platform?: ZCodeMcpTelemetryEvent["platform"];
  randomId?: () => string;
  onResourceSamples?: McpResourceTelemetryOptions["onResourceSamples"];
  processProbe?: McpResourceTelemetryOptions["processProbe"];
  logicalCpuCount?: number;
  totalMemoryGb?: number;
  timer?: McpResourceTelemetryOptions["timer"];
}

interface TrackedConnection {
  connectionId: string;
  isolation: McpTelemetryIsolation;
  mcpId: string;
  mcpSource: McpTelemetrySource;
  serverName: string;
  owners: Map<string, string | undefined>;
  process?: {
    instanceId: string;
    pid: number;
    startedAt: number;
  };
  unownedAt?: number;
}

export function createMcpTelemetryTracker(
  options: CreateMcpTelemetryTrackerOptions,
): McpTelemetryTracker {
  const arch = options.arch ?? (process.arch as ZCodeMcpTelemetryEvent["arch"]);
  const now = options.now ?? Date.now;
  const platform = options.platform ?? (process.platform as ZCodeMcpTelemetryEvent["platform"]);
  const randomId = options.randomId ?? randomUUID;
  const connections = new Map<string, TrackedConnection>();
  const emit = (event: McpTelemetryEvent): void => {
    try {
      options.onEvent(event);
    } catch {
      // 遥测为旁路，下游通知或 IPC 关闭不得改变 MCP 连接、回收或 crash 处理。
    }
  };

  const resourceTelemetry = createMcpResourceTelemetry({
    ...options,
    arch,
    platform,
    now,
    getProcesses: () =>
      [...connections.values()].flatMap((connection) => {
        const trackedProcess = connection.process;
        if (!trackedProcess) return [];
        return [
          {
            ...trackedProcess,
            mcpId: connection.mcpId,
            isCurrent: () =>
              connections.get(connection.connectionId) === connection &&
              connection.process === trackedProcess,
            observed(samples, sampledAt, memoryScope) {
              if (!samples) {
                if (connection.owners.size === 0) {
                  connection.process = undefined;
                  connections.delete(connection.connectionId);
                }
                return;
              }
              const sessionIds = new Set(
                [...connection.owners.values()].filter((id) => id !== undefined),
              );
              const unownedMs =
                connection.owners.size === 0 && connection.unownedAt !== undefined
                  ? Math.max(0, sampledAt - connection.unownedAt)
                  : 0;
              // 保留 tracker 内部孤儿观测口径；bootstrap 不再把旧 memory 事实发上协议。
              emit({
                arch,
                kind: "memory",
                mcpId: connection.mcpId,
                mcpInstanceId: trackedProcess.instanceId,
                mcpIsolation: connection.isolation,
                mcpSource: connection.mcpSource,
                platform,
                occurredAt: sampledAt,
                memoryKb: samples.reduce((total, sample) => total + sample.rssKb, 0),
                memoryScope,
                orphanSuspected: connection.owners.size === 0 && unownedMs > 60_000,
                ownerSessionCount: sessionIds.size,
                unownedSeconds: unownedMs / 1_000,
              });
            },
          },
        ];
      }),
  });

  return {
    acquireOwner(input) {
      const connection = connections.get(input.connectionId);
      if (!connection) return;
      connection.owners.set(input.ownerId, input.sessionId);
      connection.unownedAt = undefined;
    },
    recordProcessCrashed(input) {
      const connection = connections.get(input.connectionId);
      const trackedProcess = connection?.process;
      if (!connection || !trackedProcess) return;
      connection.process = undefined;
      const occurredAt = now();
      const sessionIds = new Set(
        [...connection.owners.values()].filter(
          (sessionId): sessionId is string => sessionId !== undefined,
        ),
      );
      emit({
        affectedSessionCount: sessionIds.size,
        arch,
        exitCode: input.exitCode,
        kind: "process_crash",
        mcpId: connection.mcpId,
        mcpInstanceId: trackedProcess.instanceId,
        mcpIsolation: connection.isolation,
        mcpSource: connection.mcpSource,
        occurredAt,
        platform,
        signal: input.signal,
        uptimeMs: Math.max(0, occurredAt - trackedProcess.startedAt),
      });
    },
    recordProcessClosed(input) {
      const connection = connections.get(input.connectionId);
      if (!connection) return;
      connection.process = undefined;
      if (connection.owners.size === 0) connections.delete(input.connectionId);
    },
    recordProcessStarted(input) {
      const connection = connections.get(input.connectionId);
      if (!connection || !Number.isInteger(input.pid) || input.pid <= 0) return undefined;
      const mcpInstanceId = randomId();
      const occurredAt = now();
      connection.process = {
        instanceId: mcpInstanceId,
        pid: input.pid,
        startedAt: occurredAt,
      };
      if (connection.owners.size === 0) connection.unownedAt ??= occurredAt;
      emit({
        arch,
        kind: "process_start",
        mcpId: connection.mcpId,
        mcpInstanceId,
        mcpIsolation: connection.isolation,
        mcpSource: connection.mcpSource,
        occurredAt,
        platform,
      });
      return { mcpId: connection.mcpId, mcpInstanceId };
    },
    recordSessionStartup(input) {
      emit({
        arch,
        configuredCount: input.configuredCount,
        connectedCount: input.connectedCount,
        failedCount: input.failedCount,
        kind: "session_startup",
        occurredAt: now(),
        platform,
        processCount: input.processCount,
        sessionId: input.sessionId,
      });
    },
    releaseOwner(input) {
      const connection = connections.get(input.connectionId);
      if (!connection || !connection.owners.delete(input.ownerId)) return;
      if (connection.owners.size !== 0) return;
      connection.unownedAt = now();
      // process crash 后最后一个 owner 释放时，pool entry 仍会在 idle grace 内存活。
      // 此处提前删除 registration 会让同一 workspace entry 被复用后的新进程永久失去遥测。
      // registration 的终态由 pool closeEntry 显式 unregister，owner 释放只记录无主时间。
    },
    registerConnection(input) {
      const mcpSource = input.source ?? resolveMcpSource(input.serverName);
      connections.set(input.connectionId, {
        connectionId: input.connectionId,
        isolation: input.isolation,
        mcpId: resolveMcpId(input.serverName, mcpSource, options.idSalt),
        mcpSource,
        serverName: input.serverName,
        owners: new Map(),
      });
    },
    unregisterConnection(input) {
      const connection = connections.get(input.connectionId);
      if (!connection) return;
      // pool entry 已进入终态，残留 lease 不能继续被视为 owner；若进程树回收失败则保留
      // process 供后续采样标记 orphan，确认进程关闭或 OS 不再可见后再删除 registration。
      connection.owners.clear();
      connection.unownedAt ??= now();
      if (!connection.process) connections.delete(input.connectionId);
    },
    listProcesses() {
      const processes: McpTrackedProcess[] = [];
      for (const connection of connections.values()) {
        if (!connection.process) continue;
        const pluginName = resolvePluginName(connection.serverName);
        processes.push({
          pid: connection.process.pid,
          serverName: connection.serverName,
          mcpSource: connection.mcpSource,
          ...(pluginName ? { pluginName } : {}),
        });
      }
      return processes;
    },
    sampleNow: resourceTelemetry.sampleNow,
    start: resourceTelemetry.start,
    stop: resourceTelemetry.stop,
  };
}

/** `plugin:<name>:<key>` → `<name>`；非插件命名空间返回 undefined */
export function resolvePluginName(serverName: string): string | undefined {
  if (!serverName.startsWith(PLUGIN_MCP_NAMESPACE_PREFIX)) return undefined;
  const name = serverName.slice(PLUGIN_MCP_NAMESPACE_PREFIX.length).split(":")[0]?.trim();
  return name ? name : undefined;
}

function resolveMcpSource(serverName: string): McpTelemetrySource {
  if (serverName === BUILTIN_NODE_REPL_SERVER_NAME) return "builtin";
  return serverName.startsWith(PLUGIN_MCP_NAMESPACE_PREFIX) ? "plugin" : "custom";
}

function resolveMcpId(serverName: string, source: McpTelemetrySource, idSalt: string): string {
  if (source === "builtin") {
    const publicName = serverName.startsWith(PLUGIN_MCP_NAMESPACE_PREFIX)
      ? serverName.slice(PLUGIN_MCP_NAMESPACE_PREFIX.length)
      : serverName;
    return `${BUILTIN_MCP_ID_PREFIX}${publicName.split(":").map(encodeMcpIdSegment).join(":")}`;
  }
  const digest = createHmac("sha256", idSalt).update(serverName).digest("hex").slice(0, 12);
  return `${source}:${digest}`;
}

function encodeMcpIdSegment(value: string): string {
  // 原因：encodeURIComponent 遇到孤立 surrogate 会抛 URIError，遥测编码不能反向阻断 MCP 启动。
  // Buffer 的 UTF-8 编码会把畸形序列替换为 U+FFFD，再逐字节转义成协议允许的稳定 `%HH`。
  let encoded = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const character = String.fromCharCode(byte);
    encoded += MCP_ID_SAFE_CHARACTER_PATTERN.test(character)
      ? character
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}
