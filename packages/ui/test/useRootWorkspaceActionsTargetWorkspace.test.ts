// 跨项目发起已保存工作流：新任务必须落在工作流归属项目而非活动项目
// （docs/dynamic-workflow/launch.md「The detail page」）。这里单测纯解析 helper 与源码接线契约。
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { resolveNewTaskTargetFromRequest } from "@/root/useRootWorkspaceActions.js";
import type { WorkbenchNewTaskTarget } from "@/v4/workbenchNewTaskTarget.js";

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8").replaceAll("\r\n", "\n");
}

describe("resolveNewTaskTargetFromRequest", () => {
  it("request 带 targetWorkspace 时采用它，且不询问 workbench 焦点解析", () => {
    const fallback = vi.fn<[], WorkbenchNewTaskTarget | null>(() => ({
      workspacePath: "/active",
    }));

    const target = resolveNewTaskTargetFromRequest(
      {
        initialPrompt: "运行工作流",
        targetWorkspace: {
          workspacePath: "/owner",
          workspaceIdentity: "remote:ssh:dev:/owner",
        },
      },
      fallback,
    );

    expect(target).toEqual({
      workspacePath: "/owner",
      workspaceIdentity: "remote:ssh:dev:/owner",
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("targetWorkspace 缺省 identity 时归一化为 null", () => {
    const fallback = vi.fn<[], WorkbenchNewTaskTarget | null>(() => null);

    const target = resolveNewTaskTargetFromRequest(
      { targetWorkspace: { workspacePath: "/owner" } },
      fallback,
    );

    expect(target).toEqual({ workspacePath: "/owner", workspaceIdentity: null });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("无 targetWorkspace 时回退到 workbench 解析，并把缺省 identity 归一化为 null", () => {
    const fallback = vi.fn<[], WorkbenchNewTaskTarget | null>(() => ({
      workspacePath: "/active",
    }));

    const target = resolveNewTaskTargetFromRequest({ initialPrompt: "普通新任务" }, fallback);

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(target).toEqual({ workspacePath: "/active", workspaceIdentity: null });
  });

  it("回退目标带 identity 时原样透传", () => {
    const fallback = vi.fn<[], WorkbenchNewTaskTarget | null>(() => ({
      workspacePath: "/active",
      workspaceIdentity: "remote:ssh:dev:/active",
    }));

    const target = resolveNewTaskTargetFromRequest("zcode", fallback);

    expect(target).toEqual({
      workspacePath: "/active",
      workspaceIdentity: "remote:ssh:dev:/active",
    });
  });

  it("provider 字符串请求与 undefined 请求都走回退，且回退返回 null 时透传 null", () => {
    const nullFallback = vi.fn<[], WorkbenchNewTaskTarget | null>(() => null);

    expect(resolveNewTaskTargetFromRequest("zcode", nullFallback)).toBeNull();
    expect(resolveNewTaskTargetFromRequest(undefined, nullFallback)).toBeNull();
    expect(nullFallback).toHaveBeenCalledTimes(2);
  });
});

describe("startNewTaskFromActiveWorkspace 接线契约", () => {
  it("newTaskTarget 经 resolveNewTaskTargetFromRequest 解析，惰性包裹 resolveWorkbenchNewTaskTarget", () => {
    const hook = source("../src/root/useRootWorkspaceActions.ts");
    expect(hook).toContain("const newTaskTarget = resolveNewTaskTargetFromRequest(request, () =>");
    expect(hook).toContain("resolveWorkbenchNewTaskTarget({");
    // resolveWorkbenchNewTaskTarget 只应作为 helper 的回退闭包出现一次，不再直接赋给 newTaskTarget。
    expect(hook).not.toContain("const newTaskTarget = resolveWorkbenchNewTaskTarget(");
  });

  it("中枢发起 handler 带 target 时跳过活动 workspace 只读检查并透传 targetWorkspace", () => {
    const shell = source("../src/app-shell/WorkspaceShellLayout.tsx");
    expect(shell).toContain("if (!targetWorkspace && workspaceReadOnlyReason) return;");
    // 单一 object literal，仅在 target 存在时 spread，不给 request 塞 undefined 键。
    expect(shell).toMatch(
      /handleCreateTaskInChat\(\{\s*initialPrompt: prompt,\s*\.\.\.\(targetWorkspace \? \{ targetWorkspace \} : \{\}\),\s*\}\)/,
    );
    // 工作流「运行」不再走 autoSubmit 对话文案：直接启动（docs/dynamic-workflow/launch.md），
    // 该分支应已删除，autoSubmit 通道全线移除。
    expect(shell).not.toContain("autoSubmit: true");
    expect(shell).not.toContain("handleLaunchWorkflowInChat");
  });

  it("handleCreateTaskInChat 仅在无 targetWorkspace 时应用活动 workspace 只读守卫，带 target 时仍到达 onCreateTask", () => {
    // WorkspaceShellLayout 组件体量大且依赖繁多，直接挂载不实际；此处用源码契约（正则）
    // 证明守卫按 targetWorkspace 短路。契约：先算 hasTargetWorkspace，再 `!hasTargetWorkspace &&
    // workspaceReadOnlyReason` 才 return，随后 showChatMainView() + onCreateTask(request)。
    const shell = source("../src/app-shell/WorkspaceShellLayout.tsx");
    expect(shell).toMatch(
      /const hasTargetWorkspace\s*=\s*typeof request === "object" && request !== null && Boolean\(request\.targetWorkspace\);/,
    );
    expect(shell).toMatch(
      /if \(!hasTargetWorkspace && workspaceReadOnlyReason\) \{\s*return;\s*\}\s*showChatMainView\(\);\s*onCreateTask\(request\);/,
    );
    // 旧的“无条件只读 return”守卫必须被移除，否则带 target 的跨项目发起会在活动只读时被挡下。
    expect(shell).not.toMatch(
      /const handleCreateTaskInChat = useCallback\(\s*\(request\?: [^)]*\) => \{\s*if \(workspaceReadOnlyReason\) \{/,
    );
  });

  it("handleOpenSavedWorkflowRun 用 params 携带的目标 workspace 打开实例，而非活动项目", () => {
    // 中枢是跨项目视图：实例必须开在发起它的项目（不变式 8）。用源码契约证明目标取自 params，
    // 仅缺省时兜底回退活动 workspace；remoteSessionId 按目标 workspace 从 tab 反查。
    const shell = source("../src/app-shell/WorkspaceShellLayout.tsx");
    expect(shell).toMatch(
      /const targetWorkspacePath = params\.workspacePath \|\| workspaceAbsPath;/,
    );
    expect(shell).toMatch(/const targetWorkspaceIdentity =\s*params\.workspaceIdentity \?\?/);
    // 打开实例用的是解析出的目标，不再直接用活动 workspaceAbsPath。
    expect(shell).toMatch(/handleOpenWorkflowRun\(\{\s*workspacePath: targetWorkspacePath,/);
    expect(shell).not.toContain(
      "handleSelectTaskInChat(workspaceAbsPath, params.sessionId, workspaceIdentity)",
    );
  });
});
