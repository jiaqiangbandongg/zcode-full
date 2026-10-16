// @vitest-environment jsdom

// 完成卡（docs/dynamic-workflow/transcript-and-notifications.md）：表头 → 交付物行 + 产物索引 → 四格数字。纯展示层——
// 预览由调用方交进来，这里只钉形态、布局随件数的变化、数字的诚实（`—` 不是 0）与门控。
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children?: ReactNode }) => children,
}));

// eslint-disable-next-line import/first -- 必须在 tooltip mock 之后再引入被测组件。
import {
  COMPLETION_INDEX_MAX,
  WorkflowCompletionCard,
  formatCompactCount,
  type WorkflowCompletionCardProps,
} from "@/components/workflow-timeline/WorkflowCompletionCard.js";
// eslint-disable-next-line import/first -- 同上。
import type { WorkflowCompletionArtifact } from "@/components/workflow-timeline/WorkflowArtifactTile.js";
// eslint-disable-next-line import/first -- 同上。
import { formatWorkDuration, workDurationParts } from "@/lib/workDuration.js";
// eslint-disable-next-line import/first -- 同上；词条只用于双语言存在性断言。
import enUS from "../src/i18n/locales/en-US.js";
// eslint-disable-next-line import/first -- 同上。
import zhCN from "../src/i18n/locales/zh-CN.js";

afterEach(() => {
  cleanup();
});

const ARTIFACTS: WorkflowCompletionArtifact[] = [
  { id: "brief", kind: "markdown", title: "research-brief.md", version: 1, bytes: 12_288 },
  {
    id: "sources",
    kind: "file",
    title: "sources.csv",
    version: 2,
    bytes: 6_144,
    contentType: "text/csv",
    sourcePath: "out/sources.csv",
  },
  { id: "coverage", kind: "chart", title: "source coverage", version: 1, itemCount: 4 },
];

function renderCard(
  overrides: Partial<WorkflowCompletionCardProps> = {},
  locale: "en-US" | "zh-CN" = "en-US",
) {
  const props: WorkflowCompletionCardProps = {
    name: "deep-research",
    figures: { durationMs: 708_000, tokens: 386_412, subagents: 10, phases: 16 },
    artifacts: ARTIFACTS,
    testIdKey: "turn-1",
    ...overrides,
  };
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(WorkflowCompletionCard, props),
    ),
  );
}

describe("WorkflowCompletionCard · 形态", () => {
  it("表头 = 完成的种类词 + 名字 + 灯与状态词；没有 chevron；有回调才有 ⤢", () => {
    const onOpenRun = vi.fn();
    const view = renderCard({ onOpenRun });
    const card = view.getByTestId("workflow-completion-card-turn-1");
    expect(card.getAttribute("aria-label")).toBe("Workflow completed");
    expect(view.getByTestId("workflow-card-kind").textContent).toBe("Workflow completed");
    expect(view.getByTestId("workflow-card-name").textContent).toBe("deep-research");
    expect(view.getByTestId("workflow-completion-status").textContent).toBe("Completed");
    expect(view.queryByTestId("workflow-card-toggle")).toBeNull();
    fireEvent.click(view.getByTestId("workflow-card-open-details"));
    expect(onOpenRun).toHaveBeenCalledTimes(1);

    cleanup();
    const cold = renderCard();
    expect(cold.queryByTestId("workflow-card-open-details")).toBeNull();
  });

  it("四格：时间拆成数字 + 单位、tokens 紧凑写法并把全值放进 title、子代理与阶段数原样", () => {
    const view = renderCard();
    expect(view.getByTestId("workflow-completion-figure-time").getAttribute("data-value")).toBe(
      "11m 48s",
    );
    const tokens = view.getByTestId("workflow-completion-figure-tokens");
    expect(tokens.getAttribute("data-value")).toBe("386.4k");
    expect(tokens.querySelector("[title]")?.getAttribute("title")).toBe("386,412 tokens");
    expect(
      view.getByTestId("workflow-completion-figure-subagents").getAttribute("data-value"),
    ).toBe("10");
    expect(view.getByTestId("workflow-completion-figure-phases").getAttribute("data-value")).toBe(
      "16",
    );
    // 标签四个都在。
    const figures = view.getByTestId("workflow-completion-figures");
    expect(figures.textContent).toContain("time");
    expect(figures.textContent).toContain("subagents");
    expect(figures.textContent).toContain("phases");
    expect(figures.textContent).not.toContain("steps");
  });

  it("拿不到的格写 `—`（带无障碍名），不写 0；时间独立于其余三格", () => {
    const view = renderCard({ figures: { durationMs: 3_000 } });
    expect(view.getByTestId("workflow-completion-figure-time").getAttribute("data-value")).toBe(
      "3s",
    );
    for (const key of ["tokens", "subagents", "phases"]) {
      const figure = view.getByTestId(`workflow-completion-figure-${key}`);
      expect(figure.getAttribute("data-value")).toBeNull();
      expect(figure.textContent).toContain("—");
      expect(figure.querySelector("[aria-label]")?.getAttribute("aria-label")).toBe(
        "Not available",
      );
      expect(figure.textContent).not.toContain("0");
    }
  });

  it("zh-CN：时长单位前留空格；四格标签与无障碍名双写", () => {
    const view = renderCard({ figures: { durationMs: 708_000, tokens: 5 } }, "zh-CN");
    expect(view.getByTestId("workflow-completion-figure-time").getAttribute("data-value")).toBe(
      "11 分 48 秒",
    );
    expect(view.getByTestId("workflow-completion-figures").textContent).toContain("子代理");
    for (const key of [
      "chat.toolCall.workflow.completion.time",
      "chat.toolCall.workflow.completion.tokens",
      "chat.toolCall.workflow.completion.subagents",
      "chat.toolCall.workflow.completion.phases",
      "chat.toolCall.workflow.completion.unavailable",
    ]) {
      expect(enUS).toHaveProperty(key);
      expect(zhCN).toHaveProperty(key);
    }
  });
});

