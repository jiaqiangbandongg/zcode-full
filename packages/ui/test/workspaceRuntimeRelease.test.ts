import { describe, expect, it, vi } from "vitest";
import { releaseWorkspaceRuntimeAfterProjectRemoval } from "@/lib/workspaceRuntimeRelease.js";
import { logger } from "@/logger.js";

vi.mock("@/logger.js", () => ({
  logger: {
    error: vi.fn(),
  },
}));

describe("releaseWorkspaceRuntimeAfterProjectRemoval", () => {
  it("releases local workspace runtime without workspace identity", async () => {
    const releaseWorkspacePreparation = vi.fn(async () => undefined);

    releaseWorkspaceRuntimeAfterProjectRemoval({
      tab: {
        workspacePath: "C:/repo/demo",
      },
      zcodeTaskService: { releaseWorkspacePreparation },
    });
    await Promise.resolve();

    expect(releaseWorkspacePreparation).toHaveBeenCalledWith({
      workspacePath: "C:/repo/demo",
    });
  });

  it("preserves workspace identity when releasing remote workspace runtime", async () => {
    const releaseWorkspacePreparation = vi.fn(async () => undefined);

    releaseWorkspaceRuntimeAfterProjectRemoval({
      tab: {
        workspacePath: "/repo/demo",
        workspaceIdentity: "remote:ssh:dev:/repo/demo",
      },
      zcodeTaskService: { releaseWorkspacePreparation },
    });
    await Promise.resolve();

    expect(releaseWorkspacePreparation).toHaveBeenCalledWith({
      workspacePath: "/repo/demo",
      workspaceIdentity: "remote:ssh:dev:/repo/demo",
    });
  });

  it("logs release failure without throwing", async () => {
    const error = new Error("release failed");
    const releaseWorkspacePreparation = vi.fn(async () => {
      throw error;
    });

    releaseWorkspaceRuntimeAfterProjectRemoval({
      tab: {
        workspacePath: "C:/repo/locked",
        workspaceIdentity: "  ",
      },
      zcodeTaskService: { releaseWorkspacePreparation },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(logger.error).toHaveBeenCalledWith(
      "[WorkspaceSidebarItem] 移除 workspace 后释放 runtime 失败",
      {
        workspaceKey: "C:/repo/locked",
        error,
      },
    );
  });
});
