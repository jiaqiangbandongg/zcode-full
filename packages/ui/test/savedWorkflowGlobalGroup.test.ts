// @vitest-environment jsdom
// 全局工作流组（docs/dynamic-workflow/launch.md）：顶部固定「全局」组，空也显示；载体走
// useServices().zcodeAgentService，RPC 带 { scope: "global" }。卡片 / 实参窗 / 移动窗 / 详情页换桩，
// 只看组的状态流与全局语义（运行带 scope、修订 / 创建落到本地项目、移到项目、-32602 提示、运行行项目列）。
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
  TID_WORKFLOW_GLOBAL_GROUP,
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
const fileWatcherService = {
  watch: vi.fn(async () => ({ id: "watch-1" })),
  onDynamicChange: vi.fn(() => () => ({ dispose: vi.fn() })),
  unwatch: vi.fn(async () => {}),
};

const listResult: { current: ZCodeWorkflowsListResult | (() => never) } = {
  current: { workflows: [], invalid: [], dir: "/home/.zcode/workflows" },
};
const runsResult: { current: ZCodeSavedWorkflowRun[] } = { current: [] };
const agent = {
  listSavedWorkflows: vi.fn(async () => {
    const value = listResult.current;
    if (typeof value === "function") return value();
    return value;
  }),
  listSavedWorkflowRuns: vi.fn(async () => ({ runs: runsResult.current })),
  deleteSavedWorkflow: vi.fn(async () => ({
    ok: true as const,
    path: "/home/.zcode/workflows/x.dwf.ts",
  })),
  moveSavedWorkflow: vi.fn(async () => ({
    ok: true as const,
    from: "/home/.zcode/workflows/x.dwf.ts",
    to: "/a/.zcode/workflows/x.dwf.ts",
  })),
  getSavedWorkflow: vi.fn(),
  updateSavedWorkflowMeta: vi.fn(),
};

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ zcodeAgentService: agent, fileWatcherService }),
}));
vi.mock("@/hooks/useConfirmDialog.js", () => ({ useConfirmDialog: () => confirmMock }));
vi.mock("@/components/ui/toast.js", () => ({ toast: (...args: unknown[]) => toastMock(...args) }));
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: unknown }) => children,
}));