describe("WorkflowCompletionCard · 产物索引", () => {
  it("没有交付物：索引独占产物区，一件一行（图标 + 标题 + 等宽细节 + 尾槽），两列流；没有框、没有细线；有回调才可点并交出 id", () => {
    const onOpenArtifact = vi.fn();
    const view = renderCard({ onOpenArtifact });
    const index = view.getByTestId("workflow-completion-index");
    expect(index.className).toContain("repeat(auto-fit,minmax(220px,1fr))");
    expect(index.className).not.toContain("border-t");
    expect(index.getAttribute("data-columns")).toBe("auto");
    const lines = view.getAllByTestId("workflow-completion-line");
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.getAttribute("data-variant") === "line")).toBe(true);
    expect(lines.every((line) => line.className.includes("h-[26px]"))).toBe(true);
    // 三件、无旗子：没有交付物，也没有交付物行；索引不画框，所以整卡没有纸页字形。
    expect(view.queryByTestId("workflow-completion-row")).toBeNull();
    expect(view.queryByTestId("workflow-artifact-tile-frame")).toBeNull();
    expect(view.queryByTestId("workflow-artifact-sheet")).toBeNull();
    // 细节就在行上：文档只有大小；文件 `CSV · 6.0 KB`；看板是条数。
    const details = view.getAllByTestId("workflow-artifact-line-detail");
    expect(details[0]!.textContent).toBe("12.0 KB");
    expect(details[1]!.textContent).toContain("CSV");
    expect(details[1]!.textContent).toContain("6.0 KB");
    expect(details[2]!.textContent).toBe("4 items");
    // v2 尾槽只在第二件上。
    const versions = view.getAllByTestId("workflow-artifact-tile-version");
    expect(versions).toHaveLength(1);
    expect(versions[0]!.textContent).toBe("v2");
    // 可点：真按钮、aria-label、↗ 在场、交出 id；tooltip 是「种类词 · 标题」。
    expect(lines[1]!.tagName).toBe("BUTTON");
    expect(lines[1]!.hasAttribute("disabled")).toBe(false);
    expect(lines[1]!.getAttribute("aria-label")).toBe("Open artifact: sources.csv");
    expect(lines[1]!.getAttribute("title")).toBe("File · sources.csv");
    expect(view.getAllByTestId("workflow-artifact-tile-open")).toHaveLength(3);
    fireEvent.click(lines[1]!);
    expect(onOpenArtifact).toHaveBeenCalledWith("sources");
    // 没有门。
    expect(view.queryByTestId("workflow-completion-more")).toBeNull();
  });

  it("没有回调：行禁用、无 aria-label、无 ↗；版本仍在", () => {
    const view = renderCard();
    const lines = view.getAllByTestId("workflow-completion-line");
    expect(lines.every((line) => line.hasAttribute("disabled"))).toBe(true);
    expect(lines[0]!.getAttribute("aria-label")).toBeNull();
    expect(view.queryByTestId("workflow-artifact-tile-open")).toBeNull();
    expect(view.getAllByTestId("workflow-artifact-tile-version")).toHaveLength(1);
  });

  it("一件产物即交付物（单件规则）：画成交付物行，框仍是 160 × 100 的缩略图档，不撑成横幅；没有索引", () => {
    const one = renderCard({ artifacts: ARTIFACTS.slice(0, 1) });
    expect(one.queryByTestId("workflow-completion-index")).toBeNull();
    const row = one.getByTestId("workflow-completion-row");
    expect(row.getAttribute("data-artifact-id")).toBe("brief");
    const frame = one.getByTestId("workflow-artifact-row-frame");
    expect(frame.className).toContain("w-[160px]");
    expect(frame.className).toContain("h-[100px]");
    expect(frame.className).not.toContain("aspect-[16/6]");
  });

  it("超过六件：五行 + 一行「N more」——一扇门（↗ 常在，点开 run 侧板）；六件全画；砍过时「… more」且无回调则禁用", () => {
    const many = Array.from({ length: 7 }, (_unused, index) => ({
      id: `a${index}`,
      kind: "file" as const,
      title: `产物 ${index}`,
      version: 1,
    }));
    const onOpenRun = vi.fn();
    const view = renderCard({ artifacts: many, onOpenRun });
    expect(view.getAllByTestId("workflow-completion-line")).toHaveLength(COMPLETION_INDEX_MAX - 1);
    const more = view.getByTestId("workflow-completion-more") as HTMLButtonElement;
    expect(more.textContent).toBe("2 more");
    expect(more.getAttribute("data-variant")).toBe("more");
    expect(more.getAttribute("title")).toBe("Open run details");
    expect(within(more).getByTestId("workflow-artifact-tile-open").className).toContain(
      "wf-pill-go-rest",
    );
    fireEvent.click(more);
    expect(onOpenRun).toHaveBeenCalledTimes(1);
    cleanup();
    const six = renderCard({ artifacts: many.slice(0, 6) });
    expect(six.getAllByTestId("workflow-completion-line")).toHaveLength(COMPLETION_INDEX_MAX);
    expect(six.queryByTestId("workflow-completion-more")).toBeNull();
    cleanup();
    const truncated = renderCard({ artifacts: many.slice(0, 4), artifactsTruncated: true });
    expect(truncated.getAllByTestId("workflow-completion-line")).toHaveLength(4);
    const dumb = truncated.getByTestId("workflow-completion-more") as HTMLButtonElement;
    expect(dumb.textContent).toBe("… more");
    expect(dumb.disabled).toBe(true);
    expect(within(dumb).queryByTestId("workflow-artifact-tile-open")).toBeNull();
  });

  it("预览只交给交付物的框：没有交付物时不问预览；零产物没有产物区、卡仍画", () => {
    const renderPreview = vi.fn((_artifact: WorkflowCompletionArtifact) => undefined);
    const view = renderCard({ renderPreview });
    expect(renderPreview).not.toHaveBeenCalled();
    expect(view.getByTestId("workflow-completion-index")).toBeTruthy();
    cleanup();
    const empty = renderCard({ artifacts: [] });
    expect(empty.queryByTestId("workflow-completion-index")).toBeNull();
    expect(empty.queryByTestId("workflow-completion-row")).toBeNull();
    expect(empty.getByTestId("workflow-completion-figures")).toBeTruthy();
  });

  it("行依次落地：第 k 行延迟 k × 30 ms 且 backwards 填充；四格排在行之后", () => {
    const view = renderCard();
    const lines = view.getAllByTestId("workflow-completion-line");
    expect(lines[0]!.style.animationDelay).toBe("30ms");
    expect(lines[2]!.style.animationDelay).toBe("90ms");
    expect(lines[2]!.style.animationFillMode).toBe("backwards");
    expect(view.getByTestId("workflow-completion-figure-time").style.animationDelay).toBe("120ms");
    expect(view.getByTestId("workflow-completion-figure-phases").style.animationDelay).toBe(
      "210ms",
    );
  });
});

