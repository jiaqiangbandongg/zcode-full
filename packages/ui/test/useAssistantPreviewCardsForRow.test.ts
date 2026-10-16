// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AssistantTextRow } from "@zcode/shared/zcode-protocol-v4";
import { useAssistantPreviewCardsForAssistantTextRow } from "@/v4/useAssistantPreviewCardsForRow.js";

const { extractAssistantFileReferencesSpy } = vi.hoisted(() => ({
  extractAssistantFileReferencesSpy: vi.fn(),
}));

vi.mock("@/lib/assistantFileReferences.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/assistantFileReferences.js")>();
  const extractAssistantFileReferences: typeof actual.extractAssistantFileReferences = (
    content,
    workspacePath,
  ) => {
    extractAssistantFileReferencesSpy(content, workspacePath);
    return actual.extractAssistantFileReferences(content, workspacePath);
  };
  return {
    ...actual,
    extractAssistantFileReferences,
    hasAssistantPreviewFileChangeCandidates: (content: string, workspacePath: string) =>
      extractAssistantFileReferences(content, workspacePath).some(
        (reference) => reference.kind === "markdown" || reference.kind === "html",
      ),
  };
});

function assistantText(text: string): AssistantTextRow {
  return {
    rowId: 2,
    entityId: "assistant-2",
    turnId: "turn-1",
    createdAt: 2,
    createdAtSeq: 2,
    kind: "assistantText",
    state: "complete",
    text,
  };
}

