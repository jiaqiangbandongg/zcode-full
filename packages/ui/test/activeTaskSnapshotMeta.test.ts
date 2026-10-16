import { describe, expect, it } from "vitest";
import { resolveImmediateActiveTaskSnapshotMeta } from "@/hooks/useActiveTaskSnapshotMeta.js";

describe("resolveImmediateActiveTaskSnapshotMeta", () => {
  it("切到另一个 archive/pin task 且列表里还没有 meta 时，立即清空上一条任务的 snapshot", () => {
    expect(
      resolveImmediateActiveTaskSnapshotMeta(
        {
          taskId: "task-old",
          traceId: "trace-old",
          title: "旧任务标题",
          workspacePath: "/tmp/workspace",
          createdAt: 1,
          updatedAt: 1,
          mode: "default",
          provider: "claude",
        },
        "task-new",
        null,
      ),
    ).toBeNull();
  });

  it("同一个 task 重新请求 snapshot 时，允许暂时复用自己的旧 meta，避免无谓闪烁", () => {
    expect(
      resolveImmediateActiveTaskSnapshotMeta(
        {
          taskId: "task-same",
          traceId: "trace-same",
          title: "当前任务标题",
          workspacePath: "/tmp/workspace",
          createdAt: 1,
          updatedAt: 1,
          mode: "default",
          provider: "claude",
        },
        "task-same",
        null,
      ),
    ).toMatchObject({
      taskId: "task-same",
      title: "当前任务标题",
    });
  });

  it("列表里已经拿到当前任务 meta 时，不再依赖 snapshot 兜底", () => {
    expect(
      resolveImmediateActiveTaskSnapshotMeta(
        {
          taskId: "task-same",
          traceId: "trace-same",
          title: "旧 snapshot 标题",
          workspacePath: "/tmp/workspace",
          createdAt: 1,
          updatedAt: 1,
          mode: "default",
          provider: "claude",
        },
        "task-same",
        {
          taskId: "task-same",
          traceId: "trace-same",
          title: "列表标题",
          workspacePath: "/tmp/workspace",
          createdAt: 1,
          updatedAt: 2,
          mode: "default",
          provider: "claude",
        },
      ),
    ).toBeNull();
  });
});
