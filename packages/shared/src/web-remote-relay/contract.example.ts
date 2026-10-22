import { parseWebRemoteControlRelayV2IncomingMessage } from "#src/web-remote-relay/contract.js";
export const matchedDevice = parseWebRemoteControlRelayV2IncomingMessage({
  type: "auth_ack",
  device_sid: "device-example",
  pair_status: "matched",
});
