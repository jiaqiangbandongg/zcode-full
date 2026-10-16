// @vitest-environment jsdom
// 单项目工作流组（docs/dynamic-workflow/launch.md「Groups」「目录监听」「删除」「运行发起」）。
// 迁移自 v1 单项目 section 的用例；卡片与详情页各有自己的用例，这里换桩，只看组的状态流与
// **本项目**的 target（不变式 8）。useWorkspaceServices 按 workspacePath 返回不同 agent，钉住
// 组用的是 ITS project 而不是活动 workspace。
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TID_WORKFLOWS_CREATE_VIA_CHAT,
  TID_WORKFLOWS_LIST,
  TID_WORKFLOW_ACTION_DELETE,
  TID_WORKFLOW_ACTION_MOVE,
  TID_WORKFLOW_CARD,
  TID_WORKFLOW_CARD_RUN,
  TID_WORKFLOW_DETAIL,
  TID_WORKFLOW_PROJECT_GROUP,
  testId,
  type ZCodeSavedWorkflowEntry,
  type ZCodeSavedWorkflowRun,
  type ZCodeWorkflowsListResult,
} from "@zcode/shared";
import type { AutomationWorkspaceOption } from "@/settings/automationWorkspaceOptions.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { resetSavedWorkflowStoreForTests } from "@/store/savedWorkflowStore.js";

const confirmMock = vi.fn(async () => true);
const toastMock = vi.fn();
let changeListener: (() => void) | null = null;
const watcherDispose = vi.fn();
const fileWatcherService = {
  watch: vi.fn(async () => ({ id: "watch-1" })),
  onDynamicChange: vi.fn(() => (listener: () => void) => {
    changeListener = listener;
    return { dispose: watcherDispose };
  }),
  unwatch: vi.fn(async () => {}),
};

