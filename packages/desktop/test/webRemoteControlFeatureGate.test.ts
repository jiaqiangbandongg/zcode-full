import { describe, expect, it } from "vitest";
import { createWebRemoteControlFeatureGate } from "../src/main/webRemoteControlFeatureGate.js";

describe("createWebRemoteControlFeatureGate", () => {
  it("allows development wiring", () => {
    const gate = createWebRemoteControlFeatureGate(true);

    expect(gate.isEnabled()).toBe(true);
    expect(() => gate.assertEnabled()).not.toThrow();
  });

  it("rejects production wiring before QR material is returned", () => {
    const gate = createWebRemoteControlFeatureGate(false);

    expect(gate.isEnabled()).toBe(false);
    expect(() => gate.assertEnabled()).toThrow("Web remote control is disabled");
  });
});
