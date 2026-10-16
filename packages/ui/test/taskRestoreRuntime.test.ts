import { describe, expect, it } from "vitest";
import {
  shouldShowTaskConfigLoadingOnSwitch,
  resolveTaskRuntimeStatusAfterRestore,
  shouldKeepTaskStreamingDuringRestore,
} from "../src/lib/taskRestoreRuntime.js";

describe("shouldKeepTaskStreamingDuringRestore", () => {
  it("在 task 仍处于 streaming 时保持运行态", () => {
    expect(shouldKeepTaskStreamingDuringRestore("streaming")).toBe(true);
  });

  it("不会把非 streaming 状态误判成运行中恢复", () => {
    expect(shouldKeepTaskStreamingDuringRestore("ready")).toBe(false);
    expect(shouldKeepTaskStreamingDuringRestore("completed")).toBe(false);
  });
});

describe("resolveTaskRuntimeStatusAfterRestore", () => {
  it("恢复中的 streaming task 会继续保持 streaming", () => {
    expect(resolveTaskRuntimeStatusAfterRestore("streaming", true)).toBe("streaming");
  });

  it("普通历史 task 恢复成功后回到 ready", () => {
    expect(resolveTaskRuntimeStatusAfterRestore("completed", true)).toBe("ready");
  });

  it("snapshot 声明 main turn active 时恢复为 streaming", () => {
    expect(
      resolveTaskRuntimeStatusAfterRestore("ready", true, {
        persistedStatus: "running",
        runtimeMainActive: true,
      }),
    ).toBe("streaming");
  });

  it("持久化终态已经覆盖最新用户消息时，会用终态收口旧 streaming", () => {
    expect(
      resolveTaskRuntimeStatusAfterRestore("streaming", true, {
        persistedStatus: "completed",
        persistedUpdatedAt: 200,
        latestUserMessageTimestamp: 100,
      }),
    ).toBe("completed");

    expect(
      resolveTaskRuntimeStatusAfterRestore("streaming", true, {
        persistedStatus: "error",
        persistedUpdatedAt: 200,
        latestUserMessageTimestamp: 100,
      }),
    ).toBe("failed");
  });

  it("上一轮的旧终态快照不会把新一轮仍在运行的 task 提前收口", () => {
    expect(
      resolveTaskRuntimeStatusAfterRestore("streaming", true, {
        persistedStatus: "completed",
        persistedUpdatedAt: 100,
        latestUserMessageTimestamp: 200,
      }),
    ).toBe("streaming");
  });

  it("没有恢复出 session 时明确回退到 notReady", () => {
    expect(resolveTaskRuntimeStatusAfterRestore("streaming", false)).toBe("notReady");
  });
});

describe("shouldShowTaskConfigLoadingOnSwitch", () => {
  it("切换到另一条 task 时应进入 loading 占位，避免沿用上一条任务模型回显", () => {
    expect(
      shouldShowTaskConfigLoadingOnSwitch({
        previousTaskId: "task-a",
        nextTaskId: "task-b",
      }),
    ).toBe(true);
  });

  it("首次进入某条 task 也应进入 loading 占位", () => {
    expect(
      shouldShowTaskConfigLoadingOnSwitch({
        previousTaskId: null,
        nextTaskId: "task-a",
      }),
    ).toBe(true);
  });

  it("同一条 task 重入时不重复触发 loading 占位", () => {
    expect(
      shouldShowTaskConfigLoadingOnSwitch({
        previousTaskId: "task-a",
        nextTaskId: "task-a",
      }),
    ).toBe(false);
  });

  it("切回草稿态时不触发 task loading 占位", () => {
    expect(
      shouldShowTaskConfigLoadingOnSwitch({
        previousTaskId: "task-a",
        nextTaskId: null,
      }),
    ).toBe(false);
  });
});
