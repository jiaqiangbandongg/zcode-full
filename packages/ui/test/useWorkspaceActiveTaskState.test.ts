// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { useWorkspaceActiveTaskState } from "@/hooks/useWorkspaceActiveTaskState.js";

const fixture = vi.hoisted(() => ({
  service: { getTaskMeta: vi.fn(), onDynamicWorkspaceEvent: vi.fn() },
  readSession: vi.fn(async () => {
    throw new Error("Session is not active");
  }),
  workspace: {
    optimisticTaskListByTaskId: {} as Record<string, ZCodeTaskMeta>,
    taskListCache: [],
    taskListVersion: 0,
  },
  events: new Set<(event: { type: string }) => void>(),
  broadcasts: new Set<(event: { channel: string }) => void>(),
  warning: vi.fn(),
}));
vi.mock("@/hooks/useZCodeTaskService.js", () => ({ useZCodeTaskService: () => fixture.service }));
vi.mock("@/hooks/useZCodeSessionService.js", () => ({
  useZCodeSessionService: () => ({ readSession: fixture.readSession }),
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => ({ broadcastService }),
}));
const broadcastService = {
  onMessage: (listener: (event: { channel: string }) => void) => {
    fixture.broadcasts.add(listener);
    return { dispose: () => fixture.broadcasts.delete(listener) };
  },
};
vi.mock("@/logger.js", () => ({ logger: { warn: fixture.warning } }));
vi.mock("@/store/zcodeSessionStore.js", () => ({
  getTaskMeta: () => null,
  selectWorkspaceZCodeState: () => fixture.workspace,
  useZCodeSessionStore: (selector: (state: unknown) => unknown) => selector({}),
}));
vi.mock("@/store/taskQueryCacheStore.js", () => ({
  useTaskQueryCacheStore: (select: (state: unknown) => unknown) =>
    select({ taskMetaByEntityKey: {} }),
}));
vi.mock("@/hooks/useTaskNativeSessionLogFile.js", () => ({
  useTaskNativeSessionLogFile: () => null,
}));
vi.mock("@/hooks/useTaskSessionFilePath.js", () => ({ useTaskSessionFilePath: () => null }));
const meta = (title = "1111"): ZCodeTaskMeta => ({
  taskId: "s",
  title,
  workspacePath: "/repo",
  createdAt: 1,
  updatedAt: 2,
  traceId: "s",
  mode: "default",
});
const params = {
  workspaceAbsPath: "/repo",
  activeTaskId: "s",
  selectedProvider: "codex" as const,
  intl: { formatMessage: ({ id }: { id: string }) => id },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const changed = () =>
  act(() => {
    fixture.events.forEach((listener) => listener({ type: "workspace_task_list_changed" }));
  });
beforeEach(() => {
  vi.clearAllMocks();
  fixture.workspace.optimisticTaskListByTaskId = {};
  fixture.service.getTaskMeta.mockResolvedValue(meta());
  fixture.service.onDynamicWorkspaceEvent.mockImplementation(
    () => (listener: (event: { type: string }) => void) => {
      fixture.events.add(listener);
      return { dispose: () => fixture.events.delete(listener) };
    },
  );
});
afterEach(() => {
  cleanup();
  fixture.events.clear();
  fixture.broadcasts.clear();
});

describe("当前任务 Host 元数据", () => {
  it("冷历史标题不依赖 CLI active runtime，且响应 Host 重命名", async () => {
    const { result } = renderHook(() => useWorkspaceActiveTaskState(params));
    await waitFor(() => expect(result.current.activeTaskTitle).toBe("1111"));
    expect(fixture.readSession).not.toHaveBeenCalled();
    expect(fixture.service.getTaskMeta).toHaveBeenCalledWith({
      workspacePath: "/repo",
      workspaceIdentity: undefined,
      taskId: "s",
    });
    fixture.service.getTaskMeta.mockResolvedValue({ ...meta("手动标题"), titleOverridden: true });
    changed();
    await waitFor(() => expect(result.current.activeTaskTitle).toBe("手动标题"));
  });
  it("相同元数据的刷新保持引用稳定，projects 归档事件也会刷新", async () => {
    const { result } = renderHook(() => useWorkspaceActiveTaskState(params));
    await waitFor(() => expect(result.current.activeTaskTitle).toBe("1111"));
    const initial = result.current.resolvedActiveTaskMeta;
    fixture.service.getTaskMeta.mockResolvedValue(meta());
    act(() => fixture.broadcasts.forEach((listener) => listener({ channel: "state:projects" })));
    await waitFor(() => expect(fixture.service.getTaskMeta).toHaveBeenCalledTimes(2));
    expect(result.current.resolvedActiveTaskMeta).toBe(initial);
  });
  it("同 ID/路径切换远端身份时立即撤下旧标题，迟到结果不能覆盖新身份", async () => {
    const old = deferred<ZCodeTaskMeta>();
    const next = deferred<ZCodeTaskMeta>();
    fixture.service.getTaskMeta.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const { result, rerender } = renderHook(
      ({ identity }) => useWorkspaceActiveTaskState({ ...params, workspaceIdentity: identity }),
      { initialProps: { identity: "remote:server:a:/repo" } },
    );
    rerender({ identity: "remote:server:b:/repo" });
    expect(result.current.resolvedActiveTaskMeta).toBeNull();
    await act(async () =>
      next.resolve({ ...meta("B"), workspaceIdentity: "remote:server:b:/repo" }),
    );
    await act(async () =>
      old.resolve({ ...meta("A"), workspaceIdentity: "remote:server:a:/repo" }),
    );
    expect(result.current.activeTaskTitle).toBe("B");
    expect(fixture.service.getTaskMeta.mock.calls[1]?.[0].workspaceIdentity).toBe(
      "remote:server:b:/repo",
    );
  });
  it("刷新乱序只接受最新请求，读取失败记录日志且不回退 runtime", async () => {
    const old = deferred<ZCodeTaskMeta>();
    fixture.service.getTaskMeta.mockReturnValueOnce(old.promise);
    const { result } = renderHook(() => useWorkspaceActiveTaskState(params));
    fixture.service.getTaskMeta.mockResolvedValue(meta("新标题"));
    changed();
    await waitFor(() => expect(result.current.activeTaskTitle).toBe("新标题"));
    await act(async () => old.resolve(meta("旧标题")));
    expect(result.current.activeTaskTitle).toBe("新标题");
    fixture.service.getTaskMeta.mockRejectedValueOnce(new Error("offline"));
    changed();
    await waitFor(() => expect(fixture.warning).toHaveBeenCalled());
    expect(result.current.activeTaskTitle).toBe("新标题");
    expect(fixture.readSession).not.toHaveBeenCalled();
  });
  it("已显示的标题在切换任务的首帧即撤下，卸载后释放所有订阅", async () => {
    const pending = deferred<ZCodeTaskMeta>();
    const { result, rerender, unmount } = renderHook(
      ({ taskId }) => useWorkspaceActiveTaskState({ ...params, activeTaskId: taskId }),
      { initialProps: { taskId: "s" } },
    );
    await waitFor(() => expect(result.current.activeTaskTitle).toBe("1111"));
    fixture.service.getTaskMeta.mockReturnValueOnce(pending.promise);
    rerender({ taskId: "next" });
    expect(result.current.resolvedActiveTaskMeta).toBeNull();
    unmount();
    expect(fixture.events.size).toBe(0);
    expect(fixture.broadcasts.size).toBe(0);
    await act(async () => pending.resolve({ ...meta("下一条"), taskId: "next" }));
  });
  it("首发落索引前允许现有乐观标题，Host 返回后以权威标题为准", async () => {
    fixture.workspace.optimisticTaskListByTaskId.s = meta("首发草稿");
    fixture.service.getTaskMeta.mockResolvedValueOnce(null);
    const { result } = renderHook(() => useWorkspaceActiveTaskState(params));
    await waitFor(() => expect(result.current.activeTaskTitle).toBe("首发草稿"));
    fixture.service.getTaskMeta.mockResolvedValue(meta("生成标题"));
    changed();
    await waitFor(() => expect(result.current.activeTaskTitle).toBe("生成标题"));
  });
  it("attachment 重建即使复用 service 对象也不能沿用旧请求", async () => {
    const pending = deferred<ZCodeTaskMeta>();
    const { result, rerender } = renderHook(
      ({ attachment }) =>
        useWorkspaceActiveTaskState({ ...params, workspaceRemoteSessionId: attachment }),
      { initialProps: { attachment: "old-attachment" } },
    );
    await waitFor(() => expect(result.current.activeTaskTitle).toBe("1111"));
    fixture.service.getTaskMeta.mockReturnValueOnce(pending.promise);
    rerender({ attachment: "new-attachment" });
    expect(result.current.resolvedActiveTaskMeta).toBeNull();
    await act(async () => pending.resolve(meta("新连接")));
    expect(result.current.activeTaskTitle).toBe("新连接");
  });
});
