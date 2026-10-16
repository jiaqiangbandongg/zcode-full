import { describe, expect, it, vi } from "vitest";
import { APICallError } from "@ai-sdk/provider";
import { AccountRequestRetry } from "../src/model/account-request-retry.js";
import type { AiSdkModelTextRequest, ResolvedAiSdkModel } from "../src/model/runner-runtime.js";

const scope = "a".repeat(64);
const rejected = new APICallError({
  message: "Unauthorized",
  statusCode: 401,
  url: "https://model.test",
  requestBodyValues: {},
});
function fixture(
  mode = "individual-coding-plan",
  refresh = vi.fn(async () => ({
    headersApplied: true,
    requestAuth: { apiKey: "pat-1", accountScope: scope },
  })),
) {
  const request = {
    refreshRuntimeHeadersBeforeAttempt: refresh,
  } as unknown as AiSdkModelTextRequest;
  const retry = new AccountRequestRetry(request, { accountAccess: { mode } } as ResolvedAiSdkModel);
  const run = () =>
    retry.prepareRequest(request).refreshRuntimeHeadersBeforeAttempt!({
      attempt: 1,
      providerId: "account",
      modelId: "model",
    });
  return { retry, run, refresh, request };
}
describe("PAT 请求一次恢复", () => {
  it("401 后携带原作用域及失败 PAT 指纹，最多一次", async () => {
    const { retry, run, refresh } = fixture();
    await run();
    expect(retry.claim(rejected)).toBe(true);
    expect(retry.extraAttempts).toBe(1);
    await run();
    expect(refresh.mock.calls[1]?.[0]).toMatchObject({
      expectedAccountScope: scope,
      rejectedProjectTokenFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(retry.claim(rejected)).toBe(false);
  });
  it.each(["start-plan", "highspeed"])("%s 不进入 PAT 恢复", async (mode) => {
    const { retry, run } = fixture(mode);
    await run();
    expect(retry.claim(rejected)).toBe(false);
  });
  it("已提交输出、403、未返回 PAT 作用域和取消均不恢复", async () => {
    const { retry, run } = fixture();
    await run();
    expect(retry.claim(rejected, true)).toBe(false);
    expect(
      retry.claim(
        new APICallError({
          message: "Forbidden",
          statusCode: 403,
          url: "https://model.test",
          requestBodyValues: {},
        }),
      ),
    ).toBe(false);
    const manual = fixture(
      "individual-coding-plan",
      vi.fn(async () => ({ headersApplied: true, requestAuth: { apiKey: "manual" } })) as never,
    );
    await manual.run();
    expect(manual.retry.claim(rejected)).toBe(false);
    const cancelled = fixture();
    await cancelled.run();
    const controller = new AbortController();
    cancelled.request.abortSignal = controller.signal;
    controller.abort();
    expect(cancelled.retry.claim(rejected)).toBe(false);
  });
  it("换证响应作用域变化时不发起第二次模型请求", async () => {
    let calls = 0;
    const { retry, run } = fixture(
      "team-coding-plan",
      vi.fn(async () => ({
        headersApplied: true,
        requestAuth: { apiKey: "pat", accountScope: ++calls === 1 ? scope : "b".repeat(64) },
      })),
    );
    await run();
    expect(retry.claim(rejected)).toBe(true);
    await expect(run()).rejects.toThrow("project_token_scope_invalidated");
  });
});
