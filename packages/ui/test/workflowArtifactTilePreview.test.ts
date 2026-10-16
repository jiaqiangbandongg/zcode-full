// @vitest-environment jsdom

// 完成卡瓦片的预览区（docs/dynamic-workflow/transcript-and-notifications.md「Artifact tiles」）：产物本身的缩略。
// 字节与看板条目走 mock 的会话上下文；这里钉分派（markdown / CSV / 图片 / 看板 / 字形）、
// 「还没到」与「画不了」的区分、以及不该读字节的情形。
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/logger.js", () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));

const workflowRunArtifactRead = vi.fn();
const workflowRunArtifactData = vi.fn();

vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({ workflowRunArtifactRead, workflowRunArtifactData }),
  useHasV4Conversation: () => true,
}));

// eslint-disable-next-line import/first -- 必须在 mock 之后再引入被测组件。
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
// eslint-disable-next-line import/first
import {
  WorkflowArtifactTilePreview,
  csvPreviewRows,
  previewModeFor,
} from "@/app-shell/workflow-artifacts/WorkflowArtifactTilePreview.js";
// eslint-disable-next-line import/first
import type { WorkflowCompletionArtifact } from "@/components/workflow-timeline/WorkflowArtifactTile.js";

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  // MessageResponse 按 matchMedia 选代码块配色；jsdom 没有它。
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
  workflowRunArtifactRead.mockReset();
  workflowRunArtifactData.mockReset();
  workflowRunArtifactData.mockResolvedValue({ items: [], hasMore: false });
});

function bytesOf(text: string, mediaType: string) {
  return {
    dataBase64: btoa(unescape(encodeURIComponent(text))),
    mediaType,
    totalBytes: text.length,
    nextOffset: null,
  };
}

function renderPreview(artifact: WorkflowCompletionArtifact) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(
        "div",
        { style: { position: "relative" } },
        createElement(WorkflowArtifactTilePreview, {
          artifact,
          runId: "run-1",
          sessionId: "session-1",
          theme: "system",
        }),
      ),
    ),
  );
}

describe("previewModeFor / csvPreviewRows", () => {
  it("按 kind 与内容类型分派；超上限不读", () => {
    expect(previewModeFor({ kind: "markdown" })).toBe("markdown");
    expect(previewModeFor({ kind: "file", contentType: "text/markdown; charset=utf-8" })).toBe(
      "markdown",
    );
    expect(previewModeFor({ kind: "file", contentType: "text/csv" })).toBe("csv");
    expect(previewModeFor({ kind: "file", contentType: "image/png" })).toBe("image");
    expect(previewModeFor({ kind: "file", contentType: "application/json" })).toBe("text");
    expect(previewModeFor({ kind: "file", contentType: "application/pdf" })).toBeUndefined();
    expect(
      previewModeFor({ kind: "file", contentType: "text/csv", bytes: 300 * 1024 }),
    ).toBeUndefined();
    expect(
      previewModeFor({ kind: "file", contentType: "image/png", bytes: 5 * 1024 * 1024 }),
    ).toBeUndefined();
  });

  it("CSV 缩略：至多 6 行 × 5 列，认成对引号，长格截断", () => {
    const text = [
      'source,score,used,"a, quoted",e,f',
      ...Array.from({ length: 8 }, (_unused, index) => `row${index},0.${index},yes,x,y,z`),
    ].join("\n");
    const rows = csvPreviewRows(text);
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual(["source", "score", "used", "a, quoted", "e"]);
    expect(csvPreviewRows(`${"x".repeat(40)},1`)[0]![0]).toBe(`${"x".repeat(28)}…`);
  });
});

