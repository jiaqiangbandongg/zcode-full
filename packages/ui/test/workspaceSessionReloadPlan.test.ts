import { describe, expect, it } from "vitest";
import {
  buildWorkspaceSessionReloadDraftError,
  buildWorkspaceSessionReloadPlan,
  shouldDebounceWorkspaceSessionReload,
  WORKSPACE_SESSION_RELOAD_DEBOUNCE_MS,
} from "@/lib/workspaceSessionReloadPlan.js";

describe("buildWorkspaceSessionReloadPlan", () => {
  it("有 activeTaskId 时返回 resumeTaskId，并跳过预热", () => {
    expect(buildWorkspaceSessionReloadPlan("task-123")).toEqual({
      resumeTaskId: "task-123",
      shouldPrepareWorkspace: false,
    });
  });

  it("activeTaskId 为空或仅空白时，不续接 task 且需要预热", () => {
    expect(buildWorkspaceSessionReloadPlan(null)).toEqual({
      resumeTaskId: undefined,
      shouldPrepareWorkspace: true,
    });

    expect(buildWorkspaceSessionReloadPlan("   ")).toEqual({
      resumeTaskId: undefined,
      shouldPrepareWorkspace: true,
    });
  });

  it("reload 失败时会生成可展示的草稿态错误", () => {
    const error = buildWorkspaceSessionReloadDraftError(
      { code: -32000, message: "Authentication required" },
      {
        workspacePath: "/repo/demo",
        provider: "glm",
      },
    );

    expect(error).toMatchObject({
      code: "WORKSPACE_PREPARE_FAILED",
      message: "Authentication required",
      detail: "workspace=/repo/demo provider=glm reason=reload-session attempt=1/1",
    });
  });

  it("短时间内重复触发 reload 会命中防抖", () => {
    expect(
      shouldDebounceWorkspaceSessionReload(
        1_000,
        1_000 + WORKSPACE_SESSION_RELOAD_DEBOUNCE_MS - 1,
      ),
    ).toBe(true);

    expect(
      shouldDebounceWorkspaceSessionReload(
        1_000,
        1_000 + WORKSPACE_SESSION_RELOAD_DEBOUNCE_MS,
      ),
    ).toBe(false);
  });
});
