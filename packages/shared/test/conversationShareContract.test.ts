import { describe, expect, it } from "vitest";

import {
  conversationShareArtifactUploadDataSchema,
  conversationShareCapabilitiesDataSchema,
  conversationShareCapabilitiesWireSchema,
  narrowConversationShareCapabilities,
  conversationShareConfirmDataSchema,
  conversationShareConfirmRequestSchema,
  conversationShareContinuationDataSchema,
  conversationShareContinuationRequestSchema,
  conversationShareErrorEnvelopeSchema,
  conversationSharePreparationDataSchema,
  conversationSharePreparationRequestSchema,
  conversationSharePreviewDataSchema,
  createConversationShareSuccessEnvelopeSchema,
  decodeConversationShareRows,
  isConversationShareSchemaVersionSupported,
  localizeConversationShareUrl,
  parseConversationSharePathname,
} from "../src/conversation-share.js";
import { sharedContextImportStateSchema } from "../src/zcode-protocol-v4/shared-context-import.js";

const SHA_256 = "a".repeat(64);

const completedRows = [
  {
    rowId: 1,
    turnId: "turn-1",
    productTurnId: "product-turn-1",
    createdAt: 1_788_415_000_000,
    createdAtSeq: 1,
    kind: "turnHeader",
    origin: "userInput",
    state: "completedSuccess",
    startedAt: 1_788_415_000_000,
    endedAt: 1_788_415_001_000,
  },
  {
    rowId: 2,
    turnId: "turn-1",
    productTurnId: "product-turn-1",
    createdAt: 1_788_415_000_100,
    createdAtSeq: 2,
    kind: "assistantText",
    text: "已完成",
    state: "complete",
  },
] as const;

const artifactDescriptor = {
  artifact_id: "artifact-public-id",
  logical_artifact_key: "report",
  producer_product_turn_id: "product-turn-1",
  artifact_version: 1,
  state: "current",
  ref: "zcode-artifact://share/artifact-public-id",
  artifact_type: "pptx",
  display_name: "季度报告.pptx",
  original_path: "/workspace/output/季度报告.pptx",
  extension: "pptx",
  mime_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  size_bytes: 102_400,
  sha256: SHA_256,
} as const;

