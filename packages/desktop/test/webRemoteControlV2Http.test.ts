import { describe, expect, it } from "vitest";
import { createWebRemoteControlV2Http } from "#src/main/web-remote-relay/index.js";

describe("device V2 HTTP 错误分类", () => {
  it("注册和删除响应增加字段后仍成功", async () => {
    const client = createWebRemoteControlV2Http("https://relay.example", async (url) =>
      Response.json({
        code: 0,
        msg: "",
        logid: "request-1",
        server_version: "next",
        ...(new URL(String(url)).pathname.endsWith("/delete")
          ? {}
          : {
              data: {
                device_sid: "d_1",
                device_mid: "machine-1",
                online: false,
                created_at: 1_600_000_000,
                meta: { arch: "arm64" },
                capabilities: ["remote"],
              },
            }),
      }),
    );
    const signal = new AbortController().signal;
    await expect(client.register("machine-1", "jwt", signal)).resolves.toBe("d_1");
    await expect(client.delete("d_1", "jwt", signal)).resolves.toBeUndefined();
  });

  it.each([
    new TypeError("response body connection interrupted"),
    new DOMException("response body timed out", "TimeoutError"),
  ])("收到响应头后读取正文失败仍可重试：%s", async (error) => {
    const client = createWebRemoteControlV2Http(
      "https://relay.example",
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"code":0,"data":'));
              controller.error(error);
            },
          }),
        ),
    );
    await expect(client.token("jwt", new AbortController().signal)).rejects.toMatchObject({
      reason: "relay-unavailable",
      retryable: true,
      message: "relay-unavailable",
    });
  });

  it.each([
    [401, "auth-required", false],
    [403, "relay-unavailable", false],
    [503, "relay-unavailable", true],
  ] as const)("HTTP %s 保留既有终态/重试分类", async (status, reason, retryable) => {
    const client = createWebRemoteControlV2Http(
      "https://relay.example",
      async () => new Response("private response", { status }),
    );
    await expect(client.token("jwt", new AbortController().signal)).rejects.toMatchObject({
      reason,
      retryable,
      message: reason,
    });
  });

  it.each([
    "not-json",
    JSON.stringify({ code: 1006, msg: "no permission" }),
    JSON.stringify({ code: 1006, msg: "no permission", logid: "request-1", retry_after: 5 }),
    JSON.stringify({ code: 0, msg: "", data: { token: "invalid", expires_in: 60 } }),
  ])("完整但无效的响应仍是终态", async (body) => {
    const client = createWebRemoteControlV2Http(
      "https://relay.example",
      async () => new Response(body),
    );
    await expect(client.token("jwt", new AbortController().signal)).rejects.toMatchObject({
      reason: "relay-unavailable",
      retryable: false,
    });
  });

  it.each([undefined, "request-1"])("完整合法响应仍返回一次性 token（logid=%s）", async (logid) => {
    const client = createWebRemoteControlV2Http("https://relay.example", async () =>
      Response.json({
        code: 0,
        msg: "",
        logid,
        server_version: "next",
        data: { token: "AAAAAAAAAAAAAAAAAAAAAA", expires_in: 60, token_version: 3 },
      }),
    );
    await expect(client.token("jwt", new AbortController().signal)).resolves.toBe(
      "AAAAAAAAAAAAAAAAAAAAAA",
    );
  });

  it("读取正文时取消请求，不返回 token 或泄漏原始错误", async () => {
    const controller = new AbortController();
    const client = createWebRemoteControlV2Http(
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
    const request = client.token("jwt", controller.signal);
    controller.abort();
    await expect(request).rejects.toMatchObject({
      reason: "relay-unavailable",
      retryable: true,
      message: "relay-unavailable",
    });
  });
});
