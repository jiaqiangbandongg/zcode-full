import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  requestHeaders: [] as Record<string, string>[],
  fetchHeaders: [] as Headers[],
}));

vi.mock("electron", () => ({
  net: {
    request: () => {
      const headers: Record<string, string> = {};
      electron.requestHeaders.push(headers);
      const request = Object.assign(new EventEmitter(), {
        setHeader: (name: string, value: string) => {
          headers[name] = value;
        },
        abort: () => undefined,
        end: () => {
          const response = Object.assign(new EventEmitter(), { statusCode: 200 });
          request.emit("response", response);
          response.emit("data", JSON.stringify({ code: 0, data: { configs: {} } }));
          response.emit("end");
        },
      });
      return request;
    },
    fetch: async (_input: string, init?: RequestInit) => {
      electron.fetchHeaders.push(new Headers(init?.headers));
      return new Response(JSON.stringify({ code: 0, data: { configs: {} } }));
    },
  },
}));

import { createElectronDesktopContextPromptConfigFetcher } from "../src/main/desktopContextPromptRollout.js";
import { createDesktopHelpConfigReader } from "../src/main/desktopHelpConfig.js";

describe("Desktop main client/configs 的 X-Client-Language", () => {
  it("灰度配置请求按当前界面语言发送，切换后下一次请求生效", async () => {
    let locale = "zh-CN";
    const fetchConfig = createElectronDesktopContextPromptConfigFetcher({
      appVersion: "3.0.0",
      deviceMid: "device-mid-1",
      resolveEndpointOrigin: async () => "https://zcode.example.com",
      getClientLanguage: () => locale,
    });

    await fetchConfig(new AbortController().signal);
    locale = "en-US";
    await fetchConfig(new AbortController().signal);

    expect(electron.requestHeaders.map((headers) => headers["X-Client-Language"])).toEqual([
      "zh-CN",
      "en-US",
    ]);
  });

  it("帮助配置请求按当前界面语言发送", async () => {
    const read = createDesktopHelpConfigReader({
      appVersion: "3.0.0",
      deviceMid: "device-mid-1",
      resolveEndpointOrigin: async () => "https://zcode.example.com",
      getClientLanguage: () => "zh-CN",
    });

    await read().catch(() => undefined);

    expect(electron.fetchHeaders[0]?.get("X-Client-Language")).toBe("zh-CN");
  });
});
