import type { VirtualProject } from "#src/project-storage/contract.js";

/** 远端限制必须依据持库宿主，不能让请求中的 hostId 或 addMissingRoot 绕过。 */
export function assertRemoteProjectRoots(
  ownerHostId: string | undefined,
  roots: readonly string[],
  previous?: VirtualProject,
): void {
  if (!ownerHostId || ownerHostId === "local") return;
  if (roots.length !== 1) throw new Error("project.remote-single-root-required");
  if (previous && (previous.roots.length !== 1 || previous.roots[0]?.rootPath !== roots[0]))
    throw new Error("project.remote-root-immutable");
}

/** 新建、移动和恢复共用约束；固定执行配置也不能给远端会话增加第二个目录。 */
export function assertRemoteTaskDirectories(
  ownerHostId: string | undefined,
  project: VirtualProject | null | undefined,
  workspacePath: string,
  additionalDirectories: readonly string[] = [],
): void {
  if (!ownerHostId || ownerHostId === "local") return;
  if (!project) throw new Error("project.remote-project-required");
  assertRemoteProjectRoots(
    ownerHostId,
    project.roots.map((root) => root.rootPath),
  );
  if (additionalDirectories.length) throw new Error("project.remote-single-root-required");
  if (project.roots[0]?.rootPath !== workspacePath) throw new Error("project.cwd-not-in-roots");
}
