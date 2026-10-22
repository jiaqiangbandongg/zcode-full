import { describe, expect, it, vi } from "vitest";
import {
  createWebRemoteControlDeviceStorage,
  createWebRemoteControlV2Http,
} from "#src/main/web-remote-relay/index.js";

describe("desktop relay public boundary", () => {
  it("shares legacy cleanup and permits retry after failed persistence", async () => {
    const patchSettings = vi.fn().mockRejectedValueOnce(new Error("disk"));
    const deleteLegacyCredential = vi.fn(async () => {});
    const storage = createWebRemoteControlDeviceStorage({
      loadSettings: vi.fn(),
      patchSettings,
      deleteLegacyCredential,
    });
    const first = storage.clearLegacy();
    expect(storage.clearLegacy()).toBe(first);
    await expect(first).rejects.toThrow("disk");
    await storage.clearLegacy();
    expect(deleteLegacyCredential).toHaveBeenCalledTimes(2);
    expect(patchSettings).toHaveBeenLastCalledWith({
      webRemoteControlExternalRelayDevice: undefined,
    });
  });
  it("sanitizes authentication failure at the Main boundary", async () => {
    const http = createWebRemoteControlV2Http(
      "https://relay.example.com",
      vi.fn(async () => new Response("private body", { status: 401 })),
    );
    await expect(http.token("private-jwt", new AbortController().signal)).rejects.toMatchObject({
      message: "auth-required",
      retryable: false,
    });
  });
});
