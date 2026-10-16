import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ApiRequestInit,
  ApiClient,
  FeedbackDeviceInfo,
  FeedbackTicketSeverity,
  FeedbackTicketType,
} from "@zcode/shared";
import type { ICredentialService } from "../src/credential/credential.js";
import { FeedbackHttpClient } from "../src/feedback/feedbackHttpClient.js";
import { createFeedbackService } from "../src/feedback/feedbackService.js";
import type { IOAuthService } from "../src/oauth/oauth.js";
import { setDataBaseDir } from "../src/paths.js";
import type { ServiceLogger } from "../src/logger/serviceLogger.js";
import { createNodeApiClient } from "#src/providers/api/nodeApiClient.js";

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ONE_GIB_BYTES = 1024 * 1024 * 1024;

async function startTestServer(
  handler: Parameters<typeof createServer>[0],
): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not bind to a TCP port");
  }
  return { server, port: address.port };
}

async function closeTestServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function epochSeconds(year: number, month: number, day: number, hour = 0): number {
  return Math.floor(Date.UTC(year, month - 1, day, hour, 0, 0) / 1000);
}

function makeCredentialService(
  loadValue: (key: string) => string | null = () => null,
): ICredentialService {
  return {
    load: vi.fn(async (key: string) => loadValue(key)),
    save: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  };
}

function makeOAuthService(): IOAuthService {
  return {
    getProviders: vi.fn(async () => []),
    getActiveProvider: vi.fn(async () => null),
    restoreCachedSession: vi.fn(async () => null),
    restoreSession: vi.fn(async () => null),
    startOAuth: vi.fn(),
    handleCallback: vi.fn(),
    refreshToken: vi.fn(),
    logout: vi.fn(),
    logoutAll: vi.fn(),
    cancelPending: vi.fn(),
  } as unknown as IOAuthService;
}

function makeFetchApiClient(): ApiClient {
  return {
    request: (input, init) => fetch(input, init),
  };
}

function makeClient(
  baseUrl = "https://zcode.z.ai/api/v1",
  logger?: ServiceLogger,
): FeedbackHttpClient {
  return new FeedbackHttpClient({
    baseUrl,
    apiClient: makeFetchApiClient(),
    getAuthHeaders: async () => ({
      Authorization: "Bearer test-jwt",
      "X-Device-Mid": "desktop-device-mid-test",
    }),
    logger,
  });
}

