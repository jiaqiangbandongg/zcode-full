import { describe, expect, it, vi } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import {
  CONTROLLER_TASKS_INDEX_TOPIC,
  CONTROLLER_WORKSPACES_TOPIC,
} from "@zcode/shared/zcode-protocol-v4";
import { createWindowHostControllerProjection } from "../src/host/windowHostControllerProjection.js";

function taskMeta(params: {
  taskId: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  title?: string;
  updatedAt?: number;
}): ZCodeTaskMeta {
  return {
    taskId: params.taskId,
    traceId: `trace-${params.taskId}`,
    title: params.title ?? params.taskId,
    workspacePath: params.workspacePath ?? "/work/demo",
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    createdAt: 1,
    updatedAt: params.updatedAt ?? 2,
    mode: "default",
  };
}

const localScope = {
  kind: "local" as const,
  workspacePath: "/work/demo",
};

const remoteScope = {
  kind: "remote" as const,
  remoteSessionId: "remote-session-1",
  workspacePath: "/work/demo",
  workspaceIdentity: "remote:ssh:dev:/work/demo",
};

describe("WindowHostControllerProjection", () => {
  it("task-index 是 membership 左表，sessions-index 只能覆盖已有 task 的 live facts", () => {
    const projection = createWindowHostControllerProjection({ createId: () => "id-1" });
    projection.registerSource({ scope: localScope, mutate: vi.fn() });

    projection.replaceSourceSnapshot({
      scope: localScope,
      taskIndex: [
        {
          meta: taskMeta({ taskId: "task-indexed" }),
          membership: { pinned: false, archived: false, active: true },
        },
      ],
      sessionsIndex: [
        { taskId: "task-indexed", liveStatus: "waiting" },
        { taskId: "session-only", liveStatus: "running" },
      ],
    });

    expect(projection.getTasks()).toEqual([
      expect.objectContaining({
        address: expect.objectContaining({ taskId: "task-indexed" }),
        liveStatus: "waiting",
      }),
    ]);
  });

  it("没有 live overlay 时不把持久化 running/阻塞残留当作当前运行事实", () => {
    const projection = createWindowHostControllerProjection({ createId: () => "id-1" });
    projection.registerSource({ scope: localScope, mutate: vi.fn() });
    projection.replaceSourceSnapshot({
      scope: localScope,
      taskIndex: [
        {
          meta: {
            ...taskMeta({ taskId: "waiting-task" }),
            status: "running",
            pendingInteraction: { interactionId: "ask-1", kind: "userInput" },
          },
          membership: { pinned: false, archived: false, active: true },
        },
      ],
      sessionsIndex: [],
    });

    expect(projection.getTasks()[0]?.liveStatus).toBe("idle");
  });

  it("运行时 overlay 可独立更新 activity/阻塞交互，且不会把 live facts 写回 membership", () => {
    const projection = createWindowHostControllerProjection({ createId: () => "id-1" });
    const frames: unknown[] = [];
    projection.registerSource({ scope: localScope, mutate: vi.fn() });
    projection.replaceSourceSnapshot({
      scope: localScope,
      taskIndex: [
        {
          meta: taskMeta({ taskId: "live-task", title: "持久标题", updatedAt: 2 }),
          membership: { pinned: false, archived: false, active: true },
        },
      ],
      sessionsIndex: [
        {
          taskId: "live-task",
          title: "运行标题",
          updatedAt: 8,
          liveStatus: "waiting",
          pendingInteraction: {
            interactionId: "permission-1",
            kind: "permission",
            toolName: "Bash",
          },
          activity: {
            phase: "running",
            lastActivityAt: 8,
            hasBackgroundWork: true,
            pendingInteractions: { permissionCount: 1, userInputCount: 0 },
          },
        },
      ],
    });
    projection.subscribe({
      topic: CONTROLLER_TASKS_INDEX_TOPIC,
      onFrame: (frame) => frames.push(frame),
    });
    frames.length = 0;

    expect(projection.getTasks()[0]).toMatchObject({
      liveStatus: "waiting",
      activity: {
        phase: "running",
        lastActivityAt: 8,
        pendingInteractions: { permissionCount: 1, userInputCount: 0 },
      },
      meta: {
        title: "运行标题",
        updatedAt: 8,
        pendingInteraction: { interactionId: "permission-1", kind: "permission" },
      },
    });

    projection.replaceSourceSessionOverlays(localScope, [
      {
        taskId: "live-task",
        title: "完成标题",
        updatedAt: 12,
        liveStatus: "completed",
        activity: {
          phase: "completedSuccess",
          lastActivityAt: 12,
          hasBackgroundWork: false,
        },
      },
    ]);

    expect(projection.getTasks()[0]).toMatchObject({
      liveStatus: "completed",
      activity: {
        phase: "completedSuccess",
        lastActivityAt: 12,
        hasBackgroundWork: false,
      },
      meta: { title: "完成标题", updatedAt: 12 },
    });
    expect(projection.getTasks()[0]?.meta.pendingInteraction).toBeUndefined();
    expect(frames).toHaveLength(1);
  });

  it("同路径 local 与 remote identity 的 task 不串行", () => {
    const projection = createWindowHostControllerProjection({ createId: () => "id-1" });
    projection.registerSource({ scope: localScope, mutate: vi.fn() });
    projection.registerSource({ scope: remoteScope, mutate: vi.fn() });
    projection.replaceSourceSnapshot({
      scope: localScope,
      taskIndex: [
        {
          meta: taskMeta({ taskId: "same-task" }),
          membership: { pinned: false, archived: false, active: true },
        },
      ],
      sessionsIndex: [],
    });
    projection.replaceSourceSnapshot({
      scope: remoteScope,
      taskIndex: [
        {
          meta: taskMeta({
            taskId: "same-task",
            workspaceIdentity: remoteScope.workspaceIdentity,
          }),
          membership: { pinned: true, archived: false, active: true },
        },
      ],
      sessionsIndex: [{ taskId: "same-task", liveStatus: "running" }],
    });

    expect(projection.getTasks()).toHaveLength(2);
    expect(
      projection.getTasks().find((task) => task.address.remoteSessionId)?.membership.pinned,
    ).toBe(true);
    expect(projection.getTasks().find((task) => !task.address.remoteSessionId)?.liveStatus).toBe(
      "idle",
    );
  });

  it("断连保留最后可信 rows 并标 offline，所有 mutation fail-closed", async () => {
    const localMutate = vi.fn();
    const remoteMutate = vi.fn();
    const projection = createWindowHostControllerProjection({ createId: () => "id-1" });
    projection.registerSource({ scope: localScope, mutate: localMutate });
    projection.registerSource({ scope: remoteScope, mutate: remoteMutate });
    projection.replaceSourceSnapshot({
      scope: remoteScope,
      taskIndex: [
        {
          meta: taskMeta({
            taskId: "remote-task",
            workspaceIdentity: remoteScope.workspaceIdentity,
          }),
          membership: { pinned: false, archived: false, active: true },
        },
      ],
      sessionsIndex: [{ taskId: "remote-task", liveStatus: "running" }],
    });

    projection.disconnectSource(remoteScope);
    const row = projection.getTasks()[0]!;

    expect(row).toMatchObject({ sourceAvailability: "offline", liveStatus: "running" });
    await expect(projection.mutate(row.address, { kind: "pin", pinned: true })).rejects.toThrow(
      "远程 source 当前离线",
    );
    expect(remoteMutate).not.toHaveBeenCalled();
    expect(localMutate).not.toHaveBeenCalled();
  });

  it("重连 snapshot 原子替换离线投影，不混入旧 task", () => {
    const projection = createWindowHostControllerProjection({ createId: () => "id-1" });
    projection.registerSource({ scope: remoteScope, mutate: vi.fn() });
    projection.replaceSourceSnapshot({
      scope: remoteScope,
      taskIndex: [
        {
          meta: taskMeta({ taskId: "old-task", workspaceIdentity: remoteScope.workspaceIdentity }),
          membership: { pinned: false, archived: false, active: true },
        },
      ],
      sessionsIndex: [],
    });
    projection.disconnectSource(remoteScope);

    projection.replaceSourceSnapshot({
      scope: remoteScope,
      taskIndex: [
        {
          meta: taskMeta({ taskId: "new-task", workspaceIdentity: remoteScope.workspaceIdentity }),
          membership: { pinned: false, archived: false, active: true },
        },
      ],
      sessionsIndex: [],
    });

    expect(projection.getTasks().map((task) => task.address.taskId)).toEqual(["new-task"]);
    expect(projection.getTasks()[0]?.sourceAvailability).toBe("online");
  });

  it("remoteSessionId 换代时在同一个 delta frame 移除旧地址并写入新 snapshot", () => {
    const projection = createWindowHostControllerProjection({ createId: () => "id-1" });
    const nextScope = { ...remoteScope, remoteSessionId: "remote-session-2" };
    const frames: Array<{ payload: { kind: string; deltas?: Array<{ op: string }> } }> = [];
    projection.registerSource({ scope: remoteScope, mutate: vi.fn() });
    projection.replaceSourceSnapshot({
      scope: remoteScope,
      taskIndex: [
        {
          meta: taskMeta({ taskId: "old-task", workspaceIdentity: remoteScope.workspaceIdentity }),
          membership: { pinned: false, archived: false, active: true },
        },
      ],
      sessionsIndex: [],
    });
    projection.disconnectSource(remoteScope);
    projection.registerSource({ scope: nextScope, mutate: vi.fn() });
    projection.subscribe({
      topic: CONTROLLER_TASKS_INDEX_TOPIC,
      onFrame: (frame) => frames.push(frame as (typeof frames)[number]),
    });
    frames.length = 0;

    projection.replaceSourceSnapshot({
      scope: nextScope,
      replacesScope: remoteScope,
      taskIndex: [
        {
          meta: taskMeta({ taskId: "new-task", workspaceIdentity: remoteScope.workspaceIdentity }),
          membership: { pinned: false, archived: false, active: true },
        },
      ],
      sessionsIndex: [],
    });

    expect(frames).toHaveLength(1);
    expect(frames[0]?.payload.deltas?.map((delta) => delta.op)).toEqual([
      "task.removed",
      "task.upserted",
    ]);
    expect(projection.getTasks()).toEqual([
      expect.objectContaining({
        address: expect.objectContaining({
          remoteSessionId: "remote-session-2",
          taskId: "new-task",
        }),
      }),
    ]);
  });

  it("关闭 remote scope 清理其内存投影，Grouped facts 始终只返回 local", () => {
    const projection = createWindowHostControllerProjection({ createId: () => "id-1" });
    projection.registerSource({ scope: localScope, mutate: vi.fn() });
    projection.registerSource({ scope: remoteScope, mutate: vi.fn() });
    projection.replaceSourceSnapshot({
      scope: localScope,
      taskIndex: [
        {
          meta: taskMeta({ taskId: "local-task" }),
          membership: { pinned: false, archived: false, active: true },
        },
      ],
      sessionsIndex: [],
    });
    projection.replaceSourceSnapshot({
      scope: remoteScope,
      taskIndex: [
        {
          meta: taskMeta({
            taskId: "remote-task",
            workspaceIdentity: remoteScope.workspaceIdentity,
          }),
          membership: { pinned: false, archived: false, active: true },
        },
      ],
      sessionsIndex: [],
    });

    expect(projection.getGroupedTaskFacts().map((task) => task.address.taskId)).toEqual([
      "local-task",
    ]);
    projection.removeSource(remoteScope);
    expect(projection.getTasks().map((task) => task.address.taskId)).toEqual(["local-task"]);
  });

  it("列表 mutation 根据完整 address 路由唯一 source，identity mismatch 不回落", async () => {
    const localMutate = vi.fn(async () => undefined);
    const remoteMutate = vi.fn(async () => undefined);
    const projection = createWindowHostControllerProjection({ createId: () => "id-1" });
    projection.registerSource({ scope: localScope, mutate: localMutate });
    projection.registerSource({ scope: remoteScope, mutate: remoteMutate });
    projection.replaceSourceSnapshot({
      scope: remoteScope,
      taskIndex: [
        {
          meta: taskMeta({
            taskId: "remote-task",
            workspaceIdentity: remoteScope.workspaceIdentity,
          }),
          membership: { pinned: false, archived: false, active: true },
        },
      ],
      sessionsIndex: [],
    });
    const address = projection.getTasks()[0]!.address;

    await projection.mutate(address, { kind: "archive", archived: true });
    expect(remoteMutate).toHaveBeenCalledWith(address, { kind: "archive", archived: true });
    expect(localMutate).not.toHaveBeenCalled();
    await expect(
      projection.mutate(
        { ...address, workspaceIdentity: "remote:ssh:wrong:/work/demo" },
        { kind: "archive", archived: true },
      ),
    ).rejects.toThrow("没有与任务地址匹配的 source");
    expect(localMutate).not.toHaveBeenCalled();
  });

  it("两个 topic 都产生 snapshot/delta seq + logEpoch，订阅彼此独立", () => {
    let id = 0;
    const projection = createWindowHostControllerProjection({ createId: () => `id-${++id}` });
    const taskFrames: unknown[] = [];
    const workspaceFrames: unknown[] = [];
    const tasksSubscription = projection.subscribe({
      topic: CONTROLLER_TASKS_INDEX_TOPIC,
      onFrame: (frame) => taskFrames.push(frame),
    });
    projection.subscribe({
      topic: CONTROLLER_WORKSPACES_TOPIC,
      onFrame: (frame) => workspaceFrames.push(frame),
    });

    projection.registerSource({ scope: localScope, mutate: vi.fn() });
    projection.replaceSourceSnapshot({
      scope: localScope,
      taskIndex: [
        {
          meta: taskMeta({ taskId: "local-task" }),
          membership: { pinned: false, archived: false, active: true },
        },
      ],
      sessionsIndex: [],
    });

    expect(taskFrames).toEqual([
      expect.objectContaining({
        topic: CONTROLLER_TASKS_INDEX_TOPIC,
        fromSeq: 0,
        logEpoch: expect.any(String),
        payload: expect.objectContaining({ kind: "snapshot" }),
      }),
      expect.objectContaining({
        topic: CONTROLLER_TASKS_INDEX_TOPIC,
        fromSeq: 0,
        toSeq: 1,
        payload: expect.objectContaining({ kind: "deltas" }),
      }),
    ]);
    expect(workspaceFrames).toHaveLength(2);
    expect(tasksSubscription.ack.subscriptionId).not.toBe(
      (workspaceFrames[0] as { subscriptionId: string }).subscriptionId,
    );

    projection.replaceSourceSnapshot({
      scope: localScope,
      taskIndex: [
        {
          meta: taskMeta({ taskId: "local-task" }),
          membership: { pinned: false, archived: false, active: true },
        },
      ],
      sessionsIndex: [],
    });
    expect(taskFrames).toHaveLength(2);
    expect(workspaceFrames).toHaveLength(2);
  });
});
