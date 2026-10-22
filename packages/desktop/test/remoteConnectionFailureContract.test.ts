import { describe, expect, it } from "vitest";
import {
  hostRemoteWorkspaceConnectFailedResponseSchema,
  publicZCodeErrorCodeSchema,
  normalizeRemoteConnectionError,
} from "@zcode/shared";

describe("连接失败的 Host/App 契约", () => {
  it("携带未知 cause 的公开认证码不被预检阶段覆盖", () => {
    const error = Object.assign(new Error("SSH 认证失败", { cause: new Error("opaque cause") }), {
      code: "remote-authentication-failed",
    });
    const failure = normalizeRemoteConnectionError(error, "preflight");
    expect(failure.code).toBe("remote-authentication-failed");
    expect(
      hostRemoteWorkspaceConnectFailedResponseSchema.safeParse({
        type: "remote-workspace-connect-failed",
        requestId: "auth",
        error: failure.message,
        reasonCode: failure.code,
      }).success,
    ).toBe(true);
  });
  it("预检阶段不抢先认领未知子错误，仍能找到后面的系统错误", () => {
    const error = new AggregateError(
      [
        new Error("opaque cause"),
        Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }),
      ],
      "Failed /Users/private/project",
    );
    expect(normalizeRemoteConnectionError(error, "preflight")).toMatchObject({
      code: "remote-host-unreachable",
      message: "Failed [redacted-path]",
    });
  });
  it("阶段包装保留内层网络分类，不将阶段码视为已确认领域原因", () => {
    const error = Object.assign(
      new Error("probe failed", {
        cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
      }),
      { code: "remote-preflight-failed" },
    );
    expect(normalizeRemoteConnectionError(error, "preflight").code).toBe("remote-host-unreachable");
  });
  it.each([
    [
      new AggregateError([Object.assign(new Error(""), { code: "ECONNREFUSED" })]),
      "remote-host-unreachable",
    ],
    [Object.assign(new Error(""), { code: "ETIMEDOUT" }), "remote-connection-timeout"],
    [Object.assign(new Error(""), { code: "ENOTFOUND" }), "remote-host-not-found"],
    [new Error(""), "remote-connection-unknown"],
    [new Error("\u001b[31m"), "remote-connection-unknown"],
    [{ code: "private-code", message: "" }, "remote-connection-unknown"],
  ])("空消息和嵌套错误均可经过 Host schema 返回", (error, code) => {
    const result = normalizeRemoteConnectionError(error);
    expect(result.code).toBe(code);
    expect(result.message.trim()).not.toBe("");
    expect(publicZCodeErrorCodeSchema.parse(result.code)).toBe(code);
    expect(
      hostRemoteWorkspaceConnectFailedResponseSchema.safeParse({
        type: "remote-workspace-connect-failed",
        requestId: "request",
        error: result.message,
        reasonCode: result.code,
      }).success,
    ).toBe(true);
  });
  it.each([
    ["ENOSPC", "remote-space-insufficient"],
    ["EACCES", "remote-permission-denied"],
    ["ABORT_ERR", "remote-connection-canceled"],
    ["ERR_SSH_HOST_KEY_MISMATCH", "remote-host-key-changed"],
  ])("识别系统错误 %s", (code, expected) => {
    expect(normalizeRemoteConnectionError({ code, message: "failure" }).code).toBe(expected);
  });
  it("探测阶段的 socket 中断按网络不可达分类，不冒充预检失败", () => {
    // 在线断连后的自动恢复经由懒连接 probe 抛出 ECONNRESET；它是传输失败，不是部署前置条件失败。
    const error = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
      syscall: "read",
    });
    expect(normalizeRemoteConnectionError(error, "preflight").code).toBe("remote-host-unreachable");
    expect(normalizeRemoteConnectionError(new Error("read ECONNRESET"), "preflight").code).toBe(
      "remote-host-unreachable",
    );
  });
  it.each(["download", "upload", "preflight", "install"])("%s 失败保留阶段", (phase) => {
    expect(normalizeRemoteConnectionError(new Error("failed"), phase).code).toBe(
      `remote-${phase}-failed`,
    );
  });
});
