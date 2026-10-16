import { createHash } from "node:crypto";
import { materializeConversationShareInlineImages } from "../src/conversation-share/conversationShareInlineImages.js";
import type {
  ConversationRow,
  ConversationShareCapabilities,
  ConversationShareConfirmRequest,
  ConversationSharePreparationRequest,
} from "@zcode/shared";
import { ProxyChannel } from "@zcode/rpc";
import {
  ZCODE_ATTACHMENT_FAULT_CODES,
  ZCodeAttachmentFaultError,
} from "@zcode/shared/zcode-protocol-v4";
import { describe, expect, it, vi } from "vitest";

import type { IZCodeAgentService } from "../src/zcode-agent/zcodeAgent.js";
import {
  ConversationShareClientError,
  type ConversationShareHttpClient,
} from "../src/conversation-share/conversationShareHttpClient.js";
import { sha256ConversationShareJson } from "../src/conversation-share/conversationShareIntegrity.js";
import {
  ConversationShareService,
  conversationShareConnectionScopeFactory,
  type ConversationShareServiceOptions,
} from "../src/conversation-share/conversationShareService.js";
import {
  ConversationShareServiceError,
  type ConversationSharePublishProgress,
  type ConversationShareFailureIssue,
} from "../src/conversation-share/conversationShare.js";

const capabilities: ConversationShareCapabilities = {
  schema_version: 1,
  ttl_ms: 60_000,
  access_modes: ["private", "public_readonly", "public_importable"],
  max_rows: 100,
  max_payload_bytes: 100_000,
  max_artifact_count: 0,
  max_artifact_bytes: 1,
  max_total_artifact_bytes: 1,
  allowed_artifacts: [],
};

const shareRecord = {
  share_code: "share-1",
  share_url: "https://zcode.z.ai/cn/share/share-1",
  access_mode: "public_importable" as const,
  expires_at: 20_000,
};

function pendingSafetyCheck(retryAfterMs?: number, requestId?: string) {
  return new ConversationShareClientError({
    kind: "safety_check_pending",
    message: "share safety check pending",
    status: 409,
    code: 3215,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(requestId === undefined ? {} : { requestId }),
  });
}

type PollOptions = Pick<
  ConversationShareServiceOptions,
  "confirmPollIntervalMs" | "confirmPollTimeoutMs" | "logger" | "now" | "sleep"
>;

function completedRows(): ConversationRow[] {
  return [
    {
      rowId: 1,
      turnId: "turn-1",
      productTurnId: "product-turn-1",
      createdAt: 1_000,
      createdAtSeq: 1,
      kind: "turnHeader",
      origin: "userInput",
      state: "completedSuccess",
      startedAt: 1_000,
      endedAt: 1_100,
    },
    {
      rowId: 2,
      turnId: "turn-1",
      productTurnId: "product-turn-1",
      createdAt: 1_010,
      createdAtSeq: 2,
      kind: "assistantText",
      text: "第一轮完成",
      state: "complete",
    },
    {
      rowId: 3,
      turnId: "turn-2",
      productTurnId: "product-turn-2",
      createdAt: 2_000,
      createdAtSeq: 3,
      kind: "turnHeader",
      origin: "userInput",
      state: "failed",
      startedAt: 2_000,
      endedAt: 2_100,
    },
    {
      rowId: 4,
      turnId: "turn-2",
      productTurnId: "product-turn-2",
      createdAt: 2_010,
      createdAtSeq: 4,
      kind: "assistantText",
      text: "第二轮失败",
      state: "failed",
    },
  ];
}

/** 只含一条带 txt 附件的用户输入轮，用于附件预检分类用例。 */
function attachmentPreflightRows(): ConversationRow[] {
  const rows = completedRows().slice(0, 2);
  rows[0] = { ...rows[0]!, entityId: "header-entity" };
  rows.push({
    rowId: 5,
    turnId: "turn-1",
    productTurnId: "product-turn-1",
    entityId: "input-entity",
    createdAt: 1_050,
    createdAtSeq: 5,
    kind: "userInput",
    text: "粘贴文本",
    origin: "realUser",
    attachments: [
      { ref: "/workspace/pasted.txt", fileName: "pasted.txt", mime: "text/plain", bytes: 10 },
    ],
  });
  return rows;
}

function completedRowsWithSubagent(): ConversationRow[] {
  const rows = completedRows();
  return [
    {
      ...rows[0]!,
      entityId: "local-header-entity",
      actions: { canFork: true },
    },
    {
      ...rows[1]!,
      entityId: "local-assistant-entity",
    },
    {
      rowId: 3,
      turnId: "turn-1",
      entityId: "local-agent-tool-entity",
      productTurnId: "product-turn-1",
      createdAt: 1_020,
      createdAtSeq: 3,
      actions: { canRetry: true },
      kind: "toolCall",
      toolCallId: "local-agent-tool-call",
      toolName: "Agent",
      status: "success",
      inputText: '{"description":"研究"}',
      output: { text: "研究完成" },
      approvalInteractionId: "local-approval",
    },
    {
      rowId: 4,
      turnId: "turn-1",
      entityId: "local-subagent-entity",
      productTurnId: "product-turn-1",
      createdAt: 1_030,
      createdAtSeq: 4,
      kind: "subagent",
      parentToolCallId: "local-agent-tool-call",
      subagentType: "research",
      status: "success",
      summaryText: "研究完成",
      childSessionId: "local-child-session",
    },
    { ...rows[2]!, rowId: 5, createdAtSeq: 5 },
    { ...rows[3]!, rowId: 6, createdAtSeq: 6 },
  ];
}

function completedRowsWithFileChanges(): ConversationRow[] {
  const rows = completedRows();
  rows[0] = {
    ...rows[0]!,
    entityId: "turn-header-1",
    fileChanges: { files: 3, additions: 0, deletions: 0, state: "active" },
  };
  rows[1] = { ...rows[1]!, text: "已生成 reports/调研报告.pdf 和 reports/汇报.pptx" };
  return rows;
}

function createDependencies(rows = completedRows(), pollOptions: PollOptions = {}) {
  const conversationRowsRangeV4 = vi.fn(async ({ beforeRowId }: { beforeRowId?: number }) =>
    beforeRowId === undefined
      ? {
          rows: rows.slice(rows.length > 2 ? 2 : 0),
          atSeq: 4,
          atRevision: 7,
          atLogEpoch: "epoch-1",
          hasMore: rows.length > 2,
        }
      : {
          rows: rows.slice(0, 2),
          atSeq: 4,
          atRevision: 7,
          atLogEpoch: "epoch-1",
          hasMore: false,
        },
  );
  const conversationFileChangesV4 = vi.fn(async () => ({
    files: 0,
    additions: 0,
    deletions: 0,
    items: [],
  }));
  const conversationAttachmentReadV4 = vi.fn(async () => {
    throw new Error("attachment unavailable in test fixture");
  });
  const conversationAttachmentStatV4 = vi.fn(async () => ({
    mediaType: "text/plain",
    totalBytes: 0,
  }));
  const confirmRequests: ConversationShareConfirmRequest[] = [];
  const preparationRequests: ConversationSharePreparationRequest[] = [];
  const client = {
    getCapabilities: vi.fn(async () => capabilities),
    createPreparation: vi.fn(async (request: ConversationSharePreparationRequest) => {
      preparationRequests.push(request);
      return {
        preparation_id: "preparation-1",
        status: "preparing" as const,
        access_mode: request.access_mode,
        expires_at: 20_000,
      };
    }),
    confirm: vi.fn(async (_preparationId: string, request: ConversationShareConfirmRequest) => {
      confirmRequests.push(request);
      return {
        share_code: "share-1",
        share_url: "https://zcode.z.ai/cn/share/share-1",
        access_mode: preparationRequests.at(-1)?.access_mode ?? "private",
        expires_at: 20_000,
      };
    }),
    uploadArtifact: vi.fn(async (_preparationId, descriptor) => ({
      artifact_id: descriptor.artifact_id,
      size_bytes: descriptor.size_bytes,
      sha256: descriptor.sha256,
      status: "uploaded" as const,
    })),
    getPreview: vi.fn(),
    getContinuation: vi.fn(),
  };
  const artifactSource = {
    stat: vi.fn(async ({ ref }: { ref: string }) => ({
      canonicalPath: ref,
      size: 0,
      mtimeMs: 1,
    })),
    read: vi.fn(async ({ ref }: { ref: string }) => ({
      bytes: new Uint8Array(),
      canonicalPath: ref,
    })),
  };
  const service = new ConversationShareService({
    zcodeAgentService: {
      conversationRowsRangeV4,
      conversationFileChangesV4,
      conversationAttachmentReadV4,
      conversationAttachmentStatV4,
    } as unknown as Pick<
      IZCodeAgentService,
      | "conversationRowsRangeV4"
      | "conversationFileChangesV4"
      | "conversationAttachmentReadV4"
      | "conversationAttachmentStatV4"
    >,
    client: client as unknown as ConversationShareHttpClient,
    artifactSource,
    ...pollOptions,
  });
  return {
    service,
    client,
    conversationRowsRangeV4,
    conversationFileChangesV4,
    conversationAttachmentReadV4,
    conversationAttachmentStatV4,
    confirmRequests,
    preparationRequests,
    artifactSource,
  };
}

function publishInput() {
  return {
    workspacePath: "/workspace",
    workspaceIdentity: "ssh://host/workspace",
    sessionId: "session-1",
    title: "会话分享",
    accessMode: "public_importable" as const,
    selection: { kind: "all" as const },
    clientRequestId: "publish-request-1",
    disclosureAcceptedAt: 10_000,
  };
}

function collectPublishProgress(
  service: ConversationShareService,
  operationId: string,
): ConversationSharePublishProgress[] {
  const events: ConversationSharePublishProgress[] = [];
  service.onDynamicPublishProgress(operationId)((event) => events.push(event));
  return events;
}

function firstWarnings(
  events: readonly ConversationSharePublishProgress[],
): readonly ConversationShareFailureIssue[] | undefined {
  return events.find((event) => event.warnings?.length)?.warnings;
}

