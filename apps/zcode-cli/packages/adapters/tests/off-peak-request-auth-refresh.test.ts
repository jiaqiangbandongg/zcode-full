import { describe, expect, it, vi } from "vitest";
import { refreshOffPeakRequestAuth } from "../src/model/off-peak-request-auth.js";
const scope = "a".repeat(64);
const auth = {
  apiKey: "zcode-jwt",
  accountScope: scope,
  apiKeyId: "old-key-id",
  headers: {
    Authorization: "Bearer zcode-jwt",
    "X-Coding-Plan-Api-Key": "old-pat",
    "X-Off-Peak-Ticket-ID": "ticket",
    "bigmodel-project": "project",
  },
};
const input = { providerId: "account:bigmodel-off-peak", modelId: "glm", attempt: 1 };
const accountAccess = { type: "zhipu-account", accountType: "bigmodel", mode: "off-peak" } as const;

describe("闲时每次模型请求刷新 PAT", () => {
  it("每次都向 owner 解析，更新 PAT 且保持票据和本轮身份头", async () => {
    let generation = 0;
    const refresh = vi.fn(async () => ({
      headersApplied: true,
      requestAuth: {
        apiKey: `pat-${++generation}`,
        apiKeyId: `key-id-${generation}`,
        accountScope: scope,
      },
    }));
    for (const attempt of [1, 2]) {
      const result = await refreshOffPeakRequestAuth({
        auth,
        input: { ...input, attempt },
        accountAccess,
        refresh,
      });
      expect(result).toEqual({
        ...auth,
        apiKeyId: `key-id-${attempt}`,
        headers: { ...auth.headers, "X-Coding-Plan-Api-Key": `pat-${attempt}` },
      });
    }
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh.mock.calls[0]?.[0]).toMatchObject({
      expectedAccountScope: scope,
      accountAccess,
    });
  });
  it("owner 缺失或拒绝刷新不得沿用静态 PAT", async () => {
    await expect(refreshOffPeakRequestAuth({ auth, input, accountAccess })).rejects.toThrow();
    await expect(
      refreshOffPeakRequestAuth({
        auth,
        input,
        accountAccess,
        refresh: async () => {
          throw new Error("scope changed");
        },
      }),
    ).rejects.toThrow("scope changed");
    await expect(
      refreshOffPeakRequestAuth({
        auth,
        input,
        accountAccess,
        refresh: async () => ({
          headersApplied: true,
          requestAuth: { apiKey: "other-pat", accountScope: "b".repeat(64) },
        }),
      }),
    ).rejects.toThrow();
  });
  it("保留无真实 Token 的 mock 静态注入", async () => {
    const refresh = vi.fn();
    const mock = { apiKey: "mock", headers: { "X-Coding-Plan-Api-Key": "mock" } };
    expect(await refreshOffPeakRequestAuth({ auth: mock, input, accountAccess, refresh })).toBe(
      mock,
    );
    expect(refresh).not.toHaveBeenCalled();
  });
});

it("真实 runner 同一个闲时 Model 连续请求也向 owner 刷新，不只首次派发刷新", async () => {
  const { runWithModelInvocationContext } = await import("@zcode/contracts");
  const { TestAiSdkModelAdapter, TestProviderConfigFixture } =
    await import("./test-provider-config.js");
  const seen: string[] = [];
  const adapter = new TestAiSdkModelAdapter({
    registry: new TestProviderConfigFixture({
      providers: {
        idle: {
          kind: "anthropic",
          accountMode: "off-peak",
          baseURL: "https://zcode.z.ai/api/v1/off-peak/anthropic",
        },
      },
    }),
    runtime: {
      async generateText(options) {
        seen.push(new Headers(options.headers).get("X-Coding-Plan-Api-Key")!);
        expect(new Headers(options.headers).get("X-Off-Peak-Ticket-ID")).toBe("ticket");
        return {
          text: "ok",
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1 },
          totalUsage: { inputTokens: 1, outputTokens: 1 },
        } as never;
      },
      streamText() {
        throw Error("unused");
      },
    },
  });
  const model = adapter.createModel({
    providerId: "idle",
    modelId: "glm",
    accountMode: "off-peak",
    requestDependencies: { requestAuth: { source: { resolve: async () => auth } } },
  });
  let count = 0;
  const refresh = vi.fn(async (request) => {
    expect(request.expectedAccountScope).toBe(scope);
    expect(request.accountAccess.mode).toBe("off-peak");
    return {
      headersApplied: true,
      requestAuth: { apiKey: `fresh-${++count}`, accountScope: scope },
    };
  });
  for (const _ of [1, 2]) {
    await runWithModelInvocationContext({ refreshRuntimeHeadersBeforeAttempt: refresh }, () =>
      model.generateText({ messages: [{ role: "user", content: "continue" }] }),
    );
  }
  expect(seen).toEqual(["fresh-1", "fresh-2"]);
});
