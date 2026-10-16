import { describe, expect, it } from "vitest";
import {
  ProviderEndpointIdentityCache,
  sanitizeProviderEndpoint,
} from "../src/provider-endpoint.js";

describe("sanitizeProviderEndpoint", () => {
  it("保留稳定 route，并移除认证、query 与 fragment", () => {
    expect(
      sanitizeProviderEndpoint(
        "https://user:pass@Gateway.Example.com:443/team-a/v1/messages?api_key=secret#part",
      ),
    ).toMatchObject({
      origin: "https://gateway.example.com",
      route: "/team-a/v1/messages",
      sanitizerVersion: "1",
    });
  });

  it("清洗邮箱、UUID、长数字、hash 和 token 风格 segment", () => {
    const endpoint = sanitizeProviderEndpoint(
      "https://api.example.com/alice@example.com/550e8400-e29b-41d4-a716-446655440000/123456789/abcdef0123456789/Abcdef0123456789TOKEN/v1",
    );
    expect(endpoint?.route).toBe("/{email}/{uuid}/{id}/{hash}/{token}/v1");
  });

  it("对无效 URL fail closed", () => {
    expect(sanitizeProviderEndpoint("not-a-url?token=secret")).toBeUndefined();
    expect(
      sanitizeProviderEndpoint(`https://api.example.com/${"sensitive".repeat(1_000)}`),
    ).toBeUndefined();
  });

  it("限制保留下来的自定义 route segment 长度", () => {
    const segment = "route".repeat(40);
    const endpoint = sanitizeProviderEndpoint(`https://api.example.com/${segment}/v1/messages`);
    expect(endpoint?.route).toBe(`/${segment.slice(0, 128)}/v1/messages`);
  });
});

describe("ProviderEndpointIdentityCache", () => {
  it("使用有界 LRU，且同一 endpoint 返回稳定清洗结果", () => {
    const cache = new ProviderEndpointIdentityCache(2);
    const first = cache.resolve("anthropic", "https://a.example.com/v1/messages");
    expect(cache.resolve("anthropic", "https://a.example.com/v1/messages")).toEqual(first);
    cache.resolve("openai", "https://b.example.com/v1");
    cache.resolve("custom", "https://c.example.com/v1");
    expect(cache.size).toBe(2);
  });
});
