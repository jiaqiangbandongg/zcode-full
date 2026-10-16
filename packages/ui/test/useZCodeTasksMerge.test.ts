import { describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import {
  mergeTaskMetaCandidates,
  mergeTaskWithOptimisticMeta,
} from "@/lib/zcodeTaskMetaMerge.js";

function createTaskMeta(overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId: "task-merge",
    traceId: "trace-merge",
    title: "测试任务",
    workspacePath: "/repo/workspace",
    createdAt: 1,
    updatedAt: 1,
    mode: "default",
    provider: "codex",
    ...overrides,
  };
}

describe("mergeTaskWithOptimisticMeta", () => {
  it("会保留 optimistic 里的 unread 状态，避免重刷列表后蓝点闪回", () => {
    const persistedTask = createTaskMeta({
      updatedAt: 20,
      title: "服务端标题",
    });
    const optimisticTask = createTaskMeta({
      updatedAt: 10,
      title: "服务端标题",
      unreadAt: 789,
    });

    expect(mergeTaskWithOptimisticMeta(persistedTask, optimisticTask).unreadAt).toBe(789);
  });

  it("会保留持久化 status，避免乐观元数据覆盖后丢失运行态", () => {
    const persistedTask = createTaskMeta({
      updatedAt: 20,
      status: "running",
    });
    const optimisticTask = createTaskMeta({
      updatedAt: 21,
      title: "前端乐观标题",
      status: undefined,
    });

    expect(mergeTaskWithOptimisticMeta(persistedTask, optimisticTask).status).toBe("running");
  });

  it("不会让较新的 New session 占位标题覆盖首条用户 query", () => {
    const persistedTask = createTaskMeta({
      updatedAt: 30,
      title: "New session",
      status: "running",
    });
    const optimisticTask = createTaskMeta({
      updatedAt: 20,
      title: "发现个问题，发送完消息后",
      status: "running",
    });

    expect(mergeTaskWithOptimisticMeta(persistedTask, optimisticTask).title).toBe(
      "发现个问题，发送完消息后",
    );
  });

  it("仍允许 generated title 覆盖首条用户 query", () => {
    const persistedTask = createTaskMeta({
      updatedAt: 40,
      title: "修复会话标题闪烁",
      status: "completed",
    });
    const optimisticTask = createTaskMeta({
      updatedAt: 20,
      title: "发现个问题，发送完消息后",
      status: "running",
    });

    expect(mergeTaskWithOptimisticMeta(persistedTask, optimisticTask).title).toBe(
      "修复会话标题闪烁",
    );
  });

  it("会让手动重命名标题高于更新的 raw snapshot 标题", () => {
    const indexedRenamedTask = createTaskMeta({
      title: "airline-1",
      titleOverridden: true,
      updatedAt: 20,
    });
    const rawSnapshotTask = createTaskMeta({
      title: "Analyze airline import flow",
      updatedAt: 30,
    });

    expect(
      mergeTaskMetaCandidates(rawSnapshotTask, indexedRenamedTask),
    ).toMatchObject({
      title: "airline-1",
      titleOverridden: true,
      updatedAt: 30,
    });
  });
});
