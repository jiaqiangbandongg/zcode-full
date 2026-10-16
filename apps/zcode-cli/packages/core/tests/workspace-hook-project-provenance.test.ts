import { describe, expect, it } from "vitest";
import { createHookExecutionDescriptor } from "../src/hooks/display-metadata.js";

describe("workspace hook project provenance", () => {
  it("project source 显式 clientVisible，不回退为 internal", () => {
    expect(
      createHookExecutionDescriptor(
        {
          type: "command",
          command: "./scripts/session-start.sh",
          source: { kind: "project", path: "/workspace/.zcode/config.json" },
        },
        60_000,
      ),
    ).toMatchObject({
      clientVisible: true,
      sourceKind: "project",
      sourcePath: "/workspace/.zcode/config.json",
    });
  });
});
