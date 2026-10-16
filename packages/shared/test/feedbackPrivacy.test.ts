import { describe, expect, it } from "vitest";
import { redactFeedbackText } from "../src/feedbackPrivacy.js";

describe("反馈文本脱敏", () => {
  it.each([false, true])("diagnostic=%s 隐藏路径型凭据，包括嵌套 JSON 和编码路径", (diagnostic) => {
    const urls = [
      "https://hooks.slack.com/services/T000/B000/slack-canary",
      "https://example.webhook.office.com/webhookb2/teams-canary/IncomingWebhook/key",
      "https://example.com/password-reset/reset-canary",
      "https://example.com/invite/invite-canary",
      "https://example.com/callback/callback-canary",
      "https://example.com/download/download-canary",
      "https://example.com/%72eset/encoded-canary",
      "https://files.example.com/object-canary?X-Amz-Signature=signature-canary",
      "https://files.example.com/object-canary?sig=signature-canary",
    ];
    for (const url of urls) {
      for (const source of [`请求失败 ${url}`, JSON.stringify({ detail: { url } })]) {
        const output = redactFeedbackText(source, { diagnostic });
        expect(output).not.toContain("canary");
        expect(output).toContain(new URL(url).host);
        expect(redactFeedbackText(output, { diagnostic })).toBe(output);
      }
    }
  });

  it("诊断隐藏未知路径，用户正文保留普通排障链接", () => {
    const url = "https://example.com:8443/project/opaque-canary?view=details#section";
    expect(redactFeedbackText(url, { diagnostic: true })).toBe(
      "https://example.com:8443/[REDACTED]",
    );
    expect(redactFeedbackText(url)).toBe("https://example.com:8443/project/opaque-canary");
    expect(redactFeedbackText("https://example.com/")).toBe("https://example.com/");
    expect(redactFeedbackText("https://example.com/%invalid/opaque-canary")).not.toContain(
      "canary",
    );
  });

  it("递归清洗嵌套 JSON 和字符串中的密钥，同时保留诊断元数据", () => {
    const source = JSON.stringify({
      event: "failure",
      config: { apiKey: "nested-canary" },
      note: "API_KEY=embedded-canary",
      request: { messages: [{ content: "private-prompt" }] },
      toolOutput: "private-file",
      status: 401,
    });
    const output = redactFeedbackText(source, { diagnostic: true });
    for (const secret of ["nested-canary", "embedded-canary", "private-prompt", "private-file"]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain("failure");
    expect(output).toContain("401");
  });
  it("覆盖日志前缀、转义字符串、URL、私钥和用户路径", () => {
    const source =
      '[ERROR] {"outer":{"token":"json-canary"},"note":"Authorization: Bearer bearer-canary"}\n' +
      "url=https://user:password-canary@example.com/path?api_key=query-canary\n" +
      "-----BEGIN PRIVATE KEY-----\npem-canary\n-----END PRIVATE KEY-----\n" +
      "/Users/alice/private/work.ts C:\\Users\\bob\\private\\file.txt";
    const output = redactFeedbackText(source, { diagnostic: true });
    for (const secret of [
      "json-canary",
      "bearer-canary",
      "password-canary",
      "query-canary",
      "pem-canary",
      "alice",
      "bob",
    ]) {
      expect(output).not.toContain(secret);
    }
  });
  it("版本号和普通文本保持原样，Basic 认证整段清洗", () => {
    expect(redactFeedbackText("1.0")).toBe("1.0");
    expect(redactFeedbackText("Authorization: Basic basic-canary")).not.toContain("basic-canary");
  });
  it("用户正文保留内容意图，仍清除已知凭证", () => {
    expect(redactFeedbackText("我的 content 字段坏了，API_KEY=user-canary")).toContain(
      "我的 content 字段坏了",
    );
    expect(redactFeedbackText("我的 content 字段坏了，API_KEY=user-canary")).not.toContain(
      "user-canary",
    );
  });

  it.each([false, true])("diagnostic=%s 清洗嵌入字符串和同行所有 JSON 片段", (diagnostic) => {
    const source = [
      JSON.stringify({ error: 'failed config: {"apiKey":"nested-canary"}', status: 500 }),
      '[info] {"apiKey":"prefix-canary"} {"status":401}',
      '[info] {"cookie":"cookie-canary"} trailing text',
    ].join("\n");
    const output = redactFeedbackText(source, { diagnostic });
    expect(output).not.toContain("canary");
    expect(output).toContain("500");
    expect(output).toContain("401");
    expect(output).toContain("trailing text");
  });

  it.each(["cookie", "passwd", "passphrase", "privateKey", "access_key", "api\\u004bey"])(
    "%s 在多行及截断结构中仍脱敏",
    (key) => {
      for (const source of [
        `[info] config {\n  "${key}": "pretty-canary"\n}`,
        `{"${key}":"truncated-canary`,
        `"${key}":"bare-canary`,
        `[info] {"${key}": {\n "value": "nested-canary"\n`,
      ]) {
        expect(redactFeedbackText(source)).not.toContain("canary");
      }
    },
  );

  it.each(["input", "output", "args", "env", "headers", "stdout", "data", "params"])(
    "%s 的正文只在诊断模式清洗，兼容多行和截断",
    (key) => {
      for (const source of [
        `[info] details {\n "${key}": {"value":"body-canary"}\n}`,
        `[info] details {\n "${key}": {\n "value":"body-canary"`,
        `${key}: body-canary with spaces`,
      ]) {
        expect(redactFeedbackText(source, { diagnostic: true })).not.toContain("body-canary");
        expect(redactFeedbackText(source)).toContain("body-canary");
      }
    },
  );

  it("括号和转义引号不破坏片段边界，普通日志保留", () => {
    const source = '[info] {"note":"a } and \\\" quote","status":200} [done]';
    expect(redactFeedbackText(source, { diagnostic: true })).toBe(source);
  });

  it("普通凭据中的括号与已脱敏标记不能掩盖其他字段", () => {
    for (const source of [
      'password="first{canary}last"',
      "Bearer first[canary]last",
      "token=known passphrase=other-canary",
      "passphrase=[REDACTED]canary",
    ]) {
      expect(redactFeedbackText(source)).not.toContain("canary");
    }
    expect(
      redactFeedbackText("input: first [canary] last-canary", { diagnostic: true }),
    ).not.toContain("canary");
  });
});
