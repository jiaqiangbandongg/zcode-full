// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fileWatcherService, systemService } = vi.hoisted(() => ({
  fileWatcherService: {
    watch: vi.fn(async () => ({ id: "watch-1" })),
    unwatch: vi.fn(async () => {}),
    disposeAll: vi.fn(),
    onDynamicChange: vi.fn(() => () => ({ dispose: vi.fn() })),
  },
  systemService: {
    info: vi.fn(async () => ({ homedir: "/home/tester", platform: "linux" })),
  },
}));

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServices: () => ({ fileWatcherService, systemService }),
}));

import { useGitAutoRefresh } from "@/hooks/useGitAutoRefresh.js";

describe("useGitAutoRefresh", () => {
  beforeEach(() => {
    fileWatcherService.watch.mockClear();
    fileWatcherService.unwatch.mockClear();
    fileWatcherService.onDynamicChange.mockClear();
    systemService.info.mockClear();
  });

  it("uses the workspace Host platform and never recursively watches a Linux workspace root", async () => {
    renderHook(() =>
      useGitAutoRefresh({
        workspacePath: "/repo",
        workspaceIdentity: "remote:ssh:linux:/repo",
        remoteSessionId: "remote-session-1",
        gitSummary: {
          workspacePath: "/repo",
          repoRoot: "/repo",
          workspaceInRepoPath: ".",
          autoRefreshWatchPaths: [
            { path: "/repo", recursive: true },
            { path: "/repo/.git", recursive: true },
          ],
          branchName: "main",
          trackingBranchName: null,
          headRefType: "branch",
          ahead: 0,
          behind: 0,
          isDirty: false,
          isGitAvailable: true,
          isRepository: true,
        },
        gitSummaryWorkspaceKey: "remote:ssh:linux:/repo",
        enabled: true,
        onRefreshGit: vi.fn(),
      }),
    );

    await waitFor(() => expect(fileWatcherService.watch).toHaveBeenCalledTimes(1));
    expect(fileWatcherService.watch).toHaveBeenCalledWith({
      path: "/repo/.git",
      recursive: true,
    });
    expect(systemService.info).toHaveBeenCalledTimes(1);
  });
});
