import { describe, expect, it } from "vitest";
import type { ZCodeTaskMeta, ZCodeWorkspaceTaskListChanged } from "@zcode/shared";
import {
  getTaskMetaWorkspaceEventSyncMode,
  isTaskListMembershipWorkspaceEvent,
  shouldApplyTaskMetaFromWorkspaceEvent,
  shouldRefetchTaskListMembershipForWorkspaceEvent,
  shouldRefreshTaskListForWorkspaceEvent,
} from "@/lib/taskListRefreshPolicy.js";

function createEvent(reason: ZCodeWorkspaceTaskListChanged["reason"]) {
  return { reason };
}

function createTaskMeta(overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId: "task-1",
    traceId: "trace-1",
    title: "Task 1",
    workspacePath: "/repo/demo",
    createdAt: 1,
    updatedAt: 2,
    mode: "default",
    provider: "codex",
    ...overrides,
  };
}

describe("taskListRefreshPolicy", () => {
  it("普通 meta 和自动归档事件不触发整表刷新", () => {
    expect(shouldRefreshTaskListForWorkspaceEvent(createEvent("task_meta_changed"))).toBe(false);
    expect(shouldRefreshTaskListForWorkspaceEvent(createEvent("auto_archive"))).toBe(false);
  });

  it("跨端 task membership 事件有 taskMeta 时由增量缓存更新承接", () => {
    const taskMeta = createTaskMeta();

    expect(shouldRefreshTaskListForWorkspaceEvent({
      ...createEvent("task_archived"),
      taskMeta,
    })).toBe(false);
    expect(shouldRefreshTaskListForWorkspaceEvent({
      ...createEvent("task_unarchived"),
      taskMeta,
    })).toBe(false);
    expect(shouldRefreshTaskListForWorkspaceEvent({
      ...createEvent("task_pinned"),
      taskMeta,
    })).toBe(false);
    expect(shouldRefreshTaskListForWorkspaceEvent({
      ...createEvent("task_unpinned"),
      taskMeta,
    })).toBe(false);
    expect(isTaskListMembershipWorkspaceEvent(createEvent("task_archived"))).toBe(true);
    expect(isTaskListMembershipWorkspaceEvent(createEvent("task_meta_changed"))).toBe(false);
  });

  it("旧 membership 事件缺少 taskMeta 时保留刷新兜底", () => {
    expect(shouldRefreshTaskListForWorkspaceEvent(createEvent("task_archived"))).toBe(true);
    expect(shouldRefreshTaskListForWorkspaceEvent(createEvent("task_unarchived"))).toBe(true);
  });

  it("跨设备创建、消息和状态事件缺少 taskMeta 时仍允许静默刷新任务列表状态", () => {
    expect(shouldRefreshTaskListForWorkspaceEvent(createEvent("task_created"))).toBe(true);
    expect(shouldRefreshTaskListForWorkspaceEvent(createEvent("user_message_saved"))).toBe(true);
    expect(shouldRefreshTaskListForWorkspaceEvent(createEvent("assistant_message_saved"))).toBe(true);
    expect(shouldRefreshTaskListForWorkspaceEvent(createEvent("task_status_changed"))).toBe(true);
  });

  it("跨设备消息和状态事件带 taskMeta 时由增量缓存更新承接", () => {
    const taskMeta = createTaskMeta({ status: "running" });

    expect(shouldRefreshTaskListForWorkspaceEvent({
      ...createEvent("user_message_saved"),
      taskMeta,
    })).toBe(false);
    expect(shouldRefreshTaskListForWorkspaceEvent({
      ...createEvent("assistant_message_saved"),
      taskMeta: createTaskMeta({ status: "completed" }),
    })).toBe(false);
    expect(shouldRefreshTaskListForWorkspaceEvent({
      ...createEvent("task_status_changed"),
      taskMeta: createTaskMeta({ status: "error" }),
    })).toBe(false);
  });

  it("带 taskMeta 的 task_meta_changed 事件也由增量缓存更新承接", () => {
    const event = {
      ...createEvent("task_meta_changed"),
      taskMeta: createTaskMeta({ status: "running" }),
    };

    expect(shouldApplyTaskMetaFromWorkspaceEvent(event)).toBe(true);
    expect(getTaskMetaWorkspaceEventSyncMode(event)).toBe("preserve-membership");
    expect(shouldRefreshTaskListForWorkspaceEvent(event)).toBe(false);
  });

  it("带 taskMeta 的 task_created 事件按 active 成员关系插入缓存", () => {
    const event = {
      ...createEvent("task_created"),
      taskMeta: createTaskMeta({ status: "running" }),
    };

    expect(shouldApplyTaskMetaFromWorkspaceEvent(event)).toBe(true);
    expect(getTaskMetaWorkspaceEventSyncMode(event)).toBe("insert-active");
    expect(shouldRefreshTaskListForWorkspaceEvent(event)).toBe(false);
  });

  it("删除事件保留刷新兜底，避免隐藏项删除后 total 长期错误", () => {
    expect(shouldRefreshTaskListForWorkspaceEvent({
      ...createEvent("task_deleted"),
      taskId: "task-1",
    })).toBe(true);
    expect(shouldRefreshTaskListForWorkspaceEvent(createEvent("task_deleted"))).toBe(true);
  });

  it("缺少明确缓存链路的事件仍允许刷新", () => {
    expect(shouldRefreshTaskListForWorkspaceEvent(createEvent("stream_mirror_gap"))).toBe(true);
    expect(shouldRefreshTaskListForWorkspaceEvent(createEvent("stream_mirror_owner_lost"))).toBe(true);
  });

  // M5 ③：unread（setTaskUnread → task_meta_changed）与 pin/archive 同为 tasks-index 组织态，
  // task_created/deleted 还会改变正向/负向行集合；均按 membershipVersion 重拉，session detail 另行更新。
  it("归属重拉信号涵盖 created、membership、deleted 与 task_meta_changed", () => {
    expect(
      shouldRefetchTaskListMembershipForWorkspaceEvent(createEvent("task_created")),
    ).toBe(true);
    expect(
      shouldRefetchTaskListMembershipForWorkspaceEvent(createEvent("task_pinned")),
    ).toBe(true);
    expect(
      shouldRefetchTaskListMembershipForWorkspaceEvent(createEvent("task_archived")),
    ).toBe(true);
    expect(
      shouldRefetchTaskListMembershipForWorkspaceEvent(createEvent("task_meta_changed")),
    ).toBe(true);
    expect(
      shouldRefetchTaskListMembershipForWorkspaceEvent(createEvent("task_deleted")),
    ).toBe(true);
    expect(
      shouldRefetchTaskListMembershipForWorkspaceEvent(createEvent("user_message_saved")),
    ).toBe(false);
    expect(
      shouldRefetchTaskListMembershipForWorkspaceEvent(createEvent("task_status_changed")),
    ).toBe(false);
  });

  // 语义矩阵（docs/task-list-refresh-semantics.md）：与归属无关的高频 reason
  // 绝不允许触发整表刷新或 membership 重拉——这是"输入框操作/任务收口/打开任务
  // 引发左侧列表整刷"一系列缺陷的守护线，语义漂移必须在这里被拦住。
  it("task_model_changed（切模型）只做增量 meta 回写，不整刷不重拉", () => {
    const event = {
      ...createEvent("task_model_changed"),
      taskMeta: createTaskMeta({ model: "provider/model-b" }),
    };
    expect(getTaskMetaWorkspaceEventSyncMode(event)).toBe("preserve-membership");
    expect(shouldApplyTaskMetaFromWorkspaceEvent(event)).toBe(true);
    expect(shouldRefreshTaskListForWorkspaceEvent(event)).toBe(false);
    expect(shouldRefetchTaskListMembershipForWorkspaceEvent(event)).toBe(false);
    // 无 meta 时（异常路径）也不得升级成整表刷新。
    expect(
      shouldRefreshTaskListForWorkspaceEvent(createEvent("task_model_changed")),
    ).toBe(false);
  });

  it("task_title_changed（首发/自动标题/重命名）只做增量 meta 回写，不整刷不重拉", () => {
    const event = {
      ...createEvent("task_title_changed"),
      taskMeta: createTaskMeta({ title: "新标题" }),
    };
    expect(getTaskMetaWorkspaceEventSyncMode(event)).toBe("preserve-membership");
    expect(shouldApplyTaskMetaFromWorkspaceEvent(event)).toBe(true);
    expect(shouldRefreshTaskListForWorkspaceEvent(event)).toBe(false);
    expect(shouldRefetchTaskListMembershipForWorkspaceEvent(event)).toBe(false);
    expect(
      shouldRefreshTaskListForWorkspaceEvent(createEvent("task_title_changed")),
    ).toBe(false);
  });

  it("task_status_changed（收口/回源/打开任务）带 meta 增量回写，且不重拉归属", () => {
    const event = {
      ...createEvent("task_status_changed"),
      taskMeta: createTaskMeta({ status: "completed" }),
    };
    expect(getTaskMetaWorkspaceEventSyncMode(event)).toBe("preserve-membership");
    expect(shouldRefreshTaskListForWorkspaceEvent(event)).toBe(false);
    expect(shouldRefetchTaskListMembershipForWorkspaceEvent(event)).toBe(false);
  });
});
