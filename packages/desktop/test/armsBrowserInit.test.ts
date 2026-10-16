import { afterEach, describe, expect, it, vi } from "vitest";

const { init } = vi.hoisted(() => ({ init: vi.fn() }));

vi.mock("@arms/rum-electron/browser", () => ({
  default: { init },
}));

describe("ARMS Browser init", () => {
  afterEach(() => {
    init.mockReset();
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("显式使用本地开发运行态初始化 production 产品环境为 local", async () => {
    vi.stubGlobal("__ZCODE_ENV__", "production");
    vi.stubGlobal("ArmsEventBridge", { send: vi.fn() });
    const { initArmsBrowserRumOnce } = await import("../src/shared/armsBrowserInit.js");

    expect(initArmsBrowserRumOnce("development")).toBe(true);
    expect(init).toHaveBeenCalledWith(expect.objectContaining({ env: "local" }));
  });
});
