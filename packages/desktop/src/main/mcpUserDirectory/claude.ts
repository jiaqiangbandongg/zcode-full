/**
 * MCP 用户目录模块 - Claude CLI 特殊处理
 */

import { join } from "node:path";
import { homedir } from "node:os";
import type {
  CliMcpSource,
  McpFileFormat,
  McpScope,
  SettingsDirectoryLocation,
  NativeMcpServerRecord,
  SaveCliMcpToUserDirectoryRequest,
} from "@zcode/shared";
import { getSourceDescriptor } from "./types.js";
import {
  buildClaudeStateFilePath,
  isRecord,
  normalizePathForLookup,
  normalizeServerMap,
  normalizeStringArray,
  readJsonObject,
  writeTextAtomic,
} from "./utils.js";

function findClaudeProjectState(
  root: Record<string, unknown> | null,
  workspacePath?: string,
): Record<string, unknown> | null {
  if (!workspacePath || !root) {
    return null;
  }

  const projects = root.projects;
  if (!isRecord(projects)) {
    return null;
  }

  const targetPath = normalizePathForLookup(workspacePath);
  for (const [projectPath, value] of Object.entries(projects)) {
    if (normalizePathForLookup(projectPath) === targetPath && isRecord(value)) {
      return value;
    }
  }

  return null;
}

function mapNativeServers(params: {
  source: CliMcpSource;
  scope: Exclude<McpScope, "common">;
  serverMap: Record<string, unknown>;
  filePath: string;
  format: McpFileFormat;
  projectPath?: string;
  enabledByName?: Record<string, boolean>;
}): NativeMcpServerRecord[] {
  const serverMap = normalizeServerMap(params.serverMap);
  return Object.entries(serverMap).map(([name, config]) => ({
    source: params.source,
    scope: params.scope,
    name,
    config,
    enabled: params.enabledByName?.[name],
    projectPath: params.projectPath,
    location: buildClaudeLocation(params.scope, params.projectPath),
    file: {
      format: params.format,
      filePath: params.filePath,
    },
  }));
}

function buildNativeConfigPath(
  source: CliMcpSource,
  scope: Exclude<McpScope, "common">,
  workspacePath?: string,
): string {
  const descriptor = getSourceDescriptor(source);
  const baseDir = scope === "user" ? homedir() : workspacePath;

  if (!baseDir) {
    throw new Error(`Missing workspace path for ${source} workspace MCP config`);
  }

  return join(baseDir, ...descriptor.configDirSegments, descriptor.fileName);
}

function buildClaudeSettingsFilePath(scope: Exclude<McpScope, "common">, workspacePath?: string): string {
  return buildNativeConfigPath("claudeclimcp", scope, workspacePath);
}

function buildClaudeLocation(
  scope: Exclude<McpScope, "common">,
  workspacePath?: string,
): SettingsDirectoryLocation {
  const baseDir = scope === "user" ? homedir() : workspacePath;
  if (!baseDir) {
    throw new Error("Missing workspace path for Claude workspace MCP config");
  }
  return {
    source: "claude",
    scope: scope === "workspace" ? "project" : "user",
    directoryPath: join(baseDir, ".claude"),
    ...(workspacePath ? { projectPath: workspacePath } : {}),
  };
}

function shouldWriteClaudeServerToState(
  existingServers: NativeMcpServerRecord[],
  name: string,
  stateFilePath: string,
): boolean {
  const existing = existingServers.find((server) => server.name === name);
  if (!existing?.file?.filePath) {
    return true;
  }
  return normalizePathForLookup(existing.file.filePath) === normalizePathForLookup(stateFilePath);
}

export async function readClaudeUserServers(workspacePath?: string): Promise<NativeMcpServerRecord[]> {
  const legacyFilePath = buildNativeConfigPath("claudeclimcp", "user");
  const legacyRoot = await readJsonObject(legacyFilePath);
  const settingsServers = normalizeServerMap(legacyRoot?.mcpServers);

  const stateFilePath = buildClaudeStateFilePath();
  const stateRoot = await readJsonObject(stateFilePath);
  const stateServers = normalizeServerMap(stateRoot?.mcpServers);

  const merged = new Map<string, { config: unknown; filePath: string }>();
  for (const [name, config] of Object.entries(settingsServers)) {
    merged.set(name, { config, filePath: legacyFilePath });
  }
  for (const [name, config] of Object.entries(stateServers)) {
    merged.set(name, { config, filePath: stateFilePath });
  }

  if (merged.size === 0) {
    return [];
  }

  const projectState = findClaudeProjectState(stateRoot, workspacePath);
  const disabledNames = new Set(normalizeStringArray(projectState?.disabledMcpServers));

  const result: NativeMcpServerRecord[] = [];
  for (const [name, { config, filePath }] of merged.entries()) {
    result.push({
      source: "claudeclimcp",
      scope: "user",
      name,
      config: config as Record<string, unknown>,
      enabled: !disabledNames.has(name),
      location: buildClaudeLocation("user"),
      file: {
        format: "json",
        filePath,
      },
    });
  }

  return result;
}

