// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { IPlatformService } from "@zcode/shared";
import { useReconnectingRemoteWorkspaceLogs } from "@/root/useReconnectingRemoteWorkspaceLogs.js";
it("重连失败结束后日志留到用户查看，关闭项目才释放", () => {
  let emit!: Parameters<IPlatformService["onRemoteConnectionLog"]>[0];
  const platform = {
    onRemoteConnectionLog: vi.fn((handler) => {
      emit = handler;
      return () => {};
    }),
  } as unknown as IPlatformService;
  const { result, rerender, unmount } = renderHook(
    ({ active, exists }) =>
      useReconnectingRemoteWorkspaceLogs({
        platform,
        reconnectingWorkspaceKeys: active ? ["project"] : [],
        resolveWorkspaceTargetByKey: () => (exists ? { kind: "docker", container: "dev" } : null),
        resolveWorkspaceRequestIdByKey: () => "request",
      }),
    { initialProps: { active: true, exists: true } },
  );
  act(() =>
    emit({
      requestId: "request",
      label: "window-host",
      timestamp: "12:00:00",
      level: "error",
      message: "connection failed",
    }),
  );
  expect(result.current.logsByWorkspaceKey.project).toHaveLength(1);
  rerender({ active: false, exists: true });
  expect(result.current.logsByWorkspaceKey.project).toHaveLength(1);
  rerender({ active: false, exists: false });
  expect(result.current.logsByWorkspaceKey.project).toBeUndefined();
  unmount();
});
