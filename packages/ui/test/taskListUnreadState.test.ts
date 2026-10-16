import { describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { TaskListRowActivity } from "@/v4/taskListRowActivity.js";
import { deriveTaskLeadingIndicator } from "../src/TaskList.js";

function createTaskMeta(overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId: "task-1",
    traceId: "trace-1",
    title: "排查未读状态",
    workspacePath: "/tmp/workspace-task-list",
    createdAt: 1,
    updatedAt: 1,
    mode: "default",
    provider: "codex",
    ...overrides,
  };
}

function activity(phase: TaskListRowActivity["phase"]): TaskListRowActivity {
  return {
    phase,
    lastActivityAt: 10,
    hasBackgroundWork: false,
  };
}

describe("deriveTaskLeadingIndicator", () => {
  it("sessions-index error 优先级最高，显示红点", () => {
    expect(
      deriveTaskLeadingIndicator(
        createTaskMeta({ unreadAt: 123 }),
        activity("error"),
      ),
    ).toBe("error");
  });

  it("没有 activity sidecar 的历史失败 task 会回退显示红点", () => {
    expect(
      deriveTaskLeadingIndicator(createTaskMeta({ status: "error" }), null),
    ).toBe("error");
  });

  it("新的 running activity 可以替换旧 persisted error", () => {
    expect(
      deriveTaskLeadingIndicator(
        createTaskMeta({ status: "error" }),
        activity("running"),
      ),
    ).toBe("loading");
  });

  it("task meta 自身带 unreadAt 时显示蓝点", () => {
    expect(
      deriveTaskLeadingIndicator(
        createTaskMeta({ unreadAt: 123 }),
        activity("completedSuccess"),
      ),
    ).toBe("unread");
  });

  it("蓝点优先级高于 running", () => {
    expect(
      deriveTaskLeadingIndicator(
        createTaskMeta({ unreadAt: 123 }),
        activity("running"),
      ),
    ).toBe("unread");
  });

  it.each(["prewarming", "running"] as const)(
    "%s 任务显示 loading",
    (phase) => {
      expect(
        deriveTaskLeadingIndicator(createTaskMeta(), activity(phase)),
      ).toBe("loading");
    },
  );

  it("仅持久化为 running 的历史任务不显示 loading", () => {
    expect(
      deriveTaskLeadingIndicator(createTaskMeta({ status: "running" }), null),
    ).toBe("none");
  });

  it("终态 activity 既不未读也不运行时不显示前缀指示", () => {
    expect(
      deriveTaskLeadingIndicator(
        createTaskMeta(),
        activity("completedInterrupted"),
      ),
    ).toBe("none");
  });
});
