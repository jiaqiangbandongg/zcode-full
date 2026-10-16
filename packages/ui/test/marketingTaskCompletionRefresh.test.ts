// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionSummary } from "@zcode/shared/zcode-protocol-v4";
const h = vi.hoisted(() => ({
  sessions: [] as Array<{ sessionId: string; phase: string }>,
  status: "live",
  listener: undefined as (() => void) | undefined,
  unsubscribe: vi.fn(),
  release: vi.fn(),
  acquire: vi.fn(),
  service: {},
}));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ zcodeAgentService: h.service }),
}));
vi.mock("@/v4/sessionsIndexRegistry.js", () => ({
  acquireSessionsIndex: h.acquire,
  releaseSessionsIndex: h.release,
}));
import {
  MarketingRefreshContext,
  useMarketingTaskCompletionRefresh,
} from "@/components/marketing-touch/useMarketingTaskCompletionRefresh.js";
function setup(rpcReady = true) {
  const refresh = vi.fn();
  h.acquire.mockReturnValue({
    getStatus: () => h.status,
    getSessions: () => h.sessions as SessionSummary[],
    subscribe: (listener: () => void) => {
      h.listener = listener;
      return h.unsubscribe;
    },
  });
  const hook = renderHook(
    ({ ready }) =>
      useMarketingTaskCompletionRefresh({
        workspacePath: "/workspace",
        workspaceIdentity: "remote:workspace",
        endpointKey: "remote-session",
        rpcReady: ready,
      }),
    {
      initialProps: { ready: rpcReady },
      wrapper: ({ children }) =>
        createElement(MarketingRefreshContext.Provider, { value: refresh }, children),
    },
  );
  return { ...hook, refresh };
}
function emit(phase: string, status = "live") {
  h.sessions = [{ sessionId: "task", phase }];
  h.status = status;
  act(() => h.listener?.());
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  h.sessions = [];
  h.status = "live";
  h.listener = undefined;
});
it("历史完成不刷新；真实成功边沿、重复和再次运行", () => {
  h.sessions = [{ sessionId: "task", phase: "completedSuccess" }];
  const { refresh } = setup();
  expect(refresh).not.toHaveBeenCalled();
  emit("completedSuccess");
  emit("running");
  emit("completedSuccess");
  emit("completedSuccess");
  expect(refresh).toHaveBeenCalledTimes(1);
  emit("running");
  emit("completedSuccess");
  expect(refresh).toHaveBeenCalledTimes(2);
});
it("失败和中断不刷新；新发现的历史任务不刷新", () => {
  const { refresh } = setup();
  emit("completedSuccess");
  emit("running");
  emit("error");
  emit("running");
  emit("completedInterrupted");
  expect(refresh).not.toHaveBeenCalled();
});
it("同批多任务完成合并；连接恢复建立新基线", () => {
  h.sessions = ["a", "b"].map((sessionId) => ({ sessionId, phase: "running" }));
  const { refresh } = setup();
  h.sessions = h.sessions.map((s) => ({ ...s, phase: "completedSuccess" }));
  act(() => h.listener?.());
  expect(refresh).toHaveBeenCalledTimes(1);
  emit("running");
  emit("running", "connecting");
  emit("completedSuccess");
  expect(refresh).toHaveBeenCalledTimes(1);
});
it("RPC 就绪后才订阅，传递隔离身份并在卸载释放", () => {
  const { rerender, unmount, refresh } = setup(false);
  expect(h.acquire).not.toHaveBeenCalled();
  rerender({ ready: true });
  expect(h.acquire).toHaveBeenCalledWith(
    {
      workspaceKey: "remote:workspace",
      workspaceIdentity: "remote:workspace",
      workspacePath: "/workspace",
      endpointKey: "remote-session",
    },
    h.service,
  );
  unmount();
  expect(h.unsubscribe).toHaveBeenCalledTimes(1);
  expect(h.release).toHaveBeenCalledTimes(1);
  expect(refresh).not.toHaveBeenCalled();
});
