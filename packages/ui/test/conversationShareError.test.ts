import { describe, expect, it } from "vitest";

import {
  formatConversationShareErrorSummary,
  formatConversationShareAllowedArtifacts,
  formatConversationShareArtifactType,
  getConversationShareErrorDetails,
  resolveConversationShareFallbackIssueCode,
  resolveConversationSharePublishErrorMessageId,
  resolveConversationShareWarningMessageId,
  sanitizeConversationShareWarnings,
} from "@/lib/conversationShareError.js";

describe("conversation share error presentation", () => {
  it("用友好文件类别和支持类型替代内部 MIME 白名单文案", () => {
    const issue = {
      code: "artifact_type_not_allowed" as const,
      scope: "artifact" as const,
      artifactType: "mp4",
      extension: "mp4",
      mimeType: "video/mp4",
      allowedArtifacts: [
        { type: "pdf", extensions: ["pdf"], mimeTypes: ["application/pdf"] },
        { type: "text", extensions: ["txt"], mimeTypes: ["text/plain"] },
      ],
    };
    expect(formatConversationShareArtifactType(issue, "zh-CN")).toBe("MP4");
    expect(formatConversationShareAllowedArtifacts(issue, "zh-CN")).toBe("PDF、纯文本");
    expect(formatConversationShareAllowedArtifacts(issue, "en-US")).toBe("PDF, plain text");
  });

  it("为预览卡片媒体使用本地化的 warning 类别", () => {
    expect(
      formatConversationShareArtifactType(
        {
          code: "artifact_type_not_allowed",
          scope: "artifact",
          artifactType: "video",
          artifactDisplayName: "condensed.mp4",
        },
        "zh-CN",
      ),
    ).toBe("视频");
    expect(
      formatConversationShareArtifactType(
        {
          code: "artifact_type_not_allowed",
          scope: "artifact",
          artifactType: "audio",
          artifactDisplayName: "voice.wav",
        },
        "en-US",
      ),
    ).toBe("audio");
  });

  it.each([
    ["authentication_required", "conversationShare.error.authenticationRequired"],
    ["feature_disabled", "conversationShare.error.featureDisabled"],
    ["artifact_not_allowed", "conversationShare.error.artifactNotAllowed"],
    ["limit_exceeded", "conversationShare.error.limitExceeded"],
    ["rate_limited", "conversationShare.error.rateLimited"],
    ["invalid_contract", "conversationShare.error.invalidContract"],
    ["network", "conversationShare.error.network"],
    ["safety_check_timeout", "conversationShare.error.safetyCheckTimeout"],
    ["invalid_selection", "conversationShare.error.invalidSelection"],
    ["invalid_conversation", "conversationShare.error.invalidConversation"],
    ["unsafe_structure", "conversationShare.error.invalidConversation"],
    ["upload_incomplete", "conversationShare.error.uploadFailed"],
    ["connection_unavailable", "conversationShare.error.connectionUnavailable"],
  ])("maps %s to an actionable localized message", (kind, expected) => {
    expect(resolveConversationSharePublishErrorMessageId({ kind })).toBe(expected);
  });

  it("uses the generic fallback for unknown values", () => {
    expect(resolveConversationSharePublishErrorMessageId(new Error("boom"))).toBe(
      "conversationShare.publishFailed",
    );
  });

  it("extracts only stable diagnostic fields and omits raw messages", () => {
    expect(
      getConversationShareErrorDetails({
        name: "ConversationShareClientError",
        kind: "artifact_not_allowed",
        status: 422,
        code: 3208,
        requestId: "server-request-123",
        message: "contains /private/path and https://signed.example/token",
      }),
    ).toEqual({
      name: "ConversationShareClientError",
      kind: "artifact_not_allowed",
      status: 422,
      code: 3208,
      requestId: "server-request-123",
    });
  });

  it("reads the RPC details envelope and rejects unsafe request ids", () => {
    expect(
      getConversationShareErrorDetails({
        name: "ConversationShareServiceError",
        kind: "artifact_not_allowed",
        details: {
          requestId: "server-request-123",
          issues: [{ code: "artifact_type_not_allowed", scope: "artifact" }],
          issueCount: 1,
          omittedIssueCount: 0,
        },
      }),
    ).toMatchObject({
      requestId: "server-request-123",
      issueCount: 1,
      issues: [{ code: "artifact_type_not_allowed", scope: "artifact" }],
    });

    expect(
      getConversationShareErrorDetails({
        kind: "network",
        details: { requestId: "https://signed.example/token" },
      }),
    ).not.toHaveProperty("requestId");
  });

  it("maps invalid conversation reasons to actionable guidance", () => {
    expect(
      resolveConversationSharePublishErrorMessageId({
        kind: "invalid_conversation",
        reasonCode: "input_attachment",
      }),
    ).toBe("conversationShare.error.inputAttachment");
    expect(
      resolveConversationSharePublishErrorMessageId({
        kind: "invalid_conversation",
        reasonCode: "running_turn",
      }),
    ).toBe("conversationShare.error.runningTurn");
  });

  it("keeps safe diagnostic metadata for logging and presentation", () => {
    expect(
      getConversationShareErrorDetails({
        kind: "invalid_conversation",
        reasonCode: "artifact_changed",
        diagnostics: { rowKind: "artifact", rowId: 7, artifactType: "pdf" },
        message: "private path must not be exposed",
      }),
    ).toMatchObject({
      reasonCode: "artifact_changed",
      diagnostics: { rowKind: "artifact", rowId: 7, artifactType: "pdf" },
    });
  });

  it("drops unsafe issue fields while keeping the stable error", () => {
    expect(
      getConversationShareErrorDetails({
        kind: "artifact_not_allowed",
        issues: [
          {
            code: "artifact_type_not_allowed",
            scope: "artifact",
            artifactDisplayName: "/private/report.pdf",
            mimeType: "https://signed.example/token",
          },
        ],
      }),
    ).toMatchObject({ kind: "artifact_not_allowed", issueCount: 1 });
    expect(
      getConversationShareErrorDetails({
        kind: "artifact_not_allowed",
        issues: [
          {
            code: "artifact_type_not_allowed",
            scope: "artifact",
            artifactDisplayName: "report.pdf",
            mimeType: "application/pdf",
          },
        ],
      }).issues,
    ).toEqual([
      expect.objectContaining({ artifactDisplayName: "report.pdf", mimeType: "application/pdf" }),
    ]);
  });

  it("formats a safe actionable summary from aggregated issues", () => {
    expect(
      formatConversationShareErrorSummary({
        kind: "artifact_not_allowed",
        issues: [
          {
            code: "artifact_type_not_allowed",
            scope: "artifact",
            turnOrdinal: 2,
            artifactDisplayName: "晨报.pdf",
            artifactType: "pdf",
            extension: "pdf",
            mimeType: "application/pdf",
            allowedFormats: ["PPTX", "DOCX"],
          },
        ],
      }),
    ).toEqual({
      titleId: "conversationShare.error.summary",
      issueCount: 1,
      turnOrdinals: [2],
    });
  });

  it("formats limit details without exposing paths or raw messages", () => {
    expect(
      formatConversationShareErrorSummary({
        kind: "limit_exceeded",
        issues: [
          {
            code: "payload_size_limit",
            scope: "conversation",
            actual: 4_800_000,
            limit: 4_000_000,
          },
        ],
      }),
    ).toMatchObject({ issueCount: 1, turnOrdinals: [] });
  });

  it("keeps a useful panel issue when the server returns only a stable kind", () => {
    expect(resolveConversationShareFallbackIssueCode({ kind: "invalid_conversation" })).toBe(
      "invalid_conversation",
    );
    expect(resolveConversationShareFallbackIssueCode({ kind: "network" })).toBe("unknown");
  });

  it("limits rendered issues and reports the omitted count", () => {
    const details = getConversationShareErrorDetails({
      kind: "invalid_conversation",
      issueCount: 7,
      omittedIssueCount: 2,
      issues: Array.from({ length: 5 }, () => ({
        code: "invalid_conversation",
        scope: "conversation",
      })),
    });
    expect(details.issues).toHaveLength(5);
    expect(details.omittedIssueCount).toBe(2);
  });

  it("跳过提示用非阻断文案，未覆盖的 code 回落到 issue 文案", () => {
    expect(
      resolveConversationShareWarningMessageId({ code: "artifact_read_failed", scope: "artifact" }),
    ).toBe("conversationShare.warning.artifactSkipped");
    expect(
      resolveConversationShareWarningMessageId({ code: "input_attachment", scope: "turn" }),
    ).toBe("conversationShare.warning.inputAttachmentSkipped");
    expect(
      resolveConversationShareWarningMessageId({ code: "inline_tool_image", scope: "turn" }),
    ).toBe("conversationShare.issue.inlineToolImage");
    expect(
      resolveConversationShareWarningMessageId({ code: "unsupported_timeline", scope: "turn" }),
    ).toBe("conversationShare.issue.unsupportedTimeline");
    expect(
      resolveConversationShareWarningMessageId({ code: "artifact_changed", scope: "artifact" }),
    ).toBe("conversationShare.warning.artifactChangedSkipped");
  });

  it("清洗 progress 里的跳过提示并丢弃带路径的字段", () => {
    expect(
      sanitizeConversationShareWarnings([
        {
          code: "artifact_read_failed",
          scope: "artifact",
          turnOrdinal: 2,
          artifactDisplayName: "调研报告.pdf",
        },
        { code: "artifact_read_failed", scope: "artifact", artifactDisplayName: "a/b/leak.pdf" },
        { code: "inline_tool_image", scope: "turn", turnOrdinal: 1 },
        { code: "unsupported_timeline", scope: "turn", turnOrdinal: 1 },
        "not-an-issue",
      ]),
    ).toEqual([
      {
        code: "artifact_read_failed",
        scope: "artifact",
        turnOrdinal: 2,
        artifactDisplayName: "调研报告.pdf",
      },
      { code: "artifact_read_failed", scope: "artifact" },
    ]);
    expect(sanitizeConversationShareWarnings(undefined)).toEqual([]);
  });
});

it("405 接口异常含状态文案，不建议取消轮次", () => {
  expect(
    resolveConversationSharePublishErrorMessageId({ kind: "invalid_contract", status: 405 }),
  ).toBe("conversationShare.error.invalidContractHttp");
  expect(
    getConversationShareErrorDetails({
      kind: "network",
      details: { status: 200, clientRequestId: "client-1", requestId: "server-1" },
    }),
  ).toMatchObject({
    kind: "network",
    status: 200,
    clientRequestId: "client-1",
    requestId: "server-1",
  });
  expect(
    getConversationShareErrorDetails({ details: { clientRequestId: "https://private/token" } })
      .clientRequestId,
  ).toBeUndefined();
});
