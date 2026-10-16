import { describe, expect, it } from "vitest";
import {
  getWebRemoteControlHeartbeatDelayMs,
  getWebRemoteControlReconnectJitterMs,
} from "../src/web-remote-control-heartbeat.js";

describe("web remote control heartbeat scheduling", () => {
  it("keeps the production heartbeat delay inside the symmetric jitter window", () => {
    expect(getWebRemoteControlHeartbeatDelayMs(10_000, 2_000, () => 0)).toBe(8_000);
    expect(getWebRemoteControlHeartbeatDelayMs(10_000, 2_000, () => 0.5)).toBe(10_000);
    expect(getWebRemoteControlHeartbeatDelayMs(10_000, 2_000, () => 0.999999)).toBe(12_000);
  });

  it("derives a small bounded reconnect delay from the same random source", () => {
    expect(getWebRemoteControlReconnectJitterMs(2_000, () => 0)).toBe(0);
    expect(getWebRemoteControlReconnectJitterMs(2_000, () => 0.5)).toBe(1_000);
    expect(getWebRemoteControlReconnectJitterMs(2_000, () => 0.999999)).toBe(2_000);
  });

  it("does not let a test-sized base interval produce a production-sized jitter", () => {
    expect(getWebRemoteControlHeartbeatDelayMs(20, undefined, () => 0)).toBe(16);
    expect(getWebRemoteControlHeartbeatDelayMs(20, undefined, () => 0.999999)).toBe(24);
  });
});
