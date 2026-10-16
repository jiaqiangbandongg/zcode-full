import { describe, expect, it, vi } from "vitest";
import type { ProviderSettingsView } from "@zcode/services";
import {
  reportAutomationCreateResult,
  resolveAutomationModelTelemetry,
  sanitizeAutomationTelemetryError,
} from "@/lib/automationTelemetry.js";

describe("automation telemetry", () => {
  it.each([
    ["[AUTOMATION_CREATE_LIMIT_REACHED] automation limit reached", "limit"],
    ["ETIMEDOUT connecting to https://private.example/path?token=FAKE_SECRET", "timeout"],
    ["connect ECONNREFUSED 127.0.0.1:8080", "network"],
    ["fetch failed", "network"],
    ["Unauthorized: Authorization: Bearer FAKE_SECRET", "auth"],
    ["Invalid automation mode: FAKE_SECRET", "validation"],
    ["Automation 模型选择不可用，请重新选择模型与思考档位", "validation"],
    ["unexpected FAKE_SECRET /Users/private/file", "unknown"],
    ["[FAKE_SECRET] failed", "unknown"],
    [null, "unknown"],
    [undefined, "unknown"],
    ["", "unknown"],
  ])("失败分类 %s -> %s，原文不出网", async (error, errorCode) => {
    const reportTelemetryEvent = vi.fn(async () => {});
    await reportAutomationCreateResult(
      { reportTelemetryEvent },
      {
        cronExpr: "0 9 * * *",
        error,
        modelFields: { model_name: "", model_provider: "", provider_name: "" },
      },
    );
    expect(reportTelemetryEvent).toHaveBeenCalledOnce();
    expect(reportTelemetryEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        elementName: "automation_create_result",
        eventExtraDetail: expect.objectContaining({
          status: "fail",
          error_code: errorCode,
          error_msg: error ? "[redacted]" : "",
        }),
      }),
    );
    expect(JSON.stringify(reportTelemetryEvent.mock.calls)).not.toContain("FAKE_SECRET");
    expect(JSON.stringify(reportTelemetryEvent.mock.calls)).not.toContain("/Users/private");
  });

  it("成功不携带过期失败分类或原文", async () => {
    const reportTelemetryEvent = vi.fn(async () => {});
    await reportAutomationCreateResult(
      { reportTelemetryEvent },
      {
        automationId: "automation-1",
        cronExpr: "0 9 * * *",
        error: "Unauthorized FAKE_SECRET",
        modelFields: { model_name: "", model_provider: "", provider_name: "" },
      },
    );
    expect(reportTelemetryEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventExtraDetail: expect.objectContaining({
          status: "success",
          error_code: "",
          error_msg: "",
        }),
      }),
    );
  });

  it("只从自定义 provider endpoint 提取 hostname", () => {
    const providerSettingsView = createProviderSettingsView({ builtin: false });

    expect(
      resolveAutomationModelTelemetry(
        "custom:custom-provider-id:glm-test",
        undefined,
        providerSettingsView,
      ),
    ).toEqual({
      model_name: "glm-test",
      model_provider: "custom-provider-id",
      provider_name: "api.example.com",
    });
  });

  it("官方 Provider 不把服务地址写入自动化遥测", () => {
    expect(
      resolveAutomationModelTelemetry(
        "custom:custom-provider-id:glm-test",
        undefined,
        createProviderSettingsView({ builtin: true }),
      ),
    ).toEqual({
      model_name: "glm-test",
      model_provider: "custom-provider-id",
      provider_name: "",
    });
  });

  it("失败摘要移除路径、URL 和凭据并限制长度", () => {
    const result = sanitizeAutomationTelemetryError(
      `failed /Users/test/private.txt https://example.com/path?q=secret token=secret ${"x".repeat(600)}`,
    );
    expect(result).not.toContain("/Users/test");
    expect(result).not.toContain("q=secret");
    expect(result).not.toContain("token=secret");
    expect(result).toBe("[redacted]");
    expect(sanitizeAutomationTelemetryError("Authorization: Bearer FAKE_SECRET")).toBe(
      "[redacted]",
    );
    expect(sanitizeAutomationTelemetryError(undefined)).toBe("");
  });
});

function createProviderSettingsView({ builtin }: { builtin: boolean }): ProviderSettingsView {
  return {
    revision: 1,
    providerTemplates: [],
    providerOrder: [],
    providers: [
      {
        providerId: "custom-provider-id",
        providerName: "Custom",
        ...(builtin ? { templateId: "official-api" } : {}),
        enabled: true,
        executable: true,
        effectiveConfig: {
          group: "standard-personal",
          access: { type: "api-key", apiKey: "secret" },
          api: {
            type: "openai-chat-completions",
            baseUrl: "https://api.example.com/v1/messages?token=secret",
          },
          personalModelIds: [],
        },
        issues: [],
        models: [],
      },
    ],
  };
}
