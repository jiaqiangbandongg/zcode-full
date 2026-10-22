/** Window Host 项目目录导航；依赖须与 architecture-policy 一致。 */
export const projectWorkspaceNavigationModule = {
  id: "project-workspace-navigation",
  requires: ["project", "project-catalog", "remote-projects", "shared"],
  provides: ["project-workspace-navigation"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
