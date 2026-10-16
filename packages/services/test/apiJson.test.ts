import { describe, expect, it, vi } from "vitest";
import { ApiError, type ApiClient } from "@zcode/shared";
import { readApiJson } from "../src/providers/api/apiJson.js";

function createMockClient(responseFactory: ReturnType<typeof vi.fn>): ApiClient {
  return {
    request: responseFactory,
  };
}

describe("apiJson", () => {
  it("非 2xx 响应会抛出带状态码的 ApiError", async () => {
    const request = vi.fn(async () => {
      return new Response(JSON.stringify({ error: "invalid token" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    });

    await expect(
      readApiJson(createMockClient(request), "https://example.com/oauth/userinfo"),
    ).rejects.toEqual(
      expect.objectContaining<ApiError>({
        name: "ApiError",
        method: "GET",
        status: 401,
        url: "https://example.com/oauth/userinfo",
      }),
    );
  });

  it("响应不是合法 JSON 时会抛出统一的 ApiError", async () => {
    const request = vi.fn(async () => {
      return new Response("not-json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await expect(
      readApiJson(createMockClient(request), "https://example.com/client/configs"),
    ).rejects.toEqual(
      expect.objectContaining<ApiError>({
        name: "ApiError",
        method: "GET",
        status: 200,
        url: "https://example.com/client/configs",
      }),
    );
  });
});
