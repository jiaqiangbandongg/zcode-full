import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHttpClientError,
  type HttpClientPort,
  type HttpClientRunOptions,
  type TraceContext,
  type ExecutionContext,
} from "@zcode/contracts";
import { projectAccessTokenFingerprint } from "@zcode/shared";
import { createCodingPlanApiKeyResolver } from "../src/auth/coding-plan-api-key.js";

afterEach(() => vi.useRealTimers());

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function fixture(family: "bigmodel" | "zai", phase: "metadata" | "pat" | "business", warm = false) {
  const entered = gate();
  const response = gate();
  let held = !warm;
  let failure = false;
  let issues = 0;
  const request = vi.fn(
    async (
      req: { url: string; timeoutMs?: number; trace?: TraceContext },
      options?: HttpClientRunOptions,
    ) => {
      const target =
        phase === "business"
          ? "/api/auth/z/login"
          : phase === "metadata"
            ? "getCustomerInfo"
            : "access_tokens";
      if (held && req.url.endsWith(target)) {
        entered.release();
        await new Promise<void>((resolve, reject) => {
          const cancel = () =>
            reject(createHttpClientError({ code: "cancelled", message: "cancelled" }));
          options?.signal?.addEventListener("abort", cancel, { once: true });
          response.promise.then(() => {
            options?.signal?.removeEventListener("abort", cancel);
            resolve();
          });
          if (options?.signal?.aborted) cancel();
        });
        if (failure) throw createHttpClientError({ code: "network_error", message: "unavailable" });
      }
      let data: unknown;
      if (req.url.endsWith("/api/auth/z/login"))
        data = { access_token: "business-jwt", expires_in: phase === "business" ? 600 : 3600 };
      else if (req.url.endsWith("getCustomerInfo"))
        data = { organizations: [{ organizationId: "org", projects: [{ projectId: "project" }] }] };
      else if (req.url.endsWith("api_keys")) data = [{ apiKey: "key", name: "zcode-api-key" }];
      else {
        issues++;
        data = {
          accessToken: `pat-${issues}`,
          tokenType: "Bearer",
          expiresIn: 600,
          expiresAt: Date.now() / 1000 + 600,
        };
      }
      return { status: 200, body: new TextEncoder().encode(JSON.stringify({ code: 200, data })) };
    },
  );
  const resolver = createCodingPlanApiKeyResolver({
    httpClient: { request } as unknown as HttpClientPort,
  });
  const input = { family, accessToken: "oauth", accountIdentity: "user" };
  return {
    resolver,
    input,
    request,
    entered,
    response,
    hold: () => {
      held = true;
    },
    fail: () => {
      failure = true;
    },
  };
}

