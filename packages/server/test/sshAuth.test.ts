import { afterEach, describe, expect, it } from "vitest";
import {
  buildSSHConnectConfig,
  createKeyboardInteractiveResponder,
  normalizeSSHConnectError,
} from "../src/remote/sshAuth.js";

const originalAuthSock = process.env["SSH_AUTH_SOCK"];

afterEach(() => {
  if (originalAuthSock == null) {
    delete process.env["SSH_AUTH_SOCK"];
    return;
  }
  process.env["SSH_AUTH_SOCK"] = originalAuthSock;
});

describe("sshAuth", () => {
  it("密码登录时默认禁用隐式 agent，并启用 keyboard-interactive", () => {
    process.env["SSH_AUTH_SOCK"] = "/tmp/test.sock";
    const config = buildSSHConnectConfig({
      host: "example.com",
      username: "root",
      password: "secret",
    });

    expect(config.agent).toBeUndefined();
    expect(config.tryKeyboard).toBe(true);
    expect(config.password).toBe("secret");
  });

  it("无密码时保留隐式 agent", () => {
    process.env["SSH_AUTH_SOCK"] = "/tmp/test.sock";
    const config = buildSSHConnectConfig({
      host: "example.com",
      username: "root",
    });

    expect(config.agent).toBe("/tmp/test.sock");
    expect(config.tryKeyboard).toBe(false);
  });

  it("显式传入 agent 时应覆盖默认策略", () => {
    const config = buildSSHConnectConfig({
      host: "example.com",
      username: "root",
      password: "secret",
      agent: "/tmp/custom.sock",
    });

    expect(config.agent).toBe("/tmp/custom.sock");
  });

  it("连接配置应显式设置 readyTimeout 和 keepalive，避免静默断连长期悬挂", () => {
    const config = buildSSHConnectConfig({
      host: "example.com",
      username: "root",
    });

    expect(config.readyTimeout).toBe(60_000);
    expect(config.keepaliveInterval).toBe(15_000);
    expect(config.keepaliveCountMax).toBe(3);
  });

  it("私钥口令只用于解密私钥，不应改变密码登录分支判断", () => {
    process.env["SSH_AUTH_SOCK"] = "/tmp/test.sock";
    const config = buildSSHConnectConfig({
      host: "example.com",
      username: "root",
      privateKey: "test-private-key",
      passphrase: "key-secret",
    });

    expect(config.passphrase).toBe("key-secret");
    expect(config.agent).toBe("/tmp/test.sock");
    expect(config.tryKeyboard).toBe(false);
    expect(config.password).toBeUndefined();
  });

  it("keyboard-interactive 回调应使用同一密码响应全部 prompt", () => {
    const responder = createKeyboardInteractiveResponder("secret");
    let responses: string[] = [];
    responder(
      "",
      "",
      "",
      [
        { prompt: "Password:", echo: false },
        { prompt: "OTP:", echo: false },
      ],
      (nextResponses) => {
        responses = nextResponses;
      },
    );

    expect(responses).toEqual(["secret", "secret"]);
  });

  it("client-authentication 错误应转换为可读信息", () => {
    const error = normalizeSSHConnectError({ level: "client-authentication" });
    expect(error.message).toContain("SSH 认证失败");
  });

  it("client-timeout 错误应说明是 SSH 连接握手超时", () => {
    const error = normalizeSSHConnectError({ level: "client-timeout" });
    expect(error.message).toBe(
      "SSH 连接握手超时：未能在 60 秒内建立 SSH 会话，请检查网络、服务器 SSH 服务或终端 SSH 配置差异",
    );
  });

  it("私钥缺少口令的错误文案变体应统一转换为可读提示", () => {
    const expectedMessage = "SSH 私钥需要口令：检测到加密私钥，但当前未提供私钥口令";
    const cases = [
      "Encrypted private OpenSSH key detected, but no passphrase given",
      "Encrypted OpenSSH private key detected, but no passphrase given",
      "Encrypted PPK private key detected, but no passphrase given",
    ];

    for (const message of cases) {
      expect(normalizeSSHConnectError(new Error(message)).message).toBe(expectedMessage);
    }
  });

  it("私钥口令错误应转换为可读提示", () => {
    const expectedMessage = "SSH 私钥口令错误：无法解密私钥，请检查私钥口令是否正确";
    const cases = [
      "OpenSSH key integrity check failed -- bad passphrase?",
      "PPK private key integrity check failed -- bad passphrase?",
    ];

    for (const message of cases) {
      expect(normalizeSSHConnectError(new Error(message)).message).toBe(expectedMessage);
    }
  });
});
