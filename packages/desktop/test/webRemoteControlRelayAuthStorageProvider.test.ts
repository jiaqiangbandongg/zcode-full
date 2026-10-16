import { describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@zcode/shared";
import {
  WEB_REMOTE_CONTROL_EXTERNAL_RELAY_PASS_HASH_CREDENTIAL_KEY,
  createWebRemoteControlRelayAuthStorageProvider,
} from "../src/main/webRemoteControlRelayAuthStorageProvider.js";

function createHarness(initialSettings: AppSettings = { recentProjects: [], locale: "zh-CN" }) {
  let settings = initialSettings;
  const credentials: Record<string, string | undefined> = {};
  const patches: Partial<AppSettings>[] = [];
  const operations: string[] = [];
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
  };
  const provider = createWebRemoteControlRelayAuthStorageProvider({
    credentialService: {
      load: async (key) => credentials[key] ?? null,
      save: async (key, value) => {
        operations.push(`save:${key}:${value}`);
        credentials[key] = value;
      },
      delete: async (key) => {
        operations.push(`delete:${key}`);
        credentials[key] = undefined;
      },
    },
    loadSettings: async () => settings,
    patchSettings: async (patch) => {
      operations.push(`patch:${JSON.stringify(patch)}`);
      patches.push(patch);
      settings = { ...settings, ...patch };
    },
    logger,
  });

  return { credentials, logger, operations, patches, provider };
}

describe("createWebRemoteControlRelayAuthStorageProvider", () => {
  it("stores only deviceSid in settings and passHash in credential storage", async () => {
    const { credentials, patches, provider } = createHarness();

    await provider.save({ deviceSid: "sid-1", passHash: "hash-1" });

    expect(patches.at(-1)).toEqual({
      webRemoteControlExternalRelayDevice: { deviceSid: "sid-1" },
    });
    expect(credentials[WEB_REMOTE_CONTROL_EXTERNAL_RELAY_PASS_HASH_CREDENTIAL_KEY]).toBe("hash-1");
    expect(JSON.stringify(patches.at(-1))).not.toContain("hash-1");

    await expect(provider.load()).resolves.toEqual({
      deviceSid: "sid-1",
      passHash: "hash-1",
    });
  });

  it("clears partial persisted state and returns undefined", async () => {
    const { credentials, operations, patches, provider } = createHarness({
      recentProjects: [],
      locale: "zh-CN",
      webRemoteControlExternalRelayDevice: { deviceSid: "sid-1" },
    });

    credentials[WEB_REMOTE_CONTROL_EXTERNAL_RELAY_PASS_HASH_CREDENTIAL_KEY] = undefined;

    await expect(provider.load()).resolves.toBeUndefined();
    expect(operations).toContain(
      `delete:${WEB_REMOTE_CONTROL_EXTERNAL_RELAY_PASS_HASH_CREDENTIAL_KEY}`,
    );
    expect(patches.some((patch) => "webRemoteControlExternalRelayDevice" in patch)).toBe(
      true,
    );
  });

  it("rotates by deleting old credential before saving new auth", async () => {
    const { credentials, operations, provider } = createHarness({
      recentProjects: [],
      locale: "zh-CN",
      webRemoteControlExternalRelayDevice: { deviceSid: "old-sid" },
    });
    credentials[WEB_REMOTE_CONTROL_EXTERNAL_RELAY_PASS_HASH_CREDENTIAL_KEY] = "old-hash";

    await provider.rotate({ deviceSid: "new-sid", passHash: "new-hash" });

    expect(operations).toEqual([
      expect.stringContaining("patch:"),
      `delete:${WEB_REMOTE_CONTROL_EXTERNAL_RELAY_PASS_HASH_CREDENTIAL_KEY}`,
      expect.stringContaining("patch:"),
      `save:${WEB_REMOTE_CONTROL_EXTERNAL_RELAY_PASS_HASH_CREDENTIAL_KEY}:new-hash`,
    ]);
    expect(credentials[WEB_REMOTE_CONTROL_EXTERNAL_RELAY_PASS_HASH_CREDENTIAL_KEY]).toBe("new-hash");
  });

  it("redacts passHash in logs", async () => {
    const { logger, provider } = createHarness();

    await provider.save({ deviceSid: "device-sid-abcdef", passHash: "raw-secret-hash" });
    await provider.clear();

    const loggedText = JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls]);
    expect(loggedText).not.toContain("raw-secret-hash");
    expect(loggedText).toContain("hasPassHash");
    expect(loggedText).toContain("abcdef");
  });
});
