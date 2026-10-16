import { describe, expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";
import { stringifyCodexConfigToml } from "../src/providers/codexConfigToml.js";

describe("codexConfigToml", () => {
  it("会把 provider 的 http_headers 序列化为 inline table", () => {
    const toml = stringifyCodexConfigToml({
      model_provider: "OpenAI",
      model_providers: {
        OpenAI: {
          base_url: "https://api.openai.com/v1",
          wire_api: "responses",
          requires_openai_auth: true,
          http_headers: {
            "User-Agent": "ZCode/unknown",
            "HTTP-Referer": "https://zcode.z.ai",
            "X-Title": "Z Code@electron",
          },
        },
      },
    });

    expect(toml).toContain("[model_providers.OpenAI]");
    expect(toml).toContain("http_headers = {");
    expect(toml).not.toContain("[model_providers.OpenAI.http_headers]");
  });

  it("provider 只有 http_headers 时也会写成 inline table", () => {
    const toml = stringifyCodexConfigToml({
      model_providers: {
        OpenAI: {
          http_headers: {
            "User-Agent": "ZCode/unknown",
            "HTTP-Referer": "https://zcode.z.ai",
            "X-Title": "Z Code@electron",
          },
        },
      },
    });

    expect(toml).toContain("[model_providers.OpenAI]");
    expect(toml).toContain("http_headers = {");
    expect(toml).not.toContain("[model_providers.OpenAI.http_headers]");
  });

  it("会兼容需要引号的 provider id", () => {
    const toml = stringifyCodexConfigToml({
      model_provider: "Provider Demo",
      model_providers: {
        "Provider Demo": {
          base_url: "https://example.com/v1",
          http_headers: {
            "X-Title": "Z Code@electron",
          },
        },
      },
    });

    expect(toml).toContain('[model_providers."Provider Demo"]');
    expect(toml).toContain("http_headers = {");
    expect(toml).not.toContain('[model_providers."Provider Demo".http_headers]');
  });

  it("会清理 query_params.http_headers 并把 http_headers 固定写在 provider 主表", () => {
    const toml = stringifyCodexConfigToml({
      model_provider: "custom",
      model_providers: {
        custom: {
          name: "custom",
          base_url: "http://192.168.100.166:8080/v1",
          wire_api: "responses",
          requires_openai_auth: true,
          query_params: {
            http_headers: {
              "User-Agent": "legacy/invalid",
            },
          },
          http_headers: {
            "User-Agent": "ZCode/unknown",
            "HTTP-Referer": "https://zcode.z.ai",
            "X-Title": "Z Code@electron",
          },
        },
      },
    });

    expect(toml).toContain("[model_providers.custom]");
    expect(toml).toContain("http_headers = {");
    expect(toml).not.toContain("[model_providers.custom.http_headers]");
    expect(toml).not.toContain("[model_providers.custom.query_params.http_headers]");
    expect(toml).not.toContain("[model_providers.custom.query_params.http_headers.http_headers]");

    const parsed = parseToml(toml) as {
      model_providers?: {
        custom?: {
          query_params?: Record<string, unknown>;
          http_headers?: Record<string, unknown>;
        };
      };
    };

    expect(parsed.model_providers?.custom?.query_params?.http_headers).toBeUndefined();
    expect(parsed.model_providers?.custom?.http_headers).toMatchObject({
      "User-Agent": "ZCode/unknown",
      "HTTP-Referer": "https://zcode.z.ai",
      "X-Title": "Z Code@electron",
    });
  });
});