// 交付物（docs/dynamic-workflow/transcript-and-notifications.md「Artifact tiles」「The index」）：打了 primary 旗子的那件
// 领头成一行，其余是细线之下的索引行；第七件起五行 + 「N more」。UI 上没有「primary」这个词。
describe("WorkflowCompletionCard · 交付物", () => {
  const REPORT: WorkflowCompletionArtifact = {
    id: "report",
    kind: "markdown",
    title: "季度基准报告",
    description: "对比十二个服务的 p50 / p99 延迟与上季度基线；确认三处回归，给出两项修复建议。",
    version: 3,
    bytes: 24_576,
    primary: true,
  };
  const others = (count: number): WorkflowCompletionArtifact[] =>
    Array.from({ length: count }, (_unused, index) => ({
      id: `n${index}`,
      kind: index === 0 ? "chart" : "markdown",
      title: `产物 ${index}`,
      version: 1,
      ...(index === 0 ? { itemCount: 12 } : { bytes: 2_048 }),
    }));

  it("交付物行：框 + 一级大的标题 + 三行截断的说明 + `kind · size` 行 + 尾槽 v3；整行一颗按钮交出 id；没有标签", () => {
    const onOpenArtifact = vi.fn();
    // 旗子在清单**中间**也领头：布局按旗子选，不按位置。
    const view = renderCard({ artifacts: [...others(2), REPORT, ...others(1)], onOpenArtifact });
    const row = view.getByTestId("workflow-completion-row") as HTMLButtonElement;
    expect(row.tagName).toBe("BUTTON");
    expect(row.getAttribute("data-artifact-id")).toBe("report");
    expect(row.getAttribute("data-variant")).toBe("row");
    expect(view.getByTestId("workflow-artifact-row-title").textContent).toBe("季度基准报告");
    expect(view.getByTestId("workflow-artifact-row-title").className).toContain("text-ui-base");
    const description = view.getByTestId("workflow-artifact-row-description");
    expect(description.textContent).toContain("确认三处回归");
    expect(description.className).toContain("line-clamp-3");
    expect(view.getByTestId("workflow-artifact-row-detail").textContent).toBe("Document·24.0 KB");
    expect(within(row).getByTestId("workflow-artifact-tile-version").textContent).toBe("v3");
    expect(row.getAttribute("aria-label")).toBe("Open artifact: 季度基准报告");
    fireEvent.click(row);
    expect(onOpenArtifact).toHaveBeenCalledWith("report");
    // 没有任何「primary」字样——形态本身在说话。
    expect(view.getByTestId("workflow-completion-card-turn-1").textContent).not.toMatch(
      /primary/iu,
    );
  });

  it("说明缺席时那一行消失、行仍在；没有回调时整行禁用", () => {
    const { description: _dropped, ...bare } = REPORT;
    const view = renderCard({ artifacts: [bare, ...others(1)] });
    expect(view.queryByTestId("workflow-artifact-row-description")).toBeNull();
    const row = view.getByTestId("workflow-completion-row") as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    expect(row.getAttribute("aria-label")).toBeNull();
    expect(view.queryByTestId("workflow-artifact-tile-open")).toBeNull();
  });

  it("其余产物是细线之下的索引：一件一行、两列流、细节就在行上；≤ 6 行全画、没有门", () => {
    const view = renderCard({ artifacts: [REPORT, ...others(6)] });
    const index = view.getByTestId("workflow-completion-index");
    expect(index.className).toContain("border-t");
    expect(index.className).toContain("repeat(auto-fit,minmax(220px,1fr))");
    const lines = view.getAllByTestId("workflow-completion-line");
    expect(lines).toHaveLength(6);
    expect(lines.map((line) => line.getAttribute("data-artifact-id"))).toEqual([
      "n0",
      "n1",
      "n2",
      "n3",
      "n4",
      "n5",
    ]);
    const details = view.getAllByTestId("workflow-artifact-line-detail");
    expect(details[0]!.textContent).toBe("12 items");
    expect(details[1]!.textContent).toBe("2.0 KB");
    expect(lines[0]!.getAttribute("title")).toBe("Chart · 产物 0");
    expect(view.queryByTestId("workflow-completion-more")).toBeNull();
    // 索引不画框：整卡只有交付物那一个框（这里没交预览，所以是一张纸页字形）。
    expect(view.getAllByTestId("workflow-artifact-sheet")).toHaveLength(1);
  });

  it("第七件起：五行 + 「N more」（点开 run 侧板）；zh「还有 N 个」；砍过时 `…`；无回调则禁用", () => {
    const onOpenRun = vi.fn();
    const view = renderCard({ artifacts: [REPORT, ...others(7)], onOpenRun });
    expect(view.getAllByTestId("workflow-completion-line")).toHaveLength(5);
    const more = view.getByTestId("workflow-completion-more") as HTMLButtonElement;
    expect(more.textContent).toBe("2 more");
    expect(more.getAttribute("title")).toBe("Open run details");
    fireEvent.click(more);
    expect(onOpenRun).toHaveBeenCalledTimes(1);
    cleanup();
    const zh = renderCard({ artifacts: [REPORT, ...others(7)], onOpenRun }, "zh-CN");
    expect(zh.getByTestId("workflow-completion-more").textContent).toBe("还有 2 个");
    cleanup();
    const truncated = renderCard({ artifacts: [REPORT, ...others(3)], artifactsTruncated: true });
    expect(truncated.getAllByTestId("workflow-completion-line")).toHaveLength(3);
    const dumb = truncated.getByTestId("workflow-completion-more") as HTMLButtonElement;
    expect(dumb.textContent).toBe("… more");
    expect(dumb.disabled).toBe(true);
    for (const key of ["chat.toolCall.workflow.completion.moreArtifacts"]) {
      expect(enUS).toHaveProperty(key);
      expect(zhCN).toHaveProperty(key);
    }
  });

  it("预览只问交付物一次；节拍：行 30 ms、索引行依次、门在最后一行之后、四格接在门之后", () => {
    const renderPreview = vi.fn((_artifact: WorkflowCompletionArtifact) => undefined);
    const view = renderCard({ artifacts: [REPORT, ...others(7)], renderPreview });
    expect(renderPreview.mock.calls.map(([artifact]) => artifact.id)).toEqual(["report"]);
    expect(view.getByTestId("workflow-completion-row").style.animationDelay).toBe("30ms");
    const lines = view.getAllByTestId("workflow-completion-line");
    expect(lines[0]!.style.animationDelay).toBe("60ms");
    expect(lines[4]!.style.animationDelay).toBe("180ms");
    expect(view.getByTestId("workflow-completion-more").style.animationDelay).toBe("210ms");
    // 7 格（行 + 5 行 + 门）之后才是四格。
    expect(view.getByTestId("workflow-completion-figure-time").style.animationDelay).toBe("240ms");
    // 没交预览时行里是纸页字形——整卡唯一的一张。
    expect(view.getAllByTestId("workflow-artifact-sheet")).toHaveLength(1);
  });
});

describe("formatCompactCount / workDuration", () => {
  it("tokens 紧凑写法：千位一位小数、百万两位；千以下原样", () => {
    expect(formatCompactCount(812)).toEqual({ value: "812", unit: "" });
    expect(formatCompactCount(386_412)).toEqual({ value: "386.4", unit: "k" });
    expect(formatCompactCount(1_304_118)).toEqual({ value: "1.30", unit: "M" });
  });

  it("时长拆段：最多两段、至少 1 秒；与「工作了」的写法同源", () => {
    const format = ({ id }: { id: string }) => id.split(".").at(-1)!.charAt(0);
    expect(workDurationParts(0, format)).toEqual([{ value: 1, unit: "s" }]);
    expect(workDurationParts(3_725_000, format)).toEqual([
      { value: 1, unit: "h" },
      { value: 2, unit: "m" },
    ]);
    expect(formatWorkDuration(102_000, format, "en-US")).toBe("1m 42s");
    expect(formatWorkDuration(102_000, format, "zh-CN")).toBe("1 m 42 s");
    expect(formatWorkDuration(undefined, format, "en-US")).toBeNull();
  });
});
