/**
 * MCP 用户目录模块 - 主入口
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type {
  CliMcpSource,
  LoadCliMcpFromUserDirectoryRequest,
  LoadCliMcpFromUserDirectoryResult,
  McpScope,
  SettingsDirectoryLocation,
  SettingsDirectorySource,
  NativeMcpServerRecord,
  SaveCliMcpToUserDirectoryRequest,
} from "@zcode/shared";
import type { McpConfigKeyName } from "./types.js";
import { isRecord, readJsonObject, writeTextAtomic } from "./utils.js";
import { migrateLegacyCommonMcp } from "./legacy.js";

// 重新导出类型和函数
export type { McpConfigKeyName, OpenCodeMcpServerConfig, McpSourceDescriptor } from "./types.js";
export { MCP_SOURCE_DESCRIPTORS, getSourceDescriptor } from "./types.js";
export { migrateLegacyCommonMcp } from "./legacy.js";

interface DirectoryMcpDescriptor {
  source: CliMcpSource;
  directorySource: SettingsDirectorySource;
  userConfigDirSegments: string[];
  workspaceConfigDirSegments: string[];
  fileName: string;
  format: "json";
  configKeyName: McpConfigKeyName;
}

const ZCODE_MCP_DESCRIPTOR: DirectoryMcpDescriptor = {
  source: "zcodeagentmcp",
  directorySource: "zcode",
  userConfigDirSegments: [".zcode", "cli"],
  workspaceConfigDirSegments: [".zcode"],
  fileName: "config.json",
  format: "json",
  configKeyName: "mcp.servers",
};
const ENABLED_KEY = "enabled";
// 历史遗留：桌面端早期把停用状态写成 enable，而 CLI 契约字段（contracts McpServerConfigBase）
// 一直是 enabled，导致同一条 server 出现两套口径、停用后仍被 agent 拉起。
// 现在读写逻辑一律只认 enabled，这里只保留一次性迁移；存量配置清空后整块删除。
const LEGACY_ENABLE_KEY = "enable";

const AGENTS_MCP_DESCRIPTOR: DirectoryMcpDescriptor = {
  source: "zcodeagentmcp",
  directorySource: "agents",
  userConfigDirSegments: [".agents"],
  workspaceConfigDirSegments: [".agents"],
  fileName: "mcp.json",
  format: "json",
  configKeyName: "mcpServers",
};

function resolveUserHomeDir(): string {
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

const DIRECTORY_MCP_DESCRIPTORS: readonly DirectoryMcpDescriptor[] = [
  ZCODE_MCP_DESCRIPTOR,
  AGENTS_MCP_DESCRIPTOR,
];

function buildDirectoryConfigPath(
  descriptor: DirectoryMcpDescriptor,
  scope: Exclude<McpScope, "common">,
  workspacePath?: string,
): string {
  const baseDir = scope === "user" ? resolveUserHomeDir() : workspacePath;
  if (!baseDir) {
    throw new Error(`Missing workspace path for ${descriptor.directorySource} workspace MCP config`);
  }
  const segments = scope === "user" ? descriptor.userConfigDirSegments : descriptor.workspaceConfigDirSegments;
  return join(baseDir, ...segments, descriptor.fileName);
}

function getUserCliConfigPath(): string {
  return buildDirectoryConfigPath(ZCODE_MCP_DESCRIPTOR, "user");
}

function buildDirectoryMcpLocation(
  descriptor: DirectoryMcpDescriptor,
  scope: Exclude<McpScope, "common">,
  workspacePath?: string,
): SettingsDirectoryLocation {
  const filePath = buildDirectoryConfigPath(descriptor, scope, workspacePath);
  return {
    source: descriptor.directorySource,
    scope: scope === "workspace" ? "project" : "user",
    directoryPath: dirname(filePath),
    ...(workspacePath ? { projectPath: workspacePath } : {}),
  };
}

function readServerMapFromJson(
  parsed: Record<string, unknown>,
  configKeyName: McpConfigKeyName,
): Record<string, Record<string, unknown>> {
  if (configKeyName === "mcp.servers") {
    const mcp = parsed.mcp;
    if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) {
      return {};
    }
    const servers = (mcp as Record<string, unknown>).servers;
    return servers && typeof servers === "object" && !Array.isArray(servers)
      ? servers as Record<string, Record<string, unknown>>
      : {};
  }

  const rawServerMap = parsed[configKeyName];
  return rawServerMap && typeof rawServerMap === "object" && !Array.isArray(rawServerMap)
    ? rawServerMap as Record<string, Record<string, unknown>>
    : {};
}

function writeServerMapToJson(
  current: Record<string, unknown>,
  configKeyName: McpConfigKeyName,
  servers: Record<string, Record<string, unknown>>,
): Record<string, unknown> {
  if (configKeyName !== "mcp.servers") {
    return {
      ...current,
      [configKeyName]: servers,
    };
  }

  const currentMcp = current.mcp && typeof current.mcp === "object" && !Array.isArray(current.mcp)
    ? current.mcp as Record<string, unknown>
    : {};
  return {
    ...current,
    mcp: {
      ...currentMcp,
      servers,
    },
  };
}

async function readUserCliConfig(): Promise<Record<string, unknown>> {
  return (await readJsonObject(getUserCliConfigPath())) ?? {};
}

async function writeUserCliConfig(config: Record<string, unknown>): Promise<void> {
  await writeTextAtomic(getUserCliConfigPath(), `${JSON.stringify(config, null, 2)}\n`);
}

function readServerEnabled(config: Record<string, unknown>): boolean {
  return config[ENABLED_KEY] !== false;
}

function setServerEnabled(config: Record<string, unknown>, enabled: boolean): Record<string, unknown> {
  // 启用是默认态，不落盘冗余字段；同时清掉可能残留的 legacy enable，
  // 避免再产出 enable:false + enabled:true 这类自相矛盾的配置。
  const { [LEGACY_ENABLE_KEY]: _legacyEnable, [ENABLED_KEY]: _enabled, ...rest } = config;
  if (enabled) {
    return rest;
  }
  return { ...rest, [ENABLED_KEY]: false };
}

function migrateLegacyEnableFlag(
  serverMap: Record<string, Record<string, unknown>>,
): { servers: Record<string, Record<string, unknown>>; changed: boolean } {
  let changed = false;
  const migrated: Record<string, Record<string, unknown>> = {};

  for (const [name, config] of Object.entries(serverMap)) {
    if (!isRecord(config) || !(LEGACY_ENABLE_KEY in config)) {
      migrated[name] = config;
      continue;
    }
    changed = true;
    // 两个字段冲突时以「停用」为准：桌面端写 enable:false 时不会清理外部导入残留的
    // enabled:true，若按 enabled 取值会把用户关掉的 server 重新拉起。
    const disabled = config[LEGACY_ENABLE_KEY] === false || config[ENABLED_KEY] === false;
    migrated[name] = setServerEnabled(config, !disabled);
  }

  return { servers: migrated, changed };
}

function removeLegacyMcpEnabledOverride(
  config: Record<string, unknown>,
  location: SettingsDirectoryLocation,
  name: string,
): { config: Record<string, unknown>; changed: boolean } {
  if (!isRecord(config.mcp) || !isRecord(config.mcp[location.directoryPath])) {
    return { config, changed: false };
  }

  const mcpConfig = isRecord(config.mcp) ? { ...config.mcp } : {};
  const pathConfig = isRecord(mcpConfig[location.directoryPath])
    ? { ...(mcpConfig[location.directoryPath] as Record<string, unknown>) }
    : {};
  if (!(name in pathConfig)) {
    return { config, changed: false };
  }

  delete pathConfig[name];

  if (Object.keys(pathConfig).length > 0) {
    mcpConfig[location.directoryPath] = pathConfig;
  } else {
    delete mcpConfig[location.directoryPath];
  }

  return {
    config: {
      ...config,
      mcp: mcpConfig,
    },
    changed: true,
  };
}

function findDescriptorByLocation(location: SettingsDirectoryLocation): DirectoryMcpDescriptor {
  const descriptor = DIRECTORY_MCP_DESCRIPTORS.find((item) => item.directorySource === location.source);
  if (!descriptor) {
    throw new Error(`Unsupported MCP settings directory source: ${location.source}`);
  }
  return descriptor;
}

async function cleanupLegacyMcpEnabledOverride(
  location: SettingsDirectoryLocation,
  name: string,
): Promise<void> {
  const userConfig = await readUserCliConfig();
  const result = removeLegacyMcpEnabledOverride(userConfig, location, name);
  if (result.changed) {
    await writeUserCliConfig(result.config);
  }
}

async function writeServerEnabledToFile(
  descriptor: DirectoryMcpDescriptor,
  location: SettingsDirectoryLocation,
  name: string,
  enabled: boolean,
): Promise<void> {
  const scope: Exclude<McpScope, "common"> = location.scope === "project" ? "workspace" : "user";
  const workspacePath = scope === "workspace" ? location.projectPath : undefined;
  const filePath = buildDirectoryConfigPath(descriptor, scope, workspacePath);
  const current = (await readJsonObject(filePath)) ?? {};
  const serverMap = readServerMapFromJson(current, descriptor.configKeyName);
  const currentServer = serverMap[name];
  if (!isRecord(currentServer)) {
    return;
  }

  // MCP 自身已有 mcp.servers/mcpServers 结构；禁用状态写在 server 配置对象内，
  // 避免把目录路径写到 mcp 顶层后和真实 MCP 配置混在一起。
  const nextServerMap = {
    ...serverMap,
    [name]: setServerEnabled(currentServer, enabled),
  };
  let next = writeServerMapToJson(current, descriptor.configKeyName, nextServerMap);
  const legacyCleanup = removeLegacyMcpEnabledOverride(next, location, name);
  if (legacyCleanup.changed) {
    next = legacyCleanup.config;
  }
  await writeTextAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
}

async function readDirectoryServersFromFile(
  descriptor: DirectoryMcpDescriptor,
  scope: Exclude<McpScope, "common">,
  workspacePath?: string,
): Promise<NativeMcpServerRecord[]> {
  const filePath = buildDirectoryConfigPath(descriptor, scope, workspacePath);

  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const migration = migrateLegacyEnableFlag(readServerMapFromJson(parsed, descriptor.configKeyName));
    const serverMap = migration.servers;

    if (migration.changed) {
      // 就地把存量 enable 折叠成 enabled 并落盘，用户无感；没有残留时不写文件，保证幂等。
      // 写盘失败（只读目录、权限不足等）不应阻断加载：内存结果已是正确口径，下次加载会重试。
      try {
        const next = writeServerMapToJson(parsed, descriptor.configKeyName, serverMap);
        await writeTextAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
      } catch (error) {
        console.warn("[mcp-user-directory] legacy enable migration failed:", filePath, error);
      }
    }

    const location = buildDirectoryMcpLocation(descriptor, scope, workspacePath);
    return Object.entries(serverMap).map(([name, config]) => ({
      source: descriptor.source,
      scope,
      name,
      config,
      enabled: readServerEnabled(config),
      projectPath: scope === "workspace" ? workspacePath : undefined,
      location,
      file: {
        format: descriptor.format,
        filePath,
      },
    }));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return [];
    }
    // 解析/权限失败不等于没有 MCP 配置；吞掉异常会让 renderer 把空列表
    // 作为显式配置送入 replace 路径，进而断开已经运行的 server。
    throw error;
  }
}

async function readDirectoryServersFromPreferredSources(
  scope: Exclude<McpScope, "common">,
  workspacePath?: string,
): Promise<NativeMcpServerRecord[]> {
  const zcodeServers = await readDirectoryServersFromFile(ZCODE_MCP_DESCRIPTOR, scope, workspacePath);
  // `.zcode` 是强优先级来源；只要读到 MCP server，同 scope 的 `.agents` 就不再参与。
  if (zcodeServers.length > 0) {
    return zcodeServers;
  }
  return readDirectoryServersFromFile(AGENTS_MCP_DESCRIPTOR, scope, workspacePath);
}

async function writeZCodeServersToFile(
  scope: Exclude<McpScope, "common">,
  servers: Record<string, Record<string, unknown>>,
  workspacePath?: string,
): Promise<void> {
  const filePath = buildDirectoryConfigPath(ZCODE_MCP_DESCRIPTOR, scope, workspacePath);
  const current = (await readJsonObject(filePath)) ?? {};
  const next = writeServerMapToJson(current, ZCODE_MCP_DESCRIPTOR.configKeyName, servers);
  await writeTextAtomic(filePath, `${JSON.stringify(next, null, 2)}\n`);
}

export async function loadCliMcpFromUserDirectory(
  request?: LoadCliMcpFromUserDirectoryRequest,
): Promise<LoadCliMcpFromUserDirectoryResult> {
  const servers: NativeMcpServerRecord[] = [];

  // 去掉其他 provider 后，ZCode Agent 只按目录约定读取；先 workspace，再 user。
  if (request?.workspacePath) {
    servers.push(...await readDirectoryServersFromPreferredSources("workspace", request.workspacePath));
  }

  servers.push(...await readDirectoryServersFromPreferredSources("user", request?.workspacePath));

  return { servers };
}

export async function saveCliMcpToUserDirectory(
  payload: SaveCliMcpToUserDirectoryRequest,
): Promise<void> {
  if (payload.action === "set-enabled") {
    if (typeof payload.enabled !== "boolean") {
      throw new Error("Missing enabled value for MCP set-enabled action");
    }
    const scope: Exclude<McpScope, "common"> = payload.projectPath ? "workspace" : "user";
    const location = payload.location ?? buildDirectoryMcpLocation(ZCODE_MCP_DESCRIPTOR, scope, payload.projectPath);
    await writeServerEnabledToFile(findDescriptorByLocation(location), location, payload.name, payload.enabled);
    await cleanupLegacyMcpEnabledOverride(location, payload.name);
    return;
  }

  const scope: Exclude<McpScope, "common"> = payload.projectPath ? "workspace" : "user";
  const existingServers = await readDirectoryServersFromFile(ZCODE_MCP_DESCRIPTOR, scope, payload.projectPath);
  const nextServers = Object.fromEntries(existingServers.map((server) => [server.name, server.config]));

  if (payload.action === "upsert") {
    if (!payload.config) {
      throw new Error("Missing MCP config for upsert action");
    }
    nextServers[payload.name] = payload.config;
  } else {
    delete nextServers[payload.name];
  }

  await writeZCodeServersToFile(scope, nextServers, payload.projectPath);
}
