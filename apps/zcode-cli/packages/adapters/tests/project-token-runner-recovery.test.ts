import { describe, expect, it, vi } from "vitest";
import { APICallError } from "@ai-sdk/provider";
import { runWithModelInvocationContext } from "@zcode/contracts";
import { projectAccessTokenFingerprint } from "@zcode/shared";
import { TestAiSdkModelAdapter, TestProviderConfigFixture } from "./test-provider-config.js";

const scope = "a".repeat(64);
const unauthorized = () =>
  new APICallError({
    message: "Unauthorized",
    statusCode: 401,
    url: "https://model.test",
    requestBodyValues: {},
  });
const complete = {
  text: "ok",
  finishReason: "stop",
  usage: { inputTokens: 1, outputTokens: 1 },
  totalUsage: { inputTokens: 1, outputTokens: 1 },
};
function fixture({
  alwaysFail = false,
  committed = false,
  toolOutput = false,
  chunkError = false,
  refreshFails = false,
} = {}) {
  let attempts = 0;
  const seen: string[] = [];
  const adapter = new TestAiSdkModelAdapter({
    registry: new TestProviderConfigFixture({
      providers: {
        idle: { kind: "anthropic", accountMode: "off-peak", baseURL: "https://model.test" },
      },
    }),
    retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitter: false },
    runtime: {
      async generateText(options) {
        attempts++;
        seen.push(new Headers(options.headers).get("X-Coding-Plan-Api-Key")!);
        if (alwaysFail || attempts === 1) throw unauthorized();
        return complete as never;
      },
      streamText(options) {
        attempts++;
        seen.push(new Headers(options.headers).get("X-Coding-Plan-Api-Key")!);
        return {
          fullStream: (async function* () {
            yield { type: "start" };
            if (toolOutput) {
              yield { type: "tool-input-start", id: "call", toolName: "Read" };
              yield { type: "tool-input-delta", id: "call", delta: "{}" };
              yield { type: "tool-input-end", id: "call" };
              yield { type: "tool-call", toolCallId: "call", toolName: "Read", input: "{}" };
            }
            if (committed) {
              yield { type: "text-start", id: "text" };
              yield { type: "text-delta", id: "text", text: "already visible" };
            }
            if (alwaysFail || attempts === 1) {
              if (chunkError) {
                yield { type: "error", error: unauthorized() };
                return;
              }
              throw unauthorized();
            }
            yield { type: "text-start", id: "text" };
            yield { type: "text-delta", id: "text", text: "ok" };
            yield { type: "text-end", id: "text" };
            yield {
              type: "finish",
              finishReason: "stop",
              totalUsage: { inputTokens: 1, outputTokens: 1 },
            };
          })(),
        } as never;
      },
    },
  });
  const auth = {
    apiKey: "jwt",
    accountScope: scope,
    headers: {
      Authorization: "Bearer jwt",
      "X-Coding-Plan-Api-Key": "initial",
      "X-Off-Peak-Ticket-ID": "ticket",
    },
  };
  const model = adapter.createModel({
    providerId: "idle",
    modelId: "glm",
    accountMode: "off-peak",
    requestDependencies: { requestAuth: { source: { resolve: async () => auth } } },
  });
  const refresh = vi.fn(async (input) => {
    if (input.rejectedProjectTokenFingerprint && refreshFails) throw new Error("issue failed");
    return {
      headersApplied: true,
      requestAuth: {
        apiKey: input.rejectedProjectTokenFingerprint ? "pat-2" : "pat-1",
        accountScope: scope,
      },
    };
  });
  const events: unknown[] = [];
  const run = (stream: boolean) =>
    runWithModelInvocationContext({ refreshRuntimeHeadersBeforeAttempt: refresh }, async () => {
      const request = { messages: [{ role: "user", content: "hello" }] } as const;
      if (!stream) return model.generateText(request as never);
      for await (const event of model.streamText(request as never)) events.push(event);
    });
  return { run, refresh, seen, events, attempts: () => attempts };
}

describe("真实 runner 的 PAT 401 恢复", () => {
  it.each([false, true])("stream=%s 无输出 401 换 PAT 后重试，即使普通预算为 1", async (stream) => {
    const f = fixture();
    await f.run(stream);
    expect(f.seen).toEqual(["pat-1", "pat-2"]);
    expect(f.refresh.mock.calls[1]?.[0]).toMatchObject({
      expectedAccountScope: scope,
      rejectedProjectTokenFingerprint: await projectAccessTokenFingerprint("pat-1"),
    });
  });
  it.each([false, true])("stream=%s 二次 401 终止", async (stream) => {
    const f = fixture({ alwaysFail: true });
    await expect(f.run(stream)).rejects.toThrow();
    expect(f.attempts()).toBe(2);
  });
  it("换证失败不发第二次模型请求", async () => {
    const f = fixture({ refreshFails: true });
    await expect(f.run(false)).rejects.toThrow();
    expect(f.attempts()).toBe(1);
  });
  it("已输出工具调用后不因 401 重放", async () => {
    const f = fixture({ toolOutput: true });
    await expect(f.run(true)).rejects.toThrow();
    expect(f.attempts()).toBe(1);
    expect(f.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "tool_call" })]),
    );
  });
  it("SSE 首个错误块也进入一次恢复", async () => {
    const f = fixture({ chunkError: true });
    await f.run(true);
    expect(f.seen).toEqual(["pat-1", "pat-2"]);
  });
  it.each([false, true])("已输出文本后不因 401 重放（错误块=%s）", async (chunkError) => {
    const f = fixture({ committed: true, chunkError });
    await expect(f.run(true)).rejects.toThrow();
    expect(f.attempts()).toBe(1);
  });
});
