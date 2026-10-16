// @vitest-environment jsdom

// 中枢运行历史行上两个「打开」的门与实参构造（docs/dynamic-workflow/launch.md「Cards」+
// docs/dynamic-workflow/authoring.md「How the user sees them」）。项目档与全局档共用这一个 hook，唯一的差别是
// 「目标项目怎么算」。
//
// 关键差异：产物 tab **不需要 `toolCallId`**（它不画因果图，也就不必回到那条 CreateWorkflow
// 工具行），所以老行缺 toolCallId 时「查看实例」关闭而产物 chip 仍然可点。
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ZCodeSavedWorkflowRun } from "@zcode/shared";
import {
  useSavedWorkflowRunOpeners,
  type SavedWorkflowRunOpenTarget,
} from "@/settings/saved-workflows/useSavedWorkflowRunOpeners.js";

const onOpenWorkflowRun = vi.fn();
const onOpenWorkflowArtifact = vi.fn();

const TARGET: SavedWorkflowRunOpenTarget = {
  workspacePath: "/repo",
  workspaceIdentity: "ssh://host/repo",
};

function run(overrides: Partial<ZCodeSavedWorkflowRun> = {}): ZCodeSavedWorkflowRun {
  return {
    runId: "r-1",
    name: "release-check",
    status: "completed",
    createdAt: 1,
    updatedAt: 2,
    spentTokens: 0,
    parentSessionId: "s1",
    toolCallId: "t1",
    artifacts: [
      { id: "book", kind: "file", title: "审计报告", version: 2, contentType: "text/html" },
    ],
    ...overrides,
  };
}

function openers(target: SavedWorkflowRunOpenTarget | null = TARGET) {
  return renderHook(() =>
    useSavedWorkflowRunOpeners({
      resolveTarget: () => target,
      onOpenWorkflowRun,
      onOpenWorkflowArtifact,
    }),
  ).result.current;
}

beforeEach(() => {
  onOpenWorkflowRun.mockClear();
  onOpenWorkflowArtifact.mockClear();
});

describe("useSavedWorkflowRunOpeners", () => {
  it("「查看实例」带上 toolCallId 与目标项目", () => {
    openers().handleOpenRun(run(), "release-check");
    expect(onOpenWorkflowRun).toHaveBeenCalledWith({
      sessionId: "s1",
      runId: "r-1",
      toolCallId: "t1",
      workflowName: "release-check",
      workspacePath: "/repo",
      workspaceIdentity: "ssh://host/repo",
    });
  });

  it("产物 chip 的实参**不含 toolCallId**，但带上展示名与 contentType（终点据它分流 html 产物）", () => {
    openers().handleOpenArtifact(run(), "book");
    expect(onOpenWorkflowArtifact).toHaveBeenCalledWith({
      sessionId: "s1",
      runId: "r-1",
      artifactId: "book",
      title: "审计报告",
      contentType: "text/html",
      workspacePath: "/repo",
      workspaceIdentity: "ssh://host/repo",
    });
  });

  it("老行的 chip 载荷不带 contentType 时不编一个出来（少一个键是退化不是错误）", () => {
    openers().handleOpenArtifact(
      run({ artifacts: [{ id: "book", kind: "file", title: "审计报告", version: 2 }] }),
      "book",
    );
    expect(onOpenWorkflowArtifact).toHaveBeenCalledWith({
      sessionId: "s1",
      runId: "r-1",
      artifactId: "book",
      title: "审计报告",
      workspacePath: "/repo",
      workspaceIdentity: "ssh://host/repo",
    });
  });

  it("老行缺 toolCallId：「查看实例」关闭，产物仍然打得开", () => {
    const legacy = run({ toolCallId: undefined });
    const hook = openers();
    hook.handleOpenRun(legacy, "release-check");
    expect(onOpenWorkflowRun).not.toHaveBeenCalled();

    hook.handleOpenArtifact(legacy, "book");
    expect(onOpenWorkflowArtifact).toHaveBeenCalledTimes(1);
  });

  it("缺 parentSessionId：两个入口都关（产物 tab 必须开在发起它的会话里）", () => {
    const orphan = run({ parentSessionId: undefined });
    const hook = openers();
    hook.handleOpenRun(orphan, "release-check");
    hook.handleOpenArtifact(orphan, "book");
    expect(onOpenWorkflowRun).not.toHaveBeenCalled();
    expect(onOpenWorkflowArtifact).not.toHaveBeenCalled();
  });

  it("目标项目没打开（全局档按 cwd 反查不到）：两个入口都关", () => {
    const hook = openers(null);
    hook.handleOpenRun(run(), "release-check");
    hook.handleOpenArtifact(run(), "book");
    expect(onOpenWorkflowRun).not.toHaveBeenCalled();
    expect(onOpenWorkflowArtifact).not.toHaveBeenCalled();
  });

  it("产物不在该行的清单里时不编造标题，只送 id", () => {
    openers().handleOpenArtifact(run({ artifacts: undefined }), "book");
    expect(onOpenWorkflowArtifact).toHaveBeenCalledWith({
      sessionId: "s1",
      runId: "r-1",
      artifactId: "book",
      workspacePath: "/repo",
      workspaceIdentity: "ssh://host/repo",
    });
  });

  it("本地项目没有 workspaceIdentity 时不硬塞一个空值（身份语义按 workspaceKey 回退）", () => {
    openers({ workspacePath: "/repo" }).handleOpenArtifact(run(), "book");
    expect(onOpenWorkflowArtifact).toHaveBeenCalledWith({
      sessionId: "s1",
      runId: "r-1",
      artifactId: "book",
      title: "审计报告",
      contentType: "text/html",
      workspacePath: "/repo",
    });
  });
});
