import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@zcode/shared";
import { createNodeApiClient } from "../src/providers/api/nodeApiClient.js";

describe("nodeApiClient", () => {
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

  it.each([
    "",
    "{",
    "<html>login expired</html>",
    "null",
    "[]",
    '{"code":"401","success":false}',
    '{"code":403,"success":false}',
    '{"code":500,"msg":"登录状态已过期"}',
    '{"code":200,"success":true}',
  ])("HTTP 200 非明确业务 401 不通知失效，保留原正文：%s", async (body) => {
    const onZcodeJwtInvalid = vi.fn();
    const client = createNodeApiClient({
      fetchImpl: async () => new Response(body),
      isZcodeJwtRequest: () => true,
      onZcodeJwtInvalid,
    });
    const response = await client.request("https://example.com/userinfo");
    expect(onZcodeJwtInvalid).not.toHaveBeenCalled();
    expect(await response.text()).toBe(body);
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
