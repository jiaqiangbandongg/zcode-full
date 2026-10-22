import type { IProjectService, ProjectTaskRef } from "@/project-sidebar/contract.js";
/** 先校验/确认再提交；不制造本地归属副本。 */
export async function exampleProjectMove(
  service: IProjectService,
  task: ProjectTaskRef,
  projectId: string,
) {
  await service.moveTask({ task, projectId });
  return service.readTree();
}
