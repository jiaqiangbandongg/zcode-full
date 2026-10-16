// ============================================================
// 工作流确认窗应答里的设置调整 → broker 结果的 inputAdjustments
// ============================================================
// docs/dynamic-workflow/launch.md「Adjusting the settings in the window」。
//
// 从 interaction-broker.ts 拆出（max-lines 门）：只做一件事——在 CreateWorkflow / AmendWorkflow 的
// **放行**应答上读 v4 answer 的 `content`，按契约 schema 收成那两个字段，交给 executor 去应用。

import {
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  parseWorkflowSettingsAdjustment,
} from "@zcode/contracts";
import type { V4InteractionAnswer } from "../zcode-protocol-v4/interaction-registry.js";

/**
 * 只认两个工具的 allow 应答。拒绝（含 Refine）永远不带调整：设置属于 Allow 将要启动的那次 run，
 * 拒绝什么都不启动。认不出的键被丢掉，形状不对的 content 整份作废——这不是一次放权（上界只能
 * 压低、模型要经目录重新解析），作废只意味着按确认窗之前的入参跑。
 */
export function withWorkflowSettingsAdjustment<T extends { decision: string }>(
  response: T,
  answer: V4InteractionAnswer,
  toolName: string,
): T & { inputAdjustments?: Readonly<Record<string, unknown>> } {
  if (toolName !== CREATE_WORKFLOW_TOOL_NAME && toolName !== AMEND_WORKFLOW_TOOL_NAME) {
    return response;
  }
  if (response.decision !== "allow" || answer.content === undefined) return response;
  const adjustment = parseWorkflowSettingsAdjustment(answer.content);
  return adjustment === undefined ? response : { ...response, inputAdjustments: adjustment };
}