describe("conversation share API revision 23 contract", () => {
  it("按语言前缀解析分享路径，只认已知形状", () => {
    expect(parseConversationSharePathname("/cn/share/abc")).toEqual({
      rawCode: "abc",
      locale: "zh-CN",
    });
    expect(parseConversationSharePathname("/share/abc")).toEqual({
      rawCode: "abc",
      locale: "en-US",
    });
    expect(parseConversationSharePathname("/share/abc/extra")).toBeNull();
    expect(parseConversationSharePathname("/cn/shared/abc")).toBeNull();
    expect(parseConversationSharePathname("/share")).toBeNull();
  });

  it("把分享链接改写到目标语言站点，且不改动 code 段", () => {
    expect(localizeConversationShareUrl("https://zcode.z.ai/cn/share/abc", "en-US")).toBe(
      "https://zcode.z.ai/share/abc",
    );
    expect(localizeConversationShareUrl("https://zcode.z.ai/share/abc", "zh-CN")).toBe(
      "https://zcode.z.ai/cn/share/abc",
    );
    // 已经是目标语言时保持原样，端口与 query 不受影响。
    expect(
      localizeConversationShareUrl("https://zcode.z.ai:8443/cn/share/a.b~c?x=1", "zh-CN"),
    ).toBe("https://zcode.z.ai:8443/cn/share/a.b~c?x=1");
  });

  it("形状不认识的链接原样返回，绝不猜着改", () => {
    // 服务端将来若换 URL 形状或独立域名，这里必须安静地不作为而不是改错。
    for (const url of [
      "https://zcode.z.ai/s/abc",
      "https://zcode.z.ai/cn/share/abc/extra",
      "https://zcode.z.ai/cn/share",
      "not-a-url",
      "",
    ]) {
      expect(localizeConversationShareUrl(url, "en-US")).toBe(url);
    }
  });

  it("sharedContextImport 只接受规范 /cn/share/ 回链", () => {
    // 回归守卫：导入时若把回链按界面语言本地化成 /share/<code>，这里会直接拒掉，
    // 英文界面的导入就会挂。所以持久化必须存规范路径，本地化只在展示时做。
    const base = {
      contextId: "shared-context-1",
      title: "来自分享：Shared Research",
      status: "pending" as const,
    };
    expect(
      sharedContextImportStateSchema.safeParse({
        ...base,
        shareUrl: "https://zcode.z.ai/cn/share/abc",
      }).success,
    ).toBe(true);
    const localized = sharedContextImportStateSchema.safeParse({
      ...base,
      shareUrl: "https://zcode.z.ai/share/abc",
    });
    // 英文站路径只能作为 legacy { title } 形状通过，v2 形状（带 contextId/status）会被拒。
    expect(localized.success && "contextId" in localized.data).toBe(false);
  });

  it("parses capabilities with all three access modes", () => {
    const parsed = conversationShareCapabilitiesDataSchema.parse({
      schema_version: 1,
      ttl_ms: 604_800_000,
      access_modes: ["private", "public_readonly", "public_importable"],
      max_rows: 500,
      max_payload_bytes: 4_194_304,
      max_artifact_count: 20,
      max_artifact_bytes: 20_971_520,
      max_total_artifact_bytes: 104_857_600,
      allowed_artifacts: [
        {
          type: "image",
          extensions: ["png", "jpg", "jpeg", "webp"],
          mime_types: ["image/png", "image/jpeg", "image/webp"],
        },
      ],
    });

    expect(parsed.access_modes).toEqual(["private", "public_readonly", "public_importable"]);
  });

  it("tolerates artifact types the client does not know yet", () => {
    // 线上故障：后端在 allowed_artifacts 里新增类型后，严格枚举让整份 capabilities 解析
    // 失败，发布在 collecting 阶段就抛 invalid_contract。能力发现列表必须向前兼容。
    const wire = conversationShareCapabilitiesWireSchema.parse({
      schema_version: 1,
      ttl_ms: 604_800_000,
      access_modes: ["private"],
      max_rows: 500,
      max_payload_bytes: 4_194_304,
      max_artifact_count: 20,
      max_artifact_bytes: 20_971_520,
      max_total_artifact_bytes: 104_857_600,
      allowed_artifacts: [
        { type: "pdf", extensions: ["pdf"], mime_types: ["application/pdf"] },
        { type: "some-future-type", extensions: ["fut"], mime_types: ["application/x-future"] },
      ],
    });

    const { capabilities, unsupportedArtifactTypes } = narrowConversationShareCapabilities(wire);

    expect(capabilities.allowed_artifacts.map((entry) => entry.type)).toEqual(["pdf"]);
    expect(unsupportedArtifactTypes).toEqual(["some-future-type"]);
  });

  it("保留服务端的 md 结果物类型，不再把它当未知类型削掉", () => {
    // Bug 根因：本地枚举缺 md → 服务端允许的 md 被丢弃 → 又拿被削过的白名单
    // 告诉用户「.md 不支持,请取消该轮」。本地能抽出 .md 候选，就必须认这个类型。
    const wire = conversationShareCapabilitiesWireSchema.parse({
      schema_version: 1,
      ttl_ms: 604_800_000,
      access_modes: ["private"],
      max_rows: 500,
      max_payload_bytes: 4_194_304,
      max_artifact_count: 20,
      max_artifact_bytes: 20_971_520,
      max_total_artifact_bytes: 104_857_600,
      allowed_artifacts: [
        { type: "md", extensions: ["md"], mime_types: ["text/markdown"] },
        { type: "html", extensions: ["html", "htm"], mime_types: ["text/html"] },
        { type: "text", extensions: ["txt"], mime_types: ["text/plain"] },
      ],
    });

    const { capabilities, unsupportedArtifactTypes } = narrowConversationShareCapabilities(wire);

    expect(capabilities.allowed_artifacts.map((entry) => entry.type)).toEqual([
      "md",
      "html",
      "text",
    ]);
    expect(unsupportedArtifactTypes).toEqual([]);
  });

  it("parses preparation request and confirmed idempotency response", () => {
    expect(
      conversationSharePreparationRequestSchema.parse({
        client_request_id: "request-uuid",
        title: "分享标题",
        schema_version: 1,
        access_mode: "public_readonly",
        payload_sha256: SHA_256,
        artifact_count: 0,
      }),
    ).toMatchObject({ artifact_count: 0, access_mode: "public_readonly" });

    const parsed = conversationSharePreparationDataSchema.parse({
      preparation_id: "preparation-id",
      status: "confirmed",
      access_mode: "public_readonly",
      expires_at: 1_789_020_800_000,
      share: {
        share_code: "base64url-hmac-code",
        share_url: "https://example.com/share/base64url-hmac-code",
        access_mode: "public_readonly",
        expires_at: 1_789_020_800_000,
      },
    });

    expect(parsed.status).toBe("confirmed");
  });

  it("parses artifact upload response", () => {
    expect(
      conversationShareArtifactUploadDataSchema.parse({
        artifact_id: artifactDescriptor.artifact_id,
        size_bytes: artifactDescriptor.size_bytes,
        sha256: SHA_256,
        status: "uploaded",
        safety_status: "pending",
      }),
    ).toEqual({
      artifact_id: "artifact-public-id",
      size_bytes: 102_400,
      sha256: SHA_256,
      status: "uploaded",
      safety_status: "pending",
    });
  });

  it.each([undefined, "", "   "])(
    "rejects missing or empty artifact safety status: %j",
    (safetyStatus) => {
      expect(() =>
        conversationShareArtifactUploadDataSchema.parse({
          artifact_id: artifactDescriptor.artifact_id,
          size_bytes: artifactDescriptor.size_bytes,
          sha256: SHA_256,
          status: "uploaded",
          ...(safetyStatus === undefined ? {} : { safety_status: safetyStatus }),
        }),
      ).toThrow();
    },
  );

  it("parses confirm request with formal ConversationRow values", () => {
    const parsed = conversationShareConfirmRequestSchema.parse({
      selected_product_turn_ids: ["product-turn-1"],
      projection: { rows: completedRows },
      integrity: {
        projection_sha256: SHA_256,
        artifact_set_sha256: SHA_256,
      },
      disclosure_confirmation: {
        version: 1,
        accepted_at: 1_788_415_002_000,
        acknowledged_no_secret_detection: true,
      },
    });

    expect(Object.keys(parsed)).toEqual([
      "selected_product_turn_ids",
      "projection",
      "integrity",
      "disclosure_confirmation",
    ]);
    expect(parsed.projection.rows[0]?.kind).toBe("turnHeader");
    expect(
      conversationShareConfirmDataSchema.parse({
        share_code: "base64url-hmac-code",
        share_url: "https://example.com/share/base64url-hmac-code",
        access_mode: "private",
        expires_at: 1_789_020_800_000,
      }).share_code,
    ).toBe("base64url-hmac-code");
  });

  it("keeps preview URLs and continuation download URLs as distinct fields", () => {
    const preview = conversationSharePreviewDataSchema.parse({
      schema_version: 1,
      share: {
        title: "分享标题",
        access_mode: "public_importable",
        created_at: 1_788_415_002_000,
        expires_at: 1_789_020_800_000,
      },
      rows: completedRows,
      artifacts: [
        {
          ...artifactDescriptor,
          url: "https://signed.example.com/preview",
          url_expires_at: 1_788_415_600_000,
        },
      ],
      integrity: {
        projection_sha256: SHA_256,
        artifact_set_sha256: SHA_256,
      },
    });
    const continuationRequest = conversationShareContinuationRequestSchema.parse({
      schema_version: 1,
      client_request_id: "import-request-uuid",
    });
    const continuation = conversationShareContinuationDataSchema.parse({
      schema_version: 1,
      import_grant_id: "deterministic-grant-id",
      import_grant_expires_at: 1_788_415_600_000,
      share: {
        share_id: "internal-share-id",
        title: "分享标题",
        access_mode: "public_importable",
        created_at: 1_788_415_002_000,
        expires_at: 1_789_020_800_000,
      },
      rows: completedRows,
      artifacts: [
        {
          ...artifactDescriptor,
          download_url: "https://signed.example.com/download",
          download_url_expires_at: 1_788_415_600_000,
        },
      ],
      integrity: {
        projection_sha256: SHA_256,
        artifact_set_sha256: SHA_256,
      },
    });

    expect(preview.artifacts[0]?.url).toContain("/preview");
    expect(continuation.artifacts[0]?.download_url).toContain("/download");
    expect(continuationRequest.schema_version).toBe(1);
  });

  it("rejects the legacy payload hash in confirm integrity", () => {
    expect(() =>
      conversationShareConfirmRequestSchema.parse({
        selected_product_turn_ids: ["product-turn-1"],
        projection: { rows: completedRows },
        integrity: {
          projection_sha256: SHA_256,
          artifact_set_sha256: SHA_256,
          payload_sha256: SHA_256,
        },
        disclosure_confirmation: {
          version: 1,
          accepted_at: 1_788_415_002_000,
          acknowledged_no_secret_detection: true,
        },
      }),
    ).toThrow();
  });

  it("accepts formal artifact rows and rejects incomplete ones", () => {
    const artifactRow = {
      rowId: 3,
      turnId: "turn-1",
      productTurnId: "product-turn-1",
      createdAt: 1_788_415_000_200,
      createdAtSeq: 3,
      kind: "artifact",
      artifactVersionId: "artifact-public-id",
      logicalArtifactKey: "report",
      displayName: "季度报告.pdf",
      artifactType: "pdf",
      mimeType: "application/pdf",
      sizeBytes: 102_400,
      sha256: SHA_256,
      ref: "zcode-artifact://share/artifact-public-id",
      state: "current",
    } as const;

    expect(
      conversationShareConfirmRequestSchema
        .parse({
          selected_product_turn_ids: ["product-turn-1"],
          projection: { rows: [...completedRows, artifactRow] },
          integrity: { projection_sha256: SHA_256, artifact_set_sha256: SHA_256 },
          disclosure_confirmation: {
            version: 1,
            accepted_at: 1_788_415_002_000,
            acknowledged_no_secret_detection: true,
          },
        })
        .projection.rows.at(-1),
    ).toEqual(artifactRow);

    expect(() =>
      conversationShareCapabilitiesDataSchema.parse({
        schema_version: 1,
        ttl_ms: 1,
        access_modes: ["private"],
        max_rows: 1,
        max_payload_bytes: 1,
        max_artifact_count: 0,
        max_artifact_bytes: 1,
        max_total_artifact_bytes: 1,
        allowed_artifacts: [],
        unexpected: true,
      }),
    ).toThrow();

    // 入站 preview 的 rows 是 unknown[]：残缺行不再打死整份分享，而是由
    // decodeConversationShareRows 单独跳过（见「跨版本前向兼容」一节的用例）。
    const previewWithBrokenRow = conversationSharePreviewDataSchema.parse({
      schema_version: 1,
      share: {
        title: "分享标题",
        access_mode: "public_readonly",
        created_at: 1,
        expires_at: 2,
      },
      rows: [
        {
          rowId: 1,
          turnId: "turn-1",
          productTurnId: "product-turn-1",
          createdAt: 1,
          createdAtSeq: 1,
          kind: "artifact",
          artifactVersionId: "artifact-public-id",
        },
      ],
      artifacts: [],
      integrity: {
        projection_sha256: SHA_256,
        artifact_set_sha256: SHA_256,
      },
    });
    const decodedBrokenRow = decodeConversationShareRows(previewWithBrokenRow.rows);
    expect(decodedBrokenRow.rows).toHaveLength(0);
    expect(decodedBrokenRow.unsupportedCount).toBe(1);
    expect(decodedBrokenRow.unsupportedKinds).toEqual(["artifact"]);
  });

  it.each([
    3001, 3002, 3200, 3201, 3203, 3204, 3205, 3206, 3207, 3208, 3209, 3210, 3211, 3212, 3213, 3214,
    3215,
  ])("parses documented business error code %i", (code) => {
    expect(conversationShareErrorEnvelopeSchema.parse({ code, msg: "error" }).code).toBe(code);
  });
});

