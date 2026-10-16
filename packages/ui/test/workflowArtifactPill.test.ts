// @vitest-environment jsdom

// 产物药丸与产物条（docs/dynamic-workflow/presentation.md「The run card」）：与子代理药丸同一套
// 语法——方瓦片代替圆头像，尾槽放版本号；永远是 <button>，没有回调即禁用；条 ≤ 3 枚 + `+N`，
// 事件在条这一层止步。四处（工具卡、轮尾摘要、通知行、中枢）共用这两个组件。
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  WorkflowArtifactPill,
  type ArtifactPillData,
} from "@/components/workflow-timeline/WorkflowArtifactPill.js";
import { WorkflowArtifactStrip } from "@/components/workflow-timeline/WorkflowArtifactStrip.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

afterEach(() => {
  cleanup();
});

const BOOK: ArtifactPillData = { id: "book", kind: "file", title: "Audit report", version: 2 };

function renderPill(
  props: Partial<Parameters<typeof WorkflowArtifactPill>[0]> = {},
  locale: "en-US" | "zh-CN" = "en-US",
) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(WorkflowArtifactPill, { artifact: BOOK, ...props }),
    ),
  );
}

function renderStrip(
  props: Partial<Parameters<typeof WorkflowArtifactStrip>[0]> & {
    artifacts: readonly ArtifactPillData[];
  },
  locale: "en-US" | "zh-CN" = "en-US",
) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(WorkflowArtifactStrip, {
        testId: "strip",
        pillTestId: "pill",
        moreTestId: "more",
        ...props,
      }),
    ),
  );
}

describe("WorkflowArtifactPill", () => {
  it("可打开：真按钮、瓦片带 kind 图标、尾槽里版本号与 ↗ 同格；点了交出产物 id", () => {
    const onOpen = vi.fn();
    const view = renderPill({ onOpen });
    const pill = view.getByTestId("workflow-artifact-pill") as HTMLButtonElement;
    expect(pill.tagName).toBe("BUTTON");
    expect(pill.disabled).toBe(false);
    expect(pill.className).toContain("wf-pill-open");
    expect(pill.getAttribute("data-artifact-open")).toBe("true");
    expect(pill.getAttribute("data-pill-size")).toBe("md");
    expect(pill.getAttribute("title")).toBe("File · Audit report");
    expect(pill.getAttribute("aria-label")).toBe("Open artifact: Audit report");
    expect(pill.querySelector(":scope > svg")).not.toBeNull();
    const tail = view.getByTestId("workflow-pill-tail");
    expect(tail.querySelector('[data-testid="workflow-run-artifact-version"]')?.textContent).toBe(
      "v2",
    );
    expect(tail.querySelector('[data-testid="workflow-artifact-pill-open"]')).not.toBeNull();
    fireEvent.click(pill);
    expect(onOpen).toHaveBeenCalledWith("book");
  });

  it("没有回调：禁用、没有 aria-label、没有 ↗；版本号仍在（事实与能力分开）", () => {
    const view = renderPill();
    const pill = view.getByTestId("workflow-artifact-pill") as HTMLButtonElement;
    expect(pill.disabled).toBe(true);
    expect(pill.className).not.toContain("wf-pill-open");
    expect(pill.getAttribute("aria-label")).toBeNull();
    expect(view.queryByTestId("workflow-artifact-pill-open")).toBeNull();
    expect(view.getByTestId("workflow-run-artifact-version").textContent).toBe("v2");
  });

  it("v1 不写版本；v1 且不可打开时尾槽整个缺席", () => {
    const view = renderPill({ artifact: { ...BOOK, version: 1 } });
    expect(view.queryByTestId("workflow-run-artifact-version")).toBeNull();
    expect(view.queryByTestId("workflow-pill-tail")).toBeNull();
    cleanup();
    const noVersion = renderPill({ artifact: { id: "x", kind: "markdown" }, onOpen: vi.fn() });
    expect(noVersion.queryByTestId("workflow-run-artifact-version")).toBeNull();
    expect(noVersion.getByTestId("workflow-pill-tail")).toBeTruthy();
  });

  it("小号：24px 行高的类；标题缺席退回 id；截字只在要求时发生", () => {
    const long = { id: "long", kind: "table" as const, title: "一".repeat(40), version: 1 };
    const view = renderPill({ artifact: long, size: "sm", truncateTitle: true });
    const pill = view.getByTestId("workflow-artifact-pill");
    expect(pill.getAttribute("data-pill-size")).toBe("sm");
    expect(pill.className).toContain("h-6");
    expect(pill.querySelector(".wf-pill-name")?.textContent?.length).toBeLessThan(40);
    expect(pill.getAttribute("title")).toBe(`Table · ${"一".repeat(40)}`);
    cleanup();
    const bare = renderPill({ artifact: { id: "bare", kind: "file" } });
    expect(
      bare.getByTestId("workflow-artifact-pill").querySelector(".wf-pill-name")?.textContent,
    ).toBe("bare");
  });

  it("zh-CN：tooltip 用中文 kind 词，尾槽仍是 v2，长写「第 2 版」进 title", () => {
    const view = renderPill({}, "zh-CN");
    expect(view.getByTestId("workflow-artifact-pill").getAttribute("title")).toBe(
      "文件 · Audit report",
    );
    const version = view.getByTestId("workflow-run-artifact-version");
    expect(version.textContent).toBe("v2");
    expect(version.getAttribute("title")).toBe("第 2 版");
  });

  it("入场延迟写成 animation-delay + backwards 填充", () => {
    const view = renderPill({ enterDelayMs: 60 });
    const style = view.getByTestId("workflow-artifact-pill").getAttribute("style") ?? "";
    expect(style).toContain("animation-delay: 60ms");
    expect(style).toContain("animation-fill-mode: backwards");
  });
});

