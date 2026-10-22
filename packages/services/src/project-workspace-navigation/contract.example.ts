import type { ProjectWorkspaceNavigation } from "#src/project-workspace-navigation/contract.js";
export async function openProjectExample(navigation: ProjectWorkspaceNavigation) {
  return navigation.prepare({ hostId: "remote:server:example", projectId: "project" });
}
