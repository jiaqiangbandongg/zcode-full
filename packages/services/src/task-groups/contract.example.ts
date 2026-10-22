import type { ITaskGroupService } from "#src/task-groups/contract.js";
export async function createGroupExample(service: ITaskGroupService) {
  return service.save({ title: "Research", color: "blue" });
}
