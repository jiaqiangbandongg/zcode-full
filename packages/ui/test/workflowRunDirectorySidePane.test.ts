// @vitest-environment jsdom

// dwf run 目录页（docs/dynamic-workflow/presentation.md「Other places a run appears」）：
// 任务岛页脚行 →（本文件）→ 已有的 `workflow-run` 详情页，与 subagent 的三步形状同构。
//
// 分桶/剔除/截断的规则在 workflowRunDirectoryModel.test.ts 里穷举，取数与重试语义在
// useWorkflowRunJournalSummaries.test.ts 里；这里只钉「那些结果真的接到了 DOM 上」、
// 行点击发出什么，以及三种空态在屏幕上可分辨。
import { createElement, useEffect, useState, type ReactNode } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { V4ConversationWorkflowRunSummary } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowRunDirectorySidePaneTab } from "@/lib/workspaceSidePane.js";

vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), warn: vi.fn() },
}));

// 租约与投影：页面拿投影**只当新鲜度触发器**（行仍然只渲染 journal 摘要）。
// layer 必须是稳定引用——租约 effect 以它为依赖，每次渲染换新对象会打成无限循环。
const release = vi.fn();
const acquire = vi.fn(() => ({ release }));
const layer = { acquire };

vi.mock("@/v4/V4ConversationContext.js", () => ({
  V4PaneConversationProvider: ({ children }: { children: ReactNode }) => children,
  useV4Conversation: () => ({ layer }),
}));

let snapshot: { workflowRuns?: { revision: number; runs: unknown[] } } | null = null;
// 投影桩必须**真的会推**：被测内容组件是 memo 的，props 不变时 rerender 根本不会重渲染它。
// 读模块变量的桩因此会假装「投影更新了但界面没反应」——那正好是本轮要修的 bug 的形状，
// 桩不能自己制造它。这里用一个最小订阅，与生产里 useConversationProjection 的语义一致。
const projectionListeners = new Set<() => void>();
function pushProjection(next: typeof snapshot) {
  snapshot = next;
  for (const listener of projectionListeners) listener();
}
vi.mock("@/v4/useConversationProjection.js", () => ({
  useConversationProjection: () => {
    const [, forceRender] = useState(0);
    useEffect(() => {
      const listener = () => forceRender((generation) => generation + 1);
      projectionListeners.add(listener);
      return () => {
        projectionListeners.delete(listener);
      };
    }, []);
    return { snapshot };
  },
}));

// 取数 hook 换成桩：它自己的行为（能力缺席终局、live 重试、refreshKey）有专属用例，
// 这里要钉的是**页面向它要了什么**（limit 必须与任务岛计数同深度，否则两处口径会分叉；
// refreshKey 必须真的接上，否则跑完的 run 永远留在「运行中」）以及三种返回长什么样。
let summaries: readonly V4ConversationWorkflowRunSummary[] | null = null;
let optionsSeen:
  | { sessionId: string | null; live: boolean; limit?: number; refreshKey?: number | string }
  | undefined;
const refreshKeysSeen: (number | string | undefined)[] = [];
vi.mock("@/hooks/useWorkflowRunJournalSummaries.js", () => ({
  useWorkflowRunJournalSummaries: (options: {
    sessionId: string | null;
    live: boolean;
    limit?: number;
    refreshKey?: number | string;
  }) => {
    optionsSeen = options;
    if (refreshKeysSeen.at(-1) !== options.refreshKey) refreshKeysSeen.push(options.refreshKey);
    return summaries;
  },
}));

// eslint-disable-next-line import/first -- 必须在全部 mock 之后再引入被测组件。
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
// eslint-disable-next-line import/first
import { WorkflowRunDirectorySidePane } from "@/app-shell/WorkflowRunDirectorySidePane.js";
// eslint-disable-next-line import/first
import {
  WORKFLOW_RUN_DIRECTORY_LIMIT,
  workflowRunDirectoryRefreshKey,
} from "@/v4/workflowRunDirectoryModel.js";

const tab: WorkflowRunDirectorySidePaneTab = {
  id: "workflow-directory:%2Fworkspace:parent-a",
  type: "workflow-directory",
  workspaceKey: "/workspace",
  workspacePath: "/workspace",
  parentSessionId: "parent-a",
};

const onOpenWorkflowRun = vi.fn();

function summary(
  overrides: Partial<V4ConversationWorkflowRunSummary> &
    Pick<V4ConversationWorkflowRunSummary, "runId">,
): V4ConversationWorkflowRunSummary {
  return {
    toolCallId: `call-${overrides.runId}`,
    status: "completed",
    resumable: false,
    ...overrides,
  };
}

