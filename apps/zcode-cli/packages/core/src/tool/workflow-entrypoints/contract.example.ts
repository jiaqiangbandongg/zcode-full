import type { WorkflowToolEntrypoints } from "./contract.js";
import type { ToolRegistry } from "../registry.js";

/** 只注册既有入口；调用仍进入公共调度、参数校验及审批链。 */
export function exampleWorkflowToolEntrypoints(
  registry: Pick<ToolRegistry, "register">,
  entries: WorkflowToolEntrypoints,
): void {
  registry.register(entries.amendWorkflow);
  registry.register(entries.listModels);
  registry.register(entries.fillWorkflowHole);
}
