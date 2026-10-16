// @vitest-environment jsdom

// 产物点击的落点裁决（docs/dynamic-workflow/authoring.md「How the user sees them」）。
//
// ⚠ 术语：artifact = 脚本经 `artifact.*` 交付给**用户**的产出，不是引擎内部那个「脚本顶层
// 返回值」的同名词。
//
// 钉三件事：
//   1. html + 本地 workspace + 有内嵌浏览器 ⇒ 直接开 browser tab，不再经过产物 tab；
//   2. 同一枚产物再点一次 ⇒ 复用那一个 tab，并**重新**发导航请求（v2 必须显示新字节）；
//   3. 任何一条判据不成立、出处查不到、查询本身失败 ⇒ 退回产物 tab，点击绝不落空。
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { V4ConversationWorkflowRunArtifactsResult } from "@zcode/shared/zcode-protocol-v4";
import { useAppPanels } from "@/hooks/useAppPanels.js";
import { shouldOpenWorkflowArtifactInBrowser } from "@/lib/workflowArtifactOpen.js";
import { clearTaskSidePaneMemoryStateForTest } from "@/lib/taskSidePaneMemory.js";
import { getVisibleSidePaneTabs } from "@/lib/workspaceSidePane.js";
import type {
  OpenScopedWorkflowArtifactSideTabRequest,
  WorkspaceSidePaneTab,
} from "@/lib/workspaceSidePane.js";

const { conversationWorkflowRunArtifactsV4 } = vi.hoisted(() => ({
  conversationWorkflowRunArtifactsV4:
    vi.fn<() => Promise<V4ConversationWorkflowRunArtifactsResult>>(),
}));

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({
    zcodeAgentService: { conversationWorkflowRunArtifactsV4 },
    zcodeSessionService: { closeSession: vi.fn(async () => {}) },
  }),
}));

vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const WORKSPACE_PATH = "/repo";
const SESSION_ID = "sess-a";
const REPORT_URL = "file:///repo/.zcode/workflow-runs/run-1/report.html";

function renderPanels(options?: { supportsEmbeddedBrowser?: boolean; sidePaneOwnerId?: string }) {
  return renderHook(() =>
    useAppPanels({
      workspaceAbsPath: WORKSPACE_PATH,
      activeTaskId: options?.sidePaneOwnerId ?? SESSION_ID,
      sidePaneOwnerId: options?.sidePaneOwnerId ?? SESSION_ID,
      isDesktop: true,
      isWorkspaceVisible: true,
      supportsEmbeddedBrowser: options?.supportsEmbeddedBrowser ?? true,
      defaultWhiteboardNamePrefix: "Whiteboard",
    }),
  );
}

function artifactRequest(
  overrides: Partial<OpenScopedWorkflowArtifactSideTabRequest> = {},
): OpenScopedWorkflowArtifactSideTabRequest {
  return {
    workspacePath: WORKSPACE_PATH,
    parentSessionId: SESSION_ID,
    runId: "run-1",
    artifactId: "report",
    contentType: "text/html",
    ...overrides,
  };
}

function journalResult(sourcePath?: string): V4ConversationWorkflowRunArtifactsResult {
  return {
    artifacts: [
      {
        id: "report",
        kind: "file",
        contentType: "text/html",
        version: 1,
        versions: [{ version: 1, publishedAt: 1, ...(sourcePath ? { sourcePath } : {}) }],
        itemCount: 0,
        ...(sourcePath ? { sourcePath } : {}),
      },
    ],
  };
}

function tabTypes(tabs: WorkspaceSidePaneTab[] | undefined): string[] {
  return (tabs ?? []).map((tab) => tab.type);
}

/** hook 内部的 journal 查询是 fire-and-forget 的 async IIFE，要把微任务跑干净。 */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("产物落点判据", () => {
  it("只有 html + 本地 workspace + 有内嵌浏览器三条同时成立才直开", () => {
    const base = { contentType: "text/html", supportsEmbeddedBrowser: true };
    expect(shouldOpenWorkflowArtifactInBrowser(base)).toBe(true);
    expect(shouldOpenWorkflowArtifactInBrowser({ ...base, contentType: "text/markdown" })).toBe(
      false,
    );
    // 参数化的 content type 走产物 tab：与画 html 卡那道门同一个严格判据。
    expect(
      shouldOpenWorkflowArtifactInBrowser({ ...base, contentType: "text/html; charset=utf-8" }),
    ).toBe(false);
    expect(shouldOpenWorkflowArtifactInBrowser({ supportsEmbeddedBrowser: true })).toBe(false);
    expect(shouldOpenWorkflowArtifactInBrowser({ ...base, supportsEmbeddedBrowser: false })).toBe(
      false,
    );
    expect(
      shouldOpenWorkflowArtifactInBrowser({ ...base, workspaceIdentity: "ssh://host/repo" }),
    ).toBe(false);
    // 空白 identity 不算远程（与 canRevealArtifactInWorkspace 同源）。
    expect(shouldOpenWorkflowArtifactInBrowser({ ...base, workspaceIdentity: "  " })).toBe(true);
    expect(shouldOpenWorkflowArtifactInBrowser({ ...base, remoteSessionId: "remote-a" })).toBe(
      false,
    );
  });
});

