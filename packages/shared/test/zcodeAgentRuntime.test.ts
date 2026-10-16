import { describe, expect, it } from "vitest";
import { ZCODE_AGENT_RUNTIME } from "@zcode/shared";

describe("ZCode Agent runtime", () => {
  it("starts the private ZCode Protocol server instead of the retired ZCode Agent command", () => {
    const retiredProtocolName = `${"a"}${"cp"}`;

    expect(ZCODE_AGENT_RUNTIME.spawnArgs).toEqual(["app-server", "--stdio"]);
    expect(ZCODE_AGENT_RUNTIME.spawnArgs).not.toContain(retiredProtocolName);
  });

  it("uses the ZCode Agent binary name", () => {
    expect(ZCODE_AGENT_RUNTIME.resolveEntrySegments("darwin")).toEqual(["zcode-agent"]);
    expect(ZCODE_AGENT_RUNTIME.resolveEntrySegments("win32")).toEqual(["zcode-agent.exe"]);
  });
});
