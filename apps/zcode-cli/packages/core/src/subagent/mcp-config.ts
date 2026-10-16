import type { McpServerConfig, McpServerStatus } from "@zcode/contracts";
import { matchesModelVisibleMcpServerName } from "../mcp/name.js";

export interface ParsedAgentMcpServers {
  invalidServerNames: string[];
  missingServerNames: string[];
  scopedServers: Record<string, McpServerConfig>;
}

export function parseAgentMcpServers(
  mcpServers: readonly unknown[] | undefined,
  configuredServers: Record<string, McpServerConfig>,
): ParsedAgentMcpServers {
  const invalidServerNames: string[] = [];
  const missingServerNames: string[] = [];
  const scopedServers: Record<string, McpServerConfig> = {};
  for (const spec of mcpServers ?? []) {
    if (typeof spec === "string" && spec.trim().length > 0) {
      const serverName = spec.trim();
      const config = configuredServers[serverName];
      if (!config) {
        missingServerNames.push(serverName);
      } else if (!isMcpServerConfig(config)) {
        invalidServerNames.push(serverName);
      } else {
        scopedServers[serverName] = config;
      }
      continue;
    }
    if (!isRecord(spec)) continue;
    for (const [serverName, config] of Object.entries(spec)) {
      const normalizedServerName = serverName.trim();
      if (normalizedServerName.length === 0) continue;
      if (!isMcpServerConfig(config)) {
        invalidServerNames.push(normalizedServerName);
        continue;
      }
      scopedServers[normalizedServerName] = config;
    }
  }
  return { invalidServerNames, missingServerNames, scopedServers };
}

export function matchesRequiredMcpServer(
  requiredName: string,
  statuses: Record<string, McpServerStatus>,
): boolean {
  if (requiredName === "*") {
    return Object.values(statuses).some((status) => status.status === "connected");
  }
  const expected = requiredName.toLowerCase();
  return Object.entries(statuses).some(
    ([serverName, status]) =>
      status.status === "connected" &&
      // MCP tool name 会把 plugin:android-emulator:android-emulator
      // 规范化成 plugin_android-emulator_android-emulator；required-server 检查
      // 必须使用同一套模型可见命名规则，否则已连接的 plugin MCP 会被误判为 missing。
      matchesModelVisibleMcpServerName(expected, serverName),
  );
}

export function matchesScopedMcpServer(
  requiredName: string,
  scopedServers: Record<string, McpServerConfig>,
): boolean {
  const serverNames = Object.keys(scopedServers);
  if (requiredName === "*") return serverNames.length > 0;
  return serverNames.some((serverName) =>
    matchesModelVisibleMcpServerName(requiredName, serverName),
  );
}

export function extractRequiredMcpServerNames(allowedTools: readonly string[]): string[] {
  const names = new Set<string>();
  for (const tool of allowedTools) {
    const requiredName = extractRequiredMcpServerName(tool);
    if (requiredName) names.add(requiredName);
  }
  return [...names];
}

function extractRequiredMcpServerName(tool: string): string | undefined {
  const trimmed = tool.trim();
  if (trimmed === "mcp__*" || trimmed === "mcp") return "*";
  if (!trimmed.startsWith("mcp__")) return undefined;
  const [, serverName] = trimmed.split("__");
  return serverName && serverName.length > 0 ? serverName : undefined;
}

function isMcpServerConfig(value: unknown): value is McpServerConfig {
  if (!isRecord(value)) return false;
  if (value.type === "stdio") return typeof value.command === "string";
  if (value.type === "http" || value.type === "sse") return typeof value.url === "string";
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
