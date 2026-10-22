import { expect, it } from "vitest";
import {
  buildWebRemoteControlExternalQrUrl,
  parseWebRemoteControlExternalQrParams,
} from "@zcode/shared";
import {
  getWebRemoteControlHeartbeatDelayMs,
  WEB_REMOTE_CONTROL_V2_HEARTBEAT_INTERVAL_MS,
  WEB_REMOTE_CONTROL_V2_HEARTBEAT_JITTER_MS,
} from "@zcode/shared/web-remote-relay";

it("builds V2 links without secrets, including removal of stale base URL credentials", () => {
  const url = buildWebRemoteControlExternalQrUrl({
    baseUrl: "https://zcode.z.ai/remote/v4?hash=old&t=123",
    deviceSid: "d_1",
    deviceMid: "mid-1",
    deviceName: "我的桌面",
    appVersion: "3.13.0",
  });
  const params = new URL(url).searchParams;
  expect([...params.keys()]).toEqual(["sid", "mid", "name", "app_version"]);
  expect(parseWebRemoteControlExternalQrParams(params)).toEqual({
    deviceSid: "d_1",
    deviceMid: "mid-1",
    deviceName: "我的桌面",
    appVersion: "3.13.0",
  });
});

it("accepts every V2 routing hint independently or none and rejects legacy credentials", () => {
  for (const [query, result] of [
    ["", {}],
    ["sid=d_1", { deviceSid: "d_1" }],
    ["mid=m1", { deviceMid: "m1" }],
    ["name=Desk", { deviceName: "Desk" }],
    ["app_version=3.13.0", { appVersion: "3.13.0" }],
    ["sid=%20&name=%20", {}],
  ] as const)
    expect(parseWebRemoteControlExternalQrParams(new URLSearchParams(query))).toEqual(result);
  for (const query of ["sid=d_1&hash=secret&t=123", "hash=", "t=123"]) {
    expect(parseWebRemoteControlExternalQrParams(new URLSearchParams(query))).toBeNull();
  }
});

it("uses the V2 heartbeat bounds as the helper defaults", () => {
  expect(
    getWebRemoteControlHeartbeatDelayMs(
      WEB_REMOTE_CONTROL_V2_HEARTBEAT_INTERVAL_MS,
      WEB_REMOTE_CONTROL_V2_HEARTBEAT_JITTER_MS,
      () => 0,
    ),
  ).toBe(4_000);
  expect(
    getWebRemoteControlHeartbeatDelayMs(
      WEB_REMOTE_CONTROL_V2_HEARTBEAT_INTERVAL_MS,
      WEB_REMOTE_CONTROL_V2_HEARTBEAT_JITTER_MS,
      () => 1,
    ),
  ).toBe(6_000);
  expect(getWebRemoteControlHeartbeatDelayMs(undefined, undefined, () => 0.5)).toBe(5_000);
});