describe("FeedbackHttpClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends feedback API requests through the injected zcode api client", async () => {
    const createdAt = epochSeconds(2026, 6, 25, 10);
    const apiClient: ApiClient = {
      request: vi.fn(async () => {
        return new Response(
          JSON.stringify({
            code: 0,
            msg: "ok",
            data: {
              ticket_id: "fbk_1",
              device_mid: "desktop-device-mid-test",
              status: "submitted",
              created_at: createdAt,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    };
    const globalFetch = vi.fn(async () => {
      throw new Error("global fetch should not be used for feedback API requests");
    });
    vi.stubGlobal("fetch", globalFetch);

    const client = new FeedbackHttpClient({
      baseUrl: "https://zcode.z.ai/api/v1",
      getAuthHeaders: async () => ({
        Authorization: "Bearer test-jwt",
        "X-Device-Mid": "desktop-device-mid-test",
      }),
      apiClient,
    });

    await expect(
      client.create({
        title: "ticket",
        description: "desc",
        type: "bug",
        severity: "P2-中",
        locale: "en-US",
        device: {
          appVersion: "1.2.3",
          osPlatform: "darwin",
          osVersion: "23.1.0",
        },
      }),
    ).resolves.toMatchObject({ id: "fbk_1" });

    expect(apiClient.request).toHaveBeenCalledTimes(1);
    expect(globalFetch).not.toHaveBeenCalled();
    const [url, init] = vi.mocked(apiClient.request).mock.calls[0];
    expect(String(url)).toBe("https://zcode.z.ai/api/v1/feedback/ticket");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-jwt");
    expect(headers["X-Device-Mid"]).toBe("desktop-device-mid-test");
    expect(headers["Accept-Language"]).toBe("en-US");
    expect(headers["x-request-id"]).toMatch(REQUEST_ID_PATTERN);
  });

  it("creates tickets through the wrapped new feedback API", async () => {
    const createdAt = epochSeconds(2026, 6, 25, 10);
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        title?: string;
        device_mid?: string;
        content?: {
          description?: string;
          category?: FeedbackTicketType;
          function?: string;
          severity?: FeedbackTicketSeverity;
        };
        contact?: string;
        environment?: Record<string, unknown>;
      };

      expect(String(url)).toBe("https://zcode.z.ai/api/v1/feedback/ticket");
      expect(headers.Authorization).toBe("Bearer test-jwt");
      expect(headers["X-Device-Mid"]).toBe("desktop-device-mid-test");
      expect(headers["Accept-Language"]).toBe("en-US");
      expect(headers["x-request-id"]).toMatch(REQUEST_ID_PATTERN);
      expect(body).toMatchObject({
        title: "ticket",
        device_mid: "desktop-device-mid-test",
        content: {
          description: "desc",
          category: "bug",
          severity: "P2-中",
        },
        contact: "me@example.com",
      });
      expect(body).not.toHaveProperty("description");
      expect(body.environment).toMatchObject({
        app_version: "1.2.3",
        platform: "darwin-aarch64",
        os_category: "darwin",
        os_version: "23.1.0",
        build_commit_id: "abc123",
        agent_framework: "zcode-agent",
      });
      expect(body.environment).not.toHaveProperty("module");

      return new Response(
        JSON.stringify({
          code: 0,
          msg: "ok",
          data: {
            ticket_id: "fbk_1",
            device_mid: "desktop-device-mid-test",
            status: "submitted",
            created_at: createdAt,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const device: FeedbackDeviceInfo = {
      appVersion: "1.2.3",
      buildCommitId: "abc123",
      osPlatform: "darwin",
      osVersion: "23.1.0",
      osArch: "arm64",
      agentFramework: "zcode-agent",
    };

    const ticket = await makeClient().create({
      title: "ticket",
      description: "desc",
      type: "bug",
      severity: "P2-中",
      contact: "me@example.com",
      locale: "en-US",
      device,
    });

    expect(ticket).toMatchObject({
      id: "fbk_1",
      title: "ticket",
      type: "bug",
      severity: "P2-中",
      status: "已提交",
      description: "desc",
      device,
      attachments: [],
      comments: [],
      events: [],
    });
    expect(ticket.created_at).toBe(new Date(createdAt * 1000).toISOString());
    expect(ticket.updated_at).toBe(new Date(createdAt * 1000).toISOString());
  });

  it("lists logged-in tickets from the wrapped server response", async () => {
    const createdAt = epochSeconds(2026, 6, 24, 9);
    const updatedAt = epochSeconds(2026, 6, 25, 9);
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: 0,
            msg: "ok",
            data: {
              items: [
                {
                  ticket_id: "fbk_2",
                  device_mid: "fb_device",
                  title: "closed ticket",
                  status: "closed",
                  created_at: createdAt,
                  updated_at: updatedAt,
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(makeClient().list({ mine: true, limit: 50, offset: 10 })).resolves.toEqual({
      total: 1,
      items: [
        {
          id: "fbk_2",
          title: "closed ticket",
          type: "bug",
          status: "已归档",
          created_at: new Date(createdAt * 1000).toISOString(),
          updated_at: new Date(updatedAt * 1000).toISOString(),
        },
      ],
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://zcode.z.ai/api/v1/feedback/ticket?limit=50&offset=10",
    );
  });

  it("passes zero list limit to the feedback API", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: 0,
            msg: "ok",
            data: {
              items: [],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(makeClient().list({ limit: 0 })).resolves.toEqual({
      items: [],
      total: 0,
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://zcode.z.ai/api/v1/feedback/ticket?limit=0",
    );
  });

  it("maps detail messages into comments for the existing UI contract", async () => {
    const createdAt = epochSeconds(2026, 6, 25, 8);
    const messageAt = epochSeconds(2026, 6, 25, 9);
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: 0,
            msg: "ok",
            data: {
              ticket_id: "fbk_3",
              device_mid: "fb_device",
              title: "detail ticket",
              status: "submitted",
              content: {
                description: "detail desc",
                category: "usage",
                function: "Plugin / MCP",
                severity: "P3-低",
              },
              environment: {
                app_version: "1.2.3",
                os_category: "darwin",
                os_version: "23.1.0",
              },
              attachments: [
                {
                  attachment_id: "att_1",
                  file_name: "shot.png",
                  size: 12,
                  created_at: createdAt,
                },
              ],
              messages: [
                {
                  message_id: "msg_1",
                  ticket_id: "fbk_3",
                  sender_type: "user",
                  content: { text: "补充信息" },
                  attachments: [],
                  created_at: messageAt,
                },
              ],
              created_at: createdAt,
              updated_at: messageAt,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const ticket = await makeClient().get("fbk_3");

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://zcode.z.ai/api/v1/feedback/ticket/fbk_3",
    );
    expect(ticket).toMatchObject({
      id: "fbk_3",
      title: "detail ticket",
      type: "usage",
      severity: "P3-低",
      status: "已提交",
      description: "detail desc",
      device: {
        appVersion: "1.2.3",
        osPlatform: "darwin",
        osVersion: "23.1.0",
      },
      attachments: [{ filename: "shot.png", size: 12, kind: "image" }],
      comments: [{ body: "补充信息", is_staff: false }],
    });
  });

  it("posts ticket messages through the new message API", async () => {
    const createdAt = epochSeconds(2026, 6, 25, 11);
    const logger: ServiceLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        content?: { text?: string };
      };
      expect(String(url)).toBe("https://zcode.z.ai/api/v1/feedback/ticket/fbk_4/message");
      expect(body).toEqual({ content: { text: "追加说明" } });
      return new Response(
        JSON.stringify({
          code: 0,
          msg: "ok",
          data: {
            message_id: "msg_2",
            ticket_id: "fbk_4",
            sender_type: "user",
            content: { text: "追加说明" },
            attachments: [],
            created_at: createdAt,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(makeClient(undefined, logger).comment("fbk_4", "追加说明")).resolves.toMatchObject(
      {
        message_id: "msg_2",
        body: "追加说明",
        is_staff: false,
        created_at: new Date(createdAt * 1000).toISOString(),
      },
    );
    expect(logger.info).toHaveBeenCalledWith(
      undefined,
      "反馈 HTTP 请求开始",
      expect.objectContaining({
        url: "https://zcode.z.ai/api/v1/feedback/ticket/:ticketId/message",
      }),
    );
    expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain("fbk_4");
  });

  it("retries feedback requests when TLS handshake is reset before reaching backend", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(
        new TypeError("fetch failed", {
          cause: Object.assign(
            new Error(
              "Client network socket disconnected before secure TLS connection was established",
            ),
            { code: "ECONNRESET" },
          ),
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 0, msg: "ok", data: { items: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(makeClient().list({ mine: true })).resolves.toEqual({ items: [], total: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries feedback requests through repeated transient connection failures", async () => {
    const timeoutCause = Object.assign(new AggregateError([], "connection attempts timed out"), {
      code: "ETIMEDOUT",
    });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed", { cause: timeoutCause }))
      .mockRejectedValueOnce(new TypeError("fetch failed", { cause: timeoutCause }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 0, msg: "ok", data: { items: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(makeClient().list({ mine: true })).resolves.toEqual({ items: [], total: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries feedback requests when connection attempts time out as an aggregate fetch failure", async () => {
    const timeoutCause = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
    const aggregateCause = new AggregateError([timeoutCause], "connection attempts timed out");
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed", { cause: aggregateCause }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 0, msg: "ok", data: { items: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(makeClient().list({ mine: true })).resolves.toEqual({ items: [], total: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries ticket creation when Undici times out before connecting to the feedback API", async () => {
    const connectTimeoutCause = Object.assign(
      new Error("Connect Timeout Error (attempted address: zcode.z.ai:443, timeout: 10000ms)"),
      {
        name: "ConnectTimeoutError",
        code: "UND_ERR_CONNECT_TIMEOUT",
      },
    );
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed", { cause: connectTimeoutCause }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            msg: "ok",
            data: {
              ticket_id: "fbk_connect_timeout_retry",
              status: "submitted",
              created_at: epochSeconds(2026, 7, 15, 8),
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    const client = new FeedbackHttpClient({
      baseUrl: "https://zcode.z.ai/api/v1",
      apiClient: createNodeApiClient({ fetchImpl: fetchMock as typeof fetch }),
      getAuthHeaders: async () => ({ "X-Device-Mid": "desktop-device-mid-test" }),
    });

    await expect(
      client.create({ title: "连接超时", description: "重试后提交成功", type: "bug" }),
    ).resolves.toMatchObject({ id: "fbk_connect_timeout_retry" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry ticket creation when a reset may have happened after the request was sent", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(
        new TypeError("fetch failed", {
          cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            msg: "ok",
            data: {
              ticket_id: "fbk_duplicate",
              status: "submitted",
              created_at: epochSeconds(2026, 7, 15, 8),
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    const client = new FeedbackHttpClient({
      baseUrl: "https://zcode.z.ai/api/v1",
      apiClient: createNodeApiClient({ fetchImpl: fetchMock as typeof fetch }),
      getAuthHeaders: async () => ({ "X-Device-Mid": "desktop-device-mid-test" }),
    });

    await expect(
      client.create({ title: "连接重置", description: "不能重复创建", type: "bug" }),
    ).rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry ticket creation for a generic ETIMEDOUT after sending the request", async () => {
    const fetchMock = vi.fn().mockRejectedValue(
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("socket timed out while awaiting response"), {
          code: "ETIMEDOUT",
        }),
      }),
    );
    const client = new FeedbackHttpClient({
      baseUrl: "https://zcode.z.ai/api/v1",
      apiClient: createNodeApiClient({ fetchImpl: fetchMock as typeof fetch }),
      getAuthHeaders: async () => ({ "X-Device-Mid": "desktop-device-mid-test" }),
    });

    await expect(
      client.create({ title: "响应超时", description: "不能重复创建", type: "bug" }),
    ).rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports three attempts when an Undici connect timeout remains unavailable", async () => {
    const connectTimeoutCause = Object.assign(new Error("Connect Timeout Error"), {
      name: "ConnectTimeoutError",
      code: "UND_ERR_CONNECT_TIMEOUT",
    });
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new TypeError("fetch failed", { cause: connectTimeoutCause }));
    const logger: ServiceLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const client = new FeedbackHttpClient({
      baseUrl: "https://zcode.z.ai/api/v1",
      apiClient: createNodeApiClient({ fetchImpl: fetchMock as typeof fetch }),
      getAuthHeaders: async () => ({ "X-Device-Mid": "desktop-device-mid-test" }),
      logger,
    });

    await expect(
      client.create({ title: "持续建连超时", description: "三次后失败", type: "bug" }),
    ).rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledWith(
      undefined,
      "反馈 HTTP 请求网络失败",
      expect.objectContaining({
        attemptCount: 3,
        errorCodes: ["UND_ERR_CONNECT_TIMEOUT"],
        url: "https://zcode.z.ai/api/v1/feedback/ticket",
      }),
    );
  });

  it("uploads attachments through upload credentials and OSS form post", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "feedback-http-client-"));
    const filePath = join(tempDir, "shot.png");
    const payload = Buffer.from("image-payload");
    await writeFile(filePath, payload);

    const credentialBodies: unknown[] = [];
    const ossBodies: Buffer[] = [];
    const progressEvents: Array<{ uploadedBytes: number; totalBytes: number }> = [];
    const logger: ServiceLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const server = await startTestServer((request, response) => {
      if (request.url === "/feedback/attachment/upload-credential") {
        void readRequestBody(request).then((body) => {
          credentialBodies.push(JSON.parse(body.toString("utf8")));
          response.setHeader("Content-Type", "application/json");
          response.end(
            JSON.stringify({
              code: 0,
              msg: "ok",
              data: {
                attachment_id: "att_oss",
                max_size: 100 * 1024 * 1024,
                callback: {
                  url: "https://zcode.z.ai/api/v1/feedback/attachment/callback",
                  body: "callback-body",
                  content_type: "application/json",
                },
                oss: {
                  host: `http://127.0.0.1:${server.port}`,
                  path: "feedback/att_oss/shot.png",
                  policy: "policy-value",
                  x_oss_signature: "signature-value",
                  x_oss_signature_version: "OSS4-HMAC-SHA256",
                  x_oss_credential: "credential-value",
                  x_oss_security_token: "security-token",
                  x_oss_date: "20260625T000000Z",
                },
              },
            }),
          );
        });
        return;
      }
      if (request.method === "POST" && request.url === "/") {
        void readRequestBody(request).then((body) => {
          ossBodies.push(body);
          response.statusCode = 204;
          response.end();
        });
        return;
      }
      response.statusCode = 500;
      response.end(`unexpected request: ${request.method ?? "GET"} ${request.url ?? "/"}`);
    });

    try {
      const client = makeClient(`http://127.0.0.1:${server.port}`, logger);
      const attachment = await client.uploadFile(
        "fbk_5",
        "image",
        filePath,
        "shot.png",
        "image/png",
        {
          messageId: "msg_5",
          onUploadProgress: (event) => progressEvents.push(event),
        },
      );

      expect(credentialBodies).toEqual([
        {
          ticket_id: "fbk_5",
          message_id: "msg_5",
          file_name: "shot.png",
          size: payload.byteLength,
        },
      ]);
      expect(logger.info).toHaveBeenCalledWith(
        undefined,
        "反馈 HTTP 请求开始",
        expect.objectContaining({
          url: `http://127.0.0.1:${server.port}/feedback/attachment/upload-credential`,
          body: expect.objectContaining({
            fields: ["file_name", "message_id", "size", "ticket_id"],
            hasTicketId: true,
            hasMessageId: true,
            fileName: { present: true, length: "shot.png".length, extension: ".png" },
            size: payload.byteLength,
          }),
        }),
      );
      expect(ossBodies).toHaveLength(1);
      const multipart = ossBodies[0]!.toString("utf8");
      expect(multipart).toContain('name="key"');
      expect(multipart).toContain("feedback/att_oss/shot.png");
      expect(multipart).toContain('name="policy"');
      expect(multipart).toContain("policy-value");
      expect(multipart).toContain('name="callback"');
      // callback should be base64-encoded JSON with callbackUrl, callbackBody, callbackBodyType
      const expectedCallbackJson = JSON.stringify({
        callbackUrl: "https://zcode.z.ai/api/v1/feedback/attachment/callback",
        callbackBody: "callback-body",
        callbackBodyType: "application/json",
      });
      const expectedCallbackBase64 = Buffer.from(expectedCallbackJson, "utf-8").toString("base64");
      expect(multipart).toContain(expectedCallbackBase64);
      expect(multipart).toContain('name="file"; filename="shot.png"');
      expect(multipart).toContain("image-payload");
      expect(progressEvents.at(-1)).toEqual({
        uploadedBytes: payload.byteLength,
        totalBytes: payload.byteLength,
      });
      expect(attachment).toMatchObject({
        kind: "image",
        filename: "shot.png",
        size: payload.byteLength,
        redacted: false,
        content_type: "image/png",
      });
    } finally {
      await closeTestServer(server.server);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("requests upload credentials for log attachments at the 1GB client limit", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "feedback-http-client-"));
    const filePath = join(tempDir, "one-gib.zip");
    await writeFile(filePath, "");
    await truncate(filePath, ONE_GIB_BYTES);
    const apiClient: ApiClient = {
      request: vi.fn(async () => {
        return new Response(
          JSON.stringify({
            code: 0,
            msg: "ok",
            data: {
              attachment_id: "att_one_gib",
              max_size: ONE_GIB_BYTES - 1,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    };
    const client = new FeedbackHttpClient({
      baseUrl: "https://zcode.z.ai/api/v1",
      apiClient,
      getAuthHeaders: async () => ({
        Authorization: "Bearer test-jwt",
        "X-Device-Mid": "desktop-device-mid-test",
      }),
    });

    try {
      await expect(
        client.uploadFile("fbk_large", "log", filePath, "one-gib.zip", "application/zip"),
      ).rejects.toThrow(`Feedback attachment exceeds max size ${ONE_GIB_BYTES - 1}`);
      expect(apiClient.request).toHaveBeenCalledTimes(1);
      expect(apiClient.request).toHaveBeenCalledWith(
        "https://zcode.z.ai/api/v1/feedback/attachment/upload-credential",
        expect.objectContaining({
          body: JSON.stringify({
            ticket_id: "fbk_large",
            file_name: "one-gib.zip",
            size: ONE_GIB_BYTES,
          }),
        }),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects log attachments over 1GB before requesting upload credentials", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "feedback-http-client-"));
    const filePath = join(tempDir, "too-large.zip");
    await writeFile(filePath, "");
    await truncate(filePath, ONE_GIB_BYTES + 1);
    const apiClient: ApiClient = {
      request: vi.fn(async () => {
        throw new Error("upload credential should not be requested");
      }),
    };
    const client = new FeedbackHttpClient({
      baseUrl: "https://zcode.z.ai/api/v1",
      apiClient,
      getAuthHeaders: async () => ({
        Authorization: "Bearer test-jwt",
        "X-Device-Mid": "desktop-device-mid-test",
      }),
    });

    try {
      await expect(
        client.uploadFile("fbk_large", "log", filePath, "too-large.zip", "application/zip"),
      ).rejects.toThrow(`Feedback attachment exceeds max size ${ONE_GIB_BYTES}`);
      expect(apiClient.request).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps non-log feedback attachments capped at 100MB before requesting upload credentials", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "feedback-http-client-"));
    const filePath = join(tempDir, "too-large.png");
    await writeFile(filePath, "");
    await truncate(filePath, 100 * 1024 * 1024 + 1);
    const apiClient: ApiClient = {
      request: vi.fn(async () => {
        throw new Error("upload credential should not be requested");
      }),
    };
    const client = new FeedbackHttpClient({
      baseUrl: "https://zcode.z.ai/api/v1",
      apiClient,
      getAuthHeaders: async () => ({
        Authorization: "Bearer test-jwt",
        "X-Device-Mid": "desktop-device-mid-test",
      }),
    });

    try {
      await expect(
        client.uploadFile("fbk_large", "image", filePath, "too-large.png", "image/png"),
      ).rejects.toThrow("Feedback attachment exceeds max size 104857600");
      expect(apiClient.request).not.toHaveBeenCalled();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("createFeedbackService", () => {
  afterEach(() => {
    setDataBaseDir(null);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("uses the test ZCode API base by default when ZCODE_ENV=test", async () => {
    vi.stubEnv("ZCODE_ENV", "test");
    // Bugfix: 开发机 shell 可能导出 ZCODE_BASE_URL / ZCODE_ENDPOINT_ORIGIN（resolver 最高优先级覆盖），
    // 会压过 ZCODE_ENV=test 的默认域推断，把「默认 base」用例变成环境敏感；置空恢复封闭性。
    vi.stubEnv("ZCODE_BASE_URL", "");
    vi.stubEnv("ZCODE_ENDPOINT_ORIGIN", "");
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      // Bugfix: feedback 默认 base 已收敛到统一 ZCode endpoint resolver；
      // ZCODE_ENV=test 不能继续断言生产域，否则会掩盖测试环境请求边界。
      expect(String(url)).toBe("https://zcode.z.ai/api/v1/feedback/ticket");
      return new Response(JSON.stringify({ code: 0, msg: "ok", data: { items: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const service = createFeedbackService({
      apiClient: makeFetchApiClient(),
      credentialService: makeCredentialService((key) => {
        if (key === "zcodejwttoken") return "shared-backend-jwt";
        return null;
      }),
      oauthService: makeOAuthService(),
    });

    await service.list({ mine: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the production ZCode API base by default when ZCODE_ENV=production", async () => {
    vi.stubEnv("ZCODE_ENV", "production");
    // 同上：屏蔽开发机 ambient 覆盖，保持「默认 base」语义封闭
    vi.stubEnv("ZCODE_BASE_URL", "");
    vi.stubEnv("ZCODE_ENDPOINT_ORIGIN", "");
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe("https://zcode.z.ai/api/v1/feedback/ticket");
      return new Response(JSON.stringify({ code: 0, msg: "ok", data: { items: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const service = createFeedbackService({
      apiClient: makeFetchApiClient(),
      credentialService: makeCredentialService((key) => {
        if (key === "zcodejwttoken") return "shared-backend-jwt";
        return null;
      }),
      oauthService: makeOAuthService(),
    });

    await service.list({ mine: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps explicit feedback API base above environment defaults", async () => {
    vi.stubEnv("ZCODE_ENV", "test");
    vi.stubEnv("ZCODE_FEEDBACK_API_BASE", "https://feedback-override.example.com/api/v1");
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe("https://feedback-override.example.com/api/v1/feedback/ticket");
      return new Response(JSON.stringify({ code: 0, msg: "ok", data: { items: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const service = createFeedbackService({
      apiClient: makeFetchApiClient(),
      credentialService: makeCredentialService((key) => {
        if (key === "zcodejwttoken") return "shared-backend-jwt";
        return null;
      }),
      oauthService: makeOAuthService(),
    });

    await service.list({ mine: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the host device_mid for anonymous tickets and local ticket storage", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "feedback-service-"));
    setDataBaseDir(tempDir);
    const createdAt = epochSeconds(2026, 6, 25, 12);
    const hostDeviceMid = "desktop-device-mid-001";
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        device_mid?: string;
        environment?: Record<string, unknown>;
      };
      expect(headers.Authorization).toBeUndefined();
      expect(headers["X-Device-Mid"]).toBe(hostDeviceMid);
      expect(headers["X-Feedback-Client-Id"]).toBeUndefined();
      expect(body.device_mid).toBe(hostDeviceMid);
      expect(body.environment?.app_version).toEqual(expect.any(String));
      expect(body.environment?.os_version).toBe(release());
      expect(String(body.environment?.os_version ?? "").length).toBeLessThanOrEqual(64);
      return new Response(
        JSON.stringify({
          code: 0,
          msg: "ok",
          data: {
            ticket_id: "fbk_anon",
            device_mid: body.device_mid,
            status: "submitted",
            created_at: createdAt,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const credentialService = makeCredentialService((key) =>
      key === "zcodefeedbackclientid" ? "device_legacy_path_hash" : null,
    );

    try {
      const service = createFeedbackService({
        apiClient: makeFetchApiClient(),
        apiBaseUrl: "https://zcode.z.ai/api/v1",
        getDeviceMid: () => hostDeviceMid,
        credentialService,
        oauthService: makeOAuthService(),
      });

      await service.create({ title: "匿名反馈", description: "desc", type: "bug" });
      const list = await service.list({ mine: true });

      const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
      expect(headers["X-Device-Mid"]).toBe(hostDeviceMid);
      expect(credentialService.save).not.toHaveBeenCalled();
      expect(list.items).toEqual([
        expect.objectContaining({
          id: "fbk_anon",
          title: "匿名反馈",
          type: "bug",
          status: "已提交",
        }),
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses Bearer JWT for logged-in server lists", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "feedback-service-"));
    setDataBaseDir(tempDir);
    const updatedAt = epochSeconds(2026, 6, 25, 13);
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(String(url)).toBe("https://zcode.z.ai/api/v1/feedback/ticket");
      expect(headers.Authorization).toBe("Bearer shared-backend-jwt");
      expect(headers["X-Device-Mid"]).toBe("desktop-device-mid-222");
      expect(headers["X-Feedback-Client-Id"]).toBeUndefined();
      return new Response(
        JSON.stringify({
          code: 0,
          msg: "ok",
          data: {
            items: [
              {
                ticket_id: "fbk_login",
                device_mid: "desktop-device-mid-222",
                title: "登录反馈",
                status: "closed",
                created_at: updatedAt,
                updated_at: updatedAt,
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const service = createFeedbackService({
        apiClient: makeFetchApiClient(),
        apiBaseUrl: "https://zcode.z.ai/api/v1",
        getDeviceMid: () => "desktop-device-mid-222",
        credentialService: makeCredentialService((key) => {
          if (key === "zcodejwttoken") return "shared-backend-jwt";
          return null;
        }),
        oauthService: makeOAuthService(),
      });

      await expect(service.list({ mine: true })).resolves.toEqual({
        total: 1,
        items: [
          expect.objectContaining({
            id: "fbk_login",
            title: "登录反馈",
            status: "已归档",
          }),
        ],
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("can abort an active ticket creation request by operation id", async () => {
    const abortErrors: Error[] = [];
    const apiClient: ApiClient = {
      request: vi.fn(
        async (_url: string | URL, init?: ApiRequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            expect(init?.timeoutMs).toBeGreaterThan(0);
            init?.signal?.addEventListener(
              "abort",
              () => {
                const error = new DOMException("The operation was aborted.", "AbortError");
                abortErrors.push(error);
                reject(error);
              },
              { once: true },
            );
          }),
      ),
    };
    const service = createFeedbackService({
      apiClient,
      apiBaseUrl: "https://zcode.z.ai/api/v1",
      getDeviceMid: () => "desktop-device-mid-cancel",
      credentialService: makeCredentialService(),
      oauthService: makeOAuthService(),
    });

    const createPromise = service.create(
      {
        title: "取消创建",
        description: "desc",
        type: "bug",
      },
      { operationId: "feedback-create-cancel-test" },
    );

    await vi.waitFor(() => {
      expect(apiClient.request).toHaveBeenCalledTimes(1);
    });
    await service.cancelCreate("feedback-create-cancel-test");

    await expect(createPromise).rejects.toThrow("The operation was aborted.");
    expect(abortErrors).toHaveLength(1);
  });
});
