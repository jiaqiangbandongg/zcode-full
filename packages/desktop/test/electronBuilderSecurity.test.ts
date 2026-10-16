import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("Windows 打包关闭 Node Inspector，保留 Agent 所需的 RunAsNode", async () => {
  vi.stubEnv("ZCODE_TARGET_OS", "win32");
  const { default: config } = await import("../electron-builder.config.js");

  expect(config.electronFuses?.enableNodeCliInspectArguments).toBe(false);
  expect(config.electronFuses?.runAsNode).toBeUndefined();
});

it.each(["darwin", "linux"])("%s 保留现有 fuse 配置", async (platform) => {
  vi.stubEnv("ZCODE_TARGET_OS", platform);
  const { default: config } = await import("../electron-builder.config.js");

  expect(config.electronFuses).toBeUndefined();
});
