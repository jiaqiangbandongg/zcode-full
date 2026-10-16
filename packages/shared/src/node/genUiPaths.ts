import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { buildGenUiScopeKey, genUiScopeSchema, type GenUiScope } from "../gen-ui/index.js";

/** Execution Host supplies this process-scoped root; models never choose it. */
export const GEN_UI_OUTPUT_ROOT_ENV = "ZCODE_GEN_UI_OUTPUT_ROOT";
export const GEN_UI_OUTPUT_DIRECTORY = "visualizations";

export function getGenUiOutputDirectory(outputRoot: string, scope: GenUiScope): string {
  genUiScopeSchema.parse(scope);
  if (!isAbsolute(outputRoot) || !isAbsolute(scope.workspacePath))
    throw new Error("Gen UI output root and workspace must be absolute");
  const root = resolve(outputRoot);
  // 根因：固定输出目录被误当成工作区外限制，打开 Home 时会阻断上下文初始化。
  // 目录由 Host 决定；工作区可以包含它，workspace/session 子目录只负责组织生成文件。
  return join(root, createHash("sha256").update(buildGenUiScopeKey(scope)).digest("hex"));
}
