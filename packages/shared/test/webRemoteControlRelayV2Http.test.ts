import { expect, it } from "vitest";
import {
  parseWebRemoteControlRelayV2HttpRequest,
  parseWebRemoteControlRelayV2HttpResponse,
} from "@zcode/shared/web-remote-relay";

it("accepts device/token HTTP contracts and the server's omitted null data", () => {
  const device = {
    device_sid: "d_1",
    device_mid: "machine-1",
    created_at: 1_600_000_000,
    online: false,
    meta: {},
  };
  for (const [operation, body] of [
    ["register", { device_mid: "machine-1" }],
    ["list", {}],
    ["delete", { device_sid: "d_1" }],
    ["token", { role: "device" }],
    ["token", { role: "terminal" }],
  ] as const)
    expect(parseWebRemoteControlRelayV2HttpRequest(operation, body)).toEqual(body);
  for (const [operation, data] of [
    ["register", device],
    ["list", [device]],
    ["delete", null],
    ["token", { token: "AAAAAAAAAAAAAAAAAAAAAA", expires_in: 60 }],
  ] as const) {
    const body = { code: 0, msg: "", data };
    expect(parseWebRemoteControlRelayV2HttpResponse(operation, body)).toEqual(body);
    expect(
      parseWebRemoteControlRelayV2HttpResponse(operation, { code: 401, msg: "unauthorized" }),
    ).toEqual({ code: 401, msg: "unauthorized" });
  }
  expect(parseWebRemoteControlRelayV2HttpResponse("delete", { code: 0, msg: "" })).toEqual({
    code: 0,
    msg: "",
  });
});

it("拒绝请求中的未知身份字段和响应中的非法业务数据", () => {
  for (const [operation, body] of [
    ["register", { device_mid: "  " }],
    ["register", { device_mid: "a".repeat(129) }],
    ["register", { device_mid: "mid", user_id: "victim" }],
    ["register", { device_mid: "mid", meta: {} }],
    ["list", { user_id: "victim" }],
    ["delete", { device_sid: " " }],
    ["token", { role: "admin" }],
    ["token", { role: "device", device_sid: "d_1" }],
  ] as const)
    expect(parseWebRemoteControlRelayV2HttpRequest(operation, body)).toBeNull();
  for (const [operation, body] of [
    ["register", { code: 0, msg: "", data: {} }],
    ["list", { code: 0, msg: "", data: {} }],
    ["delete", { code: 0, msg: "", data: true }],
    ["token", { code: 0, msg: "", data: { token: "invalid", expires_in: 60 } }],
    ["token", { code: 0, msg: "", data: { token: "AAAAAAAAAAAAAAAAAAAAAA", expires_in: 0 } }],
    ["token", { code: 0, msg: "" }],
    ["token", { code: "0", msg: "", data: null }],
  ] as const)
    expect(parseWebRemoteControlRelayV2HttpResponse(operation, body)).toBeNull();
});

it("忽略 HTTP 信封和嵌套数据的新增字段，仅返回已声明字段", () => {
  const device = {
    device_sid: "d_1",
    device_mid: "machine-1",
    created_at: 1_600_000_000,
    online: false,
    meta: {},
  };
  const extendedDevice = { ...device, capabilities: ["remote"], meta: { arch: "arm64" } };
  const token = { token: "AAAAAAAAAAAAAAAAAAAAAA", expires_in: 60 };
  for (const [operation, data, expectedData] of [
    ["register", extendedDevice, device],
    ["list", [extendedDevice], [device]],
    ["delete", null, null],
    ["token", { ...token, token_version: 3 }, token],
  ] as const) {
    const logid = { trace: "request-1" };
    expect(
      parseWebRemoteControlRelayV2HttpResponse(operation, {
        code: 0,
        msg: "",
        data,
        logid,
        server_version: "next",
      }),
    ).toEqual({ code: 0, msg: "", data: expectedData });
    for (const body of [
      { code: 1006, msg: "no permission" },
      { code: 1006, msg: "no permission", data: null },
    ]) {
      expect(
        parseWebRemoteControlRelayV2HttpResponse(operation, { ...body, logid, retry_after: 5 }),
      ).toEqual(body);
    }
  }
  const deleted = { code: 0, msg: "", logid: "request-1" };
  expect(parseWebRemoteControlRelayV2HttpResponse("delete", deleted)).toEqual({ code: 0, msg: "" });
  for (const data of [
    { ...extendedDevice, device_sid: undefined },
    { ...extendedDevice, online: "false" },
    { ...extendedDevice, meta: { name: 123, arch: "arm64" } },
  ]) {
    expect(parseWebRemoteControlRelayV2HttpResponse("register", { ...deleted, data })).toBeNull();
  }
});

it("counts HTTP identifiers as characters while WS SID uses UTF-8 bytes", () => {
  const body = { device_mid: "😀".repeat(128) };
  expect(parseWebRemoteControlRelayV2HttpRequest("register", body)).toEqual(body);
  expect(
    parseWebRemoteControlRelayV2HttpRequest("register", { device_mid: "😀".repeat(129) }),
  ).toBeNull();
});
