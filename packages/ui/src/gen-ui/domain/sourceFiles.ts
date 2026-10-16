import { projectGenUiReferences } from "@/gen-ui/domain/references.js";

export function collectGenUiSourcePaths(text: string): readonly string[] {
  // 这里只识别完整引用以去重，不挂载页面；执行时机和文件授权仍由原有 Gen UI 链路负责。
  return [
    ...new Set(
      projectGenUiReferences(text, true).flatMap((part) =>
        part.kind === "ui" ? [part.reference.path] : [],
      ),
    ),
  ];
}

export function matchesGenUiSourcePath(path: string, sources: readonly string[]): boolean {
  const normalize = (value: string) => value.replace(/\\/g, "/").replace(/\/+/g, "/");
  const candidate = normalize(path);
  return sources.some((source) => normalize(source) === candidate);
}
