import { describe, expect, it, vi } from "vitest";
import { createWebRemoteControlV2TokenClient } from "#src/web-remote-control/index.js";

describe("terminal token HTTP", () => {
  it.each([undefined, "request-1"])(
    "使用 JWT 申请一次性 terminal token（logid=%s）",
    async (logid) => {
      const fetcher = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: 0,
              msg: "",
              logid,
              server_version: "next",
              data: { token: "AAAAAAAAAAAAAAAAAAAAAA", expires_in: 60, token_version: 3 },
            }),
          ),
      );
      const token = createWebRemoteControlV2TokenClient("https://relay.example", fetcher);
      await expect(token("jwt", new AbortController().signal)).resolves.toBe(
        "AAAAAAAAAAAAAAAAAAAAAA",
      );
      expect(fetcher).toHaveBeenCalledWith(
        new URL("https://relay.example/api/v1/remote/token"),
        expect.objectContaining({
          method: "POST",
          headers: { Authorization: "Bearer jwt", "Content-Type": "application/json" },
          body: '{"role":"terminal"}',
          redirect: "error",
        }),
      );
    },
  );
  it.each([
    [401, "auth-required", false],
    [403, "relay-unavailable", false],
    [500, "relay-unavailable", true],
    [503, "relay-unavailable", true],
  ] as const)("HTTP %s 只暴露可操作的错误分类", async (status, reason, retryable) => {
    const fetcher = vi.fn(async () => new Response("secret response", { status }));
    await expect(
      createWebRemoteControlV2TokenClient("https://relay.example", fetcher)(
        "jwt",
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ reason, retryable, message: reason });
  });
  it.each([
    "not-json",
    JSON.stringify({ code: 1006, msg: "no permission" }),
    JSON.stringify({ code: 1006, msg: "no permission", logid: "request-1", retry_after: 5 }),
    JSON.stringify({ code: 0, msg: "", data: { token: "bad", expires_in: 60 } }),
  ])("拒绝畸形与业务错误信封", async (body) => {
    await expect(
      createWebRemoteControlV2TokenClient("https://relay.example", async () => new Response(body))(
        "jwt",
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ reason: "relay-unavailable", retryable: false });
  });
  it("网络失败可以退避重试", async () => {
    await expect(
      createWebRemoteControlV2TokenClient("https://relay.example", async () => {
        throw new Error("network secret");
      })("jwt", new AbortController().signal),
    ).rejects.toMatchObject({ reason: "relay-unavailable", retryable: true });
  });
  it.each([
    new TypeError("response body connection interrupted"),
    new DOMException("response body timed out", "TimeoutError"),
  ])("收到响应头后读取正文失败仍可重试：%s", async (error) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"code":0,"data":'));
        controller.error(error);
      },
    });
    const token = createWebRemoteControlV2TokenClient(
      "https://relay.example",
      async () => new Response(body),
    );
    await expect(token("jwt", new AbortController().signal)).rejects.toMatchObject({
      reason: "relay-unavailable",
      retryable: true,
      message: "relay-unavailable",
    });
  });

  it("读取正文时取消请求，不返回 token 或泄漏原始错误", async () => {
    const controller = new AbortController();
    const token = createWebRemoteControlV2TokenClient(
      "https://relay.example",
      async (_url, init) =>
        new Response(
          new ReadableStream({
            start(body) {
              init?.signal?.addEventListener("abort", () => body.error(init.signal?.reason), {
                once: true,
              });
            },
          }),
        ),
    );
    const request = token("jwt", controller.signal);
    controller.abort();
    await expect(request).rejects.toMatchObject({
      reason: "relay-unavailable",
      retryable: true,
      message: "relay-unavailable",
    });
  });
});
