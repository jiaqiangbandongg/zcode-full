/**
 * MCP 用户目录模块 - OpenCode 格式转换
 */

import type { McpServerConfig } from "@zcode/shared";
import type { OpenCodeMcpServerConfig } from "./types.js";

/**
 * 将 OpenCode 配置格式转换为标准 McpServerConfig
 * OpenCode 格式: { type: "local", command: ["npx", "-y", "server"], env: {...} }
 * 标准格式: { command: "npx", args: ["-y", "server"], env: {...} }
 */
export function convertOpenCodeToStandard(config: OpenCodeMcpServerConfig): McpServerConfig {
  const result: McpServerConfig = {};

  if (config.type === "local" && config.command && config.command.length > 0) {
    // command 数组的第一个元素是命令本身
    result.command = config.command[0];
    // 剩余元素是参数
    if (config.command.length > 1) {
      result.args = config.command.slice(1);
    }
  } else if (config.type === "remote" && config.url) {
    result.type = "http";
    result.url = config.url;
  }

  if (config.env) {
    result.env = config.env;
  }
  if (config.headers) {
    result.headers = config.headers;
  }

  return result;
}

/**
 * 将标准 McpServerConfig 转换为 OpenCode 配置格式
 */
export function convertStandardToOpenCode(config: McpServerConfig): OpenCodeMcpServerConfig {
  const result: OpenCodeMcpServerConfig = {
    type: config.url ? "remote" : "local",
  };

  if (result.type === "local") {
    // 将 command 和 args 合并为数组
    const commandParts: string[] = [];
    if (config.command) {
      commandParts.push(config.command);
    }
    if (config.args && config.args.length > 0) {
      commandParts.push(...config.args);
    }
    if (commandParts.length > 0) {
      result.command = commandParts;
    }
  } else {
    if (config.url) {
      result.url = config.url;
    }
  }

  if (config.env) {
    result.env = config.env;
  }
  if (config.headers) {
    result.headers = config.headers;
  }

  return result;
}

/**
 * 检查配置是否是 OpenCode 格式
 */
export function isOpenCodeFormat(config: McpServerConfig): boolean {
  return "type" in config || Array.isArray((config as unknown as OpenCodeMcpServerConfig).command);
}
