import { afterEach, describe, expect, it, vi } from "vitest";

describe("ARMS Browser init config", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("本地开发态使用 production 产品环境时仍标记为 local", async () => {
    vi.stubGlobal("__ZCODE_ENV__", "production");
    const { buildArmsBrowserInitConfig } = await import("../src/shared/armsRumShared.js");

    expect(buildArmsBrowserInitConfig("development").env).toBe("local");
  });
});
