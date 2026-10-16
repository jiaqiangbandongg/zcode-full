// 批量轮的 originMeta 合成（docs/dynamic-workflow/transcript-and-notifications.md「The pipeline and cold restore」）。
//
// 单条通知：originMeta 整体透传，manifest 载荷（workflowNotification）免费搭车。
// 批量轮（多条通知合一轮、标题合成 `a · b · +N`）：**刻意丢弃** workflowNotification——
// 「一轮 ↔ 一张 manifest」的对应在批量下不成立，谎报第一条的载荷比整轮退回裸标题行更坏。
// 这个纪律用测试钉死，防止后续「顺手把载荷也合成过来」的回归。
import { describe, expect, it } from "vitest";
import { createRootTraceContext, createSessionId } from "@zcode/contracts";
import type { BackgroundResultOriginMeta } from "@zcode/contracts";
import { resolveBackgroundTaskNotificationOriginMeta } from "../src/runtime/methods/background-notifications.js";
import {
  createRuntimeCommandId,
  type TaskNotificationRuntimeCommand,
} from "../src/runtime/command-queue.js";

function makeCommand(originMeta?: BackgroundResultOriginMeta): TaskNotificationRuntimeCommand {
  return {
    branchGeneration: 0,
    createdAt: new Date(),
    id: createRuntimeCommandId(),
    mode: "task-notification",
    priority: "next",
    source: "background_task",
    text: "notification body",
    traceContext: createRootTraceContext({ sessionId: createSessionId("bg-notif-test") }),
    ...(originMeta ? { originMeta } : {}),
  };
}

const workflowOriginMeta: BackgroundResultOriginMeta = {
  backgroundSource: "workflow",
  title: "nightly audit",
  workId: "dwfrun-1",
  workflowNotification: {
    kind: "terminal",
    status: "completed",
    summary: "nightly audit",
    result: "done",
    resultForm: "prose",
  },
};

describe("resolveBackgroundTaskNotificationOriginMeta", () => {
  it("单条：originMeta 整体透传，manifest 载荷保留", () => {
    const resolved = resolveBackgroundTaskNotificationOriginMeta([makeCommand(workflowOriginMeta)]);
    expect(resolved).toEqual(workflowOriginMeta);
    expect(resolved?.workflowNotification).toBeDefined();
  });

  it("批量轮：合成 title，刻意丢弃 workflowNotification（退回三基字段）", () => {
    const resolved = resolveBackgroundTaskNotificationOriginMeta([
      makeCommand(workflowOriginMeta),
      makeCommand({
        backgroundSource: "workflow",
        title: "hourly sweep",
        workId: "dwfrun-2",
        workflowNotification: {
          kind: "escalation",
          qid: "dwfq-2",
          actor: "poet",
          question: "继续吗？",
        },
      }),
    ]);
    // 复用首个任务的展示锚点，title 合成 `a · b`。
    expect(resolved).toEqual({
      backgroundSource: "workflow",
      title: "nightly audit · hourly sweep",
      workId: "dwfrun-1",
    });
    // 载荷不得随批量轮搭车——「一轮一张 manifest」在批量下不成立。
    expect(resolved?.workflowNotification).toBeUndefined();
  });
});
