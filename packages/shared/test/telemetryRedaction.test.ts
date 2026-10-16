import { describe, expect, it } from "vitest";
import {
  OFFICIAL_GLM_MODEL_IDS,
  TELEMETRY_SAFE_BUILTIN_MODEL_IDS,
  redactTelemetryText,
  redactTelemetryUrl,
  resolveTelemetryProviderScope,
  resolveTelemetryModelId,
  sanitizeTelemetryModelValue,
} from "@zcode/shared";

describe("redactTelemetryText", () => {
  it("把 POSIX 绝对路径归一为占位符，不保留用户名", () => {
    const redacted = redactTelemetryText(
      "ENOENT: no such file or directory, open '/Users/alice/project/src/index.ts'",
    );
    expect(redacted).not.toContain("alice");
    expect(redacted).not.toContain("/Users/");
    expect(redacted).toContain("{path}");
  });

  it("覆盖 /home、/root 与 macOS 临时目录", () => {
    const redacted = redactTelemetryText(
      "read /home/bob/.zcode failed; tmp /var/folders/xy/zz/T/zcode-123 missing",
    );
    expect(redacted).not.toContain("bob");
    expect(redacted).not.toContain("/var/folders");
  });

  it("把 Windows 盘符路径归一为占位符", () => {
    const redacted = redactTelemetryText(String.raw`EPERM C:\Users\carol\AppData\zcode\db.sqlite`);
    expect(redacted).not.toContain("carol");
    expect(redacted).toContain("{path}");
  });

  it("把邮箱归一为占位符", () => {
    expect(redactTelemetryText("login failed for dave@example.com")).toContain("{email}");
    expect(redactTelemetryText("login failed for dave@example.com")).not.toContain("dave@");
  });

  it("移除 URL 的 query 与 fragment，只保留 host 与归一化路由", () => {
    const redacted = redactTelemetryText(
      "GET https://api.example.com/v1/sessions/0f8fad5b-d9cb-469f-a165-70867728950e?token=abc#frag failed",
    );
    expect(redacted).not.toContain("token=abc");
    expect(redacted).not.toContain("0f8fad5b");
    expect(redacted).toContain("https://api.example.com/v1/sessions/{segment}");
  });

  it("遮盖 Authorization、Bearer 与赋值形态的凭据", () => {
    const redacted = redactTelemetryText(
      `authorization: Bearer abc.def.ghi, api_key="topsecretvalue", password=hunter2`,
    );
    expect(redacted).not.toContain("abc.def.ghi");
    expect(redacted).not.toContain("topsecretvalue");
    expect(redacted).not.toContain("hunter2");
  });

  it("遮盖常见密钥字面量", () => {
    const redacted = redactTelemetryText(
      "keys: sk-abcdefghijklmnopqrstuvwx ghp_abcdefghijklmnopqrstu AKIAIOSFODNN7EXAMPLE",
    );
    expect(redacted).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(redacted).not.toContain("ghp_abcdefghijklmnopqrstu");
    expect(redacted).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("按 maxLength 截断并保留头部", () => {
    const redacted = redactTelemetryText(`HEAD ${"x".repeat(5_000)}`, { maxLength: 100 });
    expect(redacted.length).toBe(100);
    expect(redacted.startsWith("HEAD ")).toBe(true);
  });

  it("空值与非字符串输入返回空串", () => {
    expect(redactTelemetryText("")).toBe("");
    expect(redactTelemetryText(undefined)).toBe("");
  });

  it("不改写普通诊断文本", () => {
    expect(redactTelemetryText("Cannot read properties of undefined (reading 'id')")).toBe(
      "Cannot read properties of undefined (reading 'id')",
    );
  });
});

describe("redactTelemetryUrl", () => {
  it("丢弃 query 与 fragment", () => {
    expect(redactTelemetryUrl("https://zcode.z.ai/api/v1/event/report?a=1&b=2#x")).toBe(
      "https://zcode.z.ai/api/v1/event/report",
    );
  });

  it("把 UUID、长 hash 与邮箱路由段归一", () => {
    expect(
      redactTelemetryUrl("https://h.test/u/eve@example.com/sessions/12345678901234567890"),
    ).toBe("https://h.test/u/{segment}/sessions/{segment}");
  });

  it("file:// 与本地路径归一为 local_file，不暴露目录", () => {
    expect(redactTelemetryUrl("file:///Users/frank/app/index.html")).toBe("local_file");
    expect(redactTelemetryUrl("/Users/frank/app/index.html")).toBe("local_file");
  });

  it("blob 与 data URL 只保留协议标记", () => {
    expect(redactTelemetryUrl("blob:file:///abc-def")).toBe("blob");
    expect(redactTelemetryUrl("data:image/png;base64,AAAA")).toBe("data");
  });

  it("无法解析时返回 unknown，不回退到原值", () => {
    expect(redactTelemetryUrl("!!!")).toBe("unknown");
    expect(redactTelemetryUrl("")).toBe("unknown");
  });
});

describe("resolveTelemetryProviderScope", () => {
  it("内置 provider 保留稳定 ID", () => {
    expect(resolveTelemetryProviderScope("account:zai-individual-coding-plan")).toEqual({
      providerId: "account:zai-individual-coding-plan",
      providerScope: "builtin",
    });
  });

  it("自定义 provider 归一为 custom，不泄露用户命名", () => {
    const resolved = resolveTelemetryProviderScope("我的内网代理");
    expect(resolved).toEqual({ providerId: "custom", providerScope: "custom" });
  });

  it("缺失 provider 时 scope 为 unknown", () => {
    expect(resolveTelemetryProviderScope(undefined)).toEqual({
      providerId: "",
      providerScope: "unknown",
    });
  });

  it("旧报表身份 builtin:* 是 ZCode 固定 ID，判为内置并原样保留", () => {
    // supervisor 投影 /report detail 时会把 account:* 映射成这些旧身份，plan_ttft / perf_ui_* 复用同一份 detail。
    for (const legacyId of [
      "builtin:zai",
      "builtin:bigmodel",
      "builtin:zai-coding-plan",
      "builtin:bigmodel-coding-plan",
      "builtin:zai-start-plan",
      "builtin:bigmodel-start-plan",
    ]) {
      expect(resolveTelemetryProviderScope(legacyId)).toEqual({
        providerId: legacyId,
        providerScope: "builtin",
      });
    }
  });

  it("未知的 builtin: 前缀不能借前缀混入内置", () => {
    expect(resolveTelemetryProviderScope("builtin:my-proxy")).toEqual({
      providerId: "custom",
      providerScope: "custom",
    });
  });
});

describe("TELEMETRY_SAFE_BUILTIN_MODEL_IDS", () => {
  it("覆盖官方 GLM 模型名单全部条目，旗舰模型不会被降级为 custom", () => {
    for (const id of OFFICIAL_GLM_MODEL_IDS) {
      expect(TELEMETRY_SAFE_BUILTIN_MODEL_IDS.has(id.toLowerCase())).toBe(true);
    }
    expect(TELEMETRY_SAFE_BUILTIN_MODEL_IDS.has("glm-5.3")).toBe(true);
    expect(TELEMETRY_SAFE_BUILTIN_MODEL_IDS.has("glm-5.3-flash")).toBe(true);
  });
});

describe("resolveTelemetryModelId", () => {
  it("内置 provider 下命中白名单的模型原样保留（小写）", () => {
    expect(resolveTelemetryModelId("builtin", "GLM-4.6")).toBe("glm-4.6");
  });

  it("内置 provider 下未命中白名单的模型降级为 custom", () => {
    expect(resolveTelemetryModelId("builtin", "glm-未来型号")).toBe("custom");
  });

  it("自定义 provider 的模型固定写 custom", () => {
    expect(resolveTelemetryModelId("custom", "internal-llm-v3")).toBe("custom");
  });

  it("scope 未知或模型缺失时留空", () => {
    expect(resolveTelemetryModelId("unknown", "glm-4.6")).toBe("");
    expect(resolveTelemetryModelId("builtin", undefined)).toBe("");
  });

  it("内置 provider 下的复合值与 custom: 编码值先剥出裸模型 ID 再查白名单", () => {
    expect(resolveTelemetryModelId("builtin", "builtin:zai-start-plan/GLM-5.3")).toBe("glm-5.3");
    expect(resolveTelemetryModelId("builtin", "custom:builtin%3Azai-start-plan:glm-5.3")).toBe(
      "glm-5.3",
    );
    expect(resolveTelemetryModelId("builtin", "builtin:zai-start-plan/private-model")).toBe(
      "custom",
    );
  });
});

describe("sanitizeTelemetryModelValue", () => {
  it("白名单内置模型原样保留", () => {
    expect(sanitizeTelemetryModelValue("glm-4.6")).toBe("glm-4.6");
    expect(sanitizeTelemetryModelValue("GLM-4.6")).toBe("glm-4.6");
  });

  it("未命中白名单的裸模型 ID 降级为 custom", () => {
    expect(sanitizeTelemetryModelValue("some-internal-model")).toBe("custom");
  });

  it("custom: 编码值不泄露 provider 名与模型名", () => {
    const value = sanitizeTelemetryModelValue("custom:%E5%86%85%E7%BD%91:secret-model");
    expect(value).toBe("custom");
  });

  it("provider/model 复合值按 provider 判定", () => {
    expect(sanitizeTelemetryModelValue("account:zai-start-plan/glm-4.6")).toBe("glm-4.6");
    expect(sanitizeTelemetryModelValue("my-proxy/secret-model")).toBe("custom");
  });

  it("supervisor 投影出的旧身份复合值与 custom: 编码值都保留白名单模型", () => {
    expect(sanitizeTelemetryModelValue("builtin:zai-start-plan/GLM-5.3")).toBe("glm-5.3");
    expect(sanitizeTelemetryModelValue("custom:builtin%3Azai-start-plan:glm-5.3")).toBe("glm-5.3");
  });

  it("空值保持空，便于与既有留空口径一致", () => {
    expect(sanitizeTelemetryModelValue("")).toBe("");
    expect(sanitizeTelemetryModelValue(undefined)).toBe("");
    expect(sanitizeTelemetryModelValue("   ")).toBe("");
  });
});
