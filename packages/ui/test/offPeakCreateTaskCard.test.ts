import { describe, expect, it } from "vitest";
import {
  describeOffPeakCardStatus,
  readOffPeakCreateTaskOutputSummary,
} from "@/ToolCallBlocks/renderers/offpeak-create.js";
import { resolveOffPeakDetailNavigation } from "@/settings/AutomationsSection.js";
import type { ZCodeOffPeakTask } from "@zcode/shared";

const intl = {
  formatMessage: (
    { id }: { id: string },
    values?: Record<string, string | number>,
  ) => (id === "offPeak.chatCreated.queuedAt" ? `排队第 ${values?.["position"]} 位` : id),
};

describe("OffPeakCreateTaskCard output（D49-6 静态轮尾卡）", () => {
  it("从工具输出解析最小任务快照（含 JSON 字符串候选）", () => {
    const task = readOffPeakCreateTaskOutputSummary(
      JSON.stringify({
        task: {
          offPeakTaskId: "offpeak-abc",
          title: "重构 utils",
          status: "queued",
          queuePosition: 3,
          createdAt: 1_700_000_000_000,
        },
        message: "Created idle-time task offpeak-abc (#3 in queue).",
      }),
    );

    expect(task).toMatchObject({
      offPeakTaskId: "offpeak-abc",
      title: "重构 utils",
      status: "queued",
      queuePosition: 3,
    });
  });

  it("缺 offPeakTaskId 视为无效输出（卡片必须能定位任务）", () => {
    expect(
      readOffPeakCreateTaskOutputSummary({ task: { title: "无 id", status: "queued" } }),
    ).toBeNull();
  });

  it("状态行：有位次显示创建时快照，无位次回退排队文案", () => {
    expect(
      describeOffPeakCardStatus({ offPeakTaskId: "offpeak-1", queuePosition: 3 }, intl),
    ).toBe("排队第 3 位");
    expect(describeOffPeakCardStatus({ offPeakTaskId: "offpeak-1" }, intl)).toBe(
      "offPeak.chatCreated.queued",
    );
  });
});

describe("resolveOffPeakDetailNavigation（卡片跳转 idle tab 编辑视图）", () => {
  const task = { offPeakTaskId: "offpeak-abc", title: "t" } as ZCodeOffPeakTask;

  it("store 加载中保持 pending（不消费导航、不误报 targetNotFound）", () => {
    expect(resolveOffPeakDetailNavigation([task], "offpeak-abc", false)).toEqual({
      status: "pending",
    });
  });

  it("命中返回 found 目标", () => {
    expect(resolveOffPeakDetailNavigation([task], "offpeak-abc", true)).toEqual({
      status: "found",
      target: task,
    });
  });

  it("任务已删除返回 missing", () => {
    expect(resolveOffPeakDetailNavigation([task], "offpeak-gone", true)).toEqual({
      status: "missing",
    });
  });

  it("刷新失败（store.error 非空）时返回 unavailable，不做 found/missing 终审（review CR-01）", () => {
    expect(resolveOffPeakDetailNavigation([], "offpeak-abc", true, "list failed")).toEqual({
      status: "unavailable",
    });
    // 就绪信号未到时仍 pending，error 不提前终审。
    expect(resolveOffPeakDetailNavigation([], "offpeak-abc", false, "list failed")).toEqual({
      status: "pending",
    });
  });
});
