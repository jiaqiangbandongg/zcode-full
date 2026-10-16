import { describe, expect, it } from "vitest";
import {
  applyProtocolPresentationSurface,
  applyProtocolProviderRegistry,
} from "../src/zcode-protocol-entrypoint.js";

describe("protocol presentation surface", () => {
  it("injects the process presentation surface without dropping session runtime config", () => {
    const options = applyProtocolPresentationSurface(
      {
        runtimeConfig: {
          mode: "plan",
          presentationSurface: "terminal",
        },
        sourceTitle: "electron",
      },
      "zcode_desktop",
    );

    expect(options.runtimeConfig).toMatchObject({
      mode: "plan",
      presentationSurface: "zcode_desktop",
    });
    expect(options.sourceTitle).toBe("electron");
  });

  it("keeps manual protocol servers on the terminal surface by default", () => {
    const options = applyProtocolPresentationSurface({}, "terminal");

    expect(options.runtimeConfig?.presentationSurface).toBe("terminal");
  });

  it("已装配进程 Registry 时直接作为 Provider 事实源", () => {
    const providerRegistry = {} as NonNullable<Parameters<typeof applyProtocolProviderRegistry>[1]>;
    const configuredDefaultModelSelection = {
      providerId: "deepseek",
      modelId: "deepseek-v4-flash",
    };

    const options = applyProtocolProviderRegistry(
      {},
      providerRegistry,
      configuredDefaultModelSelection,
    );

    expect(options.providerRegistry).toBe(providerRegistry);
    expect(options.configuredDefaultModelSelection).toEqual(configuredDefaultModelSelection);
  });
});