vi.mock("@/settings/saved-workflows/SavedWorkflowCard.js", () => ({
  SavedWorkflowCard: ({
    entry,
    onOpen,
    onRun,
    onRevise,
    onMove,
    onDelete,
  }: {
    entry: ZCodeSavedWorkflowEntry;
    onOpen: (entry: ZCodeSavedWorkflowEntry) => void;
    onRun: (entry: ZCodeSavedWorkflowEntry) => void;
    onRevise: (entry: ZCodeSavedWorkflowEntry) => void;
    onMove?: (entry: ZCodeSavedWorkflowEntry) => void;
    onDelete: (entry: ZCodeSavedWorkflowEntry) => void;
  }) =>
    createElement(
      "div",
      { "data-testid": testId(TID_WORKFLOW_CARD, entry.name) },
      entry.name,
      createElement(
        "button",
        { type: "button", "data-testid": `open-${entry.name}`, onClick: () => onOpen(entry) },
        "open",
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
      createElement(
        "button",
        { type: "button", "data-testid": `revise-${entry.name}`, onClick: () => onRevise(entry) },
        "revise",
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

// 直接启动器换桩：组只负责按类型开窗 / 直发；launch 编排与导航由 useSavedWorkflowLauncher 单测覆盖。
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

vi.mock("@/settings/saved-workflows/SavedWorkflowLaunchDialog.js", () => ({
  SavedWorkflowLaunchDialog: ({
    entry,
    targets,
    defaultTargetKey,
    onSubmit,
  }: {
    entry: ZCodeSavedWorkflowEntry | null;
    targets?: readonly AutomationWorkspaceOption[];
    defaultTargetKey?: string | null;
    onSubmit: (
      entry: ZCodeSavedWorkflowEntry,
      args: Record<string, unknown>,
      target?: AutomationWorkspaceOption,
    ) => void;
  }) =>
    entry
      ? createElement(
          "div",
          {
            "data-testid": "launch-dialog",
            "data-targets": (targets ?? []).map((t) => t.workspacePath).join(","),
            "data-default": defaultTargetKey ?? "",
          },
          createElement(
            "button",
            {
              type: "button",
              "data-testid": "launch-submit",
              onClick: () => onSubmit(entry, {}, targets?.[0]),
            },
            "go",
          ),
        )
      : null,
}));

vi.mock("@/settings/saved-workflows/SavedWorkflowMoveDialog.js", () => ({
  SavedWorkflowMoveDialog: ({
    open,
    targets,
    onSubmit,
  }: {
    open: boolean;
    targets: readonly AutomationWorkspaceOption[];
    onSubmit: (target: AutomationWorkspaceOption) => void;
  }) =>
    open
      ? createElement(
          "div",
          { "data-testid": "move-dialog" },
          createElement(
            "button",
            {
              type: "button",
              "data-testid": "move-submit",
              onClick: () => targets[0] && onSubmit(targets[0]),
            },
            "move",
          ),
        )
      : null,
}));

vi.mock("@/settings/saved-workflows/SavedWorkflowDetailView.js", () => ({
  SavedWorkflowDetailView: ({
    name,
    projectLabel,
    runs,
    resolveRunProject,
    onMove,
  }: {
    name: string;
    projectLabel: string;
    runs: readonly ZCodeSavedWorkflowRun[];
    resolveRunProject?: (run: ZCodeSavedWorkflowRun) => { label: string; canOpen: boolean } | null;
    onMove?: () => void;
  }) =>
    createElement(
      "div",
      { "data-testid": TID_WORKFLOW_DETAIL, "data-name": name, "data-project": projectLabel },
      ...runs.map((run) => {
        const project = resolveRunProject ? resolveRunProject(run) : null;
        return createElement("div", {
          key: run.runId,
          "data-testid": `run-${run.runId}`,
          "data-run-project": project?.label ?? "",
          "data-run-canopen": project?.canOpen ? "yes" : "no",
        });
      }),
      createElement(
        "button",
        { type: "button", "data-testid": "detail-move", onClick: () => onMove?.() },
        "move",
      ),
    ),
}));

const { SavedWorkflowGlobalGroup } =
  await import("@/settings/saved-workflows/SavedWorkflowGlobalGroup.js");

function entry(
  name: string,
  overrides: Partial<ZCodeSavedWorkflowEntry> = {},
): ZCodeSavedWorkflowEntry {
  return {
    name,
    description: `${name} 的说明`,
    scope: "global",
    path: `/home/.zcode/workflows/${name}.dwf.ts`,
    ...overrides,
  };
}
const ALPHA: AutomationWorkspaceOption = { workspacePath: "/a", label: "Alpha" };
const keyOfA = "/a";

function mount(props: Partial<Parameters<typeof SavedWorkflowGlobalGroup>[0]> = {}) {
  const onNavigateToLaunchedRun = vi.fn();
  const onCreateViaChat = vi.fn();
  const onOpenWorkflowRun = vi.fn();
  const onStateChange = vi.fn();
  const onOpenDetail = vi.fn();
  const onBack = vi.fn();
  const onMoved = vi.fn();
  const utils = render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(SavedWorkflowGlobalGroup, {
        refreshSeq: 0,
        mode: { kind: "list" },
        onStateChange,
        onOpenDetail,
        onBack,
        onNavigateToLaunchedRun,
        onCreateViaChat,
        onOpenWorkflowRun,
        localProjects: [ALPHA],
        activeProjectKey: keyOfA,
        onMoved,
        ...props,
      }),
    ),
  );
  return {
    ...utils,
    onNavigateToLaunchedRun,
    onCreateViaChat,
    onOpenWorkflowRun,
    onStateChange,
    onOpenDetail,
    onBack,
    onMoved,
  };
}

describe("SavedWorkflowGlobalGroup", () => {
  beforeEach(() => {
    resetSavedWorkflowStoreForTests();
    listResult.current = { workflows: [], invalid: [], dir: "/home/.zcode/workflows" };
    runsResult.current = [];
    vi.clearAllMocks();
    confirmMock.mockResolvedValue(true);
  });
  afterEach(() => {
    cleanup();
  });

  it("空也渲染：头行「全局」+ 副标 +「通过对话创建」，正文一行空态；回报 { loaded:true, empty:true }", async () => {
    const { onStateChange } = mount();
    await screen.findByTestId(TID_WORKFLOW_GLOBAL_GROUP);
    expect(screen.getByText("全局")).toBeTruthy();
    expect(screen.getByText("对所有项目可见")).toBeTruthy();
    expect(screen.getByTestId(testId(TID_WORKFLOWS_CREATE_VIA_CHAT, "global"))).toBeTruthy();
    expect(screen.getByText(/还没有全局工作流/)).toBeTruthy();
    await waitFor(() =>
      expect(onStateChange).toHaveBeenLastCalledWith("global", {
        loaded: true,
        empty: true,
        count: 0,
      }),
    );
    // RPC 带 scope: "global"（无 workspace）
    expect(agent.listSavedWorkflows).toHaveBeenCalledWith({ scope: "global" });
    expect(agent.listSavedWorkflowRuns).toHaveBeenCalledWith({ scope: "global", limit: 50 });
  });

  it("有货：列出卡片，头行数量；运行始终弹实参窗，提交带 scope:global 的文案与选中项目", async () => {
    listResult.current = {
      workflows: [entry("research")],
      invalid: [],
      dir: "/home/.zcode/workflows",
    };
    mount();
    await screen.findByTestId(testId(TID_WORKFLOWS_LIST, "global"));
    // 无实参也弹窗
    fireEvent.click(screen.getByTestId(testId(TID_WORKFLOW_CARD_RUN, "research")));
    const dialog = await screen.findByTestId("launch-dialog");
    expect(dialog.getAttribute("data-targets")).toBe("/a");
    expect(dialog.getAttribute("data-default")).toBe(keyOfA);
    fireEvent.click(screen.getByTestId("launch-submit"));
    await waitFor(() => expect(launchMock).toHaveBeenCalledTimes(1));
    // 全局档直接启动：目标 = 选中的「运行于」项目，scope = global。
    expect(launchMock.mock.calls[0]?.[0]).toEqual({ workspacePath: "/a" });
    expect(launchMock.mock.calls[0]?.[1]).toEqual({ name: "research", scope: "global", args: {} });
  });

  it("「通过对话创建」落到活动本地项目，文案为全局；修订同理", async () => {
    listResult.current = {
      workflows: [entry("research")],
      invalid: [],
      dir: "/home/.zcode/workflows",
    };
    const { onCreateViaChat } = mount();
    await screen.findByTestId(testId(TID_WORKFLOW_CARD, "research"));
    fireEvent.click(screen.getByTestId(testId(TID_WORKFLOWS_CREATE_VIA_CHAT, "global")));
    expect(onCreateViaChat.mock.calls[0]?.[1]).toEqual({ workspacePath: "/a" });
    expect(onCreateViaChat.mock.calls[0]?.[0]).toContain('scope: "global"');

    fireEvent.click(screen.getByTestId("revise-research"));
    expect(onCreateViaChat.mock.calls[1]?.[0]).toContain("请修订已保存的工作流");
    expect(onCreateViaChat.mock.calls[1]?.[1]).toEqual({ workspacePath: "/a" });
  });

  it("没有本地项目时：创建按钮禁用，运行提交无 target 不发起", async () => {
    listResult.current = {
      workflows: [entry("research")],
      invalid: [],
      dir: "/home/.zcode/workflows",
    };
    const { onCreateViaChat } = mount({ localProjects: [], activeProjectKey: null });
    await screen.findByTestId(testId(TID_WORKFLOW_CARD, "research"));
    expect(
      (screen.getByTestId(testId(TID_WORKFLOWS_CREATE_VIA_CHAT, "global")) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByTestId(testId(TID_WORKFLOW_CARD_RUN, "research")));
    fireEvent.click(await screen.findByTestId("launch-submit")); // targets 为空，target undefined
    expect(launchMock).not.toHaveBeenCalled();
    expect(onCreateViaChat).not.toHaveBeenCalled();
  });

  it("删除：确认后带 scope:global 调 delete 并 toast", async () => {
    listResult.current = {
      workflows: [entry("research")],
      invalid: [],
      dir: "/home/.zcode/workflows",
    };
    mount();
    await screen.findByTestId(testId(TID_WORKFLOW_CARD, "research"));
    fireEvent.click(screen.getByTestId(testId(TID_WORKFLOW_ACTION_DELETE, "research")));
    await waitFor(() =>
      expect(agent.deleteSavedWorkflow).toHaveBeenCalledWith({ scope: "global", name: "research" }),
    );
    expect(toastMock).toHaveBeenCalledWith("已删除工作流「research」");
  });

  it("移到项目：move 窗提交 → move(目标项目, 无 to) 成功 toast + onMoved", async () => {
    listResult.current = {
      workflows: [entry("research")],
      invalid: [],
      dir: "/home/.zcode/workflows",
    };
    const { onMoved } = mount();
    await screen.findByTestId(testId(TID_WORKFLOW_CARD, "research"));
    fireEvent.click(screen.getByTestId(testId(TID_WORKFLOW_ACTION_MOVE, "research")));
    fireEvent.click(await screen.findByTestId("move-submit"));
    await waitFor(() =>
      expect(agent.moveSavedWorkflow).toHaveBeenCalledWith({
        workspacePath: "/a",
        name: "research",
      }),
    );
    await waitFor(() => expect(onMoved).toHaveBeenCalledTimes(1));
    expect(toastMock).toHaveBeenCalledWith("已移到 Alpha");
  });

  it("移到项目：target_exists → toast 目标已有同名，不 onMoved", async () => {
    listResult.current = {
      workflows: [entry("research")],
      invalid: [],
      dir: "/home/.zcode/workflows",
    };
    agent.moveSavedWorkflow.mockResolvedValueOnce({
      ok: false as const,
      reason: "target_exists" as const,
    } as never);
    const { onMoved } = mount();
    await screen.findByTestId(testId(TID_WORKFLOW_CARD, "research"));
    fireEvent.click(screen.getByTestId(testId(TID_WORKFLOW_ACTION_MOVE, "research")));
    fireEvent.click(await screen.findByTestId("move-submit"));
    await waitFor(() => expect(agent.moveSavedWorkflow).toHaveBeenCalledTimes(1));
    expect(toastMock).toHaveBeenCalledWith("目标位置已有同名工作流");
    expect(onMoved).not.toHaveBeenCalled();
  });

  it("详情：projectLabel=「全局」，运行行项目列——cwd 命中本地项目→label 可开，否则 basename 不可开", async () => {
    listResult.current = {
      workflows: [entry("research")],
      invalid: [],
      dir: "/home/.zcode/workflows",
    };
    runsResult.current = [
      {
        runId: "r-a",
        name: "research",
        status: "completed",
        createdAt: 1,
        updatedAt: 2,
        spentTokens: 0,
        cwd: "/a",
        parentSessionId: "s1",
        toolCallId: "t1",
      },
      {
        runId: "r-x",
        name: "research",
        status: "completed",
        createdAt: 3,
        updatedAt: 4,
        spentTokens: 0,
        cwd: "/somewhere/other",
      },
    ];
    mount({ mode: { kind: "detail", name: "research" } });
    const detail = await screen.findByTestId(TID_WORKFLOW_DETAIL);
    expect(detail.getAttribute("data-project")).toBe("全局");
    await waitFor(() => expect(screen.getByTestId("run-r-a")).toBeTruthy());
    expect(screen.getByTestId("run-r-a").getAttribute("data-run-project")).toBe("Alpha");
    expect(screen.getByTestId("run-r-a").getAttribute("data-run-canopen")).toBe("yes");
    expect(screen.getByTestId("run-r-x").getAttribute("data-run-project")).toBe("other");
    expect(screen.getByTestId("run-r-x").getAttribute("data-run-canopen")).toBe("no");
  });

  it("旧 agent 不支持（-32602）：正文显示「当前 agent 不支持全局工作流」", async () => {
    listResult.current = () => {
      throw Object.assign(new Error("Invalid params"), { code: -32602 });
    };
    mount();
    await waitFor(() => expect(screen.getByText(/当前 agent 不支持全局工作流/)).toBeTruthy());
  });
});