describe("ConversationShareService", () => {
  it("选择阶段 preflight 区分运行中阻断、文件跳过和静默内部结构", async () => {
    const rows = completedRows();
    rows[0] = { ...rows[0]!, entityId: "header-entity" };
    rows.push(
      {
        rowId: 5,
        turnId: "turn-1",
        productTurnId: "product-turn-1",
        entityId: "input-entity",
        createdAt: 1_050,
        createdAtSeq: 5,
        kind: "userInput",
        text: "附带文件",
        origin: "userInput",
        attachments: [
          { ref: "/workspace/video.mp4", fileName: "video.mp4", mime: "video/mp4", bytes: 0 },
        ],
      },
      {
        rowId: 6,
        turnId: "turn-1",
        productTurnId: "product-turn-1",
        createdAt: 1_060,
        createdAtSeq: 6,
        kind: "timelineMarker",
        marker: { type: "forkNotice", parentSessionId: "private-parent", parentRowId: 1 },
      },
      {
        rowId: 7,
        turnId: "turn-1",
        productTurnId: "product-turn-1",
        createdAt: 1_070,
        createdAtSeq: 7,
        kind: "toolCall",
        toolCallId: "node-repl",
        toolName: "NodeRepl",
        status: "success",
        inputText: "{}",
        display: {
          kind: "node_repl_images",
          images: [{ base64: "secret", mimeType: "image/png" }],
        },
      },
      {
        rowId: 8,
        turnId: "turn-3",
        productTurnId: "product-turn-3",
        createdAt: 1_080,
        createdAtSeq: 8,
        kind: "turnHeader",
        origin: "userInput",
        state: "running",
        startedAt: 1_080,
      },
    );
    const { service } = createDependencies(rows);

    const result = await service.preflight({
      workspacePath: "/workspace",
      sessionId: "session-1",
      selection: { kind: "all" },
    });

    expect(result.blockingIssues).toEqual([expect.objectContaining({ code: "running_turn" })]);
    expect(result.skippableWarnings).toEqual([
      expect.objectContaining({
        code: "artifact_type_not_allowed",
        artifactType: "image",
      }),
      expect.objectContaining({
        code: "artifact_type_not_allowed",
        artifactDisplayName: "video.mp4",
      }),
    ]);
    expect(result.skippableWarnings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "inline_tool_image" }),
        expect.objectContaining({ code: "unsupported_timeline" }),
      ]),
    );
    expect(result.turnResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          productTurnId: "product-turn-1",
          skippableWarnings: expect.arrayContaining([
            expect.objectContaining({ artifactDisplayName: "video.mp4" }),
            expect.objectContaining({ artifactType: "image" }),
          ]),
        }),
      ]),
    );
  });

  it("全局预检问题会进入每个 turn 的缓存结果，避免客户端聚合时丢失", async () => {
    const rows = completedRows().map((row) =>
      row.kind === "assistantText" ? { ...row, text: "" } : row,
    );
    const { service } = createDependencies(rows);

    const result = await service.preflight({
      workspacePath: "/workspace",
      sessionId: "session-1",
      selection: { kind: "all" },
    });

    expect(result.blockingIssues).toEqual([
      expect.objectContaining({ code: "no_shareable_content", scope: "conversation" }),
    ]);
    expect(result.turnResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          productTurnId: "product-turn-1",
          blockingIssues: [expect.objectContaining({ code: "no_shareable_content" })],
        }),
        expect.objectContaining({
          productTurnId: "product-turn-2",
          blockingIssues: [expect.objectContaining({ code: "no_shareable_content" })],
        }),
      ]),
    );
  });

  it("选择阶段 preflight 能提前识别已清理的用户输入附件", async () => {
    const rows = completedRows().slice(0, 2);
    rows[0] = { ...rows[0]!, entityId: "header-entity" };
    rows.push({
      rowId: 5,
      turnId: "turn-1",
      productTurnId: "product-turn-1",
      entityId: "input-entity",
      createdAt: 1_050,
      createdAtSeq: 5,
      kind: "userInput",
      text: "粘贴文本",
      origin: "realUser",
      attachments: [
        { ref: "/workspace/pasted.txt", fileName: "pasted.txt", mime: "text/plain", bytes: 10 },
      ],
    });
    const { service, client, conversationAttachmentStatV4 } = createDependencies(rows);
    client.getCapabilities.mockResolvedValueOnce({
      ...capabilities,
      max_artifact_bytes: 100,
      allowed_artifacts: [{ type: "text", extensions: ["txt"], mime_types: ["text/plain"] }],
    });
    conversationAttachmentStatV4.mockRejectedValueOnce(new Error("ENOENT: attachment removed"));

    const result = await service.preflight({
      workspacePath: "/workspace",
      sessionId: "session-1",
      selection: { kind: "all" },
    });

    expect(result.blockingIssues).toEqual([]);
    expect(result.skippableWarnings).toEqual([
      expect.objectContaining({
        code: "input_attachment_unavailable",
        artifactDisplayName: "pasted.txt",
        availability: "not_found",
      }),
    ]);
    expect(conversationAttachmentStatV4).toHaveBeenCalledWith(
      expect.objectContaining({ attachmentIndex: 0, ref: "/workspace/pasted.txt" }),
    );
  });

  it("选择阶段把超大附件判为阻断的 artifact_size_limit，而不是降级成 deferred", async () => {
    const rows = attachmentPreflightRows();
    const { service, client, conversationAttachmentStatV4 } = createDependencies(rows);
    client.getCapabilities.mockResolvedValueOnce({
      ...capabilities,
      max_artifact_bytes: 100,
      allowed_artifacts: [{ type: "text", extensions: ["txt"], mime_types: ["text/plain"] }],
    });
    // 真实文件大小远超协议旧上限（30MiB）；stat 必须能表达它，预检才能确定阻断。
    conversationAttachmentStatV4.mockResolvedValueOnce({
      mediaType: "text/plain",
      totalBytes: 64 * 1024 * 1024,
    });

    const result = await service.preflight({
      workspacePath: "/workspace",
      sessionId: "session-1",
      selection: { kind: "all" },
    });

    expect(result.deferredIssues).toEqual([]);
    expect(result.blockingIssues).toEqual([
      expect.objectContaining({
        code: "artifact_size_limit",
        artifactDisplayName: "pasted.txt",
        productTurnId: "product-turn-1",
        actual: 64 * 1024 * 1024,
        limit: 100,
      }),
    ]);
  });

  it("stat 报 shareStatTooLarge 时也阻断，而不是当成未知错误", async () => {
    const rows = attachmentPreflightRows();
    const { service, client, conversationAttachmentStatV4 } = createDependencies(rows);
    client.getCapabilities.mockResolvedValueOnce({
      ...capabilities,
      max_artifact_bytes: 100,
      allowed_artifacts: [{ type: "text", extensions: ["txt"], mime_types: ["text/plain"] }],
    });
    conversationAttachmentStatV4.mockRejectedValueOnce(
      new ZCodeAttachmentFaultError(ZCODE_ATTACHMENT_FAULT_CODES.shareStatTooLarge),
    );

    const result = await service.preflight({
      workspacePath: "/workspace",
      sessionId: "session-1",
      selection: { kind: "all" },
    });

    expect(result.deferredIssues).toEqual([]);
    expect(result.blockingIssues).toEqual([
      expect.objectContaining({ code: "artifact_size_limit", limit: 100 }),
    ]);
  });

  it("不支持的附件类型即使超大也只是可跳过的 artifact_type_not_allowed", async () => {
    const rows = attachmentPreflightRows();
    const { service, client, conversationAttachmentStatV4 } = createDependencies(rows);
    client.getCapabilities.mockResolvedValueOnce({
      ...capabilities,
      max_artifact_bytes: 100,
      allowed_artifacts: [{ type: "pdf", extensions: ["pdf"], mime_types: ["application/pdf"] }],
    });
    conversationAttachmentStatV4.mockResolvedValueOnce({
      mediaType: "text/plain",
      totalBytes: 64 * 1024 * 1024,
    });

    const result = await service.preflight({
      workspacePath: "/workspace",
      sessionId: "session-1",
      selection: { kind: "all" },
    });

    // 不支持的类型根本不会上传，体积与分享无关：不能升级成阻断。
    expect(result.blockingIssues).toEqual([]);
    expect(result.skippableWarnings).toEqual([
      expect.objectContaining({
        code: "artifact_type_not_allowed",
        artifactDisplayName: "pasted.txt",
      }),
    ]);
  });

  it("选择阶段只检查最终预览卡片：忽略 ~/ 路径和缺失 Markdown，提示已存在视频不可分享", async () => {
    const rows = completedRows();
    rows[0] = { ...rows[0]!, entityId: "turn-header-1" };
    rows[1] = {
      ...rows[1]!,
      text: [
        "~/Code/vibe/shows/deliver/晨报.pdf",
        '::zcode-file-citation{path="/workspace/晨报.pdf" purpose="output"}',
        "build_mn/qa/layout-review.md",
        "out/one.mp4 out/two.mp4 out/three.mp4",
      ].join("\n"),
    };
    const { service, client, artifactSource } = createDependencies(rows);
    client.getCapabilities.mockResolvedValueOnce({
      ...capabilities,
      max_artifact_count: 4,
      max_artifact_bytes: 1024,
      max_total_artifact_bytes: 4096,
      allowed_artifacts: [{ type: "pdf", extensions: ["pdf"], mime_types: ["application/pdf"] }],
    });

    const result = await service.preflight({
      workspacePath: "/workspace",
      sessionId: "session-1",
      selection: { kind: "productTurns", productTurnIds: ["product-turn-1"] },
    });

    expect(artifactSource.stat).toHaveBeenCalledTimes(4);
    expect(artifactSource.stat.mock.calls.map(([input]) => input.ref)).toEqual([
      "/workspace/out/three.mp4",
      "/workspace/out/two.mp4",
      "/workspace/out/one.mp4",
      "/workspace/晨报.pdf",
    ]);
    expect(result.skippableWarnings).toEqual([
      expect.objectContaining({
        code: "artifact_type_not_allowed",
        artifactDisplayName: "three.mp4",
      }),
      expect.objectContaining({
        code: "artifact_type_not_allowed",
        artifactDisplayName: "two.mp4",
      }),
      expect.objectContaining({
        code: "artifact_type_not_allowed",
        artifactDisplayName: "one.mp4",
      }),
    ]);
    expect(result.skippableWarnings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ artifactDisplayName: "晨报.pdf" }),
        expect.objectContaining({ artifactDisplayName: "layout-review.md" }),
      ]),
    );
  });

  it("选择阶段缺失的预览卡片不会在发布阶段重新变成 warning", async () => {
    const rows = completedRowsWithFileChanges().slice(0, 2);
    rows[1] = { ...rows[1]!, text: "已生成 layout-review.md report.pdf" };
    const { service, client, artifactSource, conversationFileChangesV4, preparationRequests } =
      createDependencies(rows);
    conversationFileChangesV4.mockResolvedValue({
      files: 1,
      additions: 1,
      deletions: 0,
      state: "active",
      items: [
        {
          path: "/workspace/layout-review.md",
          additions: 1,
          deletions: 0,
          writeCount: 1,
          toolNames: ["Write"],
          patches: [],
        },
      ],
    });
    client.getCapabilities.mockResolvedValue({
      ...capabilities,
      max_artifact_count: 2,
      max_artifact_bytes: 1024,
      max_total_artifact_bytes: 2048,
      allowed_artifacts: [{ type: "pdf", extensions: ["pdf"], mime_types: ["application/pdf"] }],
    });
    artifactSource.stat.mockImplementation(async ({ ref }) => {
      if (ref.endsWith("layout-review.md")) {
        throw new ConversationShareServiceError(
          "invalid_conversation",
          "Conversation artifact cannot be read",
          { reasonCode: "artifact_read_failed", diagnostics: { errno: "ENOENT" } },
        );
      }
      return { canonicalPath: ref, size: 4, mtimeMs: 1 };
    });
    artifactSource.read.mockResolvedValue({
      bytes: new TextEncoder().encode("pdf!"),
      canonicalPath: "/workspace/report.pdf",
    });

    const selection = {
      kind: "productTurns" as const,
      productTurnIds: ["product-turn-1"],
    };
    const preflight = await service.preflight({
      workspacePath: "/workspace",
      workspaceIdentity: "ssh://host/workspace",
      remoteSessionId: "remote-session-1",
      sessionId: "session-1",
      selection,
    });
    expect(preflight.skippableWarnings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ artifactDisplayName: "layout-review.md" }),
      ]),
    );

    const progress = collectPublishProgress(service, "publish-op-preview-snapshot");
    await expect(
      service.publish(
        {
          ...publishInput(),
          remoteSessionId: "remote-session-1",
          selection,
        },
        "publish-op-preview-snapshot",
      ),
    ).resolves.toEqual(shareRecord);

    expect(artifactSource.stat.mock.calls.map(([input]) => input.ref)).toEqual([
      "/workspace/report.pdf",
      "/workspace/layout-review.md",
      "/workspace/report.pdf",
    ]);
    expect(artifactSource.read).toHaveBeenCalledTimes(1);
    expect(preparationRequests.at(-1)).toMatchObject({ artifact_count: 1 });
    expect(firstWarnings(progress)).toBeUndefined();
  });

  it("选择阶段会检查候选上限内全部文件，再按存在性取最终可见卡片", async () => {
    const rows = completedRows().slice(0, 2);
    rows[1] = {
      ...rows[1]!,
      text: Array.from({ length: 12 }, (_, index) => `clip-${index + 1}.mp4`).join(" "),
    };
    const { service, client, artifactSource } = createDependencies(rows);
    client.getCapabilities.mockResolvedValueOnce({
      ...capabilities,
      max_artifact_count: 10,
      max_artifact_bytes: 1024,
      max_total_artifact_bytes: 4096,
      allowed_artifacts: [{ type: "pdf", extensions: ["pdf"], mime_types: ["application/pdf"] }],
    });

    const result = await service.preflight({
      workspacePath: "/workspace",
      sessionId: "session-1",
      selection: { kind: "productTurns", productTurnIds: ["product-turn-1"] },
    });

    expect(artifactSource.stat).toHaveBeenCalledTimes(12);
    expect(result.skippableWarnings.map((issue) => issue.artifactDisplayName)).toEqual([
      "clip-12.mp4",
      "clip-11.mp4",
      "clip-10.mp4",
      "clip-9.mp4",
      "clip-8.mp4",
    ]);
  });

  it("即使能力列表误包含媒体，视频预览也只 warning 不上传", async () => {
    const rows = completedRows().slice(0, 2);
    rows[1] = {
      ...rows[1]!,
      text: "report.pdf clip.mp4",
    };
    const { service, client, artifactSource, preparationRequests } = createDependencies(rows);
    client.getCapabilities.mockResolvedValue({
      ...capabilities,
      max_artifact_count: 2,
      max_artifact_bytes: 1024,
      max_total_artifact_bytes: 2048,
      allowed_artifacts: [
        { type: "pdf", extensions: ["pdf"], mime_types: ["application/pdf"] },
        { type: "video", extensions: ["mp4"], mime_types: ["video/mp4"] },
      ],
    });
    artifactSource.read.mockResolvedValue({
      bytes: new TextEncoder().encode("pdf!"),
      canonicalPath: "/workspace/report.pdf",
    });

    const preflight = await service.preflight({
      workspacePath: "/workspace",
      sessionId: "session-1",
      selection: { kind: "productTurns", productTurnIds: ["product-turn-1"] },
    });

    expect(preflight.skippableWarnings).toEqual([
      expect.objectContaining({
        code: "artifact_type_not_allowed",
        artifactDisplayName: "clip.mp4",
      }),
    ]);

    await expect(service.publish(publishInput(), "publish-op-media-capability")).resolves.toEqual(
      shareRecord,
    );
    expect(artifactSource.read).toHaveBeenCalledTimes(1);
    expect(artifactSource.read).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      ref: "/workspace/report.pdf",
      maxBytes: 1024,
    });
    expect(preparationRequests.at(-1)).toMatchObject({ artifact_count: 1 });
  });

  it("exposes a stable safe reason code for invalid conversation failures", () => {
    const error = new ConversationShareServiceError(
      "invalid_conversation",
      "Conversation attachments require the artifact row protocol",
      { diagnostics: { rowKind: "userInput", rowId: 9 } },
    );
    expect(error.reasonCode).toBe("input_attachment");
    expect(error.diagnostics).toEqual({ rowKind: "userInput", rowId: 9 });
  });

  it("把 artifact 读失败消息归类到 artifact_read_failed 而不是兜底", () => {
    // 旧正则只覆盖 ended|source|chunk|readable，本地/远端兜底消息因此落到 invalid_conversation，
    // UI 于是显示了无关的「结构不支持」文案。
    expect(
      new ConversationShareServiceError(
        "invalid_conversation",
        "Conversation artifact cannot be read",
      ).reasonCode,
    ).toBe("artifact_read_failed");
    expect(
      new ConversationShareServiceError(
        "invalid_conversation",
        "Conversation artifact cannot be read from the remote workspace",
      ).reasonCode,
    ).toBe("artifact_read_failed");
    expect(
      new ConversationShareServiceError(
        "invalid_conversation",
        "Conversation artifact source is not a file",
      ).reasonCode,
    ).toBe("artifact_read_failed");
  });

  it("errno 进 diagnostics，cause 不进跨 RPC 载荷", () => {
    const cause = Object.assign(new Error("ENOENT: no such file"), {
      code: "ENOENT",
      path: "/workspace/DELIVER/报告.pdf",
    });
    const error = new ConversationShareServiceError(
      "invalid_conversation",
      "Conversation artifact cannot be read",
      { reasonCode: "artifact_read_failed", cause, diagnostics: { errno: "ENOENT" } },
    );

    expect(error.cause).toBe(cause);
    expect(error.diagnostics).toEqual({ errno: "ENOENT" });
    expect(error.details).not.toHaveProperty("cause");
    expect(JSON.stringify(error.details)).not.toContain("报告.pdf");
  });

  it("keeps a safe request id in the service error details envelope", () => {
    const error = new ConversationShareServiceError(
      "artifact_not_allowed",
      "Conversation artifacts cannot be shared",
      {
        requestId: "server-request-123",
        issues: [{ code: "artifact_type_not_allowed", scope: "artifact" }],
      },
    );

    expect(error.requestId).toBe("server-request-123");
    expect(error.details).toMatchObject({
      requestId: "server-request-123",
      issues: [{ code: "artifact_type_not_allowed", scope: "artifact" }],
      issueCount: 1,
      omittedIssueCount: 0,
    });
  });
  it("SHARE08：已选历史轮次的 PDF/PPTX 通过预览候选上传后再 confirm", async () => {
    const pdfBytes = new TextEncoder().encode("pdf!");
    const pptxBytes = new TextEncoder().encode("pptx!");
    const { service, client, artifactSource, conversationFileChangesV4, preparationRequests } =
      createDependencies(completedRowsWithFileChanges());
    client.getCapabilities.mockResolvedValueOnce({
      ...capabilities,
      max_artifact_count: 4,
      max_artifact_bytes: 1024,
      max_total_artifact_bytes: 4096,
      allowed_artifacts: [
        { type: "pdf", extensions: ["pdf"], mime_types: ["application/pdf"] },
        {
          type: "pptx",
          extensions: ["pptx"],
          mime_types: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
        },
      ],
    });
    conversationFileChangesV4.mockResolvedValueOnce({
      files: 3,
      additions: 0,
      deletions: 0,
      state: "active",
      items: [
        {
          path: "reports/调研报告.pdf",
          additions: 0,
          deletions: 0,
          writeCount: 1,
          toolNames: ["Bash"],
          patches: [],
        },
        {
          path: "reports/汇报.pptx",
          additions: 0,
          deletions: 0,
          writeCount: 1,
          toolNames: ["Bash"],
          patches: [],
        },
        {
          path: "scripts/generate.py",
          additions: 10,
          deletions: 0,
          writeCount: 1,
          toolNames: ["Write"],
          patches: [],
        },
      ],
    });
    artifactSource.read.mockImplementation(async ({ ref }) => {
      if (ref.endsWith(".pdf")) {
        return { bytes: pdfBytes, canonicalPath: "/workspace/reports/调研报告.pdf" };
      }
      if (ref.endsWith(".pptx")) {
        return { bytes: pptxBytes, canonicalPath: "/workspace/reports/汇报.pptx" };
      }
      throw new Error(`unexpected artifact read: ${ref}`);
    });
    const order: string[] = [];
    client.createPreparation.mockImplementationOnce(async (request) => {
      order.push("prepare");
      preparationRequests.push(request);
      return {
        preparation_id: "preparation-1",
        status: "preparing",
        access_mode: request.access_mode,
        expires_at: 20_000,
      };
    });
    client.uploadArtifact.mockImplementation(async (_id, descriptor) => {
      order.push(`upload:${descriptor.extension}`);
      return {
        artifact_id: descriptor.artifact_id,
        size_bytes: descriptor.size_bytes,
        sha256: descriptor.sha256,
        status: "uploaded",
      };
    });
    client.confirm.mockImplementationOnce(async () => {
      order.push("confirm");
      return shareRecord;
    });

    await expect(service.publish(publishInput(), "publish-op-1")).resolves.toEqual(shareRecord);

    expect(conversationFileChangesV4).not.toHaveBeenCalled();
    expect(artifactSource.read).toHaveBeenCalledTimes(2);
    expect(preparationRequests.at(-1)).toMatchObject({ artifact_count: 2 });
    expect(order).toEqual(["prepare", "upload:pptx", "upload:pdf", "confirm"]);
  });

  it("正文引用的文件读不到时跳过该结果物并回传非阻断提示，发布照常成功", async () => {
    const pptxBytes = new TextEncoder().encode("pptx!");
    const { service, client, artifactSource, preparationRequests } = createDependencies(
      completedRowsWithFileChanges(),
    );
    client.getCapabilities.mockResolvedValueOnce({
      ...capabilities,
      max_artifact_count: 4,
      max_artifact_bytes: 1024,
      max_total_artifact_bytes: 4096,
      allowed_artifacts: [
        { type: "pdf", extensions: ["pdf"], mime_types: ["application/pdf"] },
        {
          type: "pptx",
          extensions: ["pptx"],
          mime_types: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
        },
      ],
    });
    // PDF 是正文里已不存在的路径（例如 SKILL.md 的模板占位符），PPTX 真实存在。
    artifactSource.read.mockImplementation(async ({ ref }) => {
      if (ref.endsWith(".pdf")) {
        throw new ConversationShareServiceError(
          "invalid_conversation",
          "Conversation artifact cannot be read",
          { reasonCode: "artifact_read_failed", diagnostics: { errno: "ENOENT" } },
        );
      }
      return { bytes: pptxBytes, canonicalPath: "/workspace/reports/汇报.pptx" };
    });
    const progress: ConversationSharePublishProgress[] = [];
    service.onDynamicPublishProgress("publish-op-skip")((event) => progress.push(event));

    await expect(service.publish(publishInput(), "publish-op-skip")).resolves.toEqual(shareRecord);

    expect(preparationRequests.at(-1)).toMatchObject({ artifact_count: 1 });
    expect(firstWarnings(progress)).toEqual([
      expect.objectContaining({
        code: "artifact_read_failed",
        scope: "artifact",
        artifactDisplayName: "调研报告.pdf",
        artifactType: "pdf",
        extension: "pdf",
      }),
    ]);
  });

  it("没有预览卡片的正式 artifact row 不再作为独立分享来源", async () => {
    const bytes = new TextEncoder().encode("pdf!");
    const rows = completedRows().slice(0, 2);
    rows.push({
      rowId: 3,
      turnId: "turn-1",
      productTurnId: "product-turn-1",
      createdAt: 1_020,
      createdAtSeq: 3,
      kind: "artifact",
      artifactVersionId: "registered-report",
      logicalArtifactKey: "registered-report",
      displayName: "正式报告.pdf",
      artifactType: "pdf",
      mimeType: "application/pdf",
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      ref: "/workspace/output/report.pdf",
      state: "current",
    });
    const { service, client, artifactSource, preparationRequests, confirmRequests } =
      createDependencies(rows);
    client.getCapabilities.mockResolvedValueOnce({
      ...capabilities,
      max_artifact_count: 2,
      max_artifact_bytes: 1024,
      max_total_artifact_bytes: 2048,
      allowed_artifacts: [{ type: "pdf", extensions: ["pdf"], mime_types: ["application/pdf"] }],
    });
    artifactSource.read.mockRejectedValue(
      new ConversationShareServiceError(
        "invalid_conversation",
        "Conversation artifact cannot be read",
        { reasonCode: "artifact_read_failed" },
      ),
    );

    await expect(service.publish(publishInput(), "publish-op-skip-2")).resolves.toEqual(
      shareRecord,
    );

    expect(artifactSource.read).not.toHaveBeenCalled();
    expect(preparationRequests.at(-1)).toMatchObject({ artifact_count: 0 });
    expect(confirmRequests.at(-1)?.projection.rows).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "artifact" })]),
    );
  });

  it("用户输入附件降级为跳过：删掉 attachments 后正文照常分享", async () => {
    const base = completedRows();
    const rows: ConversationRow[] = [
      base[0]!,
      {
        rowId: 2,
        turnId: "turn-1",
        productTurnId: "product-turn-1",
        createdAt: 1_005,
        createdAtSeq: 2,
        kind: "userInput",
        text: "帮我看看这个截图",
        origin: "realUser",
        attachments: [
          {
            ref: "/Users/me/Desktop/截图.png",
            fileName: "截图.png",
            mime: "image/png",
            bytes: 2048,
          },
        ],
      },
      { ...base[1]!, rowId: 3, createdAtSeq: 3 },
    ];
    const { service, confirmRequests } = createDependencies(rows);
    const progress = collectPublishProgress(service, "publish-op-attach");

    await expect(service.publish(publishInput(), "publish-op-attach")).resolves.toEqual(
      shareRecord,
    );

    const userInput = confirmRequests
      .at(-1)
      ?.projection.rows.find((row) => row.kind === "userInput");
    expect(userInput).toMatchObject({ text: "帮我看看这个截图" });
    expect(userInput).not.toHaveProperty("attachments");
    expect(firstWarnings(progress)).toEqual([
      expect.objectContaining({
        code: "artifact_type_not_allowed",
        scope: "artifact",
        turnOrdinal: 1,
      }),
    ]);
  });

  it("用户输入文本附件生成 text manifest 并改写为公开引用", async () => {
    const rows: ConversationRow[] = [
      {
        rowId: 1,
        turnId: "turn-1",
        entityId: "user-entity",
        productTurnId: "product-turn-1",
        createdAt: 1_000,
        createdAtSeq: 1,
        kind: "turnHeader",
        origin: "userInput",
        state: "completedSuccess",
        startedAt: 1_000,
        endedAt: 1_100,
      },
      {
        rowId: 2,
        turnId: "turn-1",
        entityId: "user-entity",
        productTurnId: "product-turn-1",
        createdAt: 1_010,
        createdAtSeq: 2,
        kind: "userInput",
        text: "分析这个大文本",
        origin: "realUser",
        attachments: [
          {
            ref: "/data/.zcode/tmp/paste-attachments/pasted.txt",
            fileName: "pasted.txt",
            mime: "text/plain",
            bytes: 11,
          },
        ],
      },
      {
        rowId: 3,
        turnId: "turn-1",
        productTurnId: "product-turn-1",
        createdAt: 1_020,
        createdAtSeq: 3,
        kind: "assistantText",
        text: "已读取",
        state: "complete",
      },
    ];
    const { service, client, conversationAttachmentReadV4, confirmRequests } =
      createDependencies(rows);
    client.getCapabilities.mockResolvedValueOnce({
      ...capabilities,
      max_artifact_count: 2,
      max_artifact_bytes: 1024,
      max_total_artifact_bytes: 2048,
      allowed_artifacts: [{ type: "text", extensions: ["txt"], mime_types: ["text/plain"] }],
    });
    conversationAttachmentReadV4.mockImplementation(async ({ offset }: { offset: number }) => ({
      dataBase64: Buffer.from("hello world")
        .subarray(offset, offset + 6)
        .toString("base64"),
      mediaType: "text/plain",
      totalBytes: 11,
      nextOffset: offset + 6 < 11 ? offset + 6 : null,
    }));

    await expect(service.publish(publishInput(), "publish-op-text-attach")).resolves.toEqual(
      shareRecord,
    );

    const request = confirmRequests.at(-1)!;
    const userInput = request.projection.rows.find((row) => row.kind === "userInput");
    expect(userInput).toMatchObject({
      attachments: [
        expect.objectContaining({
          ref: "zcode-artifact://share/share-input-artifact-1",
          previewRef: "zcode-artifact://share/share-input-artifact-1",
        }),
      ],
    });
    expect(request.integrity.projection_sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(conversationAttachmentReadV4).toHaveBeenCalled();
    expect(client.uploadArtifact).toHaveBeenCalledWith(
      "preparation-1",
      expect.objectContaining({
        artifact_type: "text",
        producer_product_turn_id: "share-product-turn-1",
      }),
      expect.any(Blob),
    );
  });

  it("内嵌工具图片复用 artifact 上传且预检与发布一致", async () => {
    const rows = completedRows().slice(0, 2);
    rows.push({
      rowId: 5,
      turnId: "turn-1",
      productTurnId: "product-turn-1",
      createdAt: 1_050,
      createdAtSeq: 5,
      kind: "toolCall",
      toolCallId: "node-repl-call",
      toolName: "NodeRepl",
      status: "success",
      inputText: "{}",
      output: { text: "已绘图" },
      display: {
        kind: "node_repl_images",
        images: [{ base64: "aGVsbG8=", mimeType: "image/png" }],
      },
    });
    const { service, client, confirmRequests, artifactSource } = createDependencies(rows);
    vi.mocked(client.getCapabilities).mockResolvedValue({
      ...capabilities,
      max_artifact_count: 10,
      max_artifact_bytes: 1000,
      max_total_artifact_bytes: 10000,
      allowed_artifacts: [{ type: "image", extensions: ["png"], mime_types: ["image/png"] }],
    });
    const preflight = await service.preflight(publishInput());
    expect(preflight.blockingIssues).toEqual([]);
    expect(preflight.skippableWarnings).toEqual([]);
    const progress = collectPublishProgress(service, "publish-op-image");

    await expect(service.publish(publishInput(), "publish-op-image")).resolves.toEqual(shareRecord);

    const toolCall = confirmRequests.at(-1)?.projection.rows.find((row) => row.kind === "toolCall");
    expect(toolCall).toMatchObject({ toolName: "NodeRepl", status: "success" });
    expect(toolCall).not.toHaveProperty("display");
    expect(JSON.stringify(confirmRequests.at(-1))).not.toContain("aGVsbG8=");
    expect(firstWarnings(progress)).toBeUndefined();
    expect(client.uploadArtifact).toHaveBeenCalledWith(
      "preparation-1",
      expect.objectContaining({ artifact_type: "image", size_bytes: 5 }),
      expect.any(Blob),
    );
    const uploaded = vi.mocked(client.uploadArtifact).mock.calls[0]![2];
    expect(await uploaded.text()).toBe("hello");
    expect(
      confirmRequests
        .at(-1)
        ?.projection.rows.some((row) => row.kind === "artifact" && row.artifactType === "image"),
    ).toBe(true);
    expect(artifactSource.read).not.toHaveBeenCalled();
    client.getCapabilities.mockResolvedValue({
      ...capabilities,
      max_artifact_count: 10,
      max_artifact_bytes: 4,
      max_total_artifact_bytes: 100,
      allowed_artifacts: [{ type: "image", extensions: ["png"], mime_types: ["image/png"] }],
    });
    const oversized = await service.preflight(publishInput());
    expect(oversized.blockingIssues).toContainEqual(
      expect.objectContaining({ code: "artifact_size_limit", actual: 5, limit: 4 }),
    );
    expect(oversized.turnResults[0]?.blockingIssues).toContainEqual(
      expect.objectContaining({ code: "artifact_size_limit", productTurnId: "product-turn-1" }),
    );
    await expect(service.publish(publishInput(), "oversized-image")).rejects.toMatchObject({
      kind: "limit_exceeded",
    });
  });

  it("分支/回滚时间线标记降级为跳过：整行丢弃且不泄漏本地会话标识", async () => {
    const rows = completedRows().slice(0, 2);
    rows.push(
      {
        rowId: 5,
        turnId: "turn-1",
        productTurnId: "product-turn-1",
        createdAt: 1_060,
        createdAtSeq: 5,
        kind: "timelineMarker",
        marker: { type: "checkpointRestored", checkpointId: "local-checkpoint-1" },
      },
      {
        rowId: 6,
        turnId: "turn-1",
        productTurnId: "product-turn-1",
        createdAt: 1_070,
        createdAtSeq: 6,
        kind: "timelineMarker",
        marker: { type: "forkNotice", parentSessionId: "local-parent-session", parentRowId: 9 },
      },
    );
    const { service, confirmRequests } = createDependencies(rows);
    const progress = collectPublishProgress(service, "publish-op-timeline");

    await expect(service.publish(publishInput(), "publish-op-timeline")).resolves.toEqual(
      shareRecord,
    );

    expect(confirmRequests.at(-1)?.projection.rows.map((row) => row.rowId)).toEqual([1, 2]);
    const payload = JSON.stringify(confirmRequests.at(-1));
    expect(payload).not.toContain("local-checkpoint-1");
    expect(payload).not.toContain("local-parent-session");
    expect(firstWarnings(progress)).toBeUndefined();
  });

  it("整类 timelineMarker 在发布时静默剥掉，不产生提示", async () => {
    const rows = completedRows().slice(0, 2);
    rows.push(
      {
        rowId: 5,
        turnId: "turn-1",
        productTurnId: "product-turn-1",
        createdAt: 1_080,
        createdAtSeq: 5,
        kind: "timelineMarker",
        marker: { type: "compact", origin: "auto", status: "success" },
      },
      {
        rowId: 6,
        turnId: "turn-1",
        productTurnId: "product-turn-1",
        createdAt: 1_090,
        createdAtSeq: 6,
        kind: "timelineMarker",
        marker: {
          type: "modelChange",
          fromProvider: "p1",
          fromModel: "m1",
          toProvider: "p2",
          toModel: "m2",
          toThought: "high",
        },
      },
      {
        rowId: 7,
        turnId: "turn-1",
        productTurnId: "product-turn-1",
        createdAt: 1_100,
        createdAtSeq: 7,
        kind: "timelineMarker",
        marker: { type: "goalVerify", iteration: 1, outcome: "pass" },
      },
    );
    const { service, confirmRequests } = createDependencies(rows);
    const progress = collectPublishProgress(service, "publish-op-markers");

    await expect(service.publish(publishInput(), "publish-op-markers")).resolves.toEqual(
      shareRecord,
    );

    // compact 的 lane 是 assistantWork，留在 flow 尾部会顶掉折叠锚点，让整轮过程在分享页默认展开。
    // goalVerify 等在分享页本就不渲染。三者都属纯运行时记账，静默剥掉、不打扰分享者。
    expect(confirmRequests.at(-1)?.projection.rows.map((row) => row.rowId)).toEqual([1, 2]);
    expect(firstWarnings(progress)).toBeUndefined();
  });

  it("EnterPlanMode 工具行在发布时剥掉，不占 payload 配额", async () => {
    const rows = completedRows().slice(0, 2);
    rows.push({
      rowId: 5,
      turnId: "turn-1",
      productTurnId: "product-turn-1",
      createdAt: 1_110,
      createdAtSeq: 5,
      kind: "toolCall",
      toolCallId: "enter-plan-mode-call",
      toolName: "EnterPlanMode",
      status: "success",
      inputText: "{}",
      output: { text: "ok" },
    });
    const { service, confirmRequests } = createDependencies(rows);

    await expect(service.publish(publishInput(), "publish-op-plan-mode")).resolves.toEqual(
      shareRecord,
    );

    // 渲染层 isVisibleAssistantWorkRow 本来就过滤它，进 payload 只是白吃 max_rows 配额。
    expect(confirmRequests.at(-1)?.projection.rows.map((row) => row.rowId)).toEqual([1, 2]);
  });

  it("运行中的结构仍然阻断发布，不被降级", async () => {
    const rows = completedRows().slice(0, 2);
    rows.push({
      rowId: 5,
      turnId: "turn-1",
      productTurnId: "product-turn-1",
      createdAt: 1_090,
      createdAtSeq: 5,
      kind: "timelineMarker",
      marker: { type: "goalVerify", iteration: 1, outcome: "running" },
    });
    const { service } = createDependencies(rows);

    // 内容尚未定稿，跳过等于分享半成品；这类必须让用户等完成或取消该轮。
    await expect(service.publish(publishInput(), "publish-op-running")).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "unsupported_timeline" })],
    });
  });

  it("服务端允许 md 时，正文引用的 .md 能正常上传分享", async () => {
    const mdBytes = new TextEncoder().encode("# 报告");
    const rows = completedRowsWithFileChanges();
    rows[1] = { ...rows[1]!, text: "已生成 reports/MCP使用统计报告.md" };
    const { service, client, artifactSource, conversationFileChangesV4, preparationRequests } =
      createDependencies(rows);
    client.getCapabilities.mockResolvedValueOnce({
      ...capabilities,
      max_artifact_count: 2,
      max_artifact_bytes: 1024,
      max_total_artifact_bytes: 2048,
      allowed_artifacts: [{ type: "md", extensions: ["md"], mime_types: ["text/markdown"] }],
    });
    conversationFileChangesV4.mockResolvedValueOnce({
      files: 1,
      additions: 0,
      deletions: 0,
      state: "active",
      items: [
        {
          path: "reports/MCP使用统计报告.md",
          additions: 0,
          deletions: 0,
          writeCount: 1,
          toolNames: ["Write"],
          patches: [],
        },
      ],
    });
    artifactSource.read.mockResolvedValue({
      bytes: mdBytes,
      canonicalPath: "/workspace/reports/MCP使用统计报告.md",
    });

    await expect(service.publish(publishInput(), "publish-op-md")).resolves.toEqual(shareRecord);

    expect(preparationRequests.at(-1)).toMatchObject({ artifact_count: 1 });
    expect(client.uploadArtifact).toHaveBeenCalledWith(
      "preparation-1",
      expect.objectContaining({ artifact_type: "md", extension: "md" }),
      expect.anything(),
    );
  });

  it("发布链接跟随界面语言：英文界面改写到裸 /share，中文界面保持 /cn/share", async () => {
    const { service } = createDependencies();

    // 服务端固定下发 /cn/share/...（见 shareRecord），客户端按界面语言改写站点前缀。
    await expect(
      service.publish({ ...publishInput(), locale: "en-US" }, "publish-op-locale-en"),
    ).resolves.toMatchObject({ share_url: "https://zcode.z.ai/share/share-1" });

    await expect(
      service.publish({ ...publishInput(), locale: "zh-CN" }, "publish-op-locale-zh"),
    ).resolves.toEqual(shareRecord);
  });

  it("未传 locale 时原样返回服务端下发的链接", async () => {
    const { service } = createDependencies();

    await expect(service.publish(publishInput(), "publish-op-locale-none")).resolves.toEqual(
      shareRecord,
    );
  });

  it("reports the exact historical preview file when capabilities reject it", async () => {
    const rows = completedRowsWithFileChanges();
    const { service, client, artifactSource } = createDependencies(rows);
    client.getCapabilities.mockResolvedValueOnce({
      ...capabilities,
      max_artifact_count: 2,
      max_artifact_bytes: 1024,
      max_total_artifact_bytes: 2048,
      allowed_artifacts: [
        {
          type: "pptx",
          extensions: ["pptx"],
          mime_types: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
        },
      ],
    });

    const progress = collectPublishProgress(service, "publish-op-2");
    await expect(service.publish(publishInput(), "publish-op-2")).resolves.toEqual(shareRecord);
    expect(firstWarnings(progress)).toEqual([
      expect.objectContaining({
        code: "artifact_type_not_allowed",
        artifactDisplayName: "调研报告.pdf",
        artifactType: "pdf",
        extension: "pdf",
        mimeType: "application/pdf",
      }),
    ]);
    expect(artifactSource.read).toHaveBeenCalledTimes(1);
    expect(client.createPreparation).toHaveBeenCalledTimes(1);
  });

  it("SHARE08：fileChanges 中未被预览引用的中间文件不会读取或上传", async () => {
    const rows = completedRowsWithFileChanges();
    rows[1] = { ...rows[1]!, text: "已生成 index.html" };
    const { service, client, artifactSource, conversationFileChangesV4, preparationRequests } =
      createDependencies(rows);
    client.getCapabilities.mockResolvedValueOnce({
      ...capabilities,
      max_artifact_count: 2,
      max_artifact_bytes: 1024,
      max_total_artifact_bytes: 2048,
      allowed_artifacts: [{ type: "html", extensions: ["html"], mime_types: ["text/html"] }],
    });
    conversationFileChangesV4.mockResolvedValueOnce({
      files: 2,
      additions: 0,
      deletions: 0,
      state: "active",
      items: [
        {
          path: "index.html",
          additions: 0,
          deletions: 0,
          writeCount: 1,
          toolNames: ["Bash"],
          patches: [],
        },
        {
          path: "tmp/debug.pdf",
          additions: 0,
          deletions: 0,
          writeCount: 1,
          toolNames: ["Bash"],
          patches: [],
        },
      ],
    });
    artifactSource.read.mockResolvedValueOnce({
      bytes: new TextEncoder().encode("<html />"),
      canonicalPath: "/workspace/index.html",
    });

    await service.publish(publishInput(), "publish-op-3");

    expect(artifactSource.read).toHaveBeenCalledTimes(1);
    expect(artifactSource.read).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      ref: "/workspace/index.html",
      maxBytes: 1024,
    });
    expect(preparationRequests.at(-1)).toMatchObject({ artifact_count: 1 });
  });

  it("SHARE10：正式 artifact 与预览卡片指向同一 realpath 时只上传可见卡片一次", async () => {
    const bytes = new TextEncoder().encode("pdf!");
    const rows = completedRowsWithFileChanges().slice(0, 2);
    rows[1] = { ...rows[1]!, text: "已生成 report.pdf" };
    rows.push({
      rowId: 3,
      turnId: "turn-1",
      productTurnId: "product-turn-1",
      createdAt: 1_020,
      createdAtSeq: 3,
      kind: "artifact",
      artifactVersionId: "registered-report",
      logicalArtifactKey: "registered-report",
      displayName: "正式报告.pdf",
      artifactType: "pdf",
      mimeType: "application/pdf",
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      ref: "/workspace/output/report.pdf",
      state: "current",
    });
    const { service, client, artifactSource, conversationFileChangesV4, preparationRequests } =
      createDependencies(rows);
    client.getCapabilities.mockResolvedValueOnce({
      ...capabilities,
      max_artifact_count: 2,
      max_artifact_bytes: 1024,
      max_total_artifact_bytes: 2048,
      allowed_artifacts: [{ type: "pdf", extensions: ["pdf"], mime_types: ["application/pdf"] }],
    });
    conversationFileChangesV4.mockResolvedValueOnce({
      files: 1,
      additions: 0,
      deletions: 0,
      state: "active",
      items: [
        {
          path: "alias/report.pdf",
          additions: 0,
          deletions: 0,
          writeCount: 1,
          toolNames: ["Bash"],
          patches: [],
        },
      ],
    });
    artifactSource.read.mockResolvedValue({
      bytes,
      canonicalPath: "/workspace/real/report.pdf",
    });

    await service.publish(publishInput(), "publish-op-4");

    expect(conversationFileChangesV4).not.toHaveBeenCalled();
    expect(artifactSource.read).toHaveBeenCalledTimes(1);
    expect(preparationRequests.at(-1)).toMatchObject({ artifact_count: 1 });
    expect(client.uploadArtifact).toHaveBeenCalledTimes(1);
    expect(client.uploadArtifact.mock.calls[0]?.[1]).toMatchObject({
      display_name: "report.pdf",
    });
  });

  it("SHARE11：rows 分页 revision 不一致时在查询 fileChanges 和 prepare 前拒绝", async () => {
    const { service, client, conversationRowsRangeV4, conversationFileChangesV4 } =
      createDependencies(completedRowsWithFileChanges());
    conversationRowsRangeV4
      .mockResolvedValueOnce({
        rows: completedRowsWithFileChanges().slice(1),
        atSeq: 4,
        atRevision: 8,
        atLogEpoch: "epoch-1",
        hasMore: true,
      })
      .mockResolvedValueOnce({
        rows: completedRowsWithFileChanges().slice(0, 1),
        atSeq: 4,
        atRevision: 7,
        atLogEpoch: "epoch-1",
        hasMore: false,
      });

    await expect(service.publish(publishInput(), "publish-op-5")).rejects.toMatchObject({
      kind: "invalid_conversation",
    });
    expect(conversationFileChangesV4).not.toHaveBeenCalled();
    expect(client.createPreparation).not.toHaveBeenCalled();
  });

  it("SHARE11：reverted fileChanges 不生成临时 artifact", async () => {
    const rows = completedRowsWithFileChanges();
    rows[1] = { ...rows[1]!, text: "已生成 index.html" };
    const { service, client, artifactSource, conversationFileChangesV4, preparationRequests } =
      createDependencies(rows);
    conversationFileChangesV4.mockResolvedValueOnce({
      files: 1,
      additions: 0,
      deletions: 0,
      state: "reverted",
      items: [
        {
          path: "index.html",
          additions: 0,
          deletions: 0,
          writeCount: 1,
          toolNames: ["Bash"],
          patches: [],
        },
      ],
    });

    await service.publish(publishInput(), "publish-op-6");

    expect(conversationFileChangesV4).toHaveBeenCalledTimes(1);
    expect(artifactSource.read).not.toHaveBeenCalled();
    expect(client.uploadArtifact).not.toHaveBeenCalled();
    expect(preparationRequests.at(-1)).toMatchObject({ artifact_count: 0 });
  });

  it("SHARE03：未选轮次的 fileChanges 不查询也不读取", async () => {
    const rows = completedRows();
    rows[2] = {
      ...rows[2]!,
      entityId: "turn-header-2",
      fileChanges: { files: 1, additions: 0, deletions: 0, state: "active" },
    };
    const { service, artifactSource, conversationFileChangesV4 } = createDependencies(rows);

    await service.publish(
      {
        ...publishInput(),
        selection: { kind: "rowAnchors", rowIds: [2] },
      },
      "publish-op-7",
    );

    expect(conversationFileChangesV4).not.toHaveBeenCalled();
    expect(artifactSource.read).not.toHaveBeenCalled();
  });

  it("SHARE11：fileChanges 查询发现 stale revision 时在 prepare 前拒绝", async () => {
    const rows = completedRowsWithFileChanges();
    rows[1] = { ...rows[1]!, text: "已生成 index.html" };
    const { service, client, conversationFileChangesV4 } = createDependencies(rows);
    conversationFileChangesV4.mockRejectedValueOnce(new Error("proto.staleRevision"));

    await expect(service.publish(publishInput(), "publish-op-8")).rejects.toMatchObject({
      kind: "invalid_conversation",
    });
    expect(client.createPreparation).not.toHaveBeenCalled();
  });

  it("SHARE02：已选结果物在 prepare 后上传，全部成功后再 confirm", async () => {
    const bytes = new TextEncoder().encode("pdf!");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const rows = completedRows().slice(0, 2);
    rows[1] = { ...rows[1]!, text: "已生成 report.pdf" };
    const { service, client, artifactSource, preparationRequests, confirmRequests } =
      createDependencies(rows);
    client.getCapabilities.mockResolvedValueOnce({
      ...capabilities,
      max_artifact_count: 2,
      max_artifact_bytes: 1024,
      max_total_artifact_bytes: 2048,
      allowed_artifacts: [{ type: "pdf", extensions: ["pdf"], mime_types: ["application/pdf"] }],
    });
    artifactSource.read.mockResolvedValueOnce({
      bytes,
      canonicalPath: "/workspace/report.pdf",
    });
    const order: string[] = [];
    client.createPreparation.mockImplementationOnce(async (request) => {
      order.push("prepare");
      preparationRequests.push(request);
      return {
        preparation_id: "preparation-1",
        status: "preparing",
        access_mode: request.access_mode,
        expires_at: 20_000,
      };
    });
    client.uploadArtifact.mockImplementationOnce(async (_id, descriptor, file) => {
      order.push("upload");
      expect(await file.text()).toBe("pdf!");
      return {
        artifact_id: descriptor.artifact_id,
        size_bytes: descriptor.size_bytes,
        sha256: descriptor.sha256,
        status: "uploaded",
      };
    });
    client.confirm.mockImplementationOnce(async (_id, request) => {
      order.push("confirm");
      confirmRequests.push(request);
      return shareRecord;
    });

    await expect(service.publish(publishInput(), "publish-op-9")).resolves.toEqual(shareRecord);

    expect(order).toEqual(["prepare", "upload", "confirm"]);
    expect(artifactSource.read).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      ref: "/workspace/report.pdf",
      maxBytes: 1024,
    });
    expect(preparationRequests.at(-1)).toMatchObject({ artifact_count: 1 });
    expect(client.uploadArtifact).toHaveBeenCalledWith(
      "preparation-1",
      expect.objectContaining({
        artifact_id: "share-artifact-1",
        artifact_type: "pdf",
        size_bytes: bytes.byteLength,
        sha256,
      }),
      expect.any(Blob),
    );
    expect(confirmRequests.at(-1)?.projection.rows.at(-1)).toMatchObject({
      kind: "artifact",
      ref: "zcode-artifact://share/share-artifact-1",
    });
  });

  it("SHARE07：上传回执不一致时不调用 confirm", async () => {
    const bytes = new Uint8Array([1]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const rows = completedRows().slice(0, 2);
    rows[1] = { ...rows[1]!, text: "已生成 report.pdf" };
    const { service, client, artifactSource } = createDependencies(rows);
    client.getCapabilities.mockResolvedValueOnce({
      ...capabilities,
      max_artifact_count: 1,
      max_artifact_bytes: 10,
      max_total_artifact_bytes: 10,
      allowed_artifacts: [{ type: "pdf", extensions: ["pdf"], mime_types: ["application/pdf"] }],
    });
    artifactSource.read.mockResolvedValueOnce({
      bytes,
      canonicalPath: "/workspace/report.pdf",
    });
    client.uploadArtifact.mockResolvedValueOnce({
      artifact_id: "wrong-artifact",
      size_bytes: 1,
      sha256,
      status: "uploaded",
    });

    await expect(service.publish(publishInput(), "publish-op-10")).rejects.toMatchObject({
      kind: "upload_incomplete",
    });
    expect(client.confirm).not.toHaveBeenCalled();
  });

  it("SHARE04：后端未允许结果物类型时不创建 preparation", async () => {
    const rows = completedRows().slice(0, 2);
    rows[1] = { ...rows[1]!, text: "已生成 report.pdf" };
    const { service, client, artifactSource } = createDependencies(rows);
    client.getCapabilities.mockResolvedValueOnce({
      ...capabilities,
      max_artifact_count: 1,
      max_artifact_bytes: 10,
      max_total_artifact_bytes: 10,
      allowed_artifacts: [],
    });

    const progress = collectPublishProgress(service, "publish-op-11");
    await expect(service.publish(publishInput(), "publish-op-11")).resolves.toEqual(shareRecord);
    expect(firstWarnings(progress)).toEqual([
      expect.objectContaining({
        code: "artifact_type_not_allowed",
        artifactDisplayName: "report.pdf",
      }),
    ]);
    expect(client.createPreparation).toHaveBeenCalledTimes(1);
    expect(artifactSource.read).not.toHaveBeenCalled();
  });

  it("aggregates multiple preview-card whitelist issues without creating preparation", async () => {
    const rows = completedRows().slice(0, 2);
    rows[1] = { ...rows[1]!, text: "已生成 report.pdf 和 clip.mp4" };
    const { service, client } = createDependencies(rows);
    client.getCapabilities.mockResolvedValueOnce({
      ...capabilities,
      max_artifact_count: 4,
      max_artifact_bytes: 10,
      max_total_artifact_bytes: 20,
      allowed_artifacts: [],
    });

    const progress = collectPublishProgress(service, "publish-op-12");
    await expect(service.publish(publishInput(), "publish-op-12")).resolves.toEqual(shareRecord);
    expect(firstWarnings(progress)).toEqual([
      expect.objectContaining({ artifactDisplayName: "clip.mp4" }),
      expect.objectContaining({ artifactDisplayName: "report.pdf" }),
    ]);
    expect(client.createPreparation).toHaveBeenCalledTimes(1);
  });

  it("SHARE07：选择后预览文件被删除时发布成功但回传最终 warning", async () => {
    const rows = completedRows().slice(0, 2);
    rows[1] = { ...rows[1]!, text: "已生成 report.pdf" };
    const { service, client, artifactSource } = createDependencies(rows);
    client.getCapabilities.mockResolvedValueOnce({
      ...capabilities,
      max_artifact_count: 1,
      max_artifact_bytes: 10,
      max_total_artifact_bytes: 10,
      allowed_artifacts: [{ type: "pdf", extensions: ["pdf"], mime_types: ["application/pdf"] }],
    });
    artifactSource.stat.mockRejectedValueOnce(
      new ConversationShareServiceError(
        "invalid_conversation",
        "Conversation artifact cannot be read",
        { reasonCode: "artifact_read_failed", diagnostics: { errno: "ENOENT" } },
      ),
    );
    const progress = collectPublishProgress(service, "publish-op-13");

    await expect(service.publish(publishInput(), "publish-op-13")).resolves.toEqual(shareRecord);

    expect(firstWarnings(progress)).toEqual([
      expect.objectContaining({
        code: "artifact_read_failed",
        artifactDisplayName: "report.pdf",
        availability: "not_found",
      }),
    ]);
    expect(artifactSource.read).not.toHaveBeenCalled();
    expect(client.uploadArtifact).not.toHaveBeenCalled();
    expect(client.confirm).toHaveBeenCalledTimes(1);
  });

  it("loads all row pages and publishes selected product turns in conversation order", async () => {
    const { service, conversationRowsRangeV4, preparationRequests, confirmRequests } =
      createDependencies();

    const result = await service.publish(
      {
        ...publishInput(),
        selection: { kind: "rowAnchors", rowIds: [4, 2] },
      },
      "publish-op-14",
    );

    expect(result.share_code).toBe("share-1");
    expect(conversationRowsRangeV4).toHaveBeenNthCalledWith(1, {
      workspacePath: "/workspace",
      workspaceIdentity: "ssh://host/workspace",
      sessionId: "session-1",
      limit: 200,
    });
    expect(conversationRowsRangeV4).toHaveBeenNthCalledWith(2, {
      workspacePath: "/workspace",
      workspaceIdentity: "ssh://host/workspace",
      sessionId: "session-1",
      beforeRowId: 3,
      limit: 200,
    });
    expect(confirmRequests[0].selected_product_turn_ids).toEqual([
      "share-product-turn-1",
      "share-product-turn-2",
    ]);
    expect(confirmRequests[0].projection.rows.map((row) => row.rowId)).toEqual([1, 2, 3, 4]);
    expect(Object.keys(confirmRequests[0])).toEqual([
      "selected_product_turn_ids",
      "projection",
      "integrity",
      "disclosure_confirmation",
    ]);
    expect(confirmRequests[0].integrity).not.toHaveProperty("payload_sha256");
    expect(preparationRequests[0]).toMatchObject({
      client_request_id: "publish-request-1",
      title: "会话分享",
      access_mode: "public_importable",
      artifact_count: 0,
      payload_sha256: sha256ConversationShareJson(confirmRequests[0]),
    });
  });

  it("publishes a public projection without subagent details or local write identities", async () => {
    const { service, confirmRequests } = createDependencies(completedRowsWithSubagent());

    await service.publish(publishInput(), "publish-op-15");

    expect(confirmRequests[0].projection.rows.map((row) => row.kind)).toEqual([
      "turnHeader",
      "assistantText",
      "toolCall",
      "turnHeader",
      "assistantText",
    ]);
    expect(confirmRequests[0].projection.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "toolCall",
          toolName: "Agent",
          toolCallId: "share-tool-call-1",
          status: "success",
        }),
      ]),
    );
    expect(JSON.stringify(confirmRequests[0].projection.rows)).not.toMatch(
      /local-agent-tool-call|local-subagent|local-child-session|local-approval/u,
    );
  });

  it("rejects active rows before creating a preparation", async () => {
    const rows = completedRows();
    rows[1] = {
      ...rows[1],
      kind: "assistantText",
      text: "生成中",
      state: "streaming",
    };
    const { service, client } = createDependencies(rows);

    await expect(service.publish(publishInput(), "publish-op-16")).rejects.toMatchObject({
      kind: "invalid_conversation",
    });
    expect(client.createPreparation).not.toHaveBeenCalled();
  });

  it.each([
    ["data:text/plain;base64,YQ==", "unsafe_structure"],
    ["file:///tmp/report.html", "unsafe_structure"],
    ["zcode-artifact://share/report", "artifact_protocol_not_ready"],
  ] as const)("rejects unsupported local reference %s", async (text, kind) => {
    const rows = completedRows();
    rows[1] = { ...rows[1], kind: "assistantText", text, state: "complete" };
    const { service, client } = createDependencies(rows);

    await expect(service.publish(publishInput(), "publish-op-17")).rejects.toMatchObject({ kind });
    expect(client.createPreparation).not.toHaveBeenCalled();
  });

  it("rejects missing product turn identity, empty selections and disclosure omissions", async () => {
    const rows = completedRows();
    delete rows[1].productTurnId;
    const { service, client } = createDependencies(rows);

    await expect(service.publish(publishInput(), "publish-op-18")).rejects.toMatchObject({
      kind: "invalid_conversation",
    });
    await expect(
      service.publish(
        {
          ...publishInput(),
          selection: { kind: "rowAnchors", rowIds: [] },
        },
        "publish-op-19",
      ),
    ).rejects.toMatchObject({ kind: "invalid_selection" });
    await expect(
      service.publish(
        {
          ...publishInput(),
          disclosureAcceptedAt: 0,
        },
        "publish-op-20",
      ),
    ).rejects.toMatchObject({ kind: "disclosure_required" });
    expect(client.createPreparation).not.toHaveBeenCalled();
  });

  it("选择阶段已知行数超限必须阻断", async () => {
    const { service, client } = createDependencies();
    client.getCapabilities.mockResolvedValueOnce({
      ...capabilities,
      max_rows: 1,
    });
    const result = await service.preflight(publishInput());
    expect(result.blockingIssues).toContainEqual(
      expect.objectContaining({ code: "rows_limit", actual: 4, limit: 1 }),
    );
  });

  it("enforces capability row and payload limits", async () => {
    const { service, client } = createDependencies();
    client.getCapabilities.mockResolvedValueOnce({
      ...capabilities,
      max_rows: 1,
    });

    await expect(service.publish(publishInput(), "publish-op-21")).rejects.toMatchObject({
      kind: "limit_exceeded",
      issues: [
        expect.objectContaining({
          code: "rows_limit",
          actual: 4,
          limit: 1,
        }),
      ],
    });
    expect(client.createPreparation).not.toHaveBeenCalled();
  });

  it("short-circuits when preparation idempotency returns a confirmed share", async () => {
    const { service, client } = createDependencies();
    client.createPreparation.mockResolvedValueOnce({
      preparation_id: "preparation-1",
      status: "confirmed",
      access_mode: "public_importable",
      expires_at: 20_000,
      share: {
        share_code: "existing-share",
        share_url: "https://zcode.z.ai/cn/share/existing-share",
        access_mode: "public_importable",
        expires_at: 20_000,
      },
    });

    await expect(service.publish(publishInput(), "publish-op-22")).resolves.toMatchObject({
      share_code: "existing-share",
    });
    expect(client.confirm).not.toHaveBeenCalled();
  });

  it("幂等 confirmed 结果也按界面语言改写分享链接", async () => {
    const { service, client } = createDependencies();
    client.createPreparation.mockResolvedValueOnce({
      preparation_id: "preparation-1",
      status: "confirmed",
      access_mode: "public_importable",
      expires_at: 20_000,
      share: {
        share_code: "existing-share-locale",
        share_url: "https://zcode.z.ai/cn/share/existing-share-locale",
        access_mode: "public_importable",
        expires_at: 20_000,
      },
    });

    await expect(
      service.publish({ ...publishInput(), locale: "en-US" }, "publish-op-confirmed-locale"),
    ).resolves.toMatchObject({
      share_url: "https://zcode.z.ai/share/existing-share-locale",
    });
  });

  it("SHARE29：含结果物的幂等 preparation 已 confirmed 时仍先复验但不重复上传", async () => {
    const bytes = new Uint8Array([1]);
    const rows = completedRows().slice(0, 2);
    rows[1] = { ...rows[1]!, text: "已生成 report.pdf" };
    const { service, client, artifactSource } = createDependencies(rows);
    artifactSource.read.mockResolvedValueOnce({
      bytes,
      canonicalPath: "/workspace/report.pdf",
    });
    client.getCapabilities.mockResolvedValueOnce({
      ...capabilities,
      max_artifact_count: 1,
      max_artifact_bytes: 10,
      max_total_artifact_bytes: 10,
      allowed_artifacts: [{ type: "pdf", extensions: ["pdf"], mime_types: ["application/pdf"] }],
    });
    client.createPreparation.mockResolvedValueOnce({
      preparation_id: "preparation-1",
      status: "confirmed",
      access_mode: "public_importable",
      expires_at: 20_000,
      share: {
        share_code: "existing-share",
        share_url: "https://zcode.z.ai/cn/share/existing-share",
        access_mode: "public_importable",
        expires_at: 20_000,
      },
    });

    await expect(service.publish(publishInput(), "publish-op-23")).resolves.toMatchObject({
      share_code: "existing-share",
    });
    expect(artifactSource.read).toHaveBeenCalledTimes(1);
    expect(client.uploadArtifact).not.toHaveBeenCalled();
    expect(client.confirm).not.toHaveBeenCalled();
  });

  it("retries the same confirm request after safety-check pending", async () => {
    let now = 0;
    const sleep = vi.fn(async (delayMs: number) => {
      now += delayMs;
    });
    const { service, client } = createDependencies(completedRows(), {
      now: () => now,
      sleep,
    });
    const attempts: Array<{
      preparationId: string;
      request: ConversationShareConfirmRequest;
    }> = [];
    client.confirm.mockImplementation(async (preparationId, request) => {
      attempts.push({ preparationId, request });
      if (attempts.length <= 2) {
        throw pendingSafetyCheck();
      }
      return shareRecord;
    });

    await expect(service.publish(publishInput(), "publish-op-24")).resolves.toEqual(shareRecord);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 5_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 5_000);
    expect(attempts.map((attempt) => attempt.preparationId)).toEqual([
      "preparation-1",
      "preparation-1",
      "preparation-1",
    ]);
    expect(attempts[1]?.request).toBe(attempts[0]?.request);
    expect(attempts[2]?.request).toBe(attempts[0]?.request);
    expect(client.createPreparation).toHaveBeenCalledTimes(1);
  });

  it("prefers Retry-After over the five-second fallback", async () => {
    let now = 0;
    const sleep = vi.fn(async (delayMs: number) => {
      now += delayMs;
    });
    const { service, client } = createDependencies(completedRows(), {
      now: () => now,
      sleep,
    });
    client.confirm
      .mockRejectedValueOnce(pendingSafetyCheck(12_000))
      .mockResolvedValueOnce(shareRecord);

    await expect(service.publish(publishInput(), "publish-op-25")).resolves.toEqual(shareRecord);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(12_000);
  });

  it("stops at the two-minute safety-check deadline without another confirm", async () => {
    let now = 0;
    const sleep = vi.fn(async (delayMs: number) => {
      now += delayMs;
    });
    const { service, client } = createDependencies(completedRows(), {
      confirmPollIntervalMs: 5_000,
      confirmPollTimeoutMs: 120_000,
      now: () => now,
      sleep,
    });
    client.confirm.mockRejectedValue(pendingSafetyCheck(undefined, "server-request-timeout"));

    await expect(service.publish(publishInput(), "publish-op-26")).rejects.toMatchObject({
      kind: "safety_check_timeout",
      requestId: "server-request-timeout",
    });
    expect(client.confirm).toHaveBeenCalledTimes(24);
    expect(now).toBe(120_000);
  });

  it("caps Retry-After at the remaining deadline without another confirm", async () => {
    let now = 0;
    const sleep = vi.fn(async (delayMs: number) => {
      now += delayMs;
    });
    const { service, client } = createDependencies(completedRows(), {
      confirmPollIntervalMs: 5_000,
      confirmPollTimeoutMs: 120_000,
      now: () => now,
      sleep,
    });
    client.confirm
      .mockRejectedValueOnce(pendingSafetyCheck(115_000))
      .mockRejectedValueOnce(pendingSafetyCheck(60_000));

    await expect(service.publish(publishInput(), "publish-op-27")).rejects.toMatchObject({
      kind: "safety_check_timeout",
    });
    expect(sleep).toHaveBeenNthCalledWith(1, 115_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 5_000);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(now).toBe(120_000);
    expect(client.confirm).toHaveBeenCalledTimes(2);
  });

  it("does not retry other confirm errors", async () => {
    const sleep = vi.fn(async () => {});
    const { service, client } = createDependencies(completedRows(), { sleep });
    const error = new ConversationShareClientError({
      kind: "upload_incomplete",
      message: "share upload incomplete",
      status: 409,
      code: 3210,
    });
    client.confirm.mockRejectedValueOnce(error);

    await expect(service.publish(publishInput(), "publish-op-28")).rejects.toBe(error);
    expect(client.confirm).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("logs the publish phase and stable error fields without raw content", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const { service, client } = createDependencies(completedRows(), { logger });
    client.getCapabilities.mockRejectedValueOnce(
      new ConversationShareClientError({
        kind: "artifact_not_allowed",
        message: "contains /private/path and https://signed.example/token",
        status: 422,
        code: 3208,
        requestId: "server-request-123",
      }),
    );

    await expect(service.publish(publishInput(), "share-operation-1")).rejects.toMatchObject({
      kind: "artifact_not_allowed",
    });

    expect(logger.warn).toHaveBeenCalledWith(undefined, "conversation share publish failed", {
      operationId: "share-operation-1",
      phase: "collecting",
      kind: "artifact_not_allowed",
      status: 422,
      code: 3208,
      requestId: "server-request-123",
      errorName: "ConversationShareClientError",
    });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("/private/path");
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("signed.example");
  });

  it("connection-scoped facade uses the attachment Agent and shares publish progress", async () => {
    const { service, client, conversationRowsRangeV4 } = createDependencies(completedRows());
    expect("createConnectionScopedService" in service).toBe(false);
    expect(() =>
      ProxyChannel.fromService(service as unknown as Record<string, unknown>).call(
        "host",
        "createConnectionScopedService",
      ),
    ).toThrow("Method not found");
    const scopedRowsRange = vi.fn(async () => ({
      rows: completedRows(),
      atSeq: 4,
      atRevision: 7,
      atLogEpoch: "epoch-1",
      hasMore: false,
    }));
    const scopedFileChanges = vi.fn(async () => ({
      files: 0,
      additions: 0,
      deletions: 0,
      items: [],
    }));
    const scoped = service[conversationShareConnectionScopeFactory]({
      conversationRowsRangeV4: scopedRowsRange,
      conversationFileChangesV4: scopedFileChanges,
    } as never);
    const phases: string[] = [];
    const subscription = service.onDynamicPublishProgress("share-operation-scoped")((progress) =>
      phases.push(progress.phase),
    );

    try {
      await expect(scoped.publish(publishInput(), "share-operation-scoped")).resolves.toEqual(
        shareRecord,
      );
    } finally {
      subscription.dispose();
    }

    expect(scopedRowsRange).toHaveBeenCalledTimes(1);
    expect(scopedFileChanges).not.toHaveBeenCalled();
    expect(conversationRowsRangeV4).not.toHaveBeenCalled();
    expect(client.createPreparation).toHaveBeenCalledTimes(1);
    expect(phases).toEqual(["collecting", "uploading", "checking", "complete"]);
  });

  it.each([
    "fault.conversation.rowsRangeConnectionUntrusted",
    "fault.connection.handshakeRequired",
    "fault.connection.closed",
  ])("normalizes %s from the scoped Agent", async (message) => {
    const { service } = createDependencies(completedRows());
    const scoped = service[conversationShareConnectionScopeFactory]({
      conversationRowsRangeV4: vi.fn(async () => {
        throw new Error(message);
      }),
      conversationFileChangesV4: vi.fn(),
    } as never);

    await expect(scoped.publish(publishInput(), `operation-${message}`)).rejects.toMatchObject({
      kind: "connection_unavailable",
    });
  });

  it("keeps concurrent attachment facades on their own Agent scope", async () => {
    const { service, conversationRowsRangeV4 } = createDependencies(completedRows());
    const rowsFor = (expectedIdentity: string) =>
      vi.fn(async (params: { workspaceIdentity?: string }) => {
        expect(params.workspaceIdentity).toBe(expectedIdentity);
        return {
          rows: completedRows(),
          atSeq: 4,
          atRevision: 7,
          atLogEpoch: "epoch-1",
          hasMore: false,
        };
      });
    const rowsA = rowsFor("ssh://host-a/workspace");
    const rowsB = rowsFor("ssh://host-b/workspace");
    const noFileChanges = vi.fn();
    const scopedA = service[conversationShareConnectionScopeFactory]({
      conversationRowsRangeV4: rowsA,
      conversationFileChangesV4: noFileChanges,
    } as never);
    const scopedB = service[conversationShareConnectionScopeFactory]({
      conversationRowsRangeV4: rowsB,
      conversationFileChangesV4: noFileChanges,
    } as never);

    await Promise.all([
      scopedA.publish(
        { ...publishInput(), workspaceIdentity: "ssh://host-a/workspace" },
        "operation-a",
      ),
      scopedB.publish(
        { ...publishInput(), workspaceIdentity: "ssh://host-b/workspace" },
        "operation-b",
      ),
    ]);

    expect(rowsA).toHaveBeenCalledTimes(1);
    expect(rowsB).toHaveBeenCalledTimes(1);
    expect(conversationRowsRangeV4).not.toHaveBeenCalled();
  });

  it("delegates preview and continuation without persisting signed URLs", async () => {
    const { service, client } = createDependencies();
    client.getPreview.mockResolvedValueOnce({ marker: "preview" });
    client.getContinuation.mockResolvedValueOnce({ marker: "continuation" });

    await expect(service.getPreview("share-code")).resolves.toEqual({
      marker: "preview",
    });
    await expect(
      service.getContinuation({
        shareCode: "share-code",
        clientRequestId: "import-1",
      }),
    ).resolves.toEqual({ marker: "continuation" });
    expect(client.getContinuation).toHaveBeenCalledWith("share-code", {
      schema_version: 1,
      client_request_id: "import-1",
    });
  });
});

it("损坏的内嵌图片只警告，不丢工具文字或修改原 rows", () => {
  const rows: ConversationRow[] = [
    {
      kind: "toolCall",
      rowId: 1,
      turnId: "t",
      productTurnId: "p",
      createdAt: 1,
      createdAtSeq: 1,
      toolCallId: "tool",
      toolName: "NodeRepl",
      status: "success",
      output: { text: "结果" },
      display: { kind: "node_repl_images", images: [{ base64: "%%%", mimeType: "image/png" }] },
    },
  ];
  const result = materializeConversationShareInlineImages(
    rows,
    {
      ...capabilities,
      allowed_artifacts: [{ type: "image", extensions: ["png"], mime_types: ["image/png"] }],
    },
    new Map([["p", 1]]),
  );
  expect(result.rows).toEqual([expect.objectContaining({ output: { text: "结果" } })]);
  expect(result.rows[0]).not.toHaveProperty("display");
  expect(rows[0]).toHaveProperty("display");
  expect(result.warnings).toEqual([
    expect.objectContaining({
      code: "artifact_read_failed",
      productTurnId: "p",
      rowId: 1,
      turnOrdinal: 1,
    }),
  ]);
  expect(result.bytesBySourceRef.size).toBe(0);
});
