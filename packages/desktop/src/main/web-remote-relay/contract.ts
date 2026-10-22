import type { AppSettings, WebRemoteControlAppPayload } from "@zcode/shared";
import type { WebRemoteControlRelayV2Meta } from "@zcode/shared/web-remote-relay";

export type WebRemoteControlRegisteredDevice = NonNullable<
  AppSettings["webRemoteControlRelayV2Device"]
>;
export interface WebRemoteControlDeviceStorage {
  load(): Promise<WebRemoteControlRegisteredDevice | undefined>;
  save(device: WebRemoteControlRegisteredDevice): Promise<void>;
  clearLegacy(): Promise<void>;
}

export interface WebRemoteControlLogin {
  userId: string;
  jwt: string;
}

export type WebRemoteControlDeviceTransportState =
  | "idle"
  | "connecting"
  | "authenticating"
  | "waiting_terminal"
  | "paired"
  | "kicked"
  | "error";

export interface WebRemoteControlDeviceTransportOptions {
  relayWsUrl: string;
  deviceMid: string;
  meta: WebRemoteControlRelayV2Meta;
  getToken(signal: AbortSignal): Promise<string>;
  resolveDeviceSid(signal: AbortSignal, forceRegistration: boolean): Promise<string>;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  onStateChange(state: WebRemoteControlDeviceTransportState): void;
  onPayload(payload: WebRemoteControlAppPayload): void;
  onRawTransportPayload?(payload: unknown): boolean;
  onRawTransportFault?(reasonCode: string): void;
  onError(error: Error): void;
  onSendReady?(event: { kind: "same-socket" | "reconnected-socket" }): void;
}
