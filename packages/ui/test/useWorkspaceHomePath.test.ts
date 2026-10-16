// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@zcode/services";
import {
  buildWorkspaceHomeCacheKey,
  resetWorkspaceHomePathCacheForTests,
  useWorkspaceHomePath,
} from "@/hooks/useWorkspaceHomePath.js";

const { useServicesMock } = vi.hoisted(() => ({
  useServicesMock: vi.fn(),
}));

vi.mock("@/hooks/useServices.js", () => ({
  useServices: useServicesMock,
}));

function servicesWithHome(info: () => Promise<{ homedir: string; platform: string }>) {
  return { systemService: { info } } as unknown as IServiceAccessor;
}

describe("useWorkspaceHomePath", () => {
  beforeEach(() => {
    resetWorkspaceHomePathCacheForTests();
    useServicesMock.mockReset();
  });

  it("按 workspace identity 和 remote session 隔离 Home cache", () => {
    expect(
      buildWorkspaceHomeCacheKey({
        workspacePath: "/workspace",
        workspaceIdentity: "remote:ssh:host:/workspace",
        remoteSessionId: "remote-1",
      }),
    ).toBe("remote:ssh:host:/workspace::remote-1");
    expect(
      buildWorkspaceHomeCacheKey({
        workspacePath: "/workspace",
        remoteSessionId: "remote-2",
      }),
    ).toBe("/workspace::remote-2");
  });

  it("复用同一 Host 的 in-flight/info 结果，且 Host 变化后重新查询", async () => {
    const firstInfo = vi.fn(async () => ({ homedir: "/Users/demo", platform: "darwin" }));
    const secondInfo = vi.fn(async () => ({ homedir: "/home/remote", platform: "linux" }));
    const firstServices = servicesWithHome(firstInfo);
    const secondServices = servicesWithHome(secondInfo);
    useServicesMock.mockReturnValue(firstServices);

    const { result, rerender } = renderHook(
      ({ workspacePath, workspaceIdentity, remoteSessionId }) =>
        useWorkspaceHomePath({ workspacePath, workspaceIdentity, remoteSessionId }),
      {
        initialProps: {
          workspacePath: "/workspace",
          workspaceIdentity: "remote:ssh:host:/workspace",
          remoteSessionId: "remote-1",
        },
      },
    );

    await waitFor(() => expect(result.current).toBe("/Users/demo"));
    expect(firstInfo).toHaveBeenCalledTimes(1);

    rerender({
      workspacePath: "/workspace",
      workspaceIdentity: "remote:ssh:host:/workspace",
      remoteSessionId: "remote-1",
    });
    expect(result.current).toBe("/Users/demo");
    expect(firstInfo).toHaveBeenCalledTimes(1);

    useServicesMock.mockReturnValue(secondServices);
    rerender({
      workspacePath: "/workspace",
      workspaceIdentity: "remote:ssh:host:/workspace",
      remoteSessionId: "remote-1",
    });
    await waitFor(() => expect(result.current).toBe("/home/remote"));
    expect(secondInfo).toHaveBeenCalledTimes(1);
  });
});
