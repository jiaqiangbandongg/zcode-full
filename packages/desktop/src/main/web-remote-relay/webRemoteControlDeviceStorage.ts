import type { AppSettings } from "@zcode/shared";

import type { WebRemoteControlDeviceStorage } from "#src/main/web-remote-relay/contract.js";

export function createWebRemoteControlDeviceStorage(dependencies: {
  loadSettings(): Promise<AppSettings>;
  patchSettings(patch: Partial<AppSettings>): Promise<void>;
  deleteLegacyCredential(): Promise<void>;
}): WebRemoteControlDeviceStorage {
  let migration: Promise<void> | undefined;
  return {
    load: async () => (await dependencies.loadSettings()).webRemoteControlRelayV2Device,
    save: (device) => dependencies.patchSettings({ webRemoteControlRelayV2Device: device }),
    clearLegacy: () => {
      migration ??= (async () => {
        await dependencies.deleteLegacyCredential();
        await dependencies.patchSettings({ webRemoteControlExternalRelayDevice: undefined });
      })().catch((error) => {
        migration = undefined;
        throw error;
      });
      return migration;
    },
  };
}
