import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConversationSharePreviewClient,
  buildShareImportDeepLink,
  parseConversationShareRoute,
} from "../src/share/conversationSharePreviewClient.js";

const preview = {
  schema_version: 1 as const,
  share: {
    title: "Share",
    access_mode: "public_importable" as const,
    created_at: 1_000,
    expires_at: 2_000,
  },
  rows: [],
  artifacts: [],
  integrity: { projection_sha256: "a".repeat(64), artifact_set_sha256: "b".repeat(64) },
};

// 客户端在 wire 形状之外附带逐行降级的结果：认不出的行数交给 UI 出软提示。
const decodedPreview = { ...preview, unsupportedRowCount: 0 };

describe("conversation share preview client", () => {
  it.each([
    [429, "<html>limit</html>", "rate_limited"],
    [403, "", "not_found"],
    [403, "<html>forbidden</html>", "not_found"],
    [400, "<html>bad request</html>", "unknown"],
    [400, JSON.stringify({ message: "bad request" }), "unknown"],
    [502, "<html>gateway</html>", "service_unavailable"],
    [503, "", "service_unavailable"],
    [
      500,
      JSON.stringify({ code: 2001, msg: "database error", logid: "web-log-id" }),
      "service_unavailable",
    ],
    [404, JSON.stringify({ code: 3200, msg: "disabled" }), "feature_disabled"],
  ])("classifies HTTP %s without blaming the content", async (status, body, kind) => {
    const client = new ConversationSharePreviewClient({
      baseUrl: "https://api.example.com",
      fetchImpl: vi.fn(async () => new Response(body, { status })),
    });
    await expect(client.getPreview("share-1")).rejects.toMatchObject({ kind, status });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses both /cn/share/<code> (zh) and /share/<code> (en) routes", () => {
    expect(parseConversationShareRoute("/cn/share/share-1")).toBe("share-1");
    expect(parseConversationShareRoute("/cn/share/share-1/")).toBe("share-1");
    expect(parseConversationShareRoute("/share/share-1")).toBe("share-1");
    expect(parseConversationShareRoute("/share/share-1/")).toBe("share-1");
    expect(parseConversationShareRoute("/cn/share")).toBeNull();
    expect(parseConversationShareRoute("/share")).toBeNull();
    expect(parseConversationShareRoute("/cn/share/a%2Fb")).toBeNull();
    expect(parseConversationShareRoute("/share/a%2Fb")).toBeNull();
    expect(parseConversationShareRoute("/remote/v4")).toBeNull();
  });

  it("builds a Deep Link containing only the share code", () => {
    expect(buildShareImportDeepLink("share-1")).toBe("zcode://share/import?code=share-1");
    expect(() => buildShareImportDeepLink("share/1")).toThrow();
  });

  it("does not send Authorization for the anonymous preview request", async () => {
    const diagnostics = { info: vi.fn(), warn: vi.fn() };
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://zcode.z.ai/api/v1/shares/share-1/preview");
      expect(init?.headers).toBeUndefined();
      return new Response(JSON.stringify({ code: 0, msg: "", data: preview }), { status: 200 });
    });
    const client = new ConversationSharePreviewClient({
      baseUrl: "https://zcode.z.ai/api/v1",
      fetchImpl,
      diagnostics,
    });
    await expect(client.getPreview("share-1")).resolves.toEqual(decodedPreview);
    expect(diagnostics.info).toHaveBeenCalledWith(
      "preview_request_started",
      expect.objectContaining({
        requestTarget: "https://zcode.z.ai/api/v1/shares/<redacted>/preview",
        authenticated: false,
        shareCodeLength: 7,
      }),
    );
    expect(diagnostics.info).toHaveBeenCalledWith(
      "preview_response_received",
      expect.objectContaining({ status: 200, ok: true }),
    );
    expect(JSON.stringify(diagnostics.info.mock.calls)).not.toContain("share-1");
  });

  it("logs a safe diagnostic when fetch rejects before an HTTP response", async () => {
    const diagnostics = { info: vi.fn(), warn: vi.fn() };
    const client = new ConversationSharePreviewClient({
      baseUrl: "https://zcode.z.ai/api/v1",
      fetchImpl: vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
      diagnostics,
    });

    await expect(client.getPreview("share-1")).rejects.toMatchObject({ kind: "network" });
    expect(diagnostics.warn).toHaveBeenCalledWith("preview_request_failed", {
      requestTarget: "https://zcode.z.ai/api/v1/shares/<redacted>/preview",
      authenticated: false,
      errorName: "TypeError",
      errorMessage: "Failed to fetch",
    });
    expect(JSON.stringify(diagnostics.warn.mock.calls)).not.toContain("share-1");
  });

  it("keeps the browser global as this when using the default fetch", async () => {
    const diagnostics = { info: vi.fn(), warn: vi.fn() };
    const brandCheckedFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(
        new Response(JSON.stringify({ code: 0, msg: "", data: preview }), { status: 200 }),
      );
    });
    vi.stubGlobal("fetch", brandCheckedFetch);
    const client = new ConversationSharePreviewClient({
      baseUrl: "https://zcode.z.ai/api/v1",
      diagnostics,
    });

    await expect(client.getPreview("share-1")).resolves.toEqual(decodedPreview);
    expect(brandCheckedFetch).toHaveBeenCalledOnce();
  });

  it("retries private preview with a token and maps hidden shares", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 3211, msg: "not found" }), { status: 404 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            msg: "",
            data: { ...preview, share: { ...preview.share, access_mode: "private" } },
          }),
          { status: 200 },
        ),
      );
    const client = new ConversationSharePreviewClient({
      baseUrl: "https://zcode.z.ai/api/v1",
      fetchImpl,
    });
    await expect(client.getPreview("share-1")).rejects.toMatchObject({ kind: "not_found" });
    await expect(client.getPreview("share-1", "jwt-1")).resolves.toMatchObject({
      share: { access_mode: "private" },
    });
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer jwt-1" },
    });
  });

  it("maps an empty 401 response to authentication_required", async () => {
    const client = new ConversationSharePreviewClient({
      baseUrl: "https://zcode.z.ai/api/v1",
      fetchImpl: vi.fn(async () => new Response("", { status: 401 })),
    });
    await expect(client.getPreview("share-1")).rejects.toMatchObject({
      kind: "authentication_required",
      status: 401,
    });
  });

  it("retains unknown server codes and logid for support", async () => {
    const client = new ConversationSharePreviewClient({
      baseUrl: "https://api.example.com",
      fetchImpl: vi.fn(
        async () =>
          new Response(
            JSON.stringify({ code: 9999, msg: "server text", logid: "web-request-id" }),
            { status: 500 },
          ),
      ),
    });
    await expect(client.getPreview("share-1")).rejects.toMatchObject({
      kind: "service_unavailable",
      code: 9999,
      requestId: "web-request-id",
    });
  });

  // 落地页镜像独立部署、独立回滚，所以随时可能比发布分享的客户端旧。
  it("载荷版本比本 build 新时报 unsupported_schema_version，不报「格式无效」", async () => {
    const client = new ConversationSharePreviewClient({
      baseUrl: "https://zcode.z.ai/api/v1",
      fetchImpl: vi.fn(
        async () =>
          new Response(
            JSON.stringify({ code: 0, msg: "", data: { ...preview, schema_version: 2 } }),
            { status: 200 },
          ),
      ),
    });
    await expect(client.getPreview("share-1")).rejects.toMatchObject({
      kind: "unsupported_schema_version",
    });
  });

  it("认不出的行只被跳过并计数，整页照常渲染", async () => {
    const knownRow = {
      rowId: 1,
      turnId: "turn-1",
      createdAt: 1,
      createdAtSeq: 1,
      kind: "assistantText",
      text: "hi",
      state: "complete",
    };
    const client = new ConversationSharePreviewClient({
      baseUrl: "https://zcode.z.ai/api/v1",
      fetchImpl: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: 0,
              msg: "",
              data: {
                ...preview,
                rows: [knownRow, { ...knownRow, rowId: 2, kind: "videoClipAddedLater" }],
              },
            }),
            { status: 200 },
          ),
      ),
    });
    const loaded = await client.getPreview("share-1");
    expect(loaded.rows).toHaveLength(1);
    expect(loaded.unsupportedRowCount).toBe(1);
  });
});