/**
 * 跨版本前向兼容。
 *
 * 分享内容在 4 个可独立升级/回滚的部件之间流动（发布端 Desktop、Share API 后端、
 * 独立部署的落地页镜像、导入端 Desktop），它们不可能同版本。这一节把「什么样的演进
 * 不许打死老消费端」钉成回归，避免以后每次改分享内容都要重新推演一遍兼容性。
 */
describe("conversation share cross-version forward compatibility", () => {
  const share = {
    title: "分享标题",
    access_mode: "public_readonly",
    created_at: 1,
    expires_at: 2,
  } as const;
  const integrity = { projection_sha256: SHA_256, artifact_set_sha256: SHA_256 } as const;
  const assistantRow = {
    rowId: 10,
    turnId: "turn-1",
    createdAt: 1,
    createdAtSeq: 1,
    kind: "assistantText",
    text: "hi",
    state: "complete",
  } as const;
  const previewOf = (overrides: Record<string, unknown> = {}) => ({
    schema_version: 1,
    share,
    rows: [assistantRow],
    artifacts: [],
    integrity,
    ...overrides,
  });

  it("后端给响应加顶层字段时仍然可解析", () => {
    expect(() =>
      conversationSharePreviewDataSchema.parse(previewOf({ view_count: 3 })),
    ).not.toThrow();
  });

  it("后端给 share 元数据加字段时仍然可解析", () => {
    expect(() =>
      conversationSharePreviewDataSchema.parse(
        previewOf({ share: { ...share, owner_display_name: "someone" } }),
      ),
    ).not.toThrow();
  });

  it("后端给 artifact descriptor 加字段时仍然可解析", () => {
    const artifact = {
      artifact_id: "artifact-1",
      logical_artifact_key: "report",
      producer_product_turn_id: "product-turn-1",
      artifact_version: 1,
      state: "current",
      ref: "zcode-artifact://share/artifact-1",
      artifact_type: "md",
      display_name: "report.md",
      extension: "md",
      mime_type: "text/markdown",
      size_bytes: 1,
      sha256: SHA_256,
      url: "https://example.com/a",
      url_expires_at: 3,
      // 后端将来新增的安全扫描字段
      virus_scan: "clean",
    };
    expect(() =>
      conversationSharePreviewDataSchema.parse(previewOf({ artifacts: [artifact] })),
    ).not.toThrow();
  });

  it("后端上线新业务错误码时保留服务端 msg，不退化成无上下文的 HTTP 错误", () => {
    const parsed = conversationShareErrorEnvelopeSchema.parse({ code: 3299, msg: "新错误" });
    expect(parsed).toEqual({ code: 3299, msg: "新错误" });
  });

  it("后端给成功信封写非空 msg 时不判成契约错误", () => {
    expect(() =>
      createConversationShareSuccessEnvelopeSchema(conversationSharePreviewDataSchema).parse({
        code: 0,
        msg: "ok",
        data: previewOf(),
      }),
    ).not.toThrow();
  });

  it("后端给 capabilities 加限额字段或新 access mode 时，能力发现不被打死", () => {
    const wire = conversationShareCapabilitiesWireSchema.parse({
      schema_version: 1,
      ttl_ms: 1,
      access_modes: ["private", "public_readonly", "public_importable", "public_team"],
      max_rows: 1,
      max_payload_bytes: 1,
      max_artifact_count: 0,
      max_artifact_bytes: 1,
      max_total_artifact_bytes: 1,
      allowed_artifacts: [],
      // 后端将来新增的限额
      max_title_length: 100,
    });
    const narrowed = narrowConversationShareCapabilities(wire);
    expect(narrowed.capabilities.access_modes).toEqual([
      "private",
      "public_readonly",
      "public_importable",
    ]);
    expect(narrowed.unsupportedAccessModes).toEqual(["public_team"]);
  });

  // 这是本次加固的核心回归：additive 的 row 演进曾经会让所有老导入端算出不同的
  // projection_sha256，把「加一个 optional 字段」误报成「分享文件校验失败」。
  it("row 多一个未知 optional 字段时，原始值原样保留（哈希才能对得上）", () => {
    const futureRow = { ...assistantRow, futureField: "x" };
    const parsed = conversationSharePreviewDataSchema.parse(previewOf({ rows: [futureRow] }));
    expect(parsed.rows[0]).toEqual(futureRow);
    const decoded = decodeConversationShareRows(parsed.rows);
    expect(decoded.unsupportedCount).toBe(0);
    expect(decoded.rows).toHaveLength(1);
  });

  it.each([
    ["新增 row kind", { ...assistantRow, kind: "videoClip" }, "videoClip"],
    ["已有 kind 的新 enum 值", { ...assistantRow, state: "aborted" }, "assistantText"],
    [
      "新增 timelineMarker type",
      {
        rowId: 11,
        turnId: "turn-1",
        createdAt: 1,
        createdAtSeq: 2,
        kind: "timelineMarker",
        marker: { type: "brandNewMarker", detail: "x" },
      },
      "timelineMarker",
    ],
    [
      "新增 artifact type",
      {
        rowId: 12,
        turnId: "turn-1",
        createdAt: 1,
        createdAtSeq: 3,
        kind: "artifact",
        artifactVersionId: "a",
        logicalArtifactKey: "k",
        displayName: "data.csv",
        artifactType: "csv",
        mimeType: "text/csv",
        sizeBytes: 1,
        sha256: SHA_256,
        ref: "zcode-artifact://share/a",
        state: "current",
      },
      "artifact",
    ],
  ])("%s 只丢该行，其余内容照常呈现", (_label, futureRow, expectedKind) => {
    const parsed = conversationSharePreviewDataSchema.parse(
      previewOf({ rows: [assistantRow, futureRow] }),
    );
    const decoded = decodeConversationShareRows(parsed.rows);
    expect(decoded.rows).toHaveLength(1);
    expect(decoded.rows[0]?.rowId).toBe(assistantRow.rowId);
    expect(decoded.unsupportedCount).toBe(1);
    expect(decoded.unsupportedKinds).toEqual([expectedKind]);
  });

  it("schema_version 比本端新时收得下，由调用方转成「请升级」而不是「格式无效」", () => {
    const parsed = conversationSharePreviewDataSchema.parse(previewOf({ schema_version: 2 }));
    expect(parsed.schema_version).toBe(2);
    expect(isConversationShareSchemaVersionSupported(parsed.schema_version)).toBe(false);
    expect(isConversationShareSchemaVersionSupported(1)).toBe(true);
  });

  it("出站请求仍然严格：多带字段是本端 bug，必须当场炸掉", () => {
    expect(() =>
      conversationShareContinuationRequestSchema.parse({
        schema_version: 1,
        client_request_id: "request-1",
        unexpected: true,
      }),
    ).toThrow();
  });
});
