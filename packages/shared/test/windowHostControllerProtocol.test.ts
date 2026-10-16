import { describe, expect, it } from "vitest";
import {
  CONTROLLER_TASKS_INDEX_TOPIC,
  CONTROLLER_WORKSPACES_TOPIC,
  V4_METHODS,
  controllerSubscribeParamsSchema,
  isWindowHostControllerFrameGap,
  windowHostControllerTaskFrameSchema,
  windowHostControllerWorkspaceFrameSchema,
  windowHostTaskAddressSchema,
} from "../src/zcode-protocol-v4/index.js";

const remoteAddress = {
  remoteSessionId: "remote-session-1",
  workspacePath: "/work/demo",
  workspaceIdentity: "remote:ssh:dev:/work/demo",
  taskId: "task-1",
};

const remoteTask = {
  address: remoteAddress,
  meta: {
    taskId: "task-1",
    traceId: "trace-1",
    title: "Remote task",
    workspacePath: "/work/demo",
    workspaceIdentity: "remote:ssh:dev:/work/demo",
    createdAt: 1,
    updatedAt: 2,
    mode: "default" as const,
  },
  membership: {
    pinned: false,
    archived: false,
    active: true,
  },
  sourceAvailability: "online" as const,
  liveStatus: "running" as const,
  activity: {
    phase: "running" as const,
    lastActivityAt: 2,
    hasBackgroundWork: true,
    pendingInteractions: { permissionCount: 1, userInputCount: 0 },
  },
};

describe("R1 window Host Controller V4 protocol", () => {
  it("固定暴露两个窗口级 topic 和独立的 subscribe/resync/unsubscribe 方法", () => {
    expect(CONTROLLER_WORKSPACES_TOPIC).toBe("controller/workspaces");
    expect(CONTROLLER_TASKS_INDEX_TOPIC).toBe("controller/tasks-index");
    expect(V4_METHODS.controllerSubscribe).toBe("v4/controller/subscribe");
    expect(V4_METHODS.controllerResync).toBe("v4/controller/resync");
    expect(V4_METHODS.controllerUnsubscribe).toBe("v4/controller/unsubscribe");
  });

  it("subscribe 只接受 Controller topic，且调用方不能声明 clientMode", () => {
    expect(
      controllerSubscribeParamsSchema.safeParse({ topic: CONTROLLER_TASKS_INDEX_TOPIC }).success,
    ).toBe(true);
    expect(
      controllerSubscribeParamsSchema.safeParse({ topic: CONTROLLER_WORKSPACES_TOPIC }).success,
    ).toBe(true);
    expect(
      controllerSubscribeParamsSchema.safeParse({ topic: "sessions-index/workspace-1" }).success,
    ).toBe(false);
    expect(
      controllerSubscribeParamsSchema.safeParse({
        topic: CONTROLLER_TASKS_INDEX_TOPIC,
        clientMode: "web-remote-replayable",
      }).success,
    ).toBe(false);
  });

  it("remote task address 缺少 identity 时 fail-closed", () => {
    expect(windowHostTaskAddressSchema.safeParse(remoteAddress).success).toBe(true);
    expect(
      windowHostTaskAddressSchema.safeParse({
        remoteSessionId: "remote-session-1",
        workspacePath: "/work/demo",
        taskId: "task-1",
      }).success,
    ).toBe(false);
  });

  it("tasks-index snapshot 同时携带 seq 与 logEpoch，并拒绝 address/meta 串线", () => {
    const frame = {
      topic: CONTROLLER_TASKS_INDEX_TOPIC,
      subscriptionId: "subscription-1",
      logEpoch: "epoch-1",
      fromSeq: 0,
      toSeq: 7,
      sentAt: 10,
      payload: {
        kind: "snapshot" as const,
        snapshot: {
          protocolVersion: 1 as const,
          logEpoch: "epoch-1",
          tasks: [remoteTask],
        },
      },
    };

    expect(windowHostControllerTaskFrameSchema.safeParse(frame).success).toBe(true);
    expect(
      windowHostControllerTaskFrameSchema.safeParse({
        ...frame,
        payload: {
          kind: "snapshot",
          snapshot: {
            ...frame.payload.snapshot,
            tasks: [
              {
                ...remoteTask,
                activity: { ...remoteTask.activity, phase: "unknown" },
              },
            ],
          },
        },
      }).success,
    ).toBe(false);
    expect(
      windowHostControllerTaskFrameSchema.safeParse({
        ...frame,
        payload: {
          kind: "snapshot",
          snapshot: {
            ...frame.payload.snapshot,
            tasks: [
              {
                ...remoteTask,
                meta: { ...remoteTask.meta, taskId: "different-task" },
              },
            ],
          },
        },
      }).success,
    ).toBe(false);
  });

  it("workspaces snapshot 表达离线 source，但不携带 conversation/runtime payload", () => {
    const frame = {
      topic: CONTROLLER_WORKSPACES_TOPIC,
      subscriptionId: "subscription-workspaces-1",
      logEpoch: "workspace-epoch-1",
      fromSeq: 0,
      toSeq: 3,
      sentAt: 20,
      payload: {
        kind: "snapshot" as const,
        snapshot: {
          protocolVersion: 1 as const,
          logEpoch: "workspace-epoch-1",
          workspaces: [
            {
              remoteSessionId: "remote-session-1",
              workspacePath: "/work/demo",
              workspaceIdentity: "remote:ssh:dev:/work/demo",
              sourceAvailability: "offline" as const,
              connectionState: "disconnected" as const,
            },
          ],
        },
      },
    };

    expect(windowHostControllerWorkspaceFrameSchema.safeParse(frame).success).toBe(true);
    expect(
      windowHostControllerWorkspaceFrameSchema.safeParse({
        ...frame,
        payload: {
          kind: "snapshot",
          snapshot: {
            ...frame.payload.snapshot,
            runtimeSnapshot: { rows: [] },
          },
        },
      }).success,
    ).toBe(false);
  });

  it("按 subscription、logEpoch 和 fromSeq 检测 gap 并触发 resync", () => {
    const cursor = {
      subscriptionId: "subscription-1",
      logEpoch: "epoch-1",
      seq: 7,
    };

    expect(
      isWindowHostControllerFrameGap(cursor, {
        subscriptionId: "subscription-1",
        logEpoch: "epoch-1",
        fromSeq: 7,
      }),
    ).toBe(false);
    expect(
      isWindowHostControllerFrameGap(cursor, {
        subscriptionId: "subscription-1",
        logEpoch: "epoch-1",
        fromSeq: 9,
      }),
    ).toBe(true);
    expect(
      isWindowHostControllerFrameGap(cursor, {
        subscriptionId: "subscription-1",
        logEpoch: "epoch-2",
        fromSeq: 7,
      }),
    ).toBe(true);
    expect(
      isWindowHostControllerFrameGap(cursor, {
        subscriptionId: "subscription-2",
        logEpoch: "epoch-1",
        fromSeq: 7,
      }),
    ).toBe(true);
  });
});
