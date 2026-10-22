import type { WebRemoteControlDeviceStorage } from "#src/main/web-remote-relay/contract.js";
export async function restoreRegisteredDevice(storage: WebRemoteControlDeviceStorage) {
  await storage.clearLegacy();
  return storage.load();
}
