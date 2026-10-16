import type { ConversationRow } from "@zcode/shared";
import { describe, expect, it } from "vitest";

import {
  assertConversationSharePublicProjection,
  buildConversationSharePublicProjection,
} from "../src/conversation-share/conversationSharePublicProjection.js";

function rowsWithCompletedSubagent(): ConversationRow[] {
  return [
    {
      rowId: 101,
      turnId: "local-turn-a",
      entityId: "local-entity-header",
      productTurnId: "local-product-turn-a",
      createdAt: 1_000,
      createdAtSeq: 10,
      actions: { canFork: true },
      kind: "turnHeader",
      origin: "userInput",
      executionKind: "agent",
      state: "completedSuccess",
      startedAt: 1_000,
      endedAt: 1_900,
      activeMs: 700,
      workSegments: [
        {
          segmentId: "segment-1",
          triggerEntityId: "local-entity-tool",
          startedAt: 1_100,
          endedAt: 1_800,
          activeMs: 700,
        },
      ],
      originMeta: {
        backgroundSource: "subagent",
        workId: "local-work-header",
        title: "后台结果",
      },
      fileChanges: { additions: 3, deletions: 1, files: 1 },
    },
    {
      rowId: 102,
      turnId: "local-turn-a",
      entityId: "local-entity-user",
      productTurnId: "local-product-turn-a",
      createdAt: 1_010,
      createdAtSeq: 11,
      actions: { canEdit: true },
      kind: "userInput",
      text: "请分析并生成报告",
      origin: "backgroundResult",
      originMeta: {
        backgroundSource: "subagent",
        workId: "local-work-user",
        senderSessionId: "local-child-session",
        senderLabel: "研究助手",
      },
      sourceCommandId: "source-command",
      rootSourceCommandId: "root-source-command",
      clientId: "client-desktop",
    },
    {
      rowId: 103,
      turnId: "local-turn-a",
      entityId: "local-entity-tool",
      productTurnId: "local-product-turn-a",
      createdAt: 1_020,
      createdAtSeq: 12,
      actions: { canRetry: true },
      kind: "toolCall",
      toolCallId: "local-tool-call",
      toolName: "Agent",
      status: "success",
      inputText: '{"description":"研究"}',
      input: { description: "研究" },
      output: { text: "子任务已完成" },
      progress: { bytes: 12, previewLine: "running", updatedAt: 1_500 },
      approvalInteractionId: "approval-1",
      backgrounded: true,
      workId: "local-work-tool",
      startedAt: 1_100,
      endedAt: 1_700,
    },
    {
      rowId: 104,
      turnId: "local-turn-a",
      entityId: "local-entity-subagent",
      productTurnId: "local-product-turn-a",
      createdAt: 1_030,
      createdAtSeq: 13,
      kind: "subagent",
      parentToolCallId: "local-tool-call",
      subagentType: "research",
      status: "success",
      summaryText: "研究完成",
      childSessionId: "local-child-session",
      startedAt: 1_100,
      endedAt: 1_700,
    },
    {
      rowId: 105,
      turnId: "local-turn-a",
      entityId: "local-entity-assistant",
      productTurnId: "local-product-turn-a",
      createdAt: 1_040,
      createdAtSeq: 14,
      actions: { canFork: true },
      kind: "assistantText",
      text: "报告已经生成",
      state: "complete",
      model: "glm",
      feedback: "like",
    },
  ];
}

function build(rows = rowsWithCompletedSubagent()) {
  return buildConversationSharePublicProjection({
    rows,
    selectedProductTurnIds: ["local-product-turn-a"],
  });
}

function expectBuildFailure(rows: ConversationRow[], kind: string): void {
  try {
    build(rows);
    throw new Error("Expected public projection construction to fail");
  } catch (error) {
    expect(error).toMatchObject({ kind });
  }
}

