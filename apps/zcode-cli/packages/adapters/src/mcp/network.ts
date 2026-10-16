import { accessSync, constants } from "node:fs";
import { delimiter, posix, win32 } from "node:path";
import { sanitizeZCodeRuntimeEnv } from "@zcode/shared";
import { withoutNetworkCapture } from "@zcode/shared/node";
import { createNetworkProxyFetch } from "../network/proxy-fetch.js";
import { applyNetworkEgressEnv, type NetworkEgressEnvPolicy } from "../network/subprocess-env.js";

export type { NetworkEgressEnvPolicy };

export function buildMcpStdioEnv(options: {
  env?: NodeJS.ProcessEnv;
  network?: NetworkEgressEnvPolicy;
}): Record<string, string> {
  const sourceEnv = options.env ?? process.env;
  return prependRunningNodeDirectory(
    applyNetworkEgressEnv(sanitizeZCodeRuntimeEnv(filterStringEnv(sourceEnv)), {
      network: options.network,
      sourceEnv,
    }),
  );
}

export function createMcpTransportFetch(options: {
  env?: NodeJS.ProcessEnv;
  network?: NetworkEgressEnvPolicy;
}): typeof globalThis.fetch {
  const fetch = createNetworkProxyFetch({
    caCertFile: options.network?.caCertFile,
    env: options.env ?? process.env,
    httpProxy: options.network?.httpProxy,
    noProxy: options.network?.noProxy,
  });
  return (input, init) => withoutNetworkCapture(() => fetch(input, init));
}

function filterStringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

interface RunningNodePathOptions {
  execPath: string;
  isExecutable: (path: string) => boolean;
  platform: NodeJS.Platform;
}

const DEFAULT_RUNNING_NODE_PATH_OPTIONS: RunningNodePathOptions = {
  execPath: process.execPath,
  isExecutable: isExecutableFile,
  platform: process.platform,
};

export function prependRunningNodeDirectory(
  env: Record<string, string>,
  options: RunningNodePathOptions = DEFAULT_RUNNING_NODE_PATH_OPTIONS,
): Record<string, string> {
  const pathApi = options.platform === "win32" ? win32 : posix;
  const pathDelimiter = options.platform === "win32" ? ";" : delimiter;
  const executableName = pathApi.basename(options.execPath).toLowerCase();
  if (executableName !== "node" && executableName !== "node.exe") {
    return env;
  }

  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const currentPath = env[pathKey] ?? "";
  const nodeDirectory = pathApi.dirname(options.execPath);
  const pathEntries = currentPath.split(pathDelimiter).filter(Boolean);
  if (
    pathEntries.some((entry) =>
      arePathEntriesEqual(entry, nodeDirectory, options.platform),
    )
  ) {
    return env;
  }

  const nodeExecutableName = options.platform === "win32" ? "node.exe" : "node";
  if (
    pathEntries.some((entry) =>
      options.isExecutable(pathApi.join(entry, nodeExecutableName)),
    )
  ) {
    return env;
  }

  // remote Agent 由 ~/.zcode/server/node 启动，但登录环境 PATH 不含该目录，
  // Plugin manifest 中标准的 command: "node" 因此无法启动 MCP。复用当前 Agent 的 Node
  // 目录可保持插件配置跨本地/SSH/WSL/Docker 可移植，同时不覆盖插件显式注入的环境。
  return {
    ...env,
    [pathKey]: currentPath
      ? `${nodeDirectory}${pathDelimiter}${currentPath}`
      : nodeDirectory,
  };
}

function arePathEntriesEqual(
  left: string,
  right: string,
  platform: NodeJS.Platform,
): boolean {
  const pathApi = platform === "win32" ? win32 : posix;
  const normalize = (value: string) => {
    const normalized = pathApi.normalize(value);
    return platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
