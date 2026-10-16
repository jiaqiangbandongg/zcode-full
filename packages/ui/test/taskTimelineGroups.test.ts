import { describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { groupTaskTimelineItems, resolveTaskTimelineGroupKey } from "@/lib/taskTimelineGroups.js";

function localTimestamp(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  // 修复原因：timeline 分组按用户本地自然日/自然周计算；测试用本地时间构造，
  // 避免不同时区 runner 把 +08:00 样本归到相邻日期。
  return new Date(year, month - 1, day, hour, minute).getTime();
}

function createTask(taskId: string, createdAt: number, updatedAt = createdAt): ZCodeTaskMeta {
  return {
    taskId,
    traceId: `trace-${taskId}`,
    title: taskId,
    workspacePath: "/tmp/zcode-task-timeline",
    createdAt,
    updatedAt,
    mode: "default",
    provider: "codex",
  };
}

describe("taskTimelineGroups", () => {
  const now = localTimestamp(2026, 5, 21, 10, 0);

  it("优先按相对日、周、月生成 timeline 分组", () => {
    expect(
      resolveTaskTimelineGroupKey(localTimestamp(2026, 5, 21, 9, 0), now, "zh-CN"),
    ).toEqual({ kind: "today" });
    expect(
      resolveTaskTimelineGroupKey(localTimestamp(2026, 5, 20, 23, 59), now, "zh-CN"),
    ).toEqual({ kind: "yesterday" });
    expect(
      resolveTaskTimelineGroupKey(localTimestamp(2026, 5, 18, 8, 0), now, "zh-CN"),
    ).toEqual({ kind: "daysAgo", daysAgo: 3 });
    expect(
      resolveTaskTimelineGroupKey(localTimestamp(2026, 5, 17, 8, 0), now, "zh-CN"),
    ).toEqual({ kind: "lastWeek" });
    expect(
      resolveTaskTimelineGroupKey(localTimestamp(2026, 5, 1, 8, 0), now, "zh-CN"),
    ).toEqual({ kind: "thisMonth" });
    expect(
      resolveTaskTimelineGroupKey(localTimestamp(2026, 4, 30, 8, 0), now, "zh-CN"),
    ).toEqual({ kind: "lastMonth" });
    expect(
      resolveTaskTimelineGroupKey(localTimestamp(2026, 3, 31, 8, 0), now, "zh-CN"),
    ).toEqual({ kind: "older" });
  });

  it("按当前排序字段选择创建或更新时间分组", () => {
    const task = createTask(
      "task-1",
      localTimestamp(2026, 4, 30, 8, 0),
      localTimestamp(2026, 5, 21, 9, 0),
    );

    expect(
      groupTaskTimelineItems([task], {
        sortBy: "updated",
        now,
        locale: "zh-CN",
      })[0]?.key,
    ).toBe("today");
    expect(
      groupTaskTimelineItems([task], {
        sortBy: "created",
        now,
        locale: "zh-CN",
      })[0]?.key,
    ).toBe("lastMonth");
  });

  it("英文 locale 使用周日作为自然周起点", () => {
    expect(
      resolveTaskTimelineGroupKey(localTimestamp(2026, 5, 17, 8, 0), now, "en-US"),
    ).toEqual({ kind: "thisWeek" });
  });
});
