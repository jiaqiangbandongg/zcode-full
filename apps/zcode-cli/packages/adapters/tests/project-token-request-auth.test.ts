import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { createRegistryProviderConfig, parseProviderConfig } from "@zcode/provider";
import { AiSdkModelExecution } from "../src/model/model-execution.js";

const TOKEN = [
  Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT", sign_type: "SIGN" })).toString(
    "base64url",
  ),
  Buffer.from(JSON.stringify({ token_use: "project_access", sub: "test-account" })).toString(
    "base64url",
  ),
  "synthetic_signature_only_for_test",
].join(".");
const API_TYPES = ["anthropic-messages", "openai-chat-completions", "openai-responses"] as const;
const OPTIONS = { reasoningLevel: "disabled", maxOutputTokens: 64 };
const STATIC_HEADERS = [
  { Authorization: "Bearer old-key", "x-api-key": "old-key" },
  { authorization: "Bearer old-key", "X-API-KEY": "old-key" },
  { AuThOrIzAtIoN: "Bearer old-key", "X-Api-Key": "old-key" },
];

function fixture(
  apiType: (typeof API_TYPES)[number],
  access: Record<string, unknown>,
  headers: Record<string, string>,
) {
  const requests: Request[] = [];
  const execution = new AiSdkModelExecution(
    {
      env: {},
      defaultHeaders: { AUTHORIZATION: "Bearer default-old-key", "X-API-KEY": "default-old-key" },
    },
    {
      transport: async (input, init) => {
        requests.push(new Request(input, init));
        // 捕获真实 SDK 最终请求头；不访问网络，不依赖各协议的成功响应格式。
        return Response.json(
          { error: { type: "invalid_request_error", message: "captured" } },
          { status: 400 },
        );
      },
    },
  );
  const provider = createRegistryProviderConfig(
    parseProviderConfig({
      group: "standard-personal",
      access,
      api: { type: apiType, baseUrl: "https://open.bigmodel.cn/api/anthropic", headers },
    }),
  );
  if (!provider.ok) throw new Error("invalid auth fixture");
  const bound = execution.bindModel({
    providerId: "auth-fixture",
    modelId: "GLM-5.3",
    providerConfig: provider.config,
    supportsJsonSchemaOutput: false,
    optionSpecs: { reasoningLevel: { map: "{}" }, maxOutputTokens: { map: "{}" } },
  });
  return { requests, bound };
}

async function capture(model: Parameters<typeof generateText>[0]["model"]) {
  await expect(generateText({ model, prompt: "test", maxRetries: 0 })).rejects.toThrow();
}

describe.each(API_TYPES)("%s 请求期账号鉴权", (apiType) => {
  it.each(["individual-coding-plan", "team-coding-plan"] as const)(
    "%s 的 PAT 覆盖静态认证头，轮换不修改绑定配置",
    async (mode) => {
      for (const stale of STATIC_HEADERS) {
        const headers = { ...stale, "X-Session-ID": "session", "X-Custom": "keep" };
        const original = { ...headers };
        const { requests, bound } = fixture(
          apiType,
          { type: "zhipu-account", accountType: "bigmodel", mode, entitled: true },
          headers,
        );
        const tokens = [TOKEN, TOKEN.replace("test", "next")];
        for (const apiKey of tokens) {
          await capture(bound.resolveRequest({ options: OPTIONS, requestAuth: { apiKey } }).model);
        }
        expect(requests).toHaveLength(2);
        requests.forEach((request, index) => {
          expect(request.headers.get("authorization")).toBe(`Bearer ${tokens[index]}`);
          expect(request.headers.get("x-api-key")).toBe(
            apiType === "anthropic-messages" ? tokens[index] : null,
          );
          expect(request.headers.get("x-session-id")).toBe("session");
          expect(request.headers.get("x-custom")).toBe("keep");
        });
        expect(headers).toEqual(original);
      }
    },
  );

  it.each(["api-key", "zhipu-coding-plan-api-key"] as const)(
    "%s 保留自定义认证头",
    async (type) => {
      // 使用合法 PAT 形状隔离官方版本请求安全校验的旧路径，access 类型仍是手工 Key。
      const { requests, bound } = fixture(apiType, { type, apiKey: TOKEN }, STATIC_HEADERS[0]!);
      await capture(
        bound.resolveRequest({ options: OPTIONS, requestAuth: { apiKey: TOKEN } }).model,
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]!.headers.get("authorization")).toBe("Bearer old-key");
      expect(requests[0]!.headers.get("x-api-key")).toBe("old-key");
    },
  );
});

describe("账号 owner 的动态身份头", () => {
  it.each(["start-plan", "off-peak", "highspeed"] as const)(
    "%s 保留独立 JWT 和票据头",
    async (mode) => {
      const { requests, bound } = fixture(
        "anthropic-messages",
        { type: "zhipu-account", accountType: "bigmodel", mode, entitled: true },
        STATIC_HEADERS[0]!,
      );
      await capture(
        bound.resolveRequest({
          options: OPTIONS,
          requestAuth: {
            apiKey: "runtime-jwt",
            headers: {
              Authorization: "Bearer owner-jwt",
              "X-API-KEY": "owner-key",
              "X-Off-Peak-Ticket-ID": "ticket",
            },
          },
        }).model,
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]!.headers.get("authorization")).toBe("Bearer owner-jwt");
      expect(requests[0]!.headers.get("x-api-key")).toBe("owner-key");
      expect(requests[0]!.headers.get("x-off-peak-ticket-id")).toBe("ticket");
    },
  );
});