export async function readClaudeWorkspaceServers(workspacePath?: string): Promise<NativeMcpServerRecord[]> {
  if (!workspacePath) {
    return [];
  }

  const merged = new Map<string, NativeMcpServerRecord>();
  const workspaceFilePath = buildNativeConfigPath("claudeclimcp", "workspace", workspacePath);
  const workspaceRoot = await readJsonObject(workspaceFilePath);
  const workspaceServers = normalizeServerMap(workspaceRoot?.mcpServers);
  for (const server of mapNativeServers({
    source: "claudeclimcp",
    scope: "workspace",
    serverMap: workspaceServers,
    filePath: workspaceFilePath,
    format: "json",
    projectPath: workspacePath,
  })) {
    merged.set(server.name, server);
  }

  const stateFilePath = buildClaudeStateFilePath();
  const stateRoot = await readJsonObject(stateFilePath);
  const projectState = findClaudeProjectState(stateRoot, workspacePath);
  const projectServers = normalizeServerMap(projectState?.mcpServers);
  const disabledNames = new Set(normalizeStringArray(projectState?.disabledMcpServers));
  const enabledByName = Object.fromEntries(
    Object.keys(projectServers).map((name) => [name, !disabledNames.has(name)]),
  );

  for (const server of mapNativeServers({
    source: "claudeclimcp",
    scope: "workspace",
    serverMap: projectServers,
    filePath: stateFilePath,
    format: "json",
    projectPath: workspacePath,
    enabledByName,
  })) {
    merged.set(server.name, server);
  }

  return Array.from(merged.values());
}

async function writeClaudeUserServers(
  servers: NativeMcpServerRecord[],
  payload: SaveCliMcpToUserDirectoryRequest,
): Promise<void> {
  const settingsFilePath = buildClaudeSettingsFilePath("user");
  const stateFilePath = buildClaudeStateFilePath();
  const settingsRoot = (await readJsonObject(settingsFilePath)) ?? {};
  const stateRoot = (await readJsonObject(stateFilePath)) ?? {};
  const settingsServers = normalizeServerMap(settingsRoot.mcpServers);
  const stateServers = normalizeServerMap(stateRoot.mcpServers);

  if (payload.action === "upsert") {
    if (!payload.config) {
      throw new Error("Missing MCP config for upsert action");
    }
    if (shouldWriteClaudeServerToState(servers, payload.name, stateFilePath)) {
      stateServers[payload.name] = payload.config;
      delete settingsServers[payload.name];
    } else {
      settingsServers[payload.name] = payload.config;
    }
  } else {
    delete stateServers[payload.name];
    delete settingsServers[payload.name];
  }

  await writeTextAtomic(settingsFilePath, JSON.stringify({ ...settingsRoot, mcpServers: settingsServers }, null, 2) + "\n");
  await writeTextAtomic(stateFilePath, JSON.stringify({ ...stateRoot, mcpServers: stateServers }, null, 2) + "\n");
}

async function writeClaudeWorkspaceServers(
  servers: NativeMcpServerRecord[],
  payload: SaveCliMcpToUserDirectoryRequest,
): Promise<void> {
  if (!payload.projectPath) {
    throw new Error("Missing workspace path for Claude workspace MCP config");
  }

  const settingsFilePath = buildClaudeSettingsFilePath("workspace", payload.projectPath);
  const stateFilePath = buildClaudeStateFilePath();
  const settingsRoot = (await readJsonObject(settingsFilePath)) ?? {};
  const stateRoot = (await readJsonObject(stateFilePath)) ?? {};
  const workspaceServers = normalizeServerMap(settingsRoot.mcpServers);
  const projectsRoot = isRecord(stateRoot.projects) ? stateRoot.projects : {};
  const projectState = findClaudeProjectState(stateRoot, payload.projectPath);
  const projectServers = normalizeServerMap(projectState?.mcpServers);

  if (payload.action === "upsert") {
    if (!payload.config) {
      throw new Error("Missing MCP config for upsert action");
    }
    if (shouldWriteClaudeServerToState(servers, payload.name, stateFilePath)) {
      projectServers[payload.name] = payload.config;
      delete workspaceServers[payload.name];
    } else {
      workspaceServers[payload.name] = payload.config;
    }
  } else {
    delete projectServers[payload.name];
    delete workspaceServers[payload.name];
  }

  const nextProjectState = isRecord(projectState) ? { ...projectState } : {};
  nextProjectState.mcpServers = projectServers;
  const nextProjectsRoot = { ...projectsRoot, [payload.projectPath]: nextProjectState };

  await writeTextAtomic(settingsFilePath, JSON.stringify({ ...settingsRoot, mcpServers: workspaceServers }, null, 2) + "\n");
  await writeTextAtomic(stateFilePath, JSON.stringify({ ...stateRoot, projects: nextProjectsRoot }, null, 2) + "\n");
}

export async function writeClaudeServers(
  scope: Exclude<McpScope, "common">,
  servers: NativeMcpServerRecord[],
  payload: SaveCliMcpToUserDirectoryRequest,
): Promise<void> {
  if (scope === "user") {
    await writeClaudeUserServers(servers, payload);
    return;
  }
  await writeClaudeWorkspaceServers(servers, payload);
}
