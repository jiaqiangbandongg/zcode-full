import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTelemetryCore } from "../src/telemetry/telemetryCore.js";
import { createTelemetryAuthorizationLoader } from "../src/node.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
const context = {
  clientLanguage: "zh-CN",
  clientTimezone: "Asia/Shanghai",
  screenResolution: "100x100",
};

it("adds every public header and re-reads authorization on retry and logout", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "telemetry-headers-"));
  homes.push(homeDir);
  let token: string | null = "Bearer first";
  const loadAuthorization = vi.fn(async () => token);
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValue(new Response(null, { status: 204 }));
  const core = createTelemetryCore({
    homeDir,
    fetchImpl,
    loadAuthorization,
    loadUserId: async () => "user-1",
    appVersion: "1.2.3",
    platform: "darwin",
    arch: "arm64",
    osVersion: "24.0",
    releaseChannel: "test",
    randomUUID: () => "device-1",
    resolveZCodeEndpointOrigin: () => "https://zcode.z.ai",
    sleep: async () => {
      token = "Bearer second";
    },
  });
  await core.reportAppLaunch(context);
  expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("error");
  expect(fetchImpl.mock.calls[0]?.[1]?.headers).toEqual({
    "Content-Type": "application/json",
    "User-Agent": "ZCode/1.2.3",
    "HTTP-Referer": "https://zcode.z.ai",
    "X-Title": "Z Code@electron",
    "X-ZCode-App-Version": "1.2.3",
    "X-Platform": "darwin-arm64",
    "X-Release-Channel": "test",
    "X-Client-Language": "zh-CN",
    "X-Client-Timezone": "Asia/Shanghai",
    "X-Os-Category": "macos",
    "X-Os-Version": "24.0",
    "X-Device-Mid": "device-1",
    Authorization: "Bearer first",
  });
  expect(new Headers(fetchImpl.mock.calls[1]?.[1]?.headers).get("Authorization")).toBe(
    "Bearer second",
  );
  expect(fetchImpl.mock.calls[1]?.[1]?.body).toBe(fetchImpl.mock.calls[0]?.[1]?.body);
  token = null;
  await core.reportAppLaunch(context);
  expect(new Headers(fetchImpl.mock.calls[2]?.[1]?.headers).has("Authorization")).toBe(false);
  expect(loadAuthorization).toHaveBeenCalledWith("user-1");
  loadAuthorization.mockRejectedValueOnce(new Error("secret credential error"));
  await core.reportAppLaunch(context);
  expect(new Headers(fetchImpl.mock.calls[3]?.[1]?.headers).has("Authorization")).toBe(false);
});

it.each(["zai", "bigmodel"])(
  "only reads JWT for active %s, never OAuth/API keys",
  async (provider) => {
    const values: Record<string, string> = {
      "oauth:active_provider": provider,
      [`oauth:${provider}:user_info`]: '{"id":"u1"}',
      zcodejwttoken: "jwt-1",
    };
    const load = vi.fn(async (key: string) => values[key] ?? null);
    const authorization = createTelemetryAuthorizationLoader({ load });
    expect(await authorization("u1")).toBe("Bearer jwt-1");
    values.zcodejwttoken = "jwt-2";
    expect(await authorization("u1")).toBe("Bearer jwt-2");
    expect(await authorization("other-user")).toBeNull();
    delete values["oauth:active_provider"];
    expect(await authorization("u1")).toBeNull();
    expect(await authorization("")).toBeNull();
    expect(
      load.mock.calls.every(([key]) => !key.includes("access_token") && !key.includes("api_key")),
    ).toBe(true);
  },
);

it("drops JWT when the account changes during the read, and fails closed on errors", async () => {
  let provider = "bigmodel";
  const authorization = createTelemetryAuthorizationLoader({
    load: async (key) => {
      if (key === "oauth:active_provider") return provider;
      if (key.endsWith(":user_info")) return '{"user_id":"u1"}';
      provider = "zai";
      return "old-jwt";
    },
  });
  expect(await authorization("u1")).toBeNull();
  const failed = createTelemetryAuthorizationLoader({
    load: async () => {
      throw new Error("secret");
    },
  });
  expect(await failed("u1")).toBeNull();
});

it.each([null, "", "   ", "bad\r\nheader"])("omits absent or unsafe JWT: %j", async (token) => {
  const authorization = createTelemetryAuthorizationLoader({
    load: async (key) => {
      if (key === "oauth:active_provider") return "zai";
      if (key.endsWith(":user_info")) return '{"id":"u1"}';
      return token;
    },
  });
  expect(await authorization("u1")).toBeNull();
});
