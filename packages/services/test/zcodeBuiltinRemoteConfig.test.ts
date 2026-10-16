import type { ApiClient } from "@zcode/shared";
import { describe, expect, it, vi } from "vitest";
import { fetchZCodeBuiltinRemoteRelease } from "../src/model-provider/zcodeBuiltinRemoteConfig.js";
import { NodeApiClient } from "../src/providers/api/nodeApiClient.js";

const release = {
  schemaVersion: 1,
  revision: 7,
  config: {
    providerConfigRules: { templateRules: [], providerRules: [] },
    modelConfigRules: {
      modelRules: [],
      modelApiRules: [],
      providerSiteRules: [],
      templateModelRules: [],
      builtinProviderModelRules: [],
    },
  },
};

describe("fetchZCodeBuiltinRemoteRelease", () => {
  it("App 注入现有网络实现，控制面 URL 与 CDN 共用总预算且不携带账号鉴权", async () => {
    const request = vi.fn(
      async (_url: string | URL, _init?: RequestInit) => new Response(JSON.stringify(release)),
    );
    request.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 0,
          data: { configs: { builtin_provider_config_json: "https://cdn.example.com/v7.json" } },
        }),
      ),
    );
    expect(
      (
        await fetchZCodeBuiltinRemoteRelease({
          apiClient: new NodeApiClient({
            fetchImpl: request as typeof fetch,
            resolveZCodeEndpointOrigin: () => "https://example.com",
          }),
          endpointOrigin: "https://example.com/base",
          appVersion: "3.0.0",
          platform: "darwin-aarch64",
        })
      )?.revision,
    ).toBe(7);
    const url = new URL(request.mock.calls[0]![0]);
    expect(url.pathname).toBe("/api/v1/client/configs");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      app_version: "3.0.0",
      platform: "darwin-aarch64",
    });
    expect(request.mock.calls[1]![0].toString()).toBe("https://cdn.example.com/v7.json");
    expect(request.mock.calls[1]![1]?.signal).toBe(request.mock.calls[0]![1]?.signal);
    for (const [, init] of request.mock.calls) {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(new Headers(init?.headers).has("cookie")).toBe(false);
      expect(init?.credentials).toBe("omit");
    }
  });
  it("服务端尚未下发 URL 时不请求 CDN，也不消费旧 inline 字段", async () => {
    const request = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 0, data: { configs: { zcodeBuiltin: release } } })),
    );
    await expect(
      fetchZCodeBuiltinRemoteRelease({
        apiClient: { request } as ApiClient,
        endpointOrigin: "https://example.com",
        appVersion: "3.0.0",
        platform: "linux-x86_64",
      }),
    ).resolves.toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });
});
