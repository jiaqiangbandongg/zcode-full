// @vitest-environment jsdom

// 交付物行（docs/dynamic-workflow/transcript-and-notifications.md「Artifact tiles」）与它的两条呈现规则
// （`resolvePrimaryArtifact` / `orderArtifactsPrimaryFirst`，docs/dynamic-workflow/authoring.md「Ids, tags and versions」）。
// 行在完成卡与 run 侧板上的**落位**分别在 workflowCompletionCard.test.ts 与 workflowRunArtifactsSection.test.ts；
// 这里只钉行自己的形态，与两条纯函数。
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import {
  buildPresetLabels,
  orderArtifactsPrimaryFirst,
  resolvePrimaryArtifact,
} from "@/app-shell/workflow-artifacts/artifactPresentation.js";
import { WorkflowArtifactRow } from "@/components/workflow-timeline/WorkflowArtifactRow.js";
import type { WorkflowCompletionArtifact } from "@/components/workflow-timeline/WorkflowArtifactTile.js";

afterEach(() => {
  cleanup();
});

const REPORT: WorkflowCompletionArtifact = {
  id: "report",
  kind: "file",
  title: "季度基准报告",
  description: "对比十二个服务的 p50 / p99 延迟与上季度基线。",
  contentType: "application/pdf",
  sourcePath: "out/report.pdf",
  bytes: 4_194_304,
  version: 2,
  primary: true,
};

function renderRow(
  artifact: WorkflowCompletionArtifact,
  options: { locale?: "en-US" | "zh-CN"; onOpen?: (id: string) => void; title?: string } = {},
) {
  const labels = buildPresetLabels((descriptor) => descriptor.id.split(".").at(-1)!);
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: options.locale ?? "en-US" },
      createElement(WorkflowArtifactRow, {
        artifact,
        labels,
        ...(options.onOpen === undefined ? {} : { onOpen: options.onOpen }),
        ...(options.title === undefined ? {} : { title: options.title }),
      }),
    ),
  );
}

describe("WorkflowArtifactRow", () => {
  it("一颗按钮：框 160 × 100 在左，右侧标题一级大、说明三行截断、`kind · badge · size` 行、尾槽 v2 与 ↗", () => {
    const onOpen = vi.fn();
    const view = renderRow(REPORT, { onOpen });
    const row = view.getByTestId("workflow-artifact-row") as HTMLButtonElement;
    expect(row.tagName).toBe("BUTTON");
    // 框与按钮是兄弟：markdown 缩略里的控件（表格的复制按钮）不能嵌进按钮；点击面由 ::after 铺满。
    const shell = row.parentElement!;
    expect(shell.className).toContain("grid-cols-[160px_minmax(0,1fr)]");
    expect(shell.className).toContain("@max-[380px]/wf-artifacts:grid-cols-[136px_minmax(0,1fr)]");
    expect(row.className).toContain("wf-tile-hit");
    const frame = view.getByTestId("workflow-artifact-row-frame");
    expect(frame.parentElement).toBe(shell);
    expect(frame.hasAttribute("inert")).toBe(true);
    expect(row.contains(frame)).toBe(false);
    expect(row.getAttribute("data-variant")).toBe("row");
    expect(row.getAttribute("title")).toBe("File · 季度基准报告");
    expect(view.getByTestId("workflow-artifact-row-title").className).toContain("font-medium");
    expect(view.getByTestId("workflow-artifact-row-description").className).toContain(
      "line-clamp-3",
    );
    const detail = view.getByTestId("workflow-artifact-row-detail");
    expect(detail.textContent).toBe("File·PDF·4.00 MB");
    expect(view.getByTestId("workflow-run-artifact-badge").textContent).toBe("PDF");
    expect(view.getByTestId("workflow-run-artifact-bytes").textContent).toBe("4.00 MB");
    expect(view.getByTestId("workflow-artifact-tile-version").textContent).toBe("v2");
    expect(view.getByTestId("workflow-artifact-tile-open")).toBeTruthy();
    fireEvent.click(row);
    expect(onOpen).toHaveBeenCalledWith("report");
    // 没有「primary」字样。
    expect(row.textContent).not.toMatch(/primary/iu);
  });

  it("没有回调：禁用、无 aria-label、无 ↗；说明与版本仍在；tooltip 可由宿主覆盖", () => {
    const view = renderRow(REPORT, { title: "File · 季度基准报告\nout/report.pdf" });
    const row = view.getByTestId("workflow-artifact-row") as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    expect(row.getAttribute("aria-label")).toBeNull();
    expect(view.queryByTestId("workflow-artifact-tile-open")).toBeNull();
    expect(view.getByTestId("workflow-artifact-tile-version").textContent).toBe("v2");
    expect(row.getAttribute("title")).toBe("File · 季度基准报告\nout/report.pdf");
  });

  it("看板的细节是条数；说明缺席时那一行不画；v1 不写版本；zh-CN 的 kind 词", () => {
    const view = renderRow(
      { id: "perf", kind: "chart", title: "每轮耗时", version: 1, itemCount: 12 },
      { locale: "zh-CN" },
    );
    expect(view.queryByTestId("workflow-artifact-row-description")).toBeNull();
    expect(view.queryByTestId("workflow-artifact-tile-version")).toBeNull();
    expect(view.getByTestId("workflow-artifact-row-detail").textContent).toBe("图表·items");
    cleanup();
    // 字节未知、无条数：只剩 kind 词，没有点。
    const bare = renderRow({ id: "notes", kind: "markdown", version: 1 });
    expect(bare.getByTestId("workflow-artifact-row-detail").textContent).toBe("Document");
  });
});

describe("resolvePrimaryArtifact / orderArtifactsPrimaryFirst", () => {
  const a = { id: "a" };
  const b = { id: "b", primary: true as const };
  const c = { id: "c" };

  it("旗子优先，位置无关；没有旗子时只有单件才算交付物；两件以上无旗子 ⇒ 没有", () => {
    expect(resolvePrimaryArtifact([a, b, c])).toBe(b);
    expect(resolvePrimaryArtifact([a])).toBe(a);
    expect(resolvePrimaryArtifact([a, c])).toBeUndefined();
    expect(resolvePrimaryArtifact([])).toBeUndefined();
  });

  it("交付物带头，其余保持原顺序；没有旗子时原样复制（不按单件规则重排——只有一件也没什么可排）", () => {
    expect(orderArtifactsPrimaryFirst([a, b, c]).map((x) => x.id)).toEqual(["b", "a", "c"]);
    expect(orderArtifactsPrimaryFirst([b, a, c]).map((x) => x.id)).toEqual(["b", "a", "c"]);
    const plain = [a, c];
    const copy = orderArtifactsPrimaryFirst(plain);
    expect(copy).toEqual(plain);
    expect(copy).not.toBe(plain);
  });
});