describe("WorkflowArtifactStrip", () => {
  const FOUR: ArtifactPillData[] = [
    BOOK,
    { id: "perf", kind: "chart", title: "Round timings", version: 1 },
    { id: "notes", kind: "markdown", title: "Notes", version: 1 },
    { id: "kpi", kind: "metrics", title: "KPIs", version: 3 },
  ];

  it("至多三枚，其余折成 +N；每枚依次错开入场", () => {
    const view = renderStrip({ artifacts: FOUR, onOpenArtifact: vi.fn() });
    const pills = view.getAllByTestId("pill");
    expect(pills).toHaveLength(3);
    expect(pills.map((pill) => pill.getAttribute("data-artifact-id"))).toEqual([
      "book",
      "perf",
      "notes",
    ]);
    expect(pills[0]?.getAttribute("style")).toBeNull();
    expect(pills[2]?.getAttribute("style")).toContain("animation-delay: 60ms");
    expect(view.getByTestId("more").textContent).toBe("+1");
  });

  it("发射侧砍过：不足三枚也标「+…」；零件时整条缺席", () => {
    const view = renderStrip({ artifacts: FOUR.slice(0, 2), truncated: true });
    expect(view.getByTestId("more").textContent).toBe("+…");
    cleanup();
    expect(renderStrip({ artifacts: [] }).queryByTestId("strip")).toBeNull();
    cleanup();
    expect(renderStrip({ artifacts: FOUR.slice(0, 2) }).queryByTestId("more")).toBeNull();
  });

  it("事件只替药丸止步：药丸的点击与键盘不冒到外面的开关；条上的空白照常冒泡", () => {
    // docs/dynamic-workflow/presentation.md「The pill」：条的空白与 `+N` 是宿主可点区域
    // （轮尾摘要的整块开关）的一部分，只有药丸是自己的按钮。
    const outer = vi.fn();
    const onOpenArtifact = vi.fn();
    const view = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          "div",
          { onClick: outer, onKeyDown: outer, "data-testid": "outer" },
          createElement(WorkflowArtifactStrip, {
            artifacts: FOUR,
            onOpenArtifact,
            testId: "strip",
            pillTestId: "pill",
            moreTestId: "more",
          }),
        ),
      ),
    );
    const pill = view.getAllByTestId("pill")[0]!;
    fireEvent.click(pill);
    expect(onOpenArtifact).toHaveBeenCalledWith("book");
    fireEvent.keyDown(pill, { key: "Enter" });
    fireEvent.keyDown(pill, { key: " " });
    expect(outer).not.toHaveBeenCalled();
    // 空白、`+N` 与别的键照旧冒泡（Escape 之类归外面管）。
    fireEvent.click(view.getByTestId("strip"));
    fireEvent.click(view.getByTestId("more"));
    fireEvent.keyDown(view.getByTestId("strip"), { key: "Escape" });
    expect(outer).toHaveBeenCalledTimes(3);
  });

  it("禁用的药丸（无回调）同样止步：点它不把外面的开关点开", () => {
    const outer = vi.fn();
    const view = render(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "en-US" },
        createElement(
          "div",
          { onClick: outer, "data-testid": "outer" },
          createElement(WorkflowArtifactStrip, { artifacts: FOUR.slice(0, 1), pillTestId: "pill" }),
        ),
      ),
    );
    fireEvent.click(view.getByTestId("pill"));
    expect(outer).not.toHaveBeenCalled();
  });

  it("小号条把尺寸交给每枚药丸", () => {
    const view = renderStrip({ artifacts: FOUR.slice(0, 1), size: "sm" });
    expect(view.getByTestId("pill").getAttribute("data-pill-size")).toBe("sm");
  });

  it("词条在两种语言里都在", () => {
    for (const key of [
      "chat.toolCall.workflow.run.artifacts.versionTail",
      "chat.toolCall.workflow.card.artifact",
      "chat.toolCall.workflow.card.artifacts",
    ] as const) {
      expect(enUS[key]).toBeTruthy();
      expect(zhCN[key]).toBeTruthy();
    }
  });
});

it("Markdown 产物使用 FileDisplay 文件图标", () => {
  const view = renderPill({ artifact: { id: "md", kind: "markdown", title: "报告" } });
  expect(view.container.querySelector("img")?.getAttribute("src")).toMatch(/markdown/i);
  expect(view.container.querySelector("img")?.parentElement?.tagName).toBe("BUTTON");
  expect(view.container.querySelector(".wf-pill-tile")).toBeNull();
});