function makeAgent() {
  const listResult: { current: ZCodeWorkflowsListResult } = {
    current: { workflows: [], invalid: [], dir: "/beta/.zcode/workflows" },
  };
  const runsResult: { current: ZCodeSavedWorkflowRun[] } = { current: [] };
  const agent = {
    listResult,
    runsResult,
    listSavedWorkflows: vi.fn(async () => listResult.current),
    listSavedWorkflowRuns: vi.fn(async () => ({ runs: runsResult.current })),
    deleteSavedWorkflow: vi.fn(async () => ({
      ok: true as const,
      path: "/beta/.zcode/workflows/x.dwf.ts",
    })),
    getSavedWorkflow: vi.fn(),
    updateSavedWorkflowMeta: vi.fn(),
  };
  return agent;
}
const agentBeta = makeAgent();
const agentRepo = makeAgent();
const agentByPath: Record<string, ReturnType<typeof makeAgent>> = {
  "/beta": agentBeta,
  "/repo": agentRepo,
};

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServicesResolution: (workspacePath: string) => ({
    services: { zcodeAgentService: agentByPath[workspacePath] ?? agentRepo, fileWatcherService },
    remoteSessionId: null,
    isRemoteTarget: false,
    connectionKind: "local-ready" as const,
    rpcReady: true,
  }),
}));
vi.mock("@/hooks/useConfirmDialog.js", () => ({ useConfirmDialog: () => confirmMock }));
vi.mock("@/components/ui/toast.js", () => ({ toast: (...args: unknown[]) => toastMock(...args) }));
// 直接启动器换桩：组只负责按类型开窗 / 直发；launch 的 createSession→startSavedWorkflow 编排
// 与导航由 useSavedWorkflowLauncher 单测覆盖，这里只断言组以正确 target + request 调它。
const launchMock = vi.fn(async () => ({
  ok: true as const,
  sessionId: "s-1",
  runId: "r-1",
  toolCallId: "launch-1",
}));
const clearErrorMock = vi.fn();
vi.mock("@/settings/saved-workflows/useSavedWorkflowLauncher.js", () => ({
  useSavedWorkflowLauncher: () => ({
    launch: launchMock,
    pending: false,
    error: null,
    clearError: clearErrorMock,
  }),
}));
// 「提升为全局」编排换桩：createSession(firstInput) 与导航由 useSavedWorkflowPromote 单测覆盖，
// 这里只断言组以本项目 target + 名字 / 路径 / locale 调它，失败时 toast。
const promoteMock = vi.fn(async () => ({ ok: true as const, sessionId: "s-p" }));
vi.mock("@/settings/saved-workflows/useSavedWorkflowPromote.js", () => ({
  useSavedWorkflowPromote: () => ({ promote: promoteMock, pending: false }),
}));
vi.mock("@/settings/saved-workflows/SavedWorkflowCard.js", () => ({
  SavedWorkflowCard: ({
    entry,
    lastRun,
    onOpen,
    onRun,
    onRevise,
    onMove,
    onDelete,
  }: {
    entry: ZCodeSavedWorkflowEntry;
    lastRun: ZCodeSavedWorkflowRun | undefined;
    onOpen: (entry: ZCodeSavedWorkflowEntry) => void;
    onRun: (entry: ZCodeSavedWorkflowEntry) => void;
    onRevise: (entry: ZCodeSavedWorkflowEntry) => void;
    onMove?: (entry: ZCodeSavedWorkflowEntry) => void;
    onDelete: (entry: ZCodeSavedWorkflowEntry) => void;
  }) =>
    createElement(
      "div",
      {
        "data-testid": testId(TID_WORKFLOW_CARD, entry.name),
        "data-last-run": lastRun?.runId ?? "",
      },
      entry.name,
      createElement("button", { type: "button", onClick: () => onOpen(entry) }, "open"),
      createElement(
        "button",
        { type: "button", onClick: () => onRevise(entry), "data-testid": `revise-${entry.name}` },
        "revise",
      ),
      createElement(
        "button",
        {
          type: "button",
          "data-testid": testId(TID_WORKFLOW_CARD_RUN, entry.name),
          onClick: () => onRun(entry),
        },
        "run",
      ),
      onMove
        ? createElement(
            "button",
            {
              type: "button",
              "data-testid": testId(TID_WORKFLOW_ACTION_MOVE, entry.name),
              onClick: () => onMove(entry),
            },
            "move",
          )
        : null,
      createElement(
        "button",
        {
          type: "button",
          "data-testid": testId(TID_WORKFLOW_ACTION_DELETE, entry.name),
          onClick: () => onDelete(entry),
        },
        "delete",
      ),
    ),
}));
vi.mock("@/settings/saved-workflows/SavedWorkflowDetailView.js", () => ({
  SavedWorkflowDetailView: ({
    name,
    projectLabel,
    onBack,
  }: {
    name: string;
    projectLabel: string;
    onBack: () => void;
  }) =>
    createElement(
      "div",
      { "data-testid": TID_WORKFLOW_DETAIL, "data-name": name, "data-project": projectLabel },
      createElement("button", { type: "button", onClick: onBack }, "back"),
    ),
}));

const { SavedWorkflowProjectGroup } =
  await import("@/settings/saved-workflows/SavedWorkflowProjectGroup.js");

function entry(
  name: string,
  overrides: Partial<ZCodeSavedWorkflowEntry> = {},
): ZCodeSavedWorkflowEntry {
  return {
    name,
    description: `${name} 的说明`,
    scope: "project",
    path: `/beta/.zcode/workflows/${name}.dwf.ts`,
    ...overrides,
  };
}

const BETA: AutomationWorkspaceOption = { workspacePath: "/beta", label: "Beta" };

function mount(props: Partial<Parameters<typeof SavedWorkflowProjectGroup>[0]> = {}) {
  const onNavigateToLaunchedRun = vi.fn();
  const onCreateViaChat = vi.fn();
  const onOpenWorkflowRun = vi.fn();
  const onStateChange = vi.fn();
  const onOpenDetail = vi.fn();
  const onBack = vi.fn();
  const result = render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(SavedWorkflowProjectGroup, {
        project: BETA,
        isCurrent: false,
        refreshSeq: 0,
        mode: { kind: "list" },
        onStateChange,
        onOpenDetail,
        onBack,
        onNavigateToLaunchedRun,
        onCreateViaChat,
        onOpenWorkflowRun,
        ...props,
      }),
    ),
  );
  return {
    ...result,
    onNavigateToLaunchedRun,
    onCreateViaChat,
    onOpenWorkflowRun,
    onStateChange,
    onOpenDetail,
    onBack,
  };
}

