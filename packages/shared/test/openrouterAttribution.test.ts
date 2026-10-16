import { describe, expect, it } from "vitest";
import {
  isOpenRouterBaseUrl,
  withOpenRouterAttributionHeaders,
} from "../src/openrouter-attribution.js";

describe("OpenRouter attribution headers", () => {
  it("识别 https OpenRouter baseURL", () => {
    expect(isOpenRouterBaseUrl("https://openrouter.ai/api/v1")).toBe(true);
    expect(isOpenRouterBaseUrl(" https://openrouter.ai/api/v1/ ")).toBe(true);
    expect(isOpenRouterBaseUrl("https://gateway.openrouter.ai/api/v1")).toBe(true);
  });

  it("拒绝非 OpenRouter 或非 https baseURL", () => {
    expect(isOpenRouterBaseUrl("https://api.openai.com/v1")).toBe(false);
    expect(isOpenRouterBaseUrl("http://openrouter.ai/api/v1")).toBe(false);
    expect(isOpenRouterBaseUrl("https://example.com/https://openrouter.ai")).toBe(false);
    expect(isOpenRouterBaseUrl(undefined)).toBe(false);
  });

  it("只给 OpenRouter baseURL 添加 attribution headers", () => {
    expect(
      withOpenRouterAttributionHeaders({ "X-Title": "Z Code@cli" }, "https://openrouter.ai/api/v1"),
    ).toEqual({
      "X-Title": "Z Code@cli",
      "X-OpenRouter-Title": "ZCode",
      "X-OpenRouter-Categories": "programming-app",
    });
    expect(
      withOpenRouterAttributionHeaders({ "X-Title": "Z Code@cli" }, "https://api.openai.com/v1"),
    ).toEqual({
      "X-Title": "Z Code@cli",
    });
  });
});
