import { describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import {
  areTaskListItemsEquivalent,
  buildTaskListItemIdentityKey,
  stabilizeTaskListItems,
} from "@/v4/taskListItemStabilization.js";
import { attachTaskListRowActivity } from "@/v4/taskListRowActivity.js";

function createTask(overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId: "task-1",
    workspacePath: "/repo",
    title: "查询下今天南京的天气",
    status: "running",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  } as ZCodeTaskMeta;
}

describe("stabilizeTaskListItems", () => {
  it("等价重建时复用整个旧数组和旧元素引用", () => {
    const previous = [createTask(), createTask({ taskId: "task-2" })];
    const next = [createTask(), createTask({ taskId: "task-2" })];

    const stabilized = stabilizeTaskListItems(previous, next);

    expect(stabilized).toBe(previous);
    expect(stabilized[0]).toBe(previous[0]);
  });

  it("只有一行内容变化时其余行保持旧引用", () => {
    const previous = [createTask(), createTask({ taskId: "task-2" })];
    const next = [createTask({ title: "新标题" }), createTask({ taskId: "task-2" })];

    const stabilized = stabilizeTaskListItems(previous, next);

    expect(stabilized).not.toBe(previous);
    expect(stabilized[0]).toBe(next[0]);
    expect(stabilized[1]).toBe(previous[1]);
  });

  it("activity sidecar 内容等价时也判为等价（嵌套对象按值比较）", () => {
    const activity = { phase: "running" as const, lastActivityAt: 5, hasBackgroundWork: false };
    const previous = [attachTaskListRowActivity(createTask(), activity)];
    const next = [attachTaskListRowActivity(createTask(), { ...activity })];

    expect(stabilizeTaskListItems(previous, next)).toBe(previous);
  });

  it("activity 时间戳变化时该行换新引用", () => {
    const activity = { phase: "running" as const, lastActivityAt: 5, hasBackgroundWork: false };
    const previous = [attachTaskListRowActivity(createTask(), activity)];
    const next = [attachTaskListRowActivity(createTask(), { ...activity, lastActivityAt: 6 })];

    const stabilized = stabilizeTaskListItems(previous, next);

    expect(stabilized).not.toBe(previous);
    expect(stabilized[0]).toBe(next[0]);
  });

  it("顺序变化不复用旧数组，但每行仍复用旧引用", () => {
    const previous = [createTask(), createTask({ taskId: "task-2" })];
    const next = [createTask({ taskId: "task-2" }), createTask()];

    const stabilized = stabilizeTaskListItems(previous, next);

    expect(stabilized).not.toBe(previous);
    expect(stabilized[0]).toBe(previous[1]);
    expect(stabilized[1]).toBe(previous[0]);
  });

  it("首帧（旧数组为空）直接采用新数组", () => {
    const next = [createTask()];
    expect(stabilizeTaskListItems([], next)).toBe(next);
  });
});

describe("buildTaskListItemIdentityKey", () => {
  it("同一 taskId 在不同 workspace identity 下不互相复用", () => {
    expect(buildTaskListItemIdentityKey(createTask())).not.toBe(
      buildTaskListItemIdentityKey(createTask({ workspaceIdentity: "remote-a" })),
    );
  });
});

describe("areTaskListItemsEquivalent", () => {
  it("字段数量不同即判为不等价", () => {
    expect(
      areTaskListItemsEquivalent(createTask(), createTask({ unreadAt: 7 })),
    ).toBe(false);
  });

  // 回归锁：稳定化的全部价值押在这条等价判断上，一旦退化只表现为「整列表闪一下」，
  // 不报错也没有日志。上游 join 用条件展开构造 sidecar，key 插入顺序不保证跨帧一致。
  it("嵌套 sidecar 的 key 顺序不同但内容相同时判为等价", () => {
    const previous = attachTaskListRowActivity(createTask(), {
      phase: "running",
      lastActivityAt: 5,
      hasBackgroundWork: false,
    });
    const next = attachTaskListRowActivity(createTask(), {
      hasBackgroundWork: false,
      lastActivityAt: 5,
      phase: "running",
    });

    expect(JSON.stringify(previous)).not.toBe(JSON.stringify(next));
    expect(areTaskListItemsEquivalent(previous, next)).toBe(true);
    expect(stabilizeTaskListItems([previous], [next])[0]).toBe(previous);
  });

  it("顶层 key 顺序不同但内容相同时判为等价", () => {
    const left = { taskId: "t", workspacePath: "/repo", title: "a" } as ZCodeTaskMeta;
    const right = { title: "a", workspacePath: "/repo", taskId: "t" } as ZCodeTaskMeta;

    expect(areTaskListItemsEquivalent(left, right)).toBe(true);
  });

  it("显式 undefined 字段与缺省字段等价（与 JSON 口径一致）", () => {
    const left = { ...createTask(), workspaceIdentity: undefined } as ZCodeTaskMeta;

    expect(areTaskListItemsEquivalent(left, createTask())).toBe(true);
  });

  it("嵌套数组顺序变化仍判为不等价", () => {
    const left = { ...createTask(), tags: ["a", "b"] } as unknown as ZCodeTaskMeta;
    const right = { ...createTask(), tags: ["b", "a"] } as unknown as ZCodeTaskMeta;

    expect(areTaskListItemsEquivalent(left, right)).toBe(false);
  });
});
