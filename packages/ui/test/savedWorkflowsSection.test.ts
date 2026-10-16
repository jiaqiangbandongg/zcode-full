// @vitest-environment jsdom
// 已保存工作流中枢「页」层（docs/dynamic-workflow/launch.md「The hub page」 + docs/dynamic-workflow/launch.md「Names and scopes」）：顶部固定「全局」组，
// 其下按已打开项目分组。两个组都换成桩——桩把 props.onStateChange 回报由可控 map 驱动、暴露按钮，
// 只看页层的组顺序、当前标记、总数（含全局）、空态（只看项目组）、spinner、刷新广播、详情态与深链。
import { createElement, useEffect, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TID_WORKFLOWS_CREATE_VIA_CHAT,
  TID_WORKFLOWS_EMPTY,
  TID_WORKFLOWS_OPEN_SETTINGS,
  TID_WORKFLOWS_REFRESH,
  applyDynamicWorkflowUserMode,
  createDynamicWorkflowClientConfig,
  TID_WORKFLOW_GLOBAL_GROUP,
  TID_WORKFLOW_PROJECT_GROUP,
  resolveWorkspaceKey,
  testId,
} from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  resetDynamicWorkflowAvailabilityStoreForTests,
  useDynamicWorkflowAvailabilityStore,
} from "@/store/dynamicWorkflowAvailabilityStore.js";
import type { AutomationWorkspaceOption } from "@/settings/automationWorkspaceOptions.js";
import type {
  SavedWorkflowGroupMode,
  SavedWorkflowGroupState,
} from "@/settings/saved-workflows/savedWorkflowContract.js";

interface FakeTab {
  id: string;
  kind: "workspace" | "settings";
  workspacePath: string;
  label: string;
  workspacePurpose?: string;
  availability?: string;
  remoteSessionId?: string;
}

const tabStoreState: {
  tabs: FakeTab[];
  activeWorkspacePath: string | null;
  activeWorkspaceIdentity: string | null;
  openSettingsTab: () => void;
} = {
  tabs: [],
  activeWorkspacePath: null,
  activeWorkspaceIdentity: null,
  openSettingsTab: () => {},
};
const settingsNavigation = vi.hoisted(() => ({ setPendingSettingsSectionIntent: vi.fn() }));
vi.mock("@/lib/settingsNavigation.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  setPendingSettingsSectionIntent: settingsNavigation.setPendingSettingsSectionIntent,
}));

vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: (selector: (state: typeof tabStoreState) => unknown) => selector(tabStoreState),
}));
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) => children,
}));

// 每个组的加载态由键（项目 workspacePath 或 "global"）索引，测试直接改这张表。
const groupReadiness: Record<string, SavedWorkflowGroupState> = {};

