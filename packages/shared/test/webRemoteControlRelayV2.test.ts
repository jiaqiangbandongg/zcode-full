import { describe, expect, it } from "vitest";
import {
  parseWebRemoteControlRelayV2OutgoingMessage,
  parseWebRemoteControlRelayV2IncomingMessage,
} from "@zcode/shared/web-remote-relay";

describe("Relay V2 wire contract", () => {
  it("accepts auth_init without a role and rejects V1 identity fields", () => {
    const auth = {
      type: "auth_init",
      device_sid: "d_1",
      meta: { name: "桌面" },
      client_ts: 1_600_000_000,
    };
    expect(parseWebRemoteControlRelayV2OutgoingMessage(auth)).toEqual(auth);
    expect(parseWebRemoteControlRelayV2OutgoingMessage({ ...auth, role: "device" })).toBeNull();
    expect(parseWebRemoteControlRelayV2OutgoingMessage({ ...auth, user_id: "other" })).toBeNull();
  });
});

it("validates message direction, seconds and opaque JSON payloads", () => {
  const samples = [
    { type: "pair_status_query", client_ts: 1_600_000_000 },
    { type: "data", payload: { device_sid: "opaque", nested: [null, true, 1] } },
    { type: "data", payload: null },
  ];
  for (const sample of samples)
    expect(parseWebRemoteControlRelayV2OutgoingMessage(sample)).toEqual(sample);
  for (const invalid of [
    { type: "pair_status_query", device_sid: "d_1" },
    { type: "pair_status_query", client_ts: 1_600_000_000_000 },
    { type: "pair_status_query", client_ts: 1.5 },
    { type: "pair_status_query", client_ts: -1 },
    { type: "auth_init", device_sid: " " },
    { type: "auth_init", device_sid: "中".repeat(43) },
    { type: "auth_init", device_sid: "d_1", meta: { extra: 1 } },
    { type: "data" },
    { type: "data", payload: undefined },
    { type: "data", payload: { nested: () => 1 } },
    { type: "data", payload: "hello", server_ts: 1 },
    { type: "device_register_init" },
    null,
    [],
    "not decoded JSON",
  ])
    expect(parseWebRemoteControlRelayV2OutgoingMessage(invalid)).toBeNull();
});

it("accepts server ACKs/errors and rejects wrong direction or invalid status", () => {
  for (const sample of [
    {
      type: "auth_ack",
      device_sid: "d_1",
      terminal_sid: "",
      pair_status: "waiting",
      server_ts: 1_600_000_000,
    },
    { type: "pair_status_ack", terminal_sid: "t_1", pair_status: "matched" },
    { type: "data", payload: ["unchanged", null], server_ts: 1_600_000_000 },
    ...["AUTH_FAILED", "WRONG_PARAM", "KICKED", "INTERNAL", "DEVICE_OFFLINE"].map((code) => ({
      type: "error",
      code,
    })),
    { type: "error", code: "INTERNAL", message: "unavailable" },
  ])
    expect(parseWebRemoteControlRelayV2IncomingMessage(sample)).toEqual(sample);
  for (const invalid of [
    { type: "auth_ack", device_sid: "d_1", pair_status: "kicked" },
    { type: "auth_ack", pair_status: "matched" },
    { type: "pair_status_ack", pair_status: "waiting", device_sid: "d_1" },
    { type: "data", payload: {}, client_ts: 1 },
    { type: "data" },
    { type: "error", code: "UNAUTHORIZED" },
    { type: "error", code: "INTERNAL", message: 123 },
    { type: "error", code: "INTERNAL", server_ts: Infinity },
    { type: "auth_challenge", nonce: "v1" },
  ])
    expect(parseWebRemoteControlRelayV2IncomingMessage(invalid)).toBeNull();
});