describe("SavedWorkflowProjectGroup", () => {
  beforeEach(() => {
    resetSavedWorkflowStoreForTests();
    agentBeta.listResult.current = { workflows: [], invalid: [], dir: "/beta/.zcode/workflows" };
    agentBeta.runsResult.current = [];
    agentRepo.listResult.current = { workflows: [], invalid: [], dir: "/repo/.zcode/workflows" };
    agentRepo.runsResult.current = [];
    changeListener = null;
    vi.clearAllMocks();
    confirmMock.mockResolvedValue(true);
  });
  afterEach(() => {
    cleanup();
  });

  it("用 ITS project 的 agent 拉取，渲染卡片与上次运行归组；无实参「运行」直接发起并带本项目 target", async () => {
    agentBeta.listResult.current = {
      workflows: [entry("release-check"), entry("nightly")],
      invalid: [],
    };
    agentBeta.runsResult.current = [
      {
        runId: "r-old",
        name: "release-check",
        status: "failed",
        createdAt: 1,
        updatedAt: 2,
        spentTokens: 0,
      },
      {
        runId: "r-new",
        name: "release-check",
        status: "completed",
        createdAt: 3,
        updatedAt: 9,
        spentTokens: 0,
      },
    ];
    mount();
    await screen.findByTestId(testId(TID_WORKFLOWS_LIST, "/beta"));
    // 用的是 /beta 的 agent，不是 /repo
    expect(agentBeta.listSavedWorkflows).toHaveBeenCalledWith({ workspacePath: "/beta" });
    expect(agentRepo.listSavedWorkflows).not.toHaveBeenCalled();
    expect(agentBeta.listSavedWorkflowRuns).toHaveBeenCalledWith({
      workspacePath: "/beta",
      limit: 50,
    });
    expect(
      screen.getByTestId(testId(TID_WORKFLOW_CARD, "release-check")).getAttribute("data-last-run"),
    ).toBe("r-new");
    expect(
      screen.getByTestId(testId(TID_WORKFLOW_CARD, "nightly")).getAttribute("data-last-run"),
    ).toBe("");

    fireEvent.click(screen.getByTestId(testId(TID_WORKFLOW_CARD_RUN, "nightly")));
    await waitFor(() => expect(launchMock).toHaveBeenCalledTimes(1));
    // 无实参项目档：不弹窗，直发；带本项目 target + project scope + 空实参。
    expect(launchMock.mock.calls[0]?.[0]).toEqual({ workspacePath: "/beta" });
    expect(launchMock.mock.calls[0]?.[1]).toEqual({ name: "nightly", scope: "project", args: {} });
  });

  it("回报加载态给页：加载完成且有工作流 → { loaded:true, empty:false }", async () => {
    agentBeta.listResult.current = { workflows: [entry("a")], invalid: [] };
    const { onStateChange } = mount();
    await screen.findByTestId(testId(TID_WORKFLOW_CARD, "a"));
    await waitFor(() =>
      expect(onStateChange).toHaveBeenLastCalledWith("/beta", {
        loaded: true,
        empty: false,
        count: 1,
      }),
    );
  });

  it("空组：加载完成且无工作流无坏文件时渲染 null，但仍回报 { loaded:true, empty:true }", async () => {
    const { onStateChange, container } = mount();
    await waitFor(() =>
      expect(onStateChange).toHaveBeenLastCalledWith("/beta", {
        loaded: true,
        empty: true,
        count: 0,
      }),
    );
    expect(
      container.querySelector(`[data-testid="${testId(TID_WORKFLOW_PROJECT_GROUP, "/beta")}"]`),
    ).toBeNull();
  });

  it("坏文件条列出路径与原因，组仍出现", async () => {
    agentBeta.listResult.current = {
      workflows: [entry("ok")],
      invalid: [{ path: "/beta/.zcode/workflows/bad.dwf.ts", reason: "invalid_yaml" }],
    };
    const { container } = mount();
    await screen.findByTestId(testId(TID_WORKFLOW_CARD, "ok"));
    const strip = container.querySelector('[data-workflows-invalid="true"]');
    expect(strip?.textContent).toContain("1 个文件无法读取");
    expect(strip?.textContent).toContain("/beta/.zcode/workflows/bad.dwf.ts");
  });

  it("refreshSeq 变化时绕过缓存重拉；目录变更去抖后刷新；卸载拆监听", async () => {
    agentBeta.listResult.current = { workflows: [entry("a")], invalid: [] };
    const { rerender } = mount();
    await screen.findByTestId(testId(TID_WORKFLOW_CARD, "a"));
    expect(agentBeta.listSavedWorkflows).toHaveBeenCalledTimes(1);

    rerender(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(SavedWorkflowProjectGroup, {
          project: BETA,
          isCurrent: false,
          refreshSeq: 1,
          mode: { kind: "list" },
          onStateChange: vi.fn(),
          onOpenDetail: vi.fn(),
          onBack: vi.fn(),
          onNavigateToLaunchedRun: vi.fn(),
          onCreateViaChat: vi.fn(),
          onOpenWorkflowRun: vi.fn(),
        }),
      ),
    );
    await waitFor(() => expect(agentBeta.listSavedWorkflows).toHaveBeenCalledTimes(2));

    expect(fileWatcherService.watch).toHaveBeenCalledWith({ path: "/beta/.zcode/workflows" });
    await waitFor(() => expect(changeListener).not.toBeNull());
    changeListener?.();
    await waitFor(() => expect(agentBeta.listSavedWorkflows).toHaveBeenCalledTimes(3), {
      timeout: 2000,
    });
    cleanup();
    expect(watcherDispose).toHaveBeenCalled();
    expect(fileWatcherService.unwatch).toHaveBeenCalledWith({ id: "watch-1" });
  });

  it("删除：确认后带本项目 target 调 delete 并刷新；取消则不动", async () => {
    agentBeta.listResult.current = { workflows: [entry("x")], invalid: [] };
    mount();
    await screen.findByTestId(testId(TID_WORKFLOW_CARD, "x"));
    confirmMock.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByTestId(testId(TID_WORKFLOW_ACTION_DELETE, "x")));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(agentBeta.deleteSavedWorkflow).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId(testId(TID_WORKFLOW_ACTION_DELETE, "x")));
    await waitFor(() =>
      expect(agentBeta.deleteSavedWorkflow).toHaveBeenCalledWith({
        workspacePath: "/beta",
        name: "x",
      }),
    );
    expect(agentRepo.deleteSavedWorkflow).not.toHaveBeenCalled();
    await waitFor(() => expect(agentBeta.listSavedWorkflows).toHaveBeenCalledTimes(2));
    expect(toastMock).toHaveBeenCalledWith("已删除工作流「x」");
  });

  it("修订：带本项目 target 预填草稿", async () => {
    agentBeta.listResult.current = { workflows: [entry("x")], invalid: [] };
    const { onCreateViaChat } = mount();
    await screen.findByTestId(testId(TID_WORKFLOW_CARD, "x"));
    fireEvent.click(screen.getByTestId("revise-x"));
    expect(onCreateViaChat).toHaveBeenCalledTimes(1);
    expect(onCreateViaChat.mock.calls[0]?.[0]).toContain("请修订已保存的工作流「x」");
    expect(onCreateViaChat.mock.calls[0]?.[1]).toEqual({ workspacePath: "/beta" });
  });

  it("组头「通过对话创建」带 workspaceKey 的 test id 与本项目 target", async () => {
    agentBeta.listResult.current = { workflows: [entry("x")], invalid: [] };
    const { onCreateViaChat } = mount();
    await screen.findByTestId(testId(TID_WORKFLOW_CARD, "x"));
    fireEvent.click(screen.getByTestId(testId(TID_WORKFLOWS_CREATE_VIA_CHAT, "/beta")));
    expect(onCreateViaChat.mock.calls[0]?.[1]).toEqual({ workspacePath: "/beta" });
    expect(onCreateViaChat.mock.calls[0]?.[0]).toContain("帮我设计一个工作流");
  });

  // 「提升为全局」（docs/dynamic-workflow/launch.md「Promote to global」）：不搬文件，在本项目开
  // 新会话发概括提示。
  it("提升为全局：带本项目 target 与名字 / 路径 / locale 调 promote；不调 move、不 toast", async () => {
    agentBeta.listResult.current = {
      workflows: [entry("x")],
      invalid: [],
      dir: "/beta/.zcode/workflows",
    };
    mount();
    await screen.findByTestId(testId(TID_WORKFLOW_CARD, "x"));
    fireEvent.click(screen.getByTestId(testId(TID_WORKFLOW_ACTION_MOVE, "x")));
    await waitFor(() => expect(promoteMock).toHaveBeenCalledTimes(1));
    expect(promoteMock.mock.calls[0]?.[0]).toEqual({ workspacePath: "/beta" });
    expect(promoteMock.mock.calls[0]?.[1]).toEqual({
      name: "x",
      path: "/beta/.zcode/workflows/x.dwf.ts",
      locale: "zh-CN",
    });
    expect(toastMock).not.toHaveBeenCalled();
    // 列表不重拉：源文件没动，全局档由模型另存后靠全局组的目录监听出现。
    expect(agentBeta.listSavedWorkflows).toHaveBeenCalledTimes(1);
  });

  it("提升为全局：createSession 被拒 → toast 提升失败（带服务端原因）", async () => {
    agentBeta.listResult.current = {
      workflows: [entry("x")],
      invalid: [],
      dir: "/beta/.zcode/workflows",
    };
    promoteMock.mockResolvedValueOnce({
      ok: false,
      code: "fault.command.workspaceReadOnly",
      message: "workspace is read-only",
    } as never);
    mount();
    await screen.findByTestId(testId(TID_WORKFLOW_CARD, "x"));
    fireEvent.click(screen.getByTestId(testId(TID_WORKFLOW_ACTION_MOVE, "x")));
    await waitFor(() => expect(promoteMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith("提升失败：workspace is read-only"));
  });

  it("远程项目不提供「提升为全局」（不变式 4：远端 home 不进中枢）", async () => {
    agentBeta.listResult.current = {
      workflows: [entry("x")],
      invalid: [],
      dir: "/beta/.zcode/workflows",
    };
    mount({ project: { ...BETA, remoteSessionId: "remote-1" } });
    await screen.findByTestId(testId(TID_WORKFLOW_CARD, "x"));
    expect(screen.queryByTestId(testId(TID_WORKFLOW_ACTION_MOVE, "x"))).toBeNull();
  });

  it("点卡片进详情由页决定：onOpenDetail 带工作流名", async () => {
    agentBeta.listResult.current = { workflows: [entry("x")], invalid: [] };
    const { onOpenDetail } = mount();
    await screen.findByTestId(testId(TID_WORKFLOW_CARD, "x"));
    fireEvent.click(screen.getByText("open"));
    expect(onOpenDetail).toHaveBeenCalledWith("x");
  });

  it("detail 模式渲染 SavedWorkflowDetailView 并把项目名传给面包屑", async () => {
    agentBeta.listResult.current = { workflows: [entry("x")], invalid: [] };
    const { onBack } = mount({ mode: { kind: "detail", name: "x" } });
    const detail = await screen.findByTestId(TID_WORKFLOW_DETAIL);
    expect(detail.getAttribute("data-name")).toBe("x");
    expect(detail.getAttribute("data-project")).toBe("Beta");
    fireEvent.click(screen.getByText("back"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
