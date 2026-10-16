// ============================================================
// 确认窗里可调的两项 run 设置：纯规则
// ============================================================
// docs/dynamic-workflow/launch.md「Adjusting the settings in the window」；外观见
// docs/dynamic-workflow/presentation.md「The confirmation window」。
//
// 与「配置」弹层是同一份草稿、同一条「改了什么」的判断（workflowRunSettings.ts），差别只在起点与出口：
// 起点读的是**这次调用的入参**（CLI resolveInput 归一化过的值），出口是 Allow 应答的 `content`，用工具
// 自己的字段名与三态——agent 侧据此只有一套解析（contracts 的 WorkflowSettingsAdjustmentSchema）。

import {
  readWorkflowMaxConcurrency,
  readWorkflowSubagentModel,
} from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
import {
  workflowRunSettingsChange,
  workflowRunSettingsModelOf,
  type WorkflowRunSettingsDraft,
} from "./workflowRunSettings.js";

/** Allow 应答的 `content`：只含改过的字段；`null` = 回到默认（会话模型 / 默认并发）。 */
export interface WorkflowAskSettingsContent {
  subagent_model?: string | null;
  max_concurrency?: number | null;
}

/**
 * 起点：入参里的值。模型缺席即会话模型；上界缺席即默认并发（「没有自己的界」在步进器上就是那个数），
 * 默认也未知则为 null（步进器留空，敲一个数才算设了界）。
 */
export function initialWorkflowAskSettingsDraft(
  input: unknown,
  defaultConcurrency: number | undefined,
): WorkflowRunSettingsDraft {
  return {
    model: workflowRunSettingsModelOf(readWorkflowSubagentModel(input)),
    bound: readWorkflowMaxConcurrency(input) ?? defaultConcurrency ?? null,
  };
}

/**
 * 出口：改过的字段 → 应答 content；什么都没改即 undefined（Allow 照旧只带 optionId）。规则全是弹层的：
 * 只改思考档也算改了模型，上界等于默认并发发 `null`（高于默认是一个真的数）。
 */
export function workflowAskSettingsContent(
  initial: WorkflowRunSettingsDraft,
  draft: WorkflowRunSettingsDraft,
  defaultConcurrency: number | undefined,
): WorkflowAskSettingsContent | undefined {
  const change = workflowRunSettingsChange(initial, draft, defaultConcurrency);
  if (change === undefined) return undefined;
  return {
    ...(change.subagentModel === undefined ? {} : { subagent_model: change.subagentModel }),
    ...(change.maxConcurrency === undefined ? {} : { max_concurrency: change.maxConcurrency }),
  };
}

/** 哪一行改了（改了的那一行加粗并带「原为 …」）。 */
export function workflowAskSettingsChangedLines(
  initial: WorkflowRunSettingsDraft,
  draft: WorkflowRunSettingsDraft,
  defaultConcurrency: number | undefined,
): { model: boolean; bound: boolean } {
  const content = workflowAskSettingsContent(initial, draft, defaultConcurrency);
  return {
    model: content?.subagent_model !== undefined,
    bound: content?.max_concurrency !== undefined,
  };
}