/** 触发器那一侧的输入：投影里的 run（只有身份与状态对键有意义）。 */
function projectionRun(runId: string, status: "running" | "pending" | "completed" | "errored") {
  return {
    runId,
    toolCallId: `call-${runId}`,
    status,
    usage: { spentTokens: 0, nodesUsed: 0 },
    actors: [],
    nodes: [],
    lastEventSequence: 0,
  };
}

function renderPane(locale: "en-US" | "zh-CN" = "en-US") {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(WorkflowRunDirectorySidePane, { tab, onOpenWorkflowRun }),
    ),
  );
}

function rows(pane: ReturnType<typeof renderPane>, section: "running" | "ended") {
  return [
    ...pane.container.querySelectorAll(
      `[data-workflow-directory-section="${section}"] [data-run-id]`,
    ),
  ];
}

beforeEach(() => {
  summaries = null;
  optionsSeen = undefined;
  refreshKeysSeen.length = 0;
  snapshot = null;
  acquire.mockClear();
  release.mockClear();
  onOpenWorkflowRun.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("WorkflowRunDirectorySidePane", () => {
  it("按会话取一页 journal，深度与任务岛计数同一个常量（口径分叉就是「岛说 5、页面 4」）", () => {
    summaries = [];
    renderPane();

    expect(optionsSeen?.sessionId).toBe("parent-a");
    expect(optionsSeen?.live).toBe(true);
    expect(optionsSeen?.limit).toBe(WORKFLOW_RUN_DIRECTORY_LIMIT);
  });

  // ── 自动刷新（实测 bug：跑完的 run 不会自己挪到「已结束」）──
  //
  // 失效的形状是「页面一个信号都没有」：hook 首答即收口，那一页在 pane 的余生里冻住。
  // 所以这里钉的是**信号接上了**，而不是某个具体键值。

  it("把投影派生出的 refreshKey 交给取数 hook（缺了它那一页会永远冻住）", () => {
    summaries = [];
    snapshot = { workflowRuns: { revision: 1, runs: [projectionRun("r-1", "running")] } };
    renderPane();

    expect(optionsSeen?.refreshKey).toBe(
      workflowRunDirectoryRefreshKey([projectionRun("r-1", "running")] as never),
    );
  });

  it("run 跑完时 refreshKey 变化 → hook 重取 → 那一行自己挪到「已结束」", () => {
    summaries = [summary({ runId: "r-1", status: "running" })];
    snapshot = { workflowRuns: { revision: 1, runs: [projectionRun("r-1", "running")] } };
    const pane = renderPane();
    expect(rows(pane, "running").map((row) => row.getAttribute("data-run-id"))).toEqual(["r-1"]);
    const keyWhileRunning = optionsSeen?.refreshKey;

    // 引擎结算 → 投影翻终态；journal 的下一答随之把这条 run 归到已结束。
    act(() => {
      summaries = [summary({ runId: "r-1", status: "completed" })];
      pushProjection({ workflowRuns: { revision: 2, runs: [projectionRun("r-1", "completed")] } });
    });

    expect(optionsSeen?.refreshKey).not.toBe(keyWhileRunning);
    expect(rows(pane, "running")).toEqual([]);
    expect(rows(pane, "ended").map((row) => row.getAttribute("data-run-id"))).toEqual(["r-1"]);
  });

  it("节点级进度不抬 refreshKey：开着的页面不会因为引擎事件反复读 journal", () => {
    summaries = [summary({ runId: "r-1", status: "running" })];
    snapshot = { workflowRuns: { revision: 1, runs: [projectionRun("r-1", "running")] } };
    renderPane();

    // 同一个 run 在跑，只是又结算了一个节点（revision 也抬了）——键必须不动。
    act(() => {
      pushProjection({
        workflowRuns: {
          revision: 2,
          runs: [
            {
              ...projectionRun("r-1", "running"),
              nodes: [{ siteId: "ask#1", ordinal: 1, phase: "settled", outcome: "ok" }],
              lastEventSequence: 7,
            },
          ],
        },
      });
    });

    expect(refreshKeysSeen).toHaveLength(1);
  });

  it("按会话取租约，卸载时放掉（投影只当触发器，但租约照样是租约）", () => {
    summaries = [];
    const pane = renderPane();

    expect(acquire).toHaveBeenCalledWith("parent-a");
    expect(release).not.toHaveBeenCalled();
    pane.unmount();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("两段各自渲染并带计数：运行中与已结束", () => {
    summaries = [
      summary({ runId: "r-run", status: "running", label: "find-flaky-tests" }),
      summary({ runId: "r-done", status: "completed", label: "review-changes" }),
      summary({ runId: "r-cancel", status: "stopped", label: "migrate-imports" }),
    ];
    const pane = renderPane();

    expect(rows(pane, "running").map((row) => row.getAttribute("data-run-id"))).toEqual(["r-run"]);
    expect(rows(pane, "ended").map((row) => row.getAttribute("data-run-id"))).toEqual([
      "r-done",
      "r-cancel",
    ]);
    expect(pane.getByTestId("workflow-run-directory-running-count").textContent).toContain("1");
    expect(pane.getByTestId("workflow-run-directory-ended-count").textContent).toContain("2");
    expect(pane.getByText("find-flaky-tests")).toBeTruthy();
  });

  it("行点击开详情页，参数带全（runId + toolCallId + 展示名做标题兜底）", () => {
    summaries = [summary({ runId: "r-done", label: "review-changes" })];
    const pane = renderPane();

    fireEvent.click(pane.container.querySelector("[data-run-id='r-done']") as Element);

    expect(onOpenWorkflowRun).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      parentSessionId: "parent-a",
      runId: "r-done",
      toolCallId: "call-r-done",
      workflowName: "review-changes",
    });
  });

  it("没有 label 的 run 用既有的兜底名，绝不显示裸 runId", () => {
    summaries = [summary({ runId: "dwfrun-8f21" })];
    const pane = renderPane();

    expect(pane.queryByText("dwfrun-8f21")).toBeNull();
    expect(pane.getByText("Workflow script")).toBeTruthy();
  });

  it("状态词复用既有词汇表；stopped 行跟原因词，errored 行跟 failureCode（决策 15）", () => {
    summaries = [
      summary({
        runId: "r-stop",
        status: "stopped",
        stopReason: "interrupted",
        failureCode: "Interrupted",
        resumable: true,
      } as never),
      summary({ runId: "r-fail", status: "errored", failureCode: "DriverError" }),
      summary({ runId: "r-done", status: "completed" }),
    ];
    const pane = renderPane();

    const stopped = pane.container.querySelector("[data-run-id='r-stop']") as HTMLElement;
    expect(stopped.textContent).toContain("Stopped");
    expect(stopped.textContent).toContain("process exited");
    expect(stopped.textContent).not.toContain("Interrupted");
    const failed = pane.container.querySelector("[data-run-id='r-fail']") as HTMLElement;
    expect(failed.textContent).toContain("Errored");
    expect(failed.textContent).toContain("DriverError");
    const completed = pane.container.querySelector("[data-run-id='r-done']") as HTMLElement;
    expect(completed.textContent).toContain("Completed");
    expect(completed.textContent).not.toContain("DriverError");
  });

  it("取满一页才提示截断——静默截断会读成「就这些」", () => {
    summaries = Array.from({ length: WORKFLOW_RUN_DIRECTORY_LIMIT - 1 }, (_unused, index) =>
      summary({ runId: `r-${index}` }),
    );
    const short = renderPane();
    expect(short.queryByTestId("workflow-run-directory-truncated")).toBeNull();
    cleanup();

    summaries = Array.from({ length: WORKFLOW_RUN_DIRECTORY_LIMIT }, (_unused, index) =>
      summary({ runId: `r-${index}` }),
    );
    const full = renderPane();
    expect(full.getByTestId("workflow-run-directory-truncated").textContent).toContain("64");
  });

  it("三种空态可分辨：一条都没有 / 只是某一段空 / 根本列不出来", () => {
    summaries = [];
    const empty = renderPane();
    expect(empty.getByTestId("workflow-run-directory-empty")).toBeTruthy();
    expect(empty.queryByTestId("workflow-run-directory-unavailable")).toBeNull();
    cleanup();

    summaries = [summary({ runId: "r-run", status: "running" })];
    const onlyRunning = renderPane();
    expect(onlyRunning.queryByTestId("workflow-run-directory-empty")).toBeNull();
    expect(onlyRunning.getByTestId("workflow-run-directory-ended-empty")).toBeTruthy();
    cleanup();

    // 能力缺席 / 还没查到：hook 给 null。**不是**「没有运行」，所以不能借用空态文案。
    summaries = null;
    const unavailable = renderPane();
    expect(unavailable.getByTestId("workflow-run-directory-unavailable")).toBeTruthy();
    expect(unavailable.queryByTestId("workflow-run-directory-empty")).toBeNull();
    // 也不是报错：没有 alert，屏幕上不出现失败语气。
    expect(unavailable.container.querySelector("[role='alert']")).toBeNull();
  });

  it("中文文案（分区标题与状态词都走 i18n，不写死英文）", () => {
    summaries = [
      summary({ runId: "r-run", status: "running" }),
      summary({ runId: "r-fail", status: "errored" }),
    ];
    const pane = renderPane("zh-CN");

    // 分区标题是「标题 · 计数」的组合节点，所以按子串匹配（计数本身另有 testid）。
    expect(pane.getByText(/正在运行/)).toBeTruthy();
    expect(pane.getByText(/已结束/)).toBeTruthy();
    expect(
      (pane.container.querySelector("[data-run-id='r-fail']") as HTMLElement).textContent,
    ).toContain("出错");
  });
});