describe("conversation share public projection", () => {
  it("SHARE02：重建 artifact 公开身份并保留本地读取引用在 sidecar", () => {
    const rows = rowsWithCompletedSubagent();
    rows.push({
      rowId: 106,
      turnId: "local-turn-a",
      entityId: "local-artifact-entity",
      productTurnId: "local-product-turn-a",
      createdAt: 1_050,
      createdAtSeq: 15,
      kind: "artifact",
      artifactVersionId: "local-artifact-version",
      logicalArtifactKey: "local-report-key",
      displayName: "report.pdf",
      artifactType: "pdf",
      mimeType: "application/pdf",
      sizeBytes: 4,
      sha256: "a".repeat(64),
      ref: "/workspace/report.pdf",
      state: "current",
    });

    const result = build(rows);
    expect(result.rows.at(-1)).toMatchObject({
      kind: "artifact",
      artifactVersionId: "share-artifact-1",
      logicalArtifactKey: "share-artifact-key-1",
      ref: "zcode-artifact://share/share-artifact-1",
      productTurnId: "share-product-turn-1",
    });
    expect(result.artifacts).toEqual([
      {
        sourceRef: "/workspace/report.pdf",
        descriptor: {
          artifact_id: "share-artifact-1",
          logical_artifact_key: "share-artifact-key-1",
          producer_product_turn_id: "share-product-turn-1",
          artifact_version: 1,
          state: "current",
          ref: "zcode-artifact://share/share-artifact-1",
          artifact_type: "pdf",
          display_name: "report.pdf",
          extension: "pdf",
          mime_type: "application/pdf",
          size_bytes: 4,
          sha256: "a".repeat(64),
        },
      },
    ]);
    expect(JSON.stringify(result.rows)).not.toContain("/workspace/report.pdf");
  });

  it("filters completed subagent details while preserving Agent toolCall and public content", () => {
    const result = build();

    expect(result.selectedProductTurnIds).toEqual(["share-product-turn-1"]);
    expect(result.rows.map((row) => row.kind)).toEqual([
      "turnHeader",
      "userInput",
      "toolCall",
      "assistantText",
    ]);
    expect(result.rows.map((row) => row.rowId)).toEqual([1, 2, 3, 4]);
    expect(result.rows.map((row) => row.entityId)).toEqual([
      "share-entity-1",
      "share-entity-2",
      "share-entity-3",
      "share-entity-4",
    ]);
    expect(result.rows.every((row) => row.productTurnId === "share-product-turn-1")).toBe(true);
    expect(result.rows[0]).toMatchObject({
      kind: "turnHeader",
      turnId: "share-turn-1",
      workSegments: [expect.objectContaining({ triggerEntityId: "share-entity-3" })],
    });
    expect(result.rows[0]).not.toHaveProperty("originMeta");
    expect(result.rows[1]).toMatchObject({
      kind: "userInput",
      originMeta: {
        backgroundSource: "subagent",
        senderLabel: "研究助手",
      },
    });
    expect(result.rows[2]).toMatchObject({
      kind: "toolCall",
      toolName: "Agent",
      toolCallId: "share-tool-call-1",
      status: "success",
      output: { text: "子任务已完成" },
    });
    expect(result.rows[2]).not.toHaveProperty("progress");
    expect(result.rows[2]).not.toHaveProperty("approvalInteractionId");
    expect(result.rows[2]).not.toHaveProperty("workId");
    expect(result.rows[3]).not.toHaveProperty("feedback");
    expect(JSON.stringify(result.rows)).not.toMatch(
      /local-product-turn-a|local-turn-a|local-entity|local-tool-call|source-command|client-desktop|approval-1|local-work/u,
    );
  });

  it("allows rows to share one persistent entity identity", () => {
    const rows = rowsWithCompletedSubagent();
    rows[1] = { ...rows[1]!, entityId: rows[0]!.entityId } as ConversationRow;

    const result = build(rows);

    expect(result.rows[0]?.entityId).toBe("share-entity-1");
    expect(result.rows[1]?.entityId).toBe("share-entity-1");
  });

  it("is deterministic and rejects a dangling retained entity reference", () => {
    const first = build();
    const second = build();

    expect(second).toEqual(first);
    const header = first.rows[0];
    if (header?.kind !== "turnHeader" || !header.workSegments?.[0]) {
      throw new Error("Expected projected turn header work segment");
    }
    header.workSegments[0].triggerEntityId = "share-entity-999";

    expect(() =>
      assertConversationSharePublicProjection({
        rows: first.rows,
        selectedProductTurnIds: first.selectedProductTurnIds,
      }),
    ).toThrowError(expect.objectContaining({ kind: "invalid_conversation" }));
  });

  it("rejects active rows before preparing a share", () => {
    const rows = rowsWithCompletedSubagent();
    rows[0] = { ...rows[0]!, kind: "turnHeader", state: "running" };

    expectBuildFailure(rows, "invalid_conversation");
  });

  it("drops local attachment refs until the publication stage rewrites them", () => {
    const rows = rowsWithCompletedSubagent();
    rows[1] = {
      ...rows[1]!,
      kind: "userInput",
      attachments: [
        {
          ref: "attachment/local-file",
          fileName: "report.pdf",
          mime: "application/pdf",
          bytes: 10,
        },
      ],
    };
    const result = build(rows);
    expect(result.rows.find((row) => row.kind === "userInput")).not.toHaveProperty("attachments");
  });

  it("preserves share attachment refs in the public projection", () => {
    const rows = rowsWithCompletedSubagent();
    rows[1] = {
      ...rows[1]!,
      kind: "userInput",
      attachments: [
        {
          ref: "zcode-artifact://share/share-input-artifact-1",
          previewRef: "zcode-artifact://share/share-input-artifact-1",
          fileName: "pasted-text.txt",
          mime: "text/plain",
          bytes: 10,
        },
      ],
    };
    const result = build(rows);
    expect(result.rows.find((row) => row.kind === "userInput")).toMatchObject({
      attachments: [
        expect.objectContaining({ ref: "zcode-artifact://share/share-input-artifact-1" }),
      ],
    });
  });

  it.each([
    ["data:text/plain;base64,YQ==", "unsafe_structure"],
    ["file:///tmp/report.html", "unsafe_structure"],
    ["zcode-artifact://share/report", "artifact_protocol_not_ready"],
  ] as const)("rejects unsupported local reference %s", (text, kind) => {
    const rows = rowsWithCompletedSubagent();
    rows[4] = {
      ...rows[4]!,
      kind: "assistantText",
      text,
      state: "complete",
    };

    expectBuildFailure(rows, kind);
  });

  it("SHARE02：移除本地 truncated 引用但保留可公开的工具输出预览", () => {
    const rows = rowsWithCompletedSubagent();
    rows[2] = {
      ...rows[2]!,
      kind: "toolCall",
      output: {
        text: "head...tail",
        truncated: { totalBytes: 100_000, ref: "tool-output/local-tool-call" },
      },
    };

    const projection = build(rows);

    expect(projection.rows.find((row) => row.kind === "toolCall")?.output).toEqual({
      text: "head...tail",
    });
  });
});
