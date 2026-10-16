/**
 * MCP 用户目录模块 - TOML 解析和序列化
 */

import type { McpServerConfig } from "@zcode/shared";

/**
 * 解析 TOML 内联表格格式
 * 支持: { key = "value", key2 = "value2" }
 */
function parseTomlInlineTable(input: string): Record<string, unknown> | null {
  const inner = input.slice(1, -1).trim();
  if (!inner) return {};

  const result: Record<string, unknown> = {};
  let current = "";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < inner.length; i++) {
    const char = inner[i];
    if (!char) continue;

    if (escaped) {
      escaped = false;
      current += char;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      current += char;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      current += char;
      continue;
    }

    if (!inString) {
      if (char === "{" || char === "[") {
        depth++;
      } else if (char === "}" || char === "]") {
        depth--;
      } else if (char === "," && depth === 0) {
        const pair = current.trim();
        if (pair) {
          const eqIndex = pair.indexOf("=");
          if (eqIndex > 0) {
            const key = pair.slice(0, eqIndex).trim();
            const value = pair.slice(eqIndex + 1).trim();
            if (key) {
              result[key] = parseTomlValue(value);
            }
          }
        }
        current = "";
        continue;
      }
    }
    current += char;
  }

  const pair = current.trim();
  if (pair) {
    const eqIndex = pair.indexOf("=");
    if (eqIndex > 0) {
      const key = pair.slice(0, eqIndex).trim();
      const value = pair.slice(eqIndex + 1).trim();
      if (key) {
        result[key] = parseTomlValue(value);
      }
    }
  }

  return result;
}

function parseTomlValue(value: string): unknown {
  const normalized = value.trim();

  if ((normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'"))) {
    return normalized.slice(1, -1);
  }

  if (normalized === "true") return true;
  if (normalized === "false") return false;

  // 支持内联表格格式 { key = "value", key2 = "value2" }
  if (normalized.startsWith("{") && normalized.endsWith("}")) {
    const parsed = parseTomlInlineTable(normalized);
    if (parsed) {
      return parsed;
    }
    // 如果解析失败，尝试作为 JSON 解析（兼容旧格式）
    try {
      return JSON.parse(normalized);
    } catch {
      return undefined;
    }
  }

  if (normalized.startsWith("[")) {
    try {
      return JSON.parse(normalized.replace(/'/g, '"'));
    } catch {
      return undefined;
    }
  }

  const num = Number(normalized);
  if (!Number.isNaN(num)) return num;

  return normalized;
}

export function readTomlMcpServers(raw: string): Record<string, McpServerConfig> {
  const servers: Record<string, Record<string, unknown>> = {};
  const lines = raw.split(/\r?\n/);
  let currentServerName: string | null = null;
  // 当前写入目标：可能是 server 对象本身，也可能是子表（如 env）
  let currentTarget: Record<string, unknown> | null = null;
  const mcpServerHeaderPattern = /^\[(?:mcpServers|mcp_servers)\.([^\]]+)\]$/;

  function ensureServer(name: string): Record<string, unknown> {
    if (!servers[name]) {
      servers[name] = {};
    }
    return servers[name];
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const tableMatch = trimmed.match(mcpServerHeaderPattern);
    if (tableMatch) {
      const fullKey = tableMatch[1] ?? "";
      const dotIndex = fullKey.indexOf(".");
      if (dotIndex < 0) {
        // 顶层 server header: [mcp_servers.context7]
        currentServerName = fullKey || null;
        currentTarget = currentServerName ? ensureServer(currentServerName) : null;
      } else {
        // 子表 header: [mcp_servers.context7.env]
        const serverName = fullKey.slice(0, dotIndex);
        const subKey = fullKey.slice(dotIndex + 1);
        currentServerName = serverName;
        const serverObj = ensureServer(serverName);
        const subObj: Record<string, unknown> = {};
        serverObj[subKey] = subObj;
        currentTarget = subObj;
      }
      continue;
    }

    // 遇到非 MCP 的 table header 时结束当前 server
    if (/^\[[^\]]+\]$/.test(trimmed)) {
      currentServerName = null;
      currentTarget = null;
      continue;
    }

    if (!currentServerName || !currentTarget) {
      continue;
    }

    const keyValueMatch = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
    if (!keyValueMatch) {
      continue;
    }

    const key = keyValueMatch[1];
    const value = keyValueMatch[2];
    if (!key || value === undefined) {
      continue;
    }
    const parsedValue = parseTomlValue(value);
    if (parsedValue !== undefined) {
      currentTarget[key] = parsedValue;
    }
  }

  // 过滤空的 server
  const result: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    if (Object.keys(config).length > 0) {
      result[name] = config as McpServerConfig;
    }
  }
  return result;
}

/**
 * 序列化 TOML 值
 * 支持标准 TOML 格式输出，包括内联表格
 */
function serializeTomlValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeTomlValue(item)).join(", ")}]`;
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  if (value == null) {
    return '""';
  }
  // 处理对象：输出 TOML 内联表格格式 { key = "value" }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return "{}";
    }
    const pairs = entries.map(([k, v]) => `${k} = ${serializeTomlValue(v)}`);
    return `{ ${pairs.join(", ")} }`;
  }
  return JSON.stringify(value);
}

export function stripTomlMcpServers(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;
  const mcpServerHeaderPattern = /^\[(?:mcpServers|mcp_servers)\.[^\]]+\]$/;

  for (const line of lines) {
    const trimmed = line.trim();
    const isMcpServerHeader = mcpServerHeaderPattern.test(trimmed);
    const isOtherHeader = /^\[[^\]]+\]$/.test(trimmed) && !isMcpServerHeader;

    if (isMcpServerHeader) {
      skipping = true;
      continue;
    }

    if (skipping && isOtherHeader) {
      skipping = false;
    }

    if (!skipping) {
      kept.push(line);
    }
  }

  return kept.join("\n").trimEnd();
}

export function serializeTomlMcpServers(
  servers: Record<string, McpServerConfig>,
  configKeyName: string = "mcp_servers",
): string {
  const blocks = Object.entries(servers).map(([name, config]) => {
    const lines = [`[${configKeyName}.${name}]`];
    // 先序列化非对象的字段（内联值）
    const subTables: Array<[string, Record<string, unknown>]> = [];
    for (const [key, value] of Object.entries(config)) {
      if (value === undefined) {
        continue;
      }
      // 纯对象（非数组）作为子表输出，保持 TOML 风格
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        subTables.push([key, value as Record<string, unknown>]);
      } else {
        lines.push(`${key} = ${serializeTomlValue(value)}`);
      }
    }
    // 输出子表 [mcp_servers.serverName.subKey]
    for (const [subKey, subObj] of subTables) {
      lines.push("");
      lines.push(`[${configKeyName}.${name}.${subKey}]`);
      for (const [k, v] of Object.entries(subObj)) {
        if (v === undefined) {
          continue;
        }
        lines.push(`${k} = ${serializeTomlValue(v)}`);
      }
    }
    return lines.join("\n");
  });
  return blocks.join("\n\n");
}
