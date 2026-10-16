import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ZCODE_ENDPOINT_ORIGIN } from "@zcode/shared";
import { setDataBaseDir } from "../src/paths.js";
import { createNodeApiClient } from "../src/providers/api/nodeApiClient.js";
import { buildZCodeSourceHeaders, ZCODE_SOURCE_HEADERS } from "../src/providers/sourceHeaders.js";

describe("NodeApiClient endpoint rewriting", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    setDataBaseDir(null);
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rewrites only the configured zcode endpoint origin", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const client = createNodeApiClient({
      fetchImpl: fetchImpl as typeof fetch,
      resolveZCodeEndpointOrigin: async () => "http://localhost:3030",
    });

    await client.request(`${DEFAULT_ZCODE_ENDPOINT_ORIGIN}/api/v1/event/report?x=1`);
    await client.request("https://example.com/static/config.json");
    await client.request("https://feedback.example.invalid/api/v1/tickets");
    await client.request("https://api.z.ai/v1/models");

    expect(fetchImpl.mock.calls.map(([input]) => String(input))).toEqual([
      "http://localhost:3030/api/v1/event/report?x=1",
      "https://example.com/static/config.json",
      "https://feedback.example.invalid/api/v1/tickets",
      "https://api.z.ai/v1/models",
    ]);
  });

  it("只给当前 zcode endpoint 请求统一补来源 headers", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const client = createNodeApiClient({
      fetchImpl: fetchImpl as typeof fetch,
      resolveZCodeEndpointOrigin: async () => "https://zcode.z.ai",
    });

    await client.request(`${DEFAULT_ZCODE_ENDPOINT_ORIGIN}/api/v1/client/configs`);
    await client.request("https://api.z.ai/v1/models");

    const zcodeHeaders = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(zcodeHeaders.get("User-Agent")).toMatch(/^ZCode\//);
    expect(zcodeHeaders.get("X-Title")).toBe(ZCODE_SOURCE_HEADERS["X-Title"]);
    expect(zcodeHeaders.get("X-OpenRouter-Title")).toBeNull();
    expect(zcodeHeaders.get("X-OpenRouter-Categories")).toBeNull();
    expect(zcodeHeaders.get("HTTP-Referer")).toBe("https://zcode.z.ai");
    expect(zcodeHeaders.get("X-App-Version")).toBeNull();
    expect(zcodeHeaders.get("X-ZCode-App-Version")).toBeTruthy();
    expect(zcodeHeaders.get("X-Platform")).toBe(`${process.platform}-${process.arch}`);
    expect(zcodeHeaders.get("X-Release-Channel")).toBeTruthy();
    expect(zcodeHeaders.get("X-Client-Language")).toBeTruthy();
    expect(zcodeHeaders.get("X-Client-Timezone")).toBeTruthy();
    expect(zcodeHeaders.get("X-Os-Category")).toBeTruthy();
    expect(zcodeHeaders.get("X-Os-Version")).toBeTruthy();
    expect(zcodeHeaders.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    const externalHeaders = new Headers(fetchImpl.mock.calls[1]?.[1]?.headers);
    expect(externalHeaders.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(externalHeaders.get("User-Agent")).toBeNull();
  });

  it("保留调用方显式传入的 zcode endpoint headers", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const client = createNodeApiClient({
      fetchImpl: fetchImpl as typeof fetch,
      resolveZCodeEndpointOrigin: async () => "https://zcode.z.ai",
    });

    await client.request(`${DEFAULT_ZCODE_ENDPOINT_ORIGIN}/api/v1/oauth/token`, {
      headers: {
        "User-Agent": "CustomAgent/1.0",
        "X-Device-Mid": "caller-device-mid",
        "X-Title": "Custom Title",
        Authorization: "Bearer token",
      },
    });

    const headers = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(headers.get("User-Agent")).toBe("CustomAgent/1.0");
    expect(headers.get("X-Title")).toBe("Custom Title");
    expect(headers.get("X-OpenRouter-Title")).toBeNull();
    expect(headers.get("X-OpenRouter-Categories")).toBeNull();
    expect(headers.get("Authorization")).toBe("Bearer token");
    expect(headers.get("X-Device-Mid")).toBe("caller-device-mid");
    expect(headers.get("HTTP-Referer")).toBe("https://zcode.z.ai");
    expect(headers.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("给当前 zcode endpoint 请求补既有 deviceMid header", async () => {
    const dataBaseDir = mkdtempSync(join(tmpdir(), "zcode-device-mid-"));
    tempDirs.push(dataBaseDir);
    setDataBaseDir(dataBaseDir);
    const configDir = join(dataBaseDir, ".zcode", "v2");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "telemetry-state.json"),
      JSON.stringify({ deviceMid: "device-mid-1" }),
      "utf-8",
    );

    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const client = createNodeApiClient({
      fetchImpl: fetchImpl as typeof fetch,
      resolveZCodeEndpointOrigin: async () => "https://zcode.z.ai",
    });

    await client.request(`${DEFAULT_ZCODE_ENDPOINT_ORIGIN}/api/v1/client/configs`);

    const headers = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(headers.get("X-Device-Mid")).toBe("device-mid-1");
  });

  it.each([
    { name: "state 文件缺失", content: null },
    { name: "state JSON 损坏", content: "{" },
    { name: "deviceMid 为空字符串", content: JSON.stringify({ deviceMid: "" }) },
    { name: "deviceMid 含不可打印字符", content: JSON.stringify({ deviceMid: "mid\n1" }) },
  ])("$name 时不注入 deviceMid header", async ({ content }) => {
    const dataBaseDir = mkdtempSync(join(tmpdir(), "zcode-device-mid-invalid-"));
    tempDirs.push(dataBaseDir);
    setDataBaseDir(dataBaseDir);
    const configDir = join(dataBaseDir, ".zcode", "v2");
    mkdirSync(configDir, { recursive: true });
    if (content !== null) {
      writeFileSync(join(configDir, "telemetry-state.json"), content, "utf-8");
    }

    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const client = createNodeApiClient({
      fetchImpl: fetchImpl as typeof fetch,
      resolveZCodeEndpointOrigin: async () => "https://zcode.z.ai",
    });

    await client.request(`${DEFAULT_ZCODE_ENDPOINT_ORIGIN}/api/v1/client/configs`);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const headers = new Headers(fetchImpl.mock.calls[0]?.[1]?.headers);
    expect(headers.get("X-Device-Mid")).toBeNull();
  });

  it("统一来源 headers 支持可控的客户端上下文字段", () => {
    expect(
      buildZCodeSourceHeaders({
        appVersion: "2.14.0",
        arch: "arm64",
        clientLanguage: "zh-CN",
        clientTimezone: "Asia/Shanghai",
        osVersion: "Darwin 25.0.0",
        platform: "darwin",
        releaseChannel: "production",
      }),
    ).toMatchObject({
      "X-Platform": "darwin-arm64",
      "X-Release-Channel": "production",
      "X-Client-Language": "zh-CN",
      "X-Client-Timezone": "Asia/Shanghai",
      "X-Os-Category": "macos",
      "X-Os-Version": "Darwin 25.0.0",
      "X-ZCode-App-Version": "2.14.0",
    });
  });
});
