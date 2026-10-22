// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import type { WindowHostTaskUnreadSignal } from "@zcode/shared";
import { useProjectUnreadSignals } from "@/project-sidebar/useProjectUnreadSignals.js";
import { createTabStore, type TabStore } from "@/store/tabStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

const TARGET = {
  taskId: "task",
  workspacePath: "/repo",
  workspaceIdentity: "remote:server:source:/repo",
};

const mocks = vi.hoisted(() => ({
  services: null as unknown as {
    windowControllerService: {
      onDynamicTaskUnreadSignal: ReturnType<typeof vi.fn>;
      mutateTask: ReturnType<typeof vi.fn>;
    };
    zcodeTaskService: Record<string, unknown>;
  },
  tabs: null as TabStore | null,
}));

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => mocks.services,
}));
vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStoreApi: () => mocks.tabs,
}));
vi.mock("@/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () => null,
}));

const signalEmitter = new Emitter<WindowHostTaskUnreadSignal>();
const refresh = vi.fn(async () => {});
// mark-unread 回包带权威 marker（写未读的 CAS 凭据）
const MARKER = 11;

const fireTerminal = () =>
  signalEmitter.fire({
    address: { ...TARGET },
    updatedAt: Date.now(),
    status: "completed",
});

const mutateTaskCalls = () =>
  vi.mocked(mocks.services.windowControllerService.mutateTask).mock.calls;

