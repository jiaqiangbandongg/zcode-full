import { getGenUiOutputDirectory } from "@zcode/shared/node";
import type { AgentRuntimeInternal } from "../internal.js";

export function resolveGenUiOutputDirectory(runtime: AgentRuntimeInternal): string | undefined {
  if (runtime.config.presentationSurface !== "zcode_desktop" || !runtime.config.genUiOutputRoot)
    return undefined;
  return getGenUiOutputDirectory(runtime.config.genUiOutputRoot, {
    workspacePath: runtime.config.workspacePath ?? runtime.workspaceRoot,
    workspaceIdentity: runtime.config.workspaceIdentity,
    sessionId: runtime.sessionId,
  });
}

export async function ensureGenUiOutputDirectory(runtime: AgentRuntimeInternal): Promise<void> {
  const path = resolveGenUiOutputDirectory(runtime);
  if (!path) return;
  if (!runtime.fileSystemPort) throw new Error("Gen UI output requires FileSystemPort");
  // 只有成功创建后才向模型声明可写目录；失败不能静默落到 Git 工作区。
  await runtime.fileSystemPort.createDirectory({ path, trace: runtime.rootTraceContext });
}
