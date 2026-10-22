import { describe, expect, it } from "vitest";
import { sanitizeRemoteConnectionLog } from "../src/source-server/connectionLog.js";

describe("用户连接日志路径边界", () => {
  it.each([
    ["apiKey: test-key", "apiKey: [redacted]"],
    ['{"api_key":"test-key","status":"failed"}', '{"api_key":[redacted],"status":"failed"}'],
    ["client_secret=test-secret", "client_secret=[redacted]"],
    ["x-api-key: test-key", "x-api-key: [redacted]"],
    [
      "providerApiKey=test-key provider-secret=test-secret",
      "providerApiKey=[redacted] provider-secret=[redacted]",
    ],
    ["Authorization: Basic dXNlcjpwYXNz", "Authorization: [redacted]"],
    ["Authorization: Bearer test-token", "Authorization: [redacted]"],
    ["Cookie: session=first; other=second", "Cookie: [redacted]"],
    ['Cookie: "session=first"; other=second', "Cookie: [redacted]"],
    ['Authorization: "Basic first" trailing-secret', "Authorization: [redacted]"],
    ["Set-Cookie: session=first; Path=/; HttpOnly", "Set-Cookie: [redacted]"],
    [
      '{"authorization":"Basic dXNlcjpwYXNz","cookie":"a=first; b=second"}',
      '{"authorization":[redacted],"cookie":[redacted]}',
    ],
    [
      '{"api_key":"prefix\\\"suffix","status":"failed"}',
      '{"api_key":[redacted],"status":"failed"}',
    ],
    ["Basic dXNlcjpwYXNz", "Basic [redacted]"],
    ["Bearer test-token", "Bearer [redacted]"],
    [
      "Authorization: Basic test-secret\r\nCookie: a=first; b=second\r\nprobe failed",
      "Authorization: [redacted]\r\nCookie: [redacted]\r\nprobe failed",
    ],
  ])("凭据日志 %s 不残留秘密且重复过滤幂等", (raw, expected) => {
    const result = sanitizeRemoteConnectionLog(raw);
    expect(result).toBe(expected);
    expect(sanitizeRemoteConnectionLog(result)).toBe(result);
  });

  it.each([
    "/home/dev/.zcode/server",
    "~/server",
    "C:\\Users\\dev\\server",
    "\\\\host\\share\\server",
  ])("遮蔽 %s 后仍保留失败原因", (path) => {
    expect(
      sanitizeRemoteConnectionLog(`Installing ZCode Server to ${path} failed with exit code 1`),
    ).toBe("Installing ZCode Server to [redacted-path] failed with exit code 1");
  });

  it.each([
    '"/home/dev/My Server"',
    "'/home/dev/My Server'",
    '"C:\\Users\\Some Name\\server"',
    "'\\\\host\\Shared Folder\\server'",
  ])("整体遮蔽带引号空格路径 %s", (path) => {
    expect(sanitizeRemoteConnectionLog(`Installing to ${path} failed with exit code 1`)).toBe(
      "Installing to [redacted-path] failed with exit code 1",
    );
  });

  it("已知秘密按完整 token 遮蔽，重复过滤不破坏诊断", () => {
    const raw = "File /tmp/server failed with exit code 1 password=prefixdevsuffix";
    const result = sanitizeRemoteConnectionLog(raw, ["dev"]);
    expect(result).toBe("File [redacted-path] failed with exit code 1 password=[redacted]");
    expect(sanitizeRemoteConnectionLog(result)).toBe(result);
    expect(sanitizeRemoteConnectionLog("auth dev failed: 'dev', (dev)", ["dev"])).toBe(
      "auth [redacted] failed: '[redacted]', ([redacted])",
    );
  });

  it("短密码出现在普通单词内部时不替换，避免从固定文案反推出密码", () => {
    expect(sanitizeRemoteConnectionLog("Checking the remote device", ["dev"])).toBe(
      "Checking the remote device",
    );
    // 中文没有空格分词，紧邻中文仍视为独立 token，必须遮蔽。
    expect(sanitizeRemoteConnectionLog("使用密码dev登录失败", ["dev"])).toBe(
      "使用密码[redacted]登录失败",
    );
  });

  it("秘密两端是标点时，紧邻单词字符仍会被遮蔽", () => {
    expect(sanitizeRemoteConnectionLog("login x!p@ss! end", ["!p@ss!"])).toBe(
      "login x[redacted] end",
    );
  });

  it("没有引号的空格路径仍保守过滤，只保留可明确界定的诊断后缀", () => {
    expect(
      sanitizeRemoteConnectionLog("Installing /home/dev/My Private Server failed with exit code 1"),
    ).toBe("Installing [redacted-path] failed with exit code 1");
    expect(sanitizeRemoteConnectionLog("File C:\\Users\\Private Name\\Project Files")).toBe(
      "File [redacted-path]",
    );
  });

  it.each([
    "C:\\Users\\Doe, Jane\\secret",
    "C:\\Users\\Secret (Private)\\token",
    "\\\\host\\private;folder\\secret",
  ])("Windows/UNC 的合法标点不能被当作路径边界：%s", (path) => {
    expect(sanitizeRemoteConnectionLog(`File ${path} failed with exit code 1`)).toBe(
      "File [redacted-path] failed with exit code 1",
    );
  });

  it("日志生产者的 JSON 路径转义不会提前结束脱敏边界", () => {
    const path = '/home/dev/private "quoted" directory';
    expect(
      sanitizeRemoteConnectionLog(`File ${JSON.stringify(path)} failed with exit code 1`),
    ).toBe("File [redacted-path] failed with exit code 1");
  });
});
