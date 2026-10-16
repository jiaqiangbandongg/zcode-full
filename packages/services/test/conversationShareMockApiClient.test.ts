import { createHash } from "node:crypto";
import type {
  ConversationShareArtifactDescriptor,
  ConversationShareConfirmRequest,
} from "@zcode/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConversationShareHttpClient } from "../src/conversation-share/conversationShareHttpClient.js";
import {
  buildConversationShareConfirmRequest,
  sha256ConversationShareJson,
} from "../src/conversation-share/conversationShareIntegrity.js";
import { ConversationShareMockApiClient } from "./helpers/conversationShareMockApiClient.js";

function makeConfirmRequest(
  rows?: ConversationShareConfirmRequest["projection"]["rows"],
  artifacts: ConversationShareArtifactDescriptor[] = [],
) {
  return buildConversationShareConfirmRequest({
    selected_product_turn_ids: ["share-product-turn-1"],
    projection: {
      rows: rows ?? [
        {
          rowId: 1,
          turnId: "share-turn-1",
          productTurnId: "share-product-turn-1",
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
          turnId: "share-turn-1",
          productTurnId: "share-product-turn-1",
          createdAt: 1_010,
          createdAtSeq: 2,
          kind: "assistantText",
          text: "已完成",
          state: "complete",
        },
      ],
    },
    artifacts,
    disclosure_confirmation: {
      version: 1,
      accepted_at: 1_200,
      acknowledged_no_secret_detection: true,
    },
  });
}

function createClient(
  apiClient: ConversationShareMockApiClient,
  token: string | null = "owner-token",
) {
  return new ConversationShareHttpClient({
    apiClient,
    baseUrl: "https://api.example.com/api/v1",
    tokenProvider: async () => token,
  });
}

async function publish(
  apiClient: ConversationShareMockApiClient,
  accessMode: "private" | "public_readonly" | "public_importable",
) {
  const client = createClient(apiClient);
  const confirmRequest = makeConfirmRequest();
  const preparation = await client.createPreparation({
    client_request_id: "publish-request-1",
    title: "分享标题",
    schema_version: 1,
    access_mode: accessMode,
    payload_sha256: sha256ConversationShareJson(confirmRequest),
    artifact_count: 0,
  });
  const share = await client.confirm(preparation.preparation_id, confirmRequest);
  return { client, confirmRequest, preparation, share };
}

