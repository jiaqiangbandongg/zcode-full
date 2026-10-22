import type {
  WorkflowRunSaveController,
  WorkflowRunSaveSubmit,
} from "@/project-workflow/contract.js";
/** 保存是否成功由 Agent 返回，调用方不能提前把卡片标为已保存。 */
export function saveCompletedRun(
  controller: Pick<WorkflowRunSaveController, "save">,
  input: WorkflowRunSaveSubmit,
) {
  return controller.save(input);
}
