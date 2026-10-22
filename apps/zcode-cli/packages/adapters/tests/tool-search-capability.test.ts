import { describe, expect, it } from "vitest";
import { resolveToolSearchCapability } from "../src/model/tool-search.js";

describe("ToolSearch provider capability", () => {
  it.each([
    [{ type: "zhipu-coding-plan-api-key" }, true],
    [{ type: "zhipu-account", mode: "individual-coding-plan" }, true],
    [{ type: "zhipu-account", mode: "team-coding-plan" }, true],
    [{ type: "api-key" }, false],
    [{ type: "zhipu-account", mode: "start-plan" }, false],
    [{ type: "zhipu-account", mode: "off-peak" }, false],
  ])("derives policy from access %j", (access, enabled) => {
    expect(resolveToolSearchCapability("anthropic-messages", access)).toEqual({
      protocolSupported: true,
      defaultEnabled: enabled,
    });
    expect(resolveToolSearchCapability("openai-chat-completions", access)).toEqual({
      protocolSupported: false,
      defaultEnabled: false,
    });
  });
});
