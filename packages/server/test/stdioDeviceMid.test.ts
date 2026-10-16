import { describe, expect, it, vi } from "vitest";
import { ensureRemoteServerDeviceMid } from "../src/stdioDeviceMid.js";

describe("ensureRemoteServerDeviceMid", () => {
  it("启动时确保 deviceMid 并返回，不打告警", async () => {
    const log = vi.fn();
    const ensureDeviceMid = vi.fn(async () => "device-mid-remote");

    await expect(ensureRemoteServerDeviceMid({ ensureDeviceMid, log })).resolves.toBe(
      "device-mid-remote",
    );

    expect(ensureDeviceMid).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  it("确保失败时记录原因并继续启动，不抛错也不伪造设备 ID", async () => {
    const log = vi.fn();
    const ensureDeviceMid = vi.fn(async () => {
      throw new Error("Telemetry state lock timeout");
    });

    await expect(ensureRemoteServerDeviceMid({ ensureDeviceMid, log })).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain("X-Device-Mid");
    expect(String(log.mock.calls[0]?.[1])).toContain("Telemetry state lock timeout");
  });
});
