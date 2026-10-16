// @vitest-environment jsdom
// 工作流详情页（docs/dynamic-workflow/launch.md「The detail page」「元数据编辑」「运行历史」）。
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TID_WORKFLOW_DETAIL,
  TID_WORKFLOW_DETAIL_DESCRIPTION,
  TID_WORKFLOW_DETAIL_MENU,
  TID_WORKFLOW_DETAIL_SCRIPT,
  TID_WORKFLOW_DETAIL_WHEN_TO_USE,
  TID_WORKFLOW_ACTION_MOVE,
  TID_WORKFLOW_META_DISCARD,
  TID_WORKFLOW_META_SAVE,
  TID_WORKFLOW_ARTIFACT_CHIP,
  TID_WORKFLOW_RUN_ROW,
  testId,
  type ZCodeSavedWorkflowEntry,
  type ZCodeSavedWorkflowRun,
  type ZCodeWorkflowsGetResult,
} from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

const toastMock = vi.fn();
vi.mock("@/components/ui/toast.js", () => ({ toast: (...args: unknown[]) => toastMock(...args) }));
vi.mock("@/components/ai-elements/code-block.js", () => ({
  CodeBlock: ({ code, language }: { code: string; language: string }) =>
    createElement("pre", { "data-script": "true", "data-language": language }, code),
}));
vi.mock("@/settings/SettingsHeaderBreadcrumb.js", () => ({
  SettingsBreadcrumbReporter: ({ items }: { items: readonly { label: string }[] }) =>
    createElement(
      "nav",
      { "data-testid": "breadcrumb" },
      items.map((item, index) => createElement("span", { key: index }, item.label)),
    ),
}));

const { SavedWorkflowDetailView } =
  await import("@/settings/saved-workflows/SavedWorkflowDetailView.js");

const SCRIPT = 'export default async ({ agent }) => {\n  await agent("检查发布");\n};\n';
const ENTRY: ZCodeSavedWorkflowEntry = {
  name: "release-check",
  description: "发布前检查",
  whenToUse: "发版前",
  scope: "project",
  path: "/repo/.zcode/workflows/release-check.dwf.ts",
  args: { branch: { type: "string", required: true } },
};
const detailResult: { current: ZCodeWorkflowsGetResult } = {
  current: {
    ok: true,
    name: "release-check",
    path: ENTRY.path,
    scope: "project",
    meta: {
      description: "发布前检查",
      whenToUse: "发版前",
      args: { branch: { type: "string", required: true } },
    },
    script: SCRIPT,
  },
};
const agentService = {
  getSavedWorkflow: vi.fn(async () => detailResult.current),
  updateSavedWorkflowMeta: vi.fn(async () => ({ ok: true as const, path: ENTRY.path })),
};

const NOW = 1_700_000_000_000;
const RUNS: ZCodeSavedWorkflowRun[] = [
  {
    runId: "r-open",
    name: "release-check",
    status: "completed",
    createdAt: NOW - 90_000,
    updatedAt: NOW - 60_000,
    spentTokens: 4200,
    parentSessionId: "s1",
    toolCallId: "t1",
    args: { branch: "main" },
  },
  {
    runId: "r-orphan",
    name: "release-check",
    status: "failed",
    createdAt: NOW - 5_000,
    updatedAt: NOW - 1_000,
    spentTokens: 10,
  },
];

function mount(overrides: Partial<Parameters<typeof SavedWorkflowDetailView>[0]> = {}) {
  const props = {
    target: { workspacePath: "/repo" },
    agentService: agentService as unknown as Parameters<
      typeof SavedWorkflowDetailView
    >[0]["agentService"],
    name: "release-check",
    projectLabel: "Beta",
    entry: ENTRY,
    runs: RUNS,
    now: NOW,
    busy: false,
    canOpenRun: true,
    onBack: vi.fn(),
    onRun: vi.fn(),
    onRevise: vi.fn(),
    onCopyPath: vi.fn(),
    onDelete: vi.fn(),
    onOpenRun: vi.fn(),
    onMetaSaved: vi.fn(),
    launchDialog: null,
    ...overrides,
  };
  render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(SavedWorkflowDetailView, props),
    ),
  );
  return props;
}

