import type { WebRemoteControlDeviceNavigation } from "@/web-remote-control/contract.js";
export function deviceNavigation(chooseOtherDevice: () => void): WebRemoteControlDeviceNavigation {
  return { deviceName: "Example computer", chooseOtherDevice };
}
