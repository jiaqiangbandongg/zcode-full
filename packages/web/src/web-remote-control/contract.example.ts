import type { WebRemoteControlEntryView } from "#src/web-remote-control/contract.js";
export const emptyDeviceList: WebRemoteControlEntryView = {
  kind: "devices",
  devices: [],
  loading: false,
  error: false,
};