beforeAll(() => {
  // Radix Tabs / Select 在 jsdom 下需要 ResizeObserver。
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

describe("SavedWorkflowDetailView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    detailResult.current = {
      ok: true,
      name: "release-check",
      path: ENTRY.path,
      scope: "project",
      meta: {
        description: "发布前检查",
        whenToUse: "发版前",
        args: { branch: { type: "string", required: true } },
      },
      script: SCRIPT,
    };
  });
  afterEach(() => {
    cleanup();
  });

  it("加载详情：元数据回填、实参表有行、脚本只读呈现；未改时没有保存 / 放弃", async () => {
    mount();
    expect(screen.getByTestId(TID_WORKFLOW_DETAIL)).toBeTruthy();
    const description = (await screen.findByTestId(
      TID_WORKFLOW_DETAIL_DESCRIPTION,
    )) as HTMLTextAreaElement;
    expect(description.value).toBe("发布前检查");
    expect((screen.getByTestId(TID_WORKFLOW_DETAIL_WHEN_TO_USE) as HTMLTextAreaElement).value).toBe(
      "发版前",
    );
    expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe("branch");
    const script = screen.getByTestId(TID_WORKFLOW_DETAIL_SCRIPT);
    expect(script.querySelector("[data-script]")?.textContent).toBe(SCRIPT);
    expect(script.querySelector("[data-script]")?.getAttribute("data-language")).toBe("typescript");
    expect(script.textContent).toContain("release-check.dwf.ts");
    expect(screen.queryByTestId(TID_WORKFLOW_META_SAVE)).toBeNull();
    expect(screen.queryByTestId(TID_WORKFLOW_META_DISCARD)).toBeNull();
    expect(agentService.getSavedWorkflow).toHaveBeenCalledWith({
      workspacePath: "/repo",
      name: "release-check",
    });
  });

  it("改说明后出现保存 / 放弃；放弃回到基线", async () => {
    mount();
    const description = (await screen.findByTestId(
      TID_WORKFLOW_DETAIL_DESCRIPTION,
    )) as HTMLTextAreaElement;
    fireEvent.change(description, { target: { value: "新说明" } });
    expect(screen.getByTestId(TID_WORKFLOW_META_SAVE)).toBeTruthy();
    fireEvent.click(screen.getByTestId(TID_WORKFLOW_META_DISCARD));
    expect((screen.getByTestId(TID_WORKFLOW_DETAIL_DESCRIPTION) as HTMLTextAreaElement).value).toBe(
      "发布前检查",
    );
    expect(screen.queryByTestId(TID_WORKFLOW_META_SAVE)).toBeNull();
    expect(agentService.updateSavedWorkflowMeta).not.toHaveBeenCalled();
  });

  it("保存：只送 meta（说明 / 使用时机 / 参数声明），成功后重新拉取并通知列表", async () => {
    const props = mount();
    const description = (await screen.findByTestId(
      TID_WORKFLOW_DETAIL_DESCRIPTION,
    )) as HTMLTextAreaElement;
    fireEvent.change(description, { target: { value: "  新说明  " } });
    fireEvent.change(screen.getByTestId(TID_WORKFLOW_DETAIL_WHEN_TO_USE), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByTestId(TID_WORKFLOW_META_SAVE));
    await waitFor(() =>
      expect(agentService.updateSavedWorkflowMeta).toHaveBeenCalledWith({
        workspacePath: "/repo",
        name: "release-check",
        meta: { description: "新说明", args: { branch: { type: "string", required: true } } },
      }),
    );
    await waitFor(() => expect(props.onMetaSaved).toHaveBeenCalledTimes(1));
    expect(agentService.getSavedWorkflow).toHaveBeenCalledTimes(2);
    expect(toastMock).toHaveBeenCalledWith("已保存元数据");
  });

  it("说明清空时拒绝保存并提示", async () => {
    mount();
    const description = (await screen.findByTestId(
      TID_WORKFLOW_DETAIL_DESCRIPTION,
    )) as HTMLTextAreaElement;
    fireEvent.change(description, { target: { value: "   " } });
    fireEvent.click(screen.getByTestId(TID_WORKFLOW_META_SAVE));
    expect(screen.getByText("说明不能为空")).toBeTruthy();
    expect(agentService.updateSavedWorkflowMeta).not.toHaveBeenCalled();
  });

  it("运行历史：每行一条；只有带归属字段的行可「查看实例」", async () => {
    const props = mount();
    await screen.findByTestId(TID_WORKFLOW_DETAIL_DESCRIPTION);
    // Radix Tabs 的触发器在 mousedown 上激活，而不是 click。
    fireEvent.mouseDown(screen.getByText("运行历史 2"), { button: 0 });
    const openable = await screen.findByTestId(testId(TID_WORKFLOW_RUN_ROW, "r-open"));
    const orphan = screen.getByTestId(testId(TID_WORKFLOW_RUN_ROW, "r-orphan"));
    expect(openable.textContent).toContain("branch=main");
    expect(openable.textContent).toContain("4.2k tokens");
    const openButton = Array.from(openable.querySelectorAll("button")).find(
      (button) => button.textContent === "查看实例",
    );
    expect(openButton).toBeTruthy();
    expect(orphan.textContent).not.toContain("查看实例");
    fireEvent.click(openButton!);
    expect(props.onOpenRun).toHaveBeenCalledWith(RUNS[0]);
  });

  it("canOpenRun 为 false 时不出现「查看实例」", async () => {
    mount({ canOpenRun: false });
    await screen.findByTestId(TID_WORKFLOW_DETAIL_DESCRIPTION);
    // Radix Tabs 的触发器在 mousedown 上激活，而不是 click。
    fireEvent.mouseDown(screen.getByText("运行历史 2"), { button: 0 });
    await screen.findByTestId(testId(TID_WORKFLOW_RUN_ROW, "r-open"));
    expect(screen.queryByText("查看实例")).toBeNull();
  });

  it("面包屑带项目一级：[项目名, 工作流名]", async () => {
    mount({ projectLabel: "Alpha" });
    await screen.findByTestId(TID_WORKFLOW_DETAIL_DESCRIPTION);
    const crumbs = Array.from(screen.getByTestId("breadcrumb").querySelectorAll("span")).map(
      (s) => s.textContent,
    );
    expect(crumbs).toEqual(["Alpha", "release-check"]);
  });

  it("文件已不存在时给出提示而不是表单", async () => {
    detailResult.current = { ok: false, reason: "not_found" };
    mount({ entry: undefined });
    expect(await screen.findByText("这个工作流已不在项目里。")).toBeTruthy();
    expect(screen.queryByTestId(TID_WORKFLOW_DETAIL_DESCRIPTION)).toBeNull();
  });

  it("resolveRunProject 在每行渲染项目列，并按行 canOpen 控制「查看实例」", async () => {
    const resolveRunProject = vi.fn((run: ZCodeSavedWorkflowRun) =>
      run.runId === "r-open"
        ? { label: "Alpha", title: "/repo/alpha", canOpen: true }
        : { label: "Beta", title: "/repo/beta", canOpen: false },
    );
    const props = mount({ resolveRunProject });
    await screen.findByTestId(TID_WORKFLOW_DETAIL_DESCRIPTION);
    fireEvent.mouseDown(screen.getByText("运行历史 2"), { button: 0 });
    const openable = await screen.findByTestId(testId(TID_WORKFLOW_RUN_ROW, "r-open"));
    const project = openable.querySelector('[data-workflow-run-project="true"]');
    expect(project?.textContent).toBe("Alpha");
    expect(project?.getAttribute("title")).toBe("/repo/alpha");
    // r-open：全局 canOpenRun + ids + 该行 canOpen 都成立 → 可查看实例。
    const openButton = Array.from(openable.querySelectorAll("button")).find(
      (button) => button.textContent === "查看实例",
    );
    expect(openButton).toBeTruthy();
    fireEvent.click(openButton!);
    expect(props.onOpenRun).toHaveBeenCalledWith(RUNS[0]);
  });

  it("resolveRunProject 该行 canOpen=false 时隐藏「查看实例」（即使有归属字段）", async () => {
    mount({ resolveRunProject: () => ({ label: "Alpha", canOpen: false }) });
    await screen.findByTestId(TID_WORKFLOW_DETAIL_DESCRIPTION);
    fireEvent.mouseDown(screen.getByText("运行历史 2"), { button: 0 });
    const openable = await screen.findByTestId(testId(TID_WORKFLOW_RUN_ROW, "r-open"));
    expect(openable.textContent).not.toContain("查看实例");
  });

  it("不传 resolveRunProject 时不渲染项目列", async () => {
    mount();
    await screen.findByTestId(TID_WORKFLOW_DETAIL_DESCRIPTION);
    fireEvent.mouseDown(screen.getByText("运行历史 2"), { button: 0 });
    await screen.findByTestId(testId(TID_WORKFLOW_RUN_ROW, "r-open"));
    expect(document.querySelector('[data-workflow-run-project="true"]')).toBeNull();
  });

  // ── 产物（docs/dynamic-workflow/authoring.md「How the user sees them」）──
  // ⚠ 术语：这里的「产物」是脚本经 `artifact.*` 交付给用户的产出，不是脚本的顶层返回值。
  const ARTIFACT_RUNS: ZCodeSavedWorkflowRun[] = [
    {
      runId: "r-latest",
      name: "release-check",
      status: "completed",
      createdAt: NOW - 90_000,
      updatedAt: NOW - 60_000,
      spentTokens: 10,
      parentSessionId: "s1",
      toolCallId: "t1",
      artifacts: [
        { id: "book", kind: "file", title: "审计报告", version: 2 },
        { id: "perf", kind: "chart", title: "每轮耗时", version: 1 },
      ],
    },
    {
      // 老行：没有 parentSessionId（chip 不可点），也没有 artifacts 键（老 CLI 不发）。
      runId: "r-legacy",
      name: "release-check",
      status: "completed",
      createdAt: NOW - 5_000,
      updatedAt: NOW - 1_000,
      spentTokens: 10,
      artifacts: [{ id: "old", kind: "markdown", title: "旧综述", version: 1 }],
    },
  ];

  it("运行历史行在状态之后挂产物 chips；点一枚把 (run, 产物 id) 交给宿主", async () => {
    const onOpenArtifact = vi.fn();
    mount({ runs: ARTIFACT_RUNS, onOpenArtifact });
    await screen.findByTestId(TID_WORKFLOW_DETAIL_DESCRIPTION);
    fireEvent.mouseDown(screen.getByText("运行历史 2"), { button: 0 });

    const row = await screen.findByTestId(testId(TID_WORKFLOW_RUN_ROW, "r-latest"));
    const chips = Array.from(row.querySelectorAll(`[data-testid="${TID_WORKFLOW_ARTIFACT_CHIP}"]`));
    expect(chips).toHaveLength(2);
    fireEvent.click(chips[0]!);
    expect(onOpenArtifact).toHaveBeenCalledWith(ARTIFACT_RUNS[0], "book");
  });

  it("没有 parentSessionId 的老行 chips 不可点——产物 tab 要回到发起它的会话", async () => {
    const onOpenArtifact = vi.fn();
    mount({ runs: ARTIFACT_RUNS, onOpenArtifact });
    await screen.findByTestId(TID_WORKFLOW_DETAIL_DESCRIPTION);
    fireEvent.mouseDown(screen.getByText("运行历史 2"), { button: 0 });

    const row = await screen.findByTestId(testId(TID_WORKFLOW_RUN_ROW, "r-legacy"));
    const chip = row.querySelector(`[data-testid="${TID_WORKFLOW_ARTIFACT_CHIP}"]`);
    expect(chip?.hasAttribute("disabled")).toBe(true);
    fireEvent.click(chip!);
    expect(onOpenArtifact).not.toHaveBeenCalled();
  });

  it("宿主没注入打开能力时 chips 仍在场，只是全都不可点", async () => {
    mount({ runs: ARTIFACT_RUNS });
    await screen.findByTestId(TID_WORKFLOW_DETAIL_DESCRIPTION);
    fireEvent.mouseDown(screen.getByText("运行历史 2"), { button: 0 });

    const row = await screen.findByTestId(testId(TID_WORKFLOW_RUN_ROW, "r-latest"));
    const chips = Array.from(row.querySelectorAll(`[data-testid="${TID_WORKFLOW_ARTIFACT_CHIP}"]`));
    expect(chips).toHaveLength(2);
    expect(chips.every((chip) => chip.hasAttribute("disabled"))).toBe(true);
  });

  it("详情页头部的「最近产物」条取**最近一次 completed run**", async () => {
    const onOpenArtifact = vi.fn();
    mount({
      runs: [
        // 最近一次运行失败且什么都没交付：这一条不该把已有的交付物顶掉。
        {
          runId: "r-failed",
          name: "release-check",
          status: "failed",
          createdAt: NOW - 2_000,
          updatedAt: NOW - 1_000,
          spentTokens: 0,
          parentSessionId: "s2",
        },
        ...ARTIFACT_RUNS,
      ],
      onOpenArtifact,
    });
    await screen.findByTestId(TID_WORKFLOW_DETAIL_DESCRIPTION);

    const strip = screen.getByTestId("workflow-detail-artifacts");
    expect(strip.textContent).toContain("最近产物");
    expect(strip.textContent).toContain("审计报告");
    fireEvent.click(strip.querySelectorAll(`[data-testid="${TID_WORKFLOW_ARTIFACT_CHIP}"]`)[1]!);
    expect(onOpenArtifact).toHaveBeenCalledWith(ARTIFACT_RUNS[0], "perf");
  });

  it("一件产物都没有时「最近产物」条整块缺席（无则缺席）", async () => {
    mount({ onOpenArtifact: vi.fn() });
    await screen.findByTestId(TID_WORKFLOW_DETAIL_DESCRIPTION);
    expect(screen.queryByTestId("workflow-detail-artifacts")).toBeNull();
  });

  it("传 onMove 时详情菜单出现作用域项：项目档「提升为全局」", async () => {
    const onMove = vi.fn();
    mount({ onMove });
    await screen.findByTestId(TID_WORKFLOW_DETAIL_DESCRIPTION);
    fireEvent.pointerDown(screen.getByTestId(TID_WORKFLOW_DETAIL_MENU), {
      button: 0,
      ctrlKey: false,
    });
    const moveItem = screen.getByTestId(testId(TID_WORKFLOW_ACTION_MOVE, "release-check"));
    expect(moveItem.textContent).toBe("提升为全局");
    fireEvent.click(moveItem);
    expect(onMove).toHaveBeenCalledTimes(1);
  });

  it("全局档详情菜单移动项为「移到项目…」", async () => {
    mount({ entry: { ...ENTRY, scope: "global" }, onMove: vi.fn() });
    await screen.findByTestId(TID_WORKFLOW_DETAIL_DESCRIPTION);
    fireEvent.pointerDown(screen.getByTestId(TID_WORKFLOW_DETAIL_MENU), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.getByTestId(testId(TID_WORKFLOW_ACTION_MOVE, "release-check")).textContent).toBe(
      "移到项目…",
    );
  });

  it("不传 onMove 时详情菜单没有移动项", async () => {
    mount();
    await screen.findByTestId(TID_WORKFLOW_DETAIL_DESCRIPTION);
    fireEvent.pointerDown(screen.getByTestId(TID_WORKFLOW_DETAIL_MENU), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.queryByTestId(testId(TID_WORKFLOW_ACTION_MOVE, "release-check"))).toBeNull();
  });
});
