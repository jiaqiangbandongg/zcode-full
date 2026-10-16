import { describe, expect, it } from "vitest";
import { resolveBuiltinAgentCliStatus } from "@/lib/builtinAgentCli.js";

describe("resolveBuiltinAgentCliStatus", () => {
  it("非安装型内置 provider 不依赖 settings 启用列表", () => {
    expect(
      resolveBuiltinAgentCliStatus({
        provider: "glm",
        enabledProviders: [],
        enablingProvider: null,
        disablingProvider: null,
      }),
    ).toBe("enabled");
  });
});