describe("ConversationShareMockApiClient", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses ZCODE_CONVERSATION_SHARE_WEB_URL for generated mock links", async () => {
    vi.stubEnv("ZCODE_CONVERSATION_SHARE_WEB_URL", "http://127.0.0.1:5173/cn/share");
    const apiClient = new ConversationShareMockApiClient({ now: () => 10_000 });
    const { share } = await publish(apiClient, "public_readonly");

    expect(share.share_url).toMatch(/^http:\/\/127\.0\.0\.1:5173\/cn\/share\/mock-share-\d+$/u);
  });

  it("SHARE02：完整验证 artifact upload、confirm 与匿名 preview", async () => {
    const apiClient = new ConversationShareMockApiClient({ now: () => 10_000 });
    const client = createClient(apiClient);
    const bytes = new TextEncoder().encode("<h1>report</h1>");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const descriptor: ConversationShareArtifactDescriptor = {
      artifact_id: "share-artifact-1",
      logical_artifact_key: "share-artifact-key-1",
      producer_product_turn_id: "share-product-turn-1",
      artifact_version: 1,
      state: "current",
      ref: "zcode-artifact://share/share-artifact-1",
      artifact_type: "html",
      display_name: "report.html",
      extension: "html",
      mime_type: "text/html",
      size_bytes: bytes.byteLength,
      sha256,
    };
    const baseRows = makeConfirmRequest().projection.rows;
    const confirmRequest = makeConfirmRequest(
      [
        ...baseRows,
        {
          rowId: 3,
          turnId: "share-turn-1",
          productTurnId: "share-product-turn-1",
          createdAt: 1_020,
          createdAtSeq: 3,
          kind: "artifact",
          artifactVersionId: descriptor.artifact_id,
          logicalArtifactKey: descriptor.logical_artifact_key,
          displayName: descriptor.display_name,
          artifactType: descriptor.artifact_type,
          mimeType: descriptor.mime_type,
          sizeBytes: descriptor.size_bytes,
          sha256,
          ref: descriptor.ref,
          state: "current",
        },
      ],
      [descriptor],
    );
    const preparation = await client.createPreparation({
      client_request_id: "artifact-publish-request",
      title: "含结果物分享",
      schema_version: 1,
      access_mode: "public_importable",
      payload_sha256: sha256ConversationShareJson(confirmRequest),
      artifact_count: 1,
    });

    await client.uploadArtifact(
      preparation.preparation_id,
      descriptor,
      new Blob([bytes], { type: descriptor.mime_type }),
    );
    const share = await client.confirm(preparation.preparation_id, confirmRequest);
    const preview = await createClient(apiClient, null).getPreview(share.share_code);

    expect(preview.rows.at(-1)).toMatchObject({
      kind: "artifact",
      artifactVersionId: "share-artifact-1",
    });
    expect(preview.artifacts).toEqual([
      expect.objectContaining({
        ...descriptor,
        url: expect.stringContaining("/artifacts/share-artifact-1"),
      }),
    ]);
  });

  it("runs the real client through publish, preview and continuation", async () => {
    const apiClient = new ConversationShareMockApiClient({
      now: () => 10_000,
      authenticatedToken: "owner-token",
      shareBaseUrl: "https://zcode.z.ai/cn/share",
    });
    const { client, share } = await publish(apiClient, "public_importable");

    const preview = await createClient(apiClient, null).getPreview(share.share_code);
    const continuation = await client.getContinuation(share.share_code, {
      schema_version: 1,
      client_request_id: "import-request-1",
    });

    expect(share.share_url).toBe(`https://zcode.z.ai/cn/share/${share.share_code}`);
    expect(preview.rows).toHaveLength(2);
    expect(preview.artifacts).toEqual([]);
    expect(continuation.rows).toEqual(preview.rows);
    expect(continuation.import_grant_id).toBeTruthy();
    expect(Object.keys(preview.integrity).sort()).toEqual([
      "artifact_set_sha256",
      "projection_sha256",
    ]);
    expect(Object.keys(continuation.integrity).sort()).toEqual([
      "artifact_set_sha256",
      "projection_sha256",
    ]);
  });

  it("returns the same preparation and confirmed share for an idempotent request", async () => {
    const apiClient = new ConversationShareMockApiClient({ now: () => 10_000 });
    const { client, confirmRequest, preparation, share } = await publish(apiClient, "private");

    const repeated = await client.createPreparation({
      client_request_id: "publish-request-1",
      title: "分享标题",
      schema_version: 1,
      access_mode: "private",
      payload_sha256: sha256ConversationShareJson(confirmRequest),
      artifact_count: 0,
    });

    expect(repeated).toEqual({
      preparation_id: preparation.preparation_id,
      status: "confirmed",
      access_mode: "private",
      expires_at: expect.any(Number),
      share,
    });
  });

  it("returns pending for the configured confirm attempts and then publishes", async () => {
    const apiClient = new ConversationShareMockApiClient({
      now: () => 10_000,
      confirmSafetyCheckPendingAttempts: 2,
    });
    const client = createClient(apiClient);
    const confirmRequest = makeConfirmRequest();
    const preparation = await client.createPreparation({
      client_request_id: "publish-request-1",
      title: "分享标题",
      schema_version: 1,
      access_mode: "private",
      payload_sha256: sha256ConversationShareJson(confirmRequest),
      artifact_count: 0,
    });

    await expect(client.confirm(preparation.preparation_id, confirmRequest)).rejects.toMatchObject({
      kind: "safety_check_pending",
      status: 409,
      code: 3215,
    });
    await expect(client.confirm(preparation.preparation_id, confirmRequest)).rejects.toMatchObject({
      kind: "safety_check_pending",
    });
    await expect(client.confirm(preparation.preparation_id, confirmRequest)).resolves.toMatchObject(
      {
        share_code: expect.any(String),
      },
    );
  });

  it("rejects the legacy confirm payload hash as an unknown field", async () => {
    const apiClient = new ConversationShareMockApiClient({ now: () => 10_000 });
    const client = createClient(apiClient);
    const confirmRequest = makeConfirmRequest();
    const preparation = await client.createPreparation({
      client_request_id: "publish-request-1",
      title: "分享标题",
      schema_version: 1,
      access_mode: "private",
      payload_sha256: sha256ConversationShareJson(confirmRequest),
      artifact_count: 0,
    });

    const response = await apiClient.request(
      `https://api.example.com/api/v1/shares/preparations/${preparation.preparation_id}/confirm`,
      {
        method: "POST",
        headers: { Authorization: "Bearer owner-token" },
        body: JSON.stringify({
          ...confirmRequest,
          integrity: {
            ...confirmRequest.integrity,
            payload_sha256: "a".repeat(64),
          },
        }),
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 3001 });
  });

  it("hides private previews from non-owners", async () => {
    const apiClient = new ConversationShareMockApiClient({
      now: () => 10_000,
      authenticatedToken: "owner-token",
    });
    const { share } = await publish(apiClient, "private");

    await expect(
      createClient(apiClient, "other-token").getPreview(share.share_code),
    ).rejects.toMatchObject({
      kind: "not_found",
      status: 404,
      code: 3211,
    });
  });

  it("rejects continuation for public_readonly shares", async () => {
    const apiClient = new ConversationShareMockApiClient({ now: () => 10_000 });
    const { client, share } = await publish(apiClient, "public_readonly");

    await expect(
      client.getContinuation(share.share_code, {
        schema_version: 1,
        client_request_id: "import-request-1",
      }),
    ).rejects.toMatchObject({
      kind: "import_not_allowed",
      status: 403,
      code: 3214,
    });
  });

  it("expires previews after the configured TTL", async () => {
    let now = 10_000;
    const apiClient = new ConversationShareMockApiClient({
      now: () => now,
      ttlMs: 1_000,
    });
    const { share } = await publish(apiClient, "public_readonly");
    now = 11_001;

    await expect(createClient(apiClient, null).getPreview(share.share_code)).rejects.toMatchObject({
      kind: "expired",
      status: 410,
      code: 3212,
    });
  });

  it("injects route errors without changing the real client", async () => {
    const apiClient = new ConversationShareMockApiClient({
      scenario: {
        capabilities: { status: 429, code: 3002, msg: "too many requests" },
      },
    });

    await expect(createClient(apiClient).getCapabilities()).rejects.toMatchObject({
      kind: "rate_limited",
      status: 429,
      code: 3002,
    });
  });

  it("validates multipart size and SHA-256", async () => {
    const apiClient = new ConversationShareMockApiClient({ now: () => 10_000 });
    const client = createClient(apiClient);
    const confirmRequest = makeConfirmRequest();
    const preparation = await client.createPreparation({
      client_request_id: "publish-request-1",
      title: "分享标题",
      schema_version: 1,
      access_mode: "private",
      payload_sha256: sha256ConversationShareJson(confirmRequest),
      artifact_count: 1,
    });

    await expect(
      client.uploadArtifact(
        preparation.preparation_id,
        {
          artifact_id: "artifact-1",
          logical_artifact_key: "report",
          producer_product_turn_id: "product-turn-1",
          artifact_version: 1,
          state: "current",
          ref: "zcode-artifact://share/artifact-1",
          artifact_type: "html",
          display_name: "report.html",
          extension: "html",
          mime_type: "text/html",
          size_bytes: 3,
          sha256: "0".repeat(64),
        },
        new Blob(["abc"], { type: "text/html" }),
      ),
    ).rejects.toMatchObject({
      kind: "invalid_conversation",
      status: 422,
      code: 3205,
    });
  });

  it.each([
    {
      label: "completed subagent detail",
      createRows: () => {
        const base = makeConfirmRequest().projection.rows;
        return [
          ...base,
          {
            rowId: 3,
            turnId: "share-turn-1",
            entityId: "share-entity-1",
            productTurnId: "share-product-turn-1",
            createdAt: 1_020,
            createdAtSeq: 3,
            kind: "subagent" as const,
            parentToolCallId: "share-tool-call-1",
            subagentType: "research",
            status: "success" as const,
            summaryText: "研究完成",
          },
        ];
      },
    },
    {
      label: "local row actions",
      createRows: () => {
        const base = makeConfirmRequest().projection.rows;
        return [{ ...base[0]!, actions: { canFork: true as const } }, base[1]!];
      },
    },
  ])("rejects $label with backend-compatible 3205", async ({ createRows }) => {
    const apiClient = new ConversationShareMockApiClient({ now: () => 10_000 });
    const client = createClient(apiClient);
    const invalidConfirm = makeConfirmRequest(createRows());
    const preparation = await client.createPreparation({
      client_request_id: "publish-request-1",
      title: "分享标题",
      schema_version: 1,
      access_mode: "private",
      payload_sha256: sha256ConversationShareJson(invalidConfirm),
      artifact_count: 0,
    });

    await expect(client.confirm(preparation.preparation_id, invalidConfirm)).rejects.toMatchObject({
      kind: "invalid_conversation",
      status: 422,
      code: 3205,
    });
  });
});
