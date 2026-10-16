import { describe, expect, it } from "vitest";
import { formatSharedContextV1 } from "../src/conversation-share/sharedContextFormatter.js";

describe("SharedContextFormatterV1", () => {
  it("稳定格式化 Rows 并把 artifact ref 改写为 workspace 相对路径", () => {
    const input = {
      share: { shareId: "share-1", title: "Research" },
      rows: [
        {
          rowId: 1,
          turnId: "turn-1",
          productTurnId: "product-1",
          createdAt: 1,
          createdAtSeq: 1,
          kind: "turnHeader" as const,
          origin: "userInput" as const,
          state: "completedSuccess" as const,
          startedAt: 1,
        },
        {
          rowId: 2,
          turnId: "turn-1",
          productTurnId: "product-1",
          createdAt: 2,
          createdAtSeq: 2,
          kind: "userInput" as const,
          origin: "realUser" as const,
          text: "Make a report",
        },
        {
          rowId: 3,
          turnId: "turn-1",
          productTurnId: "product-1",
          createdAt: 3,
          createdAtSeq: 3,
          kind: "artifact" as const,
          artifactVersionId: "artifact-1",
          logicalArtifactKey: "report",
          displayName: "report.pdf",
          artifactType: "pdf" as const,
          mimeType: "application/pdf",
          sizeBytes: 3,
          sha256: "a".repeat(64),
          ref: "zcode-artifact://share/artifact-1",
          state: "current" as const,
        },
      ],
      installedArtifacts: [
        {
          artifactId: "artifact-1",
          workspaceRelativePath: "shared-artifacts/report.pdf",
          displayName: "report.pdf",
          mimeType: "application/pdf",
          sha256: "a".repeat(64),
        },
      ],
    };
    const first = formatSharedContextV1(input);
    expect(formatSharedContextV1(input)).toEqual(first);
    expect(first.markdown).toContain("shared-artifacts/report.pdf");
    expect(first.markdown).not.toContain("zcode-artifact://");
  });

  it("把 userInput 附件写入导入后的模型上下文", () => {
    const result = formatSharedContextV1({
      share: { shareId: "share-text", title: "Pasted text" },
      rows: [
        {
          rowId: 1,
          turnId: "turn-1",
          productTurnId: "product-1",
          createdAt: 1,
          createdAtSeq: 1,
          kind: "userInput" as const,
          origin: "realUser" as const,
          text: "请分析粘贴内容",
          attachments: [
            {
              ref: "zcode-artifact://share/text-1",
              fileName: "pasted-text.txt",
              mime: "text/plain",
              bytes: 4,
            },
          ],
        },
      ],
      installedArtifacts: [
        {
          artifactId: "text-1",
          workspaceRelativePath: "shared-artifacts/pasted-text.txt",
          displayName: "pasted-text.txt",
          mimeType: "text/plain",
          sha256: "b".repeat(64),
        },
      ],
    });
    expect(result.markdown).toContain("shared-artifacts/pasted-text.txt");
    expect(result.markdown).toContain("text/plain");
  });
});