vi.mock("@/settings/saved-workflows/SavedWorkflowProjectGroup.js", () => ({
  SavedWorkflowProjectGroup: ({
    project,
    isCurrent,
    refreshSeq,
    mode,
    onStateChange,
    onOpenDetail,
    onNavigateToLaunchedRun,
    onCreateViaChat,
    onBack,
  }: {
    project: AutomationWorkspaceOption;
    isCurrent: boolean;
    refreshSeq: number;
    mode: SavedWorkflowGroupMode;
    onStateChange: (workspaceKey: string, state: SavedWorkflowGroupState) => void;
    onOpenDetail: (name: string) => void;
    onNavigateToLaunchedRun?: (target: unknown, sessionId: string) => void;
    onCreateViaChat?: (prompt: string, target: unknown) => void;
    onBack: () => void;
  }) => {
    const key = resolveWorkspaceKey({
      workspacePath: project.workspacePath,
      ...(project.workspaceIdentity ? { workspaceIdentity: project.workspaceIdentity } : {}),
    });
    const st = groupReadiness[project.workspacePath] ?? { loaded: false, empty: false, count: 0 };
    useEffect(() => {
      onStateChange(key, st);
    }, [key, onStateChange, refreshSeq, st.count, st.empty, st.loaded]);
    if (mode.kind === "list" && st.loaded && st.empty) return null;
    return createElement(
      "div",
      {
        "data-testid": testId(TID_WORKFLOW_PROJECT_GROUP, key),
        "data-current": isCurrent ? "true" : "false",
        "data-mode": mode.kind,
        "data-refresh": String(refreshSeq),
        "data-name": mode.kind === "detail" ? mode.name : "",
      },
      project.label,
      createElement(
        "button",
        {
          type: "button",
          "data-testid": `open-${project.workspacePath}`,
          onClick: () => onOpenDetail("wf-1"),
        },
        "open",
      ),
      createElement(
        "button",
        {
          type: "button",
          "data-testid": `launch-${project.workspacePath}`,
          onClick: () => onNavigateToLaunchedRun?.({ workspacePath: project.workspacePath }, "s-1"),
        },
        "launch",
      ),
      createElement(
        "button",
        {
          type: "button",
          "data-testid": `create-${project.workspacePath}`,
          onClick: () => onCreateViaChat?.("create", { workspacePath: project.workspacePath }),
        },
        "create",
      ),
      createElement(
        "button",
        { type: "button", "data-testid": `back-${project.workspacePath}`, onClick: onBack },
        "back",
      ),
    );
  },
}));

// 全局组桩：始终渲染（空也显示）；用 "global" 键回报状态；暴露 open / moved / back。
vi.mock("@/settings/saved-workflows/SavedWorkflowGlobalGroup.js", () => ({
  SavedWorkflowGlobalGroup: ({
    refreshSeq,
    mode,
    onStateChange,
    onOpenDetail,
    onMoved,
    onBack,
    localProjects,
    activeProjectKey,
  }: {
    refreshSeq: number;
    mode: SavedWorkflowGroupMode;
    onStateChange: (key: "global", state: SavedWorkflowGroupState) => void;
    onOpenDetail: (name: string) => void;
    onMoved: () => void;
    onBack: () => void;
    localProjects: readonly AutomationWorkspaceOption[];
    activeProjectKey: string | null;
  }) => {
    const st = groupReadiness.global ?? { loaded: false, empty: false, count: 0 };
    useEffect(() => {
      onStateChange("global", st);
    }, [onStateChange, refreshSeq, st.count, st.empty, st.loaded]);
    return createElement(
      "div",
      {
        "data-testid": TID_WORKFLOW_GLOBAL_GROUP,
        "data-mode": mode.kind,
        "data-refresh": String(refreshSeq),
        "data-name": mode.kind === "detail" ? mode.name : "",
        "data-local": localProjects.map((p) => p.workspacePath).join(","),
        "data-active": activeProjectKey ?? "",
      },
      "global",
      createElement(
        "button",
        { type: "button", "data-testid": "global-open", onClick: () => onOpenDetail("g-1") },
        "open",
      ),
      createElement(
        "button",
        { type: "button", "data-testid": "global-moved", onClick: onMoved },
        "moved",
      ),
      createElement(
        "button",
        { type: "button", "data-testid": "global-back", onClick: onBack },
        "back",
      ),
    );
  },
}));

const { SavedWorkflowsSection } =
  await import("@/settings/saved-workflows/SavedWorkflowsSection.js");

function workspaceTab(path: string, label: string, overrides: Partial<FakeTab> = {}): FakeTab {
  return { id: `t-${path}`, kind: "workspace", workspacePath: path, label, ...overrides };
}

function mount(props: Partial<Parameters<typeof SavedWorkflowsSection>[0]> = {}) {
  const onNavigateToLaunchedRun = vi.fn();
  const onCreateViaChat = vi.fn();
  const onOpenWorkflowRun = vi.fn();
  const utils = render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(SavedWorkflowsSection, {
        workspacePath: tabStoreState.activeWorkspacePath,
        onNavigateToLaunchedRun,
        onCreateViaChat,
        onOpenWorkflowRun,
        ...props,
      }),
    ),
  );
  return { ...utils, onNavigateToLaunchedRun, onCreateViaChat, onOpenWorkflowRun };
}

