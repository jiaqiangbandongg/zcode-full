import { describe, expect, it } from "vitest";

import {
  buildConversationPreviewArtifactCandidates,
  type ConversationPreviewFileChange,
} from "../src/conversation-preview-artifacts.js";

const workspacePath = "/workspace";

function fileChange(path: string, overrides: Partial<ConversationPreviewFileChange> = {}) {
  return {
    path,
    state: "active" as const,
    ...overrides,
  };
}

describe("conversation preview artifact candidates", () => {
  it("把 .md 标成 md 类型而不是 html", () => {
    // 之前 .md 被标成 artifactType html + mime text/markdown，报错文案因此出现
    // 「HTML（.md / text/markdown）」这种组合，也对不上服务端的 md 白名单条目。
    const candidates = buildConversationPreviewArtifactCandidates({
      productTurnId: "turn-1",
      assistantText: "已生成 报告.md",
      workspacePath,
      fileChanges: [fileChange("/workspace/报告.md")],
    });

    expect(candidates).toEqual([
      expect.objectContaining({
        artifactType: "md",
        mimeType: "text/markdown",
        previewKind: "markdown",
        displayName: "报告.md",
      }),
    ]);
  });

  it("uses explicit assistant references and ignores unreferenced fileChanges", () => {
    const candidates = buildConversationPreviewArtifactCandidates({
      productTurnId: "turn-1",
      assistantText: "已生成 report.pdf",
      workspacePath,
      fileChanges: [fileChange("/workspace/report.pdf"), fileChange("/workspace/temp.pdf")],
    });

    expect(candidates.map((candidate) => candidate.sourceRef)).toEqual(["/workspace/report.pdf"]);
  });

  it("allows Office/PDF references without fileChanges", () => {
    const candidates = buildConversationPreviewArtifactCandidates({
      productTurnId: "turn-1",
      assistantText: "下载 report.pdf 和 slides.pptx",
      workspacePath,
    });

    expect(candidates.map((candidate) => candidate.displayName)).toEqual([
      "slides.pptx",
      "report.pdf",
    ]);
  });

  it("只把显式预览引用纳入候选，忽略正文里的 ~/ 路径并支持视频媒体", () => {
    const candidates = buildConversationPreviewArtifactCandidates({
      productTurnId: "turn-1",
      assistantText:
        '~/Code/vibe/shows/deliver/晨报.pdf ::zcode-file-citation{path="/workspace/晨报.pdf"} out/a.mp4 out/b.mp4 out/c.mp4',
      workspacePath,
    });

    expect(candidates.map((candidate) => candidate.displayName)).toEqual([
      "c.mp4",
      "b.mp4",
      "a.mp4",
      "晨报.pdf",
    ]);
    expect(candidates.filter((candidate) => candidate.artifactType === "video")).toHaveLength(3);
  });

  it("requires active fileChanges for Markdown and HTML", () => {
    const candidates = buildConversationPreviewArtifactCandidates({
      productTurnId: "turn-1",
      assistantText: "README.md index.html report.pdf",
      workspacePath,
      fileChanges: [fileChange("/workspace/README.md"), fileChange("/workspace/index.html")],
    });

    expect(candidates.map((candidate) => candidate.displayName)).toEqual([
      "report.pdf",
      "index.html",
      "README.md",
    ]);

    expect(
      buildConversationPreviewArtifactCandidates({
        productTurnId: "turn-1",
        assistantText: "README.md index.html",
        workspacePath,
      }),
    ).toEqual([]);
  });

  it("rejects escaped paths and unknown extensions", () => {
    const candidates = buildConversationPreviewArtifactCandidates({
      productTurnId: "turn-1",
      assistantText: "../secret.pdf /tmp/other.pdf report.txt",
      workspacePath,
    });

    expect(candidates).toEqual([]);
  });

  it("deduplicates the same canonical path referenced multiple times", () => {
    const candidates = buildConversationPreviewArtifactCandidates({
      productTurnId: "turn-1",
      assistantText: "report.pdf ./report.pdf",
      workspacePath,
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.sourceRef).toBe("/workspace/report.pdf");
  });

  it("matches UI order by keeping the latest duplicate before applying the candidate limit", () => {
    const candidates = buildConversationPreviewArtifactCandidates({
      productTurnId: "turn-1",
      assistantText: "report.pdf summary.pdf ./report.pdf",
      workspacePath,
    });

    expect(candidates.map((candidate) => candidate.sourceRef)).toEqual([
      "/workspace/report.pdf",
      "/workspace/summary.pdf",
    ]);
  });

  it("removes reverted Markdown/HTML candidates but keeps Office/PDF behavior", () => {
    const candidates = buildConversationPreviewArtifactCandidates({
      productTurnId: "turn-1",
      assistantText: "README.md index.html report.pdf",
      workspacePath,
      fileChanges: [
        fileChange("/workspace/README.md", { state: "reverted" }),
        fileChange("/workspace/index.html", { state: "reverted" }),
      ],
    });

    expect(candidates.map((candidate) => candidate.displayName)).toEqual(["report.pdf"]);
  });
});