describe.each(["resolve", "resolveMaterial"] as const)("%s 独立取消共享换证等待", (method) => {
  it.each([
    ["bigmodel", "metadata", "cold"],
    ["bigmodel", "pat", "cold"],
    ["bigmodel", "pat", "refresh"],
    ["bigmodel", "pat", "rejected"],
    ["zai", "business", "cold"],
    ["zai", "business", "refresh"],
    ["zai", "pat", "refresh"],
  ] as const)("%s %s %s 首个调用方取消不影响后续会话", async (family, phase, mode) => {
    vi.useFakeTimers();
    const f = fixture(family, phase, mode !== "cold");
    if (mode !== "cold") await f.resolver.resolve(f.input);
    if (mode === "refresh") vi.setSystemTime(Date.now() + 481_000);
    f.hold();
    const input = {
      ...f.input,
      ...(mode === "rejected"
        ? { rejectedProjectTokenFingerprint: await projectAccessTokenFingerprint("pat-1") }
        : {}),
    };
    const controller = new AbortController();
    const cleanup = vi.spyOn(controller.signal, "removeEventListener");
    const first = f.resolver[method](input, { signal: controller.signal });
    const cancelled = expect(first).rejects.toMatchObject({ name: "AbortError" });
    await f.entered.promise;
    const second = f.resolver[method](input);
    controller.abort();
    await cancelled;
    expect(cleanup).toHaveBeenCalledWith("abort", expect.any(Function));
    f.response.release();
    const value = await second;
    const token = typeof value === "string" ? value : value.token;
    expect(token).toBe(mode === "cold" ? "pat-1" : "pat-2");
    const requests = f.request.mock.calls.length;
    await expect(f.resolver.resolve(f.input)).resolves.toBe(token);
    expect(f.request).toHaveBeenCalledTimes(requests);
    expect(
      f.request.mock.calls.every(([req, options]) => !options?.signal && req.timeoutMs === 15_000),
    ).toBe(true);
  });

  it("后续等待者取消不影响首个调用方，成功后监听器清理", async () => {
    const f = fixture("bigmodel", "pat");
    const firstController = new AbortController();
    const cleanup = vi.spyOn(firstController.signal, "removeEventListener");
    const first = f.resolver[method](f.input, { signal: firstController.signal });
    await f.entered.promise;
    const nextController = new AbortController();
    const next = f.resolver[method](f.input, { signal: nextController.signal });
    const cancelled = expect(next).rejects.toMatchObject({ name: "AbortError" });
    nextController.abort();
    await cancelled;
    f.response.release();
    await first;
    expect(cleanup).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("提前取消不发起网络请求", async () => {
    const f = fixture("zai", "business");
    const controller = new AbortController();
    controller.abort();
    await expect(
      Promise.resolve().then(() => f.resolver[method](f.input, { signal: controller.signal })),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(f.request).not.toHaveBeenCalled();
  });
});

it("共享请求只保留观测上下文，移除两处调用方取消信号", async () => {
  const f = fixture("bigmodel", "pat");
  const controller = new AbortController();
  const context = {
    trace: { traceId: "test-trace" },
    logger: {},
    abortSignal: controller.signal,
  } as ExecutionContext;
  const pending = f.resolver.resolveMaterial(f.input, { signal: controller.signal, context });
  await f.entered.promise;
  f.response.release();
  await pending;
  for (const [req, options] of f.request.mock.calls) {
    expect(req.trace).toBe(context.trace);
    expect(options?.context?.trace).toBe(context.trace);
    expect(options?.context?.logger).toBe(context.logger);
    expect(options?.signal).toBeUndefined();
    expect(options?.context?.abortSignal).toBeUndefined();
  }
});

it("提前刷新中首个调用方取消后，其他等待者仍可在网络故障时复用有效 PAT", async () => {
  vi.useFakeTimers();
  const f = fixture("bigmodel", "pat", true);
  await f.resolver.resolve(f.input);
  vi.setSystemTime(Date.now() + 481_000);
  f.hold();
  f.fail();
  const controller = new AbortController();
  const first = f.resolver.resolve(f.input, { signal: controller.signal });
  const cancelled = expect(first).rejects.toMatchObject({ name: "AbortError" });
  await f.entered.promise;
  const second = f.resolver.resolve(f.input);
  controller.abort();
  await cancelled;
  f.response.release();
  await expect(second).resolves.toBe("pat-1");
  const count = f.request.mock.calls.length;
  await expect(f.resolver.resolve(f.input)).resolves.toBe("pat-1");
  expect(f.request).toHaveBeenCalledTimes(count);
});

it.each([false, true])(
  "全员取消后共享换证仍可完成，晚到失败不产生未处理拒绝：failure=%s",
  async (failure) => {
    const f = fixture("bigmodel", "pat");
    const controller = new AbortController();
    const pending = f.resolver.resolve(f.input, { signal: controller.signal });
    const cancelled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await f.entered.promise;
    controller.abort();
    await cancelled;
    if (failure) f.fail();
    f.response.release();
    // 让已取消等待对应的 owner 链继续完成/失败；测试框架也会捕获任何未处理拒绝。
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (failure)
      await expect(f.resolver.resolve(f.input)).rejects.toThrow("project_token_request_failed");
    else await expect(f.resolver.resolve(f.input)).resolves.toBe("pat-1");
  },
);

it("调用方取消不阻碍 logout 清理 owner，其他等待者拒绝迟到 Token", async () => {
  const f = fixture("zai", "business");
  const controller = new AbortController();
  const first = f.resolver.resolve(f.input, { signal: controller.signal });
  const cancelled = expect(first).rejects.toMatchObject({ name: "AbortError" });
  await f.entered.promise;
  const second = f.resolver.resolve(f.input);
  const invalidated = expect(second).rejects.toThrow();
  controller.abort();
  await cancelled;
  f.resolver.clear();
  f.response.release();
  await invalidated;
  expect(f.request.mock.calls.every(([req]) => req.url.endsWith("/api/auth/z/login"))).toBe(true);
});