describe("useAppPanels 打开工作流产物", () => {
  beforeEach(() => {
    clearTaskSidePaneMemoryStateForTest();
    conversationWorkflowRunArtifactsV4.mockReset();
  });

  it("html 产物直接开 browser tab，不再开产物 tab", async () => {
    conversationWorkflowRunArtifactsV4.mockResolvedValue(
      journalResult(".zcode/workflow-runs/run-1/report.html"),
    );
    const { result, unmount } = renderPanels();

    act(() => {
      result.current.handleOpenWorkflowArtifact(artifactRequest());
    });
    await flush();

    const tabs = result.current.sidePaneState?.tabs ?? [];
    expect(tabTypes(tabs)).toEqual(["browser"]);
    const tab = tabs[0];
    expect(tab?.type === "browser" ? tab.initialUrl : null).toBe(REPORT_URL);
    expect(result.current.sidePaneState?.activeTabId).toBe(tab?.id);
    expect(result.current.isSidePaneCollapsed).toBe(false);
    expect(result.current.browserNavigationRequest).toMatchObject({
      targetTabId: tab?.id,
      url: REPORT_URL,
    });
    expect(conversationWorkflowRunArtifactsV4).toHaveBeenCalledWith({
      workspacePath: WORKSPACE_PATH,
      sessionId: SESSION_ID,
      runId: "run-1",
    });
    unmount();
  });

  it("再点一次复用同一个 browser tab，并重新发导航请求", async () => {
    conversationWorkflowRunArtifactsV4.mockResolvedValue(
      journalResult(".zcode/workflow-runs/run-1/report.html"),
    );
    const { result, unmount } = renderPanels();

    act(() => {
      result.current.handleOpenWorkflowArtifact(artifactRequest());
    });
    await flush();
    const firstTabId = result.current.sidePaneState?.tabs[0]?.id;
    const firstRequestId = result.current.browserNavigationRequest?.id;

    // 中间切走，确认第二次点击会把它重新激活。
    act(() => {
      result.current.handleOpenGit();
    });
    act(() => {
      result.current.handleOpenWorkflowArtifact(artifactRequest());
    });
    await flush();

    const tabs = result.current.sidePaneState?.tabs ?? [];
    expect(tabs.filter((tab) => tab.type === "browser")).toHaveLength(1);
    expect(tabs[0]?.id).toBe(firstTabId);
    expect(result.current.sidePaneState?.activeTabId).toBe(firstTabId);
    // 同一个落点、新的请求 id：v2 重新发布后 webview 必须重新取字节。
    expect(result.current.browserNavigationRequest?.targetTabId).toBe(firstTabId);
    expect(result.current.browserNavigationRequest?.id).not.toBe(firstRequestId);
    expect(result.current.browserNavigationRequest?.url).toBe(REPORT_URL);
    unmount();
  });

  it("远程 workspace 的 html 产物仍开产物 tab", async () => {
    const { result, unmount } = renderPanels();

    act(() => {
      result.current.handleOpenWorkflowArtifact(
        artifactRequest({ workspaceIdentity: "ssh://host/repo" }),
      );
    });
    await flush();

    expect(tabTypes(result.current.sidePaneState?.tabs)).toEqual(["workflow-artifact"]);
    expect(conversationWorkflowRunArtifactsV4).not.toHaveBeenCalled();
    unmount();
  });

  it("手机远控（remoteSessionId）的 html 产物仍开产物 tab", async () => {
    const { result, unmount } = renderPanels();

    act(() => {
      result.current.handleOpenWorkflowArtifact(artifactRequest({ remoteSessionId: "remote-a" }));
    });
    await flush();

    expect(tabTypes(result.current.sidePaneState?.tabs)).toEqual(["workflow-artifact"]);
    expect(conversationWorkflowRunArtifactsV4).not.toHaveBeenCalled();
    unmount();
  });

  it("没有内嵌浏览器的壳层仍开产物 tab", async () => {
    const { result, unmount } = renderPanels({ supportsEmbeddedBrowser: false });

    act(() => {
      result.current.handleOpenWorkflowArtifact(artifactRequest());
    });
    await flush();

    expect(tabTypes(result.current.sidePaneState?.tabs)).toEqual(["workflow-artifact"]);
    expect(conversationWorkflowRunArtifactsV4).not.toHaveBeenCalled();
    unmount();
  });

  it("非 html 与 contentType 缺席都开产物 tab，且不查 journal", async () => {
    const { result, unmount } = renderPanels();

    act(() => {
      result.current.handleOpenWorkflowArtifact(
        artifactRequest({ artifactId: "notes", contentType: "text/markdown" }),
      );
    });
    act(() => {
      result.current.handleOpenWorkflowArtifact(
        artifactRequest({ artifactId: "legacy", contentType: undefined }),
      );
    });
    await flush();

    expect(tabTypes(result.current.sidePaneState?.tabs)).toEqual([
      "workflow-artifact",
      "workflow-artifact",
    ]);
    expect(conversationWorkflowRunArtifactsV4).not.toHaveBeenCalled();
    unmount();
  });

  it("journal 查询失败时退回产物 tab", async () => {
    conversationWorkflowRunArtifactsV4.mockRejectedValue(new Error("capabilityUnsupported"));
    const { result, unmount } = renderPanels();

    act(() => {
      result.current.handleOpenWorkflowArtifact(artifactRequest());
    });
    await flush();

    expect(tabTypes(result.current.sidePaneState?.tabs)).toEqual(["workflow-artifact"]);
    expect(result.current.browserNavigationRequest).toBeNull();
    unmount();
  });

  it("产物没有工作区出处时退回产物 tab", async () => {
    conversationWorkflowRunArtifactsV4.mockResolvedValue(journalResult(undefined));
    const { result, unmount } = renderPanels();

    act(() => {
      result.current.handleOpenWorkflowArtifact(artifactRequest());
    });
    await flush();

    expect(tabTypes(result.current.sidePaneState?.tabs)).toEqual(["workflow-artifact"]);
    expect(result.current.browserNavigationRequest).toBeNull();
    unmount();
  });

  it("中枢那条路径上 owner ref 还没追上时，browser tab 仍归属目标会话", async () => {
    // handleOpenSavedWorkflowArtifact 在同一个同步块里先 handleSelectTaskInChat 再开产物，
    // 所以点击时 sidePaneOwnerId 还停在上一条会话上。browser tab 的可见性按 ownerTaskId
    // 收窄，盖成旧会话的话切换落定后这个 tab 就消失了。
    const { result, unmount } = renderPanels({ sidePaneOwnerId: "sess-previous" });

    act(() => {
      result.current.handleOpenWorkflowArtifact(
        artifactRequest({ sourcePath: ".zcode/workflow-runs/run-1/report.html" }),
      );
    });
    await flush();

    const tabs = result.current.sidePaneState?.tabs ?? [];
    expect(tabTypes(tabs)).toEqual(["browser"]);
    expect(tabs[0]).toMatchObject({ ownerTaskId: SESSION_ID, workspaceKey: WORKSPACE_PATH });
    // 切换落定后（scope = 目标会话）这个 tab 必须还在可见集合里。
    expect(
      getVisibleSidePaneTabs(tabs, {
        workspaceKey: WORKSPACE_PATH,
        ownerTaskId: SESSION_ID,
      }).map((tab) => tab.id),
    ).toEqual([tabs[0]?.id]);
    expect(result.current.sidePaneState?.activeTabId).toBe(tabs[0]?.id);
    unmount();
  });

  it("请求自带 sourcePath 时不查 journal", async () => {
    const { result, unmount } = renderPanels();

    act(() => {
      result.current.handleOpenWorkflowArtifact(
        artifactRequest({ sourcePath: ".zcode/workflow-runs/run-1/report.html" }),
      );
    });
    await flush();

    expect(tabTypes(result.current.sidePaneState?.tabs)).toEqual(["browser"]);
    const tab = result.current.sidePaneState?.tabs[0];
    expect(tab?.type === "browser" ? tab.initialUrl : null).toBe(REPORT_URL);
    expect(conversationWorkflowRunArtifactsV4).not.toHaveBeenCalled();
    unmount();
  });
});