beforeEach(() => {
  mocks.tabs = createTabStore(null);
  mocks.services = {
    windowControllerService: {
      onDynamicTaskUnreadSignal: vi.fn(() => signalEmitter.event),
      mutateTask: vi.fn(async () => ({ unreadAt: MARKER })),
    },
    zcodeTaskService: { setTaskUnread: vi.fn() },
  };
  // 构造 isDesktopViewing 全部命中：workspace tab 激活 + 完整导航地址 + activeTaskId。
  mocks.tabs.getState().addTab("/repo", { workspaceIdentity: TARGET.workspaceIdentity });
  useZCodeSessionStore
    .getState()
    .setActiveTaskId("/repo", TARGET.taskId, TARGET.workspaceIdentity);
  useZCodeSessionStore.setState({
    taskNavHistory: {
      entries: [
        {
          kind: "task",
          taskId: TARGET.taskId,
          workspacePath: TARGET.workspacePath,
          workspaceIdentity: TARGET.workspaceIdentity,
        },
      ],
      cursor: 0,
    },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("project sidebar foreground completion unread", () => {
  it("前台完成不立即写未读（等离开补写）", async () => {
    renderHook(() => useProjectUnreadSignals([{ workspacePath: "/repo" }], refresh));
    await act(async () => fireTerminal());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mutateTaskCalls()).toHaveLength(0);
  });

  it("离开窗口（blur）补写未读并刷新树", async () => {
    renderHook(() => useProjectUnreadSignals([{ workspacePath: "/repo" }], refresh));
    await act(async () => fireTerminal());
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });
    await waitFor(() => expect(mutateTaskCalls()).toHaveLength(1));
    expect(mutateTaskCalls()[0]?.[0]).toEqual({
      address: {
        workspacePath: TARGET.workspacePath,
        workspaceIdentity: TARGET.workspaceIdentity,
        taskId: TARGET.taskId,
        // workspaceIdentity 解析出的 Source 身份会带进完整地址
        sourceServerId: "source",
      },
      mutation: { kind: "mark-unread" },
    });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("信号到达时页面已隐藏（最小化）直接补写", async () => {
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    renderHook(() => useProjectUnreadSignals([{ workspacePath: "/repo" }], refresh));
    await act(async () => fireTerminal());
    await waitFor(() => expect(mutateTaskCalls()).toHaveLength(1));
    expect(mutateTaskCalls()[0]?.[0]?.mutation).toEqual({ kind: "mark-unread" });
  });

  it("回到窗口且任务仍在面前时按 marker 自动清除（不逼用户点走再点回）", async () => {
    renderHook(() => useProjectUnreadSignals([{ workspacePath: "/repo" }], refresh));
    await act(async () => fireTerminal());
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });
    await waitFor(() => expect(mutateTaskCalls()).toHaveLength(1));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(mutateTaskCalls()).toHaveLength(2));
    expect(mutateTaskCalls()[1]?.[0]).toEqual({
      address: {
        workspacePath: TARGET.workspacePath,
        workspaceIdentity: TARGET.workspaceIdentity,
        taskId: TARGET.taskId,
        sourceServerId: "source",
      },
      mutation: { kind: "mark-read", expectedUnreadAt: MARKER },
    });
    // 自动清除后再次 focus 不重复写
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mutateTaskCalls()).toHaveLength(2);
  });

  it("回到窗口但已不在查看：保留未读作为回来处理的提醒", async () => {
    renderHook(() => useProjectUnreadSignals([{ workspacePath: "/repo" }], refresh));
    await act(async () => fireTerminal());
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });
    await waitFor(() => expect(mutateTaskCalls()).toHaveLength(1));
    // 直接改 store 不发导航提交事件：模拟用户回到窗口时停在别的任务上
    useZCodeSessionStore.setState({
      taskNavHistory: {
        entries: [
          {
            kind: "task",
            taskId: "other",
            workspacePath: "/repo",
            workspaceIdentity: TARGET.workspaceIdentity,
          },
        ],
        cursor: 0,
      },
    });
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mutateTaskCalls()).toHaveLength(1);
  });

  it("补写失败不丢记录：下次 blur 重试成功（CR-01）", async () => {
    renderHook(() => useProjectUnreadSignals([{ workspacePath: "/repo" }], refresh));
    await act(async () => fireTerminal());
    vi
      .mocked(mocks.services.windowControllerService.mutateTask)
      .mockRejectedValueOnce(new Error("source temporarily offline"));
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });
    await waitFor(() => expect(mutateTaskCalls()).toHaveLength(1));
    // 写失败：marker 未写入，提醒不能丢
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });
    await waitFor(() => expect(mutateTaskCalls()).toHaveLength(2));
    expect(mutateTaskCalls()[1]?.[0]?.mutation).toEqual({ kind: "mark-unread" });
  });

  it("blur → 完成信号 → focus：聚焦时补写未读并自动清除（SG-01 事件顺序）", async () => {
    renderHook(() => useProjectUnreadSignals([{ workspacePath: "/repo" }], refresh));
    // 先失焦（页面仍可见，hidden=false）
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 失焦期间前台完成：记录但不写（焦点不在，写了用户也看不到横幅以外的东西，
    // 等回到窗口再补上提醒）
    await act(async () => fireTerminal());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mutateTaskCalls()).toHaveLength(0);
    // 重新聚焦：补写未读，且任务仍在面前 → 紧接自动清除
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(mutateTaskCalls()).toHaveLength(2));
    expect(mutateTaskCalls()[0]?.[0]?.mutation).toEqual({ kind: "mark-unread" });
    expect(mutateTaskCalls()[1]?.[0]).toEqual({
      address: {
        workspacePath: TARGET.workspacePath,
        workspaceIdentity: TARGET.workspaceIdentity,
        taskId: TARGET.taskId,
        sourceServerId: "source",
      },
      mutation: { kind: "mark-read", expectedUnreadAt: MARKER },
    });
  });

  it("focus 与恢复可见连发只发一次自动 mark-read（SG-01 去重）", async () => {
    renderHook(() => useProjectUnreadSignals([{ workspacePath: "/repo" }], refresh));
    await act(async () => fireTerminal());
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });
    await waitFor(() => expect(mutateTaskCalls()).toHaveLength(1));
    // focus 与 visibilitychange(恢复可见) 连续触发：在途清除去重，只发一次 mark-read
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(mutateTaskCalls()).toHaveLength(2));
    expect(mutateTaskCalls()[1]?.[0]?.mutation).toEqual({
      kind: "mark-read",
      expectedUnreadAt: MARKER,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mutateTaskCalls()).toHaveLength(2);
  });

  it("effect 重跑不丢在途补写：写入跨 effect 收敛（CR-01 回归）", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { rerender } = renderHook(() =>
      useProjectUnreadSignals([{ workspacePath: "/repo" }], refresh),
    );
    await act(async () => fireTerminal());
    // 第一次 blur：补写挂在 gate 上（在途）
    const oldMutate = vi.mocked(mocks.services.windowControllerService.mutateTask);
    oldMutate.mockImplementationOnce(async () => {
      await gate;
      return { unreadAt: MARKER };
    });
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(oldMutate).toHaveBeenCalledTimes(1);
    // services 换新对象触发 effect 重跑：旧实例 disposed，在途补写完成时
    // written/marker 仍会写入共享记录（ disposed 检查在 await 之前已通过）。
    await act(async () => {
      // services 换新对象 + rerender：触发 effect 重跑（旧实例 disposed）
      mocks.services = {
        ...mocks.services,
        windowControllerService: {
          onDynamicTaskUnreadSignal: vi.fn(() => signalEmitter.event),
          mutateTask: vi.fn(async () => ({ unreadAt: MARKER })),
        },
      };
      rerender();
    });
    const newMutate = vi.mocked(mocks.services.windowControllerService.mutateTask);
    await act(async () => {
      release();
    });
    await waitFor(() => expect(oldMutate).toHaveBeenCalledTimes(1));
    // 回到窗口：已写记录按 marker 自动清除，提醒不丢
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(newMutate).toHaveBeenCalledTimes(1));
    expect(newMutate.mock.calls[0]?.[0]?.mutation).toEqual({
      kind: "mark-read",
      expectedUnreadAt: MARKER,
    });
  });

  it("blur 补写在途时立即 focus：等待补写完成后自动清除（CR-01 交错时序）", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    renderHook(() => useProjectUnreadSignals([{ workspacePath: "/repo" }], refresh));
    await act(async () => fireTerminal());
    // blur 发起补写，mutate 挂在 gate 上（在途）
    vi
      .mocked(mocks.services.windowControllerService.mutateTask)
      .mockImplementationOnce(async () => {
        await gate;
        return { unreadAt: MARKER };
      });
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(mutateTaskCalls()).toHaveLength(1);
    // 补写未完成时立即回窗（focus），此时不应有 mark-read（marker 未就位）
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mutateTaskCalls()).toHaveLength(1);
    // 释放补写：focus 侧的 flushThenClear 等到补写落定后，
    // 应自动补上 mark-read（不需要再次 focus/visibility 事件）
    await act(async () => {
      release();
    });
    await waitFor(() => expect(mutateTaskCalls()).toHaveLength(2));
    expect(mutateTaskCalls()[0]?.[0]?.mutation).toEqual({ kind: "mark-unread" });
    expect(mutateTaskCalls()[1]?.[0]).toEqual({
      address: {
        workspacePath: TARGET.workspacePath,
        workspaceIdentity: TARGET.workspaceIdentity,
        taskId: TARGET.taskId,
        sourceServerId: "source",
      },
      mutation: { kind: "mark-read", expectedUnreadAt: MARKER },
    });
  });

  it("非查看状态完成仍立即写未读（既有行为回归）", async () => {
    useZCodeSessionStore.setState({
      taskNavHistory: {
        entries: [
          {
            kind: "task",
            taskId: "other",
            workspacePath: "/repo",
            workspaceIdentity: TARGET.workspaceIdentity,
          },
        ],
        cursor: 0,
      },
    });
    renderHook(() => useProjectUnreadSignals([{ workspacePath: "/repo" }], refresh));
    await act(async () => fireTerminal());
    await waitFor(() => expect(mutateTaskCalls()).toHaveLength(1));
    expect(mutateTaskCalls()[0]?.[0]?.mutation).toEqual({ kind: "mark-unread" });
  });

  it("blur 补写失败 → focus 重试成功 → 任务仍在面前时自动清除（CR-01 闭环）", async () => {
    renderHook(() => useProjectUnreadSignals([{ workspacePath: "/repo" }], refresh));
    await act(async () => fireTerminal());
    // 首次补写失败
    vi
      .mocked(mocks.services.windowControllerService.mutateTask)
      .mockRejectedValueOnce(new Error("source temporarily offline"));
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });
    await waitFor(() => expect(mutateTaskCalls()).toHaveLength(1));
    // 重回窗口：先重试补写成功，再自动清除（共 2 次调用）
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(mutateTaskCalls()).toHaveLength(3));
    expect(mutateTaskCalls()[1]?.[0]?.mutation).toEqual({ kind: "mark-unread" });
    expect(mutateTaskCalls()[2]?.[0]).toEqual({
      address: {
        workspacePath: TARGET.workspacePath,
        workspaceIdentity: TARGET.workspaceIdentity,
        taskId: TARGET.taskId,
        sourceServerId: "source",
      },
      mutation: { kind: "mark-read", expectedUnreadAt: MARKER },
    });
  });

  it("卸载后 focus 不再触发任何写入（监听器随 effect 清理）", async () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() =>
      useProjectUnreadSignals([{ workspacePath: "/repo" }], refresh),
    );
    unmount();
    expect(removeSpy).toHaveBeenCalledWith("focus", expect.any(Function));
    const callsBefore = mutateTaskCalls().length;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("blur"));
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mutateTaskCalls().length).toBe(callsBefore);
  });

  it("多次前台完成只补写一次（去重），blur 后集合清空", async () => {
    renderHook(() => useProjectUnreadSignals([{ workspacePath: "/repo" }], refresh));
    await act(async () => {
      fireTerminal();
      fireTerminal();
      fireTerminal();
    });
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });
    await waitFor(() => expect(mutateTaskCalls()).toHaveLength(1));
    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mutateTaskCalls()).toHaveLength(1);
  });
});
