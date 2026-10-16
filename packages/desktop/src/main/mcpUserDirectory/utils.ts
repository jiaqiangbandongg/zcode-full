/**
 * MCP 用户目录模块 - 通用工具函数
 */

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import type { McpServerConfig } from "@zcode/shared";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeServerMap(value: unknown): Record<string, McpServerConfig> {
  if (!isRecord(value)) {
    return {};
  }

  const next: Record<string, McpServerConfig> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isRecord(item)) {
      next[key] = item as McpServerConfig;
    }
  }
  return next;
}

export function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

export async function readJsonObject(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function writeTextAtomic(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpFile = join(
    dirname(filePath),
    `${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );

  try {
    await writeFile(tmpFile, content, "utf-8");
    await rename(tmpFile, filePath);
  } catch (error) {
    await rm(tmpFile, { force: true });
    throw error;
  }
}

export function normalizePathForLookup(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function buildClaudeStateFilePath(): string {
  return join(homedir(), ".claude.json");
}
