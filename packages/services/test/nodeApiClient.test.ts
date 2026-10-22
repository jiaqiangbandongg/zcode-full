import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@zcode/shared";
import { createNodeApiClient } from "../src/providers/api/nodeApiClient.js";

describe("nodeApiClient", () => {
  it.each(["bigmodel", "zai"])("%s 空业务响应经身份核验确认失效，保留原响应", async (family) => {
    const original = new Response("");
    const notified = vi.fn();
    const fetchImpl = vi.fn(async (url: string | URL) =>
      String(url).endsWith("/userinfo")
        ? family === "bigmodel"
          ? new Response("")
          : Response.json({ code: 401 })
        : original,
    );
    const options = {
      fetchImpl,
      isZcodeJwtRequest: () => true,
      isBusinessUnauthorizedRequest: () => true,
      resolveBusinessCredentialValidationRequest: async () => ({
        url: "https://identity.example/userinfo",
        authorization: "business-token",
        emptyBodyMeansInvalid: family === "bigmodel",
      }),
      onZcodeJwtInvalid: notified,
    };
    const client = createNodeApiClient(options);
    const response = await client.request("https://business.example/pricing");
    expect(response).toBe(original);
    expect(await response.text()).toBe("");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(notified).toHaveBeenCalledOnce();
  });

  it.each([200, 403])("业务 HTTP %i 异常但身份正常时不登出", async (status) => {
    const notified = vi.fn();
    const client = createNodeApiClient({
      fetchImpl: async (url) =>
        String(url).endsWith("/userinfo")
          ? Response.json({ code: 200, data: { customerNumber: "synthetic" } })
          : new Response("", { status }),
      isZcodeJwtRequest: () => true,
      isBusinessUnauthorizedRequest: () => true,
      resolveBusinessCredentialValidationRequest: async () => ({
        url: "https://identity.example/userinfo",
        authorization: "business-token",
        emptyBodyMeansInvalid: true,
      }),
      onZcodeJwtInvalid: notified,
    });
    await client.request("https://business.example/pricing");
    expect(notified).not.toHaveBeenCalled();
  });

  it.each(["", "<html>blocked</html>", "{", '{"code":500}'])(
    "未确认的 ZAI 身份响应不登出：%s",
    async (body) => {
      const notified = vi.fn();
      const client = createNodeApiClient({
        fetchImpl: async (url) => new Response(String(url).endsWith("/userinfo") ? body : ""),
        isZcodeJwtRequest: () => true,
        isBusinessUnauthorizedRequest: () => true,
        resolveBusinessCredentialValidationRequest: async () => ({
          url: "https://identity.example/userinfo",
          authorization: "business-token",
          emptyBodyMeansInvalid: false,
        }),
        onZcodeJwtInvalid: notified,
      });
      await client.request("https://business.example/pricing");
      expect(notified).not.toHaveBeenCalled();
    },
  );

  it.each(["network", "server"])("BigModel 身份核验 %s 失败时保留登录", async (failure) => {
    const notified = vi.fn();
    const client = createNodeApiClient({
      fetchImpl: async (url) => {
        if (!String(url).endsWith("/userinfo")) return new Response("");
        if (failure === "network") throw new TypeError("offline");
        return Response.json({ code: 401 }, { status: 500 });
      },
      isZcodeJwtRequest: () => true,
      isBusinessUnauthorizedRequest: () => true,
      resolveBusinessCredentialValidationRequest: async () => ({
        url: "https://identity.example/userinfo",
        authorization: "business-token",
        emptyBodyMeansInvalid: true,
      }),
      onZcodeJwtInvalid: notified,
    });
    await client.request("https://business.example/pricing");
    expect(notified).not.toHaveBeenCalled();
  });

  it("当前 BigModel 身份接口空200直接确认，不递归核验", async () => {
    const notified = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(""));
    const client = createNodeApiClient({
      fetchImpl,
      isZcodeJwtRequest: () => true,
      isBusinessUnauthorizedRequest: () => true,
      resolveBusinessCredentialValidationRequest: async () => ({
        url: "https://identity.example/userinfo",
        authorization: "business-token",
        emptyBodyMeansInvalid: true,
      }),
      onZcodeJwtInvalid: notified,
    });
    await client.request("https://identity.example/userinfo");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(notified).toHaveBeenCalledOnce();
  });

  it("并发空业务响应共享一个在途身份核验", async () => {
    let release!: (response: Response) => void;
    const identity = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn(async (url) =>
      String(url).endsWith("/userinfo") ? identity : new Response(""),
    );
    const client = createNodeApiClient({
      fetchImpl,
      isZcodeJwtRequest: () => true,
      isBusinessUnauthorizedRequest: () => true,
      resolveBusinessCredentialValidationRequest: async () => ({
        url: "https://identity.example/userinfo",
        authorization: "business-token",
        emptyBodyMeansInvalid: true,
      }),
      onZcodeJwtInvalid: vi.fn(),
    });
    const requests = [
      client.request("https://business.example/a"),
      client.request("https://business.example/b"),
    ];
    await vi.waitFor(() =>
      expect(
        fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/userinfo")),
      ).toHaveLength(1),
    );
    release(new Response(""));
    await Promise.all(requests);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith("/userinfo"))).toHaveLength(
      1,
    );
  });

  it.each(["abort", "timeout"] as const)(
    "身份核验 fetch 期间 %s 立即收口且不提交迟到失效",
    async (cancellation) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      let identitySignal: AbortSignal | undefined;
      let release!: (response: Response) => void;
      let started!: () => void;
      const identityStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const notified = vi.fn();
      const finalized = vi.fn();
      const client = createNodeApiClient({
        fetchImpl: async (url, init) => {
          if (!String(url).endsWith("/userinfo")) return new Response("", { status: 403 });
          identitySignal = init?.signal ?? undefined;
          started();
          return new Promise<Response>((resolve) => {
            release = resolve;
          });
        },
        isZcodeJwtRequest: () => true,
        isBusinessUnauthorizedRequest: () => true,
        resolveBusinessCredentialValidationRequest: async () => ({
          url: "https://identity.example/userinfo",
          authorization: "business-token",
          emptyBodyMeansInvalid: true,
        }),
        onZcodeJwtInvalid: notified,
      });
      const result = client
        .request("https://business.example/pricing", {
          signal: controller.signal,
          timeoutMs: 50,
        })
        .finally(finalized)
        .catch((error: unknown) => error);
      await identityStarted;
      if (cancellation === "abort") controller.abort();
      else await vi.advanceTimersByTimeAsync(50);
      // 受控 transport 故意忽略 abort：主请求不能等待迟到响应才能执行 finally。
      const error = await result;
      expect(finalized).toHaveBeenCalledOnce();
      expect(error).toBeInstanceOf(ApiError);
      if (!(error instanceof ApiError)) throw error;
      expect(error.message).toBe(
        cancellation === "timeout" ? "Request timed out after 50ms" : "The operation was aborted.",
      );
      expect(identitySignal?.aborted).toBe(true);
      release(new Response("", { status: 401 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(notified).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["business", "identity"] as const)(
    "%s 响应副本读取期间取消会立即收口并取消观察副本",
    async (phase) => {
      const controller = new AbortController();
      let reading!: () => void;
      const readStarted = new Promise<void>((resolve) => {
        reading = resolve;
      });
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>(
        {
          pull() {
            reading();
          },
          cancel,
        },
        { highWaterMark: 0 },
      );
      const response = new Response("", { status: phase === "identity" ? 403 : 200 });
      vi.spyOn(response, "clone").mockReturnValue(new Response(body));
      const notified = vi.fn();
      const client = createNodeApiClient({
        fetchImpl: async (url) =>
          phase === "business" || String(url).endsWith("/userinfo")
            ? response
            : new Response("", { status: 403 }),
        isZcodeJwtRequest: () => true,
        isBusinessUnauthorizedRequest: () => true,
        resolveBusinessCredentialValidationRequest: async () => ({
          url: "https://identity.example/userinfo",
          authorization: "business-token",
          emptyBodyMeansInvalid: true,
        }),
        onZcodeJwtInvalid: notified,
      });
      const result = client
        .request("https://business.example/pricing", { signal: controller.signal })
        .catch((error: unknown) => error);
      await readStarted;
      controller.abort();
      const error = await result;
      expect(error).toBeInstanceOf(ApiError);
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      expect(notified).not.toHaveBeenCalled();
    },
  );

  it("并发核验中一个请求取消不会取消另一请求的核验", async () => {
    const controller = new AbortController();
    let release!: (response: Response) => void;
    let signal: AbortSignal | undefined;
    const identity = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn(async (url, init) => {
      if (!String(url).endsWith("/userinfo")) return new Response("", { status: 403 });
      signal = init?.signal ?? undefined;
      return identity;
    });
    const notified = vi.fn();
    const client = createNodeApiClient({
      fetchImpl,
      isZcodeJwtRequest: () => true,
      isBusinessUnauthorizedRequest: () => true,
      resolveBusinessCredentialValidationRequest: async () => ({
        url: "https://identity.example/userinfo",
        authorization: "business-token",
        emptyBodyMeansInvalid: true,
      }),
      onZcodeJwtInvalid: notified,
    });
    const cancelled = client
      .request("https://business.example/a", { signal: controller.signal })
      .catch((error: unknown) => error);
    const retained = client.request("https://business.example/b");
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    expect(await cancelled).toBeInstanceOf(ApiError);
    expect(signal?.aborted).toBe(false);
    release(new Response("", { status: 401 }));
    await expect(retained).resolves.toMatchObject({ status: 403 });
    expect(notified).toHaveBeenCalledOnce();
  });

  it("身份 transport 忽略取消时仍按观察预算结束核验且不登出", async () => {
    const notified = vi.fn();
    let identitySignal: AbortSignal | undefined;
    const original = new Response("", { status: 403 });
    const client = createNodeApiClient({
      fetchImpl: async (url, init) => {
        if (!String(url).endsWith("/userinfo")) return original;
        identitySignal = init?.signal ?? undefined;
        return new Promise<Response>(() => {});
      },
      businessUnauthorizedObservationTimeoutMs: 20,
      isZcodeJwtRequest: () => true,
      isBusinessUnauthorizedRequest: () => true,
      resolveBusinessCredentialValidationRequest: async () => ({
        url: "https://identity.example/userinfo",
        authorization: "business-token",
        emptyBodyMeansInvalid: true,
      }),
      onZcodeJwtInvalid: notified,
    });
    await expect(client.request("https://business.example/pricing")).resolves.toBe(original);
    expect(identitySignal?.aborted).toBe(true);
    expect(notified).not.toHaveBeenCalled();
  });

  it("响应观察自身超时取消副本并保留原响应和会话", async () => {
    const cancel = vi.fn();
    const response = new Response("original");
    vi.spyOn(response, "clone").mockReturnValue(new Response(new ReadableStream({ cancel })));
    const notified = vi.fn();
    const client = createNodeApiClient({
      fetchImpl: async () => response,
      businessUnauthorizedObservationTimeoutMs: 20,
      isZcodeJwtRequest: () => true,
      isBusinessUnauthorizedRequest: () => true,
      onZcodeJwtInvalid: notified,
    });
    await expect(client.request("https://business.example/pricing")).resolves.toBe(response);
    expect(await response.text()).toBe("original");
    expect(cancel).toHaveBeenCalledOnce();
    expect(notified).not.toHaveBeenCalled();
  });

  it("取消后迟到的凭据分类结果不启动核验或通知失效", async () => {
    const controller = new AbortController();
    let release!: (current: boolean) => void;
    let started!: () => void;
    const classified = new Promise<void>((resolve) => {
      started = resolve;
    });
    const notified = vi.fn();
    const fetchImpl = vi.fn(async () => new Response("", { status: 403 }));
    const resolveValidation = vi.fn(async () => ({
      url: "https://identity.example/userinfo",
      authorization: "business-token",
      emptyBodyMeansInvalid: true,
    }));
    const client = createNodeApiClient({
      fetchImpl,
      isZcodeJwtRequest: async () => {
        started();
        return new Promise<boolean>((resolve) => {
          release = resolve;
        });
      },
      isBusinessUnauthorizedRequest: () => true,
      resolveBusinessCredentialValidationRequest: resolveValidation,
      onZcodeJwtInvalid: notified,
    });
    const result = client
      .request("https://business.example/pricing", { signal: controller.signal })
      .catch((error: unknown) => error);
    await classified;
    controller.abort();
    expect(await result).toBeInstanceOf(ApiError);
    release(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(resolveValidation).not.toHaveBeenCalled();
    expect(notified).not.toHaveBeenCalled();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("会给请求自动补 x-request-id", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const client = createNodeApiClient({ fetchImpl });

    await client.request("https://example.com/oauth/token", {
      method: "POST",
    });

    const headers = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("保留调用方显式传入的 x-request-id", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const client = createNodeApiClient({ fetchImpl });

    await client.request("https://example.com/oauth/token", {
      method: "POST",
      headers: {
        "X-Request-Id": "caller-request-id",
      },
    });

    const headers = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-request-id")).toBe("caller-request-id");
  });

  it("401 且请求携带当前 ZCode JWT 时通知回调", async () => {
    const onZcodeJwtInvalid = vi.fn();
    const fetchImpl = vi.fn(
      async () =>
        new Response("", {
          status: 401,
        }),
    );
    const client = createNodeApiClient({
      fetchImpl,
      onZcodeJwtInvalid,
      isZcodeJwtRequest: (_input, headers) => headers.get("authorization") === "Bearer jwt",
    });

    await client.request("https://example.com/model", { headers: { Authorization: "Bearer jwt" } });

    expect(onZcodeJwtInvalid).toHaveBeenCalledTimes(1);
  });

  it("普通 401 不通知 ZCode JWT 失效", async () => {
    const onZcodeJwtInvalid = vi.fn();
    const fetchImpl = vi.fn(async () => new Response("", { status: 401 }));
    const client = createNodeApiClient({ fetchImpl, onZcodeJwtInvalid });

    await client.request("https://example.com/model");

    expect(onZcodeJwtInvalid).not.toHaveBeenCalled();
  });

  it("HTTP 200 业务 401 复用失效通知，保留原响应正文", async () => {
    const payload = { code: 401, msg: "登录状态已过期", success: false };
    const response = Response.json(payload);
    const onZcodeJwtInvalid = vi.fn();
    const client = createNodeApiClient({
      fetchImpl: async () => response,
      isZcodeJwtRequest: () => true,
      isBusinessUnauthorizedRequest: () => true,
      onZcodeJwtInvalid,
    });
    const result = await client.request("https://example.com/userinfo");
    expect(onZcodeJwtInvalid).toHaveBeenCalledOnce();
    expect(result).toBe(response);
    expect(result.status).toBe(200);
    expect(result.bodyUsed).toBe(false);
    expect(await result.json()).toEqual(payload);
  });

  it("不匹配当前凭据的 HTTP 200 不读取响应副本", async () => {
    const response = Response.json({ code: 401 });
    const clone = vi.spyOn(response, "clone");
    const onZcodeJwtInvalid = vi.fn();
    const client = createNodeApiClient({
      fetchImpl: async () => response,
      isZcodeJwtRequest: () => false,
      onZcodeJwtInvalid,
    });
    expect(await client.request("https://example.com/model")).toBe(response);
    expect(clone).not.toHaveBeenCalled();
    expect(onZcodeJwtInvalid).not.toHaveBeenCalled();
  });

  it("当前 JWT 的 SSE 不读取正文，不等待 continuous 流结束", async () => {
    const response = new Response(new ReadableStream(), {
      headers: { "Content-Type": "text/event-stream; charset=utf-8" },
    });
    const clone = vi.spyOn(response, "clone");
    const onZcodeJwtInvalid = vi.fn();
    const client = createNodeApiClient({
      fetchImpl: async () => response,
      isZcodeJwtRequest: () => true,
      onZcodeJwtInvalid,
    });
    expect(await client.request("https://example.com/stream")).toBe(response);
    expect(clone).not.toHaveBeenCalled();
    expect(onZcodeJwtInvalid).not.toHaveBeenCalled();
    await response.body?.cancel();
  });

  it("业务 401 观察达到时间预算后放行原响应", async () => {
    const response = new Response(new ReadableStream(), {
      headers: { "Content-Type": "application/json" },
    });
    const onZcodeJwtInvalid = vi.fn();
    const client = createNodeApiClient({
      fetchImpl: async () => response,
      isZcodeJwtRequest: () => true,
      isBusinessUnauthorizedRequest: () => true,
      onZcodeJwtInvalid,
      businessUnauthorizedObservationTimeoutMs: 10,
    });
    const request = client.request("https://bigmodel.cn/api/biz/customer/getCustomerInfo", {
      headers: { Authorization: "Bearer jwt" },
    });
    await expect(request).resolves.toBe(response);
    expect(onZcodeJwtInvalid).not.toHaveBeenCalled();
    await response.body?.cancel();
  });

  it("普通当前 JWT 请求不会读取 HTTP 200 响应副本", async () => {
    const response = Response.json({ code: 401 });
    const clone = vi.spyOn(response, "clone");
    const onZcodeJwtInvalid = vi.fn();
    const client = createNodeApiClient({
      fetchImpl: async () => response,
      isZcodeJwtRequest: () => true,
      onZcodeJwtInvalid,
    });
    await expect(client.request("https://example.com/model")).resolves.toBe(response);
    expect(clone).not.toHaveBeenCalled();
    expect(onZcodeJwtInvalid).not.toHaveBeenCalled();
  });

  it("业务 401 观察超过正文预算后放行原响应", async () => {
    const body = "x".repeat(64 * 1024 + 1);
    const response = new Response(body, { headers: { "Content-Type": "application/json" } });
    const onZcodeJwtInvalid = vi.fn();
    const client = createNodeApiClient({
      fetchImpl: async () => response,
      isZcodeJwtRequest: () => true,
      isBusinessUnauthorizedRequest: () => true,
      onZcodeJwtInvalid,
    });
    await expect(
      client.request("https://bigmodel.cn/api/biz/customer/getCustomerInfo"),
    ).resolves.toBe(response);
    expect(onZcodeJwtInvalid).not.toHaveBeenCalled();
    expect((await response.text()).length).toBe(body.length);
  });

  it("会把 timeoutMs 转成统一的 ApiError", async () => {
    vi.useFakeTimers();

    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener(
          "abort",
          () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          },
          { once: true },
        );
      });
    });

    const client = createNodeApiClient({ fetchImpl });
    const requestPromise = client.request("https://example.com/oauth/token", {
      method: "POST",
      timeoutMs: 10,
    });
    const expectation = expect(requestPromise).rejects.toEqual(
      expect.objectContaining<ApiError>({
        name: "ApiError",
        method: "POST",
        status: undefined,
        url: "https://example.com/oauth/token",
      }),
    );

    await vi.advanceTimersByTimeAsync(10);

    await expectation;
  });

  it("外部主动 abort 时不会误报成 timeout", async () => {
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          },
          { once: true },
        );
      });
    });

    const client = createNodeApiClient({ fetchImpl });
    const controller = new AbortController();
    const requestPromise = client.request("https://example.com/oauth/token", {
      method: "POST",
      timeoutMs: 100,
      signal: controller.signal,
    });

    controller.abort();

    await expect(requestPromise).rejects.toMatchObject<ApiError>({
      name: "ApiError",
      method: "POST",
      status: undefined,
      url: "https://example.com/oauth/token",
      message: "The operation was aborted.",
    });
  });
});
