import type { ToolEntry } from "../types.js";
export {
  AmendWorkflowInputSchema,
  FillWorkflowHoleInputSchema,
  ListModelsInputSchema,
} from "@zcode/contracts";

/** 复用原 ToolEntry 与执行器契约，不包装 handler 或复制工具配置。 */
export interface WorkflowToolEntrypoints {
  readonly amendWorkflow: ToolEntry;
  readonly listModels: ToolEntry;
  readonly fillWorkflowHole: ToolEntry;
}
