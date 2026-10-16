import { join, posix, resolve } from "node:path";

export const E2E_RUNTIME_RELATIVE_ROOT = ".zcode-e2e";
export const E2E_RUNTIME_ROOT_REPLAY_TOKEN = "{{e2eRuntimeRoot}}";
const E2E_AGENT_WORKSPACE_NAME = "ZCodeProject";

interface ResolveE2EHomeDirOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export function resolveE2EHomeDir({
  cwd = process.cwd(),
  env = process.env,
}: ResolveE2EHomeDirOptions = {}): string {
  const configuredHome =
    env.ZCODE_E2E_HOME_DIR?.trim() ||
    env.ZCODE_DATA_BASE_DIR?.trim() ||
    env.ZCODE_DESKTOP_HOME_DIR?.trim();
  return resolve(cwd, configuredHome || ".e2e-home");
}

export function resolveE2EStorageRoot(e2eHomeDir = resolveE2EHomeDir()): string {
  // Bug 根因：回滚 storage profile 时删除了仍被 E2E 用例依赖的路径 helper。
  // E2E 继续隔离 HOME，但 CLI 根固定使用历史目录 .zcode，不再区分 dev/stable profile。
  return join(e2eHomeDir, ".zcode");
}

export function resolveE2ERuntimeRoot(e2eHomeDir = resolveE2EHomeDir()): string {
  // Bug 根因：conversation E2E 的 Agent 实际 cwd 是隔离 HOME 下的
  // ZCodeProject，而不是 conversation backing workspace。Node 若写到后者，
  // Bash 的相对路径就会永远等不到同一个文件，Windows 上还会叠加 shell 路径差异。
  return join(e2eHomeDir, E2E_AGENT_WORKSPACE_NAME, E2E_RUNTIME_RELATIVE_ROOT);
}

export function resolveE2ERuntimePath(...segments: string[]): string {
  return join(resolveE2ERuntimeRoot(), ...segments);
}

export function resolveE2EToolPath(...segments: string[]): string {
  // Bug 根因：Windows Node 与 Git Bash 会把裸 POSIX 临时根解析成不同目录。
  // 工具参数保留绝对路径，但统一成 Windows 文件 API 同样接受的正斜杠形式，
  // 让 JSON replay fixture 不需要猜测盘符转义或 Git Bash mount。
  return resolveE2ERuntimePath(...segments).replaceAll("\\", "/");
}

export function resolveE2EShellPath(...segments: string[]): string {
  return posix.join(E2E_RUNTIME_RELATIVE_ROOT, ...segments);
}

export function createE2EReplayFixtureVariables(
  e2eHomeDir = resolveE2EHomeDir(),
): Readonly<Record<string, string>> {
  return {
    e2eRuntimeRoot: resolveE2ERuntimeRoot(e2eHomeDir).replaceAll("\\", "/"),
  };
}