function keyOf(path: string): string {
  return resolveWorkspaceKey({ workspacePath: path });
}

describe("SavedWorkflowsSection（全局 + 多项目页）", () => {
  beforeEach(() => {
    tabStoreState.tabs = [];
    tabStoreState.activeWorkspacePath = null;
    tabStoreState.activeWorkspaceIdentity = null;
    tabStoreState.openSettingsTab = vi.fn();
    for (const k of Object.keys(groupReadiness)) delete groupReadiness[k];
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
    resetDynamicWorkflowAvailabilityStoreForTests();
  });

  it("全局组恒置顶，位于所有项目组之上；总数=全局+各项目组条数之和", async () => {
    tabStoreState.tabs = [workspaceTab("/a", "Alpha"), workspaceTab("/b", "Beta")];
    groupReadiness.global = { loaded: true, empty: false, count: 2 };
    groupReadiness["/a"] = { loaded: true, empty: false, count: 3 };
    groupReadiness["/b"] = { loaded: true, empty: false, count: 4 };
    mount();
    await screen.findByTestId(testId(TID_WORKFLOW_PROJECT_GROUP, keyOf("/a")));
    const groups = screen.getAllByTestId(
      (id) => id === TID_WORKFLOW_GLOBAL_GROUP || id.startsWith(TID_WORKFLOW_PROJECT_GROUP),
    );
    expect(groups[0]?.getAttribute("data-testid")).toBe(TID_WORKFLOW_GLOBAL_GROUP);
    expect(groups[1]?.getAttribute("data-testid")).toBe(
      testId(TID_WORKFLOW_PROJECT_GROUP, keyOf("/a")),
    );
    expect(groups[2]?.getAttribute("data-testid")).toBe(
      testId(TID_WORKFLOW_PROJECT_GROUP, keyOf("/b")),
    );
    expect(screen.getByText("已保存的工作流").textContent).toContain("9");
  });

  it("全局组接收本机项目候选（过滤远程）与活动项目 key", async () => {
    tabStoreState.tabs = [
      workspaceTab("/a", "Alpha"),
      workspaceTab("/remote", "Remote", { remoteSessionId: "sess-1" }),
    ];
    tabStoreState.activeWorkspacePath = "/a";
    groupReadiness.global = { loaded: true, empty: false, count: 1 };
    groupReadiness["/a"] = { loaded: true, empty: false, count: 1 };
    mount({ workspacePath: "/a" });
    const globalGroup = await screen.findByTestId(TID_WORKFLOW_GLOBAL_GROUP);
    expect(globalGroup.getAttribute("data-local")).toBe("/a");
    expect(globalGroup.getAttribute("data-active")).toBe(keyOf("/a"));
  });

  it("全局空态卡只看项目组：项目全空 + 全局有货，空态卡照出（在全局组之下）", async () => {
    tabStoreState.tabs = [workspaceTab("/a", "Alpha")];
    tabStoreState.activeWorkspacePath = "/a";
    groupReadiness.global = { loaded: true, empty: false, count: 3 };
    groupReadiness["/a"] = { loaded: true, empty: true, count: 0 };
    mount({ workspacePath: "/a" });
    await screen.findByTestId(TID_WORKFLOWS_EMPTY);
    // 全局组仍在空态卡之上
    const global = screen.getByTestId(TID_WORKFLOW_GLOBAL_GROUP);
    const empty = screen.getByTestId(TID_WORKFLOWS_EMPTY);
    expect(global.compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 总数含全局
    expect(screen.getByText("已保存的工作流").textContent).toContain("3");
  });

  it("项目全空且全局也空：空态卡照旧出现在全局组之下", async () => {
    tabStoreState.tabs = [workspaceTab("/a", "Alpha")];
    tabStoreState.activeWorkspacePath = "/a";
    groupReadiness.global = { loaded: true, empty: true, count: 0 };
    groupReadiness["/a"] = { loaded: true, empty: true, count: 0 };
    const { onCreateViaChat } = mount({ workspacePath: "/a" });
    await screen.findByTestId(TID_WORKFLOWS_EMPTY);
    fireEvent.click(screen.getByTestId(TID_WORKFLOWS_CREATE_VIA_CHAT));
    expect(onCreateViaChat.mock.calls[0]?.[1]).toEqual({ workspacePath: "/a" });
    expect(onCreateViaChat.mock.calls[0]?.[0]).toEqual(expect.stringContaining("保存到本项目"));
  });

  it("spinner：全局与所有项目组都未就绪时显示，不显示空态卡", async () => {
    tabStoreState.tabs = [workspaceTab("/a", "Alpha")];
    groupReadiness.global = { loaded: false, empty: false, count: 0 };
    groupReadiness["/a"] = { loaded: false, empty: false, count: 0 };
    mount();
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.queryByTestId(TID_WORKFLOWS_EMPTY)).toBeNull();
  });

  it("只要全局组就绪，即使项目组未就绪也不再转圈", async () => {
    tabStoreState.tabs = [workspaceTab("/a", "Alpha")];
    groupReadiness.global = { loaded: true, empty: true, count: 0 };
    groupReadiness["/a"] = { loaded: false, empty: false, count: 0 };
    mount();
    await screen.findByTestId(TID_WORKFLOW_GLOBAL_GROUP);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("没有候选项目时仍渲染全局组与刷新按钮，并给「打开一个项目」提示", async () => {
    tabStoreState.tabs = [{ id: "s", kind: "settings", workspacePath: "", label: "settings" }];
    groupReadiness.global = { loaded: true, empty: true, count: 0 };
    mount();
    await screen.findByTestId(TID_WORKFLOW_GLOBAL_GROUP);
    expect(screen.getByText("打开一个项目以查看它的工作流。")).toBeTruthy();
    expect(screen.getByTestId(TID_WORKFLOWS_REFRESH)).toBeTruthy();
    // 无候选时空态卡不出（那是「项目全空」，此处根本没有项目组）
    expect(screen.queryByTestId(TID_WORKFLOWS_EMPTY)).toBeNull();
  });

  // launch.md「The hub page」「The user's choice」：标题行带「工作流设置」和当前生效模式，点击直达设置 › 常规。
  it("「工作流设置」显示当前生效模式，点击打开设置并定位到常规", async () => {
    useDynamicWorkflowAvailabilityStore.setState({
      status: "ready",
      enabled: true,
      config: applyDynamicWorkflowUserMode(
        createDynamicWorkflowClientConfig("alwaysOn", "remote"),
        "onDemand",
      ),
    });
    groupReadiness.global = { loaded: true, empty: true, count: 0 };
    mount();
    const button = await screen.findByTestId(TID_WORKFLOWS_OPEN_SETTINGS);
    expect(button.textContent).toContain("工作流设置");
    expect(button.textContent).toContain("通过命令启用");
    fireEvent.click(button);
    expect(settingsNavigation.setPendingSettingsSectionIntent).toHaveBeenCalledWith("general");
    expect(tabStoreState.openSettingsTab).toHaveBeenCalledTimes(1);
  });

  it("旧 Host 的快照没有 offeredMode：不出「工作流设置」链接（它要打开的设置行不存在）", async () => {
    useDynamicWorkflowAvailabilityStore.setState({
      status: "ready",
      enabled: true,
      config: { mode: "alwaysOn", enabled: true, source: "remote" } as unknown as ReturnType<
        typeof createDynamicWorkflowClientConfig
      >,
    });
    groupReadiness.global = { loaded: true, empty: true, count: 0 };
    mount();
    await screen.findByTestId(TID_WORKFLOWS_REFRESH);
    expect(screen.queryByTestId(TID_WORKFLOWS_OPEN_SETTINGS)).toBeNull();
  });

  it("刷新按钮把 refreshSeq 递增并广播到全局组与所有项目组", async () => {
    tabStoreState.tabs = [workspaceTab("/a", "Alpha")];
    groupReadiness.global = { loaded: true, empty: false, count: 1 };
    groupReadiness["/a"] = { loaded: true, empty: false, count: 1 };
    mount();
    await screen.findByTestId(TID_WORKFLOW_GLOBAL_GROUP);
    expect(screen.getByTestId(TID_WORKFLOW_GLOBAL_GROUP).getAttribute("data-refresh")).toBe("0");
    fireEvent.click(screen.getByTestId(TID_WORKFLOWS_REFRESH));
    await waitFor(() =>
      expect(screen.getByTestId(TID_WORKFLOW_GLOBAL_GROUP).getAttribute("data-refresh")).toBe("1"),
    );
    expect(
      screen
        .getByTestId(testId(TID_WORKFLOW_PROJECT_GROUP, keyOf("/a")))
        .getAttribute("data-refresh"),
    ).toBe("1");
  });

  // 项目组不再有 onMoved（「提升为全局」只开会话、不改两组内容，docs/dynamic-workflow/launch.md
  // 「追记（2026-09-04）」）；只有全局组「移到项目…」会广播。
  it("全局组 onMoved 让两组 refreshSeq 递增", async () => {
    tabStoreState.tabs = [workspaceTab("/a", "Alpha")];
    groupReadiness.global = { loaded: true, empty: false, count: 1 };
    groupReadiness["/a"] = { loaded: true, empty: false, count: 1 };
    mount();
    await screen.findByTestId(TID_WORKFLOW_GLOBAL_GROUP);
    fireEvent.click(screen.getByTestId("global-moved"));
    await waitFor(() =>
      expect(screen.getByTestId(TID_WORKFLOW_GLOBAL_GROUP).getAttribute("data-refresh")).toBe("1"),
    );
    expect(
      screen
        .getByTestId(testId(TID_WORKFLOW_PROJECT_GROUP, keyOf("/a")))
        .getAttribute("data-refresh"),
    ).toBe("1");
  });

  it("点全局组「打开」进全局详情：只渲染全局组（detail），项目组不在", async () => {
    tabStoreState.tabs = [workspaceTab("/a", "Alpha")];
    groupReadiness.global = { loaded: true, empty: false, count: 1 };
    groupReadiness["/a"] = { loaded: true, empty: false, count: 1 };
    mount();
    await screen.findByTestId(TID_WORKFLOW_GLOBAL_GROUP);
    fireEvent.click(screen.getByTestId("global-open"));
    await waitFor(() =>
      expect(screen.getByTestId(TID_WORKFLOW_GLOBAL_GROUP).getAttribute("data-mode")).toBe(
        "detail",
      ),
    );
    expect(screen.getByTestId(TID_WORKFLOW_GLOBAL_GROUP).getAttribute("data-name")).toBe("g-1");
    expect(screen.queryByTestId(testId(TID_WORKFLOW_PROJECT_GROUP, keyOf("/a")))).toBeNull();
    expect(screen.queryByTestId(TID_WORKFLOWS_REFRESH)).toBeNull();
    fireEvent.click(screen.getByTestId("global-back"));
    await waitFor(() =>
      expect(screen.getByTestId(testId(TID_WORKFLOW_PROJECT_GROUP, keyOf("/a")))).toBeTruthy(),
    );
  });

  it("点项目组「打开」进项目详情：只渲染该项目组，全局组不在", async () => {
    tabStoreState.tabs = [workspaceTab("/a", "Alpha"), workspaceTab("/b", "Beta")];
    groupReadiness.global = { loaded: true, empty: false, count: 1 };
    groupReadiness["/a"] = { loaded: true, empty: false, count: 1 };
    groupReadiness["/b"] = { loaded: true, empty: false, count: 1 };
    mount();
    await screen.findByTestId(testId(TID_WORKFLOW_PROJECT_GROUP, keyOf("/a")));
    fireEvent.click(screen.getByTestId("open-/a"));
    await waitFor(() =>
      expect(
        screen
          .getByTestId(testId(TID_WORKFLOW_PROJECT_GROUP, keyOf("/a")))
          .getAttribute("data-mode"),
      ).toBe("detail"),
    );
    expect(screen.queryByTestId(TID_WORKFLOW_GLOBAL_GROUP)).toBeNull();
    expect(screen.queryByTestId(testId(TID_WORKFLOW_PROJECT_GROUP, keyOf("/b")))).toBeNull();
  });

  it("活动项目的组带「当前」标记", async () => {
    tabStoreState.tabs = [workspaceTab("/a", "Alpha"), workspaceTab("/b", "Beta")];
    tabStoreState.activeWorkspacePath = "/b";
    groupReadiness.global = { loaded: true, empty: true, count: 0 };
    groupReadiness["/a"] = { loaded: true, empty: false, count: 1 };
    groupReadiness["/b"] = { loaded: true, empty: false, count: 1 };
    mount({ workspacePath: "/b" });
    await screen.findByTestId(testId(TID_WORKFLOW_PROJECT_GROUP, keyOf("/a")));
    expect(
      screen
        .getByTestId(testId(TID_WORKFLOW_PROJECT_GROUP, keyOf("/a")))
        .getAttribute("data-current"),
    ).toBe("false");
    expect(
      screen
        .getByTestId(testId(TID_WORKFLOW_PROJECT_GROUP, keyOf("/b")))
        .getAttribute("data-current"),
    ).toBe("true");
  });

  it("深链 openWorkflow 项目变体直达项目详情并被消费", async () => {
    tabStoreState.tabs = [workspaceTab("/a", "Alpha"), workspaceTab("/b", "Beta")];
    groupReadiness.global = { loaded: true, empty: true, count: 0 };
    groupReadiness["/a"] = { loaded: true, empty: false, count: 1 };
    groupReadiness["/b"] = { loaded: true, empty: false, count: 1 };
    const onOpenWorkflowConsumed = vi.fn();
    mount({ openWorkflow: { workspaceKey: keyOf("/b"), name: "deep" }, onOpenWorkflowConsumed });
    await waitFor(() =>
      expect(
        screen
          .getByTestId(testId(TID_WORKFLOW_PROJECT_GROUP, keyOf("/b")))
          .getAttribute("data-mode"),
      ).toBe("detail"),
    );
    expect(
      screen.getByTestId(testId(TID_WORKFLOW_PROJECT_GROUP, keyOf("/b"))).getAttribute("data-name"),
    ).toBe("deep");
    expect(screen.queryByTestId(TID_WORKFLOW_GLOBAL_GROUP)).toBeNull();
    expect(onOpenWorkflowConsumed).toHaveBeenCalledTimes(1);
  });

  it("深链 openWorkflow 全局变体直达全局详情并被消费", async () => {
    tabStoreState.tabs = [workspaceTab("/a", "Alpha")];
    groupReadiness.global = { loaded: true, empty: false, count: 1 };
    groupReadiness["/a"] = { loaded: true, empty: false, count: 1 };
    const onOpenWorkflowConsumed = vi.fn();
    mount({ openWorkflow: { scope: "global", name: "deep-g" }, onOpenWorkflowConsumed });
    await waitFor(() =>
      expect(screen.getByTestId(TID_WORKFLOW_GLOBAL_GROUP).getAttribute("data-mode")).toBe(
        "detail",
      ),
    );
    expect(screen.getByTestId(TID_WORKFLOW_GLOBAL_GROUP).getAttribute("data-name")).toBe("deep-g");
    expect(screen.queryByTestId(testId(TID_WORKFLOW_PROJECT_GROUP, keyOf("/a")))).toBeNull();
    expect(onOpenWorkflowConsumed).toHaveBeenCalledTimes(1);
  });
});
