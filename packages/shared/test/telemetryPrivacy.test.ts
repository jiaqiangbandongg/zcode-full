import { describe, expect, it } from "vitest";
import { sanitizeTelemetryEventDetail } from "@zcode/shared";

describe("telemetry privacy boundary", () => {
  it.each([
    [
      "https://user:secret@LOGIN.Example.com:8443/authorize?token=secret#state",
      "login.example.com",
    ],
    ["http://127.0.0.1:3000/login?state=secret", "127.0.0.1"],
    ["https://[::1]:3000/login?state=secret", "[::1]"],
    ["login.example.com", "login.example.com"],
    ["file:///Users/private/key", ""],
    ["javascript:secret", ""],
    ["not a url", ""],
    ["", ""],
  ])("login_url 只保留 hostname：%s", (value, expected) => {
    const detail = { login_url: value };
    const safe = sanitizeTelemetryEventDetail("app_login_ck", detail);
    expect(safe).toEqual({ login_url: expected });
    expect(sanitizeTelemetryEventDetail("app_login_ck", safe)).toEqual(safe);
    expect(detail.login_url).toBe(value);
  });

  it.each([
    "Authorization: Bearer FAKE_SECRET",
    '{"Authorization":"Basic FAKE_SECRET","api_key":"FAKE_SECRET"}',
    "https://user:secret@example.com/private?token=FAKE_SECRET#secret",
    "C:\\Users\\private person\\secret.txt",
    "/Users/private person/secret.txt",
    "/home/private/secret.txt",
    "\\\\host\\private\\secret.txt",
    "~/.ssh/id_rsa",
    "-----BEGIN PRIVATE KEY-----\nFAKE_SECRET\n-----END PRIVATE KEY-----",
    "unknown-format-secret-without-any-keyword",
    "ordinary error",
    " ",
  ])("所有非空错误原文都丢弃：%s", (error) => {
    expect(sanitizeTelemetryEventDetail("future_event", { error_msg: error })).toEqual({
      error_msg: "[redacted]",
    });
  });

  it("保留空值、缺失、分类字段及调用方原对象", () => {
    const detail = Object.freeze({
      error_msg: "secret",
      error_type: "TOOL_EXEC_ERROR",
      status: "fail",
    });
    const safe = sanitizeTelemetryEventDetail("agent_step", detail);
    expect(safe).toEqual({ ...detail, error_msg: "[redacted]" });
    expect(detail.error_msg).toBe("secret");
    expect(sanitizeTelemetryEventDetail("agent_step", safe)).toEqual(safe);
    expect(sanitizeTelemetryEventDetail("agent_step", { error_msg: "" })).toEqual({
      error_msg: "",
    });
    expect(sanitizeTelemetryEventDetail("session_create", { create_source: "session" })).toEqual({
      create_source: "session",
    });
  });
});
