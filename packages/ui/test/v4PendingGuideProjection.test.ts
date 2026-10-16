import { describe, expect, it } from "vitest";
import type { QueueItem, QueueState } from "@zcode/shared/zcode-protocol-v4";
import { projectPendingGuideQueue } from "@/v4/pendingGuideProjection.js";

function queueItem(
  queueItemId: string,
  admitted: "queue" | "guide",
  steerState: QueueItem["steer"]["state"] = admitted === "guide"
    ? "steering"
    : "notRequested",
): QueueItem {
  return {
    sourceCommandId: `command-${queueItemId}`,
    queueItemId,
    clientId: "desktop",
    kind: "sendText",
    text: `text-${queueItemId}`,
    attachments: [],
    delivery: { requested: admitted, admitted },
    order: {
      admissionSeq: Number(queueItemId.replace(/\D/gu, "")) || 0,
      queuePosition: 0,
    },
    steer: { state: steerState },
    dispatch: { state: "queued" },
    admittedAt: 100,
  };
}

describe("projectPendingGuideQueue", () => {
  it("把等待注入的 guide 投影到对话流，并从普通队列中排除", () => {
    const queue: QueueState = {
      autoDrain: true,
      items: [queueItem("1", "queue"), queueItem("2", "guide")],
    };

    const projection = projectPendingGuideQueue(queue);

    expect(projection.pendingGuides.map((item) => item.queueItemId)).toEqual([
      "2",
    ]);
    expect(
      projection.visibleQueue.items.map((item) => item.queueItemId),
    ).toEqual(["1"]);
  });

  it("guide 降级为 queue 后只回到普通队列", () => {
    const fallback = queueItem("2", "queue", "fellBack");
    fallback.delivery = {
      requested: "guide",
      admitted: "queue",
      fallbackReasonCode: "guide.queueNotEmpty",
    };

    const projection = projectPendingGuideQueue({
      autoDrain: true,
      items: [fallback],
    });

    expect(projection.pendingGuides).toEqual([]);
    expect(projection.visibleQueue.items).toEqual([fallback]);
  });

  it("保持 guide 的 admission FIFO 顺序", () => {
    const projection = projectPendingGuideQueue({
      autoDrain: true,
      items: [queueItem("3", "guide"), queueItem("4", "guide")],
    });

    expect(
      projection.pendingGuides.map((item) => item.sourceCommandId),
    ).toEqual(["command-3", "command-4"]);
  });
});
