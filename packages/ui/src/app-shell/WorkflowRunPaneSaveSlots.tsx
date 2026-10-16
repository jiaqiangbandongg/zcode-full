// run 侧板状态头上的「保存 / 再次运行」接线（docs/dynamic-workflow/transcript-and-notifications.md
// 「Saving the run, and running it again」）。
//
// 与完成卡共用同一个控制器（经 `WorkflowRunSaveSlotsBoundary` 挂载），因此同一个 run 在两处说
// 同一句话；侧板这边只多两件事：候选从**父会话**的行窗口建，那条用户消息也发进父会话。
// 这里只造宿主描述，不直接调用槽位 hook：控制器要查 agent，没有服务上下文的宿主不该挂它。
// 从 WorkflowRunSidePane.tsx 拆出（max-lines 400 行门）。
import { useCallback, useMemo, type ReactNode } from "react";
import type { ConversationRow, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import {
  WorkflowRunSaveSlotsBoundary,
  type WorkflowRunSaveSlots,
  type WorkflowRunSaveSlotsHost,
} from "@/components/workflow-timeline/WorkflowRunSaveControls.js";
import type { WorkflowRunSidePaneTab } from "@/lib/workspaceSidePane.js";
import { logger } from "@/logger.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { buildWorkflowSaveCandidatesByRunId } from "@/v4/workflowRunCardJoin.js";
import { useDynamicWorkflowAvailability } from "@/hooks/useDynamicWorkflowAvailability.js";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";

interface WorkflowRunPaneSaveParams {
  /** 父会话的行窗口：转写里认领过这次 run 的 SaveWorkflow 候选从这里读。 */
  rows: readonly ConversationRow[] | undefined;
  run: WorkflowRunState | undefined;
  tab: WorkflowRunSidePaneTab;
}

/** 侧板状态头的两个槽位：造宿主描述，再经服务边界挂控制器（没有服务上下文时交出 null）。 */
export function WorkflowRunPaneSaveSlots({
  children,
  ...params
}: WorkflowRunPaneSaveParams & {
  children: (slots: WorkflowRunSaveSlots | null) => ReactNode;
}) {
  const host = useWorkflowRunPaneSaveHost(params);
  return <WorkflowRunSaveSlotsBoundary host={host}>{children}</WorkflowRunSaveSlotsBoundary>;
}

function useWorkflowRunPaneSaveHost(params: WorkflowRunPaneSaveParams): WorkflowRunSaveSlotsHost {
  const { rows, run, tab } = params;
  // 灰度门（docs/dynamic-workflow/launch.md「Gray release」）与 Resume 同一道；命令走侧板所在的
  // 那条会话连接（与 Stop / Resume 同一个 sendCommand）。
  const { enabled } = useDynamicWorkflowAvailability();
  const { sendCommand } = useV4Conversation();
  const candidates = useMemo(
    () => buildWorkflowSaveCandidatesByRunId(rows).get(tab.runId),
    [rows, tab.runId],
  );
  const sendLead = useCallback(
    async (text: string) => {
      // 发进**父会话**：这条 run 是那条对话里的一件事，提炼保存这一轮也该落在那里。
      const ack = await sendCommand(
        createCommandEnvelope({
          type: "sendText",
          payload: { text },
          sessionId: tab.parentSessionId,
        }),
      );
      if (ack.status !== "accepted") {
        logger.warn("[workflow-run] 交给 ZCode 提炼保存的那条消息被拒", {
          reasonCode: ack.reasonCode ?? null,
          runId: tab.runId,
          status: ack.status,
        });
        // 抛回弹层：它据此留在原处、把按钮解回可点，而不是假装已经交出去了。
        throw new Error(ack.reasonCode ?? ack.status);
      }
    },
    [sendCommand, tab.parentSessionId, tab.runId],
  );
  return {
    workspacePath: tab.workspacePath,
    ...(tab.workspaceIdentity === undefined ? {} : { workspaceIdentity: tab.workspaceIdentity }),
    ...(tab.remoteSessionId === undefined ? {} : { remoteSessionId: tab.remoteSessionId }),
    runId: tab.runId,
    // 名字取 tab 上冻结的那个展示名：投影缺席（run 被淘汰 / 冷启动）时它是仅存来源。
    ...(tab.workflowName?.trim() ? { runName: tab.workflowName.trim() } : {}),
    ...(candidates === undefined ? {} : { candidates }),
    // 动词只给已完成的 run——「保存」说的是「这次跑完的东西值得留下」，还在跑的 run 没有这个
    // 结论可下。芯片不受这道门影响：它说的是磁盘上有没有那份文件。
    canSave: enabled && run?.status === "completed",
    sendLead,
    // 侧板状态头的按钮都带词（Configure / Resume / Stop），这一枚也一样。
    verbWord: "never",
  };
}