describe("useAssistantPreviewCardsForAssistantTextRow", () => {
  it("异步读取本轮 fileChanges 后只放行 active Markdown/HTML 卡片", async () => {
    const row = assistantText("README.md report.pdf index.html");
    const fileChangesTarget = { rowId: 1, entityId: "turn-header-1" };
    const fetchFileChanges = vi.fn(async () => ({
      state: "active" as const,
      items: [
        { path: "/workspace/README.md", patches: [] },
        { path: "/workspace/index.html", patches: [] },
      ],
    }));

    const { result } = renderHook(() =>
      useAssistantPreviewCardsForAssistantTextRow({
        row,
        assistantTextRows: [row],
        latestAssistantTextRow: row,
        workspacePath: "/workspace",
        fileChangesTarget,
        fileChangesState: "active",
        fetchFileChanges,
      }),
    );

    await waitFor(() => {
      expect(result.current.map((card) => card.title)).toEqual([
        "index.html",
        "report.pdf",
        "README.md",
      ]);
    });
    expect(fetchFileChanges).toHaveBeenCalledWith(fileChangesTarget, {
      cachePolicy: "terminal",
      fileChangesState: "active",
    });
  });

  it("fileChanges 从 active 切为 reverted 后立即清除 Markdown/HTML 卡片", async () => {
    const row = assistantText("README.md report.pdf index.html");
    const fileChangesTarget = { rowId: 1, entityId: "turn-header-1" };
    const fetchFileChanges = vi.fn(async () => ({
      state: "active" as const,
      items: [
        { path: "/workspace/README.md", patches: [] },
        { path: "/workspace/index.html", patches: [] },
      ],
    }));

    const { result, rerender } = renderHook(
      ({ fileChangesState }: { fileChangesState: "active" | "reverted" }) =>
        useAssistantPreviewCardsForAssistantTextRow({
          row,
          assistantTextRows: [row],
          latestAssistantTextRow: row,
          workspacePath: "/workspace",
          fileChangesTarget,
          fileChangesState,
          fetchFileChanges,
        }),
      { initialProps: { fileChangesState: "active" as const } },
    );

    await waitFor(() => {
      expect(result.current.map((card) => card.title)).toEqual([
        "index.html",
        "report.pdf",
        "README.md",
      ]);
    });

    rerender({ fileChangesState: "reverted" });

    expect(result.current.map((card) => card.title)).toEqual(["report.pdf"]);
    expect(fetchFileChanges).toHaveBeenCalledTimes(1);
  });

  it("缺少 turnHeader target 时不使用 assistant row 查询 fileChanges", async () => {
    const row = assistantText("index.html report.pdf");
    const fetchFileChanges = vi.fn();

    const { result } = renderHook(() =>
      useAssistantPreviewCardsForAssistantTextRow({
        row,
        assistantTextRows: [row],
        latestAssistantTextRow: row,
        workspacePath: "/workspace",
        fileChangesTarget: null,
        fetchFileChanges,
      }),
    );

    await waitFor(() => {
      expect(result.current.map((card) => card.title)).toEqual(["report.pdf"]);
    });
    expect(fetchFileChanges).not.toHaveBeenCalled();
  });

  it("fileChanges 不可用时只抑制 Markdown/HTML，不影响 Office/PDF", async () => {
    const row = assistantText("README.md report.docx paper.pdf");

    const { result } = renderHook(() =>
      useAssistantPreviewCardsForAssistantTextRow({
        row,
        assistantTextRows: [row],
        latestAssistantTextRow: row,
        workspacePath: "/workspace",
        fileChangesTarget: null,
      }),
    );

    await waitFor(() => {
      expect(result.current.map((card) => card.title)).toEqual(["paper.pdf", "report.docx"]);
    });
  });

  it("Web 远控隐藏本地 URL 和 HTML，同时保留本轮 Markdown 与 Office/PDF", async () => {
    const row = assistantText("http://localhost:5173 README.md index.html report.docx paper.pdf");
    const fileChangesTarget = { rowId: 1, entityId: "turn-header-1" };
    const fetchFileChanges = vi.fn(async () => ({
      state: "active" as const,
      items: [
        { path: "/workspace/README.md", patches: [] },
        { path: "/workspace/index.html", patches: [] },
      ],
    }));

    const { result } = renderHook(() =>
      useAssistantPreviewCardsForAssistantTextRow({
        row,
        assistantTextRows: [row],
        latestAssistantTextRow: row,
        workspacePath: "/workspace",
        fileChangesTarget,
        fileChangesState: "active",
        fetchFileChanges,
        compactForRemoteControl: true,
      }),
    );

    await waitFor(() => {
      expect(result.current.map((card) => card.title)).toEqual([
        "paper.pdf",
        "report.docx",
        "README.md",
      ]);
    });
  });

  it("Web 远控只有本地 URL 和 HTML 候选时不读取 fileChanges", () => {
    const row = assistantText("http://127.0.0.1:4173 index.html report.pdf");
    const fetchFileChanges = vi.fn();

    const { result } = renderHook(() =>
      useAssistantPreviewCardsForAssistantTextRow({
        row,
        assistantTextRows: [row],
        latestAssistantTextRow: row,
        workspacePath: "/workspace",
        fileChangesTarget: { rowId: 1, entityId: "turn-header-1" },
        fileChangesState: "active",
        fetchFileChanges,
        compactForRemoteControl: true,
      }),
    );

    expect(result.current.map((card) => card.title)).toEqual(["report.pdf"]);
    expect(fetchFileChanges).not.toHaveBeenCalled();
  });

  it("流式行不提前查询 fileChanges", () => {
    const row = { ...assistantText("README.md"), state: "streaming" as const };
    const fetchFileChanges = vi.fn();

    const { result } = renderHook(() =>
      useAssistantPreviewCardsForAssistantTextRow({
        row,
        assistantTextRows: [row],
        latestAssistantTextRow: row,
        workspacePath: "/workspace",
        fileChangesTarget: null,
        fetchFileChanges,
      }),
    );

    expect(result.current).toEqual([]);
    expect(fetchFileChanges).not.toHaveBeenCalled();
  });

  it("相同文本使用新的 rows 引用重渲染时不重复抽取文件", () => {
    extractAssistantFileReferencesSpy.mockClear();
    const initialRow = assistantText("report.pdf");
    const { result, rerender } = renderHook(
      ({ currentRow }: { currentRow: AssistantTextRow }) =>
        useAssistantPreviewCardsForAssistantTextRow({
          row: currentRow,
          assistantTextRows: [currentRow],
          latestAssistantTextRow: currentRow,
          workspacePath: "/workspace",
          fileChangesTarget: null,
        }),
      { initialProps: { currentRow: initialRow } },
    );

    expect(result.current.map((card) => card.title)).toEqual(["report.pdf"]);
    rerender({ currentRow: { ...initialRow } });

    expect(result.current.map((card) => card.title)).toEqual(["report.pdf"]);
    expect(extractAssistantFileReferencesSpy).toHaveBeenCalledTimes(1);
  });
});