describe("WorkflowArtifactTilePreview", () => {
  it("markdown：先留白，字节到了画缩放的文档渲染", async () => {
    workflowRunArtifactRead.mockResolvedValue(bytesOf("# Pricing\n\nBody text.", "text/markdown"));
    const view = renderPreview({ id: "brief", kind: "markdown", version: 1 });
    expect(view.getByTestId("workflow-artifact-preview-pending")).toBeTruthy();
    await waitFor(() => expect(view.getByTestId("workflow-artifact-preview-body")).toBeTruthy());
    const body = view.getByTestId("workflow-artifact-preview-body");
    expect(body.getAttribute("data-preview-mode")).toBe("markdown");
    expect(body.className).toContain("wf-preview-doc");
    expect(body.textContent).toContain("Pricing");
    expect(workflowRunArtifactRead).toHaveBeenCalledWith(
      expect.objectContaining({ artifactId: "brief", version: 1, runId: "run-1" }),
    );
  });

  it("同一份文档在交付物行的框里与瓦片同一档：按版本读字节，没有更小的档（预览要么读得清，要么不画）", async () => {
    workflowRunArtifactRead.mockResolvedValue(bytesOf("# Digest", "text/markdown"));
    const view = renderPreview({ id: "brief", kind: "markdown", version: 3 });
    await waitFor(() => expect(view.getByTestId("workflow-artifact-preview-body")).toBeTruthy());
    expect(view.getByTestId("workflow-artifact-preview-body").className).toBe("wf-preview-doc");
    expect(workflowRunArtifactRead).toHaveBeenCalledWith(expect.objectContaining({ version: 3 }));
  });

  it("CSV：前几行成表，首行是表头", async () => {
    workflowRunArtifactRead.mockResolvedValue(
      bytesOf("source,score\na16z.com,0.91\ngartner.com,0.84", "text/csv"),
    );
    const view = renderPreview({
      id: "sources",
      kind: "file",
      version: 1,
      contentType: "text/csv",
    });
    await waitFor(() => expect(view.getByTestId("workflow-artifact-preview-body")).toBeTruthy());
    const body = view.getByTestId("workflow-artifact-preview-body");
    expect(body.getAttribute("data-preview-mode")).toBe("csv");
    expect(body.querySelectorAll("tr")).toHaveLength(3);
    expect(body.querySelector("tr")?.textContent).toContain("source");
    expect(body.textContent).toContain("a16z.com");
  });

  it("PDF / 二进制：不读字节，直接画纸页字形 + 扩展名徽字", () => {
    const view = renderPreview({
      id: "report",
      kind: "file",
      version: 1,
      contentType: "application/pdf",
      sourcePath: "out/qa-report.pdf",
    });
    expect(view.getByTestId("workflow-artifact-sheet")).toBeTruthy();
    expect(view.getByTestId("workflow-artifact-sheet-badge").textContent).toBe("PDF");
    expect(workflowRunArtifactRead).not.toHaveBeenCalled();
  });

  it("读失败：字形而不是空白，也不炸", async () => {
    workflowRunArtifactRead.mockRejectedValue(new Error("boom"));
    const view = renderPreview({ id: "brief", kind: "markdown", version: 1 });
    await waitFor(() => expect(view.getByTestId("workflow-artifact-sheet")).toBeTruthy());
    expect(view.queryByTestId("workflow-artifact-preview-pending")).toBeNull();
  });

  it("预置看板：spec 没到留白；spec 到了走 compact 渲染并拉条目", async () => {
    const pending = renderPreview({ id: "cov", kind: "chart", version: 1, itemCount: 4 });
    expect(pending.getByTestId("workflow-artifact-preview-pending")).toBeTruthy();
    expect(workflowRunArtifactRead).not.toHaveBeenCalled();
    cleanup();
    const view = renderPreview({
      id: "cov",
      kind: "chart",
      version: 1,
      itemCount: 1,
      spec: { type: "line", x: "round", y: "ms" },
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      view.getByTestId("workflow-artifact-preview-body").getAttribute("data-preview-mode"),
    ).toBe("preset");
    expect(workflowRunArtifactData).toHaveBeenCalledWith(
      expect.objectContaining({ artifactId: "cov", runId: "run-1" }),
    );
  });
});
