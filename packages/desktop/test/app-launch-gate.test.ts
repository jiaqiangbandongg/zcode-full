import { describe, expect, it } from "vitest";

describe("app launch gate", () => {
  it("allows app launch telemetry exactly once", async () => {
    const { createAppLaunchGate } = await import("../src/main/appLaunchGate.js");
    const gate = createAppLaunchGate();

    expect(gate.consume()).toBe(true);
    expect(gate.consume()).toBe(false);
    expect(gate.consume()).toBe(false);
  });
});
